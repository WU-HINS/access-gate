/**
 * 驱动层：`@electric-sql/pglite`（进程内 PostgreSQL）+ 事务运行器。
 *
 * 为什么用 pglite：本项目只支持 PostgreSQL（D10），但 M0 的验收要求「空库真跑一次 DDL」。
 * pglite 提供**真实 PG 语义**（18.3），且无需外部服务与 root 权限，适合 CI。
 * 生产环境替换为 `pg` 池时，只需另实现 `TransactionRunner`，上层 `withTransaction` 不变。
 *
 * ★ 本文件在 `src/db/guard.ts` 的白名单里——它是唯一允许直接调用驱动查询的地方。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { PGlite } from '@electric-sql/pglite';
import { withTransaction, type TransactionHandle } from './tx.ts';

export interface QueryResultRow {
  [column: string]: unknown;
}

export interface Db {
  /** 原始驱动（仅供本模块与迁移工具使用；业务代码请用 Db.query） */
  readonly raw: PGlite;
  /** ★ 业务查询入口：必须在事务内调用 */
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** 执行 DDL/多条语句（迁移用） */
  exec(sql: string): Promise<void>;
  /** ★ 单一事务入口 */
  transaction<T>(fn: (tx: TransactionHandle) => Promise<T>, options?: { label?: string }): Promise<T>;
  close(): Promise<void>;
}

export async function createDb(options: { dataDir?: string } = {}): Promise<Db> {
  const raw = options.dataDir === undefined ? new PGlite() : new PGlite(options.dataDir);
  await raw.waitReady;

  const db: Db = {
    raw,
    async query<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const { assertInTransaction } = await import('./tx.ts');
      const tx = assertInTransaction('query');
      tx.record(sql);
      const result = await raw.query<T>(sql, params as unknown[]);
      return result.rows;
    },
    async exec(sql: string): Promise<void> {
      await raw.exec(sql);
    },
    transaction<T>(fn: (tx: TransactionHandle) => Promise<T>, opts: { label?: string } = {}): Promise<T> {
      return withTransaction(
        {
          begin: async () => {
            await raw.exec('BEGIN');
          },
          commit: async () => {
            await raw.exec('COMMIT');
          },
          rollback: async () => {
            await raw.exec('ROLLBACK');
          },
        },
        fn,
        opts,
      );
    },
    async close(): Promise<void> {
      await raw.close();
    },
  };
  return db;
}

// ─────────────────────────── 真实 PostgreSQL 连接池 ───────────────────────────

/**
 * 真实 PostgreSQL 的 `Db` 实现（生产路径）。
 *
 * ★ 为什么与 pglite 版分开：
 *   - pglite 是**进程内单连接**（CI 与本地开发用），它的 `query` 直接走 WASM；
 *   - 生产必须用**连接池**（`pg`），并且**事务必须绑定到同一条连接**——
 *     否则 `BEGIN` 与 `COMMIT` 会落在不同连接上，事务形同虚设。
 *     因此这里用 `pool.connect()` 拿独占连接，把事务上下文绑在它上面。
 *
 * 与 pglite 版共享的行为：`assertInTransaction`（单一事务入口）。
 */
/**
 * 当前事务持有的连接（AsyncLocalStorage）。
 *
 * ★ 不能用一个模块级变量：并发请求会互相串用连接。
 *   这正是「事务必须绑定连接」的另一面——绑定关系必须随异步上下文走。
 */
const connectionStorage = new AsyncLocalStorage<PoolClientLike>();

export async function createPgDb(options: { connectionString: string; max?: number }): Promise<Db & { end(): Promise<void> }> {
  const { Pool } = (await import('pg')) as unknown as typeof import('pg');
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    // 连接级别的兜底超时：避免「卡住的连接」把请求池耗尽
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 60_000,
  });

  const db: Db & { end(): Promise<void> } = {
    raw: pool as unknown as Db['raw'],
    async query<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const { assertInTransaction } = await import('./tx.ts');
      const tx = assertInTransaction('query');
      tx.record(sql);
      // ★ 事务内的查询必须走事务持有的那条连接，否则会跳出事务
      const connection = currentConnection();
      const result =
        connection === undefined ? await pool.query<T>(sql, params as unknown[]) : await connection.query<T>(sql, params as unknown[]);
      return result.rows;
    },
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    transaction<T>(fn: (tx: never) => Promise<T>, opts: { label?: string } = {}): Promise<T> {
      // ★ 事务与连接必须绑死：`BEGIN`/`COMMIT`/事务内的查询都要落在**同一条连接**上。
      //   用 AsyncLocalStorage.run 把连接注入异步上下文，事务内的 db.query 会读到它。
      //   （模块级变量不行：并发请求会互相串用连接。）
      let held: PoolClientLike | undefined;
      return withTransaction(
        {
          begin: async () => {
            held = (await pool.connect()) as unknown as PoolClientLike;
            await held.query('BEGIN');
          },
          commit: async () => {
            try {
              await held?.query('COMMIT');
            } finally {
              held?.release();
              held = undefined;
            }
          },
          rollback: async () => {
            try {
              await held?.query('ROLLBACK');
            } finally {
              held?.release();
              held = undefined;
            }
          },
        },
        // withTransaction 之外再套一层 run，保证 fn 及其所有异步派生都在同一上下文
        async (tx) => connectionStorage.run(held as PoolClientLike, () => fn(tx as never)),
        opts,
      );
    },
    async close(): Promise<void> {
      await pool.end();
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
  return db;
}

interface PoolClientLike {
  query<T = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

function currentConnection(): PoolClientLike | undefined {
  return connectionStorage.getStore();
}
