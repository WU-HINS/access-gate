/**
 * 门户页面与「服务可启动」验收（M0-10）。
 *
 * 为什么要把「服务能起来」纳入自动化：仅仅单元测试通过，不代表用户能打开页面。
 * 本文件真正**启动一个 HTTP 服务**并抓取页面与接口，覆盖：
 *   - 首页返回 HTML 且包含关键挂载点（前端 JS 依赖这些 id）；
 *   - 未登录时 `/api/me` 401、页面仍可打开（走登录引导）；
 *   - 登录后 `/api/me/eligibility` 返回可用数据（端到端串起会话 + 资格）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPortalHtml } from '../web/portal.ts';
import { InMemorySessionStore, principalFromClaims, SESSION_COOKIE, SessionService } from '../src/auth/session.ts';
import { createAppServer, newCsrfSecret, type Route } from '../src/http/server.ts';
import { createAppRoutes } from '../src/http/routes.ts';
import { InMemoryLoginTransactionStore, OidcClient, type HttpFetcher } from '../src/auth/oidc.ts';

// ─────────────────────────── 页面渲染 ───────────────────────────

test('renderPortalHtml：产出完整 HTML，且包含前端依赖的挂载点 id', () => {
  const html = renderPortalHtml({ demo: true });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<\/html>\s*$/);
  // 前端 JS 通过 getElementById 拿这些节点——id 改了页面就白屏
  for (const id of [
    'who', 'login-btn', 'logout-btn', 'login-card', 'eligibility-card', 'progress-bar', 'progress-text', 'todos', 'results',
    'admin-card', 'admin-output', 'toast',
    // ★ 两级选择（M7-5）：这三个挂载点缺失会让选择界面静默失效
    'selection-card', 'developer-select', 'site-select', 'selection-submit', 'selection-status',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `页面缺少挂载点 #${id}`);
  }
  // 关键文案（用户侧的「我的资格」）
  assert.match(html, /我的资格/);
  assert.match(html, /管理端/);
});

test('renderPortalHtml：demo 模式标注 DEMO，非 demo 模式不标注（避免把演示当生产）', () => {
  assert.match(renderPortalHtml({ demo: true }), /DEMO/);
  const real = renderPortalHtml({ demo: false });
  assert.equal(/DEMO/.test(real), false);
  assert.match(real, /接入模式/);
});

test('renderPortalHtml：所有 API 调用都带 credentials（否则会话 Cookie 不会带上）', () => {
  const html = renderPortalHtml({ demo: true });
  assert.match(html, /credentials: 'same-origin'/);
  // 写操作必须带 CSRF 头
  assert.match(html, /x-csrf-token/);
});

// ─────────────────────────── 真实起服务 ───────────────────────────

async function startPortalServer() {
  const store = new InMemorySessionStore();
  const sessions = new SessionService({ store });
  const csrfSecret = newCsrfSecret();
  const noopOidc = new OidcClient({
    config: { issuer: 'https://idp.example', clientId: 'c', redirectUri: 'http://127.0.0.1/api/auth/callback' },
    fetch: (async () => ({ status: 404, headers: {}, text: '{}' })) as HttpFetcher,
  });
  const routes: Route[] = [
    { method: 'GET', path: '/', handler: () => ({ body: renderPortalHtml({ demo: true }), contentType: 'text/html; charset=utf-8' }), auth: 'none' },
    ...createAppRoutes({
      sessions,
      oidc: noopOidc,
      loginTransactions: new InMemoryLoginTransactionStore(),
      csrfSecret,
      eligibility: {
        forUser: async ({ principal, siteId }) => ({
          progress: { satisfied: 1, total: 2 },
          todos: ['GitHub 总 star 数 ≥ 100'],
          results: [
            {
              code: 'edu',
              name: '教育邮箱解锁签到',
              decision: 'satisfied',
              summary: '满足全部条件',
              actions: [{ action: 'checkin:grant' }],
              items: [{ label: '教育邮箱', state: 'true', reason: 'ok' }],
            },
          ],
          meta: { principal: principal.userId, siteId },
        }),
      },
      defaultSiteId: 'site-1',
    }),
  ];
  const app = createAppServer({ sessions, routes, csrfSecret, port: 0 });
  const { url } = await app.listen();
  return { base: url, close: () => app.close(), sessions, csrfSecret };
}

test('★ 端到端：服务可启动；首页返回 HTML；未登录 /api/me 401 但页面仍可访问', async () => {
  const server = await startPortalServer();
  try {
    const page = await fetch(`${server.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /我的资格/);

    // 未登录：接口 401，但页面本身必须能打开（否则用户看不到登录入口）
    assert.equal((await fetch(`${server.base}/api/me`)).status, 401);
    assert.equal((await fetch(`${server.base}/api/me/eligibility`)).status, 401);
  } finally {
    await server.close();
  }
});

test('★ 端到端：带会话访问 /api/me 与 /api/me/eligibility 均成功', async () => {
  const server = await startPortalServer();
  try {
    const { token } = await server.sessions.create(
      principalFromClaims(
        { sub: 'demo:alice@tsinghua.edu.cn', email: 'alice@tsinghua.edu.cn', emailVerified: true, preferredUsername: 'alice' },
        { realm: 'enduser', activeSiteId: 'site-1' },
      ),
    );
    const cookie = `${SESSION_COOKIE}=${token}`;

    const me = await fetch(`${server.base}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { principal: { username: string }; csrfToken: string };
    assert.equal(meBody.principal.username, 'alice');
    assert.ok(meBody.csrfToken.length > 0);

    const eligibility = await fetch(`${server.base}/api/me/eligibility`, { headers: { cookie } });
    assert.equal(eligibility.status, 200);
    const body = (await eligibility.json()) as { progress: { satisfied: number }; results: { items: unknown[] }[] };
    assert.equal(body.progress.satisfied, 1);
    assert.ok(body.results[0]!.items.length > 0);
  } finally {
    await server.close();
  }
});

test('端到端：X-Request-Id 贯通到响应（排障必备）', async () => {
  const server = await startPortalServer();
  try {
    const response = await fetch(`${server.base}/`, { headers: { 'x-request-id': 'trace-portal' } });
    assert.equal(response.headers.get('x-request-id'), 'trace-portal');
  } finally {
    await server.close();
  }
});

test('★ 门户：两级选择 UI 接入真实端点（不是占位）', () => {
  const html = renderPortalHtml({ demo: true });
  // 三个端点都必须被调用：第一级 / 第二级 / 提交
  assert.match(html, /\/api\/me\/selection\/developers/, '第一级：列出开发者');
  assert.match(html, /\/api\/me\/selection\/sites\//, '第二级：列出站点');
  assert.match(html, /api\/me\/selection'/, '提交选择');
  // ★ 提交是状态变更 → 必须带 CSRF token
  assert.match(html, /x-csrf-token/, '状态变更必须带 CSRF token');
  // 控制台导航按服务端返回渲染
  assert.match(html, /\/api\/console\/sections/);
});

test('★ 门户：单站点部署下选择卡片保持隐藏（standalone 免选择）', () => {
  const html = renderPortalHtml({ demo: true });
  // 判据写在 JS 里：开发者<=1 且站点总数<=1 时隐藏
  assert.match(html, /developers\.length <= 1 && totalSites <= 1/, '★ 单站点应免于选择');
  assert.match(html, /selection-card'\)\.classList\.add\('hidden'\)/);
});
