/**
 * ★★ **站点准入闸门**（`ag_email_rules`）——权威检查点在**切换站点**时。
 *
 * ★ 为什么正确的位置是这里（按"统一登录 + 站点自选"核实后的结论）：
 *   · 登录是**平台级统一**的（两条链路共用 `resolveLogin`）；
 *   · 而 `ag_email_rules` 是**站点级**表（`site_id NOT NULL`）；
 *   · 登录后会话的 `activeSiteId` 是 **`null`**，`switchSite` 是**唯一**设置它的路径。
 *   ★ 因此"这个邮箱能不能进这个站点"必须在**切换的那一刻**问**目标站点**——
 *     在登录时拿某个默认站点的规则去判，是**错的站点**。
 *
 * ★ 最关键的一条断言：**被拒时会话不能切换**（否则"拒绝"只是回了个 403，权限已经给了）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppRoutes } from '../src/http/routes.ts';

const SITE_A = '11111111-1111-1111-1111-111111111111';
const SITE_B = '22222222-2222-2222-2222-222222222222';

/** 记录 switchSite 的调用（用来断言"被拒时没有真的切换"） */
function makeRoutes(switchCalls: string[], emailAdmission?: unknown) {
  return createAppRoutes({
    admin: async () => ({ status: 404, body: {} }),
    csrfSecret: 'test-secret',
    defaultSiteId: SITE_A,
    sessions: {
      async switchSite(sessionId: string, siteId: string) {
        switchCalls.push(siteId);
        return {
          id: sessionId,
          principal: { userId: 'u1', email: 'alice@corp.com', activeSiteId: siteId },
        };
      },
    } as never,
    ...(emailAdmission === undefined ? {} : { emailAdmission }),
  } as never);
}

async function switchTo(
  routes: ReturnType<typeof makeRoutes>,
  siteId: string,
  email: string | null = 'alice@corp.com',
) {
  const route = routes.find((candidate) => candidate.path === '/api/me/site');
  assert.ok(route !== undefined, '`/api/me/site` 必须已挂载');
  return route.handler({
    method: 'POST',
    path: '/api/me/site',
    query: {},
    body: { siteId },
    principal: { userId: 'u1', email },
    session: { id: 's1' },
  } as never);
}

test('未装配闸门 → 切换照常（等价于"该站点没有配置任何规则"）', async () => {
  const calls: string[] = [];
  const response = (await switchTo(makeRoutes(calls), SITE_B)) as {
    status?: number;
    body: { activeSiteId?: string };
  };
  assert.equal(calls.length, 1);
  assert.equal(response.body.activeSiteId, SITE_B);
});

test('目标站点允许 → 切换成功', async () => {
  const calls: string[] = [];
  const routes = makeRoutes(calls, async () => ({ allowed: true, reason: '命中允许规则' }));
  const response = (await switchTo(routes, SITE_B)) as { body: { activeSiteId?: string } };
  assert.equal(response.body.activeSiteId, SITE_B);
  assert.deepEqual(calls, [SITE_B]);
});

test('★★★ 目标站点拒绝 → **403**，且**会话没有切换**（拒绝必须是真的拒绝）', async () => {
  const calls: string[] = [];
  const routes = makeRoutes(calls, async () => ({
    allowed: false,
    reason: '未命中任何允许规则——已配置白名单时，未命中即拒绝',
  }));
  const response = (await switchTo(routes, SITE_B)) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 403);
  assert.match(response.body.error, /无法进入该站点/);
  assert.match(response.body.error, /未命中任何允许规则/, '★ 要把原因透出来（可排障）');
  assert.deepEqual(calls, [], '★★ 被拒时绝不能调用 `switchSite`——否则权限已经给了');
});

test('★★ 判定用的是**目标站点**（不是默认站点）', async () => {
  const seen: string[] = [];
  const routes = makeRoutes([], async ({ siteId }: { siteId: string }) => {
    seen.push(siteId);
    // 站点 A 允许、站点 B 拒绝 —— 每个站点各自一套规则
    return siteId === SITE_A
      ? { allowed: true, reason: 'A 站点允许' }
      : { allowed: false, reason: 'B 站点拒绝' };
  });

  assert.equal(
    ((await switchTo(routes, SITE_A)) as { status?: number }).status,
    undefined,
    'A 站点应允许',
  );
  const denied = (await switchTo(routes, SITE_B)) as { status: number };
  assert.equal(denied.status, 403, 'B 站点应拒绝');
  assert.deepEqual(seen, [SITE_A, SITE_B], '★ 每次都用**目标站点**去问');
});

test('会话里没有邮箱（`email = null`）→ 跳过闸门（无从判定）', async () => {
  const calls: string[] = [];
  const routes = makeRoutes(calls, async () => ({ allowed: false, reason: '一律拒绝' }));
  const response = (await switchTo(routes, SITE_B, null)) as { status?: number };
  assert.equal(response.status, undefined);
  assert.deepEqual(calls, [SITE_B], '没有邮箱时不检查，但仍允许切换（判定依据不存在）');
});
