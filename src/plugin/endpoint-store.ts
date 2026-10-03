/**
 * 插件端点注册表（`ag_plugin_endpoints`）—— 生产落地的 P0。
 *
 * ★★ 本表的两处关键设计（都对应文档 §1.13.5 的宿主职责）：
 *
 * 1. **路由冲突检测**：`uq_ag_plugin_endpoints_route (owner_scope, owner_id, method, mount_path)`
 *    —— 两个插件**不得注册同一 `method + path`**。冲突时 PG 抛唯一约束错误，
 *    本模块把它转成**可读的冲突说明**（而不是把 PG 的原始错误抛给调用方）。
 *
 * 2. **`owner_scope` + `owner_id` 必填**（无默认值）：端点归属于「平台 / 开发者 / 站点 / 用户」
 *    某一级。这是站点作用域门禁（R2 规则）的一部分——
 *    缺了它，一个站点的端点会与另一个站点的撞车。
 *
 * ★ 枚举取值**先查迁移产物**：
 *   `ag_owner_scope = 'platform'|'developer'|'site'|'user'`
 *   `ag_endpoint_auth = 'none'|'hmac'|'pluginToken'|'session'|'admin'`
 *   `ag_endpoint_kind = 'handler'|'webhook'`
 */

import type { Db } from '../db/pool.ts';
import { randomUUID } from 'node:crypto';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { inspectPath } from './endpoints.ts';
import { col, eq, lit } from '../query/ast.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export type EndpointAuth = 'none' | 'hmac' | 'pluginToken' | 'session' | 'admin';
export type EndpointVisibility = 'public' | 'authenticated' | 'admin';
export type EndpointKind = 'handler' | 'webhook';
export type OwnerScope = 'platform' | 'developer' | 'site' | 'user';

export interface PluginEndpointRecord {
  id: string;
  pluginId: string;
  ownerScope: OwnerScope;
  ownerId: string;
  method: string;
  path: string;
  mountPath: string;
  auth: EndpointAuth;
  visibility: EndpointVisibility;
  kind: EndpointKind;
  /** 是否已启用（管理员可单独禁用某个端点，不必禁用整个插件） */
  enabled: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface RegisterEndpointInput {
  pluginId: string;
  method: string;
  path: string;
  mountPath: string;
  auth: EndpointAuth;
  visibility?: EndpointVisibility;
  kind?: EndpointKind;
  ownerScope?: OwnerScope;
  ownerId?: string;
}

export interface PluginEndpointStore {
  list(pluginId: string): Promise<PluginEndpointRecord[]>;
  register(input: RegisterEndpointInput): Promise<PluginEndpointRecord>;
  /** 审批（记录审批人与时间） */
  approve(pluginId: string, endpointId: string, by: string, at: Date): Promise<PluginEndpointRecord | undefined>;
  /** 启用/停用单个端点 */
  setEnabled(pluginId: string, endpointId: string, enabled: boolean): Promise<PluginEndpointRecord | undefined>;
}

/** 路由冲突错误（把 PG 的唯一约束冲突转成可读信息）。 */
export class EndpointRouteConflict extends Error {
  override readonly name = 'EndpointRouteConflict';
  constructor(input: { method: string; mountPath: string; ownerScope: string; ownerId: string }) {
    super(
      `路由冲突：'${input.method} ${input.mountPath}' 已被同一作用域（${input.ownerScope}/${input.ownerId}）下的另一个插件注册` +
        `——两个插件不得注册同一 method+path（文档 §1.13.5 的冲突检测）`,
    );
  }
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryPluginEndpointStore implements PluginEndpointStore {
  private readonly records = new Map<string, PluginEndpointRecord>();
  private seq = 0;

  async list(pluginId: string): Promise<PluginEndpointRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.pluginId === pluginId)
      .sort((a, b) => (a.mountPath < b.mountPath ? -1 : a.mountPath > b.mountPath ? 1 : 0))
      .map((record) => ({ ...record }));
  }

  async register(input: RegisterEndpointInput): Promise<PluginEndpointRecord> {
    // ★★ 路径校验用 `endpoints.ts` 的 `inspectPath()`——**不再手写第二套**。
    //   R67 的模块接线检查发现 `plugin/endpoints.ts` 早已实现它
    //   （保留前缀 / 路径穿越 / 连续斜杠 / 查询串…）。
    //
    //   ★ 校验的是 **`mountPath`（挂载路径）而不是 `path`（插件内部路径）**：
    //     我第一版校验了 `path`，立刻被拒绝——
    //     `inspectPath` 要求挂载路径必须落在 `/api/plugins/<pluginId>/` 之下
    //     （**否则会与宿主路由争抢命名空间**）。
    //     这正说明了「用现成实现」的价值：**它带着我没想到的规则**。
    const inspected = inspectPath(input.mountPath);
    if (!inspected.ok) throw new Error(`端点挂载路径非法：${inspected.message}`);
    const ownerScope = input.ownerScope ?? 'platform';
    const ownerId = input.ownerId ?? 'platform';
    // ★ 冲突检测（与 PG 的唯一索引同语义）
    for (const record of this.records.values()) {
      if (record.ownerScope === ownerScope && record.ownerId === ownerId && record.method === input.method && record.mountPath === input.mountPath) {
        throw new EndpointRouteConflict({ method: input.method, mountPath: input.mountPath, ownerScope, ownerId });
      }
    }
    const now = new Date();
    const record: PluginEndpointRecord = {
      // ★ 必须是合法 uuid：PG 的 `ag_plugin_endpoints.id` 是 uuid（uuidv7 默认值）。
      //   此前生成 `ep-N`，而端点管理接口要求 `:eid` 是 uuid →
      //   **内存模式返回的 id 在真实模式下会被自己的校验拒绝**（语义漂移）。
      id: randomUUID(),
      pluginId: input.pluginId,
      ownerScope,
      ownerId,
      method: input.method,
      path: input.path,
      mountPath: input.mountPath,
      auth: input.auth,
      visibility: input.visibility ?? 'public',
      kind: input.kind ?? 'handler',
      enabled: true,
      approvedBy: null,
      approvedAt: null,
      createdAt: now,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async approve(pluginId: string, endpointId: string, by: string, at: Date): Promise<PluginEndpointRecord | undefined> {
    const found = this.records.get(endpointId);
    if (found === undefined || found.pluginId !== pluginId) return undefined;
    const next: PluginEndpointRecord = { ...found, approvedBy: by, approvedAt: at };
    this.records.set(endpointId, next);
    return { ...next };
  }

  async setEnabled(pluginId: string, endpointId: string, enabled: boolean): Promise<PluginEndpointRecord | undefined> {
    const found = this.records.get(endpointId);
    if (found === undefined || found.pluginId !== pluginId) return undefined;
    const next: PluginEndpointRecord = { ...found, enabled };
    this.records.set(endpointId, next);
    return { ...next };
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface EndpointRow extends Record<string, unknown> {
  id: string;
  plugin_id: string;
  owner_scope: string;
  owner_id: string;
  method: string;
  path: string;
  mount_path: string;
  auth: string;
  visibility: string;
  kind: string;
  enabled: boolean;
  approved_by: string | null;
  approved_at: string | Date | null;
  created_at: string | Date;
}

const COLUMNS = ['id', 'plugin_id', 'owner_scope', 'owner_id', 'method', 'path', 'mount_path', 'auth', 'visibility', 'kind', 'enabled', 'approved_by', 'approved_at', 'created_at'];

function rowToRecord(row: EndpointRow): PluginEndpointRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    ownerScope: row.owner_scope as OwnerScope,
    ownerId: row.owner_id,
    method: row.method,
    path: row.path,
    mountPath: row.mount_path,
    auth: row.auth as EndpointAuth,
    visibility: row.visibility as EndpointVisibility,
    kind: row.kind as EndpointKind,
    enabled: row.enabled === true,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at === null ? null : new Date(row.approved_at as string),
    createdAt: new Date(row.created_at as string),
  };
}

export class DbPluginEndpointStore implements PluginEndpointStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async list(pluginId: string): Promise<PluginEndpointRecord[]> {
    const compiled = compile(
      { kind: 'select', table: 'ag_plugin_endpoints', columns: COLUMNS, where: eq(col('plugin_id'), lit(pluginId)), orderBy: [{ column: 'mount_path', direction: 'asc' }] },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<EndpointRow>(compiled.sql, compiled.params);
    return rows.map(rowToRecord);
  }

  async register(input: RegisterEndpointInput): Promise<PluginEndpointRecord> {
    // ★★ 与内存实现**同一套路径校验**（`inspectPath(input.mountPath)`）——
    //   否则「内存拒绝、PG 接受」会成为又一处语义漂移。
    const inspected = inspectPath(input.mountPath);
    if (!inspected.ok) throw new Error(`端点挂载路径非法：${inspected.message}`);
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_plugin_endpoints',
        rows: [
          {
            // ★ `owner_scope` 无默认值 → 必须显式提供（站点作用域门禁的要求）
            owner_scope: input.ownerScope ?? 'platform',
            owner_id: input.ownerId ?? 'platform',
            plugin_id: input.pluginId,
            method: input.method,
            path: input.path,
            mount_path: input.mountPath,
            auth: input.auth,
            visibility: input.visibility ?? 'public',
            kind: input.kind ?? 'handler',
            spec: JSON.stringify({}),
          },
        ],
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    try {
      const rows = await this.#db.query<EndpointRow>(compiled.sql, compiled.params);
      const row = rows[0];
      if (row === undefined) throw new Error(`注册端点 '${input.method} ${input.mountPath}' 失败：未返回行`);
      return rowToRecord(row);
    } catch (error) {
      // ★★ 把 PG 的唯一约束冲突转成**可读的冲突说明**
      const message = error instanceof Error ? error.message : String(error);
      if (/uq_ag_plugin_endpoints_route|duplicate key/i.test(message)) {
        throw new EndpointRouteConflict({
          method: input.method,
          mountPath: input.mountPath,
          ownerScope: input.ownerScope ?? 'platform',
          ownerId: input.ownerId ?? 'platform',
        });
      }
      throw error;
    }
  }

  async approve(pluginId: string, endpointId: string, by: string, at: Date): Promise<PluginEndpointRecord | undefined> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_plugin_endpoints',
        set: { approved_by: by, approved_at: at },
        where: eq(col('id'), lit(endpointId)),
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<EndpointRow>(compiled.sql, compiled.params);
    const row = rows[0];
    return row === undefined || row.plugin_id !== pluginId ? undefined : rowToRecord(row);
  }

  async setEnabled(pluginId: string, endpointId: string, enabled: boolean): Promise<PluginEndpointRecord | undefined> {
    const compiled = compile(
      { kind: 'update', table: 'ag_plugin_endpoints', set: { enabled }, where: eq(col('id'), lit(endpointId)), returning: COLUMNS },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<EndpointRow>(compiled.sql, compiled.params);
    const row = rows[0];
    return row === undefined || row.plugin_id !== pluginId ? undefined : rowToRecord(row);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它）。 */
export function createTransactionalPluginEndpointStore(db: Db): PluginEndpointStore {
  const inner = new DbPluginEndpointStore(db);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    list: (pluginId) => wrap(() => inner.list(pluginId)),
    register: (input) => wrap(() => inner.register(input)),
    approve: (pluginId, endpointId, by, at) => wrap(() => inner.approve(pluginId, endpointId, by, at)),
    setEnabled: (pluginId, endpointId, enabled) => wrap(() => inner.setEnabled(pluginId, endpointId, enabled)),
  };
}
