/**
 * `src/schema/compile/ddl.ts` 与漂移检测的单测。
 *
 * 覆盖：类型映射 / 默认值三形态（★ `defaultSql("'[]'")` 必须产出 `DEFAULT '[]'` 而非 `DEFAULT {}`）
 * / 多列主键 / 部分唯一索引 / 枚举去重 / onUpdateNow 触发器幂等 / 空库真跑 + 零漂移。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { col, defineTable, t, type TableDecl, type TableOptions } from '../src/schema/dsl.ts';
import { normalizeTable, normalizeTables } from '../src/schema/normalize.ts';
import {
  compileEnums,
  compileSchema,
  compileTable,
  pgTypeOf,
  quoteIdent,
  renderDefault,
  tablePrimaryKey,
} from '../src/schema/compile/ddl.ts';
import { fixtureTables } from '../src/schema/compile/fixtures.ts';
import {
  applySchema,
  diffSchema,
  introspect,
  normalizePredicate,
  openDatabase,
} from '../src/schema/compile/drift.ts';
import type { NormalizedTable } from '../src/schema/ir.ts';

function makeTable(
  name: string,
  columns: Parameters<typeof defineTable>[1],
  extra?: Parameters<typeof defineTable>[2],
  options?: TableOptions,
): NormalizedTable {
  const decl: TableDecl = defineTable(name, columns, extra, options);
  decl.declName = name;
  return normalizeTable(decl);
}

function columnOf(table: NormalizedTable, columnName: string) {
  const column = table.columns.find((entry) => entry.columnName === columnName);
  assert.ok(column, `列 ${columnName} 不存在`);
  return column;
}

// ───────────────────────────── 1. 类型映射 ─────────────────────────────

test('类型映射：ColumnKind → PG 类型', () => {
  const table = makeTable('ag_types', {
    a: col.uuid(),
    b: col.varchar(64),
    c: col.text(),
    d: col.boolean(),
    e: col.integer(),
    f: col.bigint(),
    g: col.bigserial(),
    h: col.numeric(10, 2),
    i: col.numeric(),
    j: col.jsonb(),
    k: col.timestamp({ withTz: true }),
    l: col.date(),
    m: col.binary(32),
    n: col.enum('ag_kind', ['x', 'y']),
  });
  const expected: Record<string, string> = {
    a: 'uuid',
    b: 'varchar(64)',
    c: 'text',
    d: 'boolean',
    e: 'integer',
    f: 'bigint',
    g: 'bigserial',
    h: 'numeric(10,2)',
    i: 'numeric',
    j: 'jsonb',
    k: 'timestamptz',
    l: 'date',
    m: 'bytea',
    n: 'ag_kind',
  };
  for (const [name, want] of Object.entries(expected)) {
    assert.equal(pgTypeOf(columnOf(table, name)), want, `列 ${name}`);
  }
});

test('类型映射：timestamp({withTz:false}) → timestamp', () => {
  const table = makeTable('ag_ts', { at: col.timestamp({ withTz: false }) });
  assert.equal(pgTypeOf(columnOf(table, 'at')), 'timestamp');
});

test('quoteIdent：合法小写标识符裸写，非法/保留字加引号', () => {
  assert.equal(quoteIdent('ag_users'), 'ag_users');
  assert.equal(quoteIdent('site_id'), 'site_id');
  assert.equal(quoteIdent('select'), '"select"');
  assert.equal(quoteIdent('Weird Name'), '"Weird Name"');
  assert.equal(quoteIdent('has"quote'), '"has""quote"');
});

// ───────────────────────────── 2. 默认值三形态 ─────────────────────────────

test('默认值：defaultSql 原样输出（★ 绝不能变成 DEFAULT {}）', () => {
  const table = makeTable('ag_defs', {
    tags: col.jsonb().notNull().defaultSql("'[]'"),
    profile: col.jsonb().notNull().defaultSql("'{}'"),
    baseline: col.jsonb().notNull().defaultSql("'{}'::jsonb"),
    id: col.uuid().primaryKey().defaultSql('uuidv7()'),
  });
  assert.equal(renderDefault(columnOf(table, 'tags')), "DEFAULT '[]'");
  assert.equal(renderDefault(columnOf(table, 'profile')), "DEFAULT '{}'");
  assert.equal(renderDefault(columnOf(table, 'baseline')), "DEFAULT '{}'::jsonb");
  assert.equal(renderDefault(columnOf(table, 'id')), 'DEFAULT uuidv7()');

  const sql = compileTable(table).join('\n');
  assert.ok(sql.includes("DEFAULT '[]'"), 'jsonb 默认值必须带引号');
  assert.ok(!sql.includes('DEFAULT {}'), '禁止出现 DEFAULT {}（02 已知损坏的形态）');
  assert.ok(!sql.includes('DEFAULT []'), '禁止出现 DEFAULT []');
});

test('默认值：defaultNow → now()；literal 按类型加引号', () => {
  const table = makeTable('ag_lits', {
    createdAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
    status: col.varchar(32).notNull().default('pending'),
    quoted: col.text().nullable().default("it's"),
    count: col.integer().notNull().default(0),
    ratio: col.numeric(6, 3).notNull().default(1.5),
    enabled: col.boolean().notNull().default(false),
    nothing: col.text().nullable().default(null),
    kind: col.enum('ag_lit_kind', ['a', 'b']).notNull().default('a'),
  });
  assert.equal(renderDefault(columnOf(table, 'created_at')), 'DEFAULT now()');
  assert.equal(renderDefault(columnOf(table, 'status')), "DEFAULT 'pending'");
  assert.equal(renderDefault(columnOf(table, 'quoted')), "DEFAULT 'it''s'");
  assert.equal(renderDefault(columnOf(table, 'count')), 'DEFAULT 0');
  assert.equal(renderDefault(columnOf(table, 'ratio')), 'DEFAULT 1.5');
  assert.equal(renderDefault(columnOf(table, 'enabled')), 'DEFAULT false');
  assert.equal(renderDefault(columnOf(table, 'nothing')), 'DEFAULT NULL');
  assert.equal(renderDefault(columnOf(table, 'kind')), "DEFAULT 'a'");
});

test('默认值：未声明默认值时返回 undefined', () => {
  const table = makeTable('ag_nodefault', { a: col.text().nullable() });
  assert.equal(renderDefault(columnOf(table, 'a')), undefined);
});

// ───────────────────────────── 3. 主键 ─────────────────────────────

test('主键：单列内联，多列走表级 PRIMARY KEY', () => {
  const single = compileTable(makeTable('ag_single', { id: col.uuid().primaryKey() })).join('\n');
  assert.ok(single.includes('id uuid PRIMARY KEY'), '单列主键应内联');
  assert.ok(!single.includes('PRIMARY KEY ('), '单列主键不应有表级约束');

  const multi = compileTable(
    makeTable('ag_multi', {
      siteId: col.uuid().notNull().primaryKey(),
      provider: col.varchar(64).notNull().primaryKey(),
      cursor: col.varchar(255).nullable(),
    }),
  ).join('\n');
  assert.ok(multi.includes('PRIMARY KEY (site_id, provider)'), '多列主键应是表级约束且保序');
  assert.ok(!/^\s+site_id uuid PRIMARY KEY/m.test(multi), '多列主键不应内联');
  assert.ok(multi.includes('site_id uuid NOT NULL'), '多列主键列仍应 NOT NULL');
});

test('主键列自动 NOT NULL（IR 层）', () => {
  const table = makeTable('ag_pk', { id: col.uuid().primaryKey() });
  assert.equal(columnOf(table, 'id').nullable, false);
});

// ───────────────────────────── 4. 索引 ─────────────────────────────

test('索引：部分唯一索引带 WHERE，非唯一索引不带 UNIQUE', () => {
  const table = makeTable(
    'ag_users_like',
    {
      email: col.varchar(255).notNull(),
      status: col.varchar(32).notNull(),
      deletedAt: col.timestamp({ withTz: true }).nullable(),
    },
    (t) => [
      t.unique(['email'], { name: 'uq_ag_users_like_email', where: 'deleted_at IS NULL' }),
      t.index(['status'], { name: 'ix_ag_users_like_status' }),
    ],
  );
  const sql = compileTable(table).join('\n');
  assert.ok(
    sql.includes(
      'CREATE UNIQUE INDEX uq_ag_users_like_email ON ag_users_like (email) WHERE deleted_at IS NULL;',
    ),
  );
  assert.ok(sql.includes('CREATE INDEX ix_ag_users_like_status ON ag_users_like (status);'));
  assert.ok(!sql.includes('CREATE UNIQUE INDEX ix_ag_users_like_status'));
});

test('索引：未显式命名的索引按 uq_/ix_<table>_<cols> 派生', () => {
  const table = makeTable(
    'ag_named',
    { a: col.uuid().notNull(), b: col.uuid().notNull() },
    (t) => [t.unique(['a', 'b']), t.index(['b'])],
  );
  // 命名派生规则（normalize.ts 冻结实现）：前缀 uq_/ix_ + 去掉 ag_ 前缀的表名 + 列名
  assert.equal(table.indexes[0]?.name, 'uq_named_a_b');
  assert.equal(table.indexes[1]?.name, 'ix_named_b');
});

// ───────────────────────────── 5. 枚举 ─────────────────────────────

test('枚举：同名枚举只发射一次（多表共用）', () => {
  const tables = normalizeTables([
    defineTable('ag_e1', {
      s: col.enum('ag_shared_status', ['a', 'b']).notNull(),
    }),
    defineTable('ag_e2', {
      s: col.enum('ag_shared_status', ['a', 'b']).notNull().default('a'),
    }),
  ]);
  const enums = compileEnums(tables);
  assert.equal(enums.length, 1);
  assert.equal(enums[0], "CREATE TYPE ag_shared_status AS ENUM ('a', 'b');");
});

test('枚举：同名但取值不一致 → 报错（不允许静默取首个）', () => {
  const tables = normalizeTables([
    defineTable('ag_e1', { s: col.enum('ag_conflict', ['a', 'b']).notNull() }),
    defineTable('ag_e2', { s: col.enum('ag_conflict', ['a', 'c']).notNull() }),
  ]);
  assert.throws(() => compileEnums(tables), /取值不一致/);
});

// ───────────────────────────── 6. onUpdateNow ─────────────────────────────

test('onUpdateNow：生成函数 + 触发器，且语句可复跑（幂等）', () => {
  const table = makeTable('ag_touch', {
    id: col.uuid().primaryKey(),
    updatedAt: col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
  });
  const sql = compileTable(table).join('\n');
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION fn_ag_touch_touch() RETURNS trigger AS $$'));
  assert.ok(sql.includes('NEW.updated_at = now();'));
  assert.ok(sql.includes('DROP TRIGGER IF EXISTS trg_ag_touch_touch ON ag_touch;'));
  assert.ok(
    sql.includes(
      'CREATE TRIGGER trg_ag_touch_touch BEFORE UPDATE ON ag_touch FOR EACH ROW EXECUTE FUNCTION fn_ag_touch_touch();',
    ),
  );

  const schema = compileSchema([table]);
  assert.equal(schema.functions.length, 1);
  assert.equal(schema.triggers.length, 2);
});

test('onUpdateNow：无该标记的表不产生触发器', () => {
  const schema = compileSchema([makeTable('ag_plain', { id: col.uuid().primaryKey() })]);
  assert.equal(schema.functions.length, 0);
  assert.equal(schema.triggers.length, 0);
});

// ───────────────────────────── 7. 依赖顺序 ─────────────────────────────

test('compileSchema：先 CREATE TYPE 再 CREATE TABLE，且 plan 与 statements 一一对应', () => {
  const tables = normalizeTables([
    defineTable('ag_order', {
      id: col.uuid().primaryKey(),
      s: col.enum('ag_order_status', ['a']).notNull(),
    }),
  ]);
  const schema = compileSchema(tables);
  assert.equal(schema.enums.length, 1);
  assert.equal(schema.tables.length, 1);
  assert.ok(schema.statements[0]?.startsWith('CREATE TYPE'));
  assert.ok(schema.statements[1]?.startsWith('CREATE TABLE'));
  assert.equal(schema.plan.length, schema.statements.length);
  assert.equal(schema.sql, `${schema.statements.join('\n\n')}\n`);
});

// ───────────────────────────── 8. 空库真跑 + 零漂移（集成） ─────────────────────────────

test('集成：夹具表 DDL 真跑到空库 → 回读 → 0 漂移', async () => {
  const tables = normalizeTables(fixtureTables);
  const schema = compileSchema(tables);
  const db = await openDatabase();
  try {
    const applied = await applySchema(db, schema);
    assert.equal(applied, schema.plan.length);
    const live = await introspect(db);
    assert.equal(live.tables.length, tables.length);
    const findings = diffSchema(tables, live);
    assert.deepEqual(
      findings,
      [],
      `不应有漂移，实际：\n${findings.map((f) => `${f.kind} ${f.tableName} ${f.detail}`).join('\n')}`,
    );
  } finally {
    await db.close();
  }
});

test('集成：触发器幂等——同一 DDL 连跑两次不报错', async () => {
  const tables = [makeTable('ag_idem', {
    id: col.uuid().primaryKey(),
    updatedAt: col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
  })];
  const schema = compileSchema(tables);
  const db = await openDatabase();
  try {
    await applySchema(db, schema);
    // 幂等复跑：CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE TRIGGER
    for (const statement of schema.plan) {
      if (statement.kind === 'function' || statement.kind === 'trigger') {
        await db.exec(statement.sql);
      }
    }
    const live = await introspect(db);
    assert.deepEqual(diffSchema(tables, live), []);
  } finally {
    await db.close();
  }
});

test('集成：CHECK 约束被真正创建（双作用域）', async () => {
  const table = makeTable(
    'ag_dual',
    { siteId: col.uuid().nullable(), developerId: col.uuid().notNull() },
    undefined,
    { dualScopeCheck: 'site_id IS NOT NULL OR developer_id IS NOT NULL' },
  );
  assert.equal(table.checks.length, 1);
  assert.equal(table.checks[0]?.name, 'ck_ag_dual_scope');
  const sql = compileTable(table).join('\n');
  assert.ok(sql.includes('CONSTRAINT ck_ag_dual_scope CHECK (site_id IS NOT NULL OR developer_id IS NOT NULL)'));
});

// ───────────────────────────── 9. 部分索引谓词的枚举字面量（实测回归） ─────────────────────────────

test('谓词归一化：PG 把枚举字面量反解为 ::enum 也必须判为一致', () => {
  assert.equal(normalizePredicate("(status = 'enabled'::ag_plugin_status)"), "status = 'enabled'");
  assert.equal(normalizePredicate("status = 'enabled'"), "status = 'enabled'");
  assert.equal(normalizePredicate('(deleted_at IS NULL)'), 'deleted_at is null');
  assert.equal(normalizePredicate(null), null);
});

test('集成：部分唯一索引的 where 含枚举字面量 → 0 漂移', async () => {
  const table = makeTable(
    'ag_enum_pred',
    {
      siteId: col.uuid().notNull(),
      status: col.enum('ag_enum_pred_status', ['enabled', 'disabled']).notNull(),
    },
    (t) => [
      t.unique(['siteId', 'status'], {
        name: 'uq_ag_enum_pred_enabled',
        where: "status = 'enabled'",
      }),
    ],
  );
  const db = await openDatabase();
  try {
    await applySchema(db, compileSchema([table]));
    const findings = diffSchema([table], await introspect(db));
    assert.deepEqual(
      findings,
      [],
      `谓词口径不一致：\n${findings.map((f) => `${f.kind} ${f.detail} 期望=${f.expected} 实际=${f.actual}`).join('\n')}`,
    );
  } finally {
    await db.close();
  }
});

test('编译器拒绝空列索引声明（损坏的 IR 不得产出非法 DDL）', () => {
  const table = makeTable('ag_broken', { a: col.uuid().notNull() }, (t) => [t.index([])]);
  assert.throws(() => compileSchema([table]), /声明损坏：1 处索引没有任何列/);
  assert.throws(() => compileTable(table), /没有任何列/);
});

// ───────────────────────────── 10. 表级复合主键 t.primaryKey([...]) ─────────────────────────────

test('复合主键：t.primaryKey([...]) 走表级 PRIMARY KEY，且不内联', () => {
  const table = makeTable(
    'ag_composite',
    {
      siteId: col.uuid().notNull(),
      provider: col.varchar(64).notNull(),
      cursor: col.varchar(255).nullable(),
    },
    (t) => [t.primaryKey(['siteId', 'provider'], { name: 'pk_ag_composite' })],
  );
  assert.deepEqual(tablePrimaryKey(table), ['site_id', 'provider']);
  const sql = compileTable(table).join('\n');
  assert.ok(sql.includes('PRIMARY KEY (site_id, provider)'), '必须产出表级复合主键');
  assert.ok(!/^\s+site_id uuid PRIMARY KEY/m.test(sql), '复合主键不得内联');
});

test('复合主键：空库真跑 + 漂移检测识别主键成员与顺序', async () => {
  const table = makeTable(
    'ag_composite2',
    {
      siteId: col.uuid().notNull(),
      provider: col.varchar(64).notNull(),
      cursor: col.varchar(255).nullable(),
    },
    (t) => [t.primaryKey(['siteId', 'provider'])],
  );
  const db = await openDatabase();
  try {
    await applySchema(db, compileSchema([table]));
    const live = await introspect(db);
    assert.deepEqual(live.primaryKeys.get('ag_composite2'), ['site_id', 'provider']);
    assert.deepEqual(diffSchema([table], live), [], '复合主键应零漂移');

    // 反例：去掉活库主键 → 必须被检出 primary-key 漂移
    await db.exec('ALTER TABLE ag_composite2 DROP CONSTRAINT ag_composite2_pkey;');
    const findings = diffSchema([table], await introspect(db));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, 'primary-key');
    assert.equal(findings[0]?.expected, 'site_id, provider');
  } finally {
    await db.close();
  }
});
