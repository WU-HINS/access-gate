/**
 * ★★ **审计查询的可见性**（`docs/06:341` + `docs/07 M7-9`）。
 *
 * 声明的可见性模型：**admin 全部 / 开发者仅名下 / 终端用户仅自己**。
 *
 * ★ 本文件钉住三条最容易写错、且写错的后果最重的语义：
 *   ① ★★ **`siteIds: []` 必须是"查不到"，不能是"不过滤"** ——
 *      后者就是跨租户泄露（"名下没有站点"被当成"没有条件"）；
 *   ② `developerId: null` 是**明确的**"只看平台级记录"，不是"不限"；
 *   ③ 端点的可见性由 `audit-scope` 决定，**调用方给的条件只能收窄**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditQueryFilterOf,
  canSeeAudit,
  filterVisibleAudit,
  type AuditRecordScope,
  type AuditViewer,
} from '../src/admin/audit-scope.ts';
import { InMemoryAuditSink, type AuditEntry } from '../src/admin/api.ts';

const SITE_A = '11111111-1111-1111-1111-111111111111';
const SITE_B = '22222222-2222-2222-2222-222222222222';
const DEV_1 = '33333333-3333-3333-3333-333333333333';
const DEV_2 = '44444444-4444-4444-4444-444444444444';

/**
 * ★ 返回类型**同时满足** `AuditEntry`（写入侧）与 `AuditRecordScope`（判定侧）——
 *   两者的差别正是 `developerId` / `realm` **必填可空**（落库后恒有值，`null` = 平台级）。
 */
const entryOf = (over: Partial<AuditEntry> = {}): AuditEntry & AuditRecordScope =>
  ({
    siteId: SITE_A,
    actorId: 'user-1',
    actorType: 'admin',
    action: 'policy.publish',
    developerId: DEV_1,
    realm: 'developer',
    ...over,
  }) as AuditEntry & AuditRecordScope;

const ADMIN: AuditViewer = { userId: 'admin-1', realm: 'developer', role: 'admin' };
const DEVELOPER: AuditViewer = {
  userId: 'dev-user-1',
  realm: 'developer',
  role: 'developer',
  developerId: DEV_1,
};
const ENDUSER: AuditViewer = { userId: 'user-1', realm: 'enduser', role: 'user' };

// ─────────────────────── ① 可见性 → SQL 条件 ───────────────────────

test('★ admin → 全部（`siteIds: all` / `developerId: null` / `actorId: null`）', () => {
  const filter = auditQueryFilterOf(ADMIN);
  assert.equal(filter.siteIds, 'all');
  assert.equal(filter.developerId, null);
  assert.equal(filter.actorId, null);
  assert.match(filter.description, /全部审计/);
});

test('★ developer → **仅名下站点** + 归属过滤', () => {
  const filter = auditQueryFilterOf(DEVELOPER, { siteIdsOfDeveloper: [SITE_A] });
  assert.deepEqual(filter.siteIds, [SITE_A]);
  assert.equal(filter.developerId, DEV_1);
  assert.equal(filter.realm, 'developer');
});

test('★★ developer 名下**没有站点** → `siteIds` 是**空数组**（不是 `all`）', () => {
  const filter = auditQueryFilterOf(DEVELOPER, { siteIdsOfDeveloper: [] });
  assert.deepEqual(filter.siteIds, []);
  assert.notEqual(
    filter.siteIds,
    'all',
    '★ 空集合绝不能退化成"不限"——那正是跨租户泄露的形态',
  );
});

test('★ enduser → 只看**自己**（`actorId` 限定；站点不限，因为用户是平台级的）', () => {
  const filter = auditQueryFilterOf(ENDUSER);
  assert.equal(filter.actorId, 'user-1');
  assert.equal(filter.siteIds, 'all');
  assert.match(filter.description, /仅本人/);
});

test('★ 判定顺序：**域优先于角色**（enduser 域即使 role=admin 也只能看自己）', () => {
  const tricky: AuditViewer = { userId: 'u1', realm: 'enduser', role: 'admin' };
  assert.equal(canSeeAudit(tricky, entryOf({ actorId: 'someone-else' })), false);
  assert.equal(canSeeAudit(tricky, entryOf({ actorId: 'u1' })), true);
});

// ─────────────────────── ② 存储层的过滤 ───────────────────────

test('★★★ `siteIds: []` → **查不到**（而不是"不过滤"）', async () => {
  const sink = new InMemoryAuditSink();
  await sink.record(entryOf());
  const rows = await sink.list({ siteIds: [] });
  assert.deepEqual(
    rows,
    [],
    '★★ 空集合必须是"查不到"——写成"不过滤"就是跨租户泄露（内存与 PG 必须一致）',
  );
});

test('★ `siteIds` 限定生效；`all` 不限', async () => {
  const sink = new InMemoryAuditSink();
  await sink.record(entryOf({ siteId: SITE_A }));
  await sink.record(entryOf({ siteId: SITE_B }));

  assert.equal((await sink.list({ siteIds: [SITE_A] })).length, 1);
  assert.equal((await sink.list({ siteIds: [SITE_A, SITE_B] })).length, 2);
  assert.equal((await sink.list({ siteIds: 'all' })).length, 2);
});

test('★★ `developerId: null` → 只看**平台级**记录（不是"不限"）', async () => {
  const sink = new InMemoryAuditSink();
  await sink.record(entryOf({ developerId: null })); // 平台级操作
  await sink.record(entryOf({ developerId: DEV_1 }));

  const platform = await sink.list({ developerId: null });
  assert.equal(platform.length, 1);
  assert.equal(platform[0]!.developerId, null);

  // 不传该字段 = 不限（两种语义必须分得开）
  assert.equal((await sink.list({})).length, 2);
});

test('`realm` 过滤 + 时间倒序（最近的审计最常被查）', async () => {
  const sink = new InMemoryAuditSink();
  await sink.record(entryOf({ realm: 'developer', action: 'first' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sink.record(entryOf({ realm: 'enduser', action: 'second' }));

  assert.equal((await sink.list({ realm: 'enduser' })).length, 1);
  const all = await sink.list({});
  assert.equal(all[0]!.action, 'second', '★ 时间倒序');
});

test('动作前缀过滤（LIKE 语义的等价物）', async () => {
  const sink = new InMemoryAuditSink();
  await sink.record(entryOf({ action: 'oidc.key_published' }));
  await sink.record(entryOf({ action: 'policy.publish' }));

  const rows = await sink.list({ actionPrefix: 'oidc.' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, 'oidc.key_published');
});

// ─────────────────────── ③ 判定与过滤的一致性 ───────────────────────

test('★★★ `filterVisibleAudit`：developer 看不到**别的开发者**与**平台级**记录', () => {
  const records = [
    entryOf({ developerId: DEV_1, action: 'mine' }),
    entryOf({ developerId: DEV_2, action: 'other-developer' }),
    entryOf({ developerId: null, action: 'platform-level' }),
  ];
  const visible = filterVisibleAudit(DEVELOPER, records);
  assert.deepEqual(
    visible.map((r) => r.action),
    ['mine'],
    '★ 平台级记录（developerId=null）对普通开发者不可见——它涉及平台配置与其他开发者的入驻',
  );
});

test('★ admin 看全部（含平台级与其他开发者）', () => {
  const records = [
    entryOf({ developerId: DEV_1 }),
    entryOf({ developerId: DEV_2 }),
    entryOf({ developerId: null }),
  ];
  assert.equal(filterVisibleAudit(ADMIN, records).length, 3);
});

test('★★ 端点层的两层必须一致：SQL 条件过滤后，应用层判定**不应再拒掉任何一条**', async () => {
  const sink = new InMemoryAuditSink();
  await sink.record(entryOf({ developerId: DEV_1, siteId: SITE_A }));
  await sink.record(entryOf({ developerId: DEV_2, siteId: SITE_A }));

  const filter = auditQueryFilterOf(DEVELOPER, { siteIdsOfDeveloper: [SITE_A] });
  const rows = await sink.list({
    siteIds: filter.siteIds,
    developerId: filter.developerId,
    realm: filter.realm,
  });
  const visible = filterVisibleAudit(DEVELOPER, rows);

  assert.equal(
    visible.length,
    rows.length,
    '★ 若这里变少，说明 SQL 条件与判定器**语义不一致**（"列表过滤了、详情忘了"的反面：两层用了两套规则）',
  );
  assert.equal(visible.length, 1);
});
