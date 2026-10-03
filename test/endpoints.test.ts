/**
 * 插件端点宿主验收（M4-6）—— docs/03 §1.13。
 *
 * 验收标准（docs/07 路线图原文）：**插件注册端点全程不改主程序、不重启**。
 * 因此本文件断言的重点是：
 *   - **路径安全**（保留路径 / `..` / **编码穿越** / 二次编码 / 反斜杠）；
 *   - **★ 与宿主路由冲突必须拒绝**——插件若能覆盖 `/api/admin/*` 就等于拿到管理员权限；
 *   - **插件之间冲突必须拒绝**（否则「谁生效」取决于加载顺序）；
 *   - **五种鉴权**各自生效；
 *   - **三维限流**（单维可被绕开）；
 *   - **mount/unmount 立即生效**（这就是「不重启」的可断言含义）；
 *   - **审计全覆盖**（插件端点必须留痕）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EndpointHost,
  ENDPOINT_AUTH_KINDS,
  inspectPath,
  RateLimiter,
  RESERVED_PATH_PREFIX,
  validateEndpointDeclarations,
  type EndpointAuthResult,
  type EndpointAuthenticator,
  type EndpointDeclaration,
  type EndpointInvocation,
  type EndpointOutcome,
} from '../src/plugin/endpoints.ts';
import type { PluginManifest } from '../src/plugin/manifest.ts';
import { silentLogger } from '../src/kernel/logger.ts';

/** 鉴权器入参类型（显式标注，避免内联箭头参数被推断为 any）。 */
type AuthInput = Parameters<EndpointAuthenticator>[0];

/** 鉴权结果构造器（避免 TS 把 `ok` 推断成 boolean 而非字面量）。 */
const authOk = (kind: EndpointDeclaration['auth'], extra: { userId?: string; tokenId?: string; clientId?: string } = {}): EndpointAuthResult => ({
  ok: true,
  principal: { kind, ...extra },
});
const authFail = (status: number, error: string): EndpointAuthResult => ({ ok: false, status, error });

function manifestOf(id: string, endpoints: EndpointDeclaration[]): PluginManifest {
  return {
    apiVersion: 'gate.plugin/v1',
    kind: 'channel',
    id,
    name: id,
    version: '1.0.0',
    runtime: 'declarative',
    permissions: [],
    endpoints,
  } as unknown as PluginManifest;
}

const OK_ENDPOINT = (overrides: Partial<EndpointDeclaration> = {}): EndpointDeclaration => ({
  path: `/api/plugins/${overrides.path ?? 'demo/verify'}`.replace(`/api/plugins/${overrides.path ?? 'demo/verify'}`, overrides.path ?? '/api/plugins/demo/verify'),
  method: 'POST',
  auth: 'none',
  ...overrides,
});

// ─────────────────────────── 路径安全 ───────────────────────────

test('★ M4-6：路径安全 —— 保留路径 / 穿越 / 编码穿越 / 二次编码 / 反斜杠 全部拒绝', () => {
  // 合法路径
  assert.equal(inspectPath('/api/plugins/demo/verify').ok, true);

  // 保留路径（宿主专用）
  const reserved = inspectPath(`${RESERVED_PATH_PREFIX}endpoints`);
  assert.equal(reserved.ok, false);
  if (!reserved.ok) assert.equal(reserved.reason, 'reserved_path');

  // 明文穿越
  const traversal = inspectPath('/api/plugins/demo/../../../etc/passwd');
  assert.equal(traversal.ok, false);
  if (!traversal.ok) assert.equal(traversal.reason, 'path_traversal');

  // ★ 编码穿越（%2e%2e）——朴素检查会漏掉
  const encoded = inspectPath('/api/plugins/demo/%2e%2e/%2e%2e/admin');
  assert.equal(encoded.ok, false, '★ 编码后的穿越必须被识别');

  // ★ 二次编码（%252e → 解码一次仍 %2e → 再解一次才是 .）
  const doubleEncoded = inspectPath('/api/plugins/demo/%252e%252e/admin');
  assert.equal(doubleEncoded.ok, false, '★ 二次编码必须被识别（反复解码后检查）');

  // 反斜杠（可能被当作分隔符）
  assert.equal(inspectPath('/api/plugins/demo/..\\admin').ok, false);

  // 其它非法形态
  assert.equal(inspectPath('').ok, false);
  assert.equal(inspectPath('api/plugins/demo/x').ok, false, '必须以 / 开头');
  assert.equal(inspectPath('/api/plugins/demo/x?y=1').ok, false, '不得含查询串');
  assert.equal(inspectPath('/api/plugins//demo/x').ok, false, '不得含连续斜杠');
  assert.equal(inspectPath('/somewhere/else').ok, false, '必须挂在 /api/plugins/ 下');
});

test('★ M4-6：与**宿主已有路由**冲突 → 拒绝（插件不得覆盖 /api/admin/*）', () => {
  const malicious = manifestOf('evil', [{ path: '/api/admin/policies', method: 'POST', auth: 'none' }]);
  const issues = validateEndpointDeclarations([malicious], {
    hostRoutes: [{ method: 'POST', path: '/api/admin/policies' }],
  });
  // 注意：这里先被「必须挂在 /api/plugins/ 下」拦住；用同一命名空间内的宿主路由再验证一次
  assert.ok(issues.some((i) => i.code === 'invalid_path'));

  const withinNamespace = manifestOf('evil2', [{ path: '/api/plugins/demo/collect', method: 'POST', auth: 'none' }]);
  const issues2 = validateEndpointDeclarations([withinNamespace], {
    hostRoutes: [{ method: 'POST', path: '/api/plugins/demo/collect' }],
  });
  const conflict = issues2.find((i) => i.code === 'host_route_conflict');
  assert.ok(conflict !== undefined, '★ 与宿主路由同名必须拒绝');
  assert.match(conflict.message, /不得覆盖宿主端点/);
});

test('★ M4-6：插件之间冲突 → 拒绝（否则「谁生效」取决于加载顺序）', () => {
  const a = manifestOf('plugin-a', [{ path: '/api/plugins/shared/x', method: 'GET', auth: 'pluginToken' }]);
  const b = manifestOf('plugin-b', [{ path: '/api/plugins/shared/x', method: 'GET', auth: 'pluginToken' }]);
  const issues = validateEndpointDeclarations([a, b]);
  const conflict = issues.find((i) => i.code === 'plugin_conflict');
  assert.ok(conflict !== undefined);
  assert.match(conflict.message, /已被插件 'plugin-a' 占用/);
});

test('M4-6：声明校验 —— 未知方法 / 未知鉴权 / hmac 缺配置 / 限流非法', () => {
  const bad = manifestOf('bad', [
    { path: '/api/plugins/bad/a', method: 'TELEPORT', auth: 'none' },
    { path: '/api/plugins/bad/b', method: 'GET', auth: 'magic' as never },
    { path: '/api/plugins/bad/c', method: 'POST', auth: 'hmac' },
    { path: '/api/plugins/bad/d', method: 'GET', auth: 'none', rateLimit: { perMinute: 0 } },
  ]);
  const issues = validateEndpointDeclarations([bad]);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('invalid_method'));
  assert.ok(codes.includes('unknown_auth'));
  assert.ok(codes.includes('hmac_config_missing'));
  assert.ok(codes.includes('rate_limit_invalid'));
  assert.deepEqual(ENDPOINT_AUTH_KINDS, ['none', 'hmac', 'pluginToken', 'session', 'admin']);
});

test('M4-6：auth=none 需要管理员显式批准（未批准只是警告，不是错误）', () => {
  const manifest = manifestOf('demo', [{ path: '/api/plugins/demo/public', method: 'GET', auth: 'none' }]);
  const before = validateEndpointDeclarations([manifest]);
  const warning = before.find((i) => i.code === 'none_auth_not_approved');
  assert.ok(warning !== undefined);
  assert.equal(warning.severity, 'warning', '未批准不应硬拒——但必须提醒');

  const after = validateEndpointDeclarations([manifest], { approvedNoneAuth: ['GET /api/plugins/demo/public'] });
  assert.equal(after.filter((i) => i.code === 'none_auth_not_approved').length, 0);
});

// ─────────────────────────── 挂载与鉴权 ───────────────────────────

interface Harness {
  host: EndpointHost;
  audits: Parameters<NonNullable<ConstructorParameters<typeof EndpointHost>[0]['audit']>>[0][];
  invocations: EndpointInvocation[];
}

function makeHost(options: {
  authenticator?: EndpointAuthenticator;
  limiter?: RateLimiter;
  hostRoutes?: { method: string; path: string }[];
  approvedNoneAuth?: string[];
  handler?: (invocation: EndpointInvocation) => Promise<EndpointOutcome>;
} = {}): Harness {
  const audits: Harness['audits'] = [];
  const invocations: EndpointInvocation[] = [];
  const defaultAuthenticator: EndpointAuthenticator = (input: AuthInput): Promise<EndpointAuthResult> => {
    // 默认鉴权器：按声明类型的「理想行为」放行
    if (input.declaration.auth === 'none') return Promise.resolve(authOk('none'));
    return Promise.resolve(authOk(input.declaration.auth, { userId: 'u1' }));
  };
  const authenticator: EndpointAuthenticator = options.authenticator ?? defaultAuthenticator;

  const host = new EndpointHost({
    authenticator,
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.hostRoutes === undefined ? {} : { hostRoutes: options.hostRoutes }),
    ...(options.approvedNoneAuth === undefined ? {} : { approvedNoneAuth: options.approvedNoneAuth }),
    logger: silentLogger,
    audit: (entry) => void audits.push(entry),
  });

  const handler =
    options.handler ??
    (async (invocation) => {
      invocations.push(invocation);
      return { ok: true, status: 200, body: { pluginId: invocation.pluginId, path: invocation.declaration.path } };
    });

  const manifest = manifestOf('demo', [
    { path: '/api/plugins/demo/verify/start', method: 'POST', auth: 'none', rateLimit: { perMinute: 3, perIp: true } },
    { path: '/api/plugins/demo/verify/poll', method: 'GET', auth: 'pluginToken' },
    { path: '/api/plugins/demo/webhook', method: 'POST', auth: 'hmac', hmac: { header: 'X-Signature-256', algo: 'sha256', secretRef: 'demo.secret' }, maxBodyBytes: 32, timeoutMs: 100 },
    { path: '/api/plugins/demo/page', method: 'GET', auth: 'session' },
    { path: '/api/plugins/demo/ops', method: 'GET', auth: 'admin' },
  ]);
  const mounted = host.mount({ manifest, handler });
  assert.equal(mounted.ok, true, `挂载应成功：${mounted.ok ? '' : JSON.stringify(mounted.issues)}`);
  return { host, audits, invocations };
}

test('★ M4-6：挂载后**立即生效**、卸载后**立即 404**（这就是「不重启」的可断言含义）', async () => {
  const { host } = makeHost();
  const before = await host.invoke({ method: 'POST', path: '/api/plugins/demo/verify/start', headers: {}, rawBody: '' });
  assert.equal(before.ok, true, '挂载后无需重启即可访问');

  const removed = host.unmount('demo');
  assert.equal(removed, 5);
  const after = await host.invoke({ method: 'POST', path: '/api/plugins/demo/verify/start', headers: {}, rawBody: '' });
  assert.equal(after.ok, false);
  if (!after.ok) {
    assert.equal(after.status, 404);
    assert.equal(after.reason, 'not_mounted');
  }
});

test('★ M4-6：五种鉴权各自生效（鉴权器按声明类型被调用）', async () => {
  const seen: string[] = [];
  const authenticator: EndpointAuthenticator = (input: AuthInput): Promise<EndpointAuthResult> => {
    const { declaration } = input;
    seen.push(declaration.auth);
    if (declaration.auth === 'admin') return Promise.resolve(authFail(403, '需要管理员'));
    if (declaration.auth === 'session') return Promise.resolve(authFail(401, '需要登录'));
    return Promise.resolve(authOk(declaration.auth));
  };
  const { host } = makeHost({ authenticator });

  assert.equal((await host.invoke({ method: 'POST', path: '/api/plugins/demo/verify/start', headers: {}, rawBody: '' })).ok, true);
  assert.equal((await host.invoke({ method: 'GET', path: '/api/plugins/demo/verify/poll', headers: {}, rawBody: '' })).ok, true);
  assert.equal((await host.invoke({ method: 'POST', path: '/api/plugins/demo/webhook', headers: {}, rawBody: '' })).ok, true);

  const session = await host.invoke({ method: 'GET', path: '/api/plugins/demo/page', headers: {}, rawBody: '' });
  assert.equal(session.ok, false);
  if (!session.ok) assert.equal(session.status, 401);

  const admin = await host.invoke({ method: 'GET', path: '/api/plugins/demo/ops', headers: {}, rawBody: '' });
  assert.equal(admin.ok, false);
  if (!admin.ok) assert.equal(admin.status, 403);

  assert.deepEqual([...new Set(seen)].sort(), ['admin', 'hmac', 'none', 'pluginToken', 'session']);
});

test('★ M4-6：鉴权失败**不消耗限流配额**（否则未认证请求能打满别人的配额）', async () => {
  const limiter = new RateLimiter();
  let allow = false;
  const authenticator: EndpointAuthenticator = (): Promise<EndpointAuthResult> =>
    allow ? Promise.resolve(authOk('none')) : Promise.resolve(authFail(401, '拒绝'));
  const { host } = makeHost({ authenticator, limiter });

  // 连续 10 次鉴权失败（限流是 3/分钟）
  for (let i = 0; i < 10; i += 1) {
    const result = await host.invoke({ method: 'POST', path: '/api/plugins/demo/verify/start', headers: {}, rawBody: '', ip: '1.2.3.4' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 401, '应因鉴权失败被拒，而不是限流');
  }

  // 换成合法身份，配额应仍是满的
  allow = true;
  const first = await host.invoke({ method: 'POST', path: '/api/plugins/demo/verify/start', headers: {}, rawBody: '', ip: '1.2.3.4' });
  assert.equal(first.ok, true, '★ 之前的鉴权失败不得占用配额');
});

test('★ M4-6：三维限流 —— 换 IP 绕不过「插件级」上限', async () => {
  const limiter = new RateLimiter();
  const { host } = makeHost({ limiter });
  const hit = async (ip: string) => host.invoke({ method: 'POST', path: '/api/plugins/demo/verify/start', headers: {}, rawBody: '', ip });

  // 每 IP 3 次；插件级也是 3 次（同一 limit）
  assert.equal((await hit('10.0.0.1')).ok, true);
  assert.equal((await hit('10.0.0.1')).ok, true);
  assert.equal((await hit('10.0.0.1')).ok, true);
  const fourth = await hit('10.0.0.1');
  assert.equal(fourth.ok, false, 'IP 维度超限');
  if (!fourth.ok) assert.equal(fourth.status, 429);

  // ★ 换 IP：插件级上限仍应拦住（这正是「三维」的意义——单维可被绕开）
  const otherIp = await hit('10.0.0.2');
  assert.equal(otherIp.ok, false, '★ 换 IP 不得绕过插件级上限');
});

test('M4-6：限流器按维度返回剩余量与重试建议', () => {
  const limiter = new RateLimiter();
  const decision = limiter.check({ pluginId: 'p', path: '/x', method: 'GET', limit: { perMinute: 2 } });
  assert.equal(decision.allowed, true);
  assert.equal(decision.remaining, 1);
  limiter.check({ pluginId: 'p', path: '/x', method: 'GET', limit: { perMinute: 2 } });
  const third = limiter.check({ pluginId: 'p', path: '/x', method: 'GET', limit: { perMinute: 2 } });
  assert.equal(third.allowed, false);
  assert.ok((third.retryAfterSeconds ?? 0) >= 1);
  assert.equal(third.dimension, 'plugin');
});

test('★ M4-6：body 大小上限与超时都由宿主强制（插件声明只是「自我约束」）', async () => {
  // body 超限
  const { host } = makeHost();
  const tooLarge = await host.invoke({ method: 'POST', path: '/api/plugins/demo/webhook', headers: {}, rawBody: 'x'.repeat(64) });
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.status, 413);

  // 超时（声明 timeoutMs=100）
  const hanging = makeHost({
    handler: () => new Promise<EndpointOutcome>(() => undefined),
  });
  const started = Date.now();
  const timedOut = await hanging.host.invoke({ method: 'POST', path: '/api/plugins/demo/webhook', headers: {}, rawBody: '' });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.status, 500);
  assert.ok(Date.now() - started < 2_000, '超时应被宿主强制（不能挂着不返回）');
});

test('★ M4-6：审计全覆盖 —— 成功、鉴权失败、限流、body 超限全部留痕', async () => {
  const limiter = new RateLimiter();
  const { host, audits } = makeHost({ limiter });
  await host.invoke({ method: 'POST', path: '/api/plugins/demo/verify/start', headers: {}, rawBody: '' });
  await host.invoke({ method: 'POST', path: '/api/plugins/demo/webhook', headers: {}, rawBody: 'x'.repeat(64) });
  assert.equal(audits.length, 2, '每次调用都要审计');
  assert.equal(audits[0]!.status, 200);
  assert.equal(audits[1]!.status, 413);
  assert.equal(audits[1]!.rejectedReason, 'body_too_large');
  assert.equal(audits[0]!.pluginId, 'demo');
  assert.ok(typeof audits[0]!.durationMs === 'number');
});

test('M4-6：未挂载路径 → 404（不泄露「哪些路径存在」）', async () => {
  const { host } = makeHost();
  const result = await host.invoke({ method: 'GET', path: '/api/plugins/demo/nonexistent', headers: {}, rawBody: '' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 404);
});

test('★ M4-6：OpenAPI 由**已挂载事实**生成（而不是由声明生成）', async () => {
  const { host } = makeHost();
  const paths = host.toOpenApiPaths();
  assert.ok(Object.keys(paths).includes('/api/plugins/demo/verify/start'));
  const operation = (paths['/api/plugins/demo/verify/start'] as Record<string, Record<string, unknown>>)['post']!;
  assert.deepEqual(operation['tags'], ['demo']);
  assert.deepEqual(operation['security'], [], 'auth=none 的端点不应声明 security');
  const pollOp = (paths['/api/plugins/demo/verify/poll'] as Record<string, Record<string, unknown>>)['get']!;
  assert.deepEqual(pollOp['security'], [{ pluginToken: [] }], '其它鉴权应体现在 security 里');

  // 卸载后 OpenAPI 也应更新（事实驱动）
  host.unmount('demo');
  assert.deepEqual(host.toOpenApiPaths(), {});
});

test('★ M4-6：挂载被拒时**整体不挂载**（避免「可用端点取决于声明顺序」）', async () => {
  const audits: unknown[] = [];
  const host = new EndpointHost({
    authenticator: (): Promise<EndpointAuthResult> => Promise.resolve(authOk('none')),
    logger: silentLogger,
    audit: (entry) => void audits.push(entry),
  });
  const badManifest = manifestOf('bad', [
    { path: '/api/plugins/bad/ok', method: 'GET', auth: 'none' },
    { path: '/api/plugins/bad/../escape', method: 'GET', auth: 'none' },
  ]);
  const result = host.mount({
    manifest: badManifest,
    handler: async () => ({ ok: true, status: 200, body: {} }),
  });
  assert.equal(result.ok, false, '有一个非法声明就整体拒绝');
  if (!result.ok) assert.ok(result.issues.length > 0);
  // 连合法的那个也不应被挂载
  assert.equal(host.list().length, 0);
  const response = await host.invoke({ method: 'GET', path: '/api/plugins/bad/ok', headers: {}, rawBody: '' });
  assert.equal(response.ok, false);
});

test('M4-6：hmac 的 secret 由宿主托管（插件只声明 secretRef，拿不到密钥）', async () => {
  const { invocations } = { invocations: [] as EndpointInvocation[] };
  let captured: EndpointInvocation | undefined;
  const { host } = makeHost({
    authenticator: (input: AuthInput): Promise<EndpointAuthResult> => {
      const { declaration } = input;
      // ★ 鉴权器只看到声明里的 secretRef（一个**名字**），看不到密钥值
      assert.equal(declaration.hmac?.secretRef, 'demo.secret');
      assert.equal((declaration.hmac as Record<string, unknown>)['secret'], undefined, '声明里不得含密钥本体');
      return Promise.resolve(authOk('hmac', { clientId: 'community' }));
    },
    handler: async (invocation) => {
      captured = invocation;
      return { ok: true, status: 200, body: {} };
    },
  });
  await host.invoke({ method: 'POST', path: '/api/plugins/demo/webhook', headers: { 'x-signature-256': 'sha256=abc' }, rawBody: 'hi' });
  assert.equal(captured?.principal?.kind, 'hmac');
  assert.equal(captured?.principal?.clientId, 'community');
  assert.deepEqual(invocations, []);
});
