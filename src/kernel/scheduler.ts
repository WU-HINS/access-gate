/**
 * 调度器 + 单飞租约（M0-8）。
 *
 * 需求来源（docs/07 M0-8、docs/02 `ag_jobs`、docs/CHANGELOG.md D18）：
 *   - **单飞（single-flight）**：同一 `jobKey` 在任一时刻只允许一个实例执行；
 *   - **退避**：连续失败按指数退避，避免故障下游被打穿；
 *   - **断点续跑**：`cursor` 持久化（对账器靠它做增量）；
 *   - **租约而非永久锁**：`lockedUntil` 过期即可被抢占——否则进程崩溃会让任务永久卡死。
 *
 * ★ 关于 `pg_advisory_lock`：真正的跨进程互斥需要**多会话**的 PostgreSQL。
 *   本项目在 CI 用 pglite（**单连接嵌入式**，不支持多会话），因此：
 *     - 租约的**正确性语义**（谁持有、过期、抢占）在这里用存储层实现并可测；
 *     - 真实 PG 上的 `pg_advisory_lock` 适配器单独提供（`createPgAdvisoryLock`），
 *       它的双实例抢占**必须在真实 PG 上验证**——见 reports/M0-acceptance.md 的能力限制登记。
 *   我们不把「pglite 里跑通」当成「跨实例抢占已验证」。
 */

import type { Logger } from './logger.ts';

export type JobStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface JobRecord {
  jobKey: string;
  status: JobStatus;
  /** 持有租约的实例 id */
  lockedBy?: string;
  /** 租约到期时间：过期即可被其它实例抢占 */
  lockedUntil?: Date;
  lastRunAt?: Date;
  nextRunAt?: Date;
  runCount: number;
  failCount: number;
  backoffUntil?: Date;
  /** 断点续跑（对账器的增量游标） */
  cursor: Record<string, unknown>;
  lastError?: string;
}

export interface JobStore {
  /**
   * 幂等地登记任务（首次注册时创建记录，`nextRunAt = now` 立即到期）。
   *
   * ★ 为什么必需：`dueJobs` 只返回**已存在**的记录。早期实现里 `register()` 不写存储，
   *   于是新任务永远不在「到期」列表里 → **调度器从不执行任何任务**（静默空转）。
   */
  ensureJob(jobKey: string, now: Date): Promise<void>;
  /** 原子地尝试取得租约；返回 true 表示取得（必须**原子**，否则单飞失效） */
  tryAcquire(jobKey: string, holder: string, leaseMs: number, now: Date): Promise<boolean>;
  /** 续期（长任务；续期失败意味着租约已丢，调用方应尽快停止） */
  renew(jobKey: string, holder: string, leaseMs: number, now: Date): Promise<boolean>;
  /** 释放租约 */
  release(jobKey: string, holder: string): Promise<void>;
  get(jobKey: string): Promise<JobRecord | undefined>;
  /** 记录一次执行结果 */
  recordResult(
    jobKey: string,
    result: {
      status: JobStatus;
      error?: string;
      cursor?: Record<string, unknown>;
      nextRunAt?: Date;
      backoffUntil?: Date;
      /** 记录时间基准（由调度器注入，保证与 runDue 的时间一致、可测） */
      now: Date;
    },
  ): Promise<void>;
  /** 到期可跑的任务（nextRunAt/backoffUntil 已过，且租约可取得） */
  dueJobs(now: Date, limit: number): Promise<JobRecord[]>;
  list(): Promise<JobRecord[]>;
}

function emptyRecord(jobKey: string): JobRecord {
  return { jobKey, status: 'idle', runCount: 0, failCount: 0, cursor: {} };
}

/** 内存实现：单进程语义。用于单测与无 DB 开发模式。 */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  private ensure(jobKey: string): JobRecord {
    let record = this.jobs.get(jobKey);
    if (record === undefined) {
      record = emptyRecord(jobKey);
      this.jobs.set(jobKey, record);
    }
    return record;
  }

  async ensureJob(jobKey: string, now: Date): Promise<void> {
    const record = this.ensure(jobKey);
    if (record.nextRunAt === undefined && record.backoffUntil === undefined) {
      record.nextRunAt = now;
    }
  }

  async tryAcquire(jobKey: string, holder: string, leaseMs: number, now: Date): Promise<boolean> {
    const record = this.ensure(jobKey);
    const lockedUntil = record.lockedUntil?.getTime() ?? 0;
    // 关键：判断与写入之间**没有 await**，因此在本事件循环内是原子的
    if (record.lockedBy !== undefined && record.lockedBy !== holder && lockedUntil > now.getTime()) {
      return false;
    }
    record.lockedBy = holder;
    record.lockedUntil = new Date(now.getTime() + leaseMs);
    record.status = 'running';
    return true;
  }

  async renew(jobKey: string, holder: string, leaseMs: number, now: Date): Promise<boolean> {
    const record = this.ensure(jobKey);
    if (record.lockedBy !== holder) return false;
    record.lockedUntil = new Date(now.getTime() + leaseMs);
    return true;
  }

  async release(jobKey: string, holder: string): Promise<void> {
    const record = this.ensure(jobKey);
    if (record.lockedBy !== holder) return;
    record.lockedBy = undefined;
    record.lockedUntil = undefined;
  }

  async get(jobKey: string): Promise<JobRecord | undefined> {
    return this.jobs.get(jobKey);
  }

  async recordResult(
    jobKey: string,
    result: {
      status: JobStatus;
      error?: string;
      cursor?: Record<string, unknown>;
      nextRunAt?: Date;
      backoffUntil?: Date;
      now: Date;
    },
  ): Promise<void> {
    const record = this.ensure(jobKey);
    record.status = result.status;
    record.runCount += 1;
    if (result.status === 'failed') record.failCount += 1;
    record.lastRunAt = result.now;
    if (result.cursor !== undefined) record.cursor = result.cursor;
    if (result.nextRunAt !== undefined) record.nextRunAt = result.nextRunAt;
    if (result.backoffUntil !== undefined) record.backoffUntil = result.backoffUntil;
    if (result.error !== undefined) record.lastError = result.error;
    else if (result.status === 'succeeded') record.lastError = undefined;
  }

  async dueJobs(now: Date, limit: number): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((r) => {
        if (r.lockedBy !== undefined && (r.lockedUntil?.getTime() ?? 0) > now.getTime()) return false;
        const dueAt = r.backoffUntil ?? r.nextRunAt;
        if (dueAt !== undefined && dueAt.getTime() > now.getTime()) return false;
        return true;
      })
      .slice(0, limit);
  }

  async list(): Promise<JobRecord[]> {
    return [...this.jobs.values()];
  }
}

// ─────────────────────────── 单飞锁抽象 ───────────────────────────

/**
 * 跨进程单飞锁。
 *
 * ★ 双实例抢占的**真实验证**需要多会话 PostgreSQL；pglite 是单连接嵌入式，做不到。
 *   因此这里只定义契约与 PG 适配器，验证状态在 M0 验收报告中如实登记。
 */
export interface SingleFlightLock {
  /** 尝试取锁；立即返回结果（不阻塞等待） */
  tryLock(key: string): Promise<boolean>;
  unlock(key: string): Promise<void>;
}

// ─────────────────────────── 调度器 ───────────────────────────

export interface JobDefinition {
  jobKey: string;
  /** 执行体。抛错 = 失败（走退避）；返回 cursor 可持久化（断点续跑） */
  run: (context: {
    cursor: Record<string, unknown>;
    holder: string;
    /** 本轮调度的**时间基准**（与 runDue 的 now 一致；测试可注入） */
    now: Date;
  }) => Promise<{ cursor?: Record<string, unknown> } | void>;
  /** 正常情况下的下次运行间隔（毫秒） */
  intervalMs: number;
  /** 租约时长（毫秒）。应大于任务最长预期耗时 */
  leaseMs?: number;
  /** 失败退避基数与上限 */
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  /** 连续失败达到该次数后停止调度（进入 failed，需人工介入） */
  maxConsecutiveFailures?: number;
}

export interface SchedulerOptions {
  store: JobStore;
  logger?: Logger;
  /** 实例标识（多实例部署时用于租约归属） */
  holder?: string;
  /** 默认租约时长 */
  defaultLeaseMs?: number;
  /**
   * 事务包裹器。
   *
   * ★ 为什么必需：调度器的每次存储交互都是**独立的短操作**
   *   （`ensureJob` 一条 INSERT、`tryAcquire` 一条 UPDATE、`recordResult` 一条 UPDATE），
   *   它们天然原子，但**不在业务事务内**。
   *   而 DB 适配器（`DbJobStore`）经 `Db.query` 调用，后者有「必须在事务内」的断言——
   *   不提供此包裹器时，真实 PG 模式下**调度器一注册就抛
   *   `TransactionRequiredError`**（真实接线时暴露）。
   *   内存模式可省略。
   */
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface RunSummary {
  jobKey: string;
  outcome: 'succeeded' | 'failed' | 'skipped' | 'lease-lost';
  error?: string;
  durationMs: number;
}

export class Scheduler {
  private readonly store: JobStore;
  private readonly logger: Logger | undefined;
  private readonly holder: string;
  private readonly defaultLeaseMs: number;
  private readonly transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly running = new Set<string>();
  private closed = false;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.transaction = options.transaction ?? (<T>(fn: () => Promise<T>): Promise<T> => fn());
    this.logger = options.logger;
    this.holder = options.holder ?? `instance-${process.pid}`;
    this.defaultLeaseMs = options.defaultLeaseMs ?? 60_000;
  }

  /**
   * 注册任务并**在存储里登记**（幂等）。
   *
   * ★ 必须写存储：否则 `dueJobs` 看不到它，任务永远不会被调度
   *   （这个缺陷曾让「调度器跑通」变成假象——测试里 runDue 一直返回空数组）。
   */
  async register(definition: JobDefinition, now = new Date()): Promise<void> {
    if (this.jobs.has(definition.jobKey)) {
      throw new Error(`任务 ${definition.jobKey} 已注册（jobKey 必须唯一）`);
    }
    this.jobs.set(definition.jobKey, definition);
    await this.transaction(() => this.store.ensureJob(definition.jobKey, now));
  }

  get instanceId(): string {
    return this.holder;
  }

  /** 执行到期任务一轮。返回每个任务的结论。 */
  async runDue(now = new Date(), limit = 20): Promise<RunSummary[]> {
    if (this.closed) throw new Error('调度器已关闭');
    const due = await this.transaction(() => this.store.dueJobs(now, limit));
    const summaries: RunSummary[] = [];

    for (const record of due) {
      const definition = this.jobs.get(record.jobKey);
      if (definition === undefined) continue; // 本实例未注册该任务（多实例分工）
      if (this.running.has(record.jobKey)) {
        summaries.push({ jobKey: record.jobKey, outcome: 'skipped', durationMs: 0 });
        continue;
      }

      const leaseMs = definition.leaseMs ?? this.defaultLeaseMs;
      const acquired = await this.transaction(() => this.store.tryAcquire(record.jobKey, this.holder, leaseMs, now));
      if (!acquired) {
        summaries.push({ jobKey: record.jobKey, outcome: 'lease-lost', durationMs: 0 });
        continue;
      }

      this.running.add(record.jobKey);
      const startedAt = Date.now();
      try {
        const result = await definition.run({ cursor: record.cursor, holder: this.holder, now });
        const nextRunAt = new Date(now.getTime() + definition.intervalMs);
        await this.transaction(() =>
          this.store.recordResult(record.jobKey, {
            status: 'succeeded',
            nextRunAt,
            now,
            ...(result !== undefined && result !== null && result.cursor !== undefined ? { cursor: result.cursor } : {}),
          }),
        );
        this.logger?.info('任务执行成功', { jobKey: record.jobKey, durationMs: Date.now() - startedAt });
        summaries.push({ jobKey: record.jobKey, outcome: 'succeeded', durationMs: Date.now() - startedAt });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failures = (await this.transaction(() => this.store.get(record.jobKey)))?.failCount ?? 0;
        const attempt = failures + 1;
        const maxFailures = definition.maxConsecutiveFailures ?? Number.POSITIVE_INFINITY;
        if (attempt >= maxFailures) {
          await this.transaction(() => this.store.recordResult(record.jobKey, { status: 'failed', error: message, now }));
          this.logger?.error('任务连续失败达上限，停止调度（需人工介入）', { jobKey: record.jobKey, attempt, error: message });
        } else {
          const base = definition.backoffBaseMs ?? 1_000;
          const cap = definition.maxBackoffMs ?? 300_000;
          const delay = Math.min(base * 2 ** Math.max(0, attempt - 1), cap);
          await this.transaction(() =>
            this.store.recordResult(record.jobKey, {
              status: 'failed',
              error: message,
              backoffUntil: new Date(now.getTime() + delay),
              now,
            }),
          );
          this.logger?.warn('任务执行失败，将退避重试', { jobKey: record.jobKey, attempt, delayMs: delay, error: message });
        }
        summaries.push({ jobKey: record.jobKey, outcome: 'failed', error: message, durationMs: Date.now() - startedAt });
      } finally {
        this.running.delete(record.jobKey);
        await this.transaction(() => this.store.release(record.jobKey, this.holder));
      }
    }
    return summaries;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.jobs.clear();
  }
}
