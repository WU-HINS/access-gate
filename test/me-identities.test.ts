/**
 * `GET /api/me/identities` 验收（用户自助）。
 *
 * ★★ 安全核心：用户 id **只从会话取**，本端点不接受任何参数——
 *   否则用户可以传别人的 id 查其绑定。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppRoutes } from '../src/http/routes.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { SessionService } from '../src/auth/session.ts';
import { InMemorySessionStore } from '../src/auth/session.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ALICE = '11111111-1111-7111-a111-111111111111';
const BOB = '22222222-2222-7222-a222-222222222222';

function makeRoutes() {
  const identities = new InMemoryIdentityStore();
  void identities.save({
    provider: 'oidc:https://idp.example.com',
    providerUserId: 'alice-sub',
    userId: ALICE,
    claimSnapshot: { email: 'alice@example.com', secret_claim: '不该暴露' },
    verifiedAt: new Date('2025-06-01T00:00:00Z'),
    revokedAt: null,
  });
  void identities.save({
    provider: 'subject:github',
    providerUserId: 'alice-gh',
    userId: ALICE,
    subjectRef: { provider: 'github', externalId: 'gh-1' },
    revokedAt: new Date('2025-06-02T00:00:00Z'),
  });
  // ★ Bob 的绑定——Alice 绝不能看到
  void identities.save({ provider: 'oidc:https://idp.example.com', providerUserId: 'bob-sub', userId: BOB, revokedAt: null });

  const sessions = new SessionService({ store: new InMemorySessionStore() });
  const routes = createAppRoutes({
    sessions,
    identities,
    logger: silentLogger,
  } as never);
  return { routes, identities };
}

const callAs = async (routes: ReturnType<typeof makeRoutes>['routes'], userId: string | null, path: string) => {
  const route = routes.find((entry) => entry.method === 'GET' && entry.path === path)!;
  return route.handler({
    method: 'GET',
    path,
    query: {},
    headers: {},
    body: undefined,
    rawBody: '',
    principal: userId === null ? null : { userId, username: 'x', email: null, emailVerified: false, realm: 'enduser', role: 'user', activeSiteId: null },
    session: null,
    traceId: 't',
    setCookie: () => undefined,
    clearCookie: () => undefined,
  } as never) as Promise<{ status?: number; body?: Record<string, unknown> }>;
};

test('★★ 只返回**自己的**身份绑定（不接受任何参数）', async () => {
  const { routes } = makeRoutes();
  const asAlice = await callAs(routes, ALICE, '/api/me/identities');
  const body = asAlice.body as { identities: { provider: string; providerUserId: string }[]; total: number; activeCount: number };
  assert.equal(body.total, 2, '★ Alice 有 2 条绑定');
  assert.equal(body.identities.some((entry) => entry.providerUserId === 'bob-sub'), false, '★★ 绝不能看到 Bob 的绑定');

  const asBob = await callAs(routes, BOB, '/api/me/identities');
  const bobBody = asBob.body as { identities: { providerUserId: string }[]; total: number };
  assert.equal(bobBody.total, 1);
  assert.equal(bobBody.identities[0]!.providerUserId, 'bob-sub');
});

test('★★ **不返回 `claimSnapshot`**（IdP 断言快照可能含用户未预期暴露的字段）', async () => {
  const { routes } = makeRoutes();
  const response = await callAs(routes, ALICE, '/api/me/identities');
  const text = JSON.stringify(response.body);
  assert.equal(text.includes('secret_claim'), false, '★ 断言快照不得出现在用户自助端点');
  assert.equal(text.includes('claimSnapshot'), false);
  // ★ 但保留「绑了哪个 provider、何时验证」这些用户该知道的
  assert.equal(text.includes('alice-sub'), true, '用户应能看到自己绑定的外部标识');
});

test('★ 已撤销的绑定**仍在列表里**且标记 `revoked`（用户应知道它已失效）', async () => {
  const { routes } = makeRoutes();
  const response = await callAs(routes, ALICE, '/api/me/identities');
  const body = response.body as { identities: { provider: string; revoked: boolean; revokedAt: string | null }[]; activeCount: number };
  const revoked = body.identities.find((entry) => entry.provider === 'subject:github')!;
  assert.equal(revoked.revoked, true, '★ 已撤销的绑定要显式标记');
  assert.ok(revoked.revokedAt !== null);
  assert.equal(body.activeCount, 1, '★ activeCount 只算未撤销的');
});

test('★ 未登录 → 401（不泄露任何身份）', async () => {
  const { routes } = makeRoutes();
  const response = await callAs(routes, null, '/api/me/identities');
  assert.equal(response.status, 401);
});

test('★ 未装配身份存储 → 501（显式不可用，而不是返回空列表）', async () => {
  const sessions = new SessionService({ store: new InMemorySessionStore() });
  const routes = createAppRoutes({ sessions, logger: silentLogger } as never);
  const response = await callAs(routes, ALICE, '/api/me/identities');
  assert.equal(response.status, 501);
});
