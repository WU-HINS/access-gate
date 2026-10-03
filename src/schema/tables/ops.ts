/**
 * ⑥ 运维域 —— 由 tools/extract-doc-schema.ts 从 docs/02-数据模型.md 提取生成。
 * 请勿手改：改文档后重跑 `npm run schema:extract`。
 */
import { col, declare, defineTable, t } from '../dsl.ts';

/** 来源：docs/02-数据模型.md:1428（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const auditLog = declare(
  'auditLog',
  defineTable(
    'ag_audit_log',
    {
      siteId:       col.uuid().notNull(),
      id:           col.bigserial().primaryKey(),
      actorType:    col.enum('ag_actor_type', ['user', 'admin', 'system', 'job']).notNull(),
      actorId:      col.varchar(64).nullable(),
      developerId:  col.uuid().nullable(),
      realm:        col.enum('ag_realm', ['developer', 'enduser']).nullable(),
      action:       col.varchar(96).notNull(),
      targetType:   col.varchar(48).nullable(),
      targetId:     col.varchar(64).nullable(),
      before:       col.jsonb().nullable(),
      after:        col.jsonb().nullable(),
      ip:           col.varchar(64).nullable(),
      userAgent:    col.varchar(512).nullable(),
      traceId:      col.varchar(64).nullable(),
      createdAt:    col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.index(['actorType', 'actorId', 'createdAt'], { name: "ix_ag_audit_actor" }),
      t.index(['targetType', 'targetId'], { name: "ix_ag_audit_target" }),
      t.index(['createdAt'], { name: "ix_ag_audit_time" }),
      t.index(['developerId', 'createdAt'], { name: "ix_ag_audit_developer" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1428 },
);

/** 来源：docs/02-数据模型.md:1466（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const jobs = declare(
  'jobs',
  defineTable(
    'ag_jobs',
    {
      ownerScope:    col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:       col.varchar(64).notNull().default("platform"),
      id:            col.uuid().primaryKey().defaultSql("uuidv7()"),
      jobKey:        col.varchar(128).notNull(),
      status:        col.enum('ag_job_status', ['idle', 'queued', 'running', 'succeeded', 'failed', 'skipped']).notNull().default("idle"),
      lockedBy:      col.varchar(128).nullable(),
      lockedUntil:   col.timestamp({ withTz: true }).nullable(),
      lastRunAt:     col.timestamp({ withTz: true }).nullable(),
      nextRunAt:     col.timestamp({ withTz: true }).nullable(),
      runCount:      col.bigint().notNull().default(0),
      failCount:     col.integer().notNull().default(0),
      backoffUntil:  col.timestamp({ withTz: true }).nullable(),
      cursor:        col.jsonb().notNull().defaultSql("'{}'"),
      lastError:     col.text().nullable(),
      updatedAt:     col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['ownerScope', 'ownerId', 'jobKey'], { name: "uq_ag_jobs_key" }),
      t.index(['status', 'nextRunAt'], { name: "ix_ag_jobs_due" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1466 },
);

/** 来源：docs/02-数据模型.md:1498（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const eventOutbox = declare(
  'eventOutbox',
  defineTable(
    'ag_event_outbox',
    {
      id:             col.uuid().primaryKey().defaultSql("uuidv7()"),
      siteId:         col.uuid().notNull(),
      eventId:        col.varchar(64).notNull(),
      type:           col.varchar(64).notNull(),
      payload:        col.jsonb().notNull(),
      status:         col.enum('ag_outbox_status', ['pending', 'delivering', 'delivered', 'dead']).notNull().defaultSql("'pending'"),
      attempts:       col.integer().notNull().default(0),
      nextAttemptAt:  col.timestamp({ withTz: true }).notNull().defaultNow(),
      deliveredAt:    col.timestamp({ withTz: true }).nullable(),
      lastError:      col.text().nullable(),
      traceId:        col.varchar(48).nullable(),
      createdAt:      col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['siteId', 'eventId'], { name: "uq_ag_outbox_event" }),
      t.index(['siteId', 'status', 'nextAttemptAt'], { name: "ix_ag_outbox_due" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1498 },
);

/** 来源：docs/02-数据模型.md:1531（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const deadLetters = declare(
  'deadLetters',
  defineTable(
    'ag_dead_letters',
    {
      id:          col.uuid().primaryKey().defaultSql("uuidv7()"),
      siteId:      col.uuid().notNull(),
      eventId:     col.varchar(64).notNull(),
      type:        col.varchar(64).notNull(),
      payload:     col.jsonb().notNull(),
      attempts:    col.integer().notNull(),
      lastError:   col.text().notNull(),
      failedAt:    col.timestamp({ withTz: true }).notNull().defaultNow(),
      replayedAt:  col.timestamp({ withTz: true }).nullable(),
      replayedBy:  col.uuid().nullable(),
      createdAt:   col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['siteId', 'eventId'], { name: "uq_ag_dead_letters_event" }),
      t.index(['siteId', 'replayedAt'], { name: "ix_ag_dead_letters_pending" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1531 },
);

/** 来源：docs/02-数据模型.md:362（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const quotaCounters = declare(
  'quotaCounters',
  defineTable(
    'ag_quota_counters',
    {
      quotaKey:     col.varchar(192).primaryKey(),
      windowStart:  col.timestamp({ withTz: true }).notNull(),
      used:         col.bigint().notNull().default(0),
      updatedAt:    col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.index(['windowStart'], { name: "ix_ag_quota_window" }),
    ],
    { exemptReason: "配额计数（`docs/05 §6.4` QuotaGuard）：限流与预算是**跨实例**的资源，键由守卫保证与归属同构；LLM 凭据与预算属于**平台**，且插件宿主没有站点上下文（HostApi 无 siteId）——加 site_id 只会造出恒为默认值的列。", siteScoped: false },
  ),
  { doc: 'docs/02-数据模型.md', line: 362 },
);

