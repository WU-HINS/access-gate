/**
 * 生命周期状态机验收（M2-5）—— 两条不变量是重点。
 *
 * 断言重点：
 *   - **H1**：`indeterminate` **绝不**推进状态、**绝不**产生动作；
 *     `not_applicable` / `error` 同理（都不是「主体不满足」）；
 *   - **H2**：`unsatisfied` 只能进 `at_risk`，**必须等宽限期**才能 revoke
 *     （否则一次下游抖动会让成千用户同时被踢）；
 *   - **显式因果事件**：`binding.revoked` 才允许跳过宽限期直接收回——
 *     这正是文档里那条「解绑 → missing → 不降级 → 权限永久保留」的因果断裂的修法；
 *   - **actionSeq 只在真正要发动作时递增**（它是幂等键的组成部分）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkInvariants,
  initialState,
  replay,
  transition,
  type LifecycleEvent,
  type LifecyclePolicy,
  type LifecycleSnapshot,
} from '../src/core/lifecycle.ts';

const POLICY: LifecyclePolicy = { gracePeriodMs: 72 * 3_600_000 };
const T0 = new Date('2025-06-01T00:00:00Z');
const at = (hours: number): Date => new Date(T0.getTime() + hours * 3_600_000);

function snapshot(overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return { ...initialState(T0), ...overrides };
}

// ─────────────────────────── H1：不确定不推进 ───────────────────────────

test('★ H1：indeterminate 保持原状态、不产生动作、仅提高巡检频率', () => {
  for (const state of ['unknown', 'satisfied', 'granted', 'at_risk', 'revoked'] as const) {
    const current = snapshot({ state, ...(state === 'at_risk' ? { graceUntil: at(72) } : {}) });
    const result = transition(current, { kind: 'evaluated', decision: 'indeterminate', at: at(1) }, POLICY);
    assert.equal(result.changed, false, `${state} 在 indeterminate 下不得改变状态`);
    assert.equal(result.next.state, state);
    assert.equal(result.actionIntent, 'none');
    assert.equal(result.escalate, true, '应提高巡检频率');
    assert.match(result.note, /H1/);
  }
});

test('★ H1 反例场景：解绑导致事实 missing 时，权限**不得**被收回', () => {
  // 用户已 granted
  let current = snapshot({ state: 'granted', actionSeq: 3 });
  // 解绑后重评估：事实 missing → indeterminate
  const afterUnbind = transition(current, { kind: 'evaluated', decision: 'indeterminate', at: at(1) }, POLICY);
  assert.equal(afterUnbind.next.state, 'granted', '事实缺失时权限保持（这是 H1 的核心目的）');
  current = afterUnbind.next;

  // ★ 真正的收回只能靠显式因果事件
  const revoked = transition(current, { kind: 'binding.revoked', at: at(2), reason: '用户解绑' }, POLICY);
  assert.equal(revoked.next.state, 'revoked');
  assert.equal(revoked.actionIntent, 'revoke');
  assert.equal(revoked.changed, true);
  assert.match(revoked.note, /跳过 at_risk 与宽限期/);
});

test('not_applicable 与 error 都不推进状态（它们不是「主体不满足」）', () => {
  const current = snapshot({ state: 'granted' });
  const na = transition(current, { kind: 'evaluated', decision: 'not_applicable', at: at(1) }, POLICY);
  assert.equal(na.changed, false);
  assert.equal(na.actionIntent, 'none');

  const err = transition(current, { kind: 'evaluated', decision: 'error', at: at(1) }, POLICY);
  assert.equal(err.changed, false);
  assert.equal(err.actionIntent, 'none');
  assert.equal(err.escalate, true, '求值异常应告警（多为策略配置问题）');
});

// ─────────────────────────── H2：宽限期 ───────────────────────────

test('★ H2：granted + unsatisfied → at_risk（设宽限期），**不立即收回**', () => {
  const current = snapshot({ state: 'granted', actionSeq: 3 });
  const result = transition(current, { kind: 'evaluated', decision: 'unsatisfied', at: at(1) }, POLICY);
  assert.equal(result.next.state, 'at_risk');
  assert.equal(result.actionIntent, 'none', '进入 at_risk 不发任何动作');
  assert.equal(result.next.actionSeq, 3, 'actionSeq 不递增（没有动作要发）');
  assert.equal(result.next.graceUntil!.toISOString(), at(1 + 72).toISOString());
  assert.equal(result.next.atRiskCount, 1);
  assert.match(result.note, /H2/);
});

test('★ H2：宽限期未到 → 不收回；到期 → 收回', () => {
  const atRisk = transition(snapshot({ state: 'granted' }), { kind: 'evaluated', decision: 'unsatisfied', at: at(1) }, POLICY).next;

  const early = transition(atRisk, { kind: 'grace_expired', at: at(2) }, POLICY);
  assert.equal(early.changed, false);
  assert.equal(early.next.state, 'at_risk');
  assert.match(early.note, /宽限期尚未到期/);

  const due = transition(atRisk, { kind: 'grace_expired', at: at(1 + 72) }, POLICY);
  assert.equal(due.changed, true);
  assert.equal(due.next.state, 'revoked');
  assert.equal(due.actionIntent, 'revoke');
});

test('★ 防「千级同时踢下线」：unsatisfied 在 at_risk 期间只是顺延宽限，不收回', () => {
  let current = snapshot({ state: 'granted' });
  current = transition(current, { kind: 'evaluated', decision: 'unsatisfied', at: at(1) }, POLICY).next;
  const firstGrace = current.graceUntil!.getTime();

  // 巡检 10 次都仍不满足
  for (let i = 0; i < 10; i += 1) {
    const result = transition(current, { kind: 'evaluated', decision: 'unsatisfied', at: at(2 + i) }, POLICY);
    assert.equal(result.next.state, 'at_risk', '应始终停留在 at_risk');
    assert.equal(result.actionIntent, 'none');
    current = result.next;
  }
  assert.ok(current.graceUntil!.getTime() >= firstGrace, '宽限被顺延而非立即收回');
});

test('at_risk + satisfied → 恢复 granted 并**撤销宽限**（不重复发动作）', () => {
  const atRisk = snapshot({ state: 'at_risk', graceUntil: at(100), actionSeq: 5, atRiskCount: 1 });
  const result = transition(atRisk, { kind: 'evaluated', decision: 'satisfied', at: at(2) }, POLICY);
  assert.equal(result.next.state, 'granted');
  assert.equal(result.next.graceUntil, null);
  assert.equal(result.actionIntent, 'grant', '恢复授予需要发动作（重新解锁）');
  assert.match(result.note, /撤销宽限/);
});

// ─────────────────────────── 授予与幂等 ───────────────────────────

test('unknown + satisfied → granted（发动作，actionSeq 递增）', () => {
  const result = transition(snapshot({ state: 'unknown' }), { kind: 'evaluated', decision: 'satisfied', at: at(1) }, POLICY);
  assert.equal(result.next.state, 'granted');
  assert.equal(result.actionIntent, 'grant');
  assert.equal(result.next.actionSeq, 1, '★ 发动作时递增 actionSeq（幂等键的组成部分）');
});

test('granted + satisfied → 无变化、不重复发动作（幂等）', () => {
  const current = snapshot({ state: 'granted', actionSeq: 4 });
  const result = transition(current, { kind: 'evaluated', decision: 'satisfied', at: at(1) }, POLICY);
  assert.equal(result.changed, false);
  assert.equal(result.actionIntent, 'none');
  assert.equal(result.next.actionSeq, 4, '不递增 → 幂等键不变 → 下游不会被重复调用');
});

test('★ 重复巡检 10 次 satisfied：actionSeq 保持不变（这是「无额外会话吊销」的技术基础）', () => {
  let current = snapshot({ state: 'unknown' });
  current = transition(current, { kind: 'evaluated', decision: 'satisfied', at: at(0) }, POLICY).next;
  const seqAfterGrant = current.actionSeq;
  for (let i = 0; i < 10; i += 1) {
    const result = transition(current, { kind: 'evaluated', decision: 'satisfied', at: at(i + 1) }, POLICY);
    assert.equal(result.actionIntent, 'none');
    current = result.next;
  }
  assert.equal(current.actionSeq, seqAfterGrant, 'actionSeq 不变 → 幂等键不变 → 不重复写回');
});

test('revoked 后再次 satisfied → 重新授予（回到原值也能重新执行，靠 seq 变化）', () => {
  const revoked = snapshot({ state: 'revoked', actionSeq: 9 });
  const result = transition(revoked, { kind: 'evaluated', decision: 'satisfied', at: at(1) }, POLICY);
  assert.equal(result.next.state, 'granted');
  assert.equal(result.actionIntent, 'grant');
  assert.equal(result.next.actionSeq, 10, 'seq 变化 → 幂等键变化 → 允许重新执行');
});

test('重复的 binding.revoked 幂等（已 revoked 不再产生动作）', () => {
  const revoked = snapshot({ state: 'revoked', actionSeq: 2 });
  const result = transition(revoked, { kind: 'binding.revoked', at: at(1) }, POLICY);
  assert.equal(result.changed, false);
  assert.equal(result.actionIntent, 'none');
  assert.match(result.note, /幂等/);
});

test('不在 at_risk 时 grace_expired 被忽略', () => {
  for (const state of ['unknown', 'satisfied', 'granted', 'revoked'] as const) {
    const result = transition(snapshot({ state }), { kind: 'grace_expired', at: at(1) }, POLICY);
    assert.equal(result.changed, false);
    assert.match(result.note, /不在 at_risk/);
  }
});

// ─────────────────────────── 回放与不变量 ───────────────────────────

test('★ 回放真实场景：授予 → 三次抖动 → 恢复 → 解绑收回', () => {
  const events: LifecycleEvent[] = [
    { kind: 'evaluated', decision: 'satisfied', at: at(0) },
    { kind: 'evaluated', decision: 'unsatisfied', at: at(1) },
    { kind: 'evaluated', decision: 'indeterminate', at: at(2) },
    { kind: 'evaluated', decision: 'satisfied', at: at(3) },
    { kind: 'evaluated', decision: 'unsatisfied', at: at(4) },
    { kind: 'grace_expired', at: at(4 + 72) },
    { kind: 'evaluated', decision: 'satisfied', at: at(100) },
    { kind: 'binding.revoked', at: at(101) },
  ];
  const { snapshot: final, transitions } = replay(events, POLICY, initialState(T0));
  assert.equal(final.state, 'revoked');
  assert.deepEqual(
    transitions.map((t) => t.next.state),
    ['granted', 'at_risk', 'at_risk', 'granted', 'at_risk', 'revoked', 'granted', 'revoked'],
  );
  // 关键：第 3 步 indeterminate **没有**改变状态
  assert.equal(transitions[2]!.changed, false);
  assert.equal(transitions[2]!.actionIntent, 'none');
});

test('★ 不变量检查能发现人为构造的违规（证明它不是恒真）', () => {
  const ok = checkInvariants([
    transition(snapshot({ state: 'granted' }), { kind: 'evaluated', decision: 'indeterminate', at: at(1) }, POLICY),
    transition(snapshot({ state: 'granted' }), { kind: 'evaluated', decision: 'unsatisfied', at: at(1) }, POLICY),
  ]);
  assert.deepEqual(ok, []);

  // 伪造一个「indeterminate 却推进了状态」的迁移
  const forged = {
    next: snapshot({ state: 'revoked' }),
    changed: true,
    trigger: 'evaluated.indeterminate' as const,
    actionIntent: 'revoke' as const,
    escalate: false,
    note: '伪造',
  };
  const violations = checkInvariants([forged]);
  assert.ok(violations.some((v) => v.invariant === 'H1'));

  // 伪造一个「unsatisfied 直接 revoke」
  const forged2 = {
    next: snapshot({ state: 'revoked' }),
    changed: true,
    trigger: 'evaluated.unsatisfied' as const,
    actionIntent: 'revoke' as const,
    escalate: false,
    note: '伪造',
  };
  assert.ok(checkInvariants([forged2]).some((v) => v.invariant === 'H2'));
});

test('未覆盖的评估结论抛错（不静默返回原状态）', () => {
  assert.throws(
    () => transition(snapshot(), { kind: 'evaluated', decision: 'weird' as never, at: at(1) }, POLICY),
    /未覆盖的评估结论/,
  );
});
