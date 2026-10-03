/**
 * 表使用核对：**文档声明的表 vs 代码实际读写的表**。
 *
 * ★★ 为什么需要它：R30 发现了一个很隐蔽的偏差——
 *   `docs/02-数据模型.md §4.3` 明确规定用 `ag_plugin_grants` 表存权限授予，
 *   而我把授权写进了 `ag_plugins.runtime_state.grants`（jsonb）。
 *
 *   那次偏差的特点是：**功能是好的**（接口返回 200、测试全过），
 *   但**丢失了审计字段与唯一约束**，且**存储形态与文档不符**。
 *   现有的 `api-coverage`（端点）与 `route-coverage`（路由）都覆盖不到它。
 *
 * ★ 本工具找出两类问题：
 *   ① **「有表但代码没用」**——schema 声明了表，但 `src/**` 从不读写它
 *      （可能是未实现的功能，也可能是被别的存储方式替代了——如 grants）；
 *   ② **「代码用了文档没声明的表」**——反向漂移。
 *
 * ★ 它**不能**判断「代码用表的方式是否符合文档」（如是否用了软撤销）。
 *   那需要人工核对字段语义——本工具只负责**把差异摆到台面上**。
 *
 * 用法：
 *   node --experimental-strip-types tools/table-coverage.ts
 *   node --experimental-strip-types tools/table-coverage.ts --json
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从 docs/02 提取声明的表名（`defineTable('ag_xxx', ...)`）。 */
function extractDeclared(markdown: string): string[] {
  const names = new Set<string>();
  for (const match of markdown.matchAll(/defineTable\(\s*'(ag_[a-z_]+)'/g)) names.add(match[1]!);
  return [...names].sort();
}

/** 从迁移产物提取真实建表（用于核对文档与 DDL 是否一致）。 */
function extractDdlTables(sql: string): string[] {
  const names = new Set<string>();
  for (const match of sql.matchAll(/CREATE TABLE (ag_[a-z_]+)/g)) names.add(match[1]!);
  return [...names].sort();
}

/** 递归收集 `src/**` 下的 .ts 文件。 */
async function collectSources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSources(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 从源码提取被引用的表名（编译器的 `table: '...'` 与裸 SQL 的 FROM/INTO/UPDATE）。 */
function extractUsed(sources: Map<string, string>): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const [file, source] of sources) {
    const names = new Set<string>();
    for (const match of source.matchAll(/table:\s*'(ag_[a-z_]+)'/g)) names.add(match[1]!);
    for (const match of source.matchAll(/\b(?:FROM|INTO|UPDATE)\s+(ag_[a-z_]+)/gi)) names.add(match[1]!);
    for (const name of names) {
      const list = used.get(name) ?? [];
      list.push(path.relative(ROOT, file));
      used.set(name, list);
    }
  }
  return used;
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const markdown = await readFile(path.join(ROOT, 'docs', '02-数据模型.md'), 'utf8');
  const ddl = await readFile(path.join(ROOT, 'migrations', '0001_init.sql'), 'utf8');

  const declared = extractDeclared(markdown);
  const ddlTables = extractDdlTables(ddl);
  const sourceFiles = await collectSources(path.join(ROOT, 'src'));
  const sources = new Map<string, string>();
  for (const file of sourceFiles) sources.set(file, await readFile(file, 'utf8'));
  const used = extractUsed(sources);

  // ══════════ ★★★ 内存实现的 id 是否与 PG 主键类型一致 ══════════
  //
  //   ★ 为什么单独查这一条：本会话**两次**栽在同一个坑上——
  //     内存 store 生成 `vcc-1` / `ui-1` 这类 id，而 PG 对应表的主键是 **uuid**。
  //     后果不是「内存模式也能跑」，而是：
  //       ① 接口层加了 uuid 校验后，**内存模式的测试全部失败**（真实模式正常）；
  //       ② 更糟的是反过来的情形——内存返回的 id 被前端拿去调用，
  //          在真实模式下被 uuid 校验拒绝（**只有真实模式才暴露**）。
  //   ★ 因此这是一条**跨实现的类型一致性**检查，值得自动化。
  const idShapedWrongly: string[] = [];
  for (const [file, source] of sources) {
    // 匹配 `id: \`xx-${...}\`` 形式（模板串 + 短前缀）
    for (const match of source.matchAll(/(?:id|endpointId|userId)\s*:\s*`([a-z]{1,6})-\$\{/g)) {
      idShapedWrongly.push(`${path.relative(ROOT, file)}：短前缀 ${match[1]}- 加自增序号的模板串形式`);
    }
  }

  const unused = ddlTables.filter((name) => !used.has(name));
  const usedNotInDdl = [...used.keys()].filter((name) => !ddlTables.includes(name)).sort();
  const declaredNotInDdl = declared.filter((name) => !ddlTables.includes(name));

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ declaredCount: declared.length, ddlCount: ddlTables.length, unused, usedNotInDdl, declaredNotInDdl }, null, 2)}\n`,
    );
    return;
  }

  process.stdout.write('\n【表使用核对：文档声明的表 vs 代码实际读写】\n\n');
  process.stdout.write(`docs/02 声明：${declared.length} 张 · 迁移产物建表：${ddlTables.length} 张 · 代码引用：${used.size} 张\n\n`);

  process.stdout.write(`★ 非 uuid 的内存 id 生成（${idShapedWrongly.length} 处）：\n`);
  for (const entry of idShapedWrongly) process.stdout.write(`  ❌ ${entry}\n`);
  if (idShapedWrongly.length === 0) process.stdout.write(`  ✅ 未发现（内存实现的 id 与 PG 主键类型一致）\n`);
  process.stdout.write('\n');
  process.stdout.write(`有表但代码**从不读写**（${unused.length} 张）：\n`);
  for (const name of unused) process.stdout.write(`  ⚠️  ${name}\n`);

  if (declaredNotInDdl.length > 0) {
    process.stdout.write(`\n文档声明但迁移产物**没有**（${declaredNotInDdl.length} 张）：\n`);
    for (const name of declaredNotInDdl) process.stdout.write(`  ❌ ${name}\n`);
  }
  if (usedNotInDdl.length > 0) {
    process.stdout.write(`\n代码引用但迁移产物没有（${usedNotInDdl.length} 张）：\n`);
    for (const name of usedNotInDdl) process.stdout.write(`  ❌ ${name}\n`);
  }

  process.stdout.write(
    `\n${'='.repeat(76)}\n` +
      `★ 诚实解读（重要）：\n` +
      `  · 「有表但代码没用」**不等于缺陷**——可能是：\n` +
      `    ① 该功能尚未实现（属正常工作积压）；\n` +
      `    ② **被另一种存储方式替代了**（如 R30 的 grants 写成 jsonb）——**这才是要警惕的**；\n` +
      `  · 本工具只把差异摆到台面上，**不判断**「代码用表的方式是否符合文档字段语义」\n` +
      `    （如是否用了软撤销、是否记录了 granted_by）。那需要人工核对。\n` +
      `  · ★ 因此它像 api-coverage 一样**刻意不作为 CI 门禁**：\n` +
      `    以非零退出会逼人去「消数字」，而不是去判断哪些差异是真的问题。\n`,
  );
  // 刻意不以非零退出（同 api-coverage）：结论需要人工判断。
}

await main();
