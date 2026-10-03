/**
 * 管理端最小验收（M1-11）。
 *
 * 断言重点：
 *   - **站点作用域只来自会话**：请求体里带 siteId 一律被忽略（越权防线）；
 *   - **鉴权**：未登录 401、未选站点 400、enduser 域 403；
 *   - **手工绑定必须留审计**（它绕过自动对齐）；
 *   - **发布前静态校验**：引用未安装插件的策略 422 被拒；**发布时再校验一次**（草稿期间插件可能被卸载）；
 *   - **试算**能返回逐条明细。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAdminHandler,
  fingerprintOf,
  InMemoryAuditSink,
  InMemoryPolicyStore,
  makeSession,
  subjectRefOf,
  type AdminDeps,
  type HttpRequestLike,
} from '../src/admin/api.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import type { PluginRegistry, PolicyDocument } from '../src/policy/model.ts';
import type { ProviderPlugin, SubjectPage, SubjectSchema } from '../src/plugin/provider.ts';

const SITE = 'site-1';
const SCHEMA: SubjectSchema = { type: 'object', properties: { group: { type: 'string', watch: true } } };

function provider(id = 'fakeprovider'): ProviderPlugin {
  return {
    id,
    subjectSchema: SCHEMA,
    capabilities: { list: true, findByIdentity: false, get: true, cursor: false, update: false, create: false },
    async listSubjects(): Promise<SubjectPage> {
      return { subjects: [], nextCursor: null };
    },
    async getSubject() {
      return null;
    },
  };
}

function registry(): PluginRegistry {
  return {
    installedPlugins: () => ['email', 'fakeprovider'],
    knownFactKeys: () => ['fact.email.domain'],
    knownActions: () => ['checkin:grant'],
  };
}

const GOOD_POLICY: PolicyDocument = {
  code: 'edu',
  name: '教育邮箱',
  spec: { requirements: { expression: { matches: { 'fact.email.domain': ['*.edu.cn'] } } } },
};

async function setup(overrides: Partial<AdminDeps> = {}) {
  const subjects = new InMemorySubjectStore();
  await subjects.upsert('fakeprovider', { externalId: '42', displayName: 'alice', email: 'a@b.c', attributes: { group: 'basic' } }, ['group'], 'fp-42', new Date('2025-06-01T00:00:00Z'));
  const identities = new InMemoryIdentityStore();
  const policies = new InMemoryPolicyStore();
  const audit = new InMemoryAuditSink();
  const deps: AdminDeps = {
    subjects,
    identities,
    policies,
    audit,
    registry: registry(),
    providerForSite: () => provider(),
    ...overrides,
  };
  return { handler: createAdminHandler(deps), deps, subjects, identities, policies, audit };
}

const adminRequest = (overrides: Partial<HttpRequestLike>): HttpRequestLike => ({
  method: 'GET',
  path: '/',
  session: makeSession({ userId: 'admin-1', activeSiteId: SITE }),
  ...overrides,
});

// ─────────────────────────── 鉴权 ───────────────────────────

test('鉴权：未登录 401；未选站点 400；enduser 域 403；role=user 403', async () => {
  const { handler } = await setup();
  assert.equal((await handler({ method: 'GET', path: '/api/admin/subjects' })).status, 401);
  assert.equal(
    (await handler(adminRequest({ path: '/api/admin/subjects', session: makeSession({ userId: 'u', activeSiteId: null }) }))).status,
    400,
  );
  assert.equal(
    (
      await handler(
        adminRequest({ path: '/api/admin/subjects', session: makeSession({ userId: 'u', activeSiteId: SITE, realm: 'enduser' }) }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handler(
        adminRequest({ path: '/api/admin/subjects', session: makeSession({ userId: 'u', activeSiteId: SITE, role: 'user' }) }),
      )
    ).status,
    403,
  );
});

test('★ 站点作用域只来自会话：请求体里带 siteId 一律被忽略（越权防线）', async () => {
  const { handler, policies } = await setup();
  // 攻击者在 body 里塞 siteId 指向别的站点
  const response = await handler(
    adminRequest({ method: 'POST', path: '/api/admin/policies', body: { ...GOOD_POLICY, siteId: 'other-site' } }),
  );
  assert.equal(response.status, 201);
  // 策略落在**会话的站点**下，而不是 body 指定的站点
  assert.equal((await policies.list(SITE)).length, 1);
  assert.equal((await policies.list('other-site')).length, 0);
});

// ─────────────────────────── 主体列表 ───────────────────────────

test('主体列表：返回关注属性与指纹；站点未配置 provider → 400', async () => {
  const { handler } = await setup();
  const response = await handler(adminRequest({ path: '/api/admin/subjects' }));
  assert.equal(response.status, 200);
  const body = response.body as { provider: string; total: number; subjects: { externalId: string; watched: Record<string, unknown> }[] };
  assert.equal(body.provider, 'fakeprovider');
  assert.equal(body.total, 1);
  assert.equal(body.subjects[0]!.externalId, '42');
  assert.deepEqual(body.subjects[0]!.watched, { group: 'basic' });

  const { handler: noProvider } = await setup({ providerForSite: () => undefined });
  assert.equal((await noProvider(adminRequest({ path: '/api/admin/subjects' }))).status, 400);
});

test('主体列表：limit 被限制在合理区间（防止一次拉爆）', async () => {
  const { handler } = await setup();
  const body = (await handler(adminRequest({ path: '/api/admin/subjects', query: { limit: '99999' } }))).body as { limit: number };
  assert.equal(body.limit, 200);
});

test('未知端点 → 404（不静默成功）', async () => {
  const { handler } = await setup();
  assert.equal((await handler(adminRequest({ path: '/api/admin/nope' }))).status, 404);
});

// ─────────────────────────── 手工绑定 ───────────────────────────

test('★ 手工绑定：成功并**写入审计**（它绕过自动对齐，必须可追溯）', async () => {
  const { handler, audit, identities } = await setup();
  const response = await handler(
    adminRequest({
      method: 'POST',
      path: '/api/admin/identities/manual-bind',
      body: { userId: 'user-9', externalId: '42', reason: '用户申诉：邮箱已更换' },
    }),
  );
  assert.equal(response.status, 201);
  const saved = await identities.find('manual:fakeprovider', 'user-9');
  assert.deepEqual(saved!.subjectRef, { provider: 'fakeprovider', externalId: '42' });

  assert.equal(audit.entries.length, 1);
  const entry = audit.entries[0]!;
  assert.equal(entry.action, 'identity.manual_bind');
  assert.equal(entry.actorId, 'admin-1');
  assert.equal(entry.siteId, SITE);
  assert.match(JSON.stringify(entry.after), /user-9/);
});

test('★ 手工绑定：下游主体不在镜像中 → 404（不制造永远对不上的身份）', async () => {
  const { handler, audit } = await setup();
  const response = await handler(
    adminRequest({ method: 'POST', path: '/api/admin/identities/manual-bind', body: { userId: 'user-9', externalId: 'nope' } }),
  );
  assert.equal(response.status, 404);
  assert.equal(audit.entries.length, 0, '失败的操作不写审计（避免污染）');
});

test('手工绑定：缺参数 → 400', async () => {
  const { handler } = await setup();
  assert.equal(
    (await handler(adminRequest({ method: 'POST', path: '/api/admin/identities/manual-bind', body: { userId: 'u' } }))).status,
    400,
  );
  assert.equal(
    (await handler(adminRequest({ method: 'POST', path: '/api/admin/identities/manual-bind', body: { externalId: '42' } }))).status,
    400,
  );
});

// ─────────────────────────── 策略 ───────────────────────────

test('★ 策略保存：静态校验不通过 → 422（引用未安装插件的命名空间）', async () => {
  const { handler, policies } = await setup();
  const bad: PolicyDocument = {
    code: 'bad',
    spec: { requirements: { expression: { gte: { 'fact.gitlab.mr_count': 5 } } } },
  };
  const response = await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: bad }));
  assert.equal(response.status, 422);
  const body = response.body as { detail: { missingPlugins: string[]; issues: unknown[] } };
  assert.deepEqual(body.detail.missingPlugins, ['gitlab']);
  assert.ok(body.detail.issues.length > 0);
  assert.equal((await policies.list(SITE)).length, 0, '未通过校验的策略不得落库');
});

test('策略保存：合法策略 → 201，并返回渠道自动推断结果；写审计', async () => {
  const { handler, policies, audit } = await setup();
  const response = await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: GOOD_POLICY }));
  assert.equal(response.status, 201);
  assert.deepEqual((response.body as { inferredChannels: string[] }).inferredChannels, ['email']);
  assert.equal((await policies.list(SITE)).length, 1);
  assert.equal(audit.entries[0]!.action, 'policy.save_draft');
});

test('★ 发布：草稿合法 → 版本递增；**发布时再校验一次**（草稿期间插件可能被卸载）', async () => {
  const { handler, deps } = await setup();
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: GOOD_POLICY }));
  const published = await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/publish' }));
  assert.equal(published.status, 200);
  assert.equal((published.body as { version: number }).version, 1);

  // 模拟「草稿保存后插件被卸载」：registry 不再有 email
  deps.registry = {
    installedPlugins: () => [],
    knownFactKeys: () => [],
    knownActions: () => [],
  };
  const second = await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/publish' }));
  assert.equal(second.status, 422, '发布时必须重新校验');
  assert.deepEqual((second.body as { detail: { missingPlugins: string[] } }).detail.missingPlugins, ['email']);
});

test('发布：策略不存在 → 404；发布写审计', async () => {
  const { handler, audit } = await setup();
  assert.equal((await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/nope/publish' }))).status, 404);

  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: GOOD_POLICY }));
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/publish' }));
  assert.ok(audit.entries.some((e) => e.action === 'policy.publish'));
});

test('策略列表：只返回本会话站点的策略（站点隔离）', async () => {
  const { handler, policies } = await setup();
  await policies.saveDraft('other-site', { ...GOOD_POLICY, code: 'other' });
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: GOOD_POLICY }));
  const body = (await handler(adminRequest({ path: '/api/admin/policies' }))).body as { policies: PolicyDocument[] };
  assert.deepEqual(body.policies.map((p) => p.code), ['edu']);
});

// ─────────────────────────── 试算 ───────────────────────────

test('★ 试算：返回逐条明细（决策 + 动作 + 缺失项），供管理端预览影响面', async () => {
  const { handler } = await setup();
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: GOOD_POLICY }));

  const response = await handler(
    adminRequest({
      method: 'POST',
      path: '/api/admin/evaluate',
      body: { user: { status: 'active' }, facts: { 'fact.email.domain': 'tsinghua.edu.cn' } },
    }),
  );
  assert.equal(response.status, 200);
  const body = response.body as { policies: number; results: { code: string; decision: string; items: unknown[] }[] };
  assert.equal(body.policies, 1);
  assert.equal(body.results[0]!.code, 'edu');
  assert.equal(body.results[0]!.decision, 'satisfied');
  assert.ok(body.results[0]!.items.length > 0);

  // 缺失事实 → indeterminate（H1：不降级）
  const missing = await handler(
    adminRequest({ method: 'POST', path: '/api/admin/evaluate', body: { user: { status: 'active' }, facts: {} } }),
  );
  assert.equal((missing.body as { results: { decision: string }[] }).results[0]!.decision, 'indeterminate');
});

test('试算：缺少 user → 400（试算必须显式给出主体属性，不猜）', async () => {
  const { handler } = await setup();
  assert.equal((await handler(adminRequest({ method: 'POST', path: '/api/admin/evaluate', body: {} }))).status, 400);
});

// ─────────────────────────── 工具函数 ───────────────────────────

test('fingerprintOf 与对账器口径一致；subjectRefOf 形状正确', async () => {
  const plugin = provider();
  const subject = { externalId: '42', attributes: { group: 'basic' } };
  assert.equal(fingerprintOf('fakeprovider', subject, plugin), fingerprintOf('fakeprovider', subject, plugin));
  assert.deepEqual(subjectRefOf('fakeprovider', subject), { provider: 'fakeprovider', externalId: '42' });
});

// ─────────────────────────── M2-7 回滚端点 ───────────────────────────

test('★ M2-7 管理端：版本历史可读；回滚到历史版本并写审计', async () => {
  const { handler, audit } = await setup();
  // 存两版草稿并发布 v1
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: GOOD_POLICY }));
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/publish' }));
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: GOOD_POLICY }));
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/publish' }));

  const history = await handler(adminRequest({ method: 'GET', path: '/api/admin/policies/edu/versions' }));
  assert.equal(history.status, 200);
  const versions = (history.body as { versions: { version: number; status: string }[] }).versions;
  assert.deepEqual(versions.map((v) => `${v.version}:${v.status}`), ['1:archived', '2:active']);

  // 回滚到 v1
  const rolledBack = await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/rollback', body: { version: 1 } }));
  assert.equal(rolledBack.status, 200);
  assert.equal((rolledBack.body as { version: number }).version, 1);
  assert.ok(audit.entries.some((e) => e.action === 'policy.rollback'), '回滚必须写审计');

  const after = await handler(adminRequest({ method: 'GET', path: '/api/admin/policies/edu/versions' }));
  assert.deepEqual(
    (after.body as { versions: { version: number; status: string }[] }).versions.map((v) => `${v.version}:${v.status}`),
    ['1:active', '2:archived'],
  );
});

test('M2-7 管理端：回滚到不存在的版本 → 400（请求问题，不是服务端故障）', async () => {
  const { handler } = await setup();
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: GOOD_POLICY }));
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/publish' }));
  const response = await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/rollback', body: { version: 99 } }));
  assert.equal(response.status, 400);
  assert.match(String((response.body as { error: string }).error), /没有版本 99/);
});

test('M2-7 管理端：缺少合法 version → 400', async () => {
  const { handler } = await setup();
  const response = await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/rollback', body: {} }));
  assert.equal(response.status, 400);
});

// ─────────────────────────── M2-8 影响面端点 ───────────────────────────

test('★ M2-8 管理端：影响面试算返回高危清单与结论，且**不执行任何动作**', async () => {
  const { handler } = await setup();
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies', body: GOOD_POLICY }));
  await handler(adminRequest({ method: 'POST', path: '/api/admin/policies/edu/publish' }));

  const response = await handler(
    adminRequest({
      method: 'POST',
      path: '/api/admin/simulate',
      body: {
        subjects: [
          {
            externalId: 'u1',
            states: { edu: { state: 'granted', stateChangedAt: new Date().toISOString(), atRiskCount: 0, actionSeq: 1 } },
            user: { email: 'x@gmail.com', email_verified: true, status: 'active' },
            facts: { 'fact.email.domain': 'gmail.com', 'fact.email.verified': true },
          },
        ],
      },
    }),
  );
  assert.equal(response.status, 200);
  const report = response.body as { verdict: string; atRisk: unknown[]; results: unknown[]; stats: { unsatisfied: number } };
  assert.equal(report.results.length, 1);
  assert.equal(report.stats.unsatisfied, 1);
  // 已授权主体进入观察期 → 必须被单独列出
  assert.equal(report.atRisk.length, 1);
  assert.equal(report.verdict, 'needs_review');
});

test('M2-8 管理端：缺少 subjects → 400（影响面分析必须给出主体清单）', async () => {
  const { handler } = await setup();
  const response = await handler(adminRequest({ method: 'POST', path: '/api/admin/simulate', body: {} }));
  assert.equal(response.status, 400);
});

test('M2-8 管理端：可试算未发布的草稿（policies 显式给出）', async () => {
  const { handler } = await setup();
  const response = await handler(
    adminRequest({
      method: 'POST',
      path: '/api/admin/simulate',
      body: {
        policies: [GOOD_POLICY],
        subjects: [
          {
            externalId: 'u1',
            user: { email: 'a@tsinghua.edu.cn', email_verified: true, status: 'active' },
            facts: { 'fact.email.domain': 'tsinghua.edu.cn', 'fact.email.verified': true },
          },
        ],
      },
    }),
  );
  assert.equal(response.status, 200);
  const report = response.body as { verdict: string; stats: { grants: number } };
  assert.equal(report.stats.grants, 1);
  assert.equal(report.verdict, 'grants_only');
});
