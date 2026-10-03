/**
 * 内置插件 `email-domain` 验收（M1-6）。
 *
 * 断言重点：
 *   - **deny 永远优先**（白名单写宽了不该让黑名单失效）；
 *   - **`missing` 与 `is_edu=false` 必须区分**：邮箱缺失/非法 → `null`（走 $onMissing，默认 fail_closed），
 *     而不是 false（那会导致**已授予资格被收回**）；
 *   - `requireVerified` 生效：域名命中但未验证 → 不给 edu 资格；
 *   - manifest 通过契约校验，且**声明为 local**（不伪造网络请求）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compileRule,
  EMAIL_DOMAIN_MANIFEST,
  EmailDomainError,
  evaluateEmailDomain,
  extractDomain,
  isEduDomain,
} from '../src/plugin/builtin/email-domain.ts';
import { checkManifest, validateManifest } from '../src/plugin/manifest.ts';
import { FactPipeline, InMemoryFactStore } from '../src/plugin/host-api.ts';

test('manifest：email-domain 通过契约校验，且以 local 形态声明（不伪造 collect）', () => {
  const issues = checkManifest(EMAIL_DOMAIN_MANIFEST);
  assert.deepEqual(issues.filter((i) => i.severity === 'error'), []);
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  assert.equal(manifest.local, true);
  assert.equal(manifest.collect, undefined, 'local 插件不得声明 collect');
});

test('manifest：local:true 与 collect 并存 → 报错（事实来源必须唯一）', () => {
  const issues = checkManifest({
    ...EMAIL_DOMAIN_MANIFEST,
    collect: { request: { method: 'GET', url: 'https://x.com' }, extract: [{ path: '$.a', as: 'a' }] },
  }).filter((i) => i.severity === 'error');
  assert.ok(issues.some((i) => i.path === 'collect'));
});

test('extractDomain：大小写归一、非法邮箱返回 null', () => {
  assert.equal(extractDomain('Alice@Tsinghua.EDU.CN'), 'tsinghua.edu.cn');
  assert.equal(extractDomain('a@b'), null, '缺少 TLD');
  assert.equal(extractDomain('no-at-sign'), null);
  assert.equal(extractDomain('@x.com'), null);
  assert.equal(extractDomain('a@'), null);
  assert.equal(extractDomain('a b@x.com'), null);
  assert.equal(extractDomain(null), null);
  assert.equal(extractDomain(undefined), null);
});

test('isEduDomain：覆盖 edu / edu.cn / ac.uk / ac.jp 等教育后缀', () => {
  for (const domain of ['tsinghua.edu.cn', 'mit.edu', 'ox.ac.uk', 'u-tokyo.ac.jp', 'nus.edu.sg']) {
    assert.equal(isEduDomain(domain), true, `${domain} 应判为教育域`);
  }
  for (const domain of ['gmail.com', 'qq.com', 'edu.com', 'notedu.cn', 'ac.com']) {
    assert.equal(isEduDomain(domain), false, `${domain} 不应判为教育域`);
  }
});

test('规则编译：通配/后缀/精确/正则四类，且正则必须显式加斜杠', () => {
  assert.equal(compileRule('*.edu.cn').test('tsinghua.edu.cn'), true);
  assert.equal(compileRule('*.edu.cn').test('edu.cn'), true);
  assert.equal(compileRule('*.edu.cn').test('fake-edu.cn'), false);
  assert.equal(compileRule('@corp.com').test('corp.com'), true);
  assert.equal(compileRule('@corp.com').test('mail.corp.com'), true);
  assert.equal(compileRule('example.com').test('example.com'), true);
  assert.equal(compileRule('example.com').test('sub.example.com'), false, '精确匹配不含子域');
  assert.equal(compileRule('/^.*\\.edu$/').test('mit.edu'), true);
  assert.throws(() => compileRule('/[/'), EmailDomainError);
});

test('★ deny 永远优先：同时命中 allow 与 deny → 判定为拒绝', () => {
  const facts = evaluateEmailDomain({
    email: 'alice@tsinghua.edu.cn',
    emailVerified: true,
    config: { allowDomains: ['*.edu.cn', '*.edu'], denyDomains: ['tsinghua.edu.cn'] },
  });
  assert.equal(facts!.is_edu, false);
  assert.equal(facts!.matched_rule, 'deny:tsinghua.edu.cn');
});

test('allow 优先级：priority 数字小优先；未配置的按声明顺序靠后', () => {
  const facts = evaluateEmailDomain({
    email: 'alice@mail.corp.com',
    emailVerified: true,
    config: {
      allowDomains: ['*.corp.com', '@mail.corp.com'],
      priority: { '*.corp.com': 10, '@mail.corp.com': 1 },
    },
  });
  assert.equal(facts!.matched_rule, 'allow:@mail.corp.com', 'priority 小的先命中');

  const orderOnly = evaluateEmailDomain({
    email: 'alice@mail.corp.com',
    emailVerified: true,
    config: { allowDomains: ['@mail.corp.com', '*.corp.com'] },
  });
  assert.equal(orderOnly!.matched_rule, 'allow:@mail.corp.com', '未配置 priority 时按声明顺序');
});

test('requireVerified：域名命中但未验证 → matched_rule 命中但不给 edu 资格', () => {
  const verified = evaluateEmailDomain({
    email: 'alice@tsinghua.edu.cn',
    emailVerified: true,
    config: { allowDomains: ['*.edu.cn'], requireVerified: true },
  });
  assert.equal(verified!.is_edu, true);
  assert.equal(verified!.verified, true);

  const unverified = evaluateEmailDomain({
    email: 'alice@tsinghua.edu.cn',
    emailVerified: false,
    config: { allowDomains: ['*.edu.cn'], requireVerified: true },
  });
  assert.equal(unverified!.is_edu, false, '未验证不得给资格');
  assert.equal(unverified!.matched_rule, 'allow:*.edu.cn', '但仍能看出域名命中了规则（便于展示「去验证邮箱」）');

  const notRequired = evaluateEmailDomain({
    email: 'alice@tsinghua.edu.cn',
    emailVerified: false,
    config: { allowDomains: ['*.edu.cn'], requireVerified: false },
  });
  assert.equal(notRequired!.is_edu, true, 'requireVerified=false 时不要求验证');
});

test('未命中任何 allow：即使域名是 edu 也不给资格（白名单未声明即不允许）', () => {
  const facts = evaluateEmailDomain({
    email: 'alice@tsinghua.edu.cn',
    emailVerified: true,
    config: { allowDomains: ['@corp.com'] },
  });
  assert.equal(facts!.is_edu, false);
  assert.equal(facts!.matched_rule, 'none');
});

test('★ missing 与 false 必须区分：邮箱缺失/非法 → null（走 $onMissing，默认 fail_closed）', () => {
  assert.equal(evaluateEmailDomain({ email: null, emailVerified: true, config: { allowDomains: ['*.edu.cn'] } }), null);
  assert.equal(evaluateEmailDomain({ email: 'garbage', emailVerified: true, config: { allowDomains: ['*.edu.cn'] } }), null);

  // 对照：合法但未命中白名单 → 明确 false（不是 missing）
  const decided = evaluateEmailDomain({ email: 'a@gmail.com', emailVerified: true, config: { allowDomains: ['*.edu.cn'] } });
  assert.notEqual(decided, null);
  assert.equal(decided!.is_edu, false);
});

test('事实管线：email-domain 产出的事实能过 schema 并带命名空间落库', async () => {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const pipeline = new FactPipeline({ store: new InMemoryFactStore(), manifest, userId: 'u1' });
  const now = new Date('2025-06-01T00:00:00Z');

  const facts = evaluateEmailDomain({
    email: 'alice@tsinghua.edu.cn',
    emailVerified: true,
    config: { allowDomains: ['*.edu.cn'], requireVerified: true },
  });
  assert.notEqual(facts, null);
  const { written } = await pipeline.emit({ ...facts }, now);
  assert.deepEqual(written.sort(), ['email.domain', 'email.is_edu', 'email.matched_rule', 'email.verified']);

  const domain = await pipeline.get('domain', now);
  assert.equal(domain!.value, 'tsinghua.edu.cn');
  const isEdu = await pipeline.get('is_edu', now);
  assert.equal(isEdu!.value, true);
  // TTL 来自 manifest.factTtl = 30d
  assert.equal(isEdu!.expiresAt.toISOString(), new Date(now.getTime() + 30 * 86_400_000).toISOString());
});

test('事实管线：email-domain 的事实字段若被写错（未声明字段）会被拒绝', async () => {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const pipeline = new FactPipeline({ store: new InMemoryFactStore(), manifest, userId: 'u1' });
  await assert.rejects(pipeline.emit({ domain: 'x.com', matched_rule: 'none', oops: 1 }), /未在 factSchema 中声明/);
});
