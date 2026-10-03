/**
 * 管理端最小（M1-11）—— docs/07 §3 M1-11 与 docs/06 的接口约定。
 *
 * 交付形态：**框架无关的 HTTP 处理器**（`(request) => response`）。
 * 为什么不用 Fastify 起一个真服务：本项目的 M0-1 后端工程尚未引入 HTTP 框架，
 * 而管理端的**实质**是「鉴权 + 作用域 + 校验 + 落库」这条链，不是路由注册方式。
 * 处理器形态让这条链可以被完整测试（含拒绝路径），后续挂到任意框架只写适配层。
 *
 * 四个能力（docs/07 §3 M1-11 原话：主体列表 / 手工绑定 / 策略编辑（YAML 文本框））：
 *   GET    /api/admin/subjects                 主体列表（分页）
 *   POST   /api/admin/identities/manual-bind   手工绑定（写审计）
 *   POST   /api/admin/policies                 创建/更新草稿（**发布前静态校验**）
 *   POST   /api/admin/policies/:code/publish   发布（校验不通过则拒绝）
 *   POST   /api/admin/evaluate                 试算（任意主体 + 覆盖事实）
 *
 * ★ 三条硬约束（都来自前面的设计决定，这里只是把它们落实到接口层）：
 *   1. **站点作用域来自会话，不来自请求体**——否则客户端可以指定任意 siteId 越权。
 *   2. **写操作必须记审计**（docs/05 §7）——手工绑定尤其需要，因为它绕过自动对齐。
 *   3. **发布前必须过静态校验**（M1-9）——引用未安装插件的策略一律拒绝。
 */

import type { Logger } from '../kernel/logger.ts';
import type { SubjectStore, StoredSubject } from '../plugin/subjects.ts';
import type { ExternalSubject, ProviderPlugin } from '../plugin/provider.ts';
import { subjectFingerprint, watchedFields } from '../plugin/provider.ts';
import { validatePolicy, type PluginRegistry, type PolicyDocument } from '../policy/model.ts';
import { checkManifest } from '../plugin/manifest.ts';
import { OidcIssuerConflict } from '../auth/oidc-provider-store.ts';
import { requiresApproval, UiApprovalRequired } from '../plugin/ui-contribution-store.ts';
import { canEnable } from '../plugin/governance.ts';
import { evaluateEligibility, type FactSnapshot } from '../policy/eligibility.ts';
import { simulate } from '../policy/simulate.ts';
import type { PlatformUser, IdentityStore } from '../core/identity.ts';
import type { PluginStore } from '../plugin/registry-store.ts';
import {
  capabilitiesOf,
  planModeSwitch,
  PLATFORM_MODE_KEY,
  type PlatformMode,
  type PlatformSettingsStore,
} from '../app/platform-mode.ts';

// ─────────────────────────── HTTP 抽象 ───────────────────────────

export interface HttpRequestLike {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** 会话（由认证中间件解析后注入；**站点作用域只能来自这里**） */
  session?: SessionContext | null;
}

export interface SessionContext {
  userId: string;
  username: string;
  /** 当前选中的站点（多站点用户必须先选定） */
  activeSiteId: string | null;
  /**
   * ★ 当前选中的**开发者**（`Session.principal.activeDeveloperId`）。
   *
   * ★ 为什么管理端会话需要它：审计可见性要回答「这条记录是否属于**我名下**的开发者」
   *   （`docs/06`：开发者仅见名下站点），而 `userId` 是**平台用户 id**、
   *   与**开发者 id** 在开发者链路上通常不同 —— 用错一个会让"名下站点"查成空集。
   */
  activeDeveloperId: string | null;
  realm: 'developer' | 'enduser';
  role: 'admin' | 'developer' | 'user';
}

export interface HttpResponseLike {
  status: number;
  body: unknown;
}

export type Handler = (request: HttpRequestLike) => Promise<HttpResponseLike>;

// ─────────────────────────── 依赖 ───────────────────────────

export interface AuditEntry {
  siteId: string;
  actorId: string;
  actorType: 'admin' | 'developer' | 'system';
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  traceId?: string;
  /**
   * ★★ **归属**（审计可见性的两个维度，见 `admin/audit-scope.ts`）。
   *
   * ★ 为什么写入侧必须提供它们：可见性判定要回答「这条记录属于哪个开发者/身份域」，
   *   而它**必须在 SQL 层可过滤**（`auditQueryFilterOf` 的注释：真实审计表很大，
   *   不能"先查全部再过滤"）。所以这两列**随写入落库**，而不是查询时 JOIN 出来。
   * ★ 省略 = **平台级操作**（不属于任何开发者）或**系统任务**（不属于任何身份域）——
   *   平台级记录对普通开发者**不可见**（`audit-scope` 的 `cross_realm` 分支）。
   */
  developerId?: string | null;
  realm?: 'developer' | 'enduser' | null;
}

/** 一条**已落库**的审计记录（读取侧）——比 `AuditEntry` 多出 `id` 与 `createdAt` */
export interface AuditRecord extends AuditEntry {
  /** ★ PG 下 `id` 是 `bigserial`（驱动返回**字符串**）→ 放宽为 `string | number` */
  id: string | number;
  createdAt: Date;
  /**
   * ★ **覆写为必填**（`AuditEntry` 里是可选的，因为写入侧可以不传）。
   *   落库后恒有值：`null` = **平台级操作**（不属于任何开发者）。
   *   ★ 这样 `AuditRecord` 与 `AuditRecordScope`（`audit-scope.ts`）**结构兼容**，
   *     于是 `filterVisibleAudit` 能直接吃它 —— 否则要写一层映射，
   *     而映射里最容易出的错就是"把 `undefined` 当成 `null`"（前者语义未定、后者是明确的平台级）。
   */
  developerId: string | null;
  realm: 'developer' | 'enduser' | null;
}

/**
 * 审计查询条件（`docs/06` 的 `GET /admin/audit`）。
 *
 * ★ 这里的字段是**过滤维度**，不是**权限** —— 权限由 `audit-scope.ts` 单独判定。
 *   `docs/06` 的可见性模型是「admin 全部 / 开发者仅名下 / 终端用户仅自己」；
 *   把"能查什么"与"查到后能不能看"混进同一个接口，是权限漏洞的经典来源。
 */
export interface AuditQuery {
  from?: Date;
  to?: Date;
  actorId?: string;
  /**
   * ★★ **站点集合**（来自 `AuditQueryFilter.siteIds`）。
   *   `'all'` = 不限；**空数组 = 查不到任何站点**（开发者的"名下站点为空"就该是查不到，
   *   而不是"退化成不过滤"——后者是跨租户泄露）。
   */
  siteIds?: readonly string[] | 'all';
  /** 归属开发者（`null` = 只看平台级记录） */
  developerId?: string | null;
  /** 身份域（`null` = 不限） */
  realm?: 'developer' | 'enduser' | null;
  /** 动作前缀（如 `oidc.` / `cross_site.`） */
  actionPrefix?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
  /**
   * ★★ **读取审计**（`docs/06` 声明的 `GET /admin/audit`）。
   *
   * ★ 为什么它必须存在：审计是「**排障与追责**」的依据（`audit-scope.ts` 文件头原话）。
   *   在此之前 `AuditSink` **只有 `record`** —— 数据一直在写，却**没有任何读取路径**：
   *   出了事答不出「谁在什么时候做了什么」。
   * ★ 站点作用域：实现按 `siteId` 过滤（审计表是站点级的）；**跨站点**读取要经过
   *   `core/cross-site.ts` 的判定（见端点实现）。
   */
  list(query: AuditQuery): Promise<readonly AuditRecord[]>;
}

export interface PolicyStore {
  /** 站点作用域内的策略（草稿 + 已发布） */
  list(siteId: string): Promise<PolicyDocument[]>;
  get(siteId: string, code: string): Promise<PolicyDocument | undefined>;
  saveDraft(siteId: string, document: PolicyDocument): Promise<void>;
  publish(siteId: string, code: string, version: number): Promise<PolicyDocument>;
  /**
   * 待发布的**最新草稿**。
   *
   * ★ 为什么与 `get()` 分开（这是一个真实踩到的设计缺陷）：
   *   `get()` 的语义是「**当前生效内容**」（active 优先）。
   *   而「发布」要发布的是**最新草稿**。
   *   早期用 `get()` 兼两者：发布 v2 时 `get()` 返回的是 active 的 v1，
   *   于是 `publish(v1)` 变成幂等空操作——**新草稿永远发不出去**。
   *   两者本来就是不同的东西，必须分开。
   */
  latestDraft(siteId: string, code: string): Promise<PolicyDocument | undefined>;
  /**
   * 回滚到**指定历史版本**（M2-7）。
   *
   * ★ 为什么不能靠「重新 saveDraft 一份旧内容」代替：
   *   那会**新建**一个版本，历史被改写（原本 v3 的内容变成 v4），
   *   而「历史评估可复现」要求「v3 永远是 v3」。
   *   回滚是**指针操作**：把 `active_version_id` 指回 v3，v4 转 archived。
   */
  rollback(siteId: string, code: string, version: number): Promise<PolicyDocument>;
  /** 列出某策略的版本历史（供管理端与回滚选择） */
  versions?(siteId: string, code: string): Promise<{ version: number; status: string; createdAt: Date; specHash?: string }[]>;
}

export interface AdminDeps {
  /**
   * 事务包装（**真实 PG 模式必需**）。
   *
   * 不提供时直通（内存 store 无需事务）。真实 PG 下必须提供——
   * 否则管理端每个请求都会因 `assertInTransaction` 而 500。
   */
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * 插件注册表（P0 基础设施）。
   *
   * ★ 未提供时不挂载 `/api/admin/plugins` 相关路由——
   *   显式「不可用」比「返回空列表」诚实（后者会让人以为「一个插件都没装」）。
   */
  plugins?: PluginStore;
  /** 平台设置存储（`ag_platform_settings`）；未提供时不挂载 `/api/admin/settings/*` */
  settings?: PlatformSettingsStore;
  /** 断言流水（`ag_verify_assertions`）；未提供时不挂载断言相关端点 */
  assertions?: import('../verify/assertion-store.ts').AssertionAdminStore;
  /** OIDC 提供方注册（`ag_oidc_providers`）；未提供时不挂载 `/api/admin/oidc/providers/*` */
  oidcProviders?: import('../auth/oidc-provider-store.ts').OidcProviderStore;
  /** 协同验证调用方管理（`ag_verify_clients`）；未提供时不挂载 `/api/admin/verify/clients/*` */
  verifyClients?: import('../verify/client-admin.ts').VerifyClientAdminStore;
  /** 用户管理存储（`ag_users` / `ag_identities`）；未提供时不挂载 `/api/admin/users/*` */
  users?: import('./user-store.ts').UserAdminStore;
  /**
   * 插件运行时编排器（P1-1：让**插件宿主体**真的可用）。
   *
   * ★ 提供「手动触发一次插件采集」的能力；未提供时相关端点返回 501。
   * ★ **自动调度**（按什么节奏、对哪些主体采集）留给设计决策——
   *   见 `reports/architecture-gaps.md`「开发者级插件的事实记在谁名下」。
   */
  pluginRuntime?: import('../plugin/runtime-orchestrator.ts').PluginRuntimeOrchestrator;
  /**
   * 插件实例存储（`ag_plugin_instances`）——**让插件自动调度可运维**。
   *
   * ★ 自动调度遍历「已启用的开发者级实例」；没有管理端点的话，
   *   运维**只能用代码建实例**——那等于「功能在但不可用」。
   */
  pluginInstances?: import('../db/plugin-instance-adapter.ts').DbPluginInstanceStore;
  /**
   * 回滚依赖（**按主体 / 按策略批量**回滚需要）。
   *
   * ★ 未提供时那两种形态返回 501（显式不可用）——「单条」形态不依赖它。
   */
  rollbackDeps?: import('../core/rollback.ts').RollbackDeps;
  /** 插件调用记录（`ag_plugin_invocations`，**站点级**）；未提供时返回 501 */
  invocations?: import('../plugin/invocation-store.ts').PluginInvocationStore;
  /** 插件令牌（`ag_plugin_tokens`）；未提供时返回 501 */
  pluginTokens?: import('../plugin/token-store.ts').PluginTokenStore;
  /** 插件 UI 贡献（`ag_plugin_ui_contributions`）；未提供时返回 501 */
  uiContributions?: import('../plugin/ui-contribution-store.ts').UiContributionStore;
  /** 插件权限授予（`ag_plugin_grants`，文档 §4.3）；未提供时 grants 端点返回 501 */
  grants?: import('../plugin/grant-store.ts').PluginGrantStore;
  /** 插件端点注册表（`ag_plugin_endpoints`）；未提供时端点管理返回 501 */
  endpoints?: import('../plugin/endpoint-store.ts').PluginEndpointStore;
  /** 插件配置存储（`ag_plugin_configs`）；未提供时配置端点返回 501 */
  configs?: import('../plugin/config-store.ts').PluginConfigStore;
  /** 宿主内置的插件 manifest（供 `/admin/plugins/registry` 列出「有哪些可以装」） */
  builtinManifests?: readonly unknown[];
  /** 全平台统计（切换模式时的「数据影响提示」用） */
  platformStats?: () => Promise<{ developers: number; sites: number; subjects: number; extraSites: number }>;
  subjects: SubjectStore;
  identities: IdentityStore;
  policies: PolicyStore;
  audit: AuditSink;
  registry: PluginRegistry;
  /** 当前站点的主体目录（用于手工绑定时的指纹计算与引用校验） */
  providerForSite: (siteId: string) => ProviderPlugin | undefined;
  /**
   * ★ P1-4：OIDC 签名密钥的**可运维入口**（查看状态 + 手动触发轮换）。
   *
   * ★ 为什么必须有：轮换是**高危操作**（零 active 窗口 = 全站登录中断），
   *   而在它之前运维只能"等 90 天自动轮换"——出问题时**没有任何受控手段**。
   * ★ `rotateOnce` 必须与调度器走**同一套判定**（`nextRotationStep`），
   *   因此"手动"不会绕过「等待下游 JWKS 缓存过期」这一步。
   * ★ 未提供时不挂载端点（显式不可用 > 返回空列表）。
   */
  signingKeys?: {
    list(): Promise<
      readonly {
        kid: string;
        alg: string;
        status: string;
        activatedAt: Date | null;
        removeAfter: Date | null;
        createdAt: Date;
      }[]
    >;
    rotateOnce(now: Date): Promise<{ action: string; detail: string }>;
  };
  /**
   * ★ P1-11：外置插件**包体**的权威存储（上传入口）。
   *
   * ★ 为什么上传必须走它而不是本地文件：D9 明确**否决**"文件系统作为持久层"——
   *   容器重建、Pod 漂移、多实例无共享卷都会丢；包体的权威副本在数据库，
   *   本地只由 `FileSystemPackageCache` 按 digest 拉回（可丢弃）。
   * ★ `digest` 由存储**自己算**（不接受调用方声称的值）。
   * ★ 未提供时不挂载端点（显式不可用 > 静默丢弃上传）。
   */
  pluginPackages?: import('../db/plugin-package-adapter.ts').PluginPackageStore;
  /**
   * ★★ 审计可见性：**该开发者名下的站点集合**（`docs/06` 的「开发者仅见名下站点」）。
   *
   * ★ 为什么要它：`auditQueryFilterOf` 要把"名下站点"转成 **SQL 层条件** ——
   *   真实审计表很大，不能"先查全部再过滤"。站点集合本身是站点级的（需跨站点查询），
   *   所以由装配层提供，而不是让管理端自己拼。
   * ★ 未提供时按**空集合**处理（→ `inList` 空集 → **查不到**）：
   *   **fail-closed** —— 没配置就看不到，而不是"退化成能看全部"。
   */
  auditSiteIdsOfDeveloper?: (userId: string) => Promise<readonly string[]> | readonly string[];
  /**
   * ★★ **灰度熔断状态**（`docs/07 M6-3`「一键熔断」）。
   * ★ 未装配 = 该部署不支持熔断（端点返回 501，而不是假装成功）。
   */
  rolloutAborts?: import('../core/rollout-abort.ts').RolloutAbortStore;
  /**
   * ★★ P1-5：站点级分配的**跨站点**查询（仅管理端统计用）。
   *
   * ★ 类型刻意是**一个函数**而不是整个 store：跨站点方法（`listCrossSite`）
   *   不在 `PolicyAssignmentStore` 接口上——**接口不该鼓励跨站点查询**，
   *   只有装配层能显式交出这个能力。
   * ★ 调用方**必须**先经过 `evaluateCrossSite()` 判定并写审计（见端点实现）。
   */
  policyAssignmentsCrossSite?: () => Promise<
    readonly import('../core/policy-assignments.ts').PolicyAssignment[]
  >;
  logger?: Logger;
}

// ─────────────────────────── 错误与响应 ───────────────────────────

/**
 * uuid 格式校验（路径参数用）。
 *
 * ★★ 为什么必要：路径参数是**外部输入**，直接传进 SQL 会让 PG 抛
 *   `invalid input syntax for type uuid` → 落到通用错误处理 → **500**。
 *   而正确的语义是 **400**（客户端给了非法参数），不是 500（服务端故障）。
 *
 *   这是被 `tools/path-probe.ts` 的**自动推导探针**抓到的：
 *   它用 `probe-id` 这个非 uuid 值请求 `/api/admin/users/:id`，
 *   而手工清单里从没测过「非法 id」这种输入。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new HttpError(400, `${label} 必须是 uuid（实际 '${value}'）——该表主键是 uuid，非法值应返回 400 而不是让数据库报错`);
  }
  return value;
}

/**
 * 递归剔除敏感字段（`raw` 端点用）。
 *
 * ★★ 为什么必须递归：provider 的原始对象是嵌套的，
 *   若只删顶层 `password`，`profile.credentials.access_token` 会**漏出去**。
 *   ★ 且**不能只靠 key 名黑名单**——真实实现还应结合 schema；
 *     但黑名单足以覆盖文档明确点名的 `password` / `access_token`，
 *     并由 `tools/path-probe.ts` 的敏感字段扫描做**反向验证**。
 */
const REDACTED_KEYS = ['password', 'password_hash', 'access_token', 'refresh_token', 'id_token', 'secret', 'client_secret', 'api_key', 'token'];

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[深度超限]';
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.includes(key.toLowerCase())) {
      // ★ 保留「这里原本有个值」的信息，而不是静默删掉——
      //   排障时「有没有配 token」本身是重要线索
      out[key] = '[已脱敏]';
      continue;
    }
    out[key] = redactSecrets(child, depth + 1);
  }
  return out;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ok = (body: unknown): HttpResponseLike => ({ status: 200, body });
const created = (body: unknown): HttpResponseLike => ({ status: 201, body });
const fail = (status: number, message: string, detail?: unknown): HttpResponseLike => ({
  status,
  body: { error: message, ...(detail === undefined ? {} : { detail }) },
});

// ─────────────────────────── 鉴权与作用域 ───────────────────────────

/**
 * 取站点作用域。
 *
 * ★ **只从会话取**：早期设想过「允许请求体带 siteId 便于运维」，那是越权漏洞——
 *   客户端只要改一个字段就能操作别的站点。因此这里连参数都不接受。
 */
function requireSite(request: HttpRequestLike): { session: SessionContext; siteId: string } {
  const session = request.session;
  if (session === undefined || session === null) throw new HttpError(401, '未登录');
  if (typeof session.activeSiteId !== 'string' || session.activeSiteId.length === 0) {
    throw new HttpError(400, '尚未选定站点（多站点用户必须先选定，站点作用域不来自请求体）');
  }
  return { session, siteId: session.activeSiteId };
}

/** 管理端只允许 admin / developer 域；`enduser` 域一律拒绝。 */
function requireAdmin(request: HttpRequestLike): { session: SessionContext; siteId: string } {
  const { session, siteId } = requireSite(request);
  if (session.realm === 'enduser') throw new HttpError(403, '普通用户域不可访问管理端');
  if (session.role === 'user') throw new HttpError(403, '当前角色无权访问管理端');
  return { session, siteId };
}

// ─────────────────────────── 主体列表 ───────────────────────────

interface SubjectListRow {
  externalId: string;
  displayName?: string;
  email?: string;
  fingerprint: string;
  syncedAt: string;
  deleted: boolean;
  /** 关注的属性（策略里会用到的那些） */
  watched: Record<string, unknown>;
}

function toRow(subject: StoredSubject): SubjectListRow {
  const watched: Record<string, unknown> = {};
  for (const field of subject.watched) watched[field] = subject.attributes[field] ?? null;
  return {
    externalId: subject.externalId,
    ...(subject.displayName === undefined ? {} : { displayName: subject.displayName }),
    ...(subject.email === undefined ? {} : { email: subject.email }),
    fingerprint: subject.fingerprint,
    syncedAt: subject.syncedAt.toISOString(),
    deleted: subject.deletedAt !== undefined,
    watched,
  };
}

// ─────────────────────────── 手工绑定 ───────────────────────────

interface ManualBindBody {
  /** 平台用户 id（`ag_users.id`） */
  userId?: unknown;
  /** 下游主体主键 */
  externalId?: unknown;
  /** 可选：提供方命名空间（缺省用当前站点的 provider id） */
  provider?: unknown;
  reason?: unknown;
}

// ─────────────────────────── 策略 ───────────────────────────

interface PolicyBody {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  priority?: unknown;
  enabled?: unknown;
  spec?: unknown;
}

function parsePolicyBody(body: unknown): PolicyDocument {
  if (body === null || typeof body !== 'object') throw new HttpError(400, '请求体必须是策略对象');
  const record = body as PolicyBody;
  if (typeof record.code !== 'string' || record.code.length === 0) throw new HttpError(400, '策略缺少 code');
  if (record.spec === null || typeof record.spec !== 'object') throw new HttpError(400, '策略缺少 spec');
  return {
    code: record.code,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(typeof record.priority === 'number' ? { priority: record.priority } : {}),
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
    spec: record.spec as PolicyDocument['spec'],
  };
}

// ─────────────────────────── 路由器 ───────────────────────────

/**
 * 构建管理端处理器。
 *
 * 路由表刻意写成一个显式 switch（而不是引入路由器库）：M1 只有 5 个端点，
 * 显式列举让「哪些端点存在、各自要什么权限」一眼可见，也便于 CI 扫描。
 */
export function createAdminHandler(deps: AdminDeps): Handler {
  const handleInner = async function handle(request: HttpRequestLike): Promise<HttpResponseLike> {
    try {
      const method = request.method.toUpperCase();
      const path = request.path.replace(/\/+$/, '') || '/';

      // ══════════ 协同验证调用方（P0；docs/06 /admin/verify 系列，M5 运营面）══════════
      const verifyClients = deps.verifyClients;
      if (verifyClients !== undefined && path.startsWith('/api/admin/verify/clients')) {
        // ── GET /api/admin/verify/clients ──
        if (method === 'GET' && path === '/api/admin/verify/clients') {
          requireAdmin(request);
          const list = await verifyClients.list();
          return ok({
            clients: list,
            total: list.length,
            // ★ 提示运维「有多少把密钥处于停用/吊销」——它们是**仍需关注的**（可能该删）
            inactive: list.filter((entry) => entry.status !== 'active').map((entry) => entry.clientId),
          });
        }

        // ── POST /api/admin/verify/clients（创建；密钥**只返回一次**）──
        if (method === 'POST' && path === '/api/admin/verify/clients') {
          const { session } = requireAdmin(request);
          const body = (request.body ?? {}) as { name?: unknown; scopes?: unknown; allowedSubjects?: unknown; callbackUrl?: unknown };
          if (typeof body.name !== 'string' || body.name.trim().length === 0) throw new HttpError(400, '缺少 name');
          if (!Array.isArray(body.scopes) || body.scopes.length === 0) throw new HttpError(400, '缺少 scopes 数组（至少一项）');
          const created = await verifyClients.create({
            name: body.name,
            scopes: body.scopes as string[],
            ...(Array.isArray(body.allowedSubjects) ? { allowedSubjects: body.allowedSubjects as string[] } : {}),
            ...(typeof body.callbackUrl === 'string' ? { callbackUrl: body.callbackUrl } : {}),
            createdBy: session.userId,
          });
          return ok({
            client: created.client,
            // ★★ 原始密钥**只在此刻返回**，平台不保存明文（表里只有哈希与前缀）
            secret: created.secret,
            warning: '此密钥只显示这一次——平台只保存哈希，无法再次取回。请立即安全保存。',
          });
        }

        // ── POST /api/admin/verify/clients/:id/(suspend|activate|rotate) ──
        const clientActionMatch = /^\/api\/admin\/verify\/clients\/([^/]+)\/(suspend|activate|rotate)$/.exec(path);
        if (method === 'POST' && clientActionMatch !== null) {
          requireAdmin(request);
          const id = requireUuid(decodeURIComponent(clientActionMatch[1]!), '调用方 id');
          const action = clientActionMatch[2]!;
          if (action === 'rotate') {
            const rotated = await verifyClients.rotate(id);
            if (rotated === undefined) throw new HttpError(404, `调用方 '${id}' 不存在`);
            return ok({
              client: rotated.client,
              secret: rotated.secret,
              warning: '新密钥只显示这一次；旧密钥**立即失效**，请同步更新调用方配置。',
            });
          }
          const updated = await verifyClients.setStatus(id, action === 'suspend' ? 'suspended' : 'active');
          if (updated === undefined) throw new HttpError(404, `调用方 '${id}' 不存在`);
          return ok({ client: updated });
        }

        // ── DELETE /api/admin/verify/clients/:id ──
        const clientDeleteMatch = /^\/api\/admin\/verify\/clients\/([^/]+)$/.exec(path);
        if (method === 'DELETE' && clientDeleteMatch !== null) {
          requireAdmin(request);
          const id = requireUuid(decodeURIComponent(clientDeleteMatch[1]!), '调用方 id');
          const removed = await verifyClients.remove(id);
          if (!removed) throw new HttpError(404, `调用方 '${id}' 不存在`);
          return ok({ removed: id });
        }

        throw new HttpError(404, `未知的协同验证端点：${path}`);
      }

      // ── 断言流水与撤销（`ag_verify_assertions`）──
      const assertions = deps.assertions;
      if (assertions !== undefined && path.startsWith('/api/admin/verify/assertions')) {
        // ── GET /api/admin/verify/assertions?clientId=&onlyActive= ──
        if (method === 'GET' && path === '/api/admin/verify/assertions') {
          requireAdmin(request);
          const onlyActiveRaw = request.query?.['onlyActive'];
          const result = await assertions.list({
            ...(request.query?.['clientId'] === undefined ? {} : { clientId: request.query['clientId']! }),
            ...(onlyActiveRaw === '1' || onlyActiveRaw === 'true' ? { onlyActive: true } : {}),
            limit: clampInt(request.query?.['limit'], 50, 1, 200) + 1,
            offset: clampInt(request.query?.['offset'], 0, 0, Number.MAX_SAFE_INTEGER),
          });
          return ok({
            assertions: result.assertions.map((entry) => ({
              id: entry.id,
              clientId: entry.clientId,
              subjectType: entry.subjectType,
              subjectValue: entry.subjectValue,
              matched: entry.matched,
              via: entry.via,
              expiresAt: entry.expiresAt.toISOString(),
              revokedAt: entry.revokedAt?.toISOString() ?? null,
              createdAt: entry.createdAt.toISOString(),
              // ★ 断言内容对管理员可见（审计需要）；但**不**包含签名（它已在签发时校验）
            })),
            total: result.total,
            hasMore: result.hasMore,
            totalIsExact: false,
          });
        }

        // ── POST /api/admin/verify/assertions/:id/revoke ──
        //   ★ `id` 是 **bigserial（数字）**，与 `ag_verify_clients.id`（uuid）不同——
        //     这里显式解析为整数并拒绝非数字（否则会静默查不到）。
        const assertionRevokeMatch = /^\/api\/admin\/verify\/assertions\/([^/]+)\/revoke$/.exec(path);
        if (method === 'POST' && assertionRevokeMatch !== null) {
          requireAdmin(request);
          const raw = decodeURIComponent(assertionRevokeMatch[1]!);
          const id = Number.parseInt(raw, 10);
          if (!Number.isInteger(id) || id <= 0) {
            throw new HttpError(400, `断言 id 必须是正整数（实际 '${raw}'）——该表的主键是 bigserial，不是 uuid`);
          }
          const result = await assertions.revoke(id, new Date());
          if (result === undefined) throw new HttpError(404, `断言 '${id}' 不存在`);
          return ok({
            assertion: {
              id: result.record.id,
              revokedAt: result.record.revokedAt?.toISOString() ?? null,
            },
            // ★ 幂等：重复撤销不报错，但明确告知「之前就撤销过」
            alreadyRevoked: result.alreadyRevoked,
            note: result.alreadyRevoked ? '该断言此前已被撤销（保留首次撤销时间）' : '已撤销，该断言立即失效',
          });
        }

        throw new HttpError(404, `未知的断言端点：${path}`);
      }

      // ══════════ OIDC 提供方注册（P0；docs/06 /admin/oidc 系列）══════════
      const oidcProviders = deps.oidcProviders;
      if (oidcProviders !== undefined && path.startsWith('/api/admin/oidc/providers')) {
        // ── GET /api/admin/oidc/providers ──
        if (method === 'GET' && path === '/api/admin/oidc/providers') {
          requireAdmin(request);
          const list = await oidcProviders.list();
          return ok({
            providers: list.map((entry) => ({
              ref: entry.ref,
              label: entry.label,
              direction: entry.direction,
              issuer: entry.issuer,
              clientId: entry.clientId,
              // ★★ 只暴露「是否配置了密钥引用」，**绝不暴露引用值本身**——
              //   引用值虽不是密钥，但泄露它会让攻击者知道该去 `ag_secrets` 找什么。
              hasClientSecret: entry.clientSecretRef !== null,
              allowPlatformLogin: entry.allowPlatformLogin,
              status: entry.status,
            })),
            total: list.length,
            // ★ 提示运维：有多少提供方处于停用/吊销（它们仍占用 ref，可能该清理）
            inactive: list.filter((entry) => entry.status !== 'active').map((entry) => entry.ref),
          });
        }

        // ── POST /api/admin/oidc/providers（注册或更新，按 ref 幂等）──
        if (method === 'POST' && path === '/api/admin/oidc/providers') {
          requireAdmin(request);
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (typeof body['ref'] !== 'string' || body['ref'].trim().length === 0) throw new HttpError(400, '缺少 ref');
          if (typeof body['label'] !== 'string' || body['label'].trim().length === 0) throw new HttpError(400, '缺少 label');
          // ★ direction 必须显式给出：`outbound`（我们去连 IdP）与 `inbound`（IdP 来连我们）
          //   的风险面与配置项完全不同，不可默认。
          if (body['direction'] !== 'outbound' && body['direction'] !== 'inbound') {
            throw new HttpError(400, "direction 必须是 'outbound' 或 'inbound'（两者的配置与风险面不同，不可默认）");
          }
          if (typeof body['issuer'] !== 'string' || !/^https:\/\//.test(body['issuer'])) {
            throw new HttpError(400, 'issuer 必须是 https:// 开头的 URL（OIDC 发现文档要求 TLS）');
          }
          let saved;
          try {
            saved = await oidcProviders.upsert({
              ref: body['ref'],
              label: body['label'],
              direction: body['direction'],
              issuer: body['issuer'],
              ...(typeof body['wellKnown'] === 'string' ? { wellKnown: body['wellKnown'] } : {}),
              ...(typeof body['clientId'] === 'string' ? { clientId: body['clientId'] } : {}),
              ...(typeof body['clientSecretRef'] === 'string' ? { clientSecretRef: body['clientSecretRef'] } : {}),
              ...(Array.isArray(body['redirectUris']) ? { redirectUris: body['redirectUris'] as string[] } : {}),
              ...(Array.isArray(body['scopes']) ? { scopes: body['scopes'] as string[] } : {}),
              ...(body['allowPlatformLogin'] === true ? { allowPlatformLogin: true } : {}),
            });
          } catch (error) {
            // ★★ 同一 IdP 被两个 ref 注册 → **409**（而不是 500）。
            //   不能静默重试：那会让两个 ref 指向同一 IdP，
            //   导致「同一身份在两条链路上各建一个号」。
            if (error instanceof OidcIssuerConflict) throw new HttpError(409, error.message);
            throw error;
          }
          return ok({
            provider: { ref: saved.ref, direction: saved.direction, status: saved.status, hasClientSecret: saved.clientSecretRef !== null },
            // ★ 明确告知「密钥不进表」——避免运维以为把密钥传进来就完事了
            note: '密钥请通过 clientSecretRef 引用 `ag_secrets` 的 key，本接口**不接受**明文密钥',
          });
        }

        // ── PUT /api/admin/oidc/providers/:ref（按 ref 更新）──
        const providerRefMatch = /^\/api\/admin\/oidc\/providers\/([^/]+)$/.exec(path);
        if (method === 'PUT' && providerRefMatch !== null) {
          requireAdmin(request);
          const ref = decodeURIComponent(providerRefMatch[1]!);
          const existing = await oidcProviders.findByRef(ref);
          if (existing === undefined) throw new HttpError(404, `OIDC 提供方 '${ref}' 未注册`);
          const body = (request.body ?? {}) as Record<string, unknown>;
          const saved = await oidcProviders.upsert({
            ref,
            label: typeof body['label'] === 'string' ? body['label'] : existing.label,
            direction: body['direction'] === 'outbound' || body['direction'] === 'inbound' ? body['direction'] : existing.direction,
            issuer: typeof body['issuer'] === 'string' ? body['issuer'] : existing.issuer,
            wellKnown: typeof body['wellKnown'] === 'string' ? body['wellKnown'] : (existing.wellKnown ?? undefined),
            clientId: typeof body['clientId'] === 'string' ? body['clientId'] : (existing.clientId ?? undefined),
            clientSecretRef: typeof body['clientSecretRef'] === 'string' ? body['clientSecretRef'] : (existing.clientSecretRef ?? undefined),
            redirectUris: Array.isArray(body['redirectUris']) ? (body['redirectUris'] as string[]) : existing.redirectUris,
            scopes: Array.isArray(body['scopes']) ? (body['scopes'] as string[]) : existing.scopes,
            allowPlatformLogin: body['allowPlatformLogin'] === undefined ? existing.allowPlatformLogin : body['allowPlatformLogin'] === true,
          });
          return ok({ provider: { ref: saved.ref, status: saved.status, updatedAt: saved.updatedAt.toISOString() } });
        }

        throw new HttpError(404, `未知的 OIDC 端点：${path}`);
      }

      // ══════════ 用户管理（P0；docs/06 /admin/users 系列）══════════
      const users = deps.users;
      if (users !== undefined && path.startsWith('/api/admin/users')) {
        // ── GET /api/admin/users?status=&search=&limit=&offset= ──
        if (method === 'GET' && path === '/api/admin/users') {
          requireAdmin(request);
          const status = request.query?.['status'];
          const validStatuses = ['pending', 'active', 'suspended', 'deleted'] as const;
          if (status !== undefined && status.length > 0 && !(validStatuses as readonly string[]).includes(status)) {
            throw new HttpError(400, `status 必须是 ${validStatuses.join(' / ')} 之一`);
          }
          const result = await users.list({
            ...(status === undefined || status.length === 0 ? {} : { status: status as (typeof validStatuses)[number] }),
            ...(request.query?.['search'] === undefined ? {} : { search: request.query['search']! }),
            // ★ 多取一条用于判断 hasMore（避免 count(*)——见 user-store.ts 的说明）
            limit: clampInt(request.query?.['limit'], 50, 1, 200) + 1,
            offset: clampInt(request.query?.['offset'], 0, 0, Number.MAX_SAFE_INTEGER),
          });
          return ok({ users: result.users, total: result.total, hasMore: result.hasMore, totalIsExact: false });
        }

        // ── GET /api/admin/users/:id ──
        const userDetailMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(path);
        if (method === 'GET' && userDetailMatch !== null) {
          requireAdmin(request);
          const id = requireUuid(decodeURIComponent(userDetailMatch[1]!), '用户 id');
          const user = await users.get(id);
          if (user === undefined) throw new HttpError(404, `用户 '${id}' 不存在`);
          return ok({ user });
        }

        // ── GET /api/admin/users/:id/raw（provider 侧原始对象，**已脱敏**）──
        //   ★ 文档明确要求「已剔除 `password` / `access_token`」——
        //     这是本端点**唯一的复杂点**：原始对象是嵌套的，
        //     脱敏必须**递归**，否则 `profile.credentials.access_token` 会漏出去。
        const userRawMatch = /^\/api\/admin\/users\/([^/]+)\/raw$/.exec(path);
        if (method === 'GET' && userRawMatch !== null) {
          const { siteId } = requireAdmin(request);
          const id = requireUuid(decodeURIComponent(userRawMatch[1]!), '用户 id');
          const user = await users.get(id);
          if (user === undefined) throw new HttpError(404, `用户 '${id}' 不存在`);
          const provider = deps.providerForSite(siteId);
          if (provider === undefined) throw new HttpError(400, `站点 ${siteId} 尚未配置主体目录（provider）`);
          // ★ 用 externalId 取 provider 侧原始对象（identity 里存的是 providerUserId）
          const identities = await users.identitiesOf(id);
          if (identities.length === 0) {
            return ok({ userId: id, raw: null, note: '该用户没有绑定任何外部身份，因此没有 provider 侧原始对象' });
          }
          const raw = await provider.getSubject(identities[0]!.providerUserId);
          return ok({
            userId: id,
            raw: redactSecrets(raw),
            // ★ 明确告知已脱敏——避免运维以为看到的是全量
            redacted: true,
            note: '已递归剔除 password / access_token / secret 等敏感字段',
          });
        }

        // ── GET /api/admin/users/:id/identities ──
        const userIdentitiesMatch = /^\/api\/admin\/users\/([^/]+)\/identities$/.exec(path);
        if (method === 'GET' && userIdentitiesMatch !== null) {
          requireAdmin(request);
          const id = requireUuid(decodeURIComponent(userIdentitiesMatch[1]!), '用户 id');
          const user = await users.get(id);
          if (user === undefined) throw new HttpError(404, `用户 '${id}' 不存在`);
          const identities = await users.identitiesOf(id);
          return ok({
            userId: id,
            identities,
            // ★ 没有任何绑定身份 = 用户无法通过 OIDC 登录，这是排障时的重要线索
            note: identities.length === 0 ? '该用户没有绑定任何外部身份（无法通过 OIDC 登录）' : undefined,
          });
        }

        // ── POST /api/admin/users/:id/tags（**全量替换**标签）──
        //   ★ 语义是替换而非追加：标签是运营分类，「加一个」与「去掉一个」是同一意图的两面；
        //     增量接口会让「清空标签」变成「逐个删」，调用方很难确认删干净了。
        const userTagsMatch = /^\/api\/admin\/users\/([^/]+)\/tags$/.exec(path);
        if (method === 'POST' && userTagsMatch !== null) {
          requireAdmin(request);
          const id = requireUuid(decodeURIComponent(userTagsMatch[1]!), '用户 id');
          const body = (request.body ?? {}) as { tags?: unknown };
          if (!Array.isArray(body.tags)) throw new HttpError(400, '缺少 tags 数组（全量替换；清空请传 []）');
          // ★ 每个标签必须是字符串，且有长度上限——避免把超长文本塞进 jsonb 变成注入面
          const invalid = body.tags.find((tag) => typeof tag !== 'string' || tag.length === 0 || tag.length > 64);
          if (invalid !== undefined) {
            throw new HttpError(400, `标签必须是非空字符串且不超过 64 字符（实际 ${JSON.stringify(invalid).slice(0, 40)}）`);
          }
          const updated = await users.setTags(id, body.tags as string[]);
          if (updated === undefined) throw new HttpError(404, `用户 '${id}' 不存在`);
          return ok({
            user: { id: updated.id, tags: updated.tags },
            // ★ 回显去重后的结果：让调用方知道「传了 5 个、实际存了 3 个」而不是自己猜
            note: body.tags.length === updated.tags.length ? undefined : `已去重：传入 ${body.tags.length} 个，实际存储 ${updated.tags.length} 个`,
          });
        }

        // ── POST /api/admin/users/:id/block（封禁 / 解封）──
        const userBlockMatch = /^\/api\/admin\/users\/([^/]+)\/block$/.exec(path);
        if (method === 'POST' && userBlockMatch !== null) {
          requireAdmin(request);
          const id = requireUuid(decodeURIComponent(userBlockMatch[1]!), '用户 id');
          const body = (request.body ?? {}) as { blocked?: unknown };
          // ★ 默认封禁（blocked 未给时按「封禁」处理——管理员点这个端点通常是想封人）
          const blocked = body.blocked !== false;
          const updated = await users.setStatus(id, blocked ? 'suspended' : 'active');
          if (updated === undefined) throw new HttpError(404, `用户 '${id}' 不存在`);
          return ok({ user: { id: updated.id, status: updated.status } });
        }

        throw new HttpError(404, `未知的用户端点：${path}`);
      }

      // ══════════ 平台设置（P0；docs/06 /admin/settings 系列）══════════
      const settings = deps.settings;
      if (settings !== undefined && path.startsWith('/api/admin/settings')) {
        // ── GET /api/admin/settings/platform ──
        if (method === 'GET' && path === '/api/admin/settings/platform') {
          requireAdmin(request);
          const record = await settings.get(PLATFORM_MODE_KEY);
          const mode = (record?.value as PlatformMode | undefined) ?? 'standalone';
          return ok({
            mode,
            capabilities: capabilitiesOf(mode),
            // ★ 被环境变量锁定时 API 不得修改——运维需要知道这一点
            lockedByEnv: record?.lockedByEnv ?? false,
            updatedBy: record?.updatedBy ?? null,
            updatedAt: record?.updatedAt.toISOString() ?? null,
            // 供前端渲染「切换后会怎样」
            impacts: planModeSwitch({ from: mode, to: mode === 'saas' ? 'standalone' : 'saas', stats: { developers: 0, sites: 0, subjects: 0, extraSites: 0 } }).impacts,
          });
        }

        // ── POST /api/admin/settings/platform（切换模式）──
        if (method === 'POST' && path === '/api/admin/settings/platform') {
          const { session } = requireAdmin(request);
          const body = (request.body ?? {}) as { mode?: unknown; confirm?: unknown };
          if (body.mode !== 'standalone' && body.mode !== 'saas') {
            throw new HttpError(400, "mode 必须是 'standalone' 或 'saas'");
          }
          const record = await settings.get(PLATFORM_MODE_KEY);
          const from = (record?.value as PlatformMode | undefined) ?? 'standalone';
          // ★★ 环境变量锁定 → 拒绝（否则一次误操作就能推翻部署时的决定）
          if (record?.lockedByEnv === true) {
            throw new HttpError(
              409,
              `平台模式被环境变量锁定（locked_by_env）——API 不得修改。` +
                `如需切换，请修改部署配置（AG_PLATFORM_MODE）后重启。`,
            );
          }
          const stats = deps.platformStats === undefined ? { developers: 0, sites: 0, subjects: 0, extraSites: 0 } : await deps.platformStats();
          const plan = planModeSwitch({ from, to: body.mode, stats });
          // ★ 降级需要显式确认（它会让站点 UI 隐藏、入驻入口关闭）
          if (body.mode === 'standalone' && from === 'saas' && body.confirm !== true) {
            return ok({
              requiresConfirmation: true,
              prompt: plan.prompt,
              impacts: plan.impacts,
              reversible: plan.reversible,
              dataLoss: plan.dataLoss,
            });
          }
          const saved = await settings.put(PLATFORM_MODE_KEY, body.mode, session.userId, new Date());
          return ok({
            mode: body.mode,
            capabilities: capabilitiesOf(body.mode),
            // ★ 明确告知调用方「可逆且不丢数据」
            reversible: plan.reversible,
            dataLoss: plan.dataLoss,
            updatedBy: saved.updatedBy,
          });
        }

        throw new HttpError(404, `未知的设置端点：${path}`);
      }

      // ══════════ 插件管理（P0；docs/06 的 /admin/plugins 系列）══════════
      const plugins = deps.plugins;
      const configStore = deps.configs;
      const endpointStore = deps.endpoints;
      const grantStore = deps.grants;
      const uiContributions = deps.uiContributions;
      const pluginTokens = deps.pluginTokens;
      const invocations = deps.invocations;
      // ★★ **插件段**：刻意**不用** `plugins !== undefined` 门控整段 ——
      //   那会把"插件存储未装配"变成 **404（未知端点）**，即**把"功能未配置"伪装成"路由不存在"**，
      //   让运维往"是不是没挂载"的方向查。改为**进入端点后显式 501**
      //   （与本文件其它段落一致："显式不可用，而不是静默"）。
      //   ★ 这里保留一层**裸块**只是为了让既有缩进与括号不动。
      {
        if (path.startsWith('/api/admin/plugins') && plugins === undefined) {
          throw new HttpError(501, '插件存储未装配');
        }
        // ★ **纯类型断言**（不是运行期检查，也不是 IIFE）：
        //   · 运行期保证已由上面的「按路径 501」给出 —— `path.startsWith('/api/admin/plugins')`
        //     且未装配时已抛 501，走不到这里；
        //   · `pluginStore` **只**在 `/api/admin/plugins*` 各端点内被解引用，所以对其它路径无副作用。
        //   ★ 教训：先前写成 IIFE 就**无条件求值**了 —— 任何 admin 请求在 `plugins`
        //     未装配时都会 500（把 401/404 全变成 500）。断言不会引入这个副作用。
        const pluginStore = plugins as NonNullable<typeof plugins>;
        // ── GET /api/admin/plugins?kind=... ──
        if (method === 'GET' && path === '/api/admin/plugins') {
          requireAdmin(request);
          const kind = request.query?.['kind'];
          const all = await pluginStore.list();
          const filtered = kind === undefined || kind.length === 0 ? all : all.filter((entry) => entry.kind === kind);
          return ok({
            plugins: filtered.map((entry) => ({
              id: entry.id,
              kind: entry.kind,
              name: entry.name,
              version: entry.version,
              runtime: entry.runtime,
              source: entry.source,
              status: entry.status,
              namespace: entry.namespace,
              signatureVerified: entry.signatureVerified,
              enabledAt: entry.enabledAt?.toISOString() ?? null,
              lastError: entry.lastError,
            })),
            total: filtered.length,
            // ★ 不可信后端却已启用 = 危险状态，显式暴露给运维
            untrustedEnabled: filtered.filter(
              (entry) =>
                entry.status === 'enabled' &&
                ((entry.runtimeState['trust'] as Record<string, { trusted?: boolean }> | undefined)?.['backend']?.trusted ?? false) !== true,
            ).map((entry) => entry.id),
          });
        }

        // ── GET /api/admin/plugins/registry（可发现的插件清单）──
        //   ★★ **必须放在 `/:id` 之前**：否则 `registry` 会被当成一个插件 id
        //     而被 `/:id` 捕获 → 返回 404「插件 'registry' 未安装」。
        //     这是路由顺序陷阱（`/plugins/registry` 与 `/plugins/:id` 形状相同）。
        // ── GET /api/admin/plugins/registry（可发现的插件清单）──
        //   ★ 与 `GET /api/admin/plugins`（已安装）不同：这里列出**宿主内置/随包发布**的插件，
        //     供运维发现「有哪些可以装」。当前实现从内置 manifest 汇总。
        if (method === 'GET' && path === '/api/admin/plugins/registry') {
          requireAdmin(request);
          const installed = new Set((await pluginStore.list()).map((entry) => entry.id));
          const builtin = deps.builtinManifests ?? [];
          return ok({
            available: builtin.map((manifest) => {
              const m = manifest as unknown as Record<string, unknown>;
              return {
                id: String(m['id']),
                name: String(m['name'] ?? m['id']),
                version: String(m['version'] ?? '0.0.0'),
                kind: String(m['kind'] ?? 'feature'),
                installed: installed.has(String(m['id'])),
              };
            }),
            total: builtin.length,
          });
        }

        // ── GET /api/admin/plugins/:id ──
        const detailMatch = /^\/api\/admin\/plugins\/([^/]+)$/.exec(path);
        if (method === 'GET' && detailMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(detailMatch[1]!);
          const record = await pluginStore.get(id);
          if (record === undefined) throw new HttpError(404, `插件 '${id}' 未安装`);
          return ok({
            plugin: {
              ...record,
              enabledAt: record.enabledAt?.toISOString() ?? null,
              installedAt: record.installedAt.toISOString(),
              updatedAt: record.updatedAt.toISOString(),
            },
          });
        }

        // ── POST /api/admin/plugins/install ──
        if (method === 'POST' && path === '/api/admin/plugins/install') {
          requireAdmin(request);
          const body = (request.body ?? {}) as { manifest?: unknown; source?: unknown; signatureVerified?: unknown };
          const manifest = body.manifest as { id?: unknown } | undefined;
          if (manifest === undefined || typeof manifest.id !== 'string' || manifest.id.length === 0) {
            throw new HttpError(400, '缺少 manifest.id');
          }
          const source = typeof body.source === 'string' ? (body.source as never) : ('uploaded' as never);

          // ★★ P1-6 接线：升级时的**向后兼容检查**（`docs/10 M6`）。
          //   ★ 为什么必须在**升级**时做：那些策略在升级前就已发布，
          //     发布侧的正向校验**不会再跑一遍** → 插件删字段后，策略「永远差这一项」，
          //     而按 H1 保持 indeterminate 时**没有人被告知为什么**。
          if (deps.policies !== undefined) {
            const { checkPluginUpgrade } = await import('../plugin/schema-compat.ts');
            const { siteId: adminSiteId } = requireAdmin(request);
            const previous = await pluginStore.get(manifest.id);
            const rejection = checkPluginUpgrade({
              previous:
                previous === undefined
                  ? undefined
                  : {
                      namespace: previous.namespace,
                      manifest: previous.manifest as { factSchema?: never },
                    },
              next: manifest as { id: string; factSchema?: never },
              // ★ 保守取舍：**草稿也纳入检查**。文档说的是「已发布策略」，
              //   但草稿随时会发布；宁可多挡一次升级，也不让策略发布后静默失效。
              // ★ 已知边界：这里只查**当前站点**。插件是平台级的、策略是站点级的，
              //   严格做法是查**全部站点**——那需要跨站点通道（见 P1-7 `crossSite`）。
              policies: await deps.policies.list(adminSiteId),
            });
            if (rejection !== null) throw new HttpError(409, rejection);
          }

          const record = await pluginStore.install({
            manifest: manifest as never,
            source,
            signatureVerified: body.signatureVerified === true,
          });
          return ok({ plugin: { id: record.id, status: record.status, digest: record.digest } });
        }

        // ── GET /api/admin/oidc/signing-keys（P1-4：密钥状态）──
        //   ★ 高危操作的前提是**看得见状态**：哪把 active、哪把 retiring、何时可退休。
        if (method === 'GET' && path === '/api/admin/oidc/signing-keys') {
          requireAdmin(request);
          if (deps.signingKeys === undefined) throw new HttpError(501, '签名密钥未装配');
          const keys = await deps.signingKeys.list();
          return ok({
            keys: keys.map((key) => ({
              kid: key.kid,
              alg: key.alg,
              status: key.status,
              activatedAt: key.activatedAt === null ? null : key.activatedAt.toISOString(),
              removeAfter: key.removeAfter === null ? null : key.removeAfter.toISOString(),
              createdAt: key.createdAt.toISOString(),
            })),
          });
        }

        // ── POST /api/admin/oidc/signing-keys/rotate（P1-4：手动触发轮换）──
        //   ★ 走**同一套判定**：不会因为"手动"就跳过「等待下游缓存过期」——
        //     否则手动轮换就成了绕过安全等待期的后门。
        if (method === 'POST' && path === '/api/admin/oidc/signing-keys/rotate') {
          requireAdmin(request);
          if (deps.signingKeys === undefined) throw new HttpError(501, '签名密钥未装配');
          const result = await deps.signingKeys.rotateOnce(new Date());
          return ok({ action: result.action, detail: result.detail });
        }

        // ── GET /api/admin/policy-assignments/cross-site（P1-5：跨站点统计）──
        //   ★ 这是 `src/core/cross-site.ts` 的**第一个真实消费方**：
        //     站点级表（策略分配）的**跨站点**读取。
        //   ★ 必须经过 `evaluateCrossSite` 判定 + 写审计——
        //     "绕过站点隔离"不能靠随手写一句不带 `site_id` 的 SQL。
        if (method === 'GET' && path === '/api/admin/policy-assignments/cross-site') {
          const { session, siteId } = requireAdmin(request);
          if (deps.policyAssignmentsCrossSite === undefined) {
            throw new HttpError(501, '跨站点分配查询未装配');
          }
          const { assertCrossSiteAllowed, evaluateCrossSite } = await import('../core/cross-site.ts');
          const decision = evaluateCrossSite({
            actor: {
              realm: session.realm,
              role: session.role,
              developerId: null,
              actorId: session.userId,
            },
            request: { reason: '管理端查看全站点灰度分配' },
          });
          // ★ 被拒即拒绝（**不静默过滤**——静默过滤会让"越权"伪装成"没有数据"）。
          //   ★ 转成 **403** 而不是让 `CrossSiteDeniedError` 冒泡成 500：
          //     "你没权限"是客户端问题，不是服务端故障。
          const auditEntry = (() => {
            try {
              return assertCrossSiteAllowed(decision);
            } catch (error) {
              throw new HttpError(403, error instanceof Error ? error.message : '跨站点访问被拒');
            }
          })();
          const assignments = await deps.policyAssignmentsCrossSite();
          await deps.audit.record({
            siteId,
            actorId: session.userId,
            actorType: 'admin',
            action: auditEntry.action,
            targetType: 'policy_assignment',
            targetId: '*',
            after: {
              reason: auditEntry.reason,
              scope: auditEntry.scope,
              count: assignments.length,
            },
          });
          return ok({
            scope: auditEntry.scope,
            reason: auditEntry.reason,
            assignments: assignments.map((assignment) => ({
              id: assignment.id,
              policyId: assignment.policyId,
              targetType: assignment.targetType,
              targetRef: assignment.targetRef ?? null,
              rolloutPercent: assignment.rolloutPercent,
              enabled: assignment.enabled,
            })),
          });
        }

        // ── POST /api/admin/plugins/packages（P1-11：上传外置插件包体）──
        //   ★ 包体落**数据库**（D9：文件系统不保证持久化）；上传后本地缓存按 digest 拉回。
        //   ★ 用 base64 传输：管理端 body 是 JSON（体积上限由 HTTP 层的 `maxBodyBytes` 限制）。
        if (method === 'POST' && path === '/api/admin/plugins/packages') {
          const { session } = requireAdmin(request);
          if (deps.pluginPackages === undefined) throw new HttpError(501, '插件包体存储未装配');
          const body = (request.body ?? {}) as {
            pluginId?: unknown;
            version?: unknown;
            contentBase64?: unknown;
            signature?: unknown;
          };
          if (typeof body.pluginId !== 'string' || body.pluginId.length === 0) {
            throw new HttpError(400, '缺少 pluginId');
          }
          if (typeof body.version !== 'string' || body.version.length === 0) {
            throw new HttpError(400, '缺少 version');
          }
          if (typeof body.contentBase64 !== 'string' || body.contentBase64.length === 0) {
            throw new HttpError(400, '缺少 contentBase64（包体的 base64 编码）');
          }
          const bytes = Buffer.from(body.contentBase64, 'base64');
          if (bytes.byteLength === 0) throw new HttpError(400, 'contentBase64 解码后为空');
          const meta = await deps.pluginPackages.put({
            pluginId: body.pluginId,
            version: body.version,
            bytes,
            ...(typeof body.signature === 'string' ? { signature: body.signature } : {}),
          });
          // ★ 上传是**高危操作**（包体后续会被解包执行）→ 必须留痕
          await deps.audit.record({
            siteId: 'platform',
            actorId: session.userId,
            actorType: 'admin',
            action: 'plugin.package_uploaded',
            targetType: 'plugin_package',
            targetId: `${meta.pluginId}@${meta.version}`,
            after: { digest: meta.digest, sizeBytes: meta.sizeBytes },
          });
          return ok({
            package: {
              pluginId: meta.pluginId,
              version: meta.version,
              digest: meta.digest,
              sizeBytes: meta.sizeBytes,
            },
          });
        }

        // ── POST /api/admin/plugins/:id/trust ──
        const trustMatch = /^\/api\/admin\/plugins\/([^/]+)\/trust$/.exec(path);
        if (method === 'POST' && trustMatch !== null) {
          const { session } = requireAdmin(request);
          const id = decodeURIComponent(trustMatch[1]!);
          const body = (request.body ?? {}) as { scope?: unknown; trusted?: unknown };
          // ★ scope 必须显式给出：后端与前端信任的风险面不同（见 governance.ts）
          if (body.scope !== 'backend' && body.scope !== 'frontend') {
            throw new HttpError(400, "scope 必须是 'backend' 或 'frontend'（两者风险面不同，不可合并）");
          }
          const updated = await pluginStore.setTrust(id, body.scope, body.trusted === true, session.userId, new Date());
          if (updated === undefined) throw new HttpError(404, `插件 '${id}' 未安装`);
          return ok({ plugin: { id: updated.id, status: updated.status, trust: updated.runtimeState['trust'] ?? {} } });
        }

        // ── GET/PUT /api/admin/plugins/:id/instances（插件实例，R105）──
        //   ★ 这是「插件自动调度」**可运维**的前提：自动调度遍历已启用的开发者级实例，
        //     而此前**没有任何端点**能创建它们（只能用代码）。
        const instancesMatch = /^\/api\/admin\/plugins\/([^/]+)\/instances$/.exec(path);
        if (instancesMatch !== null && (method === 'GET' || method === 'PUT')) {
          requireAdmin(request);
          const id = decodeURIComponent(instancesMatch[1]!);
          if (deps.pluginInstances === undefined) throw new HttpError(501, '未装配插件实例存储');

          if (method === 'GET') {
            const list = await deps.pluginInstances.listByPlugin(id);
            return ok({
              pluginId: id,
              instances: list.map((entry) => ({
                id: entry.id,
                scope: entry.scope,
                developerId: entry.developerId,
                siteId: entry.siteId,
                instanceKey: entry.instanceKey,
                label: entry.label,
                // ★ 配置里可能含密钥（如 github token）——**必须脱敏**
                config: redactSecrets(entry.config),
                enabled: entry.enabled,
              })),
              total: list.length,
            });
          }

          // PUT：保存一个开发者级实例（当前只支持 developer 级；
          //   site 级需要站点作用域，属于另一个端点的语义）
          const body = (request.body ?? {}) as { developerId?: unknown; config?: unknown; enabled?: unknown; label?: unknown };
          if (typeof body.developerId !== 'string' || body.developerId.length === 0) {
            throw new HttpError(400, '缺少 developerId（当前只支持开发者级实例）');
          }
          const developerId = requireUuid(body.developerId, 'developerId');
          if (body.config === undefined || typeof body.config !== 'object' || body.config === null) {
            throw new HttpError(400, '缺少 config 对象');
          }
          // ★ 配置哈希：用与 `PluginConfigStore` 同一算法（sha256 of canonical JSON）
          const { createHash } = await import('node:crypto');
          const configHash = createHash('sha256').update(JSON.stringify(body.config)).digest('hex').slice(0, 64);
          await deps.pluginInstances.saveDeveloperInstance({
            pluginId: id,
            developerId,
            config: body.config as Record<string, unknown>,
            configHash,
            // ★ 缺省 **不启用**（与表默认值一致：显式启用才参与自动调度）
            enabled: body.enabled === true,
            ...(typeof body.label === 'string' ? { label: body.label } : {}),
          });
          return ok({ pluginId: id, developerId, enabled: body.enabled === true, configHash });
        }

        // ── POST /api/admin/plugins/:id/collect（**手动触发一次插件采集**，P1-1）──
        //   ★ 这是「插件宿主体真的可用」的**最小验证入口**：
        //     装配 HostApi（KV/缓存/密钥/出网）→ runCollect（请求→提取→派生）→ 落事实。
        //   ★ **自动调度**（节奏与主体）留给设计决策——见
        //     `reports/architecture-gaps.md`「开发者级插件的事实记在谁名下」。
        const collectMatch = /^\/api\/admin\/plugins\/([^/]+)\/collect$/.exec(path);
        if (method === 'POST' && collectMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(collectMatch[1]!);
          if (deps.pluginRuntime === undefined) throw new HttpError(501, '未装配插件运行时编排器');
          // ★ `builtinManifests` 的元素类型是 `unknown`（历史原因）——
          //   这里只读取 `id`，因此用**窄化断言**而不是整体 `as any`。
          const manifest = deps.builtinManifests?.find((entry) => (entry as { id?: string }).id === id);
          if (manifest === undefined) {
            // ★ 只支持**内置**声明式插件（它们的清单在服务里是已知的）；
            //   外置插件的清单来自其包体，本端点暂不支持。
            throw new HttpError(404, `未找到内置插件 '${id}'（本端点只支持内置声明式插件）`);
          }
          const body = (request.body ?? {}) as { userId?: unknown };
          const userId = typeof body.userId === 'string' ? body.userId : undefined;
          if (userId === undefined) {
            // ★ 主体**必须显式给出**（P0-2 的语义：事实按主体存，不存在「平台级事实」）
            throw new HttpError(
              400,
              '缺少 userId（主体 id）——事实是**按主体**存的，不存在「平台级事实」；' +
                '★ 开发者级插件应记在谁名下仍是**待决策**的设计问题（见 reports/architecture-gaps.md）。',
            );
          }
          // ★ 真正执行：装配 HostApi（KV/缓存/密钥/出网）→ runCollect → 落事实
          const outcome = await deps.pluginRuntime.runOnce(manifest as never, { userId });
          return ok({
            pluginId: outcome.pluginId,
            ok: outcome.ok,
            // ★ 写入的事实字段（带 pluginId 前缀）
            written: outcome.written,
            status: outcome.status,
            extracted: outcome.extracted,
            error: outcome.error,
            durationMs: outcome.durationMs,
          });
        }

        // ── GET /api/admin/plugins/:id/invocations（调用记录，**站点级**）──
        //   ★★ 安全关键：本表是站点级的，查询必须带站点作用域。
        //     实现上把 `siteId` 交给查询编译器（自动注入 `site_id`，缺失则 fail-closed）。
        const invocationsMatch = /^\/api\/admin\/plugins\/([^/]+)\/invocations$/.exec(path);
        if (method === 'GET' && invocationsMatch !== null) {
          // ★ 从会话取站点（**不来自请求参数**）——「站点作用域不来自请求体」的纪律
          const { siteId } = requireAdmin(request);
          const id = decodeURIComponent(invocationsMatch[1]!);
          if (invocations === undefined) throw new HttpError(501, '未启用插件调用记录存储');
          const statusRaw = request.query?.['status'];
          const validStatuses = ['ok', 'timeout', 'error', 'denied', 'rate_limited', 'crashed'] as const;
          if (statusRaw !== undefined && statusRaw.length > 0 && !(validStatuses as readonly string[]).includes(statusRaw)) {
            throw new HttpError(400, `status 必须是 ${validStatuses.join(' / ')} 之一`);
          }
          const sinceRaw = request.query?.['sinceMs'];
          const sinceMs = sinceRaw === undefined ? undefined : Number.parseInt(sinceRaw, 10);
          if (sinceMs !== undefined && (!Number.isInteger(sinceMs) || sinceMs < 0)) {
            throw new HttpError(400, 'sinceMs 必须是非负整数（毫秒）');
          }
          const result = await invocations.list({
            siteId,
            pluginId: id,
            ...(statusRaw === undefined || statusRaw.length === 0 ? {} : { status: statusRaw as (typeof validStatuses)[number] }),
            ...(sinceMs === undefined ? {} : { sinceMs }),
            limit: clampInt(request.query?.['limit'], 50, 1, 200) + 1,
            offset: clampInt(request.query?.['offset'], 0, 0, Number.MAX_SAFE_INTEGER),
          });
          const summary = await invocations.summary({ siteId, pluginId: id, ...(sinceMs === undefined ? {} : { sinceMs }) });
          return ok({
            pluginId: id,
            // ★ 回显 siteId：让调用方确认「看到的是本站点的数据」（跨站隔离的可见证据）
            siteId,
            invocations: result.invocations.map((entry) => ({
              id: entry.id,
              op: entry.op,
              status: entry.status,
              deniedPermission: entry.deniedPermission,
              egressHost: entry.egressHost,
              durationMs: entry.durationMs,
              costTokens: entry.costTokens,
              error: entry.error,
              traceId: entry.traceId,
              createdAt: entry.createdAt.toISOString(),
            })),
            hasMore: result.hasMore,
            totalIsExact: false,
            summary,
          });
        }

        // ── GET/POST /api/admin/plugins/:id/tokens ──
        //   ★ 与协同验证调用方同一设计：**令牌只在创建时返回一次**，表里只存哈希与前缀。
        const tokensListMatch = /^\/api\/admin\/plugins\/([^/]+)\/tokens$/.exec(path);
        if (method === 'GET' && tokensListMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(tokensListMatch[1]!);
          if (pluginTokens === undefined) throw new HttpError(501, '未启用插件令牌存储');
          const list = await pluginTokens.list(id);
          const now = Date.now();
          return ok({
            pluginId: id,
            tokens: list.map((entry) => ({
              id: entry.id,
              name: entry.name,
              tokenPrefix: entry.tokenPrefix,
              scopes: entry.scopes,
              expiresAt: entry.expiresAt?.toISOString() ?? null,
              revokedAt: entry.revokedAt?.toISOString() ?? null,
              lastUsedAt: entry.lastUsedAt?.toISOString() ?? null,
              // ★ 显眼标出「已失效」（撤销或过期）——它们不该被误认为可用
              active: entry.revokedAt === null && (entry.expiresAt === null || entry.expiresAt.getTime() > now),
            })),
            total: list.length,
            activeCount: list.filter((entry) => entry.revokedAt === null && (entry.expiresAt === null || entry.expiresAt.getTime() > now)).length,
          });
        }

        if (method === 'POST' && tokensListMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(tokensListMatch[1]!);
          if (pluginTokens === undefined) throw new HttpError(501, '未启用插件令牌存储');
          const body = (request.body ?? {}) as { name?: unknown; scopes?: unknown; ttlSeconds?: unknown };
          if (typeof body.name !== 'string' || body.name.trim().length === 0) throw new HttpError(400, '缺少 name');
          if (!Array.isArray(body.scopes) || body.scopes.length === 0) throw new HttpError(400, '缺少 scopes 数组（至少一项）');
          const created = await pluginTokens.create({
            pluginId: id,
            name: body.name,
            scopes: body.scopes as string[],
            ...(typeof body.ttlSeconds === 'number' && body.ttlSeconds > 0 ? { ttlSeconds: body.ttlSeconds } : {}),
          });
          return ok({
            token: {
              id: created.token.id,
              name: created.token.name,
              tokenPrefix: created.token.tokenPrefix,
              scopes: created.token.scopes,
              expiresAt: created.token.expiresAt?.toISOString() ?? null,
            },
            // ★★ 原始令牌**只在此刻返回**，平台只保存哈希
            secret: created.secret,
            warning: '此令牌只显示这一次——平台只保存哈希，无法再次取回。请立即安全保存。',
          });
        }

        // ── DELETE /api/admin/plugins/:id/tokens/:tid（撤销，幂等）──
        const tokenRevokeMatch = /^\/api\/admin\/plugins\/([^/]+)\/tokens\/([^/]+)$/.exec(path);
        if (method === 'DELETE' && tokenRevokeMatch !== null) {
          requireAdmin(request);
          const pluginId = decodeURIComponent(tokenRevokeMatch[1]!);
          const tid = requireUuid(decodeURIComponent(tokenRevokeMatch[2]!), '令牌 id');
          if (pluginTokens === undefined) throw new HttpError(501, '未启用插件令牌存储');
          const result = await pluginTokens.revoke(pluginId, tid, new Date());
          if (result === undefined) throw new HttpError(404, `令牌 '${tid}' 不属于插件 '${pluginId}'`);
          return ok({
            token: { id: result.record.id, revokedAt: result.record.revokedAt?.toISOString() ?? null },
            // ★ 幂等：重复撤销不报错，但明确告知
            alreadyRevoked: result.alreadyRevoked,
            note: result.alreadyRevoked ? '该令牌此前已被撤销（保留首次撤销时间）' : '已撤销，该令牌立即失效',
          });
        }

        // ── GET /api/admin/plugins/:id/ui（UI 贡献清单）──
        //   ★ 安全核心：`remote-module` / `iframe` 会引入**可执行/远程内容**，
        //     未审批时不得启用（见 `ui-contribution-store.ts` 的说明）。
        if (method === 'GET' && /^\/api\/admin\/plugins\/([^/]+)\/ui$/.test(path)) {
          requireAdmin(request);
          const id = decodeURIComponent(/^\/api\/admin\/plugins\/([^/]+)\/ui$/.exec(path)![1]!);
          if (uiContributions === undefined) throw new HttpError(501, '未启用 UI 贡献存储');
          const list = await uiContributions.list(id);
          return ok({
            pluginId: id,
            contributions: list.map((entry) => ({
              id: entry.id,
              type: entry.type,
              key: entry.key,
              audience: entry.audience,
              renderMode: entry.renderMode,
              order: entry.order,
              enabled: entry.enabled,
              approved: entry.approvedBy !== null,
              // ★ 显眼标出「需要审批但尚未审批」的项——它们是最该被看的
              needsApproval: entry.approvedBy === null && requiresApproval(entry.renderMode),
            })),
            total: list.length,
            pendingApproval: list.filter((entry) => entry.approvedBy === null && requiresApproval(entry.renderMode)).length,
          });
        }

        // ── POST /api/admin/plugins/:id/ui/:uid/(approve|toggle) ──
        const uiActionMatch = /^\/api\/admin\/plugins\/([^/]+)\/ui\/([^/]+)\/(approve|toggle)$/.exec(path);
        if (method === 'POST' && uiActionMatch !== null) {
          requireAdmin(request);
          const pluginId = decodeURIComponent(uiActionMatch[1]!);
          // ★ `:uid` 是表主键（uuid）——与 `:key` 不同，必须校验
          const uid = requireUuid(decodeURIComponent(uiActionMatch[2]!), 'UI 贡献 id');
          const action = uiActionMatch[3]!;
          if (uiContributions === undefined) throw new HttpError(501, '未启用 UI 贡献存储');
          if (action === 'approve') {
            const { session } = requireAdmin(request);
            const approved = await uiContributions.approve(pluginId, uid, session.userId, new Date());
            if (approved === undefined) throw new HttpError(404, `UI 贡献 '${uid}' 不属于插件 '${pluginId}'`);
            return ok({ contribution: { id: approved.id, key: approved.key, enabled: approved.enabled, approved: true } });
          }
          const body = (request.body ?? {}) as { enabled?: unknown };
          const current = (await uiContributions.list(pluginId)).find((entry) => entry.id === uid);
          if (current === undefined) throw new HttpError(404, `UI 贡献 '${uid}' 不属于插件 '${pluginId}'`);
          const next = body.enabled === undefined ? !current.enabled : body.enabled === true;
          try {
            const updated = await uiContributions.setEnabled(pluginId, uid, next);
            return ok({ contribution: { id: updated?.id, enabled: updated?.enabled } });
          } catch (error) {
            // ★★ 未审批的远程渲染贡献被启用 → **409**（显式拒绝，而不是放行后不告诉谁）
            if (error instanceof UiApprovalRequired) throw new HttpError(409, error.message);
            throw error;
          }
        }

        // ── GET/POST/DELETE /api/admin/plugins/:id/grants ──
        //   ★ 权限模型的核心：**声明 ≠ 授予**（manifest.permissions 只是「申请」）。
        //     这里管理实际授予的集合（存在 `runtime_state.grants`）。
        // ★ 刻意拆成**两条明确的正则**，而不是一条带可选组的：
        //   `grants(?:/(.+))?` 这种形式对静态分析不友好（本项目的
        //   `tools/route-coverage.ts` 就需要额外的展开逻辑才能正确提取），
        //   而两者语义本来就不同——`GET/POST` 操作整个授权集，`DELETE` 操作单项。
        //   **让代码可被静态检查**，比让检查工具更聪明更划算。
        const grantsMatch = /^\/api\/admin\/plugins\/([^/]+)\/grants$/.exec(path);
        const grantRevokeMatch = /^\/api\/admin\/plugins\/([^/]+)\/grants\/(.+)$/.exec(path);
        const grantsId = grantsMatch !== null ? grantsMatch[1]! : grantRevokeMatch !== null ? grantRevokeMatch[1]! : undefined;
        if (grantsId !== undefined && (method === 'GET' || method === 'POST' || method === 'DELETE')) {
          requireAdmin(request);
          const id = decodeURIComponent(grantsId);
          const record = await pluginStore.get(id);
          if (record === undefined) throw new HttpError(404, `插件 '${id}' 未安装`);
          const declared = ((record.manifest as { permissions?: unknown }).permissions ?? []) as string[];
          if (grantStore === undefined) throw new HttpError(501, '未启用权限授予存储（ag_plugin_grants）');

          if (method === 'GET') {
            const grantedList = await grantStore.active(id);
            const historyList = await grantStore.history(id);
            const granted = new Set(grantedList);
            return ok({
              pluginId: id,
              declared,
              granted: [...granted].sort(),
              // ★ 声明了但未批准 = 待批准（供 UI 逐项展示）
              pending: declared.filter((permission) => !granted.has(permission)).sort(),
              // ★★ 文档 §4.3 要求「逐项、可撤销」——因此这里也给出**已撤销**的历史，
              //    运维才能回答「这个权限以前授予过吗？谁撤的？」
              revoked: historyList.filter((entry) => entry.revokedAt !== null).map((entry) => ({
                permission: entry.permission,
                grantedBy: entry.grantedBy,
                grantedAt: entry.grantedAt.toISOString(),
                revokedAt: entry.revokedAt!.toISOString(),
              })),
            });
          }

          if (method === 'POST') {
            const { session } = requireAdmin(request);
            const body = (request.body ?? {}) as { permissions?: unknown };
            const requested = Array.isArray(body.permissions) ? (body.permissions as string[]) : [];
            if (requested.length === 0) throw new HttpError(400, '缺少 permissions 数组');
            // ★★ 不得授予**未声明**的权限——否则「声明」这一步形同虚设
            const undeclared = requested.filter((permission) => !declared.includes(permission));
            if (undeclared.length > 0) {
              throw new HttpError(
                400,
                `不得授予未声明的权限：${undeclared.join(', ')}——请先更新 manifest.permissions（声明是授予的前提）`,
              );
            }
            // ★ 写入独立的 `ag_plugin_grants` 表（逐项 + 审计 + 软撤销）
            await grantStore.grant(id, requested, session.userId, new Date());
            const after = await grantStore.active(id);
            return ok({ pluginId: id, granted: after, pending: declared.filter((p) => !after.includes(p)).sort() });
          }

          // DELETE /:id/grants/:permission
          const permission = decodeURIComponent(grantRevokeMatch?.[2] ?? '');
          if (permission.length === 0) throw new HttpError(400, '缺少要撤销的权限名');
          // ★★ **软撤销**（写 revoked_at，不删行）——文档 §4.3 要求「可撤销」，
          //    而物理删除会让「这个权限曾经被授予过吗」永久无法回答。
          const revoked = await grantStore.revoke(id, permission, new Date());
          const after = await grantStore.active(id);
          return ok({
            pluginId: id,
            revoked: permission,
            revokedAt: revoked?.revokedAt?.toISOString() ?? null,
            /** ★ 已撤销的权限不再出现在 granted 里，但历史保留 */
            granted: after,
            note: revoked === undefined ? '该权限此前未授予过' : '已软撤销（历史保留，可再次授予）',
          });
        }

        // ── POST /api/admin/plugins/:id/validate（manifest 校验）──
        const validateMatch = /^\/api\/admin\/plugins\/([^/]+)\/validate$/.exec(path);
        if (method === 'POST' && validateMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(validateMatch[1]!);
          const record = await pluginStore.get(id);
          if (record === undefined) throw new HttpError(404, `插件 '${id}' 未安装`);
          const issues = checkManifest(record.manifest);
          const errors = issues.filter((issue) => issue.severity === 'error');
          return ok({
            pluginId: id,
            valid: errors.length === 0,
            errors: errors.map((issue) => ({ path: issue.path, message: issue.message })),
            warnings: issues.filter((issue) => issue.severity === 'warning').map((issue) => ({ path: issue.path, message: issue.message })),
          });
        }

        // ── DELETE /api/admin/plugins/:id/trust/:scope（撤销信任）──
        //   ★ 与 `POST /:id/trust` 同源（都走 `setTrust`），只是 REST 语义不同：
        //     POST 带 body 设置状态，DELETE 从路径表达「撤销」。
        const revokeTrustMatch = /^\/api\/admin\/plugins\/([^/]+)\/trust\/(backend|frontend)$/.exec(path);
        if (method === 'DELETE' && revokeTrustMatch !== null) {
          const { session } = requireAdmin(request);
          const id = decodeURIComponent(revokeTrustMatch[1]!);
          const scope = revokeTrustMatch[2] as 'backend' | 'frontend';
          const updated = await pluginStore.setTrust(id, scope, false, session.userId, new Date());
          if (updated === undefined) throw new HttpError(404, `插件 '${id}' 未安装`);
          return ok({ plugin: { id: updated.id, status: updated.status, trust: updated.runtimeState['trust'] ?? {} } });
        }

        // ── GET /api/admin/plugins/:id/endpoints（端点清单）──
        //   ★ 文档 §1.13.5：端点可**单独禁用**（不必禁用整个插件），
        //     且必须逐条展示给管理员（「该插件将对外暴露以下端点」）。
        const endpointsListMatch = /^\/api\/admin\/plugins\/([^/]+)\/endpoints$/.exec(path);
        if (method === 'GET' && endpointsListMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(endpointsListMatch[1]!);
          if (endpointStore === undefined) throw new HttpError(501, '未启用插件端点存储');
          const list = await endpointStore.list(id);
          return ok({
            pluginId: id,
            endpoints: list.map((entry) => ({
              id: entry.id,
              method: entry.method,
              mountPath: entry.mountPath,
              auth: entry.auth,
              visibility: entry.visibility,
              kind: entry.kind,
              enabled: entry.enabled,
              approved: entry.approvedBy !== null,
              // ★ 未审批的端点必须显眼——它们是「插件将对外暴露的攻击面」
              needsApproval: entry.approvedBy === null,
            })),
            total: list.length,
            pendingApproval: list.filter((entry) => entry.approvedBy === null).length,
          });
        }

        // ── POST /api/admin/plugins/:id/endpoints/:eid/(approve|toggle) ──
        const endpointActionMatch = /^\/api\/admin\/plugins\/([^/]+)\/endpoints\/([^/]+)\/(approve|toggle)$/.exec(path);
        if (method === 'POST' && endpointActionMatch !== null) {
          const { session } = requireAdmin(request);
          const id = decodeURIComponent(endpointActionMatch[1]!);
          const endpointId = decodeURIComponent(endpointActionMatch[2]!);
          const action = endpointActionMatch[3]!;
          if (endpointStore === undefined) throw new HttpError(501, '未启用插件端点存储');
          if (action === 'approve') {
            const updated = await endpointStore.approve(id, endpointId, session.userId, new Date());
            if (updated === undefined) throw new HttpError(404, `端点 '${endpointId}' 不属于插件 '${id}'`);
            return ok({ endpoint: { id: updated.id, approved: true, enabled: updated.enabled } });
          }
          // toggle：按当前状态翻转（显式传 enabled 则以其为准）
          const body = (request.body ?? {}) as { enabled?: unknown };
          const list = await endpointStore.list(id);
          const current = list.find((entry) => entry.id === endpointId);
          if (current === undefined) throw new HttpError(404, `端点 '${endpointId}' 不属于插件 '${id}'`);
          const next = body.enabled === undefined ? !current.enabled : body.enabled === true;
          const updated = await endpointStore.setEnabled(id, endpointId, next);
          return ok({ endpoint: { id: updated?.id, enabled: updated?.enabled } });
        }

        // ── PUT /api/admin/plugins/:id/config（写配置，版本化）──
        //   ★ 配置是**版本化**的：每次写入产生新版本并把旧版本标 archived，
        //     因此「回滚配置」= 切指针（与策略版本化同构）。
        const configPutMatch = /^\/api\/admin\/plugins\/([^/]+)\/config$/.exec(path);
        if (method === 'PUT' && configPutMatch !== null) {
          const { session } = requireAdmin(request);
          const id = decodeURIComponent(configPutMatch[1]!);
          if (configStore === undefined) throw new HttpError(501, '未启用插件配置存储');
          const record = await pluginStore.get(id);
          if (record === undefined) throw new HttpError(404, `插件 '${id}' 未安装`);
          const body = (request.body ?? {}) as { config?: unknown };
          if (body.config === undefined || typeof body.config !== 'object' || Array.isArray(body.config)) {
            throw new HttpError(400, '缺少 config 对象（数组与标量不是合法配置）');
          }
          const saved = await configStore.save(id, body.config as Record<string, unknown>, session.userId, new Date());
          return ok({ pluginId: id, version: saved.version, configHash: saved.configHash, status: saved.status });
        }

        // ── GET /api/admin/plugins/:id/config/versions（版本历史，供回滚选择）──
        const configVersionsMatch = /^\/api\/admin\/plugins\/([^/]+)\/config\/versions$/.exec(path);
        if (method === 'GET' && configVersionsMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(configVersionsMatch[1]!);
          if (configStore === undefined) throw new HttpError(501, '未启用插件配置存储');
          const history = await configStore.versions(id);
          return ok({
            pluginId: id,
            versions: history.map((entry) => ({
              version: entry.version,
              configHash: entry.configHash,
              status: entry.status,
              updatedBy: entry.updatedBy,
              createdAt: entry.createdAt.toISOString(),
              // ★ 列表里**不回传完整配置**（可能含密钥）——只给哈希供比对
            })),
            latest: history.find((entry) => entry.status === 'active')?.version ?? null,
          });
        }

        // ── GET /api/admin/plugins/:id/config（读当前配置）──
        const configGetMatch = /^\/api\/admin\/plugins\/([^/]+)\/config$/.exec(path);
        if (method === 'GET' && configGetMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(configGetMatch[1]!);
          if (configStore === undefined) throw new HttpError(501, '未启用插件配置存储');
          const latest = await configStore.latest(id);
          return ok({ pluginId: id, version: latest?.version ?? null, config: latest?.config ?? {}, configHash: latest?.configHash ?? null });
        }

        // ── GET /api/admin/plugins/:id/dependents（谁依赖我）──
        //   ★ 用于**卸载前的安全检查**：若有别的插件消费我产出的事实，卸载会破坏它们。
        const dependentsMatch = /^\/api\/admin\/plugins\/([^/]+)\/dependents$/.exec(path);
        if (method === 'GET' && dependentsMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(dependentsMatch[1]!);
          const record = await pluginStore.get(id);
          if (record === undefined) throw new HttpError(404, `插件 '${id}' 未安装`);
          const namespace = record.namespace;
          const all = await pluginStore.list();
          const dependents = all
            .filter((entry) => entry.id !== id)
            .map((entry) => {
              const consumes = ((entry.manifest as { consumes?: unknown }).consumes ?? []) as string[];
              // `consumes` 里写的是事实路径（如 `demo.pr_list`），取其命名空间部分比对
              const matched = consumes.filter((path) => path.split('.')[0] === namespace);
              return { id: entry.id, namespace: entry.namespace, status: entry.status, consumes: matched };
            })
            .filter((entry) => entry.consumes.length > 0);
          return ok({
            pluginId: id,
            namespace,
            dependents,
            // ★ 明确给出「能否安全卸载」的判断，而不是让调用方自己推
            safeToRemove: dependents.length === 0,
            note:
              dependents.length === 0
                ? '没有插件消费它产出的事实，可以卸载'
                : `有 ${dependents.length} 个插件依赖它产出的事实——直接卸载会破坏它们`,
          });
        }

        // ── POST /api/admin/plugins/:id/enable | disable ──
        const toggleMatch = /^\/api\/admin\/plugins\/([^/]+)\/(enable|disable)$/.exec(path);
        if (method === 'POST' && toggleMatch !== null) {
          requireAdmin(request);
          const id = decodeURIComponent(toggleMatch[1]!);
          const action = toggleMatch[2]!;
          if (action === 'enable') {
            // ★★ 启用前**必须**检查后端信任 —— M4-5 的验收标准：
            //    「未勾选后端信任 → enable 被拒」。后端代码能读数据、能出网，
            //    一旦跑起来风险就已经发生；前端信任不能代替它。
            const record = await pluginStore.get(id);
            if (record === undefined) throw new HttpError(404, `插件 '${id}' 未安装`);
            // ★★★ 用 `governance.canEnable()` 判定，**不再手写第二套**。
            //
            //   R67 的模块接线检查发现：`plugin/governance.ts` 里的 `canEnable()`
            //   早已实现这条判定（M4-5 的验收标准），**而我在 R22 又写了一套**：
            //     `runtimeState['trust']['backend']['trusted'] === true`
            //   ★ 两套判定语义相同，但**会漂移**——例如 `canEnable` 的
            //     `EnableDecision` 里已经预留了 `signed_required`（签名门禁），
            //     将来它一旦启用，手写的那套**不会跟着变**。
            const trust = {
              pluginId: id,
              signed: record.signatureVerified,
              backendTrusted:
                (record.runtimeState['trust'] as Record<string, { trusted?: boolean }> | undefined)?.['backend']?.trusted === true,
              backendTrustedBy: null,
              backendTrustedAt: null,
              frontendTrusted:
                (record.runtimeState['trust'] as Record<string, { trusted?: boolean }> | undefined)?.['frontend']?.trusted === true,
              frontendTrustedBy: null,
              frontendTrustedAt: null,
              enabled: record.status === 'enabled',
            };
            const decision = canEnable(trust);
            if (!decision.ok) {
              // ★ 用 `governance` 给的 message（单一事实来源），并附上本系统的操作提示
              throw new HttpError(
                403,
                `${decision.message}（请先 POST /api/admin/plugins/${id}/trust { scope: 'backend', trusted: true }）`,
              );
            }
            const updated = await pluginStore.setStatus(id, 'enabled');
            return ok({ plugin: { id: updated?.id, status: updated?.status } });
          }
          const updated = await pluginStore.setStatus(id, 'disabled');
          if (updated === undefined) throw new HttpError(404, `插件 '${id}' 未安装`);
          return ok({ plugin: { id: updated.id, status: updated.status } });
        }
      }

      // ── GET /api/admin/subjects ──
      if (method === 'GET' && path === '/api/admin/subjects') {
        const { siteId } = requireAdmin(request);
        const provider = deps.providerForSite(siteId);
        if (provider === undefined) throw new HttpError(400, `站点 ${siteId} 尚未配置主体目录（provider）`);
        const limit = clampInt(request.query?.['limit'], 50, 1, 200);
        const offset = clampInt(request.query?.['offset'], 0, 0, Number.MAX_SAFE_INTEGER);
        const includeDeleted = request.query?.['includeDeleted'] === 'true';

        const ids = await deps.subjects.listExternalIds(provider.id);
        const page = ids.slice(offset, offset + limit);
        const rows: SubjectListRow[] = [];
        for (const externalId of page) {
          const stored = await deps.subjects.get(provider.id, externalId);
          if (stored === undefined) continue;
          rows.push(toRow(stored));
        }
        // 已删除的主体单独提供（默认不列出，避免误操作）
        if (includeDeleted) {
          const all = await listAll(deps.subjects, provider.id);
          for (const stored of all) {
            if (stored.deletedAt === undefined) continue;
            if (rows.length >= limit) break;
            rows.push(toRow(stored));
          }
        }
        return ok({
          provider: provider.id,
          total: ids.length,
          limit,
          offset,
          subjects: rows,
        });
      }

      // ── POST /api/admin/identities/manual-bind ──
      if (method === 'POST' && path === '/api/admin/identities/manual-bind') {
        const { session, siteId } = requireAdmin(request);
        const body = (request.body ?? {}) as ManualBindBody;
        if (typeof body.userId !== 'string' || body.userId.length === 0) throw new HttpError(400, '缺少 userId');
        if (typeof body.externalId !== 'string' || body.externalId.length === 0) throw new HttpError(400, '缺少 externalId');

        const provider = deps.providerForSite(siteId);
        if (provider === undefined) throw new HttpError(400, `站点 ${siteId} 尚未配置主体目录（provider）`);
        const providerId = typeof body.provider === 'string' && body.provider.length > 0 ? body.provider : provider.id;

        // ★ 必须先确认下游主体存在：手工绑定指向不存在的主体，等于制造一条永远对不上的身份
        const subject = await deps.subjects.get(providerId, body.externalId);
        if (subject === undefined) {
          throw new HttpError(404, `下游主体 ${providerId}:${body.externalId} 不在本地镜像中（请先完成一次对账）`);
        }

        const identityProvider = `manual:${providerId}`;
        const before = await deps.identities.find(identityProvider, body.userId);
        await deps.identities.save({
          provider: identityProvider,
          providerUserId: body.userId,
          userId: body.userId,
          subjectRef: { provider: providerId, externalId: body.externalId },
          verifiedAt: new Date(),
          claimSnapshot: { via: 'manual', by: session.userId, ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) },
        });

        // ★ 手工绑定绕过自动对齐，必须留审计（docs/05 §1.2 第 4 行的「写审计」）
        await deps.audit.record({
          siteId,
          actorId: session.userId,
          actorType: session.realm === 'developer' ? 'developer' : 'admin',
          action: 'identity.manual_bind',
          targetType: 'identity',
          targetId: `${identityProvider}:${body.userId}`,
          ...(before === undefined ? {} : { before }),
          after: { userId: body.userId, subjectRef: { provider: providerId, externalId: body.externalId } },
        });

        return created({
          ok: true,
          bound: { userId: body.userId, provider: providerId, externalId: body.externalId },
        });
      }

      // ── GET /api/admin/policies/:code（读当前生效内容）──
      //   ★ 语义注意：`get()` 返回的是「**当前生效**」（active 优先），
      //     而「发布」要发布的是**最新草稿**（用 `latestDraft()`）。
      //     两者分开是本会话早期踩过的设计缺陷（见 PolicyStore 的注释）。
      const policyGetMatch = /^\/api\/admin\/policies\/([^/]+)$/.exec(path);
      if (method === 'GET' && policyGetMatch !== null) {
        const { siteId } = requireAdmin(request);
        const code = decodeURIComponent(policyGetMatch[1]!);
        const document = await deps.policies.get(siteId, code);
        if (document === undefined) throw new HttpError(404, `策略 '${code}' 不存在`);
        return ok({ policy: document });
      }

      // ── PUT /api/admin/policies/:code（保存草稿，**必须过静态校验**）──
      if (method === 'PUT' && policyGetMatch !== null) {
        const { siteId } = requireAdmin(request);
        const code = decodeURIComponent(policyGetMatch[1]!);
        const body = (request.body ?? {}) as { policy?: unknown };
        const candidate = body.policy;
        if (candidate === undefined || typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new HttpError(400, '缺少 policy 对象');
        }
        // ★ 路径里的 code 与 body 里的 code 必须一致——否则调用方以为改的是 A、实际写的是 B
        const documentCode = (candidate as { code?: unknown }).code;
        if (documentCode !== code) {
          throw new HttpError(400, `路径中的 code ('${code}') 与 policy.code ('${String(documentCode)}') 不一致——拒绝以免写错目标`);
        }
        // ★ 静态校验（与 POST 保存草稿同一条规则）
        // ★ 判定用 `issues.length`——`PolicyValidationResult` **没有** `ok` 字段
        //   （我最初凭直觉写了 `report.ok`，tsc 立刻报错。★ 先看现有用法再写。）
        const report = validatePolicy(candidate as PolicyDocument, deps.registry);
        if (report.issues.length > 0) {
          throw new HttpError(400, `策略静态校验未通过：${report.issues.map((issue) => issue.message).join('；')}`);
        }
        await deps.policies.saveDraft(siteId, candidate as PolicyDocument);
        return ok({ saved: true, code, version: (candidate as { version?: unknown }).version ?? null });
      }

      // ── POST /api/admin/policies/:code/validate（**只校验，不保存**）──
      const policyValidateMatch = /^\/api\/admin\/policies\/([^/]+)\/validate$/.exec(path);
      if (method === 'POST' && policyValidateMatch !== null) {
        requireAdmin(request);
        const code = decodeURIComponent(policyValidateMatch[1]!);
        const body = (request.body ?? {}) as { policy?: unknown };
        const candidate = body.policy;
        if (candidate === undefined || typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new HttpError(400, '缺少 policy 对象');
        }
        const report = validatePolicy(candidate as PolicyDocument, deps.registry);
        // ★ 与 `/plugins/:id/validate` 同语义：校验失败**不是 HTTP 错误**，
        //   而是诊断结果（调用方要的是问题清单，而不是「请求失败」）。
        // ★ `ValidationIssue` 只有 `path` / `message`（**没有** severity）——
        //   我最初多写了一个 `severity`，tsc 报错后核对类型才修正。
        return ok({
          code,
          valid: report.issues.length === 0,
          issues: report.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          // ★ 额外给出「缺哪些插件 / 哪些事实键无人产出」——比只有 message 更有可操作性
          missingPlugins: report.missingPlugins,
          unknownFacts: report.unknownFacts,
        });
      }

      // ── GET /api/admin/policies ──
      if (method === 'GET' && path === '/api/admin/policies') {
        const { siteId } = requireAdmin(request);
        return ok({ policies: await deps.policies.list(siteId) });
      }

      // ── POST /api/admin/policies（保存草稿，必须过静态校验）──
      if (method === 'POST' && path === '/api/admin/policies') {
        const { session, siteId } = requireAdmin(request);
        const document = parsePolicyBody(request.body);

        // ★ 发布前门禁（M1-9）：引用未安装插件/未知事实/未知动作一律拒绝
        const validation = validatePolicy(document, deps.registry);
        if (validation.issues.length > 0) {
          return fail(422, '策略未通过静态校验', {
            issues: validation.issues,
            missingPlugins: validation.missingPlugins,
            unknownFacts: validation.unknownFacts,
            unknownActions: validation.unknownActions,
          });
        }

        const before = await deps.policies.get(siteId, document.code);
        await deps.policies.saveDraft(siteId, document);
        await deps.audit.record({
          siteId,
          actorId: session.userId,
          actorType: session.realm === 'developer' ? 'developer' : 'admin',
          action: 'policy.save_draft',
          targetType: 'policy',
          targetId: document.code,
          ...(before === undefined ? {} : { before }),
          after: document,
        });
        return created({
          ok: true,
          code: document.code,
          inferredChannels: validation.inferredChannels,
        });
      }

      // ── POST /api/admin/policies/:code/publish ──
      const publishMatch = /^\/api\/admin\/policies\/([^/]+)\/publish$/.exec(path);
      if (method === 'POST' && publishMatch !== null) {
        const { session, siteId } = requireAdmin(request);
        const code = decodeURIComponent(publishMatch[1]!);
        const draft = await deps.policies.latestDraft(siteId, code);
        if (draft === undefined) {
          // 没有草稿：可能是「已发布且无新改动」——回落到当前内容做幂等发布
          const current = await deps.policies.get(siteId, code);
          if (current === undefined) throw new HttpError(404, `策略 '${code}' 不存在`);
        }

        const target = draft ?? (await deps.policies.get(siteId, code))!;
        // ★ 发布时**再校验一次**：草稿保存后插件可能被卸载
        const validation = validatePolicy(target, deps.registry);
        if (validation.issues.length > 0) {
          return fail(422, '发布被拒绝：策略引用的插件/事实/动作当前不可用', {
            issues: validation.issues,
            missingPlugins: validation.missingPlugins,
            unknownFacts: validation.unknownFacts,
            unknownActions: validation.unknownActions,
          });
        }

        // ★ 发布 = **激活已存在的版本**，而不是「新建一个版本」。
        //   `saveDraft` 已经分配了版本号（追加），因此这里发布的就是当前草稿的版本。
        //   早期实现传 `draft.version + 1`——那会在「草稿尚未发布」时报
        //   「没有版本 N」（因为那个版本还不存在），语义上也是错的。
        const targetVersion = target.version ?? 1;

        // 审计的 before 记「发布前生效的版本」，而不是草稿版本——两者不是一回事
        const history = (await deps.policies.versions?.(siteId, code)) ?? [];
        const activeBefore = history.find((entry) => entry.status === 'active')?.version ?? 0;

        const published = await deps.policies.publish(siteId, code, targetVersion);
        await deps.audit.record({
          siteId,
          actorId: session.userId,
          actorType: session.realm === 'developer' ? 'developer' : 'admin',
          action: 'policy.publish',
          targetType: 'policy',
          targetId: code,
          before: { version: activeBefore },
          after: { version: published.version },
        });
        return ok({ ok: true, code, version: published.version });
      }

      // ── GET /api/admin/policies/:code/versions（版本历史，供回滚选择）──
      const versionsMatch = /^\/api\/admin\/policies\/([^/]+)\/versions$/.exec(path);
      if (method === 'GET' && versionsMatch !== null) {
        const { siteId } = requireAdmin(request);
        const code = decodeURIComponent(versionsMatch[1]!);
        if (deps.policies.versions === undefined) return ok({ code, versions: [] });
        const history = await deps.policies.versions(siteId, code);
        return ok({ code, versions: history });
      }

      // ── POST /api/admin/policies/:code/rollback（回滚到历史版本，M2-7）──
      const rollbackMatch = /^\/api\/admin\/policies\/([^/]+)\/rollback$/.exec(path);
      if (method === 'POST' && rollbackMatch !== null) {
        const { session, siteId } = requireAdmin(request);
        const code = decodeURIComponent(rollbackMatch[1]!);
        const body = (request.body ?? {}) as { version?: unknown; mode?: unknown; externalId?: unknown };
        const version = typeof body.version === 'number' ? body.version : Number(body.version);
        if (!Number.isInteger(version) || version <= 0) throw new HttpError(400, '缺少合法的 version（要回滚到哪个版本）');

        // R80: rollback has THREE forms (docs/07 M6-2); only the first was implemented.
        //   pointer (default) = switch version only, no re-evaluation      -> always existed
        //   subject           = switch + re-evaluate ONE subject            -> wired this round
        //   batch             = switch + re-evaluate ALL subjects, batched  -> wired this round
        // The latter two live in core/rollback.ts and were always tested,
        // but never wired to any endpoint because RollbackDeps.buildPatrol needed
        // a capability PatrolService did not expose (added this round: buildPatrolFor).
        const modeRaw = body.mode;
        const mode = modeRaw === undefined ? 'pointer' : modeRaw;
        if (mode !== 'pointer' && mode !== 'subject' && mode !== 'batch') {
          throw new HttpError(400, `mode 必须是 pointer / subject / batch 之一（实际 ${JSON.stringify(modeRaw)}）`);
        }
        if (mode === 'subject' && (typeof body.externalId !== 'string' || body.externalId.length === 0)) {
          throw new HttpError(400, 'mode=subject 时必须提供 externalId（要对哪个主体重新求值）');
        }
        if (mode !== 'pointer' && deps.rollbackDeps === undefined) {
          throw new HttpError(501, '未装配回滚依赖（按主体 / 按策略批量回滚需要巡检能力）');
        }

        const history = (await deps.policies.versions?.(siteId, code)) ?? [];
        const activeBefore = history.find((entry) => entry.status === 'active')?.version ?? 0;

        let rolledBack: PolicyDocument;
        try {
          rolledBack = await deps.policies.rollback(siteId, code, version);
        } catch (error) {
          // 版本不存在 → 400（这是请求问题，不是服务端故障）
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }

        // ★ 按主体 / 按策略批量：在**切版本之后**复用 `core/rollback.ts` 的编排
        //   （它用新策略对主体重新求值并执行动作——与巡检**共享同一套逻辑**）。
        let reEvaluation: Record<string, unknown> | undefined;
        if (mode !== 'pointer') {
          const { rollbackForSubject, rollbackByPolicy } = await import('../core/rollback.ts');
          const target = { siteId, policyCode: code, targetVersion: version, fromVersion: activeBefore };
          const result =
            mode === 'subject'
              ? await rollbackForSubject(deps.rollbackDeps!, { ...target, externalId: body.externalId as string })
              : await rollbackByPolicy(deps.rollbackDeps!, target);
          reEvaluation = {
            subjectsProcessed: result.subjectsProcessed,
            stateChanged: result.stateChanged,
            actionsExecuted: result.actionsExecuted,
            idempotentHits: result.idempotentHits,
            failures: result.failures,
            errors: result.errors,
            durationMs: result.durationMs,
          };
        }

        await deps.audit.record({
          siteId,
          actorId: session.userId,
          actorType: session.realm === 'developer' ? 'developer' : 'admin',
          action: 'policy.rollback',
          targetType: 'policy',
          targetId: code,
          before: { version: activeBefore },
          after: { version: rolledBack.version },
        });
        return ok({
          ok: true,
          code,
          version: rolledBack.version,
          rolledBackFrom: activeBefore,
          mode,
          ...(reEvaluation === undefined ? {} : { reEvaluation }),
        });
      }

      // ── POST /api/admin/policies/:code/simulate（**按策略**试算）──
      //   ★ 复用全局 `simulate` 的同一逻辑，只是候选策略**由 `:code` 确定**：
      //     body 里给了 `policy`（未保存的草稿）就用它，否则读当前生效内容。
      //   ★ 语义要点：「这条策略如果生效会怎样」——
      //     候选是**某一条**，而不是「所有已启用策略」。
      const policySimulateMatch = /^\/api\/admin\/policies\/([^/]+)\/simulate$/.exec(path);
      if (method === 'POST' && policySimulateMatch !== null) {
        const { siteId } = requireAdmin(request);
        const code = decodeURIComponent(policySimulateMatch[1]!);
        const body = (request.body ?? {}) as { policy?: unknown; subjects?: unknown; now?: unknown };
        if (!Array.isArray(body.subjects)) throw new HttpError(400, '缺少 subjects（影响面分析必须给出主体清单）');

        // ★ 候选策略：body 里有草稿就用草稿（模拟「如果发布会怎样」）；
        //   否则读**当前生效内容**（模拟「现在的效果是什么」）。
        let candidate: PolicyDocument;
        if (body.policy !== undefined && typeof body.policy === 'object' && !Array.isArray(body.policy)) {
          candidate = body.policy as PolicyDocument;
        } else {
          const current = await deps.policies.get(siteId, code);
          if (current === undefined) throw new HttpError(404, `策略 '${code}' 不存在（也没有提供 policy 草稿）`);
          candidate = current;
        }
        const validation = validatePolicy(candidate, deps.registry);
        if (validation.issues.length > 0) {
          throw new HttpError(422, `策略 '${code}' 静态校验未通过：${validation.issues.map((issue) => issue.message).join('；')}`);
        }

        // ★ `lifecycle` 是**必填**（`SimulateOptions`）——与全局 `simulate` 保持一致：
        //   72 小时宽限期来自 M2-8 的设计（`unsatisfied` → `at_risk` 的 grace）。
        //   ★ 我最初漏了它，tsc 拦住——**先看现有调用的完整参数**能省这一步。
        const report = simulate({
          policies: [candidate],
          subjects: body.subjects as Parameters<typeof simulate>[0]['subjects'],
          lifecycle: { gracePeriodMs: 72 * 3_600_000 },
          now: typeof body.now === 'string' ? new Date(body.now) : new Date(),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        });
        return ok({ code, ...report });
      }

      // ── POST /api/admin/simulate（影响面试算）──
      if (method === 'POST' && path === '/api/admin/simulate') {
        const { siteId } = requireAdmin(request);
        const body = (request.body ?? {}) as {
          policies?: unknown;
          subjects?: unknown;
          now?: unknown;
        };
        if (!Array.isArray(body.subjects)) throw new HttpError(400, '缺少 subjects（影响面分析必须给出主体清单）');

        const now = typeof body.now === 'string' ? new Date(body.now) : new Date();
        // 候选策略：显式给出则用（试算未发布的草稿），否则用当前已启用策略
        const candidates = Array.isArray(body.policies)
          ? (body.policies as PolicyDocument[])
          : (await deps.policies.list(siteId)).filter((policy) => policy.enabled !== false);

        const validationIssues: string[] = [];
        for (const candidate of candidates) {
          const validation = validatePolicy(candidate, deps.registry);
          if (validation.issues.length > 0) validationIssues.push(`${candidate.code}: ${validation.issues.join('; ')}`);
        }

        const report = simulate({
          policies: candidates,
          subjects: body.subjects as Parameters<typeof simulate>[0]['subjects'],
          lifecycle: { gracePeriodMs: 72 * 3_600_000 },
          now,
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        });
        return ok({ ...report, validationIssues });
      }

      // ── POST /api/admin/evaluate（试算）──
      if (method === 'POST' && path === '/api/admin/evaluate') {
        const { siteId } = requireAdmin(request);
        const body = (request.body ?? {}) as {
          userId?: unknown;
          user?: unknown;
          facts?: unknown;
          now?: unknown;
        };
        if (body.user === null || typeof body.user !== 'object') throw new HttpError(400, '缺少 user（试算必须显式给出主体属性）');
        const facts = (body.facts ?? {}) as Record<string, unknown>;
        const policies = await deps.policies.list(siteId);
        const enabled = policies.filter((p) => p.enabled !== false);
        const now = typeof body.now === 'string' ? new Date(body.now) : new Date();

        const report = evaluateEligibility({
          policies: enabled,
          user: body.user as Record<string, unknown>,
          facts: { values: facts } satisfies FactSnapshot,
          now,
        });
        return ok({
          siteId,
          policies: report.results.length,
          progress: report.progress,
          todos: report.todos,
          results: report.results.map((result) => ({
            code: result.code,
            decision: result.evaluation.decision,
            summary: result.evaluation.summary,
            actions: result.evaluation.actions,
            missing: result.evaluation.missing,
            items: result.view.items,
          })),
        });
      }

        // ── GET /api/admin/audit（`docs/06:341`：审计日志）──
        //   ★★ 在此之前**审计只写不读**：数据一直在落库，却没有任何读取路径 ——
        //     出了事答不出「谁在什么时候做了什么」（`audit-scope.ts` 文件头把它定为
        //     「排障与追责」的依据），所以这个端点不是"锦上添花"。
        //   ★★ 可见性分**两步**（`docs/06`：admin 全部 / 开发者仅名下 / 终端用户仅自己）：
        //     ① `auditQueryFilterOf` → **SQL 层条件**（真实审计表很大，
        //        不能"先查全部再过滤"：既慢，又会在日志/指标里泄露可见范围之外的数据量）；
        //     ② `filterVisibleAudit` → **二次校验**。`audit-scope` 自带
        //        `auditVisibilityIsConsistent` 自检，正是为了防「列表过滤了、详情忘了」这类越权 ——
        //        所以这里两层都做，而不是信任其中一层。
        if (method === 'GET' && path === '/api/admin/audit') {
          const { session, siteId } = requireAdmin(request);
          const { auditQueryFilterOf, filterVisibleAudit } = await import('../admin/audit-scope.ts');

          const viewer = {
            userId: session.userId,
            realm: session.realm,
            role: session.role,
            developerId: session.activeDeveloperId,
            activeSiteId: siteId,
          };
          // ★ 传的是 **`viewer.developerId`**（开发者 id），**不是** `session.userId`（平台用户 id）——
          //   两者在开发者链路上通常不同；传错会让"名下站点"查成空集
          //   （fail-closed：不泄露，但功能静默失效——所以这条注释留在这里）。
          const filter = auditQueryFilterOf(viewer, {
            siteIdsOfDeveloper:
              deps.auditSiteIdsOfDeveloper === undefined || viewer.developerId === null
                ? []
                : await deps.auditSiteIdsOfDeveloper(viewer.developerId),
          });

          const q = request.query ?? {};
          const rows = await deps.audit.list({
            // ① SQL 层：**可见性**条件（不可被调用方放宽）
            siteIds: filter.siteIds,
            developerId: filter.developerId,
            realm: filter.realm,
            ...(filter.actorId === null ? {} : { actorId: filter.actorId }),
            // ② 调用方给的**额外**过滤维度（只在可见范围内收窄，不可能放宽）
            ...(typeof q['from'] === 'string' ? { from: new Date(q['from']) } : {}),
            ...(typeof q['to'] === 'string' ? { to: new Date(q['to']) } : {}),
            ...(typeof q['action'] === 'string' ? { actionPrefix: q['action'] } : {}),
            limit:
              typeof q['limit'] === 'string' && Number.isFinite(Number(q['limit']))
                ? Math.min(Math.max(Number(q['limit']), 1), 200)
                : 100,
          });

          // ② 应用层：二次校验（两层任一为假 → 都查不到）
          const visible = filterVisibleAudit(viewer, rows);
          return ok({
            audits: visible.map((record) => ({
              id: record.id,
              siteId: record.siteId,
              actorId: record.actorId,
              actorType: record.actorType,
              action: record.action,
              ...(record.targetType === undefined ? {} : { targetType: record.targetType }),
              ...(record.targetId === undefined ? {} : { targetId: record.targetId }),
              ...(record.developerId === undefined || record.developerId === null
                ? {}
                : { developerId: record.developerId }),
              ...(record.before === undefined ? {} : { before: record.before }),
              ...(record.after === undefined ? {} : { after: record.after }),
              createdAt: record.createdAt.toISOString(),
            })),
            total: visible.length,
            // ★ 把"为什么只能看到这些"回给调用方（`audit-scope` 的 description 就是为此设计的）
            visibility: filter.description,
          });
        }

        // ── 灰度**一键熔断**（`docs/07 M6-3` / `docs/05 §6.3.1`）──
        //   ★★ 这是"止血"能力：灰度出错时，运维必须能**立刻**让全部用户回到旧版本。
        //     `policy/rollout.ts` 的 `abortRollout` 早就写好了，但此前**没有任何入口**
        //     —— 函数再正确，按不到按钮也止不了血。
        //   ★ `docs/05 §6.3.1` 要求给出「**按站点分组**的受影响清单」：
        //     熔断后要能回答"这次动了哪些站点、哪些策略、谁按的"。
        if (method === 'GET' && path === '/api/admin/rollouts') {
          requireAdmin(request);
          if (deps.rolloutAborts === undefined) {
            return { status: 501, body: { error: '本部署未装配熔断状态存储（rolloutAborts）' } };
          }
          const { groupAbortsBySite } = await import('../core/rollout-abort.ts');
          const aborts = await deps.rolloutAborts.list();
          return ok({
            aborts: aborts.map((abort) => ({
              siteId: abort.siteId,
              policyId: abort.policyId,
              policyCode: abort.policyCode,
              fromVersion: abort.fromVersion,
              abortedAt: abort.abortedAt.toISOString(),
              abortedBy: abort.abortedBy,
              reason: abort.reason,
            })),
            // ★ 运维第一眼要看的就是这个：按站点分组
            affected: groupAbortsBySite(aborts).map((group) => ({
              siteId: group.siteId,
              policies: group.policies.map((policy) => ({
                ...policy,
                abortedAt: policy.abortedAt.toISOString(),
              })),
            })),
          });
        }

        if (method === 'POST' && path === '/api/admin/rollouts/abort') {
          const { session, siteId } = requireAdmin(request);
          if (deps.rolloutAborts === undefined) {
            return { status: 501, body: { error: '本部署未装配熔断状态存储（rolloutAborts）' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (typeof body['policyId'] !== 'string' || typeof body['reason'] !== 'string' || body['reason'].length === 0) {
            return { status: 400, body: { error: '缺少 policyId 或 reason（熔断必须写原因：复盘时要回答"为什么回滚"）' } };
          }
          const aborted = await deps.rolloutAborts.abort({
            siteId,
            policyId: body['policyId'],
            policyCode: typeof body['policyCode'] === 'string' ? body['policyCode'] : body['policyId'],
            fromVersion: typeof body['fromVersion'] === 'number' ? body['fromVersion'] : 0,
            by: session.userId,
            reason: body['reason'],
            at: new Date(),
          });
          // ★ 熔断是运维动作，**必须留审计**（"谁在什么时候止血、为什么"）
          await deps.audit.record({
            siteId,
            actorId: session.userId,
            actorType: 'admin',
            action: 'rollout.abort',
            targetType: 'policy',
            targetId: aborted.policyId,
            after: { policyCode: aborted.policyCode, fromVersion: aborted.fromVersion, reason: aborted.reason },
            developerId: session.activeDeveloperId,
            realm: session.realm,
          });
          const { groupAbortsBySite } = await import('../core/rollout-abort.ts');
          const affected = groupAbortsBySite(await deps.rolloutAborts.list());
          return ok({
            aborted: {
              siteId: aborted.siteId,
              policyId: aborted.policyId,
              policyCode: aborted.policyCode,
              fromVersion: aborted.fromVersion,
              abortedAt: aborted.abortedAt.toISOString(),
              abortedBy: aborted.abortedBy,
              reason: aborted.reason,
            },
            // ★ 幂等：重复熔断返回的是**首次**记录（时间与原因不被覆盖）
            affected: affected.map((group) => ({
              siteId: group.siteId,
              policies: group.policies.map((policy) => ({ ...policy, abortedAt: policy.abortedAt.toISOString() })),
            })),
          });
        }

        if (method === 'POST' && path === '/api/admin/rollouts/resume') {
          const { session, siteId } = requireAdmin(request);
          if (deps.rolloutAborts === undefined) {
            return { status: 501, body: { error: '本部署未装配熔断状态存储（rolloutAborts）' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (typeof body['policyId'] !== 'string') {
            return { status: 400, body: { error: '缺少 policyId' } };
          }
          const resumed = await deps.rolloutAborts.resume(siteId, body['policyId']);
          if (resumed) {
            await deps.audit.record({
              siteId,
              actorId: session.userId,
              actorType: 'admin',
              action: 'rollout.resume',
              targetType: 'policy',
              targetId: body['policyId'],
              developerId: session.activeDeveloperId,
              realm: session.realm,
            });
          }
          return ok({ resumed });
        }

      throw new HttpError(404, `未知端点：${method} ${path}`);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.status, error.message);
      deps.logger?.error('管理端处理异常', { error: error instanceof Error ? error.message : String(error) });
      return fail(500, '内部错误');
    }
  };

  // ★★ 根治「事务外查询」：管理端的每个请求都包在一个事务里。
  //   此前 `deps.subjects` / `deps.policies` 等 DB-backed store 被**直接调用**，
  //   而 handler 由路由层调用（不在业务事务内）→ 真实 PG 下 /api/admin/* 全部 500：
  //     「拒绝在事务外执行 query（TransactionRequiredError）」
  //   这与 Scheduler / Patrol / SessionService / 巡检是**同一类**问题的第 5、6 次出现，
  //   因此这次在**入口**统一包住，而不是逐个调用点补。
  if (deps.transaction === undefined) return handleInner;
  const tx = deps.transaction;
  return (request: HttpRequestLike) => tx(() => handleInner(request));
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

async function listAll(store: SubjectStore, provider: string): Promise<StoredSubject[]> {
  // 接口只暴露 listExternalIds + get；为列出已删除项，这里用「已知 id + get」的组合。
  // 真正的分页查询应在 M2 接入查询编译器后替换（此处不为了 demo 而伪造全量扫描能力）。
  const ids = await store.listExternalIds(provider);
  const out: StoredSubject[] = [];
  for (const id of ids) {
    const record = await store.get(provider, id);
    if (record !== undefined) out.push(record);
  }
  return out;
}

// ─────────────────────────── 内存实现（测试与本地开发） ───────────────────────────

export class InMemoryPolicyStore implements PolicyStore {
  /**
   * 版本历史：`siteId\0code` → 版本列表（按 version 升序）。
   *
   * ★ 为什么要保留历史（而不是像早期那样只存一份）：
   *   回滚（M2-7）与「历史评估可复现」都要求「v3 永远是 v3」。
   *   只存一份的实现无法表达回滚，也无法与 DB 实现（`ag_policy_versions`）
   *   保持同一语义——那样针对内存实现的测试就失去了对生产路径的参考价值。
   */
  private readonly history = new Map<string, { version: number; status: 'draft' | 'active' | 'archived'; document: PolicyDocument; createdAt: Date; specHash: string }[]>();

  private key(siteId: string, code: string): string {
    return `${siteId}\u0000${code}`;
  }

  /** 当前内容：优先 active，否则最新 draft（与 DbPolicyStore 的 list/get 语义一致） */
  private current(siteId: string, code: string): PolicyDocument | undefined {
    const list = this.history.get(this.key(siteId, code));
    if (list === undefined || list.length === 0) return undefined;
    const active = list.find((entry) => entry.status === 'active');
    const chosen = active ?? [...list].sort((a, b) => b.version - a.version)[0];
    return chosen === undefined ? undefined : { ...chosen.document, version: chosen.version };
  }

  async list(siteId: string): Promise<PolicyDocument[]> {
    const codes = new Set(
      [...this.history.keys()].filter((key) => key.startsWith(`${siteId}\u0000`)).map((key) => key.slice(siteId.length + 1)),
    );
    const out: PolicyDocument[] = [];
    for (const code of codes) {
      const document = this.current(siteId, code);
      if (document !== undefined) out.push(document);
    }
    return out.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  async get(siteId: string, code: string): Promise<PolicyDocument | undefined> {
    return this.current(siteId, code);
  }

  async latestDraft(siteId: string, code: string): Promise<PolicyDocument | undefined> {
    const list = this.history.get(this.key(siteId, code)) ?? [];
    const drafts = list.filter((entry) => entry.status === 'draft');
    if (drafts.length === 0) return undefined;
    const newest = [...drafts].sort((a, b) => b.version - a.version)[0]!;
    return { ...newest.document, version: newest.version };
  }

  async saveDraft(siteId: string, document: PolicyDocument): Promise<void> {
    const key = this.key(siteId, document.code);
    const list = this.history.get(key) ?? [];
    const next = (list.reduce((max, entry) => Math.max(max, entry.version), 0) || 0) + 1;
    list.push({
      version: next,
      status: 'draft',
      document: { ...document },
      createdAt: new Date(),
      specHash: hashPolicySpec(document.spec),
    });
    this.history.set(key, list);
  }

  async publish(siteId: string, code: string, version: number): Promise<PolicyDocument> {
    return this.#activate(siteId, code, version, 'publish');
  }

  async rollback(siteId: string, code: string, version: number): Promise<PolicyDocument> {
    return this.#activate(siteId, code, version, 'rollback');
  }

  async versions(siteId: string, code: string): Promise<{ version: number; status: string; createdAt: Date; specHash?: string }[]> {
    const list = this.history.get(this.key(siteId, code)) ?? [];
    return [...list]
      .sort((a, b) => a.version - b.version)
      .map((entry) => ({ version: entry.version, status: entry.status, createdAt: entry.createdAt, specHash: entry.specHash }));
  }

  /** 发布与回滚共用：把目标版本置 active，其余 active 转 archived。 */
  #activate(siteId: string, code: string, version: number, operation: 'publish' | 'rollback'): PolicyDocument {
    const key = this.key(siteId, code);
    const list = this.history.get(key);
    if (list === undefined || list.length === 0) throw new Error(`策略 '${code}' 不存在`);
    const target = list.find((entry) => entry.version === version);
    if (target === undefined) {
      throw new Error(`策略 '${code}' 没有版本 ${version}（可用版本：${list.map((e) => e.version).join(', ')}）`);
    }
    if (operation === 'publish' && target.status === 'active') {
      // 幂等：重复发布同一版本不报错
      return { ...target.document, version: target.version, enabled: true };
    }
    for (const entry of list) {
      if (entry.status === 'active') entry.status = 'archived';
    }
    target.status = 'active';
    return { ...target.document, version: target.version, enabled: true };
  }
}

/** 规范 AST 指纹（与 DbPolicyStore 的 spec_hash 同算法，供两实现语义一致）。 */
function hashPolicySpec(spec: unknown): string {
  const payload = stableSpecStringify(spec);
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function stableSpecStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableSpecStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSpecStringify(v)}`).join(',')}}`;
}

export class InMemoryAuditSink implements AuditSink {
  /**
   * ★ 存的是 `AuditRecord`（含 `id` / `createdAt`）——**与 PG 实现返回同样的形状**。
   *   若这里只存 `AuditEntry`，内存模式下的审计查询就会缺 `createdAt`，
   *   于是"测试通过而生产不同"（本仓库反复吃亏的形态）。
   */
  readonly entries: AuditRecord[] = [];
  #nextId = 1;
  async record(entry: AuditEntry): Promise<void> {
    const id = `mem-${this.#nextId}`;
    this.#nextId += 1;
    // ★ 归一 `undefined` → `null`：`AuditRecord.developerId` 是**必填可空**
    //   （`null` = 平台级操作；留 `undefined` 会让"平台级"与"没填"混淆）
    this.entries.push({
      ...entry,
      id,
      createdAt: new Date(),
      developerId: entry.developerId ?? null,
      realm: entry.realm ?? null,
    });
  }

  /** ★ 过滤语义与 PG 实现**对齐**（时间范围 / actor / 动作前缀 / 目标 / limit） */
  async list(query: AuditQuery): Promise<readonly AuditRecord[]> {
    const matched = this.entries.filter((record) => {
      // ★ 与 PG 实现**同一套语义**——尤其"空数组 = 查不到"这一条：
      //   若这里写成"空数组跳过"，内存模式就成了**跨租户泄露**，
      //   而 PG 模式是正确的（`inList` 空集 → FALSE）。两边必须一致。
      if (query.siteIds !== undefined && query.siteIds !== 'all') {
        if (!query.siteIds.includes(record.siteId)) return false;
      }
      if (query.developerId !== undefined) {
        if ((record.developerId ?? null) !== query.developerId) return false;
      }
      if (query.realm !== undefined && query.realm !== null && record.realm !== query.realm) {
        return false;
      }
      if (query.from !== undefined && record.createdAt.getTime() < query.from.getTime()) return false;
      if (query.to !== undefined && record.createdAt.getTime() > query.to.getTime()) return false;
      if (query.actorId !== undefined && record.actorId !== query.actorId) return false;
      if (query.actionPrefix !== undefined && !record.action.startsWith(query.actionPrefix)) return false;
      if (query.targetType !== undefined && record.targetType !== query.targetType) return false;
      if (query.targetId !== undefined && record.targetId !== query.targetId) return false;
      return true;
    });
    // ★ 与 PG 一致：**时间倒序**（最近的审计最常被查），并受 limit 约束
    const sorted = [...matched].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return sorted.slice(0, query.limit ?? 100);
  }
}

// ─────────────────────────── 便捷构造 ───────────────────────────

/** 从「下游主体」构造手工绑定时需要的引用（供测试与调用方复用）。 */
export function subjectRefOf(providerId: string, subject: ExternalSubject): { provider: string; externalId: string } {
  return { provider: providerId, externalId: subject.externalId };
}

/** 计算主体的指纹（管理端展示与对账器口径一致）。 */
export function fingerprintOf(providerId: string, subject: ExternalSubject, provider: ProviderPlugin): string {
  return subjectFingerprint(providerId, subject, watchedFields(provider.subjectSchema));
}

/** 供调用方构造会话（测试与认证中间件共用，避免各处手写字段）。 */
export function makeSession(overrides: Partial<SessionContext> & Pick<SessionContext, 'userId' | 'activeSiteId'>): SessionContext {
  return {
    username: overrides.userId,
    realm: 'developer',
    role: 'admin',
    ...overrides,
    // ★ 必须**显式归一**，且放在展开**之后**：
    //   `overrides` 是 `Partial`，缺省时 `activeDeveloperId` 是 `undefined`，
    //   而 `SessionContext` 要求 `string | null`（`null` = 未选开发者）。
    //   ★ 放在展开前会被 `overrides` 里的 `undefined` 覆盖回去 —— 这是"看起来归一了、其实没有"的经典写法。
    activeDeveloperId: overrides.activeDeveloperId ?? null,
  };
}

/** 平台用户的最小构造（试算与展示用）。 */
export function makePlatformUser(overrides: Partial<PlatformUser> & Pick<PlatformUser, 'id'>): PlatformUser {
  return {
    email: null,
    emailVerified: false,
    username: overrides.id,
    status: 'active',
    ...overrides,
  };
}
