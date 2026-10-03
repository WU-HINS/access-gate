/**
 * 级联回退（`docs/10 P1` / `docs/05 §3.5`）—— `newapi-set-group:restore` 的判定与执行。
 *
 * ★ 本文件要证明的核心事实（也是修复前**不成立**的那条）：
 *   **策略 B 失效时，用户回退到「仍然满足的 A」所要求的档位，而不是静态的 default。**
 *
 * ★ 断言直接对着文档的那张表：
 *   | 步骤 | A | B | 期望 | 修复前的行为 |
 *   | 初始 | ✅ | ✅ | vip2 | vip2 |
 *   | B 不再满足 | ✅ | ❌ | **basic** | **default** ❌ |
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRestoreGroupHandler,
  decideRestoreTarget,
  type RestoreRequirement,
  type RestoreSource,
} from '../src/core/action-restore.ts';
import { createSetGroupHandler, type ActionContext } from '../src/core/action-executor.ts';

const SITE = 'site-1';
const USER = '42';
const POLICY_A = 'policy-a';
const POLICY_B = 'policy-b';

const req = (over: Partial<RestoreRequirement> & { policyId: string }): RestoreRequirement => ({
  policyCode: over.policyId,
  tier: null,
  priority: 100,
  targetGroup: null,
  ...over,
});

const context = (policyId: string): ActionContext => ({
  siteId: SITE,
  userId: USER,
  policyId,
  actionSeq: 1,
  idempotencyKey: 'k',
  params: {},
  attempt: 1,
});

// ─────────────────────────── 纯决策（decideRestoreTarget） ───────────────────────────

test('★ 级联回退：B 失效而 A 仍满足 → 回到 A 要求的 basic（不是静态 default）', () => {
  const decision = decideRestoreTarget({
    active: [req({ policyId: POLICY_A, tier: 1, priority: 100, targetGroup: 'basic' })],
    baseline: 'default',
  });
  assert.equal(decision.target, 'basic');
  assert.equal(decision.basis, 'active_policy');
});

test('多策略仍满足 → 取 tier 最高者的要求', () => {
  const decision = decideRestoreTarget({
    active: [
      req({ policyId: 'p1', tier: 1, priority: 10, targetGroup: 'basic' }),
      req({ policyId: 'p2', tier: 3, priority: 90, targetGroup: 'vip3' }),
      req({ policyId: 'p3', tier: 2, priority: 50, targetGroup: 'vip2' }),
    ],
    baseline: 'default',
  });
  assert.equal(decision.target, 'vip3');
});

test('tier 相同 → priority 小者胜（小者优先与策略分流一致）', () => {
  const decision = decideRestoreTarget({
    active: [
      req({ policyId: 'p1', tier: 2, priority: 80, targetGroup: 'vip2' }),
      req({ policyId: 'p2', tier: 2, priority: 20, targetGroup: 'vip2-pro' }),
    ],
    baseline: 'default',
  });
  assert.equal(decision.target, 'vip2-pro');
});

test('★ tier 与 priority 都相同、目标不同 → **拒绝决胜**（宁可不动，也不随机选）', () => {
  const decision = decideRestoreTarget({
    active: [
      req({ policyId: 'p1', tier: 2, priority: 50, targetGroup: 'vip2' }),
      req({ policyId: 'p2', tier: 2, priority: 50, targetGroup: 'vip2-pro' }),
    ],
    baseline: 'default',
  });
  assert.equal(decision.target, null);
  assert.equal(decision.basis, 'active_policy', 'basis 仍是 active_policy——调用方据此判定「冲突」而非「无目标」');
  assert.equal(decision.candidates.length, 2);
});

test('tier/priority 相同但目标**相同** → 不算冲突（同一档），正常返回', () => {
  const decision = decideRestoreTarget({
    active: [
      req({ policyId: 'p1', tier: 2, priority: 50, targetGroup: 'vip2' }),
      req({ policyId: 'p2', tier: 2, priority: 50, targetGroup: 'vip2' }),
    ],
    baseline: 'default',
  });
  assert.equal(decision.target, 'vip2');
});

test('没有其它仍满足的策略 → 回退到 baseline', () => {
  const decision = decideRestoreTarget({ active: [], baseline: 'vip3' });
  assert.equal(decision.target, 'vip3');
  assert.equal(decision.basis, 'baseline');
});

test('既无仍满足的策略、也无 baseline → 不回退（绝不覆盖从未被平台管理过的值）', () => {
  const decision = decideRestoreTarget({ active: [], baseline: null });
  assert.equal(decision.target, null);
  assert.equal(decision.basis, 'none');
});

test('仍满足但不要求分组的策略（targetGroup=null）不参与决胜', () => {
  const decision = decideRestoreTarget({
    active: [req({ policyId: 'p1', tier: 9, priority: 1, targetGroup: null })],
    baseline: 'baseline-x',
  });
  assert.equal(decision.target, 'baseline-x');
  assert.equal(decision.basis, 'baseline');
});

test('非阶梯策略（tier=null）被视为最低档，不压过真正的阶梯', () => {
  const decision = decideRestoreTarget({
    active: [
      req({ policyId: 'p1', tier: null, priority: 1, targetGroup: 'no-tier' }),
      req({ policyId: 'p2', tier: 1, priority: 999, targetGroup: 'tier1' }),
    ],
    baseline: null,
  });
  assert.equal(decision.target, 'tier1');
});

// ─────────────────────────── handler（含副作用与告警） ───────────────────────────

function makeHandler(input: {
  active: RestoreRequirement[];
  baseline: string | null;
  current: string | null;
}) {
  const written: { externalId: string; group: string }[] = [];
  const conflicts: { policyCode: string; targetGroup: string }[][] = [];
  const source: RestoreSource = {
    async listActiveRequirements() {
      return input.active;
    },
    async baselineOf() {
      return input.baseline;
    },
  };
  const handler = createRestoreGroupHandler({
    source,
    currentGroup: async () => input.current,
    setGroup: async (externalId, group) => {
      written.push({ externalId, group });
    },
    externalIdOf: () => '42',
    // ★ 动作规范形由装配层注入（核心不得硬编码具体系统名）
    actionKey: 'newapi-set-group:set_group',
    onConflict: ({ candidates }) => {
      conflicts.push(candidates.map((c) => ({ ...c })));
    },
  });
  return { handler, written, conflicts };
}

test('handler：排除「正在回退的这个策略」自身（否则会回退到自己要求的档位）', async () => {
  const { handler, written } = makeHandler({
    // 列表里同时含 A（仍满足）与被回退的 B —— 调用方排除自己后只应看到 A
    active: [req({ policyId: POLICY_A, tier: 1, targetGroup: 'basic' })],
    baseline: 'default',
    current: 'vip2',
  });
  const result = await handler.execute(context(POLICY_B));
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(written, [{ externalId: '42', group: 'basic' }]);
});

test('handler：★ 决胜冲突 → failed + 告警（**不写下游**）', async () => {
  const { handler, written, conflicts } = makeHandler({
    active: [
      req({ policyId: 'p1', tier: 2, priority: 50, targetGroup: 'vip2' }),
      req({ policyId: 'p2', tier: 2, priority: 50, targetGroup: 'vip2-pro' }),
    ],
    baseline: 'default',
    current: 'vip2',
  });
  const result = await handler.execute(context(POLICY_B));
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false, '冲突是配置问题，重试无意义');
  assert.match(String(result.reason), /restore_target_conflict/);
  assert.deepEqual(written, [], '★ 冲突时绝不写下游');
  assert.equal(conflicts.length, 1, '必须告警（否则是静默的随机行为）');
  assert.deepEqual(
    conflicts[0]!.map((c) => c.targetGroup).sort(),
    ['vip2', 'vip2-pro'],
  );
});

test('handler：无目标 → skipped（不写下游）', async () => {
  const { handler, written } = makeHandler({ active: [], baseline: null, current: 'vip2' });
  const result = await handler.execute(context(POLICY_B));
  assert.equal(result.status, 'skipped');
  assert.match(String(result.reason), /no_restore_target/);
  assert.deepEqual(written, []);
});

test('handler：已到位 → skipped/no_change（避免无谓写下游与踢会话）', async () => {
  const { handler, written } = makeHandler({ active: [], baseline: 'default', current: 'default' });
  const result = await handler.execute(context(POLICY_B));
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_change');
  assert.deepEqual(written, []);
});

test('handler：回退到 baseline 且当前值与之不同 → 报 baselineDrifted（交上层按 driftPolicy 处理）', async () => {
  const { handler } = makeHandler({ active: [], baseline: 'default', current: 'vip3-手工设的' });
  const result = await handler.execute(context(POLICY_B));
  assert.equal(result.status, 'succeeded');
  const detail = result.detail as { target: string; basis: string; baselineDrifted?: boolean };
  assert.equal(detail.target, 'default');
  assert.equal(detail.basis, 'baseline');
  assert.equal(detail.baselineDrifted, true, '★ 只报事实，不擅自判断是否落笔');
});

// ─────────────────────────── baseline 的写入时机（与 set_group 联动） ───────────────────────────

test('★ baseline 记录发生在**写回之前**，且记的是「接管前」的值', async () => {
  const order: string[] = [];
  const recorded: { from: string; to: string }[] = [];
  const handler = createSetGroupHandler({
    externalIdOf: () => '42',
    getSubject: async () => ({ attributes: { group: 'vip3' } }),
    setGroup: async () => {
      order.push('setGroup');
    },
    rememberBaseline: async ({ from, to }) => {
      order.push('rememberBaseline');
      recorded.push({ from, to });
    },
    now: () => new Date('2026-09-26T00:00:00Z'),
  });

  const result = await handler.execute({
    siteId: SITE,
    userId: USER,
    policyId: POLICY_A,
    actionSeq: 1,
    idempotencyKey: 'k',
    params: { group: 'vip2' },
    attempt: 1,
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(order, ['rememberBaseline', 'setGroup'], '★ 顺序不能反：写回后再记就成了「接管后的值」');
  assert.deepEqual(recorded, [{ from: 'vip3', to: 'vip2' }]);
});

test('set_group 在值不变时不记 baseline（没有接管发生）', async () => {
  let remembered = 0;
  const handler = createSetGroupHandler({
    externalIdOf: () => '42',
    getSubject: async () => ({ attributes: { group: 'basic' } }),
    setGroup: async () => {
      throw new Error('不应写回');
    },
    rememberBaseline: async () => {
      remembered += 1;
    },
  });
  const result = await handler.execute({
    siteId: SITE,
    userId: USER,
    policyId: POLICY_A,
    actionSeq: 1,
    idempotencyKey: 'k',
    params: { group: 'basic' },
    attempt: 1,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(remembered, 0);
});
