/**
 * 用户两级选择验收（M7-5）—— docs/08 §2、§6。
 *
 * ★ 最重要的断言是**归属校验**：站点是隔离边界，
 *   若允许 `(A 开发者, B 开发者的站点)` 这种组合，就是跨租户越权。
 *   而它的表现是「选择成功」而非报错，因此必须显式锁定。
 *
 * ★ 第二重要的断言：**会话里存的是内部 uuid（`site.id`），不是 slug（`site.siteId`）**。
 *   混用会让「换 slug」变成「换站点身份」——M7-1 已就此立过约束。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  listDeveloperOptions,
  listSiteOptions,
  needsSelection,
  selectContext,
  STANDALONE_SELECTION_NOTE,
  toSelectionContext,
} from '../src/core/site-selection.ts';
import { InMemorySiteRegistry } from '../src/core/sites.ts';
import { silentLogger } from '../src/kernel/logger.ts';

async function seed() {
  const registry = new InMemorySiteRegistry();
  const alice = await registry.createDeveloper({ username: 'alice', displayName: 'Alice', email: 'a@x.com', role: 'developer' });
  const bob = await registry.createDeveloper({ username: 'bob', displayName: 'Bob', email: 'b@x.com', role: 'developer' });
  await registry.createSite({ siteId: 'alice-main', nickname: 'Alice 主站', developerId: alice.id });
  await registry.createSite({ siteId: 'alice-test', nickname: 'Alice 测试站', developerId: alice.id });
  await registry.createSite({ siteId: 'bob-main', nickname: 'Bob 主站', developerId: bob.id });
  return { registry, alice, bob, options: { registry, logger: silentLogger } };
}

// ─────────────────────────── ★ 归属校验 ───────────────────────────

test('★ M7-5：跨开发者选择被拒（站点是隔离边界，归属错配即越权）', async () => {
  const { alice, bob, options } = await seed();

  // 声称「Bob 的开发者 + Alice 的站点」
  const forged = await selectContext(options, { developerId: bob.id, siteId: 'alice-main' });
  assert.equal(forged.ok, false, '★ 归属错配必须被拒');
  if (!forged.ok) {
    assert.equal(forged.reason, 'site_not_owned_by_developer');
    assert.match(forged.message, /不属于开发者/);
    assert.match(forged.message, /隔离边界/);
  }

  // 正确配对则通过
  const correct = await selectContext(options, { developerId: alice.id, siteId: 'alice-main' });
  assert.equal(correct.ok, true);
  if (correct.ok) assert.equal(correct.site.developerId, alice.id);
});

test('★ M7-5：`toSelectionContext` 写入内部 uuid（不是 slug）', async () => {
  const { alice, options } = await seed();
  const result = await selectContext(options, { developerId: alice.id, siteId: 'alice-main' });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const context = toSelectionContext(result, new Date('2025-06-01T00:00:00Z'));
  // ★ ag_sessions.active_site_id 是 uuid 列
  assert.match(context.activeSiteId, /^[0-9a-f-]{36}$/, '会话存的是内部 uuid');
  assert.notEqual(context.activeSiteId, result.site.siteId, '不得把 slug 写进 uuid 列');
  assert.equal(context.activeDeveloperId, alice.id);
  assert.equal(context.selectedAt.toISOString(), '2025-06-01T00:00:00.000Z');
});

// ─────────────────────────── 第一级：开发者 ───────────────────────────

test('M7-5：第一级列表只含**有活跃站点**的活跃开发者，并给出站点数', async () => {
  const { alice, bob, options } = await seed();
  const empty = await options.registry.createDeveloper({ username: 'empty', displayName: 'Empty', email: 'e@x.com', role: 'developer' });

  const list = await listDeveloperOptions(options, [alice.id, bob.id, empty.id]);
  assert.deepEqual(list.map((entry) => entry.displayName), ['Alice', 'Bob'], '★ 无站点的开发者不应出现在列表里');
  assert.equal(list.find((entry) => entry.developerId === alice.id)!.siteCount, 2);
  assert.equal(list.find((entry) => entry.developerId === bob.id)!.siteCount, 1);
});

test('M7-5：停用的开发者不出现在第一级列表', async () => {
  const { alice, bob, options } = await seed();
  await options.registry.setDeveloperStatus(bob.id, 'suspended');
  const list = await listDeveloperOptions(options, [alice.id, bob.id]);
  assert.deepEqual(list.map((entry) => entry.displayName), ['Alice']);
});

test('M7-5：第一级排序稳定（同名时按 id，避免顺序抖动）', async () => {
  const registry = new InMemorySiteRegistry();
  const a = await registry.createDeveloper({ username: 'a', displayName: '同名', email: 'a@x.com' });
  const b = await registry.createDeveloper({ username: 'b', displayName: '同名', email: 'b@x.com' });
  await registry.createSite({ siteId: 'sa', nickname: 'A', developerId: a.id });
  await registry.createSite({ siteId: 'sb', nickname: 'B', developerId: b.id });
  const options = { registry, logger: silentLogger };

  const first = await listDeveloperOptions(options, [a.id, b.id]);
  const second = await listDeveloperOptions(options, [b.id, a.id]);
  assert.deepEqual(first.map((entry) => entry.developerId), second.map((entry) => entry.developerId), '输入顺序不同不应改变输出顺序');
});

// ─────────────────────────── 第二级：站点 ───────────────────────────

test('M7-5：第二级只列活跃站点，并标记当前已选', async () => {
  const { alice, options } = await seed();
  const list = await listSiteOptions(options, alice.id, { siteId: 'alice-test' });
  assert.deepEqual(list.map((entry) => entry.siteId), ['alice-main', 'alice-test']);
  assert.equal(list.find((entry) => entry.siteId === 'alice-test')!.selected, true);
  assert.equal(list.find((entry) => entry.siteId === 'alice-main')!.selected, undefined);

  // 停用某站点后不再出现
  await options.registry.setSiteStatus('alice-test', 'suspended');
  const after = await listSiteOptions(options, alice.id);
  assert.deepEqual(after.map((entry) => entry.siteId), ['alice-main']);
});

test('M7-5：开发者不可用时第二级返回**空列表**（不抛错，前端只需展示「无可用站点」）', async () => {
  const { alice, options } = await seed();
  await options.registry.setDeveloperStatus(alice.id, 'suspended');
  assert.deepEqual(await listSiteOptions(options, alice.id), []);
  assert.deepEqual(await listSiteOptions(options, 'ghost'), []);
});

// ─────────────────────────── 选择失败路径 ───────────────────────────

test('M7-5：选择失败路径各自给出明确原因', async () => {
  const { alice, bob, options } = await seed();

  const noDev = await selectContext(options, { developerId: 'ghost', siteId: 'alice-main' });
  assert.equal(noDev.ok, false);
  if (!noDev.ok) assert.equal(noDev.reason, 'developer_not_found');

  const noSite = await selectContext(options, { developerId: alice.id, siteId: 'ghost' });
  assert.equal(noSite.ok, false);
  if (!noSite.ok) assert.equal(noSite.reason, 'site_not_found');

  // 开发者停用 → 拒绝（与 resolveSite 同一套判据）
  await options.registry.setDeveloperStatus(bob.id, 'suspended');
  const devSuspended = await selectContext(options, { developerId: bob.id, siteId: 'bob-main' });
  assert.equal(devSuspended.ok, false);
  if (!devSuspended.ok) assert.equal(devSuspended.reason, 'developer_suspended');

  // 站点停用 → 拒绝
  await options.registry.setSiteStatus('alice-main', 'suspended');
  const siteSuspended = await selectContext(options, { developerId: alice.id, siteId: 'alice-main' });
  assert.equal(siteSuspended.ok, false);
  if (!siteSuspended.ok) assert.equal(siteSuspended.reason, 'site_suspended');
});

// ─────────────────────────── 是否需要展示选择界面 ───────────────────────────

test('★ M7-5：`needsSelection` —— 单站点/单开发者时不需要两级选择', async () => {
  const { alice, options } = await seed();
  // Alice 有 2 个站点 → 需要选择站点
  assert.equal(await needsSelection(options, [alice.id]), true);

  // 只有一个开发者且只有一个站点 → 不需要选择
  const registry = new InMemorySiteRegistry();
  const solo = await registry.createDeveloper({ username: 'solo', displayName: 'Solo', email: 's@x.com' });
  await registry.createSite({ siteId: 'only', nickname: '唯一站点', developerId: solo.id });
  const soloOptions = { registry, logger: silentLogger };
  assert.equal(await needsSelection(soloOptions, [solo.id]), false, '★ 单站点部署不应展示选择界面');

  // 多个开发者 → 需要选择
  const { alice: a2, bob: b2, options: o2 } = await seed();
  assert.equal(await needsSelection(o2, [a2.id, b2.id]), true);
});

test('M7-5：standalone 语义有明确文档化', () => {
  assert.match(STANDALONE_SELECTION_NOTE, /自动选择默认开发者与默认站点/);
  assert.match(STANDALONE_SELECTION_NOTE, /多站点部署才展示选择界面/);
});
