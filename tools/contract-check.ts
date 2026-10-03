/**
 * `docs/12`（Schema 声明层**接口契约**）的导出核对（R118）。
 *
 * ★★★ 为什么需要它：
 *   `docs/12` 的 §2 题为「模块与导出（**冻结**）」——冻结意味着**不应有偏差**。
 *   ★ 而 R118 逐条核对时发现 **1 处真实偏差**：
 *     `collectTables` 被列在 `normalize.ts`，实际在 `dsl.ts`。
 *   ★ 这类偏差**不会让任何测试失败**（代码是好的，只是**契约描述错了**），
 *     因此只能靠**逐条核对**发现——本工具把这件事自动化。
 *
 * ★★ 本工具自身的教训（与 R112 同源）：
 *   我的第一版正则只匹配 `export (const|function|class|type|interface)`，
 *   ★ **漏了 `export async function`**，把**存在**的 `tx.ts#withTransaction`
 *     报成缺失（**假阳性**）。★ 因此本工具：
 *     ① 正则**包含 `async`**；
 *     ② 带 `--self-test`（验证它能识别各种导出形态，**包括 async**）。
 *
 * 用法：
 *   node --experimental-strip-types tools/contract-check.ts
 *   node --experimental-strip-types tools/contract-check.ts --self-test
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ★ 从源码里判断某个名字是否被导出。
 *
 * ★ 必须覆盖的形态（★ 第一版漏了第 2 种，导致假阳性）：
 *   1. `export function foo` / `export const foo` / `export class foo`
 *   2. ★ `export async function foo`
 *   3. `export type foo` / `export interface foo` / `export enum foo`
 *   4. `export { foo }` / `export { foo as bar }`
 */
export function isExported(source: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(
    `export\\s+(?:async\\s+)?(?:const|let|var|function|class|type|interface|enum)\\s+${n}\\b`,
  );
  if (direct.test(source)) return true;
  // `export { a, b as c }` —— 只认「本地名」或「导出名」任一匹配
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const pieces = part.trim().split(/\s+as\s+/);
      if (pieces.some((piece) => piece.trim() === name)) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) {
    const sample = [
      'export function a() {}',
      'export async function b() {}',      // ★ 第一版漏掉的形态
      'export const c = 1;',
      'export type d = string;',
      'export interface e {}',
      'export { f, g as h };',
      'function notExported() {}',
    ].join('\n');
    const cases: [string, boolean][] = [
      ['a', true], ['b', true], ['c', true], ['d', true], ['e', true],
      ['f', true], ['h', true], ['notExported', false], ['zzz', false],
    ];
    let ok = 0;
    for (const [name, want] of cases) {
      const got = isExported(sample, name);
      if (got === want) ok += 1;
      else process.stdout.write(`  ❌ ${name}: ${got}（期望 ${want}）\n`);
    }
    process.stdout.write(
      `\n【契约导出核对 自测】\n  ${ok === cases.length ? '✅' : '❌'} ${ok}/${cases.length} 通过` +
        `${ok === cases.length ? '——含 `export async function`（第一版漏掉的形态）' : ''}\n`,
    );
    process.exitCode = ok === cases.length ? 0 : 1;
    return;
  }

  // 契约表（从 docs/12 §2 抄录；★ 修订后的版本）
  const CONTRACT: Record<string, readonly string[]> = {
    'src/schema/dsl.ts': ['defineTable', 'declare', 'col', 't', 'collectTables'],
    'src/schema/normalize.ts': ['normalizeTable', 'tableColumns'],
    'src/schema/gate/scope.ts': ['checkScopeRules', 'formatViolations'],
    'src/schema/gate/exemptions.ts': ['PLATFORM_EXEMPTIONS'],
    'src/schema/compile/ddl.ts': ['compileTable', 'compileSchema', 'compileEnums'],
    'src/db/scope.ts': ['resolveScope', 'mustScope', 'ScopeMissingError'],
    'src/db/tx.ts': ['withTransaction', 'currentTx', 'assertInTransaction'],
    'src/db/guard.ts': ['scanSource'],
  };

  process.stdout.write('\n【docs/12 §2 契约导出核对（冻结的接口）】\n\n');
  let total = 0;
  const missing: string[] = [];
  for (const [rel, names] of Object.entries(CONTRACT)) {
    let source: string;
    try {
      source = await readFile(path.join(ROOT, rel), 'utf8');
    } catch {
      missing.push(`${rel}（模块不存在）`);
      continue;
    }
    for (const name of names) {
      total += 1;
      if (!isExported(source, name)) missing.push(`${rel} → ${name}`);
    }
  }
  process.stdout.write(`  · 契约导出项：${total}\n`);
  process.stdout.write(`  · 缺失：${missing.length}\n`);
  for (const item of missing) process.stdout.write(`      ✗ ${item}\n`);
  process.stdout.write(
    `\n  ${missing.length === 0 ? '✅' : '❌'} 冻结契约与实际导出${missing.length === 0 ? '一致' : '不一致'}\n` +
      // ★ 注意：模板字符串里**不能嵌反引号**——我第一版写了
      //   `· 本工具覆盖 `export async function`…`，直接导致语法错误。
      //   ★ 而 `ci-checks.ts` 的注释**早就警告过这个坑**（「注释里不要写反引号包住的例子」）。
      '  · ★ 本工具覆盖 export async function（第一版漏此形态致假阳性）\n' +
      '  · ★ 本工具只核对**导出是否存在**；导出**归属哪个模块**由人工维护（见 docs/12 §2）\n',
  );
  process.exitCode = missing.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) await main();
