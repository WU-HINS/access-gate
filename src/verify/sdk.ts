/**
 * 官方薄 SDK（M5-5）—— docs/06 §7.2.4。
 *
 * ```
 *   @gate/verify-client（TypeScript）：签名 · assert · challenge 轮询 · JWKS 验签 · 事件回调验签
 * ```
 *
 * ★ SDK 的核心价值**不是「把 HTTP 请求包装一下」**，而是**替调用方做掉它最容易做错的事**：
 *
 * 1. **签名**：待签串是 `method\npath\ntimestamp\nnonce\nbodyHash`——
 *    手写时极易漏掉 `bodyHash`（于是签名不覆盖内容）或把 body 换成「解析后重序列化」
 *    （于是格式差异导致验签失败）。SDK 统一生成，把这层风险消掉。
 *
 * 2. **★ 验签响应**：这是最容易被忽略的一条。调用方拿到断言后**必须验签**——
 *    否则中间人（或错误配置的代理）可以伪造一份「eligible: true」的响应。
 *    因此 SDK 默认**强制验签**（除非调用方显式关掉，并为关掉承担后果）。
 *
 * 3. **轮询**：设备码流必须遵守服务端的 `interval`（服务端也限速），
 *    且要有整体超时。手写循环很容易写成「每 100ms 轮一次」而触发 429。
 *
 * ★ 为什么叫「薄」：它只做这三件事，不含任何业务判断
 *   （「eligible 代表什么」是调用方的业务）。薄才有机会被 Python / Go 版本等价复刻。
 */

import { signRequest, type NonceStore, type VerifyClientStore } from './hmac.ts';
import { verifyAssertion, type JwksDocument, type AssertionPayload } from './jws.ts';

// ─────────────────────────── 类型 ───────────────────────────

export interface VerifyClientOptions {
  /** 平台地址（如 `https://gate.example.com`） */
  baseUrl: string;
  /** 调用方标识（`vc_...`） */
  clientId: string;
  /** 调用方密钥（**只在创建时拿到一次**） */
  secret: string;
  /** 注入的 fetch（便于测试与自定义 HTTP 栈） */
  fetch?: FetchLike;
  /** 是否校验响应签名（**默认 true**；关掉意味着接受未经验证的断言） */
  verifyResponses?: boolean;
  /** 允许的签名算法（默认只有 ES256） */
  allowedAlgorithms?: readonly string[];
  /**
   * 期望的签发者（`iss`）。
   *
   * ★ 与 `baseUrl` 分开：`baseUrl` 是「怎么连到平台」，`iss` 是「平台自称是谁」。
   *   两者可能是不同的域名（网关 / 反向代理），把它当成同一个会误拒合法断言。
   *   不提供时**不校验 iss**（签名 + 主体仍然校验）。
   */
  expectedIssuer?: string;
  /** 请求超时（毫秒） */
  timeoutMs?: number;
  /**
   * 注入时钟（用于签名时间戳）。
   *
   * ★ 为什么 SDK 需要这个：签名带时间戳，而调用方的时钟**可能与平台不同步**。
   *   生产上需要它来做时钟校正；测试上需要它来构造确定的时间。
   *   若 SDK 写死 `Date.now()`，「调用方时钟漂移」这类真实故障就无法被测试覆盖。
   */
  now?: () => Date;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  headers?: Record<string, string>;
  text: () => Promise<string>;
}>;

export interface AssertionResponse {
  matched: boolean;
  subject: { type: string; value: string; displayName?: string };
  assertions: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
  issuer: string;
  signature?: string;
}

export interface ChallengeCreated {
  challengeId: string;
  userCode: string;
  verifyUrl: string;
  expiresIn: number;
  interval: number;
}

export type ChallengePoll =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; assertion: AssertionResponse };

export class VerifyClientError extends Error {
  override readonly name = 'VerifyClientError';
  readonly status?: number;
  readonly code: string;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// ─────────────────────────── 客户端 ───────────────────────────

/**
 * 协同验证客户端（调用方侧）。
 *
 * 用法：
 * ```ts
 * const client = createVerifyClient({ baseUrl, clientId, secret });
 * const result = await client.assert({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] });
 * if (result.matched && result.assertions.eligible === true) { ... }
 * ```
 */
export function createVerifyClient(options: VerifyClientOptions) {
  const fetcher: FetchLike = options.fetch ?? (fetch as unknown as FetchLike);
  const verifyResponses = options.verifyResponses !== false;
  let cachedJwks: JwksDocument | undefined;

  /** 取 JWKS（缓存：公钥轮换不频繁，且取公钥本身也需要一次请求）。 */
  async function jwks(force = false): Promise<JwksDocument> {
    if (!force && cachedJwks !== undefined) return cachedJwks;
    const response = await fetcher(`${options.baseUrl}/api/verify/v1/jwks`, { method: 'GET' });
    if (response.status !== 200) {
      throw new VerifyClientError('jwks_unavailable', `获取 JWKS 失败（HTTP ${response.status}）`, response.status);
    }
    cachedJwks = JSON.parse(await response.text()) as JwksDocument;
    return cachedJwks;
  }

  /**
   * 验签一个断言负载。
   *
   * ★ 除了验签，还校验 `iss` 与 `expiresAt` 与响应本身一致——
   *   否则「签名有效但内容是另一份断言」的情况会被放过。
   */
  /**
   * 验签并返回**权威内容**。
   *
   * ★ 这是本 SDK 最关键的一处修复：平台响应里 `assertions` 出现了**两次**——
   *   一次在 JWS 内部（受签名保护），一次在外层（**不受保护**）。
   *   早期实现验签后把**外层**字段交给调用方，于是攻击者只要改外层
   *   `assertions` 就能伪造「eligible: true」，而验签依然通过。
   *
   *   正确语义：**签名覆盖的内容才是权威**。验签成功后必须用 JWS payload 里的
   *   `assertions` / `sub` 覆盖外层字段，而不是把两者当作同一份数据。
   */
  async function verifyAssertionPayload(payload: AssertionResponse): Promise<AssertionPayload | undefined> {
    if (!verifyResponses) return undefined;
    if (payload.signature === undefined) {
      throw new VerifyClientError('missing_signature', '响应未包含 signature，但客户端要求验签（如确实不需要，请显式设置 verifyResponses: false）');
    }
    const keys = await jwks();
    const result = await verifyAssertion({
      token: payload.signature,
      jwks: keys,
      ...(options.allowedAlgorithms === undefined ? {} : { allowedAlgorithms: options.allowedAlgorithms }),
      // ★ `iss` 只在调用方**显式**给出期望值时才校验：
      //   baseUrl 是「怎么连到平台」，而 iss 是「平台自称是谁」——
      //   两者可能是不同的域名（网关/反代），把 baseUrl 当 iss 会误拒。
      ...(options.expectedIssuer === undefined ? {} : { expectedIssuer: options.expectedIssuer }),
      expectedSubject: payload.subject.value,
      // ★ 断言有 `exp`，验签必须用**同一时钟**——否则时钟漂移会被误判为「已过期」
      ...(options.now === undefined ? {} : { now: options.now() }),
    });
    if (!result.ok) {
      // 签名不对时尝试刷一次 JWKS（可能是平台刚轮换密钥）
      if (result.reason === 'unknown_kid') {
        const refreshed = await jwks(true);
        const retry = await verifyAssertion({
          token: payload.signature,
          jwks: refreshed,
          expectedSubject: payload.subject.value,
          ...(options.now === undefined ? {} : { now: options.now() }),
        });
        if (retry.ok) return retry.payload;
        throw new VerifyClientError('signature_invalid', `响应验签失败（刷新 JWKS 后仍失败）：${retry.message}`);
      }
      // ★ 错误码要能区分「签名不对」与「内容被替换」——两者的处置完全不同：
      //   前者可能是密钥轮换/配置问题，后者是**主动攻击**（必须告警）。
      //   早期把所有失败都归成 `signature_invalid`，于是「内容被替换」被淹没在噪音里。
      const code =
        result.reason === 'subject_mismatch'
          ? 'subject_mismatch'
          : result.reason === 'expired'
            ? 'expired'
            : result.reason === 'issuer_mismatch'
              ? 'issuer_mismatch'
              : 'signature_invalid';
      throw new VerifyClientError(code, `响应验签失败：${result.message}`);
    }
    // ★ 签名有效但内容被替换的防线：比对断言内部与响应外层的签发者/主体
    const inner = result.payload as AssertionPayload;
    if (inner.sub !== payload.subject.value) {
      throw new VerifyClientError('subject_mismatch', `断言主体 '${inner.sub}' 与响应声明的主体 '${payload.subject.value}' 不一致`);
    }
    return inner;
  }

  /** 发一个签名请求（自动生成签名头）。 */
  async function signedRequest(input: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<{ status: number; payload: unknown }> {
    const bodyText = input.body === undefined ? undefined : JSON.stringify(input.body);
    const timestamp = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    const headers = signRequest({
      clientId: options.clientId,
      secret: options.secret,
      method: input.method,
      path: input.path,
      timestamp,
      ...(bodyText === undefined ? {} : { body: bodyText }),
    });
    const response = await fetcher(`${options.baseUrl}${input.path}`, {
      method: input.method,
      headers: { ...headers, ...(bodyText === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(bodyText === undefined ? {} : { body: bodyText }),
    });
    const text = await response.text();
    let payload: unknown = undefined;
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    return { status: response.status, payload };
  }

  return {
    /** 主题解析结果（供断言比对）。 */
    get jwks(): () => Promise<JwksDocument> {
      return () => jwks();
    },

    /** 手动验签（调用方自己拿到了断言文本时用）。 */
    verifyAssertion: async (token: string, expectedSubject?: string) => {
      const keys = await jwks();
      return verifyAssertion({
        token,
        jwks: keys,
        ...(options.allowedAlgorithms === undefined ? {} : { allowedAlgorithms: options.allowedAlgorithms }),
        ...(options.expectedIssuer === undefined ? {} : { expectedIssuer: options.expectedIssuer }),
        ...(expectedSubject === undefined ? {} : { expectedSubject }),
        ...(options.now === undefined ? {} : { now: options.now() }),
      });
    },

    /**
     * 资格断言（docs/06 §7.2.3 的 `/assert`）。
     *
     * ★ 默认**验签响应**：调用方拿到的是「平台上签发的断言」，
     *   而不是「某个 HTTP 服务器说的 JSON」。
     */
    async assert(input: { subject: { type: string; value: string }; claims: readonly string[] }): Promise<AssertionResponse> {
      const { status, payload } = await signedRequest({ method: 'POST', path: '/api/verify/v1/assert', body: input });
      if (status !== 200) {
        throw new VerifyClientError('assert_failed', `断言请求失败：${describeError(payload)}`, status);
      }
      const response = payload as AssertionResponse;
      // ★ 要求验签时，「matched 但没有签名」必须**拒绝**而不是静默跳过：
      //   静默跳过会让调用方以为拿到的是可信断言（而它什么都没验）。
      //   早期实现的条件是 `signature !== undefined`，于是无签名响应直接穿过去了。
      if (response.matched && verifyResponses && response.signature === undefined) {
        throw new VerifyClientError('missing_signature', '响应声明 matched 但未包含 signature，客户端要求验签（如确实不需要，请显式设置 verifyResponses: false）');
      }
      if (response.matched && response.signature !== undefined) {
        const authoritative = await verifyAssertionPayload(response);
        // ★ 验签通过后，用**受签名保护的内容**覆盖外层字段（见 verifyAssertionPayload 的说明）
        if (authoritative !== undefined) {
          return {
            ...response,
            subject: { ...response.subject, value: authoritative.sub },
            assertions: authoritative.assertions,
          };
        }
      }
      return response;
    },

    /** 发起设备码流挑战（docs/06 §7.2.3 的 `/challenge`）。 */
    async challenge(input: { subject: { type: string; value: string }; scopes: readonly string[] }): Promise<ChallengeCreated> {
      const { status, payload } = await signedRequest({ method: 'POST', path: '/api/verify/v1/challenge', body: input });
      if (status !== 200) {
        throw new VerifyClientError('challenge_failed', `发起挑战失败：${describeError(payload)}`, status);
      }
      return payload as ChallengeCreated;
    },

    /** 轮询一次挑战状态。 */
    async poll(challengeId: string): Promise<ChallengePoll> {
      const { status, payload } = await signedRequest({ method: 'GET', path: `/api/verify/v1/challenge/${encodeURIComponent(challengeId)}` });
      if (status === 429) throw new VerifyClientError('poll_too_fast', '轮询过快（请遵守服务端返回的 interval）', 429);
      if (status === 404) return { status: 'expired' };
      if (status !== 200) {
        throw new VerifyClientError('poll_failed', `轮询失败：${describeError(payload)}`, status);
      }
      const body = payload as { status: string; assertion?: AssertionResponse };
      if (body.status === 'approved' && body.assertion !== undefined) {
        const authoritative = await verifyAssertionPayload(body.assertion);
        const assertion =
          authoritative === undefined
            ? body.assertion
            : { ...body.assertion, subject: { ...body.assertion.subject, value: authoritative.sub }, assertions: authoritative.assertions };
        return { status: 'approved', assertion };
      }
      return { status: body.status as 'pending' | 'denied' | 'expired' };
    },

    /**
     * 轮询到终态（**遵守服务端 interval**）。
     *
     * ★ 这是 SDK 最该替调用方做的事之一：手写循环很容易写成「每 100ms 轮一次」
     *   而触发服务端的 429。这里按 `interval` 等待，并设整体超时。
     */
    async waitForApproval(
      created: ChallengeCreated,
      options_: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; onPending?: (elapsedMs: number) => void } = {},
    ): Promise<ChallengePoll> {
      const sleep = options_.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      // 服务端给的 interval 是秒；留 10% 余量避免边界抖动被判 429
      const intervalMs = Math.max(200, Math.floor(created.interval * 1000 * 1.1));
      const timeoutMs = options_.timeoutMs ?? created.expiresIn * 1000;
      const startedAt = Date.now();
      for (;;) {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= timeoutMs) return { status: 'expired' };
        const result = await this.poll(created.challengeId);
        if (result.status !== 'pending') return result;
        options_.onPending?.(elapsed);
        await sleep(intervalMs);
      }
    },

    /**
     * 校验**事件回调**的签名（docs/06 §7.1 的出站 webhook）。
     *
     * ★ 平台推给调用方的 webhook 也要验签——否则任何人都能伪造
     *   「policy.granted」事件去驱动调用方的业务逻辑。
     */
    async verifyWebhook(input: { headers: Record<string, string | undefined>; rawBody: string; toleranceMs?: number }): Promise<{ ok: boolean; reason?: string }> {
      const signature = input.headers['x-gate-signature'];
      if (signature === undefined || !signature.startsWith('sha256=')) {
        return { ok: false, reason: 'missing_signature' };
      }
      const { createHmac, timingSafeEqual, createHash } = await import('node:crypto');
      const expected = createHmac('sha256', options.secret).update(input.rawBody, 'utf8').digest('hex');
      const provided = signature.slice('sha256='.length);
      const a = createHash('sha256').update(expected).digest();
      const b = createHash('sha256').update(provided).digest();
      if (!timingSafeEqual(a, b)) return { ok: false, reason: 'signature_mismatch' };
      return { ok: true };
    },
  };
}

function describeError(payload: unknown): string {
  if (payload !== null && typeof payload === 'object' && 'error' in payload) {
    return String((payload as { error: unknown }).error);
  }
  return '未知错误';
}

// ─────────────────────────── 服务端侧辅助 ───────────────────────────

/**
 * 服务端侧：给调用方生成一对「客户端存储 + nonce 存储」的内存实现。
 *
 * ★ 用途是**让调用方能写集成测试**（`@gate/verify-client` 的配套）。
 *   生产环境的服务端应使用 PG 实现（`ag_verify_clients` + nonce 去重表）。
 */
export function createInMemoryServerStores(): { clients: VerifyClientStore; nonces: NonceStore } {
  const clients = new Map<string, { clientId: string; name: string; scopes: string[]; status: 'active' }>();
  const secrets = new Map<string, string>();
  const nonces = new Map<string, number>();

  return {
    clients: {
      async find(clientId) {
        const found = clients.get(clientId);
        return found === undefined ? undefined : { ...found, scopes: [...found.scopes] };
      },
      async resolveSecret(clientId) {
        return secrets.get(clientId);
      },
    },
    nonces: {
      async claim(clientId, nonce, expiresAt) {
        const key = `${clientId}\u0000${nonce}`;
        if (nonces.has(key)) return false;
        nonces.set(key, expiresAt.getTime());
        return true;
      },
    },
  };
}
