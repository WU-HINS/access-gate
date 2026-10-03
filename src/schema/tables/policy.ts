/**
 * ③ 策略域 —— 由 tools/extract-doc-schema.ts 从 docs/02-数据模型.md 提取生成。
 * 请勿手改：改文档后重跑 `npm run schema:extract`。
 */
import { col, declare, defineTable, t } from '../dsl.ts';

/** 来源：docs/02-数据模型.md:739（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const policies = declare(
  'policies',
  defineTable(
    'ag_policies',
    {
      siteId:           col.uuid().notNull(),
      id:               col.uuid().primaryKey().defaultSql("uuidv7()"),
      code:             col.varchar(64).notNull(),
      name:             col.varchar(128).notNull(),
      description:      col.text().nullable(),
      enabled:          col.boolean().notNull().default(true),
      priority:         col.integer().notNull().default(100),
      tier:             col.integer().nullable(),
      requiresTier:     col.integer().nullable(),
      collision:        col.enum('ag_policy_collision', ['exclusive', 'additive', 'highest_tier']).notNull().default("exclusive"),
      activeVersionId:  col.uuid().nullable(),
      createdAt:        col.timestamp({ withTz: true }).notNull().defaultNow(),
      updatedAt:        col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['siteId', 'code'], { name: "uq_ag_policies_code" }),
      t.index(['enabled', 'priority'], { name: "ix_ag_policies_order" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 739 },
);

/** 来源：docs/02-数据模型.md:761（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const policyVersions = declare(
  'policyVersions',
  defineTable(
    'ag_policy_versions',
    {
      siteId:       col.uuid().notNull(),
      id:           col.uuid().primaryKey().defaultSql("uuidv7()"),
      policyId:     col.uuid().notNull(),
      version:      col.integer().notNull(),
      spec:         col.jsonb().notNull(),
      specYaml:     col.text().nullable(),
      specJson:     col.jsonb().nullable(),
      specGraph:    col.jsonb().nullable(),
      origin:       col.enum('ag_spec_origin', ['yaml', 'json', 'graph', 'migrated']).notNull().default("yaml"),
      specHash:     col.varchar(64).notNull(),
      status:       col.enum('ag_policy_version_status', ['draft', 'active', 'archived']).notNull().default("draft"),
      createdBy:    col.uuid().nullable(),
      createdAt:    col.timestamp({ withTz: true }).notNull().defaultNow(),
      activatedAt:  col.timestamp({ withTz: true }).nullable(),
    },
    (t) => [
      t.unique(['siteId', 'policyId', 'version'], { name: "uq_ag_policy_versions" }),
      t.index(['specHash'], { name: "ix_ag_policy_versions_hash" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 761 },
);

/** 来源：docs/02-数据模型.md:793（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const policyAssignments = declare(
  'policyAssignments',
  defineTable(
    'ag_policy_assignments',
    {
      id:              col.uuid().primaryKey().defaultSql("uuidv7()"),
      siteId:          col.uuid().notNull(),
      policyId:        col.uuid().notNull(),
      targetType:      col.enum('ag_assign_target', ['all', 'user', 'tag', 'cohort']).notNull(),
      targetRef:       col.varchar(128).nullable(),
      rolloutPercent:  col.integer().notNull().default(100),
      enabled:         col.boolean().notNull().default(true),
      createdAt:       col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.index(['policyId', 'targetType'], { name: "ix_ag_assignments_policy" }),
      t.index(['targetType', 'targetRef'], { name: "ix_ag_assignments_target" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 793 },
);

