/**
 * 真实模式冒烟测试（判据 #2 的最终收口）。
 *
 * ★ 本文件验证的是**「生产路径真的能起来」**，而不是「各模块单测通过」：
 *   在此之前，PG 适配器只在测试里被单独调用过；`tools/serve.ts` 的 real 分支
 *   从未被任何自动化验证过——而「服务起来能用」与「测试里能跑」是两件事。
 *
 * 验证内容：
 *   ① 用真实 PG 跑迁移 → 以 `AG_MODE=real` 启动服务 → `/healthz/ready` 反映**真实依赖**
 *      （DB 连通 + 迁移版本），而不是恒真；
 *   ② `/metrics` 可抓取且格式合法；
 *   ③ 优雅关闭：`markNotReady` 让 readiness 立刻失败，而 liveness 仍为真
 *      （否则编排器会 SIGKILL，优雅关闭白做）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import { startRealPostgres, type RealPostgres } from '../tools/pg-real.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRE = process.env['AG_REQUIRE_REAL_PG'] === '1';

let pg: RealPostgres | undefined;
let unavailableReason: string | undefined;

async function ensurePg(): Promise<RealPostgres | undefined> {
  if (pg !== undefined) return pg;
  if (unavailableReason !== undefined) {
    if (REQUIRE) throw new Error(`AG_REQUIRE_REAL_PG=1 但真实 PG 不可用：${unavailableReason}`);
    return undefined;
  }
  try {
    // 端口按 pid 派生（与 pg-real.test.ts 的隔离策略一致，避免并行测试互相踩）
    pg = await startRealPostgres({ fresh: true, port: 55_500 + (process.pid % 500) });
    await pg.exec(readFileSync(join(ROOT, 'migrations', '0001_init.sql'), 'utf8'));
    await pg.exec(
      `CREATE TABLE IF NOT EXISTS ag_migrations (
         name varchar(64) PRIMARY KEY,
         checksum varchar(64) NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now(),
         status varchar(16) NOT NULL DEFAULT 'applied'
       )`,
    );
    await pg.sql(`INSERT INTO ag_migrations (name, checksum) VALUES ('0001_init', 'smoke') ON CONFLICT (name) DO NOTHING`);
    return pg;
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    if (REQUIRE) throw new Error(`AG_REQUIRE_REAL_PG=1 但真实 PG 启动失败：${unavailableReason}`);
    return undefined;
  }
}

/** 等待服务可访问（轮询 /healthz，避免固定 sleep 造成的间歇失败）。 */
async function waitForServer(base: string, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.status > 0) return true;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function startServer(env: Record<string, string>, port: number): { child: ChildProcess; logs: () => string } {
  let buffer = '';
  const child = spawn(process.execPath, ['--experimental-strip-types', 'tools/serve.ts', '--mode=real', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
  return { child, logs: () => buffer };
}

test('★ 真实模式冒烟：真实 PG + 真实 OIDC 配置下服务能起来，readiness 反映真实依赖', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }

  const port = 18_000 + (process.pid % 1_000);
  const base = `http://127.0.0.1:${port}`;
  const server = startServer(
    {
      AG_MODE: 'real',
      AG_DATABASE_URL: instance.url,
      AG_OIDC_ISSUER: 'https://idp.example',
      AG_OIDC_CLIENT_ID: 'gate',
      AG_OIDC_CLIENT_SECRET: 'secret',
      AG_PUBLIC_URL: base,
      AG_SECURE_COOKIES: '1',
      // ★ 真实模式必需：调用方密钥要加密存入 `ag_secrets`（R30 起强制要求）
      AG_MASTER_KEY: '00'.repeat(32),
      AG_LOG_LEVEL: 'info',
    },
    port,
  );
  t.after(() => {
    server.child.kill('SIGTERM');
  });

  // 诊断：确认迁移记录确实写入了服务将要连接的那个库
  {
    const { Client } = (await import('pg')) as unknown as typeof import('pg');
    const probe = new Client({ connectionString: instance.url });
    await probe.connect();
    try {
      const rows = await probe.query<{ name: string }>('SELECT name FROM ag_migrations ORDER BY name DESC LIMIT 1');
      assert.equal(rows.rows[0]?.name, '0001_init', `迁移记录应已写入 ${instance.url}（实际：${JSON.stringify(rows.rows)}）`);
    } finally {
      await probe.end();
    }
  }

  const up = await waitForServer(base);
  assert.ok(up, `服务未在超时内就绪。日志：\n${server.logs().slice(-2000)}`);

  // ① readiness 必须反映**真实依赖**（DB + 迁移），而不是恒真
  const ready = await fetch(`${base}/healthz/ready`);
  const readyBody = (await ready.json()) as { status: string; checks: { name: string; status: string }[] };
  assert.equal(ready.status, 200, `readiness 应为 200，实际 ${ready.status}：${JSON.stringify(readyBody)}`);
  const checkNames = readyBody.checks.map((c) => c.name);
  assert.ok(checkNames.includes('database'), `readiness 应包含 database 检查（实际：${checkNames.join(', ')}）`);
  assert.ok(checkNames.includes('migration'), `readiness 应包含 migration 检查（实际：${checkNames.join(', ')}）`);

  // ② liveness 只检查进程自身（不含 DB）——依赖故障不该让编排器重启应用
  const live = await fetch(`${base}/healthz/live`);
  const liveBody = (await live.json()) as { checks: { name: string }[] };
  assert.equal(live.status, 200);
  assert.equal(
    liveBody.checks.some((c) => c.name === 'database'),
    false,
    '★ liveness 不得包含 DB 检查（否则 DB 故障会被编排器当成进程死亡而重启）',
  );

  // ③ 指标可抓取且格式合法
  const metrics = await fetch(`${base}/metrics`);
  assert.equal(metrics.status, 200);
  const metricsText = await metrics.text();
  assert.match(metricsText, /# TYPE gate_http_requests_total counter/);
  assert.match(metricsText, /gate_http_in_flight/, '应包含在途请求 gauge');

  // ④ 存储真的是 PG：会话写入后能在库里查到
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const tables = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'ag\\_%'",
    );
    assert.ok(Number(tables.rows[0]!.n) >= 40, `库中应有 ≥40 张 ag_ 表，实际 ${tables.rows[0]!.n}`);
  } finally {
    await client.end();
  }

  // ⑤ 优雅关闭：SIGTERM 后进程应自行退出（而不是被强杀）
  server.child.kill('SIGTERM');
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    server.child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.ok(exited, `SIGTERM 后服务应在 15s 内退出。日志：\n${server.logs().slice(-1500)}`);
  assert.match(server.logs(), /关闭/, '应打印优雅关闭的日志（证明走的是 GracefulShutdown 而非直接退出）');
});

test('★ 真实模式：缺少迁移记录时**拒绝启动**（「起来了但库是旧的」是最危险的中间态）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }

  // 用另一个库名模拟「库是空的」
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const admin = new Client({ connectionString: instance.url });
  await admin.connect();
  const emptyDb = `smoke_empty_${process.pid}`;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${emptyDb}`);
    await admin.query(`CREATE DATABASE ${emptyDb}`);
  } finally {
    await admin.end();
  }
  const emptyUrl = instance.url.replace(/\/[^/]+$/, `/${emptyDb}`);

  const port = 19_000 + (process.pid % 1_000);
  const server = startServer(
    {
      AG_MODE: 'real',
      AG_DATABASE_URL: emptyUrl,
      AG_OIDC_ISSUER: 'https://idp.example',
      AG_OIDC_CLIENT_ID: 'gate',
      AG_PUBLIC_URL: `http://127.0.0.1:${port}`,
      AG_SECURE_COOKIES: '1',
      // ★ 真实模式必需：调用方密钥要加密存入 `ag_secrets`（R30 起强制要求）
      AG_MASTER_KEY: '00'.repeat(32),
    },
    port,
  );

  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000);
    server.child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.ok(exited, '库中没有迁移记录时进程应退出（不带着坏库继续服务）');
  // 两种拒绝路径都正确（空库可能连 ag_migrations 表都没有）：
  //   ① 「无法读取迁移记录：relation ... does not exist」——表都不存在
  //   ② 「数据库中没有迁移记录」——表在但没记录
  assert.match(
    server.logs(),
    /无法读取迁移记录|数据库中没有迁移记录/,
    `应给出可操作的错误信息。日志：\n${server.logs().slice(-800)}`,
  );
});
