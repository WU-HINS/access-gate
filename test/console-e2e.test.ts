/**
 * 端到端：两级选择 + 控制台准入（落地目标第 2、3 条）。
 *
 * ★ 本文件起一个**真实 HTTP 服务**走完整链路，验证的不是「模块能调用」，
 *   而是「真人能不能用」：
 *   登录 → 选开发者 → 选站点 → 会话作用域生效 → 控制台导航 → 分区准入。
 *
 * ★ 两条最关键的安全断言：
 *   1. **跨开发者选择返回 403**（站点是隔离边界）；
 *   2. **开发者访问「插件安装」分区返回 403**（M7-7 的否定式要求，
 *      必须在**接口层**拒绝，而不是前端不显示按钮）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppServer, newCsrfSecret, type Route } from '../src/http/server.ts';
import { createConsoleRoutes } from '../src/http/console-routes.ts';
import { csrfTokenFor, InMemorySessionStore, principalFromClaims, SESSION_COOKIE, SessionService } from '../src/auth/session.ts';
import { InMemorySiteRegistry } from '../src/core/sites.ts';
import { silentLogger } from '../src/kernel/logger.ts';

interface Harness {
  base: string;
  close: () => Promise<void>;
  sessions: SessionService;
  registry: InMemorySiteRegistry;
  alice: { id: string };
  bob: { id: string };
  adminSession: { token: string };
  developerSession: { token: string };
  /** 生成该会话的 CSRF token（真实客户端从 /api/me 拿到它） */
  csrf: (token: string) => Promise<string>;
}

async function startHarness(): Promise<Harness> {
  const registry = new InMemorySiteRegistry();
  const alice = await registry.createDeveloper({ username: 'alice', displayName: 'Alice', email: 'a@x.com', role: 'developer' });
  const bob = await registry.createDeveloper({ username: 'bob', displayName: 'Bob', email: 'b@x.com', role: 'developer' });
  await registry.createSite({ siteId: 'alice-main', nickname: 'Alice 主站', developerId: alice.id });
  await registry.createSite({ siteId: 'bob-main', nickname: 'Bob 主站', developerId: bob.id });

  const sessions = new SessionService({ store: new InMemorySessionStore() });
  const routes: Route[] = createConsoleRoutes({
    sessions,
    registry,
    // 当前用户可见的开发者集合（这里两个都可见，用于验证归属校验）
    listDeveloperIds: async () => [alice.id, bob.id],
    logger: silentLogger,
  });

  const csrfSecret = newCsrfSecret();
  const app = createAppServer({ sessions, routes, csrfSecret, logger: silentLogger, port: 0 });
  const { url } = await app.listen();

  // 两种身份各建一个会话
  const adminPrincipal = principalFromClaims({ sub: 'admin-1', emailVerified: true, preferredUsername: 'admin' }, { realm: 'developer', role: 'admin', activeSiteId: null });
  const developerPrincipal = principalFromClaims({ sub: 'dev-1', emailVerified: true, preferredUsername: 'dev' }, { realm: 'developer', role: 'developer', activeSiteId: null });
  const adminSession = await sessions.create(adminPrincipal);
  const developerSession = await sessions.create(developerPrincipal);

  return {
    base: url,
    close: () => app.close(),
    sessions,
    registry,
    alice,
    bob,
    adminSession: { token: adminSession.token },
    developerSession: { token: developerSession.token },
    // ★ 状态变更请求必须带 CSRF token（服务端强制）；测试模拟真实客户端的获取路径
    csrf: async (token: string) => {
      const auth = await sessions.authenticate(token);
      if (!auth.ok) throw new Error('会话无效，无法生成 CSRF token');
      return csrfTokenFor(auth.session.id, csrfSecret);
    },
  };
}

const get = (base: string, path: string, token: string): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });

const post = (base: string, path: string, token: string, body: unknown, csrfToken: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body),
  });

// ─────────────────────────── 两级选择 ───────────────────────────

test('★ 端到端：第一级列出开发者（含站点数）', async () => {
  const harness = await startHarness();
  try {
    const response = await get(harness.base, '/api/me/selection/developers', harness.developerSession.token);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { developers: { developerId: string; displayName: string; siteCount: number }[]; current: { siteId: string | null } };
    assert.deepEqual(body.developers.map((entry) => entry.displayName), ['Alice', 'Bob']);
    assert.equal(body.developers[0]!.siteCount, 1);
    assert.equal(body.current.siteId, null, '尚未选择站点');
  } finally {
    await harness.close();
  }
});

test('★ 端到端：第二级列出该开发者的站点', async () => {
  const harness = await startHarness();
  try {
    const response = await get(harness.base, `/api/me/selection/sites/${harness.alice.id}`, harness.developerSession.token);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sites: { siteId: string; nickname: string }[] };
    assert.deepEqual(body.sites.map((entry) => entry.siteId), ['alice-main']);
  } finally {
    await harness.close();
  }
});

test('★ 端到端：提交选择 → 会话作用域生效（且存的是内部 uuid）', async () => {
  const harness = await startHarness();
  try {
    const response = await post(
      harness.base,
      '/api/me/selection',
      harness.developerSession.token,
      { developerId: harness.alice.id, siteId: 'alice-main' },
      await harness.csrf(harness.developerSession.token),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; site: { id: string; siteId: string } };
    assert.equal(body.ok, true);
    assert.match(body.site.id, /^[0-9a-f-]{36}$/, '★ 会话写入的是内部 uuid');
    assert.equal(body.site.siteId, 'alice-main');

    // 再次请求第一级：current 应反映已选
    const after = await get(harness.base, '/api/me/selection/developers', harness.developerSession.token);
    const afterBody = (await after.json()) as { current: { developerId: string | null; siteId: string | null } };
    assert.equal(afterBody.current.developerId, harness.alice.id);
    assert.equal(afterBody.current.siteId, body.site.id, '会话里的 siteId 是内部 uuid');
  } finally {
    await harness.close();
  }
});

test('★ 端到端：跨开发者选择 → **403**（站点是隔离边界）', async () => {
  const harness = await startHarness();
  try {
    // 声称 Bob 的开发者 + Alice 的站点
    const response = await post(
      harness.base,
      '/api/me/selection',
      harness.developerSession.token,
      { developerId: harness.bob.id, siteId: 'alice-main' },
      await harness.csrf(harness.developerSession.token),
    );
    assert.equal(response.status, 403, '★ 归属错配必须被拒');
    const body = (await response.json()) as { reason: string; error: string };
    assert.equal(body.reason, 'site_not_owned_by_developer');
    assert.match(body.error, /隔离边界/);
  } finally {
    await harness.close();
  }
});

test('端到端：未登录访问选择接口 → 401', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.base}/api/me/selection/developers`);
    assert.equal(response.status, 401);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 控制台准入 ───────────────────────────

test('★ 端到端：控制台导航按能力派生（开发者 5 个分区，管理员 15 个）', async () => {
  const harness = await startHarness();
  try {
    const devResponse = await get(harness.base, '/api/console/sections', harness.developerSession.token);
    const devBody = (await devResponse.json()) as { sections: { id: string }[]; realm: string; role: string };
    assert.equal(devBody.realm, 'developer');
    assert.equal(devBody.role, 'developer');
    assert.deepEqual(
      devBody.sections.map((section) => section.id).sort(),
      ['dev.actions', 'dev.audit', 'dev.plugin-config', 'dev.policies', 'dev.subjects'],
      '★ 开发者看不到任何管理分区',
    );

    const adminResponse = await get(harness.base, '/api/console/sections', harness.adminSession.token);
    const adminBody = (await adminResponse.json()) as { sections: { id: string }[] };
    assert.equal(adminBody.sections.length, 15, '管理员应看到全部分区（10 管理 + 5 开发）');
  } finally {
    await harness.close();
  }
});

test('★ 端到端：开发者访问「插件安装」分区 → **403**（接口层拒绝，不是前端隐藏）', async () => {
  const harness = await startHarness();
  try {
    const devResponse = await get(harness.base, '/api/console/sections/admin.plugins/access', harness.developerSession.token);
    assert.equal(devResponse.status, 403, '★ M7-7：开发者不得安装插件');
    const devBody = (await devResponse.json()) as { reason: string; error: string };
    assert.equal(devBody.reason, 'missing_capability');
    assert.match(devBody.error, /plugin:install/);

    // 同一分区，管理员 200
    const adminResponse = await get(harness.base, '/api/console/sections/admin.plugins/access', harness.adminSession.token);
    assert.equal(adminResponse.status, 200);
  } finally {
    await harness.close();
  }
});

test('★ 端到端：开发者访问「OIDC 注册」分区 → 403；开发者自己的分区 → 200', async () => {
  const harness = await startHarness();
  try {
    assert.equal((await get(harness.base, '/api/console/sections/admin.oidc/access', harness.developerSession.token)).status, 403);
    assert.equal((await get(harness.base, '/api/console/sections/dev.policies/access', harness.developerSession.token)).status, 200);
    assert.equal((await get(harness.base, '/api/console/sections/dev.plugin-config/access', harness.developerSession.token)).status, 200, '可**配置**插件（只是不能安装）');
  } finally {
    await harness.close();
  }
});

test('端到端：未知分区 → 404（与权限 403 区分）', async () => {
  const harness = await startHarness();
  try {
    const response = await get(harness.base, '/api/console/sections/admin.ghost/access', harness.adminSession.token);
    assert.equal(response.status, 404);
  } finally {
    await harness.close();
  }
});

test('端到端：普通用户（enduser 域）不可进控制台', async () => {
  const harness = await startHarness();
  try {
    const principal = principalFromClaims({ sub: 'user-1', emailVerified: true, preferredUsername: 'u' }, { realm: 'enduser', role: 'user' });
    const session = await harness.sessions.create(principal);
    const response = await get(harness.base, '/api/console/sections', session.token);
    const body = (await response.json()) as { sections: unknown[] };
    assert.equal(response.status, 200, '接口本身可用（返回空导航）');
    assert.deepEqual(body.sections, [], '★ 普通用户没有任何控制台分区');
    assert.equal((await get(harness.base, '/api/console/sections/admin.overview/access', session.token)).status, 403);
  } finally {
    await harness.close();
  }
});

test('端到端：`/api/ui/manifest` 无宿主时返回空结构（前端无需特判 null）', async () => {
  const harness = await startHarness();
  try {
    const response = await get(harness.base, '/api/ui/manifest', harness.developerSession.token);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { nav: unknown[]; pages: unknown[]; slots: unknown[]; pendingApproval: number };
    assert.deepEqual(body.nav, []);
    assert.deepEqual(body.pages, []);
    assert.deepEqual(body.slots, []);
    assert.equal(body.pendingApproval, 0);
  } finally {
    await harness.close();
  }
});

test('★ 端到端：状态变更端点强制 CSRF（无 token 的 POST 被拒）', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.base}/api/me/selection`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${harness.developerSession.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ developerId: harness.alice.id, siteId: 'alice-main' }),
    });
    assert.equal(response.status, 403, '★ 无 CSRF token 的状态变更必须被拒');
  } finally {
    await harness.close();
  }
});
