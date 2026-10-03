/**
 * 动作执行器（M2-1）—— Plan → Execute → Verify，docs/05 §3。
 *
 * ★ 幂等键的**唯一权威公式**（docs/05 §3.0.1 冻结）：
 *   ```
 *   idempotencyKey = hash(siteId, userId, policyId, actionSeq, action)
 *   ```
 *   文档明确**删除**了 `targetValue`（回到原值会被永久去重）与 `dedupeWindow`
 *   （在 13 份文档中只出现在两行注释里，从未定义）。为什么 `actionSeq` 能同时满足两个相反要求：
 *   - 同一计划的任意次重试复用同一 seq → **不重复执行**；
 *   - 状态再次迁移 → seq 变化 → **回到原值也能重新执行**。
 *
 * ★ 失败处理的分野（docs/05 §3.3）：5xx/超时 → 退避重试；**4xx 不重试**并告警
 *   （那是配置/权限错误，重试无意义，只会放大故障）。
 */

import { createHash } from 'node:crypto';

import type { Logger } from '../kernel/logger.ts';
// ★★ 动作侧与求值侧**共用**同一套寻址解析（`docs/04 §1.5`：避免"判定一套、动作另一套"的割裂）
import { resolveActionTargets } from '../policy/action-addressing.ts';
import { resolveBinding, type BindingResolver } from '../policy/addressing.ts';

// ─────────────────────────── 幂等键 ───────────────────────────

/**
 * 计算幂等键（**纯函数**，跨调用可比较）。
 *
 * 用 sha256 截断到 32 hex：`ag_actions_log.idempotencyKey` 是 `varchar(128)`，
 * 32 位足够抗碰撞（同一站点内键空间是 (user, policy, seq, action) 的组合）。
 */
export function idempotencyKeyOf(input: {
  siteId: string;
  userId: string;
  policyId: string;
  actionSeq: number;
  action: string;
}): string {
  const payload = [input.siteId, input.userId, input.policyId, String(input.actionSeq), input.action].join('\u0000');
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

// ─────────────────────────── 类型 ───────────────────────────

export interface ActionStep {
  action: string;
  params: Record<string, unknown>;
  idempotencyKey: string;
  /** 失败是否阻断后续（默认 true） */
  optional?: boolean;
  /** 补偿动作（部分成功时反向执行） */
  compensation?: { action: string; params: Record<string, unknown> };
}

export interface ActionPlan {
  siteId: string;
  userId: string;
  policyId: string;
  evalId?: number;
  /** 来自 `ag_user_policy_state.actionSeq`，在生成计划的同一事务内自增 */
  actionSeq: number;
  steps: ActionStep[];
  traceId?: string;
}

export interface ActionContext {
  /** 站点作用域（注入用；核心不猜） */
  siteId: string;
  userId: string;
  policyId: string;
  actionSeq: number;
  idempotencyKey: string;
  params: Record<string, unknown>;
  traceId?: string;
  /** 该动作第几次尝试（1 起） */
  attempt: number;
}

export interface ActionResult {
  status: 'succeeded' | 'skipped' | 'failed' | 'blocked_unbound' | 'partially_applied';
  /** 跳过原因（如 `no_change` / `rate_limited`） */
  reason?: string;
  /** 可重试标记：由 handler 决定，executor 据此决定是否退避 */
  retryable?: boolean;
  /** 排障信息（脱敏后） */
  detail?: unknown;
}

export interface ActionHandler {
  /** 执行（要求幂等：同一 idempotencyKey 重复调用不得产生额外副作用） */
  execute(context: ActionContext): Promise<ActionResult>;
  /** 回读确认目标状态达成（缺省视为不校验） */
  verify?(context: ActionContext): Promise<{ verified: boolean; actual?: unknown; expected?: unknown }>;
  /** 补偿（反向执行） */
  compensate?(context: ActionContext): Promise<ActionResult>;
}

export interface ActionRegistryLike {
  get(action: string): ActionHandler | undefined;
  /** 已注册的动作名（供策略静态校验） */
  names(): string[];
}

export class ActionRegistry implements ActionRegistryLike {
  private readonly handlers = new Map<string, ActionHandler>();
  register(action: string, handler: ActionHandler): void {
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*$/.test(action)) {
      throw new Error(`动作名 '${action}' 非法：应为 <pluginId>:<actionName>`);
    }
    this.handlers.set(action, handler);
  }
  get(action: string): ActionHandler | undefined {
    return this.handlers.get(action);
  }
  names(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

// ─────────────────────────── 执行日志（幂等依据） ───────────────────────────

export interface ActionLogEntry {
  siteId: string;
  userId: string;
  policyId: string;
  actionSeq: number;
  action: string;
  idempotencyKey: string;
  status: 'planned' | 'running' | 'succeeded' | 'skipped' | 'failed' | 'rolled_back' | 'blocked_unbound' | 'partially_applied';
  reason?: string;
  attempts: number;
  startedAt: Date;
  finishedAt: Date;
  result?: unknown;
  error?: string;
}

export interface ActionLogStore {
  /** 按幂等键查（**唯一约束是 (siteId, idempotencyKey)**） */
  find(siteId: string, idempotencyKey: string): Promise<ActionLogEntry | undefined>;
  /** 追加/更新（同键幂等） */
  record(entry: ActionLogEntry): Promise<void>;
}

export class InMemoryActionLogStore implements ActionLogStore {
  private readonly byKey = new Map<string, ActionLogEntry>();
  private key(siteId: string, idempotencyKey: string): string {
    return `${siteId}\u0000${idempotencyKey}`;
  }
  async find(siteId: string, idempotencyKey: string): Promise<ActionLogEntry | undefined> {
    const found = this.byKey.get(this.key(siteId, idempotencyKey));
    return found === undefined ? undefined : { ...found };
  }
  async record(entry: ActionLogEntry): Promise<void> {
    this.byKey.set(this.key(entry.siteId, entry.idempotencyKey), { ...entry });
  }
}

// ─────────────────────────── 执行器 ───────────────────────────

export interface RetryPolicy {
  /** 退避序列（毫秒），按尝试次数取；用尽则不再重试 */
  backoffMs: readonly number[];
}

export const DEFAULT_RETRY: RetryPolicy = { backoffMs: [1_000, 5_000, 30_000, 120_000, 600_000] };

export interface ExecutorOptions {
  registry: ActionRegistryLike;
  log: ActionLogStore;
  logger?: Logger;
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** 是否在 execute 后做 verify（默认 true；verify 未实现时自动跳过） */
  verifyAfterExecute?: boolean;
  /**
   * ★★ **绑定解析器**（`policy/addressing.ts` 的 `BindingResolver`）——
   *   动作参数里的寻址目标（`{ target: 'subject:<provider>' }`）要靠它换成具体 `externalId`。
   *
   * ★ 未提供时：含寻址的动作**不会被执行**并报明确原因（见 `#resolveActionTargets`）——
   *   而不是把 `'subject:<provider>'` 这个**字符串**原样交给下游
   *   （下游要么看不懂、要么当普通值写进去 = **改错目标**）。
   * ★ 可为**工厂**（按 `plan.siteId` 构造）：`ag_plugin_bindings` 是**站点级**表，
   *   而 `BindingResolver.find()` 不含站点参数 —— 于是"按站点构造"是唯一正确的接法。
   *   单站点 / 内存模式下直接给一个 `BindingResolver` 即可。
   */
  bindings?: BindingResolver | ((siteId: string) => BindingResolver);
}

export interface StepOutcome {
  action: string;
  idempotencyKey: string;
  status: ActionLogEntry['status'];
  reason?: string;
  attempts: number;
  durationMs: number;
  error?: string;
  verified?: boolean;
  /** 是否是幂等命中的跳过（重试复用同一 seq 的情形） */
  idempotentHit?: boolean;
}

export interface PlanOutcome {
  plan: ActionPlan;
  steps: StepOutcome[];
  /** 整体结论 */
  status: 'succeeded' | 'failed' | 'partially_applied' | 'noop';
  /** 被阻断的步骤（`optional: false` 失败后不再执行） */
  blocked: string[];
  /** 已执行成功、但因后续失败而尝试补偿的步骤 */
  compensated: string[];
}

/**
 * 动作执行器。
 *
 * ★ 幂等由**日志**保证，而不是靠调用方自觉：
 *   执行前先按 `(siteId, idempotencyKey)` 查日志；已 `succeeded`/`skipped` 的直接跳过。
 *   这正是「重复巡检 10 次，下游无额外会话吊销」这条验收标准的技术基础。
 */
export class ActionExecutor {
  private readonly registry: ActionRegistryLike;
  private readonly log: ActionLogStore;
  private readonly logger: Logger | undefined;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly verifyAfterExecute: boolean;
  /** ★ 动作参数寻址用的绑定解析器（可为按站点构造的工厂；未装配则含寻址的动作会失败并报原因） */
  private readonly bindings: BindingResolver | ((siteId: string) => BindingResolver) | undefined;

  constructor(options: ExecutorOptions) {
    this.registry = options.registry;
    this.log = options.log;
    this.logger = options.logger;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.verifyAfterExecute = options.verifyAfterExecute ?? true;
    this.bindings = options.bindings;
  }

  /** 生成计划：把策略动作转成带幂等键的有序步骤（**去重**同键步骤）。 */
  buildPlan(input: {
    siteId: string;
    userId: string;
    policyId: string;
    actionSeq: number;
    evalId?: number;
    actions: readonly { action: string; params?: Record<string, unknown>; optional?: boolean; compensation?: { action: string; params: Record<string, unknown> } }[];
    traceId?: string;
  }): ActionPlan {
    const seen = new Set<string>();
    const steps: ActionStep[] = [];
    for (const item of input.actions) {
      const idempotencyKey = idempotencyKeyOf({
        siteId: input.siteId,
        userId: input.userId,
        policyId: input.policyId,
        actionSeq: input.actionSeq,
        action: item.action,
      });
      // 同一计划内重复声明同一动作 → 只保留一次（幂等键相同，重复执行没有意义）
      if (seen.has(idempotencyKey)) continue;
      seen.add(idempotencyKey);
      steps.push({
        action: item.action,
        params: item.params ?? {},
        idempotencyKey,
        ...(item.optional === undefined ? {} : { optional: item.optional }),
        ...(item.compensation === undefined ? {} : { compensation: item.compensation }),
      });
    }
    return {
      siteId: input.siteId,
      userId: input.userId,
      policyId: input.policyId,
      actionSeq: input.actionSeq,
      ...(input.evalId === undefined ? {} : { evalId: input.evalId }),
      steps,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    };
  }

  /**
   * 执行计划。
   *
   * 顺序语义：
   *   1. 逐条执行；`optional: false`（默认）的步骤失败会**阻断后续**；
   *   2. 阻断时对**已成功**的步骤尝试补偿（若声明了 `compensation`）；
   *   3. 部分成功 → 结论 `partially_applied`（**不是 failed**：已生效的部分必须如实记录，
   *      否则运维会以为「什么都没发生」）。
   */
  async execute(plan: ActionPlan): Promise<PlanOutcome> {
    const outcomes: StepOutcome[] = [];
    const blocked: string[] = [];
    const compensated: string[] = [];
    let blockedBy: string | undefined;

    for (const step of plan.steps) {
      if (blockedBy !== undefined) {
        blocked.push(step.action);
        continue;
      }
      const outcome = await this.executeStep(plan, step);
      outcomes.push(outcome);

      if (outcome.status === 'failed' && step.optional !== true) {
        blockedBy = step.action;
        // 补偿：反向执行已成功的步骤
        for (const done of [...outcomes].reverse()) {
          if (done.status !== 'succeeded') continue;
          const doneStep = plan.steps.find((s) => s.idempotencyKey === done.idempotencyKey);
          if (doneStep?.compensation === undefined) continue;
          const compensatedOk = await this.runCompensation(plan, doneStep);
          if (compensatedOk) compensated.push(doneStep.action);
        }
      }
    }

    const succeeded = outcomes.filter((o) => o.status === 'succeeded' || o.status === 'skipped').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    let status: PlanOutcome['status'];
    if (outcomes.length === 0) status = 'noop';
    else if (failed === 0) status = 'succeeded';
    else if (succeeded > 0) status = 'partially_applied';
    else status = 'failed';

    return { plan, steps: outcomes, status, blocked, compensated };
  }

  /**
   * ★★ **动作参数里的寻址解析**（`docs/04 §1.5`）。
   *
   * 文档原话：「注意 `actions` 里的 `subject: "subject:newapi"` —— **动作的目标也用同一套寻址**，
   * 避免『判定一套、动作另一套』的割裂。」
   *
   * ★ 与求值侧**共用**同一个解析器（`resolveActionTargets` → `parseAddress`）与同一套绑定解析
   *   （`resolveBinding`）—— 这才是"同一套"的含义：动作侧若自己写一套前缀解析，
   *   两边的边界处理迟早分叉（分叉的后果是"判定说满足、动作打到别人身上"）。
   * ★ 识别**保守**（见 `resolveActionTargets`）：只有"字段名在约定集合内"**且**"值看起来是寻址串"
   *   才当作目标 —— 否则 `{ group: 'contributor' }` 这类普通参数会被误判成寻址。
   * ★ 解析不出具体目标时**不静默**：报 issue，由调用方失败（见 `executeStep`）。
   */
  async #resolveActionTargets(
    params: Record<string, unknown>,
    userId: string,
    siteId: string,
  ): Promise<{ params: Record<string, unknown>; issues: string[] }> {
    const { targets, plainParams, issues } = resolveActionTargets(params);
    if (targets.length === 0) return { params, issues: [...issues] };
    // ★ 按站点构造（`ag_plugin_bindings` 是站点级表）；也接受现成的解析器
    const resolver =
      typeof this.bindings === 'function' ? this.bindings(siteId) : this.bindings;
    if (resolver === undefined) {
      return {
        params,
        issues: [...issues, '未装配绑定解析器（bindings）：动作参数里的寻址目标无法解析'],
      };
    }

    const resolved: Record<string, unknown> = { ...plainParams };
    const problems: string[] = [...issues];
    for (const target of targets) {
      const resolution = await resolveBinding({
        address: target.parsed,
        userId,
        resolver,
      });
      if (resolution.status === 'resolved') {
        resolved[target.key] = resolution.externalId;
      } else {
        // ★ 解析不出 → 保留原值 + 报 issue（不谎称成功，也不丢掉原始信息）
        resolved[target.key] = target.raw;
        problems.push(
          `动作参数 '${target.key}' 的寻址目标 '${target.raw}' 无法解析（${resolution.reason}）`,
        );
      }
    }
    return { params: resolved, issues: problems };
  }

  private async executeStep(plan: ActionPlan, step: ActionStep): Promise<StepOutcome> {
    const startedAt = this.now();
    const existing = await this.log.find(plan.siteId, step.idempotencyKey);
    if (existing !== undefined && (existing.status === 'succeeded' || existing.status === 'skipped')) {
      // ★ 幂等命中：同一计划的重试复用同一 seq，因此直接跳过，**不再触达下游**
      this.logger?.debug('幂等命中，跳过动作', { action: step.action, idempotencyKey: step.idempotencyKey });
      return {
        action: step.action,
        idempotencyKey: step.idempotencyKey,
        status: existing.status,
        attempts: existing.attempts,
        durationMs: 0,
        idempotentHit: true,
        ...(existing.reason === undefined ? {} : { reason: existing.reason }),
      };
    }

    const handler = this.registry.get(step.action);
    if (handler === undefined) {
      const error = `未注册的动作 '${step.action}'（请检查插件是否已安装/启用）`;
      await this.log.record({
        siteId: plan.siteId,
        userId: plan.userId,
        policyId: plan.policyId,
        actionSeq: plan.actionSeq,
        action: step.action,
        idempotencyKey: step.idempotencyKey,
        status: 'failed',
        attempts: 1,
        startedAt,
        finishedAt: this.now(),
        error,
      });
      return { action: step.action, idempotencyKey: step.idempotencyKey, status: 'failed', attempts: 1, durationMs: 0, error };
    }

    let attempt = 0;
    let lastError: string | undefined;
    let lastResult: ActionResult | undefined;

    // ★★ **动作参数的寻址解析**（`docs/04 §1.5`）——必须在调 handler **之前**做，
    //   且放在重试循环**外**（它与 attempt 无关，重试同一份解析结果即可）。
    const addressing = await this.#resolveActionTargets(step.params, plan.userId, plan.siteId);
    if (addressing.issues.length > 0) {
      // ★ **解析失败就不执行**：把未解析的寻址串交给下游，等于让下游去猜目标 ——
      //   那不是"降级"，而是"可能改错对象"。失败并留下原因，比猜安全。
      const error = addressing.issues.join('；');
      await this.log.record({
        siteId: plan.siteId,
        userId: plan.userId,
        policyId: plan.policyId,
        actionSeq: plan.actionSeq,
        action: step.action,
        idempotencyKey: step.idempotencyKey,
        status: 'failed',
        attempts: 1,
        startedAt,
        finishedAt: this.now(),
        error,
      });
      return {
        action: step.action,
        idempotencyKey: step.idempotencyKey,
        status: 'failed',
        attempts: 1,
        durationMs: 0,
        // ★ `reason` 是给**报告/调用方**看的（`PlanOutcome` 的 blocked 等用它），
        //   `error` 是技术细节 —— 两个都填，避免"失败了但报告里没有原因"。
        reason: error,
        error,
      };
    }

    while (attempt < Math.max(1, this.retry.backoffMs.length)) {
      attempt += 1;
      const context: ActionContext = {
        siteId: plan.siteId,
        userId: plan.userId,
        policyId: plan.policyId,
        actionSeq: plan.actionSeq,
        idempotencyKey: step.idempotencyKey,
        // ★ 用**解析后**的参数（寻址目标已换成具体 `externalId`）
        params: addressing.params,
        attempt,
        ...(plan.traceId === undefined ? {} : { traceId: plan.traceId }),
      };
      try {
        const result = await handler.execute(context);
        lastResult = result;
        if (result.status === 'failed' && result.retryable === true) {
          lastError = result.reason ?? '可重试失败';
          const delay = this.retry.backoffMs[attempt - 1];
          if (delay !== undefined && attempt < this.retry.backoffMs.length) {
            this.logger?.warn('动作失败，退避重试', { action: step.action, attempt, delayMs: delay });
            await this.sleep(delay);
            continue;
          }
          break;
        }
        // 成功 / 跳过 / 不可重试失败 / blocked_unbound
        let verified: boolean | undefined;
        if (
          this.verifyAfterExecute &&
          (result.status === 'succeeded' || result.status === 'partially_applied') &&
          handler.verify !== undefined
        ) {
          try {
            const check = await handler.verify(context);
            verified = check.verified;
            if (!check.verified) {
              // ★ 回读不一致：必须如实记录，不能当成成功
              this.logger?.warn('动作回读未达成目标状态', {
                action: step.action,
                actual: check.actual,
                expected: check.expected,
              });
            }
          } catch (error) {
            verified = false;
            this.logger?.warn('动作回读异常', { action: step.action, error: error instanceof Error ? error.message : String(error) });
          }
        }

        await this.log.record({
          siteId: plan.siteId,
          userId: plan.userId,
          policyId: plan.policyId,
          actionSeq: plan.actionSeq,
          action: step.action,
          idempotencyKey: step.idempotencyKey,
          status: result.status,
          attempts: attempt,
          startedAt,
          finishedAt: this.now(),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(result.detail === undefined ? {} : { result: result.detail }),
        });

        return {
          action: step.action,
          idempotencyKey: step.idempotencyKey,
          status: result.status,
          attempts: attempt,
          durationMs: this.now().getTime() - startedAt.getTime(),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(verified === undefined ? {} : { verified }),
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const delay = this.retry.backoffMs[attempt - 1];
        if (delay !== undefined && attempt < this.retry.backoffMs.length) {
          this.logger?.warn('动作抛错，退避重试', { action: step.action, attempt, error: lastError });
          await this.sleep(delay);
          continue;
        }
        break;
      }
    }

    // ★ 失败原因有两个来源，**两个都不能丢**：
    //   - `lastError`：抛异常或校验失败（错误）
    //   - `lastResult.reason`：handler **主动返回**失败（如「下游 4xx，不重试」）
    //   早期只记录了 `lastError`，于是主动失败的原因被吞掉——
    //   运维只看到笼统的「动作执行失败」，而排障最需要的信息恰好是那个 reason。
    const failureReason = lastError ?? lastResult?.reason;
    await this.log.record({
      siteId: plan.siteId,
      userId: plan.userId,
      policyId: plan.policyId,
      actionSeq: plan.actionSeq,
      action: step.action,
      idempotencyKey: step.idempotencyKey,
      status: 'failed',
      attempts: attempt,
      startedAt,
      finishedAt: this.now(),
      ...(lastError === undefined ? {} : { error: lastError }),
      ...(lastResult?.reason === undefined ? {} : { reason: lastResult.reason }),
      ...(lastResult?.detail === undefined ? {} : { result: lastResult.detail }),
    });
    return {
      action: step.action,
      idempotencyKey: step.idempotencyKey,
      status: 'failed',
      attempts: attempt,
      durationMs: this.now().getTime() - startedAt.getTime(),
      ...(failureReason === undefined ? {} : { reason: failureReason }),
      ...(lastError === undefined ? {} : { error: lastError }),
    };
  }

  private async runCompensation(plan: ActionPlan, step: ActionStep): Promise<boolean> {
    const compensation = step.compensation;
    if (compensation === undefined) return false;
    const handler = this.registry.get(compensation.action);
    if (handler === undefined) {
      this.logger?.warn('补偿动作未注册', { action: compensation.action });
      return false;
    }
    const context: ActionContext = {
      siteId: plan.siteId,
      userId: plan.userId,
      policyId: plan.policyId,
      actionSeq: plan.actionSeq,
      // 补偿用**独立**幂等键（同一 seq 但动作名不同 → 键不同）
      idempotencyKey: idempotencyKeyOf({
        siteId: plan.siteId,
        userId: plan.userId,
        policyId: plan.policyId,
        actionSeq: plan.actionSeq,
        action: compensation.action,
      }),
      params: compensation.params,
      attempt: 1,
    };
    try {
      const result = await handler.execute(context);
      await this.log.record({
        siteId: plan.siteId,
        userId: plan.userId,
        policyId: plan.policyId,
        actionSeq: plan.actionSeq,
        action: compensation.action,
        idempotencyKey: context.idempotencyKey,
        status: result.status,
        attempts: 1,
        startedAt: this.now(),
        finishedAt: this.now(),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
      return result.status === 'succeeded' || result.status === 'skipped';
    } catch (error) {
      this.logger?.error('补偿执行失败（需人工介入）', {
        action: compensation.action,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

// ─────────────────────────── 内置动作：写回 provider ───────────────────────────

/**
 * `set_group` 类动作的通用实现：**值不变直接跳过**（防抖，docs/05 §2.2）。
 *
 * 为什么必须跳过而不是「让下游自己判断」：改分组会 bump 下游的 `auth_version`
 * 并**踢掉用户全部会话**。哪怕下游能识别「值相同」，也不该让它收到这个请求。
 */
export function createSetGroupHandler(options: {
  /** 读取当前主体（经 provider 抽象，核心不认识具体系统） */
  getSubject: (externalId: string) => Promise<{ attributes: Record<string, unknown> } | null>;
  /** 写回目标分组 */
  setGroup: (externalId: string, group: string) => Promise<void>;
  /** 该用户的当前下游主体主键 */
  externalIdOf: (context: ActionContext) => string;
  /** 最小变更间隔（毫秒）；缺省不限制 */
  minChangeIntervalMs?: number;
  lastChangeAt?: (userId: string) => Date | undefined;
  onChanged?: (userId: string, at: Date) => void;
  /**
   * ★ 级联回退的前提（`docs/05 §3.5` 修正三）：**写回前**记录「首次接管前的原值」。
   *   幂等由 store 侧保证（仅当 `baseline` 为空时写），故此处可无条件调用。
   *   不注入时行为与从前完全一致（本回调是可选增强）。
   */
  rememberBaseline?: (input: {
    userId: string;
    /** 该动作所属的策略 id（装配层据此反查 code —— baseline 的键在状态表里按策略行存） */
    policyId: string;
    externalId: string;
    from: string;
    to: string;
  }) => Promise<void>;
  now?: () => Date;
}): ActionHandler {
  const now = options.now ?? (() => new Date());
  return {
    async execute(context) {
      const target = String(context.params['group'] ?? '');
      if (target.length === 0) return { status: 'failed', reason: '缺少 group 参数（配置错误，不重试）', retryable: false };

      const externalId = options.externalIdOf(context);
      const current = await options.getSubject(externalId);
      if (current === null) {
        // 目标未绑定：不是失败，不计入失败率（docs/02 的 blocked_unbound）
        return { status: 'blocked_unbound', reason: '下游主体不存在（尚未绑定）' };
      }
      const currentGroup = String(current.attributes['group'] ?? '');
      if (currentGroup === target) {
        return { status: 'skipped', reason: 'no_change' };
      }

      const interval = options.minChangeIntervalMs;
      if (interval !== undefined && interval > 0 && options.lastChangeAt !== undefined) {
        const last = options.lastChangeAt(context.userId);
        if (last !== undefined && now().getTime() - last.getTime() < interval) {
          return { status: 'skipped', reason: 'rate_limited' };
        }
      }

      // ★ 先记 baseline 再写回：baseline 的语义是「**接管前**的原值」——
      //   写在写回之后就变成「接管后的值」，级联回退会回到错误的目标。
      await options.rememberBaseline?.({
        userId: context.userId,
        policyId: context.policyId,
        externalId,
        from: currentGroup,
        to: target,
      });
      await options.setGroup(externalId, target);
      options.onChanged?.(context.userId, now());
      return { status: 'succeeded' };
    },
    async verify(context) {
      const target = String(context.params['group'] ?? '');
      const externalId = options.externalIdOf(context);
      const current = await options.getSubject(externalId);
      return {
        verified: current !== null && String(current.attributes['group'] ?? '') === target,
        actual: current?.attributes['group'] ?? null,
        expected: target,
      };
    },
  };
}
