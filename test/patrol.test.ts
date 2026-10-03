/**
 * 巡检闭环验收（M2-1 / M2-6 / M2-7）—— **生产就绪判据 #1**。
 *
 * 核心验收（docs/07 §5 场景 A 第 7 条）：
 *   **「重复巡检 10 次，new-api 侧无额外会话吊销」**
 *   —— 这条断言不能靠「看起来对」，必须**数下游收到的写请求次数**。
 *
 * 本文件用真实的 `newapi-provider` + 假 transport 计数，跑 10 轮巡检，断言：
 *   ① 只有第 1 轮发生写回；第 2–10 轮 0 次写回（幂等命中）；
 *   ② `actionSeq` 在重复巡检中保持不变；
 *   ③ 状态迁移只在第一轮发生；
 *   ④ 事实缺失（渠道故障）时**不产生任何动作**（H1 端到端）；
 *   ⑤ 显式解绑事件能跳过宽限期直接收回（因果事件端到端）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Patrol, InMemoryEvaluationStore, InMemoryLifecycleStateStore, fingerprintFacts, type PatrolSubject } from '../src/core/patrol.ts';
import { ActionExecutor, ActionRegistry, InMemoryActionLogStore, createSetGroupHandler } from '../src/core/action-executor.ts';
import type { LifecyclePolicy } from '../src/core/lifecycle.ts';
import { FactPipeline, InMemoryFactStore } from '../src/plugin/host-api.ts';
import { EMAIL_DOMAIN_MANIFEST, evaluateEmailDomain } from '../src/plugin/builtin/email-domain.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { EventBus } from '../src/kernel/events.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import type { PolicyDocument } from '../src/policy/model.ts';
import type { SubjectDirectory } from '../src/core/patrol.ts';

const SITE = 'site-1';
const NOW = new Date('2025-06-01T00:00:00Z');
const GRACE_MS = 72 * 3_600_000;

/** 与 docs/07 §5 场景 A 一致的策略：教育邮箱 → 升级分组 */
const EDU_POLICY: PolicyDocument = {
  code: 'edu-upgrade',
  name: '教育邮箱自动升级',
  version: 3,
  enabled: true,
  spec: {
    match: { eq: { 'user.status': 'active' } },
    requirements: {
      expression: {
        all: [
          { $label: '教育邮箱', matches: { 'fact.email.domain': ['*.edu.cn', '*.edu'] } },
          { $label: '邮箱已验证', eq: { 'fact.email.verified': true } },
        ],
      },
    },
    actions: {
      onSatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'basic' } }],
      onUnsatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'default' } }],
    },
  },
};

// ─────────────────────────── 测试装置 ───────────────────────────

interface Harness {
  patrol: Patrol;
  /** 下游收到的写请求（POST/PUT）—— 用于断言「无额外写回」 */
  downstreamWrites: { group: string }[];
  downstreamReads: number;
  states: InMemoryLifecycleStateStore;
  evaluations: InMemoryEvaluationStore;
  setGroup: string; // 下游当前分组（可变）
  factStore: InMemoryFactStore;
  emailPipeline: FactPipeline;
  setSubjectEmail: (email: string) => void;
}

async function makeHarness(options: { group?: string; email?: string; channelDown?: boolean } = {}): Promise<Harness> {
  const emailManifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const factStore = new InMemoryFactStore();
  // ★ 事实按主体存：本装置的主体 externalId 是 '42'，管线必须写同一个主体。
  //   （早期这里与巡检都用默认 'platform'，两边"恰好一致"掩盖了漏传主体 id 的缺陷。）
  const emailPipeline = new FactPipeline({ store: factStore, manifest: emailManifest, userId: '42' });

  let email = options.email ?? 'alice@tsinghua.edu.cn';
  let group = options.group ?? 'default';
  let channelDown = options.channelDown ?? false;

  const writes: { group: string }[] = [];
  let reads = 0;

  // 采集：email-domain 是本地求值（无出站），但「渠道故障」用不写事实来模拟
  const collect = async (): Promise<void> => {
    if (channelDown) return; // 不产出事实 → 快照缺失 → indeterminate
    const facts = evaluateEmailDomain({
      email,
      emailVerified: true,
      config: { allowDomains: ['*.edu.cn', '*.edu'], requireVerified: true },
    });
    if (facts !== null) await emailPipeline.emit({ ...facts }, NOW);
  };
  await collect();

  const registry = new ActionRegistry();
  registry.register(
    'newapi-set-group:set_group',
    createSetGroupHandler({
      externalIdOf: () => '42',
      getSubject: async () => {
        reads += 1;
        return { attributes: { group } };
      },
      setGroup: async (_externalId, target) => {
        writes.push({ group: target });
        group = target;
      },
      now: () => NOW,
    }),
  );

  const executor = new ActionExecutor({
    registry,
    log: new InMemoryActionLogStore(),
    sleep: async () => undefined,
    now: () => NOW,
  });

  const states = new InMemoryLifecycleStateStore();
  const evaluations = new InMemoryEvaluationStore();

  const directory: SubjectDirectory = {
    async list(_siteId, limit, offset) {
      const subject: PatrolSubject = {
        externalId: '42',
        email,
        emailVerified: true,
        attributes: { group },
      };
      const all = [subject];
      return all.slice(offset, offset + limit);
    },
    async count() {
      return 1;
    },
  };

  const lifecycle: LifecyclePolicy = { gracePeriodMs: GRACE_MS };

  const patrol = new Patrol({
    siteId: SITE,
    policies: [EDU_POLICY],
    directory,
    facts: factStore,
    factSources: [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }],
    states,
    evaluations,
    lifecycle,
    executor,
    bus: new EventBus(),
    logger: silentLogger,
    now: () => NOW,
  });

  return {
    patrol,
    downstreamWrites: writes,
    get downstreamReads() {
      return reads;
    },
    states,
    evaluations,
    get setGroup() {
      return group;
    },
    factStore,
    emailPipeline,
    setSubjectEmail(next: string) {
      email = next;
    },
  } as Harness & { downstreamWrites: { group: string }[] };
}

// ─────────────────────────── 判据 #1：重复巡检 10 次 ───────────────────────────

test('★ 生产判据 #1：重复巡检 10 次，下游只收到 1 次写回（无额外会话吊销）', async () => {
  const harness = await makeHarness();

  const reports = [];
  for (let i = 0; i < 10; i += 1) {
    reports.push(await harness.patrol.runOnce());
  }

  // ① 下游写回次数：只有第 1 轮
  assert.equal(harness.downstreamWrites.length, 1, `下游应只被写 1 次，实际 ${harness.downstreamWrites.length} 次`);
  assert.deepEqual(harness.downstreamWrites[0], { group: 'basic' });

  // ② 第 1 轮发生状态迁移与执行；第 2–10 轮幂等命中
  assert.equal(reports[0]!.stats.stateChanged, 1, '第 1 轮应发生 unknown → granted');
  assert.equal(reports[0]!.stats.actionsExecuted, 1);
  for (let i = 1; i < 10; i += 1) {
    assert.equal(reports[i]!.stats.stateChanged, 0, `第 ${i + 1} 轮不应有状态迁移`);
    assert.equal(reports[i]!.stats.actionsExecuted, 0, `第 ${i + 1} 轮不应执行动作`);
  }

  // ③ 幂等命中数：后 9 轮每轮应有 0 次「命中」——因为**根本没有产生计划**
  //    （actionIntent=none 时不生成计划，比「生成后靠日志跳过」更省）
  for (let i = 1; i < 10; i += 1) {
    assert.equal(reports[i]!.stats.idempotentHits, 0, `第 ${i + 1} 轮不应产生动作计划`);
  }

  // ④ actionSeq 保持不变（幂等键稳定的直接证据）
  const finalState = await harness.states.get(SITE, '42', 'edu-upgrade');
  assert.equal(finalState!.state, 'granted');
  assert.equal(finalState!.actionSeq, 1, 'actionSeq 应始终为 1（只在授予时递增一次）');

  // ⑤ 评估记录每轮都写（可复现性要求）
  assert.equal(await harness.evaluations.count(SITE), 10);
});

test('★ 幂等键稳定：10 轮巡检的事实指纹一致 → 结论可复现', async () => {
  const harness = await makeHarness();
  await harness.patrol.runOnce();
  const records = harness.evaluations.records;
  const first = records[0]!;
  await harness.patrol.runOnce();
  const second = harness.evaluations.records[1]!;
  assert.equal(first.decision, second.decision);
  assert.equal(first.factFingerprint, second.factFingerprint, '同一输入必须得到同一指纹');
  assert.equal(first.policyVersion, second.policyVersion);
});

test('指纹：只由参与判定的值决定，键顺序无关', () => {
  const a = fingerprintFacts({ values: { 'fact.email.domain': 'x.edu.cn', 'fact.email.verified': true } });
  const b = fingerprintFacts({ values: { 'fact.email.verified': true, 'fact.email.domain': 'x.edu.cn' } });
  assert.equal(a, b);
  const c = fingerprintFacts({ values: { 'fact.email.domain': 'y.edu.cn', 'fact.email.verified': true } });
  assert.notEqual(a, c);
});

// ─────────────────────────── H1 端到端 ───────────────────────────

test('★ H1 端到端：渠道故障（事实缺失）→ 不产生任何动作，状态保持 granted', async () => {
  const harness = await makeHarness();
  // 第 1 轮：正常授予
  await harness.patrol.runOnce();
  assert.equal(harness.downstreamWrites.length, 1);

  // 第 2 轮：把事实清掉（模拟渠道故障 / 采集失败）
  await harness.factStore.purgeExpired(new Date(NOW.getTime() + 40 * 86_400_000)); // 30d TTL 后过期
  const report = await harness.patrol.runOnce();

  assert.equal(report.stats.indeterminate, 1, '过期事实 → 缺失 → indeterminate');
  assert.equal(report.stats.actionsExecuted, 0, '★ 不确定时不得产生任何动作');
  assert.equal(harness.downstreamWrites.length, 1, '下游不应收到额外写回');

  const state = await harness.states.get(SITE, '42', 'edu-upgrade');
  assert.equal(state!.state, 'granted', '★ 状态必须保持 granted（不得因渠道故障降级）');
});

test('★ 端到端：教育邮箱改为 gmail → 进入 at_risk + 宽限期，**不立即收回**', async () => {
  const harness = await makeHarness();
  await harness.patrol.runOnce();
  assert.equal(harness.downstreamWrites.length, 1);

  // 邮箱改为非教育域并重新采集
  harness.setSubjectEmail('alice@gmail.com');
  await harness.emailPipeline.emit(
    { domain: 'gmail.com', is_edu: false, matched_rule: 'none', verified: true },
    NOW,
  );
  const report = await harness.patrol.runOnce();

  assert.equal(report.stats.unsatisfied, 1);
  const state = await harness.states.get(SITE, '42', 'edu-upgrade');
  assert.equal(state!.state, 'at_risk', '★ 必须先进 at_risk（H2：不立即收回）');
  assert.equal(harness.downstreamWrites.length, 1, '宽限期内不得写回下游');
});

test('★ 端到端：at_risk 期间事实恢复 → 回到 granted 且不重复写回', async () => {
  const harness = await makeHarness();
  await harness.patrol.runOnce();

  // 掉到 at_risk
  harness.setSubjectEmail('alice@gmail.com');
  await harness.emailPipeline.emit({ domain: 'gmail.com', is_edu: false, matched_rule: 'none', verified: true }, NOW);
  await harness.patrol.runOnce();
  assert.equal((await harness.states.get(SITE, '42', 'edu-upgrade'))!.state, 'at_risk');

  // 恢复教育邮箱
  harness.setSubjectEmail('alice@tsinghua.edu.cn');
  await harness.emailPipeline.emit(
    { domain: 'tsinghua.edu.cn', is_edu: true, matched_rule: 'allow:*.edu.cn', verified: true },
    NOW,
  );
  const report = await harness.patrol.runOnce();

  const state = await harness.states.get(SITE, '42', 'edu-upgrade');
  assert.equal(state!.state, 'granted', '事实恢复 → 回到 granted');
  assert.equal(state!.graceUntil ?? null, null, '宽限应被撤销');
  // ★ 目标分组已是 basic：本次是「重新授予」，但执行器会因值不变而 skipped
  assert.equal(report.stats.actionsExecuted, 1, '产生了一次动作尝试');
  assert.equal(harness.downstreamWrites.length, 1, '★ 值未变 → 下游不应再次收到写回');
});

// ─────────────────────────── 可复现性与可观测 ───────────────────────────

test('巡检报告包含逐主体逐策略结论与统计（可观测）', async () => {
  const harness = await makeHarness();
  const report = await harness.patrol.runOnce();
  assert.equal(report.siteId, SITE);
  assert.equal(report.policies, 1);
  assert.equal(report.subjects, 1);
  assert.equal(report.outcomes.length, 1);
  const outcome = report.outcomes[0]!;
  assert.equal(outcome.externalId, '42');
  assert.equal(outcome.policyCode, 'edu-upgrade');
  assert.equal(outcome.decision, 'satisfied');
  assert.equal(outcome.stateBefore, 'unknown');
  assert.equal(outcome.stateAfter, 'granted');
  assert.equal(outcome.changed, true);
  assert.equal(outcome.actionIntent, 'grant');
  assert.equal(outcome.planOutcome!.status, 'succeeded');
  assert.equal(report.stats.verifyFailed, 0, '回读应确认目标达成');
});

test('not_applicable 的策略不计入状态迁移（match 不通过时主体不受影响）', async () => {
  const harness = await makeHarness();
  // 让 match 不通过：下游主体 status=2（禁用）→ user.status 映射为 suspended
  const patched = new Patrol({
    siteId: SITE,
    policies: [EDU_POLICY],
    directory: {
      async list() {
        return [{ externalId: '42', email: 'alice@tsinghua.edu.cn', emailVerified: true, attributes: { status: 2 } }];
      },
      async count() {
        return 1;
      },
    },
    facts: harness.factStore,
    factSources: [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }],
    states: harness.states,
    evaluations: harness.evaluations,
    lifecycle: { gracePeriodMs: GRACE_MS },
    executor: new ActionExecutor({
      registry: new ActionRegistry(),
      log: new InMemoryActionLogStore(),
      sleep: async () => undefined,
    }),
    logger: silentLogger,
    now: () => NOW,
  });
  const report = await patched.runOnce();
  assert.equal(report.stats.notApplicable, 1);
  assert.equal(report.stats.stateChanged, 0);
  assert.equal(report.stats.actionsExecuted, 0);
});

test('巡检：未注册的动作导致失败并计入报告（不静默跳过）', async () => {
  const harness = await makeHarness();
  const patched = new Patrol({
    siteId: SITE,
    policies: [EDU_POLICY],
    directory: {
      async list() {
        return [{ externalId: '42', email: 'alice@tsinghua.edu.cn', emailVerified: true, attributes: { group: 'default', status: 1 } }];
      },
      async count() {
        return 1;
      },
    },
    facts: harness.factStore,
    factSources: [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }],
    states: new InMemoryLifecycleStateStore(),
    evaluations: new InMemoryEvaluationStore(),
    lifecycle: { gracePeriodMs: GRACE_MS },
    // ★ 空注册表：动作无法执行
    executor: new ActionExecutor({ registry: new ActionRegistry(), log: new InMemoryActionLogStore(), sleep: async () => undefined }),
    logger: silentLogger,
    now: () => NOW,
  });
  const report = await patched.runOnce();
  assert.equal(report.outcomes[0]!.planOutcome!.status, 'failed');
  assert.match(report.outcomes[0]!.planOutcome!.steps[0]!.error!, /未注册的动作/);
});

test('★ 事实按主体隔离：两个主体读到各自的事实（早期漏传主体 id 时所有人共享一份）', async () => {
  const emailManifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const factStore = new InMemoryFactStore();
  const now = new Date('2025-06-01T00:00:00Z');

  // 主体 1 是教育邮箱，主体 2 不是 —— 若漏传主体 id，两人会读到同一份事实
  await new FactPipeline({ store: factStore, manifest: emailManifest, userId: '1' }).emit(
    { domain: 'tsinghua.edu.cn', is_edu: true, matched_rule: 'allow:*.edu.cn', verified: true },
    now,
  );
  await new FactPipeline({ store: factStore, manifest: emailManifest, userId: '2' }).emit(
    { domain: 'gmail.com', is_edu: false, matched_rule: 'none', verified: true },
    now,
  );

  const registry = new ActionRegistry();
  registry.register('checkin:grant', { async execute() { return { status: 'succeeded' }; } });

  const patrol = new Patrol({
    siteId: 'site-1',
    policies: [
      {
        code: 'edu',
        name: '教育邮箱',
        version: 1,
        enabled: true,
        spec: { requirements: { expression: { matches: { 'fact.email.domain': ['*.edu.cn'] } } } },
      },
    ],
    directory: {
      async list() {
        return [
          { externalId: '1', email: 'a@tsinghua.edu.cn', emailVerified: true, attributes: {} },
          { externalId: '2', email: 'b@gmail.com', emailVerified: true, attributes: {} },
        ];
      },
      async count() { return 2; },
    },
    facts: factStore,
    factSources: [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }],
    states: new InMemoryLifecycleStateStore(),
    evaluations: new InMemoryEvaluationStore(),
    lifecycle: { gracePeriodMs: 72 * 3_600_000 },
    executor: new ActionExecutor({ registry, log: new InMemoryActionLogStore(), sleep: async () => undefined, now: () => now }),
    logger: silentLogger,
    now: () => now,
  });

  const report = await patrol.runOnce();
  const byUser = new Map(report.outcomes.map((o) => [o.externalId, o.decision]));
  assert.equal(byUser.get('1'), 'satisfied', '★ 主体 1 是教育邮箱 → 满足');
  assert.equal(byUser.get('2'), 'unsatisfied', '★ 主体 2 不是教育邮箱 → 不满足（不得共享主体 1 的事实）');
  assert.equal(report.stats.satisfied, 1);
  assert.equal(report.stats.unsatisfied, 1);
});
