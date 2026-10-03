/**
 * 从策略定义里提取「该策略要求的某动作目标值」——级联回退（`docs/05 §3.5`）的取值来源。
 *
 * ★ 为什么需要它：`restore` 的判定要回答「**仍然满足的**策略要求哪一档」。
 *   而「要求哪一档」只存在于**策略定义**里（`spec.actions.onSatisfied[].params.group`
 *   或分支级 `branches[].actions[].params.group`）——不在状态表里。
 *
 * ★ 本文件属于**核心**：`actionKey` 由装配层注入（核心不得硬编码具体系统名，
 *   见 `docs/01 §1.3` 与 CI 第 7 项）。
 */

import type { ActionSpec, PolicySpec } from './model.ts';

/**
 * 该策略要求 `actionKey` 达到的目标值；未要求则 `null`。
 *
 * ★ 优先级（与 `docs/04 §1.3` 形态 B 的语义一致）：
 *   1. **分支级** `actions`（`outcome: satisfied` 的分支）——它们**覆盖**策略级动作；
 *   2. 策略级 `actions.onSatisfied`。
 *
 * ★ 刻意**不看 `onUnsatisfied`**：那是「不满足时怎么办」，
 *   而级联回退要算的是「**满足**的策略支撑到哪一档」。
 *   把 `onUnsatisfied` 的目标算进来，正好会复现 P0-2 的原始缺陷
 *   （用静态的 `default` 覆盖掉仍满足策略给的档位）。
 */
export function requiredGroupOf(spec: PolicySpec, actionKey: string): string | null {
  for (const branch of spec.requirements.branches ?? []) {
    if (branch.outcome === 'unsatisfied') continue;
    const group = groupIn(branch.actions, actionKey);
    if (group !== null) return group;
  }
  return groupIn(spec.actions?.onSatisfied, actionKey);
}

function groupIn(actions: readonly ActionSpec[] | undefined, actionKey: string): string | null {
  for (const action of actions ?? []) {
    if (action.action !== actionKey) continue;
    const group = action.params?.['group'];
    if (typeof group === 'string' && group.length > 0) return group;
  }
  return null;
}
