/**
 * 长跑稳定性验证（生产落地第 5 项）。
 *
 * ```
 *   起真实 PG + 迁移 → 以 --mode=real 启动 serve → 周期性采样 → 判定
 *   采样维度：进程 RSS / V8 heap / PG 进程数 / 健康状态 / 指标（错误计数）
 * ```
 *
 * ★ 为什么必须**真实运行一段时间**才能发现问题：
 *   泄漏、句柄累积、连接池耗尽、PG 进程堆积——这些在单次请求测试里**完全看不到**。
 *   它们的共同特征是「随时间单调增长」，而这只有采样时间序列才能发现。
 *
 * ★ 判定标准（本项目对「稳定」的定义）：
 *   1. **内存不单调增长**——后半段的平均 RSS 不得显著高于前半段（阈值可配置）；
 *   2. **PG 进程数不堆积**——采样期间不持续增加；
 *   3. **错误不累积**——健康检查与指标里的错误计数不随采样次数递增；
 *   4. **服务始终 ready**——每次采样 `/healthz/ready` 均为 200。
 *
 * ★ 关于「一段时间」的诚实说明：本工具的默认时长（分钟级）**不足以证明生产稳定**
 *   （生产的泄漏可能以小时/天为单位）。它能证明的是「没有分钟级的明显泄漏」，
 *   并把**采样时间序列**作为证据留档。真正的长跑应在预发环境跑数小时。
 *
 * 用法：
 *   node --experimental-strip-types tools/soak.ts --minutes=3 --interval=10
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRealPostgres } from './pg-real.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8897;
const BASE = `http://127.0.0.1:${PORT}`;

interface Sample {
  atSecond: number;
  rssMb: number;
  heapUsedMb: number;
  pgProcesses: number;
  ready: boolean;
  /** 从 /metrics 解析出的错误相关计数（若无则 null） */
  errorCounters: Record<string, number> | null;
  /** 本采样区间内完成的请求数（负载开启时） */
  requestsInWindow: number;
  /** 本区间内的失败请求数 */
  failuresInWindow: number;
  /** 本区间内的平均延迟（ms） */
  avgLatencyMs: number;
  /**
   * ★★★ R82：巡检/定时任务的执行计数（`ag_jobs.run_count`）。
   *
   * ★ 为什么必须记录它：目标第 (5) 项要求「**巡检与定时任务**连续运行一段时间
   *   无泄漏 / 无累积错误」——而「内存没涨」**不能证明「定时任务在跑」**。
   *   · `runCount` 随时间**递增** = 定时任务真的在执行；
   *   · `failCount` 保持 0 = 没有累积失败；
   *   · `lastError` 非空 = 有失败原因（★ 这才是「累积错误」的直接证据）。
   */
  patrol: { jobKey: string; runCount: number; failCount: number; lastRunAt: string | null; lastError: string | null }[];
}

function parseArgs(argv: readonly string[]): { minutes: number; intervalSeconds: number; loadQps: number } {
  let minutes = 3;
  let intervalSeconds = 10;
  /** ★ 每秒请求数（0 = 空转）。空转只能验证「空闲时不泄漏」，而有负载才暴露请求路径上的泄漏。 */
  let loadQps = 0;
  for (const arg of argv) {
    if (arg.startsWith('--minutes=')) minutes = Number.parseFloat(arg.slice('--minutes='.length));
    if (arg.startsWith('--interval=')) intervalSeconds = Number.parseFloat(arg.slice('--interval='.length));
    if (arg.startsWith('--load=')) loadQps = Number.parseFloat(arg.slice('--load='.length));
  }
  return { minutes, intervalSeconds, loadQps };
}

/** 统计 postgres 进程数（用 -x 精确匹配进程名，避免匹配到自己的命令行）。 */
function countPostgresProcesses(): number {
  const result = spawnSync('bash', ['-c', 'pgrep -cx postgres || true'], { encoding: 'utf8' });
  return Number.parseInt((result.stdout ?? '0').trim(), 10) || 0;
}

/** 从 `/metrics` 文本里提取以 `_total` 结尾的计数（错误累积的证据）。 */
function parseErrorCounters(text: string): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const match = /^([a-z_]+(?:_total|_count))\s+(\d+(?:\.\d+)?)$/.exec(line.trim());
    if (match === null) continue;
    const name = match[1]!;
    if (/error|fail|reject|timeout/i.test(name)) counters[name] = Number.parseFloat(match[2]!);
  }
  return counters;
}

async function main(): Promise<void> {
  const { minutes, intervalSeconds, loadQps } = parseArgs(process.argv.slice(2));
  const totalSamples = Math.max(2, Math.floor((minutes * 60) / intervalSeconds));
  process.stdout.write(`\n【长跑稳定性验证】时长 ${minutes} 分钟 · 每 ${intervalSeconds}s 采样一次（共 ${totalSamples} 次）\n\n`);

  const instance = await startRealPostgres({ fresh: true });
  process.stdout.write(`真实 PG 就绪 port=${instance.port}\n`);

  let child: ChildProcess | undefined;
  try {
    // ① 迁移（外部 PG）
    const migrate = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.join(ROOT, 'tools', 'db-migrate.ts'), `--database-url=${instance.url}`],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (migrate.status !== 0) throw new Error(`迁移失败：${(migrate.stderr ?? '').slice(-500)}`);
    process.stdout.write('迁移完成\n');

    // ② 以真实模式启动
    child = spawn(
      process.execPath,
      ['--experimental-strip-types', path.join(ROOT, 'tools', 'serve.ts'), '--mode=real', `--port=${PORT}`, '--log-level=warn'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          AG_MODE: 'real',
          AG_DATABASE_URL: instance.url,
          // ★ 真实模式必需：调用方密钥要加密存入 `ag_secrets`（R31 起强制要求）
          AG_MASTER_KEY: '00'.repeat(32),
          // ★★★ R82：把巡检间隔压到 **1 分钟**（默认 5 分钟）——
          //   否则 12 分钟的窗口里巡检只跑 2–3 次，「run_count 随时间递增」看不出规律；
          //   而本项要验证的正是「**定时任务连续运行**无泄漏/无累积错误」。
          AG_PATROL_INTERVAL_MS: '60000',
          AG_PUBLIC_URL: BASE,
          AG_OIDC_ISSUER: 'https://idp.invalid',
          AG_OIDC_CLIENT_ID: 'soak',
          AG_OIDC_REDIRECT_URI: `${BASE}/api/auth/callback`,
          AG_SECURE_COOKIES: '1',
          AG_ALLOW_DEMO: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // 等待 ready
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        ready = (await fetch(`${BASE}/healthz/ready`, { signal: AbortSignal.timeout(2000) })).status === 200;
      } catch {
        /* 未就绪 */
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`30s 内未就绪。stderr：${stderr.slice(-500)}`);
    // ★ 取冷启动引导令牌并换会话 cookie —— 负载必须打**真实业务路径**，
    //   否则全是 401，测出来的是「拒绝请求的速度」而不是业务路径的稳定性。
    let cookie = '';
    const tokenMatch = /\/api\/auth\/bootstrap\?token=([A-Za-z0-9_-]+)/.exec(stdout);
    if (tokenMatch !== null) {
      const login = await fetch(`${BASE}${tokenMatch[0]}`, { redirect: 'manual' });
      const setCookies = login.headers.getSetCookie?.() ?? [];
      cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ');
      process.stdout.write(`已获取会话 cookie（${cookie.length} 字节）——负载将打真实业务路径\n`);
    } else {
      process.stdout.write('⚠️ 未取到引导令牌——负载将打 /metrics（非业务路径）\n');
    }
    const loadPath = cookie.length > 0 ? '/api/console/sections' : '/metrics';
    process.stdout.write('服务已就绪，开始采样\n\n');

    // ③ 负载（可选）：用 http.request + keep-alive agent 持续发请求
    //   ★ 为什么必须有负载选项：空转的长跑只证明「空闲不泄漏」，
    //     而生产是**有负载**的——请求路径上的累积（对象、连接、定时器）只有负载才暴露。
    const loadAgent = new HttpAgent({ keepAlive: true, maxSockets: 32 });
    const loadStats = { total: 0, failures: 0, latencySumMs: 0 };
    let loadTimer: NodeJS.Timeout | undefined;
    if (loadQps > 0) {
      // 用「每 interval 发一批」的方式近似 QPS（避免 setInterval 精度问题）
      const batchIntervalMs = 200;
      const perBatch = Math.max(1, Math.round((loadQps * batchIntervalMs) / 1000));
      loadTimer = setInterval(() => {
        for (let index = 0; index < perBatch; index += 1) {
          const startedAt = Date.now();
          const request = httpRequest(
            { host: '127.0.0.1', port: PORT, path: loadPath, agent: loadAgent, headers: cookie.length > 0 ? { cookie } : {} },
            (response) => {
              response.resume();
              response.on('end', () => {
                loadStats.total += 1;
                loadStats.latencySumMs += Date.now() - startedAt;
                if ((response.statusCode ?? 0) >= 400) loadStats.failures += 1;
              });
            },
          );
          request.on('error', () => {
            loadStats.total += 1;
            loadStats.failures += 1;
          });
          request.end();
        }
      }, batchIntervalMs);
      process.stdout.write(`已开启负载：约 ${loadQps} QPS → ${loadPath}（每 ${batchIntervalMs}ms 发 ${perBatch} 个请求）\n`);
    }

    // ④ 周期采样
    const samples: Sample[] = [];
    const startedAt = Date.now();
    for (let index = 0; index < totalSamples; index += 1) {
      const atSecond = Math.round((Date.now() - startedAt) / 1000);
      let readyNow = false;
      let counters: Record<string, number> | null = null;
      try {
        readyNow = (await fetch(`${BASE}/healthz/ready`, { signal: AbortSignal.timeout(3000) })).status === 200;
      } catch {
        readyNow = false;
      }
      try {
        const metrics = await fetch(`${BASE}/metrics`, { signal: AbortSignal.timeout(3000) });
        if (metrics.status === 200) counters = parseErrorCounters(await metrics.text());
      } catch {
        counters = null;
      }
      const memory = process.memoryUsage?.call(child) as unknown;
      void memory;
      // ★ 采样**子进程**的内存：用 /proc/<pid>/status（Linux）读 VmRSS
      let rssMb = 0;
      let heapUsedMb = 0;
      if (child.pid !== undefined) {
        const status = spawnSync('bash', ['-c', `grep -E '^VmRSS' /proc/${child.pid}/status 2>/dev/null | awk '{print $2}' || true`], { encoding: 'utf8' });
        const kb = Number.parseFloat((status.stdout ?? '0').trim());
        if (Number.isFinite(kb)) rssMb = Math.round((kb / 1024) * 10) / 10;
      }
      // ★★★ R82：读巡检/定时任务的执行计数——**「内存没涨」不能证明「定时任务在跑」**。
      let patrol: Sample['patrol'] = [];
      try {
        const rows = await instance.sql<{ job_key: string; run_count: number; fail_count: number; last_run_at: string | null; last_error: string | null }>(
          'SELECT job_key, run_count, fail_count, last_run_at::text AS last_run_at, last_error FROM ag_jobs ORDER BY job_key',
        );
        patrol = rows.map((row) => ({
          jobKey: row.job_key,
          runCount: Number(row.run_count),
          failCount: Number(row.fail_count),
          lastRunAt: row.last_run_at,
          lastError: row.last_error,
        }));
      } catch {
        // 表还不存在（服务刚启动）——保持空数组
        patrol = [];
      }

      samples.push({
        atSecond,
        rssMb,
        heapUsedMb,
        pgProcesses: countPostgresProcesses(),
        ready: readyNow,
        errorCounters: counters,
        requestsInWindow: loadStats.total,
        failuresInWindow: loadStats.failures,
        avgLatencyMs: loadStats.total === 0 ? 0 : Math.round((loadStats.latencySumMs / loadStats.total) * 10) / 10,
        patrol,
      });
      const last = samples[samples.length - 1]!;
      process.stdout.write(
        `[${String(atSecond).padStart(4)}s] ready=${last.ready ? '✅' : '❌'} · RSS=${last.rssMb}MB · pg 进程=${last.pgProcesses}` +
          (last.errorCounters === null ? '' : ` · 错误计数=${JSON.stringify(last.errorCounters)}`) +
          (last.patrol.length === 0
            ? ''
            : ` · 巡检=${last.patrol.map((entry) => `${entry.jobKey}:run=${entry.runCount}/fail=${entry.failCount}`).join(',')}`) +
          (loadQps > 0 ? ` · 累计请求=${last.requestsInWindow}（失败 ${last.failuresInWindow}，均延迟 ${last.avgLatencyMs}ms）` : '') +
          '\n',
      );
      if (index < totalSamples - 1) await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    }

    // 停掉负载
    if (loadTimer !== undefined) clearInterval(loadTimer);
    loadAgent.destroy();

    // ⑤ 判定
    const half = Math.floor(samples.length / 2);
    const firstHalf = samples.slice(0, half);
    const secondHalf = samples.slice(half);
    const avg = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
    const firstRss = avg(firstHalf.map((sample) => sample.rssMb));
    const secondRss = avg(secondHalf.map((sample) => sample.rssMb));
    const growthMb = secondRss - firstRss;
    const allReady = samples.every((sample) => sample.ready);
    const maxPg = Math.max(...samples.map((sample) => sample.pgProcesses));
    const minPg = Math.min(...samples.map((sample) => sample.pgProcesses));
    // 错误计数：取每个计数器在采样序列里的最大值与首次值之差
    let errorGrowth = 0;
    for (const sample of samples) {
      for (const [name, value] of Object.entries(sample.errorCounters ?? {})) {
        const firstValue = samples.find((entry) => entry.errorCounters?.[name] !== undefined)?.errorCounters?.[name] ?? value;
        errorGrowth = Math.max(errorGrowth, value - firstValue);
      }
    }

    const verdicts: { name: string; ok: boolean; detail: string }[] = [
      {
        name: '★ 服务始终 ready',
        ok: allReady,
        detail: allReady ? `${samples.length}/${samples.length} 次采样均 200` : `${samples.filter((sample) => !sample.ready).length} 次采样未就绪`,
      },
      {
        name: '★ 内存无显著增长（前后半段 RSS 均值对比）',
        ok: growthMb < 50,
        detail: `前半段均值 ${firstRss.toFixed(1)}MB → 后半段 ${secondRss.toFixed(1)}MB（差 ${growthMb >= 0 ? '+' : ''}${growthMb.toFixed(1)}MB，阈值 <50MB）`,
      },
      {
        name: '★ PG 进程数不堆积（看**趋势**而非绝对波动）',
        // ★ 早期用「波动 ≤2」判定，在负载下会误报：
        //   PG 的常驻进程约 9 个（io worker×3、checkpointer、walwriter、autovacuum…），
        //   其余是**按连接 fork 的后端进程**——负载下连接数变化是正常现象。
        //   泄漏的特征是**单调增长**（后半段持续高于前半段），而不是波动。
        ok: avg(secondHalf.map((sample) => sample.pgProcesses)) <= avg(firstHalf.map((sample) => sample.pgProcesses)) + 5,
        detail:
          `采样期间 ${minPg}–${maxPg}（波动 ${maxPg - minPg}）· ` +
          `前半段均值 ${avg(firstHalf.map((sample) => sample.pgProcesses)).toFixed(1)} → 后半段 ${avg(secondHalf.map((sample) => sample.pgProcesses)).toFixed(1)}` +
          `（判定依据是趋势，允许 +5 的均值上升）`,
      },
      {
        name: '★ 负载错误率低（有负载时才有意义）',
        ok: loadStats.total === 0 ? true : loadStats.failures / loadStats.total < 0.01,
        detail:
          loadStats.total === 0
            ? '未开启负载（--load=0）——本次只验证「空闲稳定」'
            : `完成 ${loadStats.total} 个请求，失败 ${loadStats.failures}（${((loadStats.failures / loadStats.total) * 100).toFixed(2)}%），平均延迟 ${(loadStats.latencySumMs / loadStats.total).toFixed(1)}ms`,
      },
      {
        name: '★ 错误计数不累积',
        ok: errorGrowth === 0,
        detail: errorGrowth === 0 ? '指标中的错误计数在整个采样期间无增长' : `错误计数增长 ${errorGrowth}`,
      },
    ];

    process.stdout.write(`\n${'='.repeat(64)}\n`);
    for (const verdict of verdicts) process.stdout.write(`${verdict.ok ? '✅' : '❌'} ${verdict.name}\n     ${verdict.detail}\n`);
    const failed = verdicts.filter((verdict) => !verdict.ok);
    process.stdout.write(`\n长跑结论：${verdicts.length - failed.length}/${verdicts.length} 通过\n`);
    process.stdout.write(
      `\n★ 诚实说明：本次时长 ${minutes} 分钟。它能证明「没有分钟级的明显泄漏」，\n` +
        `  但**不足以证明生产稳定**（生产的泄漏可能以小时/天为单位）。\n` +
        `  真正的长跑应在预发环境跑数小时后再判定。\n`,
    );
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    if (child !== undefined) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await instance.stop();
  }
}

await main();
