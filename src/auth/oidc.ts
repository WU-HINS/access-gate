/**
 * OIDC 授权码流程（M0-9 / 补齐 M1-7 的签名验证）。
 *
 * ★ 这是本项目**唯一**需要真正验签的地方，因此每一道防线都必须落地：
 *   | 防线 | 防的是什么 |
 *   |---|---|
 *   | `state` | CSRF（攻击者伪造回调把**自己的**账号绑到受害者会话上） |
 *   | `nonce` | ID Token 重放（拿一个合法但属于别的登录流程的 token） |
 *   | PKCE (`S256`) | 授权码拦截（公开客户端没有 client_secret，必须靠 PKCE） |
 *   | JWKS 验签 + `iss`/`aud`/`exp` | 伪造 token / IdP 混淆 / 过期重放 |
 *
 * 实现说明：验签用 `jose`（`createRemoteJWKSet` + `jwtVerify`）——签名验证是密码学代码，
 * 自己实现的风险远高于依赖它。但**声明层校验**（`iss`/`aud`/`exp`）我们仍然自己再查一遍
 * （`validateOidcClaims`），因为那是「业务语义」而非密码学：它要能给出可读的拒绝原因。
 */

import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { validateOidcClaims, OidcClaimError, type OidcClaims } from '../core/identity.ts';

// ─────────────────────────── 配置与传输 ───────────────────────────

export interface OidcConfig {
  /** 期望的 issuer（必须精确匹配，防 IdP 混淆） */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** 回调地址，必须与 IdP 注册值完全一致 */
  redirectUri: string;
  scopes?: readonly string[];
  /** 允许的签名算法（默认只允许非对称算法；**绝不**允许 none / HS*） */
  allowedAlgorithms?: readonly string[];
}

/** 默认只允许非对称签名算法。`none` 与 `HS*` 会让「验签」形同虚设。 */
const DEFAULT_ALGS = ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'EdDSA', 'PS256', 'PS384', 'PS512'];

export interface HttpFetcher {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
  }>;
}

export interface OidcDeps {
  config: OidcConfig;
  fetch: HttpFetcher;
  now?: () => Date;
}

export class OidcError extends Error {
  override readonly name = 'OidcError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ─────────────────────────── 登录事务 ───────────────────────────

/**
 * 一次登录流程的临时状态（state / nonce / PKCE verifier）。
 *
 * ★ 必须**一次性**消费：回调时取到即删除。否则同一个 state 可被重放多次，
 *   `state` 的 CSRF 防护就失效了。
 */
export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** 发起登录时的返回地址（登录成功后跳回） */
  returnTo?: string;
  /**
   * ★ 发起登录时携带的**目标站点**（内部 id）——回调成功后自动选中它。
   *
   * ★ 它必须在事务里（而不是"回调参数"）：站点在 `beginLogin` 时指定，
   *   回调只带回 `state`/`code`，中间隔着 IdP 往返。
   * ★★ 字段名刻意不叫 `siteId`：本表是**平台级**表，这是"用户**想去**哪个站点"
   *   这个普通业务字段，**不是作用域键**（R1 门禁按列名触发，见 `docs/02`）。
   * ★ 可选：不带站点参数的登录是正常路径（登录后由用户自选）。
   */
  targetSiteId?: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface LoginTransactionStore {
  /** 保存并在回调时**原子取出**（实现方必须保证取出即删除） */
  put(transaction: LoginTransaction): Promise<void>;
  /** 取出并删除；不存在返回 undefined */
  take(state: string): Promise<LoginTransaction | undefined>;
  /** 清理过期事务 */
  purgeExpired(now: Date): Promise<number>;
}

export class InMemoryLoginTransactionStore implements LoginTransactionStore {
  private readonly byState = new Map<string, LoginTransaction>();
  async put(transaction: LoginTransaction): Promise<void> {
    this.byState.set(transaction.state, transaction);
  }
  async take(state: string): Promise<LoginTransaction | undefined> {
    const found = this.byState.get(state);
    if (found === undefined) return undefined;
    this.byState.delete(state);
    return found;
  }
  async purgeExpired(now: Date): Promise<number> {
    let purged = 0;
    for (const [state, transaction] of this.byState) {
      if (transaction.expiresAt.getTime() <= now.getTime()) {
        this.byState.delete(state);
        purged += 1;
      }
    }
    return purged;
  }
}

// ─────────────────────────── PKCE ───────────────────────────

export function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** PKCE 的 `code_challenge = BASE64URL(SHA256(code_verifier))`（RFC 7636 S256）。 */
export function codeChallengeS256(codeVerifier: string): string {
  return base64Url(createHash('sha256').update(codeVerifier).digest());
}

export function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

// ─────────────────────────── 发现文档 ───────────────────────────

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: readonly string[];
}

interface CacheEntry {
  discovery: OidcDiscovery;
  fetchedAt: number;
}

export class OidcClient {
  private readonly config: OidcConfig;
  private readonly fetcher: HttpFetcher;
  private readonly now: () => Date;
  private discoveryCache: CacheEntry | undefined;
  /** JWKS 本地缓存（自己管，见 jwksFor 的说明） */
  private jwksCache: { jwks: ReturnType<typeof createLocalJWKSet>; expiresAt: number } | undefined;

  constructor(deps: OidcDeps) {
    this.config = deps.config;
    this.fetcher = deps.fetch;
    this.now = deps.now ?? (() => new Date());
  }

  get redirectUri(): string {
    return this.config.redirectUri;
  }

  /**
   * 拉取并校验发现文档。
   *
   * ★ `issuer` 必须与配置**完全一致**：OIDC 规范要求如此，且这是防
   *   「把 token endpoint 指向攻击者」的关键一步。发现文档里的 issuer 不匹配即拒绝。
   */
  async discover(): Promise<OidcDiscovery> {
    const cached = this.discoveryCache;
    const ttlMs = 10 * 60_000;
    if (cached !== undefined && this.now().getTime() - cached.fetchedAt < ttlMs) return cached.discovery;

    const url = `${this.config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await this.fetcher(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (response.status < 200 || response.status >= 300) {
      throw new OidcError('discovery_failed', `获取 OIDC 发现文档失败（${response.status}）：${url}`);
    }
    let discovery: OidcDiscovery;
    try {
      discovery = JSON.parse(response.text) as OidcDiscovery;
    } catch {
      throw new OidcError('discovery_invalid', 'OIDC 发现文档不是合法 JSON');
    }
    for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof discovery[field] !== 'string' || discovery[field].length === 0) {
        throw new OidcError('discovery_invalid', `OIDC 发现文档缺少 ${field}`);
      }
    }
    if (discovery.issuer !== this.config.issuer) {
      throw new OidcError(
        'issuer_mismatch',
        `发现文档的 issuer '${discovery.issuer}' 与配置 '${this.config.issuer}' 不一致（可能是 IdP 混淆）`,
      );
    }
    this.discoveryCache = { discovery, fetchedAt: this.now().getTime() };
    return discovery;
  }

  /**
   * 取 JWKS 并构造**本地**验签器。
   *
   * ★ 为什么不用 `createRemoteJWKSet`：它的拉取走全局 `fetch`，会**绕过**宿主注入的
   *   出站通道——那样 JWKS 拉取就不受白名单/超时/代理约束，离线环境也无法验证。
   *   这里自己经 `this.fetcher` 拉取、自己做缓存与失败冷却，用 `createLocalJWKSet` 验签。
   *   代价是要自己管缓存——但换来了「所有出站都经同一通道」这条可审计的性质。
   */
  private async jwksFor(discovery: OidcDiscovery): Promise<ReturnType<typeof createLocalJWKSet>> {
    const now = this.now().getTime();
    const cached = this.jwksCache;
    if (cached !== undefined && now < cached.expiresAt) return cached.jwks;

    const response = await this.fetcher(discovery.jwks_uri, { method: 'GET', headers: { Accept: 'application/json' } });
    if (response.status < 200 || response.status >= 300) {
      // 冷却：避免下游故障时每个请求都去打 JWKS
      this.jwksCache = {
        jwks: cached?.jwks ?? createLocalJWKSet({ keys: [] }),
        expiresAt: now + 30_000,
      };
      throw new OidcError('jwks_fetch_failed', `获取 JWKS 失败（${response.status}）：${discovery.jwks_uri}`);
    }
    let jwksDocument: { keys?: unknown };
    try {
      jwksDocument = JSON.parse(response.text) as { keys?: unknown };
    } catch {
      throw new OidcError('jwks_invalid', 'JWKS 不是合法 JSON');
    }
    if (!Array.isArray(jwksDocument.keys) || jwksDocument.keys.length === 0) {
      throw new OidcError('jwks_invalid', 'JWKS 中没有可用密钥');
    }
    const jwks = createLocalJWKSet(jwksDocument as unknown as Parameters<typeof createLocalJWKSet>[0]);
    this.jwksCache = { jwks, expiresAt: now + 5 * 60_000 };
    return jwks;
  }

  // ── 步骤 1：构造授权 URL ──

  async beginLogin(options: { returnTo?: string; targetSiteId?: string; transactionTtlMs?: number } = {}): Promise<{
    url: string;
    transaction: LoginTransaction;
  }> {
    const discovery = await this.discover();
    const now = this.now();
    const transaction: LoginTransaction = {
      state: randomToken(24),
      nonce: randomToken(24),
      codeVerifier: randomToken(32),
      ...(options.returnTo === undefined ? {} : { returnTo: options.returnTo }),
      // ★ 目标站点随事务往返（回调时据此自动选中；见 `LoginTransaction.targetSiteId`）
      ...(options.targetSiteId === undefined ? {} : { targetSiteId: options.targetSiteId }),
      createdAt: now,
      expiresAt: new Date(now.getTime() + (options.transactionTtlMs ?? 10 * 60_000)),
    };

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', (this.config.scopes ?? ['openid', 'profile', 'email']).join(' '));
    url.searchParams.set('state', transaction.state);
    url.searchParams.set('nonce', transaction.nonce);
    url.searchParams.set('code_challenge', codeChallengeS256(transaction.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), transaction };
  }

  // ── 步骤 2：用 code 换 token 并验签 ──

  async completeLogin(params: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<{ claims: OidcClaims; raw: JWTPayload; idToken: string }> {
    const discovery = await this.discover();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: params.codeVerifier,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    // 机密客户端才带 client_secret（公开客户端靠 PKCE）
    if (this.config.clientSecret !== undefined && this.config.clientSecret.length > 0) {
      headers['Authorization'] = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`;
    }

    const response = await this.fetcher(discovery.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new OidcError('token_exchange_failed', `授权码换取 token 失败（${response.status}）：${response.text.slice(0, 300)}`);
    }
    let payload: { id_token?: string; access_token?: string; error?: string; error_description?: string };
    try {
      payload = JSON.parse(response.text) as typeof payload;
    } catch {
      throw new OidcError('token_response_invalid', 'token 端点返回的不是合法 JSON');
    }
    if (typeof payload.id_token !== 'string' || payload.id_token.length === 0) {
      throw new OidcError('missing_id_token', `token 响应缺少 id_token${payload.error === undefined ? '' : `（${payload.error}）`}`);
    }

    // ★ 验签：算法白名单 + JWKS；jose 会校验 exp/nbf/iat（带容差）
    const allowed = this.config.allowedAlgorithms ?? DEFAULT_ALGS;
    let raw: JWTPayload;
    try {
      const verified = await jwtVerify(payload.id_token, await this.jwksFor(discovery), {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        algorithms: [...allowed],
        clockTolerance: 60,
      });
      raw = verified.payload;
    } catch (error) {
      throw new OidcError(
        'signature_verification_failed',
        `ID Token 验签失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // ★ nonce 必须匹配：防「拿一个合法但属于别的流程的 token」重放
    if (raw['nonce'] !== params.nonce) {
      throw new OidcError('nonce_mismatch', 'ID Token 的 nonce 与本次登录流程不匹配（可能是重放）');
    }

    // ★ 再走一遍自实现的声明层校验：给出**可读**的拒绝原因（jose 的报错偏底层）
    const claims = raw as unknown as OidcClaims;
    try {
      validateOidcClaims(claims, {
        expectedIssuer: this.config.issuer,
        allowedAudiences: [this.config.clientId],
        now: this.now(),
        clockToleranceSec: 60,
      });
    } catch (error) {
      throw new OidcError('claims_invalid', error instanceof OidcClaimError ? error.message : String(error));
    }

    return { claims, raw, idToken: payload.id_token };
  }

  /**
   * 构造登出 URL（RP-Initiated Logout）。
   *
   * 没有 `end_session_endpoint` 时返回 `null`——调用方应只清本地会话。
   * 不要「猜」一个登出地址：那会把用户送到错误的地方。
   */
  async endSessionUrl(options: { idTokenHint?: string; postLogoutRedirectUri?: string } = {}): Promise<string | null> {
    const discovery = await this.discover();
    if (discovery.end_session_endpoint === undefined) return null;
    const url = new URL(discovery.end_session_endpoint);
    if (options.idTokenHint !== undefined) url.searchParams.set('id_token_hint', options.idTokenHint);
    if (options.postLogoutRedirectUri !== undefined) url.searchParams.set('post_logout_redirect_uri', options.postLogoutRedirectUri);
    return url.toString();
  }
}

// ─────────────────────────── 静态校验 ───────────────────────────

/** 启动期校验配置（缺项/危险项必须 fail-fast，而不是等第一次登录才发现）。 */
export function assertOidcConfigUsable(config: OidcConfig): void {
  if (!/^https:\/\//.test(config.issuer) && !/^http:\/\/localhost/.test(config.issuer)) {
    throw new OidcError('insecure_issuer', `issuer 必须是 https（或 localhost 用于本地开发）：${config.issuer}`);
  }
  if (config.clientId.length === 0) throw new OidcError('missing_client_id', 'clientId 不能为空');
  if (!config.redirectUri.includes('/')) throw new OidcError('invalid_redirect_uri', `redirectUri 非法：${config.redirectUri}`);
  const allowed = config.allowedAlgorithms ?? DEFAULT_ALGS;
  for (const alg of allowed) {
    if (alg === 'none' || alg.startsWith('HS')) {
      throw new OidcError(
        'insecure_algorithm',
        `禁止的签名算法 '${alg}'：none 等于不验签；HS* 用 client_secret 当密钥，公开客户端可伪造`,
      );
    }
  }
}
