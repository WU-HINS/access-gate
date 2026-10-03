/**
 * 管理控制台与开发者控制台（M7-6 / M7-7）—— docs/06 §9、docs/07 M7-6/M7-7。
 *
 * ```
 *   管理控制台（admin）     总览 · 用户 · 策略 · 插件 · 协同验证 · 任务 · 审计 · 设置
 *   开发者控制台（developer）本站点策略 · 插件配置 · 主体 · 动作 · 审计
 * ```
 *
 * ★ 两个验收标准决定了本模块的形态：
 *   - M7-6：「需求清单中 admin 的每一项设置**均可用**」——分区必须**完整**；
 *   - M7-7：「开发者**无法安装插件、无法新增 OIDC**」——边界必须**可执行地强制**。
 *
 * ★ 为什么边界必须落在**能力检查**而不是 UI 隐藏：
 *   UI 隐藏只是「看不见按钮」，直接调 API 依然能装插件。
 *   因此这里把「分区 → 所需能力」做成**声明式映射**，
 *   由 `assertCanAccess` 在执行前强制——UI 展示什么只是这套能力的投影。
 *
 * ★ 为什么用「派生的能力集」而不是 `if (role === 'admin')`：
 *   硬编码角色判断会让「新增一个角色」或「给某角色单独开一个分区」变成
 *   在多处改 if-else，而漏掉任何一处就是一个越权缺口。
 *   能力集是**单一事实来源**，分区与端点都只引用它。
 */

import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── 能力 ───────────────────────────

/**
 * 控制台能力。
 *
 * 命名约定：`<资源>:<动作>[:<范围>]`。`own` 表示「仅限自己所属的站点/开发者」。
 */
export type ConsoleCapability =
  // 通用
  | 'console:access'
  // M7-6 · 仅管理员
  | 'developer:manage'          // 创建/停用开发者
  | 'site:manage:any'           // 管理任意站点
  | 'invitation:create'         // 生成开发者邀请码
  | 'oidc:manage'               // 新增/修改 OIDC 注册（★ 开发者不得有）
  | 'plugin:install'            // 安装/卸载插件（★ 开发者不得有）
  | 'user:manage'               // 管理普通用户
  | 'smtp:manage'               // 邮件配置
  | 'network:manage'            // 出站网络配置
  | 'audit:read:global'         // 全平台审计
  | 'system:read'               // 总览与健康度
  // M7-7 · 开发者（`own` 作用域）
  | 'site:manage:own'           // 本站点设置
  | 'policy:read:own'
  | 'policy:write:own'          // 本站点策略（含发布/回滚）
  | 'plugin:configure:own'      // 本站点**插件配置**（但不含安装）
  | 'subject:read:own'
  | 'action:read:own'
  | 'audit:read:own';

/** 身份（与会话的 `realm` / `role` 对齐）。 */
export interface ConsolePrincipal {
  userId: string;
  /** 会话作用域：`developer` 域可进开发者控制台；`enduser` 域不可进任何控制台 */
  realm: 'developer' | 'enduser';
  /** 开发者域内的角色：`admin` 是特权角色 */
  role: 'admin' | 'developer' | 'user';
  activeDeveloperId?: string | null;
  activeSiteId?: string | null;
}

// ─────────────────────────── 能力派生 ───────────────────────────

/** 管理员能力集（M7-6 的全部设置项）。 */
const ADMIN_CAPABILITIES: readonly ConsoleCapability[] = [
  'console:access',
  'developer:manage',
  'site:manage:any',
  'invitation:create',
  'oidc:manage',
  'plugin:install',
  'user:manage',
  'smtp:manage',
  'network:manage',
  'audit:read:global',
  'system:read',
  // 管理员也能做开发者能做的一切（本站点操作）
  'site:manage:own',
  'policy:read:own',
  'policy:write:own',
  'plugin:configure:own',
  'subject:read:own',
  'action:read:own',
  'audit:read:own',
];

/**
 * 开发者能力集（M7-7）。
 *
 * ★ 刻意**不含** `plugin:install` / `oidc:manage` / `developer:manage` /
 *   `site:manage:any` / `invitation:create` 等——
 *   这就是「开发者无法安装插件、无法新增 OIDC」的实现方式：
 *   **能力不存在**，因此任何分区/端点校验都会失败。
 */
const DEVELOPER_CAPABILITIES: readonly ConsoleCapability[] = [
  'console:access',
  'site:manage:own',
  'policy:read:own',
  'policy:write:own',
  'plugin:configure:own',
  'subject:read:own',
  'action:read:own',
  'audit:read:own',
];

/** 普通用户：**不可进控制台**（他们只有「我的空间」，见 docs/06 §9）。 */
const ENDUSER_CAPABILITIES: readonly ConsoleCapability[] = [];

/**
 * 派生某身份的能力集（**单一事实来源**）。
 *
 * 判定顺序刻意的：**先看身份域，再看角色**——
 * 一个 `enduser` 域的身份即使 `role` 字段被写成 `admin`，也不得获得管理员能力
 * （域是会话建立时确定的、更强的边界）。
 */
/**
 * ★ 预建的**只读**能力集（模块级常量）。
 *
 * 早期实现每次调用都 `new Set(...)`，而 `visibleSections()` 会对**每个分区**
 * 调用一次 `assertCanAccess()` → 每次又调一次 `capabilitiesFor()`。
 * 于是一个 `/api/console/sections` 请求要构造 **15 个 Set**（管理员集有 18 个元素）
 * ——纯属浪费，且发生在**每个管理读请求**上。
 */
const ADMIN_SET: ReadonlySet<ConsoleCapability> = new Set(ADMIN_CAPABILITIES);
const DEVELOPER_SET: ReadonlySet<ConsoleCapability> = new Set(DEVELOPER_CAPABILITIES);
const ENDUSER_SET: ReadonlySet<ConsoleCapability> = new Set(ENDUSER_CAPABILITIES);

export function capabilitiesFor(principal: ConsolePrincipal): ReadonlySet<ConsoleCapability> {
  if (principal.realm !== 'developer') return ENDUSER_SET;
  if (principal.role === 'admin') return ADMIN_SET;
  return DEVELOPER_SET;
}

export function hasCapability(principal: ConsolePrincipal, capability: ConsoleCapability): boolean {
  return capabilitiesFor(principal).has(capability);
}

// ─────────────────────────── 分区 ───────────────────────────

export type ConsoleKind = 'admin' | 'developer' | 'enduser';

export interface ConsoleSection {
  /** 稳定标识（前端路由与能力校验都用它） */
  id: string;
  /** 所属控制台 */
  console: ConsoleKind;
  title: string;
  /** 访问该分区所需的**任一**能力（空数组表示只需进入控制台） */
  requires: readonly ConsoleCapability[];
  /** 该分区是否属于 M7-6 的功能清单（用于验收「每一项设置均可用」） */
  specItem?: string;
}

/**
 * 分区清单。
 *
 * ★ M7-6 的九个 `specItem` 对应路线图原文的
 *   「开发者 / 站点 / 邀请码 / OIDC 注册 / 插件安装 / 普通用户 / SMTP / 网络 / 全局审计」——
 *   这样「每一项设置均可用」可以被机器核对（见测试）。
 */
export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  // ── 管理控制台（M7-6）──
  { id: 'admin.overview', console: 'admin', title: '总览', requires: ['system:read'], specItem: '总览' },
  { id: 'admin.developers', console: 'admin', title: '开发者', requires: ['developer:manage'], specItem: '开发者' },
  { id: 'admin.sites', console: 'admin', title: '站点', requires: ['site:manage:any'], specItem: '站点' },
  { id: 'admin.invitations', console: 'admin', title: '邀请码', requires: ['invitation:create'], specItem: '邀请码' },
  { id: 'admin.oidc', console: 'admin', title: 'OIDC 注册', requires: ['oidc:manage'], specItem: 'OIDC 注册' },
  { id: 'admin.plugins', console: 'admin', title: '插件安装', requires: ['plugin:install'], specItem: '插件安装' },
  { id: 'admin.users', console: 'admin', title: '普通用户', requires: ['user:manage'], specItem: '普通用户' },
  { id: 'admin.smtp', console: 'admin', title: '邮件（SMTP）', requires: ['smtp:manage'], specItem: 'SMTP' },
  { id: 'admin.network', console: 'admin', title: '网络', requires: ['network:manage'], specItem: '网络' },
  { id: 'admin.audit', console: 'admin', title: '全局审计', requires: ['audit:read:global'], specItem: '全局审计' },

  // ── 开发者控制台（M7-7）──
  { id: 'dev.policies', console: 'developer', title: '本站点策略', requires: ['policy:read:own', 'policy:write:own'] },
  { id: 'dev.plugin-config', console: 'developer', title: '插件配置（不可安装）', requires: ['plugin:configure:own'] },
  { id: 'dev.subjects', console: 'developer', title: '主体', requires: ['subject:read:own'] },
  { id: 'dev.actions', console: 'developer', title: '动作', requires: ['action:read:own'] },
  { id: 'dev.audit', console: 'developer', title: '审计', requires: ['audit:read:own'] },
] as const as ConsoleSection[];

/** 进入控制台本身所需的最小能力。 */
export const CONSOLE_ACCESS_CAPABILITY: ConsoleCapability = 'console:access';

// ─────────────────────────── 访问判定 ───────────────────────────

export type ConsoleDenialReason = 'no_console_access' | 'missing_capability' | 'unknown_section';

export type ConsoleAccess =
  | { ok: true; section: ConsoleSection }
  | { ok: false; status: 403 | 404; reason: ConsoleDenialReason; message: string; missing?: readonly ConsoleCapability[] };

/**
 * 判定某身份能否访问某分区。
 *
 * ★ 语义要点：
 *   - **无 `console:access`**（普通用户）→ 403「不属于控制台身份」，**不透露分区是否存在**；
 *   - 有控制台身份但缺能力 → 403，并**明确指出缺哪个能力**（便于运维排障，
 *     且这不构成信息泄露：该身份本就知道控制台有哪些分区）；
 *   - 分区不存在 → 404（与 403 区分：这是开发期的路由错误，不是权限问题）。
 */
export function assertCanAccess(principal: ConsolePrincipal, sectionId: string): ConsoleAccess {
  const capabilities = capabilitiesFor(principal);
  if (!capabilities.has(CONSOLE_ACCESS_CAPABILITY)) {
    return {
      ok: false,
      status: 403,
      reason: 'no_console_access',
      message: '当前身份不属于控制台（普通用户请使用「我的空间」）',
    };
  }
  const section = CONSOLE_SECTIONS.find((entry) => entry.id === sectionId);
  if (section === undefined) {
    return { ok: false, status: 404, reason: 'unknown_section', message: `控制台分区 '${sectionId}' 不存在` };
  }
  if (section.requires.length === 0) return { ok: true, section };
  const granted = section.requires.some((capability) => capabilities.has(capability));
  if (!granted) {
    return {
      ok: false,
      status: 403,
      reason: 'missing_capability',
      message: `无权访问「${section.title}」（缺少能力：${section.requires.join(' 或 ')}）`,
      missing: section.requires,
    };
  }
  return { ok: true, section };
}

/**
 * 该身份可见的分区（前端据此渲染导航）。
 *
 * ★ 不是「另一套权限逻辑」：它逐个调用 `assertCanAccess`，
 *   因此**导航所见与接口所判必然一致**——这正是把 UI 隐藏与权限强制统一起来的意义。
 */
export function visibleSections(principal: ConsolePrincipal, kind?: ConsoleKind): ConsoleSection[] {
  // ★ 能力集只派生一次（`assertCanAccess` 内部仍会派生，但这里是热路径：
  //   一个请求会走到这里，而它下面有 15 个分区）。
  const capabilities = capabilitiesFor(principal);
  if (!capabilities.has(CONSOLE_ACCESS_CAPABILITY)) return [];
  return CONSOLE_SECTIONS.filter((section) => {
    if (kind !== undefined && section.console !== kind) return false;
    if (section.requires.length === 0) return true;
    return section.requires.some((capability) => capabilities.has(capability));
  });
}

// ─────────────────────────── 动作级能力（端点用） ───────────────────────────

export type ConsoleAction =
  | 'install_plugin'
  | 'uninstall_plugin'
  | 'configure_plugin'
  | 'create_oidc_provider'
  | 'update_oidc_provider'
  | 'create_invitation'
  | 'create_developer'
  | 'suspend_developer'
  | 'publish_policy'
  | 'rollback_policy'
  | 'manage_users'
  | 'update_smtp'
  | 'update_network'
  | 'read_global_audit';

/** 动作 → 所需能力（**声明式**；端点只引用这张表）。 */
export const ACTION_CAPABILITY: Record<ConsoleAction, ConsoleCapability> = {
  install_plugin: 'plugin:install',
  uninstall_plugin: 'plugin:install',
  configure_plugin: 'plugin:configure:own',
  create_oidc_provider: 'oidc:manage',
  update_oidc_provider: 'oidc:manage',
  create_invitation: 'invitation:create',
  create_developer: 'developer:manage',
  suspend_developer: 'developer:manage',
  publish_policy: 'policy:write:own',
  rollback_policy: 'policy:write:own',
  manage_users: 'user:manage',
  update_smtp: 'smtp:manage',
  update_network: 'network:manage',
  read_global_audit: 'audit:read:global',
};

export type ActionAccess = { ok: true } | { ok: false; status: 403; reason: ConsoleDenialReason; message: string };

/** 判定某身份能否执行某控制台动作。 */
export function assertCanPerform(principal: ConsolePrincipal, action: ConsoleAction): ActionAccess {
  const capabilities = capabilitiesFor(principal);
  if (!capabilities.has(CONSOLE_ACCESS_CAPABILITY)) {
    return { ok: false, status: 403, reason: 'no_console_access', message: '当前身份不属于控制台' };
  }
  const required = ACTION_CAPABILITY[action];
  if (!capabilities.has(required)) {
    return {
      ok: false,
      status: 403,
      reason: 'missing_capability',
      message: `无权执行该操作（缺少能力：${required}）`,
    };
  }
  return { ok: true };
}

/** 该身份可执行的动作（供前端置灰按钮；与接口判定同源）。 */
export function allowedActions(principal: ConsolePrincipal): ConsoleAction[] {
  return (Object.keys(ACTION_CAPABILITY) as ConsoleAction[]).filter((action) => assertCanPerform(principal, action).ok);
}

// ─────────────────────────── M7-6 完整性核对 ───────────────────────────

/** 路线图 M7-6 原文列出的设置项（用于「每一项均可用」的机器核对）。 */
export const M7_6_REQUIRED_ITEMS: readonly string[] = [
  '开发者', '站点', '邀请码', 'OIDC 注册', '插件安装', '普通用户', 'SMTP', '网络', '全局审计',
];

/**
 * 核对 M7-6 的功能清单是否**全部**有对应分区。
 *
 * ★ 做成函数而不是人工检查：路线图清单是**需求**，
 *   分区清单是**实现**——两者必须能机器比对，否则「漏了一项设置」要靠人读文档发现。
 */
export function auditM7_6Coverage(): { covered: string[]; missing: string[] } {
  const declared = new Set(CONSOLE_SECTIONS.filter((section) => section.specItem !== undefined).map((section) => section.specItem!));
  const covered = M7_6_REQUIRED_ITEMS.filter((item) => declared.has(item));
  const missing = M7_6_REQUIRED_ITEMS.filter((item) => !declared.has(item));
  return { covered: [...covered], missing: [...missing] };
}

/**
 * M7-7 的边界声明（供测试与文档引用）。
 *
 * ★ 这两条是**否定式**要求（「无法安装插件、无法新增 OIDC」），
 *   因此它们的验证方式是「能力集里确实没有」+「动作判定确实返回 403」，
 *   而不是「UI 上没有按钮」。
 */
export const M7_7_FORBIDDEN_CAPABILITIES: readonly ConsoleCapability[] = ['plugin:install', 'oidc:manage'];
export const M7_7_FORBIDDEN_ACTIONS: readonly ConsoleAction[] = ['install_plugin', 'uninstall_plugin', 'create_oidc_provider', 'update_oidc_provider'];

/** 记录一次被拒的控制台访问（越权尝试必须留痕）。 */
export function logDenial(logger: Logger | undefined, principal: ConsolePrincipal, sectionId: string, access: Extract<ConsoleAccess, { ok: false }>): void {
  logger?.warn('控制台访问被拒', {
    userId: principal.userId,
    realm: principal.realm,
    role: principal.role,
    section: sectionId,
    reason: access.reason,
    ...(access.missing === undefined ? {} : { missing: access.missing }),
  });
}
