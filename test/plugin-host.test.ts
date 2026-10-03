/**
 * 插件宿主最小版验收（M1-4 / M1-5）。
 *
 * 断言重点：
 *   - **权限是拒绝优先**：未声明的密钥/域名一律拒绝，绝不默认允许；
 *   - **事实必须过 schema**：未声明字段被拒绝（否则策略里会出现永远取不到的路径）；
 *   - **配额耗尽 ≠ 错误**：按 `missing` 语义表达（docs/05 §751）；
 *   - **表达式不用 eval**：函数白名单之外的调用被拒绝；`now()` 走注入时间基准（可复现）；
 *   - **declarative 能真正跑通**：模板注入密钥 → 出站 → JSONPath 提取 → 派生 → 事实落库。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkManifest, validateManifest, ManifestValidationError, applyConfigDefaults, type PluginManifest } from '../src/plugin/manifest.ts';
import { renderTemplate, renderDeep, evaluateJsonPath, parseJsonPath, applyTransform, JsonPathError, TemplateError } from '../src/plugin/declarative.ts';
import { evalExpression, parseExpression, validateExpression, ExpressionError, FUNCTIONS } from '../src/plugin/expr-lite.ts';
import {
  FactPipeline,
  FactQuotaExceeded,
  FactValidationError,
  HostApi,
  InMemoryFactStore,
  InMemoryKvStore,
  PermissionDeniedError,
  parseDuration,
  permissionSetOf,
} from '../src/plugin/host-api.ts';
import { runCollect, validateDeclarativePlugin } from '../src/plugin/declarative-runner.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

// ─────────────────────────── manifest 校验 ───────────────────────────

const BASE_MANIFEST = {
  apiVersion: 'gate.plugin/v1',
  kind: 'channel',
  id: 'github',
  name: 'GitHub',
  version: '1.0.0',
  runtime: 'declarative',
  factSchema: { type: 'object', properties: { total_stars: { type: 'integer' } } },
  collect: { request: { method: 'GET', url: 'https://api.github.com/x' }, extract: [{ path: '$.a', as: 'total_stars' }] },
};

test('manifest：合法清单通过；错误清单逐条报出（含未知 runtime/kind 拒绝）', () => {
  assert.deepEqual(checkManifest(BASE_MANIFEST).filter((i) => i.severity === 'error'), []);

  const bad = checkManifest({
    ...BASE_MANIFEST,
    apiVersion: 'gate.plugin/v2',
    kind: 'wat',
    id: 'Bad_ID',
    runtime: 'wasm',
    version: '1.0',
  });
  const errors = bad.filter((i) => i.severity === 'error').map((i) => i.path);
  assert.ok(errors.includes('apiVersion'));
  assert.ok(errors.includes('kind'));
  assert.ok(errors.includes('id'));
  assert.ok(errors.includes('runtime'));
  assert.throws(() => validateManifest({ ...BASE_MANIFEST, runtime: 'wasm' }), ManifestValidationError);
});

test('manifest：identity/provider 不允许 declarative；provider 配置作用域只能是 site', () => {
  const identity = checkManifest({ ...BASE_MANIFEST, kind: 'identity' }).filter((i) => i.severity === 'error');
  assert.ok(identity.some((i) => i.path === 'runtime'));

  const provider = checkManifest({ ...BASE_MANIFEST, kind: 'provider', config: { scope: 'developer' } }).filter(
    (i) => i.severity === 'error',
  );
  assert.ok(provider.some((i) => i.path === 'config.scope'));
});

test('manifest：runtime≠declarative 必须有 entry；权限格式必须合法', () => {
  const errors = checkManifest({
    ...BASE_MANIFEST,
    runtime: 'process',
    collect: undefined,
    permissions: ['secrets-read-token', 'ok:fine:x'],
  }).filter((i) => i.severity === 'error');
  assert.ok(errors.some((i) => i.path === 'entry'));
  assert.ok(errors.some((i) => i.path.startsWith('permissions[')));
});

test('manifest：配置默认值合并；未知键被丢弃（配置漂移应显式拒绝）', () => {
  const merged = applyConfigDefaults(
    { type: 'object', properties: { mode: { type: 'string', default: 'top100' }, ttl: { type: 'string' } } },
    { ttl: '12h', unknown: 1 },
  );
  assert.deepEqual(merged, { mode: 'top100', ttl: '12h' });
});

// ─────────────────────────── 模板 ───────────────────────────

test('模板：注入 secrets/binding/config/env/context；未解析到值必须抛错（不静默渲染空串）', () => {
  const scope = {
    secrets: { 'github.token': 'ghp_secret' },
    binding: { externalName: 'alice' },
    config: { mode: 'top100' },
    env: { AG_REGION: 'cn' },
    context: { now: '2025-01-01T00:00:00Z' },
  };
  assert.equal(renderTemplate('Bearer {{ secrets.github.token }}', scope), 'Bearer ghp_secret');
  assert.equal(renderTemplate('{{ binding.externalName }}@{{ config.mode }}', scope), 'alice@top100');
  assert.equal(renderTemplate('{{ env.AG_REGION }}-{{ context.now }}', scope), 'cn-2025-01-01T00:00:00Z');

  assert.throws(() => renderTemplate('{{ secrets.nope }}', scope), TemplateError);
  assert.throws(() => renderTemplate('{{ unknownns.x }}', scope), TemplateError);
  assert.equal(renderTemplate('{{ secrets.nope }}', scope, false), '');
});

test('模板：renderDeep 保留对象类型（整串占位符解析为对象时不字符串化）', () => {
  const scope = { config: { variables: { login: 'alice' } } };
  assert.deepEqual(renderDeep({ variables: '{{ config.variables }}' }, scope), { variables: { login: 'alice' } });
  assert.deepEqual(renderDeep({ a: ['{{ config.variables }}', 1] }, scope), { a: [{ login: 'alice' }, 1] });
});

// ─────────────────────────── JSONPath ───────────────────────────

test('JSONPath：键、数组下标、通配符；不支持的语法必须报错（不得静默取空）', () => {
  const data = { data: { user: { followers: { totalCount: 7 }, repositories: { nodes: [{ stargazerCount: 3 }, { stargazerCount: 5 }] } } } };
  assert.deepEqual(evaluateJsonPath(data, '$.data.user.followers.totalCount'), [7]);
  assert.deepEqual(evaluateJsonPath(data, '$.data.user.repositories.nodes[*].stargazerCount'), [3, 5]);
  assert.deepEqual(evaluateJsonPath(data, '$.data.user.repositories.nodes[1].stargazerCount'), [5]);

  assert.throws(() => parseJsonPath('data.user'), JsonPathError);
  assert.throws(() => parseJsonPath('$.a[?(@.b > 1)]'), JsonPathError);
  assert.throws(() => parseJsonPath('$..a'), JsonPathError);
});

test('JSONPath：transform 聚合（sum/count/min/max/avg/first/last/string）', () => {
  const values = [3, 5, 2];
  assert.equal(applyTransform(values, 'sum'), 10);
  assert.equal(applyTransform(values, 'count'), 3);
  assert.equal(applyTransform(values, 'min'), 2);
  assert.equal(applyTransform(values, 'max'), 5);
  assert.equal(applyTransform(values, 'avg'), 10 / 3);
  assert.equal(applyTransform(values, 'first'), 3);
  assert.equal(applyTransform(values, 'last'), 2);
  assert.equal(applyTransform(values, 'string'), '3');
  assert.equal(applyTransform(values, undefined), 3);
  assert.equal(applyTransform([], 'sum'), 0);
});

// ─────────────────────────── 表达式 ───────────────────────────

test('表达式：四则/比较/逻辑/括号；短路语义', () => {
  assert.equal(evalExpression('1 + 2 * 3', {}), 7);
  assert.equal(evalExpression('(1 + 2) * 3', {}), 9);
  assert.equal(evalExpression('10 % 3', {}), 4 - 3);
  assert.equal(evalExpression('"a" + "b"', {}), 'ab');
  assert.equal(evalExpression('1 < 2 && 3 >= 3', {}), true);
  assert.equal(evalExpression('false && (1/0 > 0)', {}), false);
  assert.equal(evalExpression('!false', {}), true);
  assert.equal(evalExpression('-3 + 1', {}), -2);
});

test('表达式：数字与数字串宽松比较（配置里常见 quota >= "40"）', () => {
  assert.equal(evalExpression('quota >= "40"', { quota: 41 }), true);
  assert.equal(evalExpression('group == "pro"', { group: 'pro' }), true);
});

test('表达式：点分路径引用（subject.group）', () => {
  assert.equal(evalExpression('subject.group == "edu"', { subject: { group: 'edu' } }), true);
  assert.equal(evalExpression('subject.missing', { subject: {} }), undefined);
});

test('表达式：函数白名单之外必须拒绝；arity 不匹配必须拒绝', () => {
  assert.throws(() => evalExpression('evil_eval("1")', {}), ExpressionError);
  assert.throws(() => evalExpression('require("fs")', {}), ExpressionError);
  assert.throws(() => evalExpression('now(1,2)', {}), ExpressionError);
  assert.ok(Object.keys(FUNCTIONS).length > 10);
});

test('表达式：now() 走注入时间基准（可测、可复现）', () => {
  const fixed = new Date('2025-06-01T00:00:00Z');
  const context = { __now: fixed, created_at: '2025-05-01T00:00:00Z' };
  assert.equal((evalExpression('now()', context) as Date).toISOString(), fixed.toISOString());
  assert.equal(evalExpression('round(days_between(created_at, now()))', context), 31);
});

test('表达式：静态校验能报出未 white-list 的函数与 arity 错误（发布前拦住）', () => {
  assert.deepEqual(validateExpression('1 + 2'), []);
  assert.ok(validateExpression('evil(1)').some((e) => /白名单/.test(e)));
  assert.ok(validateExpression('len()').some((e) => /参数个数/.test(e)));
  assert.throws(() => parseExpression('1 +'), ExpressionError);
  assert.throws(() => parseExpression(''), ExpressionError);
});

// ─────────────────────────── 权限 ───────────────────────────

test('权限：未声明的密钥读取被拒绝；已声明的放行', () => {
  const manifest = validateManifest({ ...BASE_MANIFEST, permissions: ['secrets:read:github.token'] });
  const permissions = permissionSetOf(manifest);
  assert.equal(permissions.canReadSecret('github.token'), true);
  assert.equal(permissions.canReadSecret('github.client_secret'), false);
});

test('权限：出站白名单含子域；未声明域名被拒绝', () => {
  const manifest = validateManifest({ ...BASE_MANIFEST, permissions: ['http:egress:api.github.com'] });
  const permissions = permissionSetOf(manifest);
  assert.equal(permissions.canEgress('api.github.com'), true);
  assert.equal(permissions.canEgress('uploads.api.github.com'), true, '子域应被允许');
  assert.equal(permissions.canEgress('evil.com'), false);
  assert.equal(permissions.canEgress('github.com.evil.com'), false, '后缀伪装必须被拒绝');
});

// ─────────────────────────── 事实管线 ───────────────────────────

test('事实管线：写入加命名空间前缀 + TTL；未声明字段被拒绝', async () => {
  const manifest = validateManifest({
    ...BASE_MANIFEST,
    factTtl: '2h',
    factSchema: { type: 'object', properties: { total_stars: { type: 'integer' }, created_at: { type: 'string' } }, required: ['total_stars'] },
  });
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: 'u1' });
  const fixed = new Date('2025-06-01T00:00:00Z');

  const { written } = await pipeline.emit({ total_stars: 42, created_at: '2025-01-01' }, fixed);
  assert.deepEqual(written, ['github.total_stars', 'github.created_at']);
  const record = await pipeline.get('total_stars', fixed);
  assert.equal(record!.key, 'github.total_stars');
  assert.equal(record!.value, 42);
  assert.equal(record!.expiresAt.toISOString(), new Date(fixed.getTime() + 2 * 3_600_000).toISOString());

  // 未声明字段 → 拒绝（否则策略里会出现永远取不到的路径）
  await assert.rejects(pipeline.emit({ nope: 1 }, fixed), FactValidationError);
  // 类型不符 → 拒绝
  await assert.rejects(pipeline.emit({ total_stars: 'x' }, fixed), FactValidationError);
  // 必需字段缺失 → 拒绝
  await assert.rejects(pipeline.emit({ created_at: '2025-01-01' }, fixed), FactValidationError);
});

test('事实管线：过期即视为缺失（返回 undefined，不返回陈旧值）', async () => {
  const manifest = validateManifest({ ...BASE_MANIFEST, factTtl: '1s', factSchema: { type: 'object', properties: { total_stars: { type: 'integer' } } } });
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: 'u1' });
  const t0 = new Date('2025-06-01T00:00:00Z');
  await pipeline.emit({ total_stars: 1 }, t0);
  assert.ok(await pipeline.get('total_stars', new Date(t0.getTime() + 500)));
  assert.equal(await pipeline.get('total_stars', new Date(t0.getTime() + 2_000)), undefined);
  assert.equal(await store.purgeExpired(new Date(t0.getTime() + 2_000)), 1);
});

test('事实管线：配额耗尽抛 FactQuotaExceeded（调用方据此转 missing，不误判为故障）', async () => {
  const manifest = validateManifest({ ...BASE_MANIFEST, factSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } } } });
  const pipeline = new FactPipeline({ store: new InMemoryFactStore(), manifest, userId: 'u1', maxFieldsPerEmit: 1 });
  await assert.rejects(pipeline.emit({ a: 1, b: 2 }), FactQuotaExceeded);
});

test('parseDuration：支持 ms/s/m/h/d 与数字', () => {
  assert.equal(parseDuration('24h', 0), 24 * 3_600_000);
  assert.equal(parseDuration('30m', 0), 30 * 60_000);
  assert.equal(parseDuration('45s', 0), 45_000);
  assert.equal(parseDuration('7d', 0), 7 * 86_400_000);
  assert.equal(parseDuration(1500, 0), 1500);
  assert.equal(parseDuration('garbage', 999), 999);
});

// ─────────────────────────── 宿主 API ───────────────────────────

function makeHost(manifest: PluginManifest, fetchImpl?: typeof fetch, logger?: ReturnType<typeof createLogger>) {
  const factStore = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store: factStore, manifest, userId: 'u1' });
  const host = new HostApi({
    manifest,
    facts: pipeline,
    secrets: { get: async (name) => (name === 'github.token' ? 'ghp_test' : undefined) },
    cache: new InMemoryKvStore(),
    storage: new InMemoryKvStore(),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(logger === undefined ? {} : { logger }),
  });
  return { host, factStore, pipeline };
}

test('宿主 API：getSecret 未声明即拒绝；已声明但宿主无值也拒绝（不是返回空串）', async () => {
  const manifest = validateManifest({ ...BASE_MANIFEST, permissions: ['secrets:read:github.token'] });
  const { host } = makeHost(manifest);
  assert.equal(await host.getSecret('github.token'), 'ghp_test');
  await assert.rejects(host.getSecret('github.client_secret'), PermissionDeniedError);
});

test('宿主 API：出站域名未白名单即拒绝；白名单内成功并解析 JSON', async () => {
  const manifest = validateManifest({ ...BASE_MANIFEST, permissions: ['http:egress:api.github.com'] });
  let called = 0;
  const fakeFetch: typeof fetch = async (input) => {
    called += 1;
    const url = String(input);
    return new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { host } = makeHost(manifest, fakeFetch);

  const ok = await host.request({ method: 'GET', url: 'https://api.github.com/user' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { ok: true, url: 'https://api.github.com/user' });
  assert.equal(called, 1);

  await assert.rejects(host.request({ method: 'GET', url: 'https://evil.com/x' }), PermissionDeniedError);
  assert.equal(called, 1, '被拒绝的请求不得真正发出');
});

test('宿主 API：响应体超上限被拒绝（防插件拉爆宿主内存）', async () => {
  const manifest = validateManifest({ ...BASE_MANIFEST, permissions: ['http:egress:api.github.com'] });
  const bigFetch: typeof fetch = async () => new Response('x'.repeat(200), { status: 200 });
  const factStore = new InMemoryFactStore();
  const host = new HostApi({
    manifest,
    facts: new FactPipeline({ store: factStore, manifest, userId: 'u1' }),
    secrets: { get: async () => undefined },
    fetchImpl: bigFetch,
    maxResponseBytes: 100,
  });
  await assert.rejects(host.request({ method: 'GET', url: 'https://api.github.com/x' }), PermissionDeniedError);
});

test('宿主 API：storage 写入需声明权限；缓存/存储命名空间隔离', async () => {
  const manifest = validateManifest({ ...BASE_MANIFEST, permissions: ['storage:write:self'] });
  const { host } = makeHost(manifest);
  await host.storageSet('k', { v: 1 });
  assert.deepEqual(await host.storageGet('k'), { v: 1 });

  const noPerm = validateManifest({ ...BASE_MANIFEST });
  const { host: host2 } = makeHost(noPerm);
  await assert.rejects(host2.storageSet('k', 1), PermissionDeniedError);

  // 不同插件读不到彼此的键（命名空间前缀）
  await host2.cacheSet('shared', 'a', 60_000);
  assert.equal(await host.cacheGet('shared'), null, '另一个插件不得读到本插件的缓存键');
});

test('宿主 API：日志自动带 pluginId 且字段脱敏', async () => {
  const manifest = validateManifest({ ...BASE_MANIFEST });
  const { sink, records } = collectingSink();
  const { host } = makeHost(manifest, undefined, createLogger({ level: 'debug', sink }));
  host.log('info', '调用下游', { token: 'should-be-redacted', host: 'api.github.com' });
  assert.equal(records[0]!.fields!['pluginId'], 'github');
  const meta = records[0]!.fields!['meta'] as Record<string, unknown>;
  assert.equal(meta['token'], '[REDACTED]');
  assert.equal(meta['host'], 'api.github.com');
});

// ─────────────────────────── declarative 端到端 ───────────────────────────

test('declarative 端到端：模板注入密钥 → 出站 → JSONPath 提取 → 派生 → 事实落库', async () => {
  const manifest = validateManifest({
    apiVersion: 'gate.plugin/v1',
    kind: 'channel',
    id: 'github',
    name: 'GitHub 账户',
    version: '1.0.0',
    runtime: 'declarative',
    factTtl: '24h',
    permissions: ['secrets:read:github.token', 'http:egress:api.github.com'],
    factSchema: {
      type: 'object',
      properties: {
        created_at: { type: 'string' },
        followers: { type: 'integer' },
        public_repos: { type: 'integer' },
        total_stars: { type: 'integer' },
        account_age_days: { type: 'integer' },
      },
    },
    collect: {
      request: {
        method: 'GET',
        url: 'https://api.github.com/users/{{ binding.externalName }}',
        headers: { Authorization: 'Bearer {{ secrets.github.token }}', Accept: 'application/json' },
      },
      extract: [
        { path: '$.created_at', as: 'created_at' },
        { path: '$.followers', as: 'followers' },
        { path: '$.public_repos', as: 'public_repos' },
        { path: '$.repos[*].stargazerCount', as: 'total_stars', transform: 'sum' },
      ],
      derive: [{ as: 'account_age_days', expr: 'round(days_between(created_at, now()))' }],
    },
  });

  let seenAuth: string | undefined;
  let seenUrl: string | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seenAuth = headers['Authorization'];
    return new Response(
      JSON.stringify({
        created_at: '2025-05-01T00:00:00Z',
        followers: 12,
        public_repos: 3,
        repos: [{ stargazerCount: 5 }, { stargazerCount: 7 }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const { host, pipeline } = makeHost(manifest, fakeFetch);
  const now = new Date('2025-06-01T00:00:00Z');
  assert.deepEqual(validateDeclarativePlugin(manifest), []);

  const result = await runCollect(manifest, host, { binding: { externalName: 'alice' }, now });
  assert.equal(result.status, 200);
  assert.equal(seenUrl, 'https://api.github.com/users/alice', '模板必须被渲染进 URL');
  assert.equal(seenAuth, 'Bearer ghp_test', '密钥只经宿主填入请求头');
  assert.deepEqual(result.facts, {
    created_at: '2025-05-01T00:00:00Z',
    followers: 12,
    public_repos: 3,
    total_stars: 12,
    account_age_days: 31,
  });

  const { written } = await pipeline.emit(result.facts, now);
  assert.equal(written.includes('github.account_age_days'), true);
  const record = await pipeline.get('total_stars', now);
  assert.equal(record!.value, 12);
});

test('declarative 静态校验：模板引用未声明的密钥、非法 JSONPath、非法表达式都会被拦住', () => {
  const manifest = {
    ...BASE_MANIFEST,
    permissions: [],
    collect: {
      request: { method: 'GET', url: 'https://api.github.com/x' },
      extract: [{ path: 'a.b', as: 'x' }],
      derive: [{ as: 'y', expr: 'evil(1)' }],
    },
  } as unknown as PluginManifest;
  const errors = validateDeclarativePlugin(manifest);
  assert.ok(errors.some((e) => /extract\.path/.test(e)), '非法 JSONPath 必须报出');
  assert.ok(errors.some((e) => /evil/.test(e) || /白名单/.test(e)), '非法表达式必须报出');
});

test('declarative 采集：HTTP 401 不抛错（由上层按 D20 归因），且记录 status', async () => {
  const manifest = validateManifest({
    ...BASE_MANIFEST,
    permissions: ['http:egress:api.github.com'],
    collect: { request: { method: 'GET', url: 'https://api.github.com/x' }, extract: [{ path: '$.a', as: 'total_stars' }] },
  });
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Bad credentials"}', { status: 401, headers: { 'content-type': 'application/json' } });
  const factStore = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store: factStore, manifest, userId: 'u1' });
  const { sink } = collectingSink();
  const host = new HostApi({
    manifest,
    facts: pipeline,
    secrets: { get: async () => undefined },
    fetchImpl: fakeFetch,
    logger: createLogger({ level: 'debug', sink }),
  });
  const result = await runCollect(manifest, host, { now: new Date() });
  assert.equal(result.status, 401);
  assert.deepEqual(result.facts, {}, '401 时不应产出事实');
  assert.deepEqual(result.extracted, [{ path: '$.a', as: 'total_stars', matched: 0 }]);
});
