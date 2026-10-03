/**
 * 声明式 Schema 层（作者面）—— `docs/02-数据模型.md` 中的写法由本文件承载。
 *
 * 冻结件：见 `docs/12-Schema声明层接口契约.md`。
 * 设计要点：
 *  - 声明只描述「是什么」，不发生成 DDL 文本；DDL 由 `src/schema/compile/ddl.ts` 从规范化 IR 推导。
 *  - 所有 `col.*` 构造器返回内部结构在 `Symbol('ag.col')` 上的列对象，链式方法返回自身。
 *  - `.defaultSql(expr)` 与 `.default(literal)` 严格区分 → 杜绝 `DEFAULT {}` 这类损坏。
 */

import type {
  ColumnKind,
  DefaultValue,
  NormalizedCheck,
  NormalizedColumn,
  NormalizedIndex,
  NormalizedTable,
} from './ir.ts';

export type {
  ColumnKind,
  DefaultValue,
  NormalizedCheck,
  NormalizedColumn,
  NormalizedIndex,
  NormalizedTable,
  OwnerScope,
  ScopeViolation,
  DriftFinding,
} from './ir.ts';

// ───────────────────────────── 声明结构（内部） ─────────────────────────────

export interface ColumnState {
  name: string;
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
}

export interface ColumnSpec {
  readonly [COL]: ColumnState;
}

export type ColumnType<T> = ColumnSpec & ChainableMethods & { readonly __type?: T };
export type InferColumn<T> = T extends { readonly __type?: infer U } ? U : unknown;

/**
 * 链式修饰方法（类型层）。
 *
 * 运行时由 `make()` 用 `Object.assign` 挂上同名方法；这里必须声明，
 * 否则 `col.uuid().primaryKey().defaultSql('uuidv7()')` 这类写法会在 `tsc` 下报 TS2339。
 * 声明层（`src/schema/tables/*.ts`）全部依赖它。
 */
export interface ChainableMethods {
  primaryKey(): this;
  notNull(): this;
  nullable(): this;
  default(value: string | number | boolean | null): this;
  defaultSql(expr: string): this;
  defaultNow(): this;
  onUpdateNow(): this;
}

export const COL: unique symbol = Symbol.for('access-gate.col');

interface Buildable {
  readonly [COL]: ColumnState;
}

/** 所有列对象的内部工厂。 */
function build(state: ColumnState): ColumnSpec {
  return { [COL]: state } as unknown as ColumnSpec;
}

// ───────────────────────────── col.* 构造器 ─────────────────────────────

export type ColBuilder = {
  uuid(): ColumnType<string>;
  varchar(length: number): ColumnType<string>;
  text(): ColumnType<string>;
  boolean(): ColumnType<boolean>;
  integer(): ColumnType<number>;
  bigint(): ColumnType<string>;
  bigserial(): ColumnType<string>;
  numeric(precision?: number, scale?: number): ColumnType<string>;
  jsonb(): ColumnType<unknown>;
  timestamp(options?: { withTz?: boolean }): ColumnType<Date>;
  date(): ColumnType<string>;
  binary(length?: number): ColumnType<Buffer>;
  enum(name: string, values: readonly string[]): ColumnType<string>;
};

function make(kind: ColumnKind, extra: Partial<ColumnState> = {}): ColumnType<never> {
  const state: ColumnState = {
    name: '',
    kind,
    nullable: true,
    primaryKey: false,
    onUpdateNow: false,
    ...extra,
  };
  const self = build(state) as unknown as ColumnType<never> & ChainableMethods;
  const protoMethods: ChainableMethods = {
    primaryKey(): never {
      state.primaryKey = true;
      state.nullable = false;
      return self as never;
    },
    notNull(): never {
      state.nullable = false;
      return self as never;
    },
    nullable(): never {
      state.nullable = true;
      return self as never;
    },
    default(value: string | number | boolean | null): never {
      state.defaultValue = { form: 'literal', value };
      return self as never;
    },
    defaultSql(expr: string): never {
      state.defaultValue = { form: 'sql', expr };
      return self as never;
    },
    defaultNow(): never {
      state.defaultValue = { form: 'now' };
      return self as never;
    },
    onUpdateNow(): never {
      state.onUpdateNow = true;
      return self as never;
    },
  };
  return Object.assign(self, protoMethods) as unknown as ColumnType<never>;
}

export const col: ColBuilder = {
  uuid: () => make('uuid') as unknown as ColumnType<string>,
  varchar: (length: number) => make('varchar', { length }) as unknown as ColumnType<string>,
  text: () => make('text') as unknown as ColumnType<string>,
  boolean: () => make('boolean') as unknown as ColumnType<boolean>,
  integer: () => make('integer') as unknown as ColumnType<number>,
  bigint: () => make('bigint') as unknown as ColumnType<string>,
  bigserial: () => make('bigserial') as unknown as ColumnType<string>,
  numeric: (precision?: number, scale?: number) =>
    make('numeric', precision === undefined ? {} : { precision, scale }) as unknown as ColumnType<string>,
  jsonb: () => make('jsonb') as unknown as ColumnType<unknown>,
  timestamp: (options?: { withTz?: boolean }) =>
    make('timestamp', { withTz: options?.withTz ?? true }) as unknown as ColumnType<Date>,
  date: () => make('date') as unknown as ColumnType<string>,
  binary: (length?: number) =>
    make('binary', length === undefined ? {} : { length }) as unknown as ColumnType<Buffer>,
  enum: (name: string, values: readonly string[]) =>
    make('enum', { enumType: name, enumValues: values }) as unknown as ColumnType<string>,
};

// ───────────────────────────── 表级辅助：索引 / 唯一键 / CHECK ─────────────────────────────

export interface IndexOptions {
  name?: string;
  unique?: boolean;
  where?: string;
}

export interface CheckOptions {
  name?: string;
}

export interface PrimaryKeyConstraint {
  kind: 'primaryKey';
  name: string;
  columns: readonly string[];
}

export interface TableHelper {
  index(columns: readonly string[], options?: IndexOptions): NormalizedIndex;
  unique(columns: readonly string[], options?: IndexOptions): NormalizedIndex;
  check(expr: string, options?: CheckOptions): NormalizedCheck;
  /** ★ 复合主键（02:967 的 `ag_provider_sync_state` 需要它）。与单列 .primaryKey() 互斥。 */
  primaryKey(columns: readonly string[], options?: { name?: string }): PrimaryKeyConstraint;
}

export const t: TableHelper = {
  index(columns, options = {}) {
    return {
      name: options.name ?? '',
      columns,
      unique: options.unique ?? false,
      ...(options.where === undefined ? {} : { where: options.where }),
      kind: options.unique ? 'unique' : 'index',
    };
  },
  unique(columns, options = {}) {
    return {
      name: options.name ?? '',
      columns,
      unique: true,
      ...(options.where === undefined ? {} : { where: options.where }),
      kind: 'unique',
    };
  },
  check(expr, options = {}) {
    return { kind: 'check', name: options.name ?? '', expr };
  },
  primaryKey(columns, options = {}) {
    return { kind: 'primaryKey', name: options.name ?? '', columns };
  },
};

// ───────────────────────────── defineTable ─────────────────────────────

export interface TableOptions {
  /** 缺省 true（02 §3.10：所有业务表加 siteId）；false 表示跨作用域/双作用域表 */
  siteScoped?: boolean;
  /** R3 平台级豁免理由（仅平台级表填写，门禁要求非空） */
  exemptReason?: string;
  /** R5：双作用域表必须由声明方显式标记，并提供 CHECK 表达式 */
  dualScopeCheck?: string;
}

export interface TableDecl {
  name: string;
  declName: string;
  columns: readonly ColumnSpec[];
  indexes: readonly NormalizedIndex[];
  checks: readonly NormalizedCheck[];
  /** 复合主键（由 t.primaryKey 提供）；单列主键走列的 .primaryKey() */
  primaryKey?: { name: string; columns: readonly string[] };
  options: TableOptions;
  /**
   * 声明来源（doc + 行号）。由提取器写入，供缺陷报告回溯到 `docs/02-数据模型.md` 的具体行。
   * ★ 之所以放在声明上而不是全局变量：全局可变状态会在「多来源声明」时串行污染
   *   （曾导致所有表的 source.line 都是 0，缺陷报告无法回溯）。
   */
  source?: { doc: string; line: number };
}

type ColumnsInput = Record<string, ColumnSpec>;

/** 02 文档中 `defineTable(name, columns, extra?, options?)` 的宿主实现。 */
export function defineTable(
  name: string,
  columns: ColumnsInput,
  extra?: (t: TableHelper) => readonly (NormalizedIndex | NormalizedCheck | PrimaryKeyConstraint)[],
  options?: TableOptions,
): TableDecl {
  const specs: ColumnSpec[] = [];
  for (const [key, spec] of Object.entries(columns)) {
    if (spec === undefined || spec === null || typeof spec !== 'object' || !(COL in spec)) {
      throw new Error(
        `defineTable('${name}'): 列 '${key}' 不是 col.* 构造的列对象。` +
          `（若该列需要默认值，请用 col.xxx().default(...) / .defaultSql(...) / .defaultNow()）`,
      );
    }
    // 属性名即列名的 camelCase 来源
    (spec as Buildable)[COL].name = key;
    specs.push(spec);
  }

  const items = extra ? extra(t) : [];
  const indexes: NormalizedIndex[] = [];
  const checks: NormalizedCheck[] = [];
  let primaryKey: { name: string; columns: readonly string[] } | undefined;
  for (const item of items) {
    if (item === undefined) continue;
    if (item.kind === 'primaryKey') {
      primaryKey = {
        name: item.name.length > 0 ? item.name : `pk_${name}`,
        columns: item.columns,
      };
    } else if (item.kind === 'unique' || item.kind === 'index') {
      indexes.push(item);
    } else if ('expr' in item) {
      checks.push(item);
    } else {
      throw new Error(`defineTable('${name}'): 无法识别的约束项 ${JSON.stringify(item)}`);
    }
  }
  if (primaryKey !== undefined && specs.some((sp) => (sp as Buildable)[COL].primaryKey)) {
    throw new Error(
      `defineTable('${name}'): 同时用了列的 .primaryKey() 与 t.primaryKey() —— 二者互斥，请只保留一种。`,
    );
  }

  const opts: TableOptions = { ...(options ?? {}) };
  if (opts.dualScopeCheck !== undefined) {
    checks.push({ kind: 'check', name: `ck_${name}_scope`, expr: opts.dualScopeCheck });
  }

  const decl: TableDecl = {
    name,
    declName: '',
    columns: specs,
    indexes,
    checks,
    options: opts,
  };
  if (primaryKey !== undefined) decl.primaryKey = primaryKey;
  return decl;
}

/**
 * 绑定文档中的 `export const <declName>` 名（规范化 IR 的 `declName`）。
 *
 * 为什么需要：`02-数据模型.md` 的表定义写成 `export const users = defineTable('ag_users', {...})`，
 * 提取器把 `export const` 剥掉后必须把这个名字显式传回来，否则 `declName` 会丢失。
 */
export function declare(
  declName: string,
  decl: TableDecl,
  source?: { doc: string; line: number },
): TableDecl {
  decl.declName = declName;
  if (source !== undefined) decl.source = source;
  return decl;
}

/** 供 `tables/index.ts` 汇总：`collectTables([users, identities, ...])` */
export function collectTables(decls: readonly TableDecl[]): readonly TableDecl[] {
  const seen = new Map<string, TableDecl>();
  for (const decl of decls) {
    if (seen.has(decl.name)) {
      throw new Error(`表名重复：${decl.name}（声明层不允许同一张表出现两次）`);
    }
    seen.set(decl.name, decl);
  }
  return [...seen.values()];
}
