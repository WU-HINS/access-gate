-- access-gate 初始化迁移（0001_init）
--
-- ⚠ 自动生成，请勿手改：本文件由 `npm run db:generate` 从 Schema 声明层 IR 推导。
--    （契约见 docs/12-Schema声明层接口契约.md §5.2「DDL 禁止手写」）
-- 来源：真实声明 src/schema/tables/index.ts（48 张表）
-- 规模：表 48 · 枚举 48 · 索引 98
-- 复跑：npm run db:generate && npm run db:migrate && npm run db:check

CREATE TYPE ag_user_status AS ENUM ('pending', 'active', 'suspended', 'deleted');

CREATE TYPE ag_user_source AS ENUM ('local', 'oidc');

CREATE TYPE ag_owner_scope AS ENUM ('platform', 'developer', 'site', 'user');

CREATE TYPE ag_session_realm AS ENUM ('developer', 'enduser');

CREATE TYPE ag_email_list_type AS ENUM ('allow', 'deny');

CREATE TYPE ag_email_match_type AS ENUM ('exact', 'suffix', 'glob', 'regex');

CREATE TYPE ag_dev_role AS ENUM ('admin', 'developer');

CREATE TYPE ag_dev_status AS ENUM ('active', 'suspended', 'deleted');

CREATE TYPE ag_site_status AS ENUM ('active', 'suspended', 'archived');

CREATE TYPE ag_plugin_config_scope AS ENUM ('developer', 'site');

CREATE TYPE ag_invite_site_mode AS ENUM ('auto', 'existing');

CREATE TYPE ag_plugin_kind AS ENUM ('provider', 'channel', 'enricher', 'action', 'identity', 'feature');

CREATE TYPE ag_plugin_runtime AS ENUM ('declarative', 'process', 'container', 'in-process');

CREATE TYPE ag_plugin_source AS ENUM ('builtin', 'uploaded', 'url', 'directory');

CREATE TYPE ag_plugin_status AS ENUM ('installed', 'validated', 'enabled', 'disabled', 'error', 'removed');

CREATE TYPE ag_config_status AS ENUM ('draft', 'active', 'archived');

CREATE TYPE ag_binding_status AS ENUM ('unbound', 'bound', 'stale', 'revoked', 'failed');

CREATE TYPE ag_fact_source AS ENUM ('declarative', 'process', 'llm', 'manual', 'import');

CREATE TYPE ag_invocation_status AS ENUM ('ok', 'timeout', 'error', 'denied', 'rate_limited', 'crashed');

CREATE TYPE ag_endpoint_auth AS ENUM ('none', 'hmac', 'pluginToken', 'session', 'admin');

CREATE TYPE ag_endpoint_visibility AS ENUM ('public', 'authenticated', 'admin');

CREATE TYPE ag_endpoint_kind AS ENUM ('handler', 'webhook');

CREATE TYPE ag_ui_contrib_type AS ENUM ('nav', 'page', 'slot', 'settings', 'adminPage');

CREATE TYPE ag_ui_audience AS ENUM ('user', 'admin', 'both');

CREATE TYPE ag_ui_render AS ENUM ('declarative', 'remote-module', 'iframe');

CREATE TYPE ag_pkg_storage AS ENUM ('db', 'objectstore');

CREATE TYPE ag_policy_collision AS ENUM ('exclusive', 'additive', 'highest_tier');

CREATE TYPE ag_spec_origin AS ENUM ('yaml', 'json', 'graph', 'migrated');

CREATE TYPE ag_policy_version_status AS ENUM ('draft', 'active', 'archived');

CREATE TYPE ag_assign_target AS ENUM ('all', 'user', 'tag', 'cohort');

CREATE TYPE ag_state AS ENUM ('unknown', 'evaluating', 'satisfied', 'granted', 'at_risk', 'revoked', 'blocked');

CREATE TYPE ag_eval_outcome AS ENUM ('satisfied', 'unsatisfied', 'indeterminate', 'error');

CREATE TYPE ag_eval_trigger AS ENUM ('login', 'binding', 'manual', 'scheduled', 'webhook', 'admin');

CREATE TYPE ag_action_status AS ENUM ('planned', 'running', 'succeeded', 'skipped', 'failed', 'rolled_back', 'blocked_unbound', 'partially_applied');

CREATE TYPE ag_grant_state AS ENUM ('pending', 'in_flight', 'confirmed', 'unknown');

CREATE TYPE ag_drift_policy AS ENUM ('platform_wins', 'manual_wins', 'ignore');

CREATE TYPE ag_jwk_kty AS ENUM ('EC', 'RSA', 'OKP');

CREATE TYPE ag_signing_key_status AS ENUM ('active', 'standby', 'retiring', 'retired');

CREATE TYPE ag_client_status AS ENUM ('active', 'suspended', 'revoked');

CREATE TYPE ag_challenge_status AS ENUM ('pending', 'approved', 'denied', 'expired', 'consumed');

CREATE TYPE ag_assert_via AS ENUM ('direct', 'challenge', 'event');

CREATE TYPE ag_oauth_client_status AS ENUM ('active', 'disabled');

CREATE TYPE ag_oidc_direction AS ENUM ('outbound', 'inbound');

CREATE TYPE ag_oidc_status AS ENUM ('active', 'suspended', 'revoked');

CREATE TYPE ag_actor_type AS ENUM ('user', 'admin', 'system', 'job');

CREATE TYPE ag_realm AS ENUM ('developer', 'enduser');

CREATE TYPE ag_job_status AS ENUM ('idle', 'queued', 'running', 'succeeded', 'failed', 'skipped');

CREATE TYPE ag_outbox_status AS ENUM ('pending', 'delivering', 'delivered', 'dead');

CREATE OR REPLACE FUNCTION fn_ag_users_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_identities_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_developers_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_sites_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_plugin_instances_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_platform_settings_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_plugins_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_plugin_bindings_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_plugin_storage_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_policies_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_user_policy_state_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_provider_sync_state_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_secrets_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_oidc_providers_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_jobs_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_ag_quota_counters_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE ag_users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email varchar(255) NOT NULL,
  email_verified boolean DEFAULT false NOT NULL,
  username varchar(64) NOT NULL,
  password_hash varchar(255),
  status ag_user_status DEFAULT 'pending' NOT NULL,
  source ag_user_source DEFAULT 'local' NOT NULL,
  locale varchar(16) DEFAULT 'zh-CN' NOT NULL,
  tags jsonb DEFAULT '[]' NOT NULL,
  primary_subject jsonb,
  profile jsonb DEFAULT '{}' NOT NULL,
  last_login_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE ag_identities (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  provider varchar(64) NOT NULL,
  provider_user_id varchar(255) NOT NULL,
  subject_ref jsonb,
  claim_snapshot jsonb DEFAULT '{}' NOT NULL,
  verified_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  token_hash varchar(128) NOT NULL,
  user_agent varchar(512),
  ip varchar(64),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  realm ag_session_realm NOT NULL,
  active_developer_id uuid,
  active_site_id uuid,
  active_site_updated_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_email_rules (
  site_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  list_type ag_email_list_type NOT NULL,
  match_type ag_email_match_type NOT NULL,
  pattern varchar(255) NOT NULL,
  priority integer DEFAULT 100 NOT NULL,
  note varchar(255),
  enabled boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_invite_codes (
  site_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  code varchar(64) NOT NULL,
  created_by uuid,
  max_uses integer DEFAULT 1 NOT NULL,
  used_count integer DEFAULT 0 NOT NULL,
  grants_facts jsonb DEFAULT '{}' NOT NULL,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_developers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  username varchar(64) NOT NULL,
  display_name varchar(128) NOT NULL,
  email varchar(255) NOT NULL,
  password_hash varchar(255),
  email_verified boolean DEFAULT false NOT NULL,
  role ag_dev_role DEFAULT 'developer' NOT NULL,
  status ag_dev_status DEFAULT 'active' NOT NULL,
  locale varchar(16) DEFAULT 'zh-CN' NOT NULL,
  security jsonb DEFAULT '{}' NOT NULL,
  last_login_at timestamptz,
  user_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_sites (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  site_id varchar(48) NOT NULL,
  nickname varchar(128) NOT NULL,
  developer_id uuid NOT NULL,
  status ag_site_status DEFAULT 'active' NOT NULL,
  quota jsonb DEFAULT '{}' NOT NULL,
  settings jsonb DEFAULT '{}' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_plugin_instances (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  plugin_id varchar(64) NOT NULL,
  instance_key varchar(32) DEFAULT 'default' NOT NULL,
  scope ag_plugin_config_scope NOT NULL,
  developer_id uuid,
  site_id uuid,
  label varchar(128),
  config jsonb NOT NULL,
  config_hash varchar(64) NOT NULL,
  enabled boolean DEFAULT false NOT NULL,
  updated_by uuid,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT ck_ag_plugin_instances_scope CHECK ((scope = 'site' AND site_id IS NOT NULL AND developer_id IS NULL) OR (scope = 'developer' AND developer_id IS NOT NULL AND site_id IS NULL))
);

CREATE TABLE ag_dev_invitations (
  site_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  code_hash varchar(128) NOT NULL,
  code_prefix varchar(16) NOT NULL,
  target_email varchar(255) NOT NULL,
  site_mode ag_invite_site_mode DEFAULT 'auto' NOT NULL,
  max_uses integer DEFAULT 1 NOT NULL,
  used_count integer DEFAULT 0 NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid,
  created_by uuid NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_platform_settings (
  key varchar(96) PRIMARY KEY,
  value jsonb NOT NULL,
  locked_by_env boolean DEFAULT false NOT NULL,
  updated_by uuid,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_plugins (
  id varchar(64) PRIMARY KEY,
  kind ag_plugin_kind NOT NULL,
  name varchar(128) NOT NULL,
  version varchar(32) NOT NULL,
  api_version varchar(32) NOT NULL,
  runtime ag_plugin_runtime NOT NULL,
  source ag_plugin_source NOT NULL,
  status ag_plugin_status DEFAULT 'installed' NOT NULL,
  manifest jsonb NOT NULL,
  namespace varchar(64) NOT NULL,
  digest varchar(128) NOT NULL,
  signature_verified boolean DEFAULT false NOT NULL,
  runtime_state jsonb DEFAULT '{}' NOT NULL,
  enabled_at timestamptz,
  last_error text,
  installed_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_plugin_configs (
  id bigserial PRIMARY KEY,
  instance_id uuid NOT NULL,
  plugin_id varchar(64) NOT NULL,
  version integer NOT NULL,
  config jsonb NOT NULL,
  config_hash varchar(64) NOT NULL,
  status ag_config_status DEFAULT 'active' NOT NULL,
  updated_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_plugin_grants (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  plugin_id varchar(64) NOT NULL,
  permission varchar(160) NOT NULL,
  granted_by uuid,
  granted_at timestamptz DEFAULT now() NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE ag_plugin_bindings (
  site_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  plugin_id varchar(64) NOT NULL,
  instance_key varchar(64) DEFAULT 'default' NOT NULL,
  external_id varchar(255),
  external_name varchar(255),
  status ag_binding_status DEFAULT 'unbound' NOT NULL,
  credential_ref varchar(96),
  last_fact_at timestamptz,
  last_error text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_plugin_facts (
  site_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  plugin_id varchar(64) NOT NULL,
  namespace varchar(64) NOT NULL,
  instance_key varchar(64) DEFAULT 'default' NOT NULL,
  facts jsonb NOT NULL,
  schema_validated boolean DEFAULT true NOT NULL,
  fingerprint varchar(64) NOT NULL,
  source ag_fact_source NOT NULL,
  cost_tokens integer DEFAULT 0 NOT NULL,
  collected_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz
);

CREATE TABLE ag_plugin_invocations (
  site_id uuid NOT NULL,
  id bigserial PRIMARY KEY,
  plugin_id varchar(64) NOT NULL,
  op varchar(32) NOT NULL,
  user_id uuid,
  status ag_invocation_status NOT NULL,
  denied_permission varchar(160),
  egress_host varchar(160),
  duration_ms integer DEFAULT 0 NOT NULL,
  cost_tokens integer DEFAULT 0 NOT NULL,
  error text,
  trace_id varchar(64),
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_plugin_storage (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  instance_key varchar(32) DEFAULT 'default' NOT NULL,
  plugin_id varchar(64) NOT NULL,
  key varchar(255) NOT NULL,
  value jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_llm_cache (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  input_hash varchar(64) NOT NULL,
  model varchar(128) NOT NULL,
  prompt_ver varchar(32) NOT NULL,
  plugin_id varchar(64),
  result jsonb NOT NULL,
  prompt_tokens integer DEFAULT 0 NOT NULL,
  completion_tokens integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz
);

CREATE TABLE ag_plugin_endpoints (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  plugin_id varchar(64) NOT NULL,
  method varchar(8) NOT NULL,
  path varchar(255) NOT NULL,
  mount_path varchar(320) NOT NULL,
  auth ag_endpoint_auth NOT NULL,
  visibility ag_endpoint_visibility DEFAULT 'public' NOT NULL,
  kind ag_endpoint_kind DEFAULT 'handler' NOT NULL,
  spec jsonb NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_plugin_ui_contributions (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  plugin_id varchar(64) NOT NULL,
  type ag_ui_contrib_type NOT NULL,
  key varchar(160) NOT NULL,
  audience ag_ui_audience DEFAULT 'user' NOT NULL,
  render_mode ag_ui_render DEFAULT 'declarative' NOT NULL,
  spec jsonb NOT NULL,
  "order" integer DEFAULT 100 NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_plugin_packages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  plugin_id varchar(64) NOT NULL,
  version varchar(32) NOT NULL,
  digest varchar(128) NOT NULL,
  size_bytes bigint NOT NULL,
  storage_kind ag_pkg_storage DEFAULT 'db' NOT NULL,
  object_key varchar(512),
  blob bytea,
  signature text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_policies (
  site_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  code varchar(64) NOT NULL,
  name varchar(128) NOT NULL,
  description text,
  enabled boolean DEFAULT true NOT NULL,
  priority integer DEFAULT 100 NOT NULL,
  tier integer,
  requires_tier integer,
  collision ag_policy_collision DEFAULT 'exclusive' NOT NULL,
  active_version_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_policy_versions (
  site_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  policy_id uuid NOT NULL,
  version integer NOT NULL,
  spec jsonb NOT NULL,
  spec_yaml text,
  spec_json jsonb,
  spec_graph jsonb,
  origin ag_spec_origin DEFAULT 'yaml' NOT NULL,
  spec_hash varchar(64) NOT NULL,
  status ag_policy_version_status DEFAULT 'draft' NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  activated_at timestamptz
);

CREATE TABLE ag_policy_assignments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  site_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  target_type ag_assign_target NOT NULL,
  target_ref varchar(128),
  rollout_percent integer DEFAULT 100 NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_user_policy_state (
  baseline jsonb DEFAULT '{}'::jsonb NOT NULL,
  site_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  state ag_state DEFAULT 'unknown' NOT NULL,
  satisfied_at timestamptz,
  granted_at timestamptz,
  grace_until timestamptz,
  next_check_at timestamptz,
  last_outcome ag_eval_outcome,
  indeterminate_since timestamptz,
  consecutive_indeterminate integer DEFAULT 0 NOT NULL,
  version integer DEFAULT 0 NOT NULL,
  last_changed_at timestamptz,
  action_seq bigint DEFAULT 0 NOT NULL,
  last_eval_id bigint,
  fail_streak integer DEFAULT 0 NOT NULL,
  applied_actions jsonb DEFAULT '{}' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_evaluations (
  site_id uuid NOT NULL,
  trace_id varchar(48),
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  policy_ver_id uuid NOT NULL,
  trigger ag_eval_trigger NOT NULL,
  inputs jsonb NOT NULL,
  item_results jsonb NOT NULL,
  outcome ag_eval_outcome NOT NULL,
  score numeric(10,2),
  duration_ms integer DEFAULT 0 NOT NULL,
  error text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_actions_log (
  trace_id varchar(48),
  action_seq bigint NOT NULL,
  site_id uuid NOT NULL,
  id bigserial PRIMARY KEY,
  eval_id bigint,
  user_id uuid NOT NULL,
  policy_id uuid,
  action varchar(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  params jsonb NOT NULL,
  status ag_action_status DEFAULT 'planned' NOT NULL,
  result jsonb,
  blocked_reason varchar(64),
  skip_reason varchar(64),
  attempts integer DEFAULT 0 NOT NULL,
  request jsonb,
  response jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_checkin_entitlements (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  scope varchar(32) DEFAULT 'daily' NOT NULL,
  source_policy_id uuid,
  granted_at timestamptz DEFAULT now() NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE ag_checkin_records (
  site_id uuid NOT NULL,
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  checkin_date date NOT NULL,
  quota_awarded integer NOT NULL,
  grant_state ag_grant_state DEFAULT 'pending' NOT NULL,
  request_id varchar(64),
  grant_via varchar(32) DEFAULT 'provider' NOT NULL,
  provider_log_id bigint,
  streak integer DEFAULT 1 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_external_subjects (
  site_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  provider varchar(64) NOT NULL,
  external_id varchar(128) NOT NULL,
  display_name varchar(128),
  email varchar(255),
  attributes jsonb DEFAULT '{}' NOT NULL,
  watched jsonb DEFAULT '[]' NOT NULL,
  fingerprint varchar(64) NOT NULL,
  raw jsonb DEFAULT '{}' NOT NULL,
  synced_at timestamptz DEFAULT now() NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE ag_provider_sync_state (
  site_id uuid NOT NULL,
  provider varchar(64) NOT NULL,
  cursor varchar(255),
  last_seen_key varchar(128),
  last_incremental_at timestamptz,
  last_full_sync_at timestamptz,
  last_full_sync_count integer DEFAULT 0 NOT NULL,
  last_error text,
  capabilities jsonb DEFAULT '{}' NOT NULL,
  drift_policy ag_drift_policy DEFAULT 'platform_wins' NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (site_id, provider)
);

CREATE TABLE ag_secrets (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  key varchar(64) NOT NULL,
  ciphertext text NOT NULL,
  iv varchar(32) NOT NULL,
  auth_tag varchar(32) NOT NULL,
  key_version integer DEFAULT 1 NOT NULL,
  rotated_at timestamptz,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_oidc_signing_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kid varchar(64) NOT NULL,
  kty ag_jwk_kty NOT NULL,
  alg varchar(16) NOT NULL,
  crv varchar(16),
  public_jwk jsonb NOT NULL,
  private_ciphertext text NOT NULL,
  private_iv varchar(32) NOT NULL,
  private_auth_tag varchar(32) NOT NULL,
  master_key_version integer DEFAULT 1 NOT NULL,
  status ag_signing_key_status DEFAULT 'standby' NOT NULL,
  activated_at timestamptz,
  retired_from_signing_at timestamptz,
  remove_after timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_verify_clients (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id varchar(48) NOT NULL,
  name varchar(128) NOT NULL,
  secret_hash varchar(255) NOT NULL,
  secret_prefix varchar(16) NOT NULL,
  scopes jsonb NOT NULL,
  allowed_subjects jsonb NOT NULL,
  callback_url varchar(512),
  status ag_client_status DEFAULT 'active' NOT NULL,
  last_used_at timestamptz,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_verify_challenges (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  challenge_id varchar(48) NOT NULL,
  user_code varchar(16) NOT NULL,
  client_id varchar(48) NOT NULL,
  subject_type varchar(32) NOT NULL,
  subject_value varchar(255) NOT NULL,
  scopes jsonb NOT NULL,
  status ag_challenge_status DEFAULT 'pending' NOT NULL,
  user_id uuid,
  approved_at timestamptz,
  expires_at timestamptz NOT NULL,
  deliveries integer DEFAULT 0 NOT NULL,
  last_polled_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_verify_assertions (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id bigserial PRIMARY KEY,
  client_id varchar(48) NOT NULL,
  subject_type varchar(32) NOT NULL,
  subject_value varchar(255) NOT NULL,
  user_id uuid,
  claims jsonb NOT NULL,
  matched boolean NOT NULL,
  signature_kid varchar(64),
  via ag_assert_via NOT NULL,
  ip varchar(64),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_verify_nonces (
  client_id varchar(48) NOT NULL,
  nonce varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (client_id, nonce)
);

CREATE TABLE ag_oauth_clients (
  client_id varchar(64) PRIMARY KEY,
  name varchar(128) NOT NULL,
  redirect_uris jsonb DEFAULT '[]' NOT NULL,
  scopes jsonb DEFAULT '[]' NOT NULL,
  status ag_oauth_client_status DEFAULT 'active' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_oauth_codes (
  code varchar(128) PRIMARY KEY,
  client_id varchar(64) NOT NULL,
  redirect_uri varchar(512) NOT NULL,
  subject uuid NOT NULL,
  display_name varchar(128),
  scopes jsonb DEFAULT '[]' NOT NULL,
  code_challenge varchar(128) NOT NULL,
  nonce varchar(128),
  issued_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed boolean DEFAULT false NOT NULL
);

CREATE TABLE ag_oauth_refresh_tokens (
  token_hash varchar(128) PRIMARY KEY,
  client_id varchar(64) NOT NULL,
  subject uuid NOT NULL,
  scopes jsonb DEFAULT '[]' NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_plugin_tokens (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  plugin_id varchar(64) NOT NULL,
  name varchar(64) NOT NULL,
  token_hash varchar(255) NOT NULL,
  token_prefix varchar(16) NOT NULL,
  scopes jsonb DEFAULT '[]' NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_oidc_providers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  ref varchar(96) NOT NULL,
  label varchar(128) NOT NULL,
  direction ag_oidc_direction NOT NULL,
  issuer varchar(512) NOT NULL,
  well_known varchar(512),
  client_id varchar(256),
  client_secret_ref varchar(96),
  redirect_uris jsonb DEFAULT '[]' NOT NULL,
  scopes jsonb DEFAULT '[]' NOT NULL,
  signing_algs jsonb DEFAULT '[]' NOT NULL,
  exposed_claims jsonb DEFAULT '[]' NOT NULL,
  allow_platform_login boolean DEFAULT false NOT NULL,
  status ag_oidc_status DEFAULT 'active' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_oidc_login_transactions (
  state varchar(128) PRIMARY KEY,
  code_verifier varchar(256) NOT NULL,
  nonce varchar(128) NOT NULL,
  return_to varchar(512) NOT NULL,
  target_site_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_audit_log (
  site_id uuid NOT NULL,
  id bigserial PRIMARY KEY,
  actor_type ag_actor_type NOT NULL,
  actor_id varchar(64),
  developer_id uuid,
  realm ag_realm,
  action varchar(96) NOT NULL,
  target_type varchar(48),
  target_id varchar(64),
  before jsonb,
  after jsonb,
  ip varchar(64),
  user_agent varchar(512),
  trace_id varchar(64),
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_jobs (
  owner_scope ag_owner_scope NOT NULL,
  owner_id varchar(64) DEFAULT 'platform' NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  job_key varchar(128) NOT NULL,
  status ag_job_status DEFAULT 'idle' NOT NULL,
  locked_by varchar(128),
  locked_until timestamptz,
  last_run_at timestamptz,
  next_run_at timestamptz,
  run_count bigint DEFAULT 0 NOT NULL,
  fail_count integer DEFAULT 0 NOT NULL,
  backoff_until timestamptz,
  cursor jsonb DEFAULT '{}' NOT NULL,
  last_error text,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_event_outbox (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  site_id uuid NOT NULL,
  event_id varchar(64) NOT NULL,
  type varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  status ag_outbox_status DEFAULT 'pending' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  next_attempt_at timestamptz DEFAULT now() NOT NULL,
  delivered_at timestamptz,
  last_error text,
  trace_id varchar(48),
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_dead_letters (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  site_id uuid NOT NULL,
  event_id varchar(64) NOT NULL,
  type varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL,
  last_error text NOT NULL,
  failed_at timestamptz DEFAULT now() NOT NULL,
  replayed_at timestamptz,
  replayed_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE ag_quota_counters (
  quota_key varchar(192) PRIMARY KEY,
  window_start timestamptz NOT NULL,
  used bigint DEFAULT 0 NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX uq_ag_users_email ON ag_users (email) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX uq_ag_users_username ON ag_users (username) WHERE deleted_at IS NULL;

CREATE INDEX ix_ag_users_status ON ag_users (status);

CREATE UNIQUE INDEX uq_ag_identities_provider_uid ON ag_identities (owner_scope, owner_id, provider, provider_user_id);

CREATE INDEX ix_ag_identities_user ON ag_identities (user_id);

CREATE INDEX ix_ag_identities_provider ON ag_identities (provider);

CREATE UNIQUE INDEX uq_ag_sessions_token ON ag_sessions (token_hash);

CREATE INDEX ix_ag_sessions_user ON ag_sessions (user_id);

CREATE INDEX ix_ag_sessions_expiry ON ag_sessions (expires_at);

CREATE UNIQUE INDEX uq_ag_email_rules_pattern ON ag_email_rules (site_id, match_type, pattern);

CREATE INDEX ix_ag_email_rules_order ON ag_email_rules (enabled, priority);

CREATE UNIQUE INDEX uq_ag_invite_codes_code ON ag_invite_codes (site_id, code);

CREATE UNIQUE INDEX uq_ag_developers_username ON ag_developers (username);

CREATE UNIQUE INDEX uq_ag_developers_email ON ag_developers (email);

CREATE INDEX ix_ag_developers_role ON ag_developers (role, status);

CREATE UNIQUE INDEX uq_ag_sites_site_id ON ag_sites (site_id);

CREATE INDEX ix_ag_sites_developer ON ag_sites (developer_id);

CREATE UNIQUE INDEX uq_ag_plugin_inst_dev ON ag_plugin_instances (developer_id, plugin_id, instance_key) WHERE developer_id IS NOT NULL;

CREATE UNIQUE INDEX uq_ag_plugin_inst_site ON ag_plugin_instances (site_id, plugin_id, instance_key) WHERE site_id IS NOT NULL;

CREATE UNIQUE INDEX uq_ag_dev_invitations_code ON ag_dev_invitations (site_id, code_hash);

CREATE INDEX ix_ag_dev_invitations_email ON ag_dev_invitations (target_email, expires_at);

CREATE INDEX ix_ag_platform_settings_time ON ag_platform_settings (updated_at);

CREATE INDEX ix_ag_plugins_status_kind ON ag_plugins (status, kind);

CREATE UNIQUE INDEX uq_ag_plugins_namespace ON ag_plugins (namespace) WHERE status = 'enabled';

CREATE UNIQUE INDEX uq_ag_plugin_configs_ver ON ag_plugin_configs (plugin_id, version);

CREATE INDEX ix_ag_plugin_configs_status ON ag_plugin_configs (plugin_id, status);

CREATE UNIQUE INDEX uq_ag_plugin_grants ON ag_plugin_grants (owner_scope, owner_id, plugin_id, permission);

CREATE INDEX ix_ag_plugin_grants_perm ON ag_plugin_grants (permission);

CREATE UNIQUE INDEX uq_ag_bindings_user_plugin ON ag_plugin_bindings (site_id, user_id, plugin_id, instance_key);

CREATE UNIQUE INDEX uq_ag_bindings_external ON ag_plugin_bindings (site_id, plugin_id, instance_key, external_id) WHERE external_id IS NOT NULL;

CREATE INDEX ix_ag_bindings_status ON ag_plugin_bindings (status);

CREATE UNIQUE INDEX uq_ag_facts_user_namespace ON ag_plugin_facts (site_id, user_id, namespace, instance_key);

CREATE INDEX ix_ag_facts_plugin ON ag_plugin_facts (plugin_id);

CREATE INDEX ix_ag_facts_expiry ON ag_plugin_facts (expires_at);

CREATE INDEX ix_ag_plugin_inv_plugin_time ON ag_plugin_invocations (plugin_id, created_at);

CREATE INDEX ix_ag_plugin_inv_status_time ON ag_plugin_invocations (status, created_at);

CREATE UNIQUE INDEX uq_ag_plugin_storage ON ag_plugin_storage (owner_scope, owner_id, plugin_id, instance_key, key);

CREATE INDEX ix_ag_plugin_storage_expiry ON ag_plugin_storage (expires_at);

CREATE UNIQUE INDEX uq_ag_llm_cache_input ON ag_llm_cache (owner_scope, owner_id, input_hash);

CREATE INDEX ix_ag_llm_cache_expiry ON ag_llm_cache (expires_at);

CREATE UNIQUE INDEX uq_ag_plugin_endpoints_route ON ag_plugin_endpoints (owner_scope, owner_id, method, mount_path);

CREATE INDEX ix_ag_plugin_endpoints_plugin ON ag_plugin_endpoints (plugin_id);

CREATE UNIQUE INDEX uq_ag_plugin_ui_key ON ag_plugin_ui_contributions (type, key);

CREATE INDEX ix_ag_plugin_ui_plugin ON ag_plugin_ui_contributions (plugin_id);

CREATE UNIQUE INDEX uq_ag_plugin_packages ON ag_plugin_packages (plugin_id, version);

CREATE UNIQUE INDEX uq_ag_policies_code ON ag_policies (site_id, code);

CREATE INDEX ix_ag_policies_order ON ag_policies (enabled, priority);

CREATE UNIQUE INDEX uq_ag_policy_versions ON ag_policy_versions (site_id, policy_id, version);

CREATE INDEX ix_ag_policy_versions_hash ON ag_policy_versions (spec_hash);

CREATE INDEX ix_ag_assignments_policy ON ag_policy_assignments (policy_id, target_type);

CREATE INDEX ix_ag_assignments_target ON ag_policy_assignments (target_type, target_ref);

CREATE UNIQUE INDEX uq_ag_state_user_policy ON ag_user_policy_state (site_id, user_id, policy_id);

CREATE INDEX ix_ag_state_state ON ag_user_policy_state (state);

CREATE INDEX ix_ag_state_next_check ON ag_user_policy_state (next_check_at);

CREATE INDEX ix_ag_eval_user_time ON ag_evaluations (user_id, created_at);

CREATE INDEX ix_ag_eval_policy_outcome ON ag_evaluations (policy_id, outcome);

CREATE UNIQUE INDEX uq_ag_actions_idem ON ag_actions_log (site_id, idempotency_key);

CREATE INDEX ix_ag_actions_user_time ON ag_actions_log (user_id, created_at);

CREATE INDEX ix_ag_actions_status ON ag_actions_log (status);

CREATE UNIQUE INDEX uq_ag_checkin_entitlements ON ag_checkin_entitlements (site_id, user_id, scope);

CREATE UNIQUE INDEX uq_ag_checkin_user_date ON ag_checkin_records (site_id, user_id, checkin_date);

CREATE UNIQUE INDEX uq_ag_external_subjects ON ag_external_subjects (site_id, provider, external_id);

CREATE INDEX ix_ag_ext_subjects_email ON ag_external_subjects (provider, email);

CREATE UNIQUE INDEX uq_ag_secrets_key ON ag_secrets (owner_scope, owner_id, key);

CREATE UNIQUE INDEX uq_ag_oidc_keys_kid ON ag_oidc_signing_keys (kid);

CREATE UNIQUE INDEX uq_ag_oidc_keys_active_alg ON ag_oidc_signing_keys (alg) WHERE status = 'active';

CREATE UNIQUE INDEX uq_ag_oidc_keys_standby_alg ON ag_oidc_signing_keys (alg) WHERE status = 'standby';

CREATE INDEX ix_ag_oidc_keys_status ON ag_oidc_signing_keys (status);

CREATE INDEX ix_ag_oidc_keys_remove_after ON ag_oidc_signing_keys (remove_after);

CREATE UNIQUE INDEX uq_ag_verify_clients_id ON ag_verify_clients (client_id);

CREATE INDEX ix_ag_verify_clients_status ON ag_verify_clients (status);

CREATE UNIQUE INDEX uq_ag_challenges_id ON ag_verify_challenges (challenge_id);

CREATE UNIQUE INDEX uq_ag_challenges_code ON ag_verify_challenges (user_code) WHERE status = 'pending';

CREATE INDEX ix_ag_challenges_expiry ON ag_verify_challenges (expires_at);

CREATE INDEX ix_ag_assertions_client_time ON ag_verify_assertions (client_id, created_at);

CREATE INDEX ix_ag_assertions_subject ON ag_verify_assertions (subject_type, subject_value);

CREATE INDEX ix_ag_verify_nonces_expires ON ag_verify_nonces (expires_at);

CREATE INDEX ix_ag_oauth_clients_status ON ag_oauth_clients (status);

CREATE INDEX ix_ag_oauth_codes_expires ON ag_oauth_codes (expires_at);

CREATE INDEX ix_ag_oauth_refresh_subject ON ag_oauth_refresh_tokens (subject);

CREATE INDEX ix_ag_oauth_refresh_expires ON ag_oauth_refresh_tokens (expires_at);

CREATE UNIQUE INDEX uq_ag_plugin_tokens_hash ON ag_plugin_tokens (token_hash);

CREATE INDEX ix_ag_plugin_tokens_plugin ON ag_plugin_tokens (plugin_id);

CREATE UNIQUE INDEX uq_ag_oidc_providers_ref ON ag_oidc_providers (ref);

CREATE UNIQUE INDEX uq_ag_oidc_providers_issuer ON ag_oidc_providers (issuer);

CREATE INDEX ix_ag_oidc_providers_dir ON ag_oidc_providers (direction);

CREATE INDEX ix_ag_oidc_login_tx_expires ON ag_oidc_login_transactions (expires_at);

CREATE INDEX ix_ag_audit_actor ON ag_audit_log (actor_type, actor_id, created_at);

CREATE INDEX ix_ag_audit_target ON ag_audit_log (target_type, target_id);

CREATE INDEX ix_ag_audit_time ON ag_audit_log (created_at);

CREATE INDEX ix_ag_audit_developer ON ag_audit_log (developer_id, created_at);

CREATE UNIQUE INDEX uq_ag_jobs_key ON ag_jobs (owner_scope, owner_id, job_key);

CREATE INDEX ix_ag_jobs_due ON ag_jobs (status, next_run_at);

CREATE UNIQUE INDEX uq_ag_outbox_event ON ag_event_outbox (site_id, event_id);

CREATE INDEX ix_ag_outbox_due ON ag_event_outbox (site_id, status, next_attempt_at);

CREATE UNIQUE INDEX uq_ag_dead_letters_event ON ag_dead_letters (site_id, event_id);

CREATE INDEX ix_ag_dead_letters_pending ON ag_dead_letters (site_id, replayed_at);

CREATE INDEX ix_ag_quota_window ON ag_quota_counters (window_start);

DROP TRIGGER IF EXISTS trg_ag_users_touch ON ag_users;

CREATE TRIGGER trg_ag_users_touch BEFORE UPDATE ON ag_users FOR EACH ROW EXECUTE FUNCTION fn_ag_users_touch();

DROP TRIGGER IF EXISTS trg_ag_identities_touch ON ag_identities;

CREATE TRIGGER trg_ag_identities_touch BEFORE UPDATE ON ag_identities FOR EACH ROW EXECUTE FUNCTION fn_ag_identities_touch();

DROP TRIGGER IF EXISTS trg_ag_developers_touch ON ag_developers;

CREATE TRIGGER trg_ag_developers_touch BEFORE UPDATE ON ag_developers FOR EACH ROW EXECUTE FUNCTION fn_ag_developers_touch();

DROP TRIGGER IF EXISTS trg_ag_sites_touch ON ag_sites;

CREATE TRIGGER trg_ag_sites_touch BEFORE UPDATE ON ag_sites FOR EACH ROW EXECUTE FUNCTION fn_ag_sites_touch();

DROP TRIGGER IF EXISTS trg_ag_plugin_instances_touch ON ag_plugin_instances;

CREATE TRIGGER trg_ag_plugin_instances_touch BEFORE UPDATE ON ag_plugin_instances FOR EACH ROW EXECUTE FUNCTION fn_ag_plugin_instances_touch();

DROP TRIGGER IF EXISTS trg_ag_platform_settings_touch ON ag_platform_settings;

CREATE TRIGGER trg_ag_platform_settings_touch BEFORE UPDATE ON ag_platform_settings FOR EACH ROW EXECUTE FUNCTION fn_ag_platform_settings_touch();

DROP TRIGGER IF EXISTS trg_ag_plugins_touch ON ag_plugins;

CREATE TRIGGER trg_ag_plugins_touch BEFORE UPDATE ON ag_plugins FOR EACH ROW EXECUTE FUNCTION fn_ag_plugins_touch();

DROP TRIGGER IF EXISTS trg_ag_plugin_bindings_touch ON ag_plugin_bindings;

CREATE TRIGGER trg_ag_plugin_bindings_touch BEFORE UPDATE ON ag_plugin_bindings FOR EACH ROW EXECUTE FUNCTION fn_ag_plugin_bindings_touch();

DROP TRIGGER IF EXISTS trg_ag_plugin_storage_touch ON ag_plugin_storage;

CREATE TRIGGER trg_ag_plugin_storage_touch BEFORE UPDATE ON ag_plugin_storage FOR EACH ROW EXECUTE FUNCTION fn_ag_plugin_storage_touch();

DROP TRIGGER IF EXISTS trg_ag_policies_touch ON ag_policies;

CREATE TRIGGER trg_ag_policies_touch BEFORE UPDATE ON ag_policies FOR EACH ROW EXECUTE FUNCTION fn_ag_policies_touch();

DROP TRIGGER IF EXISTS trg_ag_user_policy_state_touch ON ag_user_policy_state;

CREATE TRIGGER trg_ag_user_policy_state_touch BEFORE UPDATE ON ag_user_policy_state FOR EACH ROW EXECUTE FUNCTION fn_ag_user_policy_state_touch();

DROP TRIGGER IF EXISTS trg_ag_provider_sync_state_touch ON ag_provider_sync_state;

CREATE TRIGGER trg_ag_provider_sync_state_touch BEFORE UPDATE ON ag_provider_sync_state FOR EACH ROW EXECUTE FUNCTION fn_ag_provider_sync_state_touch();

DROP TRIGGER IF EXISTS trg_ag_secrets_touch ON ag_secrets;

CREATE TRIGGER trg_ag_secrets_touch BEFORE UPDATE ON ag_secrets FOR EACH ROW EXECUTE FUNCTION fn_ag_secrets_touch();

DROP TRIGGER IF EXISTS trg_ag_oidc_providers_touch ON ag_oidc_providers;

CREATE TRIGGER trg_ag_oidc_providers_touch BEFORE UPDATE ON ag_oidc_providers FOR EACH ROW EXECUTE FUNCTION fn_ag_oidc_providers_touch();

DROP TRIGGER IF EXISTS trg_ag_jobs_touch ON ag_jobs;

CREATE TRIGGER trg_ag_jobs_touch BEFORE UPDATE ON ag_jobs FOR EACH ROW EXECUTE FUNCTION fn_ag_jobs_touch();

DROP TRIGGER IF EXISTS trg_ag_quota_counters_touch ON ag_quota_counters;

CREATE TRIGGER trg_ag_quota_counters_touch BEFORE UPDATE ON ag_quota_counters FOR EACH ROW EXECUTE FUNCTION fn_ag_quota_counters_touch();
