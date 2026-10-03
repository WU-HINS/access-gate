/**
 * 插件管理端点验收（P0；docs/06 的 `/admin/plugins` 系列）。
 *
 * ★ 核心断言是 **M4-5 的验收标准**：「未勾选后端信任 → `enable` 被拒」。
 *   后端代码在宿主进程中运行（可读数据、可出网、可改状态），
 *   一旦跑起来风险就已经发生——因此这道门禁必须在**接口层**强制，
 *   而不是靠 UI 置灰。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemoryPlatformSettingsStore } from '../src/app/platform-mode.ts';
import { InMemoryPluginConfigStore } from '../src/plugin/config-store.ts';
import { EndpointRouteConflict, InMemoryPluginEndpointStore } from '../src/plugin/endpoint-store.ts';
import { InMemoryPluginGrantStore } from '../src/plugin/grant-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ADMIN_SESSION = { userId: 'admin-1', username: 'admin', activeSiteId: 'site-1', realm: 'developer' as const, role: 'admin' as const };

/**
 * ★ `extra` 用于覆盖/补充 deps（R94 起需要注入 `pluginRuntime` / `builtinManifests`）。
 * ★ 默认参数保证**既有调用点全部不变**（向后兼容）。
 */
function makeHandler(extra: Record<string, unknown> = {}) {
  const plugins = new InMemoryPluginStore();
  const grants = new InMemoryPluginGrantStore();
  const handler = createAdminHandler({
    ...extra,
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: {
      list: async () => [],
      get: async () => undefined,
      versions: async () => [],
    } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins,
    grants,
    logger: silentLogger,
  });
  return { handler, plugins, grants };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], method: string, path: string, body?: unknown, query?: Record<string, string>) =>
  handler({ method, path, query, body, session: ADMIN_SESSION } as never);

const MANIFEST = {
  apiVersion: 'gate.plugin/v1',
  kind: 'channel',
  id: 'demo',
  name: '示例插件',
  version: '1.0.0',
  runtime: 'declarative',
  namespace: 'demo',
  // ★ `declarative` 且非 local 时必须声明 `collect`——
  //   否则「插件什么也不做」（校验规则本身很合理：它抓的是「声明了却不做事」的插件）。
  collect: { request: { method: 'GET', url: 'https://example.invalid/x' }, extract: [{ path: '$.n', as: 'n' }] },
};

// ─────────────────────────── 列表与详情 ───────────────────────────

test('★ GET /api/admin/plugins 列出插件（含「不可信却已启用」的告警字段）', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });

  const response = (await call(handler, 'GET', '/api/admin/plugins')) as { status: number; body: { plugins: unknown[]; total: number; untrustedEnabled: string[] } };
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.plugins.length, 1);
  // ★ 尚未启用 → 不在告警列表里
  assert.deepEqual(response.body.untrustedEnabled, []);
});

test('★ GET /api/admin/plugins?kind=... 支持按类型过滤', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  await plugins.install({ manifest: { ...MANIFEST, id: 'enr', kind: 'enricher', namespace: 'enr' } as never, source: 'uploaded' });

  const channels = (await call(handler, 'GET', '/api/admin/plugins', undefined, { kind: 'channel' })) as { body: { total: number } };
  assert.equal(channels.body.total, 1, '只应返回 channel 类型');
  const all = (await call(handler, 'GET', '/api/admin/plugins')) as { body: { total: number } };
  assert.equal(all.body.total, 2);
});

test('GET /api/admin/plugins/:id 返回详情；不存在 → 404', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  const found = (await call(handler, 'GET', '/api/admin/plugins/demo')) as { status: number; body: { plugin: { id: string; namespace: string } } };
  assert.equal(found.status, 200);
  assert.equal(found.body.plugin.namespace, 'demo');

  const missing = (await call(handler, 'GET', '/api/admin/plugins/ghost')) as { status: number };
  assert.equal(missing.status, 404, '不存在的插件应 404（而不是返回空对象）');
});

// ─────────────────────────── 安装 ───────────────────────────

test('POST /api/admin/plugins/install 安装插件；缺 manifest.id → 400', async () => {
  const { handler } = makeHandler();
  const okResponse = (await call(handler, 'POST', '/api/admin/plugins/install', { manifest: MANIFEST })) as { status: number; body: { plugin: { id: string; status: string } } };
  assert.equal(okResponse.status, 200);
  assert.equal(okResponse.body.plugin.id, 'demo');
  assert.equal(okResponse.body.plugin.status, 'installed', '安装后未启用');

  const bad = (await call(handler, 'POST', '/api/admin/plugins/install', { manifest: { name: '无 id' } })) as { status: number };
  assert.equal(bad.status, 400);
});

// ─────────────────────────── ★★ M4-5 门禁 ───────────────────────────

test('★★ 未获得后端信任时 `enable` 被拒（403）—— M4-5 的验收标准', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });

  const denied = (await call(handler, 'POST', '/api/admin/plugins/demo/enable')) as { status: number; body: { error: string } };
  assert.equal(denied.status, 403, '★ 未信任不得启用');
  assert.match(denied.body.error, /后端信任/);
  assert.match(denied.body.error, /可读数据、可出网、可改状态/, '错误信息要说明风险');
  // ★ 状态未被改变
  assert.equal((await plugins.get('demo'))?.status, 'installed');
});

test('★ 前端信任**不能**代替后端信任（两者风险面不同）', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  await call(handler, 'POST', '/api/admin/plugins/demo/trust', { scope: 'frontend', trusted: true });

  const denied = (await call(handler, 'POST', '/api/admin/plugins/demo/enable')) as { status: number };
  assert.equal(denied.status, 403, '★ 只确认前端信任仍不能启用');

  // 确认后端信任后可启用
  await call(handler, 'POST', '/api/admin/plugins/demo/trust', { scope: 'backend', trusted: true });
  const enabled = (await call(handler, 'POST', '/api/admin/plugins/demo/enable')) as { status: number; body: { plugin: { status: string } } };
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.plugin.status, 'enabled');
  assert.deepEqual(await plugins.enabledIds(), ['demo']);
});

test('★ `trust` 必须显式给出 scope（不可合并后端/前端）', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  const bad = (await call(handler, 'POST', '/api/admin/plugins/demo/trust', { trusted: true })) as { status: number; body: { error: string } };
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /风险面不同/);
});

test('★ 撤销后端信任 → 插件**自动停用**（不让不可信插件继续跑）', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  await call(handler, 'POST', '/api/admin/plugins/demo/trust', { scope: 'backend', trusted: true });
  await call(handler, 'POST', '/api/admin/plugins/demo/enable');
  assert.deepEqual(await plugins.enabledIds(), ['demo']);

  const revoked = (await call(handler, 'POST', '/api/admin/plugins/demo/trust', { scope: 'backend', trusted: false })) as { status: number; body: { plugin: { status: string } } };
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.plugin.status, 'disabled', '★ 撤销后端信任必须一并停用');
  assert.deepEqual(await plugins.enabledIds(), []);
});

test('★ 未启用却不可信不会告警；**已启用却不可信**会出现在告警列表里', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  // 绕过接口直接置为 enabled（模拟「历史上启用过、后来信任被清掉」）
  await plugins.setStatus('demo', 'enabled');
  const response = (await call(handler, 'GET', '/api/admin/plugins')) as { body: { untrustedEnabled: string[] } };
  assert.deepEqual(response.body.untrustedEnabled, ['demo'], '★ 危险状态必须显式暴露给运维');
});

// ─────────────────────────── disable ───────────────────────────

test('POST /api/admin/plugins/:id/disable 停用；不存在的插件 → 404', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  await plugins.setStatus('demo', 'enabled');
  const disabled = (await call(handler, 'POST', '/api/admin/plugins/demo/disable')) as { status: number; body: { plugin: { status: string } } };
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.plugin.status, 'disabled');

  const missing = (await call(handler, 'POST', '/api/admin/plugins/ghost/disable')) as { status: number };
  assert.equal(missing.status, 404);
});

// ─────────────────────────── ★★ 权限授予（声明 ≠ 授予）───────────────────────────

test('★★ `GET /grants` 区分「已授予」与「待批准」——声明 ≠ 授予', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({
    manifest: { ...MANIFEST, permissions: ['llm:invoke', 'http:egress', 'cache:write:self'] } as never,
    source: 'uploaded',
  });

  const before = (await call(handler, 'GET', '/api/admin/plugins/demo/grants')) as {
    status: number;
    body: { declared: string[]; granted: string[]; pending: string[]; revoked: unknown[] };
  };
  assert.equal(before.status, 200);
  assert.equal(before.body.declared.length, 3);
  assert.deepEqual(before.body.granted, [], '安装后尚无任何授权');
  assert.equal(before.body.pending.length, 3, '★ 声明了但未批准 = 待批准');
  // ★★ 文档 §4.3：授予是**逐项、可撤销**的，因此响应里也有 revoked 历史
  assert.deepEqual(before.body.revoked, [], '尚未撤销过任何权限');
});

test('★ `POST /grants` 逐项授予；`DELETE` 撤销', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: { ...MANIFEST, permissions: ['llm:invoke', 'http:egress'] } as never, source: 'uploaded' });

  const granted = (await call(handler, 'POST', '/api/admin/plugins/demo/grants', { permissions: ['llm:invoke'] })) as {
    status: number;
    body: { granted: string[]; pending: string[] };
  };
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.body.granted, ['llm:invoke']);
  assert.deepEqual(granted.body.pending, ['http:egress'], '未授予的仍是待批准');

  // 幂等：重复授予不报错、不重复
  const again = (await call(handler, 'POST', '/api/admin/plugins/demo/grants', { permissions: ['llm:invoke'] })) as { body: { granted: string[] } };
  assert.deepEqual(again.body.granted, ['llm:invoke'], '重复授予应幂等');

  // 撤销（★ 软撤销）
  const revoked = (await call(handler, 'DELETE', '/api/admin/plugins/demo/grants/llm:invoke')) as {
    status: number;
    body: { granted: string[]; revokedAt: string | null; note: string };
  };
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body.granted, [], '★ 已撤销的权限不再出现在 granted 里');
  assert.ok(revoked.body.revokedAt !== null, '★ 记录撤销时间');
  assert.match(revoked.body.note, /已软撤销/);
  assert.match(revoked.body.note, /历史保留/, '★ 说明「行没被删掉」');

  // ★★ 历史保留：GET 的 revoked 列表里能看到它（这是「谁在什么时候撤的」的答案）
  const afterRevoke = (await call(handler, 'GET', '/api/admin/plugins/demo/grants')) as {
    body: { revoked: { permission: string; revokedAt: string }[]; granted: string[] };
  };
  assert.equal(afterRevoke.body.revoked.length, 1, '★ 软撤销后历史仍在');
  assert.equal(afterRevoke.body.revoked[0]!.permission, 'llm:invoke');
  assert.deepEqual(afterRevoke.body.granted, []);

  // ★★ 重新授予已撤销的权限 → 清除撤销标记
  const regranted = (await call(handler, 'POST', '/api/admin/plugins/demo/grants', { permissions: ['llm:invoke'] })) as { body: { granted: string[] } };
  assert.deepEqual(regranted.body.granted, ['llm:invoke'], '★ 可以重新授予（唯一约束 + ON CONFLICT 清撤销标记）');
});


test('★★ 不得授予**未声明**的权限（否则「声明」形同虚设）', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: { ...MANIFEST, permissions: ['llm:invoke'] } as never, source: 'uploaded' });

  const denied = (await call(handler, 'POST', '/api/admin/plugins/demo/grants', { permissions: ['llm:invoke', 'storage:write:self'] })) as {
    status: number;
    body: { error: string };
  };
  assert.equal(denied.status, 400, '★ 未声明的权限不得授予');
  assert.match(denied.body.error, /不得授予未声明的权限/);
  assert.match(denied.body.error, /声明是授予的前提/);
  // ★ 整批都不生效（不做「部分授予」——那会让调用方误以为全成功了）
  const after = (await call(handler, 'GET', '/api/admin/plugins/demo/grants')) as { body: { granted: string[] } };
  assert.deepEqual(after.body.granted, [], '★ 批量中有一项非法时整批拒绝');
});

test('缺少 permissions 数组 → 400；撤销空权限名 → 400', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  assert.equal(((await call(handler, 'POST', '/api/admin/plugins/demo/grants', {})) as { status: number }).status, 400);
  assert.equal(((await call(handler, 'DELETE', '/api/admin/plugins/demo/grants/')) as { status: number }).status, 400);
});

// ─────────────────────────── manifest 校验 ───────────────────────────

test('★ `POST /validate` 校验 manifest（合法 → valid；缺字段 → 列出 errors）', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  const good = (await call(handler, 'POST', '/api/admin/plugins/demo/validate')) as { status: number; body: { valid: boolean; errors: unknown[] } };
  assert.equal(good.status, 200);
  assert.equal(good.body.valid, true);
  assert.deepEqual(good.body.errors, []);

  // ★ 装一个**看似合法但实际什么也不做**的 manifest：
  //   `declarative` 却没有 `collect` —— 校验规则应抓出它。
  await plugins.install({
    manifest: { apiVersion: 'gate.plugin/v1', kind: 'channel', id: 'bad', name: '坏插件', version: '1.0.0', runtime: 'declarative', namespace: 'bad' } as never,
    source: 'uploaded',
  });
  const bad = (await call(handler, 'POST', '/api/admin/plugins/bad/validate')) as { status: number; body: { valid: boolean; errors: { message: string }[] } };
  assert.equal(bad.status, 200, '校验失败本身不是 HTTP 错误——它返回诊断结果');
  assert.equal(bad.body.valid, false);
  assert.ok(bad.body.errors.length > 0, '应列出具体问题');
});

// ─────────────────────────── ★★ 路由顺序 ───────────────────────────

test('★★ `GET /plugins/registry` **不被 `/:id` 捕获**（路由顺序陷阱）', async () => {
  const settings = new InMemoryPlatformSettingsStore();
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    settings,
    builtinManifests: [{ id: 'email', name: '邮箱域', version: '1.0.0', kind: 'channel' }],
    logger: silentLogger,
  });

  const response = (await call(handler, 'GET', '/api/admin/plugins/registry')) as {
    status: number;
    body: { available: { id: string; installed: boolean }[]; total: number };
  };
  // ★ 若顺序写反，这里会是 404「插件 'registry' 未安装」
  assert.equal(response.status, 200, '★ `registry` 是固定路径，不能被 `/:id` 吃掉');
  assert.equal(response.body.total, 1);
  assert.deepEqual(response.body.available[0], { id: 'email', name: '邮箱域', version: '1.0.0', kind: 'channel', installed: false });
});

test('★ `GET /plugins/registry` 标出「已安装」（供运维区分「可装」与「已装」）', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  const response = (await call(handler, 'GET', '/api/admin/plugins/registry')) as { status: number; body: { available: unknown[] } };
  // 未提供 builtinManifests → 空清单（但端点可用）
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.available, []);
});

// ─────────────────────────── 撤销信任（DELETE 路径形式）───────────────────────────

test('★ `DELETE /plugins/:id/trust/:scope` 撤销信任（与 POST 同源）', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  await call(handler, 'POST', '/api/admin/plugins/demo/trust', { scope: 'backend', trusted: true });
  await call(handler, 'POST', '/api/admin/plugins/demo/enable');
  assert.deepEqual(await plugins.enabledIds(), ['demo']);

  const revoked = (await call(handler, 'DELETE', '/api/admin/plugins/demo/trust/backend')) as {
    status: number;
    body: { plugin: { status: string } };
  };
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.plugin.status, 'disabled', '★ DELETE 撤销后端信任同样要一并停用');
  assert.deepEqual(await plugins.enabledIds(), []);

  // 非法 scope → 不匹配该正则 → 落到别的分支（最终 404）
  const bad = (await call(handler, 'DELETE', '/api/admin/plugins/demo/trust/ghost')) as { status: number };
  assert.equal(bad.status, 404);
});

// ─────────────────────────── 依赖（卸载前安全检查）───────────────────────────

test('★★ `GET /plugins/:id/dependents` 给出「能否安全卸载」的判断', async () => {
  const { handler, plugins } = makeHandler();
  // 下游插件消费 `demo.pr_list`
  await plugins.install({ manifest: { ...MANIFEST, id: 'demo', namespace: 'demo' } as never, source: 'uploaded' });
  await plugins.install({
    manifest: { ...MANIFEST, id: 'reviewer', namespace: 'reviewer', consumes: ['demo.pr_list'] } as never,
    source: 'uploaded',
  });

  const withDeps = (await call(handler, 'GET', '/api/admin/plugins/demo/dependents')) as {
    status: number;
    body: { dependents: { id: string; consumes: string[] }[]; safeToRemove: boolean; note: string };
  };
  assert.equal(withDeps.status, 200);
  assert.equal(withDeps.body.dependents.length, 1);
  assert.equal(withDeps.body.dependents[0]!.id, 'reviewer');
  assert.deepEqual(withDeps.body.dependents[0]!.consumes, ['demo.pr_list']);
  assert.equal(withDeps.body.safeToRemove, false, '★ 有依赖时不得声称可以安全卸载');
  assert.match(withDeps.body.note, /会破坏/);

  // 无依赖的插件 → 可安全卸载
  const noDeps = (await call(handler, 'GET', '/api/admin/plugins/reviewer/dependents')) as { body: { safeToRemove: boolean } };
  assert.equal(noDeps.body.safeToRemove, true);
});

test('`GET /plugins/:id/dependents` 对不存在的插件 → 404', async () => {
  const { handler } = makeHandler();
  assert.equal(((await call(handler, 'GET', '/api/admin/plugins/ghost/dependents')) as { status: number }).status, 404);
});

// ─────────────────────────── 插件配置（版本化）───────────────────────────

test('★★ `PUT /config` 写入配置并**版本递增**；`GET /config/versions` 列出历史', async () => {
  const { handler, plugins } = makeHandler();
  const configs = new InMemoryPluginConfigStore();
  // 重新构造一个带 configs 的 handler
  const handler2 = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins,
    configs,
    logger: silentLogger,
  });
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });

  // ① 第一次写
  const first = (await call(handler2, 'PUT', '/api/admin/plugins/demo/config', { config: { token: 'abc', scope: 'repo' } })) as {
    status: number;
    body: { version: number; configHash: string; status: string };
  };
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 1, '首次写入是 v1');
  assert.equal(first.body.status, 'active');
  assert.equal(first.body.configHash.length, 32);

  // ② 第二次写 → v2，且 v1 变 archived
  const second = (await call(handler2, 'PUT', '/api/admin/plugins/demo/config', { config: { token: 'xyz' } })) as { body: { version: number } };
  assert.equal(second.body.version, 2, '★ 每次写入产生新版本（配置是版本化的）');

  const history = (await call(handler2, 'GET', '/api/admin/plugins/demo/config/versions')) as {
    status: number;
    body: { versions: { version: number; status: string }[]; latest: number | null };
  };
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.versions.map((entry) => entry.version), [2, 1], '倒序返回');
  assert.equal(history.body.versions[0]!.status, 'active');
  assert.equal(history.body.versions[1]!.status, 'archived', '★ 旧版本被归档');
  assert.equal(history.body.latest, 2);

  // ③ ★ 版本列表**不回传完整配置**（可能含密钥）
  assert.equal(JSON.stringify(history.body).includes('abc'), false, '★ 历史列表不得泄露配置内容');
  assert.equal(JSON.stringify(history.body).includes('xyz'), false);

  // ④ 读当前配置（这里才回传内容）
  const current = (await call(handler2, 'GET', '/api/admin/plugins/demo/config')) as { body: { version: number; config: Record<string, unknown> } };
  assert.equal(current.body.version, 2);
  assert.deepEqual(current.body.config, { token: 'xyz' });
});

test('配置端点：缺 config 对象 → 400；未启用配置存储 → 501；插件不存在 → 404', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });

  // 未提供 configs → 501（显式「不可用」，而不是静默成功）
  const notEnabled = (await call(handler, 'PUT', '/api/admin/plugins/demo/config', { config: { a: 1 } })) as { status: number };
  assert.equal(notEnabled.status, 501);

  const configs = new InMemoryPluginConfigStore();
  const handler2 = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins,
    configs,
    logger: silentLogger,
  });
  assert.equal(((await call(handler2, 'PUT', '/api/admin/plugins/demo/config', { config: [1, 2] })) as { status: number }).status, 400, '数组不是合法配置');
  assert.equal(((await call(handler2, 'PUT', '/api/admin/plugins/ghost/config', { config: { a: 1 } })) as { status: number }).status, 404);
});

// ─────────────────────────── 插件端点（冲突检测 + 审批）───────────────────────────

test('★★ 路由冲突被检出：两个插件**不得注册同一 method+path**（文档 §1.13.5）', async () => {
  const store = new InMemoryPluginEndpointStore();
  await store.register({ pluginId: 'a', method: 'POST', path: '/webhook/x', mountPath: '/api/plugins/a/webhook/x', auth: 'hmac' });

  // 同一作用域（默认 platform/platform）下的同一 method+path → 冲突
  await assert.rejects(
    store.register({ pluginId: 'b', method: 'POST', path: '/webhook/x', mountPath: '/api/plugins/a/webhook/x', auth: 'none' }),
    (error: unknown) => {
      assert.ok(error instanceof EndpointRouteConflict);
      assert.match(error.message, /路由冲突/);
      assert.match(error.message, /两个插件不得注册同一 method\+path/);
      return true;
    },
  );

  // 不同 mount_path → 不冲突
  await store.register({ pluginId: 'b', method: 'POST', path: '/webhook/x', mountPath: '/api/plugins/b/webhook/x', auth: 'none' });
  // 不同 method → 不冲突
  await store.register({ pluginId: 'c', method: 'GET', path: '/webhook/x', mountPath: '/api/plugins/a/webhook/x', auth: 'none' });
  assert.equal((await store.list('a')).length, 1);
  assert.equal((await store.list('b')).length, 1);
});

test('★ 端点列表标出 `needsApproval`（未审批端点是插件对外暴露的攻击面）', async () => {
  const { handler, plugins } = makeHandler();
  const endpoints = new InMemoryPluginEndpointStore();
  const handler2 = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins,
    endpoints,
    logger: silentLogger,
  });
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  const registered = await endpoints.register({ pluginId: 'demo', method: 'POST', path: '/webhook/x', mountPath: '/api/plugins/demo/webhook/x', auth: 'hmac' });

  const list = (await call(handler2, 'GET', '/api/admin/plugins/demo/endpoints')) as {
    status: number;
    body: { endpoints: { id: string; needsApproval: boolean; enabled: boolean }[]; pendingApproval: number };
  };
  assert.equal(list.status, 200);
  // ★ 断言要**有意义**：不能写成 `x === undefined ? ... : x` 这种恒真式
  //   （那是我在赶时间时写出的坏断言——它永远通过，毫无价值）
  assert.equal(list.body.endpoints.length, 1);
  assert.equal(list.body.endpoints[0]!.enabled, true, '注册后默认启用');
  assert.equal(list.body.endpoints[0]!.needsApproval, true, '★ 未审批必须显眼');
  assert.equal(list.body.pendingApproval, 1);

  // 审批后不再需要审批
  const approved = (await call(handler2, 'POST', `/api/admin/plugins/demo/endpoints/${registered.id}/approve`)) as { status: number; body: { endpoint: { approved: boolean } } };
  assert.equal(approved.status, 200);
  assert.equal(approved.body.endpoint.approved, true);
  const after = (await call(handler2, 'GET', '/api/admin/plugins/demo/endpoints')) as { body: { pendingApproval: number } };
  assert.equal(after.body.pendingApproval, 0);
});

test('★ `toggle` 可**单独禁用**某个端点（不必禁用整个插件）', async () => {
  const { plugins } = makeHandler();
  const endpoints = new InMemoryPluginEndpointStore();
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins,
    endpoints,
    logger: silentLogger,
  });
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  const registered = await endpoints.register({ pluginId: 'demo', method: 'POST', path: '/x', mountPath: '/api/plugins/demo/x', auth: 'none' });

  const toggled = (await call(handler, 'POST', `/api/admin/plugins/demo/endpoints/${registered.id}/toggle`)) as { status: number; body: { endpoint: { enabled: boolean } } };
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.endpoint.enabled, false, '★ 默认 true → 翻转成 false');
  // 插件本身仍是 installed（端点禁用不影响插件状态）
  assert.equal((await plugins.get('demo'))?.status, 'installed');

  // 端点不属于该插件 → 404
  const wrong = (await call(handler, 'POST', '/api/admin/plugins/other/endpoints/x/toggle')) as { status: number };
  assert.equal(wrong.status, 404);
});

test('未启用端点存储 → 501（显式不可用，而不是返回空列表）', async () => {
  const { handler, plugins } = makeHandler();
  await plugins.install({ manifest: MANIFEST as never, source: 'uploaded' });
  assert.equal(((await call(handler, 'GET', '/api/admin/plugins/demo/endpoints')) as { status: number }).status, 501);
});

// ─────────────────────────── ★ P1-1：插件运行时接线（手动触发采集）───────────────────────────

test('★ `POST /:id/collect` 未装配编排器 → 501（显式不可用）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/plugins/demo/collect', { userId: '11111111-1111-7111-a111-111111111111' })) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 501);
  assert.match(response.body.error, /未装配插件运行时编排器/);
});

test('★ `POST /:id/collect` 缺 `userId` → 400（★ 事实按主体存，不存在「平台级事实」）', async () => {
  const { handler } = makeHandler({ pluginRuntime: { runOnce: async () => ({}) } as never, builtinManifests: [{ id: 'github' }] });
  const response = (await call(handler, 'POST', '/api/admin/plugins/github/collect', {})) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /缺少 userId/);
  // ★ 错误信息里点明「开发者级插件记在谁名下」仍是待决策问题
  assert.match(response.body.error, /待决策|architecture-gaps/);
});

test('★ `POST /:id/collect` 非内置插件 → 404（本端点只支持内置声明式插件）', async () => {
  const { handler } = makeHandler({ pluginRuntime: { runOnce: async () => ({}) } as never, builtinManifests: [{ id: 'github' }] });
  const response = (await call(handler, 'POST', '/api/admin/plugins/external-thing/collect', { userId: '11111111-1111-7111-a111-111111111111' })) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 404);
  assert.match(response.body.error, /未找到内置插件/);
});

test('★ `POST /:id/collect` 命中内置插件 → 调编排器并回传结果（★ 接线真的通了）', async () => {
  const seen: { manifestId?: string; userId?: string } = {};
  const { handler } = makeHandler({
    builtinManifests: [{ id: 'github' }],
    pluginRuntime: {
      runOnce: async (manifest: { id: string }, overrides: { userId: string }) => {
        seen.manifestId = manifest.id;
        seen.userId = overrides.userId;
        return { pluginId: manifest.id, ok: true, written: ['github.public_repos'], status: 200, extracted: [], error: null, durationMs: 7 };
      },
    } as never,
  });
  const USER = '11111111-1111-7111-a111-111111111111';
  const response = (await call(handler, 'POST', '/api/admin/plugins/github/collect', { userId: USER })) as {
    status: number;
    body: { ok: boolean; written: string[]; status: number };
  };
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.written, ['github.public_repos'], '★ 回传写入的事实字段');
  assert.equal(seen.manifestId, 'github', '★ 编排器收到了正确的插件清单');
  assert.equal(seen.userId, USER, '★ 主体按次传入（不依赖构造时的默认值）');
});

// ─────────────────────────── ★ 插件实例管理端点（R105）───────────────────────────

test('★ `GET /:id/instances` 未装配存储 → 501（显式不可用）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'GET', '/api/admin/plugins/github/instances')) as { status: number; body: { error: string } };
  assert.equal(response.status, 501);
  assert.match(response.body.error, /未装配插件实例存储/);
});

test('★ `PUT /:id/instances` 缺 `developerId` → 400（当前只支持开发者级实例）', async () => {
  const { handler } = makeHandler({ pluginInstances: { listByPlugin: async () => [], saveDeveloperInstance: async () => undefined } });
  const response = (await call(handler, 'PUT', '/api/admin/plugins/github/instances', { config: {} })) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /缺少 developerId/);
});

test('★ `PUT /:id/instances` 缺 `config` → 400', async () => {
  const { handler } = makeHandler({ pluginInstances: { listByPlugin: async () => [], saveDeveloperInstance: async () => undefined } });
  const response = (await call(handler, 'PUT', '/api/admin/plugins/github/instances', {
    developerId: '11111111-1111-7111-a111-111111111111',
  })) as { status: number; body: { error: string } };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /缺少 config/);
});

test('★★ `PUT /:id/instances` 保存实例并回传 configHash；**缺省不启用**', async () => {
  const seen: { pluginId?: string; developerId?: string; enabled?: boolean } = {};
  const { handler } = makeHandler({
    pluginInstances: {
      listByPlugin: async () => [],
      saveDeveloperInstance: async (input: { pluginId: string; developerId: string; enabled: boolean }) => {
        seen.pluginId = input.pluginId;
        seen.developerId = input.developerId;
        seen.enabled = input.enabled;
      },
    },
  });
  const DEV = '11111111-1111-7111-a111-111111111111';
  const response = (await call(handler, 'PUT', '/api/admin/plugins/github/instances', {
    developerId: DEV,
    config: { username: 'octocat' },
  })) as { status: number; body: { enabled: boolean; configHash: string } };
  assert.equal(response.status, 200);
  assert.equal(seen.pluginId, 'github');
  assert.equal(seen.developerId, DEV);
  // ★ 缺省不启用（与表默认值一致：显式启用才参与自动调度）
  assert.equal(seen.enabled, false, '★ 缺省不启用');
  assert.equal(response.body.enabled, false);
  assert.equal(response.body.configHash.length, 64, '★ 回传配置哈希（便于确认写入的是哪份配置）');
});

test('★★★ `GET /:id/instances` **脱敏配置里的密钥**（token 不得回显）', async () => {
  const { handler } = makeHandler({
    pluginInstances: {
      listByPlugin: async () => [
        {
          id: '11111111-1111-7111-a111-111111111111',
          pluginId: 'github',
          instanceKey: 'default',
          scope: 'developer' as const,
          developerId: '22222222-2222-7222-a222-222222222222',
          siteId: null,
          label: null,
          // ★ 配置里有 PAT —— 绝不能在管理端明文回显
          config: { username: 'octocat', token: 'ghp_supersecret123' },
          configHash: 'h',
          enabled: true,
        },
      ],
      saveDeveloperInstance: async () => undefined,
    },
  });
  const response = (await call(handler, 'GET', '/api/admin/plugins/github/instances')) as {
    status: number;
    body: { instances: { config: Record<string, unknown> }[]; total: number };
  };
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  const text = JSON.stringify(response.body);
  assert.equal(text.includes('ghp_supersecret123'), false, '★★★ token 绝不能回显');
  assert.equal(text.includes('[已脱敏]'), true, '★ 应标记为已脱敏');
  // ★ 非密钥字段保留
  assert.equal(text.includes('octocat'), true);
});
