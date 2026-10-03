/**
 * 查询 AST + 编译器的验收。
 *
 * ★ 核心断言不是「生成了什么 SQL」，而是**注入是否真的发生**：
 *   站点表在无作用域时必须抛错、有作用域时必须出现 site_id 条件、
 *   且显式绕过必须带理由。这三条是 D17 的全部内容。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  and,
  col,
  decrement,
  eq,
  gt,
  increment,
  inList,
  isNull,
  like,
  lit,
  or,
  type SelectQuery,
} from '../src/query/ast.ts';
import { compile, QueryCompileError, ScopeRequiredError, type TableScopeMeta } from '../src/query/compile.ts';

const SITE_TABLE: TableScopeMeta = { siteScoped: true, hasSiteIdColumn: true };
const PLATFORM_TABLE: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };
const BROKEN_TABLE: TableScopeMeta = { siteScoped: true, hasSiteIdColumn: false };

test('SELECT：站点表 + 有作用域 → 自动注入 site_id = $1，业务条件后移', () => {
  const query: SelectQuery = {
    kind: 'select',
    table: 'ag_policies',
    columns: ['id', 'code'],
    where: eq(col('enabled'), lit(true)),
    orderBy: [{ column: 'priority', direction: 'asc' }],
    limit: 10,
  };
  const compiled = compile(query, SITE_TABLE, { scope: { siteId: 'site-1' } });
  assert.equal(
    compiled.sql,
    'SELECT id, code FROM ag_policies WHERE (site_id = $1 AND enabled = $2) ORDER BY priority ASC LIMIT $3',
  );
  assert.deepEqual(compiled.params, ['site-1', true, 10]);
  assert.equal(compiled.scopeBypassed, false);
});

test('SELECT：站点表 + 无作用域 → 抛 ScopeRequiredError（fail-closed，绝不返回不过滤的 SQL）', () => {
  const query: SelectQuery = { kind: 'select', table: 'ag_policies', columns: '*' };
  assert.throws(
    () => compile(query, SITE_TABLE, {}),
    (error: unknown) => {
      assert.ok(error instanceof ScopeRequiredError, `期望 ScopeRequiredError，实际 ${String(error)}`);
      assert.match(error.message, /fail-closed/);
      return true;
    },
  );
  // 空字符串与 undefined 同样必须拒绝（防止「传了但为空」被当成有作用域）
  assert.throws(() => compile(query, SITE_TABLE, { scope: { siteId: '' } }), ScopeRequiredError);
});

test('SELECT：平台表不需要作用域，也不注入 site_id', () => {
  const compiled = compile({ kind: 'select', table: 'ag_platform_settings', columns: '*' }, PLATFORM_TABLE, {});
  assert.equal(compiled.sql, 'SELECT * FROM ag_platform_settings');
  assert.deepEqual(compiled.params, []);
});

test('SELECT：声明 siteScoped 但没有 site_id 列 → 编译期报声明缺陷（不猜、不绕过）', () => {
  assert.throws(
    () => compile({ kind: 'select', table: 'ag_x', columns: '*' }, BROKEN_TABLE, { scope: { siteId: 's' } }),
    (error: unknown) => {
      assert.ok(error instanceof QueryCompileError);
      assert.match(error.message, /声明缺陷/);
      return true;
    },
  );
});

test('绕过：scope:bypass 无理由 → 拒绝；有理由 → 放行且标记 scopeBypassed', () => {
  const query: SelectQuery = { kind: 'select', table: 'ag_policies', columns: '*', scope: 'bypass' };
  assert.throws(() => compile(query, SITE_TABLE, { scope: { siteId: 's' } }), QueryCompileError);

  const compiled = compile(query, SITE_TABLE, { scope: { siteId: 's' }, bypassReason: '平台级运维巡检（只读统计）' });
  assert.equal(compiled.scopeBypassed, true);
  assert.equal(compiled.bypassReason, '平台级运维巡检（只读统计）');
  assert.equal(compiled.sql.includes('site_id'), false);
});

test('INSERT：站点表的每一行都被注入 site_id（客户端无法伪造）', () => {
  const compiled = compile(
    {
      kind: 'insert',
      table: 'ag_audit_log',
      rows: [
        { action: 'policy.publish', actor_type: 'admin' },
        { action: 'identity.link', actor_type: 'system' },
      ],
      returning: ['id'],
    },
    SITE_TABLE,
    { scope: { siteId: 'site-9' } },
  );
  assert.equal(
    compiled.sql,
    'INSERT INTO ag_audit_log (site_id, action, actor_type) VALUES ($1, $2, $3), ($4, $5, $6) RETURNING id',
  );
  assert.deepEqual(compiled.params, ['site-9', 'policy.publish', 'admin', 'site-9', 'identity.link', 'system']);
});

test('INSERT：显式 site_id 与作用域不一致 → 直接拒绝（防跨站点写入）；一致时值取自作用域', () => {
  // 不一致 → 拒绝
  assert.throws(
    () =>
      compile(
        { kind: 'insert', table: 'ag_audit_log', rows: [{ site_id: 'attacker-site', action: 'x' }] },
        SITE_TABLE,
        { scope: { siteId: 'real-site' } },
      ),
    (error: unknown) => {
      assert.ok(error instanceof QueryCompileError);
      assert.match(error.message, /拒绝跨站点写入/);
      return true;
    },
  );

  // 一致 → 放行，且值来自作用域
  const same = compile(
    { kind: 'insert', table: 'ag_audit_log', rows: [{ site_id: 'real-site', action: 'x' }] },
    SITE_TABLE,
    { scope: { siteId: 'real-site' } },
  );
  assert.deepEqual(same.params, ['real-site', 'x']);

  // 不写 → 自动注入
  const injected = compile(
    { kind: 'insert', table: 'ag_audit_log', rows: [{ action: 'x' }] },
    SITE_TABLE,
    { scope: { siteId: 'real-site' } },
  );
  assert.deepEqual(injected.params, ['real-site', 'x']);
  assert.equal(injected.sql.includes('attacker-site'), false);
});

test('UPDATE / DELETE：站点表自动注入 + 无 WHERE 一律拒绝（防全表写）', () => {
  const upd = compile(
    { kind: 'update', table: 'ag_policies', set: { enabled: false }, where: eq(col('code'), lit('edu')) },
    SITE_TABLE,
    { scope: { siteId: 's1' } },
  );
  assert.equal(upd.sql, 'UPDATE ag_policies SET enabled = $1 WHERE (site_id = $2 AND code = $3)');
  assert.deepEqual(upd.params, [false, 's1', 'edu']);

  assert.throws(
    () => compile({ kind: 'update', table: 'ag_policies', set: { enabled: false } }, SITE_TABLE, { scope: { siteId: 's1' } }),
    QueryCompileError,
  );
  assert.throws(
    () => compile({ kind: 'delete', table: 'ag_policies' }, SITE_TABLE, { scope: { siteId: 's1' } }),
    QueryCompileError,
  );
  assert.throws(
    () => compile({ kind: 'delete', table: 'ag_policies' }, PLATFORM_TABLE, {}),
    QueryCompileError,
  );
});

test('条件渲染：AND / OR / IN / LIKE / IS NULL 与占位符编号正确', () => {
  const compiled = compile(
    {
      kind: 'select',
      table: 'ag_external_subjects',
      columns: ['external_id'],
      where: and(
        or(eq(col('provider'), lit('github')), eq(col('provider'), lit('discord'))),
        inList(col('email'), ['a@b.c', 'd@e.f']),
        like(col('display_name'), '%bot%', true),
        isNull(col('deleted_at')),
        gt(col('score'), lit(40)),
      ),
    },
    SITE_TABLE,
    { scope: { siteId: 's' } },
  );
  // ★ 注入条件与业务条件合并为单个 AND，因此只有一层外层括号；
  //   OR 分支必须自带括号——否则会因优先级把 site_id 过滤「或」掉（跨站点泄漏）。
  assert.equal(
    compiled.sql,
    'SELECT external_id FROM ag_external_subjects WHERE ' +
      '(site_id = $1 AND ((provider = $2 OR provider = $3) AND email IN ($4, $5) AND display_name ILIKE $6 ' +
      'AND deleted_at IS NULL AND score > $7))',
  );
  assert.deepEqual(compiled.params, ['s', 'github', 'discord', 'a@b.c', 'd@e.f', '%bot%', 40]);
});

test('空 IN 集合按恒假处理（不生成非法的 IN ()）', () => {
  const compiled = compile(
    { kind: 'select', table: 'ag_policies', columns: '*', where: inList(col('id'), []) },
    SITE_TABLE,
    { scope: { siteId: 's' } },
  );
  assert.match(compiled.sql, /FALSE/);
  assert.equal(compiled.sql.includes('IN ()'), false);
});

test('非法列标识符被拒绝（防止把值拼进列位）', () => {
  assert.throws(
    () =>
      compile(
        { kind: 'select', table: 'ag_policies', columns: '*', where: eq(col('id; DROP TABLE ag_users'), lit(1)) },
        SITE_TABLE,
        { scope: { siteId: 's' } },
      ),
    QueryCompileError,
  );
});

// ─────────────────────────── SET 受限表达式（自增/自减） ───────────────────────────

test('★ UPDATE：支持列自增/自减（参数化，不拼接 SQL；替代手写 SQL）', () => {
  const compiled = compile(
    {
      kind: 'update',
      table: 'ag_jobs',
      set: { run_count: increment('run_count'), fail_count: increment('fail_count', 2), quota: decrement('quota') },
      where: eq(col('job_key'), lit('sync')),
    },
    PLATFORM_TABLE,
    {},
  );
  assert.equal(compiled.sql, 'UPDATE ag_jobs SET run_count = run_count + $1, fail_count = fail_count + $2, quota = quota - $3 WHERE job_key = $4');
  assert.deepEqual(compiled.params, [1, 2, 1, 'sync']);
});

test('自增表达式的列名必须合法（防把值拼进列位）', () => {
  assert.throws(
    () =>
      compile(
        { kind: 'update', table: 'ag_jobs', set: { run_count: increment('run_count; DROP TABLE x') }, where: eq(col('job_key'), lit('a')) },
        PLATFORM_TABLE,
        {},
      ),
    QueryCompileError,
  );
  assert.throws(() => increment('x', Number.POSITIVE_INFINITY), /有限数字/);
});

test('UPDATE：非法 SET 列名被拒绝', () => {
  assert.throws(
    () =>
      compile(
        { kind: 'update', table: 'ag_jobs', set: { 'run_count = 1; --': 1 }, where: eq(col('job_key'), lit('a')) },
        PLATFORM_TABLE,
        {},
      ),
    QueryCompileError,
  );
});
