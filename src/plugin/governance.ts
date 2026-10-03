/**
 * 插件治理：权限 · 信任分级 · 配置作用域 · UI 代理 · 插件间调用
 * （M4-2 / M4-3 / M4-5 / M4-10 / M4-11）—— docs/03 §1.11、§1.13、§1.19。
 *
 * 这五项共用同一组概念（插件标识 + 权限 + 信任状态），因此放在一个模块里——
 * 拆开会让「同一件事的状态」散落多处，而**状态分散是越权缺口的温床**。
 *
 * | 项 | 验收标准（docs/07 原文） |
 * |---|---|
 * | M4-2 | 未授权调用被拒**并记 `denied`** |
 * | M4-3 | 开发者级凭据**只配一次**即被所有站点共享 |
 * | M4-5 | 未勾选后端信任 → `enable` **被拒** |
 * | M4-10 | 跨插件读数据**被拒并记审计** |
 * | M4-11 | 插件间可调用；**成环被拒** |
 *
 * ★ 三条贯穿性的设计判断：
 *
 * 1. **声明 ≠ 授予**：`manifest.permissions` 只是「申请」，实际可用的是
 *    管理员逐项批准后的集合。若把声明直接当授权，插件只要写一行
 *    `permissions: ['*']` 就拿到了全部能力——那等于没有权限模型。
 *
 * 2. **后端信任与前端信任分开确认**（M4-5）：两者风险完全不同——
 *    后端代码在宿主的进程/沙箱里跑（可读数据、可出网），
 *    前端代码在**用户的浏览器**里跑（可伪装界面、可诱导操作）。
 *    合成一个「信任」开关会让「我信任它的采集逻辑」被迫等于
 *    「我信任它在用户界面上做任何事」。
 *
 * 3. **调用链必须同时限制深度与环**（M4-11）：只限深度挡不住 A→B→A→B… 的浅环
 *    （深度 3 内就能形成循环调用），只查环挡不住 A→B→C→D→… 的长链耗尽资源。
 */

import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── M4-2 权限 ───────────────────────────

/**
 * 权限项（与 `docs/03` 的能力命名对齐）。
 *
 * 采用**封闭枚举**而不是任意字符串：开放字符串会让「拼错一个权限名」
 * 静默变成「未授权」或（更糟）「永远授权」，而编译器帮不上忙。
 */
export type PluginPermission =
  | 'http:egress'
  | 'storage:read:self'
  | 'storage:write:self'
  | 'cache:read:self'
  | 'cache:write:self'
  | 'llm:invoke'
  | 'ui:contribute:nav,page,slot'
  | 'ui:render:custom'
  | 'action:invoke'
  | 'policy:read:self'
  | 'subject:read:self'
  | 'subject:write:self'
  | 'identity:read:self'
  | 'audit:write:self'
  | 'route:register';

export interface PermissionDecision {
  allowed: boolean;
  /** 拒绝原因（写入审计的 `denied` 记录） */
  reason?: 'not_declared' | 'not_granted' | 'plugin_disabled' | 'plugin_untrusted';
  message?: string;
}

export interface GrantedPermissions {
  pluginId: string;
  /** 管理员批准后的**实际**权限集（不是 manifest 的声明） */
  granted: ReadonlySet<PluginPermission>;
  /** 声明但未批准（供 UI 展示「待批准」） */
  pending: readonly PluginPermission[];
}

/**
 * 权限集：**声明（申请）与授予（批准）分离**。
 */
export class PluginPermissionSet {
  readonly #declared: ReadonlySet<string>;
  readonly #granted: Set<PluginPermission>;

  constructor(input: { declared: readonly string[]; granted?: readonly PluginPermission[] }) {
    this.#declared = new Set(input.declared);
    this.#granted = new Set(input.granted ?? []);
  }

  /**
   * 判定某次调用是否被允许。
   *
   * ★ 顺序：**先看声明，再看授予**——这样错误信息能区分
   *   「插件没申请这个权限」（开发者的 manifest 问题）
   *   与「申请了但管理员没批」（运营问题）。混在一起会让两边互相推诿。
   */
  check(permission: PluginPermission): PermissionDecision {
    if (!this.#declared.has(permission)) {
      return {
        allowed: false,
        reason: 'not_declared',
        message: `插件未在 manifest 中声明权限 '${permission}'（请先声明再申请授予）`,
      };
    }
    if (!this.#granted.has(permission)) {
      return {
        allowed: false,
        reason: 'not_granted',
        message: `权限 '${permission}' 已声明但**尚未被管理员批准**`,
      };
    }
    return { allowed: true };
  }

  /** 逐项授予（幂等）。 */
  grant(permissions: readonly PluginPermission[]): void {
    for (const permission of permissions) {
      if (!this.#declared.has(permission)) {
        // ★ 不得授予未声明的权限：否则「声明」这一步形同虚设
        throw new Error(`不得授予未声明的权限 '${permission}'（请先更新 manifest）`);
      }
      this.#granted.add(permission);
    }
  }

  /** 撤销授予（可撤销）。 */
  revoke(permissions: readonly PluginPermission[]): void {
    for (const permission of permissions) this.#granted.delete(permission);
  }

  snapshot(): GrantedPermissions {
    const granted = [...this.#granted].sort();
    const pending = [...this.#declared].filter((permission) => !this.#granted.has(permission as PluginPermission)).sort();
    return { pluginId: '', granted: new Set(granted), pending: pending as PluginPermission[] };
  }

  grantedList(): PluginPermission[] {
    return [...this.#granted].sort();
  }
}

/** 权限拒绝的审计记录（M4-2 要求「记 `denied`」）。 */
export interface DeniedAudit {
  pluginId: string;
  permission: PluginPermission;
  reason: NonNullable<PermissionDecision['reason']>;
  operation: string;
  at: Date;
}

export function logDenied(logger: Logger | undefined, entry: DeniedAudit): void {
  // ★ 用 warn 级别：权限拒绝是**安全事件**，不该淹没在 info 里
  logger?.warn('插件权限拒绝', {
    pluginId: entry.pluginId,
    permission: entry.permission,
    reason: entry.reason,
    operation: entry.operation,
    decision: 'denied',
  });
}

// ─────────────────────────── M4-5 信任分级 ───────────────────────────

export type TrustScope = 'backend' | 'frontend';

export interface PluginTrust {
  pluginId: string;
  /** 是否已签名 / 来自官方源（已签名者默认可信，无需逐项确认） */
  signed: boolean;
  /** ★ 后端信任：独立确认 */
  backendTrusted: boolean;
  backendTrustedBy: string | null;
  backendTrustedAt: Date | null;
  /** ★ 前端信任：独立确认（风险面完全不同） */
  frontendTrusted: boolean;
  frontendTrustedBy: string | null;
  frontendTrustedAt: Date | null;
  /** 已启用（enable 的前置条件见 `canEnable`） */
  enabled: boolean;
}

export function newPluginTrust(input: { pluginId: string; signed: boolean }): PluginTrust {
  return {
    pluginId: input.pluginId,
    signed: input.signed,
    // 已签名的插件默认可信（官方源 / 分发方背书）；未签名者必须显式确认
    backendTrusted: input.signed,
    backendTrustedBy: input.signed ? 'signature' : null,
    backendTrustedAt: input.signed ? new Date(0) : null,
    frontendTrusted: input.signed,
    frontendTrustedBy: input.signed ? 'signature' : null,
    frontendTrustedAt: input.signed ? new Date(0) : null,
    enabled: false,
  };
}

/** 确认某范围的信任（可撤销——`trust` 传 false）。 */
export function setTrust(
  trust: PluginTrust,
  input: { scope: TrustScope; trusted: boolean; by: string; at: Date },
): PluginTrust {
  if (input.scope === 'backend') {
    return {
      ...trust,
      backendTrusted: input.trusted,
      backendTrustedBy: input.trusted ? input.by : null,
      backendTrustedAt: input.trusted ? input.at : null,
      // ★ 撤销后端信任时**一并停用**：否则一个「已启用的不可信插件」会继续跑
      enabled: input.trusted ? trust.enabled : false,
    };
  }
  return {
    ...trust,
    frontendTrusted: input.trusted,
    frontendTrustedBy: input.trusted ? input.by : null,
    frontendTrustedAt: input.trusted ? input.at : null,
    // 前端信任被撤销不影响后端运行（前端只是界面），但仍要停用其**前端贡献**
  };
}

export type EnableDecision = { ok: true } | { ok: false; reason: 'backend_untrusted' | 'signed_required'; message: string };

/**
 * 判定插件能否被启用。
 *
 * ★ 验收标准（M4-5 原文）：**未勾选后端信任 → `enable` 被拒**。
 *   为什么门禁在「后端」而不是「前端」：后端代码能读数据、能出网、能改状态——
 *   它一旦跑起来，风险就已经发生；前端代码最多骗到一次点击（且可被界面复核）。
 */
export function canEnable(trust: PluginTrust): EnableDecision {
  if (!trust.backendTrusted) {
    return {
      ok: false,
      reason: 'backend_untrusted',
      message:
        '插件尚未获得**后端信任**——它将在宿主的进程/沙箱中运行（可读数据、可出网、可改状态），' +
        '请先在插件详情页单独确认后端信任。',
    };
  }
  return { ok: true };
}

export function enablePlugin(trust: PluginTrust): { trust: PluginTrust; decision: EnableDecision } {
  const decision = canEnable(trust);
  if (!decision.ok) return { trust, decision };
  return { trust: { ...trust, enabled: true }, decision };
}

// ─────────────────────────── M4-3 配置作用域与实例 ───────────────────────────

export type ConfigScope = 'developer' | 'site';
export type InstanceMode = 'singleton' | 'multi';

export interface PluginConfigScope {
  scope: ConfigScope;
  instances: { mode: InstanceMode };
}

export type ConfigResolution =
  | { ok: true; configKey: string; sharedAcrossSites: boolean; note: string }
  | { ok: false; reason: 'instance_required' | 'instance_forbidden'; message: string };

/**
 * 解析配置落到哪个键上（M4-3）。
 *
 * ★ 验收标准：「**开发者级凭据只配一次即被所有站点共享**」。
 *   这正是 `scope: 'developer'` 的语义——配置键里**不含 siteId**。
 *   若把 developer 级配置也按站点存，运维就得在每个站点重复配一遍凭据
 *   （漏配一个站点就是一次故障）。
 */
export function resolveConfigKey(
  input: { pluginId: string; developerId: string; siteId: string; instanceKey?: string },
  declared: PluginConfigScope,
): ConfigResolution {
  if (declared.instances.mode === 'multi' && (input.instanceKey === undefined || input.instanceKey.length === 0)) {
    return { ok: false, reason: 'instance_required', message: `插件声明为 multi，配置必须指明 @instanceKey` };
  }
  if (declared.instances.mode === 'singleton' && input.instanceKey !== undefined && input.instanceKey.length > 0) {
    return { ok: false, reason: 'instance_forbidden', message: `插件声明为 singleton，配置不得带 @instanceKey` };
  }
  const instance = input.instanceKey === undefined ? 'default' : input.instanceKey;
  if (declared.scope === 'developer') {
    // ★ 键里**不含 siteId** → 所有站点共享同一份
    return {
      ok: true,
      configKey: `developer:${input.developerId}:${input.pluginId}:${instance}`,
      sharedAcrossSites: true,
      note: '开发者级配置：该开发者名下所有站点共享同一份（凭据只配一次）',
    };
  }
  return {
    ok: true,
    configKey: `site:${input.siteId}:${input.pluginId}:${instance}`,
    sharedAcrossSites: false,
    note: '站点级配置：每个站点各自一份',
  };
}

// ─────────────────────────── M4-10 UI 数据代理 ───────────────────────────

export interface ApprovedEndpoint {
  pluginId: string;
  method: string;
  path: string;
}

export type ProxyDecision = { ok: true } | { ok: false; reason: 'cross_plugin' | 'not_approved' | 'plugin_untrusted'; message: string };

/**
 * UI 数据代理判定（M4-10）。
 *
 * ★ 验收标准：「跨插件读数据**被拒并记审计**」。
 *   插件页面发起的请求必须经宿主，且**只能访问本插件已批准的端点**——
 *   否则一个插件的前端代码就能读到任何其它插件的数据
 *   （包括它没有权限碰的主体信息）。
 */
export function authorizeProxyRequest(
  input: { requestingPluginId: string; targetPluginId: string; method: string; path: string },
  approved: readonly ApprovedEndpoint[],
  trust?: PluginTrust,
): ProxyDecision {
  if (input.requestingPluginId !== input.targetPluginId) {
    return {
      ok: false,
      reason: 'cross_plugin',
      message: `插件 '${input.requestingPluginId}' 不得通过 UI 代理访问插件 '${input.targetPluginId}' 的数据（跨插件读数据需走显式的插件间调用与权限）`,
    };
  }
  if (trust !== undefined && trust.enabled && !trust.frontendTrusted) {
    return { ok: false, reason: 'plugin_untrusted', message: '该插件的前端信任已被撤销，其页面数据请求被拒' };
  }
  const method = input.method.toUpperCase();
  const matched = approved.some((endpoint) => endpoint.pluginId === input.targetPluginId && endpoint.method === method && endpoint.path === input.path);
  if (!matched) {
    return {
      ok: false,
      reason: 'not_approved',
      message: `'${method} ${input.path}' 不在插件 '${input.targetPluginId}' 的已批准端点列表中`,
    };
  }
  return { ok: true };
}

// ─────────────────────────── M4-11 插件间调用 ───────────────────────────

/**
 * 调用链上下文（不可变）。
 *
 * ★ 同时限制**深度**与**环**（见文件头的说明）。
 */
export class PluginCallChain {
  readonly stack: readonly string[];
  readonly maxDepth: number;

  constructor(stack: readonly string[] = [], maxDepth = 3) {
    this.stack = [...stack];
    this.maxDepth = maxDepth;
  }

  get depth(): number {
    return this.stack.length;
  }

  /**
   * 尝试进入下一次调用（返回新链，不修改自身）。
   *
   * 拒绝的两种情况各自给**可操作**的信息：环要指出环路径，深度要指出上限。
   */
  enter(target: string): { ok: true; chain: PluginCallChain } | { ok: false; reason: 'cycle' | 'depth_exceeded'; message: string } {
    if (this.stack.includes(target)) {
      const cycle = [...this.stack.slice(this.stack.indexOf(target)), target];
      return {
        ok: false,
        reason: 'cycle',
        message: `检测到插件调用环：${cycle.join(' → ')}（环会让调用永不返回，必须拒绝）`,
      };
    }
    if (this.depth >= this.maxDepth) {
      return {
        ok: false,
        reason: 'depth_exceeded',
        message: `插件调用链已达深度上限 ${this.maxDepth}（当前：${this.stack.join(' → ')}）——过长的链会耗尽资源且难以排障`,
      };
    }
    return { ok: true, chain: new PluginCallChain([...this.stack, target], this.maxDepth) };
  }
}

export type ActionInvokeDecision =
  | { ok: true; chain: PluginCallChain }
  | { ok: false; reason: 'cycle' | 'depth_exceeded' | 'not_granted' | 'target_unknown'; message: string };

/**
 * 插件间动作调用判定（M4-11）。
 *
 * ★ 验收标准包含两条：「签到插件能调 `newapi-add-quota:add_quota`」（能调）
 *   与「**成环被拒**」（不能乱调）。因此本函数先查权限、再进链——
 *   顺序很关键：先查权限能让「没权限」的错误信息更直接（不必先过环/深度检查）。
 */
export function authorizeActionInvoke(
  input: {
    chain: PluginCallChain;
    /** 调用方插件的权限集 */
    permissions: PluginPermissionSet;
    /** 目标动作名（`<pluginId>:<actionName>`） */
    action: string;
    /** 宿主已知的动作集合（用于区分「未授权」与「根本不存在」） */
    knownActions: readonly string[];
  },
): ActionInvokeDecision {
  const targetPluginId = input.action.split(':')[0] ?? input.action;
  if (!input.knownActions.includes(input.action)) {
    return { ok: false, reason: 'target_unknown', message: `动作 '${input.action}' 未注册（请检查插件是否已安装且已启用）` };
  }
  const permission = input.permissions.check('action:invoke');
  if (!permission.allowed) {
    return { ok: false, reason: 'not_granted', message: `${permission.message}（调用 '${input.action}'）` };
  }
  const entered = input.chain.enter(targetPluginId);
  if (!entered.ok) return { ok: false, reason: entered.reason, message: entered.message };
  return { ok: true, chain: entered.chain };
}

/**
 * 调用链的审计记录（谁调了谁、多深）——排障时这是第一手材料。
 */
export interface InvokeAudit {
  from: string;
  to: string;
  action: string;
  chain: readonly string[];
  at: Date;
}

export function logInvoke(logger: Logger | undefined, entry: InvokeAudit): void {
  logger?.info('插件间动作调用', {
    from: entry.from,
    to: entry.to,
    action: entry.action,
    depth: entry.chain.length,
    chain: entry.chain.join(' → '),
  });
}
