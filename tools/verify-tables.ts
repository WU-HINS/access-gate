#!/usr/bin/env node
/**
 * tools/verify-tables.ts —— 对**真实声明**做结构自检（提取阶段的可复跑验收）。
 *
 * 检查项：
 *  1. 表数 == 40，且每张表至少 1 列；
 *  2. 每张表有主键（单列 primaryKey 或复合 t.primaryKey）；
 *  3. 无空列索引 / 无重复索引名 / 无重复列名；
 *  4. siteScoped:true 的表必须有 site_id 列（02 §3.10 的 fail-fast 保护）；
 *  5. 打印 R1–R6 门禁结论（由 src/schema/gate 提供）。
 */
import { readFileSync } from 'node:fs';
import { allTables } from '../src/schema/tables/index.ts';
import { normalizeTables, primaryKeyColumns } from '../src/schema/normalize.ts';
import { checkScopeRules, formatViolations, hasErrors } from '../src/schema/gate/scope.ts';

const tables = normalizeTables(allTables);
const problems: string[] = [];
const notes: string[] = [];

// ★ 表数期望**不再硬编码**：改为与 `docs/02 §2「领域划分」`清单**同源**比对。
//   硬编码的 40 在表数增至 47 后一直报 ❌ —— 本工具因此**退出码恒为 1、等于空转**，
//   而"空转的门禁"正是本仓库反复记下的形态（第 5 代 N1：不可执行的断言）。
//   宁可**解析失败即报错**，也不静默通过。
const doc02 = readFileSync(new URL('../docs/02-数据模型.md', import.meta.url), 'utf8');
const domainSection = /##\s*2\.\s*领域划分([\s\S]*?)```([\s\S]*?)```/.exec(doc02);
const domainNames = new Set(
  [...(domainSection?.[2] ?? '').matchAll(/ag_[a-z0-9_]+/g)].map((m) => m[0]),
);
if (domainSection === null) {
  problems.push('无法从 docs/02 §2「领域划分」解析域清单——表数一致性无法校验（拒绝静默通过）');
} else if (domainNames.size !== tables.length) {
  problems.push(`表数 ${tables.length} 与 docs/02 §2 域清单 ${domainNames.size} 不一致`);
}

for (const t of tables) {
  if (t.columns.length === 0) problems.push(`${t.tableName}: 没有任何列`);
  // ★ 判据必须区分「列级主键」与「表级复合主键」两种**声明形态**；
  //   不能拿 primaryKeyColumns()（它会把两者统一成结果）去判互斥，否则自相矛盾。
  const columnLevelPk = t.columns.filter((c) => c.primaryKey).map((c) => c.columnName);
  const composite = t.primaryKey ?? [];
  if (columnLevelPk.length === 0 && composite.length === 0) {
    notes.push(`${t.tableName}: 无代理主键（以自然键 uq_* 为主键语义）——02 本身如此设计，仅记录`);
  }
  if (columnLevelPk.length > 0 && composite.length > 0) {
    problems.push(`${t.tableName}: 同时有列级主键与表级复合主键（互斥）`);
  }
  // 无论哪种形态，最终必须能算出主键列；若确实没有代理主键，则必须有唯一键承担自然键语义
  // （02 的 ag_plugin_storage 就是这种设计：主键语义由 uq_ag_plugin_storage 承担）
  if (primaryKeyColumns(t).length === 0) {
    const hasNaturalKey = t.indexes.some((i) => i.unique);
    if (!hasNaturalKey) {
      problems.push(`${t.tableName}: 既无主键也无唯一键——无法定位行，DDL 会缺主键语义`);
    }
  }
  const colNames = t.columns.map((c) => c.columnName);
  const dupCols = colNames.filter((c, i) => colNames.indexOf(c) !== i);
  if (dupCols.length) problems.push(`${t.tableName}: 重复列 ${[...new Set(dupCols)].join(',')}`);
  const idxNames = t.indexes.map((i) => i.name);
  const dupIdx = idxNames.filter((c, i) => idxNames.indexOf(c) !== i);
  if (dupIdx.length) problems.push(`${t.tableName}: 重复索引名 ${[...new Set(dupIdx)].join(',')}`);
  for (const i of t.indexes) {
    if (i.columns.length === 0) problems.push(`${t.tableName}: 索引 ${i.name} 无列`);
  }
  // 02 §3.10 的 fail-fast 只对**显式**声明 siteScoped:true 的表成立；
  // 缺省值不能当判据（否则平台级表会被误报——见 reports/schema-doc-defects.md §2.4）。
  const explicitSiteScoped = allTables.find((d) => d.name === t.tableName)?.options.siteScoped === true;
  if (explicitSiteScoped && !colNames.includes('site_id')) {
    problems.push(`${t.tableName}: 显式 siteScoped=true 但缺 site_id 列（02 §3.10 fail-fast）`);
  }
}

const violations = checkScopeRules(tables);
console.log(`表数: ${tables.length}`);
console.log(`列总数: ${tables.reduce((n, t) => n + t.columns.length, 0)}`);
console.log(`索引总数: ${tables.reduce((n, t) => n + t.indexes.length, 0)}`);
console.log(`枚举数: ${new Set(tables.flatMap((t) => t.columns.filter((c) => c.kind === 'enum').map((c) => c.enumType))).size}`);
console.log('');
console.log('结构自检:');
if (problems.length === 0) console.log('  ✅ 无问题');
else for (const p of problems) console.log(`  ❌ ${p}`);
for (const n of notes) console.log(`  ℹ️  ${n}`);
console.log('');
console.log(`门禁 R1–R6: ${violations.length} 条（error ${violations.filter((v) => v.severity === 'error').length} / warn ${violations.filter((v) => v.severity === 'warn').length}）`);
console.log(formatViolations(violations));
process.exit(problems.length === 0 ? 0 : 1);
