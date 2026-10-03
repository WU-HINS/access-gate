/**
 * `@gate/expr` 三形态转换（M3-6）—— docs/04 §1.2.6。
 *
 * ```
 *   YAML  ─┐                    ┌─ YAML
 *   JSON  ─┼─→  AST（唯一真理）─┼─ JSON
 *   Graph ─┘                    └─ Graph
 * ```
 *
 * ★ 四条保真规则（文档定义的转换器正确性契约）：
 *
 * 1. **语义只在 AST**：`position` / `viewport` / `collapsed` / 节点 `id` **不参与语义**，
 *    转换时丢弃或重建。测试用「同一 AST 两次转 Graph，布局不同但语义相同」锁定。
 * 2. **顺序必须保序**：JSON 数组有序；Graph 用 `edge.order` 承载。
 *    `all`/`any` 逻辑上无序，但**顺序影响短路行为与展示**，故往返必须保序。
 * 3. **`$ref` 不自动内联**：YAML/JSON 中为引用，Graph 中为 `ref` 节点（避免大策略图爆炸）。
 * 4. **往返保真**：`ast → graph → ast` 必须**语义等价**。
 *    `specHash` 只对规范 AST 计算，因此「同一逻辑分别用 YAML 和图形编辑」得到**相同 hash**。
 *
 * ★ 为什么这个模块必须存在（而不是各编辑器各写一套）：
 *   一旦前后端各有一套转换，「编辑器所见」与「服务端所算」必然漂移——
 *   而漂移的表现是「界面上看着对，实际判定不对」，极难排查。
 */

import { parse as parseYamlText, stringify as stringifyYaml } from 'yaml';

import { COMPARISON_OPS, type Expression, type ReservedProps } from './expr.ts';

// ─────────────────────────── 规范 JSON AST ───────────────────────────

/** 规范形态：存库的**唯一真理**（求值只用它）。 */
export type SpecAst = Expression;

export interface ConversionError {
  path: string;
  message: string;
}

export class ExpressionFormError extends Error {
  override readonly name = 'ExpressionFormError';
  readonly issues: readonly ConversionError[];
  constructor(issues: readonly ConversionError[]) {
    super(`表达式形态转换失败：\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`);
    this.issues = issues;
  }
}

// ─────────────────────────── Graph 数据模型 ───────────────────────────

export type GraphNodeKind =
  | 'all' | 'any' | 'not' | 'none'
  | 'atLeast' | 'atMost' | 'exactly' | 'score'
  | 'always' | 'never'
  | 'compare' | 'ref';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label?: string;
  meta?: { required?: boolean; onMissing?: 'fail_closed' | 'fail_open'; note?: string; weight?: number };
  /** atLeast.n / atMost.n / exactly.n / score.threshold */
  params?: { n?: number; threshold?: number };
  /** compare 节点 */
  compare?: { op: string; operand: string; value: unknown };
  /** ref 节点引用的 defs 名称 */
  ref?: string;
  /**
   * `always` / `never` 节点的布尔值。
   *
   * ★ 为什么需要它：`{ always: false }` 与 `{ never: true }` 语义相同，
   *   但**保真**要求往返后结构不变（否则 `specHash` 会变，
   *   「内容未变」会被误判为「改过了」）。早期实现只认 `always === true`，
   *   于是 `{ always: false }` 掉进比较节点分支报「未知操作符」。
   */
  value?: boolean;
  position: { x: number; y: number };
  collapsed?: boolean;
}

export interface GraphEdge {
  id?: string;
  from: string;
  to: string;
  /** ★ 兄弟顺序（承载数组语义） */
  order: number;
}

export interface ExprGraph {
  version: 'gate/expr-graph/v1';
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

// ─────────────────────────── AST → Graph ───────────────────────────

const RESERVED_KEYS = new Set(['$label', '$required', '$onMissing', '$note']);

function readReserved(node: Expression): { label?: string; meta?: GraphNode['meta'] } {
  const source = node as ReservedProps;
  const meta: NonNullable<GraphNode['meta']> = {};
  if (source.$required !== undefined) meta.required = source.$required;
  if (source.$onMissing !== undefined) meta.onMissing = source.$onMissing;
  if (source.$note !== undefined) meta.note = source.$note;
  return {
    ...(source.$label === undefined ? {} : { label: source.$label }),
    ...(Object.keys(meta).length === 0 ? {} : { meta }),
  };
}

/** 把比较节点拆成 `{ op, operand, value }`（文档：一个比较节点只允许一个操作符键）。 */
function readComparison(node: Expression, path: string, issues: ConversionError[]): { op: string; operand: string; value: unknown } | undefined {
  const entries = Object.entries(node as Record<string, unknown>).filter(([key]) => !RESERVED_KEYS.has(key) && key !== '$ref');
  if (entries.length === 0) {
    if ((node as Record<string, unknown>)['$ref'] !== undefined) return undefined; // 由调用方处理 ref
    issues.push({ path, message: `比较节点必须恰好有一个操作符键（实际 0 个）` });
    return undefined;
  }
  if (entries.length > 1) {
    issues.push({
      path,
      message: `比较节点只允许一个操作符键（实际 ${entries.length} 个：${entries.map(([k]) => k).join(', ')}）——要「同时满足」请放进 all`,
    });
    return undefined;
  }
  const [op, operandMap] = entries[0]!;
  if (!COMPARISON_OPS.includes(op as never)) {
    issues.push({ path, message: `未知的比较操作符 '${op}'` });
    return undefined;
  }
  if (operandMap === null || typeof operandMap !== 'object' || Array.isArray(operandMap)) {
    issues.push({ path: `${path}.${op}`, message: '比较节点的值必须是 `{ <操作数>: <期望值> }`' });
    return undefined;
  }
  const operands = Object.entries(operandMap as Record<string, unknown>);
  if (operands.length !== 1) {
    issues.push({ path: `${path}.${op}`, message: `比较节点只允许一个操作数键（实际 ${operands.length} 个）` });
    return undefined;
  }
  return { op, operand: operands[0]![0], value: operands[0]![1] };
}

/**
 * AST → Graph。
 *
 * ★ 布局是**纯展示**的：这里用简单的树形布局（深度决定 x，兄弟序决定 y）。
 *   前端可以覆盖它；转换本身不依赖布局。
 */
export function toGraph(ast: Expression): ExprGraph {
  const issues: ConversionError[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let counter = 0;
  const nextId = (): string => `n${(counter += 1)}`;

  const walk = (node: Expression, path: string, depth: number, siblingIndex: number): string | undefined => {
    const reserved = readReserved(node);
    const id = nextId();
    const position = { x: depth * 240, y: siblingIndex * 80 };
    const record = node as Record<string, unknown>;

    // $ref（**不自动内联**）
    if (record['$ref'] !== undefined) {
      nodes.push({ id, kind: 'ref', ref: String(record['$ref']), ...reserved, position });
      return id;
    }

    // always / never（★ 按「键存在」判定，而不是「值为 true」——
    //   `{ always: false }` 也是合法表达式，且往返必须保真）
    if (record['always'] !== undefined) {
      nodes.push({ id, kind: 'always', value: record['always'] === true, ...reserved, position });
      return id;
    }
    if (record['never'] !== undefined) {
      nodes.push({ id, kind: 'never', value: record['never'] === true, ...reserved, position });
      return id;
    }

    // 逻辑节点
    for (const kind of ['all', 'any', 'none'] as const) {
      const children = record[kind];
      if (Array.isArray(children)) {
        nodes.push({ id, kind, ...reserved, position });
        children.forEach((child, index) => {
          const childId = walk(child as Expression, `${path}.${kind}[${index}]`, depth + 1, siblingIndex + index);
          if (childId !== undefined) edges.push({ from: id, to: childId, order: index });
        });
        return id;
      }
    }
    if (record['not'] !== undefined && record['not'] !== null) {
      nodes.push({ id, kind: 'not', ...reserved, position });
      const childId = walk(record['not'] as Expression, `${path}.not`, depth + 1, siblingIndex);
      if (childId !== undefined) edges.push({ from: id, to: childId, order: 0 });
      return id;
    }

    // 计数式
    for (const kind of ['atLeast', 'atMost', 'exactly'] as const) {
      const spec = record[kind] as { n?: unknown; of?: unknown } | undefined;
      if (spec !== undefined && typeof spec === 'object' && Array.isArray(spec.of)) {
        const n = typeof spec.n === 'number' ? spec.n : Number(spec.n);
        nodes.push({ id, kind, params: { n }, ...reserved, position });
        (spec.of as Expression[]).forEach((child, index) => {
          const childId = walk(child, `${path}.${kind}.of[${index}]`, depth + 1, siblingIndex + index);
          if (childId !== undefined) edges.push({ from: id, to: childId, order: index });
        });
        return id;
      }
    }

    // 加权分
    const score = record['score'] as { threshold?: unknown; of?: unknown } | undefined;
    if (score !== undefined && typeof score === 'object' && Array.isArray(score.of)) {
      const threshold = typeof score.threshold === 'number' ? score.threshold : Number(score.threshold);
      nodes.push({ id, kind: 'score', params: { threshold }, ...reserved, position });
      (score.of as { weight?: unknown; expr: Expression }[]).forEach((entry, index) => {
        const childId = walk(entry.expr, `${path}.score.of[${index}].expr`, depth + 1, siblingIndex + index);
        if (childId !== undefined) {
          // ★ 权重存在**子节点**的 meta 上（Graph 边没有权重字段，且权重属于该子表达式）
          const child = nodes.find((candidate) => candidate.id === childId);
          if (child !== undefined) {
            const weight = typeof entry.weight === 'number' ? entry.weight : Number(entry.weight);
            child.meta = { ...(child.meta ?? {}), weight };
          }
          edges.push({ from: id, to: childId, order: index });
        }
      });
      return id;
    }

    // 比较叶子
    const comparison = readComparison(node, path, issues);
    if (comparison !== undefined) {
      nodes.push({ id, kind: 'compare', compare: comparison, ...reserved, position });
      return id;
    }
    // 无法识别的节点：占位为 compare（错误已记录）
    nodes.push({ id, kind: 'compare', ...reserved, position });
    return id;
  };

  const rootId = walk(ast, 'expression', 0, 0);
  if (issues.length > 0 || rootId === undefined) throw new ExpressionFormError(issues.length > 0 ? issues : [{ path: 'expression', message: '空表达式' }]);

  return { version: 'gate/expr-graph/v1', root: rootId, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

// ─────────────────────────── Graph → AST ───────────────────────────

/**
 * Graph → AST。
 *
 * ★ 严格按 `edge.order` 重建数组顺序——顺序影响短路与展示，不能丢。
 */
export function fromGraph(graph: ExprGraph): Expression {
  const issues: ConversionError[] = [];
  if (graph.version !== 'gate/expr-graph/v1') {
    throw new ExpressionFormError([{ path: 'version', message: `不支持的图版本 '${graph.version}'` }]);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!byId.has(graph.root)) throw new ExpressionFormError([{ path: 'root', message: `根节点 '${graph.root}' 不存在` }]);

  const childrenOf = (id: string): GraphNode[] =>
    graph.edges
      .filter((edge) => edge.from === id)
      .sort((a, b) => a.order - b.order)
      .map((edge) => byId.get(edge.to))
      .filter((node): node is GraphNode => node !== undefined);

  const reservedOf = (node: GraphNode): ReservedProps => ({
    ...(node.label === undefined ? {} : { $label: node.label }),
    ...(node.meta?.required === undefined ? {} : { $required: node.meta.required }),
    ...(node.meta?.onMissing === undefined ? {} : { $onMissing: node.meta.onMissing }),
    ...(node.meta?.note === undefined ? {} : { $note: node.meta.note }),
  });

  const build = (node: GraphNode, path: string): Expression => {
    const reserved = reservedOf(node);
    switch (node.kind) {
      case 'always':
        return { ...reserved, always: node.value ?? true };
      case 'never':
        return { ...reserved, never: node.value ?? true };
      case 'ref':
        if (node.ref === undefined) throw new ExpressionFormError([{ path, message: 'ref 节点缺少 ref' }]);
        return { ...reserved, $ref: node.ref } as Expression;
      case 'all':
      case 'any':
      case 'none':
        return { ...reserved, [node.kind]: childrenOf(node.id).map((child, index) => build(child, `${path}.${node.kind}[${index}]`)) };
      case 'not': {
        const children = childrenOf(node.id);
        if (children.length !== 1) throw new ExpressionFormError([{ path, message: `not 节点必须恰好有一个子节点（实际 ${children.length}）` }]);
        return { ...reserved, not: build(children[0]!, `${path}.not`) };
      }
      case 'atLeast':
      case 'atMost':
      case 'exactly': {
        if (node.params?.n === undefined) throw new ExpressionFormError([{ path, message: `${node.kind} 缺少 params.n` }]);
        return {
          ...reserved,
          [node.kind]: { n: node.params.n, of: childrenOf(node.id).map((child, index) => build(child, `${path}.${node.kind}.of[${index}]`)) },
        };
      }
      case 'score': {
        if (node.params?.threshold === undefined) throw new ExpressionFormError([{ path, message: 'score 缺少 params.threshold' }]);
        return {
          ...reserved,
          score: {
            threshold: node.params.threshold,
            of: childrenOf(node.id).map((child, index) => ({
              weight: child.meta?.weight ?? 1,
              expr: build(child, `${path}.score.of[${index}].expr`),
            })),
          },
        };
      }
      case 'compare': {
        if (node.compare === undefined) throw new ExpressionFormError([{ path, message: 'compare 节点缺少 compare' }]);
        const { op, operand, value } = node.compare;
        return { ...reserved, [op]: { [operand]: value } } as Expression;
      }
      default: {
        const exhaustive: never = node.kind;
        throw new ExpressionFormError([{ path, message: `未知的节点 kind '${String(exhaustive)}'` }]);
      }
    }
  };

  const root = byId.get(graph.root)!;
  const ast = build(root, 'root');

  // 孤立节点：转换会静默丢失它们——必须报错（否则图里的东西"消失"了）
  const reachable = new Set<string>();
  const mark = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const edge of graph.edges) if (edge.from === id) mark(edge.to);
  };
  mark(graph.root);
  const orphans = graph.nodes.filter((node) => !reachable.has(node.id));
  if (orphans.length > 0) {
    issues.push({ path: 'nodes', message: `存在不可达节点：${orphans.map((n) => n.id).join(', ')}（转换会丢失它们）` });
  }
  if (issues.length > 0) throw new ExpressionFormError(issues);
  return ast;
}

// ─────────────────────────── YAML / JSON ───────────────────────────

export function toJson(ast: Expression, options: { pretty?: boolean } = {}): string {
  return JSON.stringify(ast, null, options.pretty === false ? undefined : 2);
}

export function fromJson(text: string): Expression {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ExpressionFormError([{ path: 'json', message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }]);
  }
  return assertExpressionShape(parsed, 'json');
}

export function toYaml(ast: Expression): string {
  return stringifyYaml(ast, { lineWidth: 0 });
}

export function fromYaml(text: string): Expression {
  let parsed: unknown;
  try {
    parsed = parseYamlText(text);
  } catch (error) {
    throw new ExpressionFormError([{ path: 'yaml', message: `YAML 解析失败：${error instanceof Error ? error.message : String(error)}` }]);
  }
  return assertExpressionShape(parsed, 'yaml');
}

/**
 * 形态校验：确保解析出来的东西**确实是一个表达式对象**。
 *
 * ★ 为什么必需：`JSON.parse("null")` / `YAML.parse("")` 都会成功，
 *   但得到的东西不是表达式。不校验的话，错误会推迟到求值期——
 *   那时错误信息离「哪里写错了」已经很远。
 */
function assertExpressionShape(value: unknown, path: string): Expression {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExpressionFormError([{ path, message: `表达式必须是一个对象（实际：${Array.isArray(value) ? 'array' : typeof value}）` }]);
  }
  return value as Expression;
}

// ─────────────────────────── 语义指纹 ───────────────────────────

/**
 * 规范 AST 的语义指纹（`specHash` 的唯一计算依据）。
 *
 * ★ 只对**规范 AST** 计算，且**不含布局**——因此
 *   「同一逻辑分别用 YAML 和图形编辑」会得到相同 hash，
 *   「内容未变」能被正确识别（不会因为换了编辑器就产生无意义的 draft 版本）。
 */
export function specHash(ast: Expression): string {
  const canonical = canonicalize(ast);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 规范化序列化：键排序（数组顺序**保留**——它承载语义）。 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/** 语义等价判定（供往返保真测试与「内容未变」检测）。 */
export function semanticallyEqual(a: Expression, b: Expression): boolean {
  return canonicalize(a) === canonicalize(b);
}

// ─────────────────────────── 统一入口 ───────────────────────────

export type ExpressionFormat = 'yaml' | 'json' | 'graph';

/** 按指定形态解析为规范 AST。 */
export function parseInFormat(content: string, format: ExpressionFormat): Expression {
  switch (format) {
    case 'json':
      return fromJson(content);
    case 'yaml':
      return fromYaml(content);
    case 'graph':
      return fromGraph(JSON.parse(content) as ExprGraph);
    default: {
      const exhaustive: never = format;
      throw new ExpressionFormError([{ path: 'format', message: `未知形态 '${String(exhaustive)}'` }]);
    }
  }
}

/** 把规范 AST 序列化为指定形态。 */
export function formatAs(ast: Expression, format: ExpressionFormat): string {
  switch (format) {
    case 'json':
      return toJson(ast);
    case 'yaml':
      return toYaml(ast);
    case 'graph':
      return JSON.stringify(toGraph(ast), null, 2);
    default: {
      const exhaustive: never = format;
      throw new ExpressionFormError([{ path: 'format', message: `未知形态 '${String(exhaustive)}'` }]);
    }
  }
}

/** 形态互转（服务端统一转 AST，再序列化为目标形态）。 */
export function convert(content: string, from: ExpressionFormat, to: ExpressionFormat): { ast: Expression; content: string; hash: string } {
  const ast = parseInFormat(content, from);
  return { ast, content: formatAs(ast, to), hash: specHash(ast) };
}
