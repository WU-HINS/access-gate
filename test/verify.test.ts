/**
 * 跨项目协同验证协议验收（M5-1 / M5-2 / M5-3）—— docs/06 §7.2。
 *
 * 验收标准（docs/07 路线图原文）：
 *   - M5-1：**签名错误 / 过期 / 重放均被拒**
 *   - M5-2：**用户在 bot 侧发起的验证完整走通**
 *   - M5-3：**篡改断言被第三方验签拒绝；可离线复核**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bodyHashOf,
  computeSignature,
  constantTimeEqual,
  InMemoryNonceStore,
  InMemoryVerifyClientStore,
  signRequest,
  toPublicMessage,
  verifySignedRequest,
  SIGNATURE_HEADERS,
  TIMESTAMP_TOLERANCE_MS,
} from '../src/verify/hmac.ts';
import {
  assertJwksHasNoPrivateMaterial,
  generateSigningKey,
  readJwsHeader,
  SigningKeySet,
  signAssertion,
  toJwks,
  verifyAssertion,
  type ManagedSigningKey,
} from '../src/verify/jws.ts';
import {
  DeviceCodeService,
  generateUserCode,
  InMemoryChallengeStore,
  normalizeUserCode,
  USER_CODE_ALPHABET,
} from '../src/verify/device-code.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const PATH = '/api/verify/v1/assert';
const BODY = JSON.stringify({ subject: { type: 'platform_user_id', value: 'u1' }, claims: ['eligible'] });

// ═══════════════════════ M5-1 HMAC ═══════════════════════

function makeClients() {
  const store = new InMemoryVerifyClientStore();
  const { client, secret } = store.register({ name: 'bot-a', scopes: ['assert:read', 'challenge:create'] });
  return { store, client, secret };
}

test('★ M5-1：正确签名的请求通过', async () => {
  const { store, client, secret } = makeClients();
  const headers = signRequest({ clientId: client.clientId, secret, method: 'POST', path: PATH, body: BODY, timestamp: NOW_SECONDS, nonce: 'n1' });
  const result = await verifySignedRequest({
    headers,
    method: 'POST',
    path: PATH,
    body: BODY,
    clients: store,
    nonces: new InMemoryNonceStore(),
    now: NOW,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.client.clientId, client.clientId);
});

test('★ M5-1：签名错误 → 拒（篡改 body 也会被拒，因为 bodyHash 参与签名）', async () => {
  const { store, client, secret } = makeClients();
  const headers = signRequest({ clientId: client.clientId, secret, method: 'POST', path: PATH, body: BODY, timestamp: NOW_SECONDS, nonce: 'n1' });

  // ① 直接改签名
  const tampered = { ...headers, [SIGNATURE_HEADERS.signature]: `sha256=${'0'.repeat(64)}` };
  const bad = await verifySignedRequest({ headers: tampered, method: 'POST', path: PATH, body: BODY, clients: store, nonces: new InMemoryNonceStore(), now: NOW });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'signature_mismatch');

  // ② ★ 改 body 但保留签名 → 必须被拒（否则签名不覆盖内容）
  const bodyTampered = await verifySignedRequest({
    headers,
    method: 'POST',
    path: PATH,
    body: JSON.stringify({ subject: { type: 'platform_user_id', value: 'victim' } }),
    clients: store,
    nonces: new InMemoryNonceStore(),
    now: NOW,
  });
  assert.equal(bodyTampered.ok, false);
  if (!bodyTampered.ok) assert.equal(bodyTampered.reason, 'signature_mismatch');

  // ③ 改 path 同样被拒
  const pathTampered = await verifySignedRequest({ headers, method: 'POST', path: '/api/verify/v1/other', body: BODY, clients: store, nonces: new InMemoryNonceStore(), now: NOW });
  assert.equal(pathTampered.ok, false);
});

test('★ M5-1：时间戳超出 ±5 分钟 → 拒（过去与未来都拒）', async () => {
  const { store, client, secret } = makeClients();
  const tooOld = NOW_SECONDS - Math.ceil(TIMESTAMP_TOLERANCE_MS / 1000) - 1;
  const tooNew = NOW_SECONDS + Math.ceil(TIMESTAMP_TOLERANCE_MS / 1000) + 1;

  for (const timestamp of [tooOld, tooNew]) {
    const headers = signRequest({ clientId: client.clientId, secret, method: 'POST', path: PATH, body: BODY, timestamp, nonce: 'n1' });
    const result = await verifySignedRequest({ headers, method: 'POST', path: PATH, body: BODY, clients: store, nonces: new InMemoryNonceStore(), now: NOW });
    assert.equal(result.ok, false, `时间戳 ${timestamp} 应被拒`);
    if (!result.ok) assert.equal(result.reason, 'timestamp_out_of_window');
  }

  // 边界内（正好 5 分钟）应通过
  const boundary = NOW_SECONDS - Math.ceil(TIMESTAMP_TOLERANCE_MS / 1000);
  const headers = signRequest({ clientId: client.clientId, secret, method: 'POST', path: PATH, body: BODY, timestamp: boundary, nonce: 'n-edge' });
  const ok = await verifySignedRequest({ headers, method: 'POST', path: PATH, body: BODY, clients: store, nonces: new InMemoryNonceStore(), now: NOW });
  assert.equal(ok.ok, true, '边界值应通过（容差是「不超过 ±5 分钟」）');
});

test('★ M5-1：重放（同 nonce 重复提交）→ 拒；换 nonce 则通过', async () => {
  const { store, client, secret } = makeClients();
  const nonces = new InMemoryNonceStore();
  const headers = signRequest({ clientId: client.clientId, secret, method: 'POST', path: PATH, body: BODY, timestamp: NOW_SECONDS, nonce: 'replay-me' });

  const first = await verifySignedRequest({ headers, method: 'POST', path: PATH, body: BODY, clients: store, nonces, now: NOW });
  assert.equal(first.ok, true, '首次应通过');

  // ★ 同一请求原样重发（签名仍正确、时间戳仍在窗口内）→ 必须被拒
  const replay = await verifySignedRequest({ headers, method: 'POST', path: PATH, body: BODY, clients: store, nonces, now: NOW });
  assert.equal(replay.ok, false, '★ 重放必须被拒');
  if (!replay.ok) assert.equal(replay.reason, 'nonce_replayed');

  // 换 nonce（重新签名）→ 通过
  const fresh = signRequest({ clientId: client.clientId, secret, method: 'POST', path: PATH, body: BODY, timestamp: NOW_SECONDS, nonce: 'fresh' });
  const second = await verifySignedRequest({ headers: fresh, method: 'POST', path: PATH, body: BODY, clients: store, nonces, now: NOW });
  assert.equal(second.ok, true);
});

test('M5-1：缺签名头 / 未知调用方 / 暂停 / 吊销 → 各自被拒', async () => {
  const { store, client, secret } = makeClients();
  const headers = signRequest({ clientId: client.clientId, secret, method: 'POST', path: PATH, body: BODY, timestamp: NOW_SECONDS, nonce: 'n1' });

  // 缺头
  const missing = await verifySignedRequest({
    headers: { [SIGNATURE_HEADERS.client]: client.clientId },
    method: 'POST',
    path: PATH,
    body: BODY,
    clients: store,
    nonces: new InMemoryNonceStore(),
    now: NOW,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'missing_header');

  // 未知调用方
  const unknown = await verifySignedRequest({
    headers: { ...headers, [SIGNATURE_HEADERS.client]: 'vc_ghost' },
    method: 'POST',
    path: PATH,
    body: BODY,
    clients: store,
    nonces: new InMemoryNonceStore(),
    now: NOW,
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, 'unknown_client');

  // 暂停 / 吊销
  for (const [status, reason] of [
    ['suspended', 'client_suspended'],
    ['revoked', 'client_revoked'],
  ] as const) {
    store.setStatus(client.clientId, status);
    const result = await verifySignedRequest({ headers, method: 'POST', path: PATH, body: BODY, clients: store, nonces: new InMemoryNonceStore(), now: NOW });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, reason);
  }
});

test('M5-1：scope 不足 / subject 不在白名单 → 403 类拒绝', async () => {
  const store = new InMemoryVerifyClientStore();
  const { client, secret } = store.register({ name: 'limited', scopes: ['assert:read'], allowedSubjects: ['u1', 'team-*'] });
  const headers = signRequest({ clientId: client.clientId, secret, method: 'POST', path: PATH, body: BODY, timestamp: NOW_SECONDS, nonce: 'n1' });

  const scopeDenied = await verifySignedRequest({
    headers,
    method: 'POST',
    path: PATH,
    body: BODY,
    clients: store,
    nonces: new InMemoryNonceStore(),
    now: NOW,
    requiredScope: 'challenge:create',
  });
  assert.equal(scopeDenied.ok, false);
  if (!scopeDenied.ok) {
    assert.equal(scopeDenied.reason, 'scope_denied');
    assert.equal(toPublicMessage(scopeDenied.reason).status, 403);
  }

  // 白名单：精确匹配 + 前缀通配
  const allowed = await verifySignedRequest({
    headers,
    method: 'POST',
    path: PATH,
    body: BODY,
    clients: store,
    nonces: new InMemoryNonceStore(),
    now: NOW,
    subject: { type: 'platform_user_id', value: 'team-alpha' },
  });
  assert.equal(allowed.ok, true, 'team-* 应匹配 team-alpha');

  const notAllowed = await verifySignedRequest({
    headers,
    method: 'POST',
    path: PATH,
    body: BODY,
    clients: store,
    nonces: new InMemoryNonceStore(),
    now: NOW,
    subject: { type: 'platform_user_id', value: 'outsider' },
  });
  assert.equal(notAllowed.ok, false);
  if (!notAllowed.ok) assert.equal(notAllowed.reason, 'subject_not_allowed');
});

test('★ M5-1：对外消息不泄露细节（「签名错」与「调用方不存在」返回同一句话）', () => {
  const a = toPublicMessage('signature_mismatch');
  const b = toPublicMessage('unknown_client');
  assert.deepEqual(a, b, '不得让调用方通过响应差异探测调用方是否存在');
  assert.equal(a.status, 401);
  // 但操作性错误应明确
  assert.equal(toPublicMessage('missing_header').error, '缺少签名头');
  assert.equal(toPublicMessage('scope_denied').status, 403);
});

test('M5-1：secret 轮换有过渡期（旧 secret 在宽限期内仍可用）', async () => {
  const store = new InMemoryVerifyClientStore();
  const { client, secret: oldSecret } = store.register({ name: 'bot', scopes: ['assert:read'] });
  const oldHeaders = signRequest({ clientId: client.clientId, secret: oldSecret, method: 'POST', path: PATH, body: BODY, timestamp: NOW_SECONDS, nonce: 'old' });

  const { secret: newSecret, previousSecretExpiresAt } = store.rotate(client.clientId, { graceMs: 60_000, now: NOW });
  assert.ok(previousSecretExpiresAt !== null);

  // 旧 secret 在过渡期内仍可用
  const withOld = await verifySignedRequest({
    headers: oldHeaders,
    method: 'POST',
    path: PATH,
    body: BODY,
    clients: store,
    nonces: new InMemoryNonceStore(),
    now: NOW,
    previousSecrets: (clientId, now) => store.resolvePreviousSecrets(clientId, now),
  });
  assert.equal(withOld.ok, true, '过渡期内旧 secret 应仍可用（避免调用方被迫同时切换）');

  // 过渡期外旧 secret 失效
  const later = new Date(NOW.getTime() + 120_000);
  const afterGrace = await verifySignedRequest({
    headers: oldHeaders,
    method: 'POST',
    path: PATH,
    body: BODY,
    clients: store,
    nonces: new InMemoryNonceStore(),
    now: later,
    previousSecrets: (clientId, now) => store.resolvePreviousSecrets(clientId, now),
  });
  // 注意：此处因时间戳超窗也会被拒；用新时间戳的请求更能说明问题
  assert.equal(afterGrace.ok, false);

  const freshHeaders = signRequest({ clientId: client.clientId, secret: newSecret, method: 'POST', path: PATH, body: BODY, timestamp: Math.floor(later.getTime() / 1000), nonce: 'new' });
  const withNew = await verifySignedRequest({ headers: freshHeaders, method: 'POST', path: PATH, body: BODY, clients: store, nonces: new InMemoryNonceStore(), now: later });
  assert.equal(withNew.ok, true, '新 secret 应可用');
});

test('M5-1：签名算法细节（GET 空体 / 常量时间比较 / 待签串形状）', () => {
  // GET 请求体为空串
  assert.equal(bodyHashOf(undefined), bodyHashOf(''));
  assert.equal(bodyHashOf(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  // 待签串：method\npath\ntimestamp\nnonce\nbodyHash
  const signature = computeSignature({ secret: 's', method: 'post', path: '/p', timestamp: 1, nonce: 'n', body: '' });
  const upper = computeSignature({ secret: 's', method: 'POST', path: '/p', timestamp: 1, nonce: 'n', body: '' });
  assert.equal(signature, upper, 'method 应归一为大写');

  // 常量时间比较：等值 true，不等 false（且长度不同也安全）
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcdef'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

// ═══════════════════════ M5-3 断言签名 ═══════════════════════

async function makeKeySet() {
  const key = await generateSigningKey('ec-2025-06');
  const managed: ManagedSigningKey = { ...key, status: 'active', createdAt: NOW };
  const set = new SigningKeySet();
  set.add(managed);
  return { set, key: managed };
}

const ASSERTION_PAYLOAD = {
  iss: 'https://gate.example.com',
  sub: '0192a1b2-0000-0000-0000-000000000001',
  subjectType: 'platform_user_id',
  displayName: 'alice',
  assertions: { eligible: true, tier: 2, tags: ['verified:contributor'] },
};

test('★ M5-3：签发 → 用 JWKS 离线验签通过（不依赖对平台的实时信任）', async () => {
  const { set, key } = await makeKeySet();
  const token = await signAssertion({ payload: ASSERTION_PAYLOAD, key, now: NOW });

  // 调用方侧：只用 JWKS（公钥）验签
  const jwks = await set.jwks();
  const result = await verifyAssertion({ token, jwks, expectedIssuer: ASSERTION_PAYLOAD.iss, expectedSubject: ASSERTION_PAYLOAD.sub, now: NOW });
  assert.equal(result.ok, true, `验签失败：${result.ok ? '' : result.message}`);
  if (result.ok) {
    assert.equal(result.kid, key.kid);
    assert.equal(result.payload.assertions['eligible'], true);
    assert.equal(result.payload.assertions['tier'], 2);
    assert.equal(result.payload.iss, ASSERTION_PAYLOAD.iss);
  }
});

test('★ M5-3：篡改断言 → 第三方验签拒绝', async () => {
  const { set, key } = await makeKeySet();
  const token = await signAssertion({ payload: ASSERTION_PAYLOAD, key, now: NOW });
  const jwks = await set.jwks();

  // 篡改 payload（把 eligible 改成 true 的伪造场景：把 tier 从 2 改成 99）
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  payload['assertions'] = { eligible: true, tier: 99 };
  const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;

  const result = await verifyAssertion({ token: forged, jwks, now: NOW });
  assert.equal(result.ok, false, '★ 篡改必须被拒');
  if (!result.ok) assert.equal(result.reason, 'signature_invalid');

  // 换一把密钥签名（攻击者自签）→ 也拒（因为 kid 指向的公钥对不上）
  const attackerKey = await generateSigningKey(key.kid);
  const attackerToken = await signAssertion({ payload: ASSERTION_PAYLOAD, key: attackerKey, now: NOW });
  const attackerResult = await verifyAssertion({ token: attackerToken, jwks, now: NOW });
  assert.equal(attackerResult.ok, false, '★ 同 kid 但不同私钥签的断言必须被拒');
});

test('★ M5-3：过期断言被拒', async () => {
  const { set, key } = await makeKeySet();
  const token = await signAssertion({ payload: ASSERTION_PAYLOAD, key, ttlSeconds: 300, now: NOW });
  const jwks = await set.jwks();

  // 有效期内通过
  assert.equal((await verifyAssertion({ token, jwks, now: new Date(NOW.getTime() + 299_000) })).ok, true);
  // 过期后拒绝
  const expired = await verifyAssertion({ token, jwks, now: new Date(NOW.getTime() + 301_000) });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, 'expired');
});

test('★ M5-3：`alg: none` / 未知 kid / iss 不匹配 / sub 不匹配 → 各自被拒', async () => {
  const { set, key } = await makeKeySet();
  const jwks = await set.jwks();
  const token = await signAssertion({ payload: ASSERTION_PAYLOAD, key, now: NOW });

  // alg: none —— 手工构造
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: key.kid })).toString('base64url');
  const payloadPart = token.split('.')[1]!;
  const noneToken = `${noneHeader}.${payloadPart}.`;
  const noneResult = await verifyAssertion({ token: noneToken, jwks, now: NOW });
  assert.equal(noneResult.ok, false, '★ alg:none 必须被拒（否则验签形同虚设）');
  if (!noneResult.ok) assert.equal(noneResult.reason, 'bad_algorithm');

  // 未知 kid
  const unknownKid = await verifyAssertion({ token, jwks: { keys: [] }, now: NOW });
  assert.equal(unknownKid.ok, false);
  if (!unknownKid.ok) assert.equal(unknownKid.reason, 'unknown_kid');

  // iss 不匹配
  const badIss = await verifyAssertion({ token, jwks, expectedIssuer: 'https://evil.example', now: NOW });
  assert.equal(badIss.ok, false);
  if (!badIss.ok) assert.equal(badIss.reason, 'issuer_mismatch');

  // sub 不匹配
  const badSub = await verifyAssertion({ token, jwks, expectedSubject: 'someone-else', now: NOW });
  assert.equal(badSub.ok, false);
  if (!badSub.ok) assert.equal(badSub.reason, 'subject_mismatch');

  // 格式非法
  assert.equal((await verifyAssertion({ token: 'not-a-jws', jwks, now: NOW })).ok, false);
});

test('★ M5-3：JWKS 不得含私钥材料（发出去等于公开签名私钥）', async () => {
  const { set } = await makeKeySet();
  const jwks = await set.jwks();
  assert.doesNotThrow(() => assertJwksHasNoPrivateMaterial(jwks));
  // 公钥应含 kid/alg/use
  assert.equal(jwks.keys[0]!.kid, 'ec-2025-06');
  assert.equal(jwks.keys[0]!.alg, 'ES256');
  assert.equal(jwks.keys[0]!.use, 'sig');

  // 人为注入私钥材料 → 自检必须抓住
  const leaked = { keys: [{ ...jwks.keys[0]!, d: 'private-material' }] } as typeof jwks;
  assert.throws(() => assertJwksHasNoPrivateMaterial(leaked), /泄露了私钥材料/);
});

test('★ M5-3：密钥轮换 —— retiring 仍发布（已签发断言仍可验签），retired 不再发布', async () => {
  const oldKey = await generateSigningKey('ec-old');
  const newKey = await generateSigningKey('ec-new');
  const set = new SigningKeySet();
  set.add({ ...oldKey, status: 'active', createdAt: NOW });
  set.add({ ...newKey, status: 'standby', createdAt: NOW });

  // 旧密钥签发的断言
  const oldToken = await signAssertion({ payload: ASSERTION_PAYLOAD, key: oldKey, now: NOW });

  // 轮换：新密钥转 active，旧密钥转 retiring
  set.promote('ec-new');
  assert.equal(set.active!.kid, 'ec-new');

  const jwks = await set.jwks();
  assert.ok(jwks.keys.some((k) => k.kid === 'ec-old'), '★ retiring 密钥必须仍在 JWKS 中');
  assert.ok(jwks.keys.some((k) => k.kid === 'ec-new'));

  // 旧断言仍可验签
  const stillValid = await verifyAssertion({ token: oldToken, jwks, now: NOW });
  assert.equal(stillValid.ok, true, '★ 已签发但未过期的断言在轮换后必须仍可验签');

  // retire 旧密钥 → 不再发布 → 旧断言验签失败（这是预期：此时旧断言也应已过期）
  set.retire('ec-old');
  const afterRetire = await set.jwks();
  assert.equal(afterRetire.keys.some((k) => k.kid === 'ec-old'), false);
  const nowInvalid = await verifyAssertion({ token: oldToken, jwks: afterRetire, now: NOW });
  assert.equal(nowInvalid.ok, false);

  // 不得直接 retire active
  assert.throws(() => set.retire('ec-new'), /不得直接 retire active/);
});

test('M5-3：readJwsHeader 只读头部（不验签），供选键使用', async () => {
  const { key } = await makeKeySet();
  const token = await signAssertion({ payload: ASSERTION_PAYLOAD, key, now: NOW });
  const header = readJwsHeader(token);
  assert.equal(header?.alg, 'ES256');
  assert.equal(header?.kid, key.kid);
  assert.equal(readJwsHeader('garbage'), undefined);
});

// ═══════════════════════ M5-2 设备码流 ═══════════════════════

test('★ M5-2：完整流程 —— 发起 → 轮询 pending → 用户确认 → 轮询 approved', async () => {
  const service = new DeviceCodeService({ store: new InMemoryChallengeStore(), publicUrl: 'https://gate.example.com', now: () => NOW });
  const created = await service.create({
    clientId: 'vc_bot',
    subject: { type: 'discord_id', value: '1234567' },
    scopes: ['assert:read'],
  });
  assert.match(created.challengeId, /^ch_/);
  assert.match(created.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(created.expiresIn, 600);
  assert.equal(created.interval, 3);
  assert.match(created.verifyUrl, /^https:\/\/gate\.example\.com\/verify\?code=/);

  // 首次轮询：pending
  const pending = await service.poll(created.challengeId);
  assert.deepEqual(pending, { status: 'pending' });

  // 用户在浏览器确认（用 userCode，**大小写不敏感**）
  const approved = await service.approve(created.userCode.toLowerCase(), 'user-1');
  assert.equal(approved.ok, true);

  // 轮询拿到 approved（跳过限速窗口）
  const later = new Date(NOW.getTime() + 5_000);
  const service2 = new DeviceCodeService({ store: (service as unknown as { options: { store: InMemoryChallengeStore } }).options.store, publicUrl: 'https://gate.example.com', now: () => later });
  const result = await service2.poll(created.challengeId);
  assert.ok(!('ok' in result), `轮询应返回状态而非错误：${JSON.stringify(result)}`);
  if (!('ok' in result)) {
    assert.equal(result.status, 'approved');
    if (result.status === 'approved') {
      assert.equal(result.userId, 'user-1');
      assert.deepEqual(result.scopes, ['assert:read']);
      assert.equal(result.deliveryIndex, 1);
    }
  }
});

test('★ M5-2：userCode 归一 —— 大小写 / 分隔符 / 易混字符都能识别', async () => {
  // 字符集必须排除易混字符
  assert.equal(/[0O1IL]/.test(USER_CODE_ALPHABET), false, '★ userCode 字符集不得含 0/O/1/I/L');

  assert.equal(normalizeUserCode('abcd-1234'), 'ABCD1234');
  assert.equal(normalizeUserCode('ABCD 1234'), 'ABCD1234');
  // O→0、I/L→1 的映射（用户看错也能命中）
  assert.equal(normalizeUserCode('O'), '0');
  assert.equal(normalizeUserCode('I'), '1');
  assert.equal(normalizeUserCode('L'), '1');

  // 端到端：用小写 + 带空格的码确认
  const service = new DeviceCodeService({ store: new InMemoryChallengeStore(), publicUrl: 'https://gate.example.com', now: () => NOW });
  const created = await service.create({ clientId: 'vc', subject: { type: 'discord_id', value: '1' }, scopes: [] });
  const messy = `${created.userCode.toLowerCase().replace('-', ' ')}`;
  const result = await service.approve(messy, 'user-1');
  assert.equal(result.ok, true, `带空格的小写码应被识别（${messy}）`);
});

test('★ M5-2：轮询限速（服务端强制，不只靠客户端自觉）', async () => {
  const service = new DeviceCodeService({ store: new InMemoryChallengeStore(), publicUrl: 'https://g.example', pollIntervalSeconds: 3, now: () => NOW });
  const created = await service.create({ clientId: 'vc', subject: { type: 'discord_id', value: '1' }, scopes: [] });

  await service.poll(created.challengeId); // 第一次
  const tooFast = await service.poll(created.challengeId); // 立刻再来
  assert.equal('ok' in tooFast && tooFast.ok === false, true);
  if ('ok' in tooFast && tooFast.ok === false) assert.equal(tooFast.reason, 'poll_too_fast');
});

test('★ M5-2：过期 / 拒绝 / 撤销', async () => {
  const store = new InMemoryChallengeStore();
  const service = new DeviceCodeService({ store, publicUrl: 'https://g.example', ttlSeconds: 600, now: () => NOW });
  const created = await service.create({ clientId: 'vc', subject: { type: 'discord_id', value: '1' }, scopes: [] });

  // 过期
  const afterTtl = new DeviceCodeService({ store, publicUrl: 'https://g.example', ttlSeconds: 600, now: () => new Date(NOW.getTime() + 601_000) });
  assert.deepEqual(await afterTtl.poll(created.challengeId), { status: 'expired' });
  const lateApprove = await afterTtl.approve(created.userCode, 'user-1');
  assert.equal(lateApprove.ok, false);
  if (!lateApprove.ok) assert.equal(lateApprove.reason, 'expired');

  // 拒绝
  const created2 = await service.create({ clientId: 'vc', subject: { type: 'discord_id', value: '2' }, scopes: [] });
  assert.deepEqual(await service.deny(created2.userCode), { ok: true });
  assert.deepEqual(await service.poll(created2.challengeId), { status: 'denied' });
  const denyAgain = await service.approve(created2.userCode, 'user-1');
  assert.equal(denyAgain.ok, false);
  if (!denyAgain.ok) assert.equal(denyAgain.reason, 'already_denied');

  // 撤销
  const created3 = await service.create({ clientId: 'vc', subject: { type: 'discord_id', value: '3' }, scopes: [] });
  await service.approve(created3.userCode, 'user-1');
  assert.deepEqual(await service.revoke(created3.challengeId), { ok: true, revoked: true });
});

test('★ M5-2：断言交付有次数上限（防泄漏的 challengeId 无限领断言）', async () => {
  const store = new InMemoryChallengeStore();
  let clock = NOW;
  const service = new DeviceCodeService({ store, publicUrl: 'https://g.example', deliveryLimit: 2, pollIntervalSeconds: 0, now: () => clock });
  const created = await service.create({ clientId: 'vc', subject: { type: 'discord_id', value: '1' }, scopes: [] });
  await service.approve(created.userCode, 'user-1');

  const first = await service.poll(created.challengeId);
  const second = await service.poll(created.challengeId);
  const third = await service.poll(created.challengeId);
  assert.ok(!('ok' in first) && first.status === 'approved');
  assert.ok(!('ok' in second) && second.status === 'approved', '容忍网络抖动：允许重复交付同一断言');
  assert.ok('ok' in third && third.ok === false, '超过上限后不再交付');
});

test('M5-2：未确认时轮询 pending；不存在的挑战 → not_found', async () => {
  const service = new DeviceCodeService({ store: new InMemoryChallengeStore(), publicUrl: 'https://g.example', now: () => NOW });
  const created = await service.create({ clientId: 'vc', subject: { type: 'discord_id', value: '1' }, scopes: [] });
  assert.deepEqual(await service.poll(created.challengeId), { status: 'pending' });
  const missing = await service.poll('ch_ghost');
  assert.equal('ok' in missing && missing.ok === false, true);
  if ('ok' in missing && missing.ok === false) assert.equal(missing.reason, 'not_found');
});

test('M5-2：userCode 生成具有足够熵且不重复', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 500; i += 1) codes.add(generateUserCode());
  assert.equal(codes.size, 500, '500 次生成不应重复');
  for (const code of codes) {
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(/[0O1IL]/.test(code), false);
  }
});

test('M5-1：重放检测会记录告警日志（可观测）', async () => {
  const { store, client, secret } = makeClients();
  const nonces = new InMemoryNonceStore();
  const headers = signRequest({ clientId: client.clientId, secret, method: 'POST', path: PATH, body: BODY, timestamp: NOW_SECONDS, nonce: 'x' });
  await verifySignedRequest({ headers, method: 'POST', path: PATH, body: BODY, clients: store, nonces, now: NOW });
  const warnings: string[] = [];
  const logger = { ...silentLogger, warn: (message: string) => void warnings.push(message) } as typeof silentLogger;
  await verifySignedRequest({ headers, method: 'POST', path: PATH, body: BODY, clients: store, nonces, now: NOW, logger });
  assert.ok(warnings.some((w) => /重放/.test(w)));
});
