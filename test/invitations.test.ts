/**
 * 开发者入驻验收（M7-2 / M7-8）—— docs/08 §5.1、§5.2。
 *
 * 断言主线是**滥用防护**，而不是「流程能走通」：
 *   - **只存 hash**：库里绝无明文码（邀请码等价于「一次性开户凭据」）；
 *   - **★ 原子核销**：并发核销**只有一个成功**——否则会建出两个开发者账号；
 *   - **邮箱匹配**：邀请链接被转发到群里也抢不走（且错误信息不透露目标邮箱）；
 *   - **★ 强制邮箱绑定**（M7-8）：未验证邮箱不得入驻；
 *   - **TTL 硬夹 1 小时**：安全参数不能由请求方决定；
 *   - **§5.2 未入驻不得登录**（与普通用户「首次自动建号」形成显式对照）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertDeveloperMayLogin,
  DEVELOPER_IDENTITY_PROVIDER,
  ENDUSER_AUTO_PROVISION_NOTE,
  generateInvitationCode,
  hashInvitationCode,
  InMemoryInvitationStore,
  INVITATION_ALPHABET,
  INVITATION_TTL_MAX_MS,
  InvitationError,
  InvitationService,
  normalizeInvitationCode,
} from '../src/core/invitations.ts';
import { InMemorySiteRegistry } from '../src/core/sites.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeService() {
  const store = new InMemoryInvitationStore();
  const sites = new InMemorySiteRegistry();
  const service = new InvitationService({ store, sites, onboardIdentity: async () => undefined, logger: silentLogger, now: () => NOW });
  return { store, sites, service };
}

async function seedSite(sites: InMemorySiteRegistry, slug = 'main') {
  const owner = await sites.createDeveloper({ username: `owner-${slug}`, displayName: 'Owner', email: 'owner@example.com', role: 'admin' });
  await sites.createSite({ siteId: slug, nickname: '站点', developerId: owner.id });
  return owner;
}

// ─────────────────────────── 码的生成与存储 ───────────────────────────

test('★ M7-2：库里**只有 hash**，没有明文码（邀请码 = 一次性开户凭据）', async () => {
  const { store, sites, service } = makeService();
  await seedSite(sites);

  const created = await service.create({ siteId: 'main', targetEmail: 'dev@corp.com', createdBy: 'admin-1' });
  assert.match(created.code, /^DEV-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(created.codePrefix, created.code.slice(0, 8));

  const stored = await store.list('main');
  assert.equal(stored.length, 1);
  const invitation = stored[0]!;
  // ★ 关键：任何持久化字段都不等于明文码
  for (const [key, value] of Object.entries(invitation)) {
    assert.notEqual(value, created.code, `字段 ${key} 不得等于明文码`);
  }
  assert.equal(invitation.codeHash, hashInvitationCode(created.code), '只存 hash');
  assert.notEqual(invitation.codeHash, created.code);
  assert.equal(invitation.codePrefix, created.code.slice(0, 8), '前缀仅供管理员辨认');
  assert.ok(created.code.length > invitation.codePrefix.length, '前缀不足以还原明文');
});

test('M7-2：码归一 —— 大小写 / 空格 / 易混字符都能识别', () => {
  assert.equal(normalizeInvitationCode('dev-abcd-2345'), 'DEVABCD2345', '★ 连字符也去掉（归一为纯字母数字）');
  assert.equal(normalizeInvitationCode('DEV ABCD 2345'), 'DEVABCD2345');
  // ★ 连字符与空格混用也要归一（用户抄写格式千变万化）
  assert.equal(normalizeInvitationCode('DEV 7F3A-K92M'), 'DEV7F3AK92M');
  assert.equal(normalizeInvitationCode('dev-7f3a-k92m'), 'DEV7F3AK92M');
  assert.equal(normalizeInvitationCode('O'), '0');
  assert.equal(normalizeInvitationCode('I'), '1');
  // 字符集排除易混字符
  assert.equal(/[0O1IL]/.test(INVITATION_ALPHABET), false);

  // 端到端：用小写 + 空格输入也能核销
  const codes = new Set(Array.from({ length: 200 }, () => generateInvitationCode()));
  assert.equal(codes.size, 200, '200 次生成不应重复');
});

// ─────────────────────────── TTL ───────────────────────────

test('★ M7-2：TTL **服务端硬夹 1 小时**（安全参数不能由请求方决定）', async () => {
  const { sites, service } = makeService();
  await seedSite(sites);

  // 请求 30 天 → 实际只有 1 小时
  const long = await service.create({ siteId: 'main', targetEmail: 'a@b.c', ttlMs: 30 * 24 * 3_600_000, createdBy: 'admin' });
  const effective = long.expiresAt.getTime() - NOW.getTime();
  assert.equal(effective, INVITATION_TTL_MAX_MS, '★ 超过上限的 TTL 应被夹到 1 小时');
  assert.equal(effective, 3_600_000);

  // 请求 10 分钟 → 尊重请求
  const short = await service.create({ siteId: 'main', targetEmail: 'd@e.f', ttlMs: 10 * 60_000, createdBy: 'admin' });
  assert.equal(short.expiresAt.getTime() - NOW.getTime(), 10 * 60_000);

  // 请求过短 → 下限 1 分钟（避免生成「立刻过期」的码）
  const tiny = await service.create({ siteId: 'main', targetEmail: 'g@h.i', ttlMs: 1, createdBy: 'admin' });
  assert.equal(tiny.expiresAt.getTime() - NOW.getTime(), 60_000);
});

test('M7-2：targetEmail 必须是合法邮箱（邀请码必须绑定邮箱）', async () => {
  const { sites, service } = makeService();
  await seedSite(sites);
  await assert.rejects(service.create({ siteId: 'main', targetEmail: 'not-an-email', createdBy: 'admin' }), InvitationError);
});

// ─────────────────────────── 核销校验链 ───────────────────────────

test('★ M7-2：完整入驻链路（校验 → 原子核销 → 建账号 + 站点）', async () => {
  const { sites, service } = makeService();
  await seedSite(sites, 'main');
  const created = await service.create({ siteId: 'main', targetEmail: 'dev@corp.com', createdBy: 'admin-1' });

  const result = await service.redeem({
    siteId: 'main',
    code: created.code.toLowerCase().replace('-', ' '),
    email: 'DEV@corp.com', // 大小写不敏感
    emailVerified: true,
    oidcSubject: 'oidc-sub-1',
  });

  assert.equal(result.developer.role, 'developer');
  assert.equal(result.developer.email, 'dev@corp.com');
  assert.equal(result.developer.emailVerified, true);
  assert.equal(result.site.siteId, 'main', 'siteMode=auto 且站点已存在 → 复用');
  assert.equal(result.siteCreated, false);

  // 邀请码已核销
  const stored = await service.list('main');
  assert.equal(stored[0]!.usedCount, 1);
  assert.equal(stored[0]!.usedBy, 'oidc-sub-1');
});

test('★ M7-2：**邮箱不匹配 → 拒绝**（邀请链接被转发也抢不走），且不透露目标邮箱', async () => {
  const { sites, service } = makeService();
  await seedSite(sites);
  const created = await service.create({ siteId: 'main', targetEmail: 'dev@corp.com', createdBy: 'admin' });

  await assert.rejects(
    service.redeem({ siteId: 'main', code: created.code, email: 'attacker@evil.com', emailVerified: true, oidcSubject: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof InvitationError);
      assert.equal(error.code, 'email_mismatch');
      assert.match(error.message, /不可转发他人使用/);
      // ★ 错误信息不得包含目标邮箱（否则可枚举「这个码邀请的是谁」）
      assert.equal(error.message.includes('dev@corp.com'), false, '★ 不得泄露目标邮箱');
      return true;
    },
  );
});

test('★ M7-8：**强制邮箱绑定** —— 邮箱未验证不得入驻', async () => {
  const { sites, service } = makeService();
  await seedSite(sites);
  const created = await service.create({ siteId: 'main', targetEmail: 'dev@corp.com', createdBy: 'admin' });

  await assert.rejects(
    service.redeem({ siteId: 'main', code: created.code, email: 'dev@corp.com', emailVerified: false, oidcSubject: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof InvitationError);
      assert.equal(error.code, 'email_not_verified');
      assert.match(error.message, /强制邮箱绑定/);
      return true;
    },
  );
  // 未验证的尝试**不得**消耗额度
  const stored = await service.list('main');
  assert.equal(stored[0]!.usedCount, 0, '★ 校验失败不得核销邀请码');
});

test('M7-2：过期 / 用尽 / 不存在 → 各自明确报错', async () => {
  const store = new InMemoryInvitationStore();
  const sites = new InMemorySiteRegistry();
  await seedSite(sites);

  // 过期：用可控时钟
  let clock = NOW;
  const service = new InvitationService({ store, sites, onboardIdentity: async () => undefined, logger: silentLogger, now: () => clock });
  const created = await service.create({ siteId: 'main', targetEmail: 'a@b.c', ttlMs: 60_000, createdBy: 'admin' });
  clock = new Date(NOW.getTime() + 61_000);
  await assert.rejects(service.redeem({ siteId: 'main', code: created.code, email: 'a@b.c', emailVerified: true, oidcSubject: 'x' }), (error: unknown) => {
    assert.ok(error instanceof InvitationError);
    assert.equal(error.code, 'expired');
    assert.match(error.message, /有效期最长 1 小时/);
    return true;
  });

  // 不存在
  clock = NOW;
  await assert.rejects(service.redeem({ siteId: 'main', code: 'DEV-ZZZZ-ZZZZ', email: 'a@b.c', emailVerified: true, oidcSubject: 'x' }), (error: unknown) => {
    assert.ok(error instanceof InvitationError);
    assert.equal(error.code, 'not_found');
    return true;
  });

  // 用尽（maxUses=1，已用一次）
  const single = await service.create({ siteId: 'main', targetEmail: 'z@z.z', createdBy: 'admin' });
  await service.redeem({ siteId: 'main', code: single.code, email: 'z@z.z', emailVerified: true, oidcSubject: 'sub-z' });
  await assert.rejects(service.redeem({ siteId: 'main', code: single.code, email: 'z@z.z', emailVerified: true, oidcSubject: 'sub-z2' }), (error: unknown) => {
    assert.ok(error instanceof InvitationError);
    assert.equal(error.code, 'exhausted');
    return true;
  });
});

// ─────────────────────────── ★ 原子核销 ───────────────────────────

test('★ M7-2：**原子核销** —— 并发核销只有一个成功（否则会建出两个开发者账号）', async () => {
  const { sites, service } = makeService();
  await seedSite(sites);
  // 允许 1 次使用
  const created = await service.create({ siteId: 'main', targetEmail: 'dev@corp.com', uses: 1, createdBy: 'admin' });

  // 同时发起 5 次核销（同一邮箱、同一码）
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      service.redeem({ siteId: 'main', code: created.code, email: 'dev@corp.com', emailVerified: true, oidcSubject: `sub-${index}` }),
    ),
  );
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled').length;
  assert.equal(fulfilled, 1, `★ 只能有 1 次成功（实际 ${fulfilled}）`);

  const stored = await service.list('main');
  assert.equal(stored[0]!.usedCount, 1, '★ 核销计数不得被并发突破');

  // 只有一个开发者账号被建出（成功的那个）
  const developer = await sites.findDeveloperByUsername('dev');
  assert.ok(developer !== undefined, '成功的核销应建出开发者账号');
  assert.equal(developer.email, 'dev@corp.com');
});

test('★ M7-2：多次使用的邀请码（uses=3）可按额度依次核销，超出即拒', async () => {
  const { sites, service } = makeService();
  await seedSite(sites);
  // 同一邮箱 3 次（实际场景是同一人重试或团队共享——这里验证额度语义）
  const created = await service.create({ siteId: 'main', targetEmail: 'dev@corp.com', uses: 3, createdBy: 'admin' });

  for (let i = 0; i < 3; i += 1) {
    const result = await service.redeem({
      siteId: 'main',
      code: created.code,
      email: 'dev@corp.com',
      emailVerified: true,
      oidcSubject: `sub-${i}`,
      username: `dev-${i}`, // 避免同名复用掩盖账号创建
    });
    assert.equal(result.developer.email, 'dev@corp.com');
  }
  const stored = await service.list('main');
  assert.equal(stored[0]!.usedCount, 3);

  await assert.rejects(
    service.redeem({ siteId: 'main', code: created.code, email: 'dev@corp.com', emailVerified: true, oidcSubject: 'sub-x', username: 'dev-x' }),
    (error: unknown) => {
      assert.ok(error instanceof InvitationError);
      assert.equal(error.code, 'exhausted');
      return true;
    },
  );
});

// ─────────────────────────── siteMode ───────────────────────────

test('M7-2：siteMode=auto 且站点不存在 → 自动建站点；existing → 加入签发站点', async () => {
  const { sites, service } = makeService();
  // 只建开发者，不建站点（模拟「还没站点」）
  const owner = await sites.createDeveloper({ username: 'owner', displayName: 'O', email: 'o@e.com', role: 'admin' });
  await sites.createSite({ siteId: 'inviter-site', nickname: '邀请方站点', developerId: owner.id });

  // auto：目标站点不存在 → 建出来
  const auto = await service.create({ siteId: 'new-site', targetEmail: 'a@b.c', siteMode: 'auto', createdBy: 'admin' });
  const autoResult = await service.redeem({ siteId: 'new-site', code: auto.code, email: 'a@b.c', emailVerified: true, oidcSubject: 's1' });
  assert.equal(autoResult.siteCreated, true);
  assert.equal(autoResult.site.siteId, 'new-site');
  assert.equal(autoResult.site.developerId, autoResult.developer.id, '新建站点归属入驻的开发者');

  // existing：加入签发邀请码的站点（`site_id` 作用域列即目标站点）
  const existing = await service.create({ siteId: 'inviter-site', targetEmail: 'd@e.f', siteMode: 'existing', createdBy: 'admin' });
  const existingResult = await service.redeem({ siteId: 'inviter-site', code: existing.code, email: 'd@e.f', emailVerified: true, oidcSubject: 's2' });
  assert.equal(existingResult.siteCreated, false);
  assert.equal(existingResult.site.siteId, 'inviter-site');
  assert.equal(existingResult.site.developerId, owner.id, 'existing 模式不改站点归属');
});

// ─────────────────────────── §5.2 不可注册 ───────────────────────────

test('★ M7-2：**未入驻的开发者身份不得登录**（与普通用户「首次自动建号」形成显式对照）', async () => {
  const sites = new InMemorySiteRegistry();
  const developer = await sites.createDeveloper({ username: 'dev', displayName: 'Dev', email: 'd@e.f', role: 'developer' });

  // 已入驻：identity 命中 → 允许
  const onboarded = await assertDeveloperMayLogin(
    { findByIdentity: async (provider, sub) => (provider === DEVELOPER_IDENTITY_PROVIDER && sub === 'sub-1' ? developer.id : undefined) },
    sites,
    { oidcSubject: 'sub-1' },
  );
  assert.equal(onboarded.ok, true);

  // 未入驻：identity 未命中 → 拒绝，并给出可操作的指引
  const unknown = await assertDeveloperMayLogin({ findByIdentity: async () => undefined }, sites, { oidcSubject: 'ghost' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.reason, 'not_onboarded');
    assert.match(unknown.message, /尚未入驻/);
    assert.match(unknown.message, /邀请码/, '错误信息要告诉用户下一步怎么做');
  }

  // 已入驻但账号停用 → 拒绝
  await sites.setDeveloperStatus(developer.id, 'suspended');
  const suspended = await assertDeveloperMayLogin(
    { findByIdentity: async () => developer.id },
    sites,
    { oidcSubject: 'sub-1' },
  );
  assert.equal(suspended.ok, false);
  if (!suspended.ok) assert.equal(suspended.reason, 'suspended');
});

test('M7-2：两条链路的差异是**显式**的（避免靠隐式条件区分）', () => {
  assert.match(ENDUSER_AUTO_PROVISION_NOTE, /自动建号/);
  assert.match(ENDUSER_AUTO_PROVISION_NOTE, /开发者必须凭邀请码入驻/);
});

// ─────────────────────────── 站点隔离 ───────────────────────────

test('M7-2：邀请码按站点隔离（A 站点的码不能用于 B 站点）', async () => {
  const { sites, service } = makeService();
  await seedSite(sites, 'site-a');
  await seedSite(sites, 'site-b');

  const created = await service.create({ siteId: 'site-a', targetEmail: 'dev@corp.com', createdBy: 'admin' });
  await assert.rejects(
    service.redeem({ siteId: 'site-b', code: created.code, email: 'dev@corp.com', emailVerified: true, oidcSubject: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof InvitationError);
      assert.equal(error.code, 'not_found', '★ 跨站点使用应表现为「不存在」（不泄露其它站点有码）');
      return true;
    },
  );
});
