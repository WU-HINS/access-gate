/**
 * 跨项目协同验证协议（M5-1）—— docs/06 §7.2.2。
 *
 * ```
 *   X-Gate-Client:    vc_7f3a...
 *   X-Gate-Timestamp: 1758412800
 *   X-Gate-Nonce:     8f2c...
 *   X-Gate-Signature: sha256=<HMAC(secret, method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + bodyHash)>
 * ```
 *
 * ★ 四道防线缺一不可（对应验收标准「签名错误 / 过期 / 重放均被拒」）：
 *
 * 1. **签名**：HMAC-SHA256，**常量时间比较**（否则可以按字节逐位爆破）。
 * 2. **时间戳窗口 ±5 分钟**：防止「抓到请求后长期重发」。
 * 3. **nonce 窗口内去重**：仅靠时间戳不够——攻击者可在 5 分钟内**原样重发**，
 *    每次签名都"正确且未过期"。nonce 去重是防重放的关键那一层。
 * 4. **bodyHash**：把 body 纳入签名，否则攻击者可改 body 保留签名
 *    （`method`/`path` 已纳入，但 body 不纳入就等于「签名不覆盖内容」）。
 *
 * ★ 一处必须说明的存储设计：`ag_verify_clients` 里是 `secret_hash`（不可逆），
 *   而 HMAC **验证必须能拿到原始 secret**。因此：
 *   - `secret_hash` 用于「**查找**与审计」（不可逆比对）；
 *   - 原始 secret 必须**加密存储**（`ag_secrets` + 主密钥）以便重算 HMAC。
 *   本模块把取 secret 抽象为 `resolveSecret`，让实现决定如何取——
 *   内存实现直接存明文（仅供测试），PG 实现应走 `ag_secrets` 解密。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── 常量 ───────────────────────────

/** 时间戳容差：±5 分钟（docs/06 §7.2.2） */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

export const SIGNATURE_HEADERS = {
  client: 'x-gate-client',
  timestamp: 'x-gate-timestamp',
  nonce: 'x-gate-nonce',
  signature: 'x-gate-signature',
} as const;

// ─────────────────────────── 签名 ───────────────────────────

/** `bodyHash` = SHA-256(body) 的 hex；**GET 请求体为空串**。 */
export function bodyHashOf(body: string | undefined): string {
  return createHash('sha256').update(body ?? '', 'utf8').digest('hex');
}

/**
 * 计算签名（**纯函数**，客户端与服务端共用）。
 *
 * 待签串：`method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + bodyHash`
 */
export function computeSignature(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body?: string;
}): string {
  const canonical = [
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    bodyHashOf(input.body),
  ].join('\n');
  return createHmac('sha256', input.secret).update(canonical, 'utf8').digest('hex');
}

/** 生成一组签名头（供调用方/SDK/测试使用）。 */
export function signRequest(input: {
  clientId: string;
  secret: string;
  method: string;
  path: string;
  body?: string;
  timestamp?: number;
  nonce?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const signature = computeSignature({
    secret: input.secret,
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  return {
    [SIGNATURE_HEADERS.client]: input.clientId,
    [SIGNATURE_HEADERS.timestamp]: String(timestamp),
    [SIGNATURE_HEADERS.nonce]: nonce,
    [SIGNATURE_HEADERS.signature]: `sha256=${signature}`,
  };
}

// ─────────────────────────── 常量时间比较 ───────────────────────────

/**
 * 常量时间字符串比较。
 *
 * ★ 为什么必须：`===` 在首个不同字节处返回，攻击者可据此逐字节爆破签名。
 *   长度不同时也不能提前返回——先比较长度再比较内容会泄露长度，
 *   这里用「固定长度摘要 + timingSafeEqual」规避。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

// ─────────────────────────── 调用方 ───────────────────────────

export type VerifyClientStatus = 'active' | 'suspended' | 'revoked';

export interface VerifyClient {
  /** 对外标识（`vc_...`），出现在 `X-Gate-Client` 头里 */
  clientId: string;
  name: string;
  scopes: readonly string[];
  allowedSubjects?: readonly string[];
  callbackUrl?: string;
  status: VerifyClientStatus;
}

export interface VerifyClientStore {
  find(clientId: string): Promise<VerifyClient | undefined>;
  /**
   * 取**原始 secret** 用于重算 HMAC。
   *
   * ★ 注意：这是本协议里唯一需要「可解密」的密钥。
   *   `ag_verify_clients.secret_hash` 用于查找与审计（不可逆），
   *   原始值必须加密存储（`ag_secrets` + 主密钥）。
   */
  resolveSecret(clientId: string): Promise<string | undefined>;
}

export class InMemoryVerifyClientStore implements VerifyClientStore {
  private readonly clients = new Map<string, VerifyClient>();
  private readonly secrets = new Map<string, string>();

  /** 注册调用方。返回的 `secret` **只在这一次返回**（后续不可读取）。 */
  register(input: { clientId?: string; name: string; scopes: readonly string[]; allowedSubjects?: readonly string[]; callbackUrl?: string }): {
    client: VerifyClient;
    secret: string;
  } {
    const clientId = input.clientId ?? `vc_${randomBytes(8).toString('hex')}`;
    const secret = randomBytes(32).toString('base64url');
    const client: VerifyClient = {
      clientId,
      name: input.name,
      scopes: [...input.scopes],
      status: 'active',
      ...(input.allowedSubjects === undefined ? {} : { allowedSubjects: [...input.allowedSubjects] }),
      ...(input.callbackUrl === undefined ? {} : { callbackUrl: input.callbackUrl }),
    };
    this.clients.set(clientId, client);
    this.secrets.set(clientId, secret);
    return { client, secret };
  }

  /** 轮换 secret（支持新旧并存过渡期：`graceMs` 内旧的仍可用）。 */
  rotate(clientId: string, options: { graceMs?: number; now?: Date } = {}): { secret: string; previousSecretExpiresAt: Date | null } {
    const existing = this.clients.get(clientId);
    if (existing === undefined) throw new Error(`调用方 '${clientId}' 不存在`);
    const secret = randomBytes(32).toString('base64url');
    const previous = this.secrets.get(clientId);
    this.secrets.set(clientId, secret);
    if (previous !== undefined && (options.graceMs ?? 0) > 0) {
      const expiresAt = new Date((options.now ?? new Date()).getTime() + options.graceMs!);
      this.previousSecrets.set(`${clientId}\u0000${previous}`, expiresAt);
      return { secret, previousSecretExpiresAt: expiresAt };
    }
    return { secret, previousSecretExpiresAt: null };
  }

  private readonly previousSecrets = new Map<string, Date>();

  setStatus(clientId: string, status: VerifyClientStatus): void {
    const existing = this.clients.get(clientId);
    if (existing === undefined) throw new Error(`调用方 '${clientId}' 不存在`);
    this.clients.set(clientId, { ...existing, status });
  }

  async find(clientId: string): Promise<VerifyClient | undefined> {
    const found = this.clients.get(clientId);
    return found === undefined ? undefined : { ...found };
  }

  async resolveSecret(clientId: string): Promise<string | undefined> {
    return this.secrets.get(clientId);
  }

  /** 过渡期内仍接受的旧 secret（用于轮换）。 */
  resolvePreviousSecrets(clientId: string, now: Date): string[] {
    const out: string[] = [];
    for (const [key, expiresAt] of this.previousSecrets) {
      const [id, secret] = key.split('\u0000');
      if (id === clientId && expiresAt.getTime() > now.getTime()) out.push(secret!);
    }
    return out;
  }
}

// ─────────────────────────── nonce 去重 ───────────────────────────

export interface NonceStore {
  /**
   * 记录 nonce；**首次**返回 true，窗口内重复返回 false。
   *
   * ★ 必须**原子**（PG 实现用唯一约束 + ON CONFLICT DO NOTHING 看影响行数）——
   *   先查后写在并发下会让两个相同 nonce 都通过，防重放失效。
   */
  claim(clientId: string, nonce: string, expiresAt: Date): Promise<boolean>;
  /** 清理过期 nonce（可定期调用） */
  purge?(): Promise<number>;
}

export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, Date>();
  async claim(clientId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const key = `${clientId}\u0000${nonce}`;
    const existing = this.seen.get(key);
    if (existing !== undefined) return false;
    this.seen.set(key, expiresAt);
    return true;
  }
  async purge(): Promise<number> {
    const now = Date.now();
    let purged = 0;
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt.getTime() <= now) {
        this.seen.delete(key);
        purged += 1;
      }
    }
    return purged;
  }
}

// ─────────────────────────── 验证 ───────────────────────────

export type VerifyRejection =
  | 'missing_header'
  | 'unknown_client'
  | 'client_suspended'
  | 'client_revoked'
  | 'bad_timestamp_format'
  | 'timestamp_out_of_window'
  | 'bad_signature_format'
  | 'signature_mismatch'
  | 'nonce_replayed'
  | 'scope_denied'
  | 'subject_not_allowed';

export type VerifyOutcome =
  | { ok: true; client: VerifyClient; timestamp: number }
  | { ok: false; reason: VerifyRejection; message: string; client?: VerifyClient };

export interface VerifySignedRequestInput {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  path: string;
  body?: string;
  clients: VerifyClientStore;
  nonces: NonceStore;
  now?: Date;
  /** 该端点要求的 scope（缺省不校验） */
  requiredScope?: string;
  /** 该请求声称的主体（用于 allowedSubjects 白名单） */
  subject?: { type: string; value: string };
  /** 轮换过渡期：按 clientId 取仍可用的旧 secret */
  previousSecrets?: (clientId: string, now: Date) => string[];
  logger?: Logger;
}

/**
 * 验证签名请求。
 *
 * ★ 检查顺序是刻意的：**先做便宜的检查，最后才做 HMAC**
 *   （HMAC 涉及一次加密运算）。这既是性能考虑，也让攻击者无法用
 *   大量错误签名消耗 CPU——未知 client 直接拒，不进 HMAC。
 *
 * ★ 拒绝原因**不对外暴露细节差异**（除了明确的操作性错误）：
 *   实际部署中「签名错」与「client 不存在」返回给调用方的信息应当一致，
 *   避免成为探测工具。这里返回结构化原因供**服务端日志**使用，
 *   响应体只给通用消息（见 `toPublicMessage`）。
 */
export async function verifySignedRequest(input: VerifySignedRequestInput): Promise<VerifyOutcome> {
  const header = (name: string): string | undefined => {
    const value = input.headers[name] ?? input.headers[name.toLowerCase()];
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value[0] : value;
  };

  const clientId = header(SIGNATURE_HEADERS.client);
  const timestampText = header(SIGNATURE_HEADERS.timestamp);
  const nonce = header(SIGNATURE_HEADERS.nonce);
  const signatureHeader = header(SIGNATURE_HEADERS.signature);
  if (clientId === undefined || timestampText === undefined || nonce === undefined || signatureHeader === undefined) {
    return { ok: false, reason: 'missing_header', message: `缺少签名头（需要 ${Object.values(SIGNATURE_HEADERS).join(' / ')}）` };
  }

  // ① 查找调用方
  const client = await input.clients.find(clientId);
  if (client === undefined) return { ok: false, reason: 'unknown_client', message: `未知调用方 '${clientId}'` };
  if (client.status === 'revoked') return { ok: false, reason: 'client_revoked', message: `调用方 '${clientId}' 已被吊销`, client };
  if (client.status === 'suspended') return { ok: false, reason: 'client_suspended', message: `调用方 '${clientId}' 已暂停`, client };

  // ② 时间戳格式与窗口
  if (!/^\d+$/.test(timestampText)) {
    return { ok: false, reason: 'bad_timestamp_format', message: `时间戳必须是 Unix 秒（实际 '${timestampText}'）`, client };
  }
  const timestamp = Number(timestampText);
  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const driftSeconds = Math.abs(nowSeconds - timestamp);
  if (driftSeconds > TIMESTAMP_TOLERANCE_MS / 1000) {
    return {
      ok: false,
      reason: 'timestamp_out_of_window',
      message: `时间戳超出 ±5 分钟容差（偏差 ${driftSeconds} 秒）`,
      client,
    };
  }

  // ③ 签名格式
  if (!signatureHeader.startsWith('sha256=')) {
    return { ok: false, reason: 'bad_signature_format', message: '签名必须是 sha256=<hex> 形式', client };
  }
  const provided = signatureHeader.slice('sha256='.length);

  // ④ HMAC 比对（含轮换过渡期的旧 secret）
  const secrets = [await input.clients.resolveSecret(clientId)];
  if (input.previousSecrets !== undefined) secrets.push(...input.previousSecrets(clientId, now));
  let signatureOk = false;
  for (const secret of secrets) {
    if (secret === undefined) continue;
    const expected = computeSignature({
      secret,
      method: input.method,
      path: input.path,
      timestamp,
      nonce,
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    // ★ 常量时间比较（不能用 ===，否则可按字节爆破）
    if (constantTimeEqual(expected, provided)) {
      signatureOk = true;
      break;
    }
  }
  if (!signatureOk) {
    return { ok: false, reason: 'signature_mismatch', message: '签名校验失败', client };
  }

  // ⑤ scope
  if (input.requiredScope !== undefined && !client.scopes.includes(input.requiredScope)) {
    return {
      ok: false,
      reason: 'scope_denied',
      message: `调用方 '${clientId}' 缺少 scope '${input.requiredScope}'（已有：${client.scopes.join(', ') || '（无）'}）`,
      client,
    };
  }

  // ⑥ subject 白名单
  if (input.subject !== undefined && client.allowedSubjects !== undefined && client.allowedSubjects.length > 0) {
    const allowed = client.allowedSubjects.some((pattern) =>
      pattern.endsWith('*') ? input.subject!.value.startsWith(pattern.slice(0, -1)) : pattern === input.subject!.value,
    );
    if (!allowed) {
      return {
        ok: false,
        reason: 'subject_not_allowed',
        message: `调用方 '${clientId}' 不允许查询主体 '${input.subject.value}'`,
        client,
      };
    }
  }

  // ⑦ nonce 去重（**最后做**：它会写存储，不应为无效请求留下痕迹）
  const expiresAt = new Date((timestamp + TIMESTAMP_TOLERANCE_MS / 1000) * 1000);
  const claimed = await input.nonces.claim(clientId, nonce, expiresAt);
  if (!claimed) {
    input.logger?.warn('检测到重放请求', { clientId, nonce, path: input.path });
    return { ok: false, reason: 'nonce_replayed', message: 'nonce 在容差窗口内已被使用（疑似重放）', client };
  }

  return { ok: true, client, timestamp };
}

/**
 * 对外响应消息（**不泄露细节**）。
 *
 * ★ 除了明确的操作性错误（缺头、scope 不足），其余一律返回同一句话——
 *   否则「签名错」与「client 不存在」的差异会成为探测工具。
 */
export function toPublicMessage(reason: VerifyRejection): { status: number; error: string } {
  switch (reason) {
    case 'missing_header':
      return { status: 401, error: '缺少签名头' };
    case 'unknown_client':
    case 'client_suspended':
    case 'client_revoked':
    case 'signature_mismatch':
    case 'bad_signature_format':
      return { status: 401, error: '调用方认证失败' };
    case 'bad_timestamp_format':
    case 'timestamp_out_of_window':
    case 'nonce_replayed':
      return { status: 401, error: '请求已过期或不可重放' };
    case 'scope_denied':
      return { status: 403, error: 'scope 不足' };
    case 'subject_not_allowed':
      return { status: 403, error: '不允许查询该主体' };
    default:
      return { status: 401, error: '调用方认证失败' };
  }
}
