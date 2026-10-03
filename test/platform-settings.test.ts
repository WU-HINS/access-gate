/**
 * 平台设置端点验收（P0；docs/06 `/admin/settings` 系列、docs/08 §11）。
 *
 * ★ 核心断言：
 *   1. **`locked_by_env` 时 API 拒绝修改**（否则一次误操作就能推翻部署时的决定）；
 *   2. **降级到 standalone 需要显式确认**（它会让站点 UI 隐藏、入驻入口关闭）；
 *   3. **切换可逆且不丢数据**（R14 已确立的语义，在接口层同样要体现）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemoryPlatformSettingsStore, PLATFORM_MODE_KEY } from '../src/app/platform-mode.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ADMIN_SESSION = { userId: 'admin-1', username: 'admin', activeSiteId: 'site-1', realm: 'developer' as const, role: 'admin' as const };

function makeHandler(options: { locked?: boolean; mode?: 'standalone' | 'saas' } = {}) {
  const settings = new InMemoryPlatformSettingsStore();
  if (options.mode !== undefined || options.locked !== undefined) {
    // 预置
    void settings.putIfAbsent(PLATFORM_MODE_KEY, options.mode ?? 'standalone', null, new Date(), options.locked ?? false);
  }
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    settings,
    platformStats: async () => ({ developers: 4, sites: 7, subjects: 1200, extraSites: 6 }),
    logger: silentLogger,
  });
  return { handler, settings };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], method: string, path: string, body?: unknown) =>
  handler({ method, path, query: {}, body, session: ADMIN_SESSION } as never);

// ─────────────────────────── 读 ───────────────────────────

test('★ GET /api/admin/settings/platform 返回模式 + 能力 + 锁定状态', async () => {
  const { handler } = makeHandler({ mode: 'saas' });
  const response = (await call(handler, 'GET', '/api/admin/settings/platform')) as {
    status: number;
    body: { mode: string; capabilities: { siteUiVisible: boolean }; lockedByEnv: boolean };
  };
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, 'saas');
  assert.equal(response.body.capabilities.siteUiVisible, true, 'saas 下站点 UI 可见');
  assert.equal(response.body.lockedByEnv, false);
});

test('未写入过设置时默认为 standalone（单站点是安全默认）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'GET', '/api/admin/settings/platform')) as { body: { mode: string } };
  assert.equal(response.body.mode, 'standalone');
});

// ─────────────────────────── ★★ 锁定 ───────────────────────────

test('★★ `locked_by_env` 时 POST 被拒（409）—— 不能让 API 推翻部署决定', async () => {
  const { handler, settings } = makeHandler({ mode: 'standalone', locked: true });
  const response = (await call(handler, 'POST', '/api/admin/settings/platform', { mode: 'saas' })) as { status: number; body: { error: string } };
  assert.equal(response.status, 409, '★ 被环境变量锁定时必须拒绝');
  assert.match(response.body.error, /环境变量锁定/);
  assert.match(response.body.error, /AG_PLATFORM_MODE/, '要告诉运维怎么改');
  // ★ 状态未被改变
  assert.equal((await settings.get(PLATFORM_MODE_KEY))?.value, 'standalone');
});

// ─────────────────────────── 切换 ───────────────────────────

test('★ standalone → saas 直接生效（升级不需要确认）', async () => {
  const { handler, settings } = makeHandler({ mode: 'standalone' });
  const response = (await call(handler, 'POST', '/api/admin/settings/platform', { mode: 'saas' })) as {
    status: number;
    body: { mode: string; capabilities: { onboardingOpen: boolean }; reversible: boolean; dataLoss: boolean };
  };
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, 'saas');
  assert.equal(response.body.capabilities.onboardingOpen, true);
  assert.equal(response.body.reversible, true, '★ 明确告知可逆');
  assert.equal(response.body.dataLoss, false, '★ 明确告知不丢数据');
  assert.equal((await settings.get(PLATFORM_MODE_KEY))?.value, 'saas');
});

test('★★ saas → standalone 需要**显式确认**（会隐藏站点 UI、关闭入驻入口）', async () => {
  const { handler, settings } = makeHandler({ mode: 'saas' });
  // ① 不确认 → 返回影响面提示，**不修改**
  const preview = (await call(handler, 'POST', '/api/admin/settings/platform', { mode: 'standalone' })) as {
    status: number;
    body: { requiresConfirmation: boolean; prompt: string; impacts: { description: string }[]; dataLoss: boolean };
  };
  assert.equal(preview.status, 200);
  assert.equal(preview.body.requiresConfirmation, true);
  assert.match(preview.body.prompt, /不会删除任何数据/, '★ 提示要打消「会不会丢数据」的顾虑');
  assert.ok(preview.body.impacts.some((impact) => /隐藏站点/.test(impact.description)));
  assert.equal(preview.body.dataLoss, false);
  assert.equal((await settings.get(PLATFORM_MODE_KEY))?.value, 'saas', '★ 未确认时不得修改');

  // ② 确认后生效
  const applied = (await call(handler, 'POST', '/api/admin/settings/platform', { mode: 'standalone', confirm: true })) as {
    body: { mode: string; reversible: boolean };
  };
  assert.equal(applied.body.mode, 'standalone');
  assert.equal(applied.body.reversible, true);
  assert.equal((await settings.get(PLATFORM_MODE_KEY))?.value, 'standalone');
});

test('非法 mode → 400（不静默接受）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/settings/platform', { mode: 'hybrid' })) as { status: number };
  assert.equal(response.status, 400);
});

test('未知的设置端点 → 404', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'GET', '/api/admin/settings/ghost')) as { status: number };
  assert.equal(response.status, 404);
});
