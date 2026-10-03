/**
 * 插件升级向后兼容检查（`docs/10 M6`）—— **反向索引**的可执行证明。
 *
 * ★ 本文件要证明的三件事：
 *   ① 删除/改类型**被已发布策略引用**的字段 → **拒绝升级**，并列出策略 code；
 *   ② 删除**无人引用**的字段 → 允许，但**必须警示**（归档/草稿策略可能仍在用）；
 *   ③ 展示属性的变化（`title`）**不算**兼容性变更——否则每次改文案都要走一遍审查。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkPluginUpgrade,
  checkUpgradeCompatibility,
  describeUpgradeRejection,
  diffFactSchema,
  factPathsOfNamespace,
} from '../src/plugin/schema-compat.ts';
import type { JsonSchemaSubset } from '../src/plugin/manifest.ts';
import type { PolicySpec } from '../src/policy/model.ts';

const OLD_SCHEMA: JsonSchemaSubset = {
  type: 'object',
  properties: {
    total_stars: { type: 'integer' },
    followers: { type: 'integer' },
    account_age_days: { type: 'integer' },
  },
};

/** 引用了 `total_stars` 的策略（形态 A：单一表达式） */
const POLICY_EXPRESSION: PolicySpec = {
  requirements: {
    expression: { gte: { 'fact.github.total_stars': 100 } },
  },
};

/** 引用了 `total_stars` 的策略（形态 B：分支条件里） */
const POLICY_BRANCH: PolicySpec = {
  requirements: {
    branches: [
      {
        id: 'strong',
        when: { gte: { 'fact.github.total_stars': 50 } },
        outcome: 'satisfied',
      },
    ],
  },
};

/** 与本插件无关的策略 */
const POLICY_OTHER: PolicySpec = {
  requirements: {
    expression: { matches: { 'fact.email.domain': ['*.edu.cn'] } },
  },
};

// ─────────────────────────── diff ───────────────────────────

test('diff：删除 / 改类型 / 新增 三类变更都被识别', () => {
  const changes = diffFactSchema({
    oldSchema: OLD_SCHEMA,
    newSchema: {
      type: 'object',
      properties: {
        followers: { type: 'integer' }, // 保留
        account_age_days: { type: 'string' }, // 改类型
        public_repos: { type: 'integer' }, // 新增
        // total_stars 被删除
      },
    },
  });
  const byField = new Map(changes.map((c) => [c.field, c]));
  assert.deepEqual(byField.get('total_stars'), { field: 'total_stars', kind: 'removed', from: 'integer' });
  assert.deepEqual(byField.get('account_age_days'), {
    field: 'account_age_days',
    kind: 'type_changed',
    from: 'integer',
    to: 'string',
  });
  assert.deepEqual(byField.get('public_repos'), { field: 'public_repos', kind: 'added', to: 'integer' });
  assert.equal(byField.has('followers'), false, '未变化的字段不产生变更项');
});

test('★ diff：**展示属性**（`title`）的变化不算兼容性变更（否则改文案就触发审查）', () => {
  const changes = diffFactSchema({
    oldSchema: { type: 'object', properties: { total_stars: { type: 'integer', title: '总 star' } } },
    newSchema: { type: 'object', properties: { total_stars: { type: 'integer', title: 'GitHub 总 star 数' } } },
  });
  assert.deepEqual(changes, []);
});

// ─────────────────────────── 反向索引 ───────────────────────────

test('★ 反向索引：从策略里提取某 namespace 的引用（含**分支条件**里的）', () => {
  assert.deepEqual(factPathsOfNamespace({ spec: POLICY_EXPRESSION, namespace: 'github' }), [
    'fact.github.total_stars',
  ]);
  assert.deepEqual(factPathsOfNamespace({ spec: POLICY_BRANCH, namespace: 'github' }), [
    'fact.github.total_stars',
  ]);
  // 命名空间隔离：别的 namespace 不串味
  assert.deepEqual(factPathsOfNamespace({ spec: POLICY_OTHER, namespace: 'github' }), []);
  assert.deepEqual(factPathsOfNamespace({ spec: POLICY_OTHER, namespace: 'email' }), [
    'fact.email.domain',
  ]);
});

// ─────────────────────────── 升级判定 ───────────────────────────

test('★ 删除**被已发布策略引用**的字段 → 拒绝升级，并列出策略 code', () => {
  const decision = checkUpgradeCompatibility({
    namespace: 'github',
    oldSchema: OLD_SCHEMA,
    newSchema: {
      type: 'object',
      properties: { followers: { type: 'integer' }, account_age_days: { type: 'integer' } },
    },
    policies: [
      { code: 'contributor-tier2', spec: POLICY_EXPRESSION },
      { code: 'edu-basic', spec: POLICY_OTHER },
    ],
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.deepEqual(decision.blocking, [{ code: 'contributor-tier2', field: 'total_stars' }]);

  const text = describeUpgradeRejection(decision);
  assert.match(text ?? '', /策略 'contributor-tier2' 引用了字段 'total_stars'/);
  // ★ 拒绝理由必须点明「发布侧挡不住」——否则运维会以为发布时已经检查过了
  assert.match(text ?? '', /发布侧的正向校验挡不住/);
});

test('★ 分支条件里引用也算（形态 B 同样被挡住）', () => {
  const decision = checkUpgradeCompatibility({
    namespace: 'github',
    oldSchema: OLD_SCHEMA,
    newSchema: { type: 'object', properties: { followers: { type: 'integer' } } },
    policies: [{ code: 'branch-policy', spec: POLICY_BRANCH }],
  });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.allowed === false ? decision.blocking : [], [
    { code: 'branch-policy', field: 'total_stars' },
  ]);
});

test('★ 删除**无人引用**的字段 → 允许，但**必须警示**（归档/草稿策略可能仍在用）', () => {
  const decision = checkUpgradeCompatibility({
    namespace: 'github',
    oldSchema: OLD_SCHEMA,
    newSchema: {
      type: 'object',
      properties: { total_stars: { type: 'integer' }, followers: { type: 'integer' } },
    },
    policies: [{ code: 'edu-basic', spec: POLICY_OTHER }],
  });
  assert.equal(decision.allowed, true);
  if (!decision.allowed) return;
  assert.equal(decision.warnings.length, 1);
  assert.match(decision.warnings[0]!, /删除了 1 个字段（account_age_days）/);
  assert.equal(describeUpgradeRejection(decision), null);
});

test('★ 改类型且被引用 → 同样拒绝（求值语义可能变化）', () => {
  const decision = checkUpgradeCompatibility({
    namespace: 'github',
    oldSchema: OLD_SCHEMA,
    newSchema: {
      type: 'object',
      properties: {
        total_stars: { type: 'string' }, // integer → string
        followers: { type: 'integer' },
        account_age_days: { type: 'integer' },
      },
    },
    policies: [{ code: 'contributor-tier2', spec: POLICY_EXPRESSION }],
  });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.allowed === false ? decision.blocking : [], [
    { code: 'contributor-tier2', field: 'total_stars' },
  ]);
});

test('只新增字段 → 允许，且**无**警示', () => {
  const decision = checkUpgradeCompatibility({
    namespace: 'github',
    oldSchema: OLD_SCHEMA,
    newSchema: {
      type: 'object',
      properties: {
        total_stars: { type: 'integer' },
        followers: { type: 'integer' },
        account_age_days: { type: 'integer' },
        public_repos: { type: 'integer' },
      },
    },
    policies: [{ code: 'contributor-tier2', spec: POLICY_EXPRESSION }],
  });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.allowed === true ? decision.warnings : ['不该有'], []);
});

test('★ 命名空间 ≠ 插件 id（enricher 自定义 namespace）时也正确', () => {
  // 策略写的是 fact.llm.pr_score，而插件 id 可能是 llm-review
  const spec: PolicySpec = {
    requirements: { expression: { gte: { 'fact.llm.pr_score': 60 } } },
  };
  const decision = checkUpgradeCompatibility({
    namespace: 'llm',
    oldSchema: { type: 'object', properties: { pr_score: { type: 'number' } } },
    newSchema: { type: 'object', properties: {} },
    policies: [{ code: 'contributor-tier2', spec }],
  });
  assert.equal(decision.allowed, false, '必须按 namespace 匹配，而不是按插件 id');
  assert.deepEqual(decision.allowed === false ? decision.blocking : [], [
    { code: 'contributor-tier2', field: 'pr_score' },
  ]);
});

// ─────────────────────────── 一站式检查（管理端安装端点的入口） ───────────────────────────

test('★ checkPluginUpgrade：**首次安装**直接放行（没有旧版本可比较）', () => {
  assert.equal(
    checkPluginUpgrade({
      previous: undefined,
      next: { id: 'github', factSchema: OLD_SCHEMA },
      policies: [{ code: 'p', spec: POLICY_EXPRESSION }],
    }),
    null,
  );
});

test('★ checkPluginUpgrade：升级删除被引用字段 → 返回可直接回给管理端的拒绝原因', () => {
  const rejection = checkPluginUpgrade({
    previous: { namespace: 'github', manifest: { factSchema: OLD_SCHEMA } },
    next: {
      id: 'github',
      factSchema: { type: 'object', properties: { followers: { type: 'integer' } } },
    },
    policies: [{ code: 'contributor-tier2', spec: POLICY_EXPRESSION }],
  });
  assert.ok(rejection !== null);
  assert.match(rejection, /拒绝升级/);
  assert.match(rejection, /contributor-tier2/);
});

test('checkPluginUpgrade：只新增字段 → 放行', () => {
  assert.equal(
    checkPluginUpgrade({
      previous: { namespace: 'github', manifest: { factSchema: OLD_SCHEMA } },
      next: {
        id: 'github',
        factSchema: {
          type: 'object',
          properties: {
            total_stars: { type: 'integer' },
            followers: { type: 'integer' },
            account_age_days: { type: 'integer' },
            public_repos: { type: 'integer' },
          },
        },
      },
      policies: [{ code: 'contributor-tier2', spec: POLICY_EXPRESSION }],
    }),
    null,
  );
});

test('★ checkPluginUpgrade：任一侧未声明 `factSchema` → 放行，但这是**已知盲区**（注释与测试同时记下）', () => {
  // 旧版本没有 factSchema
  assert.equal(
    checkPluginUpgrade({
      previous: { namespace: 'github', manifest: {} },
      next: { id: 'github', factSchema: OLD_SCHEMA },
      policies: [{ code: 'p', spec: POLICY_EXPRESSION }],
    }),
    null,
  );
  // 新版本没有 factSchema
  assert.equal(
    checkPluginUpgrade({
      previous: { namespace: 'github', manifest: { factSchema: OLD_SCHEMA } },
      next: { id: 'github' },
      policies: [{ code: 'p', spec: POLICY_EXPRESSION }],
    }),
    null,
  );
});
