/**
 * 官方薄 SDK 验收（M5-5）。
 *
 * ★ 本文件用**真实的平台服务 + 真实的 HTTP 往返**验证 SDK，
 *   因为 SDK 的价值恰恰在「网络边界上的正确性」（签名、验签、轮询节奏），
 *   用 mock 掉 HTTP 就测不到它。
 *
 * ★ 重点不是「能发请求」，而是三条**替调用方做掉的最易错的事**：
 *   1. 签名完整（含 bodyHash）；
 *   2. **验签响应**——否则中间人可以伪造「eligible: true」；
 *   3. **轮询遵守服务端 interval**——手写循环极易写成 100ms 一次而触发 429。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppServer, newCsrfSecret, type Route } from '../src/http/server.ts';
import { createVerifyRoutes, type AssertionSource } from '../src/http/verify-routes.ts';
import { InMemorySessionStore, SessionService } from '../src/auth/session.ts';
import { InMemoryNonceStore, InMemoryVerifyClientStore } from '../src/verify/hmac.ts';
import { DeviceCodeService, InMemoryChallengeStore } from '../src/verify/device-code.ts';
import { generateSigningKey, SigningKeySet, type ManagedSigningKey } from '../src/verify/jws.ts';
import { createVerifyClient, VerifyClientError, type FetchLike } from '../src/verify/sdk.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');
const ISS = 'https://gate.example.com';

const assertionSource: AssertionSource = {
  async lookup(subject) {
    if (subject.value === 'u1') {
      return { matched: true, displayName: 'alice', assertions: { eligible: true, tier: 2, tags: ['verified:contributor'] } };
    }
    return null;
  },
};

/** 起一个真实平台服务，并返回 SDK 可用的 base 与凭据。 */
async function startPlatform() {
  const key = await generateSigningKey('ec-sdk-1');
  const signingKeys = new SigningKeySet();
  signingKeys.add({ ...key, status: 'active', createdAt: NOW } as ManagedSigningKey);

  const clients = new InMemoryVerifyClientStore();
  const { client, secret } = clients.register({ name: 'sdk-bot', scopes: ['assert:read', 'challenge:create'] });

  // ★ 可变时钟：轮询有最小间隔，测试需要能推进它（固定时钟下两次轮询间隔为 0 会被限速）
  let deviceClock = NOW;
  const deviceCode = new DeviceCodeService({ store: new InMemoryChallengeStore(), publicUrl: ISS, now: () => deviceClock });
  const routes: Route[] = createVerifyRoutes({
    clients,
    nonces: new InMemoryNonceStore(),
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
    client,
    secret,
    deviceCode,
    signingKeys,
    advanceDeviceClock: (ms: number) => {
      deviceClock = new Date(deviceClock.getTime() + ms);
    },
  };
}

/** 把全局 fetch 适配成 SDK 的 FetchLike（真实 HTTP 往返）。 */
/** 与平台同源的固定时钟（签名时间戳必须与平台判断的时间一致）。 */
const nowAt = () => NOW;

const realFetch: FetchLike = (url, init) =>
  fetch(url, {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.body === undefined ? {} : { body: init.body }),
  }) as unknown as ReturnType<FetchLike>;

/** 一个会篡改响应体的 fetch（模拟中间人）。 */
function tamperingFetch(tamper: (body: string) => string): FetchLike {
  return async (url, init) => {
    const response = await realFetch(url, init);
    const text = await response.text();
    const isJwks = url.includes('/jwks');
    return {
      status: response.status,
      headers: {},
      // JWKS 不能篡改（否则验签基础设施本身被破坏，测试就失去意义）
      text: async () => (isJwks ? text : tamper(text)),
    };
  };
}

// ─────────────────────────── assert ───────────────────────────

test('★ M5-5：`assert` 发签名请求并**验签响应**（真实 HTTP 往返）', async () => {
  const platform = await startPlatform();
  try {
    const client = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: realFetch, now: nowAt });
    const result = await client.assert({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible', 'tier'] });
    assert.equal(result.matched, true);
    assert.equal(result.assertions['eligible'], true);
    assert.equal(result.assertions['tier'], 2);
    assert.ok(result.signature !== undefined, '平台应签发断言');
    // 最小披露：未请求的 claim 不返回
    assert.equal(result.assertions['tags'], undefined);
  } finally {
    await platform.close();
  }
});

test('★ M5-5：响应被**篡改** → SDK 拒绝（否则中间人可伪造 eligible）', async () => {
  const platform = await startPlatform();
  try {
    // 中间人把 eligible 改成 true、tier 改成 99
    const tamper = tamperingFetch((body) => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed['assertions'] !== undefined) parsed['assertions'] = { eligible: true, tier: 99 };
        return JSON.stringify(parsed);
      } catch {
        return body;
      }
    });
    const client = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: tamper, now: nowAt });
    // ★ 期望行为不是「报错」，而是「**用受签名保护的权威内容覆盖外层字段**」：
    //   平台响应里 `assertions` 出现两次（JWS 内受保护 / 外层不受保护），
    //   验签后必须以外层字段**不可信**为前提，用 JWS payload 覆盖它。
    const result = await client.assert({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible', 'tier'] });
    assert.equal(result.assertions['tier'], 2, '★ 必须返回权威内容（2），而不是被篡改的外层值（99）');
    assert.equal(result.assertions['eligible'], true);
  } finally {
    await platform.close();
  }
});

test('★ M5-5：**签名有效但内容被替换**（subject 不匹配）也被拒', async () => {
  const platform = await startPlatform();
  try {
    // 中间人把外层 subject.value 换成别人，但保留原签名
    const tamper = tamperingFetch((body) => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed['signature'] !== undefined && parsed['subject'] !== undefined) {
          parsed['subject'] = { type: 'platform_user_id', value: 'ATTACKER' };
        }
        return JSON.stringify(parsed);
      } catch {
        return body;
      }
    });
    const client = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: tamper, now: nowAt });
    await assert.rejects(
      client.assert({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] }),
      (error: unknown) => {
        assert.ok(error instanceof VerifyClientError);
        // 断言内部 sub 是 u1，外层被换成 ATTACKER → 必须检出
        assert.equal(error.code, 'subject_mismatch', '★ 必须与「签名不对」区分开（后者可能是轮换，前者是攻击）');
        assert.match(error.message, /不匹配|不一致/);
        return true;
      },
    );
  } finally {
    await platform.close();
  }
});

test('★ M5-5：响应**缺少签名**默认被拒（关掉需显式声明并承担后果）', async () => {
  const platform = await startPlatform();
  try {
    const stripping = tamperingFetch((body) => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        delete parsed['signature'];
        return JSON.stringify(parsed);
      } catch {
        return body;
      }
    });
    const strict = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: stripping, now: nowAt });
    await assert.rejects(strict.assert({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] }), (error: unknown) => {
      assert.ok(error instanceof VerifyClientError);
      assert.equal(error.code, 'missing_signature');
      assert.match(error.message, /verifyResponses: false/, '错误信息要告诉调用方如何显式关掉');
      return true;
    });

    // 显式关掉 → 通过（但这是调用方的选择）
    const relaxed = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: stripping, verifyResponses: false, now: nowAt });
    const result = await relaxed.assert({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] });
    assert.equal(result.assertions['eligible'], true);
  } finally {
    await platform.close();
  }
});

test('M5-5：未知主体 → `matched: false`（不签发，SDK 不尝试验签）', async () => {
  const platform = await startPlatform();
  try {
    const client = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: realFetch, now: nowAt });
    const result = await client.assert({ subject: { type: 'platform_user_id', value: 'ghost' }, claims: ['eligible'] });
    assert.equal(result.matched, false);
    assert.equal(result.signature, undefined);
  } finally {
    await platform.close();
  }
});

test('M5-5：认证失败（错误 secret）→ 明确报错', async () => {
  const platform = await startPlatform();
  try {
    const client = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: 'wrong-secret', fetch: realFetch, now: nowAt });
    await assert.rejects(client.assert({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] }), (error: unknown) => {
      assert.ok(error instanceof VerifyClientError);
      assert.equal(error.code, 'assert_failed');
      assert.equal(error.status, 401);
      return true;
    });
  } finally {
    await platform.close();
  }
});

// ─────────────────────────── 设备码流 ───────────────────────────

test('★ M5-5：`challenge` + `waitForApproval` 走通（并验签签发的断言）', async () => {
  const platform = await startPlatform();
  try {
    const client = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: realFetch, now: nowAt });
    const created = await client.challenge({ subject: { type: 'discord_id', value: '1234567' }, scopes: ['assert:read'] });
    assert.match(created.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(created.interval, 3);

    // 用户确认（服务端时钟固定，approve 直接调用服务对象）
    const approved = await platform.deviceCode.approve(created.userCode, 'u1');
    assert.equal(approved.ok, true);

    // ★ 推进服务端时钟越过轮询最小间隔（否则第二次 poll 会被服务端限速 429）
    const result = await client.waitForApproval(created, {
      sleep: async (ms) => {
        platform.advanceDeviceClock(ms);
      },
    });
    assert.equal(result.status, 'approved');
    if (result.status === 'approved') {
      assert.equal(result.assertion.assertions['tier'], 2, 'SDK 已验签该断言');
    }
  } finally {
    await platform.close();
  }
});

test('★ M5-5：轮询间隔**取自服务端 interval**（留余量，不写死 100ms）', async () => {
  const platform = await startPlatform();
  try {
    const client = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: realFetch, now: nowAt });
    const created = await client.challenge({ subject: { type: 'discord_id', value: '1234567' }, scopes: [] });
    const slept: number[] = [];
    // 不 approve → 一直 pending；用 timeoutMs 提前结束
    const result = await client.waitForApproval(created, {
      timeoutMs: 1,
      sleep: async (ms) => void slept.push(ms),
    });
    assert.equal(result.status, 'expired', '超时应返回 expired');
    // 间隔应基于 interval=3s 且带余量（≥3000），而不是写死的小值
    for (const ms of slept) assert.ok(ms >= 3_000, `轮询间隔应 ≥ interval（实际 ${ms}ms）`);
  } finally {
    await platform.close();
  }
});

// ─────────────────────────── webhook 验签 ───────────────────────────

test('★ M5-5：webhook 验签（否则任何人都能伪造 policy.granted 事件）', async () => {
  const platform = await startPlatform();
  try {
    const client = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: realFetch, now: nowAt });
    const { createHmac } = await import('node:crypto');
    const body = JSON.stringify({ event: 'policy.granted', eventId: 'evt_1' });
    const signature = createHmac('sha256', platform.secret).update(body, 'utf8').digest('hex');

    const ok = await client.verifyWebhook({ headers: { 'x-gate-signature': `sha256=${signature}` }, rawBody: body });
    assert.equal(ok.ok, true);

    // 篡改 body → 拒
    const tampered = await client.verifyWebhook({ headers: { 'x-gate-signature': `sha256=${signature}` }, rawBody: body.replace('granted', 'revoked') });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.reason, 'signature_mismatch');

    // 缺签名 → 拒
    const missing = await client.verifyWebhook({ headers: {}, rawBody: body });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing_signature');

    // 格式不对 → 拒
    const badFormat = await client.verifyWebhook({ headers: { 'x-gate-signature': signature }, rawBody: body });
    assert.equal(badFormat.ok, false);
    assert.equal(badFormat.reason, 'missing_signature');
  } finally {
    await platform.close();
  }
});

// ─────────────────────────── JWKS 与手动验签 ───────────────────────────

test('★ M5-5：`verifyAssertion` 可对任意断言手动验签（离线复核）', async () => {
  const platform = await startPlatform();
  try {
    const client = createVerifyClient({ baseUrl: platform.base, clientId: platform.client.clientId, secret: platform.secret, fetch: realFetch, now: nowAt });
    const response = await client.assert({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] });
    assert.ok(response.signature !== undefined);

    const verified = await client.verifyAssertion(response.signature, 'u1');
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.payload.sub, 'u1');
      assert.equal(verified.payload.assertions['eligible'], true);
    }
    // 主体不匹配 → 拒
    const wrongSubject = await client.verifyAssertion(response.signature, 'someone-else');
    assert.equal(wrongSubject.ok, false);

    // JWKS 可读且含 kid
    const keys = await client.jwks();
    assert.equal(keys.keys[0]?.kid, 'ec-sdk-1');
  } finally {
    await platform.close();
  }
});
