/**
 * 策略最小模型 + 静态校验（M1-9）—— docs/04 §1.3。
 *
 * 策略有**两种形态**（同一套表达式语言，因此引擎只有一套求值逻辑）：
 *   A · 单一表达式：`requirements.expression`
 *   B · 有序分支：`requirements.branches[]`（首个命中即停，可带 else）
 *
 * ★ 静态校验是本模块存在的主要理由（docs/07 M1-9 的验收就是「引用未安装插件时拒绝发布」）：
 *   策略是**管理员在 UI 里编辑的文本**，写错一个命名空间不会报错，只会在运行期表现为
 *   「事实永远取不到」→ 用户永远差一项。这类缺陷必须**在发布前**拦住。
 */

import type { Expression } from './expr.ts';
import { parseOperand, validateExpressionTree, type ValidationIssue } from './expr.ts';
import { parseDuration } from '../kernel/duration.ts';
import { DEFAULT_RETENTION } from '../core/retention.ts';

// ─────────────────────────── 类型 ───────────────────────────

export type PolicyOutcome = 'satisfied' | 'unsatisfied' | 'indeterminate' | 'error';

export interface ActionSpec {
  /** `<pluginId>:<actionName>`，如 `newapi-set-group:set_group` */
  action: string;
  params?: Record<string, unknown>;
}

export interface BranchSpec {
  id: string;
  label?: string;
  when: Expression;
  /** 命中后的结论；缺省 `satisfied` */
  outcome?: 'satisfied' | 'unsatisfied';
  /** 命中后要执行的动作（覆盖策略级 onSatisfied/onUnsatisfied） */
  actions?: readonly ActionSpec[];
}

export interface PolicyRequirements {
  /** 形态 A */
  expression?: Expression;
  /** 形态 B */
  branches?: readonly BranchSpec[];
  /** 未命中任何分支时（无 else）的结论 */
  defaultOutcome?: 'unsatisfied' | 'indeterminate';
}

export interface PolicySpec {
  /** 分流：本策略适用于谁（同一套表达式语言） */
  match?: Expression;
  requirements: PolicyRequirements;
  actions?: {
    onSatisfied?: readonly ActionSpec[];
    onUnsatisfied?: readonly ActionSpec[];
  };
  /** 关键事实缺失时的处置（默认 fail_closed：不升级也不降级） */
  onMissingFact?: 'fail_closed' | 'fail_open';
  /**
   * 事实**从未采集**时的求值语义（默认 `indeterminate`）。
   *
   * 为什么需要显式声明：某些策略问的就是「有没有这个事实」，此时「没采集到」本身就是答案
   * （例如「用户尚未签到」——签到事实不存在即代表没签到）。但把这一点作为**默认**会违反 H1
   * （渠道故障被当成不满足 → 误收回资格）。因此：默认 `indeterminate`，需要「不存在即不满足」
   * 的语义时**显式**声明 `false`。
   */
  missingPolicy?: 'indeterminate' | 'false';
  /**
   * ★ 授权生命周期模式（`docs/05 §2.1.4`）。
   *
   * `one_shot` = **永久授权**：一旦授予，**不再因条件变化而撤销**。
   * ★ 它**必须**声明 `maxLifetime`——否则**发布校验拒绝**（见 `validatePolicy`）：
   *   永久授权与有限保留期的矛盾，会让「3 年前的授权」**既无法复现、也无法回滚**
   *   （它的策略版本、评估、审计、动作流水**全都过期了**）。
   */
  lifecycle?: {
    mode: 'one_shot' | 'auto_revoke' | 'manual' | 'periodic';
    /** `one_shot` 的授权最长有效期（如 `180d`）；必须 ≤ 最短保留期 */
    maxLifetime?: string;
  };
}

export interface PolicyDocument {
  /** 站点内唯一的策略编码 */
  code: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  /**
   * ★★ 策略**层级**（`ag_policies.tier`）—— 级联回退的第一层判据（`docs/05 §2.1.4`）。
   *
   * ★ 为什么它必须出现在**运行期文档**里：级联回退的文档算法是
   *   **先按 `tier` 降级、再按 `priority`**。而在此之前，DB 层虽然读到了 `tier`
   *   （行类型里有），**转换成本类型时把它丢了** ——
   *   于是回退只实现了文档算法的**第二层**，第一层从未生效。
   *   （与 `fetchImpl`/`llm` 的"装配器没透传"同族：**有了字段，链路没接上**。）
   */
  tier?: number;
  spec: PolicySpec;
  /** 引用版本（发布时由版本化流程填充；评估时记录以保证可复现） */
  version?: number;
}

// ─────────────────────────── 静态校验 ───────────────────────────

/** 宿主可提供的插件能力摘要（用于校验策略引用了什么）。 */
export interface PluginRegistry {
  /** 已安装且启用的插件 id */
  installedPlugins(): readonly string[];
  /**
   * 插件产出的事实字段（**完整表达式路径**，含 `fact.` 前缀，如 `fact.github.total_stars`）。
   *
   * ★ 口径必须与策略里的写法完全一致：`collectFactRefs` 返回的是策略里原样写的
   *   `fact.<ns>.<path>`。早期把这里定义成 `github.total_stars`（无前缀），
   *   导致**每一条策略的每一个事实引用都被误判为「未知事实」**——发布门禁形同虚设，
   *   而错误信息还指向「字段不存在」，极难定位。
   */
  knownFactKeys(): readonly string[];
  /** 插件声明的动作（`<pluginId>:<actionName>`） */
  knownActions(): readonly string[];
}

export interface PolicyValidationResult {
  issues: ValidationIssue[];
  /** 策略引用到但未安装的插件 */
  missingPlugins: string[];
  /** 策略引用到但无人产出的事实键 */
  unknownFacts: string[];
  /** 策略引用到但不存在的动作 */
  unknownActions: string[];
  /** 事实命名空间 → 使用次数（供「渠道自动推断」，docs/04 §1.1） */
  inferredChannels: string[];
}

const ACTION_REF = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*$/;

/**
 * 收集策略中出现的所有 `fact.<ns>.<path>` 引用。
 *
 * 这同时服务于「渠道自动推断」（docs/04 §1.1）：表达式里写 `fact.qq.level` 就够了，
 * **不需要声明 channel**——宿主从命名空间反查插件。
 */
export function collectFactRefs(expression: unknown, out = new Set<string>()): Set<string> {
  if (expression === null || typeof expression !== 'object') return out;
  if (Array.isArray(expression)) {
    for (const item of expression) collectFactRefs(item, out);
    return out;
  }
  const record = expression as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('$')) continue;
    // 比较节点的形态：{ op: { <operandPath>: expected } }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      // ★★ 冒号限定写法（`fact:<ns>.<path>`）也要认 —— 否则它**永不采集**：
      //    配合求值层的字面量退化，策略会**静默失效**（而 `docs/04 §1.2.7` 推荐的正是限定写法）。
      const looksLikeOperandMap = entries.some(([k]) => /^(fact|user|binding|me|identity)[.:]/.test(k));
      if (looksLikeOperandMap) {
        for (const [operand] of entries) {
          // ★ 统一**归一为点号形式**再收集：下游（`factCollectedAt` / 依赖规划）按 `fact.<ns>.<path>` 取用
          if (operand.startsWith('fact.')) out.add(operand);
          else if (operand.startsWith('fact:')) out.add(`fact.${operand.slice('fact:'.length)}`);
        }
        continue;
      }
    }
    collectFactRefs(value, out);
  }
  return out;
}

/**
 * ★★ 收集策略里引用的 **`identity:` 地址**（`docs/04 §1.2.7.3`）。
 *
 * ★ 为什么**独立**收集、而不是塞进 `collectFactRefs`：
 *   - 事实按「命名空间 + 路径」取（`fact.<ns>.<path>`），身份按**完整地址**取；
 *   - 装配阶段要靠这份清单去 `ag_identities` **预加载**（求值是同步的，见
 *     `EvaluationContext.identity` 的说明）。
 * ★ 键保持**书写原样**（`identity:oidc@<ref>.<claim>`）—— 与 `context.identity` 的键逐字一致，
 *   不引入"短名 → 地址"的第二套映射（那是分叉的温床）。
 */
export function collectIdentityRefs(expression: unknown, out = new Set<string>()): Set<string> {
  if (expression === null || typeof expression !== 'object') return out;
  if (Array.isArray(expression)) {
    for (const item of expression) collectIdentityRefs(item, out);
    return out;
  }
  const record = expression as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('$')) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      // ★ 与 `collectFactRefs` 同一个识别口径（`identity:` 或 `identity.` 前缀）
      const looksLikeOperandMap = entries.some(([k]) => /^(fact|user|binding|me|identity)[.:]/.test(k));
      if (looksLikeOperandMap) {
        for (const [operand] of entries) {
          if (operand.startsWith('identity:')) out.add(operand);
        }
        continue;
      }
    }
    collectIdentityRefs(value, out);
  }
  return out;
}

/** 从 `fact.<ns>.<path>` 取命名空间。 */
export function namespaceOf(factPath: string): string {
  const ref = parseOperand(factPath);
  return ref.namespace ?? '';
}

/**
 * 收集策略里声明的全部动作引用（策略级 + 分支级）。
 *
 * 注意：**默认参数会让 TS 把它推断成回调签名**（`(spec, index?) => ActionSpec[]`），
 * 于是 `for (const x of collectActions(spec))` 会被当成迭代 `void`。
 * 这里刻意不用默认参数，签名显式化。
 */
function gatherActionRefs(spec: PolicySpec): ActionSpec[] {
  const out: ActionSpec[] = [];
  for (const action of spec.actions?.onSatisfied ?? []) out.push(action);
  for (const action of spec.actions?.onUnsatisfied ?? []) out.push(action);
  for (const branch of spec.requirements.branches ?? []) {
    for (const action of branch.actions ?? []) out.push(action);
  }
  return out;
}

/**
 * 策略静态校验（发布前门禁）。
 *
 * 覆盖：
 *   1. 形态互斥：`expression` 与 `branches` 只能有一个（同时写会让「哪个生效」不确定）
 *   2. 表达式树本身合法（复用 `validateExpressionTree` 的全部规则）
 *   3. **引用未安装的插件 → 拒绝**（M1-9 的验收项）
 *   4. 引用无人产出的事实键 → 拒绝（否则运行期表现为「永远差一项」）
 *   5. 引用不存在的动作 → 拒绝
 *   6. 动作引用格式合法
 *   7. 分支 id 唯一
 */
export function validatePolicy(document: PolicyDocument, registry: PluginRegistry): PolicyValidationResult {
  const issues: ValidationIssue[] = [];
  const missingPlugins = new Set<string>();
  const unknownFacts = new Set<string>();
  const unknownActions = new Set<string>();

  const spec = document.spec;
  const installed = new Set(registry.installedPlugins());
  const knownFacts = new Set(registry.knownFactKeys());
  const knownActions = new Set(registry.knownActions());

  // 1) 形态互斥
  const hasExpression = spec.requirements.expression !== undefined;
  const hasBranches = spec.requirements.branches !== undefined;
  if (hasExpression && hasBranches) {
    issues.push({
      path: '$.spec.requirements',
      message: '不能同时声明 expression 与 branches（两种形态互斥，同时写会让「哪个生效」不确定）',
    });
  }
  if (!hasExpression && !hasBranches) {
    issues.push({ path: '$.spec.requirements', message: '必须声明 expression 或 branches 之一' });
  }

  // 2) 表达式树校验
  if (spec.match !== undefined) {
    for (const issue of validateExpressionTree(spec.match, { path: '$.spec.match' })) issues.push(issue);
  }
  if (hasExpression) {
    for (const issue of validateExpressionTree(spec.requirements.expression, { path: '$.spec.requirements.expression' })) {
      issues.push(issue);
    }
  }
  if (hasBranches) {
    const branches = spec.requirements.branches ?? [];
    if (branches.length === 0) {
      issues.push({ path: '$.spec.requirements.branches', message: 'branches 不能为空数组（无条件请用 expression: { always: true }）' });
    }
    const seen = new Set<string>();
    branches.forEach((branch, index) => {
      const path = `$.spec.requirements.branches[${index}]`;
      if (typeof branch.id !== 'string' || branch.id.length === 0) {
        issues.push({ path: `${path}.id`, message: '分支 id 必需（用于审计与结果树定位）' });
      } else if (seen.has(branch.id)) {
        issues.push({ path: `${path}.id`, message: `分支 id '${branch.id}' 重复（必须唯一）` });
      } else {
        seen.add(branch.id);
      }
      if (branch.when === undefined) {
        issues.push({ path: `${path}.when`, message: '分支必须声明 when' });
      } else {
        for (const issue of validateExpressionTree(branch.when, { path: `${path}.when` })) issues.push(issue);
      }
      if (branch.outcome !== undefined && branch.outcome !== 'satisfied' && branch.outcome !== 'unsatisfied') {
        issues.push({ path: `${path}.outcome`, message: `未知 outcome '${String(branch.outcome)}'（允许 satisfied | unsatisfied）` });
      }
    });
  }

  // 3) 事实引用 → 插件/事实键校验
  const expressions: { path: string; expression: unknown }[] = [];
  if (spec.match !== undefined) expressions.push({ path: '$.spec.match', expression: spec.match });
  if (hasExpression) expressions.push({ path: '$.spec.requirements.expression', expression: spec.requirements.expression });
  for (const [index, branch] of (spec.requirements.branches ?? []).entries()) {
    expressions.push({ path: `$.spec.requirements.branches[${index}].when`, expression: branch.when });
  }

  const allFactRefs = new Set<string>();
  for (const { path, expression } of expressions) {
    for (const factPath of collectFactRefs(expression)) {
      allFactRefs.add(factPath);
      const namespace = namespaceOf(factPath);
      if (namespace.length === 0) continue;
      if (!installed.has(namespace)) {
        missingPlugins.add(namespace);
        issues.push({
          path,
          message: `引用了未安装的插件命名空间 '${namespace}'（${factPath}）——拒绝发布。已安装：${[...installed].sort().join(', ') || '无'}`,
        });
        continue;
      }
      if (!knownFacts.has(factPath)) {
        unknownFacts.add(factPath);
        issues.push({
          path,
          message: `事实 '${factPath}' 不在插件 '${namespace}' 声明的 factSchema 中——拒绝发布（否则运行期会表现为「永远差这一项」）`,
        });
      }
    }
  }

  // 3.5) ★ 授权生命周期（docs/05 §2.1.4）
  //   `one_shot` 是**永久授权**，而保留期是有限的——不声明 `maxLifetime` 就发布，
  //   等于制造一个「既无法复现、也无法回滚」的授权：3 年后要回滚它时，
  //   它的策略版本 / 评估 / 审计 / 动作流水**全都已经过期**。
  //   ★ 这条校验必须在**发布时**（不是运行期）：一旦授予，这个决定就收不回来了。
  const lifecycle = spec.lifecycle;
  if (lifecycle?.mode === 'one_shot') {
    const declared = lifecycle.maxLifetime;
    if (declared === undefined || declared.trim().length === 0) {
      issues.push({
        path: 'spec.lifecycle.maxLifetime',
        message:
          '`one_shot`（永久授权）必须声明 `maxLifetime`——否则该授权会比它的证据活得更久：' +
          '既无法复现、也无法解释、更无法回滚（docs/05 §2.1.4）',
      });
    } else {
      const lifetimeMs = parseDuration(declared, -1);
      if (lifetimeMs <= 0) {
        issues.push({
          path: 'spec.lifecycle.maxLifetime',
          message: `无法解析 maxLifetime '${declared}'（应为 180d / 30d / 12h 之类）`,
        });
      } else {
        const shortestDays = Math.min(
          DEFAULT_RETENTION.evaluationsDays,
          DEFAULT_RETENTION.auditDays,
          DEFAULT_RETENTION.actionsDays,
        );
        if (lifetimeMs > shortestDays * 86_400_000) {
          issues.push({
            path: 'spec.lifecycle.maxLifetime',
            message:
              `maxLifetime ${declared} 超过最短保留期 ${shortestDays} 天` +
              `（评估 ${DEFAULT_RETENTION.evaluationsDays} / 审计 ${DEFAULT_RETENTION.auditDays} / ` +
              `动作流水 ${DEFAULT_RETENTION.actionsDays}）——授权不能比它的证据活得更久（docs/05 §2.1.4）`,
          });
        }
      }
    }
  }

  // 4) 动作校验
  for (const action of gatherActionRefs(spec)) {
    if (typeof action.action !== 'string' || !ACTION_REF.test(action.action)) {
      issues.push({
        path: '$.spec.actions',
        message: `动作引用 '${String(action.action)}' 格式非法：应为 <pluginId>:<actionName>（小写字母开头，actionName 为 snake_case）`,
      });
      continue;
    }
    if (!knownActions.has(action.action)) {
      unknownActions.add(action.action);
      issues.push({
        path: '$.spec.actions',
        message: `动作 '${action.action}' 不存在——拒绝发布。可用：${[...knownActions].sort().join(', ') || '无'}`,
      });
    }
  }

  // 5) onMissingFact 取值
  if (spec.onMissingFact !== undefined && spec.onMissingFact !== 'fail_closed' && spec.onMissingFact !== 'fail_open') {
    issues.push({ path: '$.spec.onMissingFact', message: `未知取值 '${String(spec.onMissingFact)}'（允许 fail_closed | fail_open）` });
  }
  if (spec.missingPolicy !== undefined && spec.missingPolicy !== 'indeterminate' && spec.missingPolicy !== 'false') {
    issues.push({ path: '$.spec.missingPolicy', message: `未知取值 '${String(spec.missingPolicy)}'（允许 indeterminate | false）` });
  }

  return {
    issues,
    missingPlugins: [...missingPlugins].sort(),
    unknownFacts: [...unknownFacts].sort(),
    unknownActions: [...unknownActions].sort(),
    inferredChannels: [...new Set([...allFactRefs].map(namespaceOf))].filter((ns) => ns.length > 0).sort(),
  };
}

export class PolicyValidationError extends Error {
  override readonly name = 'PolicyValidationError';
  readonly result: PolicyValidationResult;
  constructor(document: PolicyDocument, result: PolicyValidationResult) {
    super(
      `策略 '${document.code}' 未通过发布前校验（${result.issues.length} 个问题）：\n` +
        result.issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n'),
    );
    this.result = result;
  }
}

/** 校验并在有问题时抛出（发布入口调用）。 */
export function assertPolicyPublishable(document: PolicyDocument, registry: PluginRegistry): PolicyValidationResult {
  const result = validatePolicy(document, registry);
  if (result.issues.length > 0) throw new PolicyValidationError(document, result);
  return result;
}
