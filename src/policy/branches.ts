/**
 * 有序分支求值器（M3-1）—— docs/04 §1.3。
 *
 * ```
 *   requirements:
 *     branches:                    # if / else-if（有序）
 *       - { id, label, when, outcome, actions }
 *     else:                        # 可选兜底
 *       { outcome, actions }
 * ```
 *
 * ★ 文档明确：**形态 B 是形态 A 的超集**——
 *   单一 `expression` 等价于「一个 `when` + `else`」，
 *   因此实现上**只保留分支求值器**，形态 A 在解析期被规整为单分支
 *   （`normalizeRequirements`）。这样引擎只有一套判定逻辑。
 *
 * ★ 三条语义要点（都直接决定正确性）：
 *
 * 1. **首个 `when` 为真即停（短路）**：后续 `when` **不再求值**。
 *    这不只是性能——后续 `when` 可能引用需要出站采集的事实，
 *    短路能避免无谓的下游调用。`shortCircuited` 字段把这一行为变成可断言的事实。
 *
 * 2. **`indeterminate` 不能被当成 `false`**（H1）。
 *    若某个被求值的 `when` 不确定，它**既非真也非假**——
 *    此时「首个为真」可能是它，也可能在后面。因此：
 *      - 已有分支为真 → 正常短路（不确定的分支在它后面，未被求值，无影响）；
 *      - 没有任何分支为真，但路径上有 `indeterminate` → **整体 indeterminate**，
 *        绝不落到 `else`（把「不知道」当成「不满足」会误收回权限）。
 *
 * 3. **`else` 可省略**：省略即 `unsatisfied` 且无动作。
 */

import type { Logger } from '../kernel/logger.ts';

import { evaluateExpression, type ExplainNode } from './expr.ts';
import type { Expression, EvaluationContext } from './expr.ts';

// ─────────────────────────── 规范类型 ───────────────────────────

export interface BranchActionSpec {
  action: string;
  params?: Record<string, unknown>;
}

export interface BranchSpec {
  id: string;
  label?: string;
  when: Expression;
  outcome: 'satisfied' | 'unsatisfied';
  actions?: readonly BranchActionSpec[];
  /** 分支级生命周期参数覆盖（docs/04 §1.3「分支级参数」） */
  gracePeriodMs?: number;
  minChangeIntervalMs?: number;
}

export interface ElseSpec {
  outcome: 'satisfied' | 'unsatisfied';
  actions?: readonly BranchActionSpec[];
}

export interface RequirementsSpec {
  expression?: Expression;
  branches?: readonly BranchSpec[];
  else?: ElseSpec;
}

// ─────────────────────────── 规整 ───────────────────────────

export interface NormalizedRequirements {
  branches: readonly BranchSpec[];
  else?: ElseSpec;
  /** 原始形态（供 UI 与错误定位） */
  source: 'expression' | 'branches';
}

export class RequirementsShapeError extends Error {
  override readonly name = 'RequirementsShapeError';
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}

/**
 * 把两种形态规整为统一的分支形态（形态 A → 单分支）。
 *
 * ★ 为什么在解析期做而不是求值期：规整后**只有一套求值路径**，
 *   避免「形态 A 走一条代码、形态 B 走另一条」——那种实现迟早出现两条路径语义不一致。
 */
export function normalizeRequirements(requirements: RequirementsSpec): NormalizedRequirements {
  const hasExpression = requirements.expression !== undefined;
  const hasBranches = requirements.branches !== undefined && requirements.branches.length > 0;

  // ★ 文档：同一 requirements 内二者只能出现一个
  if (hasExpression && hasBranches) {
    throw new RequirementsShapeError(
      'requirements',
      '`expression` 与 `branches` 互斥：请只保留一种（`branches` 是 `expression` 的超集，需要多分支时用 `branches`）',
    );
  }
  if (!hasExpression && !hasBranches) {
    throw new RequirementsShapeError('requirements', '必须提供 `expression` 或 `branches` 之一（无条件通过请显式写 `{ always: true }`）');
  }

  if (hasExpression) {
    // 形态 A：单一表达式 → 「一个 when + else」
    return {
      branches: [
        {
          id: 'default',
          label: undefined,
          when: requirements.expression!,
          outcome: 'satisfied',
        },
      ],
      ...(requirements.else === undefined ? {} : { else: requirements.else }),
      source: 'expression',
    };
  }

  // 形态 B：校验分支结构
  const seen = new Set<string>();
  for (const [index, branch] of requirements.branches!.entries()) {
    if (typeof branch.id !== 'string' || branch.id.length === 0) {
      throw new RequirementsShapeError(`requirements.branches[${index}].id`, '分支必须有序内唯一的 id');
    }
    if (seen.has(branch.id)) {
      throw new RequirementsShapeError(`requirements.branches[${index}].id`, `分支 id '${branch.id}' 重复（id 用于审计与试算定位，必须唯一）`);
    }
    seen.add(branch.id);
    if (branch.when === undefined) {
      throw new RequirementsShapeError(`requirements.branches[${index}].when`, '分支必须提供 when 条件');
    }
    if (branch.outcome !== 'satisfied' && branch.outcome !== 'unsatisfied') {
      throw new RequirementsShapeError(`requirements.branches[${index}].outcome`, `outcome 只能是 satisfied 或 unsatisfied（实际：${String(branch.outcome)}）`);
    }
  }

  return {
    branches: requirements.branches!,
    ...(requirements.else === undefined ? {} : { else: requirements.else }),
    source: 'branches',
  };
}

// ─────────────────────────── 求值 ───────────────────────────

export type BranchDecision = 'satisfied' | 'unsatisfied' | 'indeterminate' | 'error';

export interface BranchTraceEntry {
  /** 命中的分支 id；`else` 表示兜底分支 */
  branchId: string;
  label?: string;
  /** 该分支 when 的求值结果（else 无 when，为 null） */
  whenState: 'true' | 'false' | 'indeterminate' | 'error' | null;
  /** 是否命中 */
  matched: boolean;
  /** 是否被短路跳过（未求值） */
  skipped: boolean;
}

export interface BranchEvaluation {
  decision: BranchDecision;
  /** 命中的分支 id（无命中且无 else 时为 null） */
  matchedBranchId: string | null;
  matchedLabel?: string;
  /** 生效的动作（分支级优先；未指定时回落策略级） */
  actions: readonly BranchActionSpec[];
  /** 生效的分支级参数覆盖 */
  gracePeriodMs?: number;
  minChangeIntervalMs?: number;
  /** 逐分支轨迹（含被跳过的分支——这是短路的可断言证据） */
  trace: BranchTraceEntry[];
  /** 因短路而未被求值的分支 id */
  shortCircuited: string[];
  /** 各 when 的解释树（供「差在哪一项」） */
  explanations: { branchId: string; node: ExplainNode }[];
  error?: string;
}

export interface EvaluateBranchesInput {
  requirements: RequirementsSpec;
  context: EvaluationContext;
  /** 策略级动作（分支未指定 actions 时的回落） */
  policyActions?: readonly BranchActionSpec[];
  logger?: Logger;
  maxDepth?: number;
}

/**
 * 求值有序分支。
 *
 * 短路 + 三态语义见文件头说明。
 */
export function evaluateBranches(input: EvaluateBranchesInput): BranchEvaluation {
  const normalized = normalizeRequirements(input.requirements);
  const trace: BranchTraceEntry[] = [];
  const explanations: { branchId: string; node: ExplainNode }[] = [];
  const shortCircuited: string[] = [];

  let sawError = false;
  let matched: BranchSpec | undefined;

  for (const branch of normalized.branches) {
    let node: ExplainNode;
    try {
      node = evaluateExpression(branch.when, {
        context: input.context,
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      });
    } catch (error) {
      // ★ 求值异常**不是**「不满足」：抛错时把它记为 error 并继续看后续分支，
      //   最终若无人命中则整体判 error（不得落到 else 去收回权限）。
      //   （`Truth` 只有三态，异常只能通过 throw 传出。）
      sawError = true;
      input.logger?.warn('分支 when 求值异常', {
        branchId: branch.id,
        error: error instanceof Error ? error.message : String(error),
      });
      trace.push({
        branchId: branch.id,
        ...(branch.label === undefined ? {} : { label: branch.label }),
        whenState: 'error',
        matched: false,
        skipped: false,
      });
      continue;
    }
    explanations.push({ branchId: branch.id, node });

    const state = node.state;
    if (state === 'true') {
      // ★ 短路：后续 when 不再求值
      trace.push({ branchId: branch.id, ...(branch.label === undefined ? {} : { label: branch.label }), whenState: 'true', matched: true, skipped: false });
      matched = branch;
      break;
    }
    trace.push({
      branchId: branch.id,
      ...(branch.label === undefined ? {} : { label: branch.label }),
      whenState: state,
      matched: false,
      skipped: false,
    });
    // ★★ **立即收敛**（`docs/04`：unknown → indeterminate「**向上传播**」，
    //    且 indeterminate「**保持原状态，不得降级**」）。
    //    ★ 此前这里只置 `sawIndeterminate` 后**继续看后续分支** —— 若后面的排除分支命中
    //      并给出 `unsatisfied`，「不知道」就被当成了「不满足」，从而**误收回权限**（H1 违规）。
    //    ★ 与 `evaluator.ts`（**已接线的那个实现**）的内联分支求值**逐字对齐**：
    //      两套实现给出不同答案时，"编辑器预览"与"运行期判定"就会打架。
    if (state === 'indeterminate') {
      return {
        decision: 'indeterminate',
        matchedBranchId: null,
        actions: [],
        trace,
        shortCircuited,
        explanations,
      };
    }
  }

  // 记录被短路跳过的分支
  if (matched !== undefined) {
    const matchedIndex = normalized.branches.findIndex((b) => b.id === matched!.id);
    for (const branch of normalized.branches.slice(matchedIndex + 1)) {
      shortCircuited.push(branch.id);
      trace.push({ branchId: branch.id, ...(branch.label === undefined ? {} : { label: branch.label }), whenState: null, matched: false, skipped: true });
    }
  }

  // ── 命中分支 ──
  if (matched !== undefined) {
    const actions = matched.actions ?? input.policyActions ?? [];
    return {
      decision: matched.outcome,
      matchedBranchId: matched.id,
      ...(matched.label === undefined ? {} : { matchedLabel: matched.label }),
      actions,
      ...(matched.gracePeriodMs === undefined ? {} : { gracePeriodMs: matched.gracePeriodMs }),
      ...(matched.minChangeIntervalMs === undefined ? {} : { minChangeIntervalMs: matched.minChangeIntervalMs }),
      trace,
      shortCircuited,
      explanations,
    };
  }

  // ── 无分支命中 ──

  // ★ H1 的「不确定」已在**遇到时立即返回**（见循环内）——
  //   事后判断挡不住"后续分支命中并把 indeterminate 降级为 unsatisfied"，
  //   而那正是修复前的缺陷。

  // 求值异常：不是「不满足」，不得据此收回
  if (sawError) {
    return {
      decision: 'error',
      matchedBranchId: null,
      actions: [],
      trace,
      shortCircuited,
      explanations,
      error: '至少一个分支的 when 求值异常（多为策略配置问题）',
    };
  }

  // ── else 兜底（可省略）──
  if (normalized.else !== undefined) {
    const actions = normalized.else.actions ?? input.policyActions ?? [];
    trace.push({ branchId: 'else', whenState: null, matched: true, skipped: false });
    return {
      decision: normalized.else.outcome,
      matchedBranchId: 'else',
      actions,
      trace,
      shortCircuited,
      explanations,
    };
  }

  // 省略 else：unsatisfied 且无动作
  trace.push({ branchId: 'else', whenState: null, matched: true, skipped: false });
  return {
    decision: 'unsatisfied',
    matchedBranchId: null,
    actions: [],
    trace,
    shortCircuited,
    explanations,
  };
}
