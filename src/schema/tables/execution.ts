/**
 * ④ 执行域 —— 由 tools/extract-doc-schema.ts 从 docs/02-数据模型.md 提取生成。
 * 请勿手改：改文档后重跑 `npm run schema:extract`。
 */
import { col, declare, defineTable, t } from '../dsl.ts';

/** 来源：docs/02-数据模型.md:818（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const userPolicyState = declare(
  'userPolicyState',
  defineTable(
    'ag_user_policy_state',
    {
      baseline:                  col.jsonb().notNull().defaultSql("'{}'::jsonb"),
      siteId:                    col.uuid().notNull(),
      id:                        col.uuid().primaryKey().defaultSql("uuidv7()"),
      userId:                    col.uuid().notNull(),
      policyId:                  col.uuid().notNull(),
      state:                     col.enum('ag_state', ['unknown', 'evaluating', 'satisfied', 'granted', 'at_risk', 'revoked', 'blocked']).notNull().default("unknown"),
      satisfiedAt:               col.timestamp({ withTz: true }).nullable(),
      grantedAt:                 col.timestamp({ withTz: true }).nullable(),
      graceUntil:                col.timestamp({ withTz: true }).nullable(),
      nextCheckAt:               col.timestamp({ withTz: true }).nullable(),
      lastOutcome:               col.enum('ag_eval_outcome', ['satisfied', 'unsatisfied', 'indeterminate', 'error']).nullable(),
      indeterminateSince:        col.timestamp({ withTz: true }).nullable(),
      consecutiveIndeterminate:  col.integer().notNull().default(0),
      version:                   col.integer().notNull().default(0),
      lastChangedAt:             col.timestamp({ withTz: true }).nullable(),
      actionSeq:                 col.bigint().notNull().default(0),
      lastEvalId:                col.bigint().nullable(),
      failStreak:                col.integer().notNull().default(0),
      appliedActions:            col.jsonb().notNull().defaultSql("'{}'"),
      createdAt:                 col.timestamp({ withTz: true }).notNull().defaultNow(),
      updatedAt:                 col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['siteId', 'userId', 'policyId'], { name: "uq_ag_state_user_policy" }),
      t.index(['state'], { name: "ix_ag_state_state" }),
      t.index(['nextCheckAt'], { name: "ix_ag_state_next_check" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 818 },
);

/** 来源：docs/02-数据模型.md:893（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const evaluations = declare(
  'evaluations',
  defineTable(
    'ag_evaluations',
    {
      siteId:       col.uuid().notNull(),
      traceId:      col.varchar(48).nullable(),
      id:           col.bigserial().primaryKey(),
      userId:       col.uuid().notNull(),
      policyId:     col.uuid().notNull(),
      policyVerId:  col.uuid().notNull(),
      trigger:      col.enum('ag_eval_trigger', ['login', 'binding', 'manual', 'scheduled', 'webhook', 'admin']).notNull(),
      inputs:       col.jsonb().notNull(),
      itemResults:  col.jsonb().notNull(),
      outcome:      col.enum('ag_eval_outcome', ['satisfied', 'unsatisfied', 'indeterminate', 'error']).notNull(),
      score:        col.numeric(10, 2).nullable(),
      durationMs:   col.integer().notNull().default(0),
      error:        col.text().nullable(),
      createdAt:    col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.index(['userId', 'createdAt'], { name: "ix_ag_eval_user_time" }),
      t.index(['policyId', 'outcome'], { name: "ix_ag_eval_policy_outcome" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 893 },
);

/** 来源：docs/02-数据模型.md:924（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const actionsLog = declare(
  'actionsLog',
  defineTable(
    'ag_actions_log',
    {
      traceId:         col.varchar(48).nullable(),
      actionSeq:       col.bigint().notNull(),
      siteId:          col.uuid().notNull(),
      id:              col.bigserial().primaryKey(),
      evalId:          col.bigint().nullable(),
      userId:          col.uuid().notNull(),
      policyId:        col.uuid().nullable(),
      action:          col.varchar(64).notNull(),
      idempotencyKey:  col.varchar(128).notNull(),
      params:          col.jsonb().notNull(),
      status:          col.enum('ag_action_status', ['planned', 'running', 'succeeded', 'skipped', 'failed', 'rolled_back', 'blocked_unbound', 'partially_applied']).notNull().default("planned"),
      result:          col.jsonb().nullable(),
      blockedReason:   col.varchar(64).nullable(),
      skipReason:      col.varchar(64).nullable(),
      attempts:        col.integer().notNull().default(0),
      request:         col.jsonb().nullable(),
      response:        col.jsonb().nullable(),
      error:           col.text().nullable(),
      startedAt:       col.timestamp({ withTz: true }).nullable(),
      finishedAt:      col.timestamp({ withTz: true }).nullable(),
      createdAt:       col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['siteId', 'idempotencyKey'], { name: "uq_ag_actions_idem" }),
      t.index(['userId', 'createdAt'], { name: "ix_ag_actions_user_time" }),
      t.index(['status'], { name: "ix_ag_actions_status" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 924 },
);

/** 来源：docs/02-数据模型.md:968（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const checkinEntitlements = declare(
  'checkinEntitlements',
  defineTable(
    'ag_checkin_entitlements',
    {
      id:              col.uuid().primaryKey().defaultSql("uuidv7()"),
      siteId:          col.uuid().notNull(),
      userId:          col.uuid().notNull(),
      scope:           col.varchar(32).notNull().default("daily"),
      sourcePolicyId:  col.uuid().nullable(),
      grantedAt:       col.timestamp({ withTz: true }).notNull().defaultNow(),
      revokedAt:       col.timestamp({ withTz: true }).nullable(),
    },
    (t) => [
      t.unique(['siteId', 'userId', 'scope'], { name: "uq_ag_checkin_entitlements" }),
    ],
    { siteScoped: true },
  ),
  { doc: 'docs/02-数据模型.md', line: 968 },
);

/** 来源：docs/02-数据模型.md:980（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const checkinRecords = declare(
  'checkinRecords',
  defineTable(
    'ag_checkin_records',
    {
      siteId:         col.uuid().notNull(),
      id:             col.bigserial().primaryKey(),
      userId:         col.uuid().notNull(),
      checkinDate:    col.date().notNull(),
      quotaAwarded:   col.integer().notNull(),
      grantState:     col.enum('ag_grant_state', ['pending', 'in_flight', 'confirmed', 'unknown']).notNull().default("pending"),
      requestId:      col.varchar(64).nullable(),
      grantVia:       col.varchar(32).notNull().default("provider"),
      providerLogId:  col.bigint().nullable(),
      streak:         col.integer().notNull().default(1),
      createdAt:      col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['siteId', 'userId', 'checkinDate'], { name: "uq_ag_checkin_user_date" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 980 },
);

