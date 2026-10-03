/**
 * 签到资格落库（`ag_checkin_entitlements`）—— 内存实现与**真实 PG** 实现的行为一致性。
 *
 * ★ 为什么必须有这一组：`checkin:grant` / `checkin:revoke` 此前写的是
 *   `tools/serve.ts` 里的**进程内 Map**。这类缺陷的形态是
 *   「**单进程、不重启的端到端测试永远发现不了**」——
 *   只有「重启后」或「换一个实例」才暴露。
 *
 * ★ 因此本文件的断言**全部围绕幂等与持久语义**，而不是「函数被调用了」：
 *   ① 重复 `grant` 不改变 `grantedAt`（同一幂等键执行 N 次 ≡ 1 次）；
 *   ② `revoke` 幂等，且不改变 `grantedAt`；
 *   ③ 撤销后重新 `grant` → 恢复有效，但仍保留**首次授予时间**；
 *   ④ `revoke` 对「从未授予」的资格是 no-op（不创建空行）；
 *   ⑤ 真实 PG 下站点隔离生效（另一站点的同主体同 scope 互不可见）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/pool.ts';
import { InMemoryCheckinEntitlementStore, isActive } from '../src/core/checkin.ts';
import {
  DbCheckinEntitlementStore,
  createTransactionalCheckinEntitlementStore,
} from '../src/db/checkin-adapter.ts';

const SITE_A = '11111111-1111-1111-1111-111111111111';
const SITE_B = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

test('内存实现：grant 幂等（不改首次授予时间）· revoke 幂等 · 重新授予保留首次时间', async () => {
  const store = new InMemoryCheckinEntitlementStore();

  // ① 首次授予
  const t1 = new Date('2026-01-01T00:00:00Z');
  await store.grant({ siteId: SITE_A, userId: USER, scope: 'daily', now: t1 });
  const first = await store.find(SITE_A, USER, 'daily');
  assert.ok(first !== undefined);
  assert.equal(first.grantedAt.toISOString(), t1.toISOString());
  assert.equal(isActive(first), true);

  // ② 重复授予（不同时刻）→ grantedAt 不变、revokedAt 仍为空
  await store.grant({ siteId: SITE_A, userId: USER, scope: 'daily', now: new Date('2026-06-01T00:00:00Z') });
  const again = await store.find(SITE_A, USER, 'daily');
  assert.equal(again!.grantedAt.toISOString(), t1.toISOString(), '重复授予不得刷新首次授予时间');
  assert.equal(again!.revokedAt, undefined);

  // ③ 撤销 → 不再有效；重复撤销幂等
  const t2 = new Date('2026-07-01T00:00:00Z');
  await store.revoke({ siteId: SITE_A, userId: USER, scope: 'daily', now: t2 });
  const revoked = await store.find(SITE_A, USER, 'daily');
  assert.equal(isActive(revoked!), false);
  assert.equal(revoked!.revokedAt!.toISOString(), t2.toISOString());
  await store.revoke({ siteId: SITE_A, userId: USER, scope: 'daily', now: new Date('2026-08-01T00:00:00Z') });
  assert.equal(
    (await store.find(SITE_A, USER, 'daily'))!.revokedAt!.toISOString(),
    t2.toISOString(),
    '重复撤销不得改写撤销时间',
  );
  assert.deepEqual(await store.listActive(SITE_A, USER), []);

  // ④ 撤销后重新授予 → 有效，且仍是首次授予时间
  await store.grant({ siteId: SITE_A, userId: USER, scope: 'daily', now: new Date('2026-09-01T00:00:00Z') });
  const regranted = await store.find(SITE_A, USER, 'daily');
  assert.equal(isActive(regranted!), true);
  assert.equal(regranted!.grantedAt.toISOString(), t1.toISOString());

  // ⑤ 撤销一个从未授予的资格 → no-op（不创建记录）
  await store.revoke({ siteId: SITE_A, userId: USER, scope: 'weekly' });
  assert.equal(await store.find(SITE_A, USER, 'weekly'), undefined);

  // ⑥ 站点隔离（内存实现也必须按站点分隔键）
  assert.equal(await store.find(SITE_B, USER, 'daily'), undefined);
});

test('真实 pglite：签到资格的幂等由数据库约束承担（ON CONFLICT 不刷新 granted_at）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });

  // 与 `src/schema/tables/execution.ts` 的声明一致的**最小** DDL（唯一键是幂等的承载物）
  await db.exec(`
    CREATE TABLE ag_checkin_entitlements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      site_id uuid NOT NULL,
      user_id uuid NOT NULL,
      scope varchar(32) NOT NULL DEFAULT 'daily',
      source_policy_id uuid NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz NULL,
      UNIQUE (site_id, user_id, scope)
    );
  `);

  const store = createTransactionalCheckinEntitlementStore(db, SITE_A);
  const POLICY = '44444444-4444-4444-4444-444444444444';

  // ① 首次授予
  const t1 = new Date('2026-01-01T00:00:00Z');
  await store.grant({ siteId: SITE_A, userId: USER, scope: 'daily', sourcePolicyId: POLICY, now: t1 });
  const first = await store.find(SITE_A, USER, 'daily');
  assert.ok(first !== undefined);
  assert.equal(first.grantedAt.toISOString(), t1.toISOString());
  assert.equal(first.sourcePolicyId, POLICY);
  assert.equal(isActive(first), true);

  // ② 并发/重复授予 → 唯一键收敛成一行，且**不刷新** granted_at
  await store.grant({ siteId: SITE_A, userId: USER, scope: 'daily', now: new Date('2026-06-01T00:00:00Z') });
  await store.grant({ siteId: SITE_A, userId: USER, scope: 'daily', now: new Date('2026-06-02T00:00:00Z') });
  const rows = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_checkin_entitlements'),
  );
  assert.equal(rows[0]!.n, '1', '重复授予必须收敛为一行（唯一键）');
  const again = await store.find(SITE_A, USER, 'daily');
  assert.equal(again!.grantedAt.toISOString(), t1.toISOString(), 'ON CONFLICT 不得写入 granted_at');

  // ③ 撤销 → 只影响未撤销的行；重复撤销零行受影响（不报错）
  const t2 = new Date('2026-07-01T00:00:00Z');
  await store.revoke({ siteId: SITE_A, userId: USER, scope: 'daily', now: t2 });
  await store.revoke({ siteId: SITE_A, userId: USER, scope: 'daily', now: new Date('2026-08-01T00:00:00Z') });
  const revoked = await store.find(SITE_A, USER, 'daily');
  assert.equal(isActive(revoked!), false);
  assert.equal(revoked!.revokedAt!.toISOString(), t2.toISOString());
  assert.deepEqual(await store.listActive(SITE_A, USER), []);

  // ④ 撤销后重新授予 → 恢复有效，且保留首次授予时间
  await store.grant({ siteId: SITE_A, userId: USER, scope: 'daily', now: new Date('2026-09-01T00:00:00Z') });
  const regranted = await store.find(SITE_A, USER, 'daily');
  assert.equal(isActive(regranted!), true);
  assert.equal(regranted!.grantedAt.toISOString(), t1.toISOString());

  // ⑤ 撤销「从未授予」→ no-op（UPDATE 的 WHERE revoked_at IS NULL 决定行为，
  //    但更根本的是：没有行可更新 → 不产生空行）
  await store.revoke({ siteId: SITE_A, userId: USER, scope: 'weekly' });
  assert.equal(await store.find(SITE_A, USER, 'weekly'), undefined);

  // ⑥ 站点隔离：换一个站点作用域的 store 查不到 A 站点的资格
  const storeB = createTransactionalCheckinEntitlementStore(db, SITE_B);
  assert.equal(await storeB.find(SITE_B, USER, 'daily'), undefined);
  assert.deepEqual(await storeB.listActive(SITE_B, USER), []);

  // ⑦ 换个站点写入同一 (userId, scope) → 是两行，互不覆盖
  await storeB.grant({ siteId: SITE_B, userId: USER, scope: 'daily' });
  const all = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_checkin_entitlements'),
  );
  assert.equal(all[0]!.n, '2', '站点维度必须进入唯一键');
});

test('真实 pglite：绕开事务包装直接查询会被运行时兜底拒绝（CI 白名单不是免罪符）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await db.exec(`
    CREATE TABLE ag_checkin_entitlements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      site_id uuid NOT NULL,
      user_id uuid NOT NULL,
      scope varchar(32) NOT NULL DEFAULT 'daily',
      source_policy_id uuid NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz NULL,
      UNIQUE (site_id, user_id, scope)
    );
  `);

  // ★ 为什么这条测试必须存在：静态门禁（`ci-gate` 第 8 项）把本适配器文件放进了
  //   「仓储层白名单」，**理由正是**「运行时由 `Db.query()` 的 `assertInTransaction` 兜底」。
  //   白名单是一条**声称**——本测试把它变成**可执行的事实**：
  //   绕开 `createTransactional…` 包装直接调用 → 必须抛错。
  const raw = new DbCheckinEntitlementStore(db, SITE_A);
  await assert.rejects(async () => raw.find(SITE_A, USER, 'daily'), /事务外执行/);
  await assert.rejects(
    async () => raw.grant({ siteId: SITE_A, userId: USER, scope: 'daily' }),
    /事务外执行/,
  );

  // 而经工厂包装后，同一组调用落在事务域内 → 成功
  const wrapped = createTransactionalCheckinEntitlementStore(db, SITE_A);
  await wrapped.grant({ siteId: SITE_A, userId: USER, scope: 'daily' });
  const found = await wrapped.find(SITE_A, USER, 'daily');
  assert.ok(found !== undefined);
  assert.equal(isActive(found), true);
});
