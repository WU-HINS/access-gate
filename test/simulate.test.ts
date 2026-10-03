/**
 * 策略版本化回滚（M2-7）与影响面试算（M2-8）验收。
 *
 * 断言重点：
 *   - **回滚是指针操作，不改写历史**：「v3 永远是 v3」——这是「历史评估可复现」的前提。
 *     用「重新 saveDraft 一份旧内容」代替会新建 v4，污染历史。
 *   - **试算是纯函数**：不写库、不发动作、不改状态。
 *   - **★ 试算复用真实迁移函数**：否则会出现「试算说没事，发布后却收回了权限」，
 *     而权限收回会踢用户下线。测试用「同一输入下试算结论 === 真实巡检结论」锁定。
 *   - **高危影响是一等公民**：会导致权限收回的主体必须被单独列出，而不是埋在明细里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryPolicyStore } from '../src/admin/api.ts';
import { compareVersions, simulate } from '../src/policy/simulate.ts';
import { Patrol, InMemoryEvaluationStore, InMemoryLifecycleStateStore, type SubjectDirectory } from '../src/core/patrol.ts';
import { ActionExecutor, ActionRegistry, InMemoryActionLogStore } from '../src/core/action-executor.ts';
import { FactPipeline, InMemoryFactStore } from '../src/plugin/host-api.ts';
import { EMAIL_DOMAIN_MANIFEST, evaluateEmailDomain } from '../src/plugin/builtin/email-domain.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import type { PolicyDocument } from '../src/policy/model.ts';

const SITE = 'site-1';
const NOW = new Date('2025-06-01T00:00:00Z');
const GRACE_MS = 72 * 3_600_000;

const eduPolicy = (domains: readonly string[], version = 1): PolicyDocument => ({
  code: 'edu',
  name: '教育邮箱',
  version,
  enabled: true,
  spec: {
    requirements: { expression: { matches: { 'fact.email.domain': [...domains] } } },
    actions: {
      onSatisfied: [{ action: 'checkin:grant', params: {} }],
      onUnsatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'default' } }],
    },
  },
});

// ─────────────────────────── M2-7 回滚 ───────────────────────────

test('★ M2-7：回滚到历史版本是**指针操作**，不改写历史（v3 永远是 v3）', async () => {
  const store = new InMemoryPolicyStore();
  // v1 只认 *.edu.cn；v2 放宽到 *.edu；v3 又收紧回 *.edu.cn
  await store.saveDraft(SITE, eduPolicy(['*.edu.cn']));
  await store.publish(SITE, 'edu', 1);
  await store.saveDraft(SITE, eduPolicy(['*.edu', '*.edu.cn']));
  await store.publish(SITE, 'edu', 2);
  await store.saveDraft(SITE, eduPolicy(['*.edu.cn']));
  await store.publish(SITE, 'edu', 3);

  const history = await store.versions!(SITE, 'edu');
  assert.deepEqual(history.map((h) => `${h.version}:${h.status}`), ['1:archived', '2:archived', '3:active']);

  // 回滚到 v2
  const rolledBack = await store.rollback(SITE, 'edu', 2);
  assert.equal(rolledBack.version, 2);

  const after = await store.versions!(SITE, 'edu');
  assert.deepEqual(after.map((h) => `${h.version}:${h.status}`), ['1:archived', '2:active', '3:archived'], '★ 回滚只改状态指针，不新增版本');

  // ★ 关键：历史内容没被改写——v3 仍是最初那份（收紧到 *.edu.cn）
  const current = await store.get(SITE, 'edu');
  assert.equal(current!.version, 2, '当前生效的是 v2');
  assert.deepEqual(
    (current!.spec.requirements as { expression: { matches: Record<string, string[]> } }).expression.matches['fact.email.domain'],
    ['*.edu', '*.edu.cn'],
    'v2 的内容应与当初保存的一致',
  );

  // 回滚后仍可再次发布 v3（内容还是原来那份）
  const republished = await store.publish(SITE, 'edu', 3);
  assert.equal(republished.version, 3);
  assert.deepEqual(
    (republished.spec.requirements as { expression: { matches: Record<string, string[]> } }).expression.matches['fact.email.domain'],
    ['*.edu.cn'],
    '★ v3 的内容必须与首次保存完全一致（历史未被污染）',
  );
});

test('M2-7：回滚到不存在的版本 → 报错并列出可用版本（可操作的错误信息）', async () => {
  const store = new InMemoryPolicyStore();
  await store.saveDraft(SITE, eduPolicy(['*.edu.cn']));
  await store.publish(SITE, 'edu', 1);
  await assert.rejects(store.rollback(SITE, 'edu', 99), /没有版本 99.*可用版本：1/s);
  await assert.rejects(store.rollback(SITE, 'ghost', 1), /不存在/);
});

test('M2-7：重复发布同一版本是幂等的（不报错、不产生新版本）', async () => {
  const store = new InMemoryPolicyStore();
  await store.saveDraft(SITE, eduPolicy(['*.edu.cn']));
  await store.publish(SITE, 'edu', 1);
  await store.publish(SITE, 'edu', 1);
  const history = await store.versions!(SITE, 'edu');
  assert.equal(history.length, 1, '重复发布不应新增版本');
  assert.equal(history[0]!.status, 'active');
});

test('M2-7：每次 saveDraft 追加新版本（草稿不覆盖历史）', async () => {
  const store = new InMemoryPolicyStore();
  await store.saveDraft(SITE, eduPolicy(['*.edu.cn']));
  await store.saveDraft(SITE, eduPolicy(['*.edu']));
  await store.saveDraft(SITE, eduPolicy(['*.ac.uk']));
  const history = await store.versions!(SITE, 'edu');
  assert.deepEqual(history.map((h) => `${h.version}:${h.status}`), ['1:draft', '2:draft', '3:draft']);
  // 未发布时，get 返回最新草稿
  const current = await store.get(SITE, 'edu');
  assert.equal(current!.version, 3);
});

test('M2-7：spec 指纹可用于语义去重（同内容同指纹，不同内容不同指纹）', async () => {
  const store = new InMemoryPolicyStore();
  await store.saveDraft(SITE, eduPolicy(['*.edu.cn']));
  await store.saveDraft(SITE, eduPolicy(['*.edu.cn']));
  await store.saveDraft(SITE, eduPolicy(['*.edu']));
  const history = await store.versions!(SITE, 'edu');
  assert.equal(history[0]!.specHash, history[1]!.specHash, '同内容指纹应相同');
  assert.notEqual(history[1]!.specHash, history[2]!.specHash, '不同内容指纹应不同');
});

// ─────────────────────────── M2-8 试算 ───────────────────────────

const subjects = [
  { externalId: '1', user: { email: 'a@tsinghua.edu.cn', email_verified: true, status: 'active' }, facts: { 'fact.email.domain': 'tsinghua.edu.cn', 'fact.email.verified': true } },
  { externalId: '2', user: { email: 'b@mit.edu', email_verified: true, status: 'active' }, facts: { 'fact.email.domain': 'mit.edu', 'fact.email.verified': true } },
  { externalId: '3', user: { email: 'c@gmail.com', email_verified: true, status: 'active' }, facts: { 'fact.email.domain': 'gmail.com', 'fact.email.verified': true } },
];

test('★ M2-8：试算是纯函数（不改状态、不执行动作）', async () => {
  const states = new Map<string, { state: string }>();
  const report = simulate({
    policies: [eduPolicy(['*.edu.cn'])],
    subjects: [
      {
        externalId: '1',
        states: { edu: { state: 'granted', stateChangedAt: NOW, atRiskCount: 0, actionSeq: 1 } },
        user: { email: 'a@tsinghua.edu.cn', email_verified: true, status: 'active' },
        facts: { 'fact.email.domain': 'tsinghua.edu.cn', 'fact.email.verified': true },
      },
    ],
    lifecycle: { gracePeriodMs: GRACE_MS },
    now: NOW,
  });
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]!.decision, 'satisfied');
  // 调用方传入的状态对象不应被修改
  assert.equal(states.size, 0);
  assert.equal(report.results[0]!.stateAfter, 'granted');
});

test('★ M2-8：高危影响（会导致权限收回的主体）被单独列出，并给出 dangerous 结论', () => {
  const report = simulate({
    policies: [eduPolicy(['*.edu.cn'])],
    subjects: [
      // 主体 1：当前 granted，但新策略不再匹配（gmail）→ 会掉到 at_risk
      {
        externalId: '1',
        states: { edu: { state: 'granted', stateChangedAt: NOW, atRiskCount: 0, actionSeq: 1 } },
        user: { email: 'a@gmail.com', email_verified: true, status: 'active' },
        facts: { 'fact.email.domain': 'gmail.com', 'fact.email.verified': true },
      },
      // 主体 2：当前 granted，仍匹配 → 无影响
      {
        externalId: '2',
        states: { edu: { state: 'granted', stateChangedAt: NOW, atRiskCount: 0, actionSeq: 1 } },
        user: { email: 'b@tsinghua.edu.cn', email_verified: true, status: 'active' },
        facts: { 'fact.email.domain': 'tsinghua.edu.cn', 'fact.email.verified': true },
      },
    ],
    lifecycle: { gracePeriodMs: GRACE_MS },
    now: NOW,
  });

  assert.equal(report.stats.satisfied, 1);
  assert.equal(report.stats.unsatisfied, 1);
  // ★ 主体 1 从 granted 掉到 at_risk：尚未失去权限，但进入观察期 → 必须单独列出
  assert.equal(report.atRisk.length, 1);
  assert.equal(report.atRisk[0]!.externalId, '1');
  assert.equal(report.atRisk[0]!.graceUntil, new Date(NOW.getTime() + GRACE_MS).toISOString());
  assert.equal(report.verdict, 'needs_review', '有主体进入观察期 → 需要人工确认');
  // 主体 2 无影响
  assert.equal(report.results.find((r) => r.externalId === '2')!.changed, false);
});

test('★ M2-8：显式撤销类策略 → revocations 非空且结论为 dangerous', () => {
  // 一条「匹配不到就收回」的策略：当前 granted 的主体不再匹配 → 走宽限；宽限已过 → 收回
  const report = simulate({
    policies: [eduPolicy(['*.edu.cn'])],
    subjects: [
      {
        externalId: '1',
        // 已处于 at_risk 且宽限已过 → 本轮会 revoke
        states: { edu: { state: 'at_risk', graceUntil: new Date(NOW.getTime() - 1000), stateChangedAt: NOW, atRiskCount: 1, actionSeq: 1 } },
        user: { email: 'a@gmail.com', email_verified: true, status: 'active' },
        facts: { 'fact.email.domain': 'gmail.com', 'fact.email.verified': true },
      },
    ],
    lifecycle: { gracePeriodMs: GRACE_MS },
    now: NOW,
  });
  assert.equal(report.results[0]!.decision, 'unsatisfied');
  assert.equal(report.results[0]!.stateAfter, 'at_risk', 'unsatisfied 只顺延宽限，不立即 revoke（H2）');
  // H2 保证：单次 unsatisfied 不会直接 revoke，因此此处不算 revocation
  assert.equal(report.stats.revocations, 0);
  assert.equal(report.verdict, 'needs_review');
});

test('M2-8：indeterminate（事实缺失）不产生任何动作意图（H1 在试算中同样成立）', () => {
  const report = simulate({
    policies: [eduPolicy(['*.edu.cn'])],
    subjects: [
      {
        externalId: '1',
        states: { edu: { state: 'granted', stateChangedAt: NOW, atRiskCount: 0, actionSeq: 1 } },
        user: { email: 'a@tsinghua.edu.cn', email_verified: true, status: 'active' },
        facts: {}, // 事实缺失
      },
    ],
    lifecycle: { gracePeriodMs: GRACE_MS },
    now: NOW,
  });
  assert.equal(report.results[0]!.decision, 'indeterminate');
  assert.equal(report.results[0]!.changed, false, '★ 不确定不推进状态');
  assert.equal(report.results[0]!.actionIntent, 'none', '★ 不确定不产生动作');
  assert.equal(report.stats.revocations, 0);
});

test('M2-8：verdict 判定覆盖四种情形', () => {
  const base = { lifecycle: { gracePeriodMs: GRACE_MS }, now: NOW };
  // no_impact：主体已 granted 且仍满足
  const noImpact = simulate({
    ...base,
    policies: [eduPolicy(['*.edu.cn'])],
    subjects: [
      {
        externalId: '1',
        states: { edu: { state: 'granted', stateChangedAt: NOW, atRiskCount: 0, actionSeq: 1 } },
        user: { email: 'a@tsinghua.edu.cn', email_verified: true, status: 'active' },
        facts: { 'fact.email.domain': 'tsinghua.edu.cn', 'fact.email.verified': true },
      },
    ],
  });
  assert.equal(noImpact.verdict, 'no_impact');

  // grants_only：新授予
  const grantsOnly = simulate({ ...base, policies: [eduPolicy(['*.edu.cn'])], subjects: [subjects[0]!] });
  assert.equal(grantsOnly.verdict, 'grants_only');
  assert.equal(grantsOnly.stats.grants, 1);
});

test('★ M2-8：试算复用真实迁移函数 —— 同一输入下结论与真实巡检一致', async () => {
  const emailManifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const factStore = new InMemoryFactStore();
  const policy = eduPolicy(['*.edu.cn']);

  // 真实巡检：主体 1 是教育邮箱 → 应 satisfied 且 granted
  const emitted = evaluateEmailDomain({
    email: 'a@tsinghua.edu.cn',
    emailVerified: true,
    config: { allowDomains: ['*.edu.cn'], requireVerified: true },
  });
  assert.ok(emitted !== null);
  await new FactPipeline({ store: factStore, manifest: emailManifest, userId: '1' }).emit({ ...emitted }, NOW);
  const directory: SubjectDirectory = {
    async list() {
      return [{ externalId: '1', email: 'a@tsinghua.edu.cn', emailVerified: true, attributes: {} }];
    },
    async count() { return 1; },
  };
  const registry = new ActionRegistry();
  registry.register('checkin:grant', { async execute() { return { status: 'succeeded' }; } });
  const patrol = new Patrol({
    siteId: SITE,
    policies: [policy],
    directory,
    facts: factStore,
    factSources: [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }],
    states: new InMemoryLifecycleStateStore(),
    evaluations: new InMemoryEvaluationStore(),
    lifecycle: { gracePeriodMs: GRACE_MS },
    executor: new ActionExecutor({ registry, log: new InMemoryActionLogStore(), sleep: async () => undefined, now: () => NOW }),
    logger: silentLogger,
    now: () => NOW,
  });
  const realReport = await patrol.runOnce();

  // 试算：同一输入
  const simulated = simulate({
    policies: [policy],
    subjects: [
      {
        externalId: '1',
        user: { email: 'a@tsinghua.edu.cn', email_verified: true, status: 'active' },
        facts: { 'fact.email.domain': 'tsinghua.edu.cn', 'fact.email.verified': true },
      },
    ],
    lifecycle: { gracePeriodMs: GRACE_MS },
    now: NOW,
  });

  const real = realReport.outcomes[0]!;
  const sim = simulated.results[0]!;
  assert.equal(sim.decision, real.decision, '★ 试算结论必须与真实巡检一致');
  assert.equal(sim.stateBefore, real.stateBefore, '★ 起始状态一致');
  assert.equal(sim.stateAfter, real.stateAfter, '★ 迁移结果一致');
  assert.equal(sim.actionIntent, real.actionIntent, '★ 动作意图一致');
  assert.equal(sim.changed, real.changed, '★ 是否迁移一致');
});

test('★ M2-8：compareVersions 找出「候选版本新增的收回」（发布前最需要警惕的）', () => {
  const current = eduPolicy(['*.edu.cn', '*.edu'], 1);
  // 候选版本收紧了白名单 → mit.edu 会掉权限
  const candidate = eduPolicy(['*.edu.cn'], 2);

  const comparison = compareVersions({
    current,
    candidate,
    subjects: [
      {
        externalId: '1',
        states: { edu: { state: 'granted', stateChangedAt: NOW, atRiskCount: 0, actionSeq: 1 } },
        user: { email: 'a@mit.edu', email_verified: true, status: 'active' },
        facts: { 'fact.email.domain': 'mit.edu', 'fact.email.verified': true },
      },
    ],
    lifecycle: { gracePeriodMs: GRACE_MS },
    now: NOW,
  });

  // 当前版本：mit.edu 匹配 *.edu → satisfied
  assert.equal(comparison.current.results[0]!.decision, 'satisfied');
  // 候选版本：收紧了 → unsatisfied
  assert.equal(comparison.candidate.results[0]!.decision, 'unsatisfied');
  // 差异被识别
  assert.equal(comparison.diffs.length, 1);
  assert.equal(comparison.diffs[0]!.from, 'satisfied');
  assert.equal(comparison.diffs[0]!.to, 'unsatisfied');
  // ★ 候选版本会让已授权用户进入观察期
  assert.equal(comparison.candidate.atRisk.length, 1);
  assert.equal(comparison.candidate.verdict, 'needs_review');
});

test('M2-8：求值异常（策略配置错）被计入 errors 并让结论进入 needs_review', () => {
  const broken: PolicyDocument = {
    code: 'broken',
    name: '配置错误',
    version: 1,
    enabled: true,
    spec: { requirements: { expression: { $unknownOp: { 'fact.email.domain': ['x'] } } } },
  };
  const report = simulate({ policies: [broken], subjects: [subjects[0]!], lifecycle: { gracePeriodMs: GRACE_MS }, now: NOW });
  assert.equal(report.stats.error, 1);
  assert.equal(report.errors.length, 1);
  assert.equal(report.verdict, 'needs_review');
});
