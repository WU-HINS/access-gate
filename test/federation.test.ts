/**
 * OIDC 双向联邦验收（M5-6）。
 *
 * 验收标准：**「用户可用项目账号登录平台」**（inbound 联邦登录）。
 *
 * 本文件的中心断言是**最小暴露**：未在 `exposedClaims` 里声明的 claim
 * **既不落库也不可见**——而不是「存下来但查询时过滤」。
 * 后者只要有一次「查询忘了加过滤」，就是全量身份信息泄露。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscoveryDocument,
  claimAddressOf,
  isClaimAddressable,
  isExternalRef,
  isPlatformRef,
  projectExposedClaims,
  RESERVED_PLATFORM_REFS,
  resolveFederatedLogin,
  validateDiscoveryDocument,
  validateRefChange,
  validateRegistration,
  type OidcProviderRegistration,
} from '../src/auth/federation.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

const INBOUND: OidcProviderRegistration = {
  ref: 'external:github',
  direction: 'inbound',
  displayName: '用 GitHub 登录',
  issuer: 'https://github.com',
  clientId: 'cid',
  clientSecretRef: 'oidc.github.secret',
  scopes: ['openid', 'profile', 'email'],
  // ★ 只暴露三个（其余一律丢弃）
  exposedClaims: ['email', 'email_verified', 'preferred_username'],
  allowPlatformLogin: true,
  status: 'active',
  createdAt: NOW,
};

// ═══════════════════════════ ★ 最小暴露 ═══════════════════════════

test('★ M5-6：未声明的 claim **既不落库也不可见**（过滤发生在写入之前）', () => {
  const raw = {
    email: 'alice@example.com',
    email_verified: true,
    preferred_username: 'alice',
    // 以下都**未声明** —— 必须被丢弃
    name: 'Alice Zhang',
    phone_number: '+86 138...',
    groups: ['internal-admins'],
    address: { street: '...' },
    sub: '12345',
  };
  const projection = projectExposedClaims(raw, INBOUND.exposedClaims);

  // ★ 关键：投影结果里**只有**声明的三个
  assert.deepEqual(Object.keys(projection.projected).sort(), ['email', 'email_verified', 'preferred_username']);
  assert.equal('phone_number' in projection.projected, false, '★ 手机号不得落库');
  assert.equal('groups' in projection.projected, false, '★ 群组不得落库（它常被用来判断内部权限）');
  assert.equal('address' in projection.projected, false);
  assert.equal('name' in projection.projected, false);
  // 丢弃清单只记名字
  assert.deepEqual(projection.dropped, ['address', 'groups', 'name', 'phone_number', 'sub']);
  // 可寻址清单
  assert.deepEqual(projection.addressable, ['email', 'email_verified', 'preferred_username']);
});

test('★ M5-6：`dropped` **只记名字、不记值**（否则等于换个地方泄露）', () => {
  const { sink, records } = collectingSink();
  const result = resolveFederatedLogin(
    {
      registration: INBOUND,
      subject: '12345',
      rawClaims: { email: 'a@b.c', phone_number: '+86 13800000000', groups: ['secret-team'] },
      targetRef: 'platform:enduser',
      emailVerified: true,
    },
    createLogger({ level: 'debug', sink }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.claims, { email: 'a@b.c' }, '★ 只有声明的 claim 进入持久化对象');
    assert.deepEqual(result.droppedClaims, ['groups', 'phone_number']);
  }
  // 日志里必须只有名字，没有值
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes('13800000000'), false, '★ 日志不得出现被丢弃 claim 的值');
  assert.equal(serialized.includes('secret-team'), false, '★ 群组值也不得出现在日志');
  assert.match(serialized, /phone_number/, '但名字要记（排障需要知道丢了什么）');
});

test('★ M5-6：`exposedClaims` 为空 → 什么都不暴露（合法的保守配置）', () => {
  const projection = projectExposedClaims({ email: 'a@b.c', sub: '1' }, []);
  assert.deepEqual(projection.projected, {});
  assert.deepEqual(projection.addressable, []);
  assert.deepEqual(projection.dropped, ['email', 'sub']);
});

test('★ M5-6：表达式寻址路径 `identity:oidc@<ref>.<claim>` 与声明一致', () => {
  assert.equal(claimAddressOf('external:github', 'email'), 'identity:oidc@external:github.email');
  assert.equal(isClaimAddressable('external:github', 'email', INBOUND), true);
  assert.equal(isClaimAddressable('external:github', 'phone_number', INBOUND), false, '★ 未声明的 claim 不可寻址');
});

// ═══════════════════════════ ref 规则 ═══════════════════════════

test('★ M5-6：**ref 不可变**（改名会让所有引用它的策略静默失效）', () => {
  const issues = validateRefChange('external:github', 'external:gh');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.code, 'ref_changed');
  assert.match(issues[0]!.message, /静默失效/);
  assert.match(issues[0]!.message, /资格莫名其妙没了/, '要说明用户侧的表现');
  // 同名不算修改
  assert.deepEqual(validateRefChange('external:github', 'external:github'), []);
});

test('★ M5-6：**站点不得注册 `platform:*`**（否则能伪造平台链路、绕过准入策略）', () => {
  const denied = validateRegistration(
    { ...INBOUND, ref: 'platform:developer', direction: 'outbound' },
    { actor: 'site' },
  );
  assert.ok(denied.some((issue) => issue.code === 'platform_ref_reserved'));
  const issue = denied.find((entry) => entry.code === 'platform_ref_reserved')!;
  assert.match(issue.message, /平台保留/);
  assert.match(issue.message, /绕过准入策略/);

  // 平台自己可以注册
  assert.deepEqual(
    validateRegistration({ ...INBOUND, ref: 'platform:developer' }, { actor: 'platform' }).filter((issue) => issue.code === 'platform_ref_reserved'),
    [],
  );
  // 站点注册 external:* 正常
  assert.deepEqual(validateRegistration(INBOUND, { actor: 'site' }), []);
});

test('M5-6：ref 格式、issuer 安全性、openid scope 各自校验', () => {
  assert.ok(validateRegistration({ ...INBOUND, ref: 'github' }, { actor: 'site' }).some((issue) => issue.code === 'bad_ref_format'));
  assert.ok(validateRegistration({ ...INBOUND, issuer: 'http://idp.example.com' }, { actor: 'site' }).some((issue) => issue.code === 'insecure_issuer'));
  // 本地开发地址放行
  assert.equal(
    validateRegistration({ ...INBOUND, issuer: 'http://localhost:8080' }, { actor: 'site' }).some((issue) => issue.code === 'insecure_issuer'),
    false,
  );
  assert.ok(validateRegistration({ ...INBOUND, scopes: ['profile'] }, { actor: 'site' }).some((issue) => issue.code === 'missing_scope'));
  // 重复注册
  assert.ok(validateRegistration(INBOUND, { actor: 'site', existingRefs: ['external:github'] }).some((issue) => issue.code === 'ref_changed'));
  // ref 前缀判定
  assert.equal(isPlatformRef('platform:developer'), true);
  assert.equal(isExternalRef('external:github'), true);
  assert.equal(isExternalRef('platform:developer'), false);
  assert.deepEqual(RESERVED_PLATFORM_REFS, ['platform:developer', 'platform:enduser']);
});

// ═══════════════════════════ 联邦登录 ═══════════════════════════

test('★ M5-6：**用户可用项目账号登录平台**（inbound 走通）', () => {
  const result = resolveFederatedLogin({
    registration: INBOUND,
    subject: '12345',
    rawClaims: { email: 'alice@example.com', email_verified: true, preferred_username: 'alice', name: 'Alice' },
    targetRef: 'platform:enduser',
    emailVerified: true,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.federatedId, 'external:github:12345', '★ 用 ref:sub（不同 IdP 的 sub 可能撞车）');
    assert.equal(result.provider, 'external:github');
    assert.deepEqual(Object.keys(result.claims).sort(), ['email', 'email_verified', 'preferred_username']);
    assert.equal(result.targetRef, 'platform:enduser', '交给 flows.ts 做准入判定（本模块不决定准入）');
  }
});

test('★ M5-6：**outbound 注册不能用于登录平台**（方向必须匹配）', () => {
  const outbound: OidcProviderRegistration = { ...INBOUND, ref: 'platform:developer', direction: 'outbound' };
  const result = resolveFederatedLogin({ registration: outbound, subject: 'x', rawClaims: {}, targetRef: 'platform:developer', emailVerified: true });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'login_not_allowed');
    assert.match(result.message, /平台作为 IdP/);
  }
});

test('M5-6：停用的注册、缺失的 sub 都被拒', () => {
  const disabled = resolveFederatedLogin({ registration: { ...INBOUND, status: 'disabled' }, subject: 'x', rawClaims: {}, targetRef: 'platform:enduser', emailVerified: true });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.code, 'provider_disabled');

  const noSub = resolveFederatedLogin({ registration: INBOUND, subject: '  ', rawClaims: {}, targetRef: 'platform:enduser', emailVerified: true });
  assert.equal(noSub.ok, false);
  if (!noSub.ok) {
    assert.equal(noSub.code, 'subject_missing');
    assert.match(noSub.message, /无法建立稳定身份/);
  }
});

test('★ M5-6：`federatedId` 带 ref 前缀 —— 不同 IdP 的相同 sub 不撞车', () => {
  const a = resolveFederatedLogin({ registration: INBOUND, subject: '1', rawClaims: {}, targetRef: 'platform:enduser', emailVerified: true });
  const b = resolveFederatedLogin(
    { registration: { ...INBOUND, ref: 'external:gitlab' }, subject: '1', rawClaims: {}, targetRef: 'platform:enduser', emailVerified: true },
  );
  assert.equal(a.ok && b.ok, true);
  if (a.ok && b.ok) {
    assert.notEqual(a.federatedId, b.federatedId, '★ 同一个 sub "1" 在两个 IdP 下是两个人');
  }
});

// ═══════════════════════════ 发现文档 ═══════════════════════════

test('★ M5-6：发现文档要求 **PKCE S256 且不含 plain**', () => {
  const document = buildDiscoveryDocument('https://gate.example.com/', ['ES256', 'RS256']);
  assert.deepEqual(document.code_challenge_methods_supported, ['S256']);
  assert.equal(document.code_challenge_methods_supported.includes('plain'), false, '★ 允许 plain 等于允许不加密的 challenge');
  assert.equal(document.issuer, 'https://gate.example.com', '末尾斜杠被归一化');
  assert.deepEqual(document.response_types_supported, ['code'], '隐式流已废弃');
  assert.equal(document.jwks_uri, 'https://gate.example.com/oauth/jwks.json');
});

test('★ M5-6：远端发现文档校验 —— **issuer 不一致即拒绝**（混淆攻击）', () => {
  const issues = validateDiscoveryDocument(
    { issuer: 'https://attacker.example.com', response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'] },
    { expectedIssuer: 'https://idp.example.com', allowedAlgorithms: ['RS256', 'ES256'] },
  );
  assert.ok(issues.some((issue) => issue.code === 'insecure_issuer'));
  assert.match(issues.find((issue) => issue.code === 'insecure_issuer')!.message, /混淆攻击/);
});

test('★ M5-6：拒绝 `none` 签名算法与「算法无交集」', () => {
  const none = validateDiscoveryDocument(
    { issuer: 'https://idp.example.com', response_types_supported: ['code'], id_token_signing_alg_values_supported: ['none', 'RS256'] },
    { expectedIssuer: 'https://idp.example.com', allowedAlgorithms: ['RS256'] },
  );
  assert.ok(none.some((issue) => /none/.test(issue.message)), '★ 未签名的 id_token 不可接受');

  const disjoint = validateDiscoveryDocument(
    { issuer: 'https://idp.example.com', response_types_supported: ['code'], id_token_signing_alg_values_supported: ['HS256'] },
    { expectedIssuer: 'https://idp.example.com', allowedAlgorithms: ['RS256', 'ES256'] },
  );
  assert.ok(disjoint.some((issue) => /无交集/.test(issue.message)));

  // 合法文档无问题
  assert.deepEqual(
    validateDiscoveryDocument(
      { issuer: 'https://idp.example.com', response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256', 'ES256'] },
      { expectedIssuer: 'https://idp.example.com', allowedAlgorithms: ['RS256'] },
    ),
    [],
  );
});

test('M5-6：不支持 code 授权类型的远端被拒', () => {
  const issues = validateDiscoveryDocument(
    { issuer: 'https://idp.example.com', response_types_supported: ['id_token'], id_token_signing_alg_values_supported: ['RS256'] },
    { expectedIssuer: 'https://idp.example.com', allowedAlgorithms: ['RS256'] },
  );
  assert.ok(issues.some((issue) => /隐式流/.test(issue.message)));
});
