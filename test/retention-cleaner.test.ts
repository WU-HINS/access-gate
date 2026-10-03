/**
 * 策略版本清理的编排（`docs/05 §2.1.4` 第 3 条）。
 *
 * ★ 本文件要证明的核心事实：**正在生效的版本永远不会被清理掉**。
 *   否则状态表会指向一个被删的版本 → 永久授权**无法复现、无法回滚**。
 *
 * ★ 还要证明一条运维上重要的统计：`skippedProtected`（本来会被删、因被引用而幸免）
 *   —— 它长期 > 0 说明系统里存在大量长期存活的授权。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { purgePolicyVersions, type VersionPurgeDeps } from '../src/core/retention-cleaner.ts';
import type { VersionRef } from '../src/core/retention.ts';

function makeDeps(input: {
  versions: readonly VersionRef[];
  protectedIds?: readonly string[];
  keep: number;
}): { deps: VersionPurgeDeps; deleted: string[][] } {
  const deleted: string[][] = [];
  return {
    deleted,
    deps: {
      listVersions: async () => input.versions,
      listProtectedVersionIds: async () => new Set(input.protectedIds ?? []),
      deleteVersions: async (ids) => {
        deleted.push([...ids]);
      },
      keep: input.keep,
    },
  };
}

const P1: VersionRef[] = [
  { id: 'v1', policyId: 'p1', version: 1 },
  { id: 'v2', policyId: 'p1', version: 2 },
  { id: 'v3', policyId: 'p1', version: 3 },
  { id: 'v4', policyId: 'p1', version: 4 },
  { id: 'v5', policyId: 'p1', version: 5 },
];

test('正常清理：keep=3 → 删掉最旧的 2 个', async () => {
  const { deps, deleted } = makeDeps({ versions: P1, keep: 3 });
  const report = await purgePolicyVersions(deps);
  assert.deepEqual(report.purged, ['v1', 'v2']);
  assert.deepEqual(deleted, [['v1', 'v2']]);
  assert.equal(report.remaining, 3);
  assert.deepEqual(report.skippedProtected, []);
});

test('★ 正在生效的版本（有 granted/satisfied 状态的策略的 active 版本）**永不清理**', async () => {
  const { deps, deleted } = makeDeps({ versions: P1, protectedIds: ['v1'], keep: 3 });
  const report = await purgePolicyVersions(deps);
  // v1 本来会被删（超出 keep=3），但它被保护 → 只删 v2
  assert.deepEqual(report.purged, ['v2']);
  assert.deepEqual(deleted, [['v2']]);
  assert.deepEqual(report.skippedProtected, ['v1'], '★ 这个数字要能被运维看见');
});

test('★ 被保护的版本**不需要**是最新的：最旧的 active 版本同样受保护', async () => {
  const { deps } = makeDeps({ versions: P1, protectedIds: ['v1', 'v2'], keep: 1 });
  const report = await purgePolicyVersions(deps);
  // keep=1 → 只有 v5 在「最新 1 个」内；v1/v2 被保护；其余可删
  assert.deepEqual(report.purged, ['v3', 'v4']);
  assert.deepEqual(report.skippedProtected, ['v1', 'v2']);
});

test('无待删版本 → **不调用** deleteVersions（避免无意义的写）', async () => {
  const { deps, deleted } = makeDeps({ versions: P1.slice(0, 2), keep: 5 });
  const report = await purgePolicyVersions(deps);
  assert.deepEqual(report.purged, []);
  assert.deepEqual(deleted, [], '★ 没有待删项时不该产生 DELETE');
  assert.equal(report.remaining, 2);
});

test('多策略各自独立计数（一个策略的版本数不影响另一个）', async () => {
  const versions: VersionRef[] = [
    ...P1,
    { id: 'q1', policyId: 'p2', version: 1 },
    { id: 'q2', policyId: 'p2', version: 2 },
  ];
  const { deps } = makeDeps({ versions, keep: 2 });
  const report = await purgePolicyVersions(deps);
  // ★ p2 只有 2 个版本、keep=2 → 全部保留（`q1` **不该**被删）；
  //   p1 有 5 个 → 删最旧的 3 个。这正是「各自独立计数」的含义。
  assert.deepEqual(report.purged, ['v1', 'v2', 'v3']);
});

test('空版本表 → 空报告（不报错）', async () => {
  const { deps } = makeDeps({ versions: [], keep: 3 });
  const report = await purgePolicyVersions(deps);
  assert.deepEqual(report, { purged: [], skippedProtected: [], remaining: 0 });
});
