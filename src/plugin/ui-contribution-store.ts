/**
 * 插件 UI 贡献（`ag_plugin_ui_contributions`）—— 界面注入的审批闸门。
 *
 * ★ 枚举取值**先查迁移产物**：
 *   `ag_ui_contrib_type = 'nav'|'page'|'slot'|'settings'|'adminPage'`
 *   `ag_ui_audience     = 'user'|'admin'|'both'`
 *   `ag_ui_render       = 'declarative'|'remote-module'|'iframe'`
 *
 * ★★ 安全核心：`render_mode` 决定**风险等级**
 *
 *   | render_mode | 含义 | 风险 |
 *   |---|---|---|
 *   | `declarative` | 宿主按声明式 spec 渲染 | 低（插件不能执行代码） |
 *   | `remote-module` | 加载插件的**远程 JS 模块** | **高**（等于在用户浏览器里跑插件代码） |
 *   | `iframe` | 嵌入远程页面 | **高**（第三方内容进入界面） |
 *
 *   因此本模块的规则是：**`remote-module` / `iframe` 未审批时不得启用**。
 *   `declarative` 无需审批（它不引入可执行内容）。
 *   ★ 这与「插件未获后端信任不得启用」是同一类设计（见 `governance.ts`）。
 */

import type { Db } from '../db/pool.ts';
import { randomUUID } from 'node:crypto';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { col, eq, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export type UiContribType = 'nav' | 'page' | 'slot' | 'settings' | 'adminPage';
export type UiAudience = 'user' | 'admin' | 'both';
export type UiRenderMode = 'declarative' | 'remote-module' | 'iframe';

/** ★ 需要审批的渲染模式（引入可执行/远程内容）。 */
export const RENDER_MODES_REQUIRING_APPROVAL: readonly UiRenderMode[] = ['remote-module', 'iframe'];

export function requiresApproval(renderMode: UiRenderMode): boolean {
  return RENDER_MODES_REQUIRING_APPROVAL.includes(renderMode);
}

export interface UiContributionRecord {
  id: string;
  pluginId: string;
  type: UiContribType;
  key: string;
  audience: UiAudience;
  renderMode: UiRenderMode;
  spec: Record<string, unknown>;
  order: number;
  enabled: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface RegisterUiContributionInput {
  pluginId: string;
  type: UiContribType;
  key: string;
  audience?: UiAudience;
  renderMode: UiRenderMode;
  spec?: Record<string, unknown>;
  order?: number;
}

export interface UiContributionStore {
  list(pluginId: string): Promise<UiContributionRecord[]>;
  register(input: RegisterUiContributionInput): Promise<UiContributionRecord>;
  approve(pluginId: string, id: string, by: string, at: Date): Promise<UiContributionRecord | undefined>;
  setEnabled(pluginId: string, id: string, enabled: boolean): Promise<UiContributionRecord | undefined>;
}

/** 未审批的远程渲染贡献被启用时抛出（端点层转成 409）。 */
export class UiApprovalRequired extends Error {
  override readonly name = 'UiApprovalRequired';
  constructor(pluginId: string, key: string, renderMode: UiRenderMode) {
    super(
      `UI 贡献 '${pluginId}/${key}' 的渲染模式是 '${renderMode}'——它会引入**可执行/远程内容**，` +
        `未审批不得启用。请先 POST /api/admin/plugins/${pluginId}/ui/${key}/approve`,
    );
  }
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryUiContributionStore implements UiContributionStore {
  private readonly records = new Map<string, UiContributionRecord>();
  private seq = 0;

  async list(pluginId: string): Promise<UiContributionRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.pluginId === pluginId)
      .sort((a, b) => a.order - b.order)
      .map((record) => ({ ...record }));
  }
  async register(input: RegisterUiContributionInput): Promise<UiContributionRecord> {
    const record: UiContributionRecord = {
      // ★ 同上：PG 的 `ag_plugin_ui_contributions.id` 是 uuid
      id: randomUUID(),
      pluginId: input.pluginId,
      type: input.type,
      key: input.key,
      audience: input.audience ?? 'user',
      renderMode: input.renderMode,
      spec: { ...(input.spec ?? {}) },
      order: input.order ?? 100,
      // ★ 默认启用**仅当**不需要审批——远程渲染的贡献默认不启用
      enabled: !requiresApproval(input.renderMode),
      approvedBy: null,
      approvedAt: null,
      createdAt: new Date(),
    };
    this.records.set(record.id, record);
    return { ...record };
  }
  async approve(pluginId: string, id: string, by: string, at: Date): Promise<UiContributionRecord | undefined> {
    const found = this.records.get(id);
    if (found === undefined || found.pluginId !== pluginId) return undefined;
    const next: UiContributionRecord = { ...found, approvedBy: by, approvedAt: at, enabled: true };
    this.records.set(id, next);
    return { ...next };
  }
  async setEnabled(pluginId: string, id: string, enabled: boolean): Promise<UiContributionRecord | undefined> {
    const found = this.records.get(id);
    if (found === undefined || found.pluginId !== pluginId) return undefined;
    // ★★ 启用未审批的远程渲染贡献 → **拒绝**
    if (enabled && found.approvedBy === null && requiresApproval(found.renderMode)) {
      throw new UiApprovalRequired(pluginId, found.key, found.renderMode);
    }
    const next: UiContributionRecord = { ...found, enabled };
    this.records.set(id, next);
    return { ...next };
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface UiRow extends Record<string, unknown> {
  id: string;
  plugin_id: string;
  type: string;
  key: string;
  audience: string;
  render_mode: string;
  spec: Record<string, unknown> | string;
  order: number;
  enabled: boolean;
  approved_by: string | null;
  approved_at: string | Date | null;
  created_at: string | Date;
}

const COLUMNS = ['id', 'plugin_id', 'type', 'key', 'audience', 'render_mode', 'spec', 'order', 'enabled', 'approved_by', 'approved_at', 'created_at'];

function rowToRecord(row: UiRow): UiContributionRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    type: row.type as UiContribType,
    key: row.key,
    audience: row.audience as UiAudience,
    renderMode: row.render_mode as UiRenderMode,
    spec: typeof row.spec === 'string' ? (JSON.parse(row.spec) as Record<string, unknown>) : row.spec,
    order: row.order,
    enabled: row.enabled === true,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at === null ? null : new Date(row.approved_at as string),
    createdAt: new Date(row.created_at as string),
  };
}

export class DbUiContributionStore implements UiContributionStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async list(pluginId: string): Promise<UiContributionRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_ui_contributions',
        columns: COLUMNS,
        where: eq(col('plugin_id'), lit(pluginId)),
        orderBy: [{ column: 'order', direction: 'asc' }],
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UiRow>(compiled.sql, compiled.params);
    return rows.map(rowToRecord);
  }

  async register(input: RegisterUiContributionInput): Promise<UiContributionRecord> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_plugin_ui_contributions',
        rows: [
          {
            owner_scope: 'platform',
            owner_id: 'platform',
            plugin_id: input.pluginId,
            type: input.type,
            key: input.key,
            audience: input.audience ?? 'user',
            render_mode: input.renderMode,
            spec: JSON.stringify(input.spec ?? {}),
            order: input.order ?? 100,
            // ★ 与内存实现同语义：远程渲染默认**不启用**
            enabled: !requiresApproval(input.renderMode),
          },
        ],
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UiRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) throw new Error(`注册 UI 贡献 '${input.pluginId}/${input.key}' 失败：未返回行`);
    return rowToRecord(row);
  }

  async approve(pluginId: string, id: string, by: string, at: Date): Promise<UiContributionRecord | undefined> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_plugin_ui_contributions',
        set: { approved_by: by, approved_at: at, enabled: true },
        where: eq(col('id'), lit(id)),
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UiRow>(compiled.sql, compiled.params);
    const row = rows[0];
    return row === undefined || row.plugin_id !== pluginId ? undefined : rowToRecord(row);
  }

  async setEnabled(pluginId: string, id: string, enabled: boolean): Promise<UiContributionRecord | undefined> {
    // ★ 先读后写：需要判断「未审批 + 需要审批」时拒绝启用
    const current = compile(
      { kind: 'select', table: 'ag_plugin_ui_contributions', columns: COLUMNS, where: eq(col('id'), lit(id)), limit: 1 },
      PLATFORM,
      {},
    );
    const found = await this.#db.query<UiRow>(current.sql, current.params);
    const record = found[0];
    if (record === undefined || record.plugin_id !== pluginId) return undefined;
    const mapped = rowToRecord(record);
    // ★★ 与内存实现**同语义**（否则「内存通过、真实放行」是更危险的漂移）
    if (enabled && mapped.approvedBy === null && requiresApproval(mapped.renderMode)) {
      throw new UiApprovalRequired(pluginId, mapped.key, mapped.renderMode);
    }
    const compiled = compile(
      { kind: 'update', table: 'ag_plugin_ui_contributions', set: { enabled }, where: eq(col('id'), lit(id)), returning: COLUMNS },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UiRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalUiContributionStore(db: Db): UiContributionStore {
  const inner = new DbUiContributionStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    list: (pluginId) => wrap(() => inner.list(pluginId)),
    register: (input) => wrap(() => inner.register(input)),
    approve: (pluginId, id, by, at) => wrap(() => inner.approve(pluginId, id, by, at)),
    setEnabled: (pluginId, id, enabled) => wrap(() => inner.setEnabled(pluginId, id, enabled)),
  };
}
