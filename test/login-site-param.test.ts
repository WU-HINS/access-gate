/**
 * ★★ **传参登录 → 自动选择站点**（`?site=<uuid>`）—— 端到端（走 callback）。
 *
 * ★ 这条链路的难点在**时序**：站点是在**发起登录时**指定的，而"选定"发生在
 *   **IdP 往返之后**——所以站点只能随 OIDC 事务落库（`LoginTransaction.siteId`）。
 *
 * ★ 本文件锁定四种情形，其中后两种是**必须不静默**的：
 *   ① 无站点参数 → 用默认站点（既有行为不变）；
 *   ② 站点通过准入 → 自动选中它；
 *   ③ 站点**被准入拒绝** → **不选中**（也不回落到默认站点）+ 把原因带回；
 *   ④ 站点**不存在** → 同上（★ 这正是不做 `siteExists` 就会漏的那种：
 *      `decideEmailAdmission([], …)` 对"没有规则"**默认允许**）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppRoutes } from '../src/http/routes.ts';

const T0 = new Date('2026-09-26T00:00:00Z');
const SITE_DEFAULT = '11111111-1111-1111-1111-111111111111';
const SITE_TARGET = '22222222-2222-2222-2222-222222222222';

/** 造一个只关心"callback 之后会话里是什么"的路由表 */
function makeRoutes(input: {
  transactionSiteId?: string;
  emailAdmission?: unknown;
  created: { activeSiteId?: string | null }[];
}) {
  return createAppRoutes({
    admin: async () => ({ status: 404, body: {} }),
    csrfSecret: 'test-secret',
    defaultSiteId: SITE_DEFAULT,
    oidc: {
      async completeLogin() {
        return { claims: { sub: 'sub-1', email: 'alice@corp.com', email_verified: true } };
      },
    } as never,
    loginTransactions: {
      async take() {
        return {
          state: 'st',
          nonce: 'n',
          codeVerifier: 'v',
          returnTo: '/#enduser',
          ...(input.transactionSiteId === undefined ? {} : { targetSiteId: input.transactionSiteId }),
          createdAt: T0,
          expiresAt: new Date(T0.getTime() + 600_000),
        };
      },
    } as never,
    loginResolver: async () => ({
      ok: true,
      realm: 'enduser',
      role: 'user',
      principalId: '11111111-1111-1111-1111-111111111111',
    }),
    sessions: {
      async create(principal: { activeSiteId?: string | null }) {
        input.created.push(principal);
        return { token: 'tok' };
      },
    } as never,
    ...(input.emailAdmission === undefined ? {} : { emailAdmission: input.emailAdmission }),
  } as never);
}

async function runCallback(routes: ReturnType<typeof makeRoutes>) {
  const route = routes.find((candidate) => candidate.path === '/api/auth/callback');
  assert.ok(route !== undefined, '`/api/auth/callback` 必须已挂载');
  return route.handler({
    method: 'GET',
    path: '/api/auth/callback',
    query: { state: 'st', code: 'c' },
    headers: {},
    body: undefined,
    principal: null,
    session: null,
    setCookie: () => undefined,
    clearCookie: () => undefined,
    params: {},
  } as never);
}

test('① 无站点参数 → 用**默认站点**（既有行为不变）', async () => {
  const created: { activeSiteId?: string | null }[] = [];
  await runCallback(makeRoutes({ created }));
  assert.equal(created.length, 1);
  assert.equal(created[0]!.activeSiteId, SITE_DEFAULT);
});

test('② 站点通过准入 → **自动选中**它', async () => {
  const created: { activeSiteId?: string | null }[] = [];
  const seen: string[] = [];
  const routes = makeRoutes({
    created,
    transactionSiteId: SITE_TARGET,
    emailAdmission: async ({ siteId }: { siteId: string }) => {
      seen.push(siteId);
      return { allowed: true, reason: '命中允许规则' };
    },
  });
  const response = (await runCallback(routes)) as { body: Record<string, unknown> };

  assert.equal(created[0]!.activeSiteId, SITE_TARGET, '★ 应自动选中事务里带的站点');
  assert.deepEqual(seen, [SITE_TARGET], '★ 校验的必须是**目标站点**');
  assert.equal('siteSelectionFailure' in response.body, false, '成功时不该有失败字段');
});

test('③ 站点**被准入拒绝** → 不选中、**也不回落**、并把原因带回', async () => {
  const created: { activeSiteId?: string | null }[] = [];
  const routes = makeRoutes({
    created,
    transactionSiteId: SITE_TARGET,
    emailAdmission: async () => ({ allowed: false, reason: '未命中任何允许规则' }),
  });
  const response = (await runCallback(routes)) as { body: Record<string, unknown> };

  assert.equal(
    created[0]!.activeSiteId,
    null,
    '★ 绝不能回落到默认站点——用户明确要去的是目标站点，静默换站会让他以为自己在目标站点',
  );
  assert.match(String(response.body['siteSelectionFailure']), /未命中任何允许规则/);
});

test('④ 站点**不存在** → 同样不选中 + 明确原因（`siteExists` 的职责）', async () => {
  const created: { activeSiteId?: string | null }[] = [];
  const routes = makeRoutes({
    created,
    transactionSiteId: SITE_TARGET,
    // 复刻 `makeSiteAdmissionCheck` 的行为：不存在 → 拒绝
    emailAdmission: async () => ({ allowed: false, reason: `站点不存在或不可用（${SITE_TARGET}）` }),
  });
  const response = (await runCallback(routes)) as { body: Record<string, unknown> };
  assert.equal(created[0]!.activeSiteId, null);
  assert.match(String(response.body['siteSelectionFailure']), /站点不存在或不可用/);
});

test('未装配闸门 → 传参站点直接选中（"未启用准入"的语义）', async () => {
  const created: { activeSiteId?: string | null }[] = [];
  await runCallback(makeRoutes({ created, transactionSiteId: SITE_TARGET }));
  assert.equal(created[0]!.activeSiteId, SITE_TARGET);
});
