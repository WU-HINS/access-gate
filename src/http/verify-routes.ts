/**
 * 协同验证 HTTP 端点（M5-1 / M5-2 / M5-3 的对外入口）—— docs/06 §7.2.3。
 *
 * ```
 *   POST /api/verify/v1/assert               签名 + assert:read    资格断言（核心）
 *   POST /api/verify/v1/challenge            签名 + challenge:create  发起设备码流
 *   GET  /api/verify/v1/challenge/:id        签名                   轮询
 *   POST /api/verify/v1/revoke               签名 + assert:read    撤销临时关联
 *   GET  /api/verify/v1/jwks                 **匿名**              断言签名公钥
 * ```
 *
 * ★ 一处极易写错的关键细节：`bodyHash` 必须基于**原始请求体字节**（`ctx.rawBody`），
 *   而不是「解析后再 `JSON.stringify`」——后者会因键顺序/空格/数字格式差异而与
 *   调用方算出的签名不一致。这类 bug 表现是「本地测试通过、真实调用方全部 401」。
 */

import type { Logger } from '../kernel/logger.ts';
import type { Route, RouteResult } from './server.ts';

import {
  SIGNATURE_HEADERS,
  toPublicMessage,
  verifySignedRequest,
  type NonceStore,
  type VerifyClientStore,
} from '../verify/hmac.ts';
import { signAssertion, type SigningKeySet } from '../verify/jws.ts';
import type { DeviceCodeService } from '../verify/device-code.ts';

// ─────────────────────────── 依赖 ───────────────────────────

/** 断言数据来源（把主体解析为「此人有什么资格」）。 */
export interface AssertionSource {
  /**
   * 查某主体在 claims 上的断言。
   *
   * 返回 `null` 表示**主体未知**（不是「不满足」）——两者语义不同：
   * 前者应回 `matched: false` 且不签发（无主体可信），后者回 `matched: true` 但 eligible=false。
   */
  lookup(subject: { type: string; value: string }, claims: readonly string[]): Promise<{
    matched: boolean;
    displayName?: string;
    assertions: Record<string, unknown>;
    /** 用于审计与撤销的断言 id */
    assertionId?: string;
  } | null>;
}

export interface VerifyRoutesDeps {
  clients: VerifyClientStore;
  nonces: NonceStore;
  deviceCode: DeviceCodeService;
  signingKeys: SigningKeySet;
  assertionSource: AssertionSource;
  /** 平台对外地址（断言的 `iss`） */
  issuer: string;
  /** 轮换过渡期内的旧 secret（可选） */
  previousSecrets?: (clientId: string, now: Date) => string[];
  logger?: Logger;
  now?: () => Date;
}

// ─────────────────────────── 请求体形状 ───────────────────────────

interface AssertBody {
  subject?: { type?: unknown; value?: unknown };
  claims?: unknown;
}

interface ChallengeBody {
  subject?: { type?: unknown; value?: unknown };
  scopes?: unknown;
}

function readSubject(raw: unknown): { type: string; value: string } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const subject = raw as { type?: unknown; value?: unknown };
  if (typeof subject.type !== 'string' || typeof subject.value !== 'string') return undefined;
  if (subject.type.length === 0 || subject.value.length === 0) return undefined;
  return { type: subject.type, value: subject.value };
}

// ─────────────────────────── 路由 ───────────────────────────

export function createVerifyRoutes(deps: VerifyRoutesDeps): Route[] {
  const now = deps.now ?? (() => new Date());

  /** 统一的签名校验入口（把 headers 转成 string 供 HMAC 使用）。 */
  const authenticate = async (
    ctx: { headers: Record<string, string | undefined>; method: string; path: string; rawBody: string },
    options: { requiredScope?: string; subject?: { type: string; value: string } },
  ) => {
    // 头名统一转小写：HTTP 头大小写不敏感，但对象键是敏感的
    const normalized: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(ctx.headers)) normalized[key.toLowerCase()] = value;
    return verifySignedRequest({
      headers: normalized,
      method: ctx.method,
      path: ctx.path,
      // ★ 用原始 body 字节计算 bodyHash
      body: ctx.rawBody,
      clients: deps.clients,
      nonces: deps.nonces,
      now: now(),
      ...(options.requiredScope === undefined ? {} : { requiredScope: options.requiredScope }),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      ...(deps.previousSecrets === undefined ? {} : { previousSecrets: deps.previousSecrets }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
  };

  return [
    // ── GET /api/verify/v1/jwks（**匿名访问**，docs/06 §7.2.3）──
    {
      method: 'GET',
      path: '/api/verify/v1/jwks',
      auth: 'none',
      csrfExempt: true,
      handler: async (): Promise<RouteResult> => {
        const jwks = await deps.signingKeys.jwks();
        return { status: 200, body: jwks };
      },
    },

    // ── POST /api/verify/v1/assert（核心）──
    {
      method: 'POST',
      path: '/api/verify/v1/assert',
      auth: 'none',
      csrfExempt: true,
      handler: async (ctx): Promise<RouteResult> => {
        const body = (ctx.body ?? {}) as AssertBody;
        const subject = readSubject(body.subject);
        if (subject === undefined) {
          return { status: 400, body: { error: '缺少 subject（应为 `{ type, value }`）' } };
        }
        const claims = Array.isArray(body.claims) ? body.claims.filter((c): c is string => typeof c === 'string') : [];

        const auth = await authenticate(ctx, { requiredScope: 'assert:read', subject });
        if (!auth.ok) {
          const publicInfo = toPublicMessage(auth.reason);
          return { status: publicInfo.status, body: { error: publicInfo.error }, headers: { 'x-gate-reject': auth.reason } };
        }

        const found = await deps.assertionSource.lookup(subject, claims);
        if (found === null) {
          // 主体不存在：`matched: false`（**不签发**——没有主体可背书）
          return { status: 200, body: { matched: false, subject, issuedAt: now().toISOString() } };
        }

        // 只回调用方请求的 claims（最小披露）
        const assertions: Record<string, unknown> = {};
        for (const claim of claims) {
          if (Object.prototype.hasOwnProperty.call(found.assertions, claim)) assertions[claim] = found.assertions[claim];
        }

        const issuedAt = now();
        const ttl = 300;
        const signature = await signAssertion({
          payload: {
            iss: deps.issuer,
            sub: subject.value,
            subjectType: subject.type,
            ...(found.displayName === undefined ? {} : { displayName: found.displayName }),
            assertions,
            iat: Math.floor(issuedAt.getTime() / 1000),
            exp: Math.floor(issuedAt.getTime() / 1000) + ttl,
          },
          key: deps.signingKeys.requireActive(),
          now: issuedAt,
          ttlSeconds: ttl,
          ...(found.assertionId === undefined ? { jti: `as_${subject.value}_${issuedAt.getTime()}` } : { jti: found.assertionId }),
        });

        return {
          status: 200,
          body: {
            matched: found.matched,
            subject: { ...subject, ...(found.displayName === undefined ? {} : { displayName: found.displayName }) },
            assertions,
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + ttl * 1000).toISOString(),
            issuer: deps.issuer,
            signature,
          },
        };
      },
    },

    // ── POST /api/verify/v1/challenge（发起设备码流）──
    {
      method: 'POST',
      path: '/api/verify/v1/challenge',
      auth: 'none',
      csrfExempt: true,
      handler: async (ctx): Promise<RouteResult> => {
        const body = (ctx.body ?? {}) as ChallengeBody;
        const subject = readSubject(body.subject);
        if (subject === undefined) return { status: 400, body: { error: '缺少 subject（应为 `{ type, value }`）' } };

        const auth = await authenticate(ctx, { requiredScope: 'challenge:create', subject });
        if (!auth.ok) {
          const publicInfo = toPublicMessage(auth.reason);
          return { status: publicInfo.status, body: { error: publicInfo.error }, headers: { 'x-gate-reject': auth.reason } };
        }

        const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [];
        const created = await deps.deviceCode.create({ clientId: auth.client.clientId, subject, scopes });
        return { status: 200, body: created };
      },
    },

    // ── GET /api/verify/v1/challenge/:id（轮询）──
    {
      method: 'GET',
      path: '/api/verify/v1/challenge/:id',
      auth: 'none',
      csrfExempt: true,
      handler: async (ctx): Promise<RouteResult> => {
        const match = /^\/api\/verify\/v1\/challenge\/([^/]+)$/.exec(ctx.path);
        if (match === null) return { status: 400, body: { error: '缺少 challengeId' } };
        const challengeId = decodeURIComponent(match[1]!);

        const auth = await authenticate(ctx, {});
        if (!auth.ok) {
          const publicInfo = toPublicMessage(auth.reason);
          return { status: publicInfo.status, body: { error: publicInfo.error }, headers: { 'x-gate-reject': auth.reason } };
        }

        const polled = await deps.deviceCode.poll(challengeId);
        // ★ 用「提前返回」而不是复合条件，让类型收窄清晰（也更好读）
        if ('ok' in polled) {
          const status = polled.reason === 'not_found' ? 404 : polled.reason === 'poll_too_fast' ? 429 : 200;
          return { status, body: { status: polled.reason, error: polled.message } };
        }
        if (polled.status === 'approved') {
          // 用户已确认 → 签发断言（与 /assert 同一套签名路径）
          const issuedAt = now();
          const ttl = 300;
          const found = await deps.assertionSource.lookup(
            { type: 'platform_user_id', value: polled.userId },
            ['eligible', 'tier', 'tags', 'policies'],
          );
          const signature = await signAssertion({
            payload: {
              iss: deps.issuer,
              sub: polled.userId,
              subjectType: 'platform_user_id',
              ...(found?.displayName === undefined ? {} : { displayName: found.displayName }),
              assertions: found?.assertions ?? {},
              iat: Math.floor(issuedAt.getTime() / 1000),
              exp: Math.floor(issuedAt.getTime() / 1000) + ttl,
            },
            key: deps.signingKeys.requireActive(),
            now: issuedAt,
            ttlSeconds: ttl,
            jti: `ch_${challengeId}`,
          });
          return {
            status: 200,
            body: {
              status: 'approved',
              assertion: {
                matched: found?.matched ?? false,
                subject: { type: 'platform_user_id', value: polled.userId },
                assertions: found?.assertions ?? {},
                issuedAt: issuedAt.toISOString(),
                expiresAt: new Date(issuedAt.getTime() + ttl * 1000).toISOString(),
                issuer: deps.issuer,
                signature,
              },
            },
          };
        }
        return { status: 200, body: { status: polled.status } };
      },
    },

    // ── POST /api/verify/v1/revoke（撤销临时关联）──
    {
      method: 'POST',
      path: '/api/verify/v1/revoke',
      auth: 'none',
      csrfExempt: true,
      handler: async (ctx): Promise<RouteResult> => {
        const body = (ctx.body ?? {}) as { challengeId?: unknown; subject?: unknown };
        const auth = await authenticate(ctx, { requiredScope: 'assert:read' });
        if (!auth.ok) {
          const publicInfo = toPublicMessage(auth.reason);
          return { status: publicInfo.status, body: { error: publicInfo.error }, headers: { 'x-gate-reject': auth.reason } };
        }
        if (typeof body.challengeId !== 'string') return { status: 400, body: { error: '缺少 challengeId' } };
        const result = await deps.deviceCode.revoke(body.challengeId);
        deps.logger?.info('撤销协同验证关联', { clientId: auth.client.clientId, challengeId: body.challengeId });
        return { status: 200, body: result };
      },
    },
  ];
}

export { SIGNATURE_HEADERS };
