/**
 * bot-bridge 参考实现验收（M4-16）。
 *
 * 验收标准：**「展示『标准协议 + 插件适配』的组合」**。
 *
 * 因此本文件的中心断言是**分工**：协议动作全部委托给 core 注入的 `VerifyProtocol`，
 * 插件自己只做「框架特有输入 → 标准协议入参」的翻译。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptSlashCommand,
  BOT_BRIDGE_MANIFEST,
  BOT_BRIDGE_SUBSCRIPTIONS,
  buildEventPush,
  FRAMEWORK_INTEGRATION_MATRIX,
  handleBindComplete,
  handlePoll,
  handleStart,
  verifyEventPush,
  type BotBridgeDeps,
  type VerifyProtocol,
} from '../src/plugin/builtin/bot-bridge.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');
const SECRET = 'shared-secret';

/** 记录协议调用（用于验证「委托」） */
function protocolOf(overrides: Partial<VerifyProtocol> = {}): { protocol: VerifyProtocol; calls: string[] } {
  const calls: string[] = [];
  const protocol: VerifyProtocol = {
    async startChallenge(input) {
      calls.push(`start:${input.subject.value}`);
      return { challengeId: 'ch-1', userCode: 'DEV7F3AK92M', verifyUrl: 'https://gate/verify', expiresIn: 900, interval: 3, pollToken: 'poll-secret' };
    },
    async poll() {
      calls.push('poll');
      return { status: 'pending' };
    },
    async verifyCallback(input) {
      calls.push('verify');
      void input;
      return { ok: true };
    },
    ...overrides,
  };
  return { protocol, calls };
}

function depsOf(overrides: Partial<VerifyProtocol> = {}): BotBridgeDeps & { calls: string[] } {
  const { protocol, calls } = protocolOf(overrides);
  return { protocol, publicUrl: 'https://gate.example.com/', callbackSecretRef: 'bot.callback_secret', logger: undefined, calls };
}

// ═══════════════════════════ manifest ═══════════════════════════

test('★ M4-16：manifest 的权限**收窄到具体路径**（参考实现要示范最小权限）', () => {
  const permissions = (BOT_BRIDGE_MANIFEST as unknown as { permissions: string[] }).permissions;
  assert.deepEqual(permissions, [
    'route:register:/verify/*',
    'route:register:/bind/*',
    'verify:assert',
    'storage:write:self',
    'events:subscribe:policy.granted,policy.revoked',
  ]);
  // ★ 不能出现通配的 route:register
  for (const permission of permissions) {
    assert.notEqual(permission, 'route:register', '不得声明通配的端点权限');
    assert.notEqual(permission, 'route:register:*', '不得声明通配的端点权限');
  }
});

test('★ M4-16：三个端点与订阅声明与 docs/03 §1.14.2 对齐', () => {
  const endpoints = (BOT_BRIDGE_MANIFEST as unknown as { endpoints: { path: string; method: string; auth: string; visibility?: string }[] }).endpoints;
  assert.deepEqual(
    endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.auth}`),
    ['POST /verify/start none', 'GET /verify/poll pluginToken', 'POST /bind/complete hmac'],
  );
  assert.equal(endpoints[0]!.visibility, 'public', '/verify/start 是公开入口');
  const subscribes = (BOT_BRIDGE_MANIFEST as unknown as { subscribes: string[] }).subscribes;
  assert.deepEqual(subscribes, ['policy.granted', 'policy.revoked', 'checkin:granted']);
  assert.deepEqual(BOT_BRIDGE_SUBSCRIPTIONS, subscribes);
});

// ═══════════════════════════ ★ 协议委托 ═══════════════════════════

test('★ M4-16：`/verify/start` **委托给 core 的协议**（插件不自己实现 challenge）', async () => {
  const deps = depsOf();
  const result = await handleStart(deps, { externalUserId: 'u-42', platform: 'discord' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // ★ 协议被调用（而不是插件内部造了一个 challenge）
  assert.deepEqual(deps.calls, ['start:discord:u-42'], '协议动作被委托');
  assert.equal(result.userCode, 'DEV7F3AK92M');
  assert.equal(result.pollToken, 'poll-secret');
  assert.equal(result.verifyUrl, 'https://gate.example.com/verify/challenge', '末尾斜杠被归一化');
});

test('★ M4-16：`userCode` 与 `pollToken` **分开返回**（前者进公开频道，后者私密）', async () => {
  const deps = depsOf();
  const result = await handleStart(deps, { externalUserId: 'u-1', platform: 'slack' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.userCode, result.pollToken, '★ 若用 userCode 轮询，频道里任何人都能拿到别人的断言');
  // ★ pollToken 不进日志
  const { sink, records } = collectingSink();
  const withLogger = { ...depsOf(), logger: createLogger({ level: 'debug', sink }) };
  await handleStart(withLogger, { externalUserId: 'u-1', platform: 'slack' });
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes('poll-secret'), false, '★ 轮询凭据是凭据，不能落日志');
  assert.match(serialized, /ch-1/, '但 challengeId 可以记（便于排障）');
});

test('M4-16：`/verify/start` 拒绝空的外部用户标识', async () => {
  const result = await handleStart(depsOf(), { externalUserId: '   ', platform: 'discord' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.message, /缺少外部用户标识/);
  }
});

test('★ M4-16：`/verify/poll` **必须带轮询凭据**（缺失即 401）', async () => {
  const result = await handlePoll(depsOf(), { challengeId: 'ch-1', pollToken: '  ' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 401);
    assert.match(result.message, /只回给发起方/);
  }
});

test('★ M4-16：`/verify/poll` **不区分「不存在」与「凭据不匹配」**（防枚举）', async () => {
  const failing = depsOf({
    async poll() {
      throw new Error('not found or token mismatch');
    },
  });
  const result = await handlePoll(failing, { challengeId: 'ghost', pollToken: 'whatever' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 404);
    assert.match(result.message, /挑战不存在、已过期，或轮询凭据不匹配/, '★ 三者合并为一条，否则可枚举');
  }
});

test('M4-16：`/verify/poll` 透传协议状态（pending / denied / expired / approved）', async () => {
  for (const status of ['pending', 'denied', 'expired'] as const) {
    const deps = depsOf({ async poll() { return { status }; } });
    const result = await handlePoll(deps, { challengeId: 'ch', pollToken: 't' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.status, status);
  }
  const approved = depsOf({ async poll() { return { status: 'approved', assertion: { eligible: true } }; } });
  const result = await handlePoll(approved, { challengeId: 'ch', pollToken: 't' });
  assert.equal(result.ok, true);
  if (result.ok && result.status === 'approved') assert.equal(result.assertion['eligible'], true);
});

test('★ M4-16：`/bind/complete` **验签失败即拒绝**（否则可把外部账号绑到别人的平台账号）', async () => {
  const denied = depsOf({ async verifyCallback() { return { ok: false, reason: 'signature_mismatch' }; } });
  const result = await handleBindComplete(denied, {
    headers: { 'x-gate-signature': 'sha256=bad' },
    rawBody: '{}',
    parsed: { externalUserId: 'e1', platformUserId: 'victim' },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 401);
    assert.match(result.message, /防止伪造/);
  }

  const ok = depsOf();
  const good = await handleBindComplete(ok, { headers: { 'x-gate-signature': 'sha256=good' }, rawBody: '{}', parsed: { externalUserId: 'e1', platformUserId: 'p1' } });
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual({ e: good.externalUserId, p: good.platformUserId }, { e: 'e1', p: 'p1' });
});

test('M4-16：`/bind/complete` 验签通过但缺字段 → 400', async () => {
  const result = await handleBindComplete(depsOf(), { headers: {}, rawBody: '{}', parsed: { externalUserId: 'e1' } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.message, /缺少 externalUserId 或 platformUserId/);
  }
});

// ═══════════════════════════ 事件推送 ═══════════════════════════

test('★ M4-16：**只推已订阅的事件**（未订阅的一律不推）', () => {
  const notSubscribed = buildEventPush({ event: 'user.deleted', payload: { id: 'u1' }, callbackUrl: 'https://bot/cb', secret: SECRET, at: NOW });
  assert.equal(notSubscribed.ok, false);
  if (!notSubscribed.ok) {
    assert.equal(notSubscribed.reason, 'not_subscribed');
    assert.match(notSubscribed.message, /未订阅的事件不应被推送/);
  }
  // 已订阅的可推
  const subscribed = buildEventPush({ event: 'policy.granted', payload: { userId: 'u1' }, callbackUrl: 'https://bot/cb', secret: SECRET, at: NOW });
  assert.equal(subscribed.ok, true);
});

test('M4-16：未配置 callbackUrl → 不推（不是「推到默认地址」）', () => {
  const result = buildEventPush({ event: 'policy.granted', payload: {}, secret: SECRET, at: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'no_callback');
});

test('★ M4-16：推送带 HMAC 签名 + 时间戳，且**时间戳参与签名**（防重放）', () => {
  const push = buildEventPush({ event: 'policy.granted', payload: { userId: 'u1' }, callbackUrl: 'https://bot/cb', secret: SECRET, at: NOW });
  assert.equal(push.ok, true);
  if (!push.ok) return;
  assert.match(push.headers['x-gate-signature']!, /^sha256=[0-9a-f]{64}$/);
  assert.equal(push.headers['x-gate-event'], 'policy.granted');
  assert.equal(push.headers['x-gate-timestamp'], String(NOW.getTime()));

  // 对接方可自验
  const verified = verifyEventPush({
    body: push.body,
    signature: push.headers['x-gate-signature'],
    timestamp: push.headers['x-gate-timestamp'],
    secret: SECRET,
    now: NOW,
  });
  assert.equal(verified.ok, true);

  // ★ 换个时间戳（即使 body 相同）签名也必须不同 → 说明时间戳进签名
  const later = buildEventPush({ event: 'policy.granted', payload: { userId: 'u1' }, callbackUrl: 'https://bot/cb', secret: SECRET, at: new Date(NOW.getTime() + 1000) });
  if (later.ok) assert.notEqual(later.headers['x-gate-signature'], push.headers['x-gate-signature'], '★ 时间戳必须参与签名');
});

test('★ M4-16：`verifyEventPush` 的时间窗（超时即拒绝，防重放）', () => {
  const push = buildEventPush({ event: 'policy.revoked', payload: {}, callbackUrl: 'https://bot/cb', secret: SECRET, at: NOW });
  assert.equal(push.ok, true);
  if (!push.ok) return;

  // ① 6 分钟后重放 → 拒绝
  const replayed = verifyEventPush({
    body: push.body,
    signature: push.headers['x-gate-signature'],
    timestamp: push.headers['x-gate-timestamp'],
    secret: SECRET,
    now: new Date(NOW.getTime() + 6 * 60_000),
  });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.reason, 'expired', '★ 一次捕获的推送不能被无限重放');

  // ② 缺签名 / 缺时间戳 / 格式错
  assert.equal(verifyEventPush({ body: push.body, signature: undefined, timestamp: '1', secret: SECRET, now: NOW }).reason, 'missing_signature');
  assert.equal(verifyEventPush({ body: push.body, signature: 'sha256=x', timestamp: undefined, secret: SECRET, now: NOW }).reason, 'bad_timestamp');
  assert.equal(verifyEventPush({ body: push.body, signature: 'not-prefixed', timestamp: '1', secret: SECRET, now: NOW }).reason, 'missing_signature');
  // ③ 签名不匹配
  assert.equal(
    verifyEventPush({ body: '{}', signature: push.headers['x-gate-signature'], timestamp: push.headers['x-gate-timestamp'], secret: SECRET, now: NOW }).reason,
    'signature_mismatch',
  );
});

// ═══════════════════════════ 适配层 ═══════════════════════════

test('★ M4-16：适配层只做「框架输入 → 协议入参」的翻译（不含协议语义）', () => {
  const adapted = adaptSlashCommand({ platform: 'discord', interaction: { userId: 'u-7', command: 'verify', options: [{ name: 'scopes', value: 'assert:read, assert:eligible' }] } });
  assert.equal(adapted.ok, true);
  if (adapted.ok) {
    assert.equal(adapted.externalUserId, 'u-7');
    assert.equal(adapted.platform, 'discord');
    assert.deepEqual(adapted.scopes, ['assert:read', 'assert:eligible']);
  }
  // 取不到用户标识 → 明确失败
  const bad = adaptSlashCommand({ platform: 'telegram', interaction: {} });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.message, /无法从 telegram 的交互对象里取到用户标识/);
  // 未指定 scopes → 最小默认
  const minimal = adaptSlashCommand({ platform: 'nonebot', interaction: { userId: 'x' } });
  assert.equal(minimal.ok, true);
  if (minimal.ok) assert.deepEqual(minimal.scopes, ['assert:read'], '默认最小权限');
});

test('M4-16：框架接入矩阵与 docs/03 §1.14.2 对齐（协议属于 core，适配属于插件）', () => {
  assert.equal(FRAMEWORK_INTEGRATION_MATRIX.length, 5);
  // ★ 前三种主流框架**不需要平台侧插件**——这正是「协议属于 core」的证据
  for (const entry of FRAMEWORK_INTEGRATION_MATRIX.slice(0, 3)) {
    assert.equal(entry.needsPlatformPlugin, false, `${entry.framework} 应可直接用标准协议`);
  }
  // 后两种需要插件（webhook 接收 / 复杂状态机）
  for (const entry of FRAMEWORK_INTEGRATION_MATRIX.slice(3)) {
    assert.equal(entry.needsPlatformPlugin, true);
  }
  assert.ok(FRAMEWORK_INTEGRATION_MATRIX.some((entry) => /declarative webhook/.test(entry.approach)));
  assert.ok(FRAMEWORK_INTEGRATION_MATRIX.some((entry) => /assert/.test(entry.approach)));
});
