/**
 * ★★ **事实地址的两种写法必须等价**（`docs/04 §1.2.7`）：
 *   限定写法 `fact:<ns>.<path>`（文档推荐）与点号写法 `fact.<ns>.<path>`。
 *
 * 背景（本会话查出的真实缺陷）：`parseOperand` 只识别 `subject:` 的冒号形式，
 * **没有识别 `fact:`** —— 于是 `fact:email.domain` 掉进 `{ kind: 'literal' }`，
 * 被当成**字符串字面量**：
 *
 *   · `{ eq: { 'fact:email.domain': 'x' } }` → **永远 false**，且**不报缺失**；
 *   · 同时 `collectFactRefs` 的正则 `/^(fact|user|binding)\./` 也不认冒号形式 →
 *     该事实**永不采集**。
 *
 * 两处叠加的后果不是"少个功能"，而是「**用文档推荐写法写的策略静默失效**」：
 * 渠道故障时本该 `indeterminate`（H1：不推进状态），却成了"不满足"（**可能误收回权限**）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExpression, parseOperand, type EvaluationContext } from '../src/policy/expr.ts';
import { collectFactRefs, namespaceOf } from '../src/policy/model.ts';

const NOW = new Date('2026-09-28T00:00:00Z');

const contextOf = (facts: Record<string, unknown> = {}): EvaluationContext =>
  ({
    missingPolicy: 'indeterminate',
    facts: (namespace: string, path: string) => facts[`${namespace}.${path}`],
    user: { email: null, email_verified: false, status: 'active', tags: [] },
    bindings: {},
    now: NOW,
  }) as EvaluationContext;

const stateOf = (expression: unknown, facts: Record<string, unknown> = {}): string =>
  evaluateExpression(expression as never, { context: contextOf(facts) }).state;

// ─────────────────────── ① 解析层 ───────────────────────

test('★★ `parseOperand` 必须把 `fact:` **认成事实**（而不是字面量）', () => {
  const ref = parseOperand('fact:email.domain');
  assert.equal(ref.kind, 'fact', '★ 掉进 `literal` 就会拿整串去比较 —— 永远为假');
  assert.equal(ref.namespace, 'email');
  // 归一为点号形式，下游按 `fact.<ns>.<path>` 切片取值
  assert.equal(ref.path, 'fact.email.domain');
});

test('★ 点号写法不变（向后兼容）', () => {
  const ref = parseOperand('fact.email.domain');
  assert.equal(ref.kind, 'fact');
  assert.equal(ref.namespace, 'email');
});

test('★ `me:` 限定写法同样识别（归一到 `user.`）', () => {
  const ref = parseOperand('me:status');
  assert.equal(ref.kind, 'user');
  assert.equal(ref.path, 'user.status');
});

test('★ 真正的字面量**不受影响**（`foo.bar` 仍不是事实）', () => {
  assert.equal(parseOperand('foo.bar').kind, 'literal');
  assert.equal(parseOperand('contributor').kind, 'literal');
});

test('★ `namespaceOf` 对两种写法给出同一命名空间', () => {
  assert.equal(namespaceOf('fact:email.domain'), 'email');
  assert.equal(namespaceOf('fact.email.domain'), 'email');
});

// ─────────────────────── ② 依赖收集层 ───────────────────────

test('★★ `collectFactRefs` 必须收集**限定写法**的事实（否则永不采集）', () => {
  const refs = collectFactRefs({ eq: { 'fact:email.domain': 'gmail.com' } });
  assert.ok(
    refs.has('fact.email.domain'),
    '★ 收集不到 → 事实永不采集 → 求值必然落到"缺失"分支（或更糟：字面量比较）',
  );
  // 归一为点号形式（下游 `factCollectedAt` 按此取采集时间）
  assert.deepEqual([...refs], ['fact.email.domain']);
});

test('★ 混合写法：两种形式的事实都被收集，且**不重复**', () => {
  const refs = collectFactRefs({
    and: [{ eq: { 'fact:email.domain': 'a' } }, { gte: { 'fact.email.quota': 1 } }],
  });
  assert.deepEqual([...refs].sort(), ['fact.email.domain', 'fact.email.quota']);
});

test('★ 含 `@实例` / `#站点` 限定符的冒号写法也能收集', () => {
  const refs = collectFactRefs({ eq: { 'fact:qqbot-adapter@bot-main.level': 40 } });
  assert.ok(refs.has('fact.qqbot-adapter@bot-main.level'));
});

// ─────────────────────── ③ 求值层（端到端）───────────────────────

test('★★★ 事实**缺失**时，限定写法必须 `indeterminate`（此前是 `false` —— H1 违规）', () => {
  assert.equal(
    stateOf({ eq: { 'fact:email.domain': 'gmail.com' } }),
    'indeterminate',
    '★ "不知道"不能当成"不满足"：否则一次渠道故障就会误收回权限',
  );
});

test('★★★ **两种写法结论完全一致**（存在 / 缺失 / 相等 / 不等）', () => {
  const cases: { label: string; facts: Record<string, unknown>; expected: string }[] = [
    { label: '存在且相等', facts: { 'email.domain': 'gmail.com' }, expected: 'true' },
    { label: '存在但不等', facts: { 'email.domain': 'qq.com' }, expected: 'false' },
    { label: '缺失', facts: {}, expected: 'indeterminate' },
  ];
  for (const item of cases) {
    const qualified = stateOf({ eq: { 'fact:email.domain': 'gmail.com' } }, item.facts);
    const dotted = stateOf({ eq: { 'fact.email.domain': 'gmail.com' } }, item.facts);
    assert.equal(qualified, dotted, `★ 两种写法在「${item.label}」下给出不同结论`);
    assert.equal(qualified, item.expected, `★ 期望 ${item.expected}（${item.label}）`);
  }
});

test('★★ `$exists` / `not_exists` 对限定写法同样工作（缺失也可确定）', () => {
  assert.equal(stateOf({ exists: { 'fact:email.domain': true } }, {}), 'false');
  assert.equal(stateOf({ exists: { 'fact:email.domain': true } }, { 'email.domain': 'x' }), 'true');
  assert.equal(stateOf({ not_exists: { 'fact:email.domain': true } }, {}), 'true');
});

test('★ `me:` 限定写法在求值层可用', () => {
  assert.equal(stateOf({ eq: { 'me:status': 'active' } }), 'true');
  assert.equal(stateOf({ eq: { 'me:status': 'banned' } }), 'false');
});
