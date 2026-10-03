/**
 * 字段消费扫描 —— **「写入的列有没有读取者」**（R125）。
 *
 * ★★★ 为什么需要它（先例，**4 次同族缺陷**）：
 *   | 轮次 | 发现 | 形态 |
 *   |---|---|---|
 *   | R62  | `ag_checkin_records` 等表**从不读写** | 「表建了，代码不用」 |
 *   | R98  | `createNewApiProvider` **从未装配**（桩伪装） | 「实现写了，没接线」 |
 *   | R123 | `baseline` 列**零使用** | 「列建了，代码不用」 |
 *   | R124 | `collectedAt` **有值，但判定时不用** | 「数据有了，读取侧不用」 |
 *
 *   ★ 四次都是**同一族**：**「上游产物已就绪，下游没消费」**。
 *
 * ★★ 本工具覆盖其中**最可靠可自动化**的一类：**某列在 DDL 里有，而在 `src/**` 里零出现**
 *   （除 schema 声明层本身）。★ 这一类的判定**不需要语义理解**，因此**假阳性极低**。
 *
 * ★ 局限（**写在输出里，不夸大**）：
 *   ① 「出现了」**不等于**「被读取」——列名可能只出现在写入侧（这正是 R124 的形态，
 *      本工具**发现不了**，需要更细的读/写区分）；
 *   ② 「零出现」里有一部分是**正当的**（如预留列、审计列、由数据库触发器/默认值写入的列）。
 *   ★ 因此本工具**不作为 CI 门禁**，而是**复查用的信号源**。
 *
 * 用法：
 *   node --experimental-strip-types tools/field-consumption.ts
 *   node --experimental-strip-types tools/field-consumption.ts --self-test
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从 DDL 文本里提取 `CREATE TABLE <name> ( col type, … )` 的列名。 */
export function extractTableColumns(ddl: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of ddl.matchAll(/CREATE TABLE (ag_[a-z_]+) \(([\s\S]*?)\n\);/g)) {
    const name = m[1]!;
    const body = m[2]!;
    const cols: string[] = [];
    for (const line of body.split('\n')) {
      const mm = /^\s{2}([a-z][a-z0-9_]*)\s+[a-z]/.exec(line);
      if (mm !== null) cols.push(mm[1]!);
    }
    out.set(name, cols);
  }
  return out;
}

/**
 * 判断某列名在**非 schema 声明**的源码里是否出现。
 *
 * ★ 排除 `src/schema/tables/**`（那是声明层，列名**必然**出现）——
 *   ★ 否则每一列都会「出现」，工具恒真。
 */
export function appearsOutsideSchema(sources: readonly { file: string; text: string }[], column: string): boolean {
  const re = new RegExp(`\\b${column}\\b`);
  return sources.some((s) => re.test(s.text));
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) {
    const ddl = 'CREATE TABLE ag_demo (\n  id uuid NOT NULL,\n  used_col text,\n  orphan_col text,\n);';
    const cols = extractTableColumns(ddl).get('ag_demo') ?? [];
    const sources = [{ file: 'a.ts', text: 'const x = row.used_col;' }];
    const ok =
      cols.length === 3 &&
      appearsOutsideSchema(sources, 'used_col') === true &&
      appearsOutsideSchema(sources, 'orphan_col') === false;
    process.stdout.write(
      `\n【字段消费扫描 自测】\n  ${ok ? '✅' : '❌'} 提取 ${cols.length}/3 列 · used_col=${appearsOutsideSchema(sources, 'used_col')} · orphan_col=${appearsOutsideSchema(sources, 'orphan_col')}\n` +
        `  ${ok ? '自测通过——能提取列且能区分「有消费者/无消费者」' : '**自测失败——扫描器不可信**'}\n`,
    );
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const ddl = await readFile(path.join(ROOT, 'migrations', '0001_init.sql'), 'utf8');
  const tables = extractTableColumns(ddl);

  // ★ 只收集**非声明层**的源码（排除 src/schema/）
  const files = (await walk(path.join(ROOT, 'src'))).filter((f) => !f.includes(`${path.sep}schema${path.sep}`));
  const sources = await Promise.all(files.map(async (f) => ({ file: path.relative(ROOT, f), text: await readFile(f, 'utf8') })));

  process.stdout.write('\n【字段消费扫描：DDL 里有、src/（非声明层）里零出现的列】\n\n');
  process.stdout.write(`  · 表：${tables.size} · 非声明层源文件：${sources.length}\n\n`);

  const orphans: { table: string; column: string }[] = [];
  let total = 0;
  for (const [table, cols] of tables) {
    for (const col of cols) {
      total += 1;
      if (!appearsOutsideSchema(sources, col)) orphans.push({ table, column: col });
    }
  }
  process.stdout.write(`  · 列总数：${total} · **零消费者**：${orphans.length}\n\n`);
  for (const o of orphans) process.stdout.write(`      · ${o.table}.${o.column}\n`);
  process.stdout.write(
    `\n★ 诚实解读（按重要度）：\n` +
      `  ① 「零出现」**不等于**「缺陷」——预留列 / 审计列 / 由 DB 默认值或触发器写入的列，\n` +
      `     天然没有代码消费者。★ 因此这是**信号源**，不是结论。\n` +
      `  ② 本工具**发现不了** R124 那一类（\`collectedAt\` **有值但判定时不用**）——\n` +
      `     因为该列名确实出现在写入侧。★ 那需要**区分读/写**，是更强的分析。\n` +
      `  ③ 排除 \`src/schema/**\` 是**必要**的——否则声明层会让每一列都「出现」，工具恒真。\n`,
  );
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) await main();
