/**
 * 动作目标寻址（M3-5）与用户确认页（M5-4）验收。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkTargetScope,
  describeActionTarget,
  looksAddressLike,
  resolveActionTargets,
} from '../src/policy/action-addressing.ts';
import {
  handleConfirmSubmit,
  normalizeUserCode,
  renderConfirmPage,
  type ChallengeService,
  type ConfirmChallengeView,
} from '../src/verify/confirm-page.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

// ═══════════════════════════ M3-5 动作目标寻址 ═══════════════════════════

test('★ M3-5：动作参数里的目标**复用统一寻址**（与表达式同一个解析器）', () => {
  const result = resolveActionTargets({
    target: 'subject:newapi@prod.group',
    group: 'contributor',
  });
  assert.equal(result.issues.length, 0);
  assert.equal(result.targets.length, 1);
  const target = result.targets[0]!;
  assert.equal(target.key, 'target');
  // ★ 解析出了结构化字段（不是「原样字符串」）
  assert.equal(target.parsed.pluginId, 'newapi');
  assert.equal(target.parsed.instanceKey, 'prod');
  assert.deepEqual(target.parsed.path, ['group']);
  // 非寻址参数原样保留
  assert.deepEqual(result.plainParams, { group: 'contributor' });
});

test('★ M3-5：普通参数**不被误判**为寻址目标（保守识别）', () => {
  const result = resolveActionTargets({ group: 'contributor', quota: 100, note: 'hello world' });
  assert.equal(result.targets.length, 0);
  assert.deepEqual(result.plainParams, { group: 'contributor', quota: 100, note: 'hello world' });

  // 值像寻址串但**字段名不在约定集合**里 → 也不当目标
  assert.equal(resolveActionTargets({ group: 'subject:x' }).targets.length, 0);
  // 函数判据
  assert.equal(looksAddressLike('subject:qq.level'), true);
  assert.equal(looksAddressLike('fact:x@y'), true);
  assert.equal(looksAddressLike('contributor'), false);
});

test('★ M3-5：**跨站点引用需显式允许**（写操作比读更危险）', () => {
  const result = resolveActionTargets({ target: 'subject:newapi@prod.group#other-site' });
  assert.equal(result.issues.length, 0, '语法本身合法');
  const target = result.targets[0]!;

  const denied = checkTargetScope(target, { siteId: 'site-a', allowCrossSite: false });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.reason, 'cross_site_denied');
    assert.match(denied.message, /跨站点写操作/);
    assert.match(denied.message, /会真的改到别的站点的数据/);
  }
  // 显式允许 → 通过
  assert.equal(checkTargetScope(target, { siteId: 'site-a', allowCrossSite: true }).ok, true);

  // 同站点引用无需特殊允许
  const local = resolveActionTargets({ target: 'subject:newapi@prod.group' }).targets[0]!;
  assert.equal(checkTargetScope(local, { siteId: 'site-a', allowCrossSite: false }).ok, true);
});

test('★ M3-5：未知实例被拒（避免动作打到不存在的实例）', () => {
  const target = resolveActionTargets({ target: 'subject:qq@ghost.level' }).targets[0]!;
  const denied = checkTargetScope(target, { siteId: 's', allowCrossSite: false, knownInstances: ['prod', 'test'] });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.reason, 'instance_unknown');
    assert.match(denied.message, /未知实例 '@ghost'/);
    assert.match(denied.message, /prod, test/);
  }
  const known = resolveActionTargets({ target: 'subject:qq@prod.level' }).targets[0]!;
  assert.equal(checkTargetScope(known, { siteId: 's', allowCrossSite: false, knownInstances: ['prod'] }).ok, true);
});

test('M3-5：无法解析的目标 → 记入 issues（发布期拒绝，不静默忽略）', () => {
  const result = resolveActionTargets({ target: 'subject:' });
  assert.ok(result.issues.length > 0);
  assert.match(result.issues[0]!, /无法解析/);
  assert.equal(result.targets.length, 0);
});

test('★ M3-5：人类可读描述（审计里记「对谁做了什么」比原始串有用）', () => {
  const target = resolveActionTargets({ target: 'subject:newapi@prod.group#team-b' }).targets[0]!;
  const described = describeActionTarget(target);
  assert.match(described, /类型 subject/);
  assert.match(described, /插件 newapi/);
  assert.match(described, /实例 prod/);
  assert.match(described, /★ 跨站点（team-b）/);
  assert.match(described, /路径 group/);
});

test('M3-5：多个目标参数（subject / scope）都被识别', () => {
  const result = resolveActionTargets({
    subject: 'subject:qq.level@prod',
    scope: 'fact:github.stars',
    when: '2025-01-01',
  });
  assert.equal(result.targets.length, 2);
  assert.deepEqual(result.targets.map((target) => target.key).sort(), ['scope', 'subject']);
  assert.deepEqual(result.plainParams, { when: '2025-01-01' });
});

// ═══════════════════════════ M5-4 用户确认页 ═══════════════════════════

const CHALLENGE: ConfirmChallengeView = {
  userCode: 'DEV7F3AK92M',
  clientName: 'Discord Bot',
  scopes: ['assert:read', 'assert:eligible'],
  expiresAt: new Date('2025-06-01T00:15:00Z'),
  requestedBy: 'community-bot',
};

function serviceOf(overrides: Partial<ChallengeService> = {}): ChallengeService {
  return {
    async lookupByUserCode(code) {
      return code === 'DEV7F3AK92M' ? CHALLENGE : undefined;
    },
    async approve() {
      return { ok: true };
    },
    async deny() {
      return { ok: true };
    },
    ...overrides,
  };
}

test('★ M5-4：未带 code 时渲染**输入页**', () => {
  const html = renderConfirmPage({ csrfToken: 'csrf-1' });
  assert.match(html, /请粘贴外部项目展示给你的代码/);
  assert.match(html, /name="user_code"/);
  assert.match(html, /name="csrf_token" value="csrf-1"/);
  assert.match(html, /如果你没有发起过这个请求/, '应提示「不是你发起的就关闭」');
});

test('★ M5-4：带 code 时展示**谁在请求 + 请求什么范围**（用户是在授权，不是在填空）', () => {
  const html = renderConfirmPage({ challenge: CHALLENGE, csrfToken: 'csrf-1' });
  assert.match(html, /Discord Bot/, '发起方名称');
  assert.match(html, /community-bot/, '发起方标识');
  assert.match(html, /assert:read/);
  assert.match(html, /assert:eligible/);
  assert.match(html, /DEV7F3AK92M/, '设备码');
  assert.match(html, /2025-06-01 00:15:00/, '有效期');
  // 两个按钮
  assert.match(html, /value="approve"/);
  assert.match(html, /value="deny"/);
  assert.match(html, /可以随时在「我的空间」里撤销/, '告诉用户可撤销');
});

test('★ M5-4：`clientName` 被 **HTML 转义**（它来自外部项目）', () => {
  const html = renderConfirmPage({
    challenge: { ...CHALLENGE, clientName: '<script>alert(1)</script>', requestedBy: '"><img onerror=x>' },
    csrfToken: 'c',
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false, '★ 不能原样输出脚本');
  assert.match(html, /&lt;script&gt;/);
  assert.equal(html.includes('<img onerror'), false);
  // 错误提示同样要转义
  const withError = renderConfirmPage({ csrfToken: 'c', error: '<b>bad</b>' });
  assert.equal(withError.includes('<b>bad</b>'), false);
  assert.match(withError, /&lt;b&gt;/);
});

test('★ M5-4：未登录 → 403（确认页不是可匿名调用的接口）', async () => {
  const result = await handleConfirmSubmit({
    userCode: 'DEV7F3AK92M',
    decision: 'approve',
    csrfToken: 'csrf-1',
    principal: null,
    service: serviceOf(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.match(result.page, /请先登录/);
  }
});

test('★ M5-4：缺少 CSRF → 403（否则第三方页面可诱导用户「批准」）', async () => {
  const result = await handleConfirmSubmit({
    userCode: 'DEV7F3AK92M',
    decision: 'approve',
    csrfToken: '   ',
    principal: { userId: 'u1' },
    service: serviceOf(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.match(result.page, /缺少 CSRF 令牌/);
  }
});

test('★ M5-4：查不到 code 与「已过期」返回**同一条提示**（不泄露 code 是否存在）', async () => {
  const notFound = await handleConfirmSubmit({
    userCode: 'ZZZZZZZZ',
    decision: 'approve',
    csrfToken: 'c',
    principal: { userId: 'u1' },
    service: serviceOf(),
  });
  assert.equal(notFound.ok, false);
  if (!notFound.ok) {
    assert.equal(notFound.status, 400);
    assert.match(notFound.page, /该代码无效或已过期/);
  }
});

test('★ M5-4：批准与拒绝都走通（拒绝不授予任何权限）', async () => {
  const calls: string[] = [];
  const service = serviceOf({
    async approve(code, userId) {
      calls.push(`approve:${code}:${userId}`);
      return { ok: true };
    },
    async deny(code, userId) {
      calls.push(`deny:${code}:${userId}`);
      return { ok: true };
    },
  });

  const approved = await handleConfirmSubmit({
    userCode: 'DEV 7F3A-K92M',
    decision: 'approve',
    csrfToken: 'c',
    principal: { userId: 'u1' },
    service,
  });
  assert.equal(approved.ok, true);
  if (approved.ok) {
    assert.equal(approved.action, 'approve');
    assert.match(approved.notice, /已批准/);
    assert.match(approved.page, /可以回到发起请求的应用/);
  }

  const denied = await handleConfirmSubmit({
    userCode: 'DEV7F3AK92M',
    decision: 'deny',
    csrfToken: 'c',
    principal: { userId: 'u1' },
    service,
  });
  assert.equal(denied.ok, true);
  if (denied.ok) {
    assert.match(denied.notice, /已拒绝/);
    assert.match(denied.notice, /不会获得任何访问权限/);
  }

  // ★ 用户码归一化后再调用服务（带空格/连字符也能匹配）
  assert.deepEqual(calls, ['approve:DEV7F3AK92M:u1', 'deny:DEV7F3AK92M:u1']);
});

test('★ M5-4：`normalizeUserCode` 与设备码服务同规则（去除非字母数字并大写）', () => {
  assert.equal(normalizeUserCode('DEV 7F3A-K92M'), 'DEV7F3AK92M');
  assert.equal(normalizeUserCode('dev7f3ak92m'), 'DEV7F3AK92M');
  assert.equal(normalizeUserCode('  DE-V 7F3A/K92M '), 'DEV7F3AK92M');
});

test('M5-4：服务端拒绝时（如已被他人确认）展示其消息', async () => {
  const result = await handleConfirmSubmit({
    userCode: 'DEV7F3AK92M',
    decision: 'approve',
    csrfToken: 'c',
    principal: { userId: 'u1' },
    service: serviceOf({ async approve() { return { ok: false, message: '该代码已被其他用户确认' }; } }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.page, /已被其他用户确认/);
  }
  void NOW;
});
