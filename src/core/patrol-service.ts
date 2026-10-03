/**
 * 巡检服务（M2-6 接线）—— 把巡检循环接进调度器并对外暴露可观测状态。
 *
 * ★ 三件必须做对的事：
 *
 * 1. **单飞（两层）**：
 *    - **跨实例**：调度器的 `tryAcquire` 租约（真实 PG 上用条件更新 + RETURNING 原子抢锁，
 *      已在真实 PG 上验证「两个实例只有一个取到」）；
 *    - **同进程内**：`runOnce()` 可能被管理端手动触发，与调度任务并发。
 *      这一层必须自己保证——否则同一进程的两个巡检会同时读同一状态再各自迁移，
 *      造成 `actionSeq` 双递增（**凭空产生新幂等键 → 重复写下游**）。
 *
 * 2. **状态可观测**：健康检查需要知道「调度器是否在跑」「是否连续失败」。
 *    没有这个，运维只能看到 `/healthz` 说健康而巡检早已停摆。
 *
 * 3. **失败不吞**：巡检抛错必须记录并计入连续失败数，供 readiness 降级——
 *    而不是在日志里刷一行然后继续假装正常。
 */

import type { Logger } from '../kernel/logger.ts';
import type { EventBus } from '../kernel/events.ts';
import type { Scheduler, JobDefinition } from '../kernel/scheduler.ts';
import type { AppMetrics } from '../kernel/metrics.ts';

import type { PolicyDocument } from '../policy/model.ts';
import type { FactStore } from '../plugin/host-api.ts';

import type { LifecyclePolicy } from './lifecycle.ts';
import type { LifecycleStateStore } from './lifecycle-store-type.ts';
import type { ActionExecutor } from './action-executor.ts';
import { Patrol, type EvaluationStore, type PatrolReport, type SubjectDirectory } from './patrol.ts';

export interface PatrolServiceOptions {
  siteId: string;
  /**
   * 动态取策略。
   *
   * ★ 为什么是函数而不是数组：巡检是**长期运行**的，而策略会被发布/回滚。
   *   若在启动时快照策略，新发布的策略要等重启才生效——这与「发布即生效」的产品语义矛盾。
   */
  policies: () => Promise<readonly PolicyDocument[]>;
  directory: SubjectDirectory;
  facts: FactStore;
  factSources: readonly { pluginId: string; fields: readonly string[]; ttl?: string }[];
  states: LifecycleStateStore;
  evaluations: EvaluationStore;
  lifecycle: LifecyclePolicy;
  executor: ActionExecutor;
  scheduler: Scheduler;
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  bus?: EventBus;
  logger?: Logger;
  metrics?: AppMetrics;
  /** 巡检间隔（毫秒）。默认 5 分钟——docs/07 的「常规巡检」档 */
  intervalMs?: number;
  /** 租约时长；应大于单轮最长预期耗时 */
  leaseMs?: number;
  /** 单轮最多处理主体数（保护性上限） */
  maxSubjects?: number;
  now?: () => Date;
}

export interface PatrolStatus {
  /** 调度任务是否已注册（调度器在跑） */
  registered: boolean;
  /** 是否正在执行一轮 */
  running: boolean;
  /** 最近一次完成时间 */
  lastFinishedAt: Date | null;
  /** 最近一次结论 */
  lastOutcome: 'succeeded' | 'failed' | null;
  lastError: string | null;
  /** 连续失败次数（readiness 据此降级） */
  consecutiveFailures: number;
  /** 累计执行轮次 */
  totalRuns: number;
  /** 最近一轮的统计（用于运维快速查看） */
  lastStats: PatrolReport['stats'] | null;
}

/** 连续失败达到该值即认为「巡检已停摆」，readiness 应降级。 */
export const STUCK_FAILURE_THRESHOLD = 3;

export class PatrolService {
  readonly #options: PatrolServiceOptions;
  readonly #logger: Logger | undefined;
  readonly #now: () => Date;
  readonly #jobKey: string;

  /** 进程内互斥（跨实例的单飞由调度器租约保证） */
  #inFlight: Promise<PatrolReport> | undefined;
  #registered = false;
  #lastFinishedAt: Date | null = null;
  #lastOutcome: 'succeeded' | 'failed' | null = null;
  #lastError: string | null = null;
  #consecutiveFailures = 0;
  #totalRuns = 0;
  #lastStats: PatrolReport['stats'] | null = null;

  constructor(options: PatrolServiceOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#jobKey = `patrol.${options.siteId}`;
  }

  get jobKey(): string {
    return this.#jobKey;
  }

  /**
   * 构造一轮巡检器（每轮重新取策略，保证「发布即生效」）。
   *
   * ★★ `policies()` **必须**在事务内调用：
   *   真实 PG 模式下它通常会查策略表（`policyStore.list()` → `db.query`），
   *   而 `db.query` 有 `assertInTransaction` 断言。
   *   早期只把 `transaction` 传给了 `Patrol`（用于 `runOnce` 内部），
   *   于是**这一次调用落在事务外** → 巡检「执行即失败」：
   *
   *     巡检执行失败：拒绝在事务外执行 query（TransactionRequiredError）
   *
   *   后果很隐蔽：作业**注册成功**、`run_count` 也会 +1，
   *   但 `status=failed`、随后进入退避 → **巡检实际上从未真正完成过一轮**。
   *   而启动横幅只显示「巡检已启动」，看不出任何异常。
   */
  /**
   * 用**覆盖后的**策略与目录构造巡检器——供**回滚**复用。
   *
   * ★★★ 为什么需要它（R80）：`core/rollback.ts` 的 `rollbackForSubject` /
   *   `rollbackByPolicy` 需要「切版本后，用**新策略**对**特定主体/全站点**重新求值」，
   *   因此它们要求 `RollbackDeps.buildPatrol({ policies, directory, maxSubjects })`——
   *   而 `PatrolService` 的 `#buildPatrol()` 是**私有且不带参数**的（用 `options.policies()`）。
   *
   *   ★ 当时 `rollbackForSubject` / `rollbackByPolicy` **未接线**（只做了「单条」回滚）。
   *   ★★ **现已接线**（`admin/api.ts` 的回滚端点调用它们）—— 本会话核实并**更正了这条过时注释**。
   *     保留原文是为了记录「为什么需要 `buildPatrolFor`」这个**设计动机**，它依然成立。
   *
   * ★ 本方法**复用** `PatrolService` 的全部依赖（facts / states / evaluations /
   *   lifecycle / executor / 事务包装 / 指标），只覆盖**策略与目录**——
   *   因此回滚路径与巡检路径**共享同一套求值、迁移、执行、幂等逻辑**（这是设计意图：
   *   `RollbackDeps.buildPatrol` 的注释写着「**复用全部**求值/迁移/执行/幂等逻辑」）。
   */
  buildPatrolFor(overrides: {
    policies: readonly PolicyDocument[];
    directory: SubjectDirectory;
    maxSubjects?: number;
  }): Patrol {
    return new Patrol({
      siteId: this.#options.siteId,
      policies: overrides.policies,
      directory: overrides.directory,
      facts: this.#options.facts,
      factSources: this.#options.factSources,
      states: this.#options.states,
      evaluations: this.#options.evaluations,
      lifecycle: this.#options.lifecycle,
      executor: this.#options.executor,
      now: this.#now,
      ...(this.#options.transaction === undefined ? {} : { transaction: this.#options.transaction }),
      ...(this.#options.bus === undefined ? {} : { bus: this.#options.bus }),
      ...(this.#logger === undefined ? {} : { logger: this.#logger }),
      ...(this.#options.metrics === undefined ? {} : { metrics: this.#options.metrics }),
      // ★ `maxSubjects` 由**调用方覆盖**（回滚「按主体」时传 1）
      ...(overrides.maxSubjects === undefined
        ? this.#options.maxSubjects === undefined
          ? {}
          : { maxSubjects: this.#options.maxSubjects }
        : { maxSubjects: overrides.maxSubjects }),
    });
  }

  async #buildPatrol(): Promise<Patrol> {
    const build = async (): Promise<Patrol> => this.#buildPatrolInner();
    return this.#options.transaction === undefined ? build() : this.#options.transaction(build);
  }

  async #buildPatrolInner(): Promise<Patrol> {
    const policies = await this.#options.policies();
    const patrolOptions: ConstructorParameters<typeof Patrol>[0] = {
      siteId: this.#options.siteId,
      policies,
      directory: this.#options.directory,
      facts: this.#options.facts,
      factSources: this.#options.factSources,
      states: this.#options.states,
      evaluations: this.#options.evaluations,
      lifecycle: this.#options.lifecycle,
      executor: this.#options.executor,
      now: this.#now,
      ...(this.#options.transaction === undefined ? {} : { transaction: this.#options.transaction }),
      ...(this.#options.bus === undefined ? {} : { bus: this.#options.bus }),
      ...(this.#logger === undefined ? {} : { logger: this.#logger }),
      ...(this.#options.metrics === undefined ? {} : { metrics: this.#options.metrics }),
      ...(this.#options.maxSubjects === undefined ? {} : { maxSubjects: this.#options.maxSubjects }),
    };
    return new Patrol(patrolOptions);
  }

  /**
   * 跑一轮（**进程内单飞**）。
   *
   * 若已有巡检在跑，返回**同一个 Promise**（调用方等到同一结果），
   * 而不是启动第二轮——这是「同进程并发导致 actionSeq 双递增」的防线。
   */
  async runOnce(): Promise<PatrolReport> {
    if (this.#inFlight !== undefined) {
      this.#logger?.debug('巡检已在执行，复用进行中的一轮', { jobKey: this.#jobKey });
      return this.#inFlight;
    }
    const task = this.#execute();
    this.#inFlight = task;
    try {
      return await task;
    } finally {
      this.#inFlight = undefined;
    }
  }

  async #execute(): Promise<PatrolReport> {
    const startedAt = this.#now();
    this.#totalRuns += 1;
    try {
      const patrol = await this.#buildPatrol();
      const report = await patrol.runOnce();
      this.#lastFinishedAt = this.#now();
      this.#lastOutcome = 'succeeded';
      this.#lastError = null;
      this.#consecutiveFailures = 0;
      this.#lastStats = report.stats;
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastFinishedAt = this.#now();
      this.#lastOutcome = 'failed';
      this.#lastError = message;
      this.#consecutiveFailures += 1;
      // ★ 失败必须留下痕迹：不吞异常、不改状态、计入连续失败数
      this.#logger?.error('巡检执行失败', {
        jobKey: this.#jobKey,
        consecutiveFailures: this.#consecutiveFailures,
        durationMs: this.#now().getTime() - startedAt.getTime(),
        error: message,
      });
      this.#options.metrics?.patrolRuns.inc({ siteId: this.#options.siteId, result: 'failed' });
      throw error;
    }
  }

  /**
   * 注册为调度任务并开始运行。
   *
   * `intervalMs` 是「正常情况下的下次运行间隔」；失败时由调度器做退避
   * （避免「下游全挂时反而更频繁地打」这种反效果）。
   */
  async start(): Promise<void> {
    const definition: JobDefinition = {
      jobKey: this.#jobKey,
      intervalMs: this.#options.intervalMs ?? 5 * 60_000,
      ...(this.#options.leaseMs === undefined ? {} : { leaseMs: this.#options.leaseMs }),
      run: async () => {
        await this.runOnce();
      },
    };
    await this.#options.scheduler.register(definition, this.#now());
    this.#registered = true;
    this.#logger?.info('巡检任务已注册', {
      jobKey: this.#jobKey,
      intervalMs: definition.intervalMs,
      // 不访问 Scheduler 的私有字段：只在显式配置时打印租约
      ...(definition.leaseMs === undefined ? {} : { leaseMs: definition.leaseMs }),
    });
  }

  /** 停止：注销标记 + 等待在途巡检结束（不打断，避免留下半迁移状态）。 */
  async stop(): Promise<void> {
    this.#registered = false;
    if (this.#inFlight !== undefined) {
      this.#logger?.info('等待在途巡检结束', { jobKey: this.#jobKey });
      await this.#inFlight.catch(() => undefined);
    }
  }

  status(): PatrolStatus {
    return {
      registered: this.#registered,
      running: this.#inFlight !== undefined,
      lastFinishedAt: this.#lastFinishedAt,
      lastOutcome: this.#lastOutcome,
      lastError: this.#lastError,
      consecutiveFailures: this.#consecutiveFailures,
      totalRuns: this.#totalRuns,
      lastStats: this.#lastStats,
    };
  }

  /** 供健康检查：巡检是否已停摆（连续失败达阈值）。 */
  isStuck(): boolean {
    return this.#consecutiveFailures >= STUCK_FAILURE_THRESHOLD;
  }
}
