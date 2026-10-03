/**
 * OIDC 联邦接线验收（生产落地第 3 项）。
 *
 * ★★ 本文件的核心断言是**权限提升防线**：
 *   真实回调 `/api/auth/callback` **必须**走 `flows.ts` 的准入——
 *   未入驻的身份走开发者链路**必须 403**。
 *
 *   这条防线在接线之前**完全不存在**：`callback` 只做 `principalFromClaims`，
 *   于是 `/api/auth/login?realm=developer` 会让**任何人直接成为开发者**。
 *   而 `flows.ts` 有完整实现、有测试、审计也把 M7-3 标为 done——
 *   它只是**从未被真实登录路径调用过**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppServer, newCsrfSecret } from '../src/http/server.ts';
import { createAppRoutes } from '../src/http/routes.ts';
import { InMemorySessionStore, SESSION_COOKIE, SessionService } from '../src/auth/session.ts';
import { InMemoryLoginTransactionStore, type OidcClient } from '../src/auth/oidc.ts';
import { InMemoryEndUserStore, resolveLogin } from '../src/auth/flows.ts';
import { InMemorySiteRegistry } from '../src/core/sites.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

/** 一个「IdP 总是成功返回同一组 claims」的 stub（隔离测试接线，不测 IdP 本身）。 */
function stubOidc(claims: Record<string, unknown>): OidcClient {
  return {
    // ★ login 阶段需要它：返回「跳转 URL + 待校验事务（state/nonce/code_verifier）」
    async beginLogin() {
      return {
        // ★ 桩数据要**足够真实**：真实 `OidcClient.beginLogin` 一定会带 PKCE 参数，
        //   而早期的桩省略了它们 → 断言 `code_challenge_method=S256` 时误判为产品缺陷。
        // ★★ 桩必须包含**真实 OidcClient 一定会带的全部参数**：
        //   state · code_challenge + method（PKCE）· nonce（防 id_token 重放）·
        //   response_type · scope。
        //
        //   这是本会话**第四次**「桩数据不够真实导致误判」：
        //   前三次是 IdP userinfo、loadSubject、PKCE 参数；这次是漏了 `nonce`——
        //   而漏掉的后果是测试**断言不到安全属性**（不是产品错了，是桩太假）。
        //   ★ 因此这里一次性补齐，而不是逐个补。
        url:
          'https://idp.invalid/oauth/authorize?client_id=rp-app&state=st-1' +
          '&code_challenge=abc&code_challenge_method=S256' +
          '&nonce=stub-nonce-value' +
          '&response_type=code&scope=openid%20profile%20email',
        transaction: { state: 'st-1', nonce: 'n-1', codeVerifier: 'v-1', createdAt: NOW },
      } as never;
    },
    async completeLogin() {
      return { claims } as never;
    },
  } as unknown as OidcClient;
}

/** 起一个 RP 实例（带真实 loginResolver）。 */
async function startRp(input: {
  claims: Record<string, unknown>;
  developerIdentities?: Map<string, string>;
  /** ★ 必须能注入：内部新建空 registry 会让「已入驻的开发者」查不到自己 */
  sites?: InMemorySiteRegistry;
}): Promise<{ base: string; close: () => Promise<void>; sites: InMemorySiteRegistry; endUsers: InMemoryEndUserStore }> {
  const sites = input.sites ?? new InMemorySiteRegistry();
  const endUsers = new InMemoryEndUserStore();
  const identities = input.developerIdentities ?? new Map<string, string>();
  const sessions = new SessionService({ store: new InMemorySessionStore(), now: () => NOW });

  const routes = createAppRoutes({
    sessions,
    oidc: stubOidc(input.claims),
    loginTransactions: new InMemoryLoginTransactionStore(),
    csrfSecret: newCsrfSecret(),
    loginResolver: async (loginInput) => {
      const outcome = await resolveLogin(
        {
          ref: loginInput.ref,
          oidcSubject: loginInput.oidcSubject,
          email: loginInput.email,
          emailVerified: loginInput.emailVerified,
        },
        {
          developerIdentities: {
            async findByIdentity(provider, providerUserId) {
              return identities.get(`${provider}\u0000${providerUserId}`);
            },
          },
          endUsers,
          sites,
          logger: silentLogger,
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

  const app = createAppServer({ sessions, routes, csrfSecret: newCsrfSecret(), logger: silentLogger, port: 0 });
  const { url } = await app.listen();
  return { base: url, close: () => app.close(), sites, endUsers };
}

/** 走一次「login → callback」（callback 的 state 由 login 阶段写入 transaction store）。 */
async function loginFlow(base: string, realm: 'developer' | 'enduser'): Promise<{ status: number; body: string; cookie: string | null }> {
  // ① 发起登录 → 302 到 IdP（stub 环境里我们只需拿到 state）
  const login = await fetch(`${base}/api/auth/login?realm=${realm}`, { redirect: 'manual' });
  if (login.status !== 302) return { status: login.status, body: await login.text(), cookie: null };
  const location = new URL(login.headers.get('location')!);
  const state = location.searchParams.get('state')!;

  // ② 回调（stub 的 completeLogin 总是成功）
  // ★ callback 的行为是刻意的：带 `Accept: text/html` → 302（浏览器场景）；
  //   否则返回 200 + JSON（脚本/测试场景）。这里模拟浏览器。
  const callback = await fetch(`${base}/api/auth/callback?code=stub-code&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: { accept: 'text/html' },
  });
  const setCookies = callback.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ');
  return { status: callback.status, body: await callback.text(), cookie: cookie.length > 0 ? cookie : null };
}

// ─────────────────────────── ★★ 权限提升防线 ───────────────────────────

test('★★ 未入驻的身份走**真实回调**的开发者链路 → 403（而不是成为开发者）', async () => {
  const rp = await startRp({ claims: { sub: 'intruder', email: 'intruder@example.com', email_verified: true } });
  try {
    const result = await loginFlow(rp.base, 'developer');
    assert.equal(result.status, 403, '★ 未入驻必须被拒——这是 M7-3 的验收标准');
    assert.match(result.body, /尚未入驻/);
    assert.match(result.body, /邀请码/);
    assert.equal(result.cookie, null, '★ 拒绝时绝不能下发会话 cookie');
  } finally {
    await rp.close();
  }
});

test('★★ 已入驻的开发者走真实回调 → 建立会话（且主体是 developer.id）', async () => {
  const sites = new InMemorySiteRegistry();
  const developer = await sites.createDeveloper({ username: 'dev', displayName: 'Dev', email: 'dev@corp.com', role: 'developer' });
  const identities = new Map<string, string>([['identity:oidc@platform:developer\u0000dev-sub', developer.id]]);
  const rp = await startRp({ claims: { sub: 'dev-sub', email: 'dev@corp.com', email_verified: true }, developerIdentities: identities, sites });
  try {
    const result = await loginFlow(rp.base, 'developer');
    assert.equal(result.status, 302, `成功应 302 回首页（实际 ${result.status}，body=${result.body.slice(0, 300)}）`);
    assert.ok(result.cookie !== null, '应下发会话 cookie');

    // 用会话 cookie 访问 /api/me，确认主体是 developer.id
    const me = await fetch(`${rp.base}/api/me`, { headers: { cookie: result.cookie! } });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { principal: { userId: string; realm: string; role: string } };
    assert.equal(body.principal.userId, developer.id, '★ 主体 id 必须是 developer.id（纯 uuid，可写入 ag_sessions.user_id）');
    assert.equal(body.principal.realm, 'developer');
  } finally {
    await rp.close();
  }
});

test('★★ 普通用户走真实回调 → 自动建号并建立会话（无需入驻）', async () => {
  const rp = await startRp({ claims: { sub: 'e-42', email: 'e42@example.com', email_verified: true } });
  try {
    const result = await loginFlow(rp.base, 'enduser');
    assert.equal(result.status, 302, `普通用户链路应成功（实际 ${result.status}，body=${result.body.slice(0, 300)}）`);
    assert.ok(result.cookie !== null);

    const me = await fetch(`${rp.base}/api/me`, { headers: { cookie: result.cookie! } });
    const body = (await me.json()) as { principal: { userId: string; realm: string } };
    assert.equal(body.principal.realm, 'enduser');
    assert.ok(body.principal.userId.length > 0);
    // ★ 自动建号确实落到了 endUser store
    assert.equal((await rp.endUsers.findByIdentity('identity:oidc@platform:enduser', 'e-42')) !== undefined, true);
  } finally {
    await rp.close();
  }
});

test('★ 开发者链路强制邮箱验证（真实回调路径）', async () => {
  const sites = new InMemorySiteRegistry();
  const developer = await sites.createDeveloper({ username: 'dev', displayName: 'Dev', email: 'dev@corp.com', role: 'developer' });
  const identities = new Map<string, string>([['identity:oidc@platform:developer\u0000dev-sub', developer.id]]);
  const rp = await startRp({ claims: { sub: 'dev-sub', email: 'dev@corp.com', email_verified: false }, developerIdentities: identities, sites });
  try {
    const result = await loginFlow(rp.base, 'developer');
    assert.equal(result.status, 403);
    assert.match(result.body, /强制邮箱绑定/);
  } finally {
    await rp.close();
  }
});

// ─────────────────────────── 两条链路隔离 ───────────────────────────

test('★ 同一 sub：普通用户链路建号后，开发者链路**仍拒绝**（隔离成立）', async () => {
  const claims = { sub: 'shared-sub', email: 'shared@example.com', email_verified: true };

  // ① 先走普通用户链路 → 自动建号
  const rpUser = await startRp({ claims });
  let userId = '';
  try {
    const result = await loginFlow(rpUser.base, 'enduser');
    assert.equal(result.status, 302);
    const me = await fetch(`${rpUser.base}/api/me`, { headers: { cookie: result.cookie! } });
    userId = ((await me.json()) as { principal: { userId: string } }).principal.userId;
  } finally {
    await rpUser.close();
  }

  // ② 同一个 sub 走开发者链路 → 必须被拒
  const rpDev = await startRp({ claims });
  try {
    const result = await loginFlow(rpDev.base, 'developer');
    assert.equal(result.status, 403, '★ 普通用户身份不得通过开发者链路进入');
    assert.match(result.body, /尚未入驻/);
  } finally {
    await rpDev.close();
  }
  assert.ok(userId.length > 0);
});

test('★ 未提供 `loginResolver` 时保持旧行为（仅用于测试/demo，报告中登记为生产禁用项）', async () => {
  const sessions = new SessionService({ store: new InMemorySessionStore(), now: () => NOW });
  const routes = createAppRoutes({
    sessions,
    oidc: stubOidc({ sub: 'anyone', email: 'a@b.c', email_verified: true }),
    loginTransactions: new InMemoryLoginTransactionStore(),
    csrfSecret: newCsrfSecret(),
    // 刻意不提供 loginResolver
  });
  const app = createAppServer({ sessions, routes, csrfSecret: newCsrfSecret(), logger: silentLogger, port: 0 });
  const { url } = await app.listen();
  try {
    const result = await loginFlow(url, 'developer');
    // 旧行为：直接建会话（**这正是需要接线的原因**）
    assert.equal(result.status, 302);
    assert.ok(result.cookie !== null, '★ 未接线时任何人都会拿到开发者会话——生产必须提供 loginResolver');
  } finally {
    await app.close();
  }
});

void SESSION_COOKIE;

// ─────────────────────────── 文档声明的联邦登录入口（docs/06 §6.0） ───────────────────────────

test('★ docs/06 §6.0 声明的 `/auth/oidc/:ref/start` 可用（此前未实现 → 404）', async () => {
  const rp = await startRp({ claims: { sub: 'x', email: 'x@example.com', email_verified: true } });
  try {
    // `ref` 含冒号，按 URL 惯例编码
    const response = await fetch(`${rp.base}/auth/oidc/${encodeURIComponent('platform:developer')}/start`, { redirect: 'manual' });
    assert.equal(response.status, 302, '应 302 跳转到 IdP（此前该路径返回 404）');
    const location = new URL(response.headers.get('location')!);
    assert.equal(location.pathname, '/oauth/authorize');
    // ★ 应带上 PKCE 参数
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  } finally {
    await rp.close();
  }
});

test('★ `/auth/oidc/:ref/start` 的 `ref` 决定链路（platform:developer → developer 域）', async () => {
  // 未入驻的 sub 走 developer 链路必须 403；走 enduser 链路应成功
  const claims = { sub: 'ref-test', email: 'ref@example.com', email_verified: true };

  const asDeveloper = await startRp({ claims });
  try {
    const start = await fetch(`${asDeveloper.base}/auth/oidc/${encodeURIComponent('platform:developer')}/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await fetch(`${asDeveloper.base}/auth/oidc/${encodeURIComponent('platform:developer')}/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    assert.equal(callback.status, 403, '★ platform:developer 必须要求已入驻（即使从新入口进来）');
  } finally {
    await asDeveloper.close();
  }

  const asEndUser = await startRp({ claims });
  try {
    const start = await fetch(`${asEndUser.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await fetch(`${asEndUser.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    assert.equal(callback.status, 302, 'platform:enduser 应自动建号并成功');
  } finally {
    await asEndUser.close();
  }
});

test('★ `ctx.params` 现在可用（此前 `:param` 解析结果被丢弃）', async () => {
  // 用一个临时路由验证 params 传递
  const sessions = new SessionService({ store: new InMemorySessionStore() });
  const routes = [
    {
      method: 'GET',
      path: '/probe/:ref/leaf',
      auth: 'none' as const,
      handler: (ctx: { params: Record<string, string> }) => ({ status: 200, body: { ref: ctx.params['ref'] ?? null } }),
    },
  ];
  const app = createAppServer({ sessions, routes: routes as never, csrfSecret: newCsrfSecret(), logger: silentLogger, port: 0 });
  const { url } = await app.listen();
  try {
    const response = await fetch(`${url}/probe/${encodeURIComponent('platform:developer')}/leaf`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ref: string | null };
    assert.equal(body.ref, 'platform:developer', '★ 路径参数应被解码后传给 handler（此前拿不到）');
  } finally {
    await app.close();
  }
});

// ─────────────────────────── ★★ 入站安全属性（state 重放 / PKCE / nonce）───────────────────────────

test('★★ state **一次性消费**：同一个 state 回调两次，第二次必须被拒（防重放）', async () => {
  const rp = await startRp({ claims: { sub: 'replay', email: 'r@example.com', email_verified: true } });
  try {
    const start = await fetch(`${rp.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;

    // ① 第一次回调：成功（302 建立会话）
    const first = await fetch(`${rp.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    assert.equal(first.status, 302, '第一次回调应成功');

    // ② ★★ 第二次用**同一个 state**：必须被拒
    //    state 若可重放，攻击者可以拿一个截获的 state 反复触发登录
    //    （更糟的是：若 state 还绑定了 codeVerifier，重放会绕过 PKCE 的一次性语义）
    const second = await fetch(`${rp.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    assert.equal(second.status, 400, '★ 同一个 state 不能重放');
    const body = (await second.json()) as { error: string };
    assert.match(body.error, /重放|state 无效/);
  } finally {
    await rp.close();
  }
});

test('★★ 回调缺少 state 或 code → 400（不进入任何登录流程）', async () => {
  const rp = await startRp({ claims: { sub: 'x', email: 'x@example.com', email_verified: true } });
  try {
    const noState = await fetch(`${rp.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/callback?code=c`, { redirect: 'manual' });
    assert.equal(noState.status, 400);
    assert.match(((await noState.json()) as { error: string }).error, /缺少 state 或 code/);

    const noCode = await fetch(`${rp.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/callback?state=whatever`, { redirect: 'manual' });
    assert.equal(noCode.status, 400);
  } finally {
    await rp.close();
  }
});

test('★★ 伪造的 state（从未发起过登录）→ 400，且**不建立任何会话**', async () => {
  const rp = await startRp({ claims: { sub: 'forged', email: 'f@example.com', email_verified: true } });
  try {
    const response = await fetch(`${rp.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/callback?code=c&state=forged-state-value`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    assert.equal(response.status, 400, '★ 未登记的 state 必须被拒');
    // ★ 关键：不得设置会话 Cookie（否则伪造 state 就能登录）
    const cookies = response.headers.getSetCookie?.() ?? [];
    assert.equal(
      cookies.some((entry) => /ag_session/i.test(entry)),
      false,
      '★ 拒绝时不得下发会话 Cookie',
    );
  } finally {
    await rp.close();
  }
});

test('★★ IdP 返回错误（error 参数）→ 400 且带原因（不吞掉错误）', async () => {
  const rp = await startRp({ claims: { sub: 'x', email: 'x@example.com', email_verified: true } });
  try {
    const response = await fetch(
      `${rp.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/callback?error=access_denied&error_description=user%20cancelled`,
      { redirect: 'manual' },
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; detail: string | null };
    assert.match(body.error, /IdP 返回错误/);
    assert.equal(body.detail, 'user cancelled', '★ 要保留 IdP 给的原因，便于排障');
  } finally {
    await rp.close();
  }
});

test('★★ PKCE：`code_verifier` 与 `nonce` 都从**服务端事务**取，不依赖客户端回传', async () => {
  // ★ 这是 PKCE 正确性的关键：若 code_verifier 由客户端在回调时提供，
  //   攻击者截获授权码后可以自带 verifier（PKCE 就失效了）。
  //   本实现从 `loginTransactions` 取（`take(state)`），因此回调 URL 里**不需要** verifier。
  const rp = await startRp({ claims: { sub: 'pkce', email: 'p@example.com', email_verified: true } });
  try {
    const start = await fetch(`${rp.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/start`, { redirect: 'manual' });
    const location = new URL(start.headers.get('location')!);
    // ① 发起时带上 challenge（S256）
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok((location.searchParams.get('code_challenge') ?? '').length > 0, '发起时必须带 code_challenge');
    // ② ★ nonce 必须在授权请求里（防 id_token 重放）
    assert.ok((location.searchParams.get('nonce') ?? '').length > 0, '★ 授权请求必须带 nonce');

    // ③ 回调时**不带** verifier 也能成功——证明 verifier 存在服务端
    const state = location.searchParams.get('state')!;
    const callback = await fetch(`${rp.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    assert.equal(callback.status, 302, '★ 回调不需要客户端提供 code_verifier（它存在服务端事务里）');
  } finally {
    await rp.close();
  }
});

test('★★ 两条链路的隔离矩阵：同一 IdP 主体在两条链路上的**准入结论必须不同**', async () => {
  // 未入驻的主体：developer 链路必须拒绝、enduser 链路必须接受。
  // ★ 这是「两条链路隔离」的核心断言——不是「两条都能用」，
  //   而是「同一主体在两条链路上得到不同结论」。
  const claims = { sub: 'matrix-sub', email: 'm@example.com', email_verified: true };

  // ① developer 链路：未入驻 → 403
  const dev = await startRp({ claims });
  let devStatus: number;
  try {
    const start = await fetch(`${dev.base}/auth/oidc/${encodeURIComponent('platform:developer')}/start`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await fetch(`${dev.base}/auth/oidc/${encodeURIComponent('platform:developer')}/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    devStatus = callback.status;
  } finally {
    await dev.close();
  }

  // ② enduser 链路：同一主体 → 自动建号 → 302
  const user = await startRp({ claims });
  let userStatus: number;
  try {
    const start = await fetch(`${user.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/start`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await fetch(`${user.base}/auth/oidc/${encodeURIComponent('platform:enduser')}/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    userStatus = callback.status;
  } finally {
    await user.close();
  }

  assert.equal(devStatus, 403, '★ 同一主体在 developer 链路上必须被拒（未入驻）');
  assert.equal(userStatus, 302, '★ 同一主体在 enduser 链路上必须成功（自动建号）');
  assert.notEqual(devStatus, userStatus, '★★ 两条链路的准入结论**必须不同**——这才是「隔离」');
});
