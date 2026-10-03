/**
 * 事件总线 + 事务性发件箱（M0-8）。
 *
 * 为什么不是「一个 EventEmitter 就够」：
 *
 *   业务动作与副作用的**原子性**是硬需求。以「策略发布」为例，若先写库再 emit，
 *   进程在两者之间崩溃 → 策略已生效但下游动作从未被触发，且**无人知道**。
 *   正确做法是 **transactional outbox**（02/05 都承诺了 `ag_event_outbox`）：
 *   事件与业务写入在**同一事务**里落库，再由投递器异步消费 → 至少一次投递，
 *   且「未投递」这件事是可查的（不会静默丢失）。
 *
 * 本模块把两种形态分开：
 *   - `EventBus`      —— 进程内同步分发（订阅者错误不会影响发布者，逐个隔离）；
 *   - `OutboxStore`   —— 发件箱存储接口（内存实现供测试；DB 实现见 db-outbox.ts）。
 *
 * ⚠ `ag_event_outbox` / `ag_dead_letters` 在 `docs/02` 中**没有声明**（05 §7.1.2 承诺了它们）。
 *   本模块只依赖接口，不伪造表；等声明补齐后再接 DB 实现。
 */

import type { Logger } from './logger.ts';

export interface DomainEvent<T = unknown> {
  /** 事件类型：`policy.published` / `identity.linked` / `grant.revoked` … */
  type: string;
  /** 事件负载（必须可 JSON 序列化） */
  payload: T;
  /** 关联四元组：traceId 贯通 HTTP → 后台任务（与 ag_actions_log.traceId 对齐） */
  traceId?: string;
  /** 发生时间 */
  occurredAt: Date;
}

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => void | Promise<void>;

interface Subscription {
  pattern: string;
  handler: EventHandler<never>;
  once: boolean;
}

/** 通配符匹配：`policy.*` 匹配 `policy.published`；`*` 匹配全部。 */
export function matchesPattern(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === type;
  const parts = pattern.split('*');
  let cursor = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part.length === 0) continue;
    const found = type.indexOf(part, cursor);
    if (found < 0) return false;
    if (i === 0 && !pattern.startsWith('*') && found !== 0) return false;
    cursor = found + part.length;
  }
  const lastPart = parts[parts.length - 1]!;
  if (lastPart.length > 0 && !pattern.endsWith('*')) {
    if (!type.endsWith(lastPart)) return false;
  }
  return true;
}

export interface EventBusOptions {
  logger?: Logger;
  /** 单个订阅者抛错时的钩子（默认只记日志） */
  onHandlerError?: (error: unknown, event: DomainEvent) => void;
}

export class EventBus {
  private readonly subscriptions: Subscription[] = [];
  private readonly logger: Logger | undefined;
  private readonly onHandlerError: ((error: unknown, event: DomainEvent) => void) | undefined;

  constructor(options: EventBusOptions = {}) {
    this.logger = options.logger;
    this.onHandlerError = options.onHandlerError;
  }

  on<T>(pattern: string, handler: EventHandler<T>): () => void {
    const subscription: Subscription = { pattern, handler: handler as EventHandler<never>, once: false };
    this.subscriptions.push(subscription);
    return () => {
      const index = this.subscriptions.indexOf(subscription);
      if (index >= 0) this.subscriptions.splice(index, 1);
    };
  }

  once<T>(pattern: string, handler: EventHandler<T>): () => void {
    const subscription: Subscription = { pattern, handler: handler as EventHandler<never>, once: true };
    this.subscriptions.push(subscription);
    return () => {
      const index = this.subscriptions.indexOf(subscription);
      if (index >= 0) this.subscriptions.splice(index, 1);
    };
  }

  /**
   * 分发事件。两条语义**同时**成立，缺一不可：
   *
   *   ① **隔离**：所有订阅者都会被尝试，一个抛错不影响其它订阅者（否则一个坏插件
   *      就能让整条事件链静默中断）；
   *   ② **可见**：全部跑完后，若存在失败则以 `AggregateError` 抛出。
   *
   * ★ ② 是必须的：发件箱投递器**依赖异常**来判定「投递失败 → 退避重试」。
   *   早期版本只做 ①，异常被吞掉 → 投递器以为成功 → 事件被标记 delivered 而实际没送达，
   *   且**永远不会重试**（静默丢事件）。这类「隔离过头」比不隔离更危险。
   *
   * 不关心失败的调用方可用 `emitSafely()`（内部吞掉聚合异常并记日志）。
   */
  async emit<T>(event: DomainEvent<T>): Promise<void> {
    const matched = this.subscriptions.filter((s) => matchesPattern(s.pattern, event.type));
    const failures: unknown[] = [];
    for (const subscription of matched) {
      if (subscription.once) {
        const index = this.subscriptions.indexOf(subscription);
        if (index >= 0) this.subscriptions.splice(index, 1);
      }
      try {
        await (subscription.handler as EventHandler<T>)(event);
      } catch (error) {
        this.logger?.error('事件订阅者抛错（已隔离，继续执行其它订阅者）', {
          eventType: event.type,
          pattern: subscription.pattern,
          error: error instanceof Error ? error.message : String(error),
        });
        this.onHandlerError?.(error, event as DomainEvent);
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `事件 ${event.type} 有 ${failures.length} 个订阅者失败（已全部尝试；聚合抛出以便投递器退避重试）`,
      );
    }
  }

  /** 不关心订阅者失败的场景（例如「通知一下」）：吞掉聚合异常，只留日志。 */
  async emitSafely<T>(event: DomainEvent<T>): Promise<void> {
    try {
      await this.emit(event);
    } catch {
      // 已在 emit 内记日志
    }
  }

  subscriberCount(): number {
    return this.subscriptions.length;
  }

  clear(): void {
    this.subscriptions.length = 0;
  }
}

// ─────────────────────────── 发件箱 ───────────────────────────

export type OutboxStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export interface OutboxRecord {
  id: string;
  type: string;
  payload: unknown;
  traceId?: string;
  status: OutboxStatus;
  attempts: number;
  availableAt: Date;
  lastError?: string;
  createdAt: Date;
}

export interface OutboxStore {
  /** 与业务写入同事务落库（实现方保证原子性） */
  append(event: DomainEvent): Promise<void>;
  /** 取到期可投递的记录（投递器轮询） */
  claimDue(limit: number, now: Date): Promise<OutboxRecord[]>;
  markDelivered(id: string): Promise<void>;
  markRetry(id: string, nextAvailableAt: Date, error: string): Promise<void>;
  markDead(id: string, error: string): Promise<void>;
  /** 死信列表（运维可见；对应 ag_dead_letters） */
  deadLetters(): Promise<OutboxRecord[]>;
  size(): Promise<number>;
}

/** 内存实现：用于单测与「无 DB」的开发模式。 */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly records = new Map<string, OutboxRecord>();
  private seq = 0;

  async append(event: DomainEvent): Promise<void> {
    const id = `evt-${++this.seq}`;
    this.records.set(id, {
      id,
      type: event.type,
      payload: event.payload,
      ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
      status: 'pending',
      attempts: 0,
      availableAt: event.occurredAt,
      createdAt: event.occurredAt,
    });
  }

  async claimDue(limit: number, now: Date): Promise<OutboxRecord[]> {
    const due = [...this.records.values()]
      .filter((r) => (r.status === 'pending' || r.status === 'failed') && r.availableAt.getTime() <= now.getTime())
      .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
      .slice(0, limit);
    return due;
  }

  async markDelivered(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record !== undefined) record.status = 'delivered';
  }

  async markRetry(id: string, nextAvailableAt: Date, error: string): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) return;
    record.status = 'failed';
    record.attempts += 1;
    record.availableAt = nextAvailableAt;
    record.lastError = error;
  }

  async markDead(id: string, error: string): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) return;
    record.status = 'dead';
    record.attempts += 1;
    record.lastError = error;
  }

  async deadLetters(): Promise<OutboxRecord[]> {
    return [...this.records.values()].filter((r) => r.status === 'dead');
  }

  async size(): Promise<number> {
    return this.records.size;
  }
}

export interface OutboxDeliveryOptions {
  store: OutboxStore;
  bus: EventBus;
  logger?: Logger;
  /** 最大尝试次数，超过即进入死信 */
  maxAttempts?: number;
  /** 退避基数（毫秒）：第 n 次重试等待 base * 2^(n-1)，并封顶 maxBackoffMs */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * 指数退避（含封顶）。第 1 次重试 = base，第 2 次 = 2*base …
 *
 * ⚠ attempts 是**本次失败后累计的失败次数**（从 1 开始）。注意别在调用点写成 `attempts+1`，
 *   否则退避会整体多翻一倍（这个 off-by-one 曾导致单测里的「退避期内」断言失败）。
 */
export function backoffDelay(attempts: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * 投递器：把发件箱里的待投递事件转成进程内事件。
 *
 * 语义：**至少一次**（at-least-once）——投递成功才标记 delivered；
 * 失败则按指数退避重试，超过 maxAttempts 进死信（**不静默丢弃**）。
 */
export class OutboxDispatcher {
  private readonly store: OutboxStore;
  private readonly bus: EventBus;
  private readonly logger: Logger | undefined;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(options: OutboxDeliveryOptions) {
    this.store = options.store;
    this.bus = options.bus;
    this.logger = options.logger;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  /** 投递一批到期事件；返回本批统计。 */
  async dispatchDue(limit = 50, now = new Date()): Promise<{ delivered: number; retried: number; dead: number }> {
    const due = await this.store.claimDue(limit, now);
    let delivered = 0;
    let retried = 0;
    let dead = 0;

    for (const record of due) {
      const event: DomainEvent = {
        type: record.type,
        payload: record.payload,
        occurredAt: record.createdAt,
        ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
      };
      try {
        await this.bus.emit(event);
        await this.store.markDelivered(record.id);
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (record.attempts + 1 >= this.maxAttempts) {
          await this.store.markDead(record.id, message);
          this.logger?.error('事件进入死信（超过最大重试次数）', { eventId: record.id, type: record.type, error: message });
          dead += 1;
        } else {
          // attempts 此刻仍为「历史失败次数」；本次失败后累计为 attempts+1
          const delay = backoffDelay(record.attempts + 1, this.baseBackoffMs, this.maxBackoffMs);
          await this.store.markRetry(record.id, new Date(now.getTime() + delay), message);
          this.logger?.warn('事件投递失败，将退避重试', { eventId: record.id, type: record.type, delayMs: delay });
          retried += 1;
        }
      }
    }
    return { delivered, retried, dead };
  }
}
