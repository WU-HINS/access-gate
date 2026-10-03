#!/usr/bin/env node
/**
 * **二进制冒烟**：起真实 PG → 迁移 → 起**二进制**服务 → 探活 → 打印启动日志 → 清理。
 *
 * ★ 与 `tools/serve-real-e2e.ts` 的分工：
 *   · 那个是「走 19 步业务主线」的**验收**（登录 → 选择 → 控制台 → 资格）；
 *   · 这个是「**二进制能不能跑起来**」的最小验证——不依赖 Docker，
 *     直接在真实 PG 上把 `npm start` 等价的那条命令跑起来，看它是否真的在监听、
 *     健康检查是否区分 liveness/readiness、鉴权链是否生效。
 *
 * ★ 它刻意**不做**的事：不假装能验证登录（那需要真实 OIDC 提供方）。
 *   未登录访问 `/api/me` 得到 **401** 正是"鉴权链在工作"的证据。
 */

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

import { startRealPostgres } from './pg-real.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const PORT = Number(process.env['SMOKE_PORT'] ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;

const pg = await startRealPostgres();
process.stdout.write(`① 真实 PG 就绪：${pg.url}\n`);

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  AG_MODE: 'real',
  AG_DATABASE_URL: pg.url,
  // ★ 32 字节 hex（64 字符）：真实模式**必需**——缺了会启动失败，这是有意的 fail-closed
  AG_MASTER_KEY: 'a'.repeat(64),
  AG_PUBLIC_URL: BASE,
  // ★ 启动期校验要求它们存在（**fail-closed**：缺了**拒绝启动**，
  //   而不是"跑起来但登录不可用"——那才是更难发现的形态）。
  //   OIDC 的发现（discovery）是**懒加载**的（`beginLogin` 才发请求），所以假值不影响启动。
  AG_OIDC_ISSUER: 'https://oidc.invalid',
  AG_OIDC_CLIENT_ID: 'smoke-client',
  AG_OIDC_CLIENT_SECRET: 'smoke-secret',
  AG_OIDC_REDIRECT_URI: `${BASE}/api/auth/callback`,
  // ★ 生产必须 Secure Cookie。这里用 http 探活，它只影响**下发的 Cookie**，
  //   不影响健康检查与鉴权链（未登录仍应是 401）。
  AG_SECURE_COOKIES: '1',
};

process.stdout.write('② 跑迁移…\n');
const migrate = spawnSync(
  NODE,
  [
    '--experimental-strip-types',
    path.join(ROOT, 'tools', 'db-migrate.ts'),
    `--database-url=${pg.url}`,
  ],
  { cwd: ROOT, env, encoding: 'utf8' },
);
if (migrate.status !== 0) {
  process.stderr.write(`迁移失败：${(migrate.stderr ?? '').slice(-800)}\n`);
  await pg.stop();
  process.exit(1);
}
process.stdout.write('   迁移完成\n');

process.stdout.write('③ 启动二进制服务（等价于 `npm start`）…\n');
const child = spawn(
  NODE,
  ['--experimental-strip-types', path.join(ROOT, 'tools', 'serve.ts'), '--mode=real', `--port=${PORT}`],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
child.stdout.on('data', (chunk) => {
  log += String(chunk);
});
child.stderr.on('data', (chunk) => {
  log += String(chunk);
});

let ready = false;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  try {
    const res = await fetch(`${BASE}/healthz`);
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    // 还没起来
  }
}

process.stdout.write(`④ 健康检查：${ready ? '✅ /healthz 200' : '❌ 60s 内未就绪'}\n`);
if (ready) {
  for (const route of ['/healthz', '/healthz/live', '/healthz/ready']) {
    try {
      const res = await fetch(`${BASE}${route}`);
      const body = await res.text();
      process.stdout.write(`   ${route} → ${res.status} ${body.slice(0, 140)}\n`);
    } catch (error) {
      process.stdout.write(`   ${route} → ❌ ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  try {
    const res = await fetch(`${BASE}/metrics`);
    const body = await res.text();
    process.stdout.write(`   /metrics → ${res.status}（${body.split('\n').length} 行）\n`);
  } catch (error) {
    process.stdout.write(`   /metrics → ❌ ${error instanceof Error ? error.message : String(error)}\n`);
  }
  // ★ 未登录访问受保护端点：**401 才是对的**（证明鉴权链在工作，而不是"没挂载"）
  try {
    const res = await fetch(`${BASE}/api/me`);
    process.stdout.write(
      `   /api/me（未登录）→ ${res.status}${res.status === 401 ? ' ✅ 鉴权生效' : ' ⚠️ 期望 401'}\n`,
    );
  } catch (error) {
    process.stdout.write(`   /api/me → ❌ ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

process.stdout.write('\n⑤ 服务启动日志（尾部 16 行）：\n');
process.stdout.write(`${log.split('\n').slice(-16).join('\n')}\n`);

child.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 1_500));
await pg.stop();
process.stdout.write('\n清理完成\n');
process.exit(ready ? 0 : 1);
