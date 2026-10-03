/**
 * ★★ P0-1 的**接线**验证：`subject:*` 真的在**资格评估路径**上取到值。
 *
 * ★ 为什么单独一个文件：`subject-addressing.test.ts` 验的是「寻址与求值」这一层，
 *   而这里验的是「**它被接上了**」——即 `collectSubjectSnapshot()` 的产物
 *   经 `EligibilityInput.subject` 流入 `evaluateEligibility()`。
 *
 * ★ 这一条测试存在的理由：在本会话里我多次批评过「接口就绪、无消费方」
 *   （`crossSite` / `resolveBinding` / `package-cache` 都曾如此）。
 *   所以 P0-1 不能只交两层实现——**必须有证据证明它在真实评估路径上生效**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectSubjectSnapshot } from '../src/policy/subject-snapshot.ts';
import type { BindingResolver } from '../src/policy/addressing.ts';
import { evaluateEligibility } from '../src/policy/eligibility.ts';
import type { PolicyDocument } from '../src/policy/model.ts';

const USER = 'u1';
const NOW = new Date('2026-09-26T00:00:00Z');

const resolver: BindingResolver = {
  async find(userId, pluginId, instanceKey) {
    if (pluginId === 'provider-a' && userId === USER) {
      return { pluginId, instanceKey, externalId: 'ext-1', status: 'active' };
    }
    return undefined;
  },
};

const readSubject = async (input: { providerId: string; externalId: string }) =>
  input.externalId === 'ext-1' ? { group: 'vip2', level: 5 } : undefined;

/** 一条**跨系统**策略：它的判定完全依赖 `subject:*` */
const CROSS_SYSTEM_POLICY = {
  code: 'cross-system',
  name: '跨系统联合判定',
  enabled: true,
  spec: { requirements: { expression: { eq: { 'subject:provider-a.group': 'vip2' } } } },
} as unknown as PolicyDocument;

test('★ 接线：传入 subject → 策略里的 `subject:*` 命中（satisfied）', () => {
  const report = evaluateEligibility({
    policies: [CROSS_SYSTEM_POLICY],
    user: {},
    facts: { values: {} },
    subject: { 'provider-a.group': 'vip2', group: 'vip2' },
    now: NOW,
  });
  assert.equal(report.results[0]?.evaluation.decision, 'satisfied');
});

test('★★ 接线：**不传** subject → `indeterminate`（H1：不因"取不到"而降级）', () => {
  const report = evaluateEligibility({
    policies: [CROSS_SYSTEM_POLICY],
    user: {},
    facts: { values: {} },
    now: NOW,
  });
  assert.equal(
    report.results[0]?.evaluation.decision,
    'indeterminate',
    '★ 绝不能因为"没有跨系统取值"就判 unsatisfied——那会误收回已授予的资格',
  );
});

test('★★ 端到端：快照 → 资格评估（绑定 active → satisfied；未绑定 → indeterminate）', async () => {
  const bound = await collectSubjectSnapshot({
    userId: USER,
    keys: ['provider-a.group'],
    resolver,
    readSubject,
  });
  assert.deepEqual(bound.failures, []);
  assert.equal(
    evaluateEligibility({
      policies: [CROSS_SYSTEM_POLICY],
      user: {},
      facts: { values: {} },
      subject: bound.values,
      now: NOW,
    }).results[0]?.evaluation.decision,
    'satisfied',
  );

  const unbound = await collectSubjectSnapshot({
    userId: 'nobody',
    keys: ['provider-a.group'],
    resolver,
    readSubject,
  });
  assert.equal(unbound.failures.length, 1, '失败原因要能被排障看到');
  assert.equal(
    evaluateEligibility({
      policies: [CROSS_SYSTEM_POLICY],
      user: {},
      facts: { values: {} },
      subject: unbound.values,
      now: NOW,
    }).results[0]?.evaluation.decision,
    'indeterminate',
    '★ 未绑定 = 取不到 = indeterminate，而不是"不满足"',
  );
});

test('★ 端到端：绑定已撤销 → 同样 indeterminate（不是 unsatisfied）', async () => {
  const revokedResolver: BindingResolver = {
    async find(_userId, pluginId, instanceKey) {
      return { pluginId, instanceKey, externalId: 'ext-1', status: 'revoked' };
    },
  };
  const snapshot = await collectSubjectSnapshot({
    userId: USER,
    keys: ['provider-a.group'],
    resolver: revokedResolver,
    readSubject,
  });
  assert.deepEqual(snapshot.values, {});
  assert.equal(
    evaluateEligibility({
      policies: [CROSS_SYSTEM_POLICY],
      user: {},
      facts: { values: {} },
      subject: snapshot.values,
      now: NOW,
    }).results[0]?.evaluation.decision,
    'indeterminate',
  );
});
