/**
 * 插件配置存储（`ag_plugin_configs`）—— 运营必需。
 *
 * ★ 表的关键设计：配置是**版本化**的（`version` + `config_hash`），
 *   且 `uq_ag_plugin_configs_ver (plugin_id, version)` 保证版本号不重复。
 *   写入时把旧版本标 `archived`、新版本标 `active`，因此「回滚配置」= 切指针，
 *   与策略版本化的语义一致。
 *
 * ★★ 枚举取值**先查迁移产物再写**（本会话已因凭直觉写枚举踩坑三次）：
 *   `ag_config_status = 'draft' | 'active' | 'archived'`
 *
 * ★ `instance_id` 是 uuid NOT NULL（对应插件的实例，见 M4-3 的 `instances.mode`）。
 *   当前实现用「按 plugin_id 派生的稳定 uuid」，使同一插件在同一部署里
 *   始终落到同一个实例——这样重复写配置不会产生多个实例。
 */

import { createHash } from 'node:crypto';

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { col, eq, lit } from '../query/ast.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export type ConfigStatus = 'draft' | 'active' | 'archived';

export interface PluginConfigVersion {
  version: number;
  config: Record<string, unknown>;
  configHash: string;
  status: ConfigStatus;
  updatedBy: string | null;
  createdAt: Date;
}

export interface PluginConfigStore {
  /** 当前生效配置（无则 undefined） */
  latest(pluginId: string): Promise<PluginConfigVersion | undefined>;
  /** 全部版本（倒序，供回滚选择） */
  versions(pluginId: string): Promise<PluginConfigVersion[]>;
  /** 写入新版本（自动递增版本号，并把旧版本标 archived） */
  save(pluginId: string, config: Record<string, unknown>, by: string | null, at: Date): Promise<PluginConfigVersion>;
}

/** 配置内容指纹（**与插件包、策略 spec 用同一思路**：对规范化 JSON 取哈希）。 */
export function configHash(config: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(config), 'utf8').digest('hex').slice(0, 32);
}

/**
 * 由 `pluginId` 派生稳定的实例 uuid（v5 风格：命名空间 + 名称的哈希）。
 *
 * ★ 为什么需要：`instance_id` 是 NOT NULL uuid，而当前实现只有一个实例概念。
 *   派生（而不是随机）保证同一插件在同一部署里**始终是同一个实例**。
 */
export function instanceIdFor(pluginId: string): string {
  const hash = createHash('sha256').update(`ag-plugin-instance:${pluginId}`, 'utf8').digest('hex');
  // 取前 32 位十六进制，按 uuid 格式拼接，并设置 version/variant 位
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryPluginConfigStore implements PluginConfigStore {
  private readonly byPlugin = new Map<string, PluginConfigVersion[]>();

  async latest(pluginId: string): Promise<PluginConfigVersion | undefined> {
    const list = this.byPlugin.get(pluginId) ?? [];
    return list.length === 0 ? undefined : { ...list[list.length - 1]! };
  }
  async versions(pluginId: string): Promise<PluginConfigVersion[]> {
    return [...(this.byPlugin.get(pluginId) ?? [])].reverse().map((entry) => ({ ...entry }));
  }
  async save(pluginId: string, config: Record<string, unknown>, by: string | null, at: Date): Promise<PluginConfigVersion> {
    const list = this.byPlugin.get(pluginId) ?? [];
    for (const entry of list) entry.status = 'archived';
    const next: PluginConfigVersion = {
      version: (list[list.length - 1]?.version ?? 0) + 1,
      config: { ...config },
      configHash: configHash(config),
      status: 'active',
      updatedBy: by,
      createdAt: at,
    };
    list.push(next);
    this.byPlugin.set(pluginId, list);
    return { ...next };
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface ConfigRow extends Record<string, unknown> {
  version: number;
  config: Record<string, unknown> | string;
  config_hash: string;
  status: string;
  updated_by: string | null;
  created_at: string | Date;
}

const COLUMNS = ['version', 'config', 'config_hash', 'status', 'updated_by', 'created_at'];

function rowToVersion(row: ConfigRow): PluginConfigVersion {
  return {
    version: row.version,
    config: typeof row.config === 'string' ? (JSON.parse(row.config) as Record<string, unknown>) : row.config,
    configHash: row.config_hash,
    status: row.status as ConfigStatus,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at as string),
  };
}

function jsonb(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export class DbPluginConfigStore implements PluginConfigStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async latest(pluginId: string): Promise<PluginConfigVersion | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_configs',
        columns: COLUMNS,
        where: eq(col('plugin_id'), lit(pluginId)),
        orderBy: [{ column: 'version', direction: 'desc' }],
        limit: 1,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ConfigRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToVersion(rows[0]);
  }

  async versions(pluginId: string): Promise<PluginConfigVersion[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_configs',
        columns: COLUMNS,
        where: eq(col('plugin_id'), lit(pluginId)),
        orderBy: [{ column: 'version', direction: 'desc' }],
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ConfigRow>(compiled.sql, compiled.params);
    return rows.map(rowToVersion);
  }

  async save(pluginId: string, config: Record<string, unknown>, by: string | null, at: Date): Promise<PluginConfigVersion> {
    // ★ 先归档旧版本，再插入新版本（同一事务内，由调用方保证）
    const archive = compile(
      { kind: 'update', table: 'ag_plugin_configs', set: { status: 'archived' }, where: eq(col('plugin_id'), lit(pluginId)) },
      PLATFORM,
      {},
    );
    await this.#db.query(archive.sql, archive.params);

    const current = await this.latest(pluginId);
    const nextVersion = (current?.version ?? 0) + 1;
    const insert = compile(
      {
        kind: 'insert',
        table: 'ag_plugin_configs',
        rows: [
          {
            instance_id: instanceIdFor(pluginId),
            plugin_id: pluginId,
            version: nextVersion,
            config: jsonb(config),
            config_hash: configHash(config),
            status: 'active',
            updated_by: by,
            created_at: at,
          },
        ],
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ConfigRow>(insert.sql, insert.params);
    const row = rows[0];
    if (row === undefined) throw new Error(`写入插件 '${pluginId}' 的配置失败：未返回行`);
    return rowToVersion(row);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它）。 */
export function createTransactionalPluginConfigStore(db: Db): PluginConfigStore {
  const inner = new DbPluginConfigStore(db);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    latest: (pluginId) => wrap(() => inner.latest(pluginId)),
    versions: (pluginId) => wrap(() => inner.versions(pluginId)),
    save: (pluginId, config, by, at) => wrap(() => inner.save(pluginId, config, by, at)),
  };
}
