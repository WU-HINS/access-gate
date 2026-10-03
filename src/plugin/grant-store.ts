/**
 * 插件权限授予（`ag_plugin_grants`）—— **逐项、可撤销、带审计**。
 *
 * ★★★ 为什么重写：R22 我把它实现成了 `runtime_state.grants`（jsonb 数组），
 *   而 `docs/02-数据模型.md §4.3` 明确规定用**独立的 `ag_plugin_grants` 表**：
 *
 *   ```
 *   ### 4.3 `ag_plugin_grants` —— 权限授予（逐项，可撤销）
 *   t.unique(['ownerScope','ownerId','pluginId','permission'], { name: 'uq_ag_plugin_grants' })
 *   ```
 *
 *   jsonb 版本丢了四样东西：
 *   1. **谁授予的**（`granted_by`）与**什么时候**（`granted_at`）——审计线索；
 *   2. **撤销时间**（`revoked_at`）——我的实现是**物理删除**，
 *      而文档要求**软撤销**（这样才能回答「这个权限曾经被授予过吗」）；
 *   3. **唯一约束**（同一权限只能有一行）——jsonb 数组靠代码去重；
 *   4. **按权限维度的索引**（`ix_ag_plugin_grants_perm`）——用于回答
 *      「哪些插件持有 `secrets:read:*`」（安全审计的核心问题）。
 *
 *   ★ 教训：**「我实现了一个能用的版本」不等于「我实现了文档要求的版本」**。
 *     代码能跑、测试能过、接口能返回 200——但存储形态与文档不一致，
 *     于是审计与安全排查能力在**看不见的地方**缺失了。
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { and, col, eq, isNull, lit } from '../query/ast.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export interface GrantRecord {
  id: string;
  pluginId: string;
  permission: string;
  grantedBy: string | null;
  grantedAt: Date;
  /** 非空表示已撤销（**软撤销**——行仍在，用于审计） */
  revokedAt: Date | null;
}

export interface PluginGrantStore {
  /** 该插件当前**有效**的权限 */
  active(pluginId: string): Promise<string[]>;
  /** 全部授予记录（含已撤销，供审计） */
  history(pluginId: string): Promise<GrantRecord[]>;
  /** 授予（幂等：已存在则清除撤销标记并更新授予人/时间） */
  grant(pluginId: string, permissions: readonly string[], by: string | null, at: Date): Promise<GrantRecord[]>;
  /** 撤销（**软撤销**：写 `revoked_at`，不删行） */
  revoke(pluginId: string, permission: string, at: Date): Promise<GrantRecord | undefined>;
  /** 按权限反查「哪些插件持有它」（安全审计：`secrets:read:*` 都授权给了谁） */
  holdersOf(permission: string): Promise<GrantRecord[]>;
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryPluginGrantStore implements PluginGrantStore {
  private readonly records = new Map<string, GrantRecord>();
  private seq = 0;
  private key(pluginId: string, permission: string): string {
    return `${pluginId}\u0000${permission}`;
  }

  async active(pluginId: string): Promise<string[]> {
    return [...this.records.values()]
      .filter((record) => record.pluginId === pluginId && record.revokedAt === null)
      .map((record) => record.permission)
      .sort();
  }
  async history(pluginId: string): Promise<GrantRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.pluginId === pluginId)
      .sort((a, b) => (a.permission < b.permission ? -1 : 1))
      .map((record) => ({ ...record }));
  }
  async grant(pluginId: string, permissions: readonly string[], by: string | null, at: Date): Promise<GrantRecord[]> {
    const out: GrantRecord[] = [];
    for (const permission of permissions) {
      const key = this.key(pluginId, permission);
      const existing = this.records.get(key);
      const next: GrantRecord = {
        id: existing?.id ?? `g-${++this.seq}`,
        pluginId,
        permission,
        grantedBy: by,
        grantedAt: at,
        // ★ 重新授予已撤销的权限 → 清除撤销标记
        revokedAt: null,
      };
      this.records.set(key, next);
      out.push({ ...next });
    }
    return out;
  }
  async revoke(pluginId: string, permission: string, at: Date): Promise<GrantRecord | undefined> {
    const key = this.key(pluginId, permission);
    const found = this.records.get(key);
    if (found === undefined) return undefined;
    // ★ 软撤销：已撤销时**保留首次撤销时间**
    const next: GrantRecord = { ...found, revokedAt: found.revokedAt ?? at };
    this.records.set(key, next);
    return { ...next };
  }
  async holdersOf(permission: string): Promise<GrantRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.permission === permission && record.revokedAt === null)
      .map((record) => ({ ...record }));
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface GrantRow extends Record<string, unknown> {
  id: string;
  plugin_id: string;
  permission: string;
  granted_by: string | null;
  granted_at: string | Date;
  revoked_at: string | Date | null;
}

const COLUMNS = ['id', 'plugin_id', 'permission', 'granted_by', 'granted_at', 'revoked_at'];

function rowToRecord(row: GrantRow): GrantRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    permission: row.permission,
    grantedBy: row.granted_by,
    grantedAt: new Date(row.granted_at as string),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at as string),
  };
}

export class DbPluginGrantStore implements PluginGrantStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async active(pluginId: string): Promise<string[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_grants',
        columns: ['permission'],
        where: and(eq(col('plugin_id'), lit(pluginId)), isNull(col('revoked_at'))),
        orderBy: [{ column: 'permission', direction: 'asc' }],
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ permission: string }>(compiled.sql, compiled.params);
    return rows.map((row) => row.permission);
  }

  async history(pluginId: string): Promise<GrantRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_grants',
        columns: COLUMNS,
        where: eq(col('plugin_id'), lit(pluginId)),
        orderBy: [{ column: 'permission', direction: 'asc' }],
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<GrantRow>(compiled.sql, compiled.params);
    return rows.map(rowToRecord);
  }

  async grant(pluginId: string, permissions: readonly string[], by: string | null, at: Date): Promise<GrantRecord[]> {
    const out: GrantRecord[] = [];
    for (const permission of permissions) {
      // ★ 唯一约束 `uq_ag_plugin_grants` 保证同一 (plugin, permission) 只有一行；
      //   冲突时**清除撤销标记**（= 重新授予）并更新授予人/时间。
      const compiled = compile(
        {
          kind: 'insert',
          table: 'ag_plugin_grants',
          rows: [
            {
              owner_scope: 'platform',
              owner_id: 'platform',
              plugin_id: pluginId,
              permission,
              granted_by: by,
              granted_at: at,
              revoked_at: null,
            },
          ],
          returning: COLUMNS,
          onConflict: {
            columns: ['owner_scope', 'owner_id', 'plugin_id', 'permission'],
            do: 'update',
            updateColumns: ['granted_by', 'granted_at', 'revoked_at'],
          },
        },
        PLATFORM,
        {},
      );
      const rows = await this.#db.query<GrantRow>(compiled.sql, compiled.params);
      const row = rows[0];
      if (row === undefined) throw new Error(`授予 '${pluginId}' 的权限 '${permission}' 失败：未返回行`);
      out.push(rowToRecord(row));
    }
    return out;
  }

  async revoke(pluginId: string, permission: string, at: Date): Promise<GrantRecord | undefined> {
    // ★ 只在**尚未撤销**时写入（保留首次撤销时间，与断言撤销同语义）
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_plugin_grants',
        set: { revoked_at: at },
        where: and(eq(col('plugin_id'), lit(pluginId)), eq(col('permission'), lit(permission)), isNull(col('revoked_at'))),
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<GrantRow>(compiled.sql, compiled.params);
    if (rows[0] !== undefined) return rowToRecord(rows[0]);
    // 没更新到：不存在，或已撤销——回读区分
    const existing = compile(
      {
        kind: 'select',
        table: 'ag_plugin_grants',
        columns: COLUMNS,
        where: and(eq(col('plugin_id'), lit(pluginId)), eq(col('permission'), lit(permission))),
        limit: 1,
      },
      PLATFORM,
      {},
    );
    const found = await this.#db.query<GrantRow>(existing.sql, existing.params);
    return found[0] === undefined ? undefined : rowToRecord(found[0]);
  }

  async holdersOf(permission: string): Promise<GrantRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_grants',
        columns: COLUMNS,
        where: and(eq(col('permission'), lit(permission)), isNull(col('revoked_at'))),
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<GrantRow>(compiled.sql, compiled.params);
    return rows.map(rowToRecord);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它）。 */
export function createTransactionalPluginGrantStore(db: Db): PluginGrantStore {
  const inner = new DbPluginGrantStore(db);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    active: (pluginId) => wrap(() => inner.active(pluginId)),
    history: (pluginId) => wrap(() => inner.history(pluginId)),
    grant: (pluginId, permissions, by, at) => wrap(() => inner.grant(pluginId, permissions, by, at)),
    revoke: (pluginId, permission, at) => wrap(() => inner.revoke(pluginId, permission, at)),
    holdersOf: (permission) => wrap(() => inner.holdersOf(permission)),
  };
}
