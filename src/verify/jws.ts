/**
 * 断言签名（M5-3）—— docs/06 §7.2.3。
 *
 * ```
 *   { matched, subject, assertions, issuedAt, expiresAt, issuer, signature }
 *                                                        └─ ES256 JWS（compact）
 * ```
 *
 * ★ 为什么要签名而不是「调用方实时回调平台查询」：
 *   文档原话是「这样**断言可以离线复核**，不依赖对平台的实时信任」。
 *   调用方拿到断言后，用 `/api/verify/v1/jwks` 取公钥自行验签即可——
 *   平台不可用时也不影响已签发的断言被验证（对 bot 框架很关键：
 *   它们经常运行在与平台不同的网络环境里）。
 *
 * ★ 三条必须做对的事：
 * 1. **算法白名单**：只接受 ES256（`alg: none` 或 HS* 会让验签形同虚设）。
 * 2. **`kid` 必须参与选键**：轮换期间会有多把公钥，靠 `kid` 定位。
 * 3. **payload 里必须带 `iss` 与 `exp`**：否则断言可被无限期重放。
 */

import { SignJWT, importJWK, jwtVerify, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK, type KeyObject } from 'jose';

// ─────────────────────────── 类型 ───────────────────────────

/** 断言的签名载荷（`assertions` 是业务数据，不参与签名结构本身） */
export interface AssertionPayload {
  /** 签发者（平台对外地址） */
  iss: string;
  /** 主体标识 */
  sub: string;
  subjectType: string;
  displayName?: string;
  /** 业务断言：eligible / tier / tags / policies … */
  assertions: Record<string, unknown>;
  /** 签发时间（秒） */
  iat: number;
  /** 过期时间（秒） */
  exp: number;
  /** 可选：审计关联 */
  jti?: string;
}

export interface SigningKey {
  kid: string;
  /**
   * 私钥。
   *
   * ★ 类型刻意收窄为 `KeyObject`（而不是 `KeyObject | string`）：
   *   jose 的签名接口不接受 PEM 字符串——留一个「看起来能用但实际会抛错」的联合类型，
   *   只会把错误推迟到运行时。
   */
  privateKey: KeyObject;
  /** 对应公钥（用于 JWKS 发布） */
  publicKey: KeyObject;
}

export interface JwksDocument {
  keys: (JWK & { kid: string; alg: string; use: string })[];
}

export const ASSERTION_ALG = 'ES256' as const;
/** 断言默认有效期（docs/06 示例是 5 分钟） */
export const DEFAULT_ASSERTION_TTL_SECONDS = 300;

// ─────────────────────────── 生成密钥 ───────────────────────────

/** 生成一把 ES256（P-256）签名密钥。 */
export async function generateSigningKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(ASSERTION_ALG, { extractable: true });
  return { kid, privateKey, publicKey };
}

/**
 * 从私钥导出 JWK（`d` 是私钥材料）。
 *
 * ★ 导出物**不得**进入 JWKS——JWKS 只放公钥。
 */
export async function exportPrivateJwk(key: SigningKey): Promise<JWK> {
  const jwk = await exportJWK(key.privateKey);
  return { ...jwk, kid: key.kid, alg: ASSERTION_ALG, use: 'sig' };
}

/** 从公钥导出 JWK（可安全发布）。 */
export async function exportPublicJwk(key: SigningKey): Promise<JWK & { kid: string; alg: string; use: string }> {
  const jwk = await exportJWK(key.publicKey);
  return { ...jwk, kid: key.kid, alg: ASSERTION_ALG, use: 'sig' };
}

/** 组装 JWKS 文档（供 `/api/verify/v1/jwks`，**可匿名访问**）。 */
export async function toJwks(keys: readonly SigningKey[]): Promise<JwksDocument> {
  const jwks: JwksDocument = { keys: [] };
  for (const key of keys) jwks.keys.push(await exportPublicJwk(key));
  return jwks;
}

/**
 * 校验 JWKS 里**不含私钥材料**。
 *
 * ★ 这是「发布 JWKS」这一步最容易犯的致命错误：
 *   把带 `d` 的 JWK 发出去等于公开签名私钥。这里做成可断言的自检。
 */
export function assertJwksHasNoPrivateMaterial(jwks: JwksDocument): void {
  for (const key of jwks.keys) {
    const privateFields = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'] as const;
    for (const field of privateFields) {
      if ((key as Record<string, unknown>)[field] !== undefined) {
        throw new Error(`JWKS 泄露了私钥材料（kid=${key.kid} 含 '${field}'）——公钥文档绝不能包含私钥`);
      }
    }
  }
}

// ─────────────────────────── 签发 ───────────────────────────

/**
 * 通用 JWS 签发（**不限定 payload 结构**）。
 *
 * ★ 为什么需要它：OIDC 的 `id_token` 需要 `aud`（client_id）与 `nonce`，
 *   而 `AssertionPayload` 是「资格断言」的形状（有 `assertions`、没有 `aud`）。
 *   把 id_token 硬塞进断言结构会让两边都变形；抽一个通用签发函数、
 *   让 `signAssertion` 复用它，是更干净的分层。
 */
export async function signJwt(options: {
  payload: Record<string, unknown>;
  key: SigningKey;
  ttlSeconds?: number;
  now?: Date;
  /** 不在 payload 里则自动补 iat/exp */
  autoTimestamps?: boolean;
}): Promise<string> {
  const now = options.now ?? new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const payload =
    options.autoTimestamps === false
      ? { ...options.payload }
      : { iat, exp: iat + (options.ttlSeconds ?? DEFAULT_ASSERTION_TTL_SECONDS), ...options.payload };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ASSERTION_ALG, kid: options.key.kid, typ: 'JWT' })
    .sign(options.key.privateKey);
}

export interface SignAssertionOptions {
  payload: Omit<AssertionPayload, 'iat' | 'exp'> & { iat?: number; exp?: number };
  key: SigningKey;
  ttlSeconds?: number;
  now?: Date;
  /** 断言 id（用于撤销与流水关联） */
  jti?: string;
}

/**
 * 签发断言（ES256 JWS compact）。
 *
 * 头部带 `kid` 与 `alg`——调用方据此选公钥，**不依赖约定的顺序**。
 */
export async function signAssertion(options: SignAssertionOptions): Promise<string> {
  const now = options.now ?? new Date();
  const iat = options.payload.iat ?? Math.floor(now.getTime() / 1000);
  const exp = options.payload.exp ?? iat + (options.ttlSeconds ?? DEFAULT_ASSERTION_TTL_SECONDS);

  const payload: AssertionPayload = {
    iss: options.payload.iss,
    sub: options.payload.sub,
    subjectType: options.payload.subjectType,
    ...(options.payload.displayName === undefined ? {} : { displayName: options.payload.displayName }),
    assertions: options.payload.assertions,
    iat,
    exp,
    ...(options.jti === undefined ? {} : { jti: options.jti }),
  };

  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: ASSERTION_ALG, kid: options.key.kid, typ: 'JWT' })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setIssuer(payload.iss)
    .setSubject(payload.sub)
    .sign(options.key.privateKey);
}

// ─────────────────────────── 验签 ───────────────────────────

export type AssertionRejection =
  | 'malformed'
  | 'unknown_kid'
  | 'bad_algorithm'
  | 'signature_invalid'
  | 'expired'
  | 'issuer_mismatch'
  | 'subject_mismatch'
  | 'not_yet_valid';

export type AssertionVerification =
  | { ok: true; payload: AssertionPayload; kid: string }
  | { ok: false; reason: AssertionRejection; message: string };

export interface VerifyAssertionOptions {
  token: string;
  jwks: JwksDocument;
  /** 期望的签发者（必须严格相等） */
  expectedIssuer?: string;
  /** 期望的主体（必须严格相等） */
  expectedSubject?: string;
  now?: Date;
  /** 时钟偏移容忍（秒） */
  clockToleranceSeconds?: number;
  /** 允许的算法（默认只有 ES256） */
  allowedAlgorithms?: readonly string[];
}

/** 从 compact JWS 头部读出 `kid` / `alg`（**不验签**，仅用于选键）。 */
export function readJwsHeader(token: string): { kid?: string; alg?: string; typ?: string } | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return {
      ...(typeof json['kid'] === 'string' ? { kid: json['kid'] } : {}),
      ...(typeof json['alg'] === 'string' ? { alg: json['alg'] } : {}),
      ...(typeof json['typ'] === 'string' ? { typ: json['typ'] } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * 验签断言（调用方侧或平台侧自检均可使用）。
 *
 * ★ 检查顺序刻意安排：**先看头部（便宜）→ 再选键 → 最后做密码学验签**。
 *   并且**算法白名单在前**：`alg: none` 必须在进入验签前就被拒绝。
 */
export async function verifyAssertion(options: VerifyAssertionOptions): Promise<AssertionVerification> {
  const header = readJwsHeader(options.token);
  if (header === undefined) return { ok: false, reason: 'malformed', message: '不是合法的 compact JWS（应为三段）' };

  const allowed = options.allowedAlgorithms ?? [ASSERTION_ALG];
  if (header.alg === undefined || !allowed.includes(header.alg)) {
    // ★ `none` / `HS*` 必须在这里被拒——否则验签形同虚设
    return { ok: false, reason: 'bad_algorithm', message: `不允许的签名算法 '${header.alg ?? '（缺失）'}'（只允许 ${allowed.join(', ')}）` };
  }

  if (header.kid === undefined) return { ok: false, reason: 'malformed', message: 'JWS 头部缺少 kid（轮换期间无法定位公钥）' };
  const jwk = options.jwks.keys.find((key) => key.kid === header.kid);
  if (jwk === undefined) {
    return { ok: false, reason: 'unknown_kid', message: `JWKS 中没有 kid='${header.kid}' 对应的公钥（已知：${options.jwks.keys.map((k) => k.kid).join(', ') || '（空）'}）` };
  }

  let key: KeyObject | Uint8Array;
  try {
    key = (await importJWK(jwk as JWK, header.alg)) as KeyObject | Uint8Array;
  } catch (error) {
    return { ok: false, reason: 'malformed', message: `公钥导入失败：${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    const result = await jwtVerify(
      options.token,
      key as Parameters<typeof jwtVerify>[1],
      {
        algorithms: [...allowed],
        ...(options.expectedIssuer === undefined ? {} : { issuer: options.expectedIssuer }),
        ...(options.expectedSubject === undefined ? {} : { subject: options.expectedSubject }),
        ...(options.clockToleranceSeconds === undefined ? {} : { clockTolerance: options.clockToleranceSeconds }),
        ...(options.now === undefined ? {} : { currentDate: options.now }),
      },
    );
    const payload = result.payload as unknown as AssertionPayload;
    return { ok: true, payload, kid: header.kid };
  } catch (error) {
    // 把 jose 的错误归类为**可操作**的原因（而不是把库的异常直接抛给调用方）
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ERR_JWT_EXPIRED') return { ok: false, reason: 'expired', message: `断言已过期：${message}` };
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      if (/iss/.test(message)) return { ok: false, reason: 'issuer_mismatch', message: `iss 不匹配：${message}` };
      if (/sub/.test(message)) return { ok: false, reason: 'subject_mismatch', message: `sub 不匹配：${message}` };
      if (/nbf/.test(message)) return { ok: false, reason: 'not_yet_valid', message: `断言尚未生效：${message}` };
      return { ok: false, reason: 'malformed', message: `声明校验失败：${message}` };
    }
    if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      return { ok: false, reason: 'signature_invalid', message: '签名校验失败（断言可能被篡改）' };
    }
    return { ok: false, reason: 'signature_invalid', message };
  }
}

/** 计算 JWK 指纹（用于断言去重与 `kid` 生成）。 */
export async function thumbprint(jwk: JWK): Promise<string> {
  return calculateJwkThumbprint(jwk);
}

// ─────────────────────────── 密钥状态机（M6-5 联动） ───────────────────────────

export type SigningKeyStatus = 'active' | 'standby' | 'retiring' | 'retired';

export interface ManagedSigningKey extends SigningKey {
  status: SigningKeyStatus;
  createdAt: Date;
}

/**
 * 密钥集合：**只有 active 用于签发；active + retiring 都发布到 JWKS**。
 *
 * ★ 为什么 retiring 必须继续发布：
 *   已签发但未过期的断言需要旧公钥才能验签。若轮换时立刻撤下旧公钥，
 *   那些断言会「验签失败」——而它们本该是有效的（这是真实的线上事故形态）。
 */
export class SigningKeySet {
  private readonly keys: ManagedSigningKey[] = [];

  add(key: ManagedSigningKey): void {
    this.keys.push(key);
  }

  get active(): ManagedSigningKey | undefined {
    return this.keys.find((key) => key.status === 'active');
  }

  /** 用于**签发**的密钥（有且只有一把 active）。 */
  requireActive(): ManagedSigningKey {
    const active = this.active;
    if (active === undefined) throw new Error('没有 active 的签名密钥——无法签发断言');
    return active;
  }

  /** 用于**发布**的密钥（active + standby + retiring）。 */
  publishable(): ManagedSigningKey[] {
    return this.keys.filter((key) => key.status !== 'retired');
  }

  /** 状态迁移（promote standby → active 时，旧 active 转 retiring）。 */
  promote(kid: string): void {
    const target = this.keys.find((key) => key.kid === kid);
    if (target === undefined) throw new Error(`密钥 '${kid}' 不存在`);
    for (const key of this.keys) {
      if (key.status === 'active' && key.kid !== kid) key.status = 'retiring';
    }
    target.status = 'active';
  }

  retire(kid: string): void {
    const target = this.keys.find((key) => key.kid === kid);
    if (target === undefined) throw new Error(`密钥 '${kid}' 不存在`);
    if (target.status === 'active') throw new Error(`不得直接 retire active 密钥 '${kid}'（先 promote 新密钥）`);
    target.status = 'retired';
  }

  async jwks(): Promise<JwksDocument> {
    return toJwks(this.publishable());
  }

  list(): { kid: string; status: SigningKeyStatus; createdAt: Date }[] {
    return this.keys.map((key) => ({ kid: key.kid, status: key.status, createdAt: key.createdAt }));
  }
}
