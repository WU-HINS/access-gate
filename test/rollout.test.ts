/**
 * 灰度发布与一键熔断验收（M6-3 / M3-10）。
 *
 * 验收标准（M3-10 原文）：**「同一用户灰度结果稳定」**。
 * 本文件把它拆成可执行的断言——因为最自然的实现（`Math.random() < 0.1`）
 * 会让同一用户在新旧版本之间**来回翻转**，而每次翻转都可能触发动作（改分组 → 踢下线）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

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

const NOW = new Date('2025-06-01T00:00:00Z');

const base: RolloutConfig = {
  id: 'rollout-2025-06',
  siteId: 'site-a',
  policyCode: 'edu',
  fromVersion: 3,
  toVersion: 4,
  percentage: 10,
};

// ─────────────────────────── ★ 结果稳定 ───────────────────────────

test('★ M3-10：同一用户在同一灰度里**结果恒定**（这是验收标准本身）', () => {
  for (const userId of ['u1', 'u2', 'u-abc', '0192a1b2-0000-0000-0000-000000000001']) {
    const first = resolveRollout(base, userId);
    for (let i = 0; i < 100; i += 1) {
      const again = resolveRollout(base, userId);
      assert.equal(again.side, first.side, `★ ${userId} 第 ${i} 次判定必须与首次一致`);
      assert.equal(again.version, first.version);
      assert.equal(again.bucket, first.bucket);
    }
  }
});

test('★ M3-10：分桶是**纯函数**（同输入同输出，不依赖时间/随机）', () => {
  assert.equal(bucketOf('u1', 'r1'), bucketOf('u1', 'r1'));
  assert.ok(bucketOf('u1', 'r1') >= 0 && bucketOf('u1', 'r1') < 100);
  // 不同 rolloutId → 不同分桶（同用户可能换侧）
  const buckets = new Set(['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => bucketOf('u1', id)));
  assert.ok(buckets.size > 1, '换一次灰度应重新分桶');
});

test('★：递增 userId **不会集中在同一侧**（这是用 sha256 而非取模的理由）', () => {
  // 若实现是 `Number(userId) % 100 < 10`，`user-1..user-9` 会全部落进灰度，
  // 而那批用户很可能是同一时间注册的同类用户 → 灰度结论系统性偏差。
  const config: RolloutConfig = { ...base, percentage: 10 };
  const sides = Array.from({ length: 200 }, (_, index) => resolveRollout(config, `user-${index}`).side);
  const newCount = sides.filter((side) => side === 'new').length;
  assert.ok(newCount > 5 && newCount < 45, `连续 id 的放量应接近 10%（实际 ${newCount}/200）`);
  // 且不是「前 N 个连续进灰度」
  const firstTen = sides.slice(0, 10).filter((side) => side === 'new').length;
  assert.ok(firstTen < 5, `前 10 个连续用户不应全部进灰度（实际 ${firstTen}）`);
});

test('★：分桶分布接近配置比例（放量前可自检）', () => {
  const users = Array.from({ length: 2000 }, (_, index) => `u-${index}`);
  const report = inspectDistribution({ ...base, percentage: 25 }, users);
  assert.equal(report.total, 2000);
  assert.equal(report.configuredPercentage, 25);
  assert.ok(report.deviationPoints < 3, `2000 个样本的偏差应小于 3 个百分点（实际 ${report.deviationPoints}）`);
});

// ─────────────────────────── 边界与名单 ───────────────────────────

test('M6-3：比例边界（0% 无人、100% 全部）', () => {
  const users = ['u1', 'u2', 'u3'];
  for (const userId of users) {
    assert.equal(resolveRollout({ ...base, percentage: 0 }, userId).side, 'old');
    assert.equal(resolveRollout({ ...base, percentage: 100 }, userId).side, 'new');
  }
  // 越界值被夹取（不静默按字面值算）
  assert.equal(resolveRollout({ ...base, percentage: -10 }, 'u1').side, 'old');
  assert.equal(resolveRollout({ ...base, percentage: 999 }, 'u1').side, 'new');
});

test('M6-3：白名单始终新版本、黑名单始终旧版本（黑名单优先）', () => {
  const config: RolloutConfig = { ...base, percentage: 0, allowUserIds: ['vip-1'], denyUserIds: ['blocked-1'] };
  const allowed = resolveRollout(config, 'vip-1');
  assert.equal(allowed.side, 'new');
  assert.equal(allowed.reason, 'allowed');
  assert.equal(allowed.version, 4);

  const denied = resolveRollout(config, 'blocked-1');
  assert.equal(denied.side, 'old');
  assert.equal(denied.reason, 'denied');

  // 同时在两个名单里 → 黑名单优先（拒绝优先于允许）
  const both = resolveRollout({ ...config, allowUserIds: ['x'], denyUserIds: ['x'] }, 'x');
  assert.equal(both.side, 'old', '黑名单优先于白名单');
});

test('M6-3：判定带**依据与分桶值**（用户会问「为什么我被分到新版本」）', () => {
  const decision = resolveRollout({ ...base, percentage: 100 }, 'u1');
  assert.equal(decision.reason, 'percentage');
  assert.ok(Number.isInteger(decision.bucket));
  const out = resolveRollout({ ...base, percentage: 0 }, 'u1');
  assert.equal(out.reason, 'not_in_percentage');
});

// ─────────────────────────── ★ 一键熔断 ───────────────────────────

test('★ M6-3：一键熔断后**所有用户回旧版本**（含白名单——止血就是止血）', () => {
  const config: RolloutConfig = { ...base, percentage: 100, allowUserIds: ['vip-1'] };
  const aborted = abortRollout(config, { by: 'admin-1', reason: '新版本错误率 12%', at: NOW });

  assert.ok(aborted.abortedAt !== null);
  assert.equal(aborted.abortedBy, 'admin-1');
  assert.equal(aborted.abortReason, '新版本错误率 12%');

  for (const userId of ['u1', 'u2', 'vip-1']) {
    const decision = resolveRollout(aborted, userId);
    assert.equal(decision.side, 'old', `★ 熔断后 ${userId} 必须回旧版本`);
    assert.equal(decision.version, 3);
    assert.equal(decision.reason, 'aborted');
  }
  // 原对象不被修改（纯函数）
  assert.equal(config.abortedAt, undefined);
  assert.equal(resolveRollout(config, 'vip-1').side, 'new');
});

test('★ M6-3：熔断**幂等** —— 保留首次熔断的时间与原因（复盘时「谁最先发现」更重要）', () => {
  const first = abortRollout(base, { by: 'admin-1', reason: '错误率超阈值', at: NOW });
  const second = abortRollout(first, { by: 'admin-2', reason: '另一个人也点了', at: new Date(NOW.getTime() + 60_000) });
  assert.equal(second.abortedBy, 'admin-1', '★ 保留首次熔断者');
  assert.equal(second.abortReason, '错误率超阈值');
  assert.equal(second.abortedAt!.toISOString(), NOW.toISOString());
});

test('M6-3：熔断可恢复（修复后重新放量）', () => {
  const aborted = abortRollout(base, { by: 'a', reason: 'r', at: NOW });
  const resumed = resumeRollout(aborted);
  assert.equal(resumed.abortedAt, null);
  assert.equal(resumed.abortedBy, null);
  assert.equal(resumed.abortReason, null);
  assert.equal(resolveRollout(resumed, 'u1').side, resolveRollout(base, 'u1').side, '恢复后判定与原始一致');
});

test('★ M6-3：熔断优先级最高（比例/名单都不能阻挡止血）', () => {
  const config: RolloutConfig = { ...base, percentage: 100, allowUserIds: ['a'], denyUserIds: ['b'] };
  const aborted = abortRollout(config, { by: 'x', reason: 'y', at: NOW });
  for (const userId of ['a', 'b', 'c']) {
    assert.equal(resolveRollout(aborted, userId).reason, 'aborted', `${userId} 应因熔断回旧版本`);
  }
});

// ─────────────────────────── 自动熔断 ───────────────────────────

test('★ M6-3：自动熔断按失败率触发，且有**最小样本量**保护', () => {
  // 样本不足 → 不判（避免一次失败就熔断）
  const tiny = shouldAutoAbort({ failures: 1, total: 1, threshold: 0.05 });
  assert.equal(tiny.abort, false, '★ 样本太小不应熔断');
  assert.equal(tiny.rate, 1);

  // 样本足够且超阈值 → 熔断
  const bad = shouldAutoAbort({ failures: 12, total: 100, threshold: 0.05 });
  assert.equal(bad.abort, true);
  assert.match(bad.reason!, /失败率 12\.0% 超过阈值 5\.0%/);
  assert.match(bad.reason!, /样本 100/);

  // 未超阈值 → 不熔断
  assert.equal(shouldAutoAbort({ failures: 3, total: 100, threshold: 0.05 }).abort, false);
  // 恰好等于阈值 → 不熔断（「超过」才是）
  assert.equal(shouldAutoAbort({ failures: 5, total: 100, threshold: 0.05 }).abort, false);
  // 零样本 → 不熔断且不除零
  assert.deepEqual(shouldAutoAbort({ failures: 0, total: 0, threshold: 0.05 }), { abort: false, rate: 0 });
});

test('★ M6-3：熔断的**受影响清单按站点分组**（docs/05 §6.3.1：键必须与资源归属同构）', () => {
  const siteA = abortRollout({ ...base, id: 'r-a', siteId: 'site-a', percentage: 100 }, { by: 'admin', reason: '站点 A 故障', at: NOW });
  const siteB: RolloutConfig = { ...base, id: 'r-b', siteId: 'site-b', percentage: 50, abortedAt: NOW, abortedBy: 'admin', abortReason: '站点 B 故障' };
  const healthy: RolloutConfig = { ...base, id: 'r-c', siteId: 'site-c', percentage: 10 };

  const groups = affectedByAbort([siteA, siteB, healthy], {
    'site-a': ['u1', 'u2', 'u3'],
    'site-b': ['u4', 'u5', 'u6'],
    'site-c': ['u7'],
  });

  assert.deepEqual(groups.map((group) => group.siteId), ['site-a', 'site-b'], '未熔断的站点不出现');
  assert.equal(groups[0]!.rolledBackUsers, 3, '100% 放量的站点，全部用户被回滚');
  assert.equal(groups[1]!.rolledBackUsers, 0, '50% 放量但只有 3 个用户，可能无人被分到新版本');
  assert.equal(groups[0]!.reason, '站点 A 故障');
  assert.equal(groups[0]!.fromVersion, 3);
});

test('M6-3：受影响清单在**未熔断**时为空（不虚报影响面）', () => {
  assert.deepEqual(affectedByAbort([{ ...base, percentage: 100 }], { 'site-a': ['u1'] }), []);
});
