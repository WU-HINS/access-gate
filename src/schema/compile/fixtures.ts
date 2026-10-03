/**
 * **夹具表（fixture）** —— 仅在 `src/schema/tables/index.ts`（真实声明，40 张表）尚未就绪时使用。
 *
 * 用途：让「IR → DDL → 空库真跑 → 漂移检测 → CI 门禁」全链路在真实声明到位前就可验证。
 * 铁律：夹具**不是**验收对象；任何使用夹具的结论都必须在输出里显式标注 `FIXTURE`，
 *       真实声明就绪后必须用真实声明重跑（见 `reports/db-spike-evidence.md`）。
 *
 */

import { col, defineTable, type TableDecl } from '../dsl.ts';

/**
 * 站点作用域夹具表：站点唯一键首列 site_id（R1）+ 部分唯一索引 + 复用枚举 + numeric/date/bytea。
 * 夹具刻意做成**门禁干净**（R1–R6 无 error），以便 `db:check` 的两阶段都能在夹具模式下全绿。
 */
const fixtureUsers = defineTable(
  'ag_fixture_users',
  {
    siteId: col.uuid().notNull(),
    id: col.uuid().primaryKey().defaultSql('uuidv7()'),
    email: col.varchar(255).notNull(),
    emailVerified: col.boolean().notNull().default(false),
    status: col
      .enum('ag_fixture_user_status', ['pending', 'active', 'suspended'])
      .notNull()
      .default('pending'),
    tags: col.jsonb().notNull().defaultSql("'[]'"),
    profile: col.jsonb().notNull().defaultSql("'{}'"),
    lastLoginAt: col.timestamp({ withTz: true }).nullable(),
    createdAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
    updatedAt: col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    deletedAt: col.timestamp({ withTz: true }).nullable(),
  },
  (t) => [
    t.unique(['siteId', 'email'], { name: 'uq_ag_fixture_users_email', where: 'deleted_at IS NULL' }),
    t.index(['status'], { name: 'ix_ag_fixture_users_status' }),
  ],
);

/** 站点作用域 + 复用枚举 + 部分唯一索引 + numeric/date/bytea。 */
const fixtureEvaluations = defineTable(
  'ag_fixture_evaluations',
  {
    siteId: col.uuid().notNull(),
    id: col.bigserial().primaryKey(),
    userId: col.uuid().notNull(),
    traceId: col.varchar(48).nullable(),
    outcome: col
      .enum('ag_fixture_eval_outcome', ['satisfied', 'unsatisfied', 'indeterminate', 'error'])
      .notNull(),
    score: col.numeric(10, 2).nullable(),
    weight: col.numeric().nullable(),
    durationMs: col.integer().notNull().default(0),
    checkinDate: col.date().nullable(),
    fingerprint: col.binary(32).nullable(),
    inputs: col.jsonb().notNull().defaultSql("'{}'::jsonb"),
    error: col.text().nullable(),
    createdAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
  },
  (t) => [
    t.index(['userId', 'createdAt'], { name: 'ix_ag_fixture_eval_user_time' }),
    t.index(['outcome'], { name: 'ix_ag_fixture_eval_outcome' }),
    t.check('duration_ms >= 0', { name: 'ck_ag_fixture_evaluations_duration' }),
  ],
);

/** 与上一张表**共用** `ag_fixture_eval_outcome`（枚举去重验收）+ 站点唯一键首列是 site_id。 */
const fixtureActionsLog = defineTable(
  'ag_fixture_actions_log',
  {
    siteId: col.uuid().notNull(),
    id: col.bigserial().primaryKey(),
    actionSeq: col.bigint().notNull().default(0),
    idempotencyKey: col.varchar(128).notNull(),
    status: col
      .enum('ag_fixture_eval_outcome', ['satisfied', 'unsatisfied', 'indeterminate', 'error'])
      .notNull()
      .default('satisfied'),
    params: col.jsonb().notNull().defaultSql("'{}'"),
    attempts: col.integer().notNull().default(0),
    createdAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
  },
  (t) => [
    t.unique(['siteId', 'idempotencyKey'], { name: 'uq_ag_fixture_actions_idem' }),
    t.index(['status'], { name: 'ix_ag_fixture_actions_status' }),
  ],
);

/** **多列主键**（siteId, provider）+ 触发器。 */
const fixtureProviderState = defineTable('ag_fixture_provider_state', {
  siteId: col.uuid().notNull().primaryKey(),
  provider: col.varchar(64).notNull().primaryKey(),
  cursor: col.varchar(255).nullable(),
  lastSyncedAt: col.timestamp({ withTz: true }).nullable(),
  updatedAt: col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
});

/** 双作用域表：siteId 可空 + developerId，由 CHECK 保证「scope 与哪一侧非空」一致（R5）。 */
const fixturePluginInstances = defineTable(
  'ag_fixture_plugin_instances',
  {
    scope: col.enum('ag_fixture_owner_scope', ['platform', 'developer', 'site']).notNull(),
    siteId: col.uuid().nullable(),
    developerId: col.uuid().notNull(),
    instanceKey: col.varchar(64).notNull(),
    options: col.jsonb().notNull().defaultSql("'{}'"),
    createdAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
  },
  (t) => [t.unique(['siteId', 'developerId', 'instanceKey'], { name: 'uq_ag_fixture_plugin_instances' })],
  {
    dualScopeCheck:
      "(scope = 'site' AND site_id IS NOT NULL AND developer_id IS NULL) OR " +
      "(scope = 'developer' AND developer_id IS NOT NULL AND site_id IS NULL)",
  },
);

/** 夹具表全集（顺序稳定，便于快照比对）。 */
export const fixtureTables: readonly TableDecl[] = [
  fixtureUsers,
  fixtureEvaluations,
  fixtureActionsLog,
  fixtureProviderState,
  fixturePluginInstances,
];

/** 夹具表名（报告里打印用）。 */
export const FIXTURE_TABLE_NAMES: readonly string[] = fixtureTables.map((d) => d.name);
