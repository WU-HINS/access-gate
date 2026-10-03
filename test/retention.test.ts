/**
 * 保留期机制与两条启动期不变量（`docs/05 §2.1.4` · `docs/11 §13.1`）。
 *
 * ★ 本文件要证明的核心事实：
 *   ① 不变量 2 真的能**拒绝**「永久授权 + 有限保留期」的组合（而不是恒真）；
 *   ② 不变量 1 真的能**拒绝**「TTL 短于 主体数 ÷ 配额」的组合；
 *   ③ 版本清理**永不删除仍被 `granted`/`satisfied` 引用的版本**——
 *      即使它已超出 `keep` 个（这是文档明确要求，也是"永久授权可回滚"的前提）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkFactTtlInvariant,
  checkGrantLifetimeInvariant,
  checkStartupInvariants,
  DEFAULT_RETENTION,
  planVersionPurge,
  type RetentionSettings,
  type VersionRef,
} from '../src/core/retention.ts';

// ─────────────────────────── 不变量 2：授权有效期 ≤ 最短保留期 ───────────────────────────

test('★ 不变量 2：默认配置通过（maxGrantLifetime 取最短的那一项）', () => {
  assert.equal(checkGrantLifetimeInvariant(DEFAULT_RETENTION), null);
  // 默认值刻意等于最短项（动作流水 30 天）——这是「不设成无限」的落点
  assert.equal(DEFAULT_RETENTION.maxGrantLifetimeDays, DEFAULT_RETENTION.actionsDays);
});

test('★ 不变量 2：永久授权超过最短保留期 → 必须报违规（否则 3 年前的授权无法复现/回滚）', () => {
  const violation = checkGrantLifetimeInvariant({ ...DEFAULT_RETENTION, maxGrantLifetimeDays: 3650 });
  assert.ok(violation !== null);
  assert.equal(violation.name, 'grant_lifetime_exceeds_retention');
  assert.match(violation.detail, /3650 天 > 最短保留期 30 天/);
  assert.match(violation.suggestion, /无法复现|无法回滚/);
});

test('不变量 2：相等是允许的（`≤` 而非 `<`）', () => {
  const settings: RetentionSettings = {
    ...DEFAULT_RETENTION,
    evaluationsDays: 90,
    auditDays: 180,
    actionsDays: 30,
    maxGrantLifetimeDays: 30,
  };
  assert.equal(checkGrantLifetimeInvariant(settings), null);
});

test('不变量 2：以**最短**的那一项为准（不是最长、也不是平均）', () => {
  const violation = checkGrantLifetimeInvariant({
    ...DEFAULT_RETENTION,
    evaluationsDays: 90,
    auditDays: 180,
    actionsDays: 30, // 最短
    maxGrantLifetimeDays: 31,
  });
  assert.ok(violation !== null);
  assert.match(violation.detail, /最短保留期 30 天/);
});

// ─────────────────────────── 不变量 1：事实 TTL ≥ 主体数 ÷ 配额 ───────────────────────────

test('不变量 1：TTL 足够 → 通过（10 万主体 / 5000 每小时 ≈ 0.83 天）', () => {
  assert.equal(
    checkFactTtlInvariant({ factsDays: 7, subjectCount: 100_000, quotaPerHour: 5000 }),
    null,
  );
});

test('★ 不变量 1：TTL 太短 → 报违规，并给出**所需天数**（不是笼统的"配额不足"）', () => {
  const violation = checkFactTtlInvariant({
    factsDays: 1,
    subjectCount: 1_000_000,
    quotaPerHour: 100,
  });
  assert.ok(violation !== null);
  assert.equal(violation.name, 'fact_ttl_too_short');
  // 1_000_000 / 100 / 24 ≈ 416.67 天
  assert.match(violation.detail, /416\.67 天/);
  assert.match(violation.suggestion, /≥ 417 天/);
});

test('不变量 1：配额未声明（0 或负）→ 报「无从计算」而不是静默通过', () => {
  const violation = checkFactTtlInvariant({ factsDays: 7, subjectCount: 100, quotaPerHour: 0 });
  assert.ok(violation !== null);
  assert.equal(violation.name, 'fact_ttl_quota_missing');
});

// ─────────────────────────── 版本清理：保留最新 N 个，但**永不删被引用的** ───────────────────────────

const VERSIONS: VersionRef[] = [
  { id: 'v1', policyId: 'p1', version: 1 },
  { id: 'v2', policyId: 'p1', version: 2 },
  { id: 'v3', policyId: 'p1', version: 3 },
  { id: 'v4', policyId: 'p1', version: 4 },
  { id: 'v5', policyId: 'p1', version: 5 },
];

test('版本清理：keep=3 且无引用 → 清理最旧的 2 个', () => {
  assert.deepEqual(planVersionPurge({ versions: VERSIONS, keep: 3, referencedVersionIds: new Set() }), [
    'v1',
    'v2',
  ]);
});

test('★ 版本清理：**仍被 granted/satisfied 引用的版本永不清理**（即使超出 keep）', () => {
  // v1 是一个「永久授权」仍在引用的老版本
  const purge = planVersionPurge({
    versions: VERSIONS,
    keep: 3,
    referencedVersionIds: new Set(['v1']),
  });
  assert.deepEqual(purge, ['v2'], '★ v1 必须被跳过——否则状态表悬空、永久授权无法回滚');
});

test('版本清理：多个策略各自独立计数', () => {
  const versions: VersionRef[] = [
    ...VERSIONS,
    { id: 'q1', policyId: 'p2', version: 1 },
    { id: 'q2', policyId: 'p2', version: 2 },
    { id: 'q3', policyId: 'p2', version: 3 },
  ];
  assert.deepEqual(planVersionPurge({ versions, keep: 2, referencedVersionIds: new Set() }), [
    'q1',
    'v1',
    'v2',
    'v3',
  ]);
});

test('版本清理：keep 大于实际版本数 → 不清理任何东西', () => {
  assert.deepEqual(planVersionPurge({ versions: VERSIONS, keep: 99, referencedVersionIds: new Set() }), []);
});

// ─────────────────────────── 启动期聚合 ───────────────────────────

test('checkStartupInvariants：两条都跑，且**逐条列出**违规（便于一次修完）', () => {
  const violations = checkStartupInvariants({
    settings: { ...DEFAULT_RETENTION, maxGrantLifetimeDays: 3650 },
    factTtl: { subjectCount: 1_000_000, quotaPerHour: 100 },
  });
  assert.deepEqual(
    violations.map((v) => v.name),
    ['grant_lifetime_exceeds_retention', 'fact_ttl_too_short'],
  );
});

test('checkStartupInvariants：未提供 factTtl（尚未接入 provider）→ 只跑不变量 2', () => {
  const violations = checkStartupInvariants({ settings: DEFAULT_RETENTION });
  assert.deepEqual(violations, []);
});
