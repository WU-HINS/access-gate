/**
 * PostgreSQL 咨询锁适配器（`pg_advisory_lock`）—— **驱动层**关注点。
 *
 * 为什么放在 `src/db/` 而不是调度器里：
 *   咨询锁是**会话级**的，必须在一条**独占连接**上获取与释放，
 *   绝不能塞进业务事务（`withTransaction`）里——否则事务提交/回滚会改变锁的归属，
 *   而且业务事务的连接来自池，锁会跟着连接被复用而串味（D18 讨论过的坑）。
 *   因此它是驱动层能力，对上层只暴露 `SingleFlightLock` 契约。
 *
 * ★ 双实例抢占的**真实验证**需要多会话 PostgreSQL：
 *   本项目 CI 用 pglite（单连接嵌入式），做不到——该验证状态在
 *   `reports/M0-acceptance.md` 的能力限制里如实登记，不以 pglite 结果冒充。
 */

import type { Logger } from '../kernel/logger.ts';
import type { SingleFlightLock } from '../kernel/scheduler.ts';

export interface LockConnection {
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => Promise<void>;
}

export function createPgAdvisoryLock(options: {
  /** 取得一个**独占**连接；执行完毕必须归还 */
  acquireConnection: () => Promise<LockConnection>;
  logger?: Logger;
}): SingleFlightLock {
  const held = new Map<string, LockConnection>();

  return {
    async tryLock(key: string): Promise<boolean> {
      const connection = await options.acquireConnection();
      try {
        const result = await connection.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
        const row = result.rows[0] as { locked?: boolean } | undefined;
        if (row?.locked === true) {
          held.set(key, connection);
          return true;
        }
      } catch (error) {
        await connection.release();
        throw error;
      }
      await connection.release();
      return false;
    },
    async unlock(key: string): Promise<void> {
      const connection = held.get(key);
      if (connection === undefined) return;
      try {
        await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } finally {
        held.delete(key);
        await connection.release();
      }
    },
  };
}
