/**
 * ① 身份与站点域 —— 由 tools/extract-doc-schema.ts 从 docs/02-数据模型.md 提取生成。
 * 请勿手改：改文档后重跑 `npm run schema:extract`。
 */
import { col, declare, defineTable, t } from '../dsl.ts';

/** 来源：docs/02-数据模型.md:56（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const users = declare(
  'users',
  defineTable(
    'ag_users',
    {
      id:              col.uuid().primaryKey().defaultSql("uuidv7()"),
      email:           col.varchar(255).notNull(),
      emailVerified:   col.boolean().notNull().default(false),
      username:        col.varchar(64).notNull(),
      passwordHash:    col.varchar(255).nullable(),
      status:          col.enum('ag_user_status', ['pending', 'active', 'suspended', 'deleted']).notNull().default("pending"),
      source:          col.enum('ag_user_source', ['local', 'oidc']).notNull().default("local"),
      locale:          col.varchar(16).notNull().default("zh-CN"),
      tags:            col.jsonb().notNull().defaultSql("'[]'"),
      primarySubject:  col.jsonb().nullable(),
      profile:         col.jsonb().notNull().defaultSql("'{}'"),
      lastLoginAt:     col.timestamp({ withTz: true }).nullable(),
      createdAt:       col.timestamp({ withTz: true }).notNull().defaultNow(),
      updatedAt:       col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
      deletedAt:       col.timestamp({ withTz: true }).nullable(),
    },
    (t) => [
      t.unique(['email'], { name: "uq_ag_users_email", where: "deleted_at IS NULL" }),
      t.unique(['username'], { name: "uq_ag_users_username", where: "deleted_at IS NULL" }),
      t.index(['status'], { name: "ix_ag_users_status" }),
    ],
    { exemptReason: "平台身份锚点：登录与身份对齐的主体，不属于任何单站点" },
  ),
  { doc: 'docs/02-数据模型.md', line: 56 },
);

/** 来源：docs/02-数据模型.md:86（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const identities = declare(
  'identities',
  defineTable(
    'ag_identities',
    {
      ownerScope:      col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:         col.varchar(64).notNull().default("platform"),
      id:              col.uuid().primaryKey().defaultSql("uuidv7()"),
      userId:          col.uuid().notNull(),
      provider:        col.varchar(64).notNull(),
      providerUserId:  col.varchar(255).notNull(),
      subjectRef:      col.jsonb().nullable(),
      claimSnapshot:   col.jsonb().notNull().defaultSql("'{}'"),
      verifiedAt:      col.timestamp({ withTz: true }).nullable(),
      createdAt:       col.timestamp({ withTz: true }).notNull().defaultNow(),
      updatedAt:       col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['ownerScope', 'ownerId', 'provider', 'providerUserId'], { name: "uq_ag_identities_provider_uid" }),
      t.index(['userId'], { name: "ix_ag_identities_user" }),
      t.index(['provider'], { name: "ix_ag_identities_provider" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 86 },
);

/** 来源：docs/02-数据模型.md:124（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const sessions = declare(
  'sessions',
  defineTable(
    'ag_sessions',
    {
      id:                   col.uuid().primaryKey().defaultSql("uuidv7()"),
      userId:               col.uuid().notNull(),
      tokenHash:            col.varchar(128).notNull(),
      userAgent:            col.varchar(512).nullable(),
      ip:                   col.varchar(64).nullable(),
      expiresAt:            col.timestamp({ withTz: true }).notNull(),
      revokedAt:            col.timestamp({ withTz: true }).nullable(),
      realm:                col.enum('ag_session_realm', ['developer', 'enduser']).notNull(),
      activeDeveloperId:    col.uuid().nullable(),
      activeSiteId:         col.uuid().nullable(),
      activeSiteUpdatedAt:  col.timestamp({ withTz: true }).nullable(),
      createdAt:            col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['tokenHash'], { name: "uq_ag_sessions_token" }),
      t.index(['userId'], { name: "ix_ag_sessions_user" }),
      t.index(['expiresAt'], { name: "ix_ag_sessions_expiry" }),
    ],
    { exemptReason: "会话横跨站点：站点归属由 activeSiteId 在运行期约束，登录时尚未选定站点" },
  ),
  { doc: 'docs/02-数据模型.md', line: 124 },
);

/** 来源：docs/02-数据模型.md:147（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const emailRules = declare(
  'emailRules',
  defineTable(
    'ag_email_rules',
    {
      siteId:     col.uuid().notNull(),
      id:         col.uuid().primaryKey().defaultSql("uuidv7()"),
      listType:   col.enum('ag_email_list_type', ['allow', 'deny']).notNull(),
      matchType:  col.enum('ag_email_match_type', ['exact', 'suffix', 'glob', 'regex']).notNull(),
      pattern:    col.varchar(255).notNull(),
      priority:   col.integer().notNull().default(100),
      note:       col.varchar(255).nullable(),
      enabled:    col.boolean().notNull().default(true),
      createdAt:  col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['siteId', 'matchType', 'pattern'], { name: "uq_ag_email_rules_pattern" }),
      t.index(['enabled', 'priority'], { name: "ix_ag_email_rules_order" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 147 },
);

/** 来源：docs/02-数据模型.md:163（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const inviteCodes = declare(
  'inviteCodes',
  defineTable(
    'ag_invite_codes',
    {
      siteId:       col.uuid().notNull(),
      id:           col.uuid().primaryKey().defaultSql("uuidv7()"),
      code:         col.varchar(64).notNull(),
      createdBy:    col.uuid().nullable(),
      maxUses:      col.integer().notNull().default(1),
      usedCount:    col.integer().notNull().default(0),
      grantsFacts:  col.jsonb().notNull().defaultSql("'{}'"),
      expiresAt:    col.timestamp({ withTz: true }).nullable(),
      createdAt:    col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['siteId', 'code'], { name: "uq_ag_invite_codes_code" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 163 },
);

/** 来源：docs/02-数据模型.md:184（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const developers = declare(
  'developers',
  defineTable(
    'ag_developers',
    {
      id:             col.uuid().primaryKey().defaultSql("uuidv7()"),
      username:       col.varchar(64).notNull(),
      displayName:    col.varchar(128).notNull(),
      email:          col.varchar(255).notNull(),
      passwordHash:   col.varchar(255).nullable(),
      emailVerified:  col.boolean().notNull().default(false),
      role:           col.enum('ag_dev_role', ['admin', 'developer']).notNull().default("developer"),
      status:         col.enum('ag_dev_status', ['active', 'suspended', 'deleted']).notNull().default("active"),
      locale:         col.varchar(16).notNull().default("zh-CN"),
      security:       col.jsonb().notNull().defaultSql("'{}'"),
      lastLoginAt:    col.timestamp({ withTz: true }).nullable(),
      userId:         col.uuid().nullable(),
      createdAt:      col.timestamp({ withTz: true }).notNull().defaultNow(),
      updatedAt:      col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['username'], { name: "uq_ag_developers_username" }),
      t.unique(['email'], { name: "uq_ag_developers_email" }),
      t.index(['role', 'status'], { name: "ix_ag_developers_role" }),
    ],
    { exemptReason: "开发者域，按 ownerScope 隔离", siteScoped: false },
  ),
  { doc: 'docs/02-数据模型.md', line: 184 },
);

/** 来源：docs/02-数据模型.md:227（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const sites = declare(
  'sites',
  defineTable(
    'ag_sites',
    {
      id:           col.uuid().primaryKey().defaultSql("uuidv7()"),
      siteId:       col.varchar(48).notNull(),
      nickname:     col.varchar(128).notNull(),
      developerId:  col.uuid().notNull(),
      status:       col.enum('ag_site_status', ['active', 'suspended', 'archived']).notNull().default("active"),
      quota:        col.jsonb().notNull().defaultSql("'{}'"),
      settings:     col.jsonb().notNull().defaultSql("'{}'"),
      createdAt:    col.timestamp({ withTz: true }).notNull().defaultNow(),
      updatedAt:    col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['siteId'], { name: "uq_ag_sites_site_id" }),
      t.index(['developerId'], { name: "ix_ag_sites_developer" }),
    ],
    { siteScoped: false },
  ),
  { doc: 'docs/02-数据模型.md', line: 227 },
);

/** 来源：docs/02-数据模型.md:253（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginInstances = declare(
  'pluginInstances',
  defineTable(
    'ag_plugin_instances',
    {
      id:           col.uuid().primaryKey().defaultSql("uuidv7()"),
      pluginId:     col.varchar(64).notNull(),
      instanceKey:  col.varchar(32).notNull().default("default"),
      scope:        col.enum('ag_plugin_config_scope', ['developer', 'site']).notNull(),
      developerId:  col.uuid().nullable(),
      siteId:       col.uuid().nullable(),
      label:        col.varchar(128).nullable(),
      config:       col.jsonb().notNull(),
      configHash:   col.varchar(64).notNull(),
      enabled:      col.boolean().notNull().default(false),
      updatedBy:    col.uuid().nullable(),
      updatedAt:    col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['developerId', 'pluginId', 'instanceKey'], { name: "uq_ag_plugin_inst_dev", where: "developer_id IS NOT NULL" }),
      t.unique(['siteId', 'pluginId', 'instanceKey'], { name: "uq_ag_plugin_inst_site", where: "site_id IS NOT NULL" }),
    ],
    { siteScoped: false, dualScopeCheck: "(scope = 'site' AND siteId IS NOT NULL AND developerId IS NULL) OR (scope = 'developer' AND developerId IS NOT NULL AND siteId IS NULL)" },
  ),
  { doc: 'docs/02-数据模型.md', line: 253 },
);

/** 来源：docs/02-数据模型.md:307（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const devInvitations = declare(
  'devInvitations',
  defineTable(
    'ag_dev_invitations',
    {
      siteId:       col.uuid().notNull(),
      id:           col.uuid().primaryKey().defaultSql("uuidv7()"),
      codeHash:     col.varchar(128).notNull(),
      codePrefix:   col.varchar(16).notNull(),
      targetEmail:  col.varchar(255).notNull(),
      siteMode:     col.enum('ag_invite_site_mode', ['auto', 'existing']).notNull().default("auto"),
      maxUses:      col.integer().notNull().default(1),
      usedCount:    col.integer().notNull().default(0),
      expiresAt:    col.timestamp({ withTz: true }).notNull(),
      usedAt:       col.timestamp({ withTz: true }).nullable(),
      usedBy:       col.uuid().nullable(),
      createdBy:    col.uuid().notNull(),
      createdAt:    col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['siteId', 'codeHash'], { name: "uq_ag_dev_invitations_code" }),
      t.index(['targetEmail', 'expiresAt'], { name: "ix_ag_dev_invitations_email" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 307 },
);

/** 来源：docs/02-数据模型.md:374（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const platformSettings = declare(
  'platformSettings',
  defineTable(
    'ag_platform_settings',
    {
      key:          col.varchar(96).primaryKey(),
      value:        col.jsonb().notNull(),
      lockedByEnv:  col.boolean().notNull().default(false),
      updatedBy:    col.uuid().nullable(),
      updatedAt:    col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.index(['updatedAt'], { name: "ix_ag_platform_settings_time" }),
    ],
    { exemptReason: "平台设置，admin 可改", siteScoped: false },
  ),
  { doc: 'docs/02-数据模型.md', line: 374 },
);

