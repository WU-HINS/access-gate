/**
 * 插件 UI 贡献审批验收（P0；docs/06 `/admin/plugins/:id/ui` 系列）。
 *
 * ★★ 核心：`render_mode` 决定风险等级——
 *   `declarative`（宿主渲染，插件不能执行代码）vs
 *   `remote-module` / `iframe`（**引入可执行/远程内容**）。
 *   后者**未审批不得启用**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemoryUiContributionStore, requiresApproval } from '../src/plugin/ui-contribution-store.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ADMIN_SESSION = { userId: 'admin-1', username: 'admin', activeSiteId: 'site-1', realm: 'developer' as const, role: 'admin' as const };

function makeHandler() {
  const uiContributions = new InMemoryUiContributionStore();
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    uiContributions,
    logger: silentLogger,
  });
  return { handler, uiContributions };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], method: string, path: string, body?: unknown) =>
  handler({ method, path, query: {}, body, session: ADMIN_SESSION } as never);

// ─────────────────────────── 风险分级 ───────────────────────────

test('★ `requiresApproval`：只有 `remote-module` / `iframe` 需要审批', () => {
  assert.equal(requiresApproval('declarative'), false, '声明式渲染不引入可执行内容');
  assert.equal(requiresApproval('remote-module'), true, '★ 远程 JS 模块 = 在用户浏览器里跑插件代码');
  assert.equal(requiresApproval('iframe'), true, '★ 第三方内容进入界面');
});

test('★★ `declarative` 注册后**默认启用**；`remote-module` **默认不启用**', async () => {
  const store = new InMemoryUiContributionStore();
  const declarative = await store.register({ pluginId: 'demo', type: 'nav', key: 'nav-1', renderMode: 'declarative' });
  assert.equal(declarative.enabled, true, '声明式渲染可以直接用');

  const remote = await store.register({ pluginId: 'demo', type: 'page', key: 'page-1', renderMode: 'remote-module' });
  assert.equal(remote.enabled, false, '★ 远程渲染默认**不启用**（默认拒绝）');
  assert.equal(remote.approvedBy, null);
});

// ─────────────────────────── ★★ 审批闸门 ───────────────────────────

test('★★ 未审批的 `remote-module` 贡献**不得启用**（409）', async () => {
  const { handler, uiContributions } = makeHandler();
  const registered = await uiContributions.register({ pluginId: 'demo', type: 'page', key: 'page-1', renderMode: 'remote-module' });

  const denied = (await call(handler, 'POST', `/api/admin/plugins/demo/ui/${registered.id}/toggle`)) as {
    status: number;
    body: { error: string };
  };
  assert.equal(denied.status, 409, '★ 未审批不得启用');
  assert.match(denied.body.error, /可执行\/远程内容/);
  assert.match(denied.body.error, /未审批不得启用/);
  // ★ 状态未被改变
  assert.equal((await uiContributions.list('demo')).find((entry) => entry.id === registered.id)?.enabled, false);
});

test('★★ 审批后可以启用；审批会记录审批人与时间', async () => {
  const { handler, uiContributions } = makeHandler();
  const registered = await uiContributions.register({ pluginId: 'demo', type: 'page', key: 'page-1', renderMode: 'iframe' });

  const approved = (await call(handler, 'POST', `/api/admin/plugins/demo/ui/${registered.id}/approve`)) as {
    status: number;
    body: { contribution: { enabled: boolean; approved: boolean } };
  };
  assert.equal(approved.status, 200);
  assert.equal(approved.body.contribution.approved, true);
  assert.equal(approved.body.contribution.enabled, true, '审批即启用');

  const record = (await uiContributions.list('demo')).find((entry) => entry.id === registered.id)!;
  assert.equal(record.approvedBy, 'admin-1', '★ 记录审批人');
  assert.ok(record.approvedAt !== null, '★ 记录审批时间');
});

test('★ 列表标出 `needsApproval` 与待审批计数', async () => {
  const { handler, uiContributions } = makeHandler();
  await uiContributions.register({ pluginId: 'demo', type: 'nav', key: 'nav-1', renderMode: 'declarative' });
  await uiContributions.register({ pluginId: 'demo', type: 'page', key: 'page-1', renderMode: 'remote-module' });
  await uiContributions.register({ pluginId: 'demo', type: 'slot', key: 'slot-1', renderMode: 'iframe' });

  const list = (await call(handler, 'GET', '/api/admin/plugins/demo/ui')) as {
    status: number;
    body: { contributions: { key: string; needsApproval: boolean; enabled: boolean }[]; total: number; pendingApproval: number };
  };
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 3);
  assert.equal(list.body.pendingApproval, 2, '★ 两个远程渲染的待审批');
  const nav = list.body.contributions.find((entry) => entry.key === 'nav-1')!;
  assert.equal(nav.needsApproval, false, '声明式的无需审批');
  assert.equal(nav.enabled, true);
});

// ─────────────────────────── 校验 ───────────────────────────

test('★ `:uid` 必须是 uuid（表主键）→ 非 uuid 返回 400', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/plugins/demo/ui/not-a-uuid/toggle')) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /必须是 uuid/);
});

test('★ 不属于该插件的贡献 → 404（不误改）', async () => {
  const { handler, uiContributions } = makeHandler();
  const registered = await uiContributions.register({ pluginId: 'demo', type: 'page', key: 'p', renderMode: 'declarative' });
  assert.equal(((await call(handler, 'POST', `/api/admin/plugins/other/ui/${registered.id}/approve`)) as { status: number }).status, 404);
});

test('未启用 UI 存储时 → 501（显式不可用）', async () => {
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    logger: silentLogger,
  });
  assert.equal(((await call(handler, 'GET', '/api/admin/plugins/demo/ui')) as { status: number }).status, 501);
});
