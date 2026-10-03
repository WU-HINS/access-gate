/**
 * 插件绑定的 PG 存储（`docs/04 §1.2.7.2`）。
 *
 * ★ 本文件要证明的四件事：
 *   ① 落绑定后 `find` 能命中（跨系统寻址 `subject:<provider>.<attr>` 的前提）；
 *   ② **软撤销**：`revoke` 后 `find` **仍返回记录**（带 `revoked`），由调用方判 `missing(revoked)`——
 *      而不是"查不到"，那样会丢掉"曾经绑过、后来解绑"这一事实；
 *   ③ **状态映射**：表里的 `stale` / `failed` 归 `pending` 而**不是** `active`——
 *      它们都**不能用来解析主体**；
 *   ④ 站点隔离。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/pool.ts';
import {
  DbPluginBindingStore,
  toBindingStatus,
  toStoredStatus,
} from '../src/db/plugin-binding-adapter.ts';

const SITE = '11111111-1111-1111-1111-111111111111';
const OTHER_SITE = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

async function createTable(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
  await db.exec(`
    CREATE TABLE ag_plugin_bindings (
      site_id uuid NOT NULL,
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      plugin_id varchar(64) NOT NULL,
      instance_key varchar(64) NOT NULL DEFAULT 'default',
      external_id varchar(255) NULL,
      external_name varchar(255) NULL,
      status varchar(16) NOT NULL DEFAULT 'unbound',
      credential_ref varchar(96) NULL,
      last_fact_at timestamptz NULL,
      last_error text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (site_id, user_id, plugin_id, instance_key)
    );
  `);
}

test('★ upsert → find 命中（跨系统寻址的前提）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginBindingStore(db, SITE);
  await store.upsert({ userId: USER, pluginId: 'newapi-provider', instanceKey: 'default', externalId: '1024' });

  const found = await store.find(USER, 'newapi-provider', 'default');
  assert.ok(found !== undefined);
  assert.equal(found.externalId, '1024');
  assert.equal(found.status, 'active');
});

test('★ 软撤销：revoke 后 find **仍返回记录**（带 revoked），而不是查不到', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginBindingStore(db, SITE);
  await store.upsert({ userId: USER, pluginId: 'newapi-provider', instanceKey: 'default', externalId: '1024' });
  await store.revoke({ userId: USER, pluginId: 'newapi-provider', instanceKey: 'default' });

  const found = await store.find(USER, 'newapi-provider', 'default');
  assert.ok(found !== undefined, '★ 必须仍能查到——否则会丢掉「曾经绑过、后来解绑」这一事实');
  assert.equal(found.status, 'revoked');
  assert.equal(found.externalId, '1024', '撤销不抹掉 externalId（审计线索）');

  // 幂等：重复撤销零行受影响、不报错
  await store.revoke({ userId: USER, pluginId: 'newapi-provider', instanceKey: 'default' });
  assert.equal((await store.find(USER, 'newapi-provider', 'default'))?.status, 'revoked');
});

test('★ 重新绑定：revoked → upsert → active', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginBindingStore(db, SITE);
  await store.upsert({ userId: USER, pluginId: 'github', instanceKey: 'default', externalId: 'gh-1' });
  await store.revoke({ userId: USER, pluginId: 'github', instanceKey: 'default' });
  await store.upsert({ userId: USER, pluginId: 'github', instanceKey: 'default', externalId: 'gh-2' });

  const found = await store.find(USER, 'github', 'default');
  assert.equal(found?.status, 'active');
  assert.equal(found?.externalId, 'gh-2');
  // 幂等：同键只有一行
  const count = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_plugin_bindings'),
  );
  assert.equal(count[0]!.n, '1');
});

test('★ 状态映射：表里的 `stale` / `failed` → 接口的 `pending`（**不是** active）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginBindingStore(db, SITE);
  await store.upsert({ userId: USER, pluginId: 'github', instanceKey: 'default', externalId: 'gh-1' });

  for (const stored of ['stale', 'failed', 'unbound']) {
    await db.transaction(async () => {
      await db.query('UPDATE ag_plugin_bindings SET status = $1 WHERE user_id = $2', [stored, USER]);
    });
    const found = await store.find(USER, 'github', 'default');
    assert.equal(
      found?.status,
      'pending',
      `★ 表里的 '${stored}' 不能被当成 active——它不能用来解析主体`,
    );
  }

  // 映射函数本身（双向）
  assert.equal(toBindingStatus('bound'), 'active');
  assert.equal(toBindingStatus('revoked'), 'revoked');
  assert.equal(toBindingStatus('stale'), 'pending');
  assert.equal(toBindingStatus('failed'), 'pending');
  assert.equal(toBindingStatus('unbound'), 'pending');
  assert.equal(toStoredStatus('active'), 'bound');
  assert.equal(toStoredStatus('revoked'), 'revoked');
  assert.equal(toStoredStatus('pending'), 'unbound');
});

test('★ 站点隔离：另一个站点查不到本站点的绑定', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const siteA = new DbPluginBindingStore(db, SITE);
  const siteB = new DbPluginBindingStore(db, OTHER_SITE);
  await siteA.upsert({ userId: USER, pluginId: 'github', instanceKey: 'default', externalId: 'gh-a' });

  assert.equal(await siteB.find(USER, 'github', 'default'), undefined, '★ 站点 B 不得看到站点 A 的绑定');
  assert.deepEqual(await siteB.listByUser(USER), []);
});

test('listByUser：返回该用户在本站点的全部绑定（含已撤销）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginBindingStore(db, SITE);
  await store.upsert({ userId: USER, pluginId: 'github', instanceKey: 'default', externalId: 'gh-1' });
  await store.upsert({ userId: USER, pluginId: 'qq', instanceKey: 'default', externalId: 'qq-1' });
  await store.revoke({ userId: USER, pluginId: 'qq', instanceKey: 'default' });

  const all = await store.listByUser(USER);
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((b) => `${b.pluginId}:${b.status}`).sort(),
    ['github:active', 'qq:revoked'],
  );
});

test('★ 运行时兜底：事务外直接查询会被拒（CI 第 8 项白名单的依据）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  await assert.rejects(
    async () => db.query('SELECT plugin_id FROM ag_plugin_bindings'),
    /事务外执行/,
  );

  const store = new DbPluginBindingStore(db, SITE);
  await store.upsert({ userId: USER, pluginId: 'github', instanceKey: 'default', externalId: 'gh-1' });
  assert.equal((await store.listByUser(USER)).length, 1);
});
