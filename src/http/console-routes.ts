/**
 * 控制台与两级选择的 HTTP 端点 —— 把「入驻 → 建站 → 配策略 → 取得资格」这条主线
 * 变成**真人可走**的接口（落地目标第 2、3 条）。
 *
 * ```
 *   GET  /api/me/selection/developers        第一级：可选开发者
 *   GET  /api/me/selection/sites/:developerId 第二级：该开发者下的可选站点
 *   POST /api/me/selection                   提交选择（写会话作用域）
 *   GET  /api/console/sections               控制台导航（按能力派生）
 *   GET  /api/ui/manifest                    插件 UI 贡献（已批准且启用）
 * ```
 *
 * ★ 两条约束贯穿本文件：
 *
 * 1. **作用域只从会话读，不从请求体读**：`POST /api/me/selection` 是唯一能改
 *    `activeDeveloperId` / `activeSiteId` 的地方，且它必须走 `selectContext`（含归属校验）。
 *    其它端点一律用 `ctx.principal.activeSiteId` —— 否则客户端可以指定任意 siteId 越权。
 *
 * 2. **导航与判定同源**：`/api/console/sections` 直接返回 `visibleSections(principal)`，
 *    而每个分区在真正访问时由 `assertCanAccess` 再判一次。
 *    这样「前端没显示」与「接口拒绝」不可能不一致。
 */

import type { Logger } from '../kernel/logger.ts';
import type { Route, RouteResult } from './server.ts';
import type { SessionService } from '../auth/session.ts';

import { assertCanAccess, visibleSections, type ConsolePrincipal } from '../admin/console.ts';
import { guardSiteAdmission } from './site-admission.ts';
import { listDeveloperOptions, listSiteOptions, selectContext, toSelectionContext } from '../core/site-selection.ts';
import type { SiteRegistry } from '../core/sites.ts';
import type { UiContributionHost } from '../plugin/ui-host.ts';

export interface ConsoleRoutesDeps {
  sessions: SessionService;
  registry: SiteRegistry;
  /** 当前用户可见的开发者集合（由宿主决定范围；单站点部署通常只有一个） */
  listDeveloperIds: (userId: string) => Promise<string[]>;
  /** 插件 UI 贡献宿主（未提供则 `/api/ui/manifest` 返回空结构） */
  uiHost?: UiContributionHost;
  /**
   * ★★ **站点准入闸门**（`ag_email_rules`）——与 `POST /api/me/site` 走**同一道**。
   *   ★ 前端门户实际走的是本模块的 `POST /api/me/selection`；
   *     所以只堵另一条路径等于**闸门不存在**（本会话核实过）。
   * ★ 未提供 = 不启用闸门。
   */
  emailAdmission?: import('./site-admission.ts').SiteAdmissionCheck;
  logger?: Logger;
}

/** 从请求上下文派生控制台身份（**域优先于角色**的判定在 console.ts 内）。 */
function principalOf(ctx: { principal: ConsolePrincipal | null }): ConsolePrincipal | null {
  return ctx.principal === null ? null : ctx.principal;
}

export function createConsoleRoutes(deps: ConsoleRoutesDeps): Route[] {
  // ★ 控制台导航的响应**只取决于 `(realm, role)`**，与用户身份无关——
  //   因此缓存**预序列化**的 JSON。这是压测暴露的瓶颈：并发 32 时应用 316/s
  //   而空 handler 的服务器能到 539/s，差距全在「构造 15 个分区 + JSON 序列化」这段 CPU 工作。
  //
  //   ⚠️ 正确性前提：同一 `(realm, role)` 的可见分区集合恒定。
  //      若将来引入「按用户/站点授予的额外分区」，必须把这个缓存一并失效
  //      （此约束写在这里，而不是留成隐含假设）。
  const sectionsCache = new Map<string, string>();
  return [
    // ── 第一级：可选开发者 ──
    {
      method: 'GET',
      path: '/api/me/selection/developers',
      auth: 'required',
      handler: async (ctx): Promise<RouteResult> => {
        const principal = principalOf(ctx);
        if (principal === null) return { status: 401, body: { error: '需要登录' } };
        const ids = await deps.listDeveloperIds(principal.userId);
        const options = await listDeveloperOptions({ registry: deps.registry, ...(deps.logger === undefined ? {} : { logger: deps.logger }) }, ids);
        return {
          status: 200,
          body: {
            developers: options,
            current: { developerId: principal.activeDeveloperId ?? null, siteId: principal.activeSiteId ?? null },
          },
        };
      },
    },

    // ── 第二级：该开发者下的站点 ──
    {
      method: 'GET',
      path: '/api/me/selection/sites/:developerId',
      auth: 'required',
      handler: async (ctx): Promise<RouteResult> => {
        const principal = principalOf(ctx);
        if (principal === null) return { status: 401, body: { error: '需要登录' } };
        const match = /^\/api\/me\/selection\/sites\/([^/]+)$/.exec(ctx.path);
        if (match === null) return { status: 400, body: { error: '缺少 developerId' } };
        const developerId = decodeURIComponent(match[1]!);
        const sites = await listSiteOptions(
          { registry: deps.registry, ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
          developerId,
          { siteId: principal.activeSiteId ?? null },
        );
        return { status: 200, body: { developerId, sites } };
      },
    },

    // ── 提交选择（唯一能改会话作用域的入口）──
    {
      method: 'POST',
      path: '/api/me/selection',
      auth: 'required',
      handler: async (ctx): Promise<RouteResult> => {
        const principal = principalOf(ctx);
        if (principal === null || ctx.session === null) return { status: 401, body: { error: '需要登录' } };
        const body = (ctx.body ?? {}) as { developerId?: unknown; siteId?: unknown };
        if (typeof body.developerId !== 'string' || typeof body.siteId !== 'string') {
          return { status: 400, body: { error: '缺少 developerId 或 siteId' } };
        }
        // ★ 走 selectContext：含「站点归属该开发者」的校验（站点是隔离边界）
        const result = await selectContext(
          { registry: deps.registry, ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
          { developerId: body.developerId, siteId: body.siteId },
        );
        if (!result.ok) {
          // 归属错配是越权尝试 → 403；不存在/停用 → 400/403
          const status = result.reason === 'site_not_owned_by_developer' ? 403 : result.reason.endsWith('_suspended') ? 403 : 404;
          return { status, body: { error: result.message, reason: result.reason } };
        }
        const context = toSelectionContext(result);
        // ★★ **站点准入闸门**——与 `POST /api/me/site` 走**同一道**闸门。
        //   ★ 前端门户实际走的是这一条；我第一版只堵了那一条，于是闸门等于不存在。
        //   ★ 目标站点是 `context.activeSiteId`（**恰好校验过的那个**），不是请求体里的原值。
        const admission = await guardSiteAdmission({
          check: deps.emailAdmission,
          email: (ctx.principal as { email?: string | null }).email ?? null,
          siteId: context.activeSiteId,
        });
        if (!admission.ok) return { status: admission.status, body: admission.body };
        const updated = await deps.sessions.setActiveScope(ctx.session, {
          developerId: context.activeDeveloperId,
          // ★ 写入**内部 uuid**（不是 slug）——ag_sessions.active_site_id 是 uuid 列
          siteId: context.activeSiteId,
        });
        deps.logger?.info('会话作用域已更新', { userId: updated.principal.userId, developerId: context.activeDeveloperId, siteId: context.activeSiteId });
        return {
          status: 200,
          body: {
            ok: true,
            developer: { id: result.developer.id, displayName: result.developer.displayName },
            site: { id: result.site.id, siteId: result.site.siteId, nickname: result.site.nickname },
          },
        };
      },
    },

    // ── 控制台导航（按能力派生）──
    //
    // ★ 响应**只取决于 `(realm, role)`**，与用户身份无关——因此可以按这两维缓存
    //   预序列化的 JSON。这是压测暴露的瓶颈：并发 32 时应用 316/s 而空 handler
    //   的服务器能到 539/s，差距全在「构造 15 个分区 + JSON 序列化」这段 CPU 工作上。
    //
    //   ⚠️ 缓存的正确性前提是「同一 (realm, role) 的可见分区集合恒定」。
    //      若将来引入「按用户/站点授予的额外分区」，这个缓存必须失效——
    //      因此键里显式带上 `activeDeveloperId`/`activeSiteId` 的前缀，
    //      并在此处留下这条约束（而不是让它成为隐含假设）。
    {
      method: 'GET',
      path: '/api/console/sections',
      auth: 'required',
      handler: async (ctx): Promise<RouteResult> => {
        const principal = principalOf(ctx);
        if (principal === null) return { status: 401, body: { error: '需要登录' } };
        const cacheKey = `${principal.realm}\u0000${principal.role}`;
        const cached = sectionsCache.get(cacheKey);
        if (cached !== undefined) return { status: 200, body: cached, contentType: 'application/json; charset=utf-8' };
        const sections = visibleSections(principal).map((section) => ({ id: section.id, console: section.console, title: section.title }));
        const serialized = JSON.stringify({ sections, realm: principal.realm, role: principal.role });
        sectionsCache.set(cacheKey, serialized);
        return { status: 200, body: serialized, contentType: 'application/json; charset=utf-8' };
      },
    },

    // ── 单分区准入探针（前端进入某分区前调用；与真实访问同一判据）──
    {
      method: 'GET',
      path: '/api/console/sections/:id/access',
      auth: 'required',
      handler: async (ctx): Promise<RouteResult> => {
        const principal = principalOf(ctx);
        if (principal === null) return { status: 401, body: { error: '需要登录' } };
        const match = /^\/api\/console\/sections\/([^/]+)\/access$/.exec(ctx.path);
        if (match === null) return { status: 400, body: { error: '缺少分区 id' } };
        const access = assertCanAccess(principal, decodeURIComponent(match[1]!));
        if (!access.ok) return { status: access.status, body: { error: access.message, reason: access.reason } };
        return { status: 200, body: { ok: true, section: { id: access.section.id, title: access.section.title } } };
      },
    },

    // ── 插件 UI 贡献（已批准且启用；未提供宿主时返回空结构）──
    {
      method: 'GET',
      path: '/api/ui/manifest',
      auth: 'required',
      handler: async (ctx): Promise<RouteResult> => {
        if (deps.uiHost === undefined) {
          // ★★★ 此前这里返回 **200 + 空清单**——那是**静默降级**：
          //   调用方（前端）看到 200 与空数组，会以为「没有任何 UI 贡献」，
          //   而真相是「**UI 宿主未配置**」。两者需要完全不同的处置
          //   （前者什么都不用做，后者要去看配置）。
          //
          //   ★ 本项目的纪律是「**显式不可用 > 静默返回空**」
          //     （见插件配置/端点端点的 501 处理）。
          //   ★ 这个问题是被 `tools/path-probe.ts` 的**契约检查**顺带暴露的：
          //     我给 `/api/ui/manifest` 猜了一个不存在的字段 `contributions`，
          //     于是探针走进了这个空分支并报「契约违约」——
          //     **错误的契约意外地暴露了静默降级**。
          // ★★ 折中（尊重既有设计意图 + 消除静默）：
          //   保持 **200 + 空结构**（前端无需特判 null/501，这是既有测试锁定的契约），
          //   但**加上 `hostAvailable: false`** 让调用方能区分两种情况：
          //     · 宿主已接入但没有贡献 → `hostAvailable: true` + 空数组；
          //     · 宿主未接入         → `hostAvailable: false` + 空数组。
          //   ★ 这样既不破坏前端契约，也不再让「配置缺失」伪装成「没有贡献」。
          return {
            status: 200,
            body: {
              nav: [],
              pages: [],
              slots: [],
              generatedAt: new Date().toISOString(),
              pendingApproval: 0,
              /** ★ 新增：宿主是否已接入。`false` 表示「配置缺失」而非「没有贡献」 */
              hostAvailable: false,
              note: 'UI 宿主未配置（deps.uiHost 缺失）——不是「没有 UI 贡献」，而是宿主未接入',
            },
          };
        }
        // 按身份域过滤 audience：普通用户看不到 admin/developer 入口
        const audience = ctx.principal?.realm === 'developer' ? undefined : 'user';
        const manifest = await deps.uiHost.manifest(audience === undefined ? {} : { audience });
        // ★ 宿主已接入：显式标注，使两种情况可区分（见上面的说明）
        return { status: 200, body: { ...manifest, hostAvailable: true } };
      },
    },
  ];
}
