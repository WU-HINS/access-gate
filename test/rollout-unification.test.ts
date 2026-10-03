/**
 * ★★ **灰度分桶统一** 与 **一键熔断**（`docs/07 M6-3` + `docs/05 §6.3.1`）。
 *
 * 本轮做的是**接线与消重**，本文件钉住三件事：
 *
 * ① ★★ **分桶只有一处实现**。此前 `core/policy-assignments.ts` 的 `inRollout` 有**独立**的一份
 *    哈希（`sha256("<policyId>:<userId>")`），而 `policy/rollout.ts` 的 `bucketOf` 用 `\0` 分隔 ——
 *    **同一用户会落到不同的桶**。两套公式并存时，管理端的灰度预览与运行期真实判定会给出
 *    不同答案，而两边各自看都正确（最难查的一类不一致）。现在 `inRollout` **委托** `bucketOf`。
 *
 * ② ★★ **熔断的优先级最高**（`docs`：止血不能被任何名单或比例阻挡）——包括白名单。
 *
 * ③ ★★ **按站点分组的受影响清单**（`docs/05 §6.3.1` 明文要求）：
 *    熔断是"立刻全部回滚"，运维必须知道**这次回滚动了谁**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inRollout } from '../src/core/policy-assignments.ts';
import {
  abortRollout,
  affectedByAbort,
  bucketOf,
  inspectDistribution,
  resolveRollout,
  resumeRollout,
  shouldAutoAbort,
  type RolloutConfig,
} from '../src/policy/rollout.ts';

const configOf = (over: Partial<RolloutConfig> = {}): RolloutConfig => ({
  id: 'policy-x',
  siteId: 'site-a',
  policyCode: 'p',
  fromVersion: 1,
  toVersion: 2,
  percentage: 50,
  ...over,
});

const USERS = Array.from({ length: 200 }, (_, i) => `user-${i}`);

// ─────────────────────── ① 分桶统一 ───────────────────────

test('★★★ `inRollout` 与 `resolveRollout` 对同一用户**结论一致**（分桶只有一处实现）', () => {
  for (const percentage of [0, 5, 10, 50, 90, 100]) {
    for (const userId of USERS) {
      const mine = inRollout({ policyId: 'policy-x', userId, rolloutPercent: percentage });
      const theirs = resolveRollout(configOf({ percentage }), userId).side === 'new';
      assert.equal(
        mine,
        theirs,
        `★ 分桶公式分叉：percentage=${percentage} user=${userId} ` +
          `（inRollout=${mine} vs resolveRollout=${theirs}）—— 这会让"预览"与"运行期"给出不同答案`,
      );
    }
  }
});

test('★ 边界：0% 全不在、100% 全在（两个入口一致）', () => {
  for (const userId of USERS.slice(0, 20)) {
    assert.equal(inRollout({ policyId: 'p', userId, rolloutPercent: 0 }), false);
    assert.equal(inRollout({ policyId: 'p', userId, rolloutPercent: 100 }), true);
    assert.equal(resolveRollout(configOf({ percentage: 0 }), userId).side, 'old');
    assert.equal(resolveRollout(configOf({ percentage: 100 }), userId).side, 'new');
  }
});

test('★★ 不同策略的灰度**互不相关**（同一批用户不会在所有策略里同时被灰度）', () => {
  const a = USERS.filter((u) => bucketOf(u, 'policy-a') < 20);
  const b = USERS.filter((u) => bucketOf(u, 'policy-b') < 20);
  const identical = a.length === b.length && a.every((u, i) => u === b[i]);
  assert.equal(
    identical,
    false,
    '★ 若两策略的人群完全相同，说明 `rolloutId` 没进哈希 —— 实验会互相污染',
  );
});

test('★ 分桶是**纯函数**（同输入同输出）且值域 0-99', () => {
  for (const userId of USERS.slice(0, 30)) {
    const first = bucketOf(userId, 'r1');
    assert.equal(bucketOf(userId, 'r1'), first);
    assert.ok(first >= 0 && first <= 99);
  }
});

// ─────────────────────── ② 熔断 ───────────────────────

test('★★★ 熔断后**所有**用户回旧版本 —— 包括白名单（止血不能被名单阻挡）', () => {
  const aborted = abortRollout(configOf({ allowUserIds: ['user-7'] }), {
    by: 'admin@example.com',
    reason: '灰度失败率超阈值',
    at: new Date('2026-09-28T00:00:00Z'),
  });

  for (const userId of USERS.slice(0, 50)) {
    const decision = resolveRollout(aborted, userId);
    assert.equal(decision.side, 'old', `熔断后 ${userId} 必须在旧版本`);
    assert.equal(decision.reason, 'aborted');
    assert.equal(decision.version, 1);
  }
  // 白名单用户也一样
  assert.equal(resolveRollout(aborted, 'user-7').side, 'old');
});

test('★★ `abortRollout` **幂等**且保留**首个**熔断者（复盘时"谁最先发现"更有价值）', () => {
  const first = abortRollout(configOf(), { by: 'alice', reason: '首次发现', at: new Date('2026-09-28T01:00:00Z') });
  const second = abortRollout(first, { by: 'bob', reason: '又点了一次', at: new Date('2026-09-28T02:00:00Z') });

  assert.equal(second.abortedBy, 'alice');
  assert.equal(second.abortReason, '首次发现');
  assert.equal(second.abortedAt?.toISOString(), '2026-09-28T01:00:00.000Z');
});

test('★ `abortRollout` 是**纯函数**（不改原配置）+ `resumeRollout` 可恢复', () => {
  const before = configOf();
  const aborted = abortRollout(before, { by: 'a', reason: 'r', at: new Date() });
  assert.equal(before.abortedAt, undefined, '★ 不应修改传入对象');

  const resumed = resumeRollout(aborted);
  assert.equal(resumed.abortedAt, null);
  assert.equal(resumed.abortedBy, null);
  // 恢复后按比例重新分流（不再全部 old）
  const sides = new Set(USERS.map((u) => resolveRollout(resumed, u).side));
  assert.equal(sides.size, 2, '★ 恢复后应重新出现两侧用户');
});

test('★★ 自动熔断有**最小样本量**（一次失败不该熔断）', () => {
  assert.equal(shouldAutoAbort({ failures: 1, total: 1, threshold: 0.05 }).abort, false, '样本太小不判');
  assert.equal(shouldAutoAbort({ failures: 100, total: 1000, threshold: 0.05 }).abort, true);
  assert.equal(shouldAutoAbort({ failures: 10, total: 1000, threshold: 0.05 }).abort, false);
});

// ─────────────────────── ③ 受影响清单（§6.3.1）───────────────────────

test('★★★ `affectedByAbort` 给出**按站点分组**的受影响清单（`docs/05 §6.3.1` 明文要求）', () => {
  const usersBySite = {
    'site-a': USERS,
    'site-b': USERS.slice(0, 100),
  };
  const configs: RolloutConfig[] = [
    abortRollout(configOf({ siteId: 'site-a', percentage: 20 }), { by: 'ops', reason: '错误率上升', at: new Date() }),
    abortRollout(configOf({ siteId: 'site-b', percentage: 20 }), { by: 'ops', reason: '错误率上升', at: new Date() }),
    // 未熔断的配置不该出现在清单里
    configOf({ siteId: 'site-c' }),
  ];

  const affected = affectedByAbort(configs, usersBySite);
  assert.equal(affected.length, 2, '★ 只列**已熔断**的');
  assert.deepEqual(
    affected.map((a) => a.siteId),
    ['site-a', 'site-b'],
    '★ 按站点分组（且稳定排序，便于人读与 diff）',
  );
  for (const group of affected) {
    assert.ok(group.rolledBackUsers > 0, '★ 必须给出"被回滚的用户数"——运维据此判断影响面');
    assert.equal(group.reason, '错误率上升');
    assert.equal(group.fromVersion, 1);
  }
  assert.ok(affected[0]!.rolledBackUsers > affected[1]!.rolledBackUsers, '站点 A 用户更多 → 回滚人数更多');
});

test('★ `inspectDistribution` 让"实际放量比例与配置是否相符"可核对', () => {
  const report = inspectDistribution(configOf({ percentage: 20 }), USERS);
  assert.equal(report.total, USERS.length);
  assert.equal(report.configuredPercentage, 20);
  assert.ok(
    Math.abs(report.actualPercentage - 20) < 6,
    `200 个用户下实际比例应接近 20%，实际 ${report.actualPercentage}%（偏差 ${report.deviationPoints} 点）`,
  );
  assert.ok(Math.abs(report.deviationPoints) < 6);
});
