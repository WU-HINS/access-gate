/**
 * 定时任务**真的执行了**吗？（生产落地第 5 项的「巡检与定时任务」部分）
 *
 * ★ 为什么需要单独验证这一点：
 *   R2 轮的真实 PG 端到端只看到启动横幅里的「**巡检已启动**」——
 *   而「已注册」与「已执行」是两件不同的事。
 *   本会话早期**真的修过一个**「调度器 `register()` 从不写存储 → `dueJobs` 始终为空
 *   → **调度器从不执行任何任务**」的缺陷。所以「已启动」不足以证明它在跑。
 *
 * ★ 验证方法：把巡检间隔缩到 15s（通过 `AG_PATROL_INTERVAL_MS`），
 *   观察 `ag_jobs.last_run_at` 是否**随时间推进**——这是「真的执行过」的直接证据。
 *
 * 用法：
 *   node --experimental-strip-types tools/patrol-liveness.ts
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRealPostgres } from './pg-real.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8896;
const BASE = `http://127.0.0.1:${PORT}`;
const INTERVAL_MS = 15_000;
/** 观察窗口要覆盖至少 2 个巡检周期。 */
const OBSERVE_MS = 50_000;

interface JobSnapshot {
  atSecond: number;
  jobs: { jobKey: string; lastRunAt: string | null; runCount: number; failCount: number; status: string }[];
}

async function main(): Promise<void> {
  process.stdout.write(`\n【定时任务存活验证】巡检间隔 ${INTERVAL_MS}ms · 观察 ${OBSERVE_MS / 1000}s\n\n`);

  const instance = await startRealPostgres({ fresh: true });
  let child: ChildProcess | undefined;
  try {
    const migrate = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.join(ROOT, 'tools', 'db-migrate.ts'), `--database-url=${instance.url}`],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (migrate.status !== 0) throw new Error(`迁移失败：${(migrate.stderr ?? '').slice(-400)}`);

    child = spawn(
      process.execPath,
      ['--experimental-strip-types', path.join(ROOT, 'tools', 'serve.ts'), '--mode=real', `--port=${PORT}`, '--log-level=info'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          AG_MODE: 'real',
          AG_DATABASE_URL: instance.url,
          // ★ 真实模式必需：调用方密钥要加密存入 `ag_secrets`（R31 起强制要求）
          AG_MASTER_KEY: '00'.repeat(32),
          AG_PUBLIC_URL: BASE,
          AG_OIDC_ISSUER: 'https://idp.invalid',
          AG_OIDC_CLIENT_ID: 'liveness',
          AG_OIDC_REDIRECT_URI: `${BASE}/api/auth/callback`,
          AG_SECURE_COOKIES: '1',
          AG_ALLOW_DEMO: '1',
          AG_PATROL_INTERVAL_MS: String(INTERVAL_MS),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // 等待 ready
    const deadline = Date.now() + 40_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        ready = (await fetch(`${BASE}/healthz/ready`, { signal: AbortSignal.timeout(2000) })).status === 200;
      } catch {
        /* 未就绪 */
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`40s 内未就绪。stderr：${stderr.slice(-400)}`);
    process.stdout.write('服务已就绪，开始观察 ag_jobs.last_run_at\n\n');

    // 周期读 ag_jobs
    const snapshots: JobSnapshot[] = [];
    const startedAt = Date.now();
    while (Date.now() - startedAt < OBSERVE_MS) {
      // ★ 列名以迁移产物为准（`run_count` / `fail_count`，不是想象出来的 `consecutive_failures`）
      const rows = await instance.sql<{ job_key: string; last_run_at: string | null; run_count: string; fail_count: number; status: string; last_error: string | null }>(
        'SELECT job_key, last_run_at, run_count, fail_count, status, last_error FROM ag_jobs ORDER BY job_key',
      );
      const atSecond = Math.round((Date.now() - startedAt) / 1000);
      snapshots.push({
        atSecond,
        jobs: rows.map((row) => ({
          jobKey: row.job_key,
          lastRunAt: row.last_run_at === null ? null : String(row.last_run_at),
          runCount: Number.parseInt(String(row.run_count), 10) || 0,
          failCount: row.fail_count,
          status: row.status,
        })),
      });
      const first = snapshots[0]!;
      const now = snapshots[snapshots.length - 1]!;
      const advanced =
        first.jobs.length > 0 &&
        now.jobs.length > 0 &&
        first.jobs[0]!.lastRunAt !== null &&
        now.jobs[0]!.lastRunAt !== first.jobs[0]!.lastRunAt;
      process.stdout.write(
        `[${String(atSecond).padStart(3)}s] 作业数=${now.jobs.length} · run_count=${now.jobs[0]?.runCount ?? '?'}` +
          ` · status=${now.jobs[0]?.status ?? '?'} · last_run_at=${now.jobs[0]?.lastRunAt ?? '（空）'}` +
          ` · 相比首次${advanced ? ' ✅ 已推进' : '（尚未推进）'}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // ── 判定 ──
    const first = snapshots[0]!;
    const last = snapshots[snapshots.length - 1]!;
    const distinctRunTimes = new Set(snapshots.map((snapshot) => snapshot.jobs[0]?.lastRunAt ?? 'null'));
    const firstRunCount = first.jobs[0]?.runCount ?? 0;
    const lastRunCount = last.jobs[0]?.runCount ?? 0;
    const jobCount = last.jobs.length;
    const failures = last.jobs.reduce((sum, job) => sum + (job.failCount ?? 0), 0);
    // 巡检日志（「巡检」相关）
    const patrolLogLines = stdout.split('\n').filter((line) => /巡检|patrol/i.test(line)).length;

    const verdicts = [
      {
        name: '★ 作业已注册到 DB（不是只在内存里）',
        ok: jobCount > 0,
        detail: `ag_jobs 行数 = ${jobCount}${jobCount > 0 ? `（job_key=${last.jobs[0]!.jobKey}）` : '——「已启动」但 DB 里没有作业，说明注册没落库'}`,
      },
      {
        name: '★★ `run_count` **递增**（最强证据：作业真的被执行过）',
        ok: lastRunCount > firstRunCount,
        detail:
          `run_count ${firstRunCount} → ${lastRunCount}（观察 ${OBSERVE_MS / 1000}s，间隔 ${INTERVAL_MS / 1000}s）` +
          (lastRunCount > firstRunCount
            ? `——执行了约 ${lastRunCount - firstRunCount} 次`
            : '——若恒为 0 或不变，说明作业注册了但**从未被调度执行**（本会话早期真实修过这个缺陷）'),
      },
      {
        name: '★ `last_run_at` 随时间推进',
        ok: distinctRunTimes.size >= 2,
        detail: `观察期间出现 ${distinctRunTimes.size} 个不同的 last_run_at（首次 ${first.jobs[0]?.lastRunAt ?? '空'} → 末次 ${last.jobs[0]?.lastRunAt ?? '空'}）`,
      },
      {
        name: '★ 无连续失败累积',
        ok: failures === 0,
        detail: `所有作业的 fail_count 之和 = ${failures}`,
      },
      {
        name: '★ 巡检日志有输出',
        ok: patrolLogLines > 0,
        detail: `stdout 中与巡检相关的日志行 = ${patrolLogLines}`,
      },
    ];

    // ★ 打印作业的最后错误（诊断「执行即失败」）
    const errorRows = await instance.sql<{ job_key: string; last_error: string | null }>('SELECT job_key, last_error FROM ag_jobs');
    for (const row of errorRows) {
      if (row.last_error !== null) process.stdout.write(`\n作业 '${row.job_key}' 的最后错误：\n  ${row.last_error.slice(0, 600)}\n`);
    }
    // 打印 stdout 里的错误日志
    const errorLines = stdout.split('\n').filter((line) => line.includes('"level":"error"')).slice(-2);
    for (const line of errorLines) process.stdout.write(`\n服务端 error 日志：\n  ${line.slice(0, 600)}\n`);

    process.stdout.write(`\n${'='.repeat(64)}\n`);
    for (const verdict of verdicts) process.stdout.write(`${verdict.ok ? '✅' : '❌'} ${verdict.name}\n     ${verdict.detail}\n`);
    const failed = verdicts.filter((verdict) => !verdict.ok);
    process.stdout.write(`\n结论：${verdicts.length - failed.length}/${verdicts.length} 通过\n`);
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
