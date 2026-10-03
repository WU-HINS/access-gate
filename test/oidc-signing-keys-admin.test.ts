/**
 * ★ P1-4：OIDC 签名密钥的**可运维入口**（`docs/05 §8.4`）。
 *
 * ★ 为什么需要端点而不只是调度器：轮换是**高危操作**（零 active 窗口 = 全站登录中断）。
 *   只有自动轮换时，运维在出问题时**没有任何受控手段**——既看不到状态，也无法手动推进。
 *
 * ★ 本文件要证明：
 *   ① 未装配 `signingKeys` → **501**（显式不可用，而不是返回空列表让人以为"没有密钥"）；
 *   ② `GET` 列出状态且时间为 **ISO 串**（跨时区不产生歧义）；
 *   ③ `POST rotate` 真的调用 `rotateOnce` 并把动作/说明回给调用方。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import type { SigningKeyRecord } from '../src/core/oidc-key-rotation.ts';

const ADMIN_SESSION = {
  userId: 'admin-1',
  username: 'admin',
  activeSiteId: 'site-1',
  realm: 'developer' as const,
  role: 'admin' as const,
};

const KEY: SigningKeyRecord = {
  kid: 'es256-abc',
  alg: 'ES256',
  status: 'active',
  activatedAt: new Date('2026-09-26T00:00:00Z'),
  retiredFromSigningAt: null,
  removeAfter: null,
  createdAt: new Date('2026-09-26T00:00:00Z'),
};

function makeHandler(extra: Record<string, unknown> = {}) {
  return createAdminHandler({
    ...extra,
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: {
      list: async () => [],
      get: async () => undefined,
      versions: async () => [],
    } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    logger: silentLogger,
  });
}

const call = (
  handler: ReturnType<typeof makeHandler>,
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> =>
  handler({ method, path, session: ADMIN_SESSION } as never) as never;

test('★ 未装配 signingKeys → **501**（显式不可用，而不是返回空列表）', async () => {
  const handler = makeHandler();
  const response = await call(handler, 'GET', '/api/admin/oidc/signing-keys');
  assert.equal(response.status, 501);
});

test('GET → 列出密钥状态，时间为 ISO 串（跨时区不产生歧义）', async () => {
  const handler = makeHandler({
    signingKeys: {
      list: async () => [KEY],
      rotateOnce: async () => ({ action: 'none', detail: '无需动作' }),
    },
  });
  const response = await call(handler, 'GET', '/api/admin/oidc/signing-keys');
  assert.equal(response.status, 200);
  const keys = response.body['keys'] as Record<string, unknown>[];
  assert.equal(keys.length, 1);
  assert.equal(keys[0]!['kid'], 'es256-abc');
  assert.equal(keys[0]!['alg'], 'ES256');
  assert.equal(keys[0]!['status'], 'active');
  assert.equal(keys[0]!['activatedAt'], '2026-09-26T00:00:00.000Z');
  assert.equal(keys[0]!['removeAfter'], null, '未退休的密钥没有 removeAfter');
});

test('★ POST rotate → 真的调用 `rotateOnce`，并把动作与说明回给调用方', async () => {
  let calls = 0;
  const handler = makeHandler({
    signingKeys: {
      list: async () => [KEY],
      rotateOnce: async () => {
        calls += 1;
        return { action: 'publish_standby', detail: '已发布 standby（等待下游缓存过期后再切换）' };
      },
    },
  });
  const response = await call(handler, 'POST', '/api/admin/oidc/signing-keys/rotate');
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(response.body['action'], 'publish_standby');
  assert.match(String(response.body['detail']), /standby/);
});

test('POST rotate 也走 501（未装配时不得静默成功）', async () => {
  const handler = makeHandler();
  const response = await call(handler, 'POST', '/api/admin/oidc/signing-keys/rotate');
  assert.equal(response.status, 501);
});
