/**
 * 有序分支求值器验收（M3-1）—— docs/04 §1.3。
 *
 * 断言重点：
 *   - **短路**：首个 `when` 为真后，后续 `when` **不再求值**（用带副作用的操作数计数验证）。
 *   - **★ H1：`indeterminate` 不被当成 `false`**——路径上有不确定且无人命中时，
 *     整体判 `indeterminate`，**绝不落到 `else`**（把「不知道」当「不满足」会误收回权限）。
 *   - **`else` 可省略**（省略即 unsatisfied 且无动作）。
 *   - **分支级动作覆盖策略级**；未指定时回落策略级。
 *   - **形态 A 被规整为单分支**（文档：形态 B 是 A 的超集，实现只保留分支求值器）。
 *   - **`expression` 与 `branches` 互斥**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateBranches,
  normalizeRequirements,
  RequirementsShapeError,
  type RequirementsSpec,
} from '../src/policy/branches.ts';
import type { EvaluationContext } from '../src/policy/expr.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

/** 构造求值上下文；`onRead` 用于观测「哪些操作数真的被读到了」 */
function contextOf(facts: Record<string, unknown>, options: { onRead?: (path: string) => void } = {}): EvaluationContext {
  return {
    facts: (namespace: string, path: string) => {
      const key = `fact.${namespace}.${path}`;
      options.onRead?.(key);
      return facts[key];
    },
    user: { email: 'a@example.com', email_verified: true, status: 'active', tags: [] },
    bindings: {},
    now: NOW,
  };
}

// ─────────────────────────── 形态规整 ───────────────────────────

test('★ 形态 A（单表达式）被规整为单分支（文档：形态 B 是超集，实现只保留分支求值器）', () => {
  const normalized = normalizeRequirements({ expression: { always: true } });
  assert.equal(normalized.source, 'expression');
  assert.equal(normalized.branches.length, 1);
  assert.equal(normalized.branches[0]!.outcome, 'satisfied');
  assert.deepEqual(normalized.branches[0]!.when, { always: true });
});

test('★ expression 与 branches 互斥（同一 requirements 内只能出现一个）', () => {
  assert.throws(
    () =>
      normalizeRequirements({
        expression: { always: true },
        branches: [{ id: 'a', when: { always: true }, outcome: 'satisfied' }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof RequirementsShapeError);
      assert.match(error.message, /互斥/);
      return true;
    },
  );
});

test('形态校验：两者都缺失 / 分支 id 重复 / id 为空 / outcome 非法 → 明确报错', () => {
  assert.throws(() => normalizeRequirements({}), /必须提供 `expression` 或 `branches`/);
  assert.throws(
    () =>
      normalizeRequirements({
        branches: [
          { id: 'x', when: { always: true }, outcome: 'satisfied' },
          { id: 'x', when: { always: false }, outcome: 'unsatisfied' },
        ],
      }),
    /分支 id 'x' 重复/,
  );
  assert.throws(() => normalizeRequirements({ branches: [{ id: '', when: { always: true }, outcome: 'satisfied' }] }), /唯一的 id/);
  assert.throws(
    () => normalizeRequirements({ branches: [{ id: 'a', when: { always: true }, outcome: 'maybe' as never }] }),
    /outcome 只能是/,
  );
  assert.throws(() => normalizeRequirements({ branches: [{ id: 'a', when: undefined as never, outcome: 'satisfied' }] }), /必须提供 when/);
});

// ─────────────────────────── 短路 ───────────────────────────

test('★ 短路：首个 when 为真后，后续 when 的**事实根本不被读取**', () => {
  const read: string[] = [];
  const requirements: RequirementsSpec = {
    branches: [
      { id: 'first', when: { gt: { 'fact.qq.level': 40 } }, outcome: 'satisfied', actions: [{ action: 'a:high' }] },
      { id: 'second', when: { gt: { 'fact.qq.level': 20 } }, outcome: 'satisfied', actions: [{ action: 'a:mid' }] },
      { id: 'third', when: { gte: { 'fact.github.stars': 100 } }, outcome: 'satisfied', actions: [{ action: 'a:contrib' }] },
    ],
  };
  const result = evaluateBranches({
    requirements,
    context: contextOf({ 'fact.qq.level': 50, 'fact.github.stars': 999 }, { onRead: (p) => read.push(p) }),
  });

  assert.equal(result.decision, 'satisfied');
  assert.equal(result.matchedBranchId, 'first');
  assert.deepEqual(result.actions, [{ action: 'a:high' }]);
  // ★ 短路证据：只读了第一个分支的操作数
  assert.deepEqual(read, ['fact.qq.level'], '后续分支的事实不应被读取（短路的可观测后果）');
  assert.deepEqual(result.shortCircuited, ['second', 'third']);
  const skipped = result.trace.filter((t) => t.skipped).map((t) => t.branchId);
  assert.deepEqual(skipped, ['second', 'third'], 'trace 必须如实标记被跳过的分支');
});

test('顺序语义：第一个为假、第二个为真 → 命中第二个', () => {
  const result = evaluateBranches({
    requirements: {
      branches: [
        { id: 'high', when: { gt: { 'fact.qq.level': 40 } }, outcome: 'satisfied', actions: [{ action: 'a:vip3' }] },
        { id: 'mid', when: { gt: { 'fact.qq.level': 20 } }, outcome: 'satisfied', actions: [{ action: 'a:vip2' }] },
      ],
    },
    context: contextOf({ 'fact.qq.level': 30 }),
  });
  assert.equal(result.matchedBranchId, 'mid');
  assert.deepEqual(result.actions, [{ action: 'a:vip2' }]);
  assert.deepEqual(result.shortCircuited, []);
});

// ─────────────────────────── ★ H1：不确定不落 else ───────────────────────────

test('★ H1：路径上有 indeterminate 且无人命中 → 整体 indeterminate，**不落到 else**', () => {
  const result = evaluateBranches({
    requirements: {
      branches: [
        // 依赖缺失的事实 → indeterminate
        { id: 'qq_high', when: { gt: { 'fact.qq.level': 40 } }, outcome: 'satisfied', actions: [{ action: 'a:vip3' }] },
      ],
      else: { outcome: 'unsatisfied', actions: [{ action: 'newapi-set-group:set_group', params: { group: 'default' } }] },
    },
    context: contextOf({}), // 事实缺失
  });

  assert.equal(result.decision, 'indeterminate', '★ 不得落到 else 去收回权限');
  assert.equal(result.matchedBranchId, null, '不匹配任何分支（包括 else）');
  assert.deepEqual(result.actions, [], '不确定时不产生任何动作');
});

test('★ H1：即使 else 存在且「看起来合理」，不确定也不能走它', () => {
  const result = evaluateBranches({
    requirements: {
      branches: [{ id: 'a', when: { eq: { 'fact.email.verified': true } }, outcome: 'satisfied' }],
      else: { outcome: 'unsatisfied', actions: [{ action: 'checkin:revoke' }] },
    },
    context: contextOf({}), // fact.email.verified 缺失
  });
  assert.equal(result.decision, 'indeterminate');
  assert.equal(result.actions.length, 0);
});

test('H1：不确定的分支在**后面**（前面已命中的不受影响）', () => {
  const result = evaluateBranches({
    requirements: {
      branches: [
        { id: 'first', when: { always: true }, outcome: 'satisfied', actions: [{ action: 'a:ok' }] },
        { id: 'second', when: { gt: { 'fact.missing.x': 1 } }, outcome: 'satisfied' },
      ],
      else: { outcome: 'unsatisfied' },
    },
    context: contextOf({}),
  });
  assert.equal(result.decision, 'satisfied', '前面已命中 → 短路，后面的不确定无影响');
  assert.equal(result.matchedBranchId, 'first');
});

test('H1：全部 when 明确为假 → 落到 else（不是 indeterminate）', () => {
  const result = evaluateBranches({
    requirements: {
      branches: [{ id: 'a', when: { gt: { 'fact.qq.level': 40 } }, outcome: 'satisfied' }],
      else: { outcome: 'unsatisfied', actions: [{ action: 'a:default' }] },
    },
    context: contextOf({ 'fact.qq.level': 10 }), // 明确为假
  });
  assert.equal(result.decision, 'unsatisfied');
  assert.equal(result.matchedBranchId, 'else');
  assert.deepEqual(result.actions, [{ action: 'a:default' }]);
});

// ─────────────────────────── else 可省略 ───────────────────────────

test('else 可省略：无命中 → unsatisfied 且**无动作**', () => {
  const result = evaluateBranches({
    requirements: { branches: [{ id: 'a', when: { gt: { 'fact.qq.level': 40 } }, outcome: 'satisfied' }] },
    context: contextOf({ 'fact.qq.level': 10 }),
  });
  assert.equal(result.decision, 'unsatisfied');
  assert.equal(result.matchedBranchId, null);
  assert.deepEqual(result.actions, []);
});

// ─────────────────────────── 动作覆盖 ───────────────────────────

test('★ 分支级动作覆盖策略级；未指定时回落策略级', () => {
  const policyActions = [{ action: 'policy:level' }];

  const overridden = evaluateBranches({
    requirements: { branches: [{ id: 'a', when: { always: true }, outcome: 'satisfied', actions: [{ action: 'branch:level' }] }] },
    context: contextOf({}),
    policyActions,
  });
  assert.deepEqual(overridden.actions, [{ action: 'branch:level' }], '分支级动作优先');

  const fallback = evaluateBranches({
    requirements: { branches: [{ id: 'a', when: { always: true }, outcome: 'satisfied' }] },
    context: contextOf({}),
    policyActions,
  });
  assert.deepEqual(fallback.actions, policyActions, '分支未指定动作 → 回落策略级');

  const elseFallback = evaluateBranches({
    requirements: {
      branches: [{ id: 'a', when: { always: false }, outcome: 'satisfied' }],
      else: { outcome: 'unsatisfied' },
    },
    context: contextOf({}),
    policyActions,
  });
  assert.deepEqual(elseFallback.actions, policyActions, 'else 未指定动作 → 回落策略级');
});

test('分支级参数：gracePeriodMs / minChangeIntervalMs 可覆盖（docs/04 §1.3）', () => {
  const result = evaluateBranches({
    requirements: {
      branches: [
        {
          id: 'a',
          when: { always: true },
          outcome: 'satisfied',
          actions: [],
          gracePeriodMs: 3_600_000,
          minChangeIntervalMs: 60_000,
        },
      ],
    },
    context: contextOf({}),
  });
  assert.equal(result.gracePeriodMs, 3_600_000);
  assert.equal(result.minChangeIntervalMs, 60_000);

  const plain = evaluateBranches({ requirements: { branches: [{ id: 'a', when: { always: true }, outcome: 'satisfied' }] }, context: contextOf({}) });
  assert.equal(plain.gracePeriodMs, undefined, '未指定则不下发覆盖（由策略级决定）');
});

// ─────────────────────────── outcome 与求值异常 ───────────────────────────

test('分支可声明 outcome: unsatisfied（「命中即判不满足」的显式分支）', () => {
  const result = evaluateBranches({
    requirements: {
      branches: [
        { id: 'blacklist', when: { eq: { 'fact.user.abuse': true } }, outcome: 'unsatisfied', actions: [{ action: 'checkin:revoke' }] },
        { id: 'normal', when: { always: true }, outcome: 'satisfied' },
      ],
    },
    context: contextOf({ 'fact.user.abuse': true }),
  });
  assert.equal(result.decision, 'unsatisfied');
  assert.equal(result.matchedBranchId, 'blacklist');
  assert.deepEqual(result.actions, [{ action: 'checkin:revoke' }]);
});

test('★ 求值异常 → error（不是 unsatisfied：不得据此收回权限）', () => {
  const result = evaluateBranches({
    requirements: {
      branches: [{ id: 'broken', when: { $unknownOp: { 'fact.x.y': 1 } } as never, outcome: 'satisfied' }],
      else: { outcome: 'unsatisfied', actions: [{ action: 'checkin:revoke' }] },
    },
    context: contextOf({}),
    logger: silentLogger,
  });
  assert.equal(result.decision, 'error');
  assert.equal(result.actions.length, 0, '异常不产生动作');
  assert.equal(result.trace[0]!.whenState, 'error');
});

// ─────────────────────────── 轨迹与解释 ───────────────────────────

test('trace 与 explanations：逐分支可解释（用户能看到「为什么通过 / 差在哪」）', () => {
  const result = evaluateBranches({
    requirements: {
      branches: [
        { id: 'a', label: 'QQ > 40', when: { gt: { 'fact.qq.level': 40 } }, outcome: 'satisfied' },
        { id: 'b', label: 'QQ 20~40', when: { gt: { 'fact.qq.level': 20 } }, outcome: 'satisfied' },
      ],
      else: { outcome: 'unsatisfied' },
    },
    context: contextOf({ 'fact.qq.level': 30 }),
  });
  assert.deepEqual(result.trace.map((t) => `${t.branchId}:${t.whenState}:${t.matched}`), ['a:false:false', 'b:true:true']);
  assert.equal(result.trace[0]!.label, 'QQ > 40');
  assert.equal(result.matchedLabel, 'QQ 20~40');
  // 被求值的分支有解释树（供「差在哪一项」）
  assert.equal(result.explanations.length, 2);
  assert.equal(result.explanations[0]!.node.state, 'false');
});

test('形态 A 的求值行为与「单分支 + else」一致（规整后同一套逻辑）', () => {
  // 形态 A：满足
  const a = evaluateBranches({ requirements: { expression: { always: true } }, context: contextOf({}) });
  assert.equal(a.decision, 'satisfied');
  assert.equal(a.matchedBranchId, 'default');

  // 形态 A：不满足（expression 为假，无 else → unsatisfied 无动作）
  const b = evaluateBranches({ requirements: { expression: { always: false } }, context: contextOf({}) });
  assert.equal(b.decision, 'unsatisfied');
  assert.deepEqual(b.actions, []);
});
