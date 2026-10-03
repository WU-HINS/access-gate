/**
 * ★ P0-3：策略分配与灰度（`ag_policy_assignments`）—— 此前**零读写**。
 *
 * ★ 本文件的核心断言是**灰度的确定性**：
 *   随机分桶会让同一用户的资格**反复抖动**（授予 → 收回 → 授予），
 *   而那正是 H1 要防的形态。这里用「同输入多次同结果」与「跨策略分桶独立」两条来钉死它。
 * ★ 另一条是**分布**：确定性不等于"都落在同一侧"——1000 个用户在 30% 下应接近 300。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  decidePolicyAssignment,
  inRollout,
  InMemoryPolicyAssignmentStore,
  type PolicyAssignment,
} from '../src/core/policy-assignments.ts';
import { createDb } from '../src/db/pool.ts';
import { DbPolicyAssignmentStore } from '../src/db/policy-assignment-adapter.ts';

const T0 = new Date('2026-09-26T00:00:00Z');

const assignmentOf = (over: Partial<PolicyAssignment> = {}): PolicyAssignment => ({
  id: randomUUID(),
  policyId: 'policy-1',
  targetType: 'all',
  rolloutPercent: 100,
  enabled: true,
  createdAt: T0,
  ...over,
});

// ─────────────────────────── 灰度 ───────────────────────────

test('灰度边界：0% 永不入选、100% 全部入选', () => {
  assert.equal(inRollout({ policyId: 'p', userId: 'u', rolloutPercent: 0 }), false);
  assert.equal(inRollout({ policyId: 'p', userId: 'u', rolloutPercent: 100 }), true);
  assert.equal(inRollout({ policyId: 'p', userId: 'u', rolloutPercent: 150 }), true, '超过 100 视为全量');
});

test('★★ 确定性：同一 (policyId, userId) 多次求值**结果相同**', () => {
  const first = inRollout({ policyId: 'p1', userId: 'user-42', rolloutPercent: 50 });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(
      inRollout({ policyId: 'p1', userId: 'user-42', rolloutPercent: 50 }),
      first,
      '★ 不确定的分桶 = 资格抖动',
    );
  }
});

test('★★ 跨策略分桶**独立**：同一用户在不同策略下不必然同侧', () => {
  // 统计同一批用户在两个不同 policyId 下的入选模式
  const same = Array.from({ length: 200 }, (_, i) => `user-${i}`).filter(
    (userId) =>
      inRollout({ policyId: 'policy-A', userId, rolloutPercent: 50 }) ===
      inRollout({ policyId: 'policy-B', userId, rolloutPercent: 50 }),
  ).length;
  // 若两个策略共用同一分桶，则 200/200 全部相同（完全相关）
  assert.ok(
    same < 180,
    `★ 两个策略的分桶不该完全相关（实际同侧 ${same}/200）——否则多个灰度实验会互相污染`,
  );
});

test('★ 分布合理：1000 个用户在 30% 下接近 300（确定性 ≠ 都落同一侧）', () => {
  let included = 0;
  for (let i = 0; i < 1000; i += 1) {
    if (inRollout({ policyId: 'p', userId: `u-${i}`, rolloutPercent: 30 })) included += 1;
  }
  assert.ok(included > 240 && included < 360, `实际 ${included}/1000，偏离 30% 过多`);
});

test('★ 分布对**递增 id** 也成立（弱哈希会退化成顺序分配）', () => {
  let included = 0;
  for (let i = 0; i < 500; i += 1) {
    if (inRollout({ policyId: 'p', userId: String(1_000_000 + i), rolloutPercent: 50 })) included += 1;
  }
  assert.ok(included > 200 && included < 300, `实际 ${included}/500`);
});

// ─────────────────────────── 适用性判定 ───────────────────────────

test('targetType 四种：all / user / tag / cohort 各自命中', () => {
  const context = { userId: 'u1', tags: ['vip'], cohorts: ['beta'] };
  assert.equal(decidePolicyAssignment([assignmentOf({ targetType: 'all' })], context).applies, true);
  assert.equal(
    decidePolicyAssignment([assignmentOf({ targetType: 'user', targetRef: 'u1' })], context).applies,
    true,
  );
  assert.equal(
    decidePolicyAssignment([assignmentOf({ targetType: 'tag', targetRef: 'vip' })], context).applies,
    true,
  );
  assert.equal(
    decidePolicyAssignment([assignmentOf({ targetType: 'cohort', targetRef: 'beta' })], context).applies,
    true,
  );
});

test('无分配 → `no_assignment`；不命中 → `not_targeted`', () => {
  const context = { userId: 'u1', tags: ['vip'] };
  assert.deepEqual(decidePolicyAssignment([], context), { applies: false, reason: 'no_assignment' });
  const other = decidePolicyAssignment(
    [assignmentOf({ targetType: 'user', targetRef: 'someone-else' })],
    context,
  );
  assert.deepEqual(other, { applies: false, reason: 'not_targeted' });
});

test('disabled 的分配被忽略', () => {
  const disabled = assignmentOf({ enabled: false });
  assert.deepEqual(decidePolicyAssignment([disabled], { userId: 'u1' }), {
    applies: false,
    reason: 'no_assignment',
  });
});

test('★ 灰度排除 → `rollout_excluded`（且**与 not_targeted 区分**）', () => {
  // 找一个在 1% 灰度下被排除的用户
  const excludedUser = Array.from({ length: 1000 }, (_, i) => `u-${i}`).find(
    (userId) => !inRollout({ policyId: 'policy-1', userId, rolloutPercent: 1 }),
  )!;
  const decision = decidePolicyAssignment(
    [assignmentOf({ targetType: 'all', rolloutPercent: 1 })],
    { userId: excludedUser },
  );
  assert.deepEqual(decision, { applies: false, reason: 'rollout_excluded' });
});

test('★ 多条分配 OR 语义：`all`（全量）命中即适用，即使另一条被灰度排除', () => {
  const context = { userId: 'u1' };
  const decision = decidePolicyAssignment(
    [
      assignmentOf({ targetType: 'tag', targetRef: 'vip', rolloutPercent: 0 }),
      assignmentOf({ targetType: 'all', rolloutPercent: 100 }),
    ],
    context,
  );
  assert.equal(decision.applies, true);
  assert.equal(decision.applies === true ? decision.via : '', 'all');
  assert.equal(decision.applies === true ? decision.rollout : '', 'not_applicable');
});

test('★ `rollout` 字段区分"全量"与"抽样"（便于排障：为什么这个人进来了）', () => {
  const included = decidePolicyAssignment([assignmentOf({ rolloutPercent: 50 })], {
    userId: Array.from({ length: 100 }, (_, i) => `u-${i}`).find((userId) =>
      inRollout({ policyId: 'policy-1', userId, rolloutPercent: 50 }),
    )!,
  });
  assert.equal(included.applies === true ? included.rollout : '', 'included');
});

// ─────────────────────────── 存储 ───────────────────────────

const SITE = '11111111-1111-1111-1111-111111111111';
const OTHER_SITE = '22222222-2222-2222-2222-222222222222';

async function createTable(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
  await db.exec(`
    CREATE TABLE ag_policy_assignments (
      id uuid PRIMARY KEY,
      site_id uuid NOT NULL,
      policy_id uuid NOT NULL,
      target_type varchar(16) NOT NULL,
      target_ref varchar(128) NULL,
      rollout_percent integer NOT NULL DEFAULT 100,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

test('内存 store：put / list（可按 policyId 过滤）/ remove', async () => {
  const store = new InMemoryPolicyAssignmentStore();
  await store.put(assignmentOf({ id: 'a1', policyId: 'p1' }));
  await store.put(assignmentOf({ id: 'a2', policyId: 'p2' }));
  assert.equal((await store.list()).length, 2);
  assert.deepEqual((await store.list('p1')).map((row) => row.id), ['a1']);
  await store.remove('a1');
  assert.equal((await store.list()).length, 1);
});

test('★ PG store：put → list（可按 policyId 过滤，`createdAt` 为 Date）→ remove', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPolicyAssignmentStore(db, SITE);
  const policyId = randomUUID();
  await store.put(assignmentOf({ id: randomUUID(), policyId, targetType: 'cohort', targetRef: 'beta', rolloutPercent: 10 }));

  const rows = await store.list(policyId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.targetType, 'cohort');
  assert.equal(rows[0]!.targetRef, 'beta');
  assert.equal(rows[0]!.rolloutPercent, 10);
  assert.equal(rows[0]!.createdAt instanceof Date, true);
  assert.deepEqual(await store.list(randomUUID()), [], '按 policyId 过滤应生效');

  await store.remove(rows[0]!.id);
  assert.deepEqual(await store.list(policyId), []);
});

test('★ PG store：站点隔离（另一站点看不到、也删不掉）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const siteA = new DbPolicyAssignmentStore(db, SITE);
  const siteB = new DbPolicyAssignmentStore(db, OTHER_SITE);
  // ★ `policy_id` 是 uuid 列（用 `'policy-1'` 会被 PG 拒绝：22P02）
  const assignment = assignmentOf({ id: randomUUID(), policyId: randomUUID() });
  await siteA.put(assignment);

  assert.deepEqual(await siteB.list(), []);
  await siteB.remove(assignment.id);
  assert.equal((await siteA.list()).length, 1, '★ 跨站点 remove 不该生效');
});
