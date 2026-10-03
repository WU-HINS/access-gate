/**
 * outbound OIDC 端点（平台作为 IdP）—— docs/06 §6.0.1、§6.1。
 *
 * ```
 *   GET  /.well-known/openid-configuration
 *   GET  /oauth/authorize     授权端点（PKCE S256 必需）
 *   POST /oauth/token         令牌端点（authorization_code + refresh_token）
 *   GET  /oauth/userinfo      用户信息
 *   GET  /oauth/jwks.json     公钥集
 *   POST /oauth/revoke        令牌吊销
 * ```
 *
 * ★ 本模块是**生产落地 R1 暴露的缺口**：M5-6 的 outbound 方向此前
 *   只有「数据模型 + 发现文档生成函数」，**端点一个都没实现**——
 *   于是平台无法作为 IdP，真实模式下的登录链路也就无从验证。
 *
 * ★ 五处必须严格的地方（OIDC 的常见漏洞面）：
 *
 * 1. **PKCE 强制且只允许 S256**——`plain` 的 challenge 与 verifier 相同，
 *    一旦授权码在重定向中被截获，攻击者直接拿着它换令牌；
 * 2. **授权码一次性**——用后立即删除。重复使用是「授权码注入」攻击的入口；
 * 3. **`redirect_uri` 精确匹配**——不做前缀/通配匹配，否则是**开放重定向**，
 *    授权码会被送到攻击者控制的地址；
 * 4. **`id_token` 的 `aud` 必须是 client_id**——RP 靠它判断「这个令牌是发给我的」；
 * 5. **`nonce` 原样回传**——RP 靠它防重放。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Route, RouteResult } from './server.ts';
import type { Logger } from '../kernel/logger.ts';
import { signJwt, toJwks, type SigningKey, type JwksDocument } from '../verify/jws.ts';
import { exportJWK } from 'jose';
import { buildDiscoveryDocument } from '../auth/federation.ts';

// ─────────────────────────── 类型 ───────────────────────────

export interface OAuthClient {
  clientId: string;
  name: string;
  /** ★ 精确匹配的允许回调地址（不做前缀匹配） */
  redirectUris: readonly string[];
  scopes: readonly string[];
  status: 'active' | 'disabled';
}

/** 授权码（短期、一次性、绑定 PKCE challenge）。 */
export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  subject: string;
  displayName?: string;
  scopes: readonly string[];
  codeChallenge: string;
  nonce?: string;
  /** 签发时间（用于过期判断） */
  issuedAt: Date;
  /** ★ 已被兑换过（防重复使用） */
  redeemed: boolean;
}

export interface OAuthStore {
  /**
   * ★★ 注册 / 更新一个客户端。
   *
   * ★ 为什么把它**提到接口上**：内存实现此前叫 `registerClient`（**同步**），
   *   而 PG 实现叫 `saveClient`（**异步**）——**两个名字、两种时序**。
   *   后果是装配层没法无条件替换实现（真实模式只能写 `instanceof` 分支，
   *   而那正是"先用内存、以后再接"最容易留下的形态）。
   *   ★ 统一成接口方法后，两种实现**可以直接互换**。
   */
  saveClient(client: OAuthClient): Promise<void>;
  findClient(clientId: string): Promise<OAuthClient | undefined>;
  saveCode(code: AuthorizationCode): Promise<void>;
  /** 取并**标记为已兑换**（原子；返回 undefined 表示不存在或已用过） */
  redeemCode(code: string): Promise<AuthorizationCode | undefined>;
  /** 记录 refresh token（**只存哈希**） */
  saveRefresh(tokenHash: string, input: { clientId: string; subject: string; scopes: readonly string[]; expiresAt: Date }): Promise<void>;
  findRefresh(tokenHash: string): Promise<{ clientId: string; subject: string; scopes: readonly string[]; expiresAt: Date; revoked: boolean } | undefined>;
  revoke(tokenHash: string): Promise<void>;
}

export class InMemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly refresh = new Map<string, { clientId: string; subject: string; scopes: readonly string[]; expiresAt: Date; revoked: boolean }>();

  /** ★ 接口方法（与 PG 实现同名同语义，可互换） */
  async saveClient(client: OAuthClient): Promise<void> {
    this.clients.set(client.clientId, client);
  }
  /** ★ 同步别名：既有调用点（测试等）仍可用——它只做**同一件事**，不构成第二套语义 */
  registerClient(client: OAuthClient): void {
    this.clients.set(client.clientId, client);
  }
  async findClient(clientId: string): Promise<OAuthClient | undefined> {
    return this.clients.get(clientId);
  }
  async saveCode(code: AuthorizationCode): Promise<void> {
    this.codes.set(code.code, code);
  }
  async redeemCode(code: string): Promise<AuthorizationCode | undefined> {
    const found = this.codes.get(code);
    if (found === undefined || found.redeemed) return undefined;
    // ★ 一次性：标记后不可再用（不删除，便于「重复使用」的审计）
    found.redeemed = true;
    return found;
  }
  async saveRefresh(tokenHash: string, input: { clientId: string; subject: string; scopes: readonly string[]; expiresAt: Date }): Promise<void> {
    this.refresh.set(tokenHash, { ...input, revoked: false });
  }
  async findRefresh(tokenHash: string) {
    return this.refresh.get(tokenHash);
  }
  async revoke(tokenHash: string): Promise<void> {
    const found = this.refresh.get(tokenHash);
    if (found !== undefined) found.revoked = true;
  }
}

export interface OAuthRoutesDeps {
  store: OAuthStore;
  /** 平台对外地址（`iss`） */
  issuer: string;
  signingKeys: readonly SigningKey[];
  /** 取主体的展示信息（userinfo 用） */
  loadSubject: (subject: string) => Promise<{ displayName?: string; email?: string; emailVerified?: boolean } | undefined>;
  logger?: Logger;
  now?: () => Date;
  /** 授权码有效期（秒，默认 60） */
  codeTtlSeconds?: number;
  /** id_token 有效期（秒，默认 300） */
  idTokenTtlSeconds?: number;
  /** refresh token 有效期（秒，默认 30 天） */
  refreshTtlSeconds?: number;
}

// ─────────────────────────── PKCE ───────────────────────────

/** S256 challenge 计算（`base64url(sha256(verifier))`）。 */
export function codeChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

/**
 * 校验 PKCE。
 *
 * ★ 只接受 `S256`：`plain` 等于不校验（challenge == verifier），
 *   而它的存在意义只是「让 RP 声明自己支持 PKCE」——安全上等于零。
 */
export function verifyPkce(input: { codeChallenge: string; codeChallengeMethod?: string; codeVerifier: string }): { ok: true } | { ok: false; message: string } {
  if (input.codeChallengeMethod !== undefined && input.codeChallengeMethod !== 'S256') {
    return { ok: false, message: `不支持的 code_challenge_method '${input.codeChallengeMethod}'（只接受 S256；plain 等于不校验）` };
  }
  const expected = input.codeChallenge;
  const actual = codeChallengeOf(input.codeVerifier);
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  // ★ 常量时间比较：普通 `===` 会因为提前返回而泄露前缀匹配长度
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, message: 'PKCE 校验失败（code_verifier 与 code_challenge 不匹配）' };
  }
  return { ok: true };
}

// ─────────────────────────── 路由 ───────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createOAuthRoutes(deps: OAuthRoutesDeps): Route[] {
  const now = deps.now ?? (() => new Date());
  const codeTtl = deps.codeTtlSeconds ?? 60;
  const idTtl = deps.idTokenTtlSeconds ?? 300;
  const refreshTtl = deps.refreshTtlSeconds ?? 30 * 86_400;
  const issuer = deps.issuer.replace(/\/+$/, '');
  const activeKey = (): SigningKey | undefined => deps.signingKeys[0];

  /**
   * ★ R110：从**实际签名密钥**派生 Discovery 声明的算法。
   *
   * ★ 依据 `docs/06:410`：Discovery 内容必须由 JWKS 实际内容**派生**，不得手写——
   *   否则「声明了 ES256 但 JWKS 里没有 P-256 公钥」会让下游按声明选算法而**验签失败**。
   *
   * ★ 映射（按 `KeyObject.asymmetricKeyType`）：
   *   `ec`  → `ES256`（P-256；本平台的密钥生成路径只产出 P-256）
   *   `rsa` → `RS256`
   *   `ed25519` → `EdDSA`
   * ★ 未知类型**不声明**（宁可不声明，也不虚报）——★ 这正是「不虚报算法」的要点。
   */
  const algorithmsOfSigningKeys = async (keys: readonly SigningKey[]): Promise<string[]> => {
    const out = new Set<string>();
    for (const key of keys) {
      // ★ 用 jose 的 `exportJWK`（而不是 `KeyObject.asymmetricKeyType`）——
      //   本项目的 `KeyObject` 类型来自 **jose**（不是 `node:crypto`），
      //   没有 `asymmetricKeyType`；而 JWK 里既有 `kty` 也有 `crv`，信息更全。
      const jwk = (await exportJWK(key.publicKey)) as { kty?: string; crv?: string };
      if (jwk.kty === 'EC' && jwk.crv === 'P-256') out.add('ES256');
      else if (jwk.kty === 'EC' && jwk.crv === 'P-384') out.add('ES384');
      else if (jwk.kty === 'EC' && jwk.crv === 'P-521') out.add('ES512');
      else if (jwk.kty === 'RSA') out.add('RS256');
      else if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') out.add('EdDSA');
    }
    // ★ 空集时**不**回落成硬编码——回落等于虚报。
    return [...out];
  };

  return [
    // ── 发现文档 ──
    {
      method: 'GET',
      path: '/.well-known/openid-configuration',
      auth: 'none',
      handler: async (): Promise<RouteResult> => {
        // ★★★★ R110 修复：**Discovery 的算法必须从 JWKS 实际内容派生**，
        //   而不是硬编码 `['ES256']`。
        //   ★ `docs/06:410` 明确声明：「⚠️ **不得虚报算法**：若声明了 `ES256` 但 JWKS 里
        //     没有 P-256 公钥，下游按声明选算法会直接验签失败。
        //     Discovery 内容由 JWKS 实际内容**派生**，不手写。」
        //   ★ 而本处此前硬编码 `['ES256']`，**JWKS 却是动态的**（`toJwks(deps.signingKeys)`）——
        //     正好违反了这条声明。
        const document = buildDiscoveryDocument(issuer, await algorithmsOfSigningKeys(deps.signingKeys));
        return { status: 200, body: document };
      },
    },

    // ── 公钥集 ──
    {
      method: 'GET',
      path: '/oauth/jwks.json',
      auth: 'none',
      handler: async (): Promise<RouteResult> => {
        const jwks: JwksDocument = await toJwks(deps.signingKeys);
        return { status: 200, body: jwks };
      },
    },

    // ── 授权端点 ──
    {
      method: 'GET',
      path: '/oauth/authorize',
      auth: 'required',
      handler: async (ctx): Promise<RouteResult> => {
        const query = ctx.query;
        const clientId = query['client_id'] ?? '';
        const redirectUri = query['redirect_uri'] ?? '';
        const codeChallenge = query['code_challenge'] ?? '';
        const codeChallengeMethod = query['code_challenge_method'];
        const nonce = query['nonce'];

        const client = await deps.store.findClient(clientId);
        if (client === undefined || client.status !== 'active') {
          return { status: 400, body: { error: 'invalid_client', error_description: `未知或已停用的 client_id '${clientId}'` } };
        }
        // ★ 精确匹配回调地址（不做前缀/通配）——否则是开放重定向
        if (!client.redirectUris.includes(redirectUri)) {
          return {
            status: 400,
            body: {
              error: 'invalid_request',
              error_description: `redirect_uri '${redirectUri}' 不在该客户端的白名单内（必须精确匹配，防开放重定向）`,
            },
          };
        }
        // ★ PKCE 必需
        if (codeChallenge.length === 0) {
          return { status: 400, body: { error: 'invalid_request', error_description: '缺少 code_challenge——PKCE 是必需的' } };
        }
        if (codeChallengeMethod !== undefined && codeChallengeMethod !== 'S256') {
          return { status: 400, body: { error: 'invalid_request', error_description: 'code_challenge_method 只接受 S256' } };
        }
        if (ctx.principal === null) return { status: 401, body: { error: 'login_required' } };

        const code = randomBytes(32).toString('base64url');
        const requestedScopes = (query['scope'] ?? 'openid').split(' ').filter((scope) => scope.length > 0);
        await deps.store.saveCode({
          code,
          clientId,
          redirectUri,
          subject: ctx.principal.userId,
          scopes: requestedScopes,
          codeChallenge,
          ...(nonce === undefined ? {} : { nonce }),
          issuedAt: now(),
          redeemed: false,
        });
        deps.logger?.info('OIDC 授权码已签发', { clientId, subject: ctx.principal.userId, scopes: requestedScopes });
        // 302 回 RP（带 code 与 state）
        const location = `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}${
          query['state'] === undefined ? '' : `&state=${encodeURIComponent(query['state'])}`
        }`;
        return { status: 302, headers: { Location: location }, body: '' };
      },
    },

    // ── 令牌端点 ──
    {
      method: 'POST',
      path: '/oauth/token',
      auth: 'none',
      csrfExempt: true,
      handler: async (ctx): Promise<RouteResult> => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const grantType = String(body['grant_type'] ?? '');
        const clientId = String(body['client_id'] ?? '');
        const client = await deps.store.findClient(clientId);
        if (client === undefined || client.status !== 'active') {
          return { status: 401, body: { error: 'invalid_client' } };
        }

        if (grantType === 'refresh_token') {
          const tokenHash = hashToken(String(body['refresh_token'] ?? ''));
          const record = await deps.store.findRefresh(tokenHash);
          if (record === undefined || record.revoked || record.expiresAt.getTime() < now().getTime()) {
            return { status: 400, body: { error: 'invalid_grant', error_description: 'refresh_token 无效、已吊销或已过期' } };
          }
          const subject = await deps.loadSubject(record.subject);
          return {
            status: 200,
            body: await issueTokens(
              deps,
              {
                client,
                subject: record.subject,
                scopes: record.scopes,
                ...(subject?.displayName === undefined ? {} : { displayName: subject.displayName }),
                ...(subject?.email === undefined ? {} : { email: subject.email }),
                ...(subject?.emailVerified === undefined ? {} : { emailVerified: subject.emailVerified }),
              },
              idTtl,
              refreshTtl,
              now,
            ),
          };
        }

        if (grantType !== 'authorization_code') {
          return { status: 400, body: { error: 'unsupported_grant_type', error_description: `不支持的 grant_type '${grantType}'` } };
        }

        const code = String(body['code'] ?? '');
        // ★ 取并标记已兑换（一次性）
        const record = await deps.store.redeemCode(code);
        if (record === undefined) {
          return { status: 400, body: { error: 'invalid_grant', error_description: '授权码无效、已使用或不存在（授权码是一次性的）' } };
        }
        if (record.clientId !== clientId) {
          return { status: 400, body: { error: 'invalid_grant', error_description: '授权码不属于该客户端' } };
        }
        if (now().getTime() - record.issuedAt.getTime() > codeTtl * 1000) {
          return { status: 400, body: { error: 'invalid_grant', error_description: `授权码已过期（有效期 ${codeTtl}s）` } };
        }
        const pkce = verifyPkce({
          codeChallenge: record.codeChallenge,
          codeVerifier: String(body['code_verifier'] ?? ''),
        });
        if (!pkce.ok) return { status: 400, body: { error: 'invalid_grant', error_description: pkce.message } };

        const subject = await deps.loadSubject(record.subject);
        return {
          status: 200,
          body: await issueTokens(
            deps,
            {
              client,
              subject: record.subject,
              scopes: record.scopes,
              ...(record.nonce === undefined ? {} : { nonce: record.nonce }),
              ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
              ...(subject?.email === undefined ? {} : { email: subject.email }),
              ...(subject?.emailVerified === undefined ? {} : { emailVerified: subject.emailVerified }),
            },
            idTtl,
            refreshTtl,
            now,
          ),
        };
      },
    },

    // ── userinfo ──
    {
      method: 'GET',
      path: '/oauth/userinfo',
      auth: 'none',
      handler: async (ctx): Promise<RouteResult> => {
        const authorization = ctx.headers['authorization'] ?? '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
        if (token.length === 0) {
          return { status: 401, headers: { 'www-authenticate': 'Bearer' }, body: { error: 'invalid_token' } };
        }
        // ★ access_token 用与 refresh 同一套哈希存储（简化：此处按 refresh 表查）
        const record = await deps.store.findRefresh(hashToken(token));
        if (record === undefined || record.revoked || record.expiresAt.getTime() < now().getTime()) {
          return { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, body: { error: 'invalid_token' } };
        }
        const subject = await deps.loadSubject(record.subject);
        return {
          status: 200,
          body: {
            sub: record.subject,
            ...(subject?.displayName === undefined ? {} : { name: subject.displayName }),
            ...(subject?.email === undefined ? {} : { email: subject.email }),
            ...(subject?.emailVerified === undefined ? {} : { email_verified: subject.emailVerified }),
          },
        };
      },
    },

    // ── 吊销 ──
    {
      method: 'POST',
      path: '/oauth/revoke',
      auth: 'none',
      csrfExempt: true,
      handler: async (ctx): Promise<RouteResult> => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const token = String(body['token'] ?? '');
        if (token.length > 0) await deps.store.revoke(hashToken(token));
        // ★ 按 RFC 7009，无论令牌是否存在都返回 200（避免把它当成「令牌是否存在」的探针）
        return { status: 200, body: {} };
      },
    },
  ];
}

/** 签发 id_token + access_token + refresh_token。 */
async function issueTokens(
  deps: OAuthRoutesDeps,
  input: {
    client: OAuthClient;
    subject: string;
    scopes: readonly string[];
    nonce?: string;
    displayName?: string;
    email?: string;
    /**
     * ★ 必须暴露 `email_verified`：依赖它的 RP 策略（如「开发者登录要求邮箱已验证」）
     *   若拿不到这个 claim 会**永远无法通过**——而失败表现是「准入被拒」，
     *   排查时很容易误以为是策略配置问题。
     */
    emailVerified?: boolean;
  },
  idTtl: number,
  refreshTtl: number,
  now: () => Date,
): Promise<Record<string, unknown>> {
  const key = deps.signingKeys[0];
  if (key === undefined) throw new Error('没有可用于签发的签名密钥');
  const issuedAt = now();
  // ★ id_token：aud 必须是 client_id，nonce 原样回传
  const idToken = await signJwt({
    key,
    ttlSeconds: idTtl,
    now: issuedAt,
    payload: {
      iss: deps.issuer.replace(/\/+$/, ''),
      sub: input.subject,
      aud: input.client.clientId,
      ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
      ...(input.displayName === undefined ? {} : { name: input.displayName }),
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.emailVerified === undefined ? {} : { email_verified: input.emailVerified }),
      auth_time: Math.floor(issuedAt.getTime() / 1000),
    },
  });

  const accessToken = randomBytes(32).toString('base64url');
  const refreshToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(issuedAt.getTime() + refreshTtl * 1000);
  await deps.store.saveRefresh(hashToken(accessToken), { clientId: input.client.clientId, subject: input.subject, scopes: input.scopes, expiresAt });
  await deps.store.saveRefresh(hashToken(refreshToken), { clientId: input.client.clientId, subject: input.subject, scopes: input.scopes, expiresAt });

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: idTtl,
    id_token: idToken,
    refresh_token: refreshToken,
    scope: input.scopes.join(' '),
  };
}
