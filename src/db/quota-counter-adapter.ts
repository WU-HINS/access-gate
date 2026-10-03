/**
 * 配额计数的 PG 存储（`ag_quota_counters`）—— `QuotaGuard` 的**跨实例**计数。
 *
 * ★★ 为什么必须有它（本会话 L-13）：`QuotaGuard` 的内存实现是**进程内**的，
 *   多实例部署下实际配额 = 单实例配额 × 实例数 —— 而限流/预算是**跨实例**的资源。
 *
 * ★★ 原子性：预占用**条件更新 + `RETURNING`**（三条语句覆盖三种情形），
 *   而不是"先读再写" —— 后者在两个实例同时读到 `used = limit - 1` 时必然**超发**
 *   （与本仓库既有的邀请码核销、调度器租约同一手法）。
 *
 * ★ 键**不解释**：本表只存 `quota_key` 与窗口。键的形状（与归属同构）由 `QuotaGuard`
 *   保证 —— 若在这里再解析一次键，就会有两处"键的语义"，那是分叉的温床。
 *
 * ★ 仓储层（`src/db/`）：由调用方保证在事务内（`reuseOrBeginTransaction`），
 *   运行时由查询层的 `assertInTransaction` 兜底。列名写字面量、参数用占位符
 *   （CI 第 6 项禁止模板字面量插值）。
 */

import type { Db } from './pool.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { QuotaCounterStore } from '../core/quota-guard.ts';

interface UsedRow extends Record<string, unknown> {
  used: string | number;
}

export class DbQuotaCounterStore implements QuotaCounterStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async reserve(input: {
    key: string;
    amount: number;
    limit: number;
    windowStart: Date;
    windowMs: number;
  }): Promise<number | null> {
    // ① **同窗口的条件递增**：`used + amount <= limit` 才递增（一条语句，数据库保证原子）
    const bumped = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<UsedRow>(
        `UPDATE ag_quota_counters
            SET used = used + $1
          WHERE quota_key = $2 AND window_start = $3 AND used + $1 <= $4
          RETURNING used`,
        [input.amount, input.key, input.windowStart, input.limit],
      ),
    );
    if (bumped[0] !== undefined) return Number(bumped[0].used);

    // ② **窗口滚动**：把整行重置到新窗口（本条同时覆盖"行不存在"的情形——见 ③）
    //    ★ 只在本次预占不超限时才有意义：否则应判超限，而不是把窗口重置掉。
    if (input.amount <= input.limit) {
      const rolled = await reuseOrBeginTransaction(this.#db, async () =>
        this.#db.query<UsedRow>(
          `UPDATE ag_quota_counters
              SET used = $1, window_start = $2
            WHERE quota_key = $3 AND window_start <> $2
            RETURNING used`,
          [input.amount, input.windowStart, input.key],
        ),
      );
      if (rolled[0] !== undefined) return Number(rolled[0].used);

      // ③ **首次出现**：插入（并发下另一实例可能刚插入 → `DO NOTHING`，
      //    于是本次返回 null 由调用方重试；调用方（Gurad）不重试，故这里再尝试一次 ①）
      const inserted = await reuseOrBeginTransaction(this.#db, async () =>
        this.#db.query<UsedRow>(
          `INSERT INTO ag_quota_counters (quota_key, window_start, used)
           VALUES ($1, $2, $3)
           ON CONFLICT (quota_key) DO NOTHING
           RETURNING used`,
          [input.key, input.windowStart, input.amount],
        ),
      );
      if (inserted[0] !== undefined) return Number(inserted[0].used);

      // 并发插入竞争：另一实例刚建好行 → 最后再试一次条件递增
      const retried = await reuseOrBeginTransaction(this.#db, async () =>
        this.#db.query<UsedRow>(
          `UPDATE ag_quota_counters
              SET used = used + $1
            WHERE quota_key = $2 AND window_start = $3 AND used + $1 <= $4
            RETURNING used`,
          [input.amount, input.key, input.windowStart, input.limit],
        ),
      );
      if (retried[0] !== undefined) return Number(retried[0].used);
    }

    // 走到这里 = 行存在、窗口一致、且**加上本次会超限** → 超限
    return null;
  }

  async used(key: string, windowStart: Date): Promise<number> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<UsedRow>(
        `SELECT used FROM ag_quota_counters WHERE quota_key = $1 AND window_start = $2 LIMIT 1`,
        [key, windowStart],
      ),
    );
    return rows[0] === undefined ? 0 : Number(rows[0].used);
  }

  async release(input: { key: string; amount: number; windowStart: Date }): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query(
        // ★ `GREATEST(..., 0)`：额度**不能为负**（回滚多于预占时不该把配额"变成信用"）
        `UPDATE ag_quota_counters
            SET used = GREATEST(used - $1, 0)
          WHERE quota_key = $2 AND window_start = $3`,
        [input.amount, input.key, input.windowStart],
      ),
    );
  }

  async adjust(input: { key: string; delta: number; windowStart: Date }): Promise<void> {
    // ① 同窗口：按 delta 调整（下限 0，**上限不设**——结算可把 used 推到 limit 之上，
    //    如实记账才能让**下一次**调用被拒）
    const adjusted = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<UsedRow>(
        `UPDATE ag_quota_counters
            SET used = GREATEST(used + $1, 0)
          WHERE quota_key = $2 AND window_start = $3
          RETURNING used`,
        [input.delta, input.key, input.windowStart],
      ),
    );
    if (adjusted[0] !== undefined) return;

    // ② 行不存在**或**窗口已过期 → 插入/重置到新窗口
    await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query(
        `INSERT INTO ag_quota_counters (quota_key, window_start, used)
         VALUES ($1, $2, GREATEST($3, 0))
         ON CONFLICT (quota_key) DO UPDATE
            SET used = GREATEST($3, 0), window_start = $2`,
        [input.key, input.windowStart, input.delta],
      ),
    );
  }
}
