/**
 * `restore` 类动作（规范形 `<pluginId>:<actionName>`，由「改分组」插件提供）
 * —— **级联回退**（`docs/10 P1`，文档自身标注 🔴 严重）。
 *
 * ★ 本文件属于**核心**：因此**不得出现任何具体系统名**（`docs/01 §1.3`，CI 第 7 项会实扫）。
 *   具体动作名（可能含下游系统名）一律由**装配层**经 `actionKey` 注入。
 *
 * ★★ 它修的是什么：
 *
 * ```yaml
 * # 策略 A（tier 1）  onSatisfied: set_group → basic
 * # 策略 B（tier 2）  onSatisfied: set_group → vip2
 * # 两者的 onUnsatisfied 都写 set_group → default
 * ```
 *
 * | 步骤 | A | B | 期望 | 按「静态目标值」的写法 |
 * |---|---|---|---|---|
 * | 初始 | ✅ | ✅ | vip2 | vip2 ✅ |
 * | **B 不再满足** | ✅ | ❌ | **basic**（A 仍要求） | **default** ❌ |
 *
 * ★ 即：B 失效时用户被从 vip2 直接打到 default，**丢掉了仍然满足的 A 所给的 basic**。
 *   根因是 `onUnsatisfied` 写的是**静态目标值**，而不是「回退到**剩余策略所能支撑的档位**」。
 *
 * ★ 因此把 `set_group` 拆成两个动作（`docs/05 §3.5` 修正一）：
 *   - `<pluginId>:set_group` —— 声明「我要求某档」；
 *   - `<pluginId>:restore`   —— 回退，**目标由执行器计算**（本文件）。
 *
 * ★ 回退算法（`docs/05 §3.5` 修正二，四步，逐步对应下面的实现）：
 * ```
 * ① 收集该主体所有【仍处于 granted / satisfied】的策略所要求的目标值
 * ② 若有 → 取 tier 最高者
 *      （tier 相同 → priority 小者；仍相同 → 【拒绝执行并告警】，宁可不动也不随机选）
 * ③ 若无 → 回退到 baseline（该主体首次被策略接管前的原值）
 * ④ 若 baseline 已被人工改动 → 交 driftPolicy 处理，不擅自覆盖
 * ```
 *
 * ★ 关于 ④：本 handler **不做** drift 判定——那是 provider/对账层的职责
 *   （`driftPolicy` 在 `ag_provider_sync_state`）。本 handler 只负责「算出该回到哪一档」，
 *   并把「当前值与 baseline 不一致」这一事实**报给调用方**（`detail.baselineDrifted`），
 *   由上层按 `driftPolicy` 决定是否落笔。
 */

import type { ActionContext, ActionHandler, ActionResult } from './action-executor.ts';

/** 一条「仍满足的策略」及其要求（由装配层从 `ag_user_policy_state` + 策略定义组装） */
export interface RestoreRequirement {
  policyId: string;
  policyCode: string;
  /** 阶梯；`null` = 非阶梯策略（按 `docs/05 §3.5`，非阶梯视为最低） */
  tier: number | null;
  /** 多策略命中时的优先级（**小者优先**） */
  priority: number;
  /** 该策略要求的目标分组；`null` = 该策略不要求分组（不参与决胜） */
  targetGroup: string | null;
}

export interface RestoreSource {
  /** 该主体当前**仍处于 `granted` / `satisfied`** 的策略（含各自要求） */
  listActiveRequirements(input: { siteId: string; userId: string }): Promise<readonly RestoreRequirement[]>;
  /** 该 (主体, 策略) **首次接管前**的原值（`ag_user_policy_state.baseline`）；无则 `null` */
  baselineOf(input: {
    siteId: string;
    userId: string;
    policyId: string;
    actionKey: string;
  }): Promise<string | null>;
}

export interface RestoreGroupOptions {
  source: RestoreSource;
  /** 读取下游当前分组（用于「已到位则跳过」） */
  currentGroup: (externalId: string) => Promise<string | null>;
  /** 写回目标分组（由装配层注入，经 provider 的写回实现） */
  setGroup: (externalId: string, group: string) => Promise<void>;
  externalIdOf: (context: ActionContext) => string;
  /**
   * 动作规范形——它同时是 `baseline` / `appliedActions` 的键（`docs/03 §1.2`）。
   * ★ **必填且由装配层注入**：核心不得硬编码具体系统名（`docs/01 §1.3`，CI 第 7 项实扫）。
   */
  actionKey: string;
  /** 决胜失败（tier 与 priority 都相同但目标不同）时的告警出口 */
  onConflict?: (input: {
    siteId: string;
    userId: string;
    candidates: readonly { policyCode: string; targetGroup: string }[];
  }) => void;
  now?: () => Date;
}

export interface RestoreDecision {
  /** 决定回退到的目标；`null` = 没有可回退的目标 */
  target: string | null;
  /** 依据：其它仍满足的策略 / baseline / 无 */
  basis: 'active_policy' | 'baseline' | 'none';
  /** 参与决胜的候选（便于排障与审计） */
  candidates: readonly { policyCode: string; tier: number | null; priority: number; targetGroup: string }[];
}

/**
 * 纯函数形式的回退决策 —— 与 `evaluateInProcessAdmission` 同理：
 * 把「该回到哪一档」变成**可单测的判定**，而不是散落在 handler 里的分支。
 *
 * @param active 其它仍满足的策略（**调用方须已排除正在回退的那个策略**）
 * @param baseline 该策略首次接管前的原值
 */
export function decideRestoreTarget(input: {
  active: readonly RestoreRequirement[];
  baseline: string | null;
}): RestoreDecision {
  // ① 只考虑「要求了分组」的仍满足策略
  const candidates = input.active
    .filter((requirement) => requirement.targetGroup !== null)
    .map((requirement) => ({
      policyCode: requirement.policyCode,
      tier: requirement.tier,
      priority: requirement.priority,
      targetGroup: requirement.targetGroup as string,
    }));

  if (candidates.length > 0) {
    // ② tier 高者 → priority 小者 → 仍相同则**拒绝**（宁可不动，也不随机选）
    const maxTier = Math.max(...candidates.map((c) => (c.tier === null ? -1 : c.tier)));
    const topTier = candidates.filter((c) => (c.tier === null ? -1 : c.tier) === maxTier);
    const minPriority = Math.min(...topTier.map((c) => c.priority));
    const finalists = topTier.filter((c) => c.priority === minPriority);
    const targets = [...new Set(finalists.map((c) => c.targetGroup))];
    return {
      // 决胜仍并列且目标不同 → `target: null` + `basis: 'active_policy'`
      // （调用方据此**拒绝执行并告警**，而不是随便挑一个）
      target: targets.length === 1 ? targets[0]! : null,
      basis: 'active_policy',
      candidates,
    };
  }

  // ③ 没有其它仍满足的策略 → 回退到 baseline
  if (input.baseline !== null) {
    return { target: input.baseline, basis: 'baseline', candidates };
  }

  // ④ 连 baseline 都没有 → 不动（平台只回滚自己造成的变更）
  return { target: null, basis: 'none', candidates };
}

export function createRestoreGroupHandler(options: RestoreGroupOptions): ActionHandler {
  const actionKey = options.actionKey;
  const externalIdOf = options.externalIdOf;

  return {
    async execute(context: ActionContext): Promise<ActionResult> {
      const externalId = externalIdOf(context);
      const active = await options.source.listActiveRequirements({
        siteId: context.siteId,
        userId: context.userId,
      });
      // ★ 排除**正在回退的这个策略**：它的状态此刻正在转向 revoked，
      //   若把它算进「仍满足」，就会回退到自己要求的档位 = 回退无效。
      const others = active.filter((requirement) => requirement.policyId !== context.policyId);

      const baseline = await options.source.baselineOf({
        siteId: context.siteId,
        userId: context.userId,
        policyId: context.policyId,
        actionKey,
      });

      const decision = decideRestoreTarget({ active: others, baseline });

      // ② 决胜失败：**拒绝执行并告警**（不随机选一个）
      if (decision.basis === 'active_policy' && decision.target === null) {
        options.onConflict?.({
          siteId: context.siteId,
          userId: context.userId,
          candidates: decision.candidates.map((c) => ({ policyCode: c.policyCode, targetGroup: c.targetGroup })),
        });
        return {
          status: 'failed',
          reason: 'restore_target_conflict（tier 与 priority 均相同但目标不同）——拒绝随机选择，需人工裁决',
          retryable: false,
          detail: { candidates: decision.candidates },
        };
      }

      // ③④ 没有任何可回退的目标 → 不动（绝不覆盖从未被平台管理过的值）
      if (decision.target === null) {
        return {
          status: 'skipped',
          reason: 'no_restore_target（既无仍满足的策略要求，也无 baseline）',
          detail: { basis: decision.basis },
        };
      }

      // 已到位 → 跳过（避免无谓地写下游、避免踢会话）
      const current = await options.currentGroup(externalId);
      if (current === decision.target) {
        return { status: 'skipped', reason: 'no_change', detail: { target: decision.target, basis: decision.basis } };
      }

      await options.setGroup(externalId, decision.target);
      return {
        status: 'succeeded',
        detail: {
          target: decision.target,
          from: current,
          basis: decision.basis,
          // ★ ④ 的交接点：当前值与 baseline 不一致 = 可能被人手工改过，
          //   是否落笔由上层按 `driftPolicy` 决定（本 handler 只报事实，不擅自判断）
          ...(decision.basis === 'baseline' && current !== null && current !== baseline
            ? { baselineDrifted: true }
            : {}),
        },
      };
    },
  };
}
