/**
 * 漂移检测（drift detection）：活库结构 ↔ 规范化 IR 的对比。
 *
 * 冻结件：`docs/12-Schema声明层接口契约.md` §5.3。
 *   - 列：`information_schema.columns`
 *   - 索引：`pg_index` + `pg_class` + `pg_get_indexdef()`
 *   - 主键：`pg_constraint`（`contype='p'`）
 * 比较口径：**只比较 IR 中被声明的属性**（PG 自动生成的东西不参与比较）。
 *
 * 本文件里的 SQL 一律写成**不带插值的普通字符串字面量**——`src/**` 受 CI「禁止裸 SQL」扫描约束。
 */

import { PGlite } from '@electric-sql/pglite';
import type { DriftFinding, NormalizedColumn, NormalizedIndex, NormalizedTable } from '../ir.ts';
import type { CompiledSchema, CompiledStatement } from './ddl.ts';
import { effectiveNullable, renderDefault, tablePrimaryKey } from './ddl.ts';

// ───────────────────────────── 活库结构 ─────────────────────────────

export interface LiveColumn {
  columnName: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  columnDefault: string | null;
  characterMaximumLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
}

export interface LiveIndex {
  name: string;
  tableName: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
  predicate: string | null;
}

export interface LiveSchema {
  tables: string[];
  columns: Map<string, LiveColumn[]>;
  indexes: Map<string, LiveIndex[]>;
  primaryKeys: Map<string, string[]>;
  enums: Map<string, string[]>;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

interface IndexRow {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_primary: boolean;
  predicate: string | null;
  columns: string[] | null;
}

interface PrimaryKeyRow {
  table_name: string;
  columns: string[] | null;
}

interface EnumRow {
  enum_name: string;
  labels: string[];
}

const SQL_TABLES = [
  'SELECT table_name',
  'FROM information_schema.tables',
  "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  'ORDER BY table_name',
].join(' ');

const SQL_COLUMNS = [
  'SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,',
  'character_maximum_length, numeric_precision, numeric_scale',
  'FROM information_schema.columns',
  "WHERE table_schema = 'public'",
  'ORDER BY table_name, ordinal_position',
].join(' ');

const SQL_INDEXES = [
  'SELECT c.relname AS table_name, ic.relname AS index_name,',
  'i.indisunique AS is_unique, i.indisprimary AS is_primary,',
  'pg_get_expr(i.indpred, i.indrelid) AS predicate,',
  '(SELECT array_agg(a.attname ORDER BY k.ord)',
  ' FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)',
  ' JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns',
  'FROM pg_index i',
  'JOIN pg_class c ON c.oid = i.indrelid',
  'JOIN pg_class ic ON ic.oid = i.indexrelid',
  'JOIN pg_namespace n ON n.oid = c.relnamespace',
  "WHERE n.nspname = 'public'",
  'ORDER BY c.relname, ic.relname',
].join(' ');

const SQL_PRIMARY_KEYS = [
  'SELECT c.relname AS table_name,',
  '(SELECT array_agg(a.attname ORDER BY k.ord)',
  ' FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)',
  ' JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns',
  'FROM pg_constraint con',
  'JOIN pg_class c ON c.oid = con.conrelid',
  'JOIN pg_namespace n ON n.oid = c.relnamespace',
  "WHERE n.nspname = 'public' AND con.contype = 'p'",
  'ORDER BY c.relname',
].join(' ');

const SQL_ENUMS = [
  'SELECT t.typname AS enum_name,',
  'array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels',
  'FROM pg_type t',
  'JOIN pg_enum e ON e.enumtypid = t.oid',
  'JOIN pg_namespace n ON n.oid = t.typnamespace',
  "WHERE n.nspname = 'public'",
  'GROUP BY t.typname ORDER BY t.typname',
].join(' ');

/** 读回活库结构。 */
export async function introspect(db: PGlite): Promise<LiveSchema> {
  const tableRows = await db.query<{ table_name: string }>(SQL_TABLES);
  const columnRows = await db.query<ColumnRow>(SQL_COLUMNS);
  const indexRows = await db.query<IndexRow>(SQL_INDEXES);
  const pkRows = await db.query<PrimaryKeyRow>(SQL_PRIMARY_KEYS);
  const enumRows = await db.query<EnumRow>(SQL_ENUMS);

  const columns = new Map<string, LiveColumn[]>();
  for (const row of columnRows.rows) {
    const list = columns.get(row.table_name) ?? [];
    list.push({
      columnName: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      nullable: row.is_nullable === 'YES',
      columnDefault: row.column_default,
      characterMaximumLength: row.character_maximum_length,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
    });
    columns.set(row.table_name, list);
  }

  const indexes = new Map<string, LiveIndex[]>();
  for (const row of indexRows.rows) {
    const list = indexes.get(row.table_name) ?? [];
    list.push({
      name: row.index_name,
      tableName: row.table_name,
      unique: row.is_unique,
      primary: row.is_primary,
      columns: row.columns ?? [],
      predicate: row.predicate,
    });
    indexes.set(row.table_name, list);
  }

  const primaryKeys = new Map<string, string[]>();
  for (const row of pkRows.rows) primaryKeys.set(row.table_name, row.columns ?? []);

  const enums = new Map<string, string[]>();
  for (const row of enumRows.rows) enums.set(row.enum_name, row.labels ?? []);

  return {
    tables: tableRows.rows.map((r) => r.table_name),
    columns,
    indexes,
    primaryKeys,
    enums,
  };
}

// ───────────────────────────── 归一化比较口径 ─────────────────────────────

/** 去掉 PG 在 `column_default` 里补的类型转换后缀（`'pending'::character varying` → `'pending'`）。 */
export function stripDefaultCast(actual: string): string {
  return actual
    .replace(
      /::[a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_]*)*(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?$/i,
      '',
    )
    .trim();
}

export function normalizeDefault(text: string | null): string | null {
  if (text === null) return null;
  let out = stripDefaultCast(text).trim();
  // 去掉最外层括号：`(deleted_at IS NULL)` → `deleted_at IS NULL`
  while (out.startsWith('(') && out.endsWith(')')) out = out.slice(1, -1).trim();
  return out.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 部分索引谓词归一化。
 * PG 会 ① 补外层括号 ② 把枚举/域类型字面量反解成显式转换：
 *   `status = 'enabled'` → `(status = 'enabled'::ag_plugin_status)`
 * 因此比较前去掉全部 `::type` 转换（语义不变，纯文本口径差异）。
 */
export function normalizePredicate(text: string | null): string | null {
  if (text === null || text.trim().length === 0) return null;
  let out = text.trim();
  while (out.startsWith('(') && out.endsWith(')')) out = out.slice(1, -1).trim();
  out = out.replace(/::[a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_]*)*(?:\([^)]*\))?/gi, '');
  return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface ExpectedType {
  dataType: string;
  udtName: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
}

/** IR 列 → PG 的 (data_type, udt_name, 长度/精度)。 */
export function expectedType(column: NormalizedColumn): ExpectedType {
  switch (column.kind) {
    case 'uuid':
      return { dataType: 'uuid', udtName: 'uuid', length: null, precision: null, scale: null };
    case 'varchar':
      return {
        dataType: 'character varying',
        udtName: 'varchar',
        length: column.length ?? null,
        precision: null,
        scale: null,
      };
    case 'text':
      return { dataType: 'text', udtName: 'text', length: null, precision: null, scale: null };
    case 'boolean':
      return { dataType: 'boolean', udtName: 'bool', length: null, precision: null, scale: null };
    case 'integer':
      return { dataType: 'integer', udtName: 'int4', length: null, precision: null, scale: null };
    case 'bigint':
    case 'bigserial':
      return { dataType: 'bigint', udtName: 'int8', length: null, precision: null, scale: null };
    case 'numeric':
      return {
        dataType: 'numeric',
        udtName: 'numeric',
        length: null,
        precision: column.precision ?? null,
        scale: column.scale ?? null,
      };
    case 'jsonb':
      return { dataType: 'jsonb', udtName: 'jsonb', length: null, precision: null, scale: null };
    case 'timestamp':
      return column.withTz === false
        ? {
            dataType: 'timestamp without time zone',
            udtName: 'timestamp',
            length: null,
            precision: null,
            scale: null,
          }
        : {
            dataType: 'timestamp with time zone',
            udtName: 'timestamptz',
            length: null,
            precision: null,
            scale: null,
          };
    case 'date':
      return { dataType: 'date', udtName: 'date', length: null, precision: null, scale: null };
    case 'binary':
      // PG 的 bytea 无长度属性 → length 不参与比较。
      return { dataType: 'bytea', udtName: 'bytea', length: null, precision: null, scale: null };
    case 'enum':
      return {
        dataType: 'USER-DEFINED',
        udtName: column.enumType ?? '',
        length: null,
        precision: null,
        scale: null,
      };
    default: {
      const never: never = column.kind;
      throw new Error(`未知列类型：${String(never)}`);
    }
  }
}

/** 期望的默认值文本（PG 归一化后风格）；`undefined` 表示 IR 未声明默认值 → 不比较。 */
export function expectedDefault(column: NormalizedColumn): string | undefined {
  const rendered = renderDefault(column);
  if (rendered === undefined) return undefined;
  return normalizeDefault(rendered.slice('DEFAULT '.length)) ?? undefined;
}

// ───────────────────────────── 差异比对 ─────────────────────────────

function indexSignature(index: { columns: string[]; unique: boolean; predicate: string | null }): string {
  const where = normalizePredicate(index.predicate);
  return `${index.unique ? 'unique' : 'index'}(${index.columns.join(',')})${where === null ? '' : ` where ${where}`}`;
}

/** IR ↔ 活库：只比较 IR 声明的属性，返回全部差异。 */
export function diffSchema(tables: readonly NormalizedTable[], live: LiveSchema): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const liveTables = new Set(live.tables);
  const irTables = new Map(tables.map((t) => [t.tableName, t]));

  for (const table of tables) {
    if (!liveTables.has(table.tableName)) {
      findings.push({
        tableName: table.tableName,
        kind: 'missing-table',
        detail: `IR 声明了 ${table.tableName}，活库中不存在`,
        expected: table.tableName,
        actual: '<无>',
      });
    }
  }
  for (const name of live.tables) {
    if (!irTables.has(name)) {
      findings.push({
        tableName: name,
        kind: 'extra-table',
        detail: `活库中存在 ${name}，IR 未声明`,
        expected: '<无>',
        actual: name,
      });
    }
  }

  for (const table of tables) {
    if (!liveTables.has(table.tableName)) continue;
    const liveColumns = live.columns.get(table.tableName) ?? [];
    const byName = new Map(liveColumns.map((c) => [c.columnName, c]));

    for (const column of table.columns) {
      const actual = byName.get(column.columnName);
      if (actual === undefined) {
        findings.push({
          tableName: table.tableName,
          kind: 'missing-column',
          detail: `IR 声明了列 ${table.tableName}.${column.columnName}（${column.kind}），活库中不存在`,
          expected: column.kind,
          actual: '<无>',
        });
        continue;
      }
      byName.delete(column.columnName);

      const want = expectedType(column);
      if (actual.udtName !== want.udtName || actual.dataType.toLowerCase() !== want.dataType.toLowerCase()) {
        findings.push({
          tableName: table.tableName,
          kind: 'type',
          detail: `列 ${column.columnName} 类型不一致`,
          expected: `${want.dataType} (udt=${want.udtName})`,
          actual: `${actual.dataType} (udt=${actual.udtName})`,
        });
      }
      if (column.kind === 'varchar' && want.length !== null && actual.characterMaximumLength !== want.length) {
        findings.push({
          tableName: table.tableName,
          kind: 'length',
          detail: `列 ${column.columnName} 长度不一致`,
          expected: String(want.length),
          actual: actual.characterMaximumLength === null ? '<无>' : String(actual.characterMaximumLength),
        });
      }
      if (column.kind === 'numeric' && want.precision !== null) {
        if (actual.numericPrecision !== want.precision || actual.numericScale !== (want.scale ?? 0)) {
          findings.push({
            tableName: table.tableName,
            kind: 'length',
            detail: `列 ${column.columnName} numeric 精度/标度不一致`,
            expected: `${want.precision},${want.scale ?? 0}`,
            actual: `${actual.numericPrecision ?? '<无>'},${actual.numericScale ?? '<无>'}`,
          });
        }
      }
      if (actual.nullable !== effectiveNullable(table, column)) {
        findings.push({
          tableName: table.tableName,
          kind: 'nullability',
          detail: `列 ${column.columnName} 可空性不一致`,
          expected: effectiveNullable(table, column) ? 'NULL' : 'NOT NULL',
          actual: actual.nullable ? 'NULL' : 'NOT NULL',
        });
      }
      // 只比较 IR **声明了**默认值的列：PG 把「未声明」与 `DEFAULT NULL` 都表现为 column_default IS NULL，
      // 因此 `DEFAULT NULL` 与「无默认值」视为等价（bigserial 的 nextval(...) 属 PG 自动生成，不比较）。
      const wantDefault = expectedDefault(column);
      if (wantDefault !== undefined) {
        const actualDefault = normalizeDefault(actual.columnDefault);
        const wantNormalized = wantDefault === 'null' ? null : wantDefault;
        if (wantNormalized !== actualDefault) {
          findings.push({
            tableName: table.tableName,
            kind: 'default',
            detail: `列 ${column.columnName} 默认值不一致`,
            expected: wantNormalized ?? '<无>',
            actual: actualDefault ?? '<无>',
          });
        }
      }
    }

    for (const leftover of byName.values()) {
      findings.push({
        tableName: table.tableName,
        kind: 'extra-column',
        detail: `活库中存在列 ${table.tableName}.${leftover.columnName}，IR 未声明`,
        expected: '<无>',
        actual: `${leftover.dataType} (udt=${leftover.udtName})`,
      });
    }

    const wantPk = tablePrimaryKey(table);
    const actualPk = live.primaryKeys.get(table.tableName) ?? [];
    if (wantPk.join(',') !== actualPk.join(',')) {
      findings.push({
        tableName: table.tableName,
        kind: 'primary-key',
        detail: `主键成员/顺序不一致`,
        expected: wantPk.length === 0 ? '<无>' : wantPk.join(', '),
        actual: actualPk.length === 0 ? '<无>' : actualPk.join(', '),
      });
    }

    const liveIndexes = live.indexes.get(table.tableName) ?? [];
    const irIndexes = new Map<string, NormalizedIndex>(table.indexes.map((i) => [i.name, i]));
    for (const index of table.indexes) {
      const actual = liveIndexes.find((i) => i.name === index.name);
      if (actual === undefined) {
        findings.push({
          tableName: table.tableName,
          kind: 'missing-index',
          detail: `IR 声明了索引 ${index.name}，活库中不存在`,
          expected: indexSignature({ columns: [...index.columns], unique: index.unique, predicate: index.where ?? null }),
          actual: '<无>',
        });
        continue;
      }
      const want = indexSignature({
        columns: [...index.columns],
        unique: index.unique,
        predicate: index.where ?? null,
      });
      const got = indexSignature({
        columns: actual.columns,
        unique: actual.unique,
        predicate: actual.predicate,
      });
      if (want !== got) {
        findings.push({
          tableName: table.tableName,
          kind: 'index-definition',
          detail: `索引 ${index.name} 定义不一致`,
          expected: want,
          actual: got,
        });
      }
    }
    for (const actual of liveIndexes) {
      // PG 为主键自动创建的索引不参与比较（IR 不把它当索引声明）。
      if (actual.primary) continue;
      if (!irIndexes.has(actual.name)) {
        findings.push({
          tableName: table.tableName,
          kind: 'extra-index',
          detail: `活库中存在索引 ${actual.name}，IR 未声明`,
          expected: '<无>',
          actual: indexSignature({
            columns: actual.columns,
            unique: actual.unique,
            predicate: actual.predicate,
          }),
        });
      }
    }
  }

  // 枚举
  const wantEnums = new Map<string, readonly string[]>();
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.kind !== 'enum' || column.enumType === undefined) continue;
      if (!wantEnums.has(column.enumType)) wantEnums.set(column.enumType, column.enumValues ?? []);
    }
  }
  for (const [name, values] of wantEnums) {
    const actual = live.enums.get(name);
    if (actual === undefined) {
      findings.push({
        tableName: '<enum>',
        kind: 'missing-enum',
        detail: `IR 声明了枚举 ${name}，活库中不存在`,
        expected: values.join(', '),
        actual: '<无>',
      });
      continue;
    }
    if (values.join(',') !== actual.join(',')) {
      findings.push({
        tableName: '<enum>',
        kind: 'enum-values',
        detail: `枚举 ${name} 取值/顺序不一致`,
        expected: values.join(', '),
        actual: actual.join(', '),
      });
    }
  }
  for (const name of live.enums.keys()) {
    if (!wantEnums.has(name)) {
      findings.push({
        tableName: '<enum>',
        kind: 'extra-enum',
        detail: `活库中存在枚举 ${name}，IR 未声明`,
        expected: '<无>',
        actual: name,
      });
    }
  }

  return findings;
}

// ───────────────────────────── 建库 ─────────────────────────────

export interface OpenOptions {
  /** 可选持久化目录；缺省进程内内存实例（避免大量磁盘 IO） */
  dataDir?: string;
}

/**
 * DDL 执行目标（**结构接口**）。
 *
 * ★ 为什么需要它：迁移最初只支持 PGlite（`openDatabase` 返回 `PGlite`），
 *   而**生产的 PostgreSQL 是外部服务器**——于是「迁移无法应用到生产库」，
 *   而 `serve.ts --mode=real` 又要求迁移记录存在，两者叠加导致
 *   **真实模式根本起不来**。
 *
 *   PGlite 与 `pg.Client` 都天然满足这个接口（都有 `exec`/`query`），
 *   因此只需把参数类型从具体类放宽为结构接口，就能同时支持两者。
 */
export interface DdlTarget {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** 迁移元数据表（**不属于业务 schema**，因此从一致性检查中排除）。 */
export const MIGRATIONS_TABLE = 'ag_migrations';

export async function openDatabase(options: OpenOptions = {}): Promise<PGlite> {
  return options.dataDir === undefined
    ? new PGlite()
    : new PGlite({ dataDir: options.dataDir });
}

export interface DdlFailure {
  index: number;
  total: number;
  statement: CompiledStatement;
  pgMessage: string;
}

export class DdlApplyError extends Error {
  readonly failure: DdlFailure;
  constructor(failure: DdlFailure) {
    super(
      `第 ${failure.index + 1}/${failure.total} 条语句失败` +
        `${failure.statement.table === undefined ? '' : `（表 ${failure.statement.table}）`}` +
        `：${failure.pgMessage}`,
    );
    this.name = 'DdlApplyError';
    this.failure = failure;
  }
}

/** 把 DDL 逐条真跑；失败时抛出带「语句序号 + 表 + 原始 PG 报错」的异常。 */
export async function applySchema(db: DdlTarget, compiled: CompiledSchema): Promise<number> {
  const total = compiled.plan.length;
  for (let i = 0; i < compiled.plan.length; i += 1) {
    const statement = compiled.plan[i] as CompiledStatement;
    try {
      await db.exec(statement.sql);
    } catch (error) {
      const pgMessage = error instanceof Error ? error.message : String(error);
      throw new DdlApplyError({ index: i, total, statement, pgMessage });
    }
  }
  return total;
}

/** 执行任意 DDL（drift-demo 的人为破坏用）。 */
export async function execRaw(db: PGlite, sql: string): Promise<void> {
  await db.exec(sql);
}

export async function listLiveTables(db: DdlTarget): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(SQL_TABLES);
  return rows.rows.map((r) => r.table_name);
}

// ───────────────────────────── drift-demo ─────────────────────────────

export type DriftDemoKind = 'column-type' | 'drop-column' | 'add-column' | 'drop-index';

export const DRIFT_DEMO_KINDS: readonly DriftDemoKind[] = [
  'column-type',
  'drop-column',
  'add-column',
  'drop-index',
];

export interface DriftDemoPlan {
  kind: DriftDemoKind;
  description: string;
  /** 人为破坏 DDL（在活库上执行；不进入 migrations/） */
  sql: string;
  expectKinds: DriftFinding['kind'][];
}

function firstTable(tables: readonly NormalizedTable[]): NormalizedTable {
  const table = tables[0];
  if (table === undefined) throw new Error('IR 为空，无法构造漂移演示');
  return table;
}

/**
 * 构造「人为制造漂移」的 DDL。
 * 目的：证明漂移检测**不是恒真/恒假**——不破坏时零发现，破坏后必须精确报出对应 kind。
 */
export function planDriftDemo(
  kind: DriftDemoKind,
  tables: readonly NormalizedTable[],
): DriftDemoPlan {
  switch (kind) {
    case 'column-type': {
      for (const table of tables) {
        const column = table.columns.find((c) => c.kind === 'varchar' && c.length !== undefined);
        if (column !== undefined) {
          return {
            kind,
            description: `把 ${table.tableName}.${column.columnName} 从 varchar(${column.length}) 改为 text`,
            sql: `ALTER TABLE ${table.tableName} ALTER COLUMN ${column.columnName} TYPE text;`,
            expectKinds: ['type'],
          };
        }
      }
      throw new Error('IR 中没有 varchar(n) 列，无法演示 column-type 漂移');
    }
    case 'drop-column': {
      for (const table of tables) {
        const column = table.columns.find((c) => c.nullable && !c.primaryKey);
        if (column !== undefined) {
          return {
            kind,
            description: `删除活库中的列 ${table.tableName}.${column.columnName}`,
            sql: `ALTER TABLE ${table.tableName} DROP COLUMN ${column.columnName};`,
            expectKinds: ['missing-column'],
          };
        }
      }
      throw new Error('IR 中没有可空非主键列，无法演示 drop-column 漂移');
    }
    case 'add-column': {
      const table = firstTable(tables);
      return {
        kind,
        description: `给 ${table.tableName} 增加 IR 未声明的列 zz_drift_demo`,
        sql: `ALTER TABLE ${table.tableName} ADD COLUMN zz_drift_demo text;`,
        expectKinds: ['extra-column'],
      };
    }
    case 'drop-index': {
      for (const table of tables) {
        const index = table.indexes[0];
        if (index !== undefined) {
          return {
            kind,
            description: `删除活库中的索引 ${index.name}（${table.tableName}）`,
            sql: `DROP INDEX ${index.name};`,
            expectKinds: ['missing-index'],
          };
        }
      }
      throw new Error('IR 中没有索引，无法演示 drop-index 漂移');
    }
    default: {
      const never: never = kind;
      throw new Error(`未知 drift-demo 类型：${String(never)}`);
    }
  }
}

/** 差异的可读渲染（工具与报告共用）。 */
export function formatFindings(findings: readonly DriftFinding[]): string {
  return findings
    .map(
      (f, i) =>
        `${String(i + 1).padStart(2, ' ')}. [${f.kind}] ${f.tableName} — ${f.detail}` +
        (f.expected === undefined ? '' : `\n      期望: ${f.expected}`) +
        (f.actual === undefined ? '' : `\n      实际: ${f.actual}`),
    )
    .join('\n');
}
