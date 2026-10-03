/**
 * 站点作用域（D17 裁决：**不启用 RLS**，改为「注入 + fail-closed 抛错 + 单一事务入口」）。
 *
 * 为什么是这个形态（docs/CHANGELOG.md D17）：
 *   PostgreSQL RLS 需要「站点级协作者角色」才能有意义，而本项目的角色模型里没有它；
 *   强行启用 RLS 会带来逐站点事务与 SET LOCAL，成本高而收益可疑。因此推迟 RLS，
 *   但**不能推迟**的是三件事：① site_id 列从第一天就在；② 所有查询自动注入作用域；
 *   ③ 拿不到作用域时**必须抛错**（fail-closed），而不是「默认全站」。
 *
 * ★ 失败模式设计：本模块的默认行为是**拒绝**。
 *   任何「没传作用域」的调用都会抛 ScopeMissingError，绝不会退化成不过滤。
 *   这是本模块存在的全部理由——把「静默跨站点污染」变成「启动即失败」。
 */

import type { OwnerScope } from '../schema/ir.ts';

/** 可被作用域约束的四类主体（与 `ag_owner_scope` 枚举一致）。 */
export type ScopeKind = OwnerScope;

export interface SiteScope {
  kind: 'site';
  siteId: string;
  developerId?: string;
  actorId?: string;
}

export interface DeveloperScope {
  kind: 'developer';
  developerId: string;
  actorId?: string;
}

export interface PlatformScope {
  kind: 'platform';
  actorId?: string;
}

export interface UserScope {
  kind: 'user';
  ownerId: string;
  siteId?: string;
  actorId?: string;
}

export type ScopeContext = SiteScope | DeveloperScope | PlatformScope | UserScope;

/** fail-closed 的专用错误类型：调用方可以据此区分「忘了传作用域」与「传了但非法」。 */
export class ScopeMissingError extends Error {
  override readonly name = 'ScopeMissingError';
  readonly tableName: string;
  readonly operation: string;

  constructor(tableName: string, operation: string, hint?: string) {
    super(
      `拒绝执行 ${operation} on ${tableName}：没有站点作用域（fail-closed）。` +
        `站点隔离的唯一来源是会话的 activeSiteId；缺少它必须以失败告终，` +
        `绝不能退化成「不过滤 site_id」——那会造成静默的跨站点数据污染。` +
        (hint === undefined ? '' : ` ${hint}`),
    );
    this.tableName = tableName;
    this.operation = operation;
  }
}

export class ScopeInvalidError extends Error {
  override readonly name = 'ScopeInvalidError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * 作用域的不透明载体。
 *
 * 为什么需要它：作用域必须由**会话解析层**（认证后）建立，再由数据访问层消费；
 * 二者之间不应通过「随手传字符串」耦合。`Scope` 的值只能由 `createScope()` 造出，
 * 使「伪造一个 siteId」在类型与运行期都变得显式。
 */
export interface Scope {
  readonly context: ScopeContext;
  readonly establishedAt: number;
}

export function createScope(context: ScopeContext): Scope {
  validate(context);
  return { context, establishedAt: Date.now() };
}

function validate(context: ScopeContext): void {
  switch (context.kind) {
    case 'site':
      if (!context.siteId) throw new ScopeInvalidError('SiteScope.siteId 不能为空');
      return;
    case 'developer':
      if (!context.developerId) throw new ScopeInvalidError('DeveloperScope.developerId 不能为空');
      return;
    case 'platform':
      return;
    case 'user':
      if (!context.ownerId) throw new ScopeInvalidError('UserScope.ownerId 不能为空');
      return;
  }
}

// ─────────────────────────── 解析：从会话取作用域 ───────────────────────────

/** 会话中与作用域相关的字段（对应 docs/02 的 `ag_sessions`：realm / activeDeveloperId / activeSiteId）。 */
export interface SessionScopeFields {
  activeSiteId: string | null;
  activeDeveloperId?: string | null;
  actorId?: string | null;
}

/**
 * 从会话解析作用域。
 *
 * **★ fail-closed**：`activeSiteId` 为空即抛 `ScopeMissingError`——不返回「无作用域」的可用对象。
 * 这是 02 §1「站点作用域表的唯一来源是 activeSiteId」的直接实现。
 */
export function resolveScope(params: {
  siteScoped: boolean;
  session: SessionScopeFields | null | undefined;
  tableName: string;
  operation?: string;
}): Scope {
  const operation = params.operation ?? 'query';
  const session = params.session;

  if (params.siteScoped) {
    const siteId = session?.activeSiteId ?? '';
    if (siteId.length === 0) {
      throw new ScopeMissingError(
        params.tableName,
        operation,
        session === undefined || session === null
          ? '（当前根本没有会话上下文）'
          : '（会话存在，但 activeSiteId 未选择——多站点用户必须先选定站点）',
      );
    }
    const context: SiteScope = { kind: 'site', siteId };
    if (session?.activeDeveloperId !== undefined && session.activeDeveloperId !== null) {
      context.developerId = session.activeDeveloperId;
    }
    if (session?.actorId !== undefined && session.actorId !== null) context.actorId = session.actorId;
    return createScope(context);
  }

  // 非站点作用域表（平台级 / 开发者域）：可以用 developer 或 platform 作用域
  const developerId = session?.activeDeveloperId ?? '';
  if (developerId.length > 0) {
    const context: DeveloperScope = { kind: 'developer', developerId };
    if (session?.actorId !== undefined && session.actorId !== null) context.actorId = session.actorId;
    return createScope(context);
  }
  return createScope({ kind: 'platform' });
}

/**
 * ★ 强制取得站点作用域：拿不到就抛错。
 *
 * 与 `resolveScope` 的区别：本函数用于**已知必须带站点**的路径（例如写 `ag_policies`），
 * 不管表声明如何，都要求作用域存在。
 */
export function mustScope(scope: Scope | null | undefined, tableName: string, operation = 'query'): SiteScope {
  if (scope === undefined || scope === null) {
    throw new ScopeMissingError(tableName, operation, '（作用域对象本身缺失）');
  }
  if (scope.context.kind !== 'site') {
    throw new ScopeMissingError(
      tableName,
      operation,
      `（当前作用域是 ${scope.context.kind}，而本操作要求 site 作用域）`,
    );
  }
  return scope.context;
}

// ─────────────────────────── 注入 ───────────────────────────

export interface WhereClause {
  /** 参数化占位符文本，如 `site_id = $1`；由查询编译层产出，**禁止字符串拼接值** */
  sql: string;
  params: readonly unknown[];
}

/**
 * 为站点作用域表注入 `site_id` 过滤条件。
 *
 * 约定（契约 §5）：注入发生在**查询编译层**，调用方不得自行拼 `where site_id = ...`。
 * 返回的 `params` 必须按顺序进入参数化占位符，而不是插值进 SQL 文本。
 */
export function injectSiteFilter(scope: Scope, tableName: string, startIndex = 1): WhereClause {
  const site = mustScope(scope, tableName, 'inject-site-filter');
  return { sql: `site_id = $${startIndex}`, params: [site.siteId] };
}

/** 为 ownerScope 表注入双列过滤（R2 的作用域表必须双非空）。 */
export function injectOwnerFilter(
  scope: Scope,
  tableName: string,
  startIndex = 1,
): WhereClause {
  const ctx = scope.context;
  if (ctx.kind === 'platform') {
    return { sql: `owner_scope = $${startIndex} AND owner_id = $${startIndex + 1}`, params: ['platform', 'platform'] };
  }
  if (ctx.kind === 'user') {
    return { sql: `owner_scope = $${startIndex} AND owner_id = $${startIndex + 1}`, params: ['user', ctx.ownerId] };
  }
  if (ctx.kind === 'developer') {
    return {
      sql: `owner_scope = $${startIndex} AND owner_id = $${startIndex + 1}`,
      params: ['developer', ctx.developerId],
    };
  }
  if (ctx.kind === 'site') {
    return { sql: `owner_scope = $${startIndex} AND owner_id = $${startIndex + 1}`, params: ['site', ctx.siteId] };
  }
  throw new ScopeInvalidError(`${tableName}: 无法为作用域 ${(ctx as { kind: string }).kind} 注入 owner 过滤`);
}

// ─────────────────────────── 写入注入 ───────────────────────────

/**
 * 为 INSERT 注入 `site_id` 值。
 *
 * ★ 关键设计：**不提供「从入参读取 site_id」的路径**——值只能来自作用域，
 * 这样「客户端伪造 site_id」在数据访问层就不可能成立。
 */
export function injectSiteValue(scope: Scope, tableName: string): string {
  return mustScope(scope, tableName, 'inject-site-value').siteId;
}
