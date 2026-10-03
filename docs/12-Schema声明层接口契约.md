# 12 · Schema 声明层接口契约（M0 冻结件 v1.1）

> **状态**：**已冻结**（M0 期间不得擅自变更；变更须在 `docs/CHANGELOG.md` 追加 ADR 并同步本文件版本号）。
> **为什么需要它**：`02-数据模型.md` 里的 TS 片段是**作者面（authoring surface）**，不是可编译的模块。
> 本契约定义「作者面 → 规范化数据（normalized IR）→ 消费方（门禁 / DDL 编译 / 漂移检测）」的**唯一接口**，
> 使三条工作流（DSL 与提取、门禁规则、DDL 与数据库管道）可以**互不阻塞地并行实现**。

---

## 1. 数据流

```
docs/02-数据模型.md 的 ```ts 围栏          （作者面，单一事实来源；有已知缺陷，见 §6）
        │  ① tools/extract-doc-schema.ts：解析 + 漂移比对
        ▼
src/schema/tables/*.ts                      （真实的 defineTable 模块，可 tsc 校验）
        │  ② collectTables() / normalizeTable()
        ▼
NormalizedTable[]                           （规范化 IR，纯数据、无函数、可 JSON 序列化）
        │  ③ 三个互不依赖的消费方
        ├── src/schema/gate/**   → R1–R5 门禁违规列表（db:check 非零退出）
        ├── src/schema/compile/**→ PG DDL（CREATE TYPE / CREATE TABLE / 索引 / CHECK）
        └── tools/db-check.ts    → 活库 information_schema 对比 → 漂移列表
```

**铁律**：消费方**只读 IR**，不得读 `docs/`，不得读 `src/schema/tables/*.ts` 的源码文本。
IR 是唯一的跨工作流接口，因此它是冻结件。

---

## 2. 模块与导出（冻结）

| 模块 | 导出 | 职责 |
|---|---|---|
| `src/schema/dsl.ts` | `defineTable` · `declare` · `col` · `t`（含 `t.primaryKey`）· **`collectTables`** | 作者面：生成 `TableDecl`；`collectTables` **收集**声明（不做转换，故不属 `normalize`） |
| `src/schema/normalize.ts` | `normalizeTable` · `tableColumns` | `TableDecl` → `NormalizedTable` |
| `src/schema/gate/scope.ts` | `checkScopeRules` · `formatViolations` | IR → `ScopeViolation[]` |
| `src/schema/gate/exemptions.ts` | `PLATFORM_EXEMPTIONS` | R3 豁免清单（**逐表理由必填**） |
| `src/schema/compile/ddl.ts` | `compileTable` · `compileSchema` · `compileEnums` | IR → PG DDL 文本 |
| `src/db/scope.ts` | `resolveScope` · `mustScope` · `ScopeMissingError` | 运行期作用域解析 + **fail-closed 抛错** |
| `src/db/tx.ts` | `withTransaction` · `currentTx` · `assertInTransaction` | AsyncLocalStorage 事务上下文 |
| `src/db/guard.ts` | `scanSource` | 静态检出「事务外查询 / 裸 SQL」（供 CI） |

---

## 2.1 ★ 修订记录（R118 复查发现）

★ **修订**：`collectTables` 原先被列在 `src/schema/normalize.ts`，而**实际导出在 `src/schema/dsl.ts`**。

| 项 | 内容 |
|---|---|
| **发现方式** | R118 逐条核对本表（8 模块 / 20 个导出）时发现 |
| **实际位置** | `src/schema/dsl.ts:328`（`export function collectTables`）；`normalize.ts` 里 **0 处** |
| **为何改契约而非改实现** | `collectTables` 只**收集** `TableDecl`（`collectTables([users, identities, …])`），**不做转换**；而 `normalize.ts` 的职责是「`TableDecl` → `NormalizedTable`」（**转换**）。★ 因此它归**作者面**（`dsl.ts`）更合理 |
| **同类核对结果** | 其余 19 个导出**全部一致**（含 `tx.ts` 的 `withTransaction`——★ 它存在，是我的核对脚本第一版漏了 `export async function` 而误报） |

★★ **教训（与 R112 同源）**：**核对脚本本身也会有缺陷**——
我第一版的正则只匹配 `export (const|function|class|type|interface)`，
★ 漏了 `export async function`，于是把**存在**的 `withTransaction` 报成缺失（**假阳性**）。
★ 若我直接采信，就会去「修」一个**根本不存在的问题**。

## 3. 规范化 IR（冻结的结构）

```ts
export type ColumnKind =
  | 'uuid' | 'varchar' | 'text' | 'boolean' | 'integer' | 'bigint' | 'bigserial'
  | 'numeric' | 'jsonb' | 'timestamp' | 'date' | 'binary' | 'enum';

export type OwnerScope = 'platform' | 'developer' | 'site' | 'user';

/** 列引用的默认值：区分「SQL 表达式」与「字面量」——这是 02 里 DEFAULT {} 那类损坏的根因 */
export type DefaultValue =
  | { form: 'now' }
  | { form: 'literal'; value: string | number | boolean | null }
  | { form: 'sql'; expr: string };

export interface NormalizedColumn {
  /** 规范化后的属性名（camelCase，与声明一致） */
  name: string;
  /** 数据库列名（snake_case，由 name 派生） */
  columnName: string;
  kind: ColumnKind;
  /** enum 类型的 PG 类型名 + 取值（kind === 'enum' 时必填） */
  enumType?: string;
  enumValues?: readonly string[];
  /** varchar 长度 */
  length?: number;
  /** timestamp 是否带时区（02 一律 true） */
  withTz?: boolean;
  precision?: number;
  scale?: number;
  nullable: boolean;
  primaryKey: boolean;
  onUpdateNow: boolean;
  defaultValue?: DefaultValue;
  /** ★ 声明层的原样文本，仅用于缺陷报告定位；不参与 DDL 推导 */
  declaredText: string;
}

export interface NormalizedIndex {
  name: string;
  columns: readonly string[];
  unique: boolean;
  /** 部分索引谓词，如 'deleted_at IS NULL' */
  where?: string;
  kind: 'unique' | 'index';
}

export interface NormalizedCheck {
  kind: 'check';   // ★ 判别列（v1.1 追加）：让索引/主键/CHECK 三类约束可类型安全地分流
  name: string;
  expr: string;
}

export interface NormalizedTable {
  tableName: string;
  /** 声明里的 export const 名，如 'pluginInstances' */
  declName: string;
  columns: readonly NormalizedColumn[];      // 保序
  indexes: readonly NormalizedIndex[];
  checks: readonly NormalizedCheck[];
  /** ★ 复合主键列（保序，v1.1 追加）：来自 `t.primaryKey([...])`；与列级 .primaryKey() 互斥 */
  primaryKey?: readonly string[];
  /** ★ 站点头声明：options.siteScoped === false 时为 false；缺省 true（含 siteId 列） */
  siteScoped: boolean;
  /** ★ R3 豁免理由：仅平台级表填写；门禁要求「有豁免必须有理由」 */
  exemptReason?: string;
  /** ★ 双作用域表标记（R5）：由 options.dualScopeCheck 或 scope 判别列存在性推导 */
  dualScoped: boolean;
  /** 来源：docs/02 的章节与行号，用于缺陷报告回溯 */
  source: { doc: string; line: number };
}
```

**命名派生规则（冻结）**：
- `NormalizedColumn.columnName` = `name` 的 camelCase → snake_case（`primarySubject` → `primary_subject`）。
- 索引名：显式给出则用显式值（02 全部显式给出）；否则 `ix_<table>_<cols joined by _>`（唯一键 `uq_...`）。
- 表名以 `ag_` 开头，`declName` 为文档中的 export const 名。

---

## 4. 契约的行为约定（冻结）

| # | 约定 | 理由 |
|---|---|---|
| A1 | `col.jsonb().defaultSql("'[]'")` → `{form:'sql', expr:"'[]'"}`；`defaultSql('uuidv7()')` → `{form:'sql'}` | 区分表达式与字面量，杜绝 `DEFAULT {}` |
| A2 | `col.varchar(255).notNull().default('pending')` → `{form:'literal'}` + `nullable:false` | — |
| A3 | `.nullable()` 与 `.notNull()` 互斥，后写者生效；默认 `nullable: true`（除 `primaryKey` 隐式 notNull） | 与 02 的写法一致 |
| A4 | `primaryKey` 列**自动** `nullable:false` | PG 语义 |
| A5 | `t.unique(cols,{where})` 的 `columns` **保序**（首列是门禁 R1 的判据） | R1 依赖顺序 |
| A6 | `siteScoped` 缺省 `true`；`options.siteScoped === false` 显式关闭 | 02 §3.10「所有业务表加 siteId」 |
| A7 | 门禁 R6（扩展）：`t.unique` 含可空列时**必须**给出告警级发现（PG 把 NULL 视为互不相同 → 唯一约束静默失效） | 02 §1 已述此风险，但无检查 |
| A8 | 规范化输出**必须可 `JSON.stringify` 往返**（无函数、无 Symbol、无 class 实例） | 漂移检测与 snapshot 测试依赖 |

---

## 5. 消费方契约

### 5.1 门禁（`src/schema/gate/scope.ts`）

输入 `NormalizedTable[]`，输出：

```ts
export interface ScopeViolation {
  tableName: string;
  rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  severity: 'error' | 'warn';
  detail: string;
  /** 门禁只报错，不改表；修法写在 suggestion 里 */
  suggestion: string;
}
```

`checkScopeRules(tables, exemptions)` 返回 `ScopeViolation[]`；**任一 `severity:'error'` → `db:check` 非零退出（R4）**。
`R6`（唯一键含可空列）为 `warn`，不阻塞，但必须出现在报告中（02 §1 已承认该风险却无检查）。

### 5.2 DDL 编译（`src/schema/compile/ddl.ts`）

| 输入 | 输出 |
|---|---|
| `NormalizedTable[]` | `{ enums: string[]; tables: string[]; sql: string }`（按依赖顺序：先 `CREATE TYPE`，再表） |

- 标识符一律 `snake_case` 且**不加引号**（全部名字都为合法小写标识符）；需要时用 `quoteIdent()` 兜底。
- `enum` → `CREATE TYPE ag_xxx AS ENUM (...)`；同名枚举**只发射一次**（多表共用）。
- 部分唯一索引 → `CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL`。
- 禁止任何手写 DDL 进入 `migrations/`；`migrations/*.sql` 必须由 `db:generate` 产出。

### 5.3 漂移检测（`tools/db-check.ts`）

活库读取口径（冻结）：
- 列：`information_schema.columns`（`column_name` / `data_type` / `udt_name` / `is_nullable` / `column_default` / `character_maximum_length`）；
- 索引：`pg_index` + `pg_class` + `pg_get_indexdef()`；
- 主键：`pg_constraint`（`contype='p'`）。

比较口径：**只比较 IR 中被声明的属性**（列存在性、类型、可空、长度、默认、主键成员、索引名与列序、唯一性、部分谓词）；
`IR` 未声明的属性不参与比较（例如 PG 自动生成的 NOT NULL 约束名）。
发现任一差异 → `report` + `process.exit(1)`。

---

## 6. 已知缺陷登记（提取阶段的输入）

| # | 位置 | 现象 | 状态 |
|---|---|---|---|
| D-1 | `02` 行 875–885 | `ag_checkin_entitlements` 定义在**块引用**（`> ` 前缀）内 | 待提取阶段判定 |
| D-2 | `02` 行 886–910 | `ag_checkin_records` 的代码围栏疑似未收尾（缺 ` ``` `） | 待提取阶段判定 |
| D-3 | `02` 行 254–255 | `ag_plugin_instances` 的唯一键首列是**可空**的 `developerId` | 待门禁 R6 判定 |
| D-4 | `02` 行 49/80 等 | `ag_users` 等表定义后有多余的 `]);`（孤立的收尾符） | 待提取阶段判定 |
| D-5 | `05 §7.1.2` | 承诺 `ag_event_outbox` / `ag_dead_letters`，`02` 无声明 | 待范围裁决（M0 不含） |

> 本表只登记**提取阶段**会撞上的缺陷；完整缺陷报告见 `reports/schema-doc-defects.md`。
