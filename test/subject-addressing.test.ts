/**
 * ★★ P0-1：`subject:*` 跨系统寻址（`docs/04 §1.2.7.2`）。
 *
 * ★ 本文件要证明四件事：
 *   ① `subject:` 与 `subject.` 两种写法都能解析（寻址层与求值层**对齐**）；
 *   ② 快照能把「绑定 → externalId → 下游属性」串起来；
 *   ③ 解析失败的**每一种原因**都给出可排障的说明（未绑定 ≠ 已撤销 ≠ 无该属性）；
 *   ④ ★★ **取不到时判 `indeterminate` 而不是 `false`**——
 *      否则一次渠道抖动会被当成"不满足"，按 H1 属于**误降级**（错误收回已授予的资格）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectSubjectKeys, collectSubjectSnapshot } from '../src/policy/subject-snapshot.ts';
import type { BindingResolver } from '../src/policy/addressing.ts';
import { evaluateExpression, parseOperand, type EvaluationContext, type Expression } from '../src/policy/expr.ts';
import { evaluateEligibility } from '../src/policy/eligibility.ts';
import type { PolicyDocument } from '../src/policy/model.ts';

const USER = 'u1';

/** 假解析器：newapi 已绑定；revoked-provider 已撤销；其余未绑定 */
const resolver: BindingResolver = {
  async find(userId, pluginId, instanceKey) {
    if (pluginId === 'newapi' && userId === USER) {
      return { pluginId, instanceKey, externalId: '1024', status: 'active' };
    }
    if (pluginId === 'revoked-provider') {
      return { pluginId, instanceKey, externalId: 'x', status: 'revoked' };
    }
    return undefined;
  },
};

const readSubject = async (input: { providerId: string; externalId: string }) =>
  input.providerId === 'newapi' && input.externalId === '1024'
    ? { group: 'vip2', level: 5 }
    : undefined;

// ─────────────────────────── 键提取 ───────────────────────────

test('collectSubjectKeys：两种写法都能提取（`subject:` 与 `subject.`）', () => {
  const keys = collectSubjectKeys({
    all: [
      { eq: { 'subject:newapi.group': 'vip2' } },
      { gte: { 'subject.level': 3 } },
      { eq: { 'fact.github.total_stars': 1 } }, // 不是 subject，不该被收
    ],
  });
  assert.deepEqual([...keys].sort(), ['level', 'newapi.group']);
});

test('collectSubjectKeys：跳过 `$` 保留属性（`$maxSkew` 等不是操作数）', () => {
  const keys = collectSubjectKeys({
    all: [{ eq: { 'subject:newapi.group': 'vip2' } }],
    $maxSkew: '1h',
    $label: 'subject.group',
  });
  assert.deepEqual([...keys], ['newapi.group']);
});

// ─────────────────────────── 快照解析 ───────────────────────────

test('★ 快照：绑定 active → 取到值，且**裸键与显式键都能用**', async () => {
  const snapshot = await collectSubjectSnapshot({
    userId: USER,
    keys: ['newapi.group', 'group', 'level'],
    // ★ 裸键（`group` / `level`）需要默认 provider——这正是"策略绑定 provider"的含义
    defaultProviderId: 'newapi',
    resolver,
    readSubject,
  });
  assert.deepEqual(snapshot.failures, []);
  assert.equal(snapshot.values['newapi.group'], 'vip2');
  assert.equal(snapshot.values['group'], 'vip2', '★ 裸键应能取到（策略绑定 provider 时的常用写法）');
  assert.equal(snapshot.values['level'], 5);
});

test('★ 快照：未绑定 → 失败并说明原因（不是静默取不到值）', async () => {
  const snapshot = await collectSubjectSnapshot({
    userId: USER,
    keys: ['discord.role'],
    resolver,
    readSubject,
  });
  assert.deepEqual(snapshot.values, {});
  assert.equal(snapshot.failures.length, 1);
  assert.match(snapshot.failures[0]!.reason, /未绑定 provider 'discord'/);
});

test('★ 快照：绑定已撤销 → 失败原因**与"未绑定"区分**（排障需要）', async () => {
  const snapshot = await collectSubjectSnapshot({
    userId: USER,
    keys: ['revoked-provider.group'],
    resolver,
    readSubject,
  });
  assert.equal(snapshot.failures.length, 1);
  assert.match(snapshot.failures[0]!.reason, /状态是 'revoked'/);
  assert.doesNotMatch(snapshot.failures[0]!.reason, /未绑定/);
});

test('快照：下游没有该属性 / 读属性失败 → 各自有明确原因', async () => {
  const noAttr = await collectSubjectSnapshot({
    userId: USER,
    keys: ['newapi.not_exist'],
    resolver,
    readSubject,
  });
  assert.match(noAttr.failures[0]!.reason, /没有属性 'not_exist'/);

  const readFail = await collectSubjectSnapshot({
    userId: USER,
    keys: ['newapi.group'],
    resolver,
    readSubject: async () => undefined,
  });
  assert.match(readFail.failures[0]!.reason, /读取 provider 'newapi' 的主体属性失败/);
});

test('★ 快照：裸键 + 无默认 provider → 明确失败并**指出该写什么**', async () => {
  const snapshot = await collectSubjectSnapshot({
    userId: USER,
    keys: ['group'],
    resolver,
    readSubject,
  });
  assert.equal(snapshot.failures.length, 1);
  assert.match(snapshot.failures[0]!.reason, /应写 `<provider>\.<attr>`/);
});

// ─────────────────────────── 端到端（寻址层 ↔ 求值层） ───────────────────────────

const contextWith = (subject: Record<string, unknown>): EvaluationContext => ({
  facts: () => undefined,
  user: {},
  subject,
});

test('★ 端到端：`subject:newapi.group` 有值 → 正常判定', () => {
  const node = evaluateExpression({ eq: { 'subject:newapi.group': 'vip2' } } as unknown as Expression, {
    context: contextWith({ 'newapi.group': 'vip2', group: 'vip2' }),
  });
  assert.equal(node.state, 'true');
});

test('★★ 端到端：取不到 → **indeterminate**（不是 false）——H1 的误降级防线', () => {
  const missing = evaluateExpression({ eq: { 'subject:newapi.group': 'vip2' } } as unknown as Expression, {
    context: contextWith({}),
  });
  assert.equal(missing.state, 'indeterminate', '★ 一次渠道抖动不得被当成"不满足"');
  assert.equal(missing.missing?.includes('subject:newapi.group'), true, '结果树要指出差哪一项');
});

test('★ 端到端：`subject.group` 与 `subject:newapi.group` 等价（都走快照的裸键）', () => {
  const dotted = evaluateExpression({ eq: { 'subject.group': 'vip2' } } as unknown as Expression, {
    context: contextWith({ group: 'vip2' }),
  });
  const colon = evaluateExpression({ eq: { 'subject:newapi.group': 'vip2' } } as unknown as Expression, {
    context: contextWith({ 'newapi.group': 'vip2' }),
  });
  assert.equal(dotted.state, 'true');
  assert.equal(colon.state, 'true');
});

test('parseOperand：`subject:` 的切分不被通用点切分破坏', () => {
  const ref = parseOperand('subject:newapi.group');
  assert.equal(ref.kind, 'subject');
  assert.equal(ref.path, 'subject.newapi.group');
  // 冒号写法与点写法归一为同一内部形式
  assert.equal(parseOperand('subject.newapi.group').path, 'subject.newapi.group');
});
