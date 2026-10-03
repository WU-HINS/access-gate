/**
 * 插件实例的 PG 适配器（`ag_plugin_instances`）—— R104（步骤 4 的**前提**）。
 *
 * ★★★ 为什么需要它（R104 的发现）：
 *   查「插件自动调度如何按开发者解析主体」时，发现：
 *   · `ag_plugin_configs`（有 Store）**只有 `instance_id`**，其 `instanceIdFor(pluginId)`
 *     **只依赖 pluginId** → 配置是「**每插件一份**」，**无法区分开发者**；
 *   · 而 `ag_plugin_instances`（**含 `scope` / `developer_id` / `enabled`** 的**正确表**）
 *     **没有任何 Store**——★ 即：`configScope: 'developer'` 的语义**从未被实现**。
 *
 *   ★ 于是「按开发者解析 `FactPipeline.userId`」**没有数据可依**——
 *     步骤 4 的**前提不存在**。
 *
 * ★ 本适配器补上这个前提：提供「**某开发者的已启用插件实例**」的查询。
 *
 * ★ 表的语义（来自 `migrations/0001_init.sql` 的 CHECK 约束）：
 *   `scope = 'site'` → `site_id` 非空、`developer_id` 为空；
 *   `scope = 'developer'` → 反之（该分支无显式约束，本适配器按语义写入）。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: true };

export type PluginConfigScope = 'developer' | 'site';

export interface PluginInstance {
  id: string;
  pluginId: string;
  instanceKey: string;
  scope: PluginConfigScope;
  /** `scope='developer'` 时非空 */
  developerId: string | null;
  /** `scope='site'` 时非空 */
  siteId: string | null;
  label: string | null;
  config: Record<string, unknown>;
  configHash: string;
  /** ★ 只有 `enabled` 的实例才应被调度 */
  enabled: boolean;
}

interface InstanceRow extends Record<string, unknown> {
  id: string;
  plugin_id: string;
  instance_key: string;
  scope: string;
  developer_id: string | null;
  site_id: string | null;
  label: string | null;
  config: Record<string, unknown> | string | null;
  config_hash: string;
  enabled: boolean;
}

const COLUMNS = [
  'id', 'plugin_id', 'instance_key', 'scope', 'developer_id', 'site_id',
  'label', 'config', 'config_hash', 'enabled',
];

function rowToInstance(row: InstanceRow): PluginInstance {
  const config =
    typeof row.config === 'string' ? (JSON.parse(row.config) as Record<string, unknown>) : (row.config ?? {});
  return {
    id: row.id,
    pluginId: row.plugin_id,
    instanceKey: row.instance_key,
    scope: row.scope as PluginConfigScope,
    developerId: row.developer_id,
    siteId: row.site_id,
    label: row.label,
    config,
    configHash: row.config_hash,
    enabled: row.enabled === true,
  };
}

export class DbPluginInstanceStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 取**某开发者的、已启用的、指定插件**的实例。
   *
   * ★ 这是插件自动调度所需的最小查询：给定开发者与插件，拿到它的配置与 `enabled`。
   */
  async findDeveloperInstance(input: { developerId: string; pluginId: string }): Promise<PluginInstance | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_instances',
        columns: COLUMNS,
        where: and(
          eq(col('scope'), lit('developer')),
          eq(col('developer_id'), lit(input.developerId)),
          eq(col('plugin_id'), lit(input.pluginId)),
        ),
        limit: 1,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<InstanceRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToInstance(rows[0]);
  }

  /** 列出**所有已启用的开发者级实例**（自动调度的遍历入口）。 */
  async listEnabledDeveloperInstances(pluginId?: string): Promise<PluginInstance[]> {
    const conditions = [eq(col('scope'), lit('developer')), eq(col('enabled'), lit(true))];
    if (pluginId !== undefined) conditions.push(eq(col('plugin_id'), lit(pluginId)));
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_instances',
        columns: COLUMNS,
        where: and(...conditions),
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<InstanceRow>(compiled.sql, compiled.params);
    return rows.map(rowToInstance);
  }

  /** 列出**某插件的全部实例**（管理端点用；含未启用的）。 */
  async listByPlugin(pluginId: string): Promise<PluginInstance[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_instances',
        columns: COLUMNS,
        where: eq(col('plugin_id'), lit(pluginId)),
        orderBy: [{ column: 'scope', direction: 'asc' }, { column: 'instance_key', direction: 'asc' }],
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<InstanceRow>(compiled.sql, compiled.params);
    return rows.map(rowToInstance);
  }

  /** 保存（或更新）一个开发者级实例（管理端点用）。 */
  async saveDeveloperInstance(input: {
    pluginId: string;
    developerId: string;
    instanceKey?: string;
    label?: string | null;
    config: Record<string, unknown>;
    configHash: string;
    enabled: boolean;
  }): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_plugin_instances',
        rows: [
          {
            plugin_id: input.pluginId,
            instance_key: input.instanceKey ?? 'default',
            scope: 'developer',
            developer_id: input.developerId,
            site_id: null,
            label: input.label ?? null,
            config: JSON.stringify(input.config),
            config_hash: input.configHash,
            enabled: input.enabled,
          },
        ],
        returning: ['id'],
        // ★ 唯一约束是**按 scope 分的两个**（见 `migrations/0001_init.sql`）：
        //     `uq_ag_plugin_inst_dev (developer_id, plugin_id, instance_key)`
        //     `uq_ag_plugin_inst_site (site_id, plugin_id, instance_key)`
        //   ★ 我第一版写成 `(plugin_id, instance_key)`，真实 PG 报
        //     `there is no unique or exclusion constraint matching the ON CONFLICT specification`
        //     —— **唯一约束必须先查迁移产物**（本会话第 N 次同类教训）。
        onConflict: {
          columns: ['developer_id', 'plugin_id', 'instance_key'],
          do: 'update',
          updateColumns: ['config', 'config_hash', 'enabled', 'label'],
          // ★★ R6 修复：唯一索引是**部分索引**（`where developer_id IS NOT NULL`）——
          //   `ON CONFLICT` 必须带上**同一谓词**，否则 PG 报 42P10
          //   （"没有匹配 ON CONFLICT 规格的唯一约束"）。
          //   ★ 加谓词的**理由**：可空列上的唯一键会被 PG 静默失效（NULL 互不相同），
          //     于是同一 (开发者, 插件, 实例键) 可以插入任意多行。
          where: 'developer_id IS NOT NULL',
        },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalPluginInstanceStore(db: Db): DbPluginInstanceStore {
  const inner = new DbPluginInstanceStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return Object.assign(Object.create(Object.getPrototypeOf(inner)) as DbPluginInstanceStore, {
    findDeveloperInstance: (input: { developerId: string; pluginId: string }) => wrap(() => inner.findDeveloperInstance(input)),
    listByPlugin: (pluginId: string) => wrap(() => inner.listByPlugin(pluginId)),
    listEnabledDeveloperInstances: (pluginId?: string) => wrap(() => inner.listEnabledDeveloperInstances(pluginId)),
    saveDeveloperInstance: (input: Parameters<DbPluginInstanceStore['saveDeveloperInstance']>[0]) => wrap(() => inner.saveDeveloperInstance(input)),
  });
}
