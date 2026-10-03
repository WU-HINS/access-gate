/**
 * ★★ **灰度一键熔断**（`docs/07 M6-3` / `docs/05 §6.3.1`）。
 *
 * 本文件钉住四件事：
 *  ① **熔断状态可持久**（内存与 PG 两个实现语义一致，含**日期往返**）；
 *  ② ★★ **熔断在决策路径真正生效**：已熔断的策略对**所有**用户都不适用
 *     —— 包括 100% 全量的分配（"止血不能被任何名单或比例阻挡"）；
 *  ③ ★★ **按站点分组的受影响清单**（`docs/05 §6.3.1` 明文要求）；
 *  ④ ★ **端点真的能被按到**（此前 `abortRollout` 一个调用方都没有 —— 函数再对，按不到按钮也止不了血）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryRolloutAbortStore,
  groupAbortsBySite,
  type RolloutAbortStore,
} from '../src/core/rollout-abort.ts';
import { DbRolloutAbortStore } from '../src/db/rollout-abort-adapter.ts';
import { InMemoryPlatformSettingsStore } from '../src/app/platform-mode.ts';
import { decidePolicyAssignment, type PolicyAssignment } from '../src/core/policy-assignments.ts';
import { createAdminHandler, type AuditEntry } from '../src/admin/api.ts';

const T0 = new Date('2026-09-28T10:00:00Z');
const SITE_A = 'site-a';
const SITE_B = 'site-b';

const assignmentOf = (over: Partial<PolicyAssignment> = {}): PolicyAssignment => ({
  id: 'as-1',
  policyId: 'policy-1',
  targetType: 'all',
  rolloutPercent: 100,
  enabled: true,
  createdAt: T0,
  ...over,
});

// ─────────────────────── ① 存储语义 ───────────────────────

async function storeContract(name: string, make: () => Promise<RolloutAbortStore> | RolloutAbortStore) {
  test(`★★ ${name}：熔断**幂等**且保留首次（时间与原因不被覆盖）`, async () => {
    const store = await make();
    const first = await store.abort({
      siteId: SITE_A,
      policyId: 'p-1',
      policyCode: 'p1',
      fromVersion: 3,
      by: 'alice',
      reason: '错误率上升',
      at: T0,
    });
    const second = await store.abort({
      siteId: SITE_A,
      policyId: 'p-1',
      policyCode: 'p1',
      fromVersion: 3,
      by: 'bob',
      reason: '又点了一次',
      at: new Date('2026-09-28T12:00:00Z'),
    });

    assert.equal(second.abortedBy, 'alice', '★ 保留**首次**熔断者');
    assert.equal(second.reason, '错误率上升');
    assert.equal(second.abortedAt.getTime(), first.abortedAt.getTime());
    // ★ 日期往返：读回来必须还是 Date（不是字符串）
    assert.ok((await store.list())[0]!.abortedAt instanceof Date, '★ `abortedAt` 必须是 Date');
  });

  test(`★★ ${name}：abortedPolicyIds **按站点隔离**`, async () => {
    const store = await make();
    await store.abort({ siteId: SITE_A, policyId: 'p-a', policyCode: 'pa', fromVersion: 1, by: 'x', reason: 'r', at: T0 });
    await store.abort({ siteId: SITE_B, policyId: 'p-b', policyCode: 'pb', fromVersion: 1, by: 'x', reason: 'r', at: T0 });

    assert.deepEqual(await store.abortedPolicyIds(SITE_A), ['p-a']);
    assert.deepEqual(await store.abortedPolicyIds(SITE_B), ['p-b']);
    assert.deepEqual(await store.abortedPolicyIds('site-c'), [], '★ 没有熔断的站点返回空');
  });

  test(`★ ${name}：恢复清除熔断；重复恢复返回 false`, async () => {
    const store = await make();
    await store.abort({ siteId: SITE_A, policyId: 'p-1', policyCode: 'p1', fromVersion: 1, by: 'x', reason: 'r', at: T0 });
    assert.equal(await store.resume(SITE_A, 'p-1'), true);
    assert.equal(await store.resume(SITE_A, 'p-1'), false, '★ 不存在时不谎称成功');
    assert.deepEqual(await store.abortedPolicyIds(SITE_A), []);
  });
}

await storeContract('内存实现', () => new InMemoryRolloutAbortStore());
await storeContract('PG 适配器（平台设置）', () => new DbRolloutAbortStore(new InMemoryPlatformSettingsStore()));

test('★ PG 适配器会**丢弃结构不符**的记录（而不是让整个列表读不出来）', async () => {
  const settings = new InMemoryPlatformSettingsStore();
  await settings.put('policy_rollout_aborts', [{ bogus: true }, { siteId: 's', policyId: 'p', abortedAt: '不是日期' }], null, T0);
  const store = new DbRolloutAbortStore(settings);
  assert.deepEqual(await store.list(), [], '★ 坏数据被丢弃，不抛错也不污染');
});

// ─────────────────────── ② 决策路径真正生效 ───────────────────────

test('★★★ 熔断后**即使 100% 全量**也不适用（止血不能被比例阻挡）', () => {
  const decision = decidePolicyAssignment([assignmentOf({ rolloutPercent: 100 })], {
    userId: 'u1',
    abortedPolicyIds: ['policy-1'],
  });
  assert.equal(decision.applies, false);
  assert.equal(decision.reason, 'rollout_aborted');
});

test('★★ 未熔断时 100% 全量照常适用（对照组）', () => {
  const decision = decidePolicyAssignment([assignmentOf({ rolloutPercent: 100 })], { userId: 'u1' });
  assert.equal(decision.applies, true);
});

test('★★★ **部分熔断**不影响其它分配（OR 语义保留）', () => {
  const assignments = [
    assignmentOf({ id: 'as-aborted', policyId: 'policy-aborted', targetType: 'all' }),
    assignmentOf({ id: 'as-live', policyId: 'policy-live', targetType: 'user', targetRef: 'u1' }),
  ];
  const decision = decidePolicyAssignment(assignments, { userId: 'u1', abortedPolicyIds: ['policy-aborted'] });
  assert.equal(decision.applies, true, '★ 还有一条没熔断的命中 → 仍然适用');
  assert.equal(decision.applies === true && decision.assignment.policyId, 'policy-live');
});

test('★★ **全部**被熔断时才报 `rollout_aborted`（与"被比例排除"分开，排障方向不同）', () => {
  const assignments = [
    assignmentOf({ id: 'a1', policyId: 'p-1' }),
    assignmentOf({ id: 'a2', policyId: 'p-2' }),
  ];
  const allAborted = decidePolicyAssignment(assignments, { userId: 'u1', abortedPolicyIds: ['p-1', 'p-2'] });
  assert.equal(allAborted.applies, false);
  assert.equal(allAborted.reason, 'rollout_aborted');

  // 只有一条熔断、另一条被比例排除 → 报"被灰度排除"（说明不是熔断的锅）
  const mixed = decidePolicyAssignment(
    [assignmentOf({ id: 'a1', policyId: 'p-1', targetType: 'all' }), assignmentOf({ id: 'a2', policyId: 'p-2', rolloutPercent: 0 })],
    { userId: 'u1', abortedPolicyIds: ['p-1'] },
  );
  assert.equal(mixed.applies, false);
  assert.equal(mixed.applies === false ? mixed.reason : undefined, 'rollout_excluded');
});

// ─────────────────────── ③ 按站点分组的受影响清单 ───────────────────────

test('★★★ `groupAbortsBySite` 给出按站点分组的清单（`docs/05 §6.3.1`）', async () => {
  const store = new InMemoryRolloutAbortStore();
  await store.abort({ siteId: SITE_B, policyId: 'p-b', policyCode: 'pb', fromVersion: 2, by: 'ops', reason: '错误率', at: T0 });
  await store.abort({ siteId: SITE_A, policyId: 'p-a1', policyCode: 'pa1', fromVersion: 1, by: 'ops', reason: '错误率', at: T0 });
  await store.abort({ siteId: SITE_A, policyId: 'p-a2', policyCode: 'pa2', fromVersion: 5, by: 'ops', reason: '超时', at: T0 });

  const groups = groupAbortsBySite(await store.list());
  assert.deepEqual(groups.map((g) => g.siteId), [SITE_A, SITE_B], '★ 按站点分组且稳定排序');
  assert.equal(groups[0]!.policies.length, 2);
  assert.deepEqual(groups[0]!.policies.map((p) => p.policyCode), ['pa1', 'pa2'], '★ 组内按 code 排序');
  assert.equal(groups[0]!.policies[0]!.fromVersion, 1, '★ 要能回答"回到了哪一版"');
});

// ─────────────────────── ④ 端点真能被按到 ───────────────────────

function makeAdmin(rolloutAborts: RolloutAbortStore | undefined, recorded: AuditEntry[]) {
  return createAdminHandler({
    admin: async () => ({ status: 404, body: {} }),
    csrfSecret: 'test',
    audit: {
      async record(entry: AuditEntry) {
        recorded.push(entry);
      },
      async list() {
        return [];
      },
    },
    ...(rolloutAborts === undefined ? {} : { rolloutAborts }),
  } as never);
}

const SESSION = {
  userId: 'admin-1',
  username: 'admin',
  activeSiteId: SITE_A,
  activeDeveloperId: null,
  realm: 'developer' as const,
  role: 'admin' as const,
};

async function call(
  handler: (request: never) => Promise<{ status?: number; body?: unknown }>,
  request: Record<string, unknown>,
): Promise<{ status?: number; body: Record<string, unknown> }> {
  const response = await handler({ session: SESSION, siteId: SITE_A, query: {}, ...request } as never);
  return { ...(response.status === undefined ? {} : { status: response.status }), body: (response.body ?? {}) as Record<string, unknown> };
}

test('★★★ 一键熔断端点可被按到：熔断 → 查询 → 恢复，且**写审计**', async () => {
  const recorded: AuditEntry[] = [];
  const store = new InMemoryRolloutAbortStore();
  const handler = makeAdmin(store, recorded);

  // ① 熔断
  const aborted = await call(handler, {
    method: 'POST',
    path: '/api/admin/rollouts/abort',
    body: { policyId: 'policy-1', policyCode: 'p1', fromVersion: 3, reason: '错误率超阈值' },
  });
  assert.equal(aborted.status, 200, '成功返回 200');
  assert.equal((aborted.body['aborted'] as Record<string, unknown>)['abortedBy'], 'admin-1');
  assert.equal(recorded.length, 1, '★ 熔断是运维动作，必须留审计');
  assert.equal(recorded[0]!.action, 'rollout.abort');
  assert.equal(recorded[0]!.targetId, 'policy-1');

  // ② 查询（带按站点分组的受影响清单）
  const listed = await call(handler, { method: 'GET', path: '/api/admin/rollouts' });
  const affected = listed.body['affected'] as { siteId: string; policies: unknown[] }[];
  assert.equal(affected.length, 1);
  assert.equal(affected[0]!.siteId, SITE_A);
  assert.equal(affected[0]!.policies.length, 1);

  // ③ 恢复（也写审计）
  const resumed = await call(handler, { method: 'POST', path: '/api/admin/rollouts/resume', body: { policyId: 'policy-1' } });
  assert.equal(resumed.body['resumed'], true);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[1]!.action, 'rollout.resume');
});

test('★ 熔断必须写**原因**（复盘要回答"为什么回滚"）', async () => {
  const handler = makeAdmin(new InMemoryRolloutAbortStore(), []);
  const response = await call(handler, {
    method: 'POST',
    path: '/api/admin/rollouts/abort',
    body: { policyId: 'policy-1' },
  });
  assert.equal(response.status, 400);
  assert.match(String(response.body['error']), /reason/);
});

test('★ 未装配熔断存储 → **501**（而不是假装成功）', async () => {
  const handler = makeAdmin(undefined, []);
  const response = await call(handler, { method: 'GET', path: '/api/admin/rollouts' });
  assert.equal(response.status, 501, '★ 不支持就说"不支持"，不能静默返回空列表');
});
