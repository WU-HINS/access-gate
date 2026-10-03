/**
 * outbound OIDC 端点验收（平台作为 IdP）—— docs/06 §6.0.1。
 *
 * 本文件聚焦 OIDC 的**漏洞面**：PKCE、授权码一次性、redirect_uri 精确匹配、
 * id_token 的 aud/nonce。这些都是「实现看起来对了但实际可被利用」的地方。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppServer, newCsrfSecret, type Route } from '../src/http/server.ts';
import { codeChallengeOf, createOAuthRoutes, InMemoryOAuthStore, verifyPkce } from '../src/http/oauth-routes.ts';
import { InMemorySessionStore, principalFromClaims, SESSION_COOKIE, SessionService } from '../src/auth/session.ts';
import { generateSigningKey, type SigningKey } from '../src/verify/jws.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');
const REDIRECT = 'https://rp.example.com/callback';
const VERIFIER = 'verifier-abcdefghijklmnopqrstuvwxyz-0123456789';

interface Harness {
  base: string;
  close: () => Promise<void>;
  cookie: string;
  store: InMemoryOAuthStore;
  key: SigningKey;
}

async function start(): Promise<Harness> {
  const store = new InMemoryOAuthStore();
  store.registerClient({ clientId: 'rp-1', name: '外部项目', redirectUris: [REDIRECT], scopes: ['openid', 'profile', 'email'], status: 'active' });
  const key = await generateSigningKey('oidc-1');
  const sessions = new SessionService({ store: new InMemorySessionStore() });

  const routes: Route[] = createOAuthRoutes({
    store,
    issuer: 'https://gate.example.com',
    signingKeys: [key],
    loadSubject: async (subject) => (subject === 'u1' ? { displayName: 'Alice', email: 'alice@example.com', emailVerified: true } : undefined),
    logger: silentLogger,
    now: () => NOW,
  });

  const app = createAppServer({ sessions, routes, csrfSecret: newCsrfSecret(), logger: silentLogger, port: 0 });
  const { url } = await app.listen();
  const session = await sessions.create(principalFromClaims({ sub: 'u1', emailVerified: true, preferredUsername: 'alice' }, { realm: 'developer', role: 'developer' }));
  return { base: url, close: () => app.close(), cookie: `${SESSION_COOKIE}=${session.token}`, store, key };
}

/** 走一次 authorize，返回 302 的 Location（含 code）。 */
async function authorize(harness: Harness, overrides: Record<string, string> = {}): Promise<{ status: number; location: string | null; body: string }> {
  const params = new URLSearchParams({
    client_id: 'rp-1',
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid profile',
    code_challenge: codeChallengeOf(VERIFIER),
    code_challenge_method: 'S256',
    state: 'st-1',
    ...overrides,
  });
  const response = await fetch(`${harness.base}/oauth/authorize?${params}`, { headers: { cookie: harness.cookie }, redirect: 'manual' });
  return { status: response.status, location: response.headers.get('location'), body: await response.text() };
}

async function token(harness: Harness, body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

// ─────────────────────────── 发现与公钥 ───────────────────────────

test('★ 发现文档与 JWKS 可匿名获取（RP 需要它们才能起步）', async () => {
  const harness = await start();
  try {
    const discovery = await fetch(`${harness.base}/.well-known/openid-configuration`);
    assert.equal(discovery.status, 200);
    const document = (await discovery.json()) as Record<string, unknown>;
    assert.equal(document['issuer'], 'https://gate.example.com');
    assert.deepEqual(document['code_challenge_methods_supported'], ['S256']);
    assert.deepEqual(document['response_types_supported'], ['code']);

    const jwks = await fetch(`${harness.base}/oauth/jwks.json`);
    assert.equal(jwks.status, 200);
    const keys = (await jwks.json()) as { keys: { kid: string; d?: unknown }[] };
    assert.equal(keys.keys[0]!.kid, 'oidc-1');
    assert.equal('d' in keys.keys[0]!, false, '★ 公钥集绝不能含私钥材料');
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── ★ PKCE ───────────────────────────

test('★ PKCE：缺少 `code_challenge` 直接拒绝（PKCE 是必需的）', async () => {
  const harness = await start();
  try {
    const result = await authorize(harness, { code_challenge: '' });
    assert.equal(result.status, 400);
    assert.match(result.body, /PKCE 是必需的/);
  } finally {
    await harness.close();
  }
});

test('★ PKCE：只接受 S256（`plain` 等于不校验）', async () => {
  const harness = await start();
  try {
    const result = await authorize(harness, { code_challenge_method: 'plain' });
    assert.equal(result.status, 400);
    assert.match(result.body, /只接受 S256/);
  } finally {
    await harness.close();
  }
});

test('★ PKCE：`code_verifier` 不匹配 → 拒绝（且用常量时间比较）', () => {
  const challenge = codeChallengeOf(VERIFIER);
  assert.equal(verifyPkce({ codeChallenge: challenge, codeVerifier: VERIFIER }).ok, true);
  const wrong = verifyPkce({ codeChallenge: challenge, codeVerifier: 'wrong-verifier' });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.match(wrong.message, /不匹配/);
  // 长度不同也要走同一条路径（不能因长度不同提前返回）
  assert.equal(verifyPkce({ codeChallenge: challenge, codeVerifier: 'x' }).ok, false);
  // plain 被拒
  assert.equal(verifyPkce({ codeChallenge: challenge, codeChallengeMethod: 'plain', codeVerifier: VERIFIER }).ok, false);
});

// ─────────────────────────── ★ redirect_uri ───────────────────────────

test('★ redirect_uri 必须**精确匹配**（否则是开放重定向，授权码会被送到攻击者）', async () => {
  const harness = await start();
  try {
    const prefix = await authorize(harness, { redirect_uri: 'https://rp.example.com/callback/evil' });
    assert.equal(prefix.status, 400);
    assert.match(prefix.body, /不在该客户端的白名单内/);
    assert.match(prefix.body, /防开放重定向/);

    const evil = await authorize(harness, { redirect_uri: 'https://attacker.example.com/steal' });
    assert.equal(evil.status, 400);

    // 未知 client
    const unknown = await authorize(harness, { client_id: 'ghost' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body, /invalid_client/);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 授权码流程 ───────────────────────────

test('★ 完整授权码流程：authorize → token，id_token 的 aud/nonce 正确', async () => {
  const harness = await start();
  try {
    const auth = await authorize(harness, { nonce: 'n-123' });
    assert.equal(auth.status, 302);
    const location = new URL(auth.location!);
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
    const code = location.searchParams.get('code')!;
    assert.ok(code.length > 20);
    assert.equal(location.searchParams.get('state'), 'st-1', '★ state 必须原样回传');

    const result = await token(harness, { grant_type: 'authorization_code', client_id: 'rp-1', code, code_verifier: VERIFIER });
    assert.equal(result.status, 200);
    assert.equal(result.json['token_type'], 'Bearer');
    assert.ok(typeof result.json['access_token'] === 'string');
    assert.ok(typeof result.json['refresh_token'] === 'string');

    // 解出 id_token 的 payload 校验 aud/nonce/sub
    const idToken = result.json['id_token'] as string;
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    assert.equal(payload['aud'], 'rp-1', '★ aud 必须是 client_id');
    assert.equal(payload['nonce'], 'n-123', '★ nonce 必须原样回传');
    assert.equal(payload['sub'], 'u1');
    assert.equal(payload['iss'], 'https://gate.example.com');
    assert.ok(Number(payload['exp']) > Number(payload['iat']));
  } finally {
    await harness.close();
  }
});

test('★ 授权码**一次性** —— 重复兑换被拒', async () => {
  const harness = await start();
  try {
    const auth = await authorize(harness);
    const code = new URL(auth.location!).searchParams.get('code')!;

    const first = await token(harness, { grant_type: 'authorization_code', client_id: 'rp-1', code, code_verifier: VERIFIER });
    assert.equal(first.status, 200);

    const second = await token(harness, { grant_type: 'authorization_code', client_id: 'rp-1', code, code_verifier: VERIFIER });
    assert.equal(second.status, 400, '★ 授权码重复使用是「授权码注入」的入口');
    assert.match(String(second.json['error_description']), /一次性/);
  } finally {
    await harness.close();
  }
});

test('★ 错误的 `code_verifier` → 兑换被拒', async () => {
  const harness = await start();
  try {
    const auth = await authorize(harness);
    const code = new URL(auth.location!).searchParams.get('code')!;
    const result = await token(harness, { grant_type: 'authorization_code', client_id: 'rp-1', code, code_verifier: 'wrong' });
    assert.equal(result.status, 400);
    assert.match(String(result.json['error_description']), /PKCE 校验失败/);
  } finally {
    await harness.close();
  }
});

test('未登录访问 authorize → 401（授权前必须有平台会话）', async () => {
  const harness = await start();
  try {
    const params = new URLSearchParams({
      client_id: 'rp-1',
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: codeChallengeOf(VERIFIER),
      code_challenge_method: 'S256',
    });
    const response = await fetch(`${harness.base}/oauth/authorize?${params}`, { redirect: 'manual' });
    assert.equal(response.status, 401);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── refresh / userinfo / revoke ───────────────────────────

test('★ refresh_token 可换新令牌；吊销后失效', async () => {
  const harness = await start();
  try {
    const auth = await authorize(harness);
    const code = new URL(auth.location!).searchParams.get('code')!;
    const first = await token(harness, { grant_type: 'authorization_code', client_id: 'rp-1', code, code_verifier: VERIFIER });
    const refreshToken = first.json['refresh_token'] as string;

    const refreshed = await token(harness, { grant_type: 'refresh_token', client_id: 'rp-1', refresh_token: refreshToken });
    assert.equal(refreshed.status, 200);
    assert.ok(typeof refreshed.json['id_token'] === 'string');

    // 吊销后不可再用
    await fetch(`${harness.base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: refreshToken }),
    });
    const after = await token(harness, { grant_type: 'refresh_token', client_id: 'rp-1', refresh_token: refreshToken });
    assert.equal(after.status, 400);
    assert.match(String(after.json['error_description']), /已吊销/);
  } finally {
    await harness.close();
  }
});

test('★ userinfo 需要 Bearer 令牌', async () => {
  const harness = await start();
  try {
    const noToken = await fetch(`${harness.base}/oauth/userinfo`);
    assert.equal(noToken.status, 401);
    assert.equal(noToken.headers.get('www-authenticate'), 'Bearer');

    const auth = await authorize(harness);
    const code = new URL(auth.location!).searchParams.get('code')!;
    const tokens = await token(harness, { grant_type: 'authorization_code', client_id: 'rp-1', code, code_verifier: VERIFIER });
    const accessToken = tokens.json['access_token'] as string;

    const info = await fetch(`${harness.base}/oauth/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(info.status, 200);
    const claims = (await info.json()) as Record<string, unknown>;
    assert.equal(claims['sub'], 'u1');
    assert.equal(claims['email'], 'alice@example.com');
    assert.equal(claims['name'], 'Alice');

    // 无效令牌
    const bad = await fetch(`${harness.base}/oauth/userinfo`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);
  } finally {
    await harness.close();
  }
});

test('★ revoke 对不存在的令牌也返回 200（避免成为「令牌是否存在」的探针）', async () => {
  const harness = await start();
  try {
    const response = await fetch(`${harness.base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'never-existed' }),
    });
    assert.equal(response.status, 200, '★ RFC 7009：不泄露令牌存在性');
  } finally {
    await harness.close();
  }
});

test('不支持的 grant_type → 400', async () => {
  const harness = await start();
  try {
    const result = await token(harness, { grant_type: 'client_credentials', client_id: 'rp-1' });
    assert.equal(result.status, 400);
    assert.equal(result.json['error'], 'unsupported_grant_type');
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── ★ R110：Discovery 算法必须从 JWKS 派生 ───────────────────────────

test('★★★★ Discovery 声明的算法**从实际签名密钥派生**（不是硬编码）', async () => {
  const { generateKeyPair } = await import('jose');
  const { createOAuthRoutes } = await import('../src/http/oauth-routes.ts');

  const discover = async (kind: 'ES256' | 'RS256'): Promise<string[]> => {
    const { privateKey, publicKey } = await generateKeyPair(kind, { extractable: true });
    const routes = createOAuthRoutes({
      issuer: 'http://localhost:9999',
      signingKeys: [{ kid: 'k1', privateKey, publicKey, status: 'active' }],
      clients: [],
    } as never);
    const route = routes.find((entry) => entry.path === '/.well-known/openid-configuration')!;
    const result = await route.handler({} as never);
    return (result.body as { id_token_signing_alg_values_supported: string[] }).id_token_signing_alg_values_supported;
  };

  // ★ ES256 密钥 → ES256
  assert.deepEqual(await discover('ES256'), ['ES256'], '★ ES256 密钥应声明 ES256');

  // ★★★ RS256 密钥 → RS256（★ 若硬编码 ES256，这里会失败）
  //   依据 `docs/06:410`：「不得虚报算法……Discovery 内容由 JWKS 实际内容**派生**，不手写」
  assert.deepEqual(await discover('RS256'), ['RS256'], '★★ RS256 密钥必须声明 RS256（证明是派生的，不是硬编码）');
});
