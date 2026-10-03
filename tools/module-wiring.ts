/**
 * 模块接线检查：**`src/**` 里的模块是否被生产代码引用**？
 *
 * ★★★ 为什么需要它：本会话建立了三层「有但没用」的检查——
 *
 *   | 层级 | 工具 | 抓到的 |
 *   |---|---|---|
 *   | 路由级 | `route-coverage` | 3 条路由未挂载（含目标点名的**回滚**） |
 *   | 装配级 | `impl-pairing` | `HostApi` 未装配（插件运行时全不可用） |
 *   | **模块级** | **本工具** | **26 个模块未被任何生产文件引用** |
 *
 *   ★ 三层都指向同一模式：**「实现存在」不等于「服务里能用」**。
 *
 * ★ 与另两个工具一样，本工具**只报告、不判失败**——
 *   因为「未被引用」有三种完全不同的含义（见 `reports/unwired-modules.md`）：
 *   **A. 真的未接线**（缺陷）· **B. 可选能力**（按部署启用）· **C. 库/工具**（给外部用）。
 *   一刀切判失败会逼人去「消数字」（把模块删掉或加个假引用），而不是判断。
 *
 * 用法：
 *   node --experimental-strip-types tools/module-wiring.ts
 *   node --experimental-strip-types tools/module-wiring.ts --json
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 递归收集 .ts 文件。 */
async function collect(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 已知的「刻意不接」白名单（附理由）——避免每次都人工重判。 */
const INTENTIONALLY_UNWIRED: Record<string, string> = {
  'src/verify/sdk.ts': 'C 类：协同验证 SDK，**给调用方（外部）使用**，本服务只提供接口',
  'src/kernel/di.ts': 'C 类：依赖注入工具，供外部装配器使用',
  'src/plugin/process-runtime.ts': 'B 类：插件以独立进程运行的**可选**运行时（按部署启用）',
  'src/plugin/declarative-webhook.ts': 'B 类：声明式插件的 webhook 模式（按插件声明启用）',
  'src/plugin/storage-tiers.ts': 'B 类：存储分层（按规模启用）',
};

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const moduleFiles = await collect(path.join(ROOT, 'src'));
  const allFiles = [...(await collect(path.join(ROOT, 'src'))), ...(await collect(path.join(ROOT, 'tools')))];

  // 生产文件 = src/ + tools/（**不含 test/**）
  const prodSources = new Map<string, string>();
  for (const file of allFiles) prodSources.set(file, await readFile(file, 'utf8'));

  const orphans: string[] = [];
  for (const moduleFile of moduleFiles) {
    const base = path.basename(moduleFile, '.ts');
    // ★ 用「模块名」匹配 import（而不是解析路径别名）——本项目的 import 都带 `.ts` 后缀
    const pattern = new RegExp(`from\\s+['"][^'"]*${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.ts['"]`);
    let referenced = false;
    for (const [file, source] of prodSources) {
      if (file === moduleFile) continue;
      if (pattern.test(source)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) orphans.push(path.relative(ROOT, moduleFile));
  }

  const sorted = orphans.sort();
  const whitelisted = sorted.filter((file) => INTENTIONALLY_UNWIRED[file] !== undefined);
  const unclassified = sorted.filter((file) => INTENTIONALLY_UNWIRED[file] === undefined);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ moduleCount: moduleFiles.length, orphanCount: sorted.length, whitelisted, unclassified }, null, 2)}\n`,
    );
    return;
  }

  process.stdout.write('\n【模块接线检查：src/** 是否被生产代码引用】\n\n');
  process.stdout.write(`src/ 模块总数：${moduleFiles.length}\n`);
  process.stdout.write(`未被任何生产文件引用：${sorted.length}\n\n`);

  process.stdout.write(`★ 已归类为「刻意不接」（${whitelisted.length}）：\n`);
  for (const file of whitelisted) process.stdout.write(`  · ${file} —— ${INTENTIONALLY_UNWIRED[file]}\n`);

  process.stdout.write(`\n★ **待判断**（${unclassified.length}）——需要人工分类（A/B/C，见 reports/unwired-modules.md）：\n`);
  for (const file of unclassified) process.stdout.write(`  ⚠️  ${file}\n`);

  process.stdout.write(
    `\n${'='.repeat(76)}\n` +
      `★ 诚实解读：\n` +
      `  · 「未被引用」**不等于缺陷**——三类含义完全不同：\n` +
      `    A. 真的未接线（能力已实现、被测试覆盖，但服务里没有调用路径）\n` +
      `    B. 可选能力（按部署/开关启用，如进程运行时）\n` +
      `    C. 库/工具（给外部使用，如协同验证 SDK）\n` +
      `  · ★ 因此本工具**刻意不作为 CI 门禁**——\n` +
      `    判失败会逼人去「消数字」（删模块或加假引用），而不是判断哪些能力真的该接。\n` +
      `  · 已归类的条目在脚本的 INTENTIONALLY_UNWIRED 里（**附理由**），避免重复判断。\n`,
  );
}

await main();
