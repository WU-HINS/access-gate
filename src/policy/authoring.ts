/**
 * 三形态策略编写（M6-10）—— docs/07 M6-10、docs/04 §1.2.6。
 *
 * 验收标准原文：**「切换后发布，行为一致」**。
 *
 * ★ 这句话有两层含义，缺一不可：
 *
 * 1. **语义一致**：同一逻辑用 YAML / JSON / Graph 分别编写，发布后
 *    **对同一批主体的判定结果完全相同**——而不只是「AST 看起来一样」。
 *    因此本模块的验证必须走到**求值**这一步（`evaluatePolicy`），
 *    停在「AST 相等」是不够的（AST 相等但求值器读错字段的情况真实存在过）。
 *
 * 2. **语义去重生效**：三形态产出的 `specHash` 必须相同——
 *    否则「同一逻辑换个编辑器再存一次」会产生一个**无意义的新 draft 版本**，
 *    版本历史被噪音淹没，而「内容未变」再也无法被识别。
 *
 * ★ 本模块的定位是**编辑器入口**（authoring），而不是又一个转换器：
 *   转换逻辑只有 `expr-forms.ts` 一份（前端编辑器与后端校验必须共用它，
 *   否则「编辑器所见」与「服务端所算」必然漂移）。
 */

import type { Logger } from '../kernel/logger.ts';

import {
  formatAs,
  parseInFormat,
  specHash,
  type ExprGraph,
  type ExpressionFormat,
} from './expr-forms.ts';
import type { Expression } from './expr.ts';
import { validatePolicy, type PluginRegistry, type PolicyDocument } from './model.ts';

export type { ExpressionFormat };

// ─────────────────────────── 类型 ───────────────────────────

export interface PolicyActionSpec {
  action: string;
  params?: Record<string, unknown>;
}

export interface AuthoringInput {
  code: string;
  name: string;
  /** 表达式以哪种形态编写 */
  format: ExpressionFormat;
  /** 该形态下的表达式文本（YAML 文本 / JSON 文本 / Graph JSON 文本） */
  content: string;
  version?: number;
  priority?: number;
  enabled?: boolean;
  /** 策略适用条件（分流）——同为表达式，同样是三形态可编辑的 */
  match?: Expression;
  /** 命中时的动作 */
  onSatisfied?: readonly PolicyActionSpec[];
  /** 未命中时的动作 */
  onUnsatisfied?: readonly PolicyActionSpec[];
}

export interface BuiltPolicy {
  document: PolicyDocument;
  /** 规范 AST（唯一真理） */
  expression: Expression;
  /** 只对规范 AST 计算的指纹（语义去重依据） */
  hash: string;
  /** 原始形态（存库时保留，用于恢复编辑器状态） */
  origin: ExpressionFormat;
}

export class AuthoringError extends Error {
  override readonly name = 'AuthoringError';
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.issues = issues;
  }
}

// ─────────────────────────── 构建 ───────────────────────────

/**
 * 从任一形态构建策略文档。
 *
 * ★ 不在此处做插件引用校验（需要 `PluginRegistry`）——
 *   由调用方决定何时校验（`buildPolicy` 之后、`publish` 之前）。
 *   这样「编写」与「发布」两个动作的职责不混在一起。
 */
export function buildPolicy(input: AuthoringInput): BuiltPolicy {
  if (input.code.trim().length === 0) throw new AuthoringError('策略 code 不能为空');
  const expression = parseInFormat(input.content, input.format);

  const actions: Record<string, unknown> = {};
  if (input.onSatisfied !== undefined) actions['onSatisfied'] = input.onSatisfied;
  if (input.onUnsatisfied !== undefined) actions['onUnsatisfied'] = input.onUnsatisfied;

  const document: PolicyDocument = {
    code: input.code,
    name: input.name,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    spec: {
      ...(input.match === undefined ? {} : { match: input.match }),
      requirements: { expression },
      ...(Object.keys(actions).length === 0 ? {} : { actions }),
    } as PolicyDocument['spec'],
  };

  return { document, expression, hash: specHash(expression), origin: input.format };
}

/**
 * 把已构建的策略**切换**到另一种形态（编辑器视图切换 / 发布前转换）。
 *
 * ★ 返回的 `hash` 必须与构建时相同——这是「切换形态不改变语义」的直接证据；
 *   若不同，说明转换器丢了信息（顺序、保留属性、`always:false` 之类）。
 */
export function switchFormat(built: BuiltPolicy, to: ExpressionFormat): { format: ExpressionFormat; content: string; hash: string } {
  const content = formatAs(built.expression, to);
  // 往返校验：切过去再切回来必须仍是同一语义（防线而非装饰）
  const roundTripped = parseInFormat(content, to);
  const hash = specHash(roundTripped);
  if (hash !== built.hash) {
    throw new AuthoringError(
      `切换到 ${to} 形态后语义发生变化（hash ${built.hash} → ${hash}）——` +
        `说明转换器丢信息了，拒绝以此内容发布`,
      [`${built.origin} → ${to} 往返不等价`],
    );
  }
  return { format: to, content, hash };
}

/** 取某形态下的文本（不校验；用于展示）。 */
export function contentIn(built: BuiltPolicy, format: ExpressionFormat): string {
  return formatAs(built.expression, format);
}

// ─────────────────────────── 校验 ───────────────────────────

/**
 * 构建 + 静态校验（发布前的完整检查）。
 *
 * 校验项由 `validatePolicy` 提供（插件是否已安装、事实键是否已知、动作是否已注册……）。
 */
export function buildAndValidate(
  input: AuthoringInput,
  registry: PluginRegistry,
  options: { logger?: Logger } = {},
): BuiltPolicy {
  const built = buildPolicy(input);
  const validation = validatePolicy(built.document, registry);
  if (validation.issues.length > 0) {
    const messages = validation.issues.map((issue) => String(issue));
    options.logger?.warn('三形态编写的策略未通过校验', { code: input.code, origin: input.format, issues: messages });
    throw new AuthoringError(`策略 '${input.code}' 未通过静态校验（${messages.length} 项）`, messages);
  }
  return built;
}

// ─────────────────────────── 端到端一致性核对 ───────────────────────────

export interface FormConsistency {
  /** 三形态各自的 hash（应全部相同） */
  hashes: Record<ExpressionFormat, string>;
  /** 是否语义一致 */
  consistent: boolean;
  /** 不一致时的说明 */
  detail: string;
}

/**
 * 核对「同一逻辑的三种形态是否语义一致」。
 *
 * ★ 这是 M6-10 验收标准的**机器可核对形式**：
 *   输入三种形态的文本，输出「是否一致」与逐形态 hash。
 *   编辑器前端可以在保存前调用它，避免把「切形态时丢信息」的内容发布出去。
 */
export function checkFormConsistency(input: { yaml: string; json: string; graph: string }): FormConsistency {
  const hashes = {
    yaml: specHash(parseInFormat(input.yaml, 'yaml')),
    json: specHash(parseInFormat(input.json, 'json')),
    graph: specHash(parseInFormat(input.graph, 'graph')),
  } as Record<ExpressionFormat, string>;
  const unique = new Set(Object.values(hashes));
  return {
    hashes,
    consistent: unique.size === 1,
    detail:
      unique.size === 1
        ? '三种形态语义一致'
        : `三种形态语义不一致：${Object.entries(hashes)
            .map(([format, hash]) => `${format}=${hash}`)
            .join(' · ')}`,
  };
}

/**
 * 端到端一致性验证：三形态 → 策略文档 → 求值，逐步比对。
 *
 * ★ 与 `checkFormConsistency` 的区别：这里**一路走到判定**。
 *   M6-10 的验收标准是「**行为**一致」——只比 AST 是不够的：
 *   AST 相同但求值器读错字段的情况真实发生过（见 `me.` 前缀那一轮）。
 */
export function verifyBehaviorConsistency(
  forms: { yaml: string; json: string; graph: string },
  evaluate: (expression: Expression) => string,
): { consistent: boolean; verdicts: Record<ExpressionFormat, string>; detail: string } {
  const verdicts = {} as Record<ExpressionFormat, string>;
  for (const format of ['yaml', 'json', 'graph'] as ExpressionFormat[]) {
    verdicts[format] = evaluate(parseInFormat(forms[format], format));
  }
  const unique = new Set(Object.values(verdicts));
  return {
    consistent: unique.size === 1,
    verdicts,
    detail:
      unique.size === 1
        ? `三种形态求值结论一致（${[...unique][0]}）`
        : `三种形态求值结论不一致：${Object.entries(verdicts)
            .map(([format, verdict]) => `${format}=${verdict}`)
            .join(' · ')}`,
  };
}

/** Graph 形态的便捷构造（编辑器导出时用）。 */
export function graphOf(built: BuiltPolicy): ExprGraph {
  const content = formatAs(built.expression, 'graph');
  return JSON.parse(content) as ExprGraph;
}
