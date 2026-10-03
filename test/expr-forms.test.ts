/**
 * @gate/expr 三形态转换验收（M3-6）—— docs/04 §1.2.6。
 *
 * 断言重点（对应文档定义的四条保真规则）：
 *   - **语义只在 AST**：布局/节点 id/collapsed 不参与语义；
 *   - **顺序必须保序**：Graph 用 `edge.order` 承载数组语义，往返保序；
 *   - **`$ref` 不自动内联**；
 *   - **往返保真**：由 **property-based 测试**保证（随机生成 AST 做三向往返）——
 *     这是文档明确要求的验证方式，不是「举几个例子」。
 *   - **`specHash` 只对规范 AST 计算**：同一逻辑用 YAML 与图形编辑得到**相同 hash**
 *     （否则「换编辑器」会产生无意义的 draft 版本）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalize,
  convert,
  ExpressionFormError,
  formatAs,
  fromGraph,
  fromJson,
  fromYaml,
  parseInFormat,
  semanticallyEqual,
  specHash,
  toGraph,
  toJson,
  toYaml,
  type ExprGraph,
} from '../src/policy/expr-forms.ts';
import type { Expression } from '../src/policy/expr.ts';

/** docs/04 §1.2.6 的示例表达式：QQ > 40 或（20 < QQ ≤ 40） */
const SAMPLE: Expression = {
  any: [
    { gt: { 'fact.qq.level': 40 } },
    { all: [{ gt: { 'fact.qq.level': 20 } }, { lte: { 'fact.qq.level': 40 } }] },
  ],
};

// ─────────────────────────── 基本往返 ───────────────────────────

test('JSON 往返：AST → JSON → AST 语义等价', () => {
  const text = toJson(SAMPLE);
  assert.ok(semanticallyEqual(fromJson(text), SAMPLE));
});

test('YAML 往返：AST → YAML → AST 语义等价，且 YAML 可读', () => {
  const text = toYaml(SAMPLE);
  // 面向人：键与值按缩进展开（不是压成一行 JSON）
  assert.match(text, /any:/);
  assert.match(text, /- gt:/);
  assert.match(text, /fact\.qq\.level: 40/);
  assert.ok(semanticallyEqual(fromYaml(text), SAMPLE));
});

test('★ Graph 往返：AST → Graph → AST 语义等价，且**保序**', () => {
  const graph = toGraph(SAMPLE);
  assert.equal(graph.version, 'gate/expr-graph/v1');
  // 根是 any，两个子节点
  const rootNode = graph.nodes.find((n) => n.id === graph.root)!;
  assert.equal(rootNode.kind, 'any');
  const edges = graph.edges.filter((e) => e.from === graph.root).sort((a, b) => a.order - b.order);
  assert.deepEqual(edges.map((e) => e.order), [0, 1], '边必须带 order');

  const back = fromGraph(graph);
  assert.ok(semanticallyEqual(back, SAMPLE));

  // ★ 保序的强断言：交换两个子表达式的顺序后，往返结果必须**不同**
  const reordered: Expression = {
    any: [
      { all: [{ gt: { 'fact.qq.level': 20 } }, { lte: { 'fact.qq.level': 40 } }] },
      { gt: { 'fact.qq.level': 40 } },
    ],
  };
  assert.equal(semanticallyEqual(fromGraph(toGraph(reordered)), SAMPLE), false, '顺序影响短路与展示，不得被抹平');
});

test('★ 三形态互转后 `specHash` 相同（语义去重的依据）', () => {
  const hashes = new Set([
    specHash(fromYaml(toYaml(SAMPLE))),
    specHash(fromJson(toJson(SAMPLE))),
    specHash(fromGraph(toGraph(SAMPLE))),
    specHash(SAMPLE),
  ]);
  assert.equal(hashes.size, 1, `同一逻辑的三形态必须得到同一 hash（实际 ${[...hashes].join(', ')}）`);
});

test('convert：YAML → graph → YAML 的端到端互转', () => {
  const yamlText = toYaml(SAMPLE);
  const toGraphText = convert(yamlText, 'yaml', 'graph');
  assert.equal(toGraphText.hash, specHash(SAMPLE));

  const backToYaml = convert(toGraphText.content, 'graph', 'yaml');
  assert.equal(backToYaml.hash, specHash(SAMPLE));
  assert.ok(semanticallyEqual(fromYaml(backToYaml.content), SAMPLE));
});

// ─────────────────────────── 语义只在 AST ───────────────────────────

test('★ 布局不参与语义：改变 position/viewport/collapsed/节点 id 后语义不变', () => {
  const graph = toGraph(SAMPLE);
  const mutated: ExprGraph = {
    ...graph,
    viewport: { x: 999, y: -42, zoom: 3 },
    // 重命名所有节点 id 并挪动位置
    nodes: graph.nodes.map((node, index) => ({
      ...node,
      id: `renamed${index}`,
      position: { x: index * 111, y: index * 222 },
      collapsed: index % 2 === 0,
    })),
    edges: graph.edges.map((edge) => {
      const fromIndex = graph.nodes.findIndex((n) => n.id === edge.from);
      const toIndex = graph.nodes.findIndex((n) => n.id === edge.to);
      return { ...edge, from: `renamed${fromIndex}`, to: `renamed${toIndex}` };
    }),
    root: `renamed${graph.nodes.findIndex((n) => n.id === graph.root)}`,
  };
  assert.ok(semanticallyEqual(fromGraph(mutated), SAMPLE), '布局/ID/折叠状态不得影响语义');
  assert.equal(specHash(fromGraph(mutated)), specHash(SAMPLE), 'hash 也不得受布局影响');
});

test('★ $ref 不自动内联（Graph 中是 ref 节点，避免大策略图爆炸）', () => {
  const withRef: Expression = {
    all: [
      { $ref: 'github_strong' } as unknown as Expression,
      { eq: { 'me.email_verified': true } },
    ],
  };
  const graph = toGraph(withRef);
  const refNode = graph.nodes.find((n) => n.kind === 'ref');
  assert.ok(refNode !== undefined, '应生成 ref 节点');
  assert.equal(refNode.ref, 'github_strong');
  // 未被内联：图中没有 github_strong 展开出来的比较节点
  assert.equal(graph.nodes.filter((n) => n.kind === 'compare').length, 1, '只应有 $ref 之外的那个比较节点');
  assert.ok(semanticallyEqual(fromGraph(graph), withRef));
});

// ─────────────────────────── 节点类型覆盖 ───────────────────────────

test('全节点类型往返：逻辑 / 计数 / 加权 / 特殊 / 保留属性', () => {
  const cases: Expression[] = [
    { all: [{ always: true }, { never: true }] },
    { none: [{ eq: { 'me.status': 'active' } }] },
    { not: { exists: { 'fact.qq.level': true } } },
    { atLeast: { n: 2, of: [{ always: true }, { always: true }, { always: false }] } },
    { atMost: { n: 1, of: [{ always: true }] } },
    { exactly: { n: 1, of: [{ always: true }, { always: false }] } },
    {
      score: {
        threshold: 150,
        of: [
          { weight: 2, expr: { gte: { 'fact.github.total_stars': 100 } } },
          { weight: 1, expr: { gte: { 'fact.llm.pr_score': 60 } } },
        ],
      },
    },
    { $label: '带标签的比较', $onMissing: 'fail_open', gt: { 'fact.qq.level': 40 } },
    { between: { 'fact.qq.level': [20, 40] } },
    { matches: { 'fact.email.domain': ['*.edu.cn', '*.edu'] } },
    { contains: { 'fact.github.organizations': 'linux-foundation' } },
    { in: { 'me.tags': ['vip', 'beta'] } },
    { before: { 'fact.checkin.last_date': '2025-01-01' } },
    { divisible_by: { 'fact.invite.used': 2 } },
    { prefix: { 'fact.email.domain': 'tsinghua' } },
  ];
  for (const ast of cases) {
    assert.ok(semanticallyEqual(fromGraph(toGraph(ast)), ast), `Graph 往返失败：${canonicalize(ast)}`);
    assert.ok(semanticallyEqual(fromJson(toJson(ast)), ast), `JSON 往返失败：${canonicalize(ast)}`);
    assert.ok(semanticallyEqual(fromYaml(toYaml(ast)), ast), `YAML 往返失败：${canonicalize(ast)}`);
  }
});

test('score 节点的权重在 Graph 往返后保留（权重属于子表达式）', () => {
  const ast: Expression = {
    score: { threshold: 10, of: [{ weight: 3, expr: { always: true } }, { weight: 7, expr: { never: true } }] },
  };
  const back = fromGraph(toGraph(ast));
  assert.ok(semanticallyEqual(back, ast), `权重必须保留：${canonicalize(back)}`);
});

test('保留属性（$label/$required/$onMissing/$note）三形态均保留', () => {
  const ast: Expression = { $label: '标签', $required: true, $onMissing: 'fail_closed', $note: '备注', always: true };
  for (const roundTrip of [fromGraph(toGraph(ast)), fromJson(toJson(ast)), fromYaml(toYaml(ast))]) {
    assert.ok(semanticallyEqual(roundTrip, ast), canonicalize(roundTrip));
  }
});

// ─────────────────────────── 错误处理 ───────────────────────────

test('比较节点多操作符键 → 拒绝（文档：只允许一个，避免 YAML 语义歧义）', () => {
  assert.throws(
    () => toGraph({ gt: { 'fact.qq.level': 40 }, lte: { 'fact.qq.level': 100 } } as Expression),
    (error: unknown) => {
      assert.ok(error instanceof ExpressionFormError);
      assert.match(error.message, /只允许一个操作符键/);
      return true;
    },
  );
});

test('比较节点多操作数键 / 未知操作符 → 拒绝并给出路径', () => {
  assert.throws(() => toGraph({ gt: { 'a': 1, 'b': 2 } } as Expression), /只允许一个操作数键/);
  assert.throws(() => toGraph({ bogus_op: { 'a': 1 } } as Expression), /未知的比较操作符 'bogus_op'/);
});

test('★ 孤立节点 → 报错（否则图里的东西会静默「消失」）', () => {
  const graph = toGraph(SAMPLE);
  const withOrphan: ExprGraph = {
    ...graph,
    nodes: [...graph.nodes, { id: 'orphan', kind: 'always', position: { x: 0, y: 0 } }],
  };
  assert.throws(() => fromGraph(withOrphan), /不可达节点/);
});

test('图版本不符 / 根节点不存在 / not 子节点数不对 → 明确报错', () => {
  const graph = toGraph(SAMPLE);
  assert.throws(() => fromGraph({ ...graph, version: 'gate/expr-graph/v2' as never }), /不支持的图版本/);
  assert.throws(() => fromGraph({ ...graph, root: 'nope' }), /根节点 'nope' 不存在/);
  assert.throws(
    () => fromGraph({ ...graph, nodes: graph.nodes.map((n) => (n.id === graph.root ? { ...n, kind: 'not' as const } : n)) }),
    /not 节点必须恰好有一个子节点/,
  );
});

test('非法输入：空内容 / 非对象 / 语法错误 → 明确报错（不推迟到求值期）', () => {
  assert.throws(() => fromJson('null'), /表达式必须是一个对象/);
  assert.throws(() => fromYaml('[]'), /表达式必须是一个对象/);
  assert.throws(() => fromJson('{'), /JSON 解析失败/);
  assert.throws(() => parseInFormat('x', 'bogus' as never), /未知形态/);
});

test('parseInFormat / formatAs：三种形态统一入口', () => {
  const yamlText = formatAs(SAMPLE, 'yaml');
  const graphText = formatAs(SAMPLE, 'graph');
  const jsonText = formatAs(SAMPLE, 'json');
  for (const [content, format] of [
    [yamlText, 'yaml'],
    [graphText, 'graph'],
    [jsonText, 'json'],
  ] as const) {
    assert.ok(semanticallyEqual(parseInFormat(content, format), SAMPLE), `${format} 入口解析失败`);
  }
});

// ─────────────────────────── ★ property-based 往返 ───────────────────────────

/** 确定性伪随机（固定种子 → 失败可复现）。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'matches', 'exists', 'prefix'] as const;
const OPERANDS = ['fact.qq.level', 'fact.github.total_stars', 'fact.email.domain', 'me.email_verified', 'me.tags', 'fact.llm.pr_score'] as const;

/** 随机生成表达式 AST（受深度限制，保证终止）。 */
function randomExpression(random: () => number, depth: number): Expression {
  if (depth <= 0 || random() < 0.35) {
    // 叶子
    const roll = random();
    if (roll < 0.08) return { always: true };
    if (roll < 0.16) return { never: true };
    if (roll < 0.24) return { $ref: `def_${Math.floor(random() * 3)}` } as unknown as Expression;
    const op = OPS[Math.floor(random() * OPS.length)]!;
    const operand = OPERANDS[Math.floor(random() * OPERANDS.length)]!;
    let value: unknown;
    switch (op) {
      case 'exists':
        value = true;
        break;
      case 'matches':
        value = ['*.edu.cn', '*.edu'];
        break;
      case 'in':
      case 'contains':
        value = ['a', 'b'];
        break;
      default:
        value = Math.floor(random() * 100);
    }
    const leaf: Record<string, unknown> = { [op]: { [operand]: value } };
    if (random() < 0.25) leaf['$label'] = `标签${Math.floor(random() * 10)}`;
    if (random() < 0.15) leaf['$onMissing'] = random() < 0.5 ? 'fail_closed' : 'fail_open';
    return leaf as Expression;
  }

  const kind = Math.floor(random() * 8);
  const childCount = 1 + Math.floor(random() * 3);
  const children = (): Expression[] => Array.from({ length: childCount }, () => randomExpression(random, depth - 1));
  switch (kind) {
    case 0:
      return { all: children() };
    case 1:
      return { any: children() };
    case 2:
      return { none: children() };
    case 3:
      return { not: randomExpression(random, depth - 1) };
    case 4:
      return { atLeast: { n: 1 + Math.floor(random() * 2), of: children() } };
    case 5:
      return { exactly: { n: 1, of: children() } };
    case 6:
      return {
        score: {
          threshold: 1 + Math.floor(random() * 100),
          of: Array.from({ length: childCount }, () => ({ weight: 1 + Math.floor(random() * 3), expr: randomExpression(random, depth - 1) })),
        },
      };
    default: {
      const labelled: Record<string, unknown> = { all: children() };
      if (random() < 0.3) labelled['$label'] = '分组';
      return labelled as Expression;
    }
  }
}

test('★ property-based：随机 AST 的 YAML / JSON / Graph 三向往返均语义等价（200 例）', () => {
  const random = makeRandom(20_250_601);
  let checked = 0;
  for (let i = 0; i < 200; i += 1) {
    const ast = randomExpression(random, 4);
    // 三形态各自往返
    const viaJson = fromJson(toJson(ast));
    const viaYaml = fromYaml(toYaml(ast));
    const viaGraph = fromGraph(toGraph(ast));
    assert.ok(semanticallyEqual(viaJson, ast), `#${i} JSON 往返不等价：\n原始 ${canonicalize(ast)}\n回来 ${canonicalize(viaJson)}`);
    assert.ok(semanticallyEqual(viaYaml, ast), `#${i} YAML 往返不等价：\n原始 ${canonicalize(ast)}\n回来 ${canonicalize(viaYaml)}`);
    assert.ok(semanticallyEqual(viaGraph, ast), `#${i} Graph 往返不等价：\n原始 ${canonicalize(ast)}\n回来 ${canonicalize(viaGraph)}`);

    // 交叉：YAML → AST → Graph → AST → JSON → AST 必须全部等价
    const chain = fromJson(toJson(fromGraph(toGraph(fromYaml(toYaml(ast))))));
    assert.ok(semanticallyEqual(chain, ast), `#${i} 交叉往返不等价：\n原始 ${canonicalize(ast)}\n回来 ${canonicalize(chain)}`);

    // hash 稳定
    assert.equal(specHash(viaGraph), specHash(ast), `#${i} hash 不稳定`);
    checked += 1;
  }
  assert.equal(checked, 200);
});

test('★ property-based：随机 AST 的 `specHash` 与布局无关（同一 AST 两次转图 → 同 hash）', () => {
  const random = makeRandom(778_899);
  for (let i = 0; i < 50; i += 1) {
    const ast = randomExpression(random, 3);
    const graph1 = toGraph(ast);
    const graph2 = toGraph(ast);
    // 节点 id 是从 1 开始重建的，两次应完全一致（但布局不同也不该影响语义）
    assert.equal(specHash(fromGraph(graph1)), specHash(fromGraph(graph2)));
    const shifted: ExprGraph = { ...graph1, viewport: { x: 77, y: 88, zoom: 2 } };
    assert.equal(specHash(fromGraph(shifted)), specHash(ast), '视口变化不得影响语义指纹');
  }
});
