/**
 * 实现配对检查：**每个仓储接口是否同时有内存实现与 PG 实现**？
 *
 * ★★ 为什么需要它：本会话**三次**因「内存实现与 PG 实现的语义不一致」返工：
 *   ① 分页「多取一条」（内存忘了切掉 → 返回条数不同）；
 *   ② id 形态（内存 `vcc-1` vs PG uuid）——两次；
 *   ③ 标签去重排序（两个实现必须同语义，否则「是否变化」的判断会漂移）。
 *
 *   ★ 这些问题的共同点：**内存实现通过 ≠ 真实 PG 通过**，
 *     而真实 PG 在 CI 里是**可选**的（`AG_CI_REAL=1`）——
 *     所以「只有 PG 实现、没有内存实现」的接口，
 *     其行为在默认 CI 下**完全没有被测试覆盖**。
 *
 * ★ 本工具检查两类：
 *   ① **只有 Db 实现**（无内存实现）→ 默认 CI 覆盖不到，风险最高；
 *   ② **只有内存实现**（无 Db 实现）→ 真实模式下不可用（可能是「忘了写 PG 版」）。
 *
 * ★ 它**不能**检查「两个实现是否语义一致」——那需要人工或契约测试。
 *   本工具只把「配对缺口」摆到台面上。
 *
 * 用法：
 *   node --experimental-strip-types tools/impl-pairing.ts
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Implementation {
  className: string;
  file: string;
  /** 实现的接口名（`implements X`） */
  interfaces: string[];
}

async function collect(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 提取所有 `class X implements Y, Z`。 */
export function extractImplementations(sources: Map<string, string>): Implementation[] {
  const out: Implementation[] = [];
  for (const [file, source] of sources) {
    // ★ 用 `[\s\S]` 匹配跨行（有些 class 声明会换行）
    for (const match of source.matchAll(/class\s+(\w+)\s+implements\s+([\w\s,]+?)\s*\{/g)) {
      out.push({
        className: match[1]!,
        file: path.relative(ROOT, file),
        interfaces: match[2]!.split(',').map((name) => name.trim()).filter((name) => name.length > 0),
      });
    }
  }
  return out;
}

/** 自测：证明它能区分「成对」与「单边」。 */
function selfTest(): number {
  const sources = new Map<string, string>([
    ['a.ts', 'class InMemoryFooStore implements FooStore { }'],
    ['b.ts', 'class DbFooStore implements FooStore { }'],
    ['c.ts', 'class DbBarStore implements BarStore { }'],
    ['d.ts', 'class InMemoryBazStore implements BazStore { }'],
  ]);
  const impls = extractImplementations(sources);
  const byInterface = new Map<string, Implementation[]>();
  for (const impl of impls) {
    for (const name of impl.interfaces) {
      byInterface.set(name, [...(byInterface.get(name) ?? []), impl]);
    }
  }
  const cases: { name: string; iface: string; expect: 'paired' | 'dbOnly' | 'memOnly' }[] = [
    { name: '两个实现 → 成对', iface: 'FooStore', expect: 'paired' },
    { name: '只有 Db → dbOnly', iface: 'BarStore', expect: 'dbOnly' },
    { name: '只有内存 → memOnly', iface: 'BazStore', expect: 'memOnly' },
  ];
  let failures = 0;
  for (const testCase of cases) {
    const list = byInterface.get(testCase.iface) ?? [];
    const hasMem = list.some((impl) => impl.className.startsWith('InMemory'));
    const hasDb = list.some((impl) => impl.className.startsWith('Db'));
    const actual = hasMem && hasDb ? 'paired' : hasDb ? 'dbOnly' : hasMem ? 'memOnly' : 'none';
    const ok = actual === testCase.expect;
    process.stdout.write(`  ${ok ? '✅' : '❌'} ${testCase.name}：${actual}（期望 ${testCase.expect}）\n`);
    if (!ok) failures += 1;
  }
  process.stdout.write(`\n自测结果：${cases.length - failures}/${cases.length} ${failures === 0 ? '通过——检查能区分成对与单边' : '**失败——检查不可信**'}\n`);
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) {
    process.stdout.write('\n【实现配对检查自测】\n\n');
    process.exitCode = selfTest();
    return;
  }

  process.stdout.write('\n【实现配对检查（内存实现 vs PG 实现）】\n\n');
  const files = await collect(path.join(ROOT, 'src'));
  const sources = new Map<string, string>();
  for (const file of files) sources.set(file, await readFile(file, 'utf8'));
  const impls = extractImplementations(sources);

  const byInterface = new Map<string, Implementation[]>();
  for (const impl of impls) {
    for (const name of impl.interfaces) {
      byInterface.set(name, [...(byInterface.get(name) ?? []), impl]);
    }
  }

  const dbOnly: string[] = [];
  const memOnly: string[] = [];
  const paired: string[] = [];
  for (const [iface, list] of [...byInterface.entries()].sort()) {
    const hasMem = list.some((impl) => impl.className.startsWith('InMemory'));
    const hasDb = list.some((impl) => impl.className.startsWith('Db'));
    if (hasMem && hasDb) paired.push(iface);
    else if (hasDb) dbOnly.push(iface);
    else if (hasMem) memOnly.push(iface);
  }

  process.stdout.write(`接口总数（有实现的）：${byInterface.size}\n`);
  process.stdout.write(`★ 成对（内存 + PG）：${paired.length}\n`);
  process.stdout.write(`★ **只有 PG 实现**（默认 CI 覆盖不到）：${dbOnly.length}\n`);
  for (const iface of dbOnly) {
    const list = byInterface.get(iface)!;
    process.stdout.write(`  ⚠️  ${iface} —— ${list.map((impl) => impl.className).join(', ')}\n`);
  }
  process.stdout.write(`★ **只有内存实现**（真实模式下不可用？）：${memOnly.length}\n`);
  for (const iface of memOnly) {
    const list = byInterface.get(iface)!;
    process.stdout.write(`  ⚠️  ${iface} —— ${list.map((impl) => impl.className).join(', ')}\n`);
  }

  // ══════════ ★★★ 「接口有实现，但服务里没用到」检查 ══════════
  //
  //   ★ 为什么需要：R64 发现 `HostApi`（插件的宿主 API）**只在测试里被 `new`**——
  //     于是「插件 KV / 密钥 / 出网」这些能力在真实服务里**完全不可用**。
  //     而 `impl-pairing` 原本只查「接口有无 PG 实现」，
  //     **看不到「这个实现有没有被服务使用」**。
  //
  //   ★ 这类缺口的特征：**测试全绿、服务里是空的**。
  //     它与「未接线」（R13 的 3 条路由）同类，但发生在**类**而非**路由**上。
  // ★★ 装配点**不止 `serve.ts`**：本项目有 `src/app/storage.ts` 这样的装配器
  //   （它集中 `new DbXxxStore(db, siteId)`）。
  //   ★ 我第一版只扫 `serve.ts`，于是把 11 个**确实被使用**的 store 报成「未使用」——
  //     这是**检查工具自身的 bug**（本会话第 N 次）。
  //   ★ 教训：判断「某物是否被使用」时，必须**找全使用点**，而不是假定只有一个文件。
  const wiringFiles = ['tools/serve.ts', 'src/app/storage.ts', 'src/app/index.ts'];
  const wiringSources: string[] = [];
  for (const relative of wiringFiles) {
    const full = path.join(ROOT, relative);
    if (existsSync(full)) wiringSources.push(await readFile(full, 'utf8'));
  }
  const wiring = wiringSources.join('\n');

  const unusedInServe: string[] = [];
  if (wiringSources.length > 0) {
    // ★★ 判断「是否被使用」要看**接口名**，而不是实现类名——
    //   因为装配点通常是「工厂函数」（定义在 `src/db/*.ts` 里），
    //   而装配文件（`serve.ts` / `src/app/storage.ts`）里出现的是**接口类型声明**：
    //     `const x: UserAdminStore = db === undefined ? ... : createTransactionalUserAdminStore(db);`
    //   ★ 我前两版分别用了「类名 + 工厂名推导」与「类名」，都**误报**了
    //     （11 个 → 21 个）——这是**检查工具自身 bug** 的第 N 次。
    //   ★ 教训：判断「是否被使用」时，要先想清楚**使用的形态是什么**。
    for (const impl of impls) {
      if (!impl.className.startsWith('Db')) continue;
      const usedByInterface = impl.interfaces.some((name) => wiring.includes(name));
      if (!usedByInterface) unusedInServe.push(`${impl.className}（接口 ${impl.interfaces.join(', ')} 未在装配文件中出现）`);
    }
    // ★ 额外：检查 HostApi 是否被装配（R64 的具体发现）
    if (!wiring.includes('HostApi(')) {
      unusedInServe.push('HostApi（插件宿主 API——★ 只在测试里出现，服务里未装配）');
    }
  }

  process.stdout.write(`\n★ 有 PG 实现但**服务里未使用**（${unusedInServe.length} 个）：\n`);
  for (const entry of unusedInServe) process.stdout.write(`  ⚠️  ${entry}\n`);
  if (unusedInServe.length === 0) process.stdout.write('  ✅ 全部有实现且被服务使用\n');

  process.stdout.write(
    `\n★ 诚实解读：\n` +
      `  · 「只有 PG 实现」不一定是缺陷——有些仓储只服务真实模式（如 DbOutboxStore）；\n` +
      `    但它的行为在**默认 CI**（AG_CI_REAL 未设）下**没有被任何测试覆盖**。\n` +
      `  · 「只有内存实现」**更可疑**——真实模式下会走到哪里？可能是忘了写 PG 版。\n` +
      `  · ★ 本工具**不能**判断两个实现是否**语义一致**（如去重排序、分页边界）——\n` +
      `    那需要契约测试；本工具只把配对缺口摆到台面上。\n`,
  );
  // 刻意不以非零退出（同 api-coverage / table-coverage）：结论需要人工判断。
}

await main();
