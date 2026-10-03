/**
 * 断言流水与撤销验收（P0；docs/06 `/admin/verify/assertions`）。
 *
 * ★★ 核心断言：**撤销幂等且保留首次撤销时间**。
 *   撤销是「发现异常后止血」的动作——若重复调用会报错或改写时间，
 *   运维在最紧张的时刻会怀疑「到底撤没撤掉」，
 *   而「什么时候发现的」这个证据也会丢失。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemoryAssertionAdminStore, type AssertionRecord } from '../src/verify/assertion-store.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ADMIN_SESSION = { userId: 'admin-1', username: 'admin', activeSiteId: 'site-1', realm: 'developer' as const, role: 'admin' as const };

const assertion = (overrides: Partial<AssertionRecord>): AssertionRecord => ({
  id: 1,
  clientId: 'vc_aaa',
  subjectType: 'platform_user_id',
  subjectValue: 'u-1',
  matched: true,
  via: 'direct',
  claims: { eligible: true },
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  revokedAt: null,
  createdAt: new Date('2025-06-01T00:00:00Z'),
  ...overrides,
});

function makeHandler() {
  const assertions = new InMemoryAssertionAdminStore();
  assertions.seed(assertion({ id: 1, clientId: 'vc_aaa' }));
  assertions.seed(assertion({ id: 2, clientId: 'vc_bbb', via: 'challenge' }));
  assertions.seed(assertion({ id: 3, clientId: 'vc_aaa', revokedAt: new Date('2025-06-02T00:00:00Z') }));
  assertions.seed(assertion({ id: 4, clientId: 'vc_aaa', expiresAt: new Date('2020-01-01T00:00:00Z') }));
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    assertions,
    logger: silentLogger,
  });
  return { handler, assertions };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], method: string, path: string, query?: Record<string, string>) =>
  handler({ method, path, query, session: ADMIN_SESSION } as never);

// ─────────────────────────── 流水 ───────────────────────────

test('★ `GET /verify/assertions` 列出流水（含 id / via / revokedAt）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'GET', '/api/admin/verify/assertions')) as {
    status: number;
    body: { assertions: { id: number; clientId: string; via: string; revokedAt: string | null }[]; totalIsExact: boolean };
  };
  assert.equal(response.status, 200);
  assert.equal(response.body.assertions.length, 4);
  assert.equal(response.body.totalIsExact, false, '与 users 一致：不做 count(*)');
  // ★ id 是数字（bigserial），不是 uuid 字符串
  assert.equal(typeof response.body.assertions[0]!.id, 'number');
});

test('★ 支持按 clientId 过滤与 `onlyActive`（只看未撤销且未过期的）', async () => {
  const { handler } = makeHandler();
  const byClient = (await call(handler, 'GET', '/api/admin/verify/assertions', { clientId: 'vc_aaa' })) as { body: { assertions: unknown[] } };
  assert.equal(byClient.body.assertions.length, 3, 'vc_aaa 有 3 条（含已撤销与已过期的）');

  const active = (await call(handler, 'GET', '/api/admin/verify/assertions', { onlyActive: '1' })) as { body: { assertions: { id: number }[] } };
  // ★ 只剩 id=1、2（3 已撤销、4 已过期）
  assert.deepEqual(active.body.assertions.map((entry) => entry.id).sort((a, b) => a - b), [1, 2]);
});

// ─────────────────────────── ★★ 撤销幂等 ───────────────────────────

test('★★ 撤销：立即生效，且**幂等**——重复撤销保留首次撤销时间', async () => {
  const { handler, assertions } = makeHandler();

  const first = (await call(handler, 'POST', '/api/admin/verify/assertions/1/revoke')) as {
    status: number;
    body: { assertion: { revokedAt: string }; alreadyRevoked: boolean; note: string };
  };
  assert.equal(first.status, 200);
  assert.equal(first.body.alreadyRevoked, false);
  assert.ok(first.body.assertion.revokedAt !== null);
  assert.match(first.body.note, /立即失效/);
  const firstRevokedAt = first.body.assertion.revokedAt;

  // ★★ 重复撤销：不报错，但明确告知「之前就撤销过」，且**时间不变**
  const second = (await call(handler, 'POST', '/api/admin/verify/assertions/1/revoke')) as {
    status: number;
    body: { assertion: { revokedAt: string }; alreadyRevoked: boolean; note: string };
  };
  assert.equal(second.status, 200, '★ 重复撤销不应报错（幂等）');
  assert.equal(second.body.alreadyRevoked, true);
  assert.equal(second.body.assertion.revokedAt, firstRevokedAt, '★ 保留首次撤销时间（那是「什么时候发现的」的证据）');
  assert.match(second.body.note, /此前已被撤销/);

  // 状态确实已撤销
  assert.ok((await assertions.get(1))?.revokedAt !== null);
});

test('★★ 断言 id 是 **bigserial（数字）** —— 非数字 id 返回 400 并说明原因', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/verify/assertions/not-a-number/revoke')) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /bigserial/);
  assert.match(response.body.error, /不是 uuid/, '★ 错误信息要说明「这张表的主键与验证调用方表不同」');
});

test('撤销不存在的断言 → 404；已撤销的断言再次撤销 → 200（幂等）', async () => {
  const { handler } = makeHandler();
  assert.equal(((await call(handler, 'POST', '/api/admin/verify/assertions/999/revoke')) as { status: number }).status, 404);
  // id=3 预置为已撤销
  const again = (await call(handler, 'POST', '/api/admin/verify/assertions/3/revoke')) as { status: number; body: { alreadyRevoked: boolean } };
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyRevoked, true);
});
