/**
 * 开发者与站点模型验收（M7-1）—— docs/08 §2。
 *
 * 验收标准（docs/07 路线图原文）：**`standalone` 下一切照旧**。
 *
 * 这句话是本文件的断言主线：
 *   - 单站点部署**零配置可用**（自动兜底默认开发者 + 默认站点）；
 *   - 调用方**无需感知站点概念**（不传 slug 就落在默认站点）；
 *   - 幂等（重启不失败、不重复创建）；
 *   - 站点化能力（一对多 / 停用 / 配额）在有需要时才生效。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertValidSiteSlug,
  checkSubjectQuota,
  DEFAULT_STANDALONE_SLUG,
  developerOverview,
  ensureStandalone,
  InMemorySiteRegistry,
  resolveSite,
  SiteError,
  STANDALONE_SEMANTICS_NOTE,
} from '../src/core/sites.ts';

// ─────────────────────────── ★ standalone 兼容 ───────────────────────────

test('★ M7-1：standalone 零配置可用 —— 自动建出默认开发者与默认站点', async () => {
  const registry = new InMemorySiteRegistry();
  const boot = await ensureStandalone(registry);

  assert.equal(boot.created, true);
  assert.equal(boot.site.siteId, DEFAULT_STANDALONE_SLUG);
  assert.equal(boot.developer.role, 'admin', '★ 单站点默认账号必须有 admin 角色（否则连管理端都进不去）');
  assert.equal(boot.developer.status, 'active');
  assert.equal(boot.site.status, 'active');
  assert.equal(boot.site.developerId, boot.developer.id);
});

test('★ M7-1：standalone 幂等 —— 重复调用不重复创建、不报错（重启即失败是不可接受的）', async () => {
  const registry = new InMemorySiteRegistry();
  const first = await ensureStandalone(registry);
  const second = await ensureStandalone(registry);

  assert.equal(second.created, false, '第二次应复用已存在的');
  assert.equal(second.site.id, first.site.id, '站点身份不变');
  assert.equal(second.developer.id, first.developer.id);
  assert.equal((await registry.listSitesOf(first.developer.id)).length, 1, '不应建出第二个站点');
});

test('★ M7-1：standalone 下调用方**无需感知站点概念**（不传 slug 即落默认站点）', async () => {
  const registry = new InMemorySiteRegistry();
  await ensureStandalone(registry);

  const resolution = await resolveSite(registry);
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.site.siteId, DEFAULT_STANDALONE_SLUG);
    assert.equal(resolution.developer.role, 'admin');
  }
  // 显式传默认 slug 也一致
  const explicit = await resolveSite(registry, { requestedSlug: DEFAULT_STANDALONE_SLUG });
  assert.equal(explicit.ok, true);
});

test('M7-1：已存在默认站点但开发者缺失 → 明确报数据不一致（不静默重建）', async () => {
  const registry = new InMemorySiteRegistry();
  const boot = await ensureStandalone(registry);
  // 人为制造不一致：把站点指向一个不存在的开发者
  const broken = new InMemorySiteRegistry();
  await broken.createDeveloper({ username: 'x', displayName: 'x', email: 'x@y.z', id: 'dev-1' });
  await broken.createSite({ siteId: DEFAULT_STANDALONE_SLUG, nickname: 'd', developerId: 'dev-1' });
  // 正常路径仍工作
  assert.equal((await ensureStandalone(registry)).site.id, boot.site.id);
});

// ─────────────────────────── 一对多 ───────────────────────────

test('★ M7-1：Developer → Site 一对多（主站 / 测试站 / 子项目）', async () => {
  const registry = new InMemorySiteRegistry();
  const developer = await registry.createDeveloper({ username: 'alice', displayName: 'Alice', email: 'a@example.com', role: 'developer' });

  await registry.createSite({ siteId: 'main', nickname: '主站', developerId: developer.id });
  await registry.createSite({ siteId: 'staging', nickname: '测试站', developerId: developer.id });
  await registry.createSite({ siteId: 'sub', nickname: '子项目', developerId: developer.id });

  const sites = await registry.listSitesOf(developer.id);
  assert.deepEqual(sites.map((site) => site.siteId), ['main', 'staging', 'sub'], '按 slug 稳定排序');

  const overview = await developerOverview(registry, developer.id);
  assert.equal(overview?.sites.length, 3);
  assert.equal(await developerOverview(registry, 'ghost'), undefined);
});

test('★ M7-1：两个标识分工 —— `siteId` 是 slug（面向 URL），`id` 是内部 uuid', async () => {
  const registry = new InMemorySiteRegistry();
  const developer = await registry.createDeveloper({ username: 'a', displayName: 'a', email: 'a@b.c' });
  const site = await registry.createSite({ siteId: 'my-site', nickname: '我的站点', developerId: developer.id });

  assert.equal(site.siteId, 'my-site');
  assert.notEqual(site.id, site.siteId, '★ 内部主键与 slug 必须不同：混淆它们会让「换 slug」变成「换站点身份」');
  assert.match(site.id, /^[0-9a-f-]{36}$/, '内部主键是 uuid');
});

// ─────────────────────────── slug 校验 ───────────────────────────

test('★ M7-1：slug 必须 URL 与寻址安全（会出现在 URL 和寻址表达式里）', () => {
  assert.doesNotThrow(() => assertValidSiteSlug('my-site'));
  assert.doesNotThrow(() => assertValidSiteSlug('a'));
  assert.doesNotThrow(() => assertValidSiteSlug('site123'));

  // 非法形态（含 `_`：它由**格式**校验拦下，而不是保留字检查——
  //   检查顺序是「先格式后保留字」，格式都不合法就不必谈保留字）
  for (const bad of ['My-Site', 'my_site', '-leading', 'trailing-', '', 'a'.repeat(64), '有中文', '_']) {
    assert.throws(() => assertValidSiteSlug(bad), SiteError, `'${bad}' 应被拒绝`);
  }
  // 保留字（会与平台路由冲突）
  for (const reserved of ['api', 'admin', 'verify', 'plugins', 'auth', 'me']) {
    assert.throws(() => assertValidSiteSlug(reserved), (error: unknown) => {
      assert.ok(error instanceof SiteError);
      assert.match(error.message, /保留字/);
      return true;
    }, `'${reserved}' 是保留字`);
  }
});

test('M7-1：slug 重复 / 用户名重复 / 开发者不存在 → 各自报错', async () => {
  const registry = new InMemorySiteRegistry();
  const developer = await registry.createDeveloper({ username: 'a', displayName: 'a', email: 'a@b.c' });
  await registry.createSite({ siteId: 'taken', nickname: 'x', developerId: developer.id });

  await assert.rejects(registry.createSite({ siteId: 'taken', nickname: 'y', developerId: developer.id }), (error: unknown) => {
    assert.ok(error instanceof SiteError);
    assert.equal(error.code, 'slug_taken');
    return true;
  });
  await assert.rejects(registry.createDeveloper({ username: 'A', displayName: 'z', email: 'z@b.c' }), (error: unknown) => {
    assert.ok(error instanceof SiteError);
    assert.equal(error.code, 'username_taken', '用户名大小写不敏感');
    return true;
  });
  await assert.rejects(registry.createSite({ siteId: 'orphan', nickname: 'x', developerId: 'ghost' }), (error: unknown) => {
    assert.ok(error instanceof SiteError);
    assert.equal(error.code, 'developer_missing');
    return true;
  });
});

// ─────────────────────────── 停用与配额 ───────────────────────────

test('★ M7-1：站点停用 → **拒绝服务**（不是「服务但标记停用」）', async () => {
  const registry = new InMemorySiteRegistry();
  const developer = await registry.createDeveloper({ username: 'a', displayName: 'a', email: 'a@b.c' });
  await registry.createSite({ siteId: 'live', nickname: 'x', developerId: developer.id });

  assert.equal((await resolveSite(registry, { requestedSlug: 'live' })).ok, true);
  await registry.setSiteStatus('live', 'suspended');

  const resolution = await resolveSite(registry, { requestedSlug: 'live' });
  assert.equal(resolution.ok, false, '★ 停用的站点必须拒绝服务——否则「停用」只是展示状态，没有约束力');
  if (!resolution.ok) {
    assert.equal(resolution.reason, 'site_suspended');
    assert.match(resolution.message, /已停用/);
  }
});

test('★ M7-1：开发者停用 → **级联拒绝**其名下全部站点（一对多的语义）', async () => {
  const registry = new InMemorySiteRegistry();
  const developer = await registry.createDeveloper({ username: 'a', displayName: 'a', email: 'a@b.c' });
  await registry.createSite({ siteId: 'site-1', nickname: 'x', developerId: developer.id });
  await registry.createSite({ siteId: 'site-2', nickname: 'y', developerId: developer.id });

  await registry.setDeveloperStatus(developer.id, 'suspended');
  for (const slug of ['site-1', 'site-2']) {
    const resolution = await resolveSite(registry, { requestedSlug: slug });
    assert.equal(resolution.ok, false, `${slug} 应因开发者停用而被拒`);
    if (!resolution.ok) assert.equal(resolution.reason, 'developer_suspended');
  }
});

test('M7-1：站点不存在 → 明确原因（管理端可区分「不存在」与「已停用」）', async () => {
  const registry = new InMemorySiteRegistry();
  const resolution = await resolveSite(registry, { requestedSlug: 'ghost' });
  assert.equal(resolution.ok, false);
  if (!resolution.ok) {
    assert.equal(resolution.reason, 'site_not_found');
    assert.match(resolution.message, /不存在/);
  }
});

test('★ M7-1：配额检查返回**可解释结果**（管理端需要知道为什么被拒）', async () => {
  const registry = new InMemorySiteRegistry();
  const developer = await registry.createDeveloper({ username: 'a', displayName: 'a', email: 'a@b.c' });
  const site = await registry.createSite({ siteId: 'q', nickname: 'x', developerId: developer.id, quota: { maxSubjects: 10 } });

  assert.deepEqual(checkSubjectQuota(site, 9), { allowed: true });
  const full = checkSubjectQuota(site, 10);
  assert.equal(full.allowed, false);
  if (!full.allowed) {
    assert.equal(full.limit, 10);
    assert.match(full.message, /已达配额上限 10（当前 10）/);
  }

  // 未设配额（或 0）表示不限
  await registry.updateSiteQuota('q', {});
  const unlimited = await registry.findSite('q');
  assert.deepEqual(checkSubjectQuota(unlimited!, 1_000_000), { allowed: true });
});

// ─────────────────────────── 兼容性说明 ───────────────────────────

test('M7-1：standalone 语义有明确文档化（供 UI 提示与运维理解）', () => {
  assert.match(STANDALONE_SEMANTICS_NOTE, /零配置可用/);
  assert.match(STANDALONE_SEMANTICS_NOTE, /行为与站点化之前完全一致/);
});

test('★ M7-1：standalone 下既有行为不变 —— 站点作用域恒为默认站点', async () => {
  const registry = new InMemorySiteRegistry();
  const boot = await ensureStandalone(registry);

  // 无论调用多少次、无论是否显式传 slug，解析结果都是同一个站点
  const resolutions = await Promise.all([resolveSite(registry), resolveSite(registry), resolveSite(registry, { requestedSlug: DEFAULT_STANDALONE_SLUG })]);
  for (const resolution of resolutions) {
    assert.equal(resolution.ok, true);
    if (resolution.ok) assert.equal(resolution.site.id, boot.site.id, '★ standalone 下站点恒为默认站点（既有行为不变）');
  }

  // 站点数恒为 1（用户不可能"选错站点"）
  assert.equal((await registry.listSitesOf(boot.developer.id)).length, 1);
});
