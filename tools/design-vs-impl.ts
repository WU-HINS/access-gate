/**
 * 设计声明 vs 实现产物 —— **细粒度一致性扫描**（R107）。
 *
 * ★★★ 为什么需要它（先例）：
 *   `dualScopeCheck` 在 `docs/02` 里**正确声明了完整表达式**（两半，`+` 拼接），
 *   但抽取工具的**正则**只取到第一段 → 生成的 CHECK **只有一半** →
 *   `scope = 'developer'` 的行**永远无法插入**（「开发者级插件配置」在数据库层面不可能）。
 *
 *   ★ 而 **`db:check` 发现不了它**——因为它对比的是「DDL vs 快照」，
 *     而**快照本身就是抽取产物**：抽取层有损时，两边一致（都缺）。
 *
 * ★★ 本工具补上这个盲区：**直接对比「文档声明」与「抽取产物」**，
 *   按「表 → 列 / 索引 / 约束」逐项核对数量。
 *
 * ★ 用法：
 *   node --experimental-strip-types tools/design-vs-impl.ts
 *   node --experimental-strip-types tools/design-vs-impl.ts --self-test
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从文档的代码围栏里切出**每张表的定义块**。 */
export function extractDocTables(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  // ★ 两步法（比单个复杂正则可靠）：
  //   ① 找每个 `defineTable('ag_xxx', {` 的**起始**；
  //   ② 从起始往后按**花括号配平**找到该表定义的结束——
  //      这样 `}, (t) => [ … ])` 里的索引/约束声明**都在 body 里**。
  //   ★ 我前两版用单正则，都漏掉了索引（自测报「索引 0，期望 1」）。
  // ★ 允许 `defineTable(` 与表名之间有**空白/换行**——
  //   抽取产物的格式是 `defineTable(\n    'ag_users',`（换行），
  //   而文档是 `defineTable('ag_users', {`（同行）。
  const head = /defineTable\(\s*'(ag_[a-z_]+)'\s*,\s*\{/g;
  for (const m of doc.matchAll(head)) {
    const name = m[1]!;
    // ★★★ 关键：配平必须从 **`defineTable(` 的 `(`** 开始，按**圆括号**配对——
    //   因为索引/约束声明在 `}, (t) => [ … ])` 里，即**表体的 `}` 之后**。
    //   ★ 我前几版按**花括号**配平（从表体的 `{` 起），于是在表体的 `}` 处就停了，
    //     `t.unique(...)` 全被漏掉——自测一直报「索引 0（期望 1）」。
    const openParen = doc.lastIndexOf('(', m.index! + m[0]!.length - 1);
    let depth = 1;
    let i = openParen + 1;
    while (i < doc.length && depth > 0) {
      const ch = doc[i]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    out.set(name, doc.slice(openParen + 1, i - 1));
  }
  return out;
}

/** 统计一段表定义里的**列数**（`xxx: col.` 形式）。 */
export function countColumns(body: string): number {
  // ★ 缩进**不固定**：文档里是 2 空格，抽取产物里是 6 空格（嵌套在 `declare(` 里）。
  //   ★ 我第一版写死 `^\s{2}`，于是**抽取产物的列数恒为 0**——
  //     自测立刻报「文档 15 列 · 抽取 0 列」（这个自测救了我一次）。
  // ★ `:` 后的空白**不固定**——文档里既有 `siteId: col.uuid()`（一个空格），
  //   也有 `activatedAt:col.timestamp(…)`（**零个空格**）。
  //   ★ 我第一版要求 `\s+`（至少一个），于是漏掉了 `activatedAt`，
  //     把 `ag_policy_versions` 误报为「文档 13 列 · 抽取 14 列」。
  return [...body.matchAll(/^\s+[a-zA-Z][a-zA-Z0-9]*:\s*col\./gm)].length;
}

/** 统计 `t.unique` / `t.index` / `t.primaryKey` 的声明数。 */
export function countIndexes(body: string): number {
  return [...body.matchAll(/t\.(unique|index|primaryKey)\s*\(/g)].length;
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) {
    // ★ 自测：证明它能发现「列被丢弃」
    const doc = "defineTable('ag_demo', {\n  a: col.uuid(),\n  b: col.varchar(8),\n}, (t) => [\n  t.unique(['a'], { name: 'u' }),\n]);";
    const tables = extractDocTables(doc);
    const body = tables.get('ag_demo') ?? '';
    const cols = countColumns(body);
    const idx = countIndexes(body);
    const ok = tables.size === 1 && cols === 2 && idx === 1;
    process.stdout.write(
      `\n【设计 vs 实现 扫描自测】\n  ${ok ? '✅' : '❌'} 解析 1 表 / 2 列 / 1 索引（实际 ${tables.size}/${cols}/${idx}）\n` +
        `  ${ok ? '自测通过——扫描器能读到声明' : '**自测失败——扫描器不可信**'}\n`,
    );
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const doc = await readFile(path.join(ROOT, 'docs', '02-数据模型.md'), 'utf8');
  const docTables = extractDocTables(doc);

  // 抽取产物：★ 用**同一个**提取函数（圆括号配平）——
  //   我第一版这里用了**另一个**正则（截到 `}, (t)` 就停），
  //   于是抽取产物的索引数**恒为 0**，扫描结果全是「抽取 0 个」的假警报。
  //   ★ 教训：**同一件事用两份不同的解析代码**，必然出现不一致。
  const extTables = new Map<string, string>();
  for (const file of await readdir(path.join(ROOT, 'src', 'schema', 'tables'))) {
    if (!file.endsWith('.ts')) continue;
    const src = await readFile(path.join(ROOT, 'src', 'schema', 'tables', file), 'utf8');
    for (const [name, body] of extractDocTables(src)) extTables.set(name, body);
  }

  process.stdout.write('\n【设计声明 vs 实现产物 —— 细粒度扫描】\n\n');
  process.stdout.write(`文档声明：${docTables.size} 表 · 抽取产物：${extTables.size} 表\n\n`);

  const missing = [...docTables.keys()].filter((t) => !extTables.has(t));
  const extra = [...extTables.keys()].filter((t) => !docTables.has(t));

  // ★★★ 排除「文档修复项」（`tools/extract-doc-schema.ts` 的 `REPAIRS`）：
  //   文档里被修复的定义用 `>` 前缀标注（如 `> export const checkinEntitlements = …`），
  //   抽取器会把**修复前**的版本替换成修复版。
  //   ★ 因此「文档列数 < 抽取列数」在那些表上是**正常**的——
  //     我第一版没考虑它，把 5 张表误报为不一致。
  // ★★★ 可靠做法：**直接从 `REPAIRS` 读被修复的表名**——
  //   比靠文档里的 `>` 前缀推断可靠（`ag_actions_log` 的修复**没有**用 `>` 标注，
  //   于是我的前缀推断漏掉了它，把 D-6 加的 `traceId` 误报为不一致）。
  const repairedTables = new Set<string>();
  const extractorSrc = await readFile(path.join(ROOT, 'tools', 'extract-doc-schema.ts'), 'utf8');
  for (const m of extractorSrc.matchAll(/table:\s*'(ag_[a-z_]+)'/g)) repairedTables.add(m[1]!);
  // ★ 同时保留 `>` 前缀的推断（两条路径都收，宁可多排除）
  for (const m of doc.matchAll(/^>\s*export const [a-zA-Z]+ = defineTable\('(ag_[a-z_]+)'/gm)) {
    repairedTables.add(m[1]!);
  }

  let colMismatch = 0;
  let idxMismatch = 0;
  let skipped = 0;
  for (const [name, body] of docTables) {
    const ext = extTables.get(name);
    if (ext === undefined) continue;
    // ★ 被修复的表跳过数量对比（其差异是**设计上预期**的）
    if (repairedTables.has(name)) {
      skipped += 1;
      continue;
    }
    const dc = countColumns(body);
    const ec = countColumns(ext);
    const di = countIndexes(body);
    const ei = countIndexes(ext);
    if (dc !== ec) {
      colMismatch += 1;
      process.stdout.write(`  ⚠️  ${name}：文档 ${dc} 列 · 抽取 ${ec} 列\n`);
    }
    if (di !== ei) {
      idxMismatch += 1;
      process.stdout.write(`  ⚠️  ${name}：文档 ${di} 个索引/约束声明 · 抽取 ${ei} 个\n`);
    }
  }

  process.stdout.write(`\n★ 表级：丢失 ${missing.length} · 多出 ${extra.length}\n`);
  for (const t of missing) process.stdout.write(`   - ${t}（文档有，抽取没有）\n`);
  for (const t of extra) process.stdout.write(`   + ${t}（抽取有，文档没有）\n`);
  process.stdout.write(`★ 列数不一致的表：${colMismatch}\n★ 索引/约束数不一致的表：${idxMismatch}\n`);
  process.stdout.write(
    `★ 因「文档修复项」而跳过数量对比的表：${skipped}` +
      (skipped > 0 ? `（${[...repairedTables].join(', ')}）` : '') +
      '\n  · ★ 这些表在文档里有**修复前后两个版本**（`>` 前缀标注修复版），' +
      '抽取器会采用修复版，因此「文档列数 < 抽取列数」是**预期**的。\n',
  );

  process.stdout.write(
    `\n★ 诚实解读：\n` +
      `  · 本工具对比的是「文档声明」与「**抽取产物**」——\n` +
      `    ★ 这补上了 \`db:check\` 的盲区：它对比「DDL vs 快照」，而**快照本身就是抽取产物**，\n` +
      `      抽取层有损时两边一致（都缺），因此**发现不了**。\n` +
      `  · 列数/索引数一致**不等于**语义一致（如 CHECK 表达式的内容、枚举取值）——\n` +
      `    那需要人工或更强的手段；本工具只覆盖「数量级」的静默丢失。\n` +
      `  · ★ 刻意**不作为 CI 门禁**：数量差异需要人工判断（可能是刻意的重排）。\n`,
  );
}

// ★ 只在**直接执行**时跑 main（被 import 时不跑）——
//   否则任何 `import` 本文件都会**触发整个扫描**（我在调试时踩到过）。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) await main();
