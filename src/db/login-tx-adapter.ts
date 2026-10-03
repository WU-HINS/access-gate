/**
 * 登录事务的 PG 适配器（`ag_oidc_login_transactions`）—— R56 架构缺口的修复。
 *
 * ★★★ 为什么必须持久化（此前只有内存实现）：
 *
 *   | 场景 | 内存实现的后果 |
 *   |---|---|
 *   | **服务重启** | 进行中的登录**全部失效**（用户看到「state 无效或已过期」） |
 *   | **多实例部署** | 登录**随机失败**（A 实例发的 state，负载均衡到 B 实例找不到） |
 *   | **PKCE** | `code_verifier` 随进程丢失 → 回调无法完成校验 |
 *
 * ★★ 本适配器最关键的一条：`take()` 必须是**原子的「取出即删除」**。
 *
 *   接口注释明确要求：「保存并在回调时**原子取出**（实现方必须保证取出即删除）」。
 *
 *   · 若用 `SELECT` 然后 `DELETE` 两步：两个并发的回调请求**都可能 SELECT 到**同一条，
 *     于是同一个 state 被用两次——**state 防重放失效**（而 state 防重放正是 CSRF 防护）；
 *   · 因此这里用 **`DELETE ... RETURNING`**：删除与读取在**同一条语句**里，
 *     数据库保证只有一个并发事务能拿到那一行。
 *
 *   ★ 这正是「单一事务入口」之外的另一层保证：**语句级的原子性**。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { col, eq, lit, lt } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { LoginTransaction, LoginTransactionStore } from '../auth/oidc.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

interface TxRow extends Record<string, unknown> {
  state: string;
  code_verifier: string;
  nonce: string;
  return_to: string;
  target_site_id: string | null;
  expires_at: string | Date;
  created_at: string | Date;
}

const COLUMNS = ['state', 'code_verifier', 'nonce', 'return_to', 'target_site_id', 'expires_at', 'created_at'];

function rowToTransaction(row: TxRow): LoginTransaction {
  return {
    state: row.state,
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    returnTo: row.return_to,
    // ★ 目标站点（可空）——回调时据此**自动选中**站点（见 `routes.ts` 的 callback）
    ...(row.target_site_id === null ? {} : { targetSiteId: row.target_site_id }),
    createdAt: new Date(row.created_at as string),
    expiresAt: new Date(row.expires_at as string),
  };
}

export class DbLoginTransactionStore implements LoginTransactionStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async put(transaction: LoginTransaction): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_oidc_login_transactions',
        rows: [
          {
            state: transaction.state,
            code_verifier: transaction.codeVerifier,
            nonce: transaction.nonce,
            return_to: transaction.returnTo ?? '/',
            target_site_id: transaction.targetSiteId ?? null,
            expires_at: transaction.expiresAt,
            created_at: transaction.createdAt,
          },
        ],
        returning: ['state'],
        // ★ 同一 state 重复发起（如用户点两次登录）→ 覆盖，而不是报唯一冲突
        onConflict: { columns: ['state'], do: 'update', updateColumns: ['code_verifier', 'nonce', 'return_to', 'target_site_id', 'expires_at', 'created_at'] },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  /**
   * **原子取出即删除**（`DELETE ... RETURNING`）。
   *
   * ★ 这是本文件最重要的方法：见文件头的说明——
   *   两步（SELECT + DELETE）会让并发回调都取到同一条，**state 防重放失效**。
   */
  async take(state: string): Promise<LoginTransaction | undefined> {
    const compiled = compile(
      {
        kind: 'delete',
        table: 'ag_oidc_login_transactions',
        where: eq(col('state'), lit(state)),
        // ★★ 关键：`returning` 让「删除」与「读回」成为**一条语句**
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<TxRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) return undefined;
    const transaction = rowToTransaction(row);
    // ★ 过期的不返回（但已经删掉了——过期事务本就不该再用）
    //   注：这里**先删后判**是刻意的：过期的 state 也不该能被重放。
    if (transaction.expiresAt.getTime() <= Date.now()) return undefined;
    return transaction;
  }

  async purgeExpired(now: Date): Promise<number> {
    const compiled = compile(
      { kind: 'delete', table: 'ag_oidc_login_transactions', where: lt(col('expires_at'), lit(now)), returning: ['state'] },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ state: string }>(compiled.sql, compiled.params);
    return rows.length;
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalLoginTransactionStore(db: Db): LoginTransactionStore {
  const inner = new DbLoginTransactionStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    put: (transaction) => wrap(() => inner.put(transaction)),
    take: (state) => wrap(() => inner.take(state)),
    purgeExpired: (now) => wrap(() => inner.purgeExpired(now)),
  };
}
