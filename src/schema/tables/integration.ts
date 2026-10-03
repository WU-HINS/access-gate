/**
 * ⑤ 集成与协同域 —— 由 tools/extract-doc-schema.ts 从 docs/02-数据模型.md 提取生成。
 * 请勿手改：改文档后重跑 `npm run schema:extract`。
 */
import { col, declare, defineTable, t } from '../dsl.ts';

/** 来源：docs/02-数据模型.md:1010（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const externalSubjects = declare(
  'externalSubjects',
  defineTable(
    'ag_external_subjects',
    {
      siteId:       col.uuid().notNull(),
      id:           col.uuid().primaryKey().defaultSql("uuidv7()"),
      provider:     col.varchar(64).notNull(),
      externalId:   col.varchar(128).notNull(),
      displayName:  col.varchar(128).nullable(),
      email:        col.varchar(255).nullable(),
      attributes:   col.jsonb().notNull().defaultSql("'{}'"),
      watched:      col.jsonb().notNull().defaultSql("'[]'"),
      fingerprint:  col.varchar(64).notNull(),
      raw:          col.jsonb().notNull().defaultSql("'{}'"),
      syncedAt:     col.timestamp({ withTz: true }).notNull().defaultNow(),
      deletedAt:    col.timestamp({ withTz: true }).nullable(),
    },
    (t) => [
      t.unique(['siteId', 'provider', 'externalId'], { name: "uq_ag_external_subjects" }),
      t.index(['provider', 'email'], { name: "ix_ag_ext_subjects_email" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1010 },
);

/** 来源：docs/02-数据模型.md:1040（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const providerSyncState = declare(
  'providerSyncState',
  defineTable(
    'ag_provider_sync_state',
    {
      siteId:             col.uuid().notNull(),
      provider:           col.varchar(64).notNull(),
      cursor:             col.varchar(255).nullable(),
      lastSeenKey:        col.varchar(128).nullable(),
      lastIncrementalAt:  col.timestamp({ withTz: true }).nullable(),
      lastFullSyncAt:     col.timestamp({ withTz: true }).nullable(),
      lastFullSyncCount:  col.integer().notNull().default(0),
      lastError:          col.text().nullable(),
      capabilities:       col.jsonb().notNull().defaultSql("'{}'"),
      driftPolicy:        col.enum('ag_drift_policy', ['platform_wins', 'manual_wins', 'ignore']).notNull().default("platform_wins"),
      updatedAt:          col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.primaryKey(['siteId', 'provider'], { name: "pk_ag_provider_sync_state" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1040 },
);

/** 来源：docs/02-数据模型.md:1067（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const secrets = declare(
  'secrets',
  defineTable(
    'ag_secrets',
    {
      ownerScope:  col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:     col.varchar(64).notNull().default("platform"),
      id:          col.uuid().primaryKey().defaultSql("uuidv7()"),
      key:         col.varchar(64).notNull(),
      ciphertext:  col.text().notNull(),
      iv:          col.varchar(32).notNull(),
      authTag:     col.varchar(32).notNull(),
      keyVersion:  col.integer().notNull().default(1),
      rotatedAt:   col.timestamp({ withTz: true }).nullable(),
      updatedAt:   col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['ownerScope', 'ownerId', 'key'], { name: "uq_ag_secrets_key" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1067 },
);

/** 来源：docs/02-数据模型.md:1092（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const oidcSigningKeys = declare(
  'oidcSigningKeys',
  defineTable(
    'ag_oidc_signing_keys',
    {
      id:                    col.uuid().primaryKey().defaultSql("uuidv7()"),
      kid:                   col.varchar(64).notNull(),
      kty:                   col.enum('ag_jwk_kty', ['EC', 'RSA', 'OKP']).notNull(),
      alg:                   col.varchar(16).notNull(),
      crv:                   col.varchar(16).nullable(),
      publicJwk:             col.jsonb().notNull(),
      privateCiphertext:     col.text().notNull(),
      privateIv:             col.varchar(32).notNull(),
      privateAuthTag:        col.varchar(32).notNull(),
      masterKeyVersion:      col.integer().notNull().default(1),
      status:                col.enum('ag_signing_key_status', ['active', 'standby', 'retiring', 'retired']).notNull().default("standby"),
      activatedAt:           col.timestamp({ withTz: true }).nullable(),
      retiredFromSigningAt:  col.timestamp({ withTz: true }).nullable(),
      removeAfter:           col.timestamp({ withTz: true }).nullable(),
      createdAt:             col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['kid'], { name: "uq_ag_oidc_keys_kid" }),
      t.unique(['alg'], { name: "uq_ag_oidc_keys_active_alg", where: "status = 'active'" }),
      t.unique(['alg'], { name: "uq_ag_oidc_keys_standby_alg", where: "status = 'standby'" }),
      t.index(['status'], { name: "ix_ag_oidc_keys_status" }),
      t.index(['removeAfter'], { name: "ix_ag_oidc_keys_remove_after" }),
    ],
    { exemptReason: "平台级 OIDC 签名密钥" },
  ),
  { doc: 'docs/02-数据模型.md', line: 1092 },
);

/** 来源：docs/02-数据模型.md:1144（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const verifyClients = declare(
  'verifyClients',
  defineTable(
    'ag_verify_clients',
    {
      ownerScope:       col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:          col.varchar(64).notNull().default("platform"),
      id:               col.uuid().primaryKey().defaultSql("uuidv7()"),
      clientId:         col.varchar(48).notNull(),
      name:             col.varchar(128).notNull(),
      secretHash:       col.varchar(255).notNull(),
      secretPrefix:     col.varchar(16).notNull(),
      scopes:           col.jsonb().notNull(),
      allowedSubjects:  col.jsonb().notNull(),
      callbackUrl:      col.varchar(512).nullable(),
      status:           col.enum('ag_client_status', ['active', 'suspended', 'revoked']).notNull().default("active"),
      lastUsedAt:       col.timestamp({ withTz: true }).nullable(),
      createdBy:        col.uuid().nullable(),
      createdAt:        col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['clientId'], { name: "uq_ag_verify_clients_id" }),
      t.index(['status'], { name: "ix_ag_verify_clients_status" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1144 },
);

/** 来源：docs/02-数据模型.md:1173（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const verifyChallenges = declare(
  'verifyChallenges',
  defineTable(
    'ag_verify_challenges',
    {
      ownerScope:    col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:       col.varchar(64).notNull().default("platform"),
      id:            col.uuid().primaryKey().defaultSql("uuidv7()"),
      challengeId:   col.varchar(48).notNull(),
      userCode:      col.varchar(16).notNull(),
      clientId:      col.varchar(48).notNull(),
      subjectType:   col.varchar(32).notNull(),
      subjectValue:  col.varchar(255).notNull(),
      scopes:        col.jsonb().notNull(),
      status:        col.enum('ag_challenge_status', ['pending', 'approved', 'denied', 'expired', 'consumed']).notNull().default("pending"),
      userId:        col.uuid().nullable(),
      approvedAt:    col.timestamp({ withTz: true }).nullable(),
      expiresAt:     col.timestamp({ withTz: true }).notNull(),
      deliveries:    col.integer().notNull().default(0),
      lastPolledAt:  col.timestamp({ withTz: true }).nullable(),
      createdAt:     col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['challengeId'], { name: "uq_ag_challenges_id" }),
      t.unique(['userCode'], { name: "uq_ag_challenges_code", where: "status = 'pending'" }),
      t.index(['expiresAt'], { name: "ix_ag_challenges_expiry" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1173 },
);

/** 来源：docs/02-数据模型.md:1212（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const verifyAssertions = declare(
  'verifyAssertions',
  defineTable(
    'ag_verify_assertions',
    {
      ownerScope:    col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:       col.varchar(64).notNull().default("platform"),
      id:            col.bigserial().primaryKey(),
      clientId:      col.varchar(48).notNull(),
      subjectType:   col.varchar(32).notNull(),
      subjectValue:  col.varchar(255).notNull(),
      userId:        col.uuid().nullable(),
      claims:        col.jsonb().notNull(),
      matched:       col.boolean().notNull(),
      signatureKid:  col.varchar(64).nullable(),
      via:           col.enum('ag_assert_via', ['direct', 'challenge', 'event']).notNull(),
      ip:            col.varchar(64).nullable(),
      expiresAt:     col.timestamp({ withTz: true }).notNull(),
      revokedAt:     col.timestamp({ withTz: true }).nullable(),
      createdAt:     col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.index(['clientId', 'createdAt'], { name: "ix_ag_assertions_client_time" }),
      t.index(['subjectType', 'subjectValue'], { name: "ix_ag_assertions_subject" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1212 },
);

/** 来源：docs/02-数据模型.md:1350（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const verifyNonces = declare(
  'verifyNonces',
  defineTable(
    'ag_verify_nonces',
    {
      clientId:   col.varchar(48).notNull(),
      nonce:      col.varchar(128).notNull(),
      expiresAt:  col.timestamp({ withTz: true }).notNull(),
      createdAt:  col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.primaryKey(['clientId', 'nonce'], { name: "pk_ag_verify_nonces" }),
      t.index(['expiresAt'], { name: "ix_ag_verify_nonces_expires" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1350 },
);

/** 来源：docs/02-数据模型.md:1374（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const oauthClients = declare(
  'oauthClients',
  defineTable(
    'ag_oauth_clients',
    {
      clientId:      col.varchar(64).primaryKey(),
      name:          col.varchar(128).notNull(),
      redirectUris:  col.jsonb().notNull().defaultSql("'[]'"),
      scopes:        col.jsonb().notNull().defaultSql("'[]'"),
      status:        col.enum('ag_oauth_client_status', ['active', 'disabled']).notNull().default("active"),
      createdAt:     col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.index(['status'], { name: "ix_ag_oauth_clients_status" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1374 },
);

/** 来源：docs/02-数据模型.md:1387（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const oauthCodes = declare(
  'oauthCodes',
  defineTable(
    'ag_oauth_codes',
    {
      code:           col.varchar(128).primaryKey(),
      clientId:       col.varchar(64).notNull(),
      redirectUri:    col.varchar(512).notNull(),
      subject:        col.uuid().notNull(),
      displayName:    col.varchar(128),
      scopes:         col.jsonb().notNull().defaultSql("'[]'"),
      codeChallenge:  col.varchar(128).notNull(),
      nonce:          col.varchar(128),
      issuedAt:       col.timestamp({ withTz: true }).notNull().defaultNow(),
      expiresAt:      col.timestamp({ withTz: true }).notNull(),
      redeemed:       col.boolean().notNull().default(false),
    },
    (t) => [
      t.index(['expiresAt'], { name: "ix_ag_oauth_codes_expires" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1387 },
);

/** 来源：docs/02-数据模型.md:1408（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const oauthRefreshTokens = declare(
  'oauthRefreshTokens',
  defineTable(
    'ag_oauth_refresh_tokens',
    {
      tokenHash:  col.varchar(128).primaryKey(),
      clientId:   col.varchar(64).notNull(),
      subject:    col.uuid().notNull(),
      scopes:     col.jsonb().notNull().defaultSql("'[]'"),
      expiresAt:  col.timestamp({ withTz: true }).notNull(),
      revoked:    col.boolean().notNull().default(false),
      createdAt:  col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.index(['subject'], { name: "ix_ag_oauth_refresh_subject" }),
      t.index(['expiresAt'], { name: "ix_ag_oauth_refresh_expires" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1408 },
);

/** 来源：docs/02-数据模型.md:1239（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const pluginTokens = declare(
  'pluginTokens',
  defineTable(
    'ag_plugin_tokens',
    {
      ownerScope:   col.enum('ag_owner_scope', ['platform', 'developer', 'site', 'user']).notNull(),
      ownerId:      col.varchar(64).notNull().default("platform"),
      id:           col.uuid().primaryKey().defaultSql("uuidv7()"),
      pluginId:     col.varchar(64).notNull(),
      name:         col.varchar(64).notNull(),
      tokenHash:    col.varchar(255).notNull(),
      tokenPrefix:  col.varchar(16).notNull(),
      scopes:       col.jsonb().notNull().defaultSql("'[]'"),
      expiresAt:    col.timestamp({ withTz: true }).nullable(),
      lastUsedAt:   col.timestamp({ withTz: true }).nullable(),
      revokedAt:    col.timestamp({ withTz: true }).nullable(),
      createdAt:    col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['tokenHash'], { name: "uq_ag_plugin_tokens_hash" }),
      t.index(['pluginId'], { name: "ix_ag_plugin_tokens_plugin" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1239 },
);

/** 来源：docs/02-数据模型.md:1265（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const oidcProviders = declare(
  'oidcProviders',
  defineTable(
    'ag_oidc_providers',
    {
      id:                  col.uuid().primaryKey().defaultSql("uuidv7()"),
      ref:                 col.varchar(96).notNull(),
      label:               col.varchar(128).notNull(),
      direction:           col.enum('ag_oidc_direction', ['outbound', 'inbound']).notNull(),
      issuer:              col.varchar(512).notNull(),
      wellKnown:           col.varchar(512).nullable(),
      clientId:            col.varchar(256).nullable(),
      clientSecretRef:     col.varchar(96).nullable(),
      redirectUris:        col.jsonb().notNull().defaultSql("'[]'"),
      scopes:              col.jsonb().notNull().defaultSql("'[]'"),
      signingAlgs:         col.jsonb().notNull().defaultSql("'[]'"),
      exposedClaims:       col.jsonb().notNull().defaultSql("'[]'"),
      allowPlatformLogin:  col.boolean().notNull().default(false),
      status:              col.enum('ag_oidc_status', ['active', 'suspended', 'revoked']).notNull().default("active"),
      createdAt:           col.timestamp({ withTz: true }).notNull().defaultNow(),
      updatedAt:           col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['ref'], { name: "uq_ag_oidc_providers_ref" }),
      t.unique(['issuer'], { name: "uq_ag_oidc_providers_issuer" }),
      t.index(['direction'], { name: "ix_ag_oidc_providers_dir" }),
    ],
    { exemptReason: "平台级 IdP 配置" },
  ),
  { doc: 'docs/02-数据模型.md', line: 1265 },
);

/** 来源：docs/02-数据模型.md:1308（由 tools/extract-doc-schema.ts 生成，请勿手改） */
export const oidcLoginTransactions = declare(
  'oidcLoginTransactions',
  defineTable(
    'ag_oidc_login_transactions',
    {
      state:         col.varchar(128).primaryKey(),
      codeVerifier:  col.varchar(256).notNull(),
      nonce:         col.varchar(128).notNull(),
      returnTo:      col.varchar(512).notNull(),
      targetSiteId:  col.uuid().nullable(),
      expiresAt:     col.timestamp({ withTz: true }).notNull(),
      createdAt:     col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.index(['expiresAt'], { name: "ix_ag_oidc_login_tx_expires" }),
    ],
  ),
  { doc: 'docs/02-数据模型.md', line: 1308 },
);

