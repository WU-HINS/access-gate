/**
 * ★★ `ag_user_policy_state` 两个状态列的**行为**测试（审计处置表里"实现"的两项）。
 *
 * ★ 为什么必须单独写：本会话前两轮实现了 `satisfiedAt` 与 `lastEvalId`，
 *   但当时只有「既有 1357 条没被破坏」这一**回归证据**——那不是**新能力的证据**。
 *   本文件把两列的关键语义钉住，其中两条最容易写错：
 *   ① `satisfiedAt` 是**首次**满足（后续评估**不得覆盖**）——否则"授予延迟"没了分母；
 *   ② `lastEvalId` 只由**评估事件**写入（显式撤销/宽限到期不来自某次评估）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transition, type LifecycleSnapshot, type LifecyclePolicy } from '../src/core/lifecycle.ts';

const POLICY: LifecyclePolicy = { gracePeriodMs: 3_600_000 };
const T0 = new Date('2026-09-26T00:00:00Z');
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

const snap = (over: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot => ({
  state: 'unknown',
  stateChangedAt: T0,
  atRiskCount: 0,
  actionSeq: 0,
  ...over,
});

// ─────────────────────── satisfiedAt ───────────────────────

test('★ `satisfiedAt`：首次满足时写入（值为事件时间）', () => {
  const result = transition(
    snap(),
    { kind: 'evaluated', decision: 'satisfied', at: T0, evalId: 1 },
    POLICY,
  );
  assert.equal(result.next.state, 'granted');
  assert.equal(result.next.satisfiedAt?.toISOString(), T0.toISOString());
});

test('★★ `satisfiedAt`：**后续评估不得覆盖**（它是"首次"，不是"最后一次"）', () => {
  const first = transition(
    snap(),
    { kind: 'evaluated', decision: 'satisfied', at: T0, evalId: 1 },
    POLICY,
  );
  // 已 granted 时再来一次 satisfied：状态不变，`satisfiedAt` 也不该变
  const later = plus(T0, 86_400_000);
  const second = transition(
    first.next,
    { kind: 'evaluated', decision: 'satisfied', at: later, evalId: 2 },
    POLICY,
  );
  assert.equal(
    second.next.satisfiedAt?.toISOString(),
    T0.toISOString(),
    '★ 覆盖它就退化成"最后一次满足"——"授予延迟"这个度量会失去分母',
  );
  assert.equal(second.next.lastEvalId, 2, '但 `lastEvalId` 应跟上（它记的是"最近依据"）');
});

test('★★ `satisfiedAt` 跨越宽限期保持**最初那次**（at_risk → granted 恢复）', () => {
  // unknown → granted（satisfiedAt = T0）
  let snapshot = transition(
    snap(),
    { kind: 'evaluated', decision: 'satisfied', at: T0, evalId: 1 },
    POLICY,
  ).next;
  // granted → at_risk（不满足）
  snapshot = transition(
    snapshot,
    { kind: 'evaluated', decision: 'unsatisfied', at: plus(T0, 1_000), evalId: 2 },
    POLICY,
  ).next;
  assert.equal(snapshot.state, 'at_risk');
  // at_risk → granted（事实恢复）
  const recovered = transition(
    snapshot,
    { kind: 'evaluated', decision: 'satisfied', at: plus(T0, 2_000), evalId: 3 },
    POLICY,
  );
  assert.equal(recovered.next.state, 'granted');
  assert.equal(
    recovered.next.satisfiedAt?.toISOString(),
    T0.toISOString(),
    '★ 首次满足的那一刻没有变——中间只是抖动过一次',
  );
});

test('从未满足过时 `satisfiedAt` 为 `undefined`（不伪造时间点）', () => {
  const result = transition(
    snap(),
    { kind: 'evaluated', decision: 'unsatisfied', at: T0, evalId: 1 },
    POLICY,
  );
  assert.equal(result.next.satisfiedAt, undefined);
});

// ─────────────────────── lastEvalId ───────────────────────

test('★ `lastEvalId`：评估事件携带 `evalId` 时写入', () => {
  const result = transition(
    snap(),
    { kind: 'evaluated', decision: 'unsatisfied', at: T0, evalId: 42 },
    POLICY,
  );
  assert.equal(result.next.lastEvalId, 42);
});

test('评估事件**没有** `evalId`（如未落库）时不写入', () => {
  const result = transition(
    snap(),
    { kind: 'evaluated', decision: 'unsatisfied', at: T0 },
    POLICY,
  );
  assert.equal(result.next.lastEvalId, undefined);
});

test('★★ 显式撤销 / 宽限到期**不写** `lastEvalId`（它们不是评估事件）', () => {
  const revoked = transition(snap({ state: 'granted' }), { kind: 'binding.revoked', at: T0 }, POLICY);
  assert.equal(revoked.next.state, 'revoked');
  assert.equal(
    revoked.next.lastEvalId,
    undefined,
    '★ 因果事件不来自某次评估——写一个评估 id 会让"依据"指向无关记录',
  );

  const expired = transition(
    snap({ state: 'at_risk', graceUntil: plus(T0, -1_000) }),
    { kind: 'grace_expired', at: T0 },
    POLICY,
  );
  assert.equal(expired.next.state, 'revoked');
  assert.equal(expired.next.lastEvalId, undefined);
});

test('`lastEvalId` 随最近一次评估**更新**（与 `satisfiedAt` 的"首次"语义相反）', () => {
  const first = transition(
    snap(),
    { kind: 'evaluated', decision: 'satisfied', at: T0, evalId: 1 },
    POLICY,
  );
  const second = transition(
    first.next,
    { kind: 'evaluated', decision: 'satisfied', at: plus(T0, 1_000), evalId: 2 },
    POLICY,
  );
  assert.equal(second.next.lastEvalId, 2, '★ "依据哪次评估"应指向**最近**一次');
});
