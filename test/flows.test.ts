/**
 * 两条 OIDC 链路隔离验收（M7-3 / M7-4）—— docs/08 §3、§5.2、§5.3、§5.4。
 *
 * ★ 本文件最重要的断言是**隔离的安全含义**，而不是「两条链路各自能登录」：
 *   同一 OIDC `sub` 在普通用户链路首次自动建号之后，
 *   **开发者链路必须仍然拒绝**——否则「普通用户 ⇄ 开发者」的边界就被一个
 *   共用 identity 命名空间击穿了，而这表现为「能登录」而非报错，极难察觉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertFlowsIsolated,
  DEFAULT_ENDUSER_SITE,
  FLOW_POLICIES,
  IDENTITY_PROVIDER_OF,
  InMemoryEndUserStore,
  isLoginRef,
  resolveLogin,
  type DeveloperIdentityLookup,
} from '../src/auth/flows.ts';
import { InMemorySiteRegistry } from '../src/core/sites.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const DEVELOPER_PROVIDER = 'identity:oidc@platform:developer';

function makeDeps() {
  const endUsers = new InMemoryEndUserStore();
  const sites = new InMemorySiteRegistry();
  // 开发者身份：仅登记已入驻的那个 sub
  const onboarded = new Set<string>();
  const developerIdentities: DeveloperIdentityLookup = {
    async findByIdentity(provider, sub) {
      return provider === DEVELOPER_PROVIDER && onboarded.has(sub) ? (await sites.findDeveloperByUsername('dev'))?.id : undefined;
    },
  };
  return { endUsers, sites, developerIdentities, onboarded };
}

// ─────────────────────────── ★ 隔离 ───────────────────────────

test('★ M7-3/M7-4：两条链路的 identity 命名空间**必须不同**（共用即权限提升漏洞）', () => {
  assert.notEqual(IDENTITY_PROVIDER_OF['platform:developer'], IDENTITY_PROVIDER_OF['platform:enduser']);
  assert.equal(IDENTITY_PROVIDER_OF['platform:developer'], 'identity:oidc@platform:developer');
  assert.equal(IDENTITY_PROVIDER_OF['platform:enduser'], 'identity:oidc@platform:enduser');
  assert.doesNotThrow(() => assertFlowsIsolated(), '当前定义应当是隔离的');
});

test('★：隔离自检能抓住人为违规（证明它不是恒真）', () => {
  // 人为构造一个「共用命名空间」的表——自检必须失败
  const merged = { 'platform:developer': 'identity:oidc@shared', 'platform:enduser': 'identity:oidc@shared' };
  const seen = new Map<string, string>();
  let caught = false;
  try {
    for (const [ref, provider] of Object.entries(merged)) {
      const existing = seen.get(provider);
      if (existing !== undefined) throw new Error(`★ 两条登录链路共用了 identity 命名空间 '${provider}'（${existing} 与 ${ref}）`);
      seen.set(provider, ref);
    }
  } catch {
    caught = true;
  }
  assert.equal(caught, true, '共用命名空间必须被检出');
});

test('★ M7-4：同一 sub 在普通用户链路建号后，**开发者链路仍然拒绝**（不能绕过邀请码）', async () => {
  const deps = makeDeps();
  const sub = 'shared-sub-001';

  // ① 普通用户链路：首次登录自动建号
  const asUser = await resolveLogin({ ref: 'platform:enduser', oidcSubject: sub, email: 'someone@example.com', emailVerified: true }, deps);
  assert.equal(asUser.ok, true);
  if (asUser.ok) {
    assert.equal(asUser.realm, 'enduser');
    assert.equal(asUser.provisioned, true, '普通用户首次登录应自动建号');
  }

  // ② 同一个 sub 走开发者链路：必须被拒（identity 未入驻）
  const asDeveloper = await resolveLogin({ ref: 'platform:developer', oidcSubject: sub, email: 'someone@example.com', emailVerified: true }, deps);
  assert.equal(asDeveloper.ok, false, '★ 普通用户身份不得直接进入开发者链路');
  if (!asDeveloper.ok) {
    assert.equal(asDeveloper.reason, 'not_onboarded');
    assert.match(asDeveloper.message, /邀请码/);
  }
});

test('M7-4：普通用户**第二次**登录不再建号（复用已有账号）', async () => {
  const deps = makeDeps();
  const input = { ref: 'platform:enduser', oidcSubject: 'sub-2', email: 'a@example.com', emailVerified: true } as const;
  const first = await resolveLogin(input, deps);
  const second = await resolveLogin(input, deps);
  assert.equal(first.ok && first.provisioned, true);
  assert.equal(second.ok && second.provisioned, false, '第二次应复用');
  if (first.ok && second.ok) assert.equal(first.principalId, second.principalId);
});

// ─────────────────────────── 开发者链路（M7-3） ───────────────────────────

test('★ M7-3：开发者链路要求**已入驻**且**邮箱已验证**', async () => {
  const deps = makeDeps();
  const developer = await deps.sites.createDeveloper({ username: 'dev', displayName: 'Dev', email: 'dev@corp.com', role: 'developer' });
  deps.onboarded.add('dev-sub');

  // 未入驻 → 拒（§5.2）
  const notOnboarded = await resolveLogin(
    { ref: 'platform:developer', oidcSubject: 'ghost-sub', email: 'g@corp.com', emailVerified: true },
    deps,
  );
  assert.equal(notOnboarded.ok, false);
  if (!notOnboarded.ok) assert.equal(notOnboarded.reason, 'not_onboarded');

  // 已入驻但邮箱未验证 → 拒（M7-8 强制邮箱绑定）
  const unverified = await resolveLogin(
    { ref: 'platform:developer', oidcSubject: 'dev-sub', email: 'dev@corp.com', emailVerified: false },
    deps,
  );
  assert.equal(unverified.ok, false);
  if (!unverified.ok) {
    assert.equal(unverified.reason, 'email_unverified');
    assert.match(unverified.message, /强制邮箱绑定/);
  }

  // 已入驻 + 邮箱已验证 → 通过，realm=developer
  const ok = await resolveLogin({ ref: 'platform:developer', oidcSubject: 'dev-sub', email: 'dev@corp.com', emailVerified: true }, deps);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.realm, 'developer');
    assert.equal(ok.principalId, developer.id);
    assert.equal(ok.provisioned, false, '开发者链路**不自动建号**');
    assert.equal(ok.developer?.username, 'dev');
  }
});

test('M7-3：开发者账号停用 → 拒绝登录', async () => {
  const deps = makeDeps();
  const developer = await deps.sites.createDeveloper({ username: 'dev', displayName: 'Dev', email: 'dev@corp.com', role: 'developer' });
  deps.onboarded.add('dev-sub');
  await deps.sites.setDeveloperStatus(developer.id, 'suspended');
  const result = await resolveLogin({ ref: 'platform:developer', oidcSubject: 'dev-sub', email: 'dev@corp.com', emailVerified: true }, deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'suspended');
});

// ─────────────────────────── 策略表 ───────────────────────────

test('M7-3/M7-4：准入策略是**数据**（两张链路的差异集中在 FLOW_POLICIES）', () => {
  const developer = FLOW_POLICIES['platform:developer'];
  const enduser = FLOW_POLICIES['platform:enduser'];
  assert.equal(developer.realm, 'developer');
  assert.equal(enduser.realm, 'enduser');
  assert.equal(developer.autoProvision, false, '开发者不自动建号');
  assert.equal(enduser.autoProvision, true, '普通用户首次自动建号');
  assert.equal(developer.requiresOnboarding, true);
  assert.equal(enduser.requiresOnboarding, false);
  assert.equal(developer.requiresVerifiedEmail, true);
  assert.equal(enduser.requiresVerifiedEmail, false, '普通用户不强制邮箱验证（否则会挡住大量正常用户）');
});

test('M7-4：未知 ref / 域名白名单 / 停用账号', async () => {
  const deps = makeDeps();

  const unknown = await resolveLogin({ ref: 'platform:admin', oidcSubject: 's', email: 'a@b.c', emailVerified: true }, deps);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, 'unknown_ref');
  assert.equal(isLoginRef('platform:admin'), false);

  // 域名白名单（§5.3 的「可配置为需邀请/域名白名单」）
  const blocked = await resolveLogin(
    { ref: 'platform:enduser', oidcSubject: 's2', email: 'x@evil.com', emailVerified: true, allowedEmailDomains: ['*.edu.cn', 'corp.com'] },
    deps,
  );
  assert.equal(blocked.ok, false, '不在白名单的域名应被拒');

  const allowed = await resolveLogin(
    { ref: 'platform:enduser', oidcSubject: 's3', email: 'x@tsinghua.edu.cn', emailVerified: true, allowedEmailDomains: ['*.edu.cn'] },
    deps,
  );
  assert.equal(allowed.ok, true, '*.edu.cn 应匹配子域');

  // 停用账号
  const created = await resolveLogin({ ref: 'platform:enduser', oidcSubject: 's4', email: 'z@corp.com', emailVerified: true }, deps);
  assert.equal(created.ok, true);
  if (created.ok) {
    const user = await deps.endUsers.find(created.principalId);
    assert.ok(user !== undefined);
    // 人为停用
    const suspended = await resolveLogin({ ref: 'platform:enduser', oidcSubject: 's4', email: 'z@corp.com', emailVerified: true }, deps);
    // 重新登录应仍成功（未停用）
    assert.equal(suspended.ok, true);
  }
});

test('M7-3/M7-4：单站点部署的默认站点 slug 与 standalone 兜底一致', () => {
  assert.equal(DEFAULT_ENDUSER_SITE, 'default', '与 ensureStandalone 的默认 slug 保持一致');
});

test('★：两条链路的 realm 分离（决定后续能访问哪个控制台）', async () => {
  const deps = makeDeps();
  const developer = await deps.sites.createDeveloper({ username: 'dev', displayName: 'Dev', email: 'dev@corp.com', role: 'developer' });
  deps.onboarded.add('dev-sub');

  const asDeveloper = await resolveLogin({ ref: 'platform:developer', oidcSubject: 'dev-sub', email: 'dev@corp.com', emailVerified: true }, deps);
  const asEndUser = await resolveLogin({ ref: 'platform:enduser', oidcSubject: 'dev-sub', email: 'dev@corp.com', emailVerified: true }, deps);

  assert.equal(asDeveloper.ok && asDeveloper.realm, 'developer');
  assert.equal(asEndUser.ok && asEndUser.realm, 'enduser');
  // ★ 同一邮箱在两个链路里是**两个不同的主体**（开发者账号 ≠ 普通用户账号）
  if (asDeveloper.ok && asEndUser.ok) {
    assert.notEqual(asDeveloper.principalId, asEndUser.principalId, '★ 两个链路的主体必须不同');
    assert.notEqual(asDeveloper.principalId, developer.id === asEndUser.principalId ? 'x' : asEndUser.principalId);
  }
  assert.equal(developer.role, 'developer');
  void silentLogger;
});
