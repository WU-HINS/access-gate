/**
 * UI 贡献宿主（M4-8）—— docs/03 §1.17。
 *
 * ★ 核心约束（文档原话）：**插件注册 nav/page/slot 不改前端代码**。
 *   前端只做一件事：拉 `GET /api/ui/manifest` 并按 `type` 渲染。
 *   因此「加一个导航项」对前端来说是**数据变化**，不是代码变化。
 *
 * ★ 逐条审批是本模块最重要的安全设计：
 *   若不审批，插件装上就能往用户界面塞任意入口（钓鱼链接、伪装按钮）。
 *   因此每条贡献独立记录 `approvedBy` / `approvedAt`，
 *   **未批准的贡献一律不出现在 `/api/ui/manifest`**——而不是「出现但标记为未批准」
 *   （那等于把「是否展示」的决定权交给了前端，而前端是不可信的执行环境）。
 *
 * ★ 表结构说明（核对 `migrations/0001_init.sql` 所得，非凭想象）：
 *   `ag_plugin_ui_contributions` 的列是
 *   `owner_scope / owner_id / plugin_id / type / key / audience / render_mode / spec /
 *    enabled / approved_by / approved_at`——**没有 `site_id`**，属 `ownerScope` 表。
 */

import type { Logger } from '../kernel/logger.ts';
import type { PluginManifest } from './manifest.ts';

// ─────────────────────────── 类型 ───────────────────────────

export type UiContributionType = 'nav' | 'page' | 'slot';
export type UiAudience = 'user' | 'developer' | 'admin';
export type UiRenderMode = 'declarative' | 'custom';

export interface UiContribution {
  pluginId: string;
  type: UiContributionType;
  /** 插件内唯一键（nav 的 id / page 的 path / slot 的 name） */
  key: string;
  audience: UiAudience;
  renderMode: UiRenderMode;
  /** 声明原文（nav 项 / page 定义 / slot 定义） */
  spec: Record<string, unknown>;
  enabled: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface UiIssue {
  pluginId: string;
  type: string;
  key: string;
  code: 'missing_permission' | 'invalid_audience' | 'missing_key' | 'key_conflict' | 'custom_render_not_allowed' | 'bad_spec';
  message: string;
  severity: 'error' | 'warning';
}

export class UiContributionError extends Error {
  override readonly name = 'UiContributionError';
  constructor(message: string) {
    super(message);
  }
}

// ─────────────────────────── 声明解析 ───────────────────────────

/** 文档要求：`ui:contribute:nav,page,slot` 形式的能力声明。 */
export function uiContributionPermissionsOf(manifest: PluginManifest): Set<UiContributionType> {
  const permissions = ((manifest as { permissions?: unknown }).permissions ?? []) as string[];
  const granted = new Set<UiContributionType>();
  for (const permission of permissions) {
    if (!permission.startsWith('ui:contribute:')) continue;
    for (const part of permission.slice('ui:contribute:'.length).split(',')) {
      const trimmed = part.trim() as UiContributionType;
      if (trimmed === 'nav' || trimmed === 'page' || trimmed === 'slot') granted.add(trimmed);
    }
  }
  return granted;
}

/**
 * 从 manifest 提取贡献条目。
 *
 * 返回 **全部问题**而不是抛第一个——插件开发时「修一个报一个」体验极差。
 */
export function parseUiContributions(
  manifest: PluginManifest,
  options: { now?: Date } = {},
): { contributions: UiContribution[]; issues: UiIssue[] } {
  const now = options.now ?? new Date();
  const granted = uiContributionPermissionsOf(manifest);
  const issues: UiIssue[] = [];
  const contributions: UiContribution[] = [];
  const ui = (manifest as { ui?: Record<string, unknown> }).ui;
  if (ui === undefined || ui === null) return { contributions, issues };

  const push = (
    type: UiContributionType,
    key: string,
    spec: Record<string, unknown>,
    audience: unknown,
    renderMode: UiRenderMode,
  ): void => {
    if (key.length === 0) {
      issues.push({ pluginId: manifest.id, type, key, code: 'missing_key', message: `${type} 贡献缺少标识（${type === 'nav' ? 'id' : type === 'page' ? 'path' : 'name'}）`, severity: 'error' });
      return;
    }
    if (!['user', 'developer', 'admin'].includes(String(audience))) {
      issues.push({
        pluginId: manifest.id,
        type,
        key,
        code: 'invalid_audience',
        message: `audience 只能是 user / developer / admin（实际 '${String(audience)}'）`,
        severity: 'error',
      });
      return;
    }
    if (!granted.has(type)) {
      issues.push({
        pluginId: manifest.id,
        type,
        key,
        code: 'missing_permission',
        message: `声明了 ${type} 贡献但缺少权限 'ui:contribute:${type}'（已声明：${[...granted].join(', ') || '（无）'}）`,
        severity: 'error',
      });
      return;
    }
    if (renderMode === 'custom' && !((manifest as { permissions?: unknown }).permissions as string[] | undefined)?.includes('ui:render:custom')) {
      issues.push({
        pluginId: manifest.id,
        type,
        key,
        code: 'custom_render_not_allowed',
        message: "renderMode=custom 需要 'ui:render:custom' 权限（自定义渲染会执行插件提供的前端代码）",
        severity: 'error',
      });
      return;
    }
    contributions.push({
      pluginId: manifest.id,
      type,
      key,
      audience: audience as UiAudience,
      renderMode,
      spec,
      // ★ 新贡献**默认未批准**；管理员逐条批准后才进 manifest
      enabled: true,
      approvedBy: null,
      approvedAt: null,
      createdAt: now,
    });
  };

  const nav = ui['nav'];
  if (Array.isArray(nav)) {
    for (const item of nav) {
      const record = (item ?? {}) as Record<string, unknown>;
      push('nav', String(record['id'] ?? ''), record, record['audience'] ?? 'user', (record['renderMode'] as UiRenderMode) ?? 'declarative');
    }
  }
  const pages = ui['pages'];
  if (Array.isArray(pages)) {
    for (const item of pages) {
      const record = (item ?? {}) as Record<string, unknown>;
      push('page', String(record['path'] ?? ''), record, record['audience'] ?? 'user', (record['renderMode'] as UiRenderMode) ?? 'declarative');
    }
  }
  const slot = ui['slot'] ?? ui['slots'];
  if (Array.isArray(slot)) {
    for (const item of slot) {
      const record = (item ?? {}) as Record<string, unknown>;
      push('slot', String(record['name'] ?? ''), record, record['audience'] ?? 'user', (record['renderMode'] as UiRenderMode) ?? 'declarative');
    }
  }

  return { contributions, issues };
}

// ─────────────────────────── 存储 ───────────────────────────

export interface UiContributionStore {
  save(contribution: UiContribution): Promise<void>;
  list(): Promise<UiContribution[]>;
  /** 审批（逐条） */
  approve(pluginId: string, type: UiContributionType, key: string, approvedBy: string, at: Date): Promise<void>;
  /** 启用/禁用（不改变审批状态） */
  setEnabled(pluginId: string, type: UiContributionType, key: string, enabled: boolean): Promise<void>;
  /** 卸载插件时移除其全部贡献 */
  removePlugin(pluginId: string): Promise<number>;
}

export class InMemoryUiContributionStore implements UiContributionStore {
  private readonly entries = new Map<string, UiContribution>();
  #key(pluginId: string, type: UiContributionType, key: string): string {
    return `${pluginId}\u0000${type}\u0000${key}`;
  }
  async save(contribution: UiContribution): Promise<void> {
    this.entries.set(this.#key(contribution.pluginId, contribution.type, contribution.key), { ...contribution });
  }
  async list(): Promise<UiContribution[]> {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }
  async approve(pluginId: string, type: UiContributionType, key: string, approvedBy: string, at: Date): Promise<void> {
    const found = this.entries.get(this.#key(pluginId, type, key));
    if (found === undefined) throw new UiContributionError(`UI 贡献不存在：${pluginId}/${type}/${key}`);
    this.entries.set(this.#key(pluginId, type, key), { ...found, approvedBy, approvedAt: at });
  }
  async setEnabled(pluginId: string, type: UiContributionType, key: string, enabled: boolean): Promise<void> {
    const found = this.entries.get(this.#key(pluginId, type, key));
    if (found === undefined) throw new UiContributionError(`UI 贡献不存在：${pluginId}/${type}/${key}`);
    this.entries.set(this.#key(pluginId, type, key), { ...found, enabled });
  }
  async removePlugin(pluginId: string): Promise<number> {
    let removed = 0;
    for (const [mapKey, entry] of [...this.entries]) {
      if (entry.pluginId === pluginId) {
        this.entries.delete(mapKey);
        removed += 1;
      }
    }
    return removed;
  }
}

// ─────────────────────────── 聚合输出 ───────────────────────────

export interface UiManifest {
  /** 已批准且启用的导航项（按 order 排序） */
  nav: Record<string, unknown>[];
  /** 已批准且启用的页面 */
  pages: Record<string, unknown>[];
  /** 已批准且启用的插槽 */
  slots: Record<string, unknown>[];
  /** 生成时间（便于前端缓存失效判断） */
  generatedAt: string;
  /** 未批准的贡献数（供管理端提示「有 N 条待审批」） */
  pendingApproval: number;
}

export interface UiHostOptions {
  store: UiContributionStore;
  logger?: Logger;
  now?: () => Date;
}

/**
 * UI 贡献宿主。
 *
 * 职责有三：
 *   1. **注册**（`register`）：解析 manifest.ui，做冲突与权限校验；
 *   2. **审批**（`approve` / `reject`）：管理员逐条批准；
 *   3. **聚合**（`manifest`）：输出前端可直接渲染的 `/api/ui/manifest`。
 */
export class UiContributionHost {
  private readonly options: UiHostOptions;
  private readonly logger: Logger | undefined;
  private readonly now: () => Date;

  constructor(options: UiHostOptions) {
    this.options = options;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 注册一个插件的全部 UI 贡献。
   *
   * ★ 与端点宿主一致：校验不通过时**整体拒绝**（不做部分注册——
   *   否则插件的可用贡献取决于声明顺序，极难排查）。
   */
  async register(manifest: PluginManifest): Promise<{ ok: true; registered: UiContribution[]; pendingApproval: number } | { ok: false; issues: UiIssue[] }> {
    const { contributions, issues } = parseUiContributions(manifest, { now: this.now() });

    // 与**已注册**的贡献做冲突检测（同一 type+key 只能属一个插件）
    const existing = await this.options.store.list();
    const taken = new Map(existing.map((entry) => [`${entry.type}\u0000${entry.key}`, entry.pluginId]));
    for (const contribution of contributions) {
      const owner = taken.get(`${contribution.type}\u0000${contribution.key}`);
      if (owner !== undefined && owner !== manifest.id) {
        issues.push({
          pluginId: manifest.id,
          type: contribution.type,
          key: contribution.key,
          code: 'key_conflict',
          message: `${contribution.type} '${contribution.key}' 已被插件 '${owner}' 占用`,
          severity: 'error',
        });
      }
    }

    // 同一插件内重复 key 也要拦（否则「谁生效」取决于声明顺序）
    const seen = new Set<string>();
    for (const contribution of contributions) {
      const composite = `${contribution.type}\u0000${contribution.key}`;
      if (seen.has(composite)) {
        issues.push({
          pluginId: manifest.id,
          type: contribution.type,
          key: contribution.key,
          code: 'key_conflict',
          message: `${contribution.type} '${contribution.key}' 在同一插件的 manifest 里重复声明`,
          severity: 'error',
        });
      }
      seen.add(composite);
    }

    if (issues.some((issue) => issue.severity === 'error')) return { ok: false, issues };

    for (const contribution of contributions) await this.options.store.save(contribution);
    const pendingApproval = contributions.filter((entry) => entry.approvedBy === null).length;
    this.logger?.info('插件 UI 贡献已注册（待审批）', {
      pluginId: manifest.id,
      total: contributions.length,
      pendingApproval,
    });
    return { ok: true, registered: contributions, pendingApproval };
  }

  async approve(pluginId: string, type: UiContributionType, key: string, approvedBy: string): Promise<void> {
    await this.options.store.approve(pluginId, type, key, approvedBy, this.now());
    this.logger?.info('UI 贡献已批准', { pluginId, type, key, approvedBy });
  }

  async setEnabled(pluginId: string, type: UiContributionType, key: string, enabled: boolean): Promise<void> {
    await this.options.store.setEnabled(pluginId, type, key, enabled);
  }

  async unregister(pluginId: string): Promise<number> {
    return this.options.store.removePlugin(pluginId);
  }

  /** 待审批列表（管理端用）。 */
  async pending(): Promise<UiContribution[]> {
    return (await this.options.store.list()).filter((entry) => entry.approvedBy === null);
  }

  /** 全部贡献（管理端用，含未批准）。 */
  async all(): Promise<UiContribution[]> {
    return this.options.store.list();
  }

  /**
   * 生成 `/api/ui/manifest` 的响应体。
   *
   * ★ 三重过滤，缺一不可：
   *   ① **已批准**（`approvedBy !== null`）——未批准的不出现；
   *   ② **已启用**（`enabled`）——管理员可临时下线某条贡献；
   *   ③ **audience** 匹配当前访问者（可选）——不把 admin 入口暴露给普通用户。
   */
  async manifest(options: { audience?: UiAudience } = {}): Promise<UiManifest> {
    const all = await this.options.store.list();
    const visible = all.filter((entry) => entry.approvedBy !== null && entry.enabled);
    const filtered = options.audience === undefined ? visible : visible.filter((entry) => entry.audience === options.audience);

    const byType = (type: UiContributionType): Record<string, unknown>[] =>
      filtered
        .filter((entry) => entry.type === type)
        .sort((a, b) => {
          // nav 用声明的 order 排序（缺省 100）；同 order 按 pluginId + key 保证**稳定**
          const orderOf = (entry: UiContribution): number => {
            const raw = entry.spec['order'];
            return typeof raw === 'number' ? raw : 100;
          };
          const diff = orderOf(a) - orderOf(b);
          if (diff !== 0) return diff;
          if (a.pluginId !== b.pluginId) return a.pluginId < b.pluginId ? -1 : 1;
          return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        })
        .map((entry) => ({ ...entry.spec, pluginId: entry.pluginId, renderMode: entry.renderMode }));

    return {
      nav: byType('nav'),
      pages: byType('page'),
      slots: byType('slot'),
      generatedAt: this.now().toISOString(),
      pendingApproval: all.filter((entry) => entry.approvedBy === null).length,
    };
  }
}
