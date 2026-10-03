/**
 * 用户两级选择：先选开发者 → 再选站点（M7-5）—— docs/08 §2、§6。
 *
 * ```
 *   用户登录后（平台级身份）
 *     ↓  第一级：选开发者
 *   列出活跃开发者
 *     ↓  第二级：选站点
 *   列出该开发者名下的活跃站点
 *     ↓
 *   会话记录 (activeDeveloperId, activeSiteId) —— 此后一切查询落在此站点作用域
 * ```
 *
 * ★ 本模块的安全要点是**归属校验**，而不是「能列出列表」：
 *   `selectContext` 必须验证「该站点确实属于该开发者」。
 *   若只校验两者各自存在，用户就能声称 `(A 开发者, B 开发者的站点)` 这种组合——
 *   而站点是**隔离边界**，归属错配意味着跨租户越权。
 *
 * ★ 第二处要点：**列表只返回活跃项**。
 *   停用的开发者/站点不应出现在选择列表里（否则用户会选中一个进不去的站点，
 *   拿到一个「看起来正常但所有请求都失败」的会话）。
 *   这与 `resolveSite` 的「停用即拒绝服务」一致——**列表与准入用同一套判据**。
 */

import type { Logger } from '../kernel/logger.ts';

import { resolveSite, type Developer, type Site, type SiteRegistry } from './sites.ts';

// ─────────────────────────── 类型 ───────────────────────────

export interface DeveloperOption {
  developerId: string;
  displayName: string;
  /** 该开发者名下**可用站点数**（0 时前端应禁用该选项，而不是让用户点进去发现是空的） */
  siteCount: number;
}

export interface SiteOption {
  siteId: string;
  nickname: string;
  /** 是否是当前会话已选中的站点 */
  selected?: boolean;
}

export type SelectionFailure =
  | 'developer_not_found'
  | 'developer_suspended'
  | 'site_not_found'
  | 'site_suspended'
  | 'site_not_owned_by_developer'
  | 'no_available_sites';

export type SelectionResult =
  | { ok: true; developer: Developer; site: Site }
  | { ok: false; reason: SelectionFailure; message: string };

export class SiteSelectionError extends Error {
  override readonly name = 'SiteSelectionError';
  readonly reason: SelectionFailure;
  constructor(reason: SelectionFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface SiteSelectionOptions {
  registry: SiteRegistry;
  logger?: Logger;
}

// ─────────────────────────── 第一级：开发者 ───────────────────────────

/**
 * 列出可选的开发者（第一级）。
 *
 * ★ 只返回**有至少一个活跃站点**的开发者：
 *   让用户点进一个空开发者再发现「没有站点可选」是糟糕的交互，
 *   而 `siteCount` 让前端可以直接禁用这类选项。
 */
export async function listDeveloperOptions(options: SiteSelectionOptions, developerIds: readonly string[]): Promise<DeveloperOption[]> {
  const out: DeveloperOption[] = [];
  for (const developerId of developerIds) {
    const developer = await options.registry.findDeveloper(developerId);
    if (developer === undefined || developer.status !== 'active') continue;
    const sites = await options.registry.listSitesOf(developerId);
    const active = sites.filter((site) => site.status === 'active');
    if (active.length === 0) continue;
    out.push({ developerId: developer.id, displayName: developer.displayName, siteCount: active.length });
  }
  // 稳定排序：按 displayName，再按 id（避免同名时顺序抖动）
  return out.sort((a, b) => {
    if (a.displayName !== b.displayName) return a.displayName < b.displayName ? -1 : 1;
    return a.developerId < b.developerId ? -1 : a.developerId > b.developerId ? 1 : 0;
  });
}

// ─────────────────────────── 第二级：站点 ───────────────────────────

/**
 * 列出某开发者名下可选的站点（第二级）。
 *
 * ★ 开发者不可用时**返回空列表**（而不是抛错）：前端在第二级页面上
 *   只需展示「无可用站点」，不必区分「开发者被停用」与「开发者没有站点」。
 */
export async function listSiteOptions(
  options: SiteSelectionOptions,
  developerId: string,
  current?: { siteId?: string | null },
): Promise<SiteOption[]> {
  const developer = await options.registry.findDeveloper(developerId);
  if (developer === undefined || developer.status !== 'active') return [];
  const sites = await options.registry.listSitesOf(developerId);
  return sites
    .filter((site) => site.status === 'active')
    .sort((a, b) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0))
    .map((site) => ({
      siteId: site.siteId,
      nickname: site.nickname,
      ...(current?.siteId === site.siteId ? { selected: true } : {}),
    }));
}

// ─────────────────────────── 选择（含归属校验） ───────────────────────────

/**
 * 完成两级选择并返回可写入会话的上下文。
 *
 * 校验顺序（**归属校验在准入校验之前**：先确认「这两个标识的关系成立」，
 * 再看「它们各自是否可用」——否则错误信息会泄露「存在这个站点」）：
 *   ① 开发者存在 → ② 站点存在 → ③ **站点属于该开发者** → ④ 两者均可用
 */
export async function selectContext(
  options: SiteSelectionOptions,
  input: { developerId: string; siteId: string },
): Promise<SelectionResult> {
  const developer = await options.registry.findDeveloper(input.developerId);
  if (developer === undefined) {
    return { ok: false, reason: 'developer_not_found', message: `开发者 '${input.developerId}' 不存在` };
  }
  const site = await options.registry.findSite(input.siteId);
  if (site === undefined) {
    return { ok: false, reason: 'site_not_found', message: `站点 '${input.siteId}' 不存在` };
  }

  // ★ 归属校验：站点是隔离边界，归属错配即跨租户越权
  if (site.developerId !== developer.id) {
    options.logger?.warn('拒绝跨开发者的站点选择', {
      claimedDeveloperId: developer.id,
      actualDeveloperId: site.developerId,
      siteId: site.siteId,
    });
    return {
      ok: false,
      reason: 'site_not_owned_by_developer',
      message: `站点 '${site.siteId}' 不属于开发者 '${developer.id}'——站点是隔离边界，不允许跨开发者选择`,
    };
  }

  // 复用 resolveSite 的准入判据（**列表与准入用同一套判据**，避免两处不一致）
  const resolution = await resolveSite(options.registry, { requestedSlug: site.siteId });
  if (!resolution.ok) {
    const reason: SelectionFailure = resolution.reason === 'developer_suspended' ? 'developer_suspended' : 'site_suspended';
    return { ok: false, reason, message: resolution.message };
  }

  options.logger?.info('用户完成两级选择', { developerId: developer.id, siteId: site.siteId });
  return { ok: true, developer: resolution.developer, site: resolution.site };
}

/**
 * 会话中的选择上下文（写入 `ag_sessions.activeDeveloperId` / `activeSiteId`）。
 *
 * ★ 单独抽出来的理由：**这是「当前站点」的唯一来源**（RLS / `SET LOCAL` 的取值依据）。
 *   若允许别处（如请求体）指定 siteId，站点隔离就形同虚设——
 *   因此会话里的这两个字段必须**只由本模块的 `selectContext` 写入**。
 */
export interface SelectionContext {
  activeDeveloperId: string;
  activeSiteId: string;
  selectedAt: Date;
}

export function toSelectionContext(result: Extract<SelectionResult, { ok: true }>, now = new Date()): SelectionContext {
  return { activeDeveloperId: result.developer.id, activeSiteId: result.site.id, selectedAt: now };
}

/**
 * 单站点（standalone）下的选择语义。
 *
 * ★ 单站点部署**不需要两级选择**：只有一个默认开发者与默认站点，
 *   平台应在登录后**自动完成选择**，让用户直接进入。
 *   这与 M7-1 的「standalone 下一切照旧」是同一条约束的两个侧面。
 */
export const STANDALONE_SELECTION_NOTE =
  '单站点部署自动选择默认开发者与默认站点，用户不感知两级选择；多站点部署才展示选择界面。';

/**
 * 需要展示两级选择界面吗？
 *
 * 判据：**可选开发者多于 1 个**。只有一个开发者时，两级选择退化为「无选择」。
 */
export async function needsSelection(options: SiteSelectionOptions, developerIds: readonly string[]): Promise<boolean> {
  const developers = await listDeveloperOptions(options, developerIds);
  if (developers.length <= 1) {
    // 只有一个开发者时，若其下有多个站点，仍需选择站点（但不需要选开发者）
    return developers.length === 1 && developers[0]!.siteCount > 1;
  }
  return true;
}
