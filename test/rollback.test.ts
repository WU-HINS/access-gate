/**
 * 回滚编排验收（M6-2）—— 单条 / 按主体 / 按策略批量。
 *
 * ★ 本文件最重要的断言：**回滚 ≠ 把状态字段改回去**。
 *   直觉做法是「把 state 从 granted 改成 at_risk」，但那会得到一个
 *   **任何一次求值都不会产生的状态**——它看起来正常，却与现实不符
 *   （中间可能已发生事实更新、绑定撤销、策略再改）。
 *
 *   正确做法是「切版本 + 重新求值」，测试用「回滚后的状态 == 直接用旧版本跑一轮的结果」
 *   来锁定这条语义。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeRollbackPreview,
  makeSubjectScopedDirectory,
  rollbackByPolicy,
  rollbackForSubject,
  type RollbackDeps,
} from '../src/core/rollback.ts';
import { InMemoryEvaluationStore, InMemoryLifecycleStateStore, Patrol, type SubjectDirectory } from '../src/core/patrol.ts';
import { ActionExecutor, ActionRegistry, InMemoryActionLogStore } from '../src/core/action-executor.ts';
import { FactPipeline, InMemoryFactStore } from '../src/plugin/host-api.ts';
import { EMAIL_DOMAIN_MANIFEST, evaluateEmailDomain } from '../src/plugin/builtin/email-domain.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import type { PolicyDocument } from '../src/policy/model.ts';

const SITE = 'site-1';
const NOW = new Date('2025-06-01T00:00:00Z');
const GRACE_MS = 72 * 3_600_000;

/** v1：只认 *.edu（宽松）——回滚目标 */
const POLICY_V1: PolicyDocument = {
  code: 'edu',
  name: '教育邮箱',
  version: 1,
  enabled: true,
  spec: {
    requirements: { expression: { matches: { 'fact.email.domain': ['*.edu'] } } },
    actions: { onSatisfied: [{ action: 'grant:x' }] },
  },
};

/** v2：收紧到 *.edu.cn（严格）——当前生效 */
const POLICY_V2: PolicyDocument = {
  ...POLICY_V1,
  version: 2,
  spec: {
    requirements: { expression: { matches: { 'fact.email.domain': ['*.edu.cn'] } } },
    actions: { onSatisfied: [{ action: 'grant:x' }] },
  },
};

/** 三个主体：一个在 v1/v2 都满足，一个只在 v1 满足，一个都不满足 */
const SUBJECTS = [
  { externalId: 's1', email: 'a@tsinghua.edu.cn', domain: 'tsinghua.edu.cn' },
  { externalId: 's2', email: 'b@mit.edu', domain: 'mit.edu' },
  { externalId: 's3', email: 'c@gmail.com', domain: 'gmail.com' },
];

interface Harness {
  deps: RollbackDeps;
  states: InMemoryLifecycleStateStore;
  policies: Map<number, PolicyDocument>;
  activeVersion: number;
  progress: { done: number; total: number }[];
  registry: ActionRegistry;
}

async function makeHarness(): Promise<Harness> {
  const emailManifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const factStore = new InMemoryFactStore();
  for (const subject of SUBJECTS) {
    const facts = evaluateEmailDomain({
      email: subject.email,
      emailVerified: true,
      config: { allowDomains: ['*.edu', '*.edu.cn'], requireVerified: true },
    });
    if (facts !== null) await new FactPipeline({ store: factStore, manifest: emailManifest, userId: subject.externalId }).emit({ ...facts }, NOW);
  }

  const directory: SubjectDirectory = {
    async list(_siteId, limit, offset) {
      return SUBJECTS.slice(offset, offset + limit).map((subject) => ({
        externalId: subject.externalId,
        email: subject.email,
        emailVerified: true,
        attributes: {},
      }));
    },
    async count() {
      return SUBJECTS.length;
    },
  };

  const registry = new ActionRegistry();
  registry.register('grant:x', { async execute() { return { status: 'succeeded' }; } });
  const executor = new ActionExecutor({ registry, log: new InMemoryActionLogStore(), sleep: async () => undefined, now: () => NOW });
  const states = new InMemoryLifecycleStateStore();
  const evaluations = new InMemoryEvaluationStore();
  const policies = new Map<number, PolicyDocument>([[1, POLICY_V1], [2, POLICY_V2]]);
  const harness: Harness = {
    states,
    policies,
    activeVersion: 2,
    progress: [],
    registry,
    deps: undefined as unknown as RollbackDeps,
  };

  harness.deps = {
    async switchVersion(_siteId, _code, version) {
      const policy = policies.get(version);
      if (policy === undefined) throw new Error(`没有版本 ${version}`);
      harness.activeVersion = version;
      return policy;
    },
    async currentPolicy() {
      return policies.get(harness.activeVersion);
    },
    buildPatrol({ policies: selected, directory: scoped, maxSubjects }) {
      return new Patrol({
        siteId: SITE,
        policies: selected,
        directory: scoped,
        facts: factStore,
        factSources: [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }],
        states,
        evaluations,
        lifecycle: { gracePeriodMs: GRACE_MS },
        executor,
        logger: silentLogger,
        now: () => NOW,
        ...(maxSubjects === undefined ? {} : { maxSubjects }),
      });
    },
    directory,
    logger: silentLogger,
    batchSize: 2,
    onProgress: (done, total) => harness.progress.push({ done, total }),
  };
  return harness;
}

// ─────────────────────────── ★ 回滚 = 重新求值 ───────────────────────────

test('★ M6-2：按策略批量回滚 = **切版本 + 重新求值**（不是改状态字段）', async () => {
  const harness = await makeHarness();

  // ① 先用 v2（严格）跑一轮：s2（mit.edu）不满足 → 不会 granted
  const v2Patrol = harness.deps.buildPatrol({ policies: [POLICY_V2], directory: harness.deps.directory });
  await v2Patrol.runOnce();
  assert.equal((await harness.states.get(SITE, 's2', 'edu'))!.state, 'at_risk', 's2 在 v2 下不满足');

  // ② 回滚到 v1（宽松）：s2 应重新被判定为满足 → granted
  const result = await rollbackByPolicy(harness.deps, { siteId: SITE, policyCode: 'edu', targetVersion: 1 });
  assert.equal(harness.activeVersion, 1, '版本指针已切回 v1');
  assert.ok(result.subjectsProcessed >= 3, `应处理全部主体（实际 ${result.subjectsProcessed}）`);
  assert.equal((await harness.states.get(SITE, 's2', 'edu'))!.state, 'granted', '★ s2 回滚后重新获得权限（因重新求值，不是字段反转）');

  // ③ ★ 关键：回滚后的状态 == 直接用 v1 从零跑一轮的结果
  const fresh = await makeHarness();
  await fresh.deps.buildPatrol({ policies: [POLICY_V1], directory: fresh.deps.directory }).runOnce();
  for (const subject of SUBJECTS) {
    const fromRollback = await harness.states.get(SITE, subject.externalId, 'edu');
    const fromDirect = await fresh.states.get(SITE, subject.externalId, 'edu');
    assert.equal(
      fromRollback?.state,
      fromDirect?.state,
      `★ ${subject.externalId}：回滚得到的状态必须与直接用旧版本求值一致`,
    );
  }
});

test('★ M6-2：按策略批量回滚**分批执行**且进度可观测', async () => {
  const harness = await makeHarness();
  const result = await rollbackByPolicy(harness.deps, { siteId: SITE, policyCode: 'edu', targetVersion: 1 });
  assert.ok(harness.progress.length >= 2, `★ 3 个主体 / 每批 2 个 = 至少 2 批（实际 ${harness.progress.length}）`);
  assert.equal(result.subjectsProcessed, 3);
  assert.ok(result.durationMs >= 0);
});

test('★ M6-2：按主体回滚只影响该主体（其他主体状态不变）', async () => {
  const harness = await makeHarness();
  // 先用 v2 跑一轮，让 s2 处于 at_risk
  await harness.deps.buildPatrol({ policies: [POLICY_V2], directory: harness.deps.directory }).runOnce();
  const beforeS1 = (await harness.states.get(SITE, 's1', 'edu'))!.state;
  const beforeS3 = (await harness.states.get(SITE, 's3', 'edu'))!.state;

  const result = await rollbackForSubject(harness.deps, { siteId: SITE, policyCode: 'edu', targetVersion: 1, externalId: 's2' });
  assert.equal(result.subjectsProcessed, 1, '★ 只处理 1 个主体');

  assert.equal((await harness.states.get(SITE, 's2', 'edu'))!.state, 'granted', 's2 被单独拉回');
  assert.equal((await harness.states.get(SITE, 's1', 'edu'))!.state, beforeS1, 's1 不受影响');
  assert.equal((await harness.states.get(SITE, 's3', 'edu'))!.state, beforeS3, 's3 不受影响');
});

test('★ M6-2：重复回滚同一版本是**幂等**的（不产生额外动作）', async () => {
  const harness = await makeHarness();
  const first = await rollbackByPolicy(harness.deps, { siteId: SITE, policyCode: 'edu', targetVersion: 1 });
  assert.ok(first.actionsExecuted > 0, '首次回滚应有实际动作');

  const second = await rollbackByPolicy(harness.deps, { siteId: SITE, policyCode: 'edu', targetVersion: 1 });
  assert.equal(second.stateChanged, 0, '★ 再次回滚不应有状态迁移');
  assert.equal(second.actionsExecuted, 0, '★ 再次回滚不应执行动作（幂等键复用）');
  assert.equal(second.failures.length, 0);
});

test('★ M6-2：`switchVersion` 在已是目标版本时**不被调用**（跳过切换，仅重算）', async () => {
  const harness = await makeHarness();
  let calls = 0;
  const original = harness.deps.switchVersion;
  harness.deps.switchVersion = async (siteId, code, version) => {
    calls += 1;
    return original(siteId, code, version);
  };
  harness.activeVersion = 1; // 已经是目标版本
  const result = await rollbackByPolicy(harness.deps, { siteId: SITE, policyCode: 'edu', targetVersion: 1 });
  assert.equal(calls, 0, '★ 已在目标版本时不应重复切换');
  assert.equal(result.targetVersion, 1);
});

// ─────────────────────────── 失败与错误分离 ───────────────────────────

test('★ M6-2：单个主体的动作失败**不中断整体**，失败被逐条列出', async () => {
  const harness = await makeHarness();
  // 让 s2 的动作失败
  harness.registry.register('grant:x', {
    async execute(context) {
      if (context.userId === 's2') return { status: 'failed', reason: '下游拒绝', retryable: false };
      return { status: 'succeeded' };
    },
  });
  const result = await rollbackByPolicy(harness.deps, { siteId: SITE, policyCode: 'edu', targetVersion: 1 });
  assert.ok(result.failures.some((failure) => failure.externalId === 's2'), '★ 失败必须被列出');
  assert.match(result.failures[0]!.message, /下游拒绝/, '★ 失败原因必须保留（不被吞成笼统文案）');
  assert.equal(result.subjectsProcessed, 3, '整体仍然处理完全部主体（失败不中断）');

  // ★ 「不受影响」用**基准比较**证明，而不是硬编码某个状态：
  //   同一情形下不注入失败，其余主体的状态应与本次完全一致。
  const baseline = await makeHarness();
  await rollbackByPolicy(baseline.deps, { siteId: SITE, policyCode: 'edu', targetVersion: 1 });
  for (const externalId of ['s1', 's3']) {
    const withFailure = (await harness.states.get(SITE, externalId, 'edu'))?.state;
    const withoutFailure = (await baseline.states.get(SITE, externalId, 'edu'))?.state;
    assert.equal(withFailure, withoutFailure, `★ ${externalId} 的状态不应受 s2 失败影响`);
  }
  // 顺带锁住域名匹配语义：`*.edu` **不**匹配 `tsinghua.edu.cn`（那是 .edu.cn）
  assert.equal((await baseline.states.get(SITE, 's1', 'edu'))?.state, 'at_risk', 's1 在 v1（*.edu）下不满足');
});

test('M6-2：回滚不存在的版本 → 明确报错（不静默失败）', async () => {
  const harness = await makeHarness();
  await assert.rejects(
    rollbackByPolicy(harness.deps, { siteId: SITE, policyCode: 'edu', targetVersion: 99 }),
    /没有版本 99/,
  );
});

// ─────────────────────────── 目录包装与影响面 ───────────────────────────

test('★ M6-2：`makeSubjectScopedDirectory` 只返回目标主体（两种回滚形态共用同一路径）', async () => {
  const harness = await makeHarness();
  const scoped = makeSubjectScopedDirectory(harness.deps.directory, 's2');
  const list = await scoped.list(SITE, 10, 0);
  assert.deepEqual(list.map((subject) => subject.externalId), ['s2']);
  assert.equal(await scoped.count(SITE), 1);
  // 偏移 >0 时为空（避免 Patrol 分页重复处理）
  assert.deepEqual(await scoped.list(SITE, 10, 1), []);
  // 不存在的目标 → 空
  assert.deepEqual(await makeSubjectScopedDirectory(harness.deps.directory, 'ghost').list(SITE, 10, 0), []);
});

test('★ M6-2：回滚前的影响面预估要**提醒会踢下线**（按按钮前必须知道会动多少人）', () => {
  const warning = describeRollbackPreview({ targetVersion: 1, currentlyGranted: 100, estimatedRevocations: 37, sampled: 500 });
  assert.equal(warning.estimatedRevocations, 37);
  assert.match(warning.note, /37 个主体失去权限/);
  assert.match(warning.note, /踢下线/, '★ 必须明确提醒动作后果');

  const safe = describeRollbackPreview({ targetVersion: 1, currentlyGranted: 100, estimatedRevocations: 0, sampled: 500 });
  assert.match(safe.note, /不收回任何主体的权限/);
});
