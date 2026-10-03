/**
 * 事务上下文（D17 前置 3：**单一事务入口**）。
 *
 * 目标：所有业务查询都必须经 `withTransaction(fn)` 执行；事务外的查询要能被**静态检出**
 * （`src/db/guard.ts`）与**运行期拒绝**（本模块的 `assertInTransaction`）。
 *
 * 为什么用 AsyncLocalStorage：Node 的单线程事件循环里，只有 ALS 能把「当前事务」
 * 隐式地传递到任意深度的调用栈，而不必给每个函数加一个 `tx` 参数。
 *
 * ★ 为什么这件事和站点隔离有关：数据访问层要在**每个**查询上注入 site_id；
 *   如果存在「事务外也能查」的旁路，注入就会被绕过。把查询收敛到单一入口，
 *   是把「注入」从约定变成机制的前提（也是 D17 判据「后补 RLS 的改动文件数 ≤ 3」的实测基础）。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TransactionHandle {
  readonly id: string;
  /** 事务内已执行的语句数（用于诊断与「事务内是否真的做了事」的断言） */
  readonly statementCount: () => number;
  /** 该事务是否已提交/回滚 */
  readonly settled: () => boolean;
  /** 记录一条已执行的语句（由查询编译器/驱动调用） */
  readonly record: (sql: string) => void;
}

export class TransactionRequiredError extends Error {
  override readonly name = 'TransactionRequiredError';
  constructor(operation: string) {
    super(
      `拒绝在事务外执行 ${operation}：所有业务查询必须走 ctx.db.transaction(fn)（单一事务入口，D17 前置 3）。` +
        `这是站点作用域注入能够生效的前提——事务外的旁路会让注入被绕过。`,
    );
  }
}

export class TransactionStateError extends Error {
  override readonly name = 'TransactionStateError';
  constructor(message: string) {
    super(message);
  }
}

const storage = new AsyncLocalStorage<TransactionHandle>();

let txSeq = 0;

/** 当前是否处于事务内。 */
export function inTransaction(): boolean {
  return storage.getStore() !== undefined;
}

/** 取当前事务句柄；不在事务内返回 undefined。 */
export function currentTx(): TransactionHandle | undefined {
  return storage.getStore();
}

/** ★ 运行期强校验：不在事务内即抛错（fail-closed）。 */
export function assertInTransaction(operation: string): TransactionHandle {
  const handle = storage.getStore();
  if (handle === undefined) throw new TransactionRequiredError(operation);
  if (handle.settled()) {
    throw new TransactionStateError(`事务 ${handle.id} 已结束，不能再执行 ${operation}`);
  }
  return handle;
}

export interface TransactionRunner {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * 单一事务入口。
 *
 * 语义：`fn` 正常返回 → commit；抛出 → rollback 并把原错误继续抛出（不吞错）。
 * 嵌套调用**不允许**（会静默地变成两个独立事务从而破坏原子性），直接抛错。
 */
export async function withTransaction<T>(
  runner: TransactionRunner,
  fn: (tx: TransactionHandle) => Promise<T>,
  options: { label?: string } = {},
): Promise<T> {
  if (storage.getStore() !== undefined) {
    throw new TransactionStateError(
      '不允许嵌套 withTransaction：嵌套会产生两个独立事务，破坏原子性。请复用外层事务。',
    );
  }

  const id = `tx-${++txSeq}-${options.label ?? 'anonymous'}`;
  let statements = 0;
  let settled = false;

  const handle: TransactionHandle = {
    id,
    statementCount: () => statements,
    settled: () => settled,
    record: (sql: string) => {
      if (settled) throw new TransactionStateError(`事务 ${id} 已结束，不能记录语句：${sql}`);
      statements += 1;
    },
  };

  await runner.begin();
  try {
    const result = await storage.run(handle, () => fn(handle));
    await runner.commit();
    settled = true;
    return result;
  } catch (error) {
    try {
      await runner.rollback();
    } finally {
      settled = true;
    }
    throw error;
  }
}

/**
 * 复用外层事务的包装（**仓储层工厂专用**）。
 *
 * ★★★ 为什么需要它：本会话有两套「包事务」的做法，它们在 R30 **撞在一起**：
 *
 *   1. **handler 入口包一层**（R13 为根治「事务外查询」而做）；
 *   2. **store 工厂各自包一层**（R22–R30 的 `createTransactionalXxx` 模式）。
 *
 *   两者同时存在时，store 方法在 handler 的事务内再调 `transaction()`
 *   → `不允许嵌套 withTransaction` → **`/api/admin/users` 等 6 个端点全部 500**。
 *
 * ★ 正确架构是：
 *   · **最外层**（请求入口）开事务——这样多个 store 调用在**同一事务**内（原子性）；
 *   · **内层**（store 方法）检测到已有事务就**复用**，不新开。
 *
 *   错误信息其实早就写了正确做法：「请复用外层事务」。
 *
 * ★ 这个包装让两套做法**共存且语义正确**：
 *   - 有外层事务时复用（handler 场景）；
 *   - 没有时自己开（定时任务、脚本、测试等直接调 store 的场景）。
 */
export function reuseOrBeginTransaction<T>(db: { transaction<R>(fn: () => Promise<R>): Promise<R> }, fn: () => Promise<T>): Promise<T> {
  return inTransaction() ? fn() : db.transaction(async () => fn());
}
