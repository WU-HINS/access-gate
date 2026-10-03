/**
 * DDL 编译器：`NormalizedTable[]` → PostgreSQL DDL 文本。
 *
 * 冻结件：`docs/12-Schema声明层接口契约.md` §5.2。
 * 铁律：**DDL 禁止手写**——本文件是 `migrations/*.sql` 的唯一来源，全部内容由 IR 推导。
 * 铁律：消费方只读 IR，不读 `docs/` 与 `tables/*.ts` 的源码文本。
 *
 * 输出依赖顺序（§5.2）：`CREATE TYPE`（同名枚举只发射一次）→ 触发器函数 → `CREATE TABLE`
 * → 索引 → 触发器。
 */

import type { NormalizedColumn, NormalizedIndex, NormalizedTable } from '../ir.ts';
import { toSnakeCase } from '../normalize.ts';

// ───────────────────────────── 标识符 ─────────────────────────────

/** 少数必须加引号才能使用的保留字（其余小写标识符一律裸写，§5.2）。 */
const RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization',
  'binary', 'both', 'case', 'cast', 'check', 'collate', 'collation', 'column', 'concurrently',
  'constraint', 'create', 'cross', 'current_catalog', 'current_date', 'current_role',
  'current_schema', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze',
  'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect',
  'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
  'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right', 'select',
  'session_user', 'similar', 'some', 'symmetric', 'table', 'tablesample', 'then', 'to', 'trailing',
  'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when', 'where', 'window',
  'with',
]);

/**
 * 标识符兜底引用。全部 `ag_*` 名字都是合法小写标识符 → 原样返回；
 * 非法/保留字 → 双引号包裹并把内部 `"` 翻倍。
 */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

/** 单引号字符串字面量（PG 转义规则：内部 `'` 翻倍）。 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ───────────────────────────── 类型映射 ─────────────────────────────

/** 列类型映射（§5.2 冻结表）。 */
export function pgTypeOf(column: NormalizedColumn): string {
  switch (column.kind) {
    case 'uuid':
      return 'uuid';
    case 'varchar':
      return column.length === undefined ? 'varchar' : `varchar(${column.length})`;
    case 'text':
      return 'text';
    case 'boolean':
      return 'boolean';
    case 'integer':
      return 'integer';
    case 'bigint':
      return 'bigint';
    case 'bigserial':
      return 'bigserial';
    case 'numeric': {
      if (column.precision === undefined) return 'numeric';
      return column.scale === undefined
        ? `numeric(${column.precision})`
        : `numeric(${column.precision},${column.scale})`;
    }
    case 'jsonb':
      return 'jsonb';
    case 'timestamp':
      return column.withTz === false ? 'timestamp' : 'timestamptz';
    case 'date':
      return 'date';
    case 'binary':
      // PG 的 bytea 无长度属性；声明里的 length 仅作元数据，不参与 DDL（漂移检测同样跳过长度）。
      return 'bytea';
    case 'enum': {
      if (column.enumType === undefined || column.enumType.length === 0) {
        throw new Error(`列 ${column.columnName} 声明为 enum 但缺少 enumType`);
      }
      return quoteIdent(column.enumType);
    }
    default: {
      const never: never = column.kind;
      throw new Error(`未知列类型：${String(never)}`);
    }
  }
}

// ───────────────────────────── 默认值 ─────────────────────────────

/**
 * 默认值三种形态（§4 A1/A2）：
 *  - `{form:'now'}`            → `DEFAULT now()`
 *  - `{form:'sql', expr}`      → `DEFAULT <expr>`（**原样**，杜绝把对象串成 `DEFAULT {}`）
 *  - `{form:'literal', value}` → 按类型加引号（数字/布尔裸写，字符串加单引号，null → `DEFAULT NULL`）
 */
export function renderDefault(column: NormalizedColumn): string | undefined {
  const def = column.defaultValue;
  if (def === undefined) return undefined;
  switch (def.form) {
    case 'now':
      return 'DEFAULT now()';
    case 'sql': {
      const expr = def.expr.trim();
      if (expr.length === 0) {
        throw new Error(`列 ${column.columnName} 的 defaultSql 表达式为空`);
      }
      return `DEFAULT ${expr}`;
    }
    case 'literal': {
      const value = def.value;
      if (value === null) return 'DEFAULT NULL';
      if (typeof value === 'boolean') return `DEFAULT ${value ? 'true' : 'false'}`;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new Error(`列 ${column.columnName} 的数字默认值非法：${String(value)}`);
        }
        return `DEFAULT ${String(value)}`;
      }
      if (typeof value === 'string') return `DEFAULT ${quoteLiteral(value)}`;
      throw new Error(`列 ${column.columnName} 的默认值类型不受支持：${typeof value}`);
    }
    default: {
      const never: never = def;
      throw new Error(`未知默认值形态：${JSON.stringify(never)}`);
    }
  }
}

// ───────────────────────────── 枚举 ─────────────────────────────

/** `CREATE TYPE ag_xxx AS ENUM (...)`；同名枚举**只发射一次**，取值不一致即报错。 */
export function compileEnums(tables: readonly NormalizedTable[]): string[] {
  const seen = new Map<string, { values: readonly string[]; table: string }>();
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.kind !== 'enum') continue;
      const name = column.enumType;
      if (name === undefined) throw new Error(`${table.tableName}.${column.columnName} 缺少 enumType`);
      const values = column.enumValues ?? [];
      const prior = seen.get(name);
      if (prior === undefined) {
        seen.set(name, { values, table: table.tableName });
        continue;
      }
      if (prior.values.length !== values.length || prior.values.some((v, i) => v !== values[i])) {
        throw new Error(
          `枚举 ${name} 被重复声明且取值不一致：` +
            `${prior.table}=[${prior.values.join(',')}] vs ${table.tableName}=[${values.join(',')}]`,
        );
      }
    }
  }
  return [...seen.entries()].map(
    ([name, { values }]) =>
      `CREATE TYPE ${quoteIdent(name)} AS ENUM (${values.map(quoteLiteral).join(', ')});`,
  );
}

/** 枚举类型名 → 取值（db:generate 的打印与测试用）。 */
export function collectEnumTypes(
  tables: readonly NormalizedTable[],
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.kind !== 'enum' || column.enumType === undefined) continue;
      if (!out.has(column.enumType)) out.set(column.enumType, column.enumValues ?? []);
    }
  }
  return out;
}

// ───────────────────────────── 索引 ─────────────────────────────

/** `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>) [WHERE <where>];` */
export function compileIndex(table: NormalizedTable, index: NormalizedIndex): string {
  if (index.columns.length === 0) {
    // 空列索引会生成 `CREATE INDEX ix_x ON x ();` —— PG 语法错误。
    // 在 IR 层就报错，把「PG 语法错误」翻译成「声明损坏 + 具体表/索引名」。
    throw new Error(
      `索引 ${index.name}（表 ${table.tableName}）没有任何列：声明损坏（` +
        `docs/02 中形如 t.index([]) 的片段），无法生成 DDL`,
    );
  }
  const keyword = index.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
  const cols = index.columns.map(quoteIdent).join(', ');
  const where = index.where === undefined ? '' : ` WHERE ${index.where}`;
  return `${keyword} ${quoteIdent(index.name)} ON ${quoteIdent(table.tableName)} (${cols})${where};`;
}

// ───────────────────────────── 触发器（onUpdateNow） ─────────────────────────────

/** PG 无 `ON UPDATE` 列属性 → 用函数 + 触发器实现（名字确定、可复跑）。 */
export function triggerFunctionName(table: NormalizedTable): string {
  return `fn_${table.tableName}_touch`;
}

export function triggerName(table: NormalizedTable): string {
  return `trg_${table.tableName}_touch`;
}

/** 该表上全部 `onUpdateNow` 列（保序）。 */
export function touchColumns(table: NormalizedTable): NormalizedColumn[] {
  return table.columns.filter((c) => c.onUpdateNow);
}

function compileTriggerFunction(table: NormalizedTable): string {
  const cols = touchColumns(table);
  const body = cols.map((c) => `  NEW.${quoteIdent(c.columnName)} = now();`).join('\n');
  return [
    `CREATE OR REPLACE FUNCTION ${quoteIdent(triggerFunctionName(table))}() RETURNS trigger AS $$`,
    'BEGIN',
    body,
    '  RETURN NEW;',
    'END;',
    '$$ LANGUAGE plpgsql;',
  ].join('\n');
}

function compileTriggerStatements(table: NormalizedTable): string[] {
  const fn = quoteIdent(triggerFunctionName(table));
  const trg = quoteIdent(triggerName(table));
  const tbl = quoteIdent(table.tableName);
  return [
    `DROP TRIGGER IF EXISTS ${trg} ON ${tbl};`,
    `CREATE TRIGGER ${trg} BEFORE UPDATE ON ${tbl} FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
  ];
}

// ───────────────────────────── 主键 ─────────────────────────────

/**
 * 表的主键列（保序）。两种声明方式互斥：
 *   1. 列级 `col.uuid().primaryKey()`      → `NormalizedColumn.primaryKey === true`
 *   2. 表级 `t.primaryKey(['siteId','provider'])` → `NormalizedTable.primaryKey`
 *
 * ⚠ 不要用 `normalize.ts` 的 `primaryKeyColumns()`：它只看列级标记，
 * 对 `table.primaryKey` 形式的复合主键返回 `[]`（会让 DDL 静默丢失主键）。
 */
export function tablePrimaryKey(table: NormalizedTable): string[] {
  if (table.primaryKey !== undefined && table.primaryKey.length > 0) return [...table.primaryKey];
  return table.columns.filter((c) => c.primaryKey).map((c) => c.columnName);
}

/** 列的有效可空性：主键列恒为 NOT NULL（PG 语义；含表级复合主键）。 */
export function effectiveNullable(table: NormalizedTable, column: NormalizedColumn): boolean {
  if (column.primaryKey) return false;
  if (column.nullable && tablePrimaryKey(table).includes(column.columnName)) return false;
  return column.nullable;
}

// ───────────────────────────── 表 ─────────────────────────────

/** 单个 `NormalizedTable` → 语句序列（CREATE TABLE → 索引 → 触发器）。 */
/**
 * CHECK 表达式归一化：把表达式里的 camelCase 列名转成 snake_case。
 *
 * ★ 为什么必须做：文档（作者面）写的是 `siteId`，而 DDL 里的列名是 `site_id`。
 *   PostgreSQL 标识符不加引号时会折叠为小写，于是 `siteId` 被当成 `siteid` →
 *   `column "siteid" does not exist`，整条 DDL 失败（实测第 68/216 条即此）。
 *   只处理**裸标识符**，字符串字面量里的内容（如 'site'）原样保留。
 */
export function normalizeCheckExpr(expr: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (quote !== null) {
      out += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j]!)) j += 1;
      const word = expr.slice(i, j);
      // SQL 关键字保持原样；其余按 camelCase → snake_case 转换
      out += SQL_KEYWORD_WORDS.has(word.toUpperCase()) ? word : toSnakeCase(word);
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const SQL_KEYWORD_WORDS = new Set(['AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'BETWEEN', 'TRUE', 'FALSE', 'CHECK', 'CONSTRAINT']);

export function compileTable(table: NormalizedTable): string[] {
  return compileTablePlan(table).map((s) => s.sql);
}

export interface CompiledStatement {
  kind: 'enum' | 'function' | 'table' | 'index' | 'trigger';
  sql: string;
  /** 语句归属的表（enum 语句除外） */
  table?: string;
  enumName?: string;
}

function checkName(table: NormalizedTable, rawName: string, ordinal: number): string {
  if (rawName.length > 0) return rawName;
  return `ck_${table.tableName}_${ordinal}`;
}

/** 单表编译的带元信息版本（db:migrate 用它打印「哪条语句、哪张表」）。 */
export function compileTablePlan(table: NormalizedTable): CompiledStatement[] {
  const out: CompiledStatement[] = [];
  const pk = tablePrimaryKey(table);
  const pkSet = new Set(pk);
  const inlinePk = pk.length === 1;

  const lines: string[] = [];
  for (const column of table.columns) {
    const parts = [quoteIdent(column.columnName), pgTypeOf(column)];
    if (inlinePk && pkSet.has(column.columnName)) parts.push('PRIMARY KEY');
    const def = renderDefault(column);
    if (def !== undefined) parts.push(def);
    if (!effectiveNullable(table, column) && !(inlinePk && pkSet.has(column.columnName))) {
      parts.push('NOT NULL');
    }
    lines.push(`  ${parts.join(' ')}`);
  }
  if (pk.length > 1) {
    lines.push(`  PRIMARY KEY (${pk.map(quoteIdent).join(', ')})`);
  }
  table.checks.forEach((check, i) => {
    lines.push(`  CONSTRAINT ${quoteIdent(checkName(table, check.name, i + 1))} CHECK (${normalizeCheckExpr(check.expr)})`);
  });

  out.push({
    kind: 'table',
    table: table.tableName,
    sql: `CREATE TABLE ${quoteIdent(table.tableName)} (\n${lines.join(',\n')}\n);`,
  });

  for (const index of table.indexes) {
    out.push({ kind: 'index', table: table.tableName, sql: compileIndex(table, index) });
  }

  if (touchColumns(table).length > 0) {
    out.push({
      kind: 'function',
      table: table.tableName,
      sql: compileTriggerFunction(table),
    });
    for (const stmt of compileTriggerStatements(table)) {
      out.push({ kind: 'trigger', table: table.tableName, sql: stmt });
    }
  }

  return out;
}

// ───────────────────────────── 整库 ─────────────────────────────

export interface CompiledSchema {
  /** `CREATE TYPE` 语句（同名枚举只出现一次） */
  enums: string[];
  /** `CREATE TABLE` 语句 */
  tables: string[];
  /** `CREATE INDEX` / `CREATE UNIQUE INDEX` 语句 */
  indexes: string[];
  /** `CREATE OR REPLACE FUNCTION` 语句 */
  functions: string[];
  /** 触发器语句（DROP TRIGGER IF EXISTS + CREATE TRIGGER） */
  triggers: string[];
  /** 按依赖顺序展开的全部语句 */
  statements: string[];
  /** 与 statements 一一对应的元信息 */
  plan: CompiledStatement[];
  /** 拼接后的完整 DDL（`sql/schema.sql` 快照的正文） */
  sql: string;
}

/**
 * 声明完整性预检：一次性列出**全部**无法生成 DDL 的索引声明（空列索引）。
 *
 * 为什么要预检：逐表 throw 会「修一个、撞下一个」；一次性聚合能让缺陷在一轮里被全部看到。
 */
export function findBrokenIndexes(tables: readonly NormalizedTable[]): string[] {
  const broken: string[] = [];
  for (const table of tables) {
    for (const index of table.indexes) {
      if (index.columns.length === 0) {
        broken.push(`${table.tableName}.${index.name}（声明来源 ${table.source.doc}:${table.source.line}）`);
      }
    }
  }
  return broken;
}

function assertIndexesUsable(tables: readonly NormalizedTable[]): void {
  const broken = findBrokenIndexes(tables);
  if (broken.length === 0) return;
  throw new Error(
    `声明损坏：${broken.length} 处索引没有任何列 → 会生成非法的 \`CREATE INDEX ... ()\`，拒绝产出 DDL。\n` +
      '  修法：删掉这些声明，或在提取器里把「索引」说明还原成真实的列。\n' +
      broken.map((b) => `  - ${b}`).join('\n'),
  );
}

/**
 * `NormalizedTable[]` → 完整 DDL。
 * 顺序（§5.2）：枚举 → 函数 → 表 → 索引 → 触发器。
 */
export function compileSchema(tables: readonly NormalizedTable[]): CompiledSchema {
  assertIndexesUsable(tables);
  const plan: CompiledStatement[] = [];

  for (const sql of compileEnums(tables)) {
    const name = /CREATE TYPE\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s/.exec(sql)?.[1] ?? '';
    plan.push({ kind: 'enum', enumName: name.replace(/"/g, ''), sql });
  }

  const tablePlans = tables.map((table) => compileTablePlan(table));
  // 触发器函数与表无依赖，但放在表之前便于一眼看出「函数先行」。
  for (const p of tablePlans) {
    for (const s of p) if (s.kind === 'function') plan.push(s);
  }
  for (const p of tablePlans) {
    for (const s of p) if (s.kind === 'table') plan.push(s);
  }
  for (const p of tablePlans) {
    for (const s of p) if (s.kind === 'index') plan.push(s);
  }
  for (const p of tablePlans) {
    for (const s of p) if (s.kind === 'trigger') plan.push(s);
  }

  const statements = plan.map((s) => s.sql);
  return {
    enums: plan.filter((s) => s.kind === 'enum').map((s) => s.sql),
    tables: plan.filter((s) => s.kind === 'table').map((s) => s.sql),
    indexes: plan.filter((s) => s.kind === 'index').map((s) => s.sql),
    functions: plan.filter((s) => s.kind === 'function').map((s) => s.sql),
    triggers: plan.filter((s) => s.kind === 'trigger').map((s) => s.sql),
    statements,
    plan,
    sql: `${statements.join('\n\n')}\n`,
  };
}
