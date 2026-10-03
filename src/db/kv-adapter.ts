/**
 * 插件 KV 的 PG 适配器（`ag_plugin_storage`）。
 *
 * ★★ 为什么需要它：`HostApiOptions.cache` / `.storage` 是 `KvStore`，
 *   而此前**只有 `InMemoryKvStore`**——插件的键值存储**重启即丢**。
 *
 * ★★ 更根本的问题（R65 发现）：`HostApi` **在 `serve.ts` 里从未被实例化**——
 *   所以「插件 KV」的缺口不只是「内存 vs PG」，而是**宿主 API 没有装配**。
 *   本文件是装配它所需的第一块（另一块是装配器本身）。
 *
 * ★ 本适配器**按插件实例化**（`pluginId` + `instanceKey` 在构造时固定）——
 *   因为 `KvStore` 接口只接收 `key`（不含 pluginId），
 *   这是刻意的：插件**不应该**能读写别的插件的存储。
 *   ★ 把 `pluginId` 放在构造参数里，插件就**无法伪造**它。
 *
 * ★ `ag_plugin_storage` 的唯一键：`(owner_scope, owner_id, plugin_id, instance_key, key)`。
 *   `instance_key` 区分「同一个插件的 cache 与 storage」（两个独立的命名空间）。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, gt, isNull, lit, or } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { KvStore } from '../plugin/host-api.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export interface KvStoreScope {
  /** 插件 id（**由宿主注入**，插件无法伪造） */
  pluginId: string;
  /** 命名空间：`cache` 或 `storage`（两个独立的 KV 空间） */
  instanceKey: 'cache' | 'storage';
}

export class DbKvStore implements KvStore {
  readonly #db: Db;
  readonly #scope: KvStoreScope;
  constructor(db: Db, scope: KvStoreScope) {
    this.#db = db;
    this.#scope = scope;
  }

  async get(key: string): Promise<unknown> {
    // ★ 过期视为不存在（`expires_at IS NULL` 或 `expires_at > now`）
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_storage',
        columns: ['value'],
        where: and(
          eq(col('plugin_id'), lit(this.#scope.pluginId)),
          eq(col('instance_key'), lit(this.#scope.instanceKey)),
          eq(col('key'), lit(key)),
          // ★ 与内存实现的 TTL 语义一致：过期即取不到
          // ★ 用编译器的 `isNull` / `or` 辅助函数——我第一版手写了 Condition 对象，
          //   被类型拒绝后曾用类型断言绕过检查（★ 等于放弃这道防线）。
          or(isNull(col('expires_at')), gt(col('expires_at'), lit(new Date()))),
        ),
        limit: 1,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ value: unknown }>(compiled.sql, compiled.params);
    return rows[0]?.value;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs === undefined ? null : new Date(Date.now() + ttlMs);
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_plugin_storage',
        rows: [
          {
            owner_scope: 'platform',
            owner_id: 'platform',
            plugin_id: this.#scope.pluginId,
            instance_key: this.#scope.instanceKey,
            key,
            value: JSON.stringify(value ?? null),
            expires_at: expiresAt,
          },
        ],
        returning: ['key'],
        onConflict: {
          columns: ['owner_scope', 'owner_id', 'plugin_id', 'instance_key', 'key'],
          do: 'update',
          updateColumns: ['value', 'expires_at', 'updated_at'],
        },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async del(key: string): Promise<void> {
    const compiled = compile(
      {
        kind: 'delete',
        table: 'ag_plugin_storage',
        where: and(
          eq(col('plugin_id'), lit(this.#scope.pluginId)),
          eq(col('instance_key'), lit(this.#scope.instanceKey)),
          eq(col('key'), lit(key)),
        ),
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalKvStore(db: Db, scope: KvStoreScope): KvStore {
  const inner = new DbKvStore(db, scope);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    get: (key) => wrap(() => inner.get(key)),
    set: (key, value, ttlMs) => wrap(() => inner.set(key, value, ttlMs)),
    del: (key) => wrap(() => inner.del(key)),
  };
}
