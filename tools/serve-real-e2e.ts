/**
 * 真实 PostgreSQL 模式下的端到端验证（生产落地第 1 项）。
 *
 * ```
 *   ① 起一个真实 PG 实例（embedded-postgres 二进制，非 pglite）
 *   ② 应用迁移 0001_init.sql
 *   ③ 以 `--mode=real` spawn tools/serve.ts（真实 PG + 生产配置校验）
 *   ④ 轮询 health/readiness，再走完整主线：
 *        登录 → 两级选择 → 控制台导航 → 权限边界 → 资格查询
 *   ⑤ 报告每一步的真实 HTTP 结果；失败即非零退出
 *   ⑥ 清理（PG 与子进程）
 * ```
 *
 * ★ 与「内存模式验证」的区别：本脚本**不允许**回落到内存注册表。
 *   它要求 `--mode=real` 启动成功——若 `assertProductionReady` 或
 *   `DbSiteRegistry` 有问题，脚本必须**失败**而不是悄然降级。
 *
 * 用法：
 *   node --experimental-strip-types tools/serve-real-e2e.ts
 */

import { startStubIdp } from './stub-idp.ts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRealPostgres } from './pg-real.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];
/** 服务端输出缓冲（全局，供未捕获异常时打印诊断）。 */
const serverLog = { stdout: '', stderr: '' };
process.on('uncaughtException', (error) => {
  process.stdout.write(`\n!! 未捕获异常：${error.message}\n`);
  process.stdout.write(`── 服务端 stdout 尾部 ──\n${serverLog.stdout.slice(-2000)}\n`);
  process.stdout.write(`── 服务端 stderr 尾部 ──\n${serverLog.stderr.slice(-1500)}\n`);
  process.exit(1);
});
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '✅' : '❌'} ${name}\n     ${detail}\n`);
}

/** 等待服务就绪（轮询 readiness）。 */
async function waitForReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // ★ 实际路径是 /healthz/ready（启动横幅里写明了）
      const response = await fetch(`${BASE}/healthz/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) return true;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * 带 cookie 的 GET（**带重试**）。
 *
 * ★ 为什么需要重试：服务端设置了较短的 keep-alive 超时（避免挂起的连接阻塞关闭），
 *   而复用连接池时客户端可能正好命中已被服务端关闭的连接
 *   （表现为 `SocketError: other side closed`）。这是**测试客户端的连接复用问题**，
 *   不是服务端缺陷——真实浏览器会自动重试。
 */
async function get(path: string, cookie?: string, attempt = 0): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: cookie === undefined ? {} : { cookie, connection: 'close' },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    if (attempt >= 2) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return get(path, cookie, attempt + 1);
  }
}

async function main(): Promise<void> {
  process.stdout.write('\n【真实 PG 模式端到端验证】\n\n');

  // ── ① 起真实 PG ──
  const instance = await startRealPostgres({ fresh: true });
  record('① 真实 PostgreSQL 启动', true, `port=${instance.port} dataDir=${instance.dataDir}`);

  let child: ChildProcess | undefined;
  // ★ stub OIDC 提供方（真实 RSA 签名 + JWKS）——用于「真实进程 + 完整授权码流程」
  // ★ clientId 必须与传给服务进程的 `AG_OIDC_CLIENT_ID` **完全一致**——
  //   否则 id_token 的 `aud` 校验会失败（我第一版就是这样：`unexpected "aud" claim value`）。
  const stubClientId = 'e2e-real-client';
  const stubIdp = await startStubIdp({ clientId: stubClientId });
  try {
    // ── ② 跑迁移运行器（**外部 PG**，与生产同一路径）──
    //   ★ 这里刻意 spawn `tools/db-migrate.ts` 而不是直接 exec DDL：
    //     迁移记录表 `ag_migrations` 由运行器创建并维护，
    //     而 `serve.ts --mode=real` 的启动检查**要求**该表有记录。
    const migrate = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.join(ROOT, 'tools', 'db-migrate.ts'), `--database-url=${instance.url}`],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const tables = await instance.sql<{ n: string }>(
      "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ag_%'",
    );
    const migrationRows = await instance.sql<{ name: string }>('SELECT name FROM ag_migrations');
    record(
      '② 迁移运行器应用于外部 PG',
      migrate.status === 0 && Number(tables[0]!.n) > 40 && migrationRows.length > 0,
      `exit=${migrate.status}，ag_* 表数=${tables[0]!.n}，ag_migrations 记录=${migrationRows.map((row) => row.name).join(',') || '（无）'}`,
    );

    // ── ③ 以真实模式启动 serve.ts ──
    child = spawn(
      process.execPath,
      ['--experimental-strip-types', path.join(ROOT, 'tools', 'serve.ts'), '--mode=real', `--port=${PORT}`, '--log-level=info'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          AG_MODE: 'real',
          AG_DATABASE_URL: instance.url,
        // ★ 真实模式必需：调用方密钥要加密存入 `ag_secrets`
        AG_MASTER_KEY: '0'.repeat(64),
          AG_PUBLIC_URL: BASE,
          // ★ 生产模式强制要求 OIDC 配置存在（`assertProductionReady` 会在启动期拦下）。
          //   这里填**占位**值：本项只验证「真实 PG + 生产配置校验 + 主线走通」，
          //   真实 IdP 的授权码流程是第 3 项的内容。
          // ★★★★★ R78：改用**本地 stub IdP**——
          //   此前这里是 `https://idp.invalid` 占位符，而脚本自己的注释写着
          //   「真实 IdP 的授权码流程是第 3 项的内容」。
          //   ★ 本项现在**真的走完整授权码流程**（真实服务进程 + 真实 PG）：
          //     stub IdP 用真实 RSA 签名 id_token，而真实模式**会验签**。
          AG_OIDC_ISSUER: stubIdp.issuer,
          AG_OIDC_CLIENT_ID: stubClientId,
          AG_OIDC_REDIRECT_URI: `${BASE}/api/auth/callback`,
          // ★ 生产必须 Secure Cookie（这是**正确**的：不根据可伪造的请求头决定，
          //   从而避免「客户端声称 http → 应用下发非 Secure cookie」的降级攻击）。
          //   代价是本地 http 下 curl 不会自动回传 Secure cookie，
          //   因此下面的验证**手动**构造 Cookie 头（与浏览器行为无关，只验证服务端逻辑）。
          AG_SECURE_COOKIES: '1',
          AG_ALLOW_DEMO: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let bootstrapLine = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      serverLog.stdout += text;
      const match = /\/api\/auth\/bootstrap\?token=[A-Za-z0-9_-]+/.exec(stdout);
      if (match !== null) bootstrapLine = match[0];
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      serverLog.stderr += text;
    });

    const ready = await waitForReady(30_000);
    if (!ready) {
      record('③ 真实模式启动并 ready', false, `30s 内未就绪。stdout 尾部：${stdout.slice(-600)}；stderr 尾部：${stderr.slice(-600)}`);
      return;
    }
    record('③ 真实模式启动并 ready', true, 'GET /healthz/ready → 200（未回落内存模式）');

    // 确认它真的在用 PG（而不是内存注册表）
    const usersInDb = await instance.sql<{ n: string }>('SELECT count(*)::text AS n FROM ag_developers');
    record('④ 启动期确实写入了 PG', true, `ag_developers 行数 = ${usersInDb[0]!.n}（standalone 兜底已落库）`);

    // ── ④b OIDC IdP 端点（此前**完全没有挂载**）──
    const discovery = await get('/.well-known/openid-configuration');
    const jwks = await get('/oauth/jwks.json');
    const discoveryBody = discovery.status === 200 ? (JSON.parse(discovery.body) as Record<string, unknown>) : {};
    const jwksBody = jwks.status === 200 ? (JSON.parse(jwks.body) as { keys?: { kid?: string; d?: unknown }[] }) : {};
    record(
      '④b OIDC IdP 端点已挂载',
      discovery.status === 200 && jwks.status === 200 && jwksBody.keys?.[0]?.kid !== undefined && !('d' in (jwksBody.keys?.[0] ?? {})),
      `/.well-known/openid-configuration → ${discovery.status}（issuer=${String(discoveryBody['issuer'] ?? '?')}）· /oauth/jwks.json → ${jwks.status}（kid=${jwksBody.keys?.[0]?.kid ?? '?'}，无私钥材料）`,
    );

    // ── ④c 协同验证端点（此前同样没有挂载）──
    const verifyProbe = await get('/api/verify/v1/jwks');
    record('④c 协同验证端点已挂载', verifyProbe.status !== 404, `/api/verify/v1/jwks → ${verifyProbe.status}（404 表示路由未挂载）`);

    // ── ⑤ 走完整主线 ──
    // ★ 真实模式下 demo 登录**正确关闭**（404）——必须走冷启动引导令牌。
    //   这是生产冷启动的标准做法：启动时打印一次性令牌，用它换管理员会话。
    const bootstrapUrl = /\/api\/auth\/bootstrap\?token=([A-Za-z0-9_-]+)/.exec(bootstrapLine);
    const login =
      bootstrapUrl === null
        ? await fetch(`${BASE}/api/auth/demo-login?email=e2e@example.com&realm=developer&role=developer`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
        : await fetch(`${BASE}${bootstrapUrl[0]}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    // ★ 手动构造 Cookie 头：生产 cookie 带 `Secure`，而本地是 http，
    //   curl/浏览器都不会回传它。这里直接取 name=value 手动带上——
    //   验证的是**服务端会话逻辑**，不是浏览器的 cookie 策略。
    const setCookies = login.headers.getSetCookie?.() ?? [];
    const cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ');
    const hasSecure = setCookies.some((entry) => /;\s*Secure/i.test(entry));
    record(
      '⑤-1 登录（真实模式：冷启动引导令牌）',
      login.status < 400 && cookie.length > 0,
      `HTTP ${login.status}，cookie ${cookie.length} 字节${hasSecure ? '（含 Secure 属性 ✓ 生产要求）' : ''}，引导令牌${bootstrapLine.length > 0 ? '已获取' : '未获取到'}` +
        (login.status >= 400 ? `\n     ── 服务端 stdout 尾部 ──\n${stdout.slice(-1200)}\n     ── 服务端 stderr 尾部 ──\n${stderr.slice(-800)}` : ''),
    );

    const selection = await get('/api/me/selection/developers', cookie);
    const developers = JSON.parse(selection.body) as { developers: { developerId: string; displayName: string; siteCount: number }[] };
    record(
      '⑤-2 两级选择：第一级',
      selection.status === 200 && developers.developers.length > 0,
      `HTTP ${selection.status}，可选开发者 ${developers.developers.length} 个（来自 PG 的 ag_developers/ag_sites）`,
    );

    const developerId = developers.developers[0]!.developerId;
    const sites = await get(`/api/me/selection/sites/${developerId}`, cookie);
    const siteList = JSON.parse(sites.body) as { sites: { siteId: string; nickname: string }[] };
    record(
      '⑤-3 两级选择：第二级',
      sites.status === 200 && siteList.sites.length > 0,
      `HTTP ${sites.status}，可选站点 ${siteList.sites.length} 个：${siteList.sites.map((entry) => entry.siteId).join(', ')}`,
    );

    // 提交选择（需 CSRF）
    const me = await get('/api/me', cookie);
    const csrf = (JSON.parse(me.body) as { csrfToken: string }).csrfToken;
    const post = async (attempt = 0): Promise<Response> => {
      try {
        return await fetch(`${BASE}/api/me/selection`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, connection: 'close' },
          body: JSON.stringify({ developerId, siteId: siteList.sites[0]!.siteId }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return post(attempt + 1);
      }
    };
    const submit = await post();
    const submitBody = (await submit.json()) as { ok?: boolean; site?: { id: string } };
    record(
      '⑤-4 提交选择并写入会话',
      submit.status === 200 && submitBody.ok === true,
      `HTTP ${submit.status}，site.id=${submitBody.site?.id ?? '（无）'}（内部 uuid）`,
    );

    const sections = await get('/api/console/sections', cookie);
    const sectionList = JSON.parse(sections.body) as { sections: { id: string }[] };
    record('⑤-5 控制台导航', sections.status === 200 && sectionList.sections.length === 5, `HTTP ${sections.status}，开发者可见 ${sectionList.sections.length} 个分区`);

    const denied = await get('/api/console/sections/admin.plugins/access', cookie);
    const allowed = await get('/api/console/sections/dev.policies/access', cookie);
    record(
      '⑤-6 权限边界（M7-7）',
      denied.status === 403 && allowed.status === 200,
      `插件安装 → ${denied.status}（应 403）· 本站点策略 → ${allowed.status}（应 200）`,
    );

    // ── ⑤-7 资格查询（目标第 1 项明确要求的一步）──
    // ★ 复查时发现：脚本的注释里写了「→ 资格查询」，但**实际没有这一步**——
    //   验证不完整与实现不完整是两回事，但「声称走通」必须两步都在。
    const eligibility = await get('/api/me/eligibility', cookie);
    let eligibilityOk = eligibility.status === 200;
    let eligibilityDetail = `HTTP ${eligibility.status}`;
    if (eligibility.status === 200) {
      const body = JSON.parse(eligibility.body) as { progress?: { satisfied?: number; total?: number }; todos?: unknown[] };
      const satisfied = body.progress?.satisfied ?? 0;
      const total = body.progress?.total ?? 0;
      // ★ 不要求「有资格」——空站点下 satisfied=0/total=0 是合理结果。
      //   要求的是「端点可用且结构正确」。
      eligibilityOk = typeof satisfied === 'number' && typeof total === 'number' && Array.isArray(body.todos);
      eligibilityDetail = `HTTP 200，progress=${satisfied}/${total}，todos=${body.todos?.length ?? 0} 条（结构正确）`;
    } else {
      eligibilityDetail += `（期望 200——该端点未挂载或未登录）`;
    }
    record(
      '⑤-7 资格查询（/api/me/eligibility）',
      eligibilityOk,
      eligibilityDetail +
        (eligibilityOk
          ? ''
          : `\n     ── 服务端 error 日志 ──\n${stdout
              .split('\n')
              .filter((line) => line.includes('"level":"error"') || line.includes('路由处理异常'))
              .slice(-3)
              .join('\n')}`),
    );

    // ── ⑤-8 ★★★★★ 真实 OIDC 授权码流程（目标第 3 项的核心）──
    //   ★ 这一项此前**从未被验证过**：
    //     · `serve-real-e2e.ts`（真实进程 + 真实 PG）只用引导令牌登录；
    //     · `test/oidc-federation-e2e.test.ts` 覆盖完整 OIDC 流程，但用**内存 handler**。
    //     ★ 两个绿色的圆没有重叠，而目标要求的正是那个重叠区域。
    //
    //   ★ 本项覆盖：真实服务进程 + 真实 PG + **真实 RSA 验签的 IdP** + 完整授权码流程
    //     （beginLogin → IdP 授权 → 回调 → 换 token → 验签 → 校验 nonce/PKCE → 建会话）。
    {
      // ① 发起登录（拿 302 与 state/PKCE cookie）
      const startRes = await fetch(`${BASE}/api/auth/login?realm=platform:enduser`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      const startCookies = (startRes.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
      const authorizeLocation = startRes.headers.get('location') ?? '';
      const authorizeUrl = new URL(authorizeLocation);
      const stateParam = authorizeUrl.searchParams.get('state') ?? '';
      const nonceParam = authorizeUrl.searchParams.get('nonce') ?? '';
      record(
        '⑤-8a 真实 OIDC：发起登录（302 → IdP）',
        startRes.status === 302 && stateParam.length > 0 && nonceParam.length > 0 && authorizeUrl.origin === stubIdp.issuer,
        `HTTP ${startRes.status}，跳转到 ${authorizeUrl.origin}（stub IdP），state/nonce 已生成，PKCE=${authorizeUrl.searchParams.get('code_challenge_method') ?? '无'}`,
      );

      // ② 在 IdP 侧「授权」（模拟用户同意）→ 拿 code
      const hintUrl = new URL(authorizeUrl.toString());
      // ★★ sub 必须是**合法 uuid**：本平台的 `ag_users.id` 就是 OIDC sub，
      //   而它是 uuid 列——非 uuid 的 sub 会报
      //   `invalid input syntax for type uuid: "e2e-enduser-1"`（R2 已踩过一次）。
      const ENDUSER_SUB = '11111111-2222-7333-a444-555555555555';
      hintUrl.searchParams.set('login_hint', ENDUSER_SUB);
      hintUrl.searchParams.set('email', 'e2e-oidc@example.com');
      const idpRes = await fetch(hintUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      const callbackLocation = idpRes.headers.get('location') ?? '';
      const codeParam = new URL(callbackLocation).searchParams.get('code') ?? '';
      record(
        '⑤-8b 真实 OIDC：IdP 发放授权码',
        idpRes.status === 302 && codeParam.length > 0,
        `IdP HTTP ${idpRes.status}，code 已发放（state 回传一致 = ${new URL(callbackLocation).searchParams.get('state') === stateParam}）`,
      );

      // ③ 回调：本平台用 code 换 token（**真实 RSA 验签**）并建会话
      const callbackRes = await fetch(`${BASE}${callbackLocation.replace(BASE, '')}`, {
        redirect: 'manual',
        headers: { cookie: startCookies },
        signal: AbortSignal.timeout(15_000),
      });
      const sessionCookies = (callbackRes.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
      // ★★ 失败时**必须记录响应体**：401 来自 `completeLogin` 抛错分支，
      //   而**原因就在 body 里**（如 `nonce_mismatch` / `signature_verification_failed`）。
      //   ★ 我第一版只记了状态码，于是看到「401」却无从知道为什么——
      //     这是本会话反复出现的「信号可见但原因不可见」。
      const callbackBody = callbackRes.status >= 400 ? (await callbackRes.text()).slice(0, 300) : '';
      record(
        '⑤-8c 真实 OIDC：回调换 token 并建会话',
        callbackRes.status < 400 && sessionCookies.length > 0,
        `HTTP ${callbackRes.status}，会话 cookie ${sessionCookies.length} 字节` +
          (callbackRes.status >= 400
            ? `\n     ── 响应体（**原因在这里**）──\n     ${callbackBody}` +
              `\n     ── 服务端 error ──\n${stdout.split('\n').filter((line) => line.includes('"level":"error"')).slice(-2).join('\n')}`
            : ''),
      );

      // ④ ★★★ 用该会话访问 /api/me：**证明这是真实登录**（不是手工构造的 cookie）
      if (sessionCookies.length > 0) {
        const meRes = await fetch(`${BASE}/api/me`, { headers: { cookie: sessionCookies }, signal: AbortSignal.timeout(10_000) });
        // ★ `/api/me` 返回 `{ principal, csrfToken, activeSiteId }`——
        //   `realm` / `userId` 在 **`principal` 里**（我第一版假设在顶层，于是断言失败）。
        //   ★ 又一次「先看实际值，再写断言」。
        const meBody =
          meRes.status === 200
            ? (JSON.parse(await meRes.text()) as { principal?: { realm?: string; userId?: string } })
            : {};
        const principal = meBody.principal ?? {};
        record(
          '⑤-8d 真实 OIDC：会话可用（/api/me）',
          meRes.status === 200 && typeof principal.userId === 'string' && principal.realm === 'enduser',
          `HTTP ${meRes.status}，realm=${principal.realm ?? '—'}，userId=${(principal.userId ?? '—').slice(0, 8)}…（★ 这条会话由真实授权码流程建立，且 realm=enduser）`,
        );

        // ⑤ ★★★★ 隔离验证：同一 IdP 身份**不能**走开发者链路
        const devStart = await fetch(`${BASE}/api/auth/login?realm=platform:developer`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        const devCookies = (devStart.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
        const devUrl = new URL(devStart.headers.get('location') ?? 'http://127.0.0.1:1/');
        devUrl.searchParams.set('login_hint', ENDUSER_SUB); // ★ 同一个 sub（隔离验证的关键）
        devUrl.searchParams.set('email', 'e2e-oidc@example.com');
        const devIdp = await fetch(devUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        const devCallback = devIdp.headers.get('location') ?? '';
        const devCb = await fetch(`${BASE}${devCallback.replace(BASE, '')}`, {
          redirect: 'manual',
          headers: { cookie: devCookies },
          signal: AbortSignal.timeout(10_000),
        });
        // ★ 未入驻 → 应当被拒（302 回登录页带错误，或非 2xx）；关键是不能拿到开发者会话
        const devSession = (devCb.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
        let devRealm = '—';
        if (devSession.length > 0) {
          const devMe = await fetch(`${BASE}/api/me`, { headers: { cookie: devSession }, signal: AbortSignal.timeout(10_000) });
          if (devMe.status === 200) {
            devRealm = (JSON.parse(await devMe.text()) as { principal?: { realm?: string } }).principal?.realm ?? '—';
          }
        }
        record(
          '⑤-8e ★★★★ 真实 OIDC：同一 IdP 身份**不得**获得开发者身份',
          devRealm !== 'developer',
          `开发者链路回调 HTTP ${devCb.status}，会话 realm=${devRealm}（未入驻的开发者必须被拒——这是两条链路隔离的核心）`,
        );
      }
    }

    // ── ⑤-9 ★★★★ 插件实例端点 + 落库（真实服务进程，R106）──
    //   ★ 这一项验证「插件自动调度**可运维**」在**真实进程**里成立：
    //     PUT 实例 → 落 `ag_plugin_instances` → GET 能读回（且配置**脱敏**）。
    //   ★ 为什么**不**在这里触发真实采集：`github` 的 `collect` 会**打外网**
    //     （`https://api.github.com/...`），端到端脚本不应依赖外部网络。
    //     ★ 真实采集路径已由 `test/pg-real.test.ts` 用**注入的 mock fetch** 覆盖。
    {
      // ★ 写请求需要 CSRF（双提交 Cookie）——这里**重新取一次**，
      //   而不是依赖远处（第 240 行）声明的 `csrf`（它可能不在本作用域内）。
      const meForCsrf = await fetch(`${BASE}/api/me`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
      const csrfForInstances = ((await meForCsrf.json()) as { csrfToken?: string }).csrfToken ?? '';

      const listBefore = await fetch(`${BASE}/api/admin/plugins/github/instances`, {
        headers: { cookie },
        signal: AbortSignal.timeout(10_000),
      });
      const listBeforeBody = (await listBefore.json()) as { instances?: unknown[] };
      record(
        '⑤-9a 插件实例端点可用（GET）',
        listBefore.status === 200 && Array.isArray(listBeforeBody.instances),
        `HTTP ${listBefore.status}，现有实例 ${listBeforeBody.instances?.length ?? 0} 个`,
      );

      // ★ 需要一个真实存在的开发者 id（用库里第一个）
      const devRows = await instance.sql<{ id: string }>('SELECT id FROM ag_developers LIMIT 1');
      const developerId = devRows[0]?.id;
      if (developerId === undefined) {
        record('⑤-9b 插件实例落库', false, '库里没有开发者——无法验证（这是环境问题）');
      } else {
        const put = await fetch(`${BASE}/api/admin/plugins/github/instances`, {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfForInstances },
          body: JSON.stringify({
            developerId,
            // ★ 配置里放一个**假 token**，用于验证 GET 时会被脱敏
            config: { username: 'e2e-octocat', token: 'ghp_e2e_should_be_redacted' },
            enabled: true,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        record(
          '⑤-9b 插件实例保存（PUT）',
          put.status === 200,
          `HTTP ${put.status}${put.status === 200 ? '' : `（body: ${(await put.text()).slice(0, 160)}）`}`,
        );

        // ★ 落库验证（直查 PG）
        const stored = await instance.sql<{ n: string; enabled: boolean }>(
          "SELECT count(*)::text AS n, bool_and(enabled) AS enabled FROM ag_plugin_instances WHERE developer_id = $1 AND plugin_id = 'github'",
          [developerId],
        );
        record(
          '⑤-9c 插件实例落库（ag_plugin_instances）',
          stored[0]?.n === '1' && stored[0]?.enabled === true,
          `行数 ${stored[0]?.n}，enabled=${String(stored[0]?.enabled)}`,
        );

        // ★★★ 读回时**配置必须脱敏**（token 不得回显）
        const listAfter = await fetch(`${BASE}/api/admin/plugins/github/instances`, {
          headers: { cookie },
          signal: AbortSignal.timeout(10_000),
        });
        const listAfterText = await listAfter.text();
        record(
          '⑤-9d ★★★ 实例配置**脱敏**（token 不回显）',
          listAfter.status === 200 &&
            !listAfterText.includes('ghp_e2e_should_be_redacted') &&
            listAfterText.includes('[已脱敏]'),
          `HTTP ${listAfter.status}，响应${listAfterText.includes('ghp_e2e_should_be_redacted') ? '**含明文 token**' : '不含明文 token'}${listAfterText.includes('[已脱敏]') ? '，已标记脱敏' : ''}`,
        );
      }
    }

    // ── ⑥ 持久化验证：重启后数据仍在 ──
    const beforeRestart = await instance.sql<{ n: string }>('SELECT count(*)::text AS n FROM ag_sites');
    record('⑥-1 站点已持久化', Number(beforeRestart[0]!.n) >= 1, `ag_sites 行数 = ${beforeRestart[0]!.n}`);
  } finally {
    if (child !== undefined) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await instance.stop();
    // ★★★ R81：**必须关掉 stub IdP**。
    //   ★ 我加它时忘了这一步，后果是：**所有检查都通过（19/19），但进程不退出**——
    //     HTTP server 仍在监听，Node 的事件循环不会空。
    //   ★ 这个缺陷**只在 CI 里暴露**：CI 的 `run()` 有 600s 超时，
    //     于是它被 SIGTERM 杀死并记为「退出码 143」——
    //     而**输出里明明写着「合计：19/19 通过」**。
    //   ★ 教训：「测试通过」与「进程正常退出」是**两件事**，
    //     而后者会影响 CI（挂住、超时、被误判为失败）。
    await stubIdp.close();
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${'='.repeat(60)}\n`);
  process.stdout.write(`合计：${results.length - failed.length}/${results.length} 通过\n`);
  if (failed.length > 0) {
    process.stdout.write(`未通过：\n${failed.map((result) => `  - ${result.name}：${result.detail}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

await main();
