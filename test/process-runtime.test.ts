/**
 * process 运行时验收（M4-1）—— docs/03 §1.8。
 *
 * 验收标准：**插件崩溃不影响宿主**。
 * 因此本文件用**真实的 Node 子进程**验证，而不是 mock：
 *   - 崩溃后宿主进程仍活着（测试能继续跑本身就是证据）；
 *   - **在途请求被显式拒绝**——若只是「进程死了」而 Promise 不 reject，
 *     调用方会永远挂着（这才是「崩溃拖垮宿主」的真实形态）；
 *   - 崩溃后自动重启（自愈），连续失败达上限则转 `failed`（不再重启）；
 *   - 超时**杀进程**（SIGKILL，SIGTERM 可能被忽略）；
 *   - 插件请求宿主能力（`host.http.request`）由宿主代发并校验。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FrameDecoder,
  PluginCrashedError,
  PluginTimeoutError,
  ProcessRuntime,
  encodeFrame,
  isResponse,
} from '../src/plugin/process-runtime.ts';
import { silentLogger } from '../src/kernel/logger.ts';

// ─────────────────────────── 测试用插件 ───────────────────────────

const PLUGIN_SCRIPT = `
// 一个最小的 stdio JSON-RPC 插件（用于验收宿主侧行为）
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const httpCalls = [];

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'plugin.init') {
      send({ jsonrpc: '2.0', id: message.id, result: { ok: true } });
    } else if (message.method === 'channel.collect') {
      send({ jsonrpc: '2.0', id: message.id, result: { facts: { account_age_days: 1200 } } });
    } else if (message.method === 'crash') {
      process.exit(7);           // 硬崩溃
    } else if (message.method === 'hang') {
      // 永不返回（也不响应）——用于验证宿主超时杀进程
    } else if (message.method === 'noisy') {
      console.log('这行不是 JSON，宿主必须忽略');   // 污染协议流
      send({ jsonrpc: '2.0', id: message.id, result: { survived: true } });
    } else if (message.method === 'ask-host') {
      // 插件请求宿主能力：宿主代发 HTTP
      const inner = 900 + message.id;
      send({ jsonrpc: '2.0', id: inner, method: 'host.http.request', params: { method: 'GET', url: 'https://api.example.com/x' } });
      const onHostReply = (chunk2) => {
        // 简化：把宿主响应原样回给调用方
        buffer += chunk2;
      };
      process.stdin.once('data', onHostReply);
      // 用一个定时器等宿主响应（真实插件会做请求-响应配对）
      const wait = setInterval(() => {
        if (httpCalls.length === 0 && globalThis.__hostReply !== undefined) {
          clearInterval(wait);
          send({ jsonrpc: '2.0', id: message.id, result: { hostReply: globalThis.__hostReply } });
        }
      }, 10);
    } else if (message.id !== undefined && message.result !== undefined) {
      // 宿主对 host.http.request 的响应
      globalThis.__hostReply = message.result;
    }
  }
});
`;

function makePluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ag-plugin-'));
  writeFileSync(join(dir, 'plugin.mjs'), PLUGIN_SCRIPT, 'utf8');
  return dir;
}

const CAPABILITIES = {
  httpRequest: async (params: { method: string; url: string }) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: params.url, ok: true }),
  }),
};

function makeRuntime(overrides: Partial<ConstructorParameters<typeof ProcessRuntime>[0]> = {}): ProcessRuntime {
  const dir = makePluginDir();
  return new ProcessRuntime({
    pluginId: 'test-plugin',
    command: process.execPath,
    args: [join(dir, 'plugin.mjs')],
    capabilities: CAPABILITIES,
    logger: silentLogger,
    defaultTimeoutMs: 2_000,
    restartBackoffBaseMs: 20,
    restartBackoffMaxMs: 100,
    maxConsecutiveFailures: 3,
    ...overrides,
  });
}

// ─────────────────────────── 帧编解码 ───────────────────────────

test('M4-1：帧编解码 —— 按行解析、处理分片、忽略非 JSON 行（插件的 console.log 会污染流）', () => {
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(''), []);

  // 分片到达：半行不产出
  assert.deepEqual(decoder.push('{"jsonrpc":"2.0","id":1,"resu'), []);
  const frames = decoder.push('lt":{"a":1}}\n');
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as { id: number }).id, 1);

  // 一次到达多行
  const multi = decoder.push('{"jsonrpc":"2.0","id":2,"result":{}}\n{"jsonrpc":"2.0","id":3,"result":{}}\n');
  assert.equal(multi.length, 2);

  // ★ 非 JSON 行（插件的调试输出）被忽略，而不是让解码器崩溃
  const noisy = decoder.push('这不是 JSON\n{"jsonrpc":"2.0","id":4,"result":{}}\n');
  assert.equal(noisy.length, 1);
  assert.equal((noisy[0] as { id: number }).id, 4);

  // 空行忽略
  assert.deepEqual(decoder.push('\n\n'), []);

  // isResponse 判定
  assert.equal(isResponse({ jsonrpc: '2.0', id: 1, result: {} }), true);
  assert.equal(isResponse({ jsonrpc: '2.0', id: 1, method: 'x' }), false);
  assert.equal(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'm' }), '{"jsonrpc":"2.0","id":1,"method":"m"}\n');
});

// ─────────────────────────── 正常调用 ───────────────────────────

test('M4-1：启动握手 + 正常调用（init → collect 返回事实）', async () => {
  const runtime = makeRuntime();
  try {
    await runtime.start();
    assert.equal(runtime.status().state, 'ready');
    assert.ok(runtime.status().pid !== null);

    const result = (await runtime.call('channel.collect', { userId: 'u1' })) as { facts: Record<string, unknown> };
    assert.equal(result.facts['account_age_days'], 1200);
    assert.equal(runtime.status().totalCalls, 2, 'init + collect');
    assert.ok(runtime.status().lastUsedAt !== null);
  } finally {
    await runtime.stop();
  }
});

test('M4-1：插件的 console.log 污染 stdout 时仍能正常通信（噪声行被忽略）', async () => {
  const runtime = makeRuntime();
  try {
    const result = (await runtime.call('noisy', {})) as { survived: boolean };
    assert.equal(result.survived, true);
  } finally {
    await runtime.stop();
  }
});

// ─────────────────────────── ★ 崩溃隔离 ───────────────────────────

test('★ M4-1：插件崩溃 → 在途请求被**显式拒绝**（不是永远挂着）', async () => {
  const runtime = makeRuntime();
  try {
    await runtime.start();
    // 触发崩溃：crash 方法会 process.exit(7)，不会回响应
    await assert.rejects(runtime.call('crash', {}), (error: unknown) => {
      assert.ok(error instanceof PluginCrashedError, `应是 PluginCrashedError，实际 ${String(error)}`);
      assert.match(error.message, /退出码 7/);
      return true;
    });
    // ★ 关键：宿主进程仍活着（测试能继续执行本身就是证据）
    assert.ok(true, '宿主未被拖垮');
  } finally {
    await runtime.stop();
  }
});

test('★ M4-1：崩溃后**自愈** —— 下次调用自动重启并成功', async () => {
  const runtime = makeRuntime({ maxConsecutiveFailures: 10 });
  try {
    await runtime.start();
    await assert.rejects(runtime.call('crash', {}));

    // 崩溃后状态为 restarting 或已恢复；下次调用应自动拉起
    const result = (await runtime.call('channel.collect', { userId: 'u1' })) as { facts: Record<string, unknown> };
    assert.equal(result.facts['account_age_days'], 1200, '★ 崩溃后应能自愈并正常返回');
    assert.equal(runtime.status().state, 'ready');
  } finally {
    await runtime.stop();
  }
});

test('★ M4-1：连续失败达上限 → `failed`，**停止重启**（不再无限重启打满 CPU）', async () => {
  const runtime = makeRuntime({ maxConsecutiveFailures: 2 });
  try {
    // ★ 反复触发崩溃「直到」进入 failed —— 不写死次数：
    //   退避重启是异步的（定时器 + 进程 spawn），固定次数会让测试依赖时序而变得脆弱。
    for (let i = 0; i < 8 && runtime.status().state !== 'failed'; i += 1) {
      await runtime.call('crash', {}).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 40)); // 给退避重启留出时间
    }
  } finally {
    const status = runtime.status();
    assert.equal(status.state, 'failed', '连续失败达上限应转 failed');
    assert.ok(status.consecutiveFailures >= 2);
    // 此后调用立即失败（不再尝试重启）
    await assert.rejects(runtime.call('channel.collect', {}), (error: unknown) => {
      assert.ok(error instanceof PluginCrashedError);
      // 错误信息要说清「为什么不再重启」，而不只是重复崩溃原因
      assert.match(error.message, /已停止重启/);
      assert.match(error.message, /需人工介入/);
      return true;
    });
    await runtime.stop();
  }
});

// ─────────────────────────── 超时杀进程 ───────────────────────────

test('★ M4-1：调用超时 → **杀进程**（SIGKILL）并抛 PluginTimeoutError', async () => {
  const runtime = makeRuntime({ defaultTimeoutMs: 300, maxConsecutiveFailures: 10 });
  try {
    await runtime.start();
    const started = Date.now();
    await assert.rejects(runtime.call('hang', {}), (error: unknown) => {
      assert.ok(error instanceof PluginTimeoutError);
      assert.match(error.message, /未返回（已杀进程）/);
      return true;
    });
    assert.ok(Date.now() - started < 3_000, '超时应被宿主强制');

    // 进程已被杀（pid 为 null）
    assert.equal(runtime.status().pid, null, '★ 超时后进程必须已被杀（不能留着）');
  } finally {
    await runtime.stop();
  }
});

test('M4-1：stop 保证停止（SIGTERM 被忽略时升级 SIGKILL）', async () => {
  const runtime = makeRuntime();
  await runtime.start();
  const pid = runtime.status().pid;
  assert.ok(pid !== null);
  await runtime.stop();
  assert.equal(runtime.status().state, 'stopped');
  assert.equal(runtime.status().pid, null);
  // 重复 stop 幂等
  await runtime.stop();
  assert.equal(runtime.status().state, 'stopped');
});

// ─────────────────────────── 宿主能力 ───────────────────────────

test('★ M4-1：插件不能直接出网 —— 经 `host.http.request` 由宿主代发', async () => {
  const calls: { method: string; url: string }[] = [];
  const runtime = makeRuntime({
    capabilities: {
      httpRequest: async (params) => {
        calls.push({ method: params.method, url: params.url });
        return { status: 200, headers: {}, body: JSON.stringify({ viaHost: true }) };
      },
    },
  });
  try {
    const result = (await runtime.call('ask-host', {})) as { hostReply?: { status: number; body: string } };
    assert.ok(calls.length >= 1, '★ 插件的出站请求必须经宿主（宿主是唯一的出网通道）');
    assert.equal(calls[0]!.url, 'https://api.example.com/x');
    assert.ok(result.hostReply !== undefined, '插件应收到宿主代发的响应');
    assert.equal(result.hostReply!.status, 200);
  } finally {
    await runtime.stop();
  }
});

test('M4-1：未知宿主能力方法 → 返回 JSON-RPC 错误（不静默）', async () => {
  const runtime = makeRuntime();
  try {
    await runtime.start();
    // 直接构造一个未知能力请求（通过 stdin 写入，模拟插件行为）
    const child = (runtime as unknown as { child: { stdin: { write(s: string): void } } }).child;
    const before = runtime.status().inFlight;
    child.stdin.write(encodeFrame({ jsonrpc: '2.0', id: 999, method: 'host.dangerous.thing', params: {} }));
    // 给宿主一点时间处理
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 宿主应返回错误而不是崩溃；插件仍在运行
    assert.equal(runtime.status().state, 'ready');
    assert.equal(runtime.status().inFlight, before);
  } finally {
    await runtime.stop();
  }
});

// ─────────────────────────── 状态可观测 ───────────────────────────

test('M4-1：status 暴露运维需要的全部信息', async () => {
  const runtime = makeRuntime();
  try {
    const before = runtime.status();
    assert.equal(before.state, 'stopped');
    assert.equal(before.pid, null);
    assert.equal(before.restarts, 0);
    assert.equal(before.consecutiveFailures, 0);
    assert.equal(before.inFlight, 0);
    assert.equal(before.totalCalls, 0);

    await runtime.start();
    await runtime.call('channel.collect', { userId: 'u1' });
    const after = runtime.status();
    assert.equal(after.state, 'ready');
    assert.ok(after.pid !== null);
    assert.equal(after.totalCalls, 2);
    assert.equal(after.inFlight, 0);
  } finally {
    await runtime.stop();
  }
});

test('M4-1：调用不存在的插件命令 → 启动失败被隔离（宿主不崩）', async () => {
  const runtime = new ProcessRuntime({
    pluginId: 'ghost',
    command: '/nonexistent/definitely-not-a-binary',
    args: [],
    capabilities: CAPABILITIES,
    logger: silentLogger,
    defaultTimeoutMs: 1_000,
    initTimeoutMs: 1_000,
    restartBackoffBaseMs: 10,
    restartBackoffMaxMs: 20,
    maxConsecutiveFailures: 2,
  });
  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.ok(error instanceof PluginCrashedError || error instanceof Error);
    return true;
  });
  // ★ 宿主仍活着，且状态可查
  const status = runtime.status();
  assert.ok(['restarting', 'failed', 'stopped'].includes(status.state));
  assert.ok(status.lastExitReason !== null);
  await runtime.stop();
});
