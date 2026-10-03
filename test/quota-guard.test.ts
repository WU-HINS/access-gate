/**
 * ★★ **配额保护**（`docs/05 §6.4` `QuotaGuard` + `§6.3.1`「键必须与资源归属同构」）。
 *
 * 本文件钉住四条，其中第一条是文档记录的真实事故形态：
 *
 * ① ★★★ **归属隔离**：开发者 A 的站点把桶打满，**B / C 不受影响**。
 *    （§6.3.1 原文：修复前"开发者 A 的站点把桶打满 → B / C 的采集全部 missing，
 *      而告警把原因归给『渠道 X 不可信』——实际渠道完全正常"。）
 * ② ★★ 超限**不抛错**，而是返回可判定的结果（`docs/05 §6.4`：让事实返回 `missing`，
 *    由策略的 `onMissingFact` 决定）。
 * ③ ★★ 超限文案**必须带 owner**（否则管理员会去查渠道，而渠道是好的）。
 * ④ ★★ 下游调用失败要把预占**还回去**（"失败也扣费"是最难解释的一类现象）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryQuotaCounterStore,
  QuotaGuard,
  describeQuotaOwner,
  quotaKeyOf,
  type QuotaKey,
} from '../src/core/quota-guard.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

const T0 = new Date('2026-09-28T10:00:00Z');

const guardOf = (at: Date = T0) =>
  new QuotaGuard({
    store: new InMemoryQuotaCounterStore(),
    now: () => at,
    // ★ 采集日志：用于断言"超限时的归因里带 owner"（§6.3.1 的告警要求）
    logger: createLogger({ sink: collectingSink().sink, level: 'debug' }),
  });

const keyOf = (ownerId: string, over: Partial<QuotaKey> = {}): QuotaKey => ({
  ownerScope: 'site',
  ownerId,
  pluginId: 'newapi-provider',
  instanceKey: 'site-a',
  resource: 'llm:tokens',
  ...over,
});

// ─────────────────────── ① 键形状 ───────────────────────

test('★★ 键形状与文档一致：`quota:{ownerScope}:{ownerId}:{pluginId}:{instanceKey}:{resource}`', () => {
  assert.equal(
    quotaKeyOf(keyOf('site-a')),
    'quota:site:site-a:newapi-provider:site-a:llm:tokens',
  );
});

test('★ 归属描述里同时含 owner 与插件/实例（供告警使用）', () => {
  const described = describeQuotaOwner(keyOf('site-a'));
  assert.match(described, /owner=site:site-a/);
  assert.match(described, /plugin=newapi-provider/);
});

// ─────────────────────── ② 归属隔离（§6.3.1 的事故形态）───────────────────────

test('★★★ 一个 owner 把桶打满，**另一个 owner 不受影响**（跨租户故障传播的修复）', async () => {
  const guard = guardOf();

  // A 把桶用尽
  for (let i = 0; i < 3; i += 1) {
    const result = await guard.withTokenBucket(keyOf('site-a'), { capacity: 3, refillPerHour: 3 }, async () => 'ok');
    assert.equal(result.ok, true);
  }
  const exhausted = await guard.withTokenBucket(keyOf('site-a'), { capacity: 3, refillPerHour: 3 }, async () => 'ok');
  assert.equal(exhausted.ok, false);

  // ★ B 与 A 用同一个 resource 名，但**归属不同** → 必须完全不受影响
  const other = await guard.withTokenBucket(keyOf('site-b'), { capacity: 3, refillPerHour: 3 }, async () => 'ok');
  assert.equal(
    other.ok,
    true,
    '★ 若这里失败，就是 §6.3.1 记录的事故："邻居掏空了桶"，而告警会去怪渠道',
  );
});

test('★★ 同 owner 不同插件/实例也各自独立（键的每一维都参与隔离）', async () => {
  const guard = guardOf();
  await guard.withTokenBucket(keyOf('site-a', { pluginId: 'p1' }), { capacity: 1, refillPerHour: 1 }, async () => 'x');

  const p1Again = await guard.withTokenBucket(keyOf('site-a', { pluginId: 'p1' }), { capacity: 1, refillPerHour: 1 }, async () => 'x');
  assert.equal(p1Again.ok, false, '同键 → 已用尽');

  const p2 = await guard.withTokenBucket(keyOf('site-a', { pluginId: 'p2' }), { capacity: 1, refillPerHour: 1 }, async () => 'x');
  assert.equal(p2.ok, true, '不同插件 → 独立额度');

  const otherInstance = await guard.withTokenBucket(keyOf('site-a', { instanceKey: 'site-b' }), { capacity: 1, refillPerHour: 1 }, async () => 'x');
  assert.equal(otherInstance.ok, true, '不同实例 → 独立额度');
});

// ─────────────────────── ③ 超限不抛错 + 归因 ───────────────────────

test('★★ 超限**不抛错**，返回可判定结果（而不是让"配额用尽"与"代码出错"混在一起）', async () => {
  const guard = guardOf();
  await guard.withBudget(keyOf('site-a'), { daily: 100, amount: 100 }, async () => 'ok');

  const limited = await guard.withBudget(keyOf('site-a'), { daily: 100, amount: 1 }, async () => 'never');
  assert.equal(limited.ok, false);
  assert.equal(limited.ok === false && limited.reason, 'budget_exhausted');
  assert.equal(limited.ok === false && limited.ownerScope, 'site');
  assert.equal(limited.ok === false && limited.ownerId, 'site-a');
});

test('★★★ 超限文案**必须带 owner**（§6.3.1：否则管理员会去查渠道，而渠道是好的）', async () => {
  const guard = guardOf();
  await guard.withBudget(keyOf('site-a'), { daily: 1, amount: 1 }, async () => 'ok');
  const limited = await guard.withBudget(keyOf('site-a'), { daily: 1, amount: 1 }, async () => 'x');

  assert.equal(limited.ok, false);
  const message = limited.ok === false ? limited.message : '';
  assert.match(message, /owner=site:site-a/, '★ 文案必须能定位到"谁把额度用完了"');
  assert.match(message, /resource=llm:tokens/);
  assert.match(message, /used=1\/1/);
});

test('★ 超限时**不执行**下游（额度用尽就不该再发请求）', async () => {
  const guard = guardOf();
  let calls = 0;
  await guard.withBudget(keyOf('site-a'), { daily: 1, amount: 1 }, async () => {
    calls += 1;
    return 'ok';
  });
  const limited = await guard.withBudget(keyOf('site-a'), { daily: 1, amount: 1 }, async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(limited.ok, false);
  assert.equal(calls, 1, '★ 被限流的那次不该触达下游');
});

// ─────────────────────── ④ 失败要还额度 ───────────────────────

test('★★ 下游调用失败 → 预占**还回去**（不"失败也扣费"）', async () => {
  const guard = guardOf();
  await assert.rejects(
    guard.withBudget(keyOf('site-a'), { daily: 10, amount: 10 }, async () => {
      throw new Error('下游 500');
    }),
    /下游 500/,
  );
  // 额度应已归还：同样的 10 还能用
  const again = await guard.withBudget(keyOf('site-a'), { daily: 10, amount: 10 }, async () => 'ok');
  assert.equal(again.ok, true, '★ 失败不应消耗额度');
});

// ─────────────────────── ⑤ 窗口重置 ───────────────────────

test('★ 日预算跨天重置（窗口按 UTC 自然日）', async () => {
  const store = new InMemoryQuotaCounterStore();
  let now = T0;
  const guard = new QuotaGuard({ store, now: () => now });

  await guard.withBudget(keyOf('site-a'), { daily: 1, amount: 1 }, async () => 'ok');
  const sameDay = await guard.withBudget(keyOf('site-a'), { daily: 1, amount: 1 }, async () => 'x');
  assert.equal(sameDay.ok, false);

  now = new Date('2026-09-29T00:00:01Z'); // 次日
  const nextDay = await guard.withBudget(keyOf('site-a'), { daily: 1, amount: 1 }, async () => 'ok');
  assert.equal(nextDay.ok, true, '★ 新的一天应有新额度');
});

test('★ 令牌桶按**小时**窗口重置', async () => {
  const store = new InMemoryQuotaCounterStore();
  let now = T0;
  const guard = new QuotaGuard({ store, now: () => now });

  await guard.withTokenBucket(keyOf('site-a'), { capacity: 1, refillPerHour: 1 }, async () => 'ok');
  assert.equal((await guard.withTokenBucket(keyOf('site-a'), { capacity: 1, refillPerHour: 1 }, async () => 'x')).ok, false);

  now = new Date(T0.getTime() + 3_600_000); // 下一小时
  assert.equal((await guard.withTokenBucket(keyOf('site-a'), { capacity: 1, refillPerHour: 1 }, async () => 'ok')).ok, true);
});

// ─────────────────────── ⑥ 原子性 ───────────────────────

test('★★ 并发预占**不超发**（"读-改-写"会超发，所以接口只给条件累加）', async () => {
  const guard = guardOf();
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      guard.withTokenBucket(keyOf('site-a'), { capacity: 3, refillPerHour: 3 }, async () => 'ok'),
    ),
  );
  const passed = results.filter((r) => r.ok).length;
  assert.equal(passed, 3, `★ 并发下只应有 3 次通过，实际 ${passed}（超发 = 多实例下配额被放大）`);
});
