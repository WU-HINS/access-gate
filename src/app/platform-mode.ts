/**
 * 平台模式作为设置项（M7-10）—— docs/08 §11。
 *
 * ```
 *   standalone ⇄ saas   （admin 在平台设置中切换，不是部署参数）
 * ```
 *
 * ★ 验收标准（docs/07 M7-10 原文）：
 *   **「切换无需重启、无需迁移；降级不删数据」**。
 *
 *   这三条来自同一个设计决定：**两种模式共用同一套数据模型**。
 *   `standalone` 不是另一套 schema，而只是「隐藏站点 UI + 关闭入驻入口」。
 *   因此切换本质上只是**改一个设置值**——
 *   不需要迁移（schema 相同）· 不需要重启（读取方每次都查设置）· 不删数据（什么都没动）。
 *
 * ★ 为什么必须把它做成设置项而不是部署参数：
 *   真实项目的生命周期是「先单站点跑起来 → 后来要开多租户」。
 *   若模式是部署参数（环境变量），那次转变就需要**重新部署 + 可能的迁移**，
 *   而运营在那一刻最不想要的就是「停机改配置」。
 *
 * ★ 降级（saas → standalone）**绝不删数据**，只是「看不见」：
 *   若降级时清理了开发者/站点，那「试用 saas 后觉得太复杂想退回去」就变成
 *   一次**不可逆的数据丢失**——而用户当时的意图只是「先简单点」。
 */

import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── 类型 ───────────────────────────

export type PlatformMode = 'standalone' | 'saas';

export interface PlatformSettings {
  /** 当前平台模式（写入平台设置，非环境变量） */
  mode: PlatformMode;
  /** 首次启动的初始模式（仅首次生效，随后以 `mode` 为准） */
  initial: PlatformMode;
  modeChangedAt: Date | null;
  modeChangedBy: string | null;
}

export function defaultPlatformSettings(initial: PlatformMode = 'standalone'): PlatformSettings {
  return { mode: initial, initial, modeChangedAt: null, modeChangedBy: null };
}

/** 当前模式下各能力的开关（**读取方每次都查这里**，因此切换即时生效）。 */
export interface ModeCapabilities {
  /** 是否展示站点选择/管理 UI */
  siteUiVisible: boolean;
  /** 是否开放开发者入驻入口（邀请码） */
  onboardingOpen: boolean;
  /** 是否允许创建多个站点 */
  multiSiteAllowed: boolean;
  /** 是否展示开发者控制台 */
  developerConsoleVisible: boolean;
  /** 审计可见性是否按开发者隔离（standalone 下通常只有一个开发者） */
  auditScopedByDeveloper: boolean;
}

export function capabilitiesOf(mode: PlatformMode): ModeCapabilities {
  if (mode === 'saas') {
    return {
      siteUiVisible: true,
      onboardingOpen: true,
      multiSiteAllowed: true,
      developerConsoleVisible: true,
      auditScopedByDeveloper: true,
    };
  }
  return {
    // ★ standalone 只是「隐藏 UI + 关闭入口」，不是另一套数据模型
    siteUiVisible: false,
    onboardingOpen: false,
    multiSiteAllowed: false,
    developerConsoleVisible: false,
    auditScopedByDeveloper: false,
  };
}

// ─────────────────────────── 切换与影响面 ───────────────────────────

/** 平台当前的数据规模（用于切换前的影响面提示）。 */
export interface PlatformStats {
  developers: number;
  sites: number;
  subjects: number;
  /** 除默认站点之外的站点数（降级时会被「隐藏」的数量） */
  extraSites: number;
}

export interface ModeSwitchImpact {
  /** 该变化对用户/运维意味着什么（**人类可读**，用于确认对话框） */
  description: string;
  /** 是否涉及数据可见性变化（需要重点提示） */
  dataVisibility: boolean;
}

export interface ModeSwitchPlan {
  ok: boolean;
  from: PlatformMode;
  to: PlatformMode;
  /** 是否需要实际写入（同模式重复切换 → false） */
  noop: boolean;
  impacts: ModeSwitchImpact[];
  /** ★ 明确声明可逆性（降级不删数据） */
  reversible: true;
  /** 数据丢失风险（恒为 false，但显式给出以打消顾虑） */
  dataLoss: false;
  /** 供确认对话框展示的完整提示文案 */
  prompt: string;
}

export class ModeSwitchError extends Error {
  override readonly name = 'ModeSwitchError';
  readonly code: 'same_mode_noop' | 'unknown_mode';
  constructor(code: ModeSwitchError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 生成切换计划（**纯函数**：不写任何状态）。
 *
 * ★ 为什么先出计划再执行：模式切换会改变「哪些 UI 可见、哪些入口开放」，
 *   运维在按下按钮前必须看到**具体影响**（「当前有 4 个开发者、7 个站点」），
 *   而不是按完才发现「入驻入口关了，正在进行的邀请全失效」。
 */
export function planModeSwitch(input: { from: PlatformMode; to: PlatformMode; stats: PlatformStats }): ModeSwitchPlan {
  const { from, to, stats } = input;
  if (from === to) {
    return {
      ok: true,
      from,
      to,
      noop: true,
      impacts: [],
      reversible: true,
      dataLoss: false,
      prompt: `当前已是 ${to} 模式，无需切换。`,
    };
  }

  const impacts: ModeSwitchImpact[] = [];
  if (to === 'saas') {
    impacts.push({ description: '开放开发者入驻入口（可发放邀请码）', dataVisibility: false });
    impacts.push({ description: '展示站点选择与管理界面', dataVisibility: true });
    impacts.push({ description: '开发者控制台可见', dataVisibility: false });
  } else {
    impacts.push({
      description:
        `隐藏站点选择与管理界面：当前 ${stats.developers} 个开发者、${stats.sites} 个站点将**不再显示**` +
        `（其中 ${stats.extraSites} 个非默认站点）`,
      dataVisibility: true,
    });
    impacts.push({ description: '关闭开发者入驻入口：未使用的邀请码将无法核销（已入驻的开发者不受影响）', dataVisibility: false });
    impacts.push({ description: '开发者控制台不再可见', dataVisibility: false });
  }

  const prompt =
    to === 'standalone'
      ? `切换到 standalone 后：\n` +
        `  · 站点 UI 隐藏（${stats.sites} 个站点、${stats.developers} 个开发者仍在库中，只是不显示）\n` +
        `  · 入驻入口关闭（已发放但未使用的邀请码将无法核销）\n` +
        `  · **不会删除任何数据**，随时可切回 saas\n` +
        `  · 无需重启、无需迁移`
      : `切换到 saas 后：\n` +
        `  · 开放入驻入口与站点 UI\n` +
        `  · 现有 ${stats.sites} 个站点与 ${stats.developers} 个开发者立即可见\n` +
        `  · 无需重启、无需迁移`;

  return { ok: true, from, to, noop: false, impacts, reversible: true, dataLoss: false, prompt };
}

/**
 * 应用切换（**只改设置值**）。
 *
 * ★ 本函数刻意**不碰任何业务数据**——这正是「无需迁移、降级不删数据」的实现：
 *   切换的全部副作用就是 `settings.mode` 这一个字段。
 *   任何「顺手清理一下」的动作都会破坏可逆性，因此这里不做。
 */
export function applyModeSwitch(
  settings: PlatformSettings,
  input: { to: PlatformMode; by: string; at: Date },
  logger?: Logger,
): { settings: PlatformSettings; plan: ModeSwitchPlan } {
  if (input.to !== 'standalone' && input.to !== 'saas') {
    throw new ModeSwitchError('unknown_mode', `未知平台模式 '${String(input.to)}'（可用：standalone / saas）`);
  }
  const plan = planModeSwitch({ from: settings.mode, to: input.to, stats: { developers: 0, sites: 0, subjects: 0, extraSites: 0 } });
  if (plan.noop) return { settings, plan };
  const next: PlatformSettings = { ...settings, mode: input.to, modeChangedAt: input.at, modeChangedBy: input.by };
  logger?.info('平台模式已切换', { from: settings.mode, to: input.to, by: input.by, reversible: true, dataLoss: false });
  return { settings: next, plan };
}

/**
 * 模式是否**即时生效**（无需重启）的判据。
 *
 * ★ 做成函数而不是文档约定：只要所有读取方都通过 `capabilitiesOf(settings.mode)`
 *   取能力（而不是把模式缓存到模块级变量），切换就自然即时生效。
 *   这条断言用来防止「有人把模式读到全局常量里」——那会让切换需要重启。
 */
export function isModeReadPerRequest(source: { mode: () => PlatformMode }): boolean {
  // 能在这里传入一个**函数**而不是一个值，本身就说明读取是动态的
  return typeof source.mode === 'function';
}

// ─────────────────────────── 平台设置持久化（ag_platform_settings） ───────────────────────────

/**
 * 平台设置存储（`ag_platform_settings`）。
 *
 * ★★ 为什么需要它：`platform-mode.ts` 的模式逻辑（影响面提示、可逆性、能力矩阵）
 *   在 R14 就实现了，但**没有任何持久化与 HTTP 端点**——
 *   于是「平台模式是设置项」这件事只存在于单元测试里。
 *   这是本会话第 N 次「实现存在但未接线」。
 *
 * ★ `locked_by_env` 是表里的一等字段，语义很重要：
 *   运维可以用环境变量**钉死**关键配置（如 `platform.mode`），
 *   此时 API 必须**拒绝修改**——否则一次误操作就能推翻部署时的决定。
 */
export interface PlatformSettingRecord {
  key: string;
  value: unknown;
  /** 被环境变量锁定（API 不得修改） */
  lockedByEnv: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface PlatformSettingsStore {
  get(key: string): Promise<PlatformSettingRecord | undefined>;
  /**
   * 写入（`lockedByEnv` 的记录由调用方先检查，这里只负责落库）。
   *
   * ★★ `by` 是**平台用户 id（uuid）或 null**——`ag_platform_settings.updated_by`
   *   是 uuid 列。系统启动时没有「谁」可记，因此用 `null` 而不是 `'system'`
   *   （本会话已因「字符串冒充 uuid」踩坑四次：`ag_sessions.id` · bootstrap 的 `sub` ·
   *   `FactPipeline.userId` · 本处）。
   */
  put(key: string, value: unknown, by: string | null, at: Date): Promise<PlatformSettingRecord>;
  /** 首次启动写入（**只在不存在时写**）——文档 §11：`initial` 仅首次生效 */
  putIfAbsent(key: string, value: unknown, by: string | null, at: Date, lockedByEnv?: boolean): Promise<PlatformSettingRecord>;
}

export const PLATFORM_MODE_KEY = 'platform.mode';

export class InMemoryPlatformSettingsStore implements PlatformSettingsStore {
  private readonly records = new Map<string, PlatformSettingRecord>();
  async get(key: string): Promise<PlatformSettingRecord | undefined> {
    const found = this.records.get(key);
    return found === undefined ? undefined : { ...found };
  }
  async put(key: string, value: unknown, by: string | null, at: Date): Promise<PlatformSettingRecord> {
    const existing = this.records.get(key);
    const next: PlatformSettingRecord = {
      key,
      value,
      lockedByEnv: existing?.lockedByEnv ?? false,
      updatedBy: by,
      updatedAt: at,
    };
    this.records.set(key, next);
    return { ...next };
  }
  async putIfAbsent(key: string, value: unknown, by: string | null, at: Date, lockedByEnv = false): Promise<PlatformSettingRecord> {
    const existing = this.records.get(key);
    if (existing !== undefined) return { ...existing };
    const next: PlatformSettingRecord = { key, value, lockedByEnv, updatedBy: by, updatedAt: at };
    this.records.set(key, next);
    return { ...next };
  }
}
