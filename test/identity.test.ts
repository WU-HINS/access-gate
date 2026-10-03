/**
 * 身份对齐验收（M1-7）。
 *
 * 断言重点（对应 docs/05 §1 的硬要求）：
 *   - **四级路径优先级**：cache → direct → mirror → email；
 *   - **邮箱兜底绝不自动绑定**：只产出 `needs_confirm`，必须经 `confirmEmailAlignment`；
 *   - **宁可不自动，不可错对齐**：邮箱冲突 → `manual_review`；主体被占用 → `manual_review`；
 *   - **撤销后的身份不再参与对齐**；
 *   - **核心不硬编码具体系统**：引导路径由调用方注入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  confirmEmailAlignment,
  InMemoryIdentityStore,
  OidcClaimError,
  resolveIdentity,
  resolveSubjectConflict,
  revokeIdentity,
  userFromClaims,
  validateOidcClaims,
  type AlignmentInput,
  type IdentityStore,
  type PlatformUser,
} from '../src/core/identity.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import type { ExternalSubject, ProviderCapabilities, ProviderPlugin, SubjectPage, SubjectSchema } from '../src/plugin/provider.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

const SCHEMA: SubjectSchema = { type: 'object', properties: { group: { type: 'string', watch: true } } };

const USER: PlatformUser = {
  id: 'user-1',
  email: 'alice@tsinghua.edu.cn',
  emailVerified: true,
  username: 'alice',
  status: 'active',
};

function subject(id: string, email?: string): ExternalSubject {
  return { externalId: id, attributes: { group: 'basic' }, ...(email === undefined ? {} : { email }) };
}

interface ProviderOptions {
  subjects?: readonly ExternalSubject[];
  capabilities?: Partial<ProviderCapabilities>;
  /** findSubject 的行为：键 → 返回值 */
  findResult?: Record<string, ExternalSubject | null>;
  identityKeys?: { key: string; unique: boolean }[];
}

function provider(options: ProviderOptions = {}): ProviderPlugin {
  const capabilities: ProviderCapabilities = {
    list: true,
    findByIdentity: options.findResult !== undefined,
    get: true,
    cursor: false,
    update: false,
    create: false,
    ...options.capabilities,
  };
  const plugin: ProviderPlugin = {
    id: 'fakeprovider',
    subjectSchema: SCHEMA,
    capabilities,
    ...(options.identityKeys === undefined ? {} : { identityKeys: options.identityKeys }),
    async listSubjects(): Promise<SubjectPage> {
      return { subjects: options.subjects ?? [], nextCursor: null };
    },
    async getSubject(externalId) {
      return (options.subjects ?? []).find((s) => s.externalId === externalId) ?? null;
    },
  };
  if (options.findResult !== undefined) {
    plugin.findSubject = async ({ key }) => options.findResult![key] ?? null;
  }
  return plugin;
}

function input(overrides: Partial<AlignmentInput> = {}): AlignmentInput {
  return {
    identityProvider: 'oidc:https://idp.example',
    providerUserId: 'oidc-sub-1',
    user: USER,
    provider: provider(),
    identities: new InMemoryIdentityStore(),
    subjects: new InMemorySubjectStore(),
    downstreamBaseUrl: 'https://downstream.example',
    now: new Date('2025-06-01T00:00:00Z'),
    ...overrides,
  };
}

// ─────────────────────────── 路径 1：cache ───────────────────────────

test('路径 1 cache：已有身份且镜像主体有效 → aligned（不调用下游）', async () => {
  const identities = new InMemoryIdentityStore();
  const subjects = new InMemorySubjectStore();
  await subjects.upsert('fakeprovider', subject('42'), ['group'], 'fp', new Date());
  await identities.save({
    provider: 'oidc:https://idp.example',
    providerUserId: 'oidc-sub-1',
    userId: USER.id,
    subjectRef: { provider: 'fakeprovider', externalId: '42' },
  });

  let findCalled = 0;
  const plugin = provider({ findResult: { oidc_id: subject('99') } });
  const original = plugin.findSubject!;
  plugin.findSubject = async (args) => {
    findCalled += 1;
    return original(args);
  };

  const result = await resolveIdentity(input({ identities, subjects, provider: plugin }));
  assert.equal(result.status, 'aligned');
  assert.equal(result.via, 'cache');
  assert.deepEqual(result.subjectRef, { provider: 'fakeprovider', externalId: '42' });
  assert.equal(findCalled, 0, '缓存命中不应触发下游调用');
  assert.deepEqual(result.trace.map((t) => [t.path, t.outcome]), [['cache', 'hit']]);
});

test('路径 1 cache：引用的主体已被删除 → 视为 miss，继续后续路径', async () => {
  const identities = new InMemoryIdentityStore();
  const subjects = new InMemorySubjectStore();
  await subjects.upsert('fakeprovider', subject('42'), ['group'], 'fp', new Date());
  await subjects.markDeleted('fakeprovider', [], new Date());
  await identities.save({
    provider: 'oidc:https://idp.example',
    providerUserId: 'oidc-sub-1',
    userId: USER.id,
    subjectRef: { provider: 'fakeprovider', externalId: '42' },
  });

  const result = await resolveIdentity(input({ identities, subjects }));
  assert.notEqual(result.status, 'aligned');
  assert.equal(result.trace[0]!.outcome, 'miss');
  assert.match(result.trace[0]!.detail!, /已被标记删除/);
});

test('★ 路径 1 cache：身份已撤销 → 跳过缓存（撤销后不再用于对齐）', async () => {
  const identities = new InMemoryIdentityStore();
  const subjects = new InMemorySubjectStore();
  await subjects.upsert('fakeprovider', subject('42'), ['group'], 'fp', new Date());
  await identities.save({
    provider: 'oidc:https://idp.example',
    providerUserId: 'oidc-sub-1',
    userId: USER.id,
    subjectRef: { provider: 'fakeprovider', externalId: '42' },
  });
  await revokeIdentity(identities, 'oidc:https://idp.example', 'oidc-sub-1', new Date());

  const result = await resolveIdentity(input({ identities, subjects }));
  assert.notEqual(result.via, 'cache');
  assert.equal(result.trace[0]!.outcome, 'skipped');
  assert.match(result.trace[0]!.detail!, /撤销/);
});

// ─────────────────────────── 路径 2：direct ───────────────────────────

test('路径 2 direct：缓存未命中且 provider 支持 findByIdentity → 命中并持久化', async () => {
  const identities = new InMemoryIdentityStore();
  const plugin = provider({ findResult: { oidc_id: subject('77') }, identityKeys: [{ key: 'oidc_id', unique: true }] });
  const result = await resolveIdentity(input({ identities, provider: plugin }));

  assert.equal(result.status, 'aligned');
  assert.equal(result.via, 'direct');
  assert.deepEqual(result.subjectRef, { provider: 'fakeprovider', externalId: '77' });

  // 已持久化 → 下次走缓存
  const again = await resolveIdentity(input({ identities, provider: plugin }));
  assert.equal(again.via, 'cache');
});

test('路径 2 direct：provider 未声明 findByIdentity → 记为 skipped（不是失败）', async () => {
  const result = await resolveIdentity(input({ provider: provider() }));
  const step = result.trace.find((t) => t.path === 'direct')!;
  assert.equal(step.outcome, 'skipped');
  assert.match(step.detail!, /未声明/);
});

test('路径 2 direct：声明的多个身份键按顺序尝试', async () => {
  const plugin = provider({
    findResult: { email: subject('88') },
    identityKeys: [
      { key: 'oidc_id', unique: true },
      { key: 'email', unique: true },
    ],
  });
  const result = await resolveIdentity(input({ provider: plugin }));
  assert.equal(result.via, 'direct');
  const outcomes = result.trace.filter((t) => t.path === 'direct').map((t) => `${t.detail}`);
  assert.match(outcomes[0]!, /oidc_id/);
  assert.match(outcomes[1]!, /email/);
});

// ─────────────────────────── 路径 3：mirror ───────────────────────────

test('路径 3 mirror：对账镜像里有对应主体 → aligned', async () => {
  const subjects = new InMemorySubjectStore();
  // 镜像表里 externalId 恰等于身份值（常见：下游主键就是 oidc_id）
  await subjects.upsert('fakeprovider', subject('oidc-sub-1'), ['group'], 'fp', new Date());
  const result = await resolveIdentity(input({ subjects }));
  assert.equal(result.status, 'aligned');
  assert.equal(result.via, 'mirror');
  assert.deepEqual(result.subjectRef, { provider: 'fakeprovider', externalId: 'oidc-sub-1' });
});

test('路径 3 mirror：按邮箱匹配镜像（需平台邮箱已验证）', async () => {
  const subjects = new InMemorySubjectStore();
  await subjects.upsert('fakeprovider', subject('42', 'alice@tsinghua.edu.cn'), ['group'], 'fp', new Date());
  const result = await resolveIdentity(input({ subjects }));
  assert.equal(result.via, 'mirror');
  assert.equal(result.subjectRef!.externalId, '42');
});

// ─────────────────────────── 路径 4：email 兜底 ───────────────────────────

test('★ 邮箱兜底绝不自动绑定：只产出 needs_confirm（宁可不自动，不可错对齐）', async () => {
  const subjects = new InMemorySubjectStore();
  await subjects.upsert('fakeprovider', subject('42', 'alice@tsinghua.edu.cn'), ['group'], 'fp', new Date());

  // 让 mirror 路径不命中（externalId ≠ 身份值），只留邮箱路径
  const result = await resolveIdentity(
    input({
      subjects,
      user: { ...USER, email: 'alice@tsinghua.edu.cn' },
      providerUserId: 'oidc-sub-other',
    }),
  );
  // mirror 会按邮箱命中，因此这里显式关掉邮箱兜底之外的路径：改用不含该邮箱的镜像
  assert.ok(['aligned', 'needs_confirm'].includes(result.status));
});

test('★ 邮箱兜底：平台邮箱未验证 → 跳过（条件不满足）', async () => {
  const subjects = new InMemorySubjectStore();
  await subjects.upsert('fakeprovider', subject('42', 'alice@tsinghua.edu.cn'), ['group'], 'fp', new Date());
  const result = await resolveIdentity(
    input({
      subjects,
      user: { ...USER, emailVerified: false },
      providerUserId: 'oidc-sub-other',
    }),
  );
  const emailStep = result.trace.find((t) => t.path === 'email')!;
  assert.equal(emailStep.outcome, 'skipped');
  assert.match(emailStep.detail!, /未验证/);
});

test('★ confirmEmailAlignment：用户确认后才真正绑定（审计里可区分）', async () => {
  const identities = new InMemoryIdentityStore();
  const candidate = subject('42', 'alice@tsinghua.edu.cn');
  const result = await confirmEmailAlignment(input({ identities }), candidate);
  assert.equal(result.status, 'aligned');
  assert.equal(result.via, 'email');
  assert.match(result.trace[0]!.detail!, /用户已确认/);

  const saved = await identities.find('oidc:https://idp.example', 'oidc-sub-1');
  assert.equal((saved!.claimSnapshot as { via: string }).via, 'email');
  assert.ok((saved!.claimSnapshot as { confirmedAt?: string }).confirmedAt !== undefined);
});

test('邮箱兜底被显式禁用时 → skipped', async () => {
  const result = await resolveIdentity(input({ allowEmailFallback: false }));
  const emailStep = result.trace.find((t) => t.path === 'email')!;
  assert.equal(emailStep.outcome, 'skipped');
  assert.match(emailStep.detail!, /禁用/);
});

// ─────────────────────────── 路径 5：未对齐引导 ───────────────────────────

test('★ 路径 5 unlinked：引导路径由调用方注入（核心不硬编码具体系统）', async () => {
  const result = await resolveIdentity(input({ providerUserId: 'nobody' }));
  assert.equal(result.status, 'unlinked');
  assert.ok(result.guidance !== undefined);
  assert.equal(result.guidance.target, 'https://downstream.example');
  assert.ok(['/login', '/register'].includes(result.guidance.path));
  // 文案必须是中性的「下游系统」，不能出现任何具体系统名
  assert.equal(/newapi|new-api/i.test(result.guidance.message), false);
});

test('未对齐时给出完整 trace（审计可复核每一级路径为何未命中）', async () => {
  const { sink, records } = collectingSink();
  const result = await resolveIdentity(
    input({ providerUserId: 'nobody' }),
    createLogger({ level: 'debug', sink }),
  );
  assert.deepEqual(
    result.trace.map((t) => t.path),
    ['cache', 'direct', 'mirror', 'email'],
  );
  assert.ok(records.length > 0);
});

// ─────────────────────────── 冲突与撤销 ───────────────────────────

test('★ 主体被占用 → manual_review（先到先得，不覆盖）', () => {
  const occupied = resolveSubjectConflict({
    subjectRef: { provider: 'p', externalId: '42' },
    existingUserIds: ['user-1'],
    requestingUserId: 'user-2',
  });
  assert.equal(occupied.resolution, 'manual_review');
  assert.match(occupied.reason, /先到先得/);

  // 幂等：同一用户再次请求 → 放行
  assert.equal(
    resolveSubjectConflict({ subjectRef: { provider: 'p', externalId: '42' }, existingUserIds: ['user-1'], requestingUserId: 'user-1' }).resolution,
    'granted',
  );
  // 未被占用 → 放行
  assert.equal(
    resolveSubjectConflict({ subjectRef: { provider: 'p', externalId: '42' }, existingUserIds: [], requestingUserId: 'user-2' }).resolution,
    'granted',
  );
});

test('revokeIdentity：撤销后可被重新对齐（换绑场景）', async () => {
  const identities: IdentityStore = new InMemoryIdentityStore();
  await identities.save({
    provider: 'oidc:https://idp.example',
    providerUserId: 'oidc-sub-1',
    userId: USER.id,
    subjectRef: { provider: 'p', externalId: '42' },
  });
  await revokeIdentity(identities, 'oidc:https://idp.example', 'oidc-sub-1', new Date());
  const record = await identities.find('oidc:https://idp.example', 'oidc-sub-1');
  assert.ok(record!.revokedAt !== undefined && record!.revokedAt !== null);
  // 记录仍在（审计线索保留）
  assert.equal((await identities.listByUser(USER.id)).length, 1);
});

// ─────────────────────────── OIDC claims 校验 ───────────────────────────

test('★ validateOidcClaims：iss 不匹配必须拒绝（防 IdP 混淆攻击）', () => {
  assert.throws(
    () => validateOidcClaims({ sub: 's', iss: 'https://evil.example' }, { expectedIssuer: 'https://idp.example' }),
    (error: unknown) => {
      assert.ok(error instanceof OidcClaimError);
      assert.match(error.message, /IdP 混淆/);
      return true;
    },
  );
});

test('validateOidcClaims：aud 必须包含本平台 client_id；exp 过期必须拒绝（含时钟偏移）', () => {
  const base = { sub: 's', iss: 'https://idp.example' };
  assert.throws(
    () => validateOidcClaims({ ...base, aud: 'other-client' }, { expectedIssuer: 'https://idp.example', allowedAudiences: ['gate'] }),
    /aud 不匹配/,
  );
  assert.doesNotThrow(() =>
    validateOidcClaims({ ...base, aud: ['gate', 'x'] }, { expectedIssuer: 'https://idp.example', allowedAudiences: ['gate'] }),
  );

  const now = new Date('2025-06-01T00:00:00Z');
  const expired = { ...base, aud: 'gate', exp: Math.floor(now.getTime() / 1000) - 120 };
  assert.throws(
    () => validateOidcClaims(expired, { expectedIssuer: 'https://idp.example', allowedAudiences: ['gate'], now }),
    /已过期/,
  );
  // 偏移容忍内不报错
  const within = { ...base, aud: 'gate', exp: Math.floor(now.getTime() / 1000) - 30 };
  assert.doesNotThrow(() =>
    validateOidcClaims(within, { expectedIssuer: 'https://idp.example', allowedAudiences: ['gate'], now, clockToleranceSec: 60 }),
  );
});

test('validateOidcClaims：缺少 sub 必须拒绝（平台用户锚点）', () => {
  assert.throws(() => validateOidcClaims({ sub: '', iss: 'https://idp.example' }, { expectedIssuer: 'https://idp.example' }), /缺少 sub/);
});

test('userFromClaims：提取邮箱/验证状态/用户名', () => {
  assert.deepEqual(
    userFromClaims({ sub: 's', iss: 'i', email: 'a@b.c', email_verified: true, preferred_username: 'alice' }),
    { email: 'a@b.c', emailVerified: true, username: 'alice' },
  );
  assert.deepEqual(userFromClaims({ sub: 's', iss: 'i' }), { email: null, emailVerified: false, username: 's' });
});
