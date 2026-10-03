/**
 * 压测原语验收（M6-4 的支撑）。
 *
 * 本节测的是**测量本身的正确性**——因为一个算错分位数的压测工具
 * 会产出「看起来专业但完全错误」的数字，比没有工具更糟。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateTarget,
  formatStats,
  percentile,
  runConcurrent,
  summarize,
  type Sample,
} from '../src/kernel/bench.ts';

// ─────────────────────────── 分位数 ───────────────────────────

test('★ M6-4：`percentile` 用**线性插值**（不是「取第 k 个样本」）', () => {
  const sorted = [10, 20, 30, 40, 50];
  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile(sorted, 1), 50);
  assert.equal(percentile(sorted, 0.5), 30, '中位数');
  // 0.25 → 位置 (5-1)*0.25 = 1 → 第 2 个
  assert.equal(percentile(sorted, 0.25), 20);
  // 0.3 → 位置 1.2 → 20 与 30 之间插值
  assert.equal(percentile(sorted, 0.3), 22);
  // 单样本与空样本
  assert.equal(percentile([7], 0.99), 7);
  assert.equal(percentile([], 0.5), 0, '★ 空样本返回 0 而不是 NaN（NaN 会一路传播到报表）');
});

test('★ M6-4：**均值会掩盖最慢的那次**（这就是要报分位与 max 的理由）', () => {
  // 99 个 10ms + 1 个 500ms
  const durations = [...Array.from({ length: 99 }, () => 10), 500];
  const sorted = [...durations].sort((a, b) => a - b);
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;

  assert.equal(mean, 14.9, '均值看起来很好（14.9ms）');
  assert.equal(sorted[sorted.length - 1], 500, '★ 但有用户等了 500ms——**均值把它平均掉了**');
  // 分位数确实反映了尾部（线性插值会向 500 靠）
  assert.ok(percentile(sorted, 0.99) > 10, `p99 应高于众数（实际 ${percentile(sorted, 0.99)}）`);
  assert.ok(percentile(sorted, 0.5) === 10, 'p50 仍是 10');
});

// ─────────────────────────── 汇总 ───────────────────────────

test('★ M6-4：失败样本**计入错误率但不计入延迟分位**', () => {
  const samples: Sample[] = [
    { durationMs: 10, ok: true },
    { durationMs: 20, ok: true },
    { durationMs: 30, ok: true },
    { durationMs: 9999, ok: false, error: 'boom' },
    { durationMs: 9999, ok: false, error: 'boom' },
  ];
  const stats = summarize(samples, 1000);
  assert.equal(stats.total, 5);
  assert.equal(stats.succeeded, 3);
  assert.equal(stats.failed, 2);
  assert.equal(stats.errorRate, 0.4);
  assert.equal(stats.p50, 20, '★ 失败样本的耗时（9999）不得进入分位');
  assert.equal(stats.max, 30, '★ 也不得成为 max（否则报表显示「最慢 10 秒」而其实是失败样本）');
  assert.deepEqual(stats.errors, { boom: 2 });
  // 吞吐按总样本数算（失败也是被处理过的请求）
  assert.equal(stats.throughput, 5);
});

test('M6-4：空样本与零耗时边界', () => {
  const empty = summarize([], 100);
  assert.equal(empty.total, 0);
  assert.equal(empty.errorRate, 0);
  assert.equal(empty.p50, 0);
  assert.equal(empty.throughput, 0);
  // wallMs 为 0 → 不除零
  assert.equal(summarize([{ durationMs: 1, ok: true }], 0).throughput, 0);
});

// ─────────────────────────── 并发执行 ───────────────────────────

test('★ M6-4：`runConcurrent` 的样本数**恰好等于 total**（不重复、不遗漏）', async () => {
  const seen = new Set<number>();
  const stats = await runConcurrent({
    total: 250,
    concurrency: 8,
    operation: async (index) => {
      assert.equal(seen.has(index), false, `★ index ${index} 被跑了两次`);
      seen.add(index);
    },
  });
  assert.equal(seen.size, 250, '★ 每个 index 恰好一次（共享计数器由单线程保证）');
  assert.equal(stats.total, 250);
  assert.equal(stats.failed, 0);
});

test('★ M6-4：操作抛错被记为失败（**不中断整轮**）', async () => {
  const stats = await runConcurrent({
    total: 40,
    concurrency: 4,
    operation: async (index) => {
      if (index % 4 === 0) throw new Error('synthetic');
    },
  });
  assert.equal(stats.total, 40, '★ 失败不中断，仍跑完全部');
  assert.equal(stats.failed, 10);
  assert.equal(stats.errorRate, 0.25);
  assert.deepEqual(stats.errors, { synthetic: 10 });
});

test('★ M6-4：超时按失败计入（且**超时定时器真的会触发**）', async () => {
  const stats = await runConcurrent({
    total: 4,
    concurrency: 2,
    timeoutMs: 50,
    operation: async (index) => {
      if (index % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    },
  });
  assert.equal(stats.failed, 2, '★ 慢操作被超时中断（unref 过的定时器永远不会触发——这是项目历史教训）');
  assert.ok(Object.keys(stats.errors).some((key) => /超时/.test(key)));
  assert.equal(stats.succeeded, 2);
});

test('M6-4：进度回调被调用（长跑基准需要可观测）', async () => {
  const progress: number[] = [];
  await runConcurrent({
    total: 250,
    concurrency: 4,
    operation: async () => undefined,
    onProgress: (done) => void progress.push(done),
  });
  assert.ok(progress.length >= 2, `至少报告两次进度（实际 ${progress.length}）`);
  assert.ok(progress.every((done) => done <= 250));
});

// ─────────────────────────── 达标判定 ───────────────────────────

test('★ M6-4：达标判定给出**具体差距**（压测的价值是指导优化）', () => {
  const stats = summarize(
    [
      { durationMs: 100, ok: true },
      { durationMs: 200, ok: true },
    ],
    1000,
  ); // 2 次 / 1s → 2/s

  const verdict = evaluateTarget(stats, { name: '管理读', minThroughput: 500, maxP99Ms: 50, maxErrorRate: 0 });
  assert.equal(verdict.met, false);
  assert.equal(verdict.details.length, 3);
  assert.match(verdict.details[0]!, /吞吐 2\.0\/s < 目标 500\/s（差 250\.00 倍）/, '★ 要说明差多少倍');
  // p99 由线性插值算得：位置 (2-1)*0.99=0.99 → 100*0.01 + 200*0.99 = 199
  assert.match(verdict.details[1]!, /p99 199\.0ms > 目标 50ms/);
  assert.match(verdict.details[2]!, /错误率 0\.00% ≤ 目标 0\.00%/);
});

test('M6-4：达标时逐条给出「通过了什么」', () => {
  const stats = summarize(Array.from({ length: 1000 }, () => ({ durationMs: 1, ok: true })), 1000); // 1000/s
  const verdict = evaluateTarget(stats, { name: '管理读', minThroughput: 500, maxP99Ms: 10, maxErrorRate: 0.001 });
  assert.equal(verdict.met, true);
  for (const detail of verdict.details) assert.match(detail, /[≤≥]/, '通过的项也要打印实际值');
  assert.match(verdict.details[0]!, /1000\.0\/s ≥ 目标 500\/s/);
});

test('M6-4：未指定某项目标时不判定该项（不虚报）', () => {
  const stats = summarize([{ durationMs: 5, ok: true }], 1000);
  const verdict = evaluateTarget(stats, { name: 'x', minThroughput: 1 });
  assert.equal(verdict.details.length, 1, '★ 只报告被指定的目标');
  assert.equal(verdict.met, true);
});

test('M6-4：`formatStats` 输出含吞吐与三个分位（供 CI 日志与报告引用）', () => {
  const stats = summarize([{ durationMs: 10, ok: true }, { durationMs: 20, ok: true }], 500);
  const text = formatStats('全量评估', stats);
  assert.match(text, /全量评估: 2 次/);
  assert.match(text, /p50 /);
  assert.match(text, /p95 /);
  assert.match(text, /p99 /);
  assert.match(text, /失败 0（0\.00%）/);
});
