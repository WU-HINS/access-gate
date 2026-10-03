/**
 * OIDC 自举双实例端到端（生产落地第 3 项）。
 *
 * ```
 *   [RP 实例 :18912]  --/api/auth/login?realm=…-->  [IdP 实例 :18911]
 *        ↑                                                    |
 *        └──────── /api/auth/callback?code=…  ←───────────────┘
 * ```
 *
 * ★ 用**同一套实现**同时扮演 IdP 与 RP（自举）：
 *   - 这是「OIDC 双向联邦」最直接的验证（两个方向用同一份代码）；
 *   - 不依赖外部 Keycloak，可在 CI 复跑；
 *   - 同时验证了 `OidcClient`（RP 侧）与 `createOAuthRoutes`（IdP 侧）**真的能互操作**——
 *     它们此前各自有单元测试，但**从未互相调用过**。
 *
 * ★ 端口固定是必需的：`OidcClient` 要求 `issuer` 与发现文档**完全一致**，
 *   而 IdP 的 issuer 里含自己的端口——随机端口会让「先有鸡还是先有蛋」无解。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppServer, newCsrfSecret } from '../src/http/server.ts';
import { createAppRoutes } from '../src/http/routes.ts';
import { createOAuthRoutes, InMemoryOAuthStore } from '../src/http/oauth-routes.ts';
import { InMemorySessionStore, principalFromClaims, SESSION_COOKIE, SessionService } from '../src/auth/session.ts';
import { InMemoryLoginTransactionStore, OidcClient } from '../src/auth/oidc.ts';
import { InMemoryEndUserStore, resolveLogin } from '../src/auth/flows.ts';
import { InMemorySiteRegistry } from '../src/core/sites.ts';
import { generateSigningKey } from '../src/verify/jws.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

/** ★ 用收集型 logger：`silentLogger` 会把 500 的真实原因吞掉。 */
const sink = collectingSink();
const logger = createLogger({ level: 'debug', sink: sink.sink });
process.on('exit', () => {
  const errors = sink.records.filter((record) => record.level === 'error' || record.level === 'warn');
  if (errors.length > 0 && process.exitCode !== 0) {
    process.stdout.write(`\n── 服务端错误日志（${errors.length} 条）──\n`);
    for (const record of errors.slice(-8)) {
      process.stdout.write(`  [${record.level}] ${record.message} ${JSON.stringify(record.fields ?? {})}\n`);
    }
  }
});

const IDP_PORT = 18911;
const RP_PORT = 18912;
const IDP_URL = `http://127.0.0.1:${IDP_PORT}`;
const RP_URL = `http://127.0.0.1:${RP_PORT}`;
const RP_CALLBACK = `${RP_URL}/api/auth/callback`;
// ★ 刻意**不使用固定时钟**：id_token 的 `exp` 是绝对时间戳，
//   用 2025-06-01 签发后，RP 侧按真实时间验签会报「已过期」。
//   生产上时钟是同步的，因此这里用真实时钟才符合生产语义。

interface Federation {
  close: () => Promise<void>;
  /** 在 IdP 侧建立会话并返回其 cookie（模拟「用户已在 IdP 登录」） */
  loginAtIdp: (sub: string, email: string, emailVerified?: boolean) => Promise<string>;
  sites: InMemorySiteRegistry;
  developer: { id: string };
  developerIdentities: Map<string, string>;
}

async function startFederation(): Promise<Federation> {
  // ── IdP 实例 ──
  const idpKey = await generateSigningKey('idp-e2e');
  const oauthStore = new InMemoryOAuthStore();
  oauthStore.registerClient({
    clientId: 'rp-app',
    name: '自举 RP',
    redirectUris: [RP_CALLBACK],
    scopes: ['openid', 'profile', 'email'],
    status: 'active',
  });
  const idpSessions = new SessionService({ store: new InMemorySessionStore() });
  // ★ IdP 侧的「用户档案」：`loadSubject` 与 id_token 的 email/email_verified 都取自它。
  //   装置若返回 undefined，RP 就永远拿不到 email_verified（会被误读成实现缺陷）。
  const idpUsers = new Map<string, { email: string; emailVerified: boolean }>();
  const idpRoutes = createOAuthRoutes({
    store: oauthStore,
    issuer: IDP_URL,
    signingKeys: [idpKey],
    loadSubject: async (subject) => {
      const user = idpUsers.get(subject);
      return user === undefined ? undefined : { displayName: user.email.split('@')[0]!, email: user.email, emailVerified: user.emailVerified };
    },
    logger: logger,
  });
  const idp = createAppServer({ sessions: idpSessions, routes: idpRoutes, csrfSecret: newCsrfSecret(), logger: logger, port: IDP_PORT });
  await idp.listen();

  // ── RP 实例（真实 OidcClient 指向 IdP）──
  const sites = new InMemorySiteRegistry();
  const developer = await sites.createDeveloper({ username: 'dev', displayName: 'Dev', email: 'dev@corp.com', role: 'developer' });
  const developerIdentities = new Map<string, string>();
  const endUsers = new InMemoryEndUserStore();
  const rpSessions = new SessionService({ store: new InMemorySessionStore() });
  const oidc = new OidcClient({
    config: { issuer: IDP_URL, clientId: 'rp-app', redirectUri: RP_CALLBACK, scopes: ['openid', 'profile', 'email'] },
    // ★ `HttpFetcher` 的契约是 `{status, headers, text: string}`——**不是**标准 Response
    //   （`text` 是字符串而非方法）。直接返回 Response 会让发现文档解析失败。
    fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const response = await fetch(url, init as RequestInit);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        text: await response.text(),
      };
    },
  });

  const rpRoutes = createAppRoutes({
    sessions: rpSessions,
    oidc,
    loginTransactions: new InMemoryLoginTransactionStore(),
    csrfSecret: newCsrfSecret(),
    loginResolver: async (loginInput) => {
      const outcome = await resolveLogin(
        { ref: loginInput.ref, oidcSubject: loginInput.oidcSubject, email: loginInput.email, emailVerified: loginInput.emailVerified },
        {
          developerIdentities: {
            async findByIdentity(provider, providerUserId) {
              return developerIdentities.get(`${provider}\u0000${providerUserId}`);
            },
          },
          endUsers,
          sites,
          logger: logger,
        },
      );
      if (!outcome.ok) return { ok: false as const, reason: outcome.reason, message: outcome.message };
      return {
        ok: true as const,
        realm: outcome.realm,
        role: (outcome.realm === 'developer' ? 'developer' : 'user') as 'admin' | 'developer' | 'user',
        principalId: outcome.principalId,
      };
    },
  });
  const rp = createAppServer({ sessions: rpSessions, routes: rpRoutes, csrfSecret: newCsrfSecret(), logger: logger, port: RP_PORT });
  await rp.listen();

  return {
    close: async () => {
      await rp.close();
      await idp.close();
    },
    sites,
    developer,
    developerIdentities,
    loginAtIdp: async (sub, email, emailVerified = true) => {
      idpUsers.set(sub, { email, emailVerified });
      const created = await idpSessions.create(
        principalFromClaims({ sub, email, emailVerified, preferredUsername: email.split('@')[0]! }, { realm: 'developer', role: 'developer' }),
      );
      return `${SESSION_COOKIE}=${created.token}`;
    },
  };
}

/** 完整走一次「RP 发起 → IdP 授权 → RP 回调」。 */
async function runFederatedLogin(
  realm: 'developer' | 'enduser',
  idpCookie: string,
): Promise<{ status: number; body: string; cookie: string | null }> {
  // ① RP 发起登录 → 302 到 IdP 的 /oauth/authorize
  const login = await fetch(`${RP_URL}/api/auth/login?realm=${realm}`, { redirect: 'manual' });
  assert.equal(login.status, 302, `RP 应跳转到 IdP（实际 ${login.status}）`);
  const authorizeUrl = new URL(login.headers.get('location')!);
  assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`, `${IDP_URL}/oauth/authorize`, '★ 应指向 IdP 的授权端点');
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256', '★ RP 必须用 S256');

  // ② IdP 授权（带 IdP 会话 cookie）→ 302 回 RP 的 callback
  const authorize = await fetch(authorizeUrl, { headers: { cookie: idpCookie }, redirect: 'manual' });
  assert.equal(authorize.status, 302, `IdP 授权应 302（实际 ${authorize.status}：${(await authorize.text()).slice(0, 200)}）`);
  const back = new URL(authorize.headers.get('location')!);
  assert.equal(`${back.origin}${back.pathname}`, RP_CALLBACK, '★ 应回到 RP 的 callback');
  assert.ok(back.searchParams.get('code') !== null, '★ 应带上授权码');

  // ③ RP 回调 → 走准入 → 建会话
  const callback = await fetch(back, { redirect: 'manual', headers: { accept: 'text/html' } });
  const setCookies = callback.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ');
  return { status: callback.status, body: await callback.text(), cookie: cookie.length > 0 ? cookie : null };
}

// ─────────────────────────── 端到端 ───────────────────────────

test('★★ 自举端到端：**未入驻** → 走完 IdP 授权码流程后 RP **拒绝**（403，无会话）', async () => {
  const fed = await startFederation();
  try {
    // IdP 侧有会话（用户确实在 IdP 登录了），但该身份**未在平台入驻**
    const idpCookie = await fed.loginAtIdp('intruder-sub', 'intruder@example.com');
    const result = await runFederatedLogin('developer', idpCookie);
    assert.equal(result.status, 403, '★ IdP 授权成功 ≠ 平台准入通过——这是两条独立的判定');
    assert.match(result.body, /尚未入驻/);
    assert.equal(result.cookie, null, '★ 拒绝时不下发会话 cookie');
  } finally {
    await fed.close();
  }
});

test('★★ 自举端到端：**已入驻开发者** → 走完授权码流程后建立会话（主体是 developer.id）', async () => {
  const fed = await startFederation();
  try {
    // 把该 sub 登记为已入驻
    fed.developerIdentities.set(`identity:oidc@platform:developer\u0000dev-sub`, fed.developer.id);
    const idpCookie = await fed.loginAtIdp('dev-sub', 'dev@corp.com');
    const result = await runFederatedLogin('developer', idpCookie);
    assert.equal(result.status, 302, `应成功跳回首页（实际 ${result.status}：${result.body.slice(0, 200)}）`);
    assert.ok(result.cookie !== null, '应下发会话 cookie');

    const me = await fetch(`${RP_URL}/api/me`, { headers: { cookie: result.cookie! } });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { principal: { userId: string; realm: string; role: string } };
    assert.equal(body.principal.userId, fed.developer.id, '★ 主体 id 是 developer.id（可写入 ag_sessions.user_id 的 uuid）');
    assert.equal(body.principal.realm, 'developer');
  } finally {
    await fed.close();
  }
});

test('★★ 自举端到端：**普通用户** → 走完授权码流程后自动建号并建立会话', async () => {
  const fed = await startFederation();
  try {
    const idpCookie = await fed.loginAtIdp('enduser-7', 'user7@example.com');
    const result = await runFederatedLogin('enduser', idpCookie);
    assert.equal(result.status, 302, `应成功（实际 ${result.status}：${result.body.slice(0, 200)}）`);
    assert.ok(result.cookie !== null);

    const me = await fetch(`${RP_URL}/api/me`, { headers: { cookie: result.cookie! } });
    const body = (await me.json()) as { principal: { userId: string; realm: string } };
    assert.equal(body.principal.realm, 'enduser');
    assert.ok(body.principal.userId.length > 0);
  } finally {
    await fed.close();
  }
});

test('★ 自举端到端：IdP 侧**无会话** → authorize 返回 401（授权前必须在 IdP 登录）', async () => {
  const fed = await startFederation();
  try {
    const login = await fetch(`${RP_URL}/api/auth/login?realm=enduser`, { redirect: 'manual' });
    const authorizeUrl = new URL(login.headers.get('location')!);
    // 不带 IdP cookie
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(authorize.status, 401, '★ 未在 IdP 登录不能授权');
  } finally {
    await fed.close();
  }
});

test('★ 自举端到端：**授权码一次性** —— 用同一个 code 二次回调被拒', async () => {
  const fed = await startFederation();
  try {
    fed.developerIdentities.set(`identity:oidc@platform:developer\u0000dev-sub`, fed.developer.id);
    const idpCookie = await fed.loginAtIdp('dev-sub', 'dev@corp.com');

    // 手工走一次 authorize 拿到 callback URL（不消费它）
    const login = await fetch(`${RP_URL}/api/auth/login?realm=developer`, { redirect: 'manual' });
    const authorizeUrl = new URL(login.headers.get('location')!);
    const authorize = await fetch(authorizeUrl, { headers: { cookie: idpCookie }, redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);

    // ① 第一次回调：成功
    const first = await fetch(back, { redirect: 'manual', headers: { accept: 'text/html' } });
    assert.equal(first.status, 302, '第一次回调应成功');

    // ② 第二次用同一个 code：RP 的 state 已被消费 → 400
    const second = await fetch(back, { redirect: 'manual', headers: { accept: 'text/html' } });
    assert.notEqual(second.status, 302, '★ 同一个 code/state 不能二次使用');
  } finally {
    await fed.close();
  }
});

test('★ 自举端到端：**错误的 code_verifier 无法兑换**（PKCE 在真实链路上生效）', async () => {
  const fed = await startFederation();
  try {
    // 直接调 IdP 的 token 端点，用一个不匹配的 verifier
    const login = await fetch(`${RP_URL}/api/auth/login?realm=enduser`, { redirect: 'manual' });
    const authorizeUrl = new URL(login.headers.get('location')!);
    const idpCookie = await fed.loginAtIdp('enduser-9', 'user9@example.com');
    const authorize = await fetch(authorizeUrl, { headers: { cookie: idpCookie }, redirect: 'manual' });
    const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!;

    const response = await fetch(`${IDP_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: 'rp-app', code, code_verifier: 'wrong-verifier' }),
    });
    assert.equal(response.status, 400, '★ PKCE 校验失败必须拒绝');
    const body = (await response.json()) as Record<string, unknown>;
    assert.match(String(body['error_description']), /PKCE 校验失败/);
  } finally {
    await fed.close();
  }
});
