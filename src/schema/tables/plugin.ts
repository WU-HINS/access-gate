/**
 * ② 插件域 —— 由 tools/extract-doc-schema.ts 从 docs/02-数据模型.md 提取生成。
 * 请勿手改：改文档后重跑 `npm run schema:extract`。
 */
import { col, declare, defineTable, t } from '../dsl.ts';

/** 来源：docs/02-数据模型.md:407（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const plugins = declare(
  'plugins',
  defineTable(
    'ag_plugins',
    {
      id:                 col.varchar(64).primaryKey(),
      kind:               col.enum('ag_plugin_kind', ['provider', 'channel', 'enricher', 'action', 'identity', 'feature']).notNull(),
      name:               col.varchar(128).notNull(),
      version:            col.varchar(32).notNull(),
      apiVersion:         col.varchar(32).notNull(),
      runtime:            col.enum('ag_plugin_runtime', ['declarative', 'process', 'container', 'in-process']).notNull(),
      source:             col.enum('ag_plugin_source', ['builtin', 'uploaded', 'url', 'directory']).notNull(),
      status:             col.enum('ag_plugin_status', ['installed', 'validated', 'enabled', 'disabled', 'error', 'removed']).notNull().default("installed"),
      manifest:           col.jsonb().notNull(),
      namespace:          col.varchar(64).notNull(),
      digest:             col.varchar(128).notNull(),
      signatureVerified:  col.boolean().notNull().default(false),
      runtimeState:       col.jsonb().notNull().defaultSql("'{}'"),
      enabledAt:          col.timestamp({ withTz: true }).nullable(),
      lastError:          col.text().nullable(),
      installedAt:        col.timestamp({ withTz: true }).notNull().defaultNow(),
      updatedAt:          col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.index(['status', 'kind'], { name: "ix_ag_plugins_status_kind" }),
      t.unique(['namespace'], { name: "uq_ag_plugins_namespace", where: "status = 'enabled'" }),
    ],
    { exemptReason: "插件目录，平台级注册表；安装动作是平台级的" },
  ),
  { doc: 'docs/02-数据模型.md', line: 407 },
);

/** 来源：docs/02-数据模型.md:449（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginConfigs = declare(
  'pluginConfigs',
  defineTable(
    'ag_plugin_configs',
    {
      id:          col.bigserial().primaryKey(),
      instanceId:  col.uuid().notNull(),
      pluginId:    col.varchar(64).notNull(),
      version:     col.integer().notNull(),
      config:      col.jsonb().notNull(),
      configHash:  col.varchar(64).notNull(),
      status:      col.enum('ag_config_status', ['draft', 'active', 'archived']).notNull().default("active"),
      updatedBy:   col.uuid().nullable(),
      createdAt:   col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['pluginId', 'version'], { name: "uq_ag_plugin_configs_ver" }),
      t.index(['pluginId', 'status'], { name: "ix_ag_plugin_configs_status" }),
    ],
    { exemptReason: "配置版本历史：归属由父实例 ag_plugin_instances 决定（实例可能是 developer 级或 site 级），不能自带 siteId" },
  ),
  { doc: 'docs/02-数据模型.md', line: 449 },
);

/** 来源：docs/02-数据模型.md:472（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginGrants = declare(
  'pluginGrants',
  defineTable(
    'ag_plugin_grants',
    {
      ownerScope:  col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:     col.varchar(64).notNull().default("platform"),
      id:          col.uuid().primaryKey().defaultSql("uuidv7()"),
      pluginId:    col.varchar(64).notNull(),
      permission:  col.varchar(160).notNull(),
      grantedBy:   col.uuid().nullable(),
      grantedAt:   col.timestamp({ withTz: true }).notNull().defaultNow(),
      revokedAt:   col.timestamp({ withTz: true }).nullable(),
    },
    (t) => [
      t.unique(['ownerScope', 'ownerId', 'pluginId', 'permission'], { name: "uq_ag_plugin_grants" }),
      t.index(['permission'], { name: "ix_ag_plugin_grants_perm" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 472 },
);

/** 来源：docs/02-数据模型.md:494（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginBindings = declare(
  'pluginBindings',
  defineTable(
    'ag_plugin_bindings',
    {
      siteId:         col.uuid().notNull(),
      id:             col.uuid().primaryKey().defaultSql("uuidv7()"),
      userId:         col.uuid().notNull(),
      pluginId:       col.varchar(64).notNull(),
      instanceKey:    col.varchar(64).notNull().default("default"),
      externalId:     col.varchar(255).nullable(),
      externalName:   col.varchar(255).nullable(),
      status:         col.enum('ag_binding_status', ['unbound', 'bound', 'stale', 'revoked', 'failed']).notNull().default("unbound"),
      credentialRef:  col.varchar(96).nullable(),
      lastFactAt:     col.timestamp({ withTz: true }).nullable(),
      lastError:      col.text().nullable(),
      createdAt:      col.timestamp({ withTz: true }).notNull().defaultNow(),
      updatedAt:      col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['siteId', 'userId', 'pluginId', 'instanceKey'], { name: "uq_ag_bindings_user_plugin" }),
      t.unique(['siteId', 'pluginId', 'instanceKey', 'externalId'], { name: "uq_ag_bindings_external", where: "external_id IS NOT NULL" }),
      t.index(['status'], { name: "ix_ag_bindings_status" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 494 },
);

/** 来源：docs/02-数据模型.md:524（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginFacts = declare(
  'pluginFacts',
  defineTable(
    'ag_plugin_facts',
    {
      siteId:           col.uuid().notNull(),
      id:               col.uuid().primaryKey().defaultSql("uuidv7()"),
      userId:           col.uuid().notNull(),
      pluginId:         col.varchar(64).notNull(),
      namespace:        col.varchar(64).notNull(),
      instanceKey:      col.varchar(64).notNull().default("default"),
      facts:            col.jsonb().notNull(),
      schemaValidated:  col.boolean().notNull().default(true),
      fingerprint:      col.varchar(64).notNull(),
      source:           col.enum('ag_fact_source', ['declarative', 'process', 'llm', 'manual', 'import']).notNull(),
      costTokens:       col.integer().notNull().default(0),
      collectedAt:      col.timestamp({ withTz: true }).notNull().defaultNow(),
      expiresAt:        col.timestamp({ withTz: true }).nullable(),
    },
    (t) => [
      t.unique(['siteId', 'userId', 'namespace', 'instanceKey'], { name: "uq_ag_facts_user_namespace" }),
      t.index(['pluginId'], { name: "ix_ag_facts_plugin" }),
      t.index(['expiresAt'], { name: "ix_ag_facts_expiry" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 524 },
);

/** 来源：docs/02-数据模型.md:558（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginInvocations = declare(
  'pluginInvocations',
  defineTable(
    'ag_plugin_invocations',
    {
      siteId:            col.uuid().notNull(),
      id:                col.bigserial().primaryKey(),
      pluginId:          col.varchar(64).notNull(),
      op:                col.varchar(32).notNull(),
      userId:            col.uuid().nullable(),
      status:            col.enum('ag_invocation_status', ['ok', 'timeout', 'error', 'denied', 'rate_limited', 'crashed']).notNull(),
      deniedPermission:  col.varchar(160).nullable(),
      egressHost:        col.varchar(160).nullable(),
      durationMs:        col.integer().notNull().default(0),
      costTokens:        col.integer().notNull().default(0),
      error:             col.text().nullable(),
      traceId:           col.varchar(64).nullable(),
      createdAt:         col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.index(['pluginId', 'createdAt'], { name: "ix_ag_plugin_inv_plugin_time" }),
      t.index(['status', 'createdAt'], { name: "ix_ag_plugin_inv_status_time" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 558 },
);

/** 来源：docs/02-数据模型.md:586（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginStorage = declare(
  'pluginStorage',
  defineTable(
    'ag_plugin_storage',
    {
      ownerScope:   col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:      col.varchar(64).notNull().default("platform"),
      instanceKey:  col.varchar(32).notNull().default("default"),
      pluginId:     col.varchar(64).notNull(),
      key:          col.varchar(255).notNull(),
      value:        col.jsonb().notNull(),
      expiresAt:    col.timestamp({ withTz: true }).nullable(),
      updatedAt:    col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['ownerScope', 'ownerId', 'pluginId', 'instanceKey', 'key'], { name: "uq_ag_plugin_storage" }),
      t.index(['expiresAt'], { name: "ix_ag_plugin_storage_expiry" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 586 },
);

/** 来源：docs/02-数据模型.md:605（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const llmCache = declare(
  'llmCache',
  defineTable(
    'ag_llm_cache',
    {
      ownerScope:        col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:           col.varchar(64).notNull().default("platform"),
      id:                col.uuid().primaryKey().defaultSql("uuidv7()"),
      inputHash:         col.varchar(64).notNull(),
      model:             col.varchar(128).notNull(),
      promptVer:         col.varchar(32).notNull(),
      pluginId:          col.varchar(64).nullable(),
      result:            col.jsonb().notNull(),
      promptTokens:      col.integer().notNull().default(0),
      completionTokens:  col.integer().notNull().default(0),
      createdAt:         col.timestamp({ withTz: true }).notNull().defaultNow(),
      expiresAt:         col.timestamp({ withTz: true }).nullable(),
    },
    (t) => [
      t.unique(['ownerScope', 'ownerId', 'inputHash'], { name: "uq_ag_llm_cache_input" }),
      t.index(['expiresAt'], { name: "ix_ag_llm_cache_expiry" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 605 },
);

/** 来源：docs/02-数据模型.md:633（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginEndpoints = declare(
  'pluginEndpoints',
  defineTable(
    'ag_plugin_endpoints',
    {
      ownerScope:  col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:     col.varchar(64).notNull().default("platform"),
      id:          col.uuid().primaryKey().defaultSql("uuidv7()"),
      pluginId:    col.varchar(64).notNull(),
      method:      col.varchar(8).notNull(),
      path:        col.varchar(255).notNull(),
      mountPath:   col.varchar(320).notNull(),
      auth:        col.enum('ag_endpoint_auth', ['none', 'hmac', 'pluginToken', 'session', 'admin']).notNull(),
      visibility:  col.enum('ag_endpoint_visibility', ['public', 'authenticated', 'admin']).notNull().default("public"),
      kind:        col.enum('ag_endpoint_kind', ['handler', 'webhook']).notNull().default("handler"),
      spec:        col.jsonb().notNull(),
      enabled:     col.boolean().notNull().default(true),
      approvedBy:  col.uuid().nullable(),
      approvedAt:  col.timestamp({ withTz: true }).nullable(),
      createdAt:   col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['ownerScope', 'ownerId', 'method', 'mountPath'], { name: "uq_ag_plugin_endpoints_route" }),
      t.index(['pluginId'], { name: "ix_ag_plugin_endpoints_plugin" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 633 },
);

/** 来源：docs/02-数据模型.md:669（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginUiContributions = declare(
  'pluginUiContributions',
  defineTable(
    'ag_plugin_ui_contributions',
    {
      ownerScope:  col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:     col.varchar(64).notNull().default("platform"),
      id:          col.uuid().primaryKey().defaultSql("uuidv7()"),
      pluginId:    col.varchar(64).notNull(),
      type:        col.enum('ag_ui_contrib_type', ['nav', 'page', 'slot', 'settings', 'adminPage']).notNull(),
      key:         col.varchar(160).notNull(),
      audience:    col.enum('ag_ui_audience', ['user', 'admin', 'both']).notNull().default("user"),
      renderMode:  col.enum('ag_ui_render', ['declarative', 'remote-module', 'iframe']).notNull().default("declarative"),
      spec:        col.jsonb().notNull(),
      order:       col.integer().notNull().default(100),
      enabled:     col.boolean().notNull().default(true),
      approvedBy:  col.uuid().nullable(),
      approvedAt:  col.timestamp({ withTz: true }).nullable(),
      createdAt:   col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['type', 'key'], { name: "uq_ag_plugin_ui_key" }),
      t.index(['pluginId'], { name: "ix_ag_plugin_ui_plugin" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 669 },
);

/** 来源：docs/02-数据模型.md:706（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginPackages = declare(
  'pluginPackages',
  defineTable(
    'ag_plugin_packages',
    {
      id:           col.uuid().primaryKey().defaultSql("uuidv7()"),
      pluginId:     col.varchar(64).notNull(),
      version:      col.varchar(32).notNull(),
      digest:       col.varchar(128).notNull(),
      sizeBytes:    col.bigint().notNull(),
      storageKind:  col.enum('ag_pkg_storage', ['db', 'objectstore']).notNull().default("db"),
      objectKey:    col.varchar(512).nullable(),
      blob:         col.binary(255).nullable(),
      signature:    col.text().nullable(),
      createdAt:    col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['pluginId', 'version'], { name: "uq_ag_plugin_packages" }),
    ],
    { exemptReason: "外置插件包体的权威存储：包体是平台级分发物，与站点无关", siteScoped: false },
  ),
  { doc: 'docs/02-数据模型.md', line: 706 },
);

