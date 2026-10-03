/**
 * 表达式引擎验收（M1-8）—— `gate/expr/v1`。
 *
 * 断言重点：
 *   - **三态求值**：`indeterminate` 与 `false` 必须分开，且 `not` 不得把 indeterminate 取反成 true；
 *   - **短路**：`all` 遇 false 即停、`any` 遇 true 即停（结果树里能看出来）；
 *   - **发布前拒绝**：`all: []` / `any: []` / `atLeast.n=0` / 多操作数键 / 未知操作符；
 *   - **结果树可解释**：用户能看到「差哪一项、差多少」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectFailures,
  collectIndeterminate,
  COMPARISON_OPS,
  evaluateExpression,
  ExpressionEngineError,
  globMatch,
  parseOperand,
  resolvePath,
  validateExpressionTree,
  type EvaluationContext,
  type Expression,
} from '../src/policy/expr.ts';

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const facts: Record<string, unknown> = {
    'qq.level': 32,
    'github.total_stars': 120,
    'github.organizations': ['linux-foundation'],
    'email.domain': 'tsinghua.edu.cn',
    'email.is_edu': true,
    'llm.pr_score': 88,
    'github.created_at': '2025-05-25T00:00:00Z',
    'github.empty_list': [],
    'llm.nullable_field': null,
  };
  return {
    facts: (namespace, path) => facts[`${namespace}.${path}`],
    user: { email_verified: true, tags: ['vip'], status: 'active', username: 'alice' },
    bindings: { qq: { status: 'bound', externalName: 'alice-qq' } },
    now: new Date('2025-06-01T00:00:00Z'),
    ...overrides,
  };
}

const evaluate = (expression: Expression, ctx = context()) => evaluateExpression(expression, { context: ctx });

// ─────────────────────────── 操作数解析 ───────────────────────────

test('parseOperand：fact/user/binding/字面量四类', () => {
  assert.deepEqual(parseOperand('fact.qq.level'), { kind: 'fact', path: 'fact.qq.level', namespace: 'qq' });
  assert.equal(parseOperand('user.email_verified').kind, 'user');
  assert.equal(parseOperand('binding.qq.age_days').kind, 'binding');
  assert.equal(parseOperand('literal').kind, 'literal');
});

test('resolvePath：点分路径、数组下标、通配', () => {
  const data = { a: { b: [{ c: 1 }, { c: 2 }] } };
  assert.equal(resolvePath(data, 'a.b[0].c'), 1);
  assert.deepEqual(resolvePath(data, 'a.b[*].c'), [1, 2]);
  assert.equal(resolvePath(data, 'a.missing'), undefined);
});

// ─────────────────────────── 比较操作符 ───────────────────────────

test('比较操作符全集可用（与 docs/04 §1.2.2 的表格一致）', () => {
  assert.ok(COMPARISON_OPS.length >= 25, `操作符应覆盖文档全集，实际 ${COMPARISON_OPS.length}`);

  const cases: [Expression, string][] = [
    [{ gt: { 'fact.qq.level': 40 } }, 'false'],
    [{ lte: { 'fact.qq.level': 40 } }, 'true'],
    [{ gte: { 'fact.github.total_stars': 100 } }, 'true'],
    [{ eq: { 'user.status': 'active' } }, 'true'],
    [{ ne: { 'user.status': 'banned' } }, 'true'],
    [{ between: { 'fact.qq.level': [20, 40] } }, 'true'],
    [{ in: { 'user.status': ['active', 'pending'] } }, 'true'],
    [{ in: { 'user.tags': ['vip', 'beta'] } }, 'false'], // ★ 数组左值不属于「包含于」语义（用 intersects）
    [{ not_in: { 'user.tags': ['banned'] } }, 'true'],
    [{ contains: { 'fact.github.organizations': 'linux-foundation' } }, 'true'],
    [{ not_contains: { 'fact.github.organizations': 'evil-corp' } }, 'true'],
    [{ subset_of: { 'user.tags': ['vip', 'beta', 'x'] } }, 'true'],
    [{ superset_of: { 'user.tags': ['vip'] } }, 'true'],
    [{ intersects: { 'user.tags': ['beta', 'vip'] } }, 'true'],
    [{ matches: { 'fact.email.domain': ['*.edu.cn', '*.edu'] } }, 'true'],
    [{ regex: { 'fact.email.domain': '^.*\\.edu\\.cn$' } }, 'true'],
    [{ prefix: { 'fact.email.domain': 'tsing' } }, 'true'],
    [{ suffix: { 'fact.email.domain': '.edu.cn' } }, 'true'],
    [{ exists: { 'fact.llm.pr_score': true } }, 'true'],
    [{ not_exists: { 'fact.llm.nope': true } }, 'true'],
    [{ is_null: { 'fact.llm.nullable_field': true } }, 'true'],
    [{ is_empty: { 'fact.github.empty_list': true } }, 'true'],
    [{ before: { 'fact.github.created_at': '2030-01-01' } }, 'true'],
    [{ after: { 'fact.github.created_at': '2000-01-01' } }, 'true'],
    [{ divisible_by: { 'fact.qq.level': 4 } }, 'true'],
  ];
  for (const [expression, expected] of cases) {
    assert.equal(evaluate(expression).state, expected, `${JSON.stringify(expression)} 期望 ${expected}`);
  }
});

test('within_days / before / after：用注入的时间基准（可测）', () => {
  const fresh = context({
    facts: (ns, path) => (ns === 'github' && path === 'created_at' ? '2025-05-25T00:00:00Z' : undefined),
  });
  assert.equal(evaluate({ within_days: { 'fact.github.created_at': 10 } }, fresh).state, 'true', '7 天前在 10 天内');
  assert.equal(evaluate({ within_days: { 'fact.github.created_at': 3 } }, fresh).state, 'false', '7 天前不在 3 天内');
  assert.equal(evaluate({ before: { 'fact.github.created_at': '2025-06-01' } }, fresh).state, 'true');
  assert.equal(evaluate({ after: { 'fact.github.created_at': '2025-05-01' } }, fresh).state, 'true');
});

test('globMatch：*.edu.cn 命中子域，不命中伪装域名', () => {
  assert.equal(globMatch('*.edu.cn', 'tsinghua.edu.cn'), true);
  assert.equal(globMatch('*.edu.cn', 'fake-edu.cn'), false);
  assert.equal(globMatch('*.edu', 'mit.edu'), true);
  assert.equal(globMatch('*.edu', 'notedu.com'), false);
  assert.equal(globMatch('*.edu.cn', 'edu.cn'), true, '裸域也应命中（与 email-domain 规则口径一致）');
  assert.equal(globMatch('*.edu.cn', 'fake.edu.cn.evil.com'), false);
  assert.equal(globMatch('**@corp.com', 'mail.corp.com'), true);
});

// ─────────────────────────── 三态求值 ───────────────────────────

test('★ 事实缺失 → indeterminate（不是 false）：否则会错误收回已授予资格', () => {
  const node = evaluate({ gt: { 'fact.qq.level': 40 } }, context({ facts: () => undefined }));
  assert.equal(node.state, 'indeterminate');
  assert.deepEqual(node.missing, ['fact.qq.level']);
  assert.match(node.reason, /缺失/);
});

test('missingPolicy=false 时才降级为 false（显式选择，不是默认）', () => {
  const node = evaluate({ gt: { 'fact.qq.level': 40 } }, context({ facts: () => undefined, missingPolicy: 'false' }));
  assert.equal(node.state, 'false');
});

test('★ not 不得把 indeterminate 取反成 true（逻辑错误）', () => {
  const node = evaluate({ not: { gt: { 'fact.qq.level': 40 } } }, context({ facts: () => undefined }));
  assert.equal(node.state, 'indeterminate');
});

test('★ exists/not_exists 对「从未采集」有确定语义；is_null/is_empty 判 indeterminate', () => {
  const ctx = context({ facts: () => undefined });
  // 它们问的就是「有没有」——没采集到就是确定答案
  assert.equal(evaluate({ exists: { 'fact.qq.level': true } }, ctx).state, 'false');
  assert.equal(evaluate({ not_exists: { 'fact.qq.level': true } }, ctx).state, 'true');
  // ★ 它们问的是「值是什么」——没采集到时**无从回答**，必须判 indeterminate
  //   （否则「渠道故障」会被当成「该字段为空」，进而错误地满足/不满足策略）
  assert.equal(evaluate({ is_null: { 'fact.qq.level': true } }, ctx).state, 'indeterminate');
  assert.equal(evaluate({ is_empty: { 'fact.qq.level': true } }, ctx).state, 'indeterminate');
});

test('★ 区分「从未采集」（undefined）与「采集到 null」：后者是已确定的答案', () => {
  const neverCollected = context({ facts: () => undefined });
  const collectedNull = context({ facts: (ns, path) => (ns === 'qq' && path === 'level' ? null : undefined) });

  assert.equal(evaluate({ is_null: { 'fact.qq.level': true } }, neverCollected).state, 'indeterminate');
  assert.equal(evaluate({ is_null: { 'fact.qq.level': true } }, collectedNull).state, 'true');
  assert.equal(evaluate({ exists: { 'fact.qq.level': true } }, collectedNull).state, 'false');
  assert.equal(evaluate({ gt: { 'fact.qq.level': 10 } }, collectedNull).state, 'false', 'null 与数字比较是确定的 false');
});

test('all 三态：任一 false → false；全 true → true；有缺失且无 false → indeterminate', () => {
  assert.equal(evaluate({ all: [{ gt: { 'fact.qq.level': 40 } }, { gte: { 'fact.github.total_stars': 100 } }] }).state, 'false');
  assert.equal(evaluate({ all: [{ gt: { 'fact.qq.level': 30 } }, { gte: { 'fact.github.total_stars': 100 } }] }).state, 'true');
  assert.equal(evaluate({ all: [{ gt: { 'fact.qq.level': 30 } }, { gt: { 'fact.nope.x': 1 } }] }).state, 'indeterminate');
  // 有明确的 false 时，即使还有缺失也判 false（不需要再等缺失的事实）
  assert.equal(
    evaluate({ all: [{ gt: { 'fact.qq.level': 40 } }, { gt: { 'fact.nope.x': 1 } }] }).state,
    'false',
  );
});

test('any 三态：任一 true → true；全 false → false；否则 indeterminate', () => {
  assert.equal(evaluate({ any: [{ gt: { 'fact.qq.level': 40 } }, { gte: { 'fact.github.total_stars': 100 } }] }).state, 'true');
  assert.equal(evaluate({ any: [{ gt: { 'fact.qq.level': 40 } }, { gt: { 'fact.github.total_stars': 1000 } }] }).state, 'false');
  assert.equal(evaluate({ any: [{ gt: { 'fact.qq.level': 40 } }, { gt: { 'fact.nope.x': 1 } }] }).state, 'indeterminate');
});

test('none 与 not 等价；always/never 显式常量', () => {
  assert.equal(evaluate({ none: [{ gt: { 'fact.qq.level': 100 } }] }).state, 'true');
  assert.equal(evaluate({ none: [{ gt: { 'fact.qq.level': 10 } }] }).state, 'false');
  assert.equal(evaluate({ always: true }).state, 'true');
  assert.equal(evaluate({ never: true }).state, 'false');
});

// ─────────────────────────── 短路 ───────────────────────────

test('短路：all 遇 false 即停（结果树只包含已求值的分支）', () => {
  const node = evaluate({
    all: [{ gt: { 'fact.qq.level': 40 } }, { gt: { 'fact.github.total_stars': 1 } }, { gt: { 'fact.llm.pr_score': 1 } }],
  });
  assert.equal(node.state, 'false');
  assert.equal(node.children!.length, 1, '遇 false 后不再求值后续分支');
});

test('短路：any 遇 true 即停', () => {
  const node = evaluate({
    any: [{ gt: { 'fact.qq.level': 10 } }, { gt: { 'fact.qq.level': 1000 } }, { gt: { 'fact.nttp.x': 1 } }],
  });
  assert.equal(node.state, 'true');
  assert.equal(node.children!.length, 1);
});

// ─────────────────────────── 语法糖展开 ───────────────────────────

test('atLeast/atMost/exactly：计数语义与三态', () => {
  const yes = { gt: { 'fact.qq.level': 10 } };
  const no = { gt: { 'fact.qq.level': 100 } };

  assert.equal(evaluate({ atLeast: { n: 2, of: [yes, yes, no] } }).state, 'true');
  assert.equal(evaluate({ atLeast: { n: 2, of: [yes, no, no] } }).state, 'false');
  assert.equal(evaluate({ atLeast: { n: 2, of: [yes, { gt: { 'fact.nope.x': 1 } }, no] } }).state, 'indeterminate');

  assert.equal(evaluate({ atMost: { n: 1, of: [no, yes, no] } }).state, 'true');
  assert.equal(evaluate({ atMost: { n: 0, of: [yes] } }).state, 'false');

  assert.equal(evaluate({ exactly: { n: 1, of: [yes, no] } }).state, 'true');
  assert.equal(evaluate({ exactly: { n: 2, of: [yes, no] } }).state, 'false');
});

test('atLeast：已不可能满足时即使有缺失也判 false', () => {
  const no = { gt: { 'fact.qq.level': 100 } };
  const node = evaluate({ atLeast: { n: 2, of: [no, no, { gt: { 'fact.nope.x': 1 } }] } });
  assert.equal(node.state, 'false');
});

test('score：加权分与阈值；含缺失时 indeterminate', () => {
  const node = evaluate({
    score: {
      threshold: 150,
      of: [
        { weight: 2, expr: { gte: { 'fact.github.total_stars': 100 } } },
        { weight: 1, expr: { gte: { 'fact.llm.pr_score': 80 } } },
      ],
    },
  });
  assert.equal(node.state, 'false', '2*? 实际得分：第一条 true(2) 第二条 true(1) 仅权重计分 → 需按权重数值换算');
});

test('score：用权重数值累加（文档示例 threshold=150）', () => {
  const node = evaluate({
    score: {
      threshold: 150,
      of: [
        { weight: 100, expr: { gte: { 'fact.github.total_stars': 100 } } },
        { weight: 60, expr: { gte: { 'fact.llm.pr_score': 80 } } },
      ],
    },
  });
  assert.equal(node.state, 'true');
  assert.equal(node.actual, 160);

  const indeterminate = evaluate({
    score: { threshold: 10, of: [{ weight: 5, expr: { gt: { 'fact.nope.x': 1 } } }, { weight: 5, expr: { gt: { 'fact.qq.level': 1 } } }] },
  });
  assert.equal(indeterminate.state, 'indeterminate');
});

// ─────────────────────────── 结果树 ───────────────────────────

test('结果树：带 $label 时可用于展示；错误项能给出「差多少」', () => {
  const node = evaluate({
    all: [
      { ...{ $label: '教育邮箱' }, eq: { 'fact.email.is_edu': true } },
      { ...{ $label: 'QQ 等级' }, gt: { 'fact.qq.level': 40 } },
    ],
  });
  assert.equal(node.state, 'false');
  const labeled = node.children!.map((child) => child.label);
  assert.deepEqual(labeled, ['教育邮箱', 'QQ 等级']);

  const failure = collectFailures(node)[0]!;
  assert.equal(failure.label, 'QQ 等级');
  assert.equal(failure.actual, 32);
  assert.equal(failure.expected, 40);
  assert.match(failure.reason, /32/);
});

test('collectIndeterminate：列出所有不可判定的叶子（用于「差哪一项」与 $onMissing 归因）', () => {
  const node = evaluate(
    { all: [{ gt: { 'fact.qq.level': 40 } }, { gt: { 'fact.a.x': 1 } }, { gt: { 'fact.b.y': 1 } }] },
    context({ facts: (ns, path) => (ns === 'qq' && path === 'level' ? 50 : undefined) }),
  );
  assert.equal(node.state, 'indeterminate');
  const list = collectIndeterminate(node);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((n) => n.missing?.[0]).sort(), ['fact.a.x', 'fact.b.y']);
});

// ─────────────────────────── 静态校验 ───────────────────────────

test('★ 发布前拒绝 all: [] 与 any: []（否则清空条件会让全站主体立即满足）', () => {
  const issues = validateExpressionTree({ all: [] });
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /恒真/);
  assert.ok(validateExpressionTree({ any: [] }).some((i) => /恒假/.test(i.message)));
  // 显式写法允许
  assert.deepEqual(validateExpressionTree({ always: true }), []);
  assert.deepEqual(validateExpressionTree({ never: true }), []);
});

test('发布前拒绝：atLeast.n=0 / n>len / 多操作数键 / 未知操作符 / 空节点', () => {
  assert.ok(validateExpressionTree({ atLeast: { n: 0, of: [{ always: true }] } }).some((i) => /恒真/.test(i.message)));
  assert.ok(validateExpressionTree({ atLeast: { n: 3, of: [{ always: true }] } }).some((i) => /恒假/.test(i.message)));
  assert.ok(validateExpressionTree({ eq: { 'fact.a': 1, 'fact.b': 2 } }).some((i) => /一个操作数键/.test(i.message)));
  assert.ok(validateExpressionTree({ nope: { 'fact.a': 1 } }).some((i) => /未知操作符/.test(i.message)));
  assert.ok(validateExpressionTree({}).some((i) => /空节点/.test(i.message)));
});

test('发布前拒绝：非法操作数前缀；between 期望值形状；未知比较值形式', () => {
  assert.ok(validateExpressionTree({ eq: { 'rawpath': 1 } }).some((i) => /必须以 fact\.\/user\.\/binding\./.test(i.message)));
  assert.ok(validateExpressionTree({ between: { 'fact.a': [1] } }).some((i) => /\[下界, 上界\]/.test(i.message)));
  assert.ok(validateExpressionTree({ in: { 'fact.a': 'not-array' } }).some((i) => /必须是数组/.test(i.message)));
});

test('发布前拒绝：嵌套超过 32 层', () => {
  let node: Expression = { always: true };
  for (let i = 0; i < 35; i += 1) node = { not: node };
  assert.ok(validateExpressionTree(node).some((i) => /嵌套超过上限/.test(i.message)));
});

test('合法表达式：嵌套 all/any/not 通过校验且能求值', () => {
  const expression: Expression = {
    all: [
      { any: [{ eq: { 'fact.email.is_edu': true } }, { gte: { 'fact.github.total_stars': 500 } }] },
      { not: { eq: { 'user.status': 'banned' } } },
    ],
  };
  assert.deepEqual(validateExpressionTree(expression), []);
  assert.equal(evaluate(expression).state, 'true');
});

test('比较节点值形式错误时求值抛错（不静默返回 false）', () => {
  assert.throws(() => evaluate({ gt: 'not-an-object' } as unknown as Expression), ExpressionEngineError);
  assert.throws(() => evaluate({ nope: { 'fact.a': 1 } } as unknown as Expression), ExpressionEngineError);
});
