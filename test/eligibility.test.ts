/**
 * M1 垂直切片端到端验收 —— docs/07 §3 M1 的验收原句：
 *
 * > `alice@tsinghua.edu.cn` 登录后打开「我的资格」，看到「✅ 教育邮箱」与「❌ 尚未解锁签到」
 * > ——**第一个可演示的价值**。
 *
 * 本文件把四层真正串起来（不是各层单测的重复）：
 *   ① `email-domain` 内置插件产出事实 → ② FactPipeline 落库（带 TTL）
 *   → ③ 策略求值（三态 + 结果树）→ ④ 用户可读的「我的资格」视图
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EMAIL_DOMAIN_MANIFEST, evaluateEmailDomain } from '../src/plugin/builtin/email-domain.ts';
import { FactPipeline, InMemoryFactStore } from '../src/plugin/host-api.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { validatePolicy, type PluginRegistry, type PolicyDocument } from '../src/policy/model.ts';
import { collectFactSnapshot, evaluateEligibility } from '../src/policy/eligibility.ts';

const NOW = new Date('2025-06-01T12:00:00Z');

/** 与 ag_policies / ag_plugin_facts 的真实字段对齐的注册表 */
function registry(): PluginRegistry {
  return {
    installedPlugins: () => ['email', 'checkin'],
    knownFactKeys: () => ['fact.email.domain', 'fact.email.is_edu', 'fact.email.matched_rule', 'fact.email.verified', 'fact.checkin.last_date'],
    knownActions: () => ['newapi-set-group:set_group', 'checkin:grant'],
  };
}

/** M1 验收场景的策略：edu 邮箱 → 解锁签到 */
const EDU_POLICY: PolicyDocument = {
  code: 'edu-unlock-checkin',
  name: '教育邮箱解锁签到',
  version: 3,
  priority: 10,
  spec: {
    match: { eq: { 'user.status': 'active' } },
    requirements: {
      expression: {
        all: [
          { $label: '✅ 教育邮箱', matches: { 'fact.email.domain': ['*.edu.cn', '*.edu'] } },
          { $label: '邮箱已验证', eq: { 'fact.email.verified': true } },
        ],
      },
    },
    actions: {
      onSatisfied: [{ action: 'checkin:grant', params: { scope: 'daily' } }],
      onUnsatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'default' } }],
    },
  },
};

/** 「尚未解锁签到」——依赖 checkin 插件的事实 */
const CHECKIN_POLICY: PolicyDocument = {
  code: 'daily-checkin',
  name: '每日签到',
  version: 1,
  priority: 20,
  spec: {
    // ★ 本策略问的就是「有没有签到事实」——没采集到即代表「尚未签到」，
    //   因此**显式**声明 missingPolicy: 'false'（默认是 indeterminate，见 model.ts 的说明）
    missingPolicy: 'false',
    requirements: {
      expression: { $label: '尚未解锁签到', exists: { 'fact.checkin.last_date': true } },
    },
    actions: { onUnsatisfied: [] },
  },
};

/** 把 email-domain 插件的求值结果写进事实库（模拟一次采集） */
async function collectEmailFacts(pipeline: FactPipeline, email: string, verified: boolean, at: Date) {
  const facts = evaluateEmailDomain({
    email,
    emailVerified: verified,
    config: { allowDomains: ['*.edu.cn', '*.edu'], denyDomains: ['*.evil.com'], requireVerified: true },
  });
  if (facts === null) return null;
  await pipeline.emit({ ...facts }, at);
  return facts;
}

test('M1 验收：alice@tsinghua.edu.cn → ✅ 教育邮箱 / ❌ 尚未解锁签到', async () => {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: 'u1' });

  await collectEmailFacts(pipeline, 'alice@tsinghua.edu.cn', true, NOW);

  const collection = await collectFactSnapshot(store, [{ pluginId: 'email', fields: ['domain', 'is_edu', 'matched_rule', 'verified'], ttl: '30d' }], NOW, 'u1');
  assert.deepEqual(collection.missing, [], '四个事实都应采集到');
  assert.equal(collection.snapshot.values['fact.email.domain'], 'tsinghua.edu.cn');

  const report = evaluateEligibility({
    policies: [EDU_POLICY, CHECKIN_POLICY],
    user: { status: 'active', email_verified: true, username: 'alice' },
    facts: collection.snapshot,
    now: NOW,
  });

  // 策略 1：教育邮箱 → 满足（解锁签到）
  const edu = report.results.find((r) => r.code === 'edu-unlock-checkin')!;
  assert.equal(edu.evaluation.decision, 'satisfied');
  assert.deepEqual(edu.evaluation.actions.map((a) => a.action), ['checkin:grant']);
  assert.deepEqual(
    edu.view.items.map((i) => [i.label, i.state]),
    [
      ['✅ 教育邮箱', 'true'],
      ['邮箱已验证', 'true'],
    ],
  );

  // 策略 2：签到事实尚未产生 → **indeterminate**（不是 false）
  const checkin = report.results.find((r) => r.code === 'daily-checkin')!;
  assert.equal(checkin.evaluation.decision, 'unsatisfied', '显式 missingPolicy:false 时缺失即不满足（「尚未签到」）');
  assert.deepEqual(checkin.evaluation.actions, []);

  assert.equal(report.progress.satisfied, 1);
  assert.equal(report.progress.total, 2);
  assert.ok(
    report.todos.some((t) => /签到/.test(t)),
    `todos 应包含「尚未解锁签到」，实际 ${JSON.stringify(report.todos)}`,
  );
});

test('M1 验收：换成 gmail.com → 教育邮箱不满足，动作回退 default', async () => {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: 'u1' });
  await collectEmailFacts(pipeline, 'alice@gmail.com', true, NOW);

  const collection = await collectFactSnapshot(store, [{ pluginId: 'email', fields: ['domain', 'matched_rule', 'verified'], ttl: '30d' }], NOW, 'u1');
  const report = evaluateEligibility({
    policies: [EDU_POLICY],
    user: { status: 'active' },
    facts: collection.snapshot,
    now: NOW,
  });
  const edu = report.results[0]!;
  assert.equal(edu.evaluation.decision, 'unsatisfied');
  assert.deepEqual(edu.evaluation.actions[0]!.params, { group: 'default' });
  const item = edu.view.items.find((i) => i.label === '✅ 教育邮箱')!;
  assert.equal(item.state, 'false');
  assert.equal(item.actual, 'gmail.com');
  assert.deepEqual(item.expected, ['*.edu.cn', '*.edu']);
});

test('★ 事实过期 → 按缺失处理（不使用陈旧值），结论为 indeterminate 且不产生动作', async () => {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: 'u1' });

  // 60 天前采集，TTL 30d → 已过期
  const longAgo = new Date(NOW.getTime() - 60 * 86_400_000);
  await collectEmailFacts(pipeline, 'alice@tsinghua.edu.cn', true, longAgo);

  const collection = await collectFactSnapshot(store, [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }], NOW, 'u1');
  assert.deepEqual(collection.expired.sort(), ['fact.email.domain', 'fact.email.verified']);
  assert.deepEqual(collection.missing, [], '过期与缺失是两种不同状态，都要能报出');
  assert.deepEqual(collection.snapshot.values, {}, '过期事实不得进入快照');

  const report = evaluateEligibility({ policies: [EDU_POLICY], user: { status: 'active' }, facts: collection.snapshot, now: NOW });
  assert.equal(report.results[0]!.evaluation.decision, 'indeterminate');
  assert.deepEqual(report.results[0]!.evaluation.actions, []);
});

test('★ 同一输入必须得到同一结论（可复现）——这是历史评估与试算的前提', async () => {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: 'u1' });
  await collectEmailFacts(pipeline, 'alice@tsinghua.edu.cn', true, NOW);
  const collection = await collectFactSnapshot(store, [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }], NOW, 'u1');

  const input = { policies: [EDU_POLICY], user: { status: 'active' }, facts: collection.snapshot, now: NOW };
  const first = evaluateEligibility(input);
  const second = evaluateEligibility(input);
  assert.equal(first.results[0]!.evaluation.decision, second.results[0]!.evaluation.decision);
  assert.deepEqual(first.results[0]!.view.items, second.results[0]!.view.items);
  assert.equal(first.evaluatedAt.toISOString(), second.evaluatedAt.toISOString());
});

test('发布前门禁对 M1 场景策略全绿；引入未安装插件即被拒', () => {
  assert.deepEqual(validatePolicy(EDU_POLICY, registry()).issues, []);
  assert.deepEqual(validatePolicy(CHECKIN_POLICY, registry()).issues, []);

  const bad: PolicyDocument = {
    ...EDU_POLICY,
    code: 'bad',
    spec: {
      ...EDU_POLICY.spec,
      requirements: { expression: { gte: { 'fact.gitlab.mr_count': 5 } } },
    },
  };
  const result = validatePolicy(bad, registry());
  assert.deepEqual(result.missingPlugins, ['gitlab']);
});

test('多策略场景：策略按 priority 升序求值（稳定排序）', async () => {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: 'u1' });
  await collectEmailFacts(pipeline, 'alice@tsinghua.edu.cn', true, NOW);
  const collection = await collectFactSnapshot(store, [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }], NOW, 'u1');

  const lowPriority = { ...EDU_POLICY, code: 'priority-1', priority: 1 };
  const noPriority = { ...EDU_POLICY, code: 'no-priority', priority: undefined };
  const report = evaluateEligibility({
    policies: [noPriority as PolicyDocument, lowPriority as PolicyDocument],
    user: { status: 'active' },
    facts: collection.snapshot,
    now: NOW,
  });
  assert.deepEqual(report.results.map((r) => r.code), ['priority-1', 'no-priority']);
});

test('禁用策略被跳过（enabled: false 不参与进度统计）', async () => {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: 'u1' });
  await collectEmailFacts(pipeline, 'alice@tsinghua.edu.cn', true, NOW);
  const collection = await collectFactSnapshot(store, [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }], NOW, 'u1');

  const report = evaluateEligibility({
    policies: [{ ...EDU_POLICY, enabled: false }],
    user: { status: 'active' },
    facts: collection.snapshot,
    now: NOW,
  });
  assert.equal(report.results.length, 0);
  assert.equal(report.progress.total, 0);
});

test('not_applicable 的策略不计入进度（避免「本策略不管我」拉低用户进度）', async () => {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: 'u1' });
  await collectEmailFacts(pipeline, 'alice@tsinghua.edu.cn', true, NOW);
  const collection = await collectFactSnapshot(store, [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }], NOW, 'u1');

  const report = evaluateEligibility({
    policies: [EDU_POLICY],
    user: { status: 'suspended' }, // match 不通过
    facts: collection.snapshot,
    now: NOW,
  });
  assert.equal(report.results[0]!.evaluation.decision, 'not_applicable');
  assert.equal(report.progress.total, 0, 'not_applicable 不计入分母');
});
