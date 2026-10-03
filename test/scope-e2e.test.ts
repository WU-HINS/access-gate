/**
 * 端到端：真实 pglite 上验证「作用域注入真的生效」与「无作用域真的查不到」。
 *
 * ★ 为什么必须有这一组：前两组测试证明的是「函数返回了正确的 SQL 片段」，
 *   而这里证明的是「把片段送进真实 PG 后，隔离真的成立」——即
 *   ① 同一张表里两个站点的数据互不可见；
 *   ② 不注入作用域的查询（走 assertInTransaction 的 fail-closed 路径）根本执行不了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/pool.ts';
import { createScope, injectSiteFilter, injectSiteValue, resolveScope, ScopeMissingError } from '../src/db/scope.ts';
import { assertInTransaction } from '../src/db/tx.ts';

test('真实 pglite：站点隔离由注入保证，且无作用域时 fail-closed', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });

  // 建一张最小站点作用域表（形状与 02 的站点表一致：site_id + 业务键）
  await db.exec(`
    CREATE TABLE ag_demo_policies (
      id uuid PRIMARY KEY,
      site_id uuid NOT NULL,
      code varchar(64) NOT NULL,
      UNIQUE (site_id, code)
    );
  `);

  const siteA = createScope({ kind: 'site', siteId: '11111111-1111-1111-1111-111111111111' });
  const siteB = createScope({ kind: 'site', siteId: '22222222-2222-2222-2222-222222222222' });

  // 写入：site_id 只能来自作用域
  await db.transaction(async () => {
    await db.query('INSERT INTO ag_demo_policies (id, site_id, code) VALUES ($1, $2, $3)', [
      'aaaaaaaa-0000-0000-0000-000000000001',
      injectSiteValue(siteA, 'ag_demo_policies'),
      'edu',
    ]);
    await db.query('INSERT INTO ag_demo_policies (id, site_id, code) VALUES ($1, $2, $3)', [
      'bbbbbbbb-0000-0000-0000-000000000001',
      injectSiteValue(siteB, 'ag_demo_policies'),
      'gmail',
    ]);
  });

  // 读取：注入 site_id 后只能看到本站点数据
  const readFor = async (scope: ReturnType<typeof createScope>) => {
    const filter = injectSiteFilter(scope, 'ag_demo_policies');
    return db.transaction(async () =>
      db.query<{ code: string }>(`SELECT code FROM ag_demo_policies WHERE ${filter.sql}`, filter.params),
    );
  };

  assert.deepEqual(await readFor(siteA), [{ code: 'edu' }]);
  assert.deepEqual(await readFor(siteB), [{ code: 'gmail' }]);

  // 无作用域：resolveScope 直接抛错（拿不到 siteId 时不允许「不过滤」）
  assert.throws(
    () => resolveScope({ siteScoped: true, session: { activeSiteId: null }, tableName: 'ag_demo_policies' }),
    ScopeMissingError,
  );

  // 事务外查询：运行期被拒（这是「单一事务入口」的强制点）
  await assert.rejects(
    async () => db.query('SELECT code FROM ag_demo_policies'),
    /事务外执行/,
  );
  assert.throws(() => assertInTransaction('query'), /事务外执行/);

  // 事务内计数：证明 record 真的被调用（注入点确实经过数据访问层）
  const count = await db.transaction(async (tx) => {
    await db.query('SELECT 1');
    await db.query('SELECT 2');
    return tx.statementCount();
  });
  assert.equal(count, 2);
});

test('真实 pglite：部分唯一索引（where deleted_at IS NULL）与软删除语义成立', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });

  // 与 02 §1「软删除 + 部分唯一索引」一致
  await db.exec(`
    CREATE TABLE ag_demo_users (
      id uuid PRIMARY KEY,
      email varchar(255) NOT NULL,
      deleted_at timestamptz NULL
    );
    CREATE UNIQUE INDEX uq_ag_demo_users_email ON ag_demo_users (email) WHERE deleted_at IS NULL;
  `);

  const id = 'cccccccc-0000-0000-0000-000000000001';
  await db.transaction(async () => {
    await db.query('INSERT INTO ag_demo_users (id, email) VALUES ($1, $2)', [id, 'a@b.c']);
  });

  // 有效行重复 → 被部分唯一索引拦住
  await assert.rejects(async () =>
    db.transaction(async () => {
      await db.query('INSERT INTO ag_demo_users (id, email) VALUES ($1, $2)', [
        'cccccccc-0000-0000-0000-000000000002',
        'a@b.c',
      ]);
    }),
  );

  // 软删除后同名可再插入 → 证明 where 谓词真的生效（不是全表唯一）
  await db.transaction(async () => {
    await db.query('UPDATE ag_demo_users SET deleted_at = now() WHERE id = $1', [id]);
    await db.query('INSERT INTO ag_demo_users (id, email) VALUES ($1, $2)', [
      'cccccccc-0000-0000-0000-000000000003',
      'a@b.c',
    ]);
  });

  const rows = await db.transaction(async () => db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_demo_users'));
  assert.equal(rows[0]!.n, '2');
});
