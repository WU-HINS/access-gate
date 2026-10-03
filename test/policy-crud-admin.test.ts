/**
 * 策略读/写/校验端点验收（P0；docs/06 `/admin/policies/:code` 系列）。
 *
 * ★★ 核心断言：**路径里的 `:code` 与 body 里的 `policy.code` 必须一致**——
 *   否则调用方以为改的是 A、实际写的是 B（静默写错目标）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler, type PolicyStore } from '../src/admin/api.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const ADMIN_SESSION = { userId: 'admin-1', username: 'admin', activeSiteId: 'site-1', realm: 'developer' as const, role: 'admin' as const };

/**
 * 最小可用策略。
 *
 * ★ 形状是从**现有测试**（`test/admin.test.ts`）抄来的，而不是凭直觉写的：
 *   我最初写了 `{ code, version, status, rules: [] }`，而 `validatePolicy`
 *   会读 `spec.requirements.expression` → **抛 TypeError**。
 *   ★ 「先看现有用法再写」在这里又省了一轮。
 */
const policy = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  code: 'edu',
  name: '教育邮箱',
  spec: { requirements: { expression: { matches: { 'fact.email.domain': ['*.edu.cn'] } } } },
  ...overrides,
});

function makeHandler() {
  const saved: Record<string, unknown>[] = [];
  const documents = new Map<string, Record<string, unknown>>();
  const policies: PolicyStore = {
    list: async (_siteId: string) => [],
    get: async (_siteId: string, code: string) => documents.get(code) as never,
    saveDraft: async (_siteId: string, document: { code: string }) => {
      saved.push(document as unknown as Record<string, unknown>);
      documents.set(document.code, document as unknown as Record<string, unknown>);
    },
    publish: async (_siteId: string, code: string) => ({ code, version: 1 }) as never,
    versions: async (_siteId: string, _code: string) => [],
    // ★ R80：回滚端点需要 `rollback`（此前 mock 没有它 → 调用即 400）。
    //   返回「回滚后的策略文档」，版本即目标版本。
    rollback: async (_siteId: string, code: string, version: number) => ({ code, version }) as never,
  } as unknown as PolicyStore;
  const handler = createAdminHandler({
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies,
    audit: { record: async () => undefined } as never,
    // ★ registry 必须声明策略引用的事实键，否则 `unknownFacts` 非空 → 校验失败
    registry: { installedPlugins: () => ['email'], knownFactKeys: () => ['fact.email.domain'], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    logger: silentLogger,
  });
  return { handler, saved };
}

const call = (handler: ReturnType<typeof makeHandler>['handler'], method: string, path: string, body?: unknown) =>
  handler({ method, path, query: {}, body, session: ADMIN_SESSION } as never);

// ─────────────────────────── 读 ───────────────────────────

test('★ `GET /admin/policies/:code` 读当前生效内容；不存在 → 404', async () => {
  const { handler } = makeHandler();
  assert.equal(((await call(handler, 'GET', '/api/admin/policies/edu')) as { status: number }).status, 404);

  await call(handler, 'PUT', '/api/admin/policies/edu', { policy: policy() });
  const found = (await call(handler, 'GET', '/api/admin/policies/edu')) as { status: number; body: { policy: { code: string } } };
  assert.equal(found.status, 200);
  assert.equal(found.body.policy.code, 'edu');
});

// ─────────────────────────── ★★ 写（含一致性校验）───────────────────────────

test('★★ `PUT /:code` 保存草稿；**路径 code 与 body code 不一致 → 400**', async () => {
  const { handler, saved } = makeHandler();

  // ① 一致 → 保存
  const okResponse = (await call(handler, 'PUT', '/api/admin/policies/edu', { policy: policy() })) as { status: number };
  assert.equal(okResponse.status, 200);
  assert.equal(saved.length, 1);

  // ② ★★ 不一致 → 拒绝（否则会静默写错目标）
  const mismatch = (await call(handler, 'PUT', '/api/admin/policies/edu', { policy: policy({ code: 'other' }) })) as {
    status: number;
    body: { error: string };
  };
  assert.equal(mismatch.status, 400, '★ 路径与 body 的 code 不一致必须拒绝');
  assert.match(mismatch.body.error, /不一致/);
  assert.match(mismatch.body.error, /拒绝以免写错目标/);
  assert.equal(saved.length, 1, '★ 拒绝时不得写入');
});

test('★ `PUT /:code`：缺 policy 对象 → 400', async () => {
  const { handler } = makeHandler();
  assert.equal(((await call(handler, 'PUT', '/api/admin/policies/edu', {})) as { status: number }).status, 400);
  assert.equal(((await call(handler, 'PUT', '/api/admin/policies/edu', { policy: [1, 2] })) as { status: number }).status, 400);
});

// ─────────────────────────── 校验 ───────────────────────────

test('★ `POST /:code/validate`：**只校验不保存**，且返回诊断而非 HTTP 错误', async () => {
  const { handler, saved } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/policies/edu/validate', { policy: policy() })) as {
    status: number;
    body: { code: string; valid: boolean; issues: unknown[]; missingPlugins: string[]; unknownFacts: string[] };
  };
  // ★ 即使校验失败也应是 200（调用方要的是问题清单）
  assert.equal(response.status, 200);
  assert.equal(response.body.code, 'edu');
  assert.equal(typeof response.body.valid, 'boolean');
  assert.ok(Array.isArray(response.body.issues));
  // ★ 额外给出「缺哪些插件 / 哪些事实键无人产出」——比只有 message 更有可操作性
  assert.ok(Array.isArray(response.body.missingPlugins));
  assert.ok(Array.isArray(response.body.unknownFacts));
  assert.equal(saved.length, 0, '★ 校验**不保存**');
});

test('★ 校验：缺 policy 对象 → 400（这是**参数错误**，不是校验失败）', async () => {
  const { handler } = makeHandler();
  assert.equal(((await call(handler, 'POST', '/api/admin/policies/edu/validate', {})) as { status: number }).status, 400);
});

// ─────────────────────────── ★ 按策略试算 ───────────────────────────

test('★ `POST /:code/simulate`：候选策略由 `:code` 确定（body 给草稿就用草稿）', async () => {
  const { handler } = makeHandler();
  // 不保存直接试算草稿（模拟「如果发布会怎样」）
  const response = (await call(handler, 'POST', '/api/admin/policies/edu/simulate', {
    policy: policy({ spec: { requirements: { expression: { matches: { 'fact.email.domain': ['*.edu.cn'] } } } } }),
    // ★ `SimulateSubject` 的 `user` 是**必填**（我最初漏了它 → 500）
    subjects: [{ externalId: 's1', user: { email: 'a@b.edu.cn', email_verified: true, status: 'active' }, facts: { 'fact.email.domain': 'a@b.edu.cn' } }],
  })) as { status: number; body: { code: string } };
  assert.equal(response.status, 200);
  assert.equal(response.body.code, 'edu', '★ 响应回显 code，便于调用方确认试算的是哪一条');
});

test('★ `POST /:code/simulate`：body 没给草稿 → 读**当前生效内容**', async () => {
  const { handler } = makeHandler();
  await call(handler, 'PUT', '/api/admin/policies/edu', { policy: policy() });
  const response = (await call(handler, 'POST', '/api/admin/policies/edu/simulate', {
    subjects: [{ externalId: 's1', user: { email: 'a@b.edu.cn', email_verified: true, status: 'active' }, facts: { 'fact.email.domain': 'a@b.edu.cn' } }],
  })) as { status: number };
  assert.equal(response.status, 200);
});

test('★ `POST /:code/simulate`：策略不存在且未给草稿 → 404；缺 subjects → 400', async () => {
  const { handler } = makeHandler();
  assert.equal(((await call(handler, 'POST', '/api/admin/policies/ghost/simulate', { subjects: [] })) as { status: number }).status, 404);
  assert.equal(((await call(handler, 'POST', '/api/admin/policies/edu/simulate', {})) as { status: number }).status, 400);
});

test('★ `POST /:code/simulate`：草稿静态校验未通过 → 422（拒绝试算无效策略）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/policies/edu/simulate', {
    // 引用一个 registry 里没有的事实键 → unknownFacts 非空 → 校验失败
    policy: policy({ spec: { requirements: { expression: { matches: { 'fact.ghost.key': ['x'] } } } } }),
    subjects: [{ externalId: 's1', user: { status: 'active' }, facts: {} }],
  })) as { status: number; body: { error: string } };
  assert.equal(response.status, 422);
  assert.match(response.body.error, /静态校验未通过/);
});

// ─────────────────────────── ★ 回滚的三种形态（R80）───────────────────────────

test('★ 回滚 `mode` 缺省 = pointer（**向后兼容**，仅切版本）', async () => {
  const { handler } = makeHandler();
  await call(handler, 'PUT', '/api/admin/policies/edu', { policy: policy() });
  await call(handler, 'PUT', '/api/admin/policies/edu', { policy: policy({ version: 2 }) });
  const response = (await call(handler, 'POST', '/api/admin/policies/edu/rollback', { version: 1 })) as {
    status: number;
    body: { mode: string; reEvaluation?: unknown };
  };
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, 'pointer', '★ 缺省形态是 pointer（不重算）');
  assert.equal(response.body.reEvaluation, undefined, '★ pointer 不做重新求值');
});

test('★ `mode` 非法 → 400（三种形态之外的都拒绝）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/policies/edu/rollback', { version: 1, mode: 'ghost' })) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /mode 必须是 pointer \/ subject \/ batch 之一/);
});

test('★ `mode=subject` 缺 `externalId` → 400（必须说明对哪个主体重新求值）', async () => {
  const { handler } = makeHandler();
  const response = (await call(handler, 'POST', '/api/admin/policies/edu/rollback', { version: 1, mode: 'subject' })) as {
    status: number;
    body: { error: string };
  };
  assert.equal(response.status, 400);
  assert.match(response.body.error, /必须提供 externalId/);
});

test('★ 未装配回滚依赖时，`mode=subject`/`batch` → 501（显式不可用，而不是静默只切版本）', async () => {
  const { handler } = makeHandler();
  for (const mode of ['subject', 'batch']) {
    const response = (await call(handler, 'POST', '/api/admin/policies/edu/rollback', {
      version: 1,
      mode,
      ...(mode === 'subject' ? { externalId: 's1' } : {}),
    })) as { status: number; body: { error: string } };
    assert.equal(response.status, 501, `mode=${mode} 应返回 501`);
    assert.match(response.body.error, /未装配回滚依赖/);
  }
});
