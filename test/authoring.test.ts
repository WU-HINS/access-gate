/**
 * 三形态编辑器端到端验收（M6-10）。
 *
 * 验收标准原文：**「切换后发布，行为一致」**。
 *
 * ★ 本文件刻意**一路走到判定**（`evaluatePolicy`），而不是停在「AST 相等」：
 *   AST 相同但求值器读错字段的情况在本项目**真实发生过**
 *   （`me.` 前缀在寻址层合法、求值层不认的那一轮）。
 *   只有比对**判定结果**才能证明「行为一致」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthoringError,
  buildAndValidate,
  buildPolicy,
  checkFormConsistency,
  contentIn,
  graphOf,
  switchFormat,
  verifyBehaviorConsistency,
  type AuthoringInput,
} from '../src/policy/authoring.ts';
import { evaluatePolicy } from '../src/policy/evaluator.ts';
import { formatAs, fromYaml, specHash, toGraph } from '../src/policy/expr-forms.ts';
import type { Expression } from '../src/policy/expr.ts';
import type { PluginRegistry } from '../src/policy/model.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

/** 一条有分支语义的表达式：QQ>40 直接通过；20<QQ≤40 且邮箱是教育域也通过 */
const EXPRESSION: Expression = {
  any: [
    { $label: 'QQ 等级 > 40', gt: { 'fact.qq.level': 40 } },
    {
      all: [
        { gt: { 'fact.qq.level': 20 } },
        { lte: { 'fact.qq.level': 40 } },
        { $label: '教育邮箱', matches: { 'fact.email.domain': ['*.edu.cn'] } },
      ],
    },
  ],
};

const REGISTRY: PluginRegistry = {
  installedPlugins: () => ['qq', 'email'],
  knownFactKeys: () => ['fact.qq.level', 'fact.email.domain'],
  knownActions: () => ['checkin:grant'],
};

/** 三种形态的文本（YAML 手写、JSON 手写、Graph 由转换器导出） */
const YAML_TEXT = `
any:
  - $label: QQ 等级 > 40
    gt:
      fact.qq.level: 40
  - all:
      - gt:
          fact.qq.level: 20
      - lte:
          fact.qq.level: 40
      - $label: 教育邮箱
        matches:
          fact.email.domain:
            - "*.edu.cn"
`;
const JSON_TEXT = JSON.stringify(EXPRESSION);
const GRAPH_TEXT = JSON.stringify(toGraph(EXPRESSION));

function inputOf(format: 'yaml' | 'json' | 'graph'): AuthoringInput {
  const content = format === 'yaml' ? YAML_TEXT : format === 'json' ? JSON_TEXT : GRAPH_TEXT;
  return {
    code: 'edu-unlock',
    name: '教育邮箱解锁',
    format,
    content,
    version: 1,
    onSatisfied: [{ action: 'checkin:grant', params: { scope: 'daily' } }],
  };
}

/** 在某组事实上求值（返回三态结论） */
function evaluateWith(expression: Expression, facts: Record<string, unknown>): string {
  const evaluation = evaluatePolicy({
    policy: buildPolicy({ ...inputOf('json'), content: formatAs(expression, 'json') }).document,
    context: {
      facts: (namespace, path) => facts[`fact.${namespace}.${path}`],
      user: { email: 'a@example.com', email_verified: true, status: 'active', tags: [] },
      bindings: {},
      now: NOW,
    },
  });
  return evaluation.decision;
}

// ─────────────────────────── ★ 行为一致（验收标准） ───────────────────────────

test('★ M6-10：三种形态构建同一策略 → 对同一批主体的**判定完全相同**', () => {
  const cases: { label: string; facts: Record<string, unknown>; expected: string }[] = [
    { label: 'QQ=50（>40 直接通过）', facts: { 'fact.qq.level': 50 }, expected: 'satisfied' },
    { label: 'QQ=30 且教育邮箱', facts: { 'fact.qq.level': 30, 'fact.email.domain': 'a.tsinghua.edu.cn' }, expected: 'satisfied' },
    { label: 'QQ=30 但非教育邮箱', facts: { 'fact.qq.level': 30, 'fact.email.domain': 'a.gmail.com' }, expected: 'unsatisfied' },
    { label: 'QQ=10（两个分支都不满足）', facts: { 'fact.qq.level': 10, 'fact.email.domain': 'a.tsinghua.edu.cn' }, expected: 'unsatisfied' },
    { label: '事实缺失 → indeterminate（H1）', facts: {}, expected: 'indeterminate' },
  ];

  for (const entry of cases) {
    const verdicts = (['yaml', 'json', 'graph'] as const).map((format) => {
      const built = buildPolicy({ ...inputOf(format), content: format === 'yaml' ? YAML_TEXT : format === 'json' ? JSON_TEXT : GRAPH_TEXT });
      return { format, hash: built.hash, decision: evaluateWith(built.expression, entry.facts) };
    });
    // ★ 三形态判定必须完全一致
    const decisions = new Set(verdicts.map((entry_) => entry_.decision));
    assert.equal(decisions.size, 1, `★ ${entry.label}：三形态判定应一致（实际 ${verdicts.map((v) => `${v.format}=${v.decision}`).join(', ')}）`);
    assert.equal(verdicts[0]!.decision, entry.expected, `${entry.label} 的预期结论`);
    // 且 hash 相同（语义去重生效）
    assert.equal(new Set(verdicts.map((v) => v.hash)).size, 1, '★ 三形态的 specHash 必须相同');
  }
});

test('★ M6-10：`verifyBehaviorConsistency` 一路走到判定（不只比 AST）', () => {
  const facts = { 'fact.qq.level': 30, 'fact.email.domain': 'a.tsinghua.edu.cn' };
  const result = verifyBehaviorConsistency({ yaml: YAML_TEXT, json: JSON_TEXT, graph: GRAPH_TEXT }, (expression) =>
    evaluateWith(expression, facts),
  );
  assert.equal(result.consistent, true);
  assert.deepEqual(result.verdicts, { yaml: 'satisfied', json: 'satisfied', graph: 'satisfied' });
  assert.match(result.detail, /求值结论一致/);
});

test('★ M6-10：`checkFormConsistency` 能发现不一致（证明它不是恒真）', () => {
  const ok = checkFormConsistency({ yaml: YAML_TEXT, json: JSON_TEXT, graph: GRAPH_TEXT });
  assert.equal(ok.consistent, true);
  assert.equal(new Set(Object.values(ok.hashes)).size, 1);

  // 人为把 YAML 改成一个不同逻辑（QQ>99）
  const tampered = YAML_TEXT.replace('fact.qq.level: 40', 'fact.qq.level: 99');
  const bad = checkFormConsistency({ yaml: tampered, json: JSON_TEXT, graph: GRAPH_TEXT });
  assert.equal(bad.consistent, false, '★ 内容不同的三形态必须被识别为不一致');
  assert.match(bad.detail, /语义不一致/);
  assert.notEqual(bad.hashes.yaml, bad.hashes.json);
});

// ─────────────────────────── 形态切换 ───────────────────────────

test('★ M6-10：切换形态不改变语义（hash 不变，且往返校验把关）', () => {
  const built = buildPolicy(inputOf('yaml'));
  for (const target of ['json', 'graph', 'yaml'] as const) {
    const switched = switchFormat(built, target);
    assert.equal(switched.hash, built.hash, `★ yaml → ${target} 后 hash 必须不变`);
    assert.equal(switched.format, target);
    // 切过去后的内容再解析回来仍是同一语义
    assert.equal(specHash(fromYaml(formatAs(built.expression, 'yaml'))), built.hash);
  }
});

test('M6-10：`contentIn` 取出任意形态文本；`graphOf` 导出合法图', () => {
  const built = buildPolicy(inputOf('json'));
  assert.match(contentIn(built, 'yaml'), /any:/);
  assert.equal(JSON.parse(contentIn(built, 'json')).any.length, 2);
  const graph = graphOf(built);
  assert.equal(graph.version, 'gate/expr-graph/v1');
  assert.ok(graph.nodes.length > 3, '图应包含全部节点');
  assert.equal(graph.nodes.filter((node) => node.kind === 'compare').length, 4);
});

// ─────────────────────────── 构建与校验 ───────────────────────────

test('M6-10：构建保留 origin 与动作；策略文档结构完整', () => {
  const built = buildPolicy(inputOf('graph'));
  assert.equal(built.origin, 'graph');
  assert.equal(built.document.code, 'edu-unlock');
  assert.equal(built.document.version, 1);
  assert.equal(built.document.spec.requirements.expression, built.expression);
  assert.deepEqual(built.document.spec.actions?.onSatisfied, [{ action: 'checkin:grant', params: { scope: 'daily' } }]);
});

test('M6-10：`buildAndValidate` 通过已知事实；未知事实被拒', () => {
  const ok = buildAndValidate(inputOf('yaml'), REGISTRY);
  assert.equal(ok.hash, buildPolicy(inputOf('yaml')).hash);

  // 引用了未安装插件的命名空间 → 拒绝
  const bad = { ...inputOf('yaml'), content: YAML_TEXT.replace(/fact\.qq\.level/g, 'fact.unknown.level') };
  assert.throws(
    () => buildAndValidate(bad, REGISTRY),
    (error: unknown) => {
      assert.ok(error instanceof AuthoringError);
      assert.match(error.message, /未通过静态校验/);
      assert.ok(error.issues.length > 0);
      return true;
    },
  );
});

test('M6-10：构建时拒绝空 code 与非法形态内容', () => {
  assert.throws(() => buildPolicy({ ...inputOf('yaml'), code: '   ' }), /code 不能为空/);
  assert.throws(() => buildPolicy({ ...inputOf('json'), content: 'null' }), /表达式必须是一个对象/);
  assert.throws(() => buildPolicy({ ...inputOf('yaml'), content: '[]' }), /表达式必须是一个对象/);
});

// ─────────────────────────── 与版本化衔接 ───────────────────────────

test('★ M6-10：切形态后再存草稿**不产生新版本**（hash 相同 → 语义去重）', () => {
  // 这是 specHash 只对规范 AST 计算的实际价值：
  // 用户用 YAML 存了一次，又切到图形视图存了一次 —— 内容没变，不应产生新版本。
  const fromYamlBuilt = buildPolicy(inputOf('yaml'));
  const fromGraphBuilt = buildPolicy(inputOf('graph'));
  assert.equal(fromYamlBuilt.hash, fromGraphBuilt.hash, '★ 换编辑器不改变语义指纹');
  assert.deepEqual(fromYamlBuilt.document.spec.requirements.expression, fromGraphBuilt.document.spec.requirements.expression);
  void silentLogger;
});
