/**
 * nonce 防重放的 PG 适配器（`ag_verify_nonces`）—— R56 架构缺口的修复（第 2 个）。
 *
 * ★★★ 为什么必须持久化（此前只有内存实现）：
 *
 *   | 场景 | 内存实现的后果 |
 *   |---|---|
 *   | **多实例部署** | A 实例用过的 nonce，B 实例**不认识** → **重放防护失效** |
 *   | **服务重启** | 已用过的 nonce 全部忘记 → 攻击者可在窗口内重放 |
 *
 * ★★ 接口注释早已写明正确做法（本文件只是让那个做法**有地方落**）：
 *
 *   「必须**原子**（PG 实现用唯一约束 + `ON CONFLICT DO NOTHING` 看影响行数）——
 *     先查后写在并发下会让两个相同 nonce 都通过，防重放失效。」
 *
 * ★ 因此 `claim()` 的实现是：
 *   ① `INSERT ... ON CONFLICT (client_id, nonce) DO NOTHING RETURNING client_id`；
 *   ② **返回行数为 1 → 首次**（claim 成功）；**为 0 → 已存在**（拒绝）。
 *
 *   关键在于**不需要先查**：插入成功与否本身就是「是否首次」的答案，
 *   而数据库的唯一约束保证了并发下的正确性（两个并发请求只有一个能插入成功）。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { col, lt, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { NonceStore } from '../verify/hmac.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export class DbNonceStore implements NonceStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async claim(clientId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_verify_nonces',
        rows: [{ client_id: clientId, nonce, expires_at: expiresAt }],
        // ★★ 冲突时**什么都不做**（不更新）——因为「已存在」就意味着「这个 nonce 用过了」。
        //   若写成 DO UPDATE，则重复 claim 会「成功」，防重放就失效了。
        onConflict: { columns: ['client_id', 'nonce'], do: 'nothing' },
        returning: ['client_id'],
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ client_id: string }>(compiled.sql, compiled.params);
    // ★ 返回行数为 1 = 插入成功 = **首次**；为 0 = 已存在 = 重复（拒绝）
    return rows.length > 0;
  }

  async purge(): Promise<number> {
    const compiled = compile(
      { kind: 'delete', table: 'ag_verify_nonces', where: lt(col('expires_at'), lit(new Date())), returning: ['nonce'] },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ nonce: string }>(compiled.sql, compiled.params);
    return rows.length;
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalNonceStore(db: Db): NonceStore {
  const inner = new DbNonceStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    claim: (clientId, nonce, expiresAt) => wrap(() => inner.claim(clientId, nonce, expiresAt)),
    purge: () => wrap(() => inner.purge!()),
  };
}
