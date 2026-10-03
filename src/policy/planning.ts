/**
 * 策略规划：渠道自动推断 · 阶梯门槛 · 完整解释（M3-12 / M3-11 / M3-13）
 * —— docs/04 §1.1、§1.4、§1.6；docs/02 §7.3（`ag_policies` 的 tier / requiresTier / collision）。
 *
 * 三项都是「策略**执行前**的规划与解释」，因此放在一个模块里：
 * 它们的共同输入是「策略 + 表达式」，共同输出是「该做什么 / 为什么」。
 *
 * ★ M3-12 的核心立场（docs/04 §1.4）：**策略里不写 `channel`**。
 *   表达式里出现 `fact.<ns>.*`，宿主自动完成依赖解析：
 *   ```
 *   ① 遍历表达式树，收集 fact 命名空间引用
 *   ② 命名空间 → 插件
 *   ③ enricher 的依赖递归展开（按 manifest 的 consumes）
 *   ④ 拓扑排序成 DAG，按需调用
 *   ⑤ 静态校验：引用了未安装/未启用的命名空间 → 拒绝发布
 *   ```
 *   ★ 为什么这条重要：若要求策略作者手写 `channel: qq`，他就必须知道
 *     「这个事实由哪个插件产出」——而那是**平台的部署信息**，不该泄漏到策略里。
 *     更糟的是：同一条策略在「装了 qq 插件」与「没装」的环境里写法不同，
 *     策略就无法在环境间复制。
 *
 * ★ 步骤 ③ 的**递归展开**是关键：`fact.llm.pr_score` 来自 `llm-review`，
 *   而它 `consumes: ['github.pr_list']` —— 所以要先有 github 的事实。
 *   依赖链必须**拓扑排序**并按序执行，否则 enricher 会读到空输入。
 */

import type { PolicyDocument } from './model.ts';
import type { Expression } from './expr.ts';

// ─────────────────────────── 类型 ───────────────────────────

/** 插件在规划器眼里的最小视图（避免依赖完整的 manifest）。 */
export interface PluginDescriptor {
  pluginId: string;
  kind: 'channel' | 'enricher' | 'action' | 'feature' | 'identity';
  /** 该插件产出的**事实命名空间**（如 `qq`、`github`、`llm`） */
  namespaces: readonly string[];
  /** enricher 消费的事实路径（如 `github.pr_list`）——用于递归展开 */
  consumes?: readonly string[];
  enabled: boolean;
}

export interface DependencyPlan {
  /** 需要的插件（**已按拓扑序**：被依赖者在前） */
  order: readonly string[];
  /** 每个插件的依赖来源（`pluginId → 它依赖的 pluginId[]`），供排障展示 */
  edges: Readonly<Record<string, readonly string[]>>;
  /** 直接由表达式引用的命名空间 */
  referencedNamespaces: readonly string[];
  /** 静态校验发现的问题（非空则**拒绝发布**） */
  issues: readonly string[];
}

export class DependencyError extends Error {
  override readonly name = 'DependencyError';
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`渠道依赖解析失败：\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.issues = issues;
  }
}

// ─────────────────────────── ① 收集引用 ───────────────────────────

/**
 * 遍历表达式树，收集所有 `fact.<namespace>.*` 引用。
 *
 * ★ 必须遍历**全部**结构：逻辑节点（all/any/not/none/atLeast/…）、score 的权重项、
 *   `$ref`（此处只记名字，由调用方决定是否展开 defs）、比较节点的操作数。
 *   漏掉任何一类都会让「策略用了某插件但规划器不知道」→ 运行时读到空事实。
 */
export function collectFactNamespaces(expression: Expression): string[] {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;

    // 比较节点：`{ op: { operand: value } }`
    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith('$')) continue; // 保留属性
      if (key === 'all' || key === 'any' || key === 'none') {
        visit(value);
        continue;
      }
      if (key === 'not') {
        visit(value);
        continue;
      }
      if (key === 'atLeast' || key === 'atMost' || key === 'exactly') {
        if (value !== null && typeof value === 'object') visit((value as { of?: unknown }).of);
        continue;
      }
      if (key === 'score') {
        if (value !== null && typeof value === 'object') {
          for (const entry of ((value as { of?: unknown[] }).of ?? [])) {
            if (entry !== null && typeof entry === 'object') visit((entry as { expr?: unknown }).expr);
          }
        }
        continue;
      }
      // 操作数映射：`{ 'fact.qq.level': 40 }`
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const operand of Object.keys(value as Record<string, unknown>)) {
          const match = /^fact:([^@#.]+)(?:[@#][^.]*)?\./.exec(operand) ?? /^fact\.([^.]+)\./.exec(operand);
          if (match !== null) found.add(match[1]!);
        }
      }
    }
  };
  visit(expression);
  return [...found].sort();
}

// ─────────────────────────── ②③④ 解析与拓扑排序 ───────────────────────────

/**
 * 解析完整的插件依赖计划（步骤 ②③④）。
 *
 * ★ 环检测：enricher 互相依赖（A consumes B 的产出，B consumes A 的）会让拓扑排序失败。
 *   这时**必须报错**而不是随便挑一个顺序——随便排序会让结果依赖内存里的对象顺序，
 *   同一份 manifest 在不同机器上可能得到不同的执行序（极难复现的 bug）。
 */
export function planDependencies(input: {
  expression: Expression;
  plugins: readonly PluginDescriptor[];
}): DependencyPlan {
  const issues: string[] = [];
  const referencedNamespaces = collectFactNamespaces(input.expression);

  // ② 命名空间 → 插件
  const byNamespace = new Map<string, PluginDescriptor>();
  for (const plugin of input.plugins) {
    for (const namespace of plugin.namespaces) {
      const existing = byNamespace.get(namespace);
      if (existing !== undefined && existing.pluginId !== plugin.pluginId) {
        issues.push(`命名空间 '${namespace}' 同时被插件 '${existing.pluginId}' 与 '${plugin.pluginId}' 声明——无法确定用哪个`);
        continue;
      }
      byNamespace.set(namespace, plugin);
    }
  }
  const byId = new Map(input.plugins.map((plugin) => [plugin.pluginId, plugin]));

  // ⑤（前置部分）未安装/未启用的命名空间 → 拒绝
  const roots = new Set<string>();
  for (const namespace of referencedNamespaces) {
    const plugin = byNamespace.get(namespace);
    if (plugin === undefined) {
      issues.push(`表达式引用了命名空间 'fact.${namespace}.*'，但没有已安装的插件产出它（请安装对应插件，或修正表达式）`);
      continue;
    }
    if (!plugin.enabled) {
      issues.push(`命名空间 '${namespace}' 属于插件 '${plugin.pluginId}'，但该插件**未启用**（请在插件管理中启用）`);
      continue;
    }
    roots.add(plugin.pluginId);
  }

  // ③ 递归展开 enricher 的 consumes
  const edges = new Map<string, Set<string>>();
  const visitPlugin = (pluginId: string): void => {
    if (edges.has(pluginId)) return;
    edges.set(pluginId, new Set());
    const plugin = byId.get(pluginId);
    if (plugin === undefined) return;
    for (const consumed of plugin.consumes ?? []) {
      // `github.pr_list` / `fact.github.pr_list` 两种写法都接受
      const match = /^(?:fact\.)?([^.]+)\./.exec(consumed);
      if (match === null) continue;
      const upstream = byNamespace.get(match[1]!);
      if (upstream === undefined) {
        issues.push(`插件 '${pluginId}' 声明消费 '${consumed}'，但没有插件产出命名空间 '${match[1]}'（依赖缺失）`);
        continue;
      }
      if (!upstream.enabled) {
        issues.push(`插件 '${pluginId}' 依赖的插件 '${upstream.pluginId}'（命名空间 '${match[1]}'）未启用`);
        continue;
      }
      edges.get(pluginId)!.add(upstream.pluginId);
      visitPlugin(upstream.pluginId);
    }
  };
  for (const pluginId of roots) visitPlugin(pluginId);

  // ④ 拓扑排序（Kahn）：入度为零者先出，保证被依赖者在前
  // ★ 入度 = 「**我还需要等几个上游**」，而不是「有多少东西依赖我」。
  //   `edges` 的方向是 `from → to` 表示「from **依赖** to」，
  //   因此 `from` 的入度要 +1（它要等 to 先完成）。
  //   写反会让顺序完全颠倒——而且**看上去仍然是一个合法的拓扑序**
  //   （只是把 enricher 排在了它的数据源前面，运行时读到空输入）。
  const indegree = new Map<string, number>();
  for (const pluginId of edges.keys()) indegree.set(pluginId, 0);
  for (const [from, tos] of edges) {
    for (const _to of tos) {
      // 每个上游依赖 +1（`_to` 只用于计数）
      void _to;
      indegree.set(from, (indegree.get(from) ?? 0) + 1);
    }
  }
  // ★ Kahn 算法需要**反向邻接表**：出队一个插件后，要能找到「谁在等它」并减其入度。
  //   只有正向边（依赖者 → 被依赖者）是不够的——那样出队 github 时
  //   无法得知 llm-review 在等它，于是 llm-review 的入度永远不归零 →
  //   **误判为环**（这正是本实现最初的行为：明明无环却报「依赖存在环」）。
  const dependents = new Map<string, Set<string>>();
  for (const [from, tos] of edges) {
    for (const to of tos) {
      const set = dependents.get(to) ?? new Set<string>();
      set.add(from);
      dependents.set(to, set);
    }
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const next of [...(dependents.get(current) ?? [])].sort()) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (order.length !== indegree.size) {
    const inCycle = [...indegree.entries()].filter(([, degree]) => degree > 0).map(([id]) => id).sort();
    issues.push(`插件依赖存在**环**：${inCycle.join(' ↔ ')}——环会让依赖无法满足（必须打破其中一个 consumes 声明）`);
  }

  return {
    order: issues.length > 0 ? [] : order,
    edges: Object.fromEntries([...edges.entries()].map(([id, tos]) => [id, [...tos].sort()])),
    referencedNamespaces,
    issues,
  };
}

/** 解析失败即抛（发布前的调用形态）。 */
export function requireDependencyPlan(input: { expression: Expression; plugins: readonly PluginDescriptor[] }): DependencyPlan {
  const plan = planDependencies(input);
  if (plan.issues.length > 0) throw new DependencyError(plan.issues);
  return plan;
}

// ─────────────────────────── M3-11 阶梯门槛 ───────────────────────────

export type CollisionMode = 'exclusive' | 'additive' | 'highest_tier';

/** 带阶梯信息的策略视图（`ag_policies` 的 tier / requiresTier / collision）。 */
export type TieredPolicy = PolicyDocument & {
  tier?: number | null;
  requiresTier?: number | null;
  collision?: CollisionMode;
};

export type TierGate =
  | { runnable: true; reason: string }
  | { runnable: false; reason: 'requires_tier_unmet'; message: string };

/**
 * 判定某策略在该站点的阶梯下**是否可运行**（M3-11）。
 *
 * ★ 语义：`requiresTier` 是「前置阶梯」——站点当前阶梯（`siteTier`）达到它，
 *   这条策略才参与判定。这是「阶梯式解锁」的表达方式：
 *   低阶梯站点看不到高阶梯策略的判定，而不是「判定为不满足」
 *   （后者会让用户看到一条永远无法达成的策略，体验很差）。
 */
export function checkTierGate(policy: TieredPolicy, siteTier: number): TierGate {
  const required = policy.requiresTier;
  if (required === undefined || required === null) {
    return { runnable: true, reason: '该策略不要求前置阶梯' };
  }
  if (siteTier < required) {
    return {
      runnable: false,
      reason: 'requires_tier_unmet',
      message: `策略 '${policy.code}' 需要阶梯 ≥ ${required}（当前站点阶梯 ${siteTier}）——本策略不参与判定`,
    };
  }
  return { runnable: true, reason: `站点阶梯 ${siteTier} ≥ 所需 ${required}` };
}

/** 按阶梯门槛筛选可运行的策略（保持输入顺序，阶梯高的不会「插队」）。 */
export function filterByTier(policies: readonly TieredPolicy[], siteTier: number): { runnable: TieredPolicy[]; skipped: { policy: TieredPolicy; gate: Extract<TierGate, { runnable: false }> }[] } {
  const runnable: TieredPolicy[] = [];
  const skipped: { policy: TieredPolicy; gate: Extract<TierGate, { runnable: false }> }[] = [];
  for (const policy of policies) {
    const gate = checkTierGate(policy, siteTier);
    if (gate.runnable) runnable.push(policy);
    else skipped.push({ policy, gate });
  }
  return { runnable, skipped };
}

/**
 * 多策略命中时的**合并语义**（`ag_policies.collision`）。
 *
 * | 模式 | 语义 |
 * |---|---|
 * | `exclusive` | 命中即互斥，取 **priority 最高**的一条（其余被抑制） |
 * | `additive` | 全部生效（动作叠加） |
 * | `highest_tier` | 取 **tier 最高**的一条 |
 *
 * ★ 为什么必须显式建模：多策略同时命中时「谁生效」若是隐含的（比如「按加载顺序」），
 *   同样的配置在不同部署里会得到不同结果——而这表现为「权限莫名其妙不对」。
 */
export function resolveCollision(
  matched: readonly TieredPolicy[],
  mode: CollisionMode,
): { effective: readonly TieredPolicy[]; suppressed: readonly TieredPolicy[]; reason: string } {
  if (matched.length <= 1) return { effective: matched, suppressed: [], reason: '命中策略不超过一条，无需合并' };

  if (mode === 'additive') {
    return { effective: matched, suppressed: [], reason: `additive：${matched.length} 条策略的动作全部生效` };
  }
  const pick = (compare: (a: TieredPolicy, b: TieredPolicy) => number): TieredPolicy =>
    [...matched].sort((a, b) => {
      const diff = compare(a, b);
      // ★ 平手时按 code 稳定排序（否则「谁生效」取决于输入顺序）
      return diff !== 0 ? diff : a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    })[0]!;

  if (mode === 'highest_tier') {
    // tier 大者优先；未设 tier 视为 0
    const winner = pick((a, b) => (b.tier ?? 0) - (a.tier ?? 0));
    return {
      effective: [winner],
      suppressed: matched.filter((policy) => policy !== winner),
      reason: `highest_tier：取 tier 最高的 '${winner.code}'（tier=${winner.tier ?? 0}）`,
    };
  }
  // exclusive：priority **数值小者优先**（与 docs 的「优先级」语义一致）
  const winner = pick((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  return {
    effective: [winner],
    suppressed: matched.filter((policy) => policy !== winner),
    reason: `exclusive：取 priority 最高的 '${winner.code}'（priority=${winner.priority ?? 100}）`,
  };
}

// ─────────────────────────── M3-13 完整解释 ───────────────────────────

/** 解释条目（面向用户「差在哪」）。 */
export interface ExplainedItem {
  label: string;
  state: 'true' | 'false' | 'indeterminate';
  /** 实际值（脱敏后的展示值） */
  actual?: unknown;
  /** 期望值 */
  expected?: unknown;
  /** 人类可读的原因 */
  reason: string;
  /** 该条目的依赖插件（用户「需要绑定什么」的建议依据） */
  pluginId?: string;
}

export interface ExplainedPolicy {
  code: string;
  name: string;
  /** 是否参与判定 */
  participated: boolean;
  /** 不参与时的原因（阶梯门槛等） */
  skippedReason?: string;
  items: ExplainedItem[];
  /** 满足项 / 总项 */
  satisfiedCount: number;
  totalCount: number;
  /** 缺口清单（**给用户看的 actionable 建议**，不是技术错误） */
  gaps: string[];
}

/**
 * 把策略的判定结果转成**完整的解释**（M3-13）。
 *
 * ★ 「完整」有三层含义，缺一层用户就会困惑：
 *   1. **逐项列出**（不只是「不满足」）；
 *   2. **区分 false 与 indeterminate**——前者是「努力就能达成」，
 *      后者是「平台暂时不知道」（用户什么都不用做，等渠道恢复）；
 *   3. **给出缺口与依赖插件**——用户需要知道「要做什么」与「去哪里做」。
 */
export function explainPolicy(input: {
  policy: PolicyDocument;
  items: readonly ExplainedItem[];
  gate?: TierGate;
}): ExplainedPolicy {
  const satisfiedCount = input.items.filter((item) => item.state === 'true').length;
  const gaps: string[] = [];
  for (const item of input.items) {
    if (item.state === 'false') {
      // false = 可以努力达成 → 给具体建议
      const where = item.pluginId === undefined ? '' : `（在 ${item.pluginId} 渠道完成）`;
      gaps.push(`${item.label}：尚未满足${where}`);
    } else if (item.state === 'indeterminate') {
      // ★ indeterminate 不是用户的错，措辞必须不同
      gaps.push(`${item.label}：平台暂时无法确认（渠道数据缺失，无需操作，稍后自动恢复）`);
    }
  }
  return {
    code: input.policy.code,
    name: input.policy.name ?? input.policy.code,
    participated: input.gate === undefined ? true : input.gate.runnable,
    ...(input.gate !== undefined && !input.gate.runnable ? { skippedReason: input.gate.message } : {}),
    items: [...input.items],
    satisfiedCount,
    totalCount: input.items.length,
    gaps,
  };
}
