/**
 * 策略分配（`ag_policy_assignments`）—— 补齐 `docs/02 §3` 声明但**零读写**的表。
 *
 * ★★ 它与 `PolicySpec.match` 的区别（因此**不是**"被替代"）：
 *   · `match` 是**条件表达式**——基于事实判定"这条策略适用于谁"；
 *   · 本表是**显式分配**——把策略绑定到 `all` / `user` / `tag` / `cohort`，
 *     并带 **`rolloutPercent` 灰度**。★ 百分比灰度是**表达式表达不了的**
 *     （表达式只能给出真/假，无法给出"10% 的人"）。
 *
 * ★★ 灰度必须是**确定性哈希**，不能是随机数：
 *   随机的话，同一个用户这一次在 10% 里、下一次不在——
 *   他的资格会**反复抖动**（授予 → 收回 → 授予），而这正是 H1 要防的形态。
 *   因此用 `hash(policyId + userId)` 分桶：同一策略下同一用户**永远落在同一侧**。
 *
 * ★ 哈希里**必须含 `policyId`**：否则"所有策略都对同一批 10% 用户灰度"——
 *   多个灰度实验会**互相污染**，得到的结论不可用。
 */

// ★★ 分桶**委托**给 `policy/rollout.ts` 的 `bucketOf` —— 全项目只保留一处分桶公式，
//   否则"管理端灰度预览"与"运行期真实判定"会给出不同答案（各自看都对，最难查）
import { bucketOf } from '../policy/rollout.ts';

export type AssignmentTargetType = 'all' | 'user' | 'tag' | 'cohort';

export interface PolicyAssignment {
  id: string;
  policyId: string;
  targetType: AssignmentTargetType;
  /** `all` 时为 undefined；其余为 userId / tag / cohort 名 */
  targetRef?: string;
  /** 灰度百分比 0–100（100 = 全量） */
  rolloutPercent: number;
  enabled: boolean;
  createdAt: Date;
}

export interface AssignmentContext {
  userId: string;
  /** 用户身上的标签（来自事实/身份） */
  tags?: readonly string[];
  /** 用户所属群组 */
  cohorts?: readonly string[];
  /**
   * ★★ **已一键熔断的策略 id**（`docs/07 M6-3` / `docs/05 §6.3.1`）。
   *
   * ★ 语义：熔断 = 该策略的灰度**整体回旧版本** —— 因此它**优先于比例，也优先于名单**
   *   （"止血不能被任何名单或比例阻挡"）。
   * ★ 为什么放在上下文里（而不是让判定自己去查存储）：判定是**纯函数**，
   *   这样才可测试、可复现；熔断状态由装配层一次取好传入，
   *   判定路径里**不出现 IO**（否则每次求值都要查一次平台设置）。
   */
  abortedPolicyIds?: readonly string[];
}

export type AssignmentDecision =
  | {
      applies: true;
      via: AssignmentTargetType;
      assignment: PolicyAssignment;
      /** 是否**因灰度**而适用（`100` 时为 `not_applicable`，便于区分"全量"与"抽样"） */
      rollout: 'included' | 'not_applicable';
    }
  | { applies: false; reason: 'no_assignment' | 'not_targeted' | 'rollout_excluded' | 'rollout_aborted' };

/**
 * 稳定分桶：`hash(policyId + userId) % 100 < rolloutPercent`。
 *
 * ★ 用 SHA-256 的前 4 字节（而不是 `hashCode` 之类的弱哈希）：
 *   弱哈希在"用户 id 递增"时分布很差（例如低位取模会退化成顺序分配）。
 */
export function inRollout(input: {
  policyId: string;
  userId: string;
  rolloutPercent: number;
}): boolean {
  if (input.rolloutPercent >= 100) return true;
  if (input.rolloutPercent <= 0) return false;
  // ★★ **分桶只有一处实现**（`policy/rollout.ts` 的 `bucketOf`）。
  //   ★ 此前这里是**独立**的一份哈希（`sha256("<policyId>:<userId>")`，冒号分隔），
  //     而 `bucketOf` 用 `\0` 分隔 —— **同一个用户会落到不同的桶**。
  //     两套公式并存时，"预览说这个用户在灰度里、运行期却判定不在"，
  //     而两边各自看都正确 —— 这正是本仓库最贵的那类不一致。
  //   ★ 传 `policyId` 作为 `rolloutId`：保持「不同策略的灰度互不相关」这一性质
  //     （否则同一批用户会在所有策略里同时被灰度到，实验结论互相污染）。
  return bucketOf(input.userId, input.policyId) < input.rolloutPercent;
}

function isTargeted(assignment: PolicyAssignment, context: AssignmentContext): boolean {
  switch (assignment.targetType) {
    case 'all':
      return true;
    case 'user':
      return assignment.targetRef === context.userId;
    case 'tag':
      return assignment.targetRef !== undefined && (context.tags ?? []).includes(assignment.targetRef);
    case 'cohort':
      return (
        assignment.targetRef !== undefined && (context.cohorts ?? []).includes(assignment.targetRef)
      );
  }
}

/**
 * 该策略是否适用于该用户。
 *
 * ★ 多条分配时：**任一命中即可**（OR 语义）——"给某用户单独开白名单"
 *   与"给某标签全量开放"可以并存。
 * ★ 但灰度是**逐条**判定的：命中 `all`（100%）即适用，
 *   命中 `tag`（10%）还要通过它自己的灰度。
 */
export function decidePolicyAssignment(
  assignments: readonly PolicyAssignment[],
  context: AssignmentContext,
): AssignmentDecision {
  const active = assignments.filter((assignment) => assignment.enabled);
  if (active.length === 0) return { applies: false, reason: 'no_assignment' };

  const targeted = active.filter((assignment) => isTargeted(assignment, context));
  if (targeted.length === 0) return { applies: false, reason: 'not_targeted' };

  let abortedCount = 0;
  for (const assignment of targeted) {
    // ★★ **熔断优先**（`docs/05 §6.3.1`：止血不能被任何名单或比例阻挡）——
    //   已熔断的策略整条跳过：它的**所有**用户都回旧版本，与比例、标签都无关。
    if (context.abortedPolicyIds?.includes(assignment.policyId) === true) {
      abortedCount += 1;
      continue;
    }
    const included = inRollout({
      policyId: assignment.policyId,
      userId: context.userId,
      rolloutPercent: assignment.rolloutPercent,
    });
    if (included) {
      return {
        applies: true,
        via: assignment.targetType,
        assignment,
        rollout: assignment.rolloutPercent >= 100 ? 'not_applicable' : 'included',
      };
    }
  }
  // ★ 区分「被灰度排除」与「被熔断」：两者的**运维动作完全不同**
  //   （前者是正常抽样、后者要去看熔断原因与受影响清单）——
  //   报告里混为一谈会让排障走错方向。
  return abortedCount > 0 && abortedCount === targeted.length
    ? { applies: false, reason: 'rollout_aborted' }
    : { applies: false, reason: 'rollout_excluded' };
}

// ─────────────────────────── 存储契约 ───────────────────────────

export interface PolicyAssignmentStore {
  /** 列出本站点的分配；给 `policyId` 时只列该策略的 */
  list(policyId?: string): Promise<readonly PolicyAssignment[]>;
  put(assignment: PolicyAssignment): Promise<void>;
  remove(id: string): Promise<void>;
}

export class InMemoryPolicyAssignmentStore implements PolicyAssignmentStore {
  readonly #rows = new Map<string, PolicyAssignment>();

  async list(policyId?: string): Promise<readonly PolicyAssignment[]> {
    return [...this.#rows.values()]
      .filter((row) => policyId === undefined || row.policyId === policyId)
      .map((row) => ({ ...row }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async put(assignment: PolicyAssignment): Promise<void> {
    this.#rows.set(assignment.id, { ...assignment });
  }

  async remove(id: string): Promise<void> {
    this.#rows.delete(id);
  }
}
