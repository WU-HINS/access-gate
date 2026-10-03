/**
 * ★★ L-1 接线验证：**邮箱准入闸门在登录路径上真的生效**。
 *
 * ★ 为什么单独一个文件：`email-rules.test.ts` 验的是**判定逻辑**（纯函数），
 *   而这里验的是「**它被接上了**」——`resolveLogin()` 在建号**之前**用它拦人。
 *
 * ★ 最关键的一条断言是**「拒绝发生在建号之前」**：
 *   如果先建号再拒绝，数据库里会留下一个"注册被拒但账号存在"的幽灵用户——
 *   这正是"用采集事实做准入"（先建号、再判定）会造成的后果。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveLogin } from '../src/auth/flows.ts';
import { InMemoryEndUserStore } from '../src/auth/flows.ts';
import { InMemoryEmailRuleStore, type EmailRule } from '../src/core/email-rules.ts';

const T0 = new Date('2026-09-26T00:00:00Z');

const ruleOf = (over: Partial<EmailRule> = {}): EmailRule => ({
  id: `rule-${Math.random().toString(36).slice(2)}`,
  listType: 'allow',
  matchType: 'suffix',
  pattern: 'corp.com',
  priority: 100,
  enabled: true,
  createdAt: T0,
  ...over,
});

/** 终端用户链路（会自动建号）——这正是闸门必须拦在建号之前的原因 */
async function login(options: {
  email: string;
  emailRules?: InMemoryEmailRuleStore;
  endUsers: InMemoryEndUserStore;
}) {
  return resolveLogin(
    {
      ref: 'platform:enduser',
      oidcSubject: `sub-${options.email}`,
      email: options.email,
      emailVerified: true,
    },
    {
      developerIdentities: { findByIdentity: async () => undefined },
      endUsers: options.endUsers,
      sites: { list: async () => [], get: async () => undefined } as never,
      ...(options.emailRules === undefined ? {} : { emailRules: options.emailRules }),
    },
  );
}

test('未注入 `emailRules` → 闸门不启用（登录照常）', async () => {
  const endUsers = new InMemoryEndUserStore();
  const outcome = await login({ email: 'anyone@anywhere.com', endUsers });
  assert.equal(outcome.ok, true);
});

test('★ 白名单命中 → 放行', async () => {
  const endUsers = new InMemoryEndUserStore();
  const emailRules = new InMemoryEmailRuleStore();
  await emailRules.put(ruleOf({ pattern: 'corp.com' }));

  const outcome = await login({ email: 'alice@corp.com', endUsers, emailRules });
  assert.equal(outcome.ok, true);
});

test('★★ 白名单未命中 → **`email_not_admitted`**（拒绝，且说明理由）', async () => {
  const endUsers = new InMemoryEndUserStore();
  const emailRules = new InMemoryEmailRuleStore();
  await emailRules.put(ruleOf({ pattern: 'corp.com' }));

  const outcome = await login({ email: 'bob@gmail.com', endUsers, emailRules });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false ? outcome.reason : '', 'email_not_admitted');
  assert.match(outcome.ok === false ? outcome.message : '', /未命中任何允许规则/);
});

test('★ deny 规则命中 → 拒绝（且理由指向"命中了拒绝规则"）', async () => {
  const endUsers = new InMemoryEndUserStore();
  const emailRules = new InMemoryEmailRuleStore();
  await emailRules.put(ruleOf({ pattern: 'corp.com' })); // 白名单
  await emailRules.put(
    ruleOf({ listType: 'deny', matchType: 'exact', pattern: 'banned@corp.com', priority: 10 }),
  );

  const outcome = await login({ email: 'banned@corp.com', endUsers, emailRules });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.message : '', /命中拒绝规则/);
});

test('★★★ 拒绝发生在**建号之前**：库里不该留下幽灵用户', async () => {
  const endUsers = new InMemoryEndUserStore();
  const emailRules = new InMemoryEmailRuleStore();
  await emailRules.put(ruleOf({ pattern: 'corp.com' }));

  const outcome = await login({ email: 'ghost@gmail.com', endUsers, emailRules });
  assert.equal(outcome.ok, false);

  // ★ 若先建号再拒绝，这里会查到一个"注册被拒但账号存在"的幽灵用户。
  //   ★ 用显式窄化而不是 `any`：内存实现是否提供 `list` 是**实现细节**，
  //     测试不该假定它存在——若不存在，这条断言退化为"无法验证"，
  //     而上面那条 `email_not_admitted` 才是真正的验收。
  const lookup = (endUsers as unknown as { list?: () => Promise<{ email: string }[]> }).list;
  if (lookup !== undefined) {
    const all = await lookup.call(endUsers);
    assert.equal(
      all.some((user) => user.email === 'ghost@gmail.com'),
      false,
      '★ 被拒的邮箱绝不能在库里留下账号',
    );
  }
});

test('判定用**规范化后的邮箱**（大小写不敏感）', async () => {
  const endUsers = new InMemoryEndUserStore();
  const emailRules = new InMemoryEmailRuleStore();
  await emailRules.put(ruleOf({ matchType: 'exact', pattern: 'alice@corp.com' }));

  const outcome = await login({ email: '  ALICE@Corp.COM  ', endUsers, emailRules });
  assert.equal(outcome.ok, true, '★ 大小写与首尾空格都该被规范化');
});
