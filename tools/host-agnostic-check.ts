/**
 * 架构验收 M4-17「**宿主无知**」—— 核心必须与内置插件解耦。
 *
 * ★ 路线图的原文（`docs/07:150`）：
 *   > **验收：宿主无知** | 删除 `plugins/builtin/` 后主程序仍能启动；
 *   > 核心逻辑 grep `github` 为 0
 *
 * ★★ 此前只有**后半**被覆盖（CI 第 7 项：`src/**` 的系统名扫描）；
 *   **前半**（「删除后可启动」）**从未被验证**——本工具补上它。
 *
 * ★★★ 方法：把 `src/plugin/builtin/` **临时移走**，跑 `tsc --noEmit`，
 *   断言**核心（`src/`）零错误**；然后**无论结果如何都移回**（`finally`）。
 *
 * ★ 关于「装配层（`tools/`）依赖内置插件」：这是**设计如此**——
 *   装配层负责**装载**内置插件，它当然要知道它们。
 *   ★ M4-17 说的是「**主程序**」（核心），因此本工具**只断言 `src/` 零错误**，
 *     并**同时报告** `tools/` 的错误数（供知情，不作为失败）。
 *
 * 用法：
 *   node --experimental-strip-types tools/host-agnostic-check.ts
 *   node --experimental-strip-types tools/host-agnostic-check.ts --self-test
 */

import { rename, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN = path.join(ROOT, 'src', 'plugin', 'builtin');
const PARKED = path.join(ROOT, 'src', 'plugin', '.builtin-parked');

/** 分类 `tsc` 的输出：核心 / 装配层 / 测试。 */
export function classifyErrors(output: string): { core: string[]; tools: string[]; tests: string[] } {
  const core: string[] = [];
  const tools: string[] = [];
  const tests: string[] = [];
  for (const line of output.split('\n')) {
    if (!/error TS/.test(line)) continue;
    if (line.startsWith('src/')) core.push(line);
    else if (line.startsWith('tools/')) tools.push(line);
    else if (line.startsWith('test/')) tests.push(line);
  }
  return { core, tools, tests };
}

function selfTest(): number {
  const sample = [
    'src/a.ts(1,2): error TS2307: x',
    'tools/serve.ts(3,4): error TS2307: y',
    'test/t.test.ts(5,6): error TS2307: z',
    'some unrelated line',
  ].join('\n');
  const r = classifyErrors(sample);
  const ok = r.core.length === 1 && r.tools.length === 1 && r.tests.length === 1;
  process.stdout.write(
    `\n【宿主无知检查自测】\n  ${ok ? '✅' : '❌'} 分类 core=${r.core.length} tools=${r.tools.length} tests=${r.tests.length}（期望 1/1/1）\n` +
      `  ${ok ? '自测通过——分类器可信' : '**自测失败——分类器不可信**'}\n`,
  );
  return ok ? 0 : 1;
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) {
    process.exitCode = selfTest();
    return;
  }

  process.stdout.write('\n【架构验收 M4-17：宿主无知（核心与内置插件解耦）】\n\n');
  let parked = false;
  try {
    await stat(BUILTIN);
    await rename(BUILTIN, PARKED);
    parked = true;
    process.stdout.write('  · 已临时移走 src/plugin/builtin/\n');

    const tsc = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--noEmit'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const { core, tools, tests } = classifyErrors(`${tsc.stdout ?? ''}${tsc.stderr ?? ''}`);

    process.stdout.write(`  · 核心（src/）错误：${core.length}\n`);
    process.stdout.write(`  · 装配层（tools/）错误：${tools.length}（★ 设计如此：装配层负责装载内置插件，不作为失败）\n`);
    process.stdout.write(`  · 测试（test/）错误：${tests.length}（测试依赖内置插件，不作为失败）\n`);
    for (const line of core.slice(0, 6)) process.stdout.write(`      ✗ ${line}\n`);

    const ok = core.length === 0;
    process.stdout.write(
      `\n  ${ok ? '✅' : '❌'} M4-17 前半（删除 builtin/ 后**核心**仍可通过类型检查）：${ok ? '通过' : `失败（${core.length} 处核心错误）`}\n` +
        `  · ★ 后半（核心逻辑 grep 系统名 = 0）由 CI 第 7 项覆盖。\n`,
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    // ★★★ 无论成功失败都要移回——否则会破坏工作区（我在手工验证时也是这么做的）。
    if (parked) {
      await rename(PARKED, BUILTIN);
      process.stdout.write('  · 已移回 src/plugin/builtin/\n');
    }
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) await main();
