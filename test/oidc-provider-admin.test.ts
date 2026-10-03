/**
 * OIDC 提供方注册验收（P0；docs/06 `/admin/oidc` 系列）。
 *
 * ★★ 核心断言：**接口绝不暴露 `clientSecretRef` 的值**。
 *   它虽然是「引用」而非密钥本身，但泄露它会让攻击者知道该去 `ag_secrets` 找什么；
 *   因此只暴露 `hasClientSecret: boolean`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemoryOidcProviderStore } from '../src/auth/oidc-provider-store.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ADMIN_SESSION = { userId: 'admin-1', username: 'admin', activeSiteId: 'site-1', realm: 'developer' as const, role: 'admin' as const };

function makeHandler() {
  const oidcProviders = new InMemoryOidcProviderStore();
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    oidcProviders,
    logger: silentLogger,
  });
  return { handler, oidcProviders };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], method: string, path: string, body?: unknown) =>
  handler({ method, path, query: {}, body, session: ADMIN_SESSION } as never);

const VALID = {
  ref: 'platform:enduser',
  label: '本地 Keycloak',
  direction: 'outbound',
  issuer: 'https://idp.example.com/realms/main',
  clientId: 'access-gate',
  clientSecretRef: 'oidc:platform:enduser:client_secret',
  scopes: ['openid', 'profile', 'email'],
};

// ─────────────────────────── 注册 ───────────────────────────

test('★ 注册 OIDC 提供方；响应**不含**密钥引用值，只给 hasClientSecret', async () => {
  const { handler } = makeHandler();
  const created = (await call(handler, 'POST', '/api/admin/oidc/providers', VALID)) as {
    status: number;
    body: { provider: { ref: string; hasClientSecret: boolean }; note: string };
  };
  assert.equal(created.status, 200);
  assert.equal(created.body.provider.ref, 'platform:enduser');
  assert.equal(created.body.provider.hasClientSecret, true, '★ 只暴露「有没有」，不暴露「是什么」');
  assert.match(created.body.note, /不接受\*\*明文密钥/, '要明确告知密钥通过引用提供');
  assert.equal(JSON.stringify(created.body).includes('oidc:platform:enduser:client_secret'), false, '★ 不得回显引用值');

  // ★ 列表同样不暴露引用值
  const list = (await call(handler, 'GET', '/api/admin/oidc/providers')) as {
    body: { providers: { ref: string; hasClientSecret: boolean }[]; total: number; inactive: string[] };
  };
  assert.equal(list.body.total, 1);
  assert.equal(list.body.providers[0]!.hasClientSecret, true);
  assert.equal(JSON.stringify(list.body).includes('client_secret'), false, '★ 列表也不得泄露引用值');
});

test('★ `direction` 必须显式给出（两者配置与风险面不同）', async () => {
  const { handler, oidcProviders } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/oidc/providers', { ...VALID, direction: undefined })) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /outbound.*inbound|inbound.*outbound/);
  assert.equal((await oidcProviders.list()).length, 0, '校验失败不得留下记录');
});

test('★ `issuer` 必须是 https（OIDC 发现文档要求 TLS）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/oidc/providers', { ...VALID, issuer: 'http://insecure.example.com' })) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /https/);
});

test('★ 缺 ref / label → 400', async () => {
  const { handler } = makeHandler();
  assert.equal(((await call(handler, 'POST', '/api/admin/oidc/providers', { ...VALID, ref: '' })) as { status: number }).status, 400);
  assert.equal(((await call(handler, 'POST', '/api/admin/oidc/providers', { ...VALID, label: '' })) as { status: number }).status, 400);
});

// ─────────────────────────── 幂等与更新 ───────────────────────────

test('★ 按 `ref` 幂等：重复注册同一 ref → **更新**而不是新增行', async () => {
  const { handler, oidcProviders } = makeHandler();
  await call(handler, 'POST', '/api/admin/oidc/providers', VALID);
  const second = (await call(handler, 'POST', '/api/admin/oidc/providers', { ...VALID, label: '改名后的 Keycloak' })) as {
    status: number;
    body: { provider: { ref: string } };
  };
  assert.equal(second.status, 200);
  const all = await oidcProviders.list();
  assert.equal(all.length, 1, '★ 同一 ref 只有一条记录');
  assert.equal(all[0]!.label, '改名后的 Keycloak', '★ 是更新而非新增');
});

test('★ `PUT /:ref` 更新；不存在的 ref → 404', async () => {
  const { handler, oidcProviders } = makeHandler();
  await call(handler, 'POST', '/api/admin/oidc/providers', VALID);
  const updated = (await call(handler, 'PUT', '/api/admin/oidc/providers/platform:enduser', { label: '新标签' })) as {
    status: number;
    body: { provider: { ref: string } };
  };
  assert.equal(updated.status, 200);
  // ★ 未提供的字段保持原值（PUT 语义为「部分更新」，但要显式说明）
  assert.equal((await oidcProviders.findByRef('platform:enduser'))?.scopes.length, 3, '未提供的字段保持原值');

  assert.equal(((await call(handler, 'PUT', '/api/admin/oidc/providers/ghost', { label: 'x' })) as { status: number }).status, 404);
});

test('★ `allowPlatformLogin` 默认 false（平台登录是敏感能力，不默认开启）', async () => {
  const { handler, oidcProviders } = makeHandler();
  await call(handler, 'POST', '/api/admin/oidc/providers', VALID);
  assert.equal((await oidcProviders.findByRef('platform:enduser'))?.allowPlatformLogin, false);
});

test('未启用 OIDC 存储时不挂载（404，而不是返回空列表）', async () => {
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    logger: silentLogger,
  });
  assert.equal(((await call(handler, 'GET', '/api/admin/oidc/providers')) as { status: number }).status, 404);
});

// ─────────────────────────── ★★ issuer 唯一约束（文档已声明，DDL 已存在）───────────────────────────

test('★★ 同一 `issuer` 被两个 ref 注册 → **拒绝**（同一 IdP 不应有两个 ref）', async () => {
  const { handler, oidcProviders } = makeHandler();
  await call(handler, 'POST', '/api/admin/oidc/providers', VALID);

  // 换一个 ref，但 issuer 相同
  const conflict = (await call(handler, 'POST', '/api/admin/oidc/providers', {
    ...VALID,
    ref: 'platform:developer',
  })) as { status: number; body: { error: string } };

  // ★ 两个实现同语义：内存实现也模拟了 `uq_ag_oidc_providers_issuer`
  //   （否则「内存通过、真实 409」会成为又一处语义漂移）
  assert.equal(conflict.status, 409, '★ 同一 issuer 不得有两个 ref');
  assert.match(conflict.body.error, /同一 IdP/);
  assert.equal((await oidcProviders.list()).length, 1, '冲突时不得新增记录');
});

test('★★ 真实 PG 的 issuer 唯一约束确实存在（文档声明 + DDL 一致）', async () => {
  const { readFile } = await import('node:fs/promises');
  const ddl = await readFile(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
  assert.match(ddl, /uq_ag_oidc_providers_ref ON ag_oidc_providers \(ref\)/, '★ ref 唯一约束必须存在');
  assert.match(ddl, /uq_ag_oidc_providers_issuer ON ag_oidc_providers \(issuer\)/, '★ issuer 唯一约束必须存在');
  // ★ 教训：我上一轮用 `grep | head -5` 查证，**只看到前几条索引就下结论「没有唯一约束」**。
  //   这个测试用 `match`（全量扫描）而非截断输出，避免同类错误。
});
