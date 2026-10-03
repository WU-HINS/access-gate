/**
 * ★ P1-3：`one_shot`（永久授权）的**发布校验**（`docs/05 §2.1.4`）。
 *
 * 文档原话：
 * > **one_shot 必须声明** `maxLifetime`（默认不小于审计保留期），否则**发布校验拒绝**
 *
 * ★ 为什么必须是**发布时**而不是运行期：`one_shot` 一旦授予就**不再因条件变化而撤销**，
 *   而它的策略版本 / 评估 / 审计 / 动作流水都有保质期。3 年后要回滚这个授权时，
 *   证据**全都过期了**——"既无法复现、也无法解释、更无法回滚"。
 *   这个决定必须在发布那一刻就挡住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validatePolicy, type PolicyDocument } from '../src/policy/model.ts';

const REGISTRY = {
  installedPlugins: () => [] as string[],
  knownFactKeys: () => [] as string[],
  knownActions: () => [] as string[],
};

function policyWith(lifecycle: unknown): PolicyDocument {
  return {
    code: 'lifetime-test',
    name: '永久授权测试',
    version: 1,
    enabled: true,
    spec: {
      requirements: { expression: { always: true } },
      ...(lifecycle === undefined ? {} : { lifecycle: lifecycle as never }),
    },
  } as PolicyDocument;
}

const issuesOf = (document: PolicyDocument): { path: string; message: string }[] =>
  validatePolicy(document, REGISTRY).issues as { path: string; message: string }[];

test('★ `one_shot` 未声明 `maxLifetime` → **拒绝发布**', () => {
  const issues = issuesOf(policyWith({ mode: 'one_shot' }));
  const target = issues.filter((issue) => issue.path === 'spec.lifecycle.maxLifetime');
  assert.equal(target.length, 1, '必须恰好报一条（指向 maxLifetime）');
  assert.match(target[0]!.message, /必须声明 `maxLifetime`/);
  // ★ 报错要说清后果，而不是"字段缺失"
  assert.match(target[0]!.message, /无法复现|无法回滚/);
});

test('`one_shot` + `maxLifetime` 等于最短保留期 → 通过（`≤` 而非 `<`）', () => {
  // 默认保留期：评估 90 / 审计 180 / 动作流水 30 → 最短 30 天
  assert.deepEqual(
    issuesOf(policyWith({ mode: 'one_shot', maxLifetime: '30d' })).filter(
      (issue) => issue.path === 'spec.lifecycle.maxLifetime',
    ),
    [],
  );
});

test('★ `one_shot` + `maxLifetime` 超过最短保留期 → 拒绝，并说明**为什么**', () => {
  const target = issuesOf(policyWith({ mode: 'one_shot', maxLifetime: '365d' })).filter(
    (issue) => issue.path === 'spec.lifecycle.maxLifetime',
  );
  assert.equal(target.length, 1);
  assert.match(target[0]!.message, /超过最短保留期 30 天/);
  assert.match(target[0]!.message, /评估 90 \/ 审计 180 \/ 动作流水 30/);
  assert.match(target[0]!.message, /授权不能比它的证据活得更久/);
});

test('★ `one_shot` + 无法解析的 `maxLifetime` → 拒绝（配置错误要响亮）', () => {
  const target = issuesOf(policyWith({ mode: 'one_shot', maxLifetime: '很久' })).filter(
    (issue) => issue.path === 'spec.lifecycle.maxLifetime',
  );
  assert.equal(target.length, 1);
  assert.match(target[0]!.message, /无法解析/);
});

test('★ 非 `one_shot` 模式**不受**此校验（`auto_revoke` / `manual` / `periodic`）', () => {
  for (const mode of ['auto_revoke', 'manual', 'periodic']) {
    const target = issuesOf(policyWith({ mode })).filter(
      (issue) => issue.path === 'spec.lifecycle.maxLifetime',
    );
    assert.deepEqual(target, [], `${mode} 不该被这条校验拦住`);
  }
});

test('★ 向后兼容：完全没有 `lifecycle` 的策略照常通过', () => {
  const target = issuesOf(policyWith(undefined)).filter(
    (issue) => issue.path === 'spec.lifecycle.maxLifetime',
  );
  assert.deepEqual(target, []);
});
