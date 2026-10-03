/**
 * 查询 AST（M0-3）——所有业务查询的**唯一表达方式**。
 *
 * 为什么要有 AST 而不是直接写 SQL：
 *   1. **站点作用域注入点唯一**。若允许业务代码手写 SQL，`site_id` 过滤就得靠人记得写，
 *      漏一处就是静默的跨站点污染（这正是 D17 要防的）。AST 让注入成为**编译期**行为。
 *   2. **禁止裸 SQL 可机械检查**。CI 第 6 项能扫出字符串拼接，但扫不出「忘了写 where」；
 *      AST 形态下「忘了写」= 缺少注入点 = 编译器自己就能发现。
 *   3. 占位符由编译器统一编号，值走参数数组，从根上消除注入类风险。
 *
 * ★ 与 IR 的关系：本模块**不读** `src/schema/tables/**` 的源码文本，
 *   只通过调用方传入的 `NormalizedTable`（或其 `siteScoped`/`columns` 摘要）决定是否注入。
 */

import type { NormalizedTable } from '../schema/ir.ts';

export type SqlValue = string | number | boolean | null | Date | readonly SqlValue[] | { readonly [k: string]: unknown };

export interface ColumnRef {
  /** 数据库列名（snake_case） */
  column: string;
  /** 表别名（多表时使用；单表可为空） */
  table?: string;
}

export interface Literal {
  value: SqlValue;
}

export type Operand = ColumnRef | Literal;

export type ComparisonOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';

export type Condition =
  | { kind: 'true' }
  | { kind: 'cmp'; op: ComparisonOp; left: Operand; right: Operand }
  | { kind: 'isNull'; operand: Operand; negated: boolean }
  | { kind: 'in'; operand: Operand; values: readonly SqlValue[]; negated: boolean }
  | { kind: 'like'; operand: Operand; pattern: string; caseInsensitive: boolean }
  | { kind: 'and'; conditions: readonly Condition[] }
  | { kind: 'or'; conditions: readonly Condition[] }
  | { kind: 'not'; condition: Condition }
  /** 原文谓词：仅用于**无法用 AST 表达**的极端情况，必须显式标注作者与理由（CI 可扫描） */
  | { kind: 'raw'; sql: string; reason: string };

export interface OrderBy {
  column: string;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

export interface SelectQuery {
  kind: 'select';
  table: string;
  columns: readonly string[] | '*';
  where?: Condition;
  orderBy?: readonly OrderBy[];
  limit?: number;
  offset?: number;
  /** 是否要求注入站点作用域过滤。缺省由表的 siteScoped 决定；显式 false 会被编译器审计 */
  scope?: 'auto' | 'require' | 'bypass';
}

export interface InsertQuery {
  kind: 'insert';
  table: string;
  rows: readonly { readonly [column: string]: SqlValue }[];
  /** 冲突时行为 */
  onConflict?: {
    columns: readonly string[];
    do: 'nothing' | 'update';
    updateColumns?: readonly string[];
    /**
     * ★★ **部分唯一索引的谓词**（编译为 `ON CONFLICT (cols) WHERE <谓词> DO …`）。
     *
     * ★ 为什么需要它：当唯一索引是**部分索引**（如 `where developer_id IS NOT NULL`）时，
     *   PG 的 `ON CONFLICT (cols)` 会报 **42P10**（"没有匹配的唯一约束或排除约束"）——
     *   因为"命中哪个索引"必须由**谓词**一起确定。
     * ★ 这也正是「**可空列的唯一键**」的正确修法：不加 `IS NOT NULL` 谓词时，
     *   PG 把 NULL 视为互不相同，唯一约束会**静默失效**（可插入任意多组重复逻辑键）。
     */
    where?: string;
  };
  returning?: readonly string[];
  scope?: 'auto' | 'require' | 'bypass';
}

/**
 * SET 值的**受限表达式**形态。
 *
 * ★ 为什么需要它：`run_count = run_count + 1` 这类自增无法用「值」表达。
 *   早期实现为此手写了一段 SQL 字符串——那正是「裸 SQL」规则要拦的东西，
 *   而且手写 SQL 会**绕过站点作用域注入**。这里把自增建模成受控表达式，
 *   由编译器产出参数化 SQL，两件事一起解决。
 */
export interface ColumnExpression {
  readonly __expr: 'increment' | 'decrement';
  readonly column: string;
  readonly by: number;
}

export function increment(column: string, by = 1): ColumnExpression {
  if (!Number.isFinite(by)) throw new Error('increment 的 by 必须是有限数字');
  return { __expr: 'increment', column, by };
}

export function decrement(column: string, by = 1): ColumnExpression {
  return { __expr: 'decrement', column, by };
}

export type SetValue = SqlValue | ColumnExpression;

export interface UpdateQuery {
  kind: 'update';
  table: string;
  set: { readonly [column: string]: SetValue };
  where?: Condition;
  returning?: readonly string[];
  scope?: 'auto' | 'require' | 'bypass';
}

export interface DeleteQuery {
  kind: 'delete';
  table: string;
  where?: Condition;
  returning?: readonly string[];
  scope?: 'auto' | 'require' | 'bypass';
}

export type Query = SelectQuery | InsertQuery | UpdateQuery | DeleteQuery;

// ─────────────────────────── 构造助手（让写法接近自然语言） ───────────────────────────

export const col = (column: string, table?: string): ColumnRef =>
  table === undefined ? { column } : { column, table };

export const lit = (value: SqlValue): Literal => ({ value });

export const and = (...conditions: Condition[]): Condition => ({ kind: 'and', conditions });
export const or = (...conditions: Condition[]): Condition => ({ kind: 'or', conditions });
export const not = (condition: Condition): Condition => ({ kind: 'not', condition });
export const eq = (left: Operand, right: Operand): Condition => ({ kind: 'cmp', op: 'eq', left, right });
export const ne = (left: Operand, right: Operand): Condition => ({ kind: 'cmp', op: 'ne', left, right });
export const lt = (left: Operand, right: Operand): Condition => ({ kind: 'cmp', op: 'lt', left, right });
export const lte = (left: Operand, right: Operand): Condition => ({ kind: 'cmp', op: 'lte', left, right });
export const gt = (left: Operand, right: Operand): Condition => ({ kind: 'cmp', op: 'gt', left, right });
export const gte = (left: Operand, right: Operand): Condition => ({ kind: 'cmp', op: 'gte', left, right });
export const isNull = (operand: Operand): Condition => ({ kind: 'isNull', operand, negated: false });
export const isNotNull = (operand: Operand): Condition => ({ kind: 'isNull', operand, negated: true });
export const inList = (operand: Operand, values: readonly SqlValue[]): Condition => ({
  kind: 'in',
  operand,
  values,
  negated: false,
});
export const like = (operand: Operand, pattern: string, caseInsensitive = false): Condition => ({
  kind: 'like',
  operand,
  pattern,
  caseInsensitive,
});

/** 表摘要：编译期判定是否注入 site_id 所需的最小信息。 */
export interface TableScopeInfo {
  siteScoped: boolean;
  /** 表是否真的存在 site_id 列（防止「声明 siteScoped 但没列」） */
  hasSiteIdColumn: boolean;
}

export function scopeInfoOf(table: NormalizedTable): TableScopeInfo {
  return {
    siteScoped: table.siteScoped,
    hasSiteIdColumn: table.columns.some((c) => c.columnName === 'site_id'),
  };
}
