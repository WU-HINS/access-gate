/**
 * 声明 → 规范化 IR 的转换器（冻结件实现）。
 *
 * 消费方（门禁 / DDL 编译 / 漂移检测）只读本文件的输出。
 */

import { COL, type ColumnSpec, type ColumnState, type TableDecl } from './dsl.ts';
import type { NormalizedColumn, NormalizedIndex, NormalizedTable } from './ir.ts';

const DOC = 'docs/02-数据模型.md';

/** camelCase → snake_case；连续大写（如 providerUserID 之外的缩写）按逐段处理。 */
export function toSnakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

export function tableColumns(table: NormalizedTable): string[] {
  return table.columns.map((c) => c.columnName);
}

export function getColumn(table: NormalizedTable, name: string): NormalizedColumn | undefined {
  const snake = toSnakeCase(name);
  return table.columns.find((c) => c.name === name || c.columnName === snake);
}

export function hasColumn(table: NormalizedTable, name: string): boolean {
  return getColumn(table, name) !== undefined;
}

function normalizeColumn(state: ColumnState, declaredText: string): NormalizedColumn {
  if (!state.name) throw new Error('列缺少属性名：声明必须写成 { someColumn: col.uuid() }');
  const column: NormalizedColumn = {
    name: state.name,
    columnName: toSnakeCase(state.name),
    kind: state.kind,
    nullable: state.primaryKey ? false : state.nullable,
    primaryKey: state.primaryKey,
    onUpdateNow: state.onUpdateNow,
    declaredText,
  };
  if (state.enumType !== undefined) column.enumType = state.enumType;
  if (state.enumValues !== undefined) column.enumValues = state.enumValues;
  if (state.length !== undefined) column.length = state.length;
  if (state.withTz !== undefined) column.withTz = state.withTz;
  if (state.precision !== undefined) column.precision = state.precision;
  if (state.scale !== undefined) column.scale = state.scale;
  if (state.defaultValue !== undefined) column.defaultValue = state.defaultValue;
  return column;
}

function normalizeIndex(raw: NormalizedIndex, tableName: string): NormalizedIndex {
  const kind: 'unique' | 'index' = raw.unique ? 'unique' : 'index';
  const prefix = kind === 'unique' ? 'uq' : 'ix';
  const name =
    raw.name && raw.name.length > 0
      ? raw.name
      : `${prefix}_${tableName.replace(/^ag_/, '')}_${raw.columns.map(toSnakeCase).join('_')}`;
  const normalized: NormalizedIndex = {
    name,
    columns: raw.columns.map(toSnakeCase),
    unique: raw.unique,
    kind,
  };
  if (raw.where !== undefined) normalized.where = raw.where;
  return normalized;
}

/** 缺省来源（未标注 source 的声明，例如测试夹具）。 */
const DEFAULT_SOURCE = { doc: DOC, line: 0 };

export function normalizeTable(decl: TableDecl): NormalizedTable {
  const columns = decl.columns.map((spec: ColumnSpec) => {
    const state = spec[COL] as ColumnState;
    const text = `${state.name}: ${state.kind}`;
    return normalizeColumn(state, text);
  });

  const indexes = decl.indexes.map((i) => normalizeIndex(i, decl.name));
  const tableName = decl.name;
  const opts = decl.options;

  const hasScopeColumn = columns.some((c) => c.columnName === 'scope');
  const siteIdColumn = columns.find((c) => c.columnName === 'site_id');
  const dualScoped =
    opts.dualScopeCheck !== undefined ||
    (hasScopeColumn &&
      columns.some((c) => c.columnName === 'developer_id') &&
      siteIdColumn !== undefined &&
      siteIdColumn.nullable);

  const table: NormalizedTable = {
    tableName,
    declName: decl.declName,
    columns,
    indexes,
    checks: decl.checks,
    siteScoped: opts.siteScoped ?? true,
    siteScopedExplicit: opts.siteScoped !== undefined,
    dualScoped,
    source: decl.source ?? DEFAULT_SOURCE,
  };
  if (decl.primaryKey !== undefined) table.primaryKey = decl.primaryKey.columns.map(toSnakeCase);
  if (opts.exemptReason !== undefined) table.exemptReason = opts.exemptReason;
  return table;
}

export function normalizeTables(decls: readonly TableDecl[]): NormalizedTable[] {
  return decls.map(normalizeTable);
}

/** 全部列名（snake_case）—— 门禁与 DDL 编译的公共入口。 */
export function columnNames(table: NormalizedTable): Set<string> {
  return new Set(table.columns.map((c) => c.columnName));
}

/**
 * 主键列（保序）。
 *
 * ★ 必须同时处理两种声明形态：列级 `.primaryKey()` 与表级 `t.primaryKey([...])`。
 *   早期版本只看列级标记，对复合主键返回 `[]`——任何消费方误用都会**静默丢主键**
 *   （DDL 少一个 PRIMARY KEY，而漂移检测两边同时忽略它，于是报 0 漂移）。
 *   编译器侧请优先用 `compile/ddl.ts` 的 `tablePrimaryKey()`；本函数保持同一口径。
 */
export function primaryKeyColumns(table: NormalizedTable): string[] {
  if (table.primaryKey !== undefined && table.primaryKey.length > 0) return [...table.primaryKey];
  return table.columns.filter((c) => c.primaryKey).map((c) => c.columnName);
}

export function nullableColumns(table: NormalizedTable): string[] {
  return table.columns.filter((c) => c.nullable).map((c) => c.columnName);
}
