/**
 * 内置插件 `newapi-provider` 验收（M1-3）—— 第一个真实 provider。
 *
 * 断言重点（都是 docs/09 §2 的实测结论，漏掉任何一条都会造成真实故障）：
 *   - **不伪造能力**：下游不支持按 `oidc_id` 检索 → `findByIdentity: false`，`findSubject` 返回 null；
 *   - **分页必须 `sort_by=id&sort_order=asc`**：降级增量路径依赖「首页按主键序」才能「遇已知 id 即停」；
 *   - **raw 必须脱敏**：`access_token` / `password` 绝不能进 `ag_external_subjects.raw`；
 *   - **写回绝不能带 `password`**：带了会不可逆地损坏用户凭据；
 *   - **能力探测必须真实调用**（不返回常量）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createNewApiProvider,
  IDENTITY_KEYS,
  NEWAPI_PROVIDER_MANIFEST,
  NewApiProviderError,
  redactUser,
  SUBJECT_SCHEMA,
  toExternalSubject,
  WATCH_FIELDS,
  writeBackAttributes,
  type NewApiProviderConfig,
  type ProviderTransport,
} from '../src/plugin/builtin/newapi-provider.ts';
import { checkManifest, validateManifest } from '../src/plugin/manifest.ts';
import { subjectFingerprint, watchedFields } from '../src/plugin/provider.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemorySyncStateStore, Reconciler } from '../src/core/reconciler.ts';
import { EventBus } from '../src/kernel/events.ts';

// ─────────────────────────── 测试替身 ───────────────────────────

interface Recorded {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function fakeTransport(
  handler: (request: Recorded) => { status: number; data: unknown },
): { transport: ProviderTransport; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    transport: {
      async request(request) {
        const recorded: Recorded = {
          method: request.method,
          url: request.url,
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          ...(request.body === undefined ? {} : { body: request.body }),
        };
        calls.push(recorded);
        const result = handler(recorded);
        return { status: result.status, data: result.data, text: JSON.stringify(result.data) };
      },
    },
  };
}

const CONFIG: NewApiProviderConfig = { baseUrl: 'https://gate.example.com/', pageSize: 2, pageDelayMs: 0 };

function rawUser(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    username: `user${id}`,
    display_name: `User ${id}`,
    email: `user${id}@example.com`,
    group: 'default',
    status: 1,
    role: 1,
    quota: 1000,
    used_quota: 100,
    request_count: 5,
    aff_code: `aff${id}`,
    oidc_id: `oidc-${id}`,
    ...overrides,
  };
}

function makeProvider(users: readonly Record<string, unknown>[], config = CONFIG) {
  const { transport, calls } = fakeTransport((request) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/user/') {
      const page = Number(url.searchParams.get('p') ?? '1');
      const size = Number(url.searchParams.get('page_size') ?? '100');
      const slice = users.slice((page - 1) * size, (page - 1) * size + size);
      return { status: 200, data: { success: true, data: slice, total: users.length } };
    }
    const match = /^\/api\/user\/(\d+)$/.exec(url.pathname);
    if (match !== null) {
      const found = users.find((u) => String(u['id']) === match[1]);
      return found === undefined ? { status: 404, data: { success: false } } : { status: 200, data: { success: true, data: found } };
    }
    return { status: 404, data: { success: false } };
  });
  const provider = createNewApiProvider({ transport, pat: 'pat-secret', config });
  return { provider, calls };
}

// ─────────────────────────── manifest ───────────────────────────

test('manifest：newapi-provider 通过契约校验，且配置作用域是 site（provider 只允许 site）', () => {
  const issues = checkManifest(NEWAPI_PROVIDER_MANIFEST);
  assert.deepEqual(issues.filter((i) => i.severity === 'error'), []);
  const manifest = validateManifest(NEWAPI_PROVIDER_MANIFEST);
  assert.equal(manifest.kind, 'provider');
  assert.equal(manifest.config?.scope, 'site');
  assert.equal(manifest.runtime, 'process');
  assert.ok(manifest.entry !== undefined);
});

test('manifest：watch 字段的**唯一来源**是 WATCH_FIELDS（schema 里不重复抄一份）', () => {
  const schema = NEWAPI_PROVIDER_MANIFEST.subjectSchema;
  const watched = Object.entries(schema.properties)
    .filter(([, property]) => (property as { watch?: boolean }).watch === true)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(watched, [...WATCH_FIELDS].sort());
  // 与对账器用的 watchedFields() 口径一致
  assert.deepEqual(watchedFields(schema as never), [...WATCH_FIELDS].sort());
});

test('manifest：能力声明诚实——findByIdentity=false、cursor=false（下游不支持）', () => {
  assert.equal(NEWAPI_PROVIDER_MANIFEST.provider.capabilities.findByIdentity, false);
  assert.equal(NEWAPI_PROVIDER_MANIFEST.provider.capabilities.cursor, false);
  assert.deepEqual(
    NEWAPI_PROVIDER_MANIFEST.provider.identityKeys.map((k) => k.key),
    ['oidc_id', 'email'],
  );
  assert.deepEqual(IDENTITY_KEYS.map((k) => k.unique), [true, true]);
});

// ─────────────────────────── 脱敏与映射 ───────────────────────────

test('★ redactUser：access_token / password 绝不允许进入 raw（落库就晚了，日志脱敏救不了）', () => {
  const redacted = redactUser(rawUser(1, { access_token: 'sk-live-123', password: 'hunter2' }) as never);
  assert.equal(redacted['access_token'], '[REDACTED]');
  assert.equal(redacted['password'], '[REDACTED]');
  assert.equal(redacted['username'], 'user1');
});

test('toExternalSubject：属性袋覆盖文档列出的全部字段；id 缺失必须报错', () => {
  const subject = toExternalSubject(rawUser(42) as never);
  assert.equal(subject.externalId, '42');
  assert.equal(subject.displayName, 'User 42');
  assert.equal(subject.email, 'user42@example.com');
  for (const field of ['username', 'display_name', 'email', 'group', 'status', 'role', 'quota', 'used_quota', 'request_count', 'aff_code', 'oidc_id']) {
    assert.ok(field in subject.attributes, `属性袋应包含 ${field}`);
  }
  assert.equal((subject.raw as Record<string, unknown>)['password'], undefined);
  assert.throws(() => toExternalSubject({ username: 'x' } as never), NewApiProviderError);
});

test('指纹只由 watch 字段决定：quota/used_quota/request_count 变化不改变指纹', () => {
  const watch = watchedFields(SUBJECT_SCHEMA as never);
  const base = toExternalSubject(rawUser(1) as never);
  const noisy = toExternalSubject(rawUser(1, { quota: 99999, used_quota: 88888, request_count: 777 }) as never);
  assert.equal(subjectFingerprint('newapi-provider', base, watch), subjectFingerprint('newapi-provider', noisy, watch));

  const realChange = toExternalSubject(rawUser(1, { group: 'vip2' }) as never);
  assert.notEqual(subjectFingerprint('newapi-provider', base, watch), subjectFingerprint('newapi-provider', realChange, watch));
});

// ─────────────────────────── listSubjects ───────────────────────────

test('★ listSubjects：分页必须带 sort_by=id&sort_order=asc（降级增量路径依赖它）', async () => {
  const { provider, calls } = makeProvider([rawUser(1), rawUser(2), rawUser(3)]);
  await provider.listSubjects(null, 2);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('sort_by'), 'id');
  assert.equal(url.searchParams.get('sort_order'), 'asc');
  assert.equal(url.searchParams.get('page_size'), '2');
  assert.equal(calls[0]!.headers!['Authorization'], 'Bearer pat-secret');
});

test('listSubjects：分页游标就是页码；翻到底返回 nextCursor=null', async () => {
  const { provider } = makeProvider([rawUser(1), rawUser(2), rawUser(3)]);
  const first = await provider.listSubjects(null, 2);
  assert.deepEqual(first.subjects.map((s) => s.externalId), ['1', '2']);
  assert.equal(first.nextCursor, '2');

  const second = await provider.listSubjects('2', 2);
  assert.deepEqual(second.subjects.map((s) => s.externalId), ['3']);
  assert.equal(second.nextCursor, null);
});

test('listSubjects：page_size 被下游上限截断为 100；非法游标必须报错（不静默当成第 1 页）', async () => {
  const { provider, calls } = makeProvider([rawUser(1)], { ...CONFIG, pageSize: 500 });
  await provider.listSubjects(null, 500);
  assert.equal(new URL(calls[0]!.url).searchParams.get('page_size'), '100');

  await assert.rejects(provider.listSubjects('abc', 10), NewApiProviderError);
  await assert.rejects(provider.listSubjects('-1', 10), NewApiProviderError);
});

test('listSubjects：下游 success=false 必须抛错（不返回空页掩盖故障）', async () => {
  const { transport } = fakeTransport(() => ({ status: 200, data: { success: false, message: 'token 过期' } }));
  const provider = createNewApiProvider({ transport, pat: 'x', config: CONFIG });
  await assert.rejects(provider.listSubjects(null, 10), /token 过期/);
});

test('listSubjects：401 必须抛错并提示 PAT 问题（不静默返回空目录）', async () => {
  const { transport } = fakeTransport(() => ({ status: 401, data: { success: false } }));
  const provider = createNewApiProvider({ transport, pat: 'bad', config: CONFIG });
  await assert.rejects(provider.listSubjects(null, 10), (error: unknown) => {
    assert.ok(error instanceof NewApiProviderError);
    assert.equal(error.status, 401);
    assert.match(error.message, /PAT/);
    return true;
  });
});

// ─────────────────────────── getSubject / findSubject ───────────────────────────

test('getSubject：命中返回主体；404 返回 null（不抛错）', async () => {
  const { provider } = makeProvider([rawUser(7)]);
  const hit = await provider.getSubject('7');
  assert.equal(hit!.externalId, '7');
  assert.equal(await provider.getSubject('999'), null);
});

test('★ findSubject：诚实的空实现——下游不支持按 oidc_id 检索，返回 null 而非伪造结果', async () => {
  const { provider, calls } = makeProvider([rawUser(7)]);
  const result = await provider.findSubject!({ key: 'oidc_id', value: 'oidc-7' });
  assert.equal(result, null);
  assert.equal(calls.length, 0, '不得为了「看起来能查」而发请求');
  assert.equal(provider.capabilities.findByIdentity, false, '能力声明必须与真实行为一致');
});

// ─────────────────────────── 能力探测 ───────────────────────────

test('★ probeCapabilities：真实调用一次并返回实测结果（不是返回常量）', async () => {
  const { provider, calls } = makeProvider([rawUser(1)]);
  const actual = await provider.probeCapabilities();
  assert.equal(calls.length, 1, '探测必须真实调用');
  assert.equal(actual.list, true);
  assert.equal(actual.cursor, true);
});

test('probeCapabilities：下游不可用时 list=false（不抛错，由宿主比对告警）', async () => {
  const { transport } = fakeTransport(() => ({ status: 500, data: {} }));
  const provider = createNewApiProvider({ transport, pat: 'x', config: CONFIG });
  const actual = await provider.probeCapabilities();
  assert.equal(actual.list, false);
});

// ─────────────────────────── 写回 ───────────────────────────

test('★ writeBackAttributes：必须先 GET 再 PUT，且**绝不能带 password**（不可逆损坏）', async () => {
  const { transport, calls } = fakeTransport((request) => {
    if (request.method === 'GET') return { status: 200, data: { data: rawUser(9, { password: 'hunter2', access_token: 'sk-x' }) } };
    return { status: 200, data: { success: true } };
  });
  await writeBackAttributes({ transport, pat: 'pat', config: CONFIG }, '9', { group: 'vip2' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.method, 'GET', '必须先读取当前值');
  assert.equal(calls[1]!.method, 'PUT');

  const body = calls[1]!.body as Record<string, unknown>;
  assert.equal(body['group'], 'vip2');
  assert.equal(body['password'], undefined, '带 password 会不可逆地损坏用户凭据');
  assert.equal(body['access_token'], undefined);
  // 回填必需字段，否则下游整体替换会清空它们
  assert.equal(body['username'], 'user9');
  assert.equal(body['display_name'], 'User 9');
  assert.ok('remark' in body);
});

test('writeBackAttributes：读取失败必须抛错（不得在没读到当前值时盲写）', async () => {
  const { transport } = fakeTransport(() => ({ status: 500, data: {} }));
  await assert.rejects(writeBackAttributes({ transport, pat: 'p', config: CONFIG }, '9', { group: 'x' }), /写回前读取失败/);
});

// ─────────────────────────── 与对账器集成 ───────────────────────────

test('★ 与通用对账器集成：真实 provider 走「降级增量」路径（cursor=false）', async () => {
  const users = [rawUser(3), rawUser(2), rawUser(1)];
  const { provider } = makeProvider(users);
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  const bus = new EventBus();
  const events: string[] = [];
  bus.on('subject.*', (event) => void events.push(`${event.type}:${(event.payload as { externalId: string }).externalId}`));

  const reconciler = new Reconciler({ provider, subjects: store, state, bus, pageSize: 2 });

  // 首次必须走全量
  const first = await reconciler.reconcile();
  assert.equal(first.mode, 'full');
  assert.equal(first.created, 3);
  assert.equal(await store.count('newapi-provider'), 3);

  // 下游新增 id=4（排在最前，因为下游按 id 升序……这里模拟「降级路径遇已知 id 即停」）
  const { provider: provider2 } = makeProvider([rawUser(4), rawUser(3), rawUser(2), rawUser(1)]);
  const reconciler2 = new Reconciler({ provider: provider2, subjects: store, state, bus, pageSize: 2 });
  const incremental = await reconciler2.reconcileIncremental();
  assert.equal(incremental.mode, 'incremental-degraded');
  assert.equal(incremental.created, 1, '应发现新增的 id=4');
  assert.equal(await store.count('newapi-provider'), 4);

  // 分组变化触发 attributes_changed
  events.length = 0;
  const { provider: provider3 } = makeProvider([rawUser(1, { group: 'vip2' }), rawUser(2), rawUser(3), rawUser(4)]);
  const reconciler3 = new Reconciler({ provider: provider3, subjects: store, state, bus, pageSize: 4 });
  const changed = await reconciler3.reconcileFull();
  assert.equal(changed.changed, 1);
  assert.deepEqual(events, ['subject.attributes_changed:1']);
});
