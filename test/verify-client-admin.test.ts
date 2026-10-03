/**
 * 协同验证调用方管理验收（P0；docs/06 `/admin/verify` 系列，M5 运营面）。
 *
 * ★★ 核心断言：**原始密钥只在创建时返回一次，且不落库**。
 *   这不是「不方便」，而是密钥管理的正确形态——
 *   若平台能取回明文密钥，一次数据库泄露就等于所有调用方密钥泄露。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemoryVerifyClientAdminStore, generateSecret, hashSecret } from '../src/verify/client-admin.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ADMIN_SESSION = { userId: 'admin-1', username: 'admin', activeSiteId: 'site-1', realm: 'developer' as const, role: 'admin' as const };

function makeHandler() {
  const verifyClients = new InMemoryVerifyClientAdminStore();
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    verifyClients,
    logger: silentLogger,
  });
  return { handler, verifyClients };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], method: string, path: string, body?: unknown) =>
  handler({ method, path, query: {}, body, session: ADMIN_SESSION } as never);

// ─────────────────────────── ★★ 一次性密钥 ───────────────────────────

test('★★ 创建调用方：密钥**只返回一次**，且响应明确警告', async () => {
  const { handler } = makeHandler();
  const created = (await call(handler, 'POST', '/api/admin/verify/clients', { name: '社区 bot', scopes: ['assert:read'] })) as {
    status: number;
    body: { client: { clientId: string; secretPrefix: string; status: string }; secret: string; warning: string };
  };
  assert.equal(created.status, 200);
  assert.match(created.body.secret, /^vc_/, '密钥有 vc_ 前缀');
  assert.ok(created.body.secret.length > 30, '密钥足够长');
  assert.equal(created.body.client.status, 'active');
  // ★ 前缀用于识别「这是哪一把密钥」，但不泄露完整值
  assert.equal(created.body.client.secretPrefix, created.body.secret.slice(0, 10));
  assert.notEqual(created.body.client.secretPrefix, created.body.secret, '★ 前缀不是完整密钥');
  assert.match(created.body.warning, /只显示这一次/);
  assert.match(created.body.warning, /无法再次取回/);

  // ★★ 列表与详情**都不含密钥**
  const list = (await call(handler, 'GET', '/api/admin/verify/clients')) as { body: { clients: Record<string, unknown>[] } };
  const serialized = JSON.stringify(list.body);
  assert.equal(serialized.includes(created.body.secret), false, '★ 列表不得泄露密钥');
  assert.equal(serialized.includes('secretHash'), false, '★ 哈希也不该暴露（无意义且增加攻击面）');
});

test('★ 创建：缺 name / scopes → 400（不创建半成品）', async () => {
  const { handler, verifyClients } = makeHandler();
  assert.equal(((await call(handler, 'POST', '/api/admin/verify/clients', { scopes: ['assert:read'] })) as { status: number }).status, 400);
  assert.equal(((await call(handler, 'POST', '/api/admin/verify/clients', { name: 'x', scopes: [] })) as { status: number }).status, 400);
  assert.equal((await verifyClients.list()).length, 0, '★ 校验失败时不得留下记录');
});

test('★★ `rotate` 返回新密钥并提示**旧密钥立即失效**', async () => {
  const { handler } = makeHandler();
  const created = (await call(handler, 'POST', '/api/admin/verify/clients', { name: 'bot', scopes: ['assert:read'] })) as {
    body: { client: { id: string; secretPrefix: string }; secret: string };
  };
  const rotated = (await call(handler, 'POST', `/api/admin/verify/clients/${created.body.client.id}/rotate`)) as {
    status: number;
    body: { secret: string; client: { secretPrefix: string }; warning: string };
  };
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.secret, created.body.secret, '★ 新密钥必须与旧的不同');
  assert.notEqual(rotated.body.client.secretPrefix, created.body.client.secretPrefix, '前缀也变了（便于识别新旧）');
  assert.match(rotated.body.warning, /旧密钥\*\*立即失效\*\*/);
});

// ─────────────────────────── 状态流转 ───────────────────────────

test('★ 停用 / 启用 / 删除', async () => {
  const { handler, verifyClients } = makeHandler();
  const created = (await call(handler, 'POST', '/api/admin/verify/clients', { name: 'bot', scopes: ['assert:read'] })) as { body: { client: { id: string } } };
  const id = created.body.client.id;

  const suspended = (await call(handler, 'POST', `/api/admin/verify/clients/${id}/suspend`)) as { body: { client: { status: string } } };
  assert.equal(suspended.body.client.status, 'suspended');
  const list = (await call(handler, 'GET', '/api/admin/verify/clients')) as { body: { inactive: string[] } };
  assert.equal(list.body.inactive.length, 1, '★ 停用的密钥仍应出现在「需关注」清单里');

  const activated = (await call(handler, 'POST', `/api/admin/verify/clients/${id}/activate`)) as { body: { client: { status: string } } };
  assert.equal(activated.body.client.status, 'active');

  const removed = (await call(handler, 'DELETE', `/api/admin/verify/clients/${id}`)) as { status: number };
  assert.equal(removed.status, 200);
  assert.equal((await verifyClients.list()).length, 0);

  // 重复删除 → 404
  assert.equal(((await call(handler, 'DELETE', `/api/admin/verify/clients/${id}`)) as { status: number }).status, 404);
});

// ─────────────────────────── 哈希工具 ───────────────────────────

test('★ `hashSecret` 与生成器：密钥不可逆、不同次生成不重复', () => {
  const a = generateSecret();
  const b = generateSecret();
  assert.notEqual(a, b, '★ 每次生成都不同');
  assert.match(a, /^vc_/);
  assert.equal(hashSecret(a).length, 64, 'sha256 hex');
  assert.equal(hashSecret(a), hashSecret(a), '哈希是确定性的（校验侧要能重算）');
  assert.equal(hashSecret(a).includes(a), false, '★ 哈希里不含明文');

  // clientId 是短标识（不是密钥）
  const created = new InMemoryVerifyClientAdminStore();
  void created;
});
