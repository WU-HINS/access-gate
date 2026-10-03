/**
 * 巡检编排（M2-6 / M2-7）—— 把四层串成一个**可重复运行**的循环。
 *
 * ```
 *   for 每个策略（该站点、已启用）:
 *     ① 取主体 + 事实快照（过期即缺失）
 *     ② 策略求值（三态）→ 生命周期迁移（H1/H2）
 *     ③ 若迁移产生动作意图 → 生成 ActionPlan（actionSeq 幂等键）
 *     ④ 执行（幂等命中则跳过）→ 回读验证
 *     ⑤ 落状态 + 落评估记录 + 发领域事件
 * ```
 *
 * ★ 本模块的三条设计约束（都来自前面已落地的机制，这里只是把它们串起来）：
 *
 * 1. **幂等靠 actionSeq，不靠时间**：`actionSeq` 只在**真正要发动作**时递增
 *    （见 `lifecycle.transition`）。因此重复巡检 10 次不会产生 10 个不同幂等键——
 *    这正是「重复巡检 10 次，下游无额外会话吊销」的技术基础。
 *
 * 2. **`indeterminate` 一律不产生动作**：编排层不得把三态「压平」成布尔。
 *    它只做搬运，判断留给 `lifecycle`（那里有 H1 的不变量断言）。
 *
 * 3. **单飞**：同一站点的巡检由调度器保证串行（复用 `src/kernel/scheduler.ts`）。
 *    并发巡检会让「读状态 → 迁移 → 写状态」变成竞态。
 */

import type { Logger } from '../kernel/logger.ts';
import type { EventBus } from '../kernel/events.ts';
import { currentTraceId } from '../kernel/logger.ts';

import type { PolicyDocument } from '../policy/model.ts';
import { evaluatePolicy, type PolicyDecision } from '../policy/evaluator.ts';
import { collectFactSnapshot, type FactSnapshot } from '../policy/eligibility.ts';
import type { FactStore } from '../plugin/host-api.ts';

import type { AppMetrics } from '../kernel/metrics.ts';

import { transition, type LifecyclePolicy, type LifecycleSnapshot } from './lifecycle.ts';
import type { BaselineKey, LifecycleStateEntry, LifecycleStateStore } from './lifecycle-store-type.ts';

export type { LifecycleStateStore } from './lifecycle-store-type.ts';
import type { ActionExecutor, PlanOutcome } from './action-executor.ts';

// ─────────────────────────── 依赖接口 ───────────────────────────

/** 待巡检的主体（来自 `ag_external_subjects` 的镜像） */
export interface PatrolSubject {
  externalId: string;
  email: string | null;
  emailVerified: boolean;
  attributes: Record<string, unknown>;
}

export interface SubjectDirectory {
  /** 列出该站点下未删除的主体（分页由实现方决定；此处返回全部或分批） */
  list(siteId: string, limit: number, offset: number): Promise<PatrolSubject[]>;
  count(siteId: string): Promise<number>;
}

export class InMemoryLifecycleStateStore implements LifecycleStateStore {
  private readonly states = new Map<string, LifecycleSnapshot>();
  /** `policyKey → (actionKey → 首次接管前的原值)` */
  private readonly baselines = new Map<string, Record<string, string>>();
  private key(siteId: string, userId: string, policyCode: string): string {
    return `${siteId}\u0000${userId}\u0000${policyCode}`;
  }
  async get(siteId: string, userId: string, policyCode: string): Promise<LifecycleSnapshot | undefined> {
    const found = this.states.get(this.key(siteId, userId, policyCode));
    return found === undefined ? undefined : { ...found };
  }
  async save(siteId: string, userId: string, policyCode: string, snapshot: LifecycleSnapshot): Promise<void> {
    this.states.set(this.key(siteId, userId, policyCode), { ...snapshot });
  }
  async listByUser(siteId: string, userId: string): Promise<readonly LifecycleStateEntry[]> {
    const prefix = `${siteId}\u0000${userId}\u0000`;
    const entries: LifecycleStateEntry[] = [];
    for (const [key, snapshot] of this.states) {
      if (!key.startsWith(prefix)) continue;
      const policyCode = key.slice(prefix.length);
      // 内存模式下没有 uuid 映射：用 policyCode 充当 policyId（装配层两侧自洽）
      entries.push({ policyId: policyCode, policyCode, state: snapshot.state, snapshot: { ...snapshot } });
    }
    return entries;
  }
  async baselineOf(input: BaselineKey): Promise<string | null> {
    const value = this.baselines.get(this.key(input.siteId, input.userId, input.policyCode))?.[
      input.actionKey
    ];
    return value === undefined ? null : value;
  }
  async rememberBaseline(input: BaselineKey & { value: string }): Promise<void> {
    const key = this.key(input.siteId, input.userId, input.policyCode);
    const record = { ...(this.baselines.get(key) ?? {}) };
    // ★ 幂等：仅当为空时写（见类型契约——被覆盖就不再是「接管前」的原值）
    if (record[input.actionKey] !== undefined) return;
    record[input.actionKey] = input.value;
    this.baselines.set(key, record);
  }
}

/** 评估记录存储（`ag_evaluations` 的抽象；用于「历史评估可复现」） */
export interface EvaluationRecord {
  siteId: string;
  userId: string;
  policyCode: string;
  policyVersion: number;
  decision: PolicyDecision;
  /** 触发来源（对应 `ag_eval_trigger`）；巡检默认 `scheduled` */
  trigger?: 'login' | 'binding' | 'manual' | 'scheduled' | 'webhook' | 'admin';
  /** 参与判定的输入事实快照指纹（可复现的关键） */
  factFingerprint: string;
  inputs: Record<string, unknown>;
  missing: readonly string[];
  evaluatedAt: Date;
  traceId?: string;
}

export interface EvaluationStore {
  /**
   * 追加一条评估记录，**返回它的 id**。
   *
   * ★ 为什么必须返回 id：`ag_user_policy_state.last_eval_id` 的语义是
   *   「这个状态是**依据哪次评估**得出的」——拿不到 id，"状态回溯到依据"就做不到
   *   （排障时只能看"现在是什么状态"，**答不出"为什么会变成这样"**）。
   *   （本列此前**零引用**，见 `reports/state-columns-audit.md`。）
   */
  append(record: EvaluationRecord): Promise<{ id: number } | null>;
  count(siteId: string): Promise<number>;
}

export class InMemoryEvaluationStore implements EvaluationStore {
  readonly records: EvaluationRecord[] = [];
  #nextId = 1;
  async append(record: EvaluationRecord): Promise<{ id: number } | null> {
    const id = this.#nextId;
    this.#nextId += 1;
    this.records.push(record);
    return { id };
  }
  async count(siteId: string): Promise<number> {
    return this.records.filter((r) => r.siteId === siteId).length;
  }
}

/** 动作计划构建器（由 `ActionExecutor.buildPlan` 提供；抽象出来便于测试替身） */
export interface PlanBuilder {
  buildPlan(input: {
    siteId: string;
    userId: string;
    policyId: string;
    actionSeq: number;
    actions: readonly { action: string; params?: Record<string, unknown>; optional?: boolean }[];
    traceId?: string;
  }): Parameters<ActionExecutor['execute']>[0];
}

// ─────────────────────────── 巡检结果 ───────────────────────────

export interface PatrolSubjectOutcome {
  externalId: string;
  policyCode: string;
  decision: PolicyDecision;
  stateBefore: LifecycleSnapshot['state'];
  stateAfter: LifecycleSnapshot['state'];
  changed: boolean;
  actionIntent: 'grant' | 'revoke' | 'none';
  /** 若产生了动作，这里是执行结论 */
  planOutcome?: PlanOutcome;
  /** 幂等命中（未触达下游）的动作数 */
  idempotentHits: number;
}

export interface PatrolReport {
  siteId: string;
  startedAt: Date;
  finishedAt: Date;
  policies: number;
  subjects: number;
  /** 逐主体逐策略的结论 */
  outcomes: PatrolSubjectOutcome[];
  stats: {
    satisfied: number;
    unsatisfied: number;
    indeterminate: number;
    notApplicable: number;
    error: number;
    stateChanged: number;
    actionsExecuted: number;
    /** ★ 幂等命中次数：这是「重复巡检无额外写回」的直接度量 */
    idempotentHits: number;
    /** 回读未达成目标状态的次数（必须告警） */
    verifyFailed: number;
  };
  /** 本轮失败的策略求值（decision=error），需人工看配置 */
  errors: { externalId: string; policyCode: string; message: string }[];
}

export interface PatrolOptions {
  siteId: string;
  policies: readonly PolicyDocument[];
  directory: SubjectDirectory;
  facts: FactStore;
  /** 每个插件要读的事实字段（用于建快照） */
  factSources: readonly { pluginId: string; fields: readonly string[]; ttl?: string }[];
  states: LifecycleStateStore;
  evaluations: EvaluationStore;
  lifecycle: LifecyclePolicy;
  executor: ActionExecutor;
  bus?: EventBus;
  logger?: Logger;
  /** 单批主体数（分页巡检，避免一次加载全部） */
  batchSize?: number;
  /** 单轮最多处理主体数（保护性上限；0 表示不限制） */
  maxSubjects?: number;
  now?: () => Date;
  /** 指标集（M6-1）；未提供则不打点（单测与脚本场景） */
  metrics?: AppMetrics;
  /**
   * 事务包裹器。
   *
   * ★ 为什么必需：一次状态迁移要**原子**地完成
   *   「读状态 → 迁移 → 写状态 → 写评估记录」四步。
   *   若分开提交，进程在中间崩溃会留下「状态已改但评估记录缺失」
   *   （复盘失去依据）或反之。
   *   在 DB 模式下，`Db.query` 本身有「必须在事务内」的断言——
   *   不提供此包裹器时巡检**根本跑不起来**（真实接线时暴露）。
   *   内存模式可省略（无事务语义）。
   */
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
}

// ─────────────────────────── 巡检器 ───────────────────────────

export class Patrol {
  private readonly options: PatrolOptions;
  private readonly logger: Logger | undefined;
  private readonly now: () => Date;

  constructor(options: PatrolOptions) {
    this.options = options;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  /** 有事务包裹器就用，没有就直接执行（内存模式）。 */
  async #withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const wrapper = this.options.transaction;
    return wrapper === undefined ? fn() : wrapper(fn);
  }

  /**
   * 跑一轮巡检。
   *
   * 幂等性质：对同一主体同一策略，只要判定结论与上次相同、且状态未迁移，
   * `actionSeq` 不变 → 幂等键不变 → 执行器命中日志直接跳过（**不触达下游**）。
   */
  async runOnce(): Promise<PatrolReport> {
    const startedAt = this.now();
    const { siteId, policies, directory, states, evaluations, lifecycle, executor } = this.options;
    const batchSize = this.options.batchSize ?? 200;
    const maxSubjects = this.options.maxSubjects ?? 0;
    const traceId = currentTraceId();

    const outcomes: PatrolSubjectOutcome[] = [];
    const errors: PatrolReport['errors'] = [];
    const stats: PatrolReport['stats'] = {
      satisfied: 0,
      unsatisfied: 0,
      indeterminate: 0,
      notApplicable: 0,
      error: 0,
      stateChanged: 0,
      actionsExecuted: 0,
      idempotentHits: 0,
      verifyFailed: 0,
    };

    let offset = 0;
    let processed = 0;
    let total = 0;

    for (;;) {
      // ★★ 取数也**必须**在事务内：真实 PG 模式下 `directory.list()` 通常会查主体表
      //   （serve.ts 的实现会调 `storage.subjects.listExternalIds()` / `.get()`）。
      //   早期只有「单个主体的处理」被 `#withTransaction` 包住，而分页取数在事务外
      //   → 巡检**执行即失败**：
      //
      //     巡检执行失败：拒绝在事务外执行 query（TransactionRequiredError）
      //
      //   表现极具迷惑性：作业注册成功、`run_count` 也 +1，但 `status=failed`、
      //   随后进入退避 → **巡检从未真正跑完过一轮**；而启动横幅只说「巡检已启动」。
      const batch = await this.#withTransaction(async () => directory.list(siteId, batchSize, offset));
      if (batch.length === 0) break;
      total += batch.length;

      for (const subject of batch) {
        processed += 1;
        if (maxSubjects > 0 && processed > maxSubjects) break;

        // 事实快照：**过期即缺失**（不返回陈旧值）。
        // ★ 必须按**主体**读：事实的键含 user_id（见 FactStore 的说明）。
        //   早期这里漏传 userId，导致所有主体读到同一份（默认主体）的事实——
        //   在多主体场景下是严重的正确性缺陷（所有人共享一份事实）。
        const collection = await collectFactSnapshot(
          this.options.facts,
          this.options.factSources,
          this.now(),
          // ★ 参数顺序：`(store, sources, now, userId, logger?)`——
          //   主体在前（**必填**），日志在后（可选）。
          //   ★ 这里原本是 `(logger, subject.externalId)` 的顺序；
          //     为了把 userId 变成**必填**（去掉 'platform' 默认值），顺序调整为
          //     `(..., userId, logger?)`。语义不变。
          subject.externalId,
          this.logger,
        );
        const snapshot: FactSnapshot = collection.snapshot;
        const factFingerprint = fingerprintFacts(snapshot);

        // ★ 同一主体的所有策略在**一个事务**内完成（读状态→迁移→写状态→写评估）：
        //   否则进程在中间崩溃会留下「状态已改但评估记录缺失」，复盘失去依据。
        const subjectOutcomes = await this.#withTransaction(async () => {
        const collected: PatrolSubjectOutcome[] = [];
        for (const policy of policies) {
          const evaluation = evaluatePolicy({
            policy,
            context: {
              facts: (namespace, path) => snapshot.values[`fact.${namespace}.${path}`],
              // ★ P5 ②：巡检写下的评估记录里，结果树的叶子要能回答「依据是多久前采的」
              ...(snapshot.collectedAt === undefined
                ? {}
                : {
                    factCollectedAt: (fullPath: string) => snapshot.collectedAt?.[fullPath],
                  }),
              user: {
                email: subject.email,
                email_verified: subject.emailVerified,
                status: subject.attributes['status'] === 2 ? 'suspended' : 'active',
                tags: subject.attributes['tags'] ?? [],
              },
              bindings: {},
              now: this.now(),
            },
          });

          switch (evaluation.decision) {
            case 'satisfied': stats.satisfied += 1; break;
            case 'unsatisfied': stats.unsatisfied += 1; break;
            case 'indeterminate': stats.indeterminate += 1; break;
            case 'not_applicable': stats.notApplicable += 1; break;
            case 'error':
              stats.error += 1;
              errors.push({ externalId: subject.externalId, policyCode: policy.code, message: evaluation.error ?? '未知求值异常' });
              break;
          }

          const previous = (await states.get(siteId, subject.externalId, policy.code)) ?? {
            state: 'unknown' as const,
            stateChangedAt: startedAt,
            atRiskCount: 0,
            actionSeq: 0,
          };
          // ★★ **先落库评估、再迁移状态**：`lastEvalId` 要记「这个状态依据哪次评估」，
          //   所以必须在迁移**之前**拿到评估 id（顺序反了就只能记 null）。
          const appended = await evaluations.append({
            siteId,
            userId: subject.externalId,
            policyCode: policy.code,
            policyVersion: policy.version ?? 0,
            decision: evaluation.decision,
            factFingerprint,
            inputs: { facts: snapshot.values, attributes: subject.attributes },
            missing: evaluation.missing,
            evaluatedAt: this.now(),
            ...(traceId === undefined ? {} : { traceId }),
          });
          const migration = transition(
            previous,
            {
              kind: 'evaluated',
              decision: evaluation.decision,
              at: this.now(),
              // ★ `null` = 没有落库（如 `not_applicable`）→ **不写** `lastEvalId`
              //   （写哨兵值会让状态指向一次不存在的评估）
              ...(appended === null ? {} : { evalId: appended.id }),
            },
            lifecycle,
          );

          const outcome: PatrolSubjectOutcome = {
            externalId: subject.externalId,
            policyCode: policy.code,
            decision: evaluation.decision,
            stateBefore: previous.state,
            stateAfter: migration.next.state,
            changed: migration.changed,
            actionIntent: migration.actionIntent,
            idempotentHits: 0,
          };

          if (migration.changed) {
            stats.stateChanged += 1;
            this.options.metrics?.patrolStateTransitions.inc({ siteId, from: previous.state, to: migration.next.state });
          }

          // 只有真正要发动作时才生成计划并执行
          if (migration.actionIntent !== 'none') {
            const actions = migration.actionIntent === 'grant'
              ? evaluation.actions
              : policy.spec.actions?.onUnsatisfied ?? [];
            if (actions.length > 0) {
              const plan = executor.buildPlan({
                siteId,
                userId: subject.externalId,
                policyId: policy.code,
                actionSeq: migration.next.actionSeq,
                actions: actions.map((a) => ({ action: a.action, params: a.params ?? {} })),
                ...(traceId === undefined ? {} : { traceId }),
              });
              const actionStartedAt = this.now();
              const planOutcome = await executor.execute(plan);
              const metrics = this.options.metrics;
              if (metrics !== undefined) {
                metrics.actionDuration.observe((this.now().getTime() - actionStartedAt.getTime()) / 1_000, {
                  siteId,
                  policy: policy.code,
                });
                for (const step of planOutcome.steps) {
                  metrics.actionsTotal.inc({ siteId, action: step.action, status: step.status });
                  if (step.idempotentHit === true) metrics.actionSkipped.inc({ siteId, reason: 'idempotent_hit' });
                  else if (step.reason !== undefined) metrics.actionSkipped.inc({ siteId, reason: step.reason });
                }
              }
              outcome.planOutcome = planOutcome;
              outcome.idempotentHits = planOutcome.steps.filter((s) => s.idempotentHit === true).length;
              stats.idempotentHits += outcome.idempotentHits;
              stats.actionsExecuted += planOutcome.steps.filter((s) => s.idempotentHit !== true).length;
              stats.verifyFailed += planOutcome.steps.filter((s) => s.verified === false).length;
            }
          }

          await states.save(siteId, subject.externalId, policy.code, migration.next);
          // ★ 评估记录已在上面（迁移**之前**）落库——那里拿到了 `id` 用于 `lastEvalId`。

          // 领域事件（订阅者失败不影响巡检）
          if (this.options.bus !== undefined && migration.changed) {
            await this.options.bus.emitSafely({
              type: 'policy.state_changed',
              payload: {
                siteId,
                userId: subject.externalId,
                policyCode: policy.code,
                from: previous.state,
                to: migration.next.state,
                decision: evaluation.decision,
              },
              occurredAt: this.now(),
              ...(traceId === undefined ? {} : { traceId }),
            });
          }

          collected.push(outcome);
        }
        return collected;
        });
        outcomes.push(...subjectOutcomes);
      }

      offset += batch.length;
      if (batch.length < batchSize) break;
      if (maxSubjects > 0 && processed >= maxSubjects) break;
    }

    const finishedAt = this.now();
    const durationSec = (finishedAt.getTime() - startedAt.getTime()) / 1_000;
    const metrics = this.options.metrics;
    if (metrics !== undefined) {
      metrics.patrolDuration.observe(durationSec, { siteId });
      metrics.patrolRuns.inc({ siteId, result: errors.length > 0 ? 'with_errors' : 'ok' });
      metrics.patrolSubjects.inc({ siteId, decision: 'satisfied' }, stats.satisfied);
      metrics.patrolSubjects.inc({ siteId, decision: 'unsatisfied' }, stats.unsatisfied);
      metrics.patrolSubjects.inc({ siteId, decision: 'indeterminate' }, stats.indeterminate);
      metrics.patrolSubjects.inc({ siteId, decision: 'not_applicable' }, stats.notApplicable);
      metrics.patrolSubjects.inc({ siteId, decision: 'error' }, stats.error);
      metrics.patrolIndeterminate.inc({ siteId }, stats.indeterminate);
      if (stats.verifyFailed > 0) metrics.actionVerifyFailed.inc({ siteId }, stats.verifyFailed);
    }
    const report: PatrolReport = {
      siteId,
      startedAt,
      finishedAt,
      policies: policies.length,
      subjects: total,
      outcomes,
      stats,
      errors,
    };
    this.logger?.info('巡检完成', {
      siteId,
      policies: report.policies,
      subjects: report.subjects,
      stateChanged: stats.stateChanged,
      actionsExecuted: stats.actionsExecuted,
      idempotentHits: stats.idempotentHits,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
    return report;
  }
}

/**
 * 事实快照指纹（用于「历史评估可复现」）。
 *
 * 只对**参与判定的值**取指纹，键排序保证稳定——这样「同一输入得到同一结论」可以被机器验证。
 */
export function fingerprintFacts(snapshot: FactSnapshot): string {
  const entries = Object.entries(snapshot.values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = entries.map(([key, value]) => `${key}=${JSON.stringify(value ?? null)}`).join('\u0001');
  // 复用执行器的哈希风格（FNV 风格在此不够，这里用轻量稳定哈希即可，不用于安全用途）
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fp:${hash.toString(16).padStart(8, '0')}:${entries.length}`;
}
