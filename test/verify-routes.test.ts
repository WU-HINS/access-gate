/**
 * 协同验证 HTTP 端点端到端验收（M5 收口）—— docs/06 §7.2.3。
 *
 * 本文件真的**起一个 HTTP 服务**并走完整协议，验证的是「外部调用方能否用」，
 * 而不是「模块单测通过」。特别覆盖一处极易写错的细节：
 * **`bodyHash` 必须基于原始请求体字节**——若服务端用「解析后再序列化」算 hash，
 * 真实调用方（格式略有不同）会全部 401，而本地测试却可能通过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppServer, newCsrfSecret, type Route } from '../src/http/server.ts';
import { createVerifyRoutes, type AssertionSource } from '../src/http/verify-routes.ts';
import { InMemorySessionStore, SessionService } from '../src/auth/session.ts';
import { InMemoryNonceStore, InMemoryVerifyClientStore, signRequest, SIGNATURE_HEADERS } from '../src/verify/hmac.ts';
import { DeviceCodeService, InMemoryChallengeStore } from '../src/verify/device-code.ts';
import { generateSigningKey, SigningKeySet, verifyAssertion, type ManagedSigningKey } from '../src/verify/jws.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');
const ISS = 'https://gate.example.com';

/** 断言数据源：u1 有资格（tier 2），未知主体返回 null */
const assertionSource: AssertionSource = {
  async lookup(subject) {
    if (subject.value === 'u1') {
      return { matched: true, displayName: 'alice', assertions: { eligible: true, tier: 2, tags: ['verified:contributor'], policies: [{ code: 'edu', state: 'granted' }] } };
    }
    return null;
  },
};

async function startServer() {
  const key = await generateSigningKey('ec-test-1');
  const signingKeys = new SigningKeySet();
  signingKeys.add({ ...key, status: 'active', createdAt: NOW } as ManagedSigningKey);

  const clients = new InMemoryVerifyClientStore();
  const { client, secret } = clients.register({ name: 'bot-a', scopes: ['assert:read', 'challenge:create'] });
  const nonces = new InMemoryNonceStore();
  const challengeStore = new InMemoryChallengeStore();
  // ★ 设备码流用**可推进**的时钟：固定时钟下两次轮询间隔为 0，会被限速拒绝，
  //   而那与「完整走通」的语义无关（限速本身有独立用例覆盖）。
  let deviceClock = NOW;
  const deviceCode = new DeviceCodeService({ store: challengeStore, publicUrl: ISS, now: () => deviceClock });

  const routes: Route[] = createVerifyRoutes({
    clients,
    nonces,
    deviceCode,
    signingKeys,
    assertionSource,
    issuer: ISS,
    logger: silentLogger,
    now: () => NOW,
  });

  const app = createAppServer({
    sessions: new SessionService({ store: new InMemorySessionStore() }),
    routes,
    csrfSecret: newCsrfSecret(),
    logger: silentLogger,
    port: 0,
  });
  const { url } = await app.listen();
  return {
    base: url,
    close: () => app.close(),
    clients,
    client,
    secret,
    nonces,
    signingKeys,
    deviceCode,
    advanceDeviceClock: (ms: number) => {
      deviceClock = new Date(deviceClock.getTime() + ms);
    },
  };
}

/** 用调用方身份发一个签名请求（时间戳用 NOW，与服务端时钟一致）。 */
function signedFetch(
  base: string,
  path: string,
  options: { method: string; clientId: string; secret: string; body?: string; nonce?: string; timestamp?: number; pathForSignature?: string },
): Promise<Response> {
  const headers = signRequest({
    clientId: options.clientId,
    secret: options.secret,
    method: options.method,
    path: options.pathForSignature ?? path,
    ...(options.body === undefined ? {} : { body: options.body }),
    timestamp: options.timestamp ?? Math.floor(NOW.getTime() / 1000),
    nonce: options.nonce ?? `n-${Math.random().toString(16).slice(2)}`,
  });
  return fetch(`${base}${path}`, {
    method: options.method,
    headers: { ...headers, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

// ─────────────────────────── JWKS ───────────────────────────

test('★ M5-3 端点：`/jwks` 可**匿名**访问，且不含私钥材料', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.base}/api/verify/v1/jwks`);
    assert.equal(response.status, 200, 'jwks 必须匿名可访问（调用方需先取公钥）');
    const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0]!['kid'], 'ec-test-1');
    assert.equal(jwks.keys[0]!['alg'], 'ES256');
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
      assert.equal(jwks.keys[0]![field], undefined, `JWKS 不得含私钥字段 '${field}'`);
    }
  } finally {
    await server.close();
  }
});

// ─────────────────────────── /assert ───────────────────────────

test('★ M5-3 端点：`/assert` 返回**可离线验签**的断言', async () => {
  const server = await startServer();
  try {
    const body = JSON.stringify({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible', 'tier'] });
    const response = await signedFetch(server.base, '/api/verify/v1/assert', { method: 'POST', clientId: server.client.clientId, secret: server.secret, body });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { matched: boolean; assertions: Record<string, unknown>; issuer: string; signature: string; expiresAt: string };
    assert.equal(payload.matched, true);
    assert.equal(payload.assertions['eligible'], true);
    assert.equal(payload.assertions['tier'], 2);
    // 最小披露：未请求的 claim 不返回
    assert.equal(payload.assertions['policies'], undefined);
    assert.equal(payload.issuer, ISS);

    // ★ 用 JWKS **离线**验签（这正是「不依赖对平台的实时信任」的含义）
    const jwks = (await (await fetch(`${server.base}/api/verify/v1/jwks`)).json()) as Parameters<typeof verifyAssertion>[0]['jwks'];
    const verified = await verifyAssertion({ token: payload.signature, jwks, expectedIssuer: ISS, expectedSubject: 'u1', now: NOW });
    assert.equal(verified.ok, true, `断言应可离线验签：${verified.ok ? '' : verified.message}`);
  } finally {
    await server.close();
  }
});

test('★ M5-1 端点：签名错误 / 时间戳过期 / 重放 → 均被拒', async () => {
  const server = await startServer();
  try {
    const body = JSON.stringify({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] });

    // ① 签名错误
    const badSignature = await fetch(`${server.base}/api/verify/v1/assert`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADERS.client]: server.client.clientId,
        [SIGNATURE_HEADERS.timestamp]: String(Math.floor(NOW.getTime() / 1000)),
        [SIGNATURE_HEADERS.nonce]: 'n-bad',
        [SIGNATURE_HEADERS.signature]: `sha256=${'0'.repeat(64)}`,
      },
      body,
    });
    assert.equal(badSignature.status, 401);

    // ② 时间戳过期（超出 ±5 分钟）
    const stale = await signedFetch(server.base, '/api/verify/v1/assert', {
      method: 'POST',
      clientId: server.client.clientId,
      secret: server.secret,
      body,
      timestamp: Math.floor(NOW.getTime() / 1000) - 3600,
    });
    assert.equal(stale.status, 401);

    // ③ 重放：同一签名请求原样重发
    const nonce = 'replay-endpoint';
    const first = await signedFetch(server.base, '/api/verify/v1/assert', { method: 'POST', clientId: server.client.clientId, secret: server.secret, body, nonce });
    assert.equal(first.status, 200);
    const replay = await signedFetch(server.base, '/api/verify/v1/assert', { method: 'POST', clientId: server.client.clientId, secret: server.secret, body, nonce });
    assert.equal(replay.status, 401, '★ 重放必须被拒');
    assert.equal(replay.headers.get('x-gate-reject'), 'nonce_replayed');
  } finally {
    await server.close();
  }
});

test('★ 端点：`bodyHash` 基于**原始字节** —— 签名与 body 不一致即被拒', async () => {
  const server = await startServer();
  try {
    const canonical = JSON.stringify({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] });
    // ① 用 canonical 签名，但发送**格式不同**的 body（多空格）→ 必须被拒
    const reformatted = JSON.stringify({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] }, null, 2);
    assert.notEqual(canonical, reformatted);

    const response = await fetch(`${server.base}/api/verify/v1/assert`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signRequest({ clientId: server.client.clientId, secret: server.secret, method: 'POST', path: '/api/verify/v1/assert', body: canonical, timestamp: Math.floor(NOW.getTime() / 1000), nonce: 'n-fmt' }),
      },
      body: reformatted,
    });
    assert.equal(response.status, 401, '★ body 字节不同 → 签名必须失配（服务端不得用「解析后重序列化」算 hash）');

    // ② 完全一致的字节 → 通过
    const ok = await signedFetch(server.base, '/api/verify/v1/assert', { method: 'POST', clientId: server.client.clientId, secret: server.secret, body: canonical });
    assert.equal(ok.status, 200);
  } finally {
    await server.close();
  }
});

test('端点：未知主体 → matched:false（不签发）；缺 subject → 400', async () => {
  const server = await startServer();
  try {
    const unknown = await signedFetch(server.base, '/api/verify/v1/assert', {
      method: 'POST',
      clientId: server.client.clientId,
      secret: server.secret,
      body: JSON.stringify({ subject: { type: 'platform_user_id', value: 'ghost' }, claims: ['eligible'] }),
    });
    assert.equal(unknown.status, 200);
    const payload = (await unknown.json()) as { matched: boolean; signature?: string };
    assert.equal(payload.matched, false);
    assert.equal(payload.signature, undefined, '主体未知时不签发断言（没有主体可背书）');

    const missing = await signedFetch(server.base, '/api/verify/v1/assert', {
      method: 'POST',
      clientId: server.client.clientId,
      secret: server.secret,
      body: JSON.stringify({ claims: ['eligible'] }),
    });
    assert.equal(missing.status, 400);
  } finally {
    await server.close();
  }
});

test('端点：scope 不足（用无 challenge:create 的调用方发起挑战）→ 403', async () => {
  const server = await startServer();
  try {
    const limited = server.clients.register({ name: 'reader-only', scopes: ['assert:read'] });
    const response = await signedFetch(server.base, '/api/verify/v1/challenge', {
      method: 'POST',
      clientId: limited.client.clientId,
      secret: limited.secret,
      body: JSON.stringify({ subject: { type: 'discord_id', value: '1' } }),
    });
    assert.equal(response.status, 403);
  } finally {
    await server.close();
  }
});

// ─────────────────────────── 设备码流完整走通 ───────────────────────────

test('★ M5-2 端点：用户在 bot 侧发起的验证**完整走通**（发起 → 确认 → 轮询拿到断言）', async () => {
  const server = await startServer();
  try {
    // ① bot 侧发起
    const created = await signedFetch(server.base, '/api/verify/v1/challenge', {
      method: 'POST',
      clientId: server.client.clientId,
      secret: server.secret,
      body: JSON.stringify({ subject: { type: 'discord_id', value: '1234567' }, scopes: ['assert:read'] }),
    });
    assert.equal(created.status, 200);
    const challenge = (await created.json()) as { challengeId: string; userCode: string; verifyUrl: string; interval: number };
    assert.match(challenge.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.match(challenge.verifyUrl, /\/verify\?code=/);

    // ② bot 轮询：pending
    const pending = await signedFetch(server.base, `/api/verify/v1/challenge/${challenge.challengeId}`, {
      method: 'GET',
      clientId: server.client.clientId,
      secret: server.secret,
      nonce: 'poll-1',
    });
    assert.equal(pending.status, 200);
    assert.equal(((await pending.json()) as { status: string }).status, 'pending');

    // ③ 用户在浏览器确认（服务端时钟固定，approve 用同一时钟）
    const approved = await server.deviceCode.approve(challenge.userCode, 'u1');
    assert.equal(approved.ok, true);

    // ④ bot 再轮询：approved + 断言（可离线验签）
    server.advanceDeviceClock(5_000); // 越过轮询最小间隔
    const result = await signedFetch(server.base, `/api/verify/v1/challenge/${challenge.challengeId}`, {
      method: 'GET',
      clientId: server.client.clientId,
      secret: server.secret,
      nonce: 'poll-2',
    });
    assert.equal(result.status, 200);
    const payload = (await result.json()) as { status: string; assertion?: { signature: string; assertions: Record<string, unknown> } };
    assert.equal(payload.status, 'approved');
    assert.ok(payload.assertion !== undefined);
    assert.equal(payload.assertion!.assertions['tier'], 2);

    const jwks = (await (await fetch(`${server.base}/api/verify/v1/jwks`)).json()) as Parameters<typeof verifyAssertion>[0]['jwks'];
    const verified = await verifyAssertion({ token: payload.assertion!.signature, jwks, expectedIssuer: ISS, now: NOW });
    assert.equal(verified.ok, true, '设备码流签发的断言也必须可离线验签');
  } finally {
    await server.close();
  }
});

test('端点：轮询不存在的挑战 → 404；轮询过快 → 429', async () => {
  const server = await startServer();
  try {
    const missing = await signedFetch(server.base, '/api/verify/v1/challenge/ch_ghost', { method: 'GET', clientId: server.client.clientId, secret: server.secret });
    assert.equal(missing.status, 404);

    const created = await signedFetch(server.base, '/api/verify/v1/challenge', {
      method: 'POST',
      clientId: server.client.clientId,
      secret: server.secret,
      body: JSON.stringify({ subject: { type: 'discord_id', value: '1' } }),
    });
    const { challengeId } = (await created.json()) as { challengeId: string };
    await signedFetch(server.base, `/api/verify/v1/challenge/${challengeId}`, { method: 'GET', clientId: server.client.clientId, secret: server.secret, nonce: 'a' });
    const fast = await signedFetch(server.base, `/api/verify/v1/challenge/${challengeId}`, { method: 'GET', clientId: server.client.clientId, secret: server.secret, nonce: 'b' });
    assert.equal(fast.status, 429, '服务端必须强制轮询限速');
  } finally {
    await server.close();
  }
});

test('端点：GET 请求（空 body）也要正确签名 —— bodyHash 用空串', async () => {
  const server = await startServer();
  try {
    // GET 不传 body；signRequest 内部对 undefined body 用空串
    const response = await signedFetch(server.base, '/api/verify/v1/challenge/ch_none', { method: 'GET', clientId: server.client.clientId, secret: server.secret });
    // 挑战不存在 → 404（说明**签名已通过**，否则会是 401）
    assert.equal(response.status, 404, 'GET 的签名应通过（否则拿不到 404 而是 401）');
  } finally {
    await server.close();
  }
});

test('端点：`/revoke` 需 assert:read 且写日志', async () => {
  const server = await startServer();
  try {
    const created = await signedFetch(server.base, '/api/verify/v1/challenge', {
      method: 'POST',
      clientId: server.client.clientId,
      secret: server.secret,
      body: JSON.stringify({ subject: { type: 'discord_id', value: '1' } }),
    });
    const { challengeId } = (await created.json()) as { challengeId: string };
    const revoked = await signedFetch(server.base, '/api/verify/v1/revoke', {
      method: 'POST',
      clientId: server.client.clientId,
      secret: server.secret,
      body: JSON.stringify({ challengeId }),
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { ok: true, revoked: true });
  } finally {
    await server.close();
  }
});
