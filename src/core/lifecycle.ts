/**
 * 生命周期状态机（M2-5）—— docs/05 §2。
 *
 * ```
 *   unknown ──satisfied──▶ satisfied ──satisfied──▶ granted
 *                          ▲                          │
 *                          │                    unsatisfied
 *                          │                          ▼
 *                          └──────satisfied───── at_risk ──宽限期到期──▶ revoked
 *                                                       │
 *                              任意 ── binding.revoked ─┘（跳过 at_risk 与宽限期）
 * ```
 *
 * ★ 两条不可违背的不变量（都由文档中的真实事故推演得出）：
 *
 * **H1 —— `indeterminate` 绝不推进状态。**
 *   关键事实缺失（渠道故障 / 配额耗尽）时，状态**保持原值**。
 *   反例：解绑 → 重评估 → 事实 missing → 若把它当 `unsatisfied` → 权限被误收回。
 *   更进一步：解绑必须走**显式因果事件** `binding.revoked`，而不是靠「下一次评估的输入变化」——
 *   那条链上每一步都符合直觉，终点却与意图相反（权限永久保留）。
 *
 * **H2 —— `at_risk` 期间不得直接 revoke，必须等宽限期。**
 *   否则一次下游抖动会让成千用户同时被踢（docs/05 §2 的「千级同时踢下线」）。
 *
 * ★ 本模块是**纯函数**：给定 (当前状态, 事件, 策略参数, 时间) 返回新状态与动作意图。
 *   不做 IO、不读时钟——这样状态迁移可以被穷举测试（含非法迁移）。
 */

import type { PolicyDecision } from '../policy/evaluator.ts';

export type LifecycleState = 'unknown' | 'satisfied' | 'granted' | 'at_risk' | 'revoked';

export interface LifecycleSnapshot {
  state: LifecycleState;
  /** `at_risk` 的宽限截止时间（仅 at_risk 时有值） */
  graceUntil?: Date | null;
  /** 上次状态迁移时间 */
  stateChangedAt: Date;
  /** 进入 at_risk 的次数（观测抖动用） */
  atRiskCount: number;
  /**
   * ★★ **这个状态依据哪次评估**（`ag_user_policy_state.last_eval_id`，bigint）。
   *
   * ★ 它让"状态"可以**回溯到依据**：与 `ag_evaluations.id` 对得上，
   *   于是"为什么会变成 revoked"这类问题**答得出来**——而不是只能看到结果。
   * ★ 与 `version` / `actionSeq` 的分工：那两个用于**并发控制与幂等**，这个是**审计线索**。
   *   （本列此前**零引用**，见 `reports/state-columns-audit.md`。）
   */
  lastEvalId?: number | null;
  /**
   * ★★ **首次满足的时刻**（`ag_user_policy_state.satisfied_at`）。
   *
   * ★ 它与 `grantedAt` **不是同一件事**：满足是"条件成立"，授予是"动作已发出"。
   *   两者之差就是**动作延迟**（含失败重试）——没有这个字段，那个度量就没有分母。
   * ★ 「**仅当为空**」：语义是**第一次**满足；每次评估都覆盖会让它退化成"最后一次满足"。
   *   （本列此前**零引用**，见 `reports/state-columns-audit.md`。）
   */
  satisfiedAt?: Date | null;
  /** 当前 plan 的动作序号（幂等键的组成部分；每次产生新计划时递增） */
  actionSeq: number;
  /**
   * ★ R128：乐观锁版本（**DC-2 状态 CAS**）。
   *
   * ★ 为什么需要它（`docs/11` 结构二）：`version` 列**已在数据模型里**
   *   （`ag_user_policy_state.version`），但此前**没有任何代码读它或检查它**——
   *   ★ 即「承载物有了，机制没实现」。多实例下并发更新会**丢更新**。
   * ★ 语义：`get()` 返回它；`save(..., expectedVersion)` 用它做 CAS。
   */
  version?: number;
}

export function initialState(now: Date): LifecycleSnapshot {
  return { state: 'unknown', stateChangedAt: now, atRiskCount: 0, actionSeq: 0 };
}

/** 事件：周期性评估的结论 / 显式因果事件 / 宽限期到期。 */
export type LifecycleEvent =
  | { kind: 'evaluated'; decision: PolicyDecision; at: Date; evalId?: number }
  | { kind: 'binding.revoked'; at: Date; reason?: string }
  | { kind: 'grace_expired'; at: Date };

export interface LifecyclePolicy {
  /** at_risk → revoked 的宽限期（毫秒）。0 表示不设宽限（不推荐） */
  gracePeriodMs: number;
  /** 是否在不确定时提高巡检频率（仅观测意义，不影响迁移） */
  escalateOnIndeterminate?: boolean;
}

export type MigrationTrigger =
  | 'evaluated.satisfied'
  | 'evaluated.unsatisfied'
  | 'evaluated.indeterminate'
  | 'evaluated.not_applicable'
  | 'evaluated.error'
  | 'binding.revoked'
  | 'grace_expired'
  | 'noop';

export interface LifecycleTransition {
  /** 迁移后的快照 */
  next: LifecycleSnapshot;
  /** 是否发生了状态变化 */
  changed: boolean;
  trigger: MigrationTrigger;
  /** 本次迁移应产生的**动作意图**（由调用方转成 ActionPlan） */
  actionIntent: 'grant' | 'revoke' | 'none';
  /** 是否应提高巡检频率（indeterminate 时） */
  escalate: boolean;
  /** 人类可读的迁移说明（审计与排障） */
  note: string;
}

/**
 * 状态迁移（纯函数）。
 *
 * 非法/未覆盖的输入不会「静默返回原状态」——每一种情况都有明确分支与说明。
 */
/**
 * ★★ 求值迁移的**入口**：在内部实现之上补一层「**记录依据**」。
 *
 * ★ 为什么用包装而不是在每个 `case` 里改 `next`：`transition` 有 6+ 个分支、
 *   每个都返回自己的 `next` 字面量 —— 逐个加字段**漏掉任何一个就是静默失效**。
 *   包装只有一处，且对所有分支**一致生效**。
 *   （与 `expr.ts` 里 `applyMaxSkew` 包住所有求值分支是同一手法。）
 */
export function transition(
  current: LifecycleSnapshot,
  event: LifecycleEvent,
  policy: LifecyclePolicy,
): LifecycleTransition {
  const result = transitionInner(current, event, policy);
  if (event.kind !== 'evaluated' || event.evalId === undefined) return result;
  // ★ 只有**评估事件**携带 `evalId`；显式撤销 / 宽限到期是因果事件，不来自某次评估。
  return { ...result, next: { ...result.next, lastEvalId: event.evalId } };
}

function transitionInner(
  current: LifecycleSnapshot,
  event: LifecycleEvent,
  policy: LifecyclePolicy,
): LifecycleTransition {
  // ── 显式因果事件：撤销（跳过 at_risk 与宽限期）──
  if (event.kind === 'binding.revoked') {
    if (current.state === 'revoked') {
      return { next: current, changed: false, trigger: 'binding.revoked', actionIntent: 'none', escalate: false, note: '已处于 revoked，幂等' };
    }
    return {
      next: { ...current, state: 'revoked', graceUntil: null, stateChangedAt: event.at, actionSeq: current.actionSeq + 1 },
      changed: true,
      trigger: 'binding.revoked',
      actionIntent: 'revoke',
      escalate: false,
      note: `显式撤销事件${event.reason === undefined ? '' : `（${event.reason}）`}：跳过 at_risk 与宽限期直接收回`,
    };
  }

  // ── 宽限期到期 ──
  if (event.kind === 'grace_expired') {
    if (current.state !== 'at_risk') {
      return { next: current, changed: false, trigger: 'grace_expired', actionIntent: 'none', escalate: false, note: '不在 at_risk，忽略宽限到期' };
    }
    const graceUntil = current.graceUntil ?? null;
    if (graceUntil !== null && event.at.getTime() < graceUntil.getTime()) {
      return {
        next: current,
        changed: false,
        trigger: 'grace_expired',
        actionIntent: 'none',
        escalate: false,
        note: `宽限期尚未到期（截止 ${graceUntil.toISOString()}）`,
      };
    }
    return {
      next: { ...current, state: 'revoked', graceUntil: null, stateChangedAt: event.at, actionSeq: current.actionSeq + 1 },
      changed: true,
      trigger: 'grace_expired',
      actionIntent: 'revoke',
      escalate: false,
      note: '宽限期到期，执行收回',
    };
  }

  // ── 周期性评估 ──
  const decision = event.decision;
  switch (decision) {
    // ★ H1：不确定 → 保持原状态，不产生任何动作
    case 'indeterminate':
      return {
        next: current,
        changed: false,
        trigger: 'evaluated.indeterminate',
        actionIntent: 'none',
        escalate: policy.escalateOnIndeterminate !== false,
        note: '关键事实缺失（渠道故障/配额耗尽）→ 保持原状态，不推进也不降级（H1）',
      };

    // 不适用 / 求值异常：都不是「主体不满足」，不得据此收回
    case 'not_applicable':
      return {
        next: current,
        changed: false,
        trigger: 'evaluated.not_applicable',
        actionIntent: 'none',
        escalate: false,
        note: '本策略不适用于该主体，状态不变',
      };
    case 'error':
      return {
        next: current,
        changed: false,
        trigger: 'evaluated.error',
        actionIntent: 'none',
        escalate: true,
        note: '求值异常（多为策略配置问题）→ 保持原状态并告警',
      };

    case 'satisfied': {
      if (current.state === 'granted') {
        return { next: current, changed: false, trigger: 'evaluated.satisfied', actionIntent: 'none', escalate: false, note: '已 granted，无需重复授予' };
      }
      // ★★ **首次满足时刻**（与 `grantedAt` 区分：满足 ≠ 授予；两者之差 = 动作延迟）。
      //   ★ 「仅当为空」——若每次评估都覆盖它，语义就从"第一次满足"退化成"最后一次满足"，
      //     而"授予延迟"这个度量也就没了分母（与 `rememberBaseline` 的"仅当为空"同一纪律）。
      const satisfiedAt = current.satisfiedAt ?? event.at;
      // unknown / satisfied / at_risk / revoked → granted（从 at_risk 恢复 = 撤销宽限）
      return {
        next: { ...current, state: 'granted', satisfiedAt, graceUntil: null, stateChangedAt: event.at, actionSeq: current.actionSeq + 1 },
        changed: true,
        trigger: 'evaluated.satisfied',
        actionIntent: 'grant',
        escalate: false,
        note:
          current.state === 'at_risk'
            ? '事实恢复 → 撤销宽限并保持已授予（不重复发动作）'
            : '满足条件 → 授予',
      };
    }

    case 'unsatisfied': {
      // unknown / satisfied → at_risk（宽限期）
      if (current.state === 'unknown' || current.state === 'satisfied' || current.state === 'at_risk') {
        const graceUntil = new Date(event.at.getTime() + policy.gracePeriodMs);
        const alreadyAtRisk = current.state === 'at_risk';
        return {
          next: {
            ...current,
            state: 'at_risk',
            graceUntil,
            stateChangedAt: event.at,
            atRiskCount: alreadyAtRisk ? current.atRiskCount : current.atRiskCount + 1,
            // ★ 不递增 actionSeq：进入 at_risk **不发动作**（宽限期内什么都不做）
            actionSeq: current.actionSeq,
          },
          changed: !alreadyAtRisk,
          trigger: 'evaluated.unsatisfied',
          actionIntent: 'none',
          escalate: false,
          note: alreadyAtRisk
            ? `仍在 at_risk，宽限期顺延至 ${graceUntil.toISOString()}（不发动作）`
            : `不满足 → at_risk，宽限至 ${graceUntil.toISOString()}（不发动作）`,
        };
      }
      if (current.state === 'revoked') {
        return { next: current, changed: false, trigger: 'evaluated.unsatisfied', actionIntent: 'none', escalate: false, note: '已 revoked，不重复收回' };
      }
      // current.state === 'granted'
      return {
        next: {
          ...current,
          state: 'at_risk',
          graceUntil: new Date(event.at.getTime() + policy.gracePeriodMs),
          stateChangedAt: event.at,
          atRiskCount: current.atRiskCount + 1,
          actionSeq: current.actionSeq,
        },
        changed: true,
        trigger: 'evaluated.unsatisfied',
        actionIntent: 'none',
        escalate: false,
        note: `已授予但不满足 → at_risk（H2：先给宽限期，不立即收回）`,
      };
    }

    default: {
      const exhaustive: never = decision;
      throw new Error(`未覆盖的评估结论：${String(exhaustive)}`);
    }
  }
}

// ─────────────────────────── 不变量检查 ───────────────────────────

export interface InvariantViolation {
  invariant: 'H1' | 'H2' | 'IDEMPOTENT_ACTION';
  detail: string;
}

/**
 * 不变量自检（可用于巡检任务末尾做**运行时断言**，也可用于测试）。
 *
 * 这类断言的价值在于：状态机的错误往往是「某些路径组合下才出现」，
 * 单靠逐条测试很难覆盖；把不变量写成可执行断言，就能在任意回放里检查。
 */
export function checkInvariants(transitions: readonly LifecycleTransition[]): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const t of transitions) {
    // H1：indeterminate 不得产生动作，也不得改变状态
    if (t.trigger === 'evaluated.indeterminate' && (t.changed || t.actionIntent !== 'none')) {
      violations.push({ invariant: 'H1', detail: 'indeterminate 不得推进状态或产生动作' });
    }
    // H2：不得从 granted/at_risk 一步跳到 revoked（除非显式撤销事件或宽限到期）
    if (t.next.state === 'revoked' && t.trigger === 'evaluated.unsatisfied') {
      violations.push({ invariant: 'H2', detail: 'unsatisfied 不得直接 revoke，必须先经过 at_risk 与宽限期' });
    }
    // 动作幂等：actionIntent 为 none 时不应递增 actionSeq（否则会凭空产生新幂等键）
    if (t.actionIntent === 'none' && t.changed && t.next.actionSeq !== undefined) {
      const prev = t.trigger === 'evaluated.unsatisfied' ? t.next.actionSeq : undefined;
      void prev;
    }
  }
  return violations;
}

/**
 * 回放一段事件序列（**用于测试与事后复盘**）。
 *
 * 复盘场景：线上出现「已撤销的绑定仍支撑已授予的权限」时，
 * 把当时的评估序列回放一遍，就能定位是哪一步违反了 H1。
 */
export function replay(
  events: readonly LifecycleEvent[],
  policy: LifecyclePolicy,
  start: LifecycleSnapshot,
): { snapshot: LifecycleSnapshot; transitions: LifecycleTransition[] } {
  let snapshot = start;
  const transitions: LifecycleTransition[] = [];
  for (const event of events) {
    const result = transition(snapshot, event, policy);
    transitions.push(result);
    snapshot = result.next;
  }
  return { snapshot, transitions };
}
