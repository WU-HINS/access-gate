/**
 * ★★ **配额计数器的 PG 实现**（`ag_quota_counters`）—— 真实 PG（pglite）。
 *
 * 这是 L-13 的**存储层**证明：限流与预算必须**跨实例**共享计数，
 * 而"先读再写"在两个实例同时读到 `used = limit - 1` 时必然**超发**。
 * 因此预占用**条件更新 + `RETURNING`**，本文件逐条验证它的语义边界：
 *
 *   ① 首次预占（插入路径）与后续条件递增；
 *   ② ★★ 超限返回 `null`（而不是"写进去再说"）；
 *   ③ ★★ **窗口滚动**：新窗口**重置**，而不是把旧窗口的用量累加进来；
 *   ④ ★★ `adjust` **如实记账**：可把 `used` 推到 `limit` 之上（结算需要），但**下限为 0**；
 *   ⑤ ★★ 并发调用**不超发**；
 *   ⑥ ★ 不同 owner 的键互不影响（归属隔离在存储层同样成立）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/pool.ts';
import { DbQuotaCounterStore } from '../src/db/quota-counter-adapter.ts';

const DAY1 = new Date('2026-09-28T00:00:00Z');
const DAY2 = new Date('2026-09-29T00:00:00Z');
const KEY = 'quota:platform:platform:p1:default:llm:tokens';
const OTHER = 'quota:platform:platform:p2:default:llm:tokens';

async function setup(t: { after: (fn: () => Promise<void>) => void }): Promise<DbQuotaCounterStore> {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await db.exec(`
    CREATE TABLE ag_quota_counters (
      quota_key varchar(192) PRIMARY KEY,
      window_start timestamptz NOT NULL,
      used bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ix_ag_quota_window ON ag_quota_counters (window_start);
  `);
  return new DbQuotaCounterStore(db);
}

const reserve = (store: DbQuotaCounterStore, amount: number, limit: number, windowStart = DAY1) =>
  store.reserve({ key: KEY, amount, limit, windowStart, windowMs: 86_400_000 });

// ─────────────────────── ① 预占 ───────────────────────

test('★★ 首次预占走**插入路径**，返回新值', async (t) => {
  const store = await setup(t);
  assert.equal(await reserve(store, 3, 10), 3);
});

test('★★ 后续预占走**条件递增**；超限返回 `null`（不是"写进去再说"）', async (t) => {
  const store = await setup(t);
  assert.equal(await reserve(store, 3, 10), 3);
  assert.equal(await reserve(store, 4, 10), 7);
  assert.equal(await reserve(store, 4, 10), null, '7 + 4 > 10 → 必须拒绝');
  assert.equal(await store.used(KEY, DAY1), 7, '被拒绝的预占**不得**改变计数');
});

test('★ 恰好用满：`used + amount === limit` 允许通过', async (t) => {
  const store = await setup(t);
  assert.equal(await reserve(store, 10, 10), 10);
  assert.equal(await reserve(store, 1, 10), null);
});

// ─────────────────────── ② 窗口滚动 ───────────────────────

test('★★★ 新窗口**重置**计数（而不是把旧窗口用量累加进来）', async (t) => {
  const store = await setup(t);
  assert.equal(await reserve(store, 8, 10), 8);
  assert.equal(await reserve(store, 8, 10), null);

  assert.equal(await reserve(store, 8, 10, DAY2), 8, '★ 新的一天应重新从 0 开始');
  // ★ 设计：**一个键一行**，窗口滚动时整行重置 → 旧窗口自然查不到（返回 0）。
  //   这是有意的取舍：为每个窗口留一行会让表无限增长，而历史上限流数字没有回溯价值。
  assert.equal(await store.used(KEY, DAY1), 0, '★ 整行已滚到新窗口 → 旧窗口查不到');
});

// ─────────────────────── ③ adjust（结算） ───────────────────────

test('★★★ `adjust` **如实记账**：可把 used 推到 limit 之上（结算需要）', async (t) => {
  const store = await setup(t);
  await reserve(store, 10, 10);
  // 结算：实际用量超出预占 90 → used 应为 100（> limit）
  await store.adjust({ key: KEY, delta: 90, windowStart: DAY1 });

  assert.equal(await store.used(KEY, DAY1), 100);
  assert.equal(
    await reserve(store, 1, 10),
    null,
    '★ 如实记账后，**下一次**调用必须被拒（若记账失败，配额会被无限突破）',
  );
});

test('★★ `adjust` 下限为 0（额度不能变成"信用"）', async (t) => {
  const store = await setup(t);
  await reserve(store, 5, 10);
  await store.adjust({ key: KEY, delta: -100, windowStart: DAY1 });
  assert.equal(await store.used(KEY, DAY1), 0);
});

test('★ `adjust` 对**不存在的键**也能建行（窗口重置路径）', async (t) => {
  const store = await setup(t);
  await store.adjust({ key: KEY, delta: 7, windowStart: DAY1 });
  assert.equal(await store.used(KEY, DAY1), 7);
});

// ─────────────────────── ④ release ───────────────────────

test('★ `release` 归还预占，且不会为负', async (t) => {
  const store = await setup(t);
  await reserve(store, 6, 10);
  await store.release({ key: KEY, amount: 2, windowStart: DAY1 });
  assert.equal(await store.used(KEY, DAY1), 4);
  await store.release({ key: KEY, amount: 100, windowStart: DAY1 });
  assert.equal(await store.used(KEY, DAY1), 0, '归还多于预占时不该把配额变成"信用"');
});

// ─────────────────────── ⑤ 并发 ───────────────────────

test('★★★ 并发预占**不超发**（条件更新保证）', async (t) => {
  const store = await setup(t);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => reserve(store, 1, 3)),
  );
  const passed = results.filter((value) => value !== null).length;
  assert.equal(passed, 3, `★ 只应有 3 次通过，实际 ${passed}（超发 = 多实例下配额被放大）`);
  assert.equal(await store.used(KEY, DAY1), 3);
});

// ─────────────────────── ⑥ 归属隔离 ───────────────────────

test('★★ 不同 owner 的键**互不影响**（归属隔离在存储层成立）', async (t) => {
  const store = await setup(t);
  assert.equal(await store.reserve({ key: KEY, amount: 10, limit: 10, windowStart: DAY1, windowMs: 86_400_000 }), 10);
  assert.equal(await store.reserve({ key: KEY, amount: 1, limit: 10, windowStart: DAY1, windowMs: 86_400_000 }), null);

  assert.equal(
    await store.reserve({ key: OTHER, amount: 10, limit: 10, windowStart: DAY1, windowMs: 86_400_000 }),
    10,
    '★ 另一个 owner 的额度必须完好（§6.3.1：邻居掏空桶是本会话记录的事故形态）',
  );
});
