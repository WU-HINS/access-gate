/**
 * 应用路由装配（M0-9 + M1-10 + M1-11）—— 把能力暴露成 HTTP 端点。
 *
 * 端点清单（每个都对应一个已实现的内核能力，没有「占位」）：
 *
 * | 方法 | 路径 | 用途 |
 * |---|---|---|
 * | GET  | `/healthz` | 存活与配置摘要 |
 * | GET  | `/api/auth/login` | 跳转 OIDC 授权（PKCE） |
 * | GET  | `/api/auth/callback` | 授权码回调（验签 + nonce + state） |
 * | POST | `/api/auth/logout` | 登出（清本地会话） |
 * | GET  | `/api/me` | 当前主体 + **CSRF token**（前端据此发写请求） |
 * | POST | `/api/me/site` | 切换当前站点（多站点用户） |
 * | GET  | `/api/me/eligibility` | **我的资格**（M1-10 的用户侧视图） |
 * | GET  | `/api/admin/subjects` | 管理端：主体列表 |
 * | POST | `/api/admin/identities/manual-bind` | 管理端：手工绑定 |
 * | GET/POST | `/api/admin/policies` | 管理端：策略列表 / 保存草稿 |
 * | POST | `/api/admin/policies/:code/publish` | 管理端：发布 |
 * | POST | `/api/admin/evaluate` | 管理端：试算 |
 *
 * ★ 认证与 CSRF 的边界由路由声明（`auth` / `csrfExempt`），而不是散落在各 handler 里——
 *   这样「哪些端点需要登录、哪些豁免 CSRF」可以一眼看全，也便于 CI 扫描。
 */

import {
  csrfTokenFor,
  principalFromClaims,
  SESSION_COOKIE,
  type Principal,
  type Realm,
  type SessionService,
} from '../auth/session.ts';
import type { OidcClient, LoginTransactionStore } from '../auth/oidc.ts';
import type { Route, RouteHandler, RouteResult, RequestContext } from '../http/server.ts';
import type { Handler as AdminHandler } from '../admin/api.ts';
import { guardSiteAdmission } from './site-admission.ts';
import { createLogger, type Logger } from '../kernel/logger.ts';

// ─────────────────────────── 依赖 ───────────────────────────

export interface EligibilitySource {
  /** 取某主体的资格报告（用户侧视图） */
  forUser(params: {
    principal: Principal;
    siteId: string;
  }): Promise<{ progress: { satisfied: number; total: number }; todos: string[]; results: unknown[] }>;
}

export interface AppRoutesDeps {
  /** 健康检查注册表（M6-7）；未提供则 /healthz 只返回固定 ok */
  health?: import('../kernel/health.ts').HealthRegistry;
  /** 指标集（M6-1）；未提供则不暴露 /metrics */
  metrics?: import('../kernel/metrics.ts').AppMetrics;
  /** 会话服务（回调里真正建立会话；切站点时更新主体） */
  sessions: SessionService;
  /**
   * ★ 登录准入解析（**两条链路隔离的执行点**）。
   *
   * 不提供时退化为「直接建立会话」——但那只适合测试与 demo。
   * **生产必须提供**：否则 `/api/auth/login?realm=developer` 会让任何人
   * 直接成为开发者（M7-3 的「必须已入驻」在真实路径上不会生效）。
   */
  loginResolver?: (input: {
    ref: string;
    oidcSubject: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
  }) => Promise<{ ok: true; realm: Realm; role: 'admin' | 'developer' | 'user'; principalId: string } | { ok: false; reason: string; message: string }>;
  oidc: OidcClient;
  loginTransactions: LoginTransactionStore;
  csrfSecret: string;
  /** 管理端处理器（M1-11）；未提供则不挂载管理端路由 */
  admin?: AdminHandler;
  /** 用户侧资格来源（M1-10）；未提供则不挂载资格路由 */
  eligibility?: EligibilitySource;
  /**
   * 签到服务（`docs/06 §4`）；未提供则不挂载签到路由（**显式不可用 > 返回空列表**）。
   *
   * ★ 用结构化类型而非 import `CheckinService`：路由层只负责透传，
   *   不承担签到的业务语义（避免 http ↔ core 的双向依赖）。
   */
  checkin?: {
    status(input: { siteId: string; userId: string }): Promise<unknown>;
    checkin(input: { siteId: string; userId: string }): Promise<unknown>;
    history(input: { siteId: string; userId: string; limit?: number }): Promise<unknown>;
  };
  /**
   * ★★ L-1：**邀请码核销**（`ag_invite_codes` 的使用路径）。
   *
   * ★ 返回值是**业务结论**（`ok: false` + `reason`），不是 HTTP 错误——
   *   与签到端点同一约定："码已用完"是可预期的结论，不是协议错误。
   * ★ 「核销成功但授予失败」也必须能表达（`ok: true` + `grantedPending: true`）：
   *   码的消耗**不可逆**，而事实写入**可重试**——把这两件事说成同一个"成功/失败"
   *   会让用户以为码没被用掉，从而反复尝试。
   */
  inviteRedeem?: (input: { siteId: string; userId: string; code: string }) => Promise<{
    ok: boolean;
    reason?: string;
    message?: string;
    /** 本次授予的事实（`fact.invite.*`） */
    granted?: Record<string, unknown>;
    /** ★ `true` = 核销已生效、但事实未写入成功（可带记录找运维重试） */
    grantedPending?: boolean;
  }>;
  /** 身份绑定存储；未提供则不挂载 /api/me/identities（显式不可用 > 返回空列表） */
  identities?: import('../core/identity.ts').IdentityStore;
  /**
   * ★★ **站点准入闸门**（`ag_email_rules`）——进入站点时校验。
   *
   * ★ 为什么它是**权威检查点**（而不是登录时）：登录是**平台级统一**的，
   *   站点由用户自选或传参指定。因此"这个邮箱能不能进这个站点"必须在
   *   **切换的那一刻**问**目标站点**——在登录时拿某个（默认）站点的规则去猜，
   *   是**错的站点**：用户选站点 B 时从未按 B 的规则校验过。
   * ★ 未装配 → 不启用闸门（等价于"该站点没有配置任何规则"）。
   */
  emailAdmission?: (input: {
    siteId: string;
    email: string;
  }) => Promise<{ allowed: boolean; reason: string }>;
  /**
   * 开发者入驻服务（邀请码核销 → 建号 → **写身份映射**）。
   *
   * ★ 未提供时 `/api/auth/onboard` 返回 501（显式不可用）。
   * ★ 真实模式下由 `serve.ts` 注入（含 `DbInvitationStore` + `recordDeveloperIdentity`）。
   */
  invitations?: import('../core/invitations.ts').InvitationService;
  logger?: Logger;
  /** 登录后默认落地的站点（单站点部署可直接给默认站点） */
  defaultSiteId?: string | null;
  /** 允许的返回地址前缀（防开放重定向） */
  allowedReturnPrefixes?: readonly string[];
  /** 应用版本（健康检查里返回） */
  version?: string;
}

// ─────────────────────────── 开放重定向防护 ───────────────────────────

/**
 * 校验 `returnTo`。
 *
 * ★ 必须只接受**相对路径**（以单个 `/` 开头）或显式允许的前缀。
 *   直接信任 `returnTo` 就是一个开放重定向（钓鱼常用手法）：
 *   `?returnTo=https://evil.example` 会把刚登录的用户送去攻击者站点。
 */
export function sanitizeReturnTo(raw: string | undefined, allowedPrefixes: readonly string[] = []): string {
  if (raw === undefined || raw.length === 0) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.includes('\\')) return '/';
  if (allowedPrefixes.length > 0 && !allowedPrefixes.some((prefix) => raw.startsWith(prefix))) return '/';
  return raw;
}

// ─────────────────────────── 路由 ───────────────────────────

export function createAppRoutes(deps: AppRoutesDeps): Route[] {
  const logger = deps.logger ?? createLogger({ level: 'info' });
  const allowedPrefixes = deps.allowedReturnPrefixes ?? ['/'];

  /** 由 ctx 解析出「当前站点」；没有则返回 undefined（由调用方决定 400 还是空）。 */
  const siteOf = (ctx: RequestContext): string | undefined => {
    const siteId = ctx.principal?.activeSiteId;
    if (typeof siteId === 'string' && siteId.length > 0) return siteId;
    if (typeof deps.defaultSiteId === 'string' && deps.defaultSiteId.length > 0) return deps.defaultSiteId;
    return undefined;
  };

  /**
   * 就绪探测（Kubernetes readinessProbe）。
   *
   * ★ 与 `/healthz` 的区别：本端点反映**依赖**状态。不 ready 时编排器把实例移出负载均衡，
   *   **但不重启**——这正是区分 liveness/readiness 的意义。
   */
  const healthReady: RouteHandler = async () => {
    if (deps.health === undefined) return { status: 200, body: { status: 'healthy' } };
    const report = await deps.health.run('readiness');
    return { status: report.status === 'unhealthy' ? 503 : 200, body: report };
  };

  /** 存活探测：**只**检查进程自身（事件循环），绝不检查依赖。 */
  const healthLive: RouteHandler = async () => {
    if (deps.health === undefined) return { status: 200, body: { status: 'healthy' } };
    const report = await deps.health.run('liveness');
    return { status: report.status === 'unhealthy' ? 503 : 200, body: report };
  };

  const health: RouteHandler = async (ctx) => {
    if (deps.health === undefined) {
      return {
        body: {
          status: 'ok',
          version: deps.version ?? '0.0.0',
          oidc: deps.oidc.redirectUri,
          features: { admin: deps.admin !== undefined, eligibility: deps.eligibility !== undefined },
          traceId: ctx.traceId,
        },
      } satisfies RouteResult;
    }
    const report = await deps.health.run();
    return {
      status: report.status === 'unhealthy' ? 503 : 200,
      body: {
        ...report,
        version: deps.version ?? '0.0.0',
        features: { admin: deps.admin !== undefined, eligibility: deps.eligibility !== undefined },
        traceId: ctx.traceId,
      },
    };
  };

  /** Prometheus 抓取端点（text/plain; version=0.0.4）。 */
  const metricsHandler: RouteHandler = () => {
    if (deps.metrics === undefined) return { status: 404, body: { error: '未启用指标' } };
    return { status: 200, body: deps.metrics.registry.render(), contentType: 'text/plain; version=0.0.4; charset=utf-8' };
  };

  const login: RouteHandler = async (ctx) => {
    const returnTo = sanitizeReturnTo(ctx.query['returnTo'], allowedPrefixes);
    // ★ 两条入口都要支持：
    //   · `/api/auth/login?realm=developer`（既有形式）
    //   · `/auth/oidc/:ref/start`（**docs/06 §6 声明的形式**，ref 是 `platform:developer`
    //     或 `platform:enduser`；含冒号，URL 里通常编码为 `platform%3Adeveloper`）
    //   `ref` 的语义比 `realm` 更明确（它同时标识「哪条链路」与「哪个身份域」），
    //   因此优先取 ref。
    const refParam = ctx.params['ref'];
    const realm: Realm =
      refParam !== undefined
        ? refParam === 'platform:developer'
          ? 'developer'
          : 'enduser'
        : ctx.query['realm'] === 'developer'
          ? 'developer'
          : 'enduser';
    // ★★ 站点参数（**内部 id**）：`?site=<uuid>`。
    //   ★ 用户可能"带着站点意图登录"（传参），也可能"登录后再自选"——
    //     前者要求站点随 OIDC 事务往返（回调时才知道），故存进事务。
    //   ★ 这里只做**格式**校验（是不是像 uuid）；**存在性与准入**在回调时判——
    //     因为那时才有会话，也才能给出"为什么进不去这个站点"的准确原因。
    const siteParam = ctx.query['site'];
    const targetSiteId =
      typeof siteParam === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteParam)
        ? siteParam
        : undefined;
    const { url, transaction } = await deps.oidc.beginLogin({
      returnTo,
      ...(targetSiteId === undefined ? {} : { targetSiteId }),
    });
    // ★ 事务必须落库：回调时才能校验 state/nonce 并取回 code_verifier
    await deps.loginTransactions.put({ ...transaction, returnTo: `${returnTo}#${realm}` });
    return { status: 302, headers: { Location: url }, body: '' };
  };

  /**
   * `POST /api/auth/onboard` —— **开发者入驻**（邀请码核销 → 建号 → 写身份映射）。
   *
   * ★★★ R91 新增：这是**阻塞上线的一环**。
   *   此前：`InvitationService.redeem()` 实现完整、但**从未被实例化**；
   *   `recordDeveloperIdentity` **没有任何调用点**；
   *   且没有入驻端点 → **上线后没有任何开发者能登录**。
   *
   * ★ 站点由**邀请链接**携带（`?site=<siteId>&code=...`）：
   *   `InvitationStore` 按 `(siteId, codeHash)` 查，而邀请码本身**不含站点信息**——
   *   管理员生成链接时已知站点，因此由链接携带是自然的选择（且仍需邀请码核销）。
   *
   * ★ 安全要点（都在 `redeem()` 内，本端点只做入参校验与错误映射）：
   *   ① **原子核销**（并发下只有一个请求能占用额度）；
   *   ② **邮箱必须匹配**邀请码绑定的邮箱（常量时间比较，防时序探测）；
   *   ③ **邮箱必须已验证**（M7-8 强制邮箱绑定）；
   *   ④ ★ **写身份映射**（否则入驻成功也登录不了）。
   */
  const onboard: RouteHandler = async (ctx) => {
    if (deps.invitations === undefined) {
      return { status: 501, body: { error: '入驻服务未装配（需要邀请码存储与身份映射）' } };
    }
    const body = (ctx.body ?? {}) as {
      siteId?: unknown;
      code?: unknown;
      email?: unknown;
      emailVerified?: unknown;
      oidcSubject?: unknown;
      username?: unknown;
      displayName?: unknown;
    };
    const siteId = body.siteId;
    const code = body.code;
    const email = body.email;
    const oidcSubject = body.oidcSubject;
    if (typeof siteId !== 'string' || siteId.length === 0) return { status: 400, body: { error: '缺少 siteId' } };
    if (typeof code !== 'string' || code.length === 0) return { status: 400, body: { error: '缺少邀请码 code' } };
    if (typeof email !== 'string' || email.length === 0) return { status: 400, body: { error: '缺少 email' } };
    if (typeof oidcSubject !== 'string' || oidcSubject.length === 0) {
      return { status: 400, body: { error: '缺少 oidcSubject（入驻后要用它建立登录身份映射）' } };
    }

    try {
      const result = await deps.invitations.redeem({
        siteId,
        code,
        email,
        // ★ 缺省视为未验证——**不能**因为「没传」就当作已验证
        emailVerified: body.emailVerified === true,
        oidcSubject,
        ...(typeof body.username === 'string' ? { username: body.username } : {}),
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      });
      return {
        status: 201,
        body: {
          developerId: result.developer.id,
          username: result.developer.username,
          siteId: result.site.id,
          siteCreated: result.siteCreated,
          // ★ 明确告知「身份映射已写入」——这是入驻可登录的关键
          identityBound: true,
        },
      };
    } catch (error) {
      // ★ 把领域错误映射成**可操作的** HTTP 状态与信息（不泄露目标邮箱）
      const reason = error instanceof Error && 'reason' in error ? (error as { reason?: string }).reason : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const status =
        reason === 'not_found' || reason === 'expired' || reason === 'exhausted' || reason === 'email_mismatch'
          ? 400
          : reason === 'email_not_verified'
            ? 403
            : 500;
      return { status, body: { error: message, ...(reason === undefined ? {} : { reason }) } };
    }
  };

  const callback: RouteHandler = async (ctx) => {
    const error = ctx.query['error'];
    if (error !== undefined) {
      return { status: 400, body: { error: `IdP 返回错误：${error}`, detail: ctx.query['error_description'] ?? null } };
    }
    const state = ctx.query['state'];
    const code = ctx.query['code'];
    if (state === undefined || code === undefined) {
      return { status: 400, body: { error: '回调缺少 state 或 code' } };
    }
    // ★ 一次性取出（取到即删除）：同一个 state 不能被重放
    const transaction = await deps.loginTransactions.take(state);
    if (transaction === undefined) {
      return { status: 400, body: { error: 'state 无效或已过期（可能是重放，或登录超时）' } };
    }

    const [returnToRaw = '/', realmRaw = 'enduser'] = (transaction.returnTo ?? '/#enduser').split('#');
    const realm: Realm = realmRaw === 'developer' ? 'developer' : 'enduser';

    let claims: Awaited<ReturnType<OidcClient['completeLogin']>>['claims'];
    try {
      const result = await deps.oidc.completeLogin({ code, codeVerifier: transaction.codeVerifier, nonce: transaction.nonce });
      claims = result.claims;
    } catch (err) {
      logger.warn('OIDC 登录失败', { error: err instanceof Error ? err.message : String(err) });
      return { status: 401, body: { error: err instanceof Error ? err.message : 'OIDC 登录失败' } };
    }

    const email = typeof claims.email === 'string' ? claims.email : '';
    const emailVerified = claims.email_verified === true;
    const preferredUsername = typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined;

    // ★ 走登录准入（两条链路隔离）——**生产必须提供 loginResolver**。
    let resolved: { realm: Realm; role: 'admin' | 'developer' | 'user'; principalId: string } = {
      realm,
      role: realm === 'developer' ? 'developer' : 'user',
      principalId: claims.sub,
    };
    if (deps.loginResolver !== undefined) {
      const loginRef = realm === 'developer' ? 'platform:developer' : 'platform:enduser';
      const admission = await deps.loginResolver({
        ref: loginRef,
        oidcSubject: claims.sub,
        email,
        emailVerified,
        ...(preferredUsername === undefined ? {} : { displayName: preferredUsername }),
      });
      if (!admission.ok) {
        logger.warn('登录准入被拒绝', { ref: loginRef, reason: admission.reason });
        // ★ 不回落到「直接建会话」——拒绝就是拒绝
        return { status: 403, body: { error: admission.message, reason: admission.reason } };
      }
      resolved = { realm: admission.realm, role: admission.role, principalId: admission.principalId };
    }

    // ★★ **传参登录 → 自动选择站点**（`?site=<uuid>`，站点由事务带回）。
    //   ★ 必须过**同一道**准入闸门——否则"传参"就成了绕过闸门的后门。
    //   ★ 被拒 / 站点不存在 → **不选中**，并把原因带回（**不静默回落**：
    //     静默回落到别的站点会让用户以为自己在目标站点里）。
    let activeSiteId = deps.defaultSiteId ?? null;
    let siteSelectionFailure: string | null = null;
    if (transaction.targetSiteId !== undefined) {
      const admission = await guardSiteAdmission({
        check: deps.emailAdmission,
        email: email.length > 0 ? email : null,
        siteId: transaction.targetSiteId,
      });
      if (admission.ok) {
        activeSiteId = transaction.targetSiteId;
      } else {
        // ★ 刻意**不回落**到默认站点：用户明确表达了要去哪个站点，
        //   进不去就该告诉他，而不是悄悄把他放进另一个站点。
        activeSiteId = null;
        siteSelectionFailure = admission.body.error;
        logger.warn('登录携带的站点未通过准入，未自动选中', {
          targetSiteId: transaction.targetSiteId,
          reason: admission.body.error,
        });
      }
    }

    const principal = principalFromClaims(
      {
        // ★ `sub` 用**准入结果的主体 id**（开发者链路上是 developer.id，纯 uuid），
        //   而不是 IdP 的 sub——`ag_sessions.user_id` 是 uuid 列。
        sub: resolved.principalId,
        email: email.length > 0 ? email : null,
        emailVerified,
        ...(preferredUsername === undefined ? {} : { preferredUsername }),
      },
      {
        realm: resolved.realm,
        role: resolved.role,
        activeSiteId,
      },
    );

    // ★ 真正建立会话：明文 token 只在这里出现一次，落库的是哈希
    const { token } = await deps.sessions.create(principal);
    ctx.setCookie(SESSION_COOKIE, token, { sameSite: 'Lax', path: '/', maxAgeSec: 12 * 3600 });

    const returnTo = sanitizeReturnTo(returnToRaw, allowedPrefixes);
    // 浏览器直接跳转的回调场景：返回 302 而不是 JSON（否则用户会看到一坨 JSON）
    if ((ctx.headers['accept'] ?? '').includes('text/html')) {
      return { status: 302, headers: { Location: returnTo }, body: '' };
    }
    // 非浏览器场景（脚本/测试）返回 JSON；CSRF token 由客户端随后调 `/api/me` 获取
    // ★ 若传参携带的站点未通过准入，这里**明确告知**（而不是静默回落）——
    //   否则用户会以为自己已经在目标站点里。
    return {
      status: 200,
      body: {
        ok: true,
        principal,
        returnTo,
        ...(siteSelectionFailure === null ? {} : { siteSelectionFailure }),
      },
    };
  };

  const logout: RouteHandler = (ctx) => {
    ctx.clearCookie(SESSION_COOKIE_NAME);
    return { body: { ok: true } };
  };

  const me: RouteHandler = (ctx) => {
    if (ctx.principal === null || ctx.session === null) {
      return { status: 401, body: { error: '未登录' } };
    }
    return {
      body: {
        principal: ctx.principal,
        /** ★ 前端所有写请求都必须带上它（双提交 Cookie） */
        csrfToken: csrfTokenFor(ctx.session.id, deps.csrfSecret),
        activeSiteId: siteOf(ctx) ?? null,
      },
    };
  };

  const switchSite: RouteHandler = async (ctx) => {
    if (ctx.principal === null || ctx.session === null) return { status: 401, body: { error: '未登录' } };
    const body = (ctx.body ?? {}) as { siteId?: unknown };
    if (typeof body.siteId !== 'string' || body.siteId.length === 0) {
      return { status: 400, body: { error: '缺少 siteId' } };
    }
    // ★★ **站点准入闸门**（共享实现，见 `src/http/site-admission.ts`）。
    //   ★ 注意：**另一条**改作用域的路径（`POST /api/me/selection`）也过了**同一道**闸门——
    //     我第一版只堵了这里，而前端门户走的是那一条（闸门等于没有）。
    const admission = await guardSiteAdmission({
      check: deps.emailAdmission,
      email: ctx.principal.email,
      siteId: body.siteId,
    });
    if (!admission.ok) return { status: admission.status, body: admission.body };
    // ★ 站点作用域的唯一来源就是会话的 activeSiteId——因此切换必须落到会话上，
    //   而不是「返回一个 siteId 让调用方自己记住」（那等于让客户端决定作用域）。
    const updated = await deps.sessions.switchSite(ctx.session.id, body.siteId);
    if (updated === undefined) return { status: 401, body: { error: '会话已失效' } };
    return { body: { ok: true, activeSiteId: updated.principal.activeSiteId } };
  };

  /**
   * `GET /api/me/identities` —— **我的**身份绑定（用户自助）。
   *
   * ★★ 安全核心：用户 id **只从会话取**（`ctx.principal.userId`），
   *   本端点**不接受任何参数**——否则用户可以传别人的 id 查其绑定。
   *
   * ★ 不返回 `claimSnapshot`：那是 IdP 断言的完整快照，
   *   可能含用户未预期暴露的字段；本端点只给「绑了哪个 provider、何时验证的」。
   */
  const myIdentities: RouteHandler = async (ctx) => {
    if (ctx.principal === null) return { status: 401, body: { error: '未登录' } };
    if (deps.identities === undefined) return { status: 501, body: { error: '身份绑定视图未装配' } };
    const records = await deps.identities.listByUser(ctx.principal.userId);
    return {
      body: {
        identities: records.map((record) => ({
          provider: record.provider,
          providerUserId: record.providerUserId,
          // ★ 已撤销的绑定**仍在列表里**（用户应知道「这个绑定曾存在、现已失效」）
          revoked: record.revokedAt != null,
          verifiedAt: record.verifiedAt?.toISOString() ?? null,
          revokedAt: record.revokedAt?.toISOString() ?? null,
          subjectRef: record.subjectRef ?? null,
        })),
        total: records.length,
        activeCount: records.filter((record) => record.revokedAt == null).length,
      },
    };
  };

  const eligibility: RouteHandler = async (ctx) => {
    if (ctx.principal === null) return { status: 401, body: { error: '未登录' } };
    if (deps.eligibility === undefined) return { status: 501, body: { error: '资格视图未装配' } };
    const siteId = siteOf(ctx);
    if (siteId === undefined) {
      return { status: 400, body: { error: '尚未选定站点（站点作用域不来自请求体）' } };
    }
    const report = await deps.eligibility.forUser({ principal: ctx.principal, siteId });
    return { body: report };
  };

  // ── 签到（docs/06 §4：status / checkin / history）──
  //   ★ 站点从**会话**取（`siteOf`），不接受请求参数——与作用域注入同一条纪律。
  const checkinStatus: RouteHandler = async (ctx) => {
    if (ctx.principal === null) return { status: 401, body: { error: '未登录' } };
    if (deps.checkin === undefined) return { status: 501, body: { error: '签到未装配' } };
    const siteId = siteOf(ctx);
    if (siteId === undefined) return { status: 400, body: { error: '尚未选定站点' } };
    return { body: await deps.checkin.status({ siteId, userId: ctx.principal.userId }) };
  };

  const checkinSubmit: RouteHandler = async (ctx) => {
    if (ctx.principal === null) return { status: 401, body: { error: '未登录' } };
    if (deps.checkin === undefined) return { status: 501, body: { error: '签到未装配' } };
    const siteId = siteOf(ctx);
    if (siteId === undefined) return { status: 400, body: { error: '尚未选定站点' } };
    // ★ 业务结果（未取得资格 / 额度发放结果未知）用 200 + `ok:false` 返回：
    //   它们是**可预期的业务结论**，不是协议错误——前端据此展示原因。
    return { body: await deps.checkin.checkin({ siteId, userId: ctx.principal.userId }) };
  };

  const checkinHistory: RouteHandler = async (ctx) => {
    if (ctx.principal === null) return { status: 401, body: { error: '未登录' } };
    if (deps.checkin === undefined) return { status: 501, body: { error: '签到未装配' } };
    const siteId = siteOf(ctx);
    if (siteId === undefined) return { status: 400, body: { error: '尚未选定站点' } };
    const limitRaw = Number.parseInt(ctx.query['limit'] ?? '', 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 30;
    return { body: { items: await deps.checkin.history({ siteId, userId: ctx.principal.userId, limit }) } };
  };

  /**
   * ★★ L-1：**邀请码核销**（`ag_invite_codes` 的使用路径）。
   *
   * ★ 业务结论用 `200 + ok:false`（与签到同一约定）："码已用完/已过期/不存在"
   *   都是**可预期的结论**，不是协议错误。
   * ★ 「核销成功但授予失败」用 `ok:true + grantedPending:true` 表达——
   *   码的消耗**不可逆**，而事实写入**可重试**。把它混进 `ok:false`
   *   会让用户以为码没被用掉，从而反复尝试（每试一次都在消耗次数，若还有余量的话）。
   */
  const redeemInvite: RouteHandler = async (ctx) => {
    if (ctx.principal === null) return { status: 401, body: { error: '未登录' } };
    if (deps.inviteRedeem === undefined) return { status: 501, body: { error: '邀请码核销未装配' } };
    const siteId = siteOf(ctx);
    if (siteId === undefined) return { status: 400, body: { error: '尚未选定站点' } };
    const body = (ctx.body ?? {}) as { code?: unknown };
    if (typeof body.code !== 'string' || body.code.trim().length === 0) {
      return { status: 400, body: { error: '缺少 code' } };
    }
    return {
      body: await deps.inviteRedeem({
        siteId,
        userId: ctx.principal.userId,
        code: body.code.trim(),
      }),
    };
  };

  const routes: Route[] = [
    { method: 'GET', path: '/healthz', handler: health, auth: 'none' },
    { method: 'GET', path: '/healthz/live', handler: healthLive, auth: 'none' },
    { method: 'GET', path: '/healthz/ready', handler: healthReady, auth: 'none' },
    { method: 'GET', path: '/metrics', handler: metricsHandler, auth: 'none' },
    { method: 'GET', path: '/api/auth/login', handler: login, auth: 'none' },
    // ★ docs/06 §6.0 声明的联邦登录入口。此前**未实现**——
    //   按文档对接的客户端会拿到 404（R16 的接口面覆盖率检查发现的）。
    { method: 'GET', path: '/auth/oidc/:ref/start', handler: login, auth: 'none' },
    { method: 'GET', path: '/auth/oidc/:ref/callback', handler: callback, auth: 'none', csrfExempt: true },
    // 回调必须豁免 CSRF：它是 IdP 发起的 GET 跳转，不可能带自定义头
    { method: 'POST', path: '/api/auth/onboard', handler: onboard, auth: 'none', csrfExempt: true },
    { method: 'GET', path: '/api/auth/callback', handler: callback, auth: 'none', csrfExempt: true },
    { method: 'POST', path: '/api/auth/logout', handler: logout, auth: 'required' },
    { method: 'GET', path: '/api/me', handler: me, auth: 'none' },
    { method: 'POST', path: '/api/me/site', handler: switchSite, auth: 'required' },
    { method: 'GET', path: '/api/me/eligibility', handler: eligibility, auth: 'required' },
    // ★ docs/06 §4 声明的签到三端点（此前只有资格视图，签到本身没有入口）
    { method: 'GET', path: '/api/me/checkin/status', handler: checkinStatus, auth: 'required' },
    { method: 'POST', path: '/api/me/checkin', handler: checkinSubmit, auth: 'required' },
    { method: 'GET', path: '/api/me/checkin/history', handler: checkinHistory, auth: 'required' },
    // ★★ L-1：邀请码核销（`ag_invite_codes` 的使用路径）
    { method: 'POST', path: '/api/me/redeem-invite', handler: redeemInvite, auth: 'required' },
    { method: 'GET', path: '/api/me/identities', handler: myIdentities, auth: 'required' },
  ];

  // 管理端：把 M1-11 的处理器挂到两个前缀上（保持其内部路由语义不变）
  if (deps.admin !== undefined) {
    const admin = deps.admin;
    const mount = (method: string, path: string): Route => ({
      method,
      path,
      auth: 'required',
      handler: async (ctx) => {
        const response = await admin({
          method: ctx.method,
          path: ctx.path,
          query: ctx.query,
          body: ctx.body,
          session:
            ctx.principal === null || ctx.session === null
              ? null
              : {
                  userId: ctx.principal.userId,
                  username: ctx.principal.username,
                  activeSiteId: ctx.principal.activeSiteId ?? deps.defaultSiteId ?? null,
                  // ★ 审计可见性要用它（`docs/06`「开发者仅见名下站点」）——
                  //   它是**开发者 id**，与上面的 `userId`（平台用户 id）不是一回事。
                  activeDeveloperId: ctx.principal.activeDeveloperId ?? null,
                  realm: ctx.principal.realm,
                  role: ctx.principal.role,
                },
        });
        return { status: response.status, body: response.body };
      },
    });
    routes.push(
      mount('GET', '/api/admin/subjects'),
      mount('POST', '/api/admin/identities/manual-bind'),
      // ★ P1-4：OIDC 签名密钥的**可运维入口**（查看状态 + 手动触发轮换）。
      //   ★ 高危操作必须有受控通道——否则运维只能"等 90 天自动轮换"，
      //     出问题时既看不到状态、也无法手动推进。
      // ★ `docs/06:341` 声明的审计日志端点（此前**只写不读**：数据在库里却查不出来）
      mount('GET', '/api/admin/audit'),
      // ★ `docs/07 M6-3`：灰度一键熔断（止血按钮必须能被按到）
      mount('GET', '/api/admin/rollouts'),
      mount('POST', '/api/admin/rollouts/abort'),
      mount('POST', '/api/admin/rollouts/resume'),
      mount('GET', '/api/admin/oidc/signing-keys'),
      mount('POST', '/api/admin/oidc/signing-keys/rotate'),
      // ★ P1-11：外置插件包体上传（权威副本落 DB，本地缓存按 digest 拉回）。
      //   ★ 记住 Round 28 的教训：**加了 handler 就必须在这里 mount**，
      //     否则 `route-coverage` 会报「实现存在但用户调不到（404）」。
      mount('POST', '/api/admin/plugins/packages'),
      // ★ P1-5：跨站点灰度分配统计（`src/core/cross-site.ts` 的第一个真实消费方）。
      //   ★ 记住：加了 handler 就必须在这里 mount，否则 `route-coverage` 会报 404。
      mount('GET', '/api/admin/policy-assignments/cross-site'),
      mount('GET', '/api/admin/policies'),
      mount('POST', '/api/admin/policies'),
      // ★ 注意顺序：`/:code` 必须在 `/:code/versions` 等**之前**不影响
      //   （路径段数不同，`matchRoute` 能区分）；但 `/:code/validate` 要显式挂载。
      mount('GET', '/api/admin/policies/:code'),
      mount('PUT', '/api/admin/policies/:code'),
      mount('POST', '/api/admin/policies/:code/validate'),
      mount('POST', '/api/admin/policies/:code/simulate'),
      mount('POST', '/api/admin/policies/:code/publish'),
      // ★★ 以下三条此前**未挂载**——「实现存在但用户调不到」：
      //   · 试算（simulate）
      //   · 版本历史（`/:code/versions`）
      //   · **回滚**（`/:code/rollback`）—— 目标第 4 项点名的 M6-2 能力
      //
      //   漏掉的原因很机械：`mount()` 用**固定 path**，而这三条是
      //   「带参数的路径」或「在 handler 内用正则匹配的路径」，
      //   容易在列清单时被漏掉。`matchRoute` 本身**支持 `:param`**，
      //   所以补上即可。
      // ★ 协同验证：断言流水与撤销
      mount('GET', '/api/admin/verify/assertions'),
      mount('POST', '/api/admin/verify/assertions/:id/revoke'),
      // ★ OIDC 提供方注册（P0；docs/06 的 /admin/oidc 系列）
      mount('GET', '/api/admin/oidc/providers'),
      mount('POST', '/api/admin/oidc/providers'),
      mount('PUT', '/api/admin/oidc/providers/:ref'),
      // ★ 协同验证调用方（P0；docs/06 的 /admin/verify 系列）
      mount('GET', '/api/admin/verify/clients'),
      mount('POST', '/api/admin/verify/clients'),
      mount('POST', '/api/admin/verify/clients/:id/suspend'),
      mount('POST', '/api/admin/verify/clients/:id/activate'),
      mount('POST', '/api/admin/verify/clients/:id/rotate'),
      mount('DELETE', '/api/admin/verify/clients/:id'),
      // ★ 用户管理（P0；docs/06 的 /admin/users 系列）
      mount('GET', '/api/admin/users'),
      mount('GET', '/api/admin/users/:id'),
      mount('GET', '/api/admin/users/:id/raw'),
      mount('GET', '/api/admin/users/:id/identities'),
      mount('POST', '/api/admin/users/:id/block'),
      mount('POST', '/api/admin/users/:id/tags'),
      // ★ 平台设置（P0；docs/06 的 /admin/settings 系列）
      mount('GET', '/api/admin/settings/platform'),
      mount('POST', '/api/admin/settings/platform'),
      // ★ 插件管理（P0；docs/06 的 /admin/plugins 系列，本轮实现核心 6 条）
      mount('GET', '/api/admin/plugins'),
      // ★ 必须在 `/:id` 之前挂载（否则 `registry` 会被当作插件 id）
      mount('GET', '/api/admin/plugins/registry'),
      mount('GET', '/api/admin/plugins/:id'),
      mount('POST', '/api/admin/plugins/install'),
      mount('POST', '/api/admin/plugins/:id/trust'),
      mount('GET', '/api/admin/plugins/:id/endpoints'),
      mount('POST', '/api/admin/plugins/:id/endpoints/:eid/approve'),
      mount('POST', '/api/admin/plugins/:id/endpoints/:eid/toggle'),
      mount('GET', '/api/admin/plugins/:id/config'),
      mount('PUT', '/api/admin/plugins/:id/config'),
      mount('GET', '/api/admin/plugins/:id/config/versions'),
      mount('GET', '/api/admin/plugins/:id/invocations'),
      // ★ R94（P1-1）：手动触发一次插件采集（让插件宿主体真的可用）
      mount('POST', '/api/admin/plugins/:id/collect'),
      mount('GET', '/api/admin/plugins/:id/instances'),
      mount('PUT', '/api/admin/plugins/:id/instances'),
      mount('GET', '/api/admin/plugins/:id/tokens'),
      mount('POST', '/api/admin/plugins/:id/tokens'),
      mount('DELETE', '/api/admin/plugins/:id/tokens/:tid'),
      mount('GET', '/api/admin/plugins/:id/ui'),
      mount('POST', '/api/admin/plugins/:id/ui/:uid/approve'),
      mount('POST', '/api/admin/plugins/:id/ui/:uid/toggle'),
      mount('GET', '/api/admin/plugins/:id/grants'),
      mount('POST', '/api/admin/plugins/:id/grants'),
      mount('DELETE', '/api/admin/plugins/:id/grants/:permission'),
      mount('POST', '/api/admin/plugins/:id/validate'),
      mount('DELETE', '/api/admin/plugins/:id/trust/:scope'),
      mount('GET', '/api/admin/plugins/:id/dependents'),
      mount('POST', '/api/admin/plugins/:id/enable'),
      mount('POST', '/api/admin/plugins/:id/disable'),
      mount('POST', '/api/admin/simulate'),
      mount('GET', '/api/admin/policies/:code/versions'),
      mount('POST', '/api/admin/policies/:code/rollback'),
      mount('POST', '/api/admin/evaluate'),
    );
  }

  return routes;
}

/** 会话 Cookie 名（与 `session.ts` 同源，避免两处硬编码漂移）。 */
export const SESSION_COOKIE_NAME = SESSION_COOKIE;
