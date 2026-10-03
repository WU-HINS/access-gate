/**
 * `npm run db:generate` —— IR → PostgreSQL DDL 文件。
 *
 * 产物（**禁止手写，必须由本命令产出**）：
 *   - `migrations/0001_init.sql`：带头部注释的完整迁移
 *   - `sql/schema.sql`：纯 DDL 快照（CI 用它做「编译产物 snapshot 对比」）
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { compileSchema, collectEnumTypes } from '../src/schema/compile/ddl.ts';
import { describeSource, loadTables } from '../src/schema/compile/load-tables.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '0001_init.sql');
const SNAPSHOT_PATH = path.join(ROOT, 'sql', 'schema.sql');

function migrationHeader(tableCount: number, enumCount: number, indexCount: number, source: string): string {
  return [
    '-- access-gate 初始化迁移（0001_init）',
    '--',
    '-- ⚠ 自动生成，请勿手改：本文件由 `npm run db:generate` 从 Schema 声明层 IR 推导。',
    '--    （契约见 docs/12-Schema声明层接口契约.md §5.2「DDL 禁止手写」）',
    `-- 来源：${source}`,
    `-- 规模：表 ${tableCount} · 枚举 ${enumCount} · 索引 ${indexCount}`,
    '-- 复跑：npm run db:generate && npm run db:migrate && npm run db:check',
    '',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const requireReal = process.argv.includes('--require-real');
  const loaded = await loadTables({ requireReal });
  const compiled = compileSchema(loaded.tables);
  const enumCount = collectEnumTypes(loaded.tables).size;
  const indexCount = compiled.indexes.length;
  const triggerTables = new Set(
    compiled.plan.filter((s) => s.kind === 'function').map((s) => s.table ?? ''),
  ).size;

  const source = describeSource(loaded);
  const header = migrationHeader(compiled.tables.length, enumCount, indexCount, source);

  await mkdir(path.dirname(MIGRATION_PATH), { recursive: true });
  await mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(MIGRATION_PATH, header + compiled.sql, 'utf8');
  await writeFile(SNAPSHOT_PATH, compiled.sql, 'utf8');

  for (const warning of loaded.warnings) console.warn(`WARN: ${warning}`);
  console.log('db:generate 完成');
  console.log(`  来源              : ${source}`);
  console.log(`  表  (CREATE TABLE): ${compiled.tables.length}`);
  console.log(`  枚举(CREATE TYPE) : ${enumCount}`);
  console.log(`  索引(CREATE INDEX): ${indexCount}`);
  console.log(`  onUpdateNow 触发器表: ${triggerTables}`);
  console.log(`  语句总数          : ${compiled.plan.length}`);
  console.log(`  写入              : ${path.relative(ROOT, MIGRATION_PATH)}`);
  console.log(`  写入              : ${path.relative(ROOT, SNAPSHOT_PATH)}`);

  if (loaded.source === 'fixture') {
    console.warn('WARN: 真实声明尚未就绪——以上产物由**夹具表**生成，不是 M0 验收对象。');
  }
}

try {
  await main();
} catch (error) {
  console.error('');
  console.error(`FAIL(db:generate): ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
