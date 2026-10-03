/**
 * 策略模型 + 静态校验 + 求值 验收（M1-9 / M1-10）。
 *
 * 断言重点：
 *   - **发布前拒绝**：引用未安装插件的命名空间、未知事实键、未知动作、两种形态同时声明；
 *   - **渠道自动推断**：表达式里写 `fact.qq.level` 就够了，不需要声明 channel；
 *   - **有序分支**：首个命中即停；分支不可判定时**不得跳到后续分支**（H1）；
 *   - **用户侧视图**：能渲染出「差哪一项、差多少」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPolicyPublishable,
  collectFactRefs,
  namespaceOf,
  PolicyValidationError,
  validatePolicy,
  type PluginRegistry,
  type PolicyDocument,
} from '../src/policy/model.ts';
import { evaluatePolicy, toEligibilityView, collectLeaves } from '../src/policy/evaluator.ts';
import type { EvaluationContext } from '../src/policy/expr.ts';

// ─────────────────────────── 测试用注册表与上下文 ───────────────────────────

function registry(overrides: Partial<PluginRegistry> = {}): PluginRegistry {
  const installed = ['email', 'qq', 'github'];
  // ★ 口径：完整表达式路径（含 fact. 前缀），与策略里的写法一致
  const facts = ['fact.email.domain', 'fact.email.is_edu', 'fact.qq.level', 'fact.github.total_stars'];
  const actions = ['newapi-set-group:set_group', 'checkin:grant'];
  return {
    installedPlugins: () => installed,
    knownFactKeys: () => facts,
    knownActions: () => actions,
    ...overrides,
  };
}

function context(facts: Record<string, unknown>, overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    facts: (namespace, path) => facts[`${namespace}.${path}`],
    user: { email_verified: true, status: 'active', tags: ['vip'] },
    bindings: {},
    now: new Date('2025-06-01T00:00:00Z'),
    ...overrides,
  };
}

/** M1 验收场景（docs/07 §5 场景 A）：edu 邮箱自动升级 */
const EDU_POLICY: PolicyDocument = {
  code: 'edu-upgrade',
  name: '教育邮箱自动升级',
  version: 1,
  spec: {
    match: { eq: { 'user.status': 'active' } },
    requirements: {
      expression: {
        all: [
          { $label: '邮箱已验证', eq: { 'user.email_verified': true } },
          { $label: '教育邮箱', matches: { 'fact.email.domain': ['*.edu.cn', '*.edu'] } },
        ],
      },
    },
    actions: {
      onSatisfied: [
        { action: 'newapi-set-group:set_group', params: { group: 'basic' } },
        { action: 'checkin:grant', params: { scope: 'daily' } },
      ],
      onUnsatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'default' } }],
    },
  },
};

// ─────────────────────────── 事实引用与渠道推断 ───────────────────────────

test('collectFactRefs：只收集 fact.* 引用（不收集 user/binding/字面量）', () => {
  const refs = collectFactRefs({
    all: [
      { gte: { 'fact.github.total_stars': 100 } },
      { matches: { 'fact.email.domain': ['*.edu.cn'] } },
      { eq: { 'user.status': 'active' } },
      { gt: { 'fact.qq.level': 40 } },
    ],
  });
  assert.deepEqual([...refs].sort(), ['fact.email.domain', 'fact.github.total_stars', 'fact.qq.level']);
});

test('namespaceOf：从事实路径取命名空间', () => {
  assert.equal(namespaceOf('fact.github.total_stars'), 'github');
  assert.equal(namespaceOf('fact.email.domain'), 'email');
});

test('渠道自动推断：表达式里写 fact.* 即可，无需声明 channel', () => {
  const result = validatePolicy(
    {
      code: 'multi',
      spec: {
        requirements: {
          expression: {
            all: [
              { gte: { 'fact.github.total_stars': 100 } },
              { matches: { 'fact.email.domain': ['*.edu.cn'] } },
              { gt: { 'fact.qq.level': 40 } },
            ],
          },
        },
      },
    },
    registry(),
  );
  assert.deepEqual(result.inferredChannels, ['email', 'github', 'qq']);
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues, null, 2));
});

// ─────────────────────────── 发布前校验 ───────────────────────────

test('★ 引用未安装的插件命名空间 → 拒绝发布（M1-9 的验收项）', () => {
  const document: PolicyDocument = {
    code: 'bad-plugin',
    spec: { requirements: { expression: { gt: { 'fact.gitlab.mr_count': 5 } } } },
  };
  const result = validatePolicy(document, registry());
  assert.deepEqual(result.missingPlugins, ['gitlab']);
  assert.ok(result.issues.some((i) => /未安装的插件命名空间 'gitlab'/.test(i.message)));
  assert.throws(() => assertPolicyPublishable(document, registry()), PolicyValidationError);
});

test('引用插件已安装但字段未声明 → 拒绝（否则运行期表现为「永远差一项」）', () => {
  const document: PolicyDocument = {
    code: 'bad-fact',
    spec: { requirements: { expression: { gt: { 'fact.github.nonexistent_field': 1 } } } },
  };
  const result = validatePolicy(document, registry());
  assert.deepEqual(result.unknownFacts, ['fact.github.nonexistent_field']);
  assert.ok(result.issues.some((i) => /不在插件 'github' 声明的 factSchema 中/.test(i.message)));
});

test('引用不存在的动作 → 拒绝；动作格式非法 → 拒绝', () => {
  const missingAction = validatePolicy(
    { code: 'a', spec: { requirements: { expression: { always: true } }, actions: { onSatisfied: [{ action: 'nope:do_it' }] } } },
    registry(),
  );
  assert.deepEqual(missingAction.unknownActions, ['nope:do_it']);

  const badFormat = validatePolicy(
    { code: 'b', spec: { requirements: { expression: { always: true } }, actions: { onSatisfied: [{ action: 'NoColon' }] } } },
    registry(),
  );
  assert.ok(badFormat.issues.some((i) => /格式非法/.test(i.message)));
});

test('形态互斥：同时声明 expression 与 branches → 拒绝；两者都无 → 拒绝', () => {
  const both = validatePolicy(
    {
      code: 'both',
      spec: {
        requirements: {
          expression: { always: true },
          branches: [{ id: 'x', when: { always: true } }],
        },
      },
    },
    registry(),
  );
  assert.ok(both.issues.some((i) => /互斥/.test(i.message)));

  const neither = validatePolicy({ code: 'neither', spec: { requirements: {} } }, registry());
  assert.ok(neither.issues.some((i) => /必须声明 expression 或 branches/.test(i.message)));
});

test('分支 id 重复 / 缺 id / 未知 outcome → 拒绝；分支 when 的表达式规则同样生效', () => {
  const result = validatePolicy(
    {
      code: 'branches',
      spec: {
        requirements: {
          branches: [
            { id: 'dup', when: { always: true } },
            { id: 'dup', when: { always: true } },
            { id: '', when: { all: [] } },
            { id: 'bad-outcome', when: { always: true }, outcome: 'maybe' as never },
          ],
        },
      },
    },
    registry(),
  );
  assert.ok(result.issues.some((i) => /重复/.test(i.message)));
  assert.ok(result.issues.some((i) => /id 必需/.test(i.message)));
  assert.ok(result.issues.some((i) => /all: \[\] 被拒绝|恒真/.test(i.message)));
  assert.ok(result.issues.some((i) => /未知 outcome/.test(i.message)));
});

test('合法策略（两种形态）通过校验', () => {
  const eduResult = validatePolicy(EDU_POLICY, registry());
  assert.deepEqual(eduResult.issues, [], JSON.stringify(eduResult, null, 2));
  const branches: PolicyDocument = {
    code: 'branches-ok',
    spec: {
      requirements: {
        branches: [
          { id: 'high', label: 'QQ > 40', when: { gt: { 'fact.qq.level': 40 } }, actions: [{ action: 'checkin:grant' }] },
          { id: 'mid', label: 'QQ 20~40', when: { between: { 'fact.qq.level': [20, 40] } } },
        ],
        defaultOutcome: 'unsatisfied',
      },
    },
  };
  const branchResult = validatePolicy(branches, registry());
  assert.deepEqual(branchResult.issues, [], JSON.stringify(branchResult, null, 2));
});

// ─────────────────────────── 求值：形态 A ───────────────────────────

test('形态 A：满足 → satisfied，并给出 onSatisfied 动作', () => {
  const evaluation = evaluatePolicy({
    policy: EDU_POLICY,
    context: context({ 'email.domain': 'tsinghua.edu.cn', 'email.is_edu': true }),
  });
  assert.equal(evaluation.decision, 'satisfied');
  assert.equal(evaluation.form, 'expression');
  assert.deepEqual(
    evaluation.actions.map((a) => a.action),
    ['newapi-set-group:set_group', 'checkin:grant'],
  );
  assert.match(evaluation.summary, /满足全部条件/);
});

test('形态 A：不满足 → unsatisfied，并给出 onUnsatisfied 动作与失败项', () => {
  const evaluation = evaluatePolicy({
    policy: EDU_POLICY,
    context: context({ 'email.domain': 'gmail.com', 'email.is_edu': false }),
  });
  assert.equal(evaluation.decision, 'unsatisfied');
  assert.deepEqual(evaluation.actions.map((a) => a.action), ['newapi-set-group:set_group']);
  assert.ok(evaluation.failures.some((f) => f.label === '教育邮箱'));
});

test('★ 形态 A：事实缺失 → indeterminate 且**不产生任何动作**（H1：不推进状态）', () => {
  const evaluation = evaluatePolicy({ policy: EDU_POLICY, context: context({}) });
  assert.equal(evaluation.decision, 'indeterminate');
  assert.deepEqual(evaluation.actions, [], 'indeterminate 时不得产生动作');
  assert.ok(evaluation.missing.includes('fact.email.domain'));
});

test('match 不通过 → not_applicable（本策略不管这个主体）', () => {
  const evaluation = evaluatePolicy({
    policy: EDU_POLICY,
    context: context({ 'email.domain': 'tsinghua.edu.cn' }, { user: { status: 'suspended' } }),
  });
  assert.equal(evaluation.decision, 'not_applicable');
  assert.deepEqual(evaluation.actions, []);
});

test('★ match 不可判定 → indeterminate（不得当成 not_applicable 静默放过）', () => {
  const policy: PolicyDocument = {
    code: 'match-indeterminate',
    spec: {
      match: { eq: { 'fact.qq.level': 40 } },
      requirements: { expression: { always: true } },
    },
  };
  const evaluation = evaluatePolicy({ policy, context: context({}) });
  assert.equal(evaluation.decision, 'indeterminate');
});

// ─────────────────────────── 求值：形态 B ───────────────────────────

const BRANCH_POLICY: PolicyDocument = {
  code: 'qq-tiers',
  spec: {
    requirements: {
      branches: [
        {
          id: 'qq_high',
          label: 'QQ 等级 > 40 级',
          when: { gt: { 'fact.qq.level': 40 } },
          actions: [{ action: 'newapi-set-group:set_group', params: { group: 'vip3' } }],
        },
        {
          id: 'qq_mid',
          label: 'QQ 等级 20~40 级',
          when: { between: { 'fact.qq.level': [20, 40] } },
          actions: [{ action: 'newapi-set-group:set_group', params: { group: 'vip2' } }],
        },
      ],
      defaultOutcome: 'unsatisfied',
    },
    actions: { onUnsatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'default' } }] },
  },
};

test('形态 B：首个命中即停（后面的分支不再求值）', () => {
  const evaluation = evaluatePolicy({ policy: BRANCH_POLICY, context: context({ 'qq.level': 55 }) });
  assert.equal(evaluation.decision, 'satisfied');
  assert.equal(evaluation.selectedBranch, 'qq_high');
  assert.equal(evaluation.branches!.length, 1, '命中后不再求值后续分支');
  assert.deepEqual(evaluation.actions[0]!.params, { group: 'vip3' });
});

test('形态 B：命中第二个分支（第一个不满足）', () => {
  const evaluation = evaluatePolicy({ policy: BRANCH_POLICY, context: context({ 'qq.level': 32 }) });
  assert.equal(evaluation.selectedBranch, 'qq_mid');
  assert.equal(evaluation.branches!.length, 2);
  assert.deepEqual(evaluation.actions[0]!.params, { group: 'vip2' });
});

test('形态 B：全不命中 → defaultOutcome（走策略级 onUnsatisfied）', () => {
  const evaluation = evaluatePolicy({ policy: BRANCH_POLICY, context: context({ 'qq.level': 5 }) });
  assert.equal(evaluation.decision, 'unsatisfied');
  assert.equal(evaluation.selectedBranch, undefined);
  assert.deepEqual(evaluation.actions[0]!.params, { group: 'default' });
});

test('★ 形态 B：分支不可判定时**不得跳到后续分支**（否则会把「不知道」当「不满足」）', () => {
  const policy: PolicyDocument = {
    code: 'indeterminate-branch',
    spec: {
      requirements: {
        branches: [
          { id: 'needs_qq', when: { gt: { 'fact.qq.level': 40 } } },
          { id: 'fallback', when: { always: true }, outcome: 'unsatisfied' },
        ],
      },
    },
  };
  const evaluation = evaluatePolicy({ policy, context: context({}) });
  assert.equal(evaluation.decision, 'indeterminate');
  assert.equal(evaluation.branches!.length, 1, '遇到不可判定分支立即收敛，不进入 fallback');
  assert.deepEqual(evaluation.actions, []);
});

test('分支可声明 outcome: unsatisfied（命中即判不满足，用于显式「排除」分支）', () => {
  const policy: PolicyDocument = {
    code: 'exclude',
    spec: {
      requirements: {
        branches: [
          { id: 'deny', label: '黑名单域名', when: { matches: { 'fact.email.domain': ['*.evil.com'] } }, outcome: 'unsatisfied' },
          { id: 'allow', when: { always: true } },
        ],
      },
    },
  };
  const denied = evaluatePolicy({ policy, context: context({ 'email.domain': 'a.evil.com' }) });
  assert.equal(denied.decision, 'unsatisfied');
  assert.equal(denied.selectedBranch, 'deny');
  assert.deepEqual(denied.actions, []);

  const allowed = evaluatePolicy({ policy, context: context({ 'email.domain': 'a.edu.cn' }) });
  assert.equal(allowed.decision, 'satisfied');
  assert.equal(allowed.selectedBranch, 'allow');
});

test('求值异常被收敛为 decision=error（一条策略写坏不该中断整个评估链）', () => {
  const policy: PolicyDocument = {
    code: 'broken',
    spec: { requirements: { expression: { gt: 'not-an-object' } as never } },
  };
  const evaluation = evaluatePolicy({ policy, context: context({}) });
  assert.equal(evaluation.decision, 'error');
  assert.ok(evaluation.error !== undefined);
  assert.deepEqual(evaluation.actions, []);
});

// ─────────────────────────── 用户侧资格视图 ───────────────────────────

test('★ 用户侧视图：能渲染「差哪一项、差多少」（M1-10 的验收）', () => {
  const evaluation = evaluatePolicy({
    policy: EDU_POLICY,
    context: context({ 'email.domain': 'gmail.com', 'email.is_edu': false }),
  });
  const view = toEligibilityView(evaluation);
  assert.equal(view.decision, 'unsatisfied');
  const emailItem = view.items.find((item) => item.label === '教育邮箱');
  assert.ok(emailItem !== undefined);
  assert.equal(emailItem.state, 'false');
  assert.equal(emailItem.actual, 'gmail.com');
  assert.deepEqual(emailItem.expected, ['*.edu.cn', '*.edu']);
  assert.match(emailItem.reason, /gmail\.com/);
});

test('用户侧视图：通过项也会列出（用户能看到完整进度，而不只是失败项）', () => {
  const evaluation = evaluatePolicy({
    policy: EDU_POLICY,
    context: context({ 'email.domain': 'tsinghua.edu.cn', 'email.is_edu': true }),
  });
  const view = toEligibilityView(evaluation);
  assert.deepEqual(
    view.items.map((item) => [item.label, item.state]),
    [
      ['邮箱已验证', 'true'],
      ['教育邮箱', 'true'],
    ],
  );
});

test('用户侧视图：缺失项进入 missingLabels（提示「请完成 X」）', () => {
  const evaluation = evaluatePolicy({ policy: EDU_POLICY, context: context({}) });
  const view = toEligibilityView(evaluation);
  assert.equal(view.decision, 'indeterminate');
  assert.ok(view.missingLabels.length > 0);
  assert.ok(view.items.every((item) => item.label.length > 0), '每个叶子都要有可读文案');
});

test('collectLeaves：只返回叶子（内部逻辑节点不暴露给用户）', () => {
  const evaluation = evaluatePolicy({
    policy: EDU_POLICY,
    context: context({ 'email.domain': 'tsinghua.edu.cn', 'email.is_edu': true }),
  });
  const leaves = collectLeaves(evaluation.requirementTree!);
  assert.equal(leaves.length, 2);
  assert.ok(leaves.every((leaf) => leaf.children === undefined || leaf.children.length === 0));
});
