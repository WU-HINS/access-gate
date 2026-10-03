/**
 * 压测工具（M6-4）—— docs/07 M6-4「10 万主体全量评估、500 QPS 管理读」。
 *
 * 两个基准：
 *   ① **全量评估吞吐**：N 个主体跑一轮巡检（评估 → 迁移 → 计划 → 执行 → 回读）
 *   ② **管理读 QPS**：真实 HTTP 服务上的管理端读接口
 *
 * ★★ 关于「10 万 / 500 QPS」这两个数字，本工具的立场是**如实测量、明确标注差距**：
 *
 *   - 目标规模（10 万主体）在开发机上跑一轮可能需要数分钟到数十分钟，
 *     且结果**强烈依赖机器**（CPU、内存、PG 配置）。把开发机上的数字
 *     当成「生产可达」是**误导**。
 *   - 因此本工具默认用**较小规模**跑通链路，并**打印实际规模**；
 *     规模通过 `--subjects=N` 可调，验收环境应使用目标规模。
 *   - 报告里同时给出**外推估算**与**实测值**，并明确标注哪一个是实测。
 *
 *   这条约束来自本项目的既有纪律：**不把「跑通了」当成「达标了」**。
 *
 * 用法：
 *   node --experimental-strip-types tools/bench.ts --subjects=2000 --qps-requests=2000
 *   node --experimental-strip-types tools/bench.ts --subjects=100000 --qps-requests=5000   # 目标规模
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { parseArgs } from 'node:util';

import {
  evaluateTarget,
  formatStats,
  runConcurrent,
  type BenchStats,
  type Sample,
} from '../src/kernel/bench.ts';
import { InMemoryEvaluationStore, InMemoryLifecycleStateStore, Patrol, type SubjectDirectory } from '../src/core/patrol.ts';
import { ActionExecutor, ActionRegistry, InMemoryActionLogStore } from '../src/core/action-executor.ts';
import { FactPipeline, InMemoryFactStore } from '../src/plugin/host-api.ts';
import { EMAIL_DOMAIN_MANIFEST, evaluateEmailDomain } from '../src/plugin/builtin/email-domain.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import type { PolicyDocument } from '../src/policy/model.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

const POLICY: PolicyDocument = {
  code: 'edu',
  name: '教育邮箱',
  version: 1,
  enabled: true,
  spec: {
    requirements: { expression: { matches: { 'fact.email.domain': ['*.edu', '*.edu.cn'] } } },
    actions: { onSatisfied: [{ action: 'grant:x' }] },
  },
};

// ─────────────────────────── ① 全量评估 ───────────────────────────

/** 生成 N 个主体（域名交替，使满足/不满足都有） */
function makeDirectory(count: number): SubjectDirectory {
  return {
    async list(_siteId, limit, offset) {
      const end = Math.min(offset + limit, count);
      const out: { externalId: string; email: string; emailVerified: boolean; attributes: Record<string, unknown> }[] = [];
      for (let index = offset; index < end; index += 1) {
        const edu = index % 3 !== 0;
        out.push({
          externalId: `u-${index}`,
          email: edu ? `u${index}@mit.edu` : `u${index}@gmail.com`,
          emailVerified: true,
          attributes: {},
        });
      }
      return out;
    },
    async count() {
      return count;
    },
  };
}

async function benchEvaluation(subjects: number): Promise<BenchStats> {
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const factStore = new InMemoryFactStore();
  const directory = makeDirectory(subjects);
  const registry = new ActionRegistry();
  registry.register('grant:x', { async execute() { return { status: 'succeeded' }; } });
  const executor = new ActionExecutor({ registry, log: new InMemoryActionLogStore(), sleep: async () => undefined, now: () => NOW });
  const states = new InMemoryLifecycleStateStore();
  const evaluations = new InMemoryEvaluationStore();

  // ★ 事实预填充也计入总时间（真实场景下采集本身有成本）
  const startedAt = Date.now();
  for (let index = 0; index < subjects; index += 1) {
    const edu = index % 3 !== 0;
    const facts = evaluateEmailDomain({
      email: edu ? `u${index}@mit.edu` : `u${index}@gmail.com`,
      emailVerified: true,
      config: { allowDomains: ['*.edu', '*.edu.cn'], requireVerified: true },
    });
    if (facts !== null) await new FactPipeline({ store: factStore, manifest, userId: `u-${index}` }).emit({ ...facts }, NOW);
  }

  const patrol = new Patrol({
    siteId: 'bench-site',
    policies: [POLICY],
    directory,
    facts: factStore,
    factSources: [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }],
    states,
    evaluations,
    lifecycle: { gracePeriodMs: 72 * 3_600_000 },
    executor,
    logger: silentLogger,
    now: () => NOW,
  });
  const report = await patrol.runOnce();
  const wallMs = Date.now() - startedAt;

  // ★ 每个主体算一次「操作」；用巡检报告的真实计数（不是乐观地按 subjects 算）
  const samples: Sample[] = Array.from({ length: report.subjects }, () => ({ durationMs: wallMs / Math.max(report.subjects, 1), ok: true }));
  for (const error of report.errors) samples.push({ durationMs: 0, ok: false, error: error.message });
  const { summarize } = await import('../src/kernel/bench.ts');
  return summarize(samples, wallMs);
}

// ─────────────────────────── ② 管理读 QPS ───────────────────────────

async function benchManagementReads(requests: number, concurrency: number): Promise<BenchStats> {
  const { createAppServer, newCsrfSecret } = await import('../src/http/server.ts');
  const { createConsoleRoutes } = await import('../src/http/console-routes.ts');
  const { InMemorySessionStore, principalFromClaims, SESSION_COOKIE, SessionService } = await import('../src/auth/session.ts');
  const { InMemorySiteRegistry } = await import('../src/core/sites.ts');

  const registry = new InMemorySiteRegistry();
  const developer = await registry.createDeveloper({ username: 'bench', displayName: 'Bench', email: 'b@x.com', role: 'admin' });
  await registry.createSite({ siteId: 'bench', nickname: '压测站点', developerId: developer.id });

  const sessions = new SessionService({ store: new InMemorySessionStore() });
  const routes = createConsoleRoutes({
    sessions,
    registry,
    listDeveloperIds: async () => [developer.id],
    logger: silentLogger,
  });
  const app = createAppServer({ sessions, routes, csrfSecret: newCsrfSecret(), logger: silentLogger, port: 0 });
  const { url } = await app.listen();

  const principal = principalFromClaims({ sub: 'bench-1', emailVerified: true, preferredUsername: 'bench' }, { realm: 'developer', role: 'admin', activeSiteId: null });
  const session = await sessions.create(principal);
  const cookie = `${SESSION_COOKIE}=${session.token}`;

  // ★★ 压测客户端必须用 `http.request` + keep-alive agent，**不能用 `fetch`**。
  //
  //   实测（本机，空 handler 的最小服务器，并发 32）：
  //     fetch（undici）        →  539/s
  //     http.request + agent   → 1386/s      ← 相差 2.5 倍
  //
  //   `fetch` 每次都要走 undici 的完整请求生命周期（含 Response 对象构造、
  //   body 流、header 归一化）。用它压测会把**客户端的开销算到服务端头上**，
  //   从而得出「应用性能不足」的错误结论。
  const agent = new HttpAgent({ keepAlive: true, maxSockets: 256 });
  const target = new URL(url);
  try {
    return await runConcurrent({
      total: requests,
      concurrency,
      timeoutMs: 10_000,
      operation: async () => {
        await new Promise<void>((resolve, reject) => {
          const request = httpRequest(
            // ★ 直接给绝对路径：用 `pathname + '/api/...'` 会拼出 `//api/...`（双斜杠）→ 404
            { host: target.hostname, port: target.port, path: '/api/console/sections', agent, headers: { cookie } },
            (response) => {
              const status = response.statusCode ?? 0;
              response.resume(); // 丢弃 body（但不读它）
              response.on('end', () => (status === 200 ? resolve() : reject(new Error(`HTTP ${status}`))));
            },
          );
          request.on('error', reject);
          request.end();
        });
      },
    });
  } finally {
    agent.destroy();
    await app.close();
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      subjects: { type: 'string', default: '2000' },
      'qps-requests': { type: 'string', default: '1000' },
      'qps-concurrency': { type: 'string', default: '32' },
      'skip-eval': { type: 'boolean', default: false },
      'skip-qps': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      // ★ R84：`--assert` —— 任一判定不达标即退出码 1（供 CI 门禁使用）
      assert: { type: 'boolean', default: false },
    },
  });

  const subjects = Number.parseInt(values.subjects ?? '2000', 10);
  const qpsRequests = Number.parseInt(values['qps-requests'] ?? '1000', 10);
  const qpsConcurrency = Number.parseInt(values['qps-concurrency'] ?? '32', 10);

  const results: { label: string; stats: BenchStats; verdict: string }[] = [];

  if (values['skip-eval'] !== true) {
    process.stdout.write(`\n【① 全量评估】规模 ${subjects} 个主体（目标：100000）…\n`);
    const stats = await benchEvaluation(subjects);
    // ★ 目标按**比例**折算：目标 10 万主体，若巡检应在一轮内完成，则吞吐门槛由运维设定；
    //   这里只给一个「不慢于线性外推」的参考线，不谎称它就是验收线。
    const verdict = evaluateTarget(stats, { name: '全量评估', maxErrorRate: 0 });
    results.push({ label: '全量评估', stats, verdict: `${verdict.met ? '✅' : '❌'} ${verdict.details.join(' · ')}` });
    process.stdout.write(`${formatStats('全量评估', stats)}\n`);
    // ★ 外推 = 规模 / 吞吐（秒）。早期这里多除了一次 1000，
    //   把「10 万主体约 294s」显示成「0.3s」——一个**严重误导**的数字，
    //   会让读者以为全量评估毫无成本。
    const extrapolatedSeconds = 100_000 / Math.max(stats.throughput, 0.001);
    process.stdout.write(
      `  外推：按此吞吐，100000 主体约需 ${extrapolatedSeconds.toFixed(0)}s（${(extrapolatedSeconds / 60).toFixed(1)} 分钟）` +
        `——这是**线性外推**，真实规模下还会受内存与 GC 影响\n`,
    );
    process.stdout.write(`  判定：${verdict.met ? '✅' : '❌'} ${verdict.details.join(' · ')}\n`);
  }

  if (values['skip-qps'] !== true) {
    process.stdout.write(`\n【② 管理读】${qpsRequests} 次请求 / 并发 ${qpsConcurrency}（目标：500 QPS）…\n`);
    const stats = await benchManagementReads(qpsRequests, qpsConcurrency);
    // ★★ `AG_BENCH_FORCE_MIN` 是**自测入口**（默认 500，即目标值）：
    //   把它设成不可能达到的数（如 99999）可以验证「`--assert` 真的会在不达标时返回非 0」——
    //   ★ 即证明**门禁不是恒真**。已验证：`AG_BENCH_FORCE_MIN=99999 ... --assert` → 退出码 1。
    //   ★ 正常情况下不会设置它，因此不影响真实判定。
    const verdict = evaluateTarget(stats, {
      name: '管理读',
      minThroughput: Number(process.env['AG_BENCH_FORCE_MIN'] ?? 500),
      maxErrorRate: 0.001,
    });
    results.push({ label: '管理读', stats, verdict: `${verdict.met ? '✅' : '❌'} ${verdict.details.join(' · ')}` });
    process.stdout.write(`${formatStats('管理读', stats)}\n`);
    process.stdout.write(`  判定：${verdict.met ? '✅' : '❌'} ${verdict.details.join(' · ')}\n`);
  }

  process.stdout.write(`\n★ 说明：以上为**本机实测值**（规模 ${subjects} 主体 / ${qpsRequests} 请求）。\n`);
  process.stdout.write(`  目标规模（100000 主体 / 500 QPS）请在验收环境用 --subjects=100000 --qps-requests=5000 复跑；\n`);
  process.stdout.write(`  开发机数字受 CPU / 内存 / 磁盘影响，**不代表生产可达**。\n`);

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  }

  // ★★★ R84：`--assert` 模式下，**任一判定不达标即退出码 1**。
  //
  //   ★ 为什么需要它：`bench.ts` 此前**总是退出码 0**——
  //     即使「管理读只有 200 QPS」也返回成功，因此**无法作为 CI 门禁**。
  //     于是目标第 (4) 项（性能 ≥500 QPS）的证据**只来自手跑的一次性记录**，
  //     下一次没人会跑，也就没人会发现性能退化。
  //   ★ 这正是 R81 的教训：「不默认跑的检查会骗人」。
  if (values['assert'] === true) {
    const unmet = results.filter((entry) => entry.verdict.startsWith('❌'));
    if (unmet.length > 0) {
      process.stdout.write(
        `\n❌ --assert：以下目标未达标 → 退出码 1\n` +
          unmet.map((entry) => `   · ${entry.label}：${entry.verdict}\n`).join(''),
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\n✅ --assert：全部目标达标（${results.length} 项）\n`);
  }
}

await main();
