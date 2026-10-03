/**
 * 策略求值（M1-9 / M1-10）—— 产出**完整结果树**，供用户侧「我的资格」渲染。
 *
 * 求值是**纯函数**：给定 (策略, 用户, 事实, 绑定, 时间) 就能复现同一结论。
 * 这一点是「历史评估可复现」（docs/07 M2-7）与「试算」（M2-8）的前提。
 *
 * ★ 决策顺序（与 docs/04 §1.3 一致）：
 *   1. `match` 不通过 → `not_applicable`（本策略不管这个主体）
 *   2. `match` 不可判定 → `indeterminate`（**不得**当成不适用：那会静默放过本应判定的主体）
 *   3. 形态 A：`expression` 求值
 *   4. 形态 B：`branches` 顺序求值，**首个 `satisfied` 命中即停**；全不命中 → `defaultOutcome`
 *   5. 任何 `indeterminate` → 结论 `indeterminate`（H1：不降级），除非分支明确把它当未命中
 */

import { collectFailures, collectIndeterminate, evaluateExpression, type EvaluationContext, type Expression, type ExplainNode, type Truth } from './expr.ts';
import type { ActionSpec, PolicyDocument } from './model.ts';

export type PolicyDecision = 'satisfied' | 'unsatisfied' | 'indeterminate' | 'not_applicable' | 'error';

export interface BranchTrace {
  id: string;
  label?: string;
  /** 该分支的求值结论 */
  state: Truth;
  /** 是否命中（即成为最终结论来源） */
  hit: boolean;
  tree: ExplainNode;
}

export interface PolicyEvaluation {
  policyCode: string;
  /** 引用版本（保证可复现） */
  version?: number;
  form: 'expression' | 'branches';
  decision: PolicyDecision;
  /** 用于展示的一句话结论 */
  summary: string;
  /** match 阶段的结果树 */
  matchTree?: ExplainNode;
  /** 形态 A 的结果树 */
  requirementTree?: ExplainNode;
  /** 形态 B 的逐分支轨迹（含未求值的分支——短路时长度为已求值数） */
  branches?: BranchTrace[];
  /** 最终选中的分支（形态 B） */
  selectedBranch?: string;
  /** 将要执行的动作（仅 decision=satisfied/unsatisfied 时有意义） */
  actions: readonly ActionSpec[];
  /** 不可判定的事实路径（用于「差哪一项」与 $onMissing 归因） */
  missing: string[];
  /** 不满足的叶子（用户侧「差在哪、差多少」） */
  failures: ExplainNode[];
  /** 求值异常信息（decision=error 时） */
  error?: string;
}

export interface PolicyEvaluationInput {
  policy: PolicyDocument;
  context: EvaluationContext;
  /** 渠道自动推断的结果（仅为可观测性记录，不参与判定） */
  inferredChannels?: readonly string[];
}

/**
 * 求值单个策略。
 *
 * 不抛错：任何内部异常都被收敛为 `decision: 'error'` 并带上原因——
 * 因为在巡检场景里，一条策略写坏了不该让整个主体的评估链中断。
 */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const { policy, context } = input;
  // ★ 策略级 missingPolicy 覆盖全局默认：某些策略问的就是「有没有这个事实」
  const effectiveContext: EvaluationContext =
    policy.spec.missingPolicy === undefined ? context : { ...context, missingPolicy: policy.spec.missingPolicy };
  const base = {
    policyCode: policy.code,
    ...(policy.version === undefined ? {} : { version: policy.version }),
  };

  try {
    // ── 1) match ──
    let matchTree: ExplainNode | undefined;
    if (policy.spec.match !== undefined) {
      matchTree = evaluateExpression(policy.spec.match, { context: effectiveContext });
      if (matchTree.state === 'false') {
        return {
          ...base,
          form: policy.spec.requirements.branches === undefined ? 'expression' : 'branches',
          decision: 'not_applicable',
          summary: '本策略不适用于该主体（match 未通过）',
          matchTree,
          actions: [],
          missing: [],
          failures: [],
        };
      }
      if (matchTree.state === 'indeterminate') {
        return {
          ...base,
          form: policy.spec.requirements.branches === undefined ? 'expression' : 'branches',
          decision: 'indeterminate',
          summary: '合流条件不可判定（关键事实缺失），不推进状态',
          matchTree,
          actions: [],
          missing: [...new Set(matchTree.missing ?? [])],
          failures: [],
        };
      }
    }

    // ── 2) 形态 A ──
    if (policy.spec.requirements.expression !== undefined) {
      const tree = evaluateExpression(policy.spec.requirements.expression, { context: effectiveContext });
      const decision = toDecision(tree.state);
      return {
        ...base,
        form: 'expression',
        decision,
        summary: describe(decision, tree),
        ...(matchTree === undefined ? {} : { matchTree }),
        requirementTree: tree,
        actions: actionsFor(policy, decision),
        missing: [...new Set(tree.missing ?? [])],
        failures: collectFailures(tree),
      };
    }

    // ── 3) 形态 B：有序分支 ──
    const branches = policy.spec.requirements.branches ?? [];
    const traces: BranchTrace[] = [];
    for (const branch of branches) {
      const tree = evaluateExpression(branch.when, { context: effectiveContext });
      const branchOutcome = branch.outcome ?? 'satisfied';
      // ★ 命中判据只看 `when` 是否为真——**与 outcome 无关**。
      //   `outcome: unsatisfied` 表达的是「命中这个条件时，结论是不满足」，
      //   典型用法是「排除分支」（如黑名单域名）。
      //   早期写成 `state === (outcome === 'satisfied' ? 'true' : 'false')`，
      //   语义被反转为「when 为假才算命中」，导致排除分支永不生效、正常分支被跳过。
      const hit = tree.state === 'true';
      traces.push({
        id: branch.id,
        state: tree.state,
        hit,
        tree,
        ...(branch.label === undefined ? {} : { label: branch.label }),
      });
      if (!hit && tree.state === 'indeterminate') {
        // 分支不可判定：**不能跳过**——若跳过，后面分支可能给出「不满足」，
        // 从而把「不知道」当成「不满足」（H1 违规）。因此立刻以 indeterminate 收敛。
        return {
          ...base,
          form: 'branches',
          decision: 'indeterminate',
          summary: `分支 '${branch.label ?? branch.id}' 不可判定（关键事实缺失），不推进状态`,
          ...(matchTree === undefined ? {} : { matchTree }),
          branches: traces,
          actions: [],
          missing: [...new Set(tree.missing ?? [])],
          failures: [],
        };
      }
      if (hit) {
        const decision: PolicyDecision = branchOutcome === 'satisfied' ? 'satisfied' : 'unsatisfied';
        return {
          ...base,
          form: 'branches',
          decision,
          summary: `命中分支 '${branch.label ?? branch.id}'：${describe(decision, tree)}`,
          ...(matchTree === undefined ? {} : { matchTree }),
          branches: traces,
          selectedBranch: branch.id,
          actions: branch.actions ?? actionsFor(policy, decision),
          missing: [...new Set(tree.missing ?? [])],
          failures: collectFailures(tree),
        };
      }
    }

    // 全不命中
    const defaultOutcome = policy.spec.requirements.defaultOutcome ?? 'unsatisfied';
    const decision: PolicyDecision = defaultOutcome === 'indeterminate' ? 'indeterminate' : 'unsatisfied';
    return {
      ...base,
      form: 'branches',
      decision,
      summary: `未命中任何分支（${branches.length} 个分支全部不满足）`,
      ...(matchTree === undefined ? {} : { matchTree }),
      branches: traces,
      actions: actionsFor(policy, decision),
      missing: [],
      failures: traces.flatMap((trace) => collectFailures(trace.tree)),
    };
  } catch (error) {
    return {
      ...base,
      form: policy.spec.requirements.branches === undefined ? 'expression' : 'branches',
      decision: 'error',
      summary: `策略求值异常：${error instanceof Error ? error.message : String(error)}`,
      actions: [],
      missing: [],
      failures: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toDecision(state: Truth): PolicyDecision {
  return state === 'true' ? 'satisfied' : state === 'false' ? 'unsatisfied' : 'indeterminate';
}

function describe(decision: PolicyDecision, tree: ExplainNode): string {
  switch (decision) {
    case 'satisfied':
      return '满足全部条件';
    case 'unsatisfied': {
      const failures = collectFailures(tree);
      if (failures.length === 0) return '不满足条件';
      return `不满足 ${failures.length} 项：${failures
        .slice(0, 3)
        .map((f) => f.label ?? f.reason)
        .join('；')}`;
    }
    case 'indeterminate': {
      const missing = collectIndeterminate(tree);
      return `关键事实缺失（${missing.length} 项），无法判定`;
    }
    default:
      return tree.reason;
  }
}

function actionsFor(policy: PolicyDocument, decision: PolicyDecision): readonly ActionSpec[] {
  if (decision === 'satisfied') return policy.spec.actions?.onSatisfied ?? [];
  if (decision === 'unsatisfied') return policy.spec.actions?.onUnsatisfied ?? [];
  // indeterminate / not_applicable / error：**不产生动作**（H1：不推进状态）
  return [];
}

// ─────────────────────────── 用户侧「我的资格」视图 ───────────────────────────

export interface EligibilityItem {
  /** 展示文案 */
  label: string;
  state: Truth;
  /** 「差多少」：期望值 */
  expected?: unknown;
  /** 「差多少」：实际值 */
  actual?: unknown;
  reason: string;
}

export interface EligibilityView {
  policyCode: string;
  decision: PolicyDecision;
  summary: string;
  /** 逐项展示（用户侧只看得到叶子，不看内部结构） */
  items: EligibilityItem[];
  /** 缺失项（提示「请完成 X」） */
  missingLabels: string[];
}

/**
 * 把结果树投影成**用户可读**的资格视图（M1-10）。
 *
 * 只暴露叶子级信息：内部逻辑结构（all/any 的嵌套）对用户没有意义，
 * 且暴露它会让「差哪一项」淹没在括号里。所有叶子都会列出（含通过的），
 * 这样用户能看到完整进度而不只是失败项。
 */
export function toEligibilityView(evaluation: PolicyEvaluation): EligibilityView {
  const trees: ExplainNode[] = [];
  if (evaluation.requirementTree !== undefined) trees.push(evaluation.requirementTree);
  for (const branch of evaluation.branches ?? []) trees.push(branch.tree);

  const items: EligibilityItem[] = [];
  const missingLabels: string[] = [];
  for (const tree of trees) {
    for (const leaf of collectLeaves(tree)) {
      const label = leaf.label ?? humanize(leaf);
      items.push({
        label,
        state: leaf.state,
        reason: leaf.reason,
        ...(leaf.expected === undefined ? {} : { expected: leaf.expected }),
        ...(leaf.actual === undefined ? {} : { actual: leaf.actual }),
      });
      if (leaf.state === 'indeterminate') missingLabels.push(label);
    }
  }

  return {
    policyCode: evaluation.policyCode,
    decision: evaluation.decision,
    summary: evaluation.summary,
    items,
    missingLabels: [...new Set(missingLabels)],
  };
}

/** 收集所有叶子（无 children 的节点）。 */
export function collectLeaves(node: ExplainNode): ExplainNode[] {
  if (node.children === undefined || node.children.length === 0) return [node];
  return node.children.flatMap((child) => collectLeaves(child));
}

/**
 * 把叶子渲染成**用户可读**的文案。
 *
 * ★ 为什么不能直接暴露 `fact.x.y gte`：M1 的验收标准是「用户能看到差哪一项」。
 *   内部路径与操作符名对用户没有意义——把它原样显示等于没做「可解释」。
 *   策略作者应当用 `$label` 给出业务文案；没有 `$label` 时这里做一次尽力翻译。
 */
const OP_TEXT: Record<string, string> = {
  eq: '等于',
  ne: '不等于',
  gt: '大于',
  gte: '不低于',
  lt: '小于',
  lte: '不高于',
  between: '介于',
  in: '属于',
  not_in: '不属于',
  contains: '包含',
  not_contains: '不包含',
  subset_of: '是子集',
  superset_of: '是超集',
  intersects: '有交集',
  matches: '匹配',
  regex: '匹配正则',
  prefix: '以…开头',
  suffix: '以…结尾',
  exists: '已有',
  not_exists: '尚未有',
  is_null: '为空',
  is_empty: '为空',
  before: '早于',
  after: '晚于',
  within_days: '在若干天内',
  divisible_by: '可整除',
};

// ★★★★ R112：此处原有一张**硬编码的文案表** `FIELD_TEXT`，列举了具体插件的事实路径：
//   `fact.github.total_stars` / `fact.qq.level` / `fact.llm.pr_score` / `fact.checkin.*` …
//
//   ★ 它与 `docs/07:150` 的架构验收 **M4-17「宿主无知」** 冲突——
//     原文要求「**核心逻辑 grep `github` 为 0**」，而本表让**核心知道了具体插件**。
//   ★ 而 `docs/07:175` 的 M6-9（`grep newapi` 为 0）**已被 CI 第 7 项覆盖**，
//     但 M4-17 的「grep `github`」**从未被覆盖**（CI 的品牌名清单只有 `newapi`/`new-api`）。
//
//   ★ **已删除**。依据：
//     ① 展示文案的**正确来源是策略自己**（`$label`）——`humanize` 的调用点已优先用 `leaf.label`：
//        `const label = leaf.label ?? humanize(leaf);`
//     ② 其次的来源应是**插件清单**（`factSchema.properties[*].title`）——
//        ★ 但当前 `factSchema` **没有 `title`**（`configSchema` 有），因此本轮不引入派生；
//     ③ 兜底已存在且足够：`path.replace(/^(fact|user|binding)\./, '').replace(/_/g, ' ')`
//        —— 即**原样显示**事实路径（如 `github total stars`）。
//
//   ★ 代价：**未声明 `$label` 的路径文案会退化**（从「GitHub 总 star 数」变为「github total stars」）。
//     收益：**核心不再知道任何具体插件**（M4-17 后半达成）。
//   ★ 若要恢复友好文案，正确做法是给 `factSchema.properties[*]` 加 `title` 并**从清单派生**——
//     已登记在 `reports/architecture-gaps.md`（含落地步骤）。

function humanize(leaf: ExplainNode): string {
  if (leaf.operand === undefined) return leaf.kind;
  const path = leaf.operand.path;
  // ★ R112：不再查硬编码表（见上方说明）——直接**原样显示**路径的叶子部分。
  const field = path.replace(/^(fact|user|binding)\./, '').replace(/_/g, ' ');
  const op = leaf.op === undefined ? '' : (OP_TEXT[leaf.op] ?? leaf.op);
  // `exists` / `not_exists` 是「有没有」类判断，拼成「已有 X」比「X 已有」更自然
  if (leaf.op === 'exists' || leaf.op === 'not_exists' || leaf.op === 'is_null' || leaf.op === 'is_empty') {
    return `${op} ${field}`;
  }
  return `${field} ${op}`.trim();
}
