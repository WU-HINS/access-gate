/**
 * 渠道同步状态的 PG 适配器（`ag_provider_sync_state`）—— P1-2。
 *
 * ★★ 为什么它重要：`SyncStateStore` 此前**只有内存实现**，而它记录的是
 *   「**上次同步到哪了**」（`cursor` / `lastSeenKey` / `lastFullSyncAt`）。
 *   · **重启后归零** → 下一次同步会**从头再来**（重复拉取，甚至重复写入）；
 *   · **多实例** → 每个实例各自记得不同的游标 → **重复同步或漏同步**。
 *
 * ★ 接口 `get(provider)` / `save(state)` **不含 siteId**，而表的主键是 `(site_id, provider)`
 *   → 因此**按站点实例化**（与 `KvStore` 同一模式）：
 *   把 `siteId` 放进构造参数，调用方**无法**跨站点读写。
 *
 * ★ `drift_policy` 列本适配器**不写**（用表默认值 `platform_wins`）——
 *   它的归属是「站点级策略配置」，不是「同步进度」，由别的路径设置。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { SyncState, SyncStateStore } from '../core/reconciler.ts';

/**
 * ★ `ag_provider_sync_state` 是**站点级**表。
 *
 * ★ 本适配器**按站点实例化**（构造时固定 `siteId`），因此查询里的 `site_id`
 *   由**本文件**负责带上——这是「站点作用域」的另一种实现方式：
 *   **不是**编译器注入，而是**把作用域变成构造参数**（调用方拿不到跨站点的 store）。
 *   ★ 与 `DbKvStore` 同一模式；★ 与 `DbInvitationStore` 的显式 where 也一致。
 */
const SITE_SCOPED_BY_HAND: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: true };

interface SyncStateRow extends Record<string, unknown> {
  provider: string;
  cursor: string | null;
  last_seen_key: string | null;
  last_incremental_at: string | Date | null;
  last_full_sync_at: string | Date | null;
  last_full_sync_count: number;
  last_error: string | null;
  capabilities: Record<string, unknown> | string | null;
}

const COLUMNS = [
  'provider', 'cursor', 'last_seen_key', 'last_incremental_at',
  'last_full_sync_at', 'last_full_sync_count', 'last_error', 'capabilities',
];

function rowToState(row: SyncStateRow): SyncState {
  const capabilities =
    typeof row.capabilities === 'string'
      ? (JSON.parse(row.capabilities) as Record<string, unknown>)
      : (row.capabilities ?? {});
  return {
    provider: row.provider,
    cursor: row.cursor,
    lastSeenKey: row.last_seen_key,
    ...(row.last_incremental_at === null ? {} : { lastIncrementalAt: new Date(row.last_incremental_at as string) }),
    ...(row.last_full_sync_at === null ? {} : { lastFullSyncAt: new Date(row.last_full_sync_at as string) }),
    lastFullSyncCount: row.last_full_sync_count,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    capabilities,
  };
}

export class DbSyncStateStore implements SyncStateStore {
  readonly #db: Db;
  readonly #siteId: string;
  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async get(provider: string): Promise<SyncState | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_provider_sync_state',
        columns: COLUMNS,
        where: and(eq(col('site_id'), lit(this.#siteId)), eq(col('provider'), lit(provider))),
        limit: 1,
      },
      SITE_SCOPED_BY_HAND,
      {},
    );
    const rows = await this.#db.query<SyncStateRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToState(rows[0]);
  }

  async save(state: SyncState): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_provider_sync_state',
        rows: [
          {
            site_id: this.#siteId,
            provider: state.provider,
            cursor: state.cursor,
            last_seen_key: state.lastSeenKey,
            last_incremental_at: state.lastIncrementalAt ?? null,
            last_full_sync_at: state.lastFullSyncAt ?? null,
            last_full_sync_count: state.lastFullSyncCount,
            last_error: state.lastError ?? null,
            capabilities: JSON.stringify(state.capabilities ?? {}),
          },
        ],
        returning: ['provider'],
        // ★ 主键是 (site_id, provider)：同一渠道再次保存 → **更新进度**
        onConflict: {
          columns: ['site_id', 'provider'],
          do: 'update',
          updateColumns: [
            'cursor', 'last_seen_key', 'last_incremental_at', 'last_full_sync_at',
            'last_full_sync_count', 'last_error', 'capabilities',
          ],
        },
      },
      SITE_SCOPED_BY_HAND,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalSyncStateStore(db: Db, siteId: string): SyncStateStore {
  const inner = new DbSyncStateStore(db, siteId);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    get: (provider) => wrap(() => inner.get(provider)),
    save: (state) => wrap(() => inner.save(state)),
  };
}
