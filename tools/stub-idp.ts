/**
 * 本地 **stub OIDC 提供方**——用于「真实服务进程 + 完整授权码流程」的验证。
 *
 * ★★★ 为什么需要它（R78 的发现）：
 *
 *   | 验证 | 覆盖的 | 没覆盖的 |
 *   |---|---|---|
 *   | `tools/serve-real-e2e.ts`（真实 PG + 真实进程） | 引导令牌登录 + 主线 | OIDC 授权码流程 |
 *   | `test/oidc-federation-e2e.test.ts` | 完整 OIDC 流程 | **真实服务进程与真实装配**（内存 handler） |
 *
 *   ★ 两个测试各自通过，而**交集**（「真实服务进程 + 完整 OIDC 流程」）从未被验证——
 *     而这正是目标第 (3) 项要求的东西。
 *
 * ★ 与 `createDemoIdp()` 的关键区别：**它真的签名，而真实模式真的验签**。
 *   `OidcClient` 会：
 *     ① 拉 `${issuer}/.well-known/openid-configuration`；
 *     ② 用 `jwks_uri` 取公钥并**验签** id_token（默认只允许非对称算法）；
 *     ③ 校验 `iss` / `aud` / `nonce` / `exp`。
 *   ★ 因此本 stub 必须**生成真实 RSA 密钥并用它签名**——
 *     这正是「真实授权码流程」与 demo 的差别。
 */

import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface StubIdp {
  /** issuer（`OidcConfig.issuer` 必须**精确等于**它） */
  issuer: string;
  /** 授权端点的完整 URL（e2e 用它模拟「用户被重定向到 IdP」） */
  authorizationEndpoint: string;
  /** 记录每个 code 对应的 claims（供 `/token` 返回） */
  issueCode: (input: { sub: string; email: string; emailVerified: boolean; nonce: string }) => string;
  close: () => Promise<void>;
}

/**
 * 启动一个 stub IdP。
 *
 * ★ `subjects`：允许的 `sub → claims` 映射（模拟 IdP 侧的用户目录）。
 * ★ 未在映射里的 sub 也能登录（stub 不模拟用户目录的准入）——
 *   因为我们验证的是**本平台**的准入逻辑（`platform:developer` 须入驻）。
 */
export async function startStubIdp(options: { clientId?: string } = {}): Promise<StubIdp> {
  const clientId = options.clientId ?? 'stub-client';
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'stub-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  // code → claims 的暂存（stub 侧；与「真实 IdP 发放授权码」等价）
  const codes = new Map<string, { sub: string; email: string; emailVerified: boolean; nonce: string }>();
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const send = (status: number, body: unknown, contentType = 'application/json'): void => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    // ① 发现文档
    if (url.pathname === '/.well-known/openid-configuration') {
      send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
      return;
    }

    // ② JWKS（真实客户端会用它验签）
    if (url.pathname === '/jwks') {
      send(200, { keys: [jwk] });
      return;
    }

    // ③ 授权端点：发放 code（并把 nonce 等记下来）
    if (url.pathname === '/authorize') {
      const state = url.searchParams.get('state') ?? '';
      const nonce = url.searchParams.get('nonce') ?? '';
      const sub = url.searchParams.get('login_hint') ?? 'stub-user-1';
      const email = url.searchParams.get('email') ?? `${sub}@stub.example`;
      const emailVerified = url.searchParams.get('email_verified') !== 'false';
      const code = `stub-code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { sub, email, emailVerified, nonce });
      // ★ 真实 IdP 会 302 回 redirect_uri；这里也 302（e2e 从中取 code 与 state）
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const location = `${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      res.writeHead(302, { location });
      res.end();
      return;
    }

    // ④ 令牌端点：用私钥**真实签名** id_token
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        void (async () => {
          const params = new URLSearchParams(raw);
          const code = params.get('code') ?? '';
          const record = codes.get(code);
          if (record === undefined) {
            send(400, { error: 'invalid_grant', error_description: '未知的 code' });
            return;
          }
          codes.delete(code); // 授权码一次性
          const now = Math.floor(Date.now() / 1000);
          const idToken = await new SignJWT({ email: record.email, email_verified: record.emailVerified, nonce: record.nonce })
            .setProtectedHeader({ alg: 'RS256', kid: 'stub-key-1' })
            .setIssuer(issuer)
            .setSubject(record.sub)
            .setAudience(clientId)
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .sign(privateKey);
          send(200, { access_token: 'stub-access', token_type: 'Bearer', expires_in: 300, id_token: idToken });
        })();
      });
      return;
    }

    send(404, { error: 'not_found', path: url.pathname });
  });

  // ★ 必须用 **`localhost`** 而不是 `127.0.0.1`：
  //   `assertProductionReady` 只接受 `https://` 或 `http://localhost`
  //   （本地开发豁免的写法就是字面量 localhost）。
  //   ★ 监听不绑定地址（双栈），否则 `localhost` 解析到 `::1` 时会连不上。
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  issuer = `http://localhost:${port}`;

  return {
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    issueCode: (input) => {
      const code = `stub-code-direct-${Math.random().toString(36).slice(2)}`;
      codes.set(code, input);
      return code;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
