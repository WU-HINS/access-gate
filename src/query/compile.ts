/**
 * 查询编译器（M0-3 的编译侧）—— AST → 参数化 PG SQL + **站点作用域强制注入**。
 *
 * ★ 本模块是「注入」的唯一实现点（D17 裁决：不启用 RLS，改为注入 + fail-closed + 单一事务入口）。
 *   三条硬规则：
 *     1. 站点作用域表（`siteScoped` 且有 `site_id` 列）在**未显式要求绕过**时，
 *        编译器自动把 `site_id = $n` 合入 WHERE（或 INSERT 的列值）；
 *     2. 拿不到作用域 → 抛 `ScopeRequiredError`（fail-closed），**绝不退化成不过滤**；
 *     3. 显式 `scope: 'bypass'` 必须带 `bypassReason`，并被记入编译结果，供 CI/审计扫描。
 *
 * 值一律走 `$n` 参数数组，不做字符串插值——从根上消除注入类风险。
 */

import type {
  ColumnExpression,
  Condition,
  DeleteQuery,
  InsertQuery,
  Operand,
  Query,
  SelectQuery,
  SetValue,
  SqlValue,
  UpdateQuery,
} from './ast.ts';

/** 识别受限表达式（自增/自减）。 */
function asColumnExpression(value: SetValue): ColumnExpression | undefined {
  if (value !== null && typeof value === 'object' && '__expr' in (value as object)) {
    return value as ColumnExpression;
  }
  return undefined;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

export class QueryCompileError extends Error {
  override readonly name = 'QueryCompileError';
}

export class ScopeRequiredError extends Error {
  override readonly name = 'ScopeRequiredError';
  readonly table: string;
  constructor(table: string, why: string) {
    super(
      `拒绝编译 ${table} 的查询：${why}。站点作用域表的查询必须携带 siteId（fail-closed）——` +
        `退化成「不过滤 site_id」会造成静默的跨站点数据污染。` +
        `若确需跨站点（如平台级运维），请显式传 { scope: 'bypass', bypassReason: '...' }。`,
    );
    this.table = table;
  }
}

export interface TableScopeMeta {
  /** 表是否按站点隔离（来自声明 `siteScoped`） */
  siteScoped: boolean;
  /** 表是否真的有 site_id 列（声明与列必须一致，否则报错而不是猜） */
  hasSiteIdColumn: boolean;
}

export interface CompileScope {
  /** 当前站点 id；站点作用域表必填 */
  siteId?: string;
}

export interface CompileOptions {
  scope?: CompileScope;
  /** 显式绕过站点注入的**理由**（缺省不允许绕过；提供后编译结果会标记 bypassed） */
  bypassReason?: string;
}

export interface CompiledQuery {
  sql: string;
  params: readonly SqlValue[];
  /** 本次编译是否**未**注入站点过滤（供审计与 CI 断言） */
  scopeBypassed: boolean;
  bypassReason?: string;
}

interface Ctx {
  params: SqlValue[];
}

function placeholder(ctx: Ctx, value: SqlValue): string {
  ctx.params.push(value);
  return `$${ctx.params.length}`;
}

function renderOperand(ctx: Ctx, operand: Operand): string {
  if ('column' in operand) {
    const ident = operand.table === undefined ? operand.column : `${operand.table}.${operand.column}`;
    if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(ident)) {
      throw new QueryCompileError(`非法的列标识符：${ident}（只允许 snake_case 标识符）`);
    }
    return ident;
  }
  return placeholder(ctx, operand.value);
}

const CMP_SQL: Record<string, string> = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };

function renderCondition(ctx: Ctx, condition: Condition): string {
  switch (condition.kind) {
    case 'true':
      return 'TRUE';
    case 'cmp':
      return `${renderOperand(ctx, condition.left)} ${CMP_SQL[condition.op]} ${renderOperand(ctx, condition.right)}`;
    case 'isNull':
      return `${renderOperand(ctx, condition.operand)} IS ${condition.negated ? 'NOT ' : ''}NULL`;
    case 'in': {
      if (condition.values.length === 0) {
        // 空集合的语义：IN () 非法；按恒假/恒真处理更安全
        return condition.negated ? 'TRUE' : 'FALSE';
      }
      const items = condition.values.map((v) => placeholder(ctx, v)).join(', ');
      return `${renderOperand(ctx, condition.operand)} ${condition.negated ? 'NOT ' : ''}IN (${items})`;
    }
    case 'like':
      return `${renderOperand(ctx, condition.operand)} ${condition.caseInsensitive ? 'ILIKE' : 'LIKE'} ${placeholder(ctx, condition.pattern)}`;
    case 'and':
      return condition.conditions.length === 0 ? 'TRUE' : `(${condition.conditions.map((c) => renderCondition(ctx, c)).join(' AND ')})`;
    case 'or':
      return condition.conditions.length === 0 ? 'FALSE' : `(${condition.conditions.map((c) => renderCondition(ctx, c)).join(' OR ')})`;
    case 'not':
      return `NOT (${renderCondition(ctx, condition.condition)})`;
    case 'raw':
      // 原文谓词必须带理由（AST 里是必填字段），否则类型层就写不出来
      return `(${condition.sql})`;
  }
}

/** 判断本次编译是否需要注入站点过滤。 */
function resolveScopeMode(
  table: string,
  meta: TableScopeMeta,
  requested: 'auto' | 'require' | 'bypass' | undefined,
  options: CompileOptions,
): { inject: boolean; bypassed: boolean; reason?: string } {
  if (meta.siteScoped && !meta.hasSiteIdColumn) {
    throw new QueryCompileError(
      `${table}：声明 siteScoped=true 但表中没有 site_id 列——这是声明缺陷，` +
        `注入无从下手。请修声明（R1），不要绕过。`,
    );
  }
  if (requested === 'bypass') {
    if (options.bypassReason === undefined || options.bypassReason.trim().length === 0) {
      throw new QueryCompileError(
        `${table}：scope:'bypass' 必须同时提供 bypassReason（不允许无理由绕过站点隔离）。`,
      );
    }
    return { inject: false, bypassed: true, reason: options.bypassReason };
  }
  const wantsInject = requested === 'require' || (requested ?? 'auto') === 'auto';
  if (!wantsInject) return { inject: false, bypassed: false };
  if (!meta.siteScoped) return { inject: false, bypassed: false };
  return { inject: true, bypassed: false };
}

function requireSiteId(table: string, scope: CompileScope | undefined): string {
  const siteId = scope?.siteId;
  if (typeof siteId !== 'string' || siteId.length === 0) {
    throw new ScopeRequiredError(table, '当前没有站点作用域（scope.siteId 为空）');
  }
  return siteId;
}

function mergeWhere(injected: Condition | undefined, where: Condition | undefined): Condition | undefined {
  if (injected === undefined) return where;
  if (where === undefined) return injected;
  return { kind: 'and', conditions: [injected, where] };
}

// ─────────────────────────── 各语句编译 ───────────────────────────

function compileSelect(query: SelectQuery, meta: TableScopeMeta, options: CompileOptions): CompiledQuery {
  const ctx: Ctx = { params: [] };
  const mode = resolveScopeMode(query.table, meta, query.scope, options);

  const injected = mode.inject ? { kind: 'cmp' as const, op: 'eq' as const, left: { column: 'site_id' }, right: { value: requireSiteId(query.table, options.scope) } } : undefined;
  const where = mergeWhere(injected, query.where);

  const columns = query.columns === '*' ? '*' : query.columns.join(', ');
  const parts = [`SELECT ${columns} FROM ${query.table}`];
  if (where !== undefined) parts.push(`WHERE ${renderCondition(ctx, where)}`);
  if (query.orderBy !== undefined && query.orderBy.length > 0) {
    parts.push(
      `ORDER BY ${query.orderBy
        .map((o) => `${o.column} ${o.direction.toUpperCase()}${o.nulls === undefined ? '' : ` NULLS ${o.nulls.toUpperCase()}`}`)
        .join(', ')}`,
    );
  }
  if (query.limit !== undefined) parts.push(`LIMIT ${placeholder(ctx, query.limit)}`);
  if (query.offset !== undefined) parts.push(`OFFSET ${placeholder(ctx, query.offset)}`);

  return {
    sql: parts.join(' '),
    params: ctx.params,
    scopeBypassed: mode.bypassed,
    ...(mode.reason === undefined ? {} : { bypassReason: mode.reason }),
  };
}

function compileInsert(query: InsertQuery, meta: TableScopeMeta, options: CompileOptions): CompiledQuery {
  if (query.rows.length === 0) throw new QueryCompileError(`${query.table}: INSERT 没有任何行`);
  const ctx: Ctx = { params: [] };
  const mode = resolveScopeMode(query.table, meta, query.scope, options);
  const siteId = mode.inject ? requireSiteId(query.table, options.scope) : undefined;

  const explicitColumns = [...new Set(query.rows.flatMap((row) => Object.keys(row)))];
  // ★ 站点注入时**一律以作用域为准**：行里显式给了 site_id 必须与作用域一致，
  //   不一致直接拒绝（否则客户端可以借入参做跨站点写入——这正是要防的）。
  if (siteId !== undefined) {
    for (const row of query.rows) {
      const explicit = row['site_id'];
      if (explicit !== undefined && explicit !== siteId) {
        throw new QueryCompileError(
          `${query.table}: 行内显式 site_id='${String(explicit)}' 与当前作用域 siteId='${siteId}' 不一致——` +
            `拒绝跨站点写入（site_id 只能来自作用域）。`,
        );
      }
    }
  }
  const columns = [...explicitColumns];
  if (siteId !== undefined && !columns.includes('site_id')) columns.unshift('site_id');

  const valueGroups = query.rows.map((row) => {
    const values = columns.map((column) => {
      if (column === 'site_id' && siteId !== undefined) {
        // 无论行里是否写了，值都取自作用域
        return placeholder(ctx, siteId);
      }
      const value = row[column];
      if (value === undefined) {
        throw new QueryCompileError(
          `${query.table}: 行缺少列 ${column}（显式列集合为 [${explicitColumns.join(', ')}]）——` +
            `AST 要求所有行具有相同的列集合。`,
        );
      }
      return placeholder(ctx, value);
    });
    return `(${values.join(', ')})`;
  });

  const parts = [`INSERT INTO ${query.table} (${columns.join(', ')}) VALUES ${valueGroups.join(', ')}`];
  if (query.onConflict !== undefined) {
    const target = query.onConflict.columns.join(', ');
    // ★★ 部分唯一索引：谓词必须与列**一起**给出，否则 PG 报 42P10
    //   （"没有匹配 ON CONFLICT 规格的唯一约束或排除约束"）。
    const predicate =
      query.onConflict.where === undefined ? '' : ` WHERE ${query.onConflict.where}`;
    if (query.onConflict.do === 'nothing') {
      parts.push(`ON CONFLICT (${target})${predicate} DO NOTHING`);
    } else {
      const updates = (query.onConflict.updateColumns ?? query.onConflict.columns)
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(', ');
      parts.push(`ON CONFLICT (${target})${predicate} DO UPDATE SET ${updates}`);
    }
  }
  if (query.returning !== undefined && query.returning.length > 0) parts.push(`RETURNING ${query.returning.join(', ')}`);

  return {
    sql: parts.join(' '),
    params: ctx.params,
    scopeBypassed: mode.bypassed,
    ...(mode.reason === undefined ? {} : { bypassReason: mode.reason }),
  };
}

function compileUpdate(query: UpdateQuery, meta: TableScopeMeta, options: CompileOptions): CompiledQuery {
  const ctx: Ctx = { params: [] };
  const mode = resolveScopeMode(query.table, meta, query.scope, options);

  const setParts = Object.entries(query.set).map(([column, value]) => {
    if (!IDENT.test(column)) throw new QueryCompileError(`非法的列标识符：${column}`);
    const expression = asColumnExpression(value as SetValue);
    if (expression !== undefined) {
      // ★ 自增/自减：列名走标识符白名单校验，增量走参数化占位符——不做字符串拼接
      if (!IDENT.test(expression.column)) throw new QueryCompileError(`非法的列标识符：${expression.column}`);
      const operator = expression.__expr === 'increment' ? '+' : '-';
      return `${column} = ${expression.column} ${operator} ${placeholder(ctx, expression.by)}`;
    }
    return `${column} = ${placeholder(ctx, value as SqlValue)}`;
  });
  if (setParts.length === 0) throw new QueryCompileError(`${query.table}: UPDATE 没有要设置的列`);

  // ★ 必须在注入**之前**检查业务条件：否则注入的 site_id 会把「有 WHERE」凑满，
  //   于是 `UPDATE ag_policies SET enabled=false` 会变成**全站更新**——这是真实安全缺陷。
  if (query.where === undefined) {
    throw new QueryCompileError(
      `${query.table}: UPDATE 缺少业务 WHERE —— 一律拒绝（站点注入不能替代业务条件，否则会全站更新）。`,
    );
  }
  const injected = mode.inject ? { kind: 'cmp' as const, op: 'eq' as const, left: { column: 'site_id' }, right: { value: requireSiteId(query.table, options.scope) } } : undefined;
  const mergedForUpdate = mergeWhere(injected, query.where);
  if (mergedForUpdate === undefined) throw new QueryCompileError(`${query.table}: UPDATE 条件缺失`);
  const where = mergedForUpdate;

  const parts = [`UPDATE ${query.table} SET ${setParts.join(', ')}`, `WHERE ${renderCondition(ctx, where)}`];
  if (query.returning !== undefined && query.returning.length > 0) parts.push(`RETURNING ${query.returning.join(', ')}`);

  return {
    sql: parts.join(' '),
    params: ctx.params,
    scopeBypassed: mode.bypassed,
    ...(mode.reason === undefined ? {} : { bypassReason: mode.reason }),
  };
}

function compileDelete(query: DeleteQuery, meta: TableScopeMeta, options: CompileOptions): CompiledQuery {
  const ctx: Ctx = { params: [] };
  const mode = resolveScopeMode(query.table, meta, query.scope, options);

  // 同 UPDATE：先检查业务条件，再注入
  if (query.where === undefined) {
    throw new QueryCompileError(
      `${query.table}: DELETE 缺少业务 WHERE —— 一律拒绝（站点注入不能替代业务条件，否则会清空整站数据）。`,
    );
  }
  const injected = mode.inject ? { kind: 'cmp' as const, op: 'eq' as const, left: { column: 'site_id' }, right: { value: requireSiteId(query.table, options.scope) } } : undefined;
  const mergedForDelete = mergeWhere(injected, query.where);
  if (mergedForDelete === undefined) throw new QueryCompileError(`${query.table}: DELETE 条件缺失`);
  const where = mergedForDelete;

  const parts = [`DELETE FROM ${query.table}`, `WHERE ${renderCondition(ctx, where)}`];
  if (query.returning !== undefined && query.returning.length > 0) parts.push(`RETURNING ${query.returning.join(', ')}`);

  return {
    sql: parts.join(' '),
    params: ctx.params,
    scopeBypassed: mode.bypassed,
    ...(mode.reason === undefined ? {} : { bypassReason: mode.reason }),
  };
}

/** 主入口：把 AST 编译成参数化 SQL，并按需注入站点作用域。 */
export function compile(query: Query, meta: TableScopeMeta, options: CompileOptions = {}): CompiledQuery {
  switch (query.kind) {
    case 'select':
      return compileSelect(query, meta, options);
    case 'insert':
      return compileInsert(query, meta, options);
    case 'update':
      return compileUpdate(query, meta, options);
    case 'delete':
      return compileDelete(query, meta, options);
  }
}
