/**
 * 站点作用域注入 + fail-closed 抛错 + 单一事务入口的运行期验收。
 *
 * ★ 这些用例的存在理由：M0 的核心主张是「拿不到站点作用域时必须失败，绝不退化成不过滤」。
 *   因此每个 fail-closed 断言都必须证明「**抛出**」而不是「返回空/全量」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createScope,
  injectOwnerFilter,
  injectSiteFilter,
  injectSiteValue,
  mustScope,
  resolveScope,
  ScopeInvalidError,
  ScopeMissingError,
} from '../src/db/scope.ts';
import {
  assertInTransaction,
  currentTx,
  inTransaction,
  withTransaction,
  TransactionRequiredError,
  TransactionStateError,
} from '../src/db/tx.ts';

// ─────────────────────────── 1. 解析：fail-closed ───────────────────────────

test('resolveScope：站点表但会话没有 activeSiteId → 抛 ScopeMissingError（fail-closed）', () => {
  for (const session of [null, undefined, { activeSiteId: null }, { activeSiteId: '' }]) {
    assert.throws(
      () => resolveScope({ siteScoped: true, session, tableName: 'ag_policies' }),
      (error: unknown) => {
        assert.ok(error instanceof ScopeMissingError, `期望 ScopeMissingError，实际 ${String(error)}`);
        assert.equal(error.tableName, 'ag_policies');
        assert.match(error.message, /fail-closed/);
        return true;
      },
    );
  }
});

test('resolveScope：站点表且会话有 activeSiteId → 生成 site 作用域，并带上 developerId/actorId', () => {
  const scope = resolveScope({
    siteScoped: true,
    session: { activeSiteId: 'site-1', activeDeveloperId: 'dev-1', actorId: 'user-1' },
    tableName: 'ag_policies',
  });
  assert.equal(scope.context.kind, 'site');
  assert.deepEqual(scope.context, { kind: 'site', siteId: 'site-1', developerId: 'dev-1', actorId: 'user-1' });
});

test('resolveScope：非站点表允许降级为 developer / platform，但站点表不允许', () => {
  // 非站点表：有 developerId → developer 作用域
  const dev = resolveScope({
    siteScoped: false,
    session: { activeSiteId: null, activeDeveloperId: 'dev-1' },
    tableName: 'ag_developers',
  });
  assert.equal(dev.context.kind, 'developer');

  // 非站点表：什么都没有 → platform（平台级表可读）
  const plat = resolveScope({ siteScoped: false, session: null, tableName: 'ag_platform_settings' });
  assert.equal(plat.context.kind, 'platform');

  // ★ 对照：同一份「空会话」用于站点表就必须抛错——证明降级只对非站点表成立
  assert.throws(
    () => resolveScope({ siteScoped: true, session: null, tableName: 'ag_platform_settings' }),
    ScopeMissingError,
  );
});

test('createScope：非法作用域在建立时就抛 ScopeInvalidError（不产生半成品作用域）', () => {
  assert.throws(() => createScope({ kind: 'site', siteId: '' }), ScopeInvalidError);
  assert.throws(() => createScope({ kind: 'developer', developerId: '' }), ScopeInvalidError);
  assert.throws(() => createScope({ kind: 'user', ownerId: '' }), ScopeInvalidError);
});

test('mustScope：传 null/undefined 或非 site 作用域 → 抛 ScopeMissingError', () => {
  assert.throws(() => mustScope(null, 'ag_actions_log'), ScopeMissingError);
  assert.throws(() => mustScope(undefined, 'ag_actions_log'), ScopeMissingError);
  assert.throws(
    () => mustScope(createScope({ kind: 'platform' }), 'ag_actions_log'),
    (error: unknown) => {
      assert.ok(error instanceof ScopeMissingError);
      assert.match(error.message, /要求 site 作用域/);
      return true;
    },
  );
});

// ─────────────────────────── 2. 注入 ───────────────────────────

test('injectSiteFilter：产出参数化条件，值来自作用域而非入参', () => {
  const scope = createScope({ kind: 'site', siteId: 'site-42' });
  const filter = injectSiteFilter(scope, 'ag_policies');
  assert.equal(filter.sql, 'site_id = $1');
  assert.deepEqual(filter.params, ['site-42']);

  const shifted = injectSiteFilter(scope, 'ag_policies', 3);
  assert.equal(shifted.sql, 'site_id = $3');
  assert.deepEqual(shifted.params, ['site-42']);
});

test('injectSiteValue：写入值只能来自作用域（客户端无法伪造 site_id）', () => {
  const scope = createScope({ kind: 'site', siteId: 'site-7' });
  assert.equal(injectSiteValue(scope, 'ag_audit_log'), 'site-7');
  assert.throws(() => injectSiteValue(createScope({ kind: 'platform' }), 'ag_audit_log'), ScopeMissingError);
});

test('injectOwnerFilter：四类作用域各自映射到 (owner_scope, owner_id) 双列', () => {
  assert.deepEqual(injectOwnerFilter(createScope({ kind: 'platform' }), 'ag_secrets'), {
    sql: 'owner_scope = $1 AND owner_id = $2',
    params: ['platform', 'platform'],
  });
  assert.deepEqual(injectOwnerFilter(createScope({ kind: 'user', ownerId: 'u1' }), 'ag_secrets').params, ['user', 'u1']);
  assert.deepEqual(injectOwnerFilter(createScope({ kind: 'developer', developerId: 'd1' }), 'ag_secrets').params, [
    'developer',
    'd1',
  ]);
  assert.deepEqual(injectOwnerFilter(createScope({ kind: 'site', siteId: 's1' }), 'ag_secrets').params, ['site', 's1']);
});

// ─────────────────────────── 3. 单一事务入口 ───────────────────────────

test('assertInTransaction：事务外调用 → 抛 TransactionRequiredError（fail-closed）', () => {
  assert.equal(inTransaction(), false);
  assert.equal(currentTx(), undefined);
  assert.throws(() => assertInTransaction('query'), TransactionRequiredError);
});

test('withTransaction：事务内可见句柄、提交后不可再用、语句计数正确', async () => {
  const events: string[] = [];
  const runner = {
    begin: async () => void events.push('begin'),
    commit: async () => void events.push('commit'),
    rollback: async () => void events.push('rollback'),
  };

  const returned = await withTransaction(runner, async (tx) => {
    assert.equal(inTransaction(), true);
    assert.equal(currentTx()?.id, tx.id);
    tx.record('SELECT 1');
    tx.record('SELECT 2');
    assert.equal(tx.statementCount(), 2);
    return 'ok';
  });

  assert.equal(returned, 'ok');
  assert.deepEqual(events, ['begin', 'commit']);
  assert.equal(inTransaction(), false, '提交后应退出事务上下文');
});

test('withTransaction：fn 抛错 → rollback 且原错误继续抛出（不吞错、不提交）', async () => {
  const events: string[] = [];
  const runner = {
    begin: async () => void events.push('begin'),
    commit: async () => void events.push('commit'),
    rollback: async () => void events.push('rollback'),
  };

  const boom = new Error('业务失败');
  await assert.rejects(
    withTransaction(runner, async () => {
      throw boom;
    }),
    (error: unknown) => error === boom,
  );
  assert.deepEqual(events, ['begin', 'rollback']);
  assert.equal(inTransaction(), false);
});

test('withTransaction：拒绝嵌套（嵌套会变成两个独立事务，破坏原子性）', async () => {
  const runner = {
    begin: async () => {},
    commit: async () => {},
    rollback: async () => {},
  };
  await assert.rejects(
    withTransaction(runner, async () => {
      await withTransaction(runner, async () => undefined);
    }),
    TransactionStateError,
  );
});

test('事务结束后 record / assertInTransaction 都会被拒绝（防「已结束还写」）', async () => {
  let captured: { record: (sql: string) => void } | undefined;
  const runner = { begin: async () => {}, commit: async () => {}, rollback: async () => {} };
  await withTransaction(runner, async (tx) => {
    captured = tx;
  });
  assert.throws(() => captured!.record('SELECT 1'), TransactionStateError);
});
