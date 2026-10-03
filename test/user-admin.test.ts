/**
 * 用户管理端点验收（P0；docs/06 `/admin/users` 系列）。
 *
 * ★ 这些端点服务于**排障与客服**：没有它们，运维只能直接连数据库查用户。
 *   因此断言的重点是「能不能查到该查的」与「能不能安全地改状态」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemoryUserAdminStore, type PlatformUserRecord } from '../src/admin/user-store.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ADMIN_SESSION = { userId: 'admin-1', username: 'admin', activeSiteId: 'site-1', realm: 'developer' as const, role: 'admin' as const };

const user = (overrides: Partial<PlatformUserRecord>): PlatformUserRecord => ({
  id: '11111111-1111-7111-a111-111111111111',
  email: 'alice@example.com',
  emailVerified: true,
  username: 'alice',
  status: 'active',
  source: 'oidc',
  locale: 'zh-CN',
  tags: [],
  lastLoginAt: null,
  createdAt: new Date('2025-06-01T00:00:00Z'),
  updatedAt: new Date('2025-06-01T00:00:00Z'),
  ...overrides,
});

function makeHandler() {
  const users = new InMemoryUserAdminStore();
  users.seed(user({ id: '11111111-1111-7111-a111-111111111111', email: 'alice@example.com', username: 'alice', status: 'active' }), [
    { id: 'id-1', provider: 'identity:oidc@platform:enduser', providerUserId: 'sub-1', verifiedAt: new Date('2025-06-01T00:00:00Z'), createdAt: new Date('2025-06-01T00:00:00Z') },
  ]);
  users.seed(user({ id: '22222222-2222-7222-a222-222222222222', email: 'bob@corp.com', username: 'bob', status: 'suspended' }), []);
  users.seed(user({ id: '33333333-3333-7333-a333-333333333333', email: 'carol@example.com', username: 'carol', status: 'pending' }), []);
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    users,
    logger: silentLogger,
  });
  return { handler, users };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], method: string, path: string, body?: unknown, query?: Record<string, string>) =>
  handler({ method, path, query, body, session: ADMIN_SESSION } as never);

// ─────────────────────────── 列表 ───────────────────────────

test('★★ `GET /admin/users` 列表：`total` 是「至少这么多」+ `hasMore`（**不做 count**）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'GET', '/api/admin/users')) as {
    status: number;
    body: { users: { id: string }[]; total: number; hasMore: boolean; totalIsExact: boolean };
  };
  assert.equal(response.status, 200);
  assert.equal(response.body.users.length, 3);
  // ★★ 语义已明确改变：精确计数需要 count(*)，而 CI 的两项检查都拒绝拼接式 SQL
  //    （见 user-store.ts 的说明）。因此 total **不是精确总数**，并显式标注。
  assert.equal(response.body.totalIsExact, false, '★ 必须显式声明 total 不精确，而不是让调用方以为它是总数');
  assert.equal(response.body.total, 3, '3 条都在一页 → total == 页长度');
  assert.equal(response.body.hasMore, false, '只有 3 条且都在本页 → 无下一页');
});

test('★★ 分页：`hasMore` 用「多取一条」判断（不依赖 count）', async () => {
  const { handler } = makeHandler();
  // limit=2 → 实际取 3 条（多一条），因此 hasMore 应为 true
  const firstPage = (await call(handler, 'GET', '/api/admin/users', undefined, { limit: '2' })) as {
    body: { users: unknown[]; total: number; hasMore: boolean };
  };
  assert.equal(firstPage.body.users.length, 2, '★ 返回给调用方的仍是 limit 条');
  assert.equal(firstPage.body.hasMore, true, '★ 还有第 3 条 → hasMore');

  // 取最后一页
  const secondPage = (await call(handler, 'GET', '/api/admin/users', undefined, { limit: '2', offset: '2' })) as {
    body: { users: unknown[]; hasMore: boolean };
  };
  assert.equal(secondPage.body.users.length, 1);
  assert.equal(secondPage.body.hasMore, false, '最后一页 → 无更多');
});

test('★ 支持 `status` 过滤与 `search` 模糊匹配（大小写不敏感）', async () => {
  const { handler } = makeHandler();
  const active = (await call(handler, 'GET', '/api/admin/users', undefined, { status: 'active' })) as { body: { users: { id: string }[]; total: number } };
  assert.equal(active.body.users.length, 1);
  assert.equal(active.body.users[0]!.id, '11111111-1111-7111-a111-111111111111');

  const search = (await call(handler, 'GET', '/api/admin/users', undefined, { search: 'CORP' })) as { body: { users: { id: string }[]; total: number } };
  assert.equal(search.body.users.length, 1, '★ 搜索应大小写不敏感');
  assert.equal(search.body.users[0]!.id, '22222222-2222-7222-a222-222222222222');

  const byUsername = (await call(handler, 'GET', '/api/admin/users', undefined, { search: 'car' })) as { body: { users: unknown[] } };
  assert.equal(byUsername.body.users.length, 1, '用户名也参与匹配');

  // 组合过滤
  const combined = (await call(handler, 'GET', '/api/admin/users', undefined, { status: 'active', search: 'bob' })) as { body: { users: unknown[] } };
  assert.equal(combined.body.users.length, 0, 'status 与 search 是 AND 关系');
});

test('非法 status → 400（不静默返回空列表）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'GET', '/api/admin/users', undefined, { status: 'ghost' })) as { status: number; body: { error: string } };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /pending \/ active \/ suspended \/ deleted/);
});

// ─────────────────────────── 详情与身份 ───────────────────────────

test('★ `GET /admin/users/:id` 详情；不存在 → 404', async () => {
  const { handler } = makeHandler();
  const found = (await call(handler, 'GET', '/api/admin/users/11111111-1111-7111-a111-111111111111')) as { status: number; body: { user: { email: string } } };
  assert.equal(found.status, 200);
  assert.equal(found.body.user.email, 'alice@example.com');
  assert.equal(((await call(handler, 'GET', '/api/admin/users/99999999-9999-7999-a999-999999999999')) as { status: number }).status, 404);
});

test('★★ `GET /admin/users/:id/identities` 列出绑定；**无绑定时给出排障线索**', async () => {
  const { handler } = makeHandler();
  const withIdentity = (await call(handler, 'GET', '/api/admin/users/11111111-1111-7111-a111-111111111111/identities')) as {
    status: number;
    body: { identities: { provider: string }[]; note?: string };
  };
  assert.equal(withIdentity.status, 200);
  assert.equal(withIdentity.body.identities.length, 1);
  assert.equal(withIdentity.body.identities[0]!.provider, 'identity:oidc@platform:enduser');
  assert.equal(withIdentity.body.note, undefined, '有绑定时不提示');

  // ★ 无绑定身份 = 用户无法通过 OIDC 登录——这是排障时最该看到的信息
  const withoutIdentity = (await call(handler, 'GET', '/api/admin/users/22222222-2222-7222-a222-222222222222/identities')) as { body: { identities: unknown[]; note?: string } };
  assert.deepEqual(withoutIdentity.body.identities, []);
  assert.match(String(withoutIdentity.body.note), /无法通过 OIDC 登录/);

  assert.equal(((await call(handler, 'GET', '99999999-9999-7999-a999-999999999999/identities')) as { status: number }).status, 404);
});

// ─────────────────────────── 封禁 ───────────────────────────

test('★ `POST /admin/users/:id/block` 封禁（默认）与解封', async () => {
  const { handler, users } = makeHandler();
  // 默认 → 封禁
  const blocked = (await call(handler, 'POST', '/api/admin/users/11111111-1111-7111-a111-111111111111/block')) as { status: number; body: { user: { status: string } } };
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.user.status, 'suspended', '★ 未给参数时默认封禁');
  assert.equal((await users.get('11111111-1111-7111-a111-111111111111'))?.status, 'suspended');

  // 显式解封
  const unblocked = (await call(handler, 'POST', '/api/admin/users/11111111-1111-7111-a111-111111111111/block', { blocked: false })) as { body: { user: { status: string } } };
  assert.equal(unblocked.body.user.status, 'active');
  assert.equal((await users.get('11111111-1111-7111-a111-111111111111'))?.status, 'active');

  assert.equal(((await call(handler, 'POST', '99999999-9999-7999-a999-999999999999/block')) as { status: number }).status, 404);
});

test('未启用用户存储时不挂载（404，而不是返回空列表）', async () => {
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    logger: silentLogger,
  });
  const response = (await call(handler, 'GET', '/api/admin/users')) as { status: number };
  assert.equal(response.status, 404, '★ 显式「不可用」比「返回空列表」诚实');
});

// ─────────────────────────── ★★ 非法输入 → 400（不是 500）───────────────────────────

test('★★ 非 uuid 的 id → **400**（而不是让 PG 报错成 500）', async () => {
  const { handler } = makeHandler();
  // ★ 这是被 path-probe 的**自动推导探针**抓到的：
  //   它用 `probe-id` 请求这些路径，而当时返回的是 500
  //   （PG 抛 `invalid input syntax for type uuid`）。
  //   路径参数是**外部输入**，非法值应返回 400。
  for (const [method, path] of [
    ['GET', '/api/admin/users/not-a-uuid'],
    ['GET', '/api/admin/users/not-a-uuid/identities'],
    ['POST', '/api/admin/users/not-a-uuid/block'],
  ] as const) {
    const response = (await call(handler, method, path)) as { status: number; body: { error: string } };
    assert.equal(response.status, 400, `${method} ${path} 应返回 400（实际 ${response.status}）`);
    assert.match(response.body.error, /必须是 uuid/);
    assert.match(response.body.error, /主键是 uuid/, '错误信息要说明「为什么非法值不该让数据库报错」');
  }

  // 合法 uuid 但不存在 → 404（这才是「没找到」，与「参数非法」区分开）
  const missing = (await call(handler, 'GET', '/api/admin/users/00000000-0000-7000-a000-000000000000')) as { status: number };
  assert.equal(missing.status, 404, '★ 合法 uuid 但不存在 → 404，与 400 明确区分');
});

// ─────────────────────────── ★★ raw 端点（递归脱敏）───────────────────────────

test('★★ `GET /admin/users/:id/raw` **递归**剔除敏感字段（文档要求）', async () => {
  const users = new InMemoryUserAdminStore();
  const USER_ID = '11111111-1111-7111-a111-111111111111';
  users.seed(user({ id: USER_ID, email: 'a@example.com', username: 'alice' }), [
    { id: 'id-1', provider: 'p', providerUserId: 'sub-1', verifiedAt: null, createdAt: new Date() },
  ]);
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => ({
      id: 'p',
      subjectSchema: { type: 'object', properties: {} },
      capabilities: { list: true, findByIdentity: false, get: true, cursor: false, update: false, create: false },
      listSubjects: async () => ({ subjects: [], nextCursor: null }),
      // ★ provider 侧原始对象——**故意**在多个层级埋敏感字段
      getSubject: async () => ({
        id: 'sub-1',
        username: 'alice',
        password: '明文密码',
        access_token: 'at-xxx',
        profile: {
          email: 'a@example.com',
          credentials: { access_token: '嵌套的令牌', api_key: 'k-1' },
          nested: { deeper: { secret: '深层的密钥' } },
        },
        normal: '这个应该保留',
      }),
    }) as never,
    plugins: new InMemoryPluginStore(),
    users,
    logger: silentLogger,
  } as never);

  const response = (await call(handler, 'GET', `/api/admin/users/${USER_ID}/raw`)) as {
    status: number;
    body: { raw: Record<string, unknown>; redacted: boolean; note: string };
  };
  assert.equal(response.status, 200);
  assert.equal(response.body.redacted, true);
  assert.match(response.body.note, /递归剔除/);

  const text = JSON.stringify(response.body.raw);
  // ★ 三个层级的敏感值都不得出现
  assert.equal(text.includes('明文密码'), false, '顶层 password 必须剔除');
  assert.equal(text.includes('at-xxx'), false, '顶层 access_token 必须剔除');
  assert.equal(text.includes('嵌套的令牌'), false, '★ 嵌套的 access_token 必须剔除（只删顶层是不够的）');
  assert.equal(text.includes('k-1'), false, '嵌套的 api_key 必须剔除');
  assert.equal(text.includes('深层的密钥'), false, '★ 更深层的 secret 必须剔除');

  // ★ 非敏感字段保留（避免「过度脱敏」让端点失去排障价值）
  assert.equal((response.body.raw as { normal?: string }).normal, '这个应该保留');
  assert.equal((response.body.raw as { username?: string }).username, 'alice');
  // ★ 被剔除的位置留下标记，而不是静默消失（排障时「有没有配 token」是重要线索）
  assert.equal((response.body.raw as { password?: string }).password, '[已脱敏]');
});

test('★ `raw`：站点**未配置 provider** → 400（显式说明，而不是返回空对象）', async () => {
  // ★ 这个断言来自一次真实的测试失败：我原以为会走到「无绑定身份」分支，
  //   实际先撞上「站点没有 provider」——两者是不同的失败原因，不该混淆。
  const { handler } = makeHandler();
  const response = (await call(handler, 'GET', '/api/admin/users/22222222-2222-7222-a222-222222222222/raw')) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /尚未配置主体目录/);
});

test('★ `raw`：用户无绑定身份 → raw 为 null 且给出说明（不报错）', async () => {
  const users = new InMemoryUserAdminStore();
  const USER_ID = '33333333-3333-7333-a333-333333333333';
  users.seed(user({ id: USER_ID, email: 'b@example.com', username: 'bob' }), []);
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: { list: async () => [], get: async () => undefined, versions: async () => [] } as never,
    audit: { record: async () => undefined } as never,
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => ({
      id: 'p',
      subjectSchema: { type: 'object', properties: {} },
      capabilities: { list: true, findByIdentity: false, get: true, cursor: false, update: false, create: false },
      listSubjects: async () => ({ subjects: [], nextCursor: null }),
      getSubject: async () => null,
    }) as never,
    plugins: new InMemoryPluginStore(),
    users,
    logger: silentLogger,
  });

  const response = (await handler({
    method: 'GET',
    path: `/api/admin/users/${USER_ID}/raw`,
    query: {},
    session: ADMIN_SESSION,
  } as never)) as { status: number; body: { raw: unknown; note: string } };
  assert.equal(response.status, 200);
  assert.equal(response.body.raw, null);
  assert.match(response.body.note, /没有绑定任何外部身份/);
});

// ─────────────────────────── 标签（全量替换 + 去重排序）───────────────────────────

test('★ `POST /:id/tags` 是**全量替换**（不是追加）——传 [] 即清空', async () => {
  const { handler, users } = makeHandler();
  const ID = '11111111-1111-7111-a111-111111111111';

  const set = (await call(handler, 'POST', `/api/admin/users/${ID}/tags`, { tags: ['vip', 'risk'] })) as {
    status: number;
    body: { user: { tags: string[] } };
  };
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.user.tags, ['risk', 'vip'], '★ 排序后返回（顺序稳定）');

  // ★ 全量替换：只传一个 → 另一个消失（若是追加语义，vip 会留下）
  const replaced = (await call(handler, 'POST', `/api/admin/users/${ID}/tags`, { tags: ['trial'] })) as { body: { user: { tags: string[] } } };
  assert.deepEqual(replaced.body.user.tags, ['trial'], '★ 是替换：未传的标签应消失');

  // ★ 清空
  const cleared = (await call(handler, 'POST', `/api/admin/users/${ID}/tags`, { tags: [] })) as { body: { user: { tags: string[] } } };
  assert.deepEqual(cleared.body.user.tags, [], '★ 传 [] 即清空（不需要逐个删）');
  assert.deepEqual((await users.get(ID))?.tags, []);
});

test('★ 标签**去重并排序**——同一组标签在不同输入顺序下结果相同', async () => {
  const { handler } = makeHandler();
  const ID = '11111111-1111-7111-a111-111111111111';

  const a = (await call(handler, 'POST', `/api/admin/users/${ID}/tags`, { tags: ['vip', 'risk', 'vip'] })) as {
    body: { user: { tags: string[] }; note?: string };
  };
  assert.deepEqual(a.body.user.tags, ['risk', 'vip'], '★ 去重');
  assert.match(String(a.body.note), /已去重：传入 3 个，实际存储 2 个/, '★ 明确告知去重（而不是让调用方猜）');

  // ★ 换一个顺序 → 结果相同（这保证了「标签是否变化」的判断是稳定的）
  const b = (await call(handler, 'POST', `/api/admin/users/${ID}/tags`, { tags: ['risk', 'vip'] })) as { body: { user: { tags: string[] }; note?: string } };
  assert.deepEqual(b.body.user.tags, a.body.user.tags);
  assert.equal(b.body.note, undefined, '没有去重时不产生 note');
});

test('★ 非法标签 → 400（空串 / 超长 / 非字符串）', async () => {
  const { handler } = makeHandler();
  const ID = '11111111-1111-7111-a111-111111111111';
  for (const tags of [[''], ['x'.repeat(65)], [123], [null]]) {
    const response = (await call(handler, 'POST', `/api/admin/users/${ID}/tags`, { tags })) as { status: number; body: { error: string } };
    assert.equal(response.status, 400, `tags=${JSON.stringify(tags)} 应被拒绝`);
    assert.match(response.body.error, /非空字符串/);
  }
  // 缺 tags 数组 → 400
  assert.equal(((await call(handler, 'POST', `/api/admin/users/${ID}/tags`, {})) as { status: number }).status, 400);
});

test('★ 非 uuid 的 id → 400；不存在的用户 → 404', async () => {
  const { handler } = makeHandler();
  assert.equal(((await call(handler, 'POST', '/api/admin/users/not-a-uuid/tags', { tags: [] })) as { status: number }).status, 400);
  assert.equal(((await call(handler, 'POST', '/api/admin/users/99999999-9999-7999-a999-999999999999/tags', { tags: [] })) as { status: number }).status, 404);
});
