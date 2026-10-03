/**
 * 策略规划验收（M3-12 / M3-11 / M3-13）。
 *
 * 三个验收标准的共同点：它们都在回答「**为什么**」——
 * 为什么需要这个插件（依赖推断）· 为什么这条策略不生效（阶梯门槛）·
 * 为什么用户还没达标（完整解释）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkTierGate,
  collectFactNamespaces,
  DependencyError,
  explainPolicy,
  filterByTier,
  planDependencies,
  requireDependencyPlan,
  resolveCollision,
  type ExplainedItem,
  type PluginDescriptor,
  type TieredPolicy,
} from '../src/policy/planning.ts';
import type { Expression } from '../src/policy/expr.ts';

// ─────────────────────────── M3-12 ① 收集引用 ───────────────────────────

test('★ M3-12：收集表达式里的全部 `fact.<ns>.*` 引用（含嵌套/计数/加权）', () => {
  const expression: Expression = {
    any: [
      { gt: { 'fact.qq.level': 40 } },
      {
        all: [
          { gte: { 'fact.github.total_stars': 100 } },
          { atLeast: { n: 2, of: [{ gte: { 'fact.llm.pr_score': 60 } }, { matches: { 'fact.email.domain': ['*.edu'] } }] } },
        ],
      },
      { not: { exists: { 'fact.qq.level': true } } },
      { score: { threshold: 10, of: [{ weight: 1, expr: { gte: { 'fact.invite.used': 1 } } }] } },
      // 新写法（统一寻址）也要识别
      { gt: { 'fact:qq.level': 1 } },
    ],
  };
  assert.deepEqual(collectFactNamespaces(expression), ['email', 'github', 'invite', 'llm', 'qq']);
});

test('M3-12：保留属性（`$label` 等）与 `user.`/`me.` 不产生命名空间', () => {
  const expression: Expression = {
    all: [
      { $label: '标签里提到 fact.fake.x 也不算', eq: { 'me.email_verified': true } },
      { eq: { 'user.status': 'active' } },
    ],
  };
  assert.deepEqual(collectFactNamespaces(expression), [], '★ 只有真实操作数才算引用');
});

// ─────────────────────────── M3-12 ②③④ 解析 ───────────────────────────

const PLUGINS: PluginDescriptor[] = [
  { pluginId: 'github', kind: 'channel', namespaces: ['github'], enabled: true },
  { pluginId: 'qq', kind: 'channel', namespaces: ['qq'], enabled: true },
  { pluginId: 'email', kind: 'channel', namespaces: ['email'], enabled: true },
  // ★ enricher：消费 github 的产出，产出 llm 命名空间
  { pluginId: 'llm-review', kind: 'enricher', namespaces: ['llm'], consumes: ['github.pr_list'], enabled: true },
];

test('★ M3-12：策略里**不写 channel** —— 只写 `fact.<ns>.*` 就能解析出插件', () => {
  const plan = planDependencies({ expression: { gt: { 'fact.qq.level': 40 } }, plugins: PLUGINS });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.referencedNamespaces, ['qq']);
  assert.deepEqual(plan.order, ['qq'], '★ 无需任何 channel 声明');
});

test('★ M3-12：enricher 依赖**递归展开**并拓扑排序（被依赖者在前）', () => {
  // 表达式只引用 llm 命名空间，但 llm-review 消费 github.pr_list → 必须先把 github 排进来
  const plan = planDependencies({ expression: { gte: { 'fact.llm.pr_score': 60 } }, plugins: PLUGINS });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.referencedNamespaces, ['llm']);
  assert.deepEqual(plan.order, ['github', 'llm-review'], '★ 上游必须先执行（否则 enricher 读到空输入）');
  assert.deepEqual(plan.edges['llm-review'], ['github'], '依赖边可查（供排障展示）');
});

test('★ M3-12：未安装的命名空间 → **拒绝发布**并说明缺哪个插件', () => {
  const plan = planDependencies({ expression: { gt: { 'fact.qq.level': 1 }, gte: { 'fact.gitlab.mrs': 1 } }, plugins: PLUGINS });
  assert.ok(plan.issues.some((issue) => /gitlab/.test(issue) && /没有已安装的插件/.test(issue)));
  assert.deepEqual(plan.order, [], '有 issue 时不给出执行序（避免误用）');
  assert.throws(() => requireDependencyPlan({ expression: { gte: { 'fact.gitlab.mrs': 1 } }, plugins: PLUGINS }), DependencyError);
});

test('★ M3-12：插件**未启用** → 拒绝（区分「没装」与「装了但关着」）', () => {
  const disabled = PLUGINS.map((plugin) => (plugin.pluginId === 'qq' ? { ...plugin, enabled: false } : plugin));
  const plan = planDependencies({ expression: { gt: { 'fact.qq.level': 1 } }, plugins: disabled });
  assert.ok(plan.issues.some((issue) => /未启用/.test(issue)));
});

test('★ M3-12：依赖**环** → 报错（不能随便挑一个顺序）', () => {
  const cyclic: PluginDescriptor[] = [
    { pluginId: 'a', kind: 'enricher', namespaces: ['ns-a'], consumes: ['ns-b.x'], enabled: true },
    { pluginId: 'b', kind: 'enricher', namespaces: ['ns-b'], consumes: ['ns-a.y'], enabled: true },
  ];
  const plan = planDependencies({ expression: { gte: { 'fact.ns-a.z': 1 } }, plugins: cyclic });
  assert.ok(plan.issues.some((issue) => /环/.test(issue)), '★ 环必须被检出');
  assert.match(plan.issues.find((issue) => /环/.test(issue))!, /↔/);
});

test('M3-12：命名空间被两个插件同时声明 → 报错（无法确定用哪个）', () => {
  const conflict: PluginDescriptor[] = [
    { pluginId: 'p1', kind: 'channel', namespaces: ['shared'], enabled: true },
    { pluginId: 'p2', kind: 'channel', namespaces: ['shared'], enabled: true },
  ];
  const plan = planDependencies({ expression: { gt: { 'fact.shared.x': 1 } }, plugins: conflict });
  assert.ok(plan.issues.some((issue) => /同时被插件/.test(issue)));
});

test('M3-12：enricher 声明的依赖缺失 → 报错（依赖缺失比运行时读到空值好）', () => {
  const broken: PluginDescriptor[] = [{ pluginId: 'llm-review', kind: 'enricher', namespaces: ['llm'], consumes: ['ghost.x'], enabled: true }];
  const plan = planDependencies({ expression: { gte: { 'fact.llm.pr_score': 1 } }, plugins: broken });
  assert.ok(plan.issues.some((issue) => /依赖缺失/.test(issue)));
});

// ─────────────────────────── M3-11 阶梯 ───────────────────────────

const policyOf = (overrides: Partial<TieredPolicy>): TieredPolicy =>
  ({ code: 'p', name: 'P', version: 1, enabled: true, spec: { requirements: { expression: { always: true } } }, ...overrides }) as TieredPolicy;

test('★ M3-11：`requiresTier` 未达标 → **不参与判定**（而不是判为不满足）', () => {
  const policy = policyOf({ code: 'tier3', requiresTier: 3 });
  const blocked = checkTierGate(policy, 2);
  assert.equal(blocked.runnable, false);
  if (!blocked.runnable) {
    assert.equal(blocked.reason, 'requires_tier_unmet');
    assert.match(blocked.message, /需要阶梯 ≥ 3（当前站点阶梯 2）/);
    assert.match(blocked.message, /不参与判定/, '★ 语义是「不参与」而不是「不满足」');
  }
  assert.equal(checkTierGate(policy, 3).runnable, true, '达标即可运行');
  assert.equal(checkTierGate(policy, 5).runnable, true);
  // 未设门槛 → 恒可运行
  assert.equal(checkTierGate(policyOf({ code: 'free' }), 0).runnable, true);
});

test('M3-11：`filterByTier` 保持输入顺序（阶梯高的不会插队）', () => {
  const policies = [
    policyOf({ code: 'a', requiresTier: 2 }),
    policyOf({ code: 'b', requiresTier: 5 }),
    policyOf({ code: 'c' }),
  ];
  const { runnable, skipped } = filterByTier(policies, 3);
  assert.deepEqual(runnable.map((policy) => policy.code), ['a', 'c'], '★ 保持原顺序');
  assert.deepEqual(skipped.map((entry) => entry.policy.code), ['b']);
});

test('★ M3-11：`collision` 三种模式（多策略命中时「谁生效」必须显式）', () => {
  const policies = [policyOf({ code: 'p1', priority: 10, tier: 1 }), policyOf({ code: 'p2', priority: 5, tier: 3 })];

  const additive = resolveCollision(policies, 'additive');
  assert.equal(additive.effective.length, 2, 'additive：全部生效');
  assert.equal(additive.suppressed.length, 0);

  // exclusive：priority 数值小者优先（与 docs 的优先级语义一致）
  const exclusive = resolveCollision(policies, 'exclusive');
  assert.deepEqual(exclusive.effective.map((policy) => policy.code), ['p2'], 'priority 5 < 10 → p2');
  assert.deepEqual(exclusive.suppressed.map((policy) => policy.code), ['p1']);
  assert.match(exclusive.reason, /priority=5/);

  const highest = resolveCollision(policies, 'highest_tier');
  assert.deepEqual(highest.effective.map((policy) => policy.code), ['p2'], 'tier 3 > 1 → p2');
  assert.match(highest.reason, /tier 最高的/);
});

test('★ M3-11：平手时按 code **稳定排序**（否则「谁生效」取决于输入顺序）', () => {
  const a = policyOf({ code: 'aaa', priority: 10 });
  const b = policyOf({ code: 'bbb', priority: 10 });
  // 输入顺序反过来，结果必须一致
  assert.equal(resolveCollision([a, b], 'exclusive').effective[0]!.code, resolveCollision([b, a], 'exclusive').effective[0]!.code);
  assert.equal(resolveCollision([a, b], 'exclusive').effective[0]!.code, 'aaa');
  // 单条命中直接返回
  assert.equal(resolveCollision([a], 'exclusive').effective.length, 1);
  assert.equal(resolveCollision([], 'exclusive').effective.length, 0);
});

// ─────────────────────────── M3-13 完整解释 ───────────────────────────

test('★ M3-13：解释**逐项列出**并统计满足数', () => {
  const items: ExplainedItem[] = [
    { label: '教育邮箱', state: 'true', reason: '满足' },
    { label: 'GitHub star ≥ 100', state: 'false', actual: 42, expected: 100, reason: '不足', pluginId: 'github' },
  ];
  const explained = explainPolicy({ policy: policyOf({ code: 'edu', name: '教育解锁' }), items });
  assert.equal(explained.participated, true);
  assert.equal(explained.satisfiedCount, 1);
  assert.equal(explained.totalCount, 2);
  assert.equal(explained.items.length, 2);
  assert.equal(explained.name, '教育解锁');
});

test('★ M3-13：**区分 false 与 indeterminate 的措辞**（前者要努力，后者不用动）', () => {
  const items: ExplainedItem[] = [
    { label: 'QQ 等级', state: 'false', pluginId: 'qq', reason: '不足' },
    { label: 'GitHub star', state: 'indeterminate', pluginId: 'github', reason: '渠道缺失' },
  ];
  const { gaps } = explainPolicy({ policy: policyOf({ code: 'p' }), items });
  assert.equal(gaps.length, 2);
  // false → 给「去哪里做」的建议
  assert.match(gaps[0]!, /尚未满足（在 qq 渠道完成）/);
  // ★ indeterminate → 明确告知「无需操作」
  assert.match(gaps[1]!, /平台暂时无法确认/);
  assert.match(gaps[1]!, /无需操作/);
  assert.match(gaps[1]!, /稍后自动恢复/);
});

test('★ M3-13：阶梯门槛未达时 `participated: false` 并给出原因', () => {
  const gate = checkTierGate(policyOf({ code: 'tier3', requiresTier: 3 }), 1);
  const explained = explainPolicy({ policy: policyOf({ code: 'tier3' }), items: [], gate });
  assert.equal(explained.participated, false);
  assert.match(explained.skippedReason!, /需要阶梯 ≥ 3/);
});

test('M3-13：全部满足时无缺口（`gaps` 为空）', () => {
  const items: ExplainedItem[] = [
    { label: 'a', state: 'true', reason: 'ok' },
    { label: 'b', state: 'true', reason: 'ok' },
  ];
  const explained = explainPolicy({ policy: policyOf({ code: 'p' }), items });
  assert.deepEqual(explained.gaps, []);
  assert.equal(explained.satisfiedCount, 2);
});
