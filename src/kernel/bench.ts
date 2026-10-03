/**
 * 压测原语（M6-4 的支撑）—— docs/07 M6-4「10 万主体全量评估、500 QPS 管理读」。
 *
 * ★ 本模块只提供**测量原语**，不含任何「达标判定」——判定由 `tools/bench.ts` 做，
 *   这样「怎么测」与「多少算够」是两个可以独立修改的东西。
 *
 * ★ 三处刻意的做法：
 *
 * 1. **分位数从原始样本算**（排序后取位置），而不是「均值 + 假设正态」。
 *    延迟分布**几乎从不服从正态**（长尾是常态），用均值汇报会掩盖掉
 *    最需要知道的信息：p99 到底有多慢。
 *
 * 2. **并发用固定 worker 数**而不是「一次性发起 N 个请求」：
 *    后者会把 N 个请求全部塞进事件循环，测出来的是「内存排队速度」，
 *    与真实负载（有并发上限的客户端）无关。
 *
 * 3. **记录失败与超时**，且**不把它们从统计里剔除**——
 *    把失败样本丢掉会让「错误率高但成功的那些很快」看起来很好看。
 */

// ─────────────────────────── 样本与统计 ───────────────────────────

export interface Sample {
  /** 单次操作的耗时（毫秒） */
  durationMs: number;
  ok: boolean;
  /** 失败原因（ok=false 时有意义） */
  error?: string;
}

export interface BenchStats {
  total: number;
  succeeded: number;
  failed: number;
  /** 错误率（0-1） */
  errorRate: number;
  /** 吞吐（次/秒） */
  throughput: number;
  /** 总墙钟时间（毫秒） */
  wallMs: number;
  /** 延迟分位（毫秒）——**只统计成功样本**（失败样本的耗时无意义） */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
  /** 失败原因分布 */
  errors: Record<string, number>;
}

/**
 * 计算分位数（**线性插值**，与常见监控系统一致）。
 *
 * ★ 空样本返回 0 而不是 NaN：调用方拿到 NaN 后会一路传播到报表里，
 *   而 0 至少能让「没有样本」这件事在数值上可见（配合 `total === 0` 判断）。
 */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * Math.max(0, Math.min(1, fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/** 汇总样本（**失败样本计入错误率，但不计入延迟分位**）。 */
export function summarize(samples: readonly Sample[], wallMs: number): BenchStats {
  const succeeded = samples.filter((sample) => sample.ok);
  const failed = samples.filter((sample) => !sample.ok);
  const durations = succeeded.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const errors: Record<string, number> = {};
  for (const sample of failed) {
    const key = sample.error ?? 'unknown';
    errors[key] = (errors[key] ?? 0) + 1;
  }
  return {
    total: samples.length,
    succeeded: succeeded.length,
    failed: failed.length,
    errorRate: samples.length === 0 ? 0 : failed.length / samples.length,
    throughput: wallMs === 0 ? 0 : (samples.length / wallMs) * 1000,
    wallMs,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    min: durations[0] ?? 0,
    max: durations[durations.length - 1] ?? 0,
    errors,
  };
}

// ─────────────────────────── 并发执行 ───────────────────────────

export interface RunOptions {
  /** 总操作数 */
  total: number;
  /** 并发 worker 数（**固定**，模拟有上限的客户端） */
  concurrency: number;
  /** 单次操作 */
  operation: (index: number) => Promise<void>;
  /** 单次操作超时（毫秒；超时按失败计入） */
  timeoutMs?: number;
  /** 进度回调（长跑基准需要可观测） */
  onProgress?: (done: number, stats: BenchStats) => void;
  /** 时钟注入（测试用） */
  now?: () => number;
}

/**
 * 以固定并发跑 N 次操作，收集样本。
 *
 * ★ worker 之间**共享一个索引计数器**（原子递增由 JS 单线程保证），
 *   因此不会出现「两个 worker 跑同一个 index」——那会让实际样本数少于 `total`，
 *   而统计里却按 `total` 算吞吐（数字会虚高）。
 */
export async function runConcurrent(options: RunOptions): Promise<BenchStats> {
  const now = options.now ?? (() => Date.now());
  const samples: Sample[] = [];
  let nextIndex = 0;
  const startedAt = now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.total) return;

      const operationStartedAt = now();
      try {
        if (options.timeoutMs === undefined) {
          await options.operation(index);
        } else {
          await withTimeout(options.operation(index), options.timeoutMs);
        }
        samples.push({ durationMs: now() - operationStartedAt, ok: true });
      } catch (error) {
        samples.push({
          durationMs: now() - operationStartedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (options.onProgress !== undefined && samples.length % 100 === 0) {
        options.onProgress(samples.length, summarize(samples, now() - startedAt));
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, () => worker());
  await Promise.all(workers);
  return summarize(samples, now() - startedAt);
}

/** 超时包装（**不 unref 定时器**——unref 会让超时永不触发，见项目历史教训）。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`操作超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─────────────────────────── 达标判定 ───────────────────────────

export interface Target {
  name: string;
  /** 期望的最小吞吐 */
  minThroughput?: number;
  /** 期望的最大 p99 延迟（毫秒） */
  maxP99Ms?: number;
  /** 期望的最大错误率 */
  maxErrorRate?: number;
}

export interface TargetVerdict {
  target: string;
  met: boolean;
  /** 逐条差距（**不达标时说明差多少**，而不是只说「不达标」） */
  details: string[];
}

/**
 * 判定是否达标。
 *
 * ★ 关键：不达标时给出**具体差距**（「吞吐 120/s，目标 500/s，差 4.2 倍」），
 *   而不是一句「不达标」。压测的价值在于指导优化，而「差多少」正是优化起点。
 */
export function evaluateTarget(stats: BenchStats, target: Target): TargetVerdict {
  const details: string[] = [];
  let met = true;

  if (target.minThroughput !== undefined) {
    const ok = stats.throughput >= target.minThroughput;
    met = met && ok;
    details.push(
      ok
        ? `吞吐 ${stats.throughput.toFixed(1)}/s ≥ 目标 ${target.minThroughput}/s`
        : `吞吐 ${stats.throughput.toFixed(1)}/s < 目标 ${target.minThroughput}/s（差 ${(target.minThroughput / Math.max(stats.throughput, 0.001)).toFixed(2)} 倍）`,
    );
  }
  if (target.maxP99Ms !== undefined) {
    const ok = stats.p99 <= target.maxP99Ms;
    met = met && ok;
    details.push(
      ok ? `p99 ${stats.p99.toFixed(1)}ms ≤ 目标 ${target.maxP99Ms}ms` : `p99 ${stats.p99.toFixed(1)}ms > 目标 ${target.maxP99Ms}ms`,
    );
  }
  if (target.maxErrorRate !== undefined) {
    const ok = stats.errorRate <= target.maxErrorRate;
    met = met && ok;
    details.push(
      ok
        ? `错误率 ${(stats.errorRate * 100).toFixed(2)}% ≤ 目标 ${(target.maxErrorRate * 100).toFixed(2)}%`
        : `错误率 ${(stats.errorRate * 100).toFixed(2)}% > 目标 ${(target.maxErrorRate * 100).toFixed(2)}%`,
    );
  }
  return { target: target.name, met, details };
}

/** 把统计渲染成一行可读文本（供 CI 日志与报告）。 */
export function formatStats(label: string, stats: BenchStats): string {
  return (
    `${label}: ${stats.total} 次 / ${stats.wallMs.toFixed(0)}ms → ` +
    `${stats.throughput.toFixed(1)}/s · ` +
    `p50 ${stats.p50.toFixed(1)}ms · p95 ${stats.p95.toFixed(1)}ms · p99 ${stats.p99.toFixed(1)}ms · ` +
    `失败 ${stats.failed}（${(stats.errorRate * 100).toFixed(2)}%）`
  );
}
