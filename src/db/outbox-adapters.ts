/**
 * 发件箱与死信的 PostgreSQL 适配器 —— 补齐 `ag_event_outbox` / `ag_dead_letters`
 * （目标点名的「表声明与适配器」）。
 *
 * ★ 这两张表此前**在 `docs/02` 中无声明**（缺陷 D-5），而 `docs/05 §7.1.2` 承诺了它们。
 *   后果在文档里写得很清楚：`granted` 事件推送失败会进**不存在的 DLQ（即丢弃）**——
 *   失败被静默吞掉，运维看不到任何异常，而用户在下游失去资格。
 *   本轮先补文档声明（`docs/02 §8.5/§8.6`），再补适配器。
 *
 * ★ 接口与表的一处差异（沿用既有模式解决）：
 *   `OutboxStore` 接口**没有 `siteId`**，而 `ag_event_outbox.siteId` 是 `NOT NULL`。
 *   与 `DbFactStore` / `DbActionLogStore` 一致：**构造时注入 siteId**——
 *   适配器实例天然属于某个站点，不需要每个方法都传。
 *
 * ★ 状态映射（接口 ↔ 表的枚举不同，必须显式说明）：
 *   | 接口 `OutboxStatus` | 表 `ag_outbox_status` |
 *   |---|---|
 *   | `pending` | `pending` |
 *   | `failed`（待重试） | `pending`（表用 `nextAttemptAt` 表达"还没到点"，不另设 failed 态） |
 *   | `delivered` | `delivered` |
 *   | —（不可投递） | `dead` |
 *   即**表没有 `failed` 态**：重试中的事件仍是 `pending`，只是 `attempts` 增长、
 *   `nextAttemptAt` 推后。这比「failed + 单独的 availableAt 判断」少一个不一致来源。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from './pool.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, increment, isNull, lit, lte, type SetValue } from '../query/ast.ts';
import type { DomainEvent, OutboxRecord, OutboxStatus, OutboxStore } from '../kernel/events.ts';

const SITE_SCOPED: TableScopeMeta = { siteScoped: true, hasSiteIdColumn: true };

function jsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  type: string;
  payload: unknown;
  trace_id: string | null;
  status: string;
  attempts: number;
  next_attempt_at: string | Date;
  last_error: string | null;
  created_at: string | Date;
}

interface DeadLetterRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  type: string;
  payload: unknown;
  attempts: number;
  last_error: string;
  failed_at: string | Date;
  created_at: string | Date;
}

/**
 * `ag_event_outbox` 的 PG 实现。
 *
 * ★ `append` 必须与业务写在**同一事务**里（`Db.query` 的 `assertInTransaction`
 *   在运行时强制这一点——调用方无法"忘记"）。
 */
export class DbOutboxStore implements OutboxStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async append(event: DomainEvent): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_event_outbox',
        rows: [
          {
            site_id: this.#siteId,
            // 业务事件 id：接收方按它幂等（投递语义是「至少一次」）。
            // DomainEvent 本身没有 id 字段，这里生成一个稳定的 uuid。
            event_id: randomUUID(),
            type: event.type,
            payload: jsonb(event.payload),
            status: 'pending',
            attempts: 0,
            next_attempt_at: event.occurredAt,
            ...(event.traceId === undefined ? {} : { trace_id: event.traceId }),
            created_at: event.occurredAt,
          },
        ],
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  /** 取到期可投递的记录（只取 `pending`；`delivered`/`dead` 是终态）。 */
  async claimDue(limit: number, now: Date): Promise<OutboxRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_event_outbox',
        columns: ['id', 'type', 'payload', 'trace_id', 'status', 'attempts', 'next_attempt_at', 'last_error', 'created_at'],
        where: and(eq(col('status'), lit('pending')), lte(col('next_attempt_at'), lit(now))),
        orderBy: [{ column: 'next_attempt_at', direction: 'asc' }],
        limit,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<OutboxRow>(compiled.sql, compiled.params);
    return rows.map(rowToOutboxRecord);
  }

  async markDelivered(id: string): Promise<void> {
    const compiled = compile(
      { kind: 'update', table: 'ag_event_outbox', set: { status: 'delivered', delivered_at: new Date() }, where: eq(col('id'), lit(id)) },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async markRetry(id: string, nextAvailableAt: Date, error: string): Promise<void> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_event_outbox',
        set: { attempts: increment('attempts') as unknown as SetValue, next_attempt_at: nextAvailableAt, last_error: error },
        where: eq(col('id'), lit(id)),
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  /**
   * 标记为死信。
   *
   * ★ 必须**同时写入 `ag_dead_letters`**——这正是这张表存在的全部意义：
   *   若只把 outbox 行标成 `dead`，运维就没有「可列出、可重放」的入口，
   *   失败等同于被丢弃（文档描述的真实事故）。
   */
  async markDead(id: string, error: string): Promise<void> {
    // 先读原行（死信需要保留 payload 与累计尝试次数）
    const read = compile(
      {
        kind: 'select',
        table: 'ag_event_outbox',
        columns: ['id', 'type', 'payload', 'attempts'],
        where: eq(col('id'), lit(id)),
        limit: 1,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<OutboxRow>(read.sql, read.params);
    const row = rows[0];
    if (row === undefined) return; // 已被清理：幂等返回

    const update = compile(
      { kind: 'update', table: 'ag_event_outbox', set: { status: 'dead', last_error: error }, where: eq(col('id'), lit(id)) },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(update.sql, update.params);

    const insert = compile(
      {
        kind: 'insert',
        table: 'ag_dead_letters',
        rows: [
          {
            site_id: this.#siteId,
            // 死信用 outbox 行 id 作为 event_id：同一事件重试耗尽只应落一条死信
            event_id: id,
            type: row.type,
            payload: jsonb(row.payload),
            attempts: Number(row.attempts),
            last_error: error,
            failed_at: new Date(),
          },
        ],
        // ★ 幂等：同一事件重复 markDead 不产生多条死信
        onConflict: { columns: ['site_id', 'event_id'], do: 'nothing' },
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(insert.sql, insert.params);
  }

  /** 死信列表（`06 §5.5` 的列表与重放入口的数据源）。 */
  async deadLetters(): Promise<OutboxRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_dead_letters',
        columns: ['id', 'event_id', 'type', 'payload', 'attempts', 'last_error', 'failed_at', 'created_at'],
        where: isNull(col('replayed_at')),
        orderBy: [{ column: 'failed_at', direction: 'desc' }],
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<DeadLetterRow>(compiled.sql, compiled.params);
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload,
      status: 'failed' as OutboxStatus,
      attempts: Number(row.attempts),
      availableAt: toDate(row.failed_at),
      lastError: row.last_error,
      createdAt: toDate(row.created_at),
    }));
  }

  /** 待投递数量（监控「积压」用；只算 pending）。 */
  async size(): Promise<number> {
    const compiled = compile(
      { kind: 'select', table: 'ag_event_outbox', columns: ['id'], where: eq(col('status'), lit('pending')) },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<{ id: string }>(compiled.sql, compiled.params);
    return rows.length;
  }

  /** 标记死信已重放（`06 §5.5` 的重放入口调用）。 */
  async markReplayed(deadLetterId: string, replayedBy: string): Promise<void> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_dead_letters',
        set: { replayed_at: new Date(), replayed_by: replayedBy },
        where: eq(col('id'), lit(deadLetterId)),
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }
}

function rowToOutboxRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
    status: row.status === 'delivered' ? 'delivered' : row.status === 'dead' ? 'failed' : 'pending',
    attempts: Number(row.attempts),
    availableAt: toDate(row.next_attempt_at),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: toDate(row.created_at),
  };
}

/**
 * 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。
 *
 * ★★ R95：`DbOutboxStore` 是本项目**唯一没有自带事务包装**的仓储——
 *   于是它的每个调用方都要自己包事务，而**调用方很容易忘**。
 *   ★ 实测踩到两次：① `eventBus.on('*', …)` 的订阅者里直接 `append`；
 *     ② `OutboxDispatcher.dispatchDue()` 里 `claimDue`。
 *   两次都是 `TransactionRequiredError`（本会话第 10、11 次同类问题）。
 *   ★ 这里补上包装，与 `createTransactionalXxx` 的其它适配器**保持一致**：
 *     **仓储层负责自己的事务边界，调用方不必知道**。
 */
export function createTransactionalOutboxStore(db: Db, siteId: string): OutboxStore {
  const inner = new DbOutboxStore(db, siteId);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    append: (event) => wrap(() => inner.append(event)),
    claimDue: (limit, now) => wrap(() => inner.claimDue(limit, now)),
    markDelivered: (id) => wrap(() => inner.markDelivered(id)),
    markRetry: (id, nextAvailableAt, error) => wrap(() => inner.markRetry(id, nextAvailableAt, error)),
    markDead: (id, error) => wrap(() => inner.markDead(id, error)),
    // ★ `OutboxStore` 还要求这两个（死信列表与待投递计数）
    deadLetters: () => wrap(() => inner.deadLetters()),
    size: () => wrap(() => inner.size()),
  };
}
