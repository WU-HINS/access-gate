/**
 * ★★ **两套分支求值必须给出一致结论**（`docs/04 §1.3` / `§1.5`）。
 *
 * 背景：`policy/branches.ts` 的 `evaluateBranches` 与 `policy/evaluator.ts` 的**内联**分支求值
 * 是**两份独立实现**。本会话核实出它们在**最关键的一点上分歧**：
 *
 *   · `evaluator.ts`（**已接线**、生产在用）：遇到 `indeterminate` **立即收敛**
 *     —— 注释写明理由「若跳过，后面分支可能给出『不满足』，从而把『不知道』当成『不满足』（H1 违规）」；
 *   · `branches.ts`（此前**零调用**）：只记下 `sawIndeterminate` 后**继续**，
 *     后续分支可以命中并**胜出** —— 若那个分支是"排除分支"（`outcome: unsatisfied`），
 *     就等于**凭不知道的信息收回权限**。
 *
 * `docs/04:649/668` 站在 `evaluator.ts` 一边：`indeterminate`「**保持原状态，不得降级**」、
 * unknown「**向上传播**」。因此已把 `branches.ts` 对齐为**立即收敛**。
 *
 * ★ 本文件用**交叉核对**把两者钉在一起：同一组输入下，两个实现的结论必须相同。
 *   两套实现给出不同答案时，"编辑器预览"与"运行期判定"就会打架 ——
 *   而两边各自看都"对"，是最难查的一类不一致。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateBranches } from '../src/policy/branches.ts';
import { evaluatePolicy } from '../src/policy/evaluator.ts';
import type { EvaluationContext } from '../src/policy/expr.ts';
import type { PolicyDocument } from '../src/policy/model.ts';

const NOW = new Date('2026-09-28T00:00:00Z');

const contextOf = (over: Partial<EvaluationContext> = {}): EvaluationContext =>
  ({
    // ★ 取不到的事实必须变成 `indeterminate`（而不是 `false`）——
    //   显式声明缺失策略，避免依赖默认值（本测试的核心就是"不确定不得降级"）
    missingPolicy: 'indeterminate',
    facts: () => undefined,
    user: { email: null, email_verified: false, status: 'active', tags: [] },
    bindings: {},
    now: NOW,
    ...over,
  }) as EvaluationContext;

const policyOf = (requirements: unknown): PolicyDocument =>
  ({ code: 'p', version: 1, spec: { requirements } }) as unknown as PolicyDocument;

/** 同一条策略：分别用**两个实现**求值，断言结论一致 */
function assertAgree(requirements: unknown, context: EvaluationContext, label: string): string {
  const viaEvaluator = evaluatePolicy({ policy: policyOf(requirements), context }).decision;
  const viaBranches = evaluateBranches({
    requirements: requirements as never,
    context,
  }).decision;
  assert.equal(
    viaBranches,
    viaEvaluator,
    `★ 两套分支求值结论不一致（${label}）：evaluator=${viaEvaluator} vs branches=${viaBranches}`,
  );
  return viaEvaluator;
}

// ─────────────────────── ① 命中 / 兜底 ───────────────────────

test('★ 命中首个为真的分支：两者都 satisfied', () => {
  const decision = assertAgree(
    {
      branches: [{ id: 'a', when: { eq: { 'me.status': 'active' } }, outcome: 'satisfied' }],
      else: { outcome: 'unsatisfied' },
    },
    contextOf(),
    '命中 a',
  );
  assert.equal(decision, 'satisfied');
});

test('★ 无分支命中 → 落到 else：两者都取 else 的结论', () => {
  const decision = assertAgree(
    {
      branches: [{ id: 'a', when: { eq: { 'me.status': 'banned' } }, outcome: 'satisfied' }],
      else: { outcome: 'unsatisfied' },
    },
    contextOf(),
    'else 兜底',
  );
  assert.equal(decision, 'unsatisfied');
});

test('★ 省略 else 且无命中 → 两者都 unsatisfied', () => {
  const decision = assertAgree(
    { branches: [{ id: 'a', when: { eq: { 'me.status': 'banned' } }, outcome: 'satisfied' }] },
    contextOf(),
    '省略 else',
  );
  assert.equal(decision, 'unsatisfied');
});

// ─────────────────────── ② ★★ H1：不确定不得降级 ───────────────────────

test('★★★ 前一个分支**不可判定**、后一个是「排除分支」→ 两者都必须 `indeterminate`（不得降级）', () => {
  // 分支 a 依赖一个**取不到的事实** → indeterminate；分支 b 是排除分支（命中即 unsatisfied）。
  // ★ 修复前：`branches.ts` 会继续求值 b 并返回 `unsatisfied` —— 即**凭不知道的信息收回权限**。
  const decision = assertAgree(
    {
      branches: [
        { id: 'a', when: { eq: { 'fact.email.domain': 1 } }, outcome: 'satisfied' },
        { id: 'b', when: { eq: { 'me.status': 'active' } }, outcome: 'unsatisfied' },
      ],
      else: { outcome: 'satisfied' },
    },
    contextOf(),
    '不确定 + 排除分支',
  );
  assert.equal(
    decision,
    'indeterminate',
    '★ 必须"向上传播"为 indeterminate；把"不知道"当成"不满足"会误收回权限',
  );
});

test('★★★ 不可判定**之后**还有为真的分支，也不得被它"救回"（立即收敛）', () => {
  const decision = assertAgree(
    {
      branches: [
        { id: 'a', when: { eq: { 'fact.email.domain': 1 } }, outcome: 'satisfied' },
        { id: 'b', when: { eq: { 'me.status': 'active' } }, outcome: 'satisfied' },
      ],
      else: { outcome: 'unsatisfied' },
    },
    contextOf(),
    '不确定 + 后续命中',
  );
  assert.equal(decision, 'indeterminate');
});

test('★ 不可判定分支放在**最后**、前面都不命中 → 仍必须 indeterminate（**不落到 else**）', () => {
  const decision = assertAgree(
    {
      branches: [
        { id: 'b', when: { eq: { 'me.status': 'banned' } }, outcome: 'unsatisfied' },
        { id: 'a', when: { eq: { 'fact.email.domain': 1 } }, outcome: 'satisfied' },
      ],
      // ★ else 是 `satisfied`：若把"不知道"当成"不满足"就会落到 else（**凭不知道的信息升级**）
      else: { outcome: 'satisfied' },
    },
    contextOf(),
    '不确定在最后',
  );
  assert.equal(decision, 'indeterminate', '★ 不得落到 else');
});

// ─────────────────────── ③ 短路证据 ───────────────────────

test('★ 短路：命中后**不再求值**后续分支（两套实现都有可断言证据）', () => {
  const requirements = {
    branches: [
      { id: 'a', when: { eq: { 'me.status': 'active' } }, outcome: 'satisfied' },
      { id: 'b', when: { eq: { 'fact.email.domain': 1 } }, outcome: 'satisfied' },
    ],
    else: { outcome: 'unsatisfied' },
  };
  const context = contextOf();

  // 若没有短路，分支 b 的 missing 事实会让结果变成 indeterminate
  assert.equal(evaluatePolicy({ policy: policyOf(requirements), context }).decision, 'satisfied');

  const branches = evaluateBranches({ requirements: requirements as never, context });
  assert.equal(branches.decision, 'satisfied');
  assert.deepEqual(branches.shortCircuited, ['b'], '★ `branches.ts` 明确列出被短路的分支');
  assert.equal(branches.trace.find((t) => t.branchId === 'b')?.skipped, true);
});
