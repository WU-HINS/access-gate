/**
 * 统一寻址与绑定解析验收（M3-3）—— docs/04 §1.2.7。
 *
 * 断言重点：
 *   - 语法：`<root>:<pluginId>[@instanceKey][#siteSlug].<path>`，含数组下标与通配；
 *   - **★ `@instanceKey` 规则**：`singleton` 带 `@` → 拒绝；`multi` 不带 `@` → 拒绝。
 *     静默取到 null 会把「配错了」表现成「事实缺失」（indeterminate），
 *     真正的配置错误被藏起来。
 *   - **`#siteSlug` 跨站点引用默认禁止**（仅平台级 admin 策略可用）；
 *   - **旧写法兼容并归一**（`user.status` → `me.status`），但标记 legacy 并提示改写；
 *   - **绑定解析**：命中绑定 → resolved；未命中 → 尝试自动解析；
 *     **已撤销的绑定不得支撑取值**（否则「解绑后仍能读到下游属性」= 因果断裂）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AddressSyntaxError,
  formatAddress,
  formatPath,
  parseAddress,
  parsePath,
  resolveBinding,
  validateAddress,
  validateAddresses,
  type AddressingRegistry,
  type BindingResolver,
} from '../src/policy/addressing.ts';

const REGISTRY: AddressingRegistry = {
  // 开发者级 singleton：全站唯一配置
  github: { mode: 'singleton' },
  // 站点级 multi：可接多个实例
  webhook: { mode: 'multi', instanceKeys: ['orders', 'signups'] },
  // 身份域
  oidc: { mode: 'multi', instanceKeys: ['external', 'internal'] },
  // 下游系统（subject 寻址）
  newapi: { mode: 'multi', instanceKeys: ['default'] },
  email: { mode: 'singleton' },
  qq: { mode: 'singleton' },
};

// ─────────────────────────── 解析 ───────────────────────────

test('解析限定写法：root / pluginId / path', () => {
  const address = parseAddress('fact:github.total_stars');
  assert.equal(address.root, 'fact');
  assert.equal(address.pluginId, 'github');
  assert.deepEqual(address.path, ['total_stars']);
  assert.equal(address.syntax, 'qualified');
  assert.equal(address.instanceKey, undefined);
  assert.equal(address.siteSlug, undefined);
});

test('解析实例与站点：fact:webhook@orders#site-b.event_count', () => {
  const address = parseAddress('fact:webhook@orders#site-b.event_count');
  assert.equal(address.pluginId, 'webhook');
  assert.equal(address.instanceKey, 'orders');
  assert.equal(address.siteSlug, 'site-b');
  assert.deepEqual(address.path, ['event_count']);
});

test('解析 me（无 pluginId）与 identity（含多段路径）', () => {
  const me = parseAddress('me.tags');
  assert.equal(me.root, 'me');
  assert.deepEqual(me.path, ['tags']);

  const identity = parseAddress('identity:oidc@external.proj-a.sub');
  assert.equal(identity.root, 'identity');
  assert.equal(identity.pluginId, 'oidc');
  assert.equal(identity.instanceKey, 'external');
  assert.deepEqual(identity.path, ['proj-a', 'sub']);
});

test('★ 路径支持数组下标与通配：orgs[0] / repos[*].stars', () => {
  assert.deepEqual(parseAddress('fact:github.orgs[0]').path, ['orgs', '0']);
  assert.deepEqual(parseAddress('fact:github.repos[*].stars').path, ['repos', '*', 'stars']);
  assert.deepEqual(parseAddress('fact:github.matrix[1][2]').path, ['matrix', '1', '2']);
  assert.equal(formatPath(['repos', '*', 'stars']), 'repos[*].stars');
  assert.equal(formatPath(['orgs', '0']), 'orgs[0]');
});

test('★ 旧点号写法兼容并归一（user → me），标记 legacy', () => {
  const fact = parseAddress('fact.email.domain');
  assert.equal(fact.root, 'fact');
  assert.equal(fact.pluginId, 'email');
  assert.deepEqual(fact.path, ['domain']);
  assert.equal(fact.syntax, 'legacy');

  const user = parseAddress('user.status');
  assert.equal(user.root, 'me', 'user 是旧写法 → 归一为 me');
  assert.deepEqual(user.path, ['status']);
  assert.equal(user.syntax, 'legacy');

  const binding = parseAddress('binding.newapi.status');
  assert.equal(binding.root, 'binding');
  assert.equal(binding.pluginId, 'newapi');
  assert.deepEqual(binding.path, ['status']);
});

test('归一化文本（formatAddress）：三种写法归一为限定形态', () => {
  assert.equal(formatAddress(parseAddress('fact.email.domain')), 'fact:email.domain');
  assert.equal(formatAddress(parseAddress('user.tags')), 'me.tags');
  assert.equal(formatAddress(parseAddress('fact:webhook@orders.count')), 'fact:webhook@orders.count');
  assert.equal(formatAddress(parseAddress('fact:github#site-b.stars')), 'fact:github#site-b.stars');
});

test('语法错误：空 / 缺路径 / 未知 root / 缺 pluginId / 括号不匹配 → 明确报错', () => {
  assert.throws(() => parseAddress(''), AddressSyntaxError);
  assert.throws(() => parseAddress('fact'), /缺少路径/);
  assert.throws(() => parseAddress('nope:github.stars'), /未知的 root 'nope'/);
  assert.throws(() => parseAddress('fact:'), /缺少路径|缺少 pluginId/);
  assert.throws(() => parseAddress('fact:.stars'), /缺少 pluginId/);
  assert.throws(() => parseAddress('fact:github.'), /缺少路径/);
  assert.throws(() => parseAddress('fact:github.repos[0.stars'), /没有匹配的 '\]'/);
  assert.throws(() => parseAddress('fact:github.repos].stars'), /多余的 '\]'/);
  assert.throws(() => parseAddress('fact:github.repos[].stars'), /空的下标/);
  assert.throws(() => parsePath('a..b') as never, /空的段/);
  assert.throws(() => parsePath('.a') as never, /空的段/);
  assert.throws(() => parsePath('a.') as never, /空的段/);
});

// ─────────────────────────── ★ @instanceKey 规则 ───────────────────────────

test('★ singleton 带 @ → 拒绝（否则静默取 null，配置错误被藏成「事实缺失」）', () => {
  const issues = validateAddress(parseAddress('fact:github@main.total_stars'), REGISTRY);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.code, 'instance_forbidden');
  assert.equal(issues[0]!.severity, 'error');
  assert.match(issues[0]!.message, /singleton.*不得带 @instanceKey/s);
});

test('★ multi 不带 @ → 拒绝（必须指明是哪个实例）', () => {
  const issues = validateAddress(parseAddress('fact:webhook.event_count'), REGISTRY);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.code, 'instance_required');
  assert.match(issues[0]!.message, /multi.*必须带 @instanceKey/s);
  // 错误信息里给出改写示例（可操作）
  assert.match(issues[0]!.message, /fact:webhook@orders\.event_count/);
});

test('multi 带了未知实例 → 拒绝并列出已知实例', () => {
  const issues = validateAddress(parseAddress('fact:webhook@nope.count'), REGISTRY);
  assert.equal(issues[0]!.code, 'unknown_instance');
  assert.match(issues[0]!.message, /orders, signups/);
});

test('multi 带合法实例 / singleton 不带实例 → 通过', () => {
  assert.deepEqual(validateAddress(parseAddress('fact:webhook@orders.count'), REGISTRY), []);
  assert.deepEqual(validateAddress(parseAddress('fact:github.total_stars'), REGISTRY), []);
  assert.deepEqual(validateAddress(parseAddress('me.tags'), REGISTRY), []);
});

test('未安装插件 → 拒绝并列出已声明插件（可操作）', () => {
  const issues = validateAddress(parseAddress('fact:ghost.x'), REGISTRY);
  assert.equal(issues[0]!.code, 'unknown_plugin');
  assert.match(issues[0]!.message, /未安装或未在寻址表中声明/);
  assert.match(issues[0]!.message, /github/);
});

// ─────────────────────────── 跨站点 ───────────────────────────

test('★ 跨站点引用 #siteSlug 默认禁止；平台级策略可用', () => {
  const address = parseAddress('fact:github#site-b.total_stars');
  const forbidden = validateAddress(address, REGISTRY);
  assert.equal(forbidden[0]!.code, 'cross_site_forbidden');
  assert.match(forbidden[0]!.message, /仅平台级 admin 策略可用/);

  // 平台级：显式放行
  assert.deepEqual(validateAddress(address, REGISTRY, { allowCrossSite: true }), []);
});

test('旧写法产生 legacy 警告（不阻断，但提示改写）', () => {
  const issues = validateAddress(parseAddress('fact.email.domain'), REGISTRY);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.code, 'legacy_syntax');
  assert.equal(issues[0]!.severity, 'warning');
  assert.match(issues[0]!.message, /fact:email\.domain/);
});

// ─────────────────────────── 批量校验 ───────────────────────────

test('批量校验：按寻址文本分组返回全部问题，并统计 error / warning', () => {
  const result = validateAddresses(
    ['fact:github.total_stars', 'fact:webhook.event_count', 'fact:github@x.y', 'fact.email.domain', 'nope:bad.path'],
    REGISTRY,
  );
  assert.equal(result.errors, 3, 'multi 缺实例 + singleton 带实例 + 未知 root = 3 个错误');
  assert.equal(result.warnings, 1, '旧写法 1 个警告');
  assert.equal(result.byAddress.size, 4);
  assert.ok(result.byAddress.has('fact:webhook.event_count'));
});

// ─────────────────────────── 绑定解析 ───────────────────────────

const binding = (overrides: Partial<{ pluginId: string; instanceKey: string; externalId: string; status: 'active' | 'revoked' | 'pending' }> = {}) => ({
  pluginId: 'newapi',
  instanceKey: 'default',
  externalId: '42',
  status: 'active' as const,
  ...overrides,
});

test('★ 绑定解析：命中绑定 → resolved（拿到 externalId）', async () => {
  const resolver: BindingResolver = {
    async find() {
      return binding();
    },
  };
  const result = await resolveBinding({ address: parseAddress('subject:newapi@default.group'), userId: 'u1', resolver });
  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') {
    assert.equal(result.externalId, '42');
    assert.equal(result.source, 'binding');
  }
});

test('★ 绑定解析：未命中但插件能自动解析 → resolved（source=auto）', async () => {
  const resolver: BindingResolver = {
    async find() {
      return undefined;
    },
    async autoResolve() {
      return binding({ externalId: '99' });
    },
  };
  const result = await resolveBinding({ address: parseAddress('subject:newapi@default.group'), userId: 'u1', resolver });
  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') {
    assert.equal(result.externalId, '99');
    assert.equal(result.source, 'auto');
  }
});

test('★ 绑定解析：已撤销的绑定**不得**支撑取值（否则「解绑后仍能读到下游属性」= 因果断裂）', async () => {
  const resolver: BindingResolver = {
    async find() {
      return binding({ status: 'revoked' });
    },
    async autoResolve() {
      // 即使能自动解析，也不能用「已撤销」的结果
      return binding({ status: 'revoked' });
    },
  };
  const result = await resolveBinding({ address: parseAddress('subject:newapi@default.group'), userId: 'u1', resolver });
  assert.equal(result.status, 'missing');
  if (result.status === 'missing') assert.equal(result.reason, 'revoked');
});

test('绑定解析：完全解析不到 → missing（交由 $onMissing 决定，不静默当假）', async () => {
  const resolver: BindingResolver = {
    async find() {
      return undefined;
    },
  };
  const result = await resolveBinding({ address: parseAddress('subject:newapi@default.group'), userId: 'u1', resolver });
  assert.equal(result.status, 'missing');
  if (result.status === 'missing') assert.equal(result.reason, 'no_binding');
});

test('绑定解析：fact / me / identity 不需要绑定解析（not_applicable）', async () => {
  const resolver: BindingResolver = {
    async find() {
      throw new Error('不应被调用');
    },
  };
  for (const raw of ['fact:github.total_stars', 'me.tags', 'identity:oidc@external.sub']) {
    const result = await resolveBinding({ address: parseAddress(raw), userId: 'u1', resolver });
    assert.equal(result.status, 'not_applicable', `${raw} 不需要绑定解析`);
  }
});
