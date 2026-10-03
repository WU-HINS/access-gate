/**
 * ★★ **`POST /api/me/selection` 的站点准入闸门**。
 *
 * ★ 为什么这个文件必须存在：这是**第二条**能改会话作用域的路径
 *   （`sessions.setActiveScope`），而**前端门户（`web/portal.ts`）走的正是它**。
 *   我第一版只给 `POST /api/me/site` 加了闸门——于是"闸门"被这条路径**完全绕过**。
 *   ★ 只改代码不写测试，等于没修：本文件把那次的漏给钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConsoleRoutes } from '../src/http/console-routes.ts';

const DEV = '11111111-1111-1111-1111-111111111111';
const SITE = '22222222-2222-2222-2222-222222222222';

function makeRoutes(scopes: { siteId: string }[], emailAdmission?: unknown) {
  return createConsoleRoutes({
    sessions: {
      async setActiveScope(_session: unknown, scope: { siteId: string }) {
        scopes.push(scope);
        return { principal: { userId: 'u1', activeSiteId: scope.siteId } };
      },
    } as never,
    registry: {
      async findDeveloper() {
        return { id: DEV, username: 'dev', displayName: '开发者', status: 'active' };
      },
      async findSite() {
        return {
          id: SITE,
          siteId: 'slug',
          nickname: '站点',
          developerId: DEV,
          status: 'active',
        };
      },
    } as never,
    listDeveloperIds: async () => [DEV],
    ...(emailAdmission === undefined ? {} : { emailAdmission }),
  } as never);
}

async function submitSelection(routes: ReturnType<typeof makeRoutes>, email: string | null = 'alice@corp.com') {
  const route = routes.find((candidate) => candidate.path === '/api/me/selection');
  assert.ok(route !== undefined, '`/api/me/selection` 必须已挂载');
  return route.handler({
    method: 'POST',
    path: '/api/me/selection',
    query: {},
    body: { developerId: DEV, siteId: SITE },
    principal: { userId: 'u1', email },
    session: { id: 's1' },
  } as never);
}

test('未装配闸门 → 提交选择照常（等价于"该站点没有配置任何规则"）', async () => {
  const scopes: { siteId: string }[] = [];
  const response = (await submitSelection(makeRoutes(scopes))) as { status?: number };
  assert.equal(response.status, 200, '★ console 路由**显式**返回 200（与 admin 路由的约定不同）');
  assert.equal(scopes[0]?.siteId, SITE, '★ 只断言站点——`setActiveScope` 还带 developerId，不该耦合它');
});

test('★★★ 被拒 → **403**，且 `setActiveScope` **未被调用**（拒绝必须是真的拒绝）', async () => {
  const scopes: { siteId: string }[] = [];
  const routes = makeRoutes(scopes, async () => ({
    allowed: false,
    reason: '未命中任何允许规则——已配置白名单时，未命中即拒绝',
  }));
  const response = (await submitSelection(routes)) as { status: number; body: { error: string } };

  assert.equal(response.status, 403);
  assert.match(response.body.error, /无法进入该站点/);
  assert.match(response.body.error, /未命中任何允许规则/, '★ 原因要透出来（可排障）');
  assert.deepEqual(
    scopes,
    [],
    '★★ 被拒时绝不能调用 `setActiveScope`——否则 403 只是"回了个错误"，权限已经给了',
  );
});

test('★ 校验用的是**目标站点**（`context.activeSiteId`，即校验归属后的那个）', async () => {
  const seen: string[] = [];
  const routes = makeRoutes([], async ({ siteId }: { siteId: string }) => {
    seen.push(siteId);
    return { allowed: true, reason: 'ok' };
  });
  await submitSelection(routes);
  assert.deepEqual(seen, [SITE]);
});

test('会话里没有邮箱 → 跳过闸门（判定依据不存在），但仍允许提交', async () => {
  const scopes: { siteId: string }[] = [];
  const routes = makeRoutes(scopes, async () => ({ allowed: false, reason: '一律拒绝' }));
  const response = (await submitSelection(routes, null)) as { status?: number };
  assert.equal(response.status, 200, '★ console 路由**显式**返回 200（与 admin 路由的约定不同）');
  assert.equal(scopes[0]?.siteId, SITE, '★ 只断言站点——`setActiveScope` 还带 developerId，不该耦合它');
});
