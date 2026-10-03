/**
 * `docs/10 P5` ②：**结果树标注每个事实的采集时间**。
 *
 * ★ 这条修的是什么（文档原话）：
 * > 策略同时引用 `fact:github.total_stars`（1 小时前）与 `fact:github.account_age_days`（3 天前）
 * > → 判定基于「**半新半旧**」的组合。
 *
 * 修复前：每个事实**都有** `collectedAt`（存在库里），**但判定时不看它、结果树里也看不到它**——
 * 于是「半新半旧」既无法被识别，也无法配置容忍度（③ `$maxSkew` 的前提就是本项）。
 *
 * ★ 因此本文件既验**求值器**（叶子带时间），也验**接线**（快照的时间真的流到了结果树里）——
 *   只验前者会漏掉「实现了但没接上」这一类。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExpression, type Expression } from '../src/policy/expr.ts';
import { evaluateEligibility } from '../src/policy/eligibility.ts';
import type { PolicyDocument } from '../src/policy/model.ts';

const STAR_EXPR: Expression = { gte: { 'fact.github.total_stars': 100 } };
const COLLECTED_AT = new Date('2026-09-20T00:00:00Z');
const FACTS: Record<string, unknown> = { 'fact.github.total_stars': 212 };

test('叶子带采集时间：提供 `factCollectedAt` 时，`ExplainNode.collectedAt` 是 ISO 串', () => {
  const tree = evaluateExpression(STAR_EXPR, {
    context: {
      facts: (namespace, path) => FACTS[`fact.${namespace}.${path}`],
      user: {},
      factCollectedAt: (fullPath) =>
        fullPath === 'fact.github.total_stars' ? COLLECTED_AT : undefined,
    },
  });
  assert.equal(tree.state, 'true');
  assert.equal(tree.collectedAt, COLLECTED_AT.toISOString());
});

test('向后兼容：不提供 `factCollectedAt` → 不出现该字段（老调用方行为不变）', () => {
  const tree = evaluateExpression(STAR_EXPR, {
    context: {
      facts: (namespace, path) => FACTS[`fact.${namespace}.${path}`],
      user: {},
    },
  });
  assert.equal(tree.state, 'true');
  assert.equal(tree.collectedAt, undefined);
  assert.equal(Object.hasOwn(tree, 'collectedAt'), false);
});

test('★ 事实缺失/过期时**也**带时间——「这条依据是 3 天前采的、已过期」正是最该被看见的情况', () => {
  const tree = evaluateExpression(STAR_EXPR, {
    context: {
      // 事实缺失（渠道故障 / 已过期）
      facts: () => undefined,
      user: {},
      factCollectedAt: () => COLLECTED_AT,
    },
  });
  assert.equal(tree.state, 'indeterminate', 'H1：缺失不得降级为 false');
  assert.equal(tree.collectedAt, COLLECTED_AT.toISOString());
  assert.deepEqual(tree.missing, ['fact.github.total_stars']);
});

const EDU_POLICY: PolicyDocument = {
  code: 'edu-upgrade',
  name: '教育邮箱自动升级',
  version: 1,
  enabled: true,
  spec: {
    match: { eq: { 'user.status': 'active' } },
    requirements: {
      expression: {
        all: [
          { matches: { 'fact.email.domain': ['*.edu.cn', '*.edu'] } },
          { eq: { 'fact.email.verified': true } },
        ],
      },
    },
    actions: {
      onSatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'basic' } }],
    },
  },
};

test('★ 端到端接线：`evaluateEligibility` 的结果树里真的能看到快照的采集时间', () => {
  const collected = new Date('2026-09-25T00:00:00Z');
  const report = evaluateEligibility({
    facts: {
      values: {
        'fact.email.domain': 'alice@tsinghua.edu.cn',
        'fact.email.verified': true,
      },
      collectedAt: {
        'fact.email.domain': collected,
        'fact.email.verified': collected,
      },
    },
    user: { status: 'active' },
    policies: [EDU_POLICY],
    now: new Date('2026-09-26T00:00:00Z'),
  });

  // ★ 用序列化搜索而不是逐字段断言：`EligibilityReport` 的形状（results / progress …）
  //   属于用户侧视图的内部结构，逐字段断言会让本测试随视图演进而脆断；
  //   这里要证明的只有一件事——**采集时间确实流进了结果树**。
  const serialized = JSON.stringify(report);
  assert.match(serialized, /2026-09-25T00:00:00\.000Z/, '结果树里必须能看到采集时间');
});

test('端到端：快照没有 `collectedAt`（旧数据 / 手工试算）→ 不注入，行为不变', () => {
  const report = evaluateEligibility({
    facts: { values: { 'fact.email.domain': 'alice@tsinghua.edu.cn', 'fact.email.verified': true } },
    user: { status: 'active' },
    policies: [EDU_POLICY],
    now: new Date('2026-09-26T00:00:00Z'),
  });
  assert.doesNotMatch(JSON.stringify(report), /collectedAt/, '没有快照时间就不该凭空造一个');
});
