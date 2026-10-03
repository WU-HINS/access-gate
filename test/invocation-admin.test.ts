/**
 * 插件调用记录验收（P0；docs/06 `/admin/plugins/:id/invocations`）。
 *
 * ★★ 核心：`ag_plugin_invocations` 是**站点级**表（`site_id NOT NULL`）。
 *   本测试最重要的一条是**跨站隔离**——site A 的记录绝不能被 site B 的查询看到。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemoryPluginInvocationStore, type InvocationRecord } from '../src/plugin/invocation-store.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const SITE_A = 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb';

const session = (siteId: string) => ({ userId: 'admin-1', username: 'admin', activeSiteId: siteId, realm: 'developer' as const, role: 'admin' as const });

const invocation = (overrides: Partial<InvocationRecord> = {}): InvocationRecord => ({
  id: 1,
  pluginId: 'demo',
  op: 'facts.read',
  userId: null,
  status: 'ok',
  deniedPermission: null,
  egressHost: null,
  durationMs: 12,
  costTokens: 0,
  error: null,
  traceId: 'tr-1',
  createdAt: new Date(),
  ...overrides,
});

function makeHandler() {
  const invocations = new InMemoryPluginInvocationStore();
  // ★ 给**递增的时间戳**：`orderBy created_at desc` 在时间相同时**本就无确定顺序**，
  //   而依赖顺序的断言会变成 flaky（我第一次就是这么失败的）。
  const t0 = Date.now() - 3000;
  invocations.seed(SITE_A, invocation({ id: 1, status: 'ok', createdAt: new Date(t0) }));
  invocations.seed(SITE_A, invocation({ id: 2, status: 'denied', deniedPermission: 'http:egress:api.github.com', createdAt: new Date(t0 + 1000) }));
  invocations.seed(SITE_A, invocation({ id: 3, status: 'error', error: '上游 500', createdAt: new Date(t0 + 2000) }));
  // ★ site B 的记录——**绝不能**出现在 site A 的查询里
  invocations.seed(SITE_B, invocation({ id: 99, status: 'ok', traceId: 'site-b-trace', createdAt: new Date() }));
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    invocations,
    logger: silentLogger,
  });
  return { handler };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], siteId: string, method: string, path: string, query: Record<string, string> = {}) =>
  handler({ method, path, query, session: session(siteId) } as never);

// ─────────────────────────── ★★ 跨站隔离 ───────────────────────────

test('★★ **跨站隔离**：site A 的查询看不到 site B 的记录', async () => {
  const { handler } = makeHandler();
  const asA = (await call(handler, SITE_A, 'GET', '/api/admin/plugins/demo/invocations')) as {
    status: number;
    body: { siteId: string; invocations: { id: number }[]; summary: Record<string, number> };
  };
  assert.equal(asA.status, 200);
  assert.equal(asA.body.siteId, SITE_A, '★ 回显 siteId，让调用方确认看到的是本站点数据');
  // ★ 用**集合比较**（不依赖顺序）：跨站隔离要看的是「有没有 site B 的数据」，不是排序
  assert.deepEqual([...asA.body.invocations.map((entry) => entry.id)].sort((a, b) => a - b), [1, 2, 3], '★ 只有 site A 的 3 条');
  // ★ 顺带验证排序（时间递增 → id 递减）
  assert.deepEqual(asA.body.invocations.map((entry) => entry.id), [3, 2, 1], '★ 按时间降序');
  assert.equal(asA.body.invocations.some((entry) => entry.id === 99), false, '★★ site B 的记录绝不可见');
  assert.equal(asA.body.summary['ok'], 1, '★ 聚合也按站点隔离');

  // site B 只看到自己的 1 条
  const asB = (await call(handler, SITE_B, 'GET', '/api/admin/plugins/demo/invocations')) as {
    body: { invocations: { id: number }[]; summary: Record<string, number> };
  };
  assert.deepEqual(asB.body.invocations.map((entry) => entry.id), [99]);
  assert.equal(asB.body.summary['ok'], 1);
  assert.equal(asB.body.summary['denied'], 0, '★ site B 没有 denied 记录');
});

// ─────────────────────────── 过滤与聚合 ───────────────────────────

test('★ 按 `status` 过滤；按状态聚合给出 summary', async () => {
  const { handler } = makeHandler();
  const denied = (await call(handler, SITE_A, 'GET', '/api/admin/plugins/demo/invocations', { status: 'denied' })) as {
    body: { invocations: { status: string; deniedPermission: string | null }[]; summary: Record<string, number> };
  };
  assert.equal(denied.body.invocations.length, 1);
  assert.equal(denied.body.invocations[0]!.status, 'denied');
  // ★ `deniedPermission` 是安全排查的关键线索（「缺哪个权限」）
  assert.equal(denied.body.invocations[0]!.deniedPermission, 'http:egress:api.github.com');
  assert.equal(denied.body.summary['denied'], 1, '★ summary 反映**过滤前**的全量分布');
});

test('★ 非法 `status` → 400；非法 `sinceMs` → 400', async () => {
  const { handler } = makeHandler();
  assert.equal(((await call(handler, SITE_A, 'GET', '/api/admin/plugins/demo/invocations', { status: 'ghost' })) as { status: number }).status, 400);
  assert.equal(((await call(handler, SITE_A, 'GET', '/api/admin/plugins/demo/invocations', { sinceMs: '-1' })) as { status: number }).status, 400);
});

test('★ `sinceMs` 只返回时间窗内的记录', async () => {
  const invocations = new InMemoryPluginInvocationStore();
  invocations.seed(SITE_A, invocation({ id: 1, createdAt: new Date(Date.now() - 3_600_000) }));
  invocations.seed(SITE_A, invocation({ id: 2, createdAt: new Date() }));
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    invocations,
    logger: silentLogger,
  });
  const recent = (await call(handler, SITE_A, 'GET', '/api/admin/plugins/demo/invocations', { sinceMs: '60000' })) as {
    body: { invocations: { id: number }[] };
  };
  assert.deepEqual(recent.body.invocations.map((entry) => entry.id), [2], '★ 只返回最近 60 秒内的');
});

test('未启用调用记录存储时 → 501（显式不可用）', async () => {
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
  assert.equal(((await call(handler, SITE_A, 'GET', '/api/admin/plugins/demo/invocations')) as { status: number }).status, 501);
});
