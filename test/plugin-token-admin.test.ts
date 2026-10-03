/**
 * 插件令牌验收（P0；docs/06 `/admin/plugins/:id/tokens`）。
 *
 * ★★ 核心：**令牌只在创建时返回一次**（与协同验证调用方同一设计），
 *   且撤销**幂等**（保留首次撤销时间）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemoryPluginTokenStore, generateToken, hashToken } from '../src/plugin/token-store.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ADMIN_SESSION = { userId: 'admin-1', username: 'admin', activeSiteId: 'site-1', realm: 'developer' as const, role: 'admin' as const };

function makeHandler() {
  const pluginTokens = new InMemoryPluginTokenStore();
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    pluginTokens,
    logger: silentLogger,
  });
  return { handler, pluginTokens };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], method: string, path: string, body?: unknown) =>
  handler({ method, path, query: {}, body, session: ADMIN_SESSION } as never);

// ─────────────────────────── ★★ 一次性令牌 ───────────────────────────

test('★★ 创建令牌：**只返回一次**，响应含警告；列表**不含**令牌', async () => {
  const { handler } = makeHandler();
  const created = (await call(handler, 'POST', '/api/admin/plugins/demo/tokens', { name: 'CI 用', scopes: ['facts:read'] })) as {
    status: number;
    body: { token: { id: string; tokenPrefix: string; scopes: string[] }; secret: string; warning: string };
  };
  assert.equal(created.status, 200);
  assert.match(created.body.secret, /^pt_/, '★ 令牌有 pt_ 前缀');
  assert.ok(created.body.secret.length > 30);
  assert.equal(created.body.token.tokenPrefix, created.body.secret.slice(0, 10));
  assert.match(created.body.warning, /只显示这一次/);
  assert.match(created.body.warning, /无法再次取回/);

  // ★ id 是合法 uuid（PG 主键类型）——本会话的静态检查也会验证这一点
  assert.match(created.body.token.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  // ★★ 列表不得泄露令牌
  const list = (await call(handler, 'GET', '/api/admin/plugins/demo/tokens')) as { body: { tokens: unknown[]; activeCount: number } };
  const serialized = JSON.stringify(list.body);
  assert.equal(serialized.includes(created.body.secret), false, '★ 列表不得泄露令牌');
  assert.equal(serialized.includes('token_hash'), false, '★ 哈希也不该暴露');
  assert.equal(list.body.activeCount, 1);
});

test('★ 创建：缺 name / scopes → 400（不留下半成品）', async () => {
  const { handler, pluginTokens } = makeHandler();
  assert.equal(((await call(handler, 'POST', '/api/admin/plugins/demo/tokens', { scopes: ['x'] })) as { status: number }).status, 400);
  assert.equal(((await call(handler, 'POST', '/api/admin/plugins/demo/tokens', { name: 'x', scopes: [] })) as { status: number }).status, 400);
  assert.equal((await pluginTokens.list('demo')).length, 0);
});

test('★ `ttlSeconds` 设置过期时间；`active` 标志反映过期', async () => {
  const { handler, pluginTokens } = makeHandler();
  // ttl = 0 不合法（不设置）；用一个极小的正整数验证过期逻辑
  const created = (await call(handler, 'POST', '/api/admin/plugins/demo/tokens', { name: '短期', scopes: ['x'], ttlSeconds: 1 })) as {
    body: { token: { id: string; expiresAt: string | null } };
  };
  assert.ok(created.body.token.expiresAt !== null, '设置了 ttl 就应有 expiresAt');

  // 手工造一个已过期的令牌，验证 active 判定
  const store = pluginTokens;
  const past = new Date(Date.now() - 1000);
  await store.create({ pluginId: 'demo', name: '已过期', scopes: ['x'], ttlSeconds: -1 });
  void past;
  const list = (await call(handler, 'GET', '/api/admin/plugins/demo/tokens')) as {
    body: { tokens: { name: string; active: boolean }[]; activeCount: number };
  };
  const expired = list.body.tokens.find((entry) => entry.name === '已过期')!;
  assert.equal(expired.active, false, '★ 已过期的令牌不是 active');
});

// ─────────────────────────── ★★ 撤销幂等 ───────────────────────────

test('★★ 撤销：立即失效，且**幂等**——重复撤销保留首次时间', async () => {
  const { handler, pluginTokens } = makeHandler();
  const created = (await call(handler, 'POST', '/api/admin/plugins/demo/tokens', { name: 'T', scopes: ['x'] })) as {
    body: { token: { id: string } };
  };

  const first = (await call(handler, 'DELETE', `/api/admin/plugins/demo/tokens/${created.body.token.id}`)) as {
    status: number;
    body: { token: { revokedAt: string }; alreadyRevoked: boolean; note: string };
  };
  assert.equal(first.status, 200);
  assert.equal(first.body.alreadyRevoked, false);
  assert.match(first.body.note, /立即失效/);
  const firstTime = first.body.token.revokedAt;

  const second = (await call(handler, 'DELETE', `/api/admin/plugins/demo/tokens/${created.body.token.id}`)) as {
    status: number;
    body: { token: { revokedAt: string }; alreadyRevoked: boolean; note: string };
  };
  assert.equal(second.status, 200, '★ 重复撤销不报错（幂等）');
  assert.equal(second.body.alreadyRevoked, true);
  assert.equal(second.body.token.revokedAt, firstTime, '★ 保留首次撤销时间');
  assert.match(second.body.note, /此前已被撤销/);

  const list = (await call(handler, 'GET', '/api/admin/plugins/demo/tokens')) as { body: { activeCount: number } };
  assert.equal(list.body.activeCount, 0, '★ 撤销后不再是 active');
  void pluginTokens;
});

// ─────────────────────────── 校验 ───────────────────────────

test('★ `:tid` 必须是 uuid → 非 uuid 返回 400；不属于该插件 → 404', async () => {
  const { handler, pluginTokens } = makeHandler();
  assert.equal(((await call(handler, 'DELETE', '/api/admin/plugins/demo/tokens/not-a-uuid')) as { status: number }).status, 400);

  const created = await pluginTokens.create({ pluginId: 'demo', name: 'T', scopes: ['x'] });
  assert.equal(((await call(handler, 'DELETE', `/api/admin/plugins/other/tokens/${created.token.id}`)) as { status: number }).status, 404);
});

test('★ 哈希工具：不可逆、确定性、不同次生成不重复', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^pt_/);
  assert.equal(hashToken(a).length, 64);
  assert.equal(hashToken(a), hashToken(a));
  assert.equal(hashToken(a).includes(a), false, '★ 哈希里不含明文');
});

test('未启用令牌存储时 → 501（显式不可用）', async () => {
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
  assert.equal(((await call(handler, 'GET', '/api/admin/plugins/demo/tokens')) as { status: number }).status, 501);
});
