/**
 * 规范化 IR（normalized IR）—— Schema 声明层与全部消费方之间的**唯一接口**。
 *
 * 冻结件：见 `docs/12-Schema声明层接口契约.md`。
 * 铁律：消费方（门禁 / DDL 编译 / 漂移检测）只读本文件的类型，不读 `docs/` 与 `tables/*.ts` 的源码文本。
 * 铁律：本文件的结构必须可 `JSON.stringify` 往返（无函数、无 Symbol、无 class 实例）。
 */

export type ColumnKind =
  | 'uuid'
  | 'varchar'
  | 'text'
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'bigserial'
  | 'numeric'
  | 'jsonb'
  | 'timestamp'
  | 'date'
  | 'binary'
  | 'enum';

export type OwnerScope = 'platform' | 'developer' | 'site' | 'user';

/** 列默认值：区分「SQL 表达式」与「字面量」——这是 `DEFAULT {}` 那类损坏的根因。 */
export type DefaultValue =
  | { form: 'now' }
  | { form: 'literal'; value: string | number | boolean | null }
  | { form: 'sql'; expr: string };

export interface NormalizedColumn {
  /** 规范化属性名（camelCase，与声明一致） */
  name: string;
  /** 数据库列名（snake_case，由 name 派生） */
  columnName: string;
  kind: ColumnKind;
  enumType?: string;
  enumValues?: readonly string[];
  length?: number;
  withTz?: boolean;
  precision?: number;
  scale?: number;
  nullable: boolean;
  primaryKey: boolean;
  onUpdateNow: boolean;
  defaultValue?: DefaultValue;
  /** 声明层原样文本：仅供缺陷报告定位，不参与 DDL 推导 */
  declaredText: string;
}

export interface NormalizedIndex {
  name: string;
  columns: readonly string[];
  unique: boolean;
  where?: string;
  kind: 'unique' | 'index';
}

export interface NormalizedCheck {
  /** 判别列：让「索引 / 主键 / CHECK」三类约束可被类型安全地区分 */
  kind: 'check';
  name: string;
  expr: string;
}

export interface NormalizedTable {
  tableName: string;
  /** 声明里的 export const 名，如 'pluginInstances' */
  declName: string;
  columns: readonly NormalizedColumn[];
  indexes: readonly NormalizedIndex[];
  checks: readonly NormalizedCheck[];
  /** 复合主键列（保序）。单列主键走 NormalizedColumn.primaryKey，二者互斥。 */
  primaryKey?: readonly string[];
  /** options.siteScoped === false 时为 false；缺省 true */
  siteScoped: boolean;
  /**
   * ★ 作者是否**显式**写了 siteScoped（v1.1 追加）。
   *
   * 为什么需要：缺省值是 true，但 02 文档里「平台级表」常常根本不写这个字段
   * （ag_plugins / ag_oidc_providers / ag_jobs …）。若把缺省值当判据，M0-11 的
   * «显式 siteScoped:true 但缺 site_id → 启动失败» 会对平台级表产生一片误报。
   * 消费方应只用 siteScopedExplicit 判定「作者承诺了站点头」。
   */
  siteScopedExplicit: boolean;
  /** R3 豁免理由：仅平台级表填写；门禁要求「有豁免必须有理由」 */
  exemptReason?: string;
  /** 双作用域表标记（R5） */
  dualScoped: boolean;
  source: { doc: string; line: number };
}

/** 门禁结论（`src/schema/gate` 产出，`db:check` 消费） */
export interface ScopeViolation {
  tableName: string;
  rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  severity: 'error' | 'warn';
  detail: string;
  suggestion: string;
}

/** 漂移检测结论（`tools/db-check` 产出） */
export interface DriftFinding {
  tableName: string;
  kind: 'missing-table' | 'extra-table' | 'missing-column' | 'extra-column' | 'type' | 'nullability' | 'default' | 'length' | 'primary-key' | 'missing-index' | 'extra-index' | 'index-definition' | 'missing-enum' | 'extra-enum' | 'enum-values';
  detail: string;
  expected?: string;
  actual?: string;
}
