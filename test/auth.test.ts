/**
 * 会话 / OIDC / HTTP 服务器验收（M0-9 + 打通 M1 的对外入口）。
 *
 * 断言重点：
 *   - 会话 token **只存哈希**；四种失效各自可区分（缺失/未知/过期/撤销）；
 *   - CSRF 双提交校验；状态变更方法必须带 token；
 *   - **OIDC 真实验签**：用本地生成的 ES256 密钥 + 自建 JWKS，验证
 *     「篡改 token 被拒」「nonce 不匹配被拒」「state 重放被拒」「iss/aud 不匹配被拒」；
 *   - HTTP 层：认证边界、CSRF 边界、开放重定向防护、健康检查。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

import {
  buildClearCookie,
  buildSetCookie,
  csrfTokenFor,
  hashToken,
  InMemorySessionStore,
  parseCookies,
  principalFromClaims,
  safeEqualHex,
  SessionService,
  verifyCsrf,
  SESSION_COOKIE,
} from '../src/auth/session.ts';
import {
  assertOidcConfigUsable,
  codeChallengeS256,
  InMemoryLoginTransactionStore,
  OidcClient,
  OidcError,
  randomToken,
  type HttpFetcher,
} from '../src/auth/oidc.ts';
import { createAppServer, matchRoute, newCsrfSecret, type Route } from '../src/http/server.ts';
import { createAppRoutes, sanitizeReturnTo } from '../src/http/routes.ts';

// ─────────────────────────── 会话 ───────────────────────────

test('会话：token 只存哈希（明文不入库）；authenticate 能还原主体', async () => {
  const store = new InMemorySessionStore();
  const sessions = new SessionService({ store });
  const principal = principalFromClaims(
    { sub: 'u1', email: 'a@b.c', emailVerified: true, preferredUsername: 'alice' },
    { realm: 'enduser' },
  );
  const { session, token } = await sessions.create(principal);
  assert.equal(session.tokenHash, hashToken(token));
  assert.notEqual(session.tokenHash, token, '落库的必须是哈希');
  assert.equal(JSON.stringify(session).includes(token), false, '会话对象里不得出现明文 token');

  const auth = await sessions.authenticate(token);
  assert.equal(auth.ok, true);
  if (auth.ok) assert.equal(auth.session.principal.userId, 'u1');
});

test('★ 会话失效的四种原因可区分（前端提示与审计需要区分）', async () => {
  const store = new InMemorySessionStore();
  let now = new Date('2025-06-01T00:00:00Z');
  const sessions = new SessionService({ store, ttlMs: 1_000, now: () => now });

  assert.deepEqual(await sessions.authenticate(undefined), { ok: false, reason: 'missing' });
  assert.deepEqual(await sessions.authenticate('not-a-token'), { ok: false, reason: 'unknown' });

  const { session, token } = await sessions.create(principalFromClaims({ sub: 'u', emailVerified: false }, { realm: 'enduser' }));
  now = new Date(now.getTime() + 2_000);
  assert.deepEqual(await sessions.authenticate(token), { ok: false, reason: 'expired' });

  const fresh = await sessions.create(principalFromClaims({ sub: 'u2', emailVerified: false }, { realm: 'enduser' }));
  await sessions.revoke(fresh.session.id);
  assert.deepEqual(await sessions.authenticate(fresh.token), { ok: false, reason: 'revoked' });
  void session;
});

test('会话：lastSeenAt 按节流刷新（不是每请求一次写库）', async () => {
  const store = new InMemorySessionStore();
  let now = new Date('2025-06-01T00:00:00Z');
  const sessions = new SessionService({ store, touchIntervalMs: 60_000, now: () => now });
  const { session, token } = await sessions.create(principalFromClaims({ sub: 'u', emailVerified: false }, { realm: 'enduser' }));
  const created = (await store.findById(session.id))!.lastSeenAt;

  now = new Date(now.getTime() + 1_000);
  await sessions.authenticate(token);
  assert.equal((await store.findById(session.id))!.lastSeenAt.getTime(), created.getTime(), '节流内不刷新');

  now = new Date(now.getTime() + 120_000);
  await sessions.authenticate(token);
  assert.ok((await store.findById(session.id))!.lastSeenAt.getTime() > created.getTime(), '超过节流后刷新');
});

test('会话：批量撤销某用户全部会话（改密码/封禁场景）', async () => {
  const store = new InMemorySessionStore();
  const sessions = new SessionService({ store });
  const principal = principalFromClaims({ sub: 'u1', emailVerified: false }, { realm: 'enduser' });
  await sessions.create(principal);
  await sessions.create(principal);
  assert.equal(await sessions.revokeAllForUser('u1'), 2);
  assert.equal(await sessions.revokeAllForUser('u1'), 0, '幂等');
});

test('★ 切换站点写回会话（站点作用域的唯一来源是会话，不是客户端记忆）', async () => {
  const store = new InMemorySessionStore();
  const sessions = new SessionService({ store });
  const { session } = await sessions.create(principalFromClaims({ sub: 'u1', emailVerified: false }, { realm: 'enduser' }));
  const updated = await sessions.switchSite(session.id, 'site-9');
  assert.equal(updated!.principal.activeSiteId, 'site-9');
  assert.equal((await store.findById(session.id))!.principal.activeSiteId, 'site-9');
});

test('Cookie：HttpOnly/SameSite 默认开启；Secure 可选；解析正确', () => {
  const cookie = buildSetCookie(SESSION_COOKIE, 'tok', { maxAgeSec: 3600 });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(/Secure/.test(cookie), false, '本地开发不应强制 Secure');
  assert.match(buildSetCookie(SESSION_COOKIE, 'tok', { secure: true }), /Secure/);
  assert.match(buildClearCookie(SESSION_COOKIE), /Max-Age=0/);

  assert.deepEqual(parseCookies('a=1; ag_session=abc%3D; b=2'), { a: '1', ag_session: 'abc=', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('CSRF：双提交校验；错误 token / 缺失 token 均拒绝', () => {
  const secret = newCsrfSecret();
  const token = csrfTokenFor('sess-1', secret);
  assert.equal(verifyCsrf('sess-1', secret, token), true);
  assert.equal(verifyCsrf('sess-2', secret, token), false, '会话不同则 token 无效');
  assert.equal(verifyCsrf('sess-1', newCsrfSecret(), token), false, '密钥不同则无效');
  assert.equal(verifyCsrf('sess-1', secret, undefined), false);
  assert.equal(verifyCsrf('sess-1', secret, ''), false);
});

test('safeEqualHex：常量时间比较，长度不同直接 false', () => {
  assert.equal(safeEqualHex('ab', 'ab'), true);
  assert.equal(safeEqualHex('ab', 'ac'), false);
  assert.equal(safeEqualHex('ab', 'abc'), false);
});

test('principalFromClaims：realm 由**登录入口**决定，不由 claims 决定', () => {
  const claims = { sub: 'u1', email: 'a@b.c', emailVerified: true };
  assert.equal(principalFromClaims(claims, { realm: 'developer' }).role, 'developer');
  assert.equal(principalFromClaims(claims, { realm: 'enduser' }).role, 'user');
  // 即使 claims 里塞了 realm，也不影响判定
  assert.equal(principalFromClaims({ ...claims, realm: 'developer' } as never, { realm: 'enduser' }).realm, 'enduser');
});

// ─────────────────────────── OIDC ───────────────────────────

const ISSUER = 'https://idp.example';

/** 构造一个「本地 IdP」：发现文档 + JWKS + 可签发的 id_token。 */
async function makeIdp(options: { tamper?: boolean; alg?: string } = {}) {
  const { privateKey, publicKey } = await generateKeyPair(options.alg ?? 'ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'kid-1';
  jwk.alg = options.alg ?? 'ES256';
  jwk.use = 'sig';

  const sign = async (claims: Record<string, unknown>, headerAlg = options.alg ?? 'ES256') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: headerAlg, kid: 'kid-1' })
      .setIssuer(ISSUER)
      .setAudience('gate-client')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  const fetcher: HttpFetcher = async (url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          end_session_endpoint: `${ISSUER}/logout`,
        }),
      };
    }
    if (url.endsWith('/jwks')) {
      return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ keys: [jwk] }) };
    }
    throw new Error(`未预期的请求：${url}`);
  };

  return { sign, fetcher, privateKey, publicKey };
}

function oidcWith(fetcher: HttpFetcher, tokenResponse?: { status: number; text: string }) {
  const base = fetcher;
  const wrapped: HttpFetcher = async (url, init) => {
    if (url.endsWith('/token')) {
      return {
        status: tokenResponse?.status ?? 200,
        headers: { 'content-type': 'application/json' },
        text: tokenResponse?.text ?? '{}',
      };
    }
    return base(url, init);
  };
  return new OidcClient({
    config: { issuer: ISSUER, clientId: 'gate-client', redirectUri: 'https://gate.example/api/auth/callback' },
    fetch: wrapped,
    now: () => new Date('2025-06-01T00:00:00Z'),
  });
}

test('OIDC：beginLogin 生成带 PKCE/nonce/state 的授权 URL；事务一次性消费', async () => {
  const idp = await makeIdp();
  const client = oidcWith(idp.fetcher);
  const { url, transaction } = await client.beginLogin({ returnTo: '/me' });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('code_challenge'), codeChallengeS256(transaction.codeVerifier));
  assert.equal(parsed.searchParams.get('nonce'), transaction.nonce);
  assert.equal(parsed.searchParams.get('state'), transaction.state);
  assert.equal(parsed.searchParams.get('scope'), 'openid profile email');

  const store = new InMemoryLoginTransactionStore();
  await store.put(transaction);
  assert.ok((await store.take(transaction.state)) !== undefined);
  assert.equal(await store.take(transaction.state), undefined, '★ state 必须一次性消费（防重放）');
});

test('★ OIDC：真实验签通过；篡改 payload 后验签失败', async () => {
  const idp = await makeIdp();
  const good = await idp.sign({ sub: 'u1', nonce: 'n1', email: 'a@b.c', email_verified: true });
  const client = oidcWith(idp.fetcher, { status: 200, text: JSON.stringify({ id_token: good }) });

  const ok = await client.completeLogin({ code: 'c', codeVerifier: 'v', nonce: 'n1' });
  assert.equal(ok.claims.sub, 'u1');

  // 篡改 payload 的一个字符 → 签名不再匹配
  const [header, payload, signature] = good.split('.');
  const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
  decoded['sub'] = 'attacker';
  const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  const tampered = `${header}.${tamperedPayload}.${signature}`;
  const client2 = oidcWith(idp.fetcher, { status: 200, text: JSON.stringify({ id_token: tampered }) });
  await assert.rejects(client2.completeLogin({ code: 'c', codeVerifier: 'v', nonce: 'n1' }), (error: unknown) => {
    assert.ok(error instanceof OidcError);
    assert.equal(error.code, 'signature_verification_failed');
    return true;
  });
});

test('★ OIDC：nonce 不匹配 → 拒绝（防「拿别人的合法 token」重放）', async () => {
  const idp = await makeIdp();
  const token = await idp.sign({ sub: 'u1', nonce: 'other-nonce' });
  const client = oidcWith(idp.fetcher, { status: 200, text: JSON.stringify({ id_token: token }) });
  await assert.rejects(client.completeLogin({ code: 'c', codeVerifier: 'v', nonce: 'my-nonce' }), (error: unknown) => {
    assert.ok(error instanceof OidcError);
    assert.equal(error.code, 'nonce_mismatch');
    return true;
  });
});

test('★ OIDC：iss / aud 不匹配 → 拒绝（防 IdP 混淆）', async () => {
  const idp = await makeIdp();
  const wrongIss = await new SignJWT({ sub: 'u1', nonce: 'n1' })
    .setProtectedHeader({ alg: 'ES256', kid: 'kid-1' })
    .setIssuer('https://evil.example')
    .setAudience('gate-client')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(idp.privateKey);
  const client = oidcWith(idp.fetcher, { status: 200, text: JSON.stringify({ id_token: wrongIss }) });
  await assert.rejects(client.completeLogin({ code: 'c', codeVerifier: 'v', nonce: 'n1' }), OidcError);

  const wrongAud = await new SignJWT({ sub: 'u1', nonce: 'n1' })
    .setProtectedHeader({ alg: 'ES256', kid: 'kid-1' })
    .setIssuer(ISSUER)
    .setAudience('other-client')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(idp.privateKey);
  const client2 = oidcWith(idp.fetcher, { status: 200, text: JSON.stringify({ id_token: wrongAud }) });
  await assert.rejects(client2.completeLogin({ code: 'c', codeVerifier: 'v', nonce: 'n1' }), OidcError);
});

test('OIDC：token 端点报错 / 缺 id_token → 明确报错（不静默当未登录）', async () => {
  const idp = await makeIdp();
  const failing = oidcWith(idp.fetcher, { status: 400, text: '{"error":"invalid_grant"}' });
  await assert.rejects(failing.completeLogin({ code: 'c', codeVerifier: 'v', nonce: 'n' }), /授权码换取 token 失败/);

  const noIdToken = oidcWith(idp.fetcher, { status: 200, text: '{"access_token":"at"}' });
  await assert.rejects(noIdToken.completeLogin({ code: 'c', codeVerifier: 'v', nonce: 'n' }), /缺少 id_token/);
});

test('OIDC：发现文档 issuer 与配置不一致 → 拒绝（防 token 端点被指向攻击者）', async () => {
  const evil: HttpFetcher = async (url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          issuer: 'https://evil.example',
          authorization_endpoint: 'https://evil.example/authorize',
          token_endpoint: 'https://evil.example/token',
          jwks_uri: 'https://evil.example/jwks',
        }),
      };
    }
    throw new Error('unexpected');
  };
  const client = oidcWith(evil);
  await assert.rejects(client.discover(), (error: unknown) => {
    assert.ok(error instanceof OidcError);
    assert.equal(error.code, 'issuer_mismatch');
    return true;
  });
});

test('★ assertOidcConfigUsable：禁止 none / HS* 算法（否则验签形同虚设）', () => {
  const base = { issuer: ISSUER, clientId: 'c', redirectUri: 'https://x/api/auth/callback' };
  assert.doesNotThrow(() => assertOidcConfigUsable(base));
  assert.throws(() => assertOidcConfigUsable({ ...base, allowedAlgorithms: ['none'] }), /禁止的签名算法/);
  assert.throws(() => assertOidcConfigUsable({ ...base, allowedAlgorithms: ['HS256'] }), /禁止的签名算法/);
  assert.throws(() => assertOidcConfigUsable({ ...base, issuer: 'http://insecure.example' }), /必须是 https/);
  assert.doesNotThrow(() => assertOidcConfigUsable({ ...base, issuer: 'http://localhost:8080' }));
});

test('randomToken / codeChallengeS256：PKCE 计算符合 RFC 7636', () => {
  assert.equal(codeChallengeS256('abc'), createHash('sha256').update('abc').digest('base64url'));
  assert.notEqual(randomToken(), randomToken());
  assert.equal(randomToken(8).length > 0, true);
});

// ─────────────────────────── 路由匹配与重定向防护 ───────────────────────────

test('matchRoute：精确与 :param；方法不匹配则不命中', () => {
  const routes: Route[] = [
    { method: 'GET', path: '/healthz', handler: () => ({}) },
    { method: 'POST', path: '/api/admin/policies/:code/publish', handler: () => ({}) },
  ];
  assert.equal(matchRoute(routes, 'GET', '/healthz')?.params['x'], undefined);
  assert.deepEqual(matchRoute(routes, 'POST', '/api/admin/policies/edu/publish')?.params, { code: 'edu' });
  assert.equal(matchRoute(routes, 'GET', '/api/admin/policies/edu/publish'), undefined);
  assert.equal(matchRoute(routes, 'GET', '/healthz/extra'), undefined);
});

test('★ sanitizeReturnTo：只接受相对路径（防开放重定向钓鱼）', () => {
  assert.equal(sanitizeReturnTo('/me'), '/me');
  assert.equal(sanitizeReturnTo('https://evil.example'), '/');
  assert.equal(sanitizeReturnTo('//evil.example'), '/');
  assert.equal(sanitizeReturnTo('/\\evil'), '/');
  assert.equal(sanitizeReturnTo(undefined), '/');
  assert.equal(sanitizeReturnTo('/admin/x', ['/admin']), '/admin/x');
  assert.equal(sanitizeReturnTo('/me', ['/admin']), '/', '不在允许前缀内则回落到 /');
});

// ─────────────────────────── HTTP 服务器端到端 ───────────────────────────

interface TestServer {
  base: string;
  close(): Promise<void>;
  sessions: SessionService;
  csrfSecret: string;
}

async function startServer(extraRoutes: Route[] = []): Promise<TestServer> {
  const store = new InMemorySessionStore();
  const sessions = new SessionService({ store });
  const csrfSecret = newCsrfSecret();
  const routes: Route[] = [
    { method: 'GET', path: '/healthz', handler: () => ({ body: { status: 'ok' } }), auth: 'none' },
    { method: 'GET', path: '/public', handler: () => ({ body: { ok: true } }), auth: 'none' },
    { method: 'GET', path: '/private', handler: (ctx) => ({ body: { user: ctx.principal!.userId } }), auth: 'required' },
    {
      method: 'POST',
      path: '/write',
      handler: (ctx) => ({ body: { got: ctx.body, user: ctx.principal!.userId } }),
      auth: 'required',
    },
    { method: 'POST', path: '/echo', handler: (ctx) => ({ body: { raw: ctx.rawBody } }), auth: 'none' },
    ...extraRoutes,
  ];
  const app = createAppServer({ sessions, routes, csrfSecret, port: 0, logger: undefined });
  const { url } = await app.listen();
  return { base: url, close: () => app.close(), sessions, csrfSecret };
}

async function createSessionCookie(server: TestServer): Promise<string> {
  const { token } = await server.sessions.create(
    principalFromClaims({ sub: 'u1', emailVerified: true, preferredUsername: 'alice' }, { realm: 'enduser', activeSiteId: 'site-1' }),
  );
  return `${SESSION_COOKIE}=${token}`;
}

test('HTTP：健康检查与公开端点无需登录', async () => {
  const server = await startServer();
  try {
    const health = await fetch(`${server.base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, 'ok');
    assert.equal((await fetch(`${server.base}/public`)).status, 200);
  } finally {
    await server.close();
  }
});

test('HTTP：受保护端点无 Cookie → 401；有会话 → 200', async () => {
  const server = await startServer();
  try {
    assert.equal((await fetch(`${server.base}/private`)).status, 401);
    const cookie = await createSessionCookie(server);
    const ok = await fetch(`${server.base}/private`, { headers: { cookie } });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { user: string }).user, 'u1');
  } finally {
    await server.close();
  }
});

test('★ HTTP：状态变更方法缺 CSRF token → 403；带上正确 token → 200', async () => {
  const server = await startServer();
  try {
    const cookie = await createSessionCookie(server);
    const without = await fetch(`${server.base}/write`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(without.status, 403);

    // 从会话 id 反推 CSRF token（真实前端从 /api/me 拿）
    const sessions = await server.sessions.authenticate(cookie.split('=')[1]);
    assert.equal(sessions.ok, true);
    if (!sessions.ok) return;
    const csrf = csrfTokenFor(sessions.session.id, server.csrfSecret);

    const withToken = await fetch(`${server.base}/write`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(withToken.status, 200);
    assert.deepEqual(((await withToken.json()) as { got: unknown }).got, { a: 1 });
  } finally {
    await server.close();
  }
});

test('HTTP：未知端点 404；非法 JSON 400；超大请求体 413', async () => {
  const server = await startServer();
  try {
    assert.equal((await fetch(`${server.base}/nope`)).status, 404);

    const badJson = await fetch(`${server.base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);

    const huge = await fetch(`${server.base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ big: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(huge.status, 413);
  } finally {
    await server.close();
  }
});

test('HTTP：无效会话 Cookie 会被清除（避免浏览器反复带坏 token）', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.base}/public`, { headers: { cookie: `${SESSION_COOKIE}=bogus` } });
    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /ag_session=;/);
    assert.match(setCookie, /Max-Age=0/);
  } finally {
    await server.close();
  }
});

test('HTTP：traceId 贯通（响应头 X-Request-Id 回显或生成）', async () => {
  const server = await startServer();
  try {
    const echoed = await fetch(`${server.base}/healthz`, { headers: { 'x-request-id': 'trace-abc' } });
    assert.equal(echoed.headers.get('x-request-id'), 'trace-abc');
    const generated = await fetch(`${server.base}/healthz`);
    assert.ok((generated.headers.get('x-request-id') ?? '').length > 0);
  } finally {
    await server.close();
  }
});

// ─────────────────────────── 应用路由（含管理端挂载） ───────────────────────────

test('★ 应用路由：/api/me 返回主体与 CSRF token；未登录 401', async () => {
  const idp = await makeIdp();
  const store = new InMemorySessionStore();
  const sessions = new SessionService({ store });
  const loginTransactions = new InMemoryLoginTransactionStore();
  const routes = createAppRoutes({
    sessions,
    oidc: oidcWith(idp.fetcher),
    loginTransactions,
    csrfSecret: 'secret',
    defaultSiteId: 'site-1',
  });
  const app = createAppServer({ sessions, routes, csrfSecret: 'secret', port: 0 });
  const { url } = await app.listen();
  try {
    assert.equal((await fetch(`${url}/api/me`)).status, 401);

    const { token } = await sessions.create(
      principalFromClaims({ sub: 'u1', emailVerified: true }, { realm: 'enduser', activeSiteId: 'site-1' }),
    );
    const me = await fetch(`${url}/api/me`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { principal: { userId: string }; csrfToken: string };
    assert.equal(body.principal.userId, 'u1');
    assert.equal(body.csrfToken, csrfTokenFor((await store.findByTokenHash(hashToken(token)))!.id, 'secret'));
  } finally {
    await app.close();
  }
});

test('★ 应用路由：/api/auth/login 302 到 IdP 且 state 已落库；回调一次性消费 state', async () => {
  const idp = await makeIdp();
  const store = new InMemorySessionStore();
  const sessions = new SessionService({ store });
  const loginTransactions = new InMemoryLoginTransactionStore();
  const routes = createAppRoutes({ sessions, oidc: oidcWith(idp.fetcher), loginTransactions, csrfSecret: 's' });
  const app = createAppServer({ sessions, routes, csrfSecret: 's', port: 0 });
  const { url } = await app.listen();
  try {
    const login = await fetch(`${url}/api/auth/login?returnTo=/me`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const location = login.headers.get('location')!;
    assert.match(location, /^https:\/\/idp\.example\/authorize/);
    const state = new URL(location).searchParams.get('state')!;

    // 用同一个 state 走两次回调：第一次成功建会话，第二次必须失败（一次性）
    const idToken = await idp.sign({ sub: 'u1', nonce: new URL(location).searchParams.get('nonce')!, email_verified: true });
    const idpWithToken = oidcWith(idp.fetcher, { status: 200, text: JSON.stringify({ id_token: idToken }) });
    const routes2 = createAppRoutes({ sessions, oidc: idpWithToken, loginTransactions, csrfSecret: 's' });
    const app2 = createAppServer({ sessions, routes: routes2, csrfSecret: 's', port: 0 });
    const { url: url2 } = await app2.listen();
    try {
      const first = await fetch(`${url2}/api/auth/callback?state=${state}&code=c1`);
      assert.equal(first.status, 200);
      assert.match(first.headers.get('set-cookie') ?? '', /ag_session=/);
      const second = await fetch(`${url2}/api/auth/callback?state=${state}&code=c1`);
      assert.equal(second.status, 400, '★ 同一个 state 不能被重放');
      assert.match(((await second.json()) as { error: string }).error, /state 无效或已过期/);
    } finally {
      await app2.close();
    }
  } finally {
    await app.close();
  }
});

test('应用路由：管理端挂载后，enduser 域访问被 403 拒绝', async () => {
  const idp = await makeIdp();
  const store = new InMemorySessionStore();
  const sessions = new SessionService({ store });
  const adminCalls: string[] = [];
  const admin = async (request: { path: string; session?: { realm: string } | null }) => {
    adminCalls.push(request.path);
    if (request.session?.realm === 'enduser') return { status: 403, body: { error: '普通用户域不可访问管理端' } };
    return { status: 200, body: { ok: true } };
  };
  const routes = createAppRoutes({
    sessions,
    oidc: oidcWith(idp.fetcher),
    loginTransactions: new InMemoryLoginTransactionStore(),
    csrfSecret: 's',
    admin,
    defaultSiteId: 'site-1',
  });
  const app = createAppServer({ sessions, routes, csrfSecret: 's', port: 0 });
  const { url } = await app.listen();
  try {
    const { token } = await sessions.create(
      principalFromClaims({ sub: 'u1', emailVerified: true }, { realm: 'enduser', activeSiteId: 'site-1' }),
    );
    const response = await fetch(`${url}/api/admin/subjects`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    assert.equal(response.status, 403);
    assert.deepEqual(adminCalls, ['/api/admin/subjects'], '管理端处理器被调用，由它做域判定');
  } finally {
    await app.close();
  }
});

test('应用路由：未装配能力时返回 501（不假装成功）', async () => {
  const idp = await makeIdp();
  const store = new InMemorySessionStore();
  const sessions = new SessionService({ store });
  const routes = createAppRoutes({
    sessions,
    oidc: oidcWith(idp.fetcher),
    loginTransactions: new InMemoryLoginTransactionStore(),
    csrfSecret: 's',
  });
  const app = createAppServer({ sessions, routes, csrfSecret: 's', port: 0 });
  const { url } = await app.listen();
  try {
    const { token } = await sessions.create(
      principalFromClaims({ sub: 'u1', emailVerified: true }, { realm: 'enduser', activeSiteId: 'site-1' }),
    );
    const response = await fetch(`${url}/api/me/eligibility`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    assert.equal(response.status, 501);
  } finally {
    await app.close();
  }
});
