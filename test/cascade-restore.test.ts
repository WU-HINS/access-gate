/**
 * ★★ 级联回退的**端到端**验收（`docs/10 P1` / `docs/05 §3.5`）。
 *
 * 用**真实的** `createRestoreSource`（装配层与它共用同一份实现）+ 真实 `InMemoryLifecycleStateStore`
 * + 真实 restore handler，复现文档给出的那张表：
 *
 * | 步骤 | A | B | 期望 | **修复前** |
 * |---|---|---|---|---|
 * | 初始 | ✅ | ✅ | vip2 | vip2 |
 * | **B 不再满足** | ✅ | ❌ | **basic**（A 仍要求） | **default** ❌ |
 *
 * ★ 这条测试与 `test/action-restore.test.ts` 的区别：后者验**判定逻辑**，
 *   本文件验**跨组件串联**（状态表 → 策略定义 → 决胜 → 写回），
 *   即「接线之后，行为真的按文档走」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryLifecycleStateStore } from '../src/core/patrol.ts';
import { createRestoreSource } from '../src/core/restore-source.ts';
import { createRestoreGroupHandler } from '../src/core/action-restore.ts';
import type { ActionContext } from '../src/core/action-executor.ts';
import type { PolicyDocument } from '../src/policy/model.ts';
import type { LifecycleState } from '../src/core/lifecycle.ts';

const SITE = 'site-1';
const USER = 'u-42';
const ACTION_KEY = 'newapi-set-group:set_group';

/** 与 `docs/07 §5` 场景 A 同构的两条阶梯策略（A: tier1 → basic；B: tier2 → vip2） */
const POLICY_A: PolicyDocument = {
  code: 'tier1-edu',
  name: '教育邮箱',
  priority: 100,
  spec: {
    requirements: { expression: { always: true } },
    actions: { onSatisfied: [{ action: ACTION_KEY, params: { group: 'basic' } }] },
  },
};

const POLICY_B: PolicyDocument = {
  code: 'tier2-contributor',
  name: '贡献者',
  priority: 50,
  spec: {
    requirements: { expression: { always: true } },
    actions: { onSatisfied: [{ action: ACTION_KEY, params: { group: 'vip2' } }] },
  },
};

function snapshot(state: LifecycleState, actionSeq = 1) {
  return { state, stateChangedAt: new Date('2026-09-26T00:00:00Z'), atRiskCount: 0, actionSeq };
}

function harness(policies: PolicyDocument[]) {
  const lifecycle = new InMemoryLifecycleStateStore();
  const written: string[] = [];
  const conflicts: unknown[] = [];
  const source = createRestoreSource({
    lifecycle,
    listPolicies: async () => policies,
    policyIdOfCode: async (code) => code, // 内存模式：状态表的 policy_id 就是 code
    policyCodeOfId: async (id) => id,
    actionKey: ACTION_KEY,
  });
  const handler = createRestoreGroupHandler({
    source,
    actionKey: ACTION_KEY,
    externalIdOf: () => USER,
    currentGroup: async () => 'vip2',
    setGroup: async (_externalId, group) => {
      written.push(group);
    },
    onConflict: (input) => {
      conflicts.push(input);
    },
  });
  const context = (policyId: string): ActionContext => ({
    siteId: SITE,
    userId: USER,
    policyId,
    actionSeq: 2,
    idempotencyKey: 'k2',
    params: {},
    attempt: 1,
  });
  return { lifecycle, source, handler, written, conflicts, context };
}

test('★ 端到端：B 不再满足而 A 仍满足 → 回退到 A 要求的 basic（不是静态 default）', async () => {
  const h = harness([POLICY_A, POLICY_B]);

  // 初始：A、B 都 granted；B 首次接管前记录 baseline = default
  await h.lifecycle.save(SITE, USER, POLICY_A.code, snapshot('granted'));
  await h.lifecycle.save(SITE, USER, POLICY_B.code, snapshot('granted'));
  await h.lifecycle.rememberBaseline({
    siteId: SITE,
    userId: USER,
    policyCode: POLICY_B.code,
    actionKey: ACTION_KEY,
    value: 'default',
  });

  // B 不再满足（状态转 revoked）→ 执行回退
  await h.lifecycle.save(SITE, USER, POLICY_B.code, snapshot('revoked'));
  const result = await h.handler.execute(h.context(POLICY_B.code));

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(h.written, ['basic'], '★ 必须回到仍满足的 A 所要求的档位');
  const detail = result.detail as { basis: string; target: string };
  assert.equal(detail.target, 'basic');
  assert.equal(detail.basis, 'active_policy', '依据是「仍有满足的策略」，而非 baseline');
});

test('端到端：A 也不满足 → 回退到 baseline（首次接管前的原值）', async () => {
  const h = harness([POLICY_A, POLICY_B]);
  await h.lifecycle.save(SITE, USER, POLICY_A.code, snapshot('revoked'));
  await h.lifecycle.save(SITE, USER, POLICY_B.code, snapshot('revoked'));
  await h.lifecycle.rememberBaseline({
    siteId: SITE,
    userId: USER,
    policyCode: POLICY_B.code,
    actionKey: ACTION_KEY,
    value: 'default',
  });

  const result = await h.handler.execute(h.context(POLICY_B.code));
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(h.written, ['default']);
  assert.equal((result.detail as { basis: string }).basis, 'baseline');
});

test('端到端：没有任何可回退目标（无仍满足策略、无 baseline）→ 不动', async () => {
  const h = harness([POLICY_A, POLICY_B]);
  await h.lifecycle.save(SITE, USER, POLICY_A.code, snapshot('revoked'));
  await h.lifecycle.save(SITE, USER, POLICY_B.code, snapshot('revoked'));
  // 不写 baseline —— 模拟「从未被平台接管过」
  const result = await h.handler.execute(h.context(POLICY_B.code));
  assert.equal(result.status, 'skipped');
  assert.deepEqual(h.written, [], '★ 绝不覆盖从未被平台管理过的值');
});

test('端到端：两条策略仍满足但 priority 相同、目标不同 → 拒绝执行并告警', async () => {
  const samePriorityA: PolicyDocument = { ...POLICY_A, priority: 50 };
  const h = harness([samePriorityA, POLICY_B]); // 两者 priority 均 50
  await h.lifecycle.save(SITE, USER, samePriorityA.code, snapshot('granted'));
  await h.lifecycle.save(SITE, USER, POLICY_B.code, snapshot('granted'));

  // 回退 B（policyId = B.code）→ 剩下 A（basic）；但为造冲突，让第三方也同 priority
  const policyC: PolicyDocument = {
    code: 'tier2-alt',
    name: '另一个 vip2-pro',
    priority: 50,
    spec: {
      requirements: { expression: { always: true } },
      actions: { onSatisfied: [{ action: ACTION_KEY, params: { group: 'basic' } }] },
    },
  };
  const h2 = harness([policyC, POLICY_B]);
  await h2.lifecycle.save(SITE, USER, policyC.code, snapshot('granted'));
  await h2.lifecycle.save(SITE, USER, POLICY_B.code, snapshot('granted'));

  // policyC 与 policyD 同 priority 但目标不同 → 冲突
  const policyD: PolicyDocument = {
    code: 'tier2-pro',
    name: 'vip2-pro',
    priority: 50,
    spec: {
      requirements: { expression: { always: true } },
      actions: { onSatisfied: [{ action: ACTION_KEY, params: { group: 'vip2-pro' } }] },
    },
  };
  const h3 = harness([policyC, policyD, POLICY_B]);
  await h3.lifecycle.save(SITE, USER, policyC.code, snapshot('granted'));
  await h3.lifecycle.save(SITE, USER, policyD.code, snapshot('granted'));
  await h3.lifecycle.save(SITE, USER, POLICY_B.code, snapshot('revoked'));

  const result = await h3.handler.execute(h3.context(POLICY_B.code));
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.deepEqual(h3.written, [], '★ 冲突时绝不写下游');
  assert.equal(h3.conflicts.length, 1, '必须告警');

  // 前两个 harness 只为证明「同 priority 但目标相同 → 不算冲突」
  const okSameTarget = await h2.handler.execute(h2.context(POLICY_B.code));
  assert.equal(okSameTarget.status, 'succeeded');
  assert.deepEqual(h2.written, ['basic']);
  void h;
});
