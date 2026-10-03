/**
 * ★★ **`identity:` root 的求值**（`docs/04 §1.2.7.3` / `docs/03:1120/1134`）。
 *
 * 文档规定：表达式里通过 **`identity:oidc@<ref>.<claim>`** 引用"该用户在某个 OIDC
 * 唯一标识符下的身份信息"，**不依赖任何具体下游系统**；登录后平台把外部身份写入
 * `ag_identities`（`provider = "identity:oidc@<ref>"`），且**其余 claim 既不落库也不可见**。
 *
 * 本会话核实到的现状（与 `fact:` 那个缺陷同类）：
 *   · `parseOperand` **没有** `identity` 分支 → 该地址掉进 `literal`，
 *     变成**永远为假的字符串比较**；
 *   · `federation.ts` 的 `claimAddressOf` / `projectExposedClaims`（构造与投影这些地址的
 *     权威实现）**在文件外零引用** —— 也就是说"地址格式已经定好了，但**没人求值**"。
 *
 * ★ 本文件把三处（解析 / 依赖收集 / 求值）钉住，并核对**与 `claimAddressOf` 逐字一致**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExpression, parseOperand, type EvaluationContext } from '../src/policy/expr.ts';
import { collectIdentityRefs } from '../src/policy/model.ts';
import { claimAddressOf } from '../src/auth/federation.ts';
import { evaluateEligibility } from '../src/policy/eligibility.ts';

const NOW = new Date('2026-09-28T00:00:00Z');
const GATE = claimAddressOf('platform:gate', 'email_verified');
const GITHUB = claimAddressOf('github', 'login');

const contextOf = (identity: Record<string, unknown> = {}, over: Partial<EvaluationContext> = {}): EvaluationContext =>
  ({
    missingPolicy: 'indeterminate',
    facts: () => undefined,
    user: { email: null, email_verified: false, status: 'active', tags: [] },
    bindings: {},
    identity,
    now: NOW,
    ...over,
  }) as EvaluationContext;

const stateOf = (expression: unknown, identity: Record<string, unknown> = {}): string =>
  evaluateExpression(expression as never, { context: contextOf(identity) }).state;

// ─────────────────────── ① 解析层 ───────────────────────

test('★★ `parseOperand` 必须把 `identity:` **认成身份地址**（而不是字面量）', () => {
  const ref = parseOperand(GATE);
  assert.equal(ref.kind, 'identity', '★ 掉进 `literal` 就会拿整串去比较 —— 永远为假');
  // 键与表达式里书写的**逐字一致**（不引入第二套映射）
  assert.equal(ref.path, GATE);
});

test('★ 带 `@` 与内层 `:` 的 ref 不被切错（`oidc@platform:gate`）', () => {
  const ref = parseOperand('identity:oidc@external:proj-a.sub');
  assert.equal(ref.kind, 'identity');
  assert.equal(ref.path, 'identity:oidc@external:proj-a.sub');
});

test('★ 裸 `identity`（无冒号）仍是字面量（不误判）', () => {
  assert.equal(parseOperand('identity').kind, 'literal');
});

// ─────────────────────── ② 依赖收集层 ───────────────────────

test('★★ `collectIdentityRefs` 收集身份地址（装配阶段据此预加载）', () => {
  const refs = collectIdentityRefs({ eq: { [GATE]: true, [GITHUB]: 'alice' } });
  assert.deepEqual([...refs].sort(), [GATE, GITHUB].sort());
});

test('★ 身份地址**不**混进 `collectFactRefs`（两类依赖分开预加载）', () => {
  const refs = collectIdentityRefs({
    and: [{ eq: { [GATE]: true } }, { eq: { 'fact.email.domain': 'x' } }],
  });
  assert.deepEqual([...refs], [GATE], '★ 事实不该出现在身份清单里');
});

// ─────────────────────── ③ 求值层 ───────────────────────

test('★★ identity claim 为真 / 为假时分别得到 `true` / `false`', () => {
  assert.equal(stateOf({ eq: { [GATE]: true } }, { [GATE]: true }), 'true');
  assert.equal(stateOf({ eq: { [GATE]: true } }, { [GATE]: false }), 'false');
});

test('★★★ **没有该身份**时必须 `indeterminate`（不得判 `false` —— H1：不降级）', () => {
  assert.equal(
    stateOf({ eq: { [GATE]: true } }, {}),
    'indeterminate',
    '★ 把"不知道这个用户在某 OIDC 下的 claim"当成"不满足"，会误收回权限',
  );
});

test('★★ claim **未开放**（不在 `exposedClaims` 里）同样 `indeterminate`', () => {
  // 装配层只放开放的 claim：未开放的 claim 在映射里根本不存在 → 与"没有该身份"同语义
  assert.equal(stateOf({ eq: { [GATE]: true } }, { [GITHUB]: 'alice' }), 'indeterminate');
});

test('★★ 身份地址与主体/事实**互不干扰**', () => {
  const state = stateOf(
    { all: [{ eq: { [GATE]: true } }, { eq: { 'subject:newapi.group': 'vip' } }] },
    { [GATE]: true },
  );
  // `subject:newapi.group` 没提供 → indeterminate（H1），因此整体 indeterminate
  assert.equal(state, 'indeterminate');
});

// ─────────────────────── ④ 跨模块一致性 + 装配透传 ───────────────────────

test('★★★ 与 `federation.claimAddressOf` **逐字一致**（地址格式只有一处定义）', () => {
  for (const [ref, claim] of [
    ['platform:gate', 'email_verified'],
    ['platform:enduser', 'sub'],
    ['github', 'login'],
  ] as const) {
    const address = claimAddressOf(ref, claim);
    assert.equal(address, `identity:oidc@${ref}.${claim}`);
    assert.equal(parseOperand(address).kind, 'identity', `★ 权威实现产出的地址必须能被解析：${address}`);
    assert.equal(evaluateExpression({ eq: { [address]: 'v' } } as never, { context: contextOf({ [address]: 'v' }) }).state, 'true');
  }
});

test('★★ 装配**透传**：`evaluateEligibility` 接收的 `identity` 要真的进到求值上下文', () => {
  const policy = {
    code: 'id-verified',
    version: 1,
    enabled: true,
    spec: { requirements: { expression: { eq: { [GATE]: true } } } },
  } as never;

  const withIdentity = evaluateEligibility({
    policies: [policy],
    user: { status: 'active' },
    facts: { values: {}, collectedAt: {} },
    now: NOW,
    identity: { [GATE]: true },
  });
  assert.equal(withIdentity.results[0]!.evaluation.decision, 'satisfied');

  // ★ 不透传（省略）时必须是 indeterminate —— 这条防的正是本仓库反复出现的"透传缺失"
  const withoutIdentity = evaluateEligibility({
    policies: [policy],
    user: { status: 'active' },
    facts: { values: {}, collectedAt: {} },
    now: NOW,
  });
  assert.equal(withoutIdentity.results[0]!.evaluation.decision, 'indeterminate');
});
