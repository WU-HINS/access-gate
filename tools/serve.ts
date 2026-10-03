#!/usr/bin/env node
/**
 * tools/serve.ts —— 可运行的 access-gate 服务（M0-1 + M0-9 + M0-10 落地入口）。
 *
 * 用法：
 *   node --experimental-strip-types tools/serve.ts                # 默认 127.0.0.1:8787
 *   node --experimental-strip-types tools/serve.ts --port 9000
 *   node --experimental-strip-types tools/serve.ts --demo         # 演示模式（内置假 IdP + 演示数据）
 *
 * 两种模式：
 *   · **demo 模式**（默认关闭）：用内存数据 + 内置假 IdP，不需要任何外部系统即可看到
 *     「我的资格」与「管理端」完整可用。目的：让评审者一条命令就能看到东西。
 *   · **接入模式**：读环境变量接真实 OIDC 与数据库（当前 M0 阶段用内存实现占位，
 *     DB 适配器已在 `src/db/` 与 `src/plugin/subjects.ts` 中提供）。
 *
 * ★ 本文件不隐藏任何东西：演示数据会在启动日志里明确标注 `DEMO`，
 *   并且 `/healthz` 会返回 `mode: 'demo'`，避免把演示当成生产。
 */

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import { SessionService, SESSION_COOKIE, principalFromClaims } from '../src/auth/session.ts';
import {
  assertProductionReady,
  checkProductionConfig,
  createStorage,
  productionConfigFromEnv,
  type ProductionConfig,
} from '../src/app/storage.ts';
import { createAppMetrics, type AppMetrics } from '../src/kernel/metrics.ts';
import {
  databaseCheck,
  eventLoopCheck,
  GracefulShutdown,
  HealthRegistry,
  migrationCheck,
  schedulerCheck,
  waitMs,
} from '../src/kernel/health.ts';
import { InMemoryLoginTransactionStore, OidcClient, randomToken, type HttpFetcher, type LoginTransactionStore } from '../src/auth/oidc.ts';
import { createTransactionalChallengeStore } from '../src/db/challenge-adapter.ts';
import { createTransactionalLoginTransactionStore } from '../src/db/login-tx-adapter.ts';
import { createTransactionalNonceStore } from '../src/db/nonce-adapter.ts';
import { createTransactionalDeveloperIdentityLookup } from '../src/db/developer-identity-adapter.ts';
import { createAppServer, newCsrfSecret, type Route, type RouteResult } from '../src/http/server.ts';
import { createAppRoutes } from '../src/http/routes.ts';
import { createConsoleRoutes } from '../src/http/console-routes.ts';
import { createVerifyRoutes } from '../src/http/verify-routes.ts';
import { createOAuthRoutes, InMemoryOAuthStore } from '../src/http/oauth-routes.ts';
import { createTransactionalOAuthStore } from '../src/db/oauth-store-adapter.ts';
import { InMemoryNonceStore, InMemoryVerifyClientStore } from '../src/verify/hmac.ts';
import { InMemoryVerifyClientAdminStore, createTransactionalVerifyClientAdminStore } from '../src/verify/client-admin.ts';
import { createTransactionalVerifyClientLookup } from '../src/verify/client-store-db.ts';
import { InMemorySecretStore, createTransactionalSecretStore } from '../src/secrets/store.ts';
import { parseMasterKey } from '../src/secrets/crypto.ts';
import { InMemoryPluginConfigStore, createTransactionalPluginConfigStore } from '../src/plugin/config-store.ts';
import { InMemoryPluginEndpointStore, createTransactionalPluginEndpointStore } from '../src/plugin/endpoint-store.ts';
import { InMemoryPluginGrantStore, createTransactionalPluginGrantStore } from '../src/plugin/grant-store.ts';
import { InMemoryUserAdminStore, createTransactionalUserAdminStore } from '../src/admin/user-store.ts';
import { InMemoryAssertionAdminStore, createTransactionalAssertionAdminStore } from '../src/verify/assertion-store.ts';
import { InMemoryOidcProviderStore, createTransactionalOidcProviderStore } from '../src/auth/oidc-provider-store.ts';
import { InMemoryUiContributionStore, createTransactionalUiContributionStore } from '../src/plugin/ui-contribution-store.ts';
import { InMemoryPluginTokenStore, createTransactionalPluginTokenStore } from '../src/plugin/token-store.ts';
import {
  InMemoryPluginInvocationStore,
  createTransactionalPluginInvocationStore,
} from '../src/plugin/invocation-store.ts';
import { DeviceCodeService, InMemoryChallengeStore } from '../src/verify/device-code.ts';
import { ASSERTION_ALG, generateSigningKey, SigningKeySet, type ManagedSigningKey } from '../src/verify/jws.ts';
import { ensureStandalone, InMemorySiteRegistry } from '../src/core/sites.ts';
import { createTransactionalSiteRegistry } from '../src/db/site-adapters.ts';
import { createTransactionalPluginStore, InMemoryPluginStore, type PluginStore } from '../src/plugin/registry-store.ts';
import { createTransactionalSettingsStore } from '../src/db/settings-adapters.ts';
import { InMemoryPlatformSettingsStore, PLATFORM_MODE_KEY, type PlatformMode, type PlatformSettingsStore } from '../src/app/platform-mode.ts';
import { BUILTIN_MANIFESTS } from '../src/plugin/builtin/features.ts';
import { InMemoryEndUserStore, resolveLogin, type EndUserStore } from '../src/auth/flows.ts';
import { createTransactionalEndUserStore } from '../src/db/end-user-adapter.ts';
import { InMemoryInvitationStore, InvitationService } from '../src/core/invitations.ts';
import { createTransactionalInvitationStore } from '../src/db/invitation-adapter.ts';
import { recordDeveloperIdentity } from '../src/db/developer-identity-adapter.ts';
import { ensureDeveloperUser } from '../src/db/developer-user-link.ts';
import { createTransactionalPluginInstanceStore } from '../src/db/plugin-instance-adapter.ts';
import { PluginRuntimeOrchestrator } from '../src/plugin/runtime-orchestrator.ts';
import { CheckinService } from '../src/core/checkin-service.ts';
import {
  createRestoreGroupHandler,
  type RestoreSource,
} from '../src/core/action-restore.ts';
import { createRestoreSource } from '../src/core/restore-source.ts';
import { checkStartupInvariants, DEFAULT_RETENTION } from '../src/core/retention.ts';
import { purgePolicyVersions, type VersionPurgeDeps } from '../src/core/retention-cleaner.ts';
import { DbOidcSigningKeyStore } from '../src/db/oidc-signing-key-adapter.ts';
import { DbPluginPackageStore } from '../src/db/plugin-package-adapter.ts';
import { DbPluginBindingStore } from '../src/db/plugin-binding-adapter.ts';
import { DbPolicyAssignmentStore } from '../src/db/policy-assignment-adapter.ts';
import { DbEmailRuleStore } from '../src/db/email-rule-adapter.ts';
import { DbInviteCodeStore } from '../src/db/invite-code-adapter.ts';
import path from 'node:path';
import { FileSystemPackageCache } from '../src/plugin/package-cache.ts';
import { restorePluginPackages } from '../src/plugin/package-restore.ts';
import { makeSiteAdmissionCheck } from '../src/http/site-admission.ts';
import { LlmGateway } from '../src/plugin/llm-gateway.ts';
import { HttpLlmProvider } from '../src/plugin/llm-provider-http.ts';
import { DbLlmCacheStore } from '../src/db/llm-cache-adapter.ts';
import { buildInviteFacts, INVITE_GRANTS_MANIFEST } from '../src/plugin/builtin/invite-grants.ts';
import { collectSubjectKeys, collectSubjectSnapshot } from '../src/policy/subject-snapshot.ts';
import {
  applyRotationStep,
  needsNewStandby,
  nextRotationStep,
  type RotationOptions,
} from '../src/core/oidc-key-rotation.ts';
import { AlertSilenceService, InMemoryAlertSilenceStore } from '../src/core/alert-silence.ts';
import { DbAlertSilenceStore } from '../src/db/alert-silence-adapter.ts';
// ★★ 灰度一键熔断（`docs/07 M6-3`）：状态落平台设置，重启不丢（止血状态不能忘）
import { InMemoryRolloutAbortStore } from '../src/core/rollout-abort.ts';
import { DbRolloutAbortStore } from '../src/db/rollout-abort-adapter.ts';
// ★★ 配额保护（`docs/05 §6.4`）：限流与预算必须走**跨实例**计数 —— 否则 L-13
import { InMemoryQuotaCounterStore, QuotaGuard } from '../src/core/quota-guard.ts';
import { DbQuotaCounterStore } from '../src/db/quota-counter-adapter.ts';
import { requiredGroupOf } from '../src/policy/required-group.ts';
import { createNewApiDownstreamApi } from '../src/plugin/builtin/newapi-downstream.ts';
import { createNewApiProvider, writeBackAttributes, type ProviderTransport } from '../src/plugin/builtin/newapi-provider.ts';
import {
  createAddQuotaAction,
  createSetStatusAction,
  type DownstreamApi,
} from '../src/plugin/builtin/newapi-actions.ts';
import { InMemorySyncStateStore, Reconciler } from '../src/core/reconciler.ts';
import { createTransactionalSyncStateStore } from '../src/db/sync-state-adapter.ts';
import type { ProviderPlugin } from '../src/plugin/provider.ts';
import { EventBus, InMemoryOutboxStore, OutboxDispatcher } from '../src/kernel/events.ts';
import { createTransactionalOutboxStore } from '../src/db/outbox-adapters.ts';
import { reuseOrBeginTransaction } from '../src/db/tx.ts';
import { createAdminHandler } from '../src/admin/api.ts';

import { EMAIL_DOMAIN_MANIFEST, evaluateEmailDomain } from '../src/plugin/builtin/email-domain.ts';
import { FactPipeline } from '../src/plugin/host-api.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { collectFactSnapshot, evaluateEligibility } from '../src/policy/eligibility.ts';
import { validatePolicy, type PluginRegistry, type PolicyDocument } from '../src/policy/model.ts';
import { createLogger } from '../src/kernel/logger.ts';
import { createPgDb } from '../src/db/pool.ts';
import { DbEvaluationStore } from '../src/db/adapters.ts';
import { Scheduler } from '../src/kernel/scheduler.ts';
import { ActionExecutor, ActionRegistry, createSetGroupHandler } from '../src/core/action-executor.ts';
import { PatrolService } from '../src/core/patrol-service.ts';
import { InMemoryEvaluationStore } from '../src/core/patrol.ts';
import { renderPortalHtml } from '../web/portal.ts';

// ─────────────────────────── 参数 ───────────────────────────

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    /** 默认 demo（零依赖即可启动）；生产用 `--mode=real` 或 `--no-demo` */
    demo: { type: 'boolean', default: true },
    mode: { type: 'string', default: '' },
    'log-level': { type: 'string', default: 'info' },
  },
  allowPositionals: true,
});

const port = Number(values.port);
const host = values.host ?? '127.0.0.1';
// 三种入口：`--no-demo`（布尔）或 `--mode=real`（显式）都表示生产模式
const demo = values.mode !== 'real' && values.demo !== false;
const logger = createLogger({ level: (values['log-level'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info' });

// ─────────────────────────── 演示数据 ───────────────────────────

const DEMO_SITE = '11111111-1111-1111-1111-111111111111';

/** 演示策略：与 docs/07 §5 场景 A 一致 */
const DEMO_POLICIES: PolicyDocument[] = [
  {
    code: 'edu-unlock-checkin',
    name: '教育邮箱解锁签到',
    version: 1,
    priority: 10,
    enabled: true,
    spec: {
      match: { eq: { 'user.status': 'active' } },
      requirements: {
        expression: {
          all: [
            { $label: '教育邮箱', matches: { 'fact.email.domain': ['*.edu.cn', '*.edu', '*.ac.uk'] } },
            { $label: '邮箱已验证', eq: { 'fact.email.verified': true } },
          ],
        },
      },
      actions: {
        onSatisfied: [{ action: 'checkin:grant', params: { scope: 'daily' } }],
        onUnsatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'default' } }],
      },
    },
  },
  {
    code: 'github-contributor',
    name: 'GitHub 贡献者',
    version: 1,
    priority: 20,
    enabled: true,
    spec: {
      requirements: { expression: { $label: 'GitHub 总 star 数 ≥ 100', gte: { 'fact.github.total_stars': 100 } } },
      actions: { onSatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'vip2' } }] },
    },
  },
];

/** 演示 IdP：完全本地，不需要任何外部服务。 */
function createDemoIdp(): { client: OidcClient; tokens: Map<string, Record<string, unknown>> } {
  const tokens = new Map<string, Record<string, unknown>>();
  const issuer = 'http://localhost/demo-idp';

  const fetcher: HttpFetcher = async (url, init) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
      };
    }
    if (url.endsWith('/token')) {
      // 演示模式：不做真实验签（没有真实 IdP）。明确标注，避免被误认为已验签。
      // 生产接入请用真实 IdP：`OidcClient.completeLogin` 会经 JWKS 验签并校验 nonce。
      const body = new URLSearchParams(init?.body ?? '');
      const code = body.get('code') ?? '';
      const claims = tokens.get(code) ?? { sub: 'demo-user', email_verified: false };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({ id_token: `demo.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.unsigned` }),
      };
    }
    return { status: 404, headers: {} as Record<string, string>, text: '{}' };
  };

  const client = new OidcClient({
    config: { issuer, clientId: 'demo', redirectUri: `http://${host}:${port}/api/auth/callback` },
    fetch: fetcher,
  });
  // 演示模式绕过验签：把 completeLogin 换成「直接解析 claims」
  const originalComplete = client.completeLogin.bind(client);
  client.completeLogin = async (params) => {
    const body = new URLSearchParams();
    void body;
    // 从演示 token 表里取 claims（等价于 IdP 返回）
    const claims = tokens.get(params.code);
    if (claims === undefined) throw new Error('演示模式：未知的授权码');
    void originalComplete;
    return { claims: claims as never, raw: claims as never, idToken: 'demo' };
  };
  return { client, tokens };
}

// ─────────────────────────── 装配 ───────────────────────────

async function main(): Promise<void> {
  // ── 配置自查：生产模式缺任一项即启动失败（一次性列出全部缺项）──
  // ★ 模式判定以**命令行**为准：`productionConfigFromEnv()` 在 AG_MODE 未设时返回 'auto'，
  //   而自查只在 mode==='demo' 时走演示分支——若不在这里显式覆盖，`--mode=demo`
  //   会被当成生产模式而被自查拦下（真实跑出来的行为差异）。
  const config: ProductionConfig = {
    ...productionConfigFromEnv(),
    mode: demo ? 'demo' : 'real',
    // 命令行显式要求 demo（默认值或 `--mode=demo`）即视为「显式允许」；
    // 环境变量走 AG_ALLOW_DEMO=1。两者都是**显式**动作，不是静默降级。
    allowDemo: demo ? true : productionConfigFromEnv().allowDemo,
  };
  const issues = checkProductionConfig(config);
  for (const issue of issues) {
    process.stdout.write(`  ${issue.severity === 'error' ? '✗' : '!'} [${issue.field}] ${issue.message}\n`);
  }
  if (config.mode !== 'demo') assertProductionReady(config);

  const usePostgres = config.mode !== 'demo' && config.databaseUrl !== undefined;
  let db: Awaited<ReturnType<typeof createPgDb>> | undefined;
  let resolvePolicyId: ((code: string) => Promise<string | undefined>) | undefined;

  /**
   * 启动期与健康探测用的**裸驱动**查询。
   *
   * ★ 为什么不用 `db.query`：后者有「必须在事务内」的断言（单一事务入口，D17 前置 3），
   *   而启动校验与 readiness 探测都不在业务事务内。用 `db.query` 会抛错，
   *   若再 `.catch(() => [])` 就会把错误吞成「没有迁移记录」——真实踩到的坑。
   */
  const probe = async (sql: string): Promise<{ name?: string }[]> => {
    if (config.databaseUrl === undefined) return [];
    const { Pool } = (await import('pg')) as unknown as typeof import('pg');
    const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
    try {
      const result = await pool.query(sql);
      return result.rows as { name?: string }[];
    } finally {
      await pool.end();
    }
  };

  if (usePostgres) {
    db = await createPgDb({ connectionString: config.databaseUrl! });
    // ★ 启动期校验必须走**裸驱动**（`db.exec` / 直连），不能用 `db.query`：
    //   后者有「必须在事务内」的断言（单一事务入口，D17 前置 3），启动期没有事务，
    //   调用会抛错——而 `.catch(() => [])` 会把这个错误吞成「没有迁移记录」，
    //   表现为「明明跑过迁移却说没有」（真实踩到的坑）。
    let applied: { name?: string }[] = [];
    try {
      applied = await probe('SELECT name FROM ag_migrations ORDER BY name DESC LIMIT 1');
    } catch (error) {
      process.stdout.write(`  ✗ 无法读取迁移记录：${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    if (applied.length === 0 || applied[0]?.name === undefined) {
      process.stdout.write('  ✗ 数据库中没有迁移记录——请先执行 `npm run db:migrate`\n');
      process.exit(1);
    }
    // 生命周期状态表的外键是 ag_policies.id → 需要 code → id 解析。
    // 注意：这个解析在**业务事务内**被调用，因此用 db.query 是正确的。
    resolvePolicyId = async (code: string): Promise<string | undefined> => {
      const rows = await db!.query<{ id: string }>('SELECT id FROM ag_policies WHERE code = $1 LIMIT 1', [code]);
      return rows[0]?.id;
    };
  }

  const storage = createStorage(
    usePostgres
      ? { mode: 'postgres', siteId: DEMO_SITE, db: db!, resolvePolicyId: resolvePolicyId! }
      : { mode: 'memory', siteId: DEMO_SITE },
  );
  const sessionStore = storage.sessions;
  // ★ 真实 PG 模式下**必须**注入事务包装：`DbSessionStore` 走 `db.query`，
  //   而路由处理器不在业务事务里——不包会让登录直接 500
  //   （与 Scheduler / Patrol 同类问题的同一种处置）。
  const sessions = new SessionService({
    store: sessionStore,
    ...(db === undefined ? {} : { transaction: <T>(fn: () => Promise<T>): Promise<T> => db!.transaction(async () => fn()) }),
  });
  // ★★★ R57：登录事务必须**持久化**（此前无条件用内存实现）——
  //   内存实现的后果：重启后登录全失效 · 多实例下登录随机失败 ·
  //   PKCE 的 code_verifier 随进程丢失。见 `src/db/login-tx-adapter.ts` 的说明。
  const loginTransactions: LoginTransactionStore =
    db === undefined ? new InMemoryLoginTransactionStore() : createTransactionalLoginTransactionStore(db);
  const csrfSecret = newCsrfSecret();
  const metrics: AppMetrics = createAppMetrics();

  const subjectStore = storage.subjects;
  const identityStore = storage.identities;
  const policyStore = storage.policies;
  const audit = storage.audit;
  const factStore = storage.facts;

  // ★★★ R94：**插件运行时编排器**（P1-1）。
  //   此前 `host-factory`（R66）与 `runtime-orchestrator`（R70）都写好了，
  //   但**都没有被 serve.ts 引用** → 插件的宿主能力（KV / 缓存 / 密钥 / 出网）在服务里不可用。
  //   ★ 本处把它接上，并通过管理端点 `POST /api/admin/plugins/:id/collect` 暴露「手动触发」。
  //   ★ **自动调度**（节奏与主体）留给设计决策——见
  //     `reports/architecture-gaps.md`「开发者级插件的事实记在谁名下」。
  //   ★ `userId` 不在此固定：`runOnce(manifest, { userId })` 按次传入（事实按主体存）。
  // ★ 未配置渠道连接时的**显式降级**（不是「看起来在工作」的桩）：
  //   · capabilities 全 false —— 明确声明「我什么也做不了」；
  //   · 调用即抛错（而不是静默返回空列表）——让问题**在调用点暴露**。
  const notConfiguredProvider: ProviderPlugin = {
    id: 'newapi-provider',
    subjectSchema: { type: 'object', properties: { group: { type: 'string', watch: true } } },
    capabilities: { list: false, findByIdentity: false, get: false, cursor: false, update: false, create: false },
    listSubjects: async () => {
      throw new Error('渠道未配置（AG_NEWAPI_BASE_URL / AG_NEWAPI_PAT）——拒绝返回「空列表」以免被误读为「没有主体」');
    },
    getSubject: async () => {
      throw new Error('渠道未配置（AG_NEWAPI_BASE_URL / AG_NEWAPI_PAT）');
    },
  };

  /**
   * ★ 解析渠道 provider（R98 起：有配置用**真实实现**，无配置用**显式降级**）。
   *
   * ★ R99 把它从 `createAdminHandler` 的 deps 里**提取出来**——
   *   因为**对账（reconciler）也需要同一个 provider**，
   *   而内联写法会导致「两处各自解析」→ 可能不一致（本会话反复出现的模式）。
   */
  // ★ P0-5：渠道连接信息**只解析一处**（provider 与「写回下游」共用）——
  //   避免「两处各自解析 → 可能不一致」（本段上方注释记的教训）。
  const newApiConfig = (() => {
    const baseUrl = process.env['AG_NEWAPI_BASE_URL'];
    const pat = process.env['AG_NEWAPI_PAT'];
    if (baseUrl === undefined || pat === undefined) return undefined;
    const pageSizeRaw = process.env['AG_NEWAPI_PAGE_SIZE'];
    return {
      baseUrl,
      pat,
      ...(pageSizeRaw === undefined ? {} : { pageSize: Number.parseInt(pageSizeRaw, 10) }),
    };
  })();

  const providerTransport: ProviderTransport | undefined =
    newApiConfig === undefined
      ? undefined
      : {
          async request(request) {
            const response = await fetch(request.url, {
              method: request.method,
              ...(request.headers === undefined ? {} : { headers: request.headers }),
              ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
              signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
            });
            const text = await response.text();
            let data: unknown = null;
            try {
              data = JSON.parse(text) as unknown;
            } catch {
              data = null;
            }
            return { status: response.status, data, text };
          },
        };

  /**
   * 管理类动作（`add_quota` / `set_status`）是否可用。
   *
   * ★ 与「动作注册」和「策略静态校验（knownActions）」**共用同一判据**——
   *   否则会出现「校验通过、运行时找不到动作」的落差（本文件 `checkin:grant`
   *   注册处记过这类教训：两处清单必须一起维护）。
   */
  const manageActionsAvailable = newApiConfig !== undefined && providerTransport !== undefined;

  const resolveProvider = (): ProviderPlugin => {
    if (newApiConfig === undefined || providerTransport === undefined) return notConfiguredProvider;
    return createNewApiProvider({
      transport: providerTransport,
      pat: newApiConfig.pat,
      config: {
        baseUrl: newApiConfig.baseUrl,
        ...(newApiConfig.pageSize === undefined ? {} : { pageSize: newApiConfig.pageSize }),
      },
    });
  };

  /**
   * ★★★ P0-5：把分组**真正写回下游**。
   *
   * ★ 此前 `set_group` 无论是否配置渠道，都只写进程内 `downstreamGroups`
   *   （注册处注释自己写着「真实模式应经 provider 的 updateSubject 写回下游」）——
   *   即「**演示实现被当作生产路径**」：动作报告成功、审计完整，而**下游分组永远不变**。
   * ★ `writeBackAttributes` 早已实现（含「必须先 GET、绝不带 password」两条硬约束），
   *   其函数注释也写明「尚未接入动作执行器」——本处即那一步接线。
   */
  const writeBackGroup =
    newApiConfig === undefined || providerTransport === undefined
      ? undefined
      : async (externalId: string, group: string): Promise<void> => {
          await writeBackAttributes(
            {
              transport: providerTransport,
              pat: newApiConfig.pat,
              config: { baseUrl: newApiConfig.baseUrl },
            },
            externalId,
            { group },
          );
        };

  const pluginInstanceStore =
    db === undefined ? undefined : createTransactionalPluginInstanceStore(db);

  // ★★ L-2：LLM 网关的**条件装配**——有 `AG_LLM_API_KEY` 才启用。
  //   ★ 为什么是"条件"而不是"总是"：没有凭据时构造网关只会得到
  //     「每次调用都失败」的假象；**不装配**才是显式且诚实的。
  //   ★ 配了凭据时**必须**注入持久缓存（`DbLlmCacheStore`）——
  //     否则重启后会为同一批主体**重复付费**（见 P1-12）。
  //   ★ 放在**编排器之前**：插件运行时要通过 `llm` 把它交给宿主 API
  //     （插件因此只能走网关 → 预算/限流/白名单/审计必然生效）。
  const llmApiKey = process.env['AG_LLM_API_KEY'];
  const llmGateway =
    llmApiKey === undefined || llmApiKey.trim().length === 0
      ? undefined
      : new LlmGateway({
          provider: new HttpLlmProvider({
            baseUrl: process.env['AG_LLM_BASE_URL'] ?? 'https://api.openai.com/v1',
            apiKey: llmApiKey.trim(),
          }),
          logger,
          defaultModel: process.env['AG_LLM_MODEL'] ?? 'gpt-4o-mini',
          now: () => new Date(),
          // ★★ **配额守卫**（`docs/05 §6.4`）：限流与预算走**跨实例**计数
          //   （真实模式落 `ag_quota_counters`）——进程内计数会让多实例部署下的
          //   实际配额 = 单实例配额 × 实例数（本会话记录的 L-13）。
          quota: new QuotaGuard({
            store: db === undefined ? new InMemoryQuotaCounterStore() : new DbQuotaCounterStore(db),
            logger,
          }),
          ...(db === undefined
            ? {}
            : {
                cacheStore: new DbLlmCacheStore(db),
                cacheOwner: { ownerScope: 'platform' as const, ownerId: 'platform' },
              }),
        });
  if (llmGateway === undefined) {
    logger.info('未配置 AG_LLM_API_KEY：LLM 网关不装配（插件无法调用 LLM，也不产生费用）');
  } else {
    logger.info('LLM 网关已装配', {
      model: process.env['AG_LLM_MODEL'] ?? 'gpt-4o-mini',
      persistentCache: db !== undefined,
    });
  }

  const pluginRuntime = new PluginRuntimeOrchestrator({
    ...(db === undefined ? {} : { db }),
    facts: factStore,
    ...(logger === undefined ? {} : { logger }),
    // ★★ L-2：把 LLM 通道交给插件运行时。插件**只能**走它——
    //   自己发 HTTP 会绕过预算/限流/模型白名单/审计（见 llm-provider-http.ts 文件头）。
    ...(llmGateway === undefined ? {} : { llm: llmGateway }),
  });

  const emailManifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  // ★★★ R75：此处原本有一行 `new FactPipeline(...)`——
  //   它**只被声明、从未被使用**（第 467 行的注释说「下面会用到」，但代码里没有）。
  //   ★ 而它依赖 `FactPipeline` 的默认主体 `'platform'`，
  //     那是「事实是全局的」这一**已被明确否定**的假设的遗留物
  //     （`ag_plugin_facts.user_id` 是 NOT NULL uuid，字符串写不进去）。
  //   改为必填主体后，它作为**死代码**被编译器暴露出来，故删除。

  // ★★ 插件注册表存储：此前 `installedPlugins()` 是**硬编码数组**，
  //   与 `ag_plugins` 表无关——装了新插件，策略校验看不到它。
  //   现在真实模式从 DB 读，demo 模式用内存（内置插件预置进去）。
  // ★★ L-3：外置插件包体的**启动拉回**（D9：本地仅作可丢弃缓存，启动按 digest 拉回）。
  //   ★ 放在插件装配**之前**：包体必须先落到本地，后续的解包/加载才有东西可读。
  //   ★ 单个失败不阻断启动，但会**记进日志**——否则"某个插件没加载"会变成说不清的现象。
  if (db !== undefined) {
    const cacheDir = path.join(process.cwd(), 'plugins', 'runtime');
    const restoreReport = await restorePluginPackages({
      cacheDir,
      cache: new FileSystemPackageCache({ dir: cacheDir, store: new DbPluginPackageStore(db) }),
      listExternalPlugins: async () =>
        (
          await db.transaction(async () =>
            db.query<{ id: string; version: string; digest: string }>(
              `SELECT id, version, digest FROM ag_plugins WHERE source <> 'builtin' AND status <> 'removed'`,
              [],
            ),
          )
        ).map((row) => ({ pluginId: row.id, version: row.version, digest: row.digest })),
    });
    if (restoreReport.restored.length > 0 || restoreReport.failed.length > 0) {
      logger.info('外置插件包体已按 digest 拉回', {
        restored: restoreReport.restored.length,
        alreadyCached: restoreReport.alreadyCached.length,
        failed: restoreReport.failed.length,
        failures: restoreReport.failed.map(
          (item) => `${item.pluginId}@${item.version}: ${item.reason}`,
        ),
      });
    }
  }

  const pluginStore: PluginStore = db === undefined ? new InMemoryPluginStore() : createTransactionalPluginStore(db);
  if (db === undefined) {
    // demo 模式：预置内置插件，保持原有行为（否则 demo 下策略校验会认为「没有插件」）
    for (const manifest of BUILTIN_MANIFESTS) {
      await pluginStore.install({ manifest, source: 'builtin', signatureVerified: true });
    }
    for (const id of ['email', 'checkin', 'github', 'newapi-provider']) {
      await pluginStore.setStatus(id, 'enabled');
    }
  }

  const enabledPluginIds = await pluginStore.enabledIds();
  // ── 平台设置（`ag_platform_settings`）──
  // ★ 文档 §11：`initial` **仅首次启动生效**，此后以设置为准。
  //   因此这里用 `putIfAbsent`：已存在则不覆盖（否则每次重启都会推翻 API 的切换）。
  const settingsStore: PlatformSettingsStore = db === undefined ? new InMemoryPlatformSettingsStore() : createTransactionalSettingsStore(db);
  await settingsStore.putIfAbsent(
    PLATFORM_MODE_KEY,
    (demo ? 'standalone' : 'saas') satisfies PlatformMode,
    // ★ `updated_by` 是 uuid 列：启动时没有「谁」，用 null 而不是 'system'
    null,
    new Date(),
    // ★ 若部署用环境变量钉死了模式，则标记 locked_by_env（API 不得修改）
    process.env['AG_PLATFORM_MODE'] !== undefined,
  );

  const masterKeyRaw = process.env['AG_MASTER_KEY'];
  // ★ 用**共用接口**（`verify/client-store-db.ts` 从 `hmac.ts` 复用了它），
  //   而不是在这里再写一份形状相同的内联类型——那正是 tsc 报错的来源。
  let verifyClients: import('../src/verify/client-store-db.ts').VerifyClientLookup;
  let verifyClientAdmin: import('../src/verify/client-admin.ts').VerifyClientAdminStore;
  let secretStore: import('../src/secrets/store.ts').SecretStore;
  /** ★ P1-4：主密钥提到外层——OIDC 签名密钥的加解密（`DbOidcSigningKeyStore`）也要用它 */
  let masterKey: Buffer | undefined;
  /**
   * ★ P1-4：签名密钥仓储**也必须提到外层**——管理端点
   *   （`/admin/oidc/signing-keys`）在它之前装配，而 deps 里的
   *   `...(signingKeyStore === undefined ? {} : …)` 是**立即求值**的
   *   （只有箭头函数体内的引用才是惰性的）。
   */
  let signingKeyStore: DbOidcSigningKeyStore | undefined;
  if (db === undefined) {
    // demo/内存模式：明文内存实现（仅供测试，`hmac.ts` 已注明）
    verifyClients = new InMemoryVerifyClientStore();
    verifyClientAdmin = new InMemoryVerifyClientAdminStore();
    secretStore = new InMemorySecretStore();
  } else {
    // ★ 真实模式：主密钥是**必需**的——缺失时显式报错，而不是静默退回内存
    if (masterKeyRaw === undefined || masterKeyRaw.trim().length === 0) {
      throw new Error(
        '真实 PG 模式需要 AG_MASTER_KEY（32 字节，hex 或 base64）——' +
          '调用方密钥必须加密存入 `ag_secrets` 才能重算 HMAC。' +
          '若不提供主密钥而静默退回内存存储，协同验证在重启后会全部失效（且无法察觉）。',
      );
    }
    masterKey = parseMasterKey(masterKeyRaw);
    secretStore = createTransactionalSecretStore(db);
    verifyClients = createTransactionalVerifyClientLookup(db, secretStore, masterKey);
    verifyClientAdmin = createTransactionalVerifyClientAdminStore(db, secretStore, masterKey);
  }
  // ── 管理端仓储（真实模式用 PG，demo 用内存）──
  const pluginConfigStore: import('../src/plugin/config-store.ts').PluginConfigStore =
    db === undefined ? new InMemoryPluginConfigStore() : createTransactionalPluginConfigStore(db);
  const endpointStore: import('../src/plugin/endpoint-store.ts').PluginEndpointStore =
    db === undefined ? new InMemoryPluginEndpointStore() : createTransactionalPluginEndpointStore(db);
  const grantStore: import('../src/plugin/grant-store.ts').PluginGrantStore =
    db === undefined ? new InMemoryPluginGrantStore() : createTransactionalPluginGrantStore(db);
  const userAdminStore: import('../src/admin/user-store.ts').UserAdminStore =
    db === undefined ? new InMemoryUserAdminStore() : createTransactionalUserAdminStore(db);
  const assertionAdminStore: import('../src/verify/assertion-store.ts').AssertionAdminStore =
    db === undefined ? new InMemoryAssertionAdminStore() : createTransactionalAssertionAdminStore(db);
  const oidcProviderStore: import('../src/auth/oidc-provider-store.ts').OidcProviderStore =
    db === undefined ? new InMemoryOidcProviderStore() : createTransactionalOidcProviderStore(db);
  const uiContributionStore: import('../src/plugin/ui-contribution-store.ts').UiContributionStore =
    db === undefined ? new InMemoryUiContributionStore() : createTransactionalUiContributionStore(db);
  const pluginTokenStore: import('../src/plugin/token-store.ts').PluginTokenStore =
    db === undefined ? new InMemoryPluginTokenStore() : createTransactionalPluginTokenStore(db);
  const pluginInvocationStore: import('../src/plugin/invocation-store.ts').PluginInvocationStore =
    db === undefined ? new InMemoryPluginInvocationStore() : createTransactionalPluginInvocationStore(db);

  const registry: PluginRegistry = {
    // ★ `PluginRegistry` 是**同步**接口，而 store 是异步的——
    //   因此在启动时预取一次并缓存（插件状态变更时应重建 registry；
    //   这是当前实现的已知限制，已登记在报告中）。
    installedPlugins: () => enabledPluginIds,
    knownFactKeys: () => [
      'fact.email.domain',
      'fact.email.is_edu',
      'fact.email.matched_rule',
      'fact.email.verified',
      'fact.checkin.last_date',
      'fact.github.total_stars',
    ],
    // ★ 管理类动作只在渠道已配置时才「已知」——否则策略静态校验会放行一个
    //   运行时不存在的动作（两处清单必须由**同一判据**驱动）。
    knownActions: () => {
      const actions = [
        'checkin:grant',
        'checkin:revoke',
        'newapi-set-group:set_group',
        // ★ P0-2：级联回退动作（`docs/05 §3.5` 修正一：`set_group` 拆成两个动作）
        'newapi-set-group:restore',
      ];
      if (manageActionsAvailable) actions.push('newapi-add-quota:add_quota', 'newapi-set-status:set_status');
      return actions;
    },
  };

  // 演示数据：两个下游主体 + 两条策略
  if (demo) {
    for (const [id, email] of [
      ['42', 'alice@tsinghua.edu.cn'],
      ['43', 'bob@gmail.com'],
    ] as const) {
      const facts = evaluateEmailDomain({
        email,
        emailVerified: true,
        config: { allowDomains: ['*.edu.cn', '*.edu'], denyDomains: ['*.evil.com'], requireVerified: true },
      });
      await subjectStore.upsert(
        'newapi-provider',
        { externalId: id, displayName: `user${id}`, email, attributes: { ...(facts ?? {}), group: 'default', status: 1 } },
        ['group', 'status'],
        `demo-fp-${id}`,
        new Date(),
      );
      // ★ 事实必须写进 factStore，且**按主体**写（键含 user_id）——
      //   否则巡检读不到事实，全部判为 indeterminate（演示看起来「没反应」）。
      if (facts !== null) {
        await new FactPipeline({ store: factStore, manifest: emailManifest, userId: id }).emit({ ...facts }, new Date());
      }
    }
    for (const policy of DEMO_POLICIES) {
      const validation = validatePolicy(policy, registry);
      if (validation.issues.length > 0) {
        logger.warn('演示策略未通过校验（不应发生）', { code: policy.code, issues: validation.issues });
        continue;
      }
      await policyStore.saveDraft(DEMO_SITE, policy);
      await policyStore.publish(DEMO_SITE, policy.code, 1);
    }
    logger.warn('DEMO 模式：使用内置假 IdP 与内存数据，仅供演示，切勿用于生产', { siteId: DEMO_SITE });
  }

  // ★★★ R80：回滚依赖（**按主体 / 按策略批量**）——
  //   `core/rollback.ts` 的两种编排**一直存在且被测试覆盖**，但从未接线：
  //   因为 `RollbackDeps.buildPatrol` 需要一个 `PatrolService` 没暴露的能力。
  //   ★ 本轮加了 `PatrolService.buildPatrolFor(...)`（复用它的**全部依赖**）。
  //   ★ 注意：`patrolService` 在本行**之后**才声明——但闭包在**调用时**才求值，
  //     而回滚端点总在服务起来之后才会被调用，因此不会触发 TDZ。
  const rollbackDeps: import('../src/core/rollback.ts').RollbackDeps = {
    switchVersion: (siteId, code, version) => policyStore.rollback(siteId, code, version),
    currentPolicy: (siteId, code) => policyStore.get(siteId, code),
    buildPatrol: ({ policies, directory, maxSubjects }) =>
      patrolService.buildPatrolFor({
        policies,
        directory,
        ...(maxSubjects === undefined ? {} : { maxSubjects }),
      }),
    // ★ 与巡检**同一份主体目录**（回滚「按策略批量」要遍历全站点主体）
    directory: {
      async list(siteId, limit, offset) {
        const stored = await storage.subjects.listExternalIds('newapi-provider');
        void siteId;
        return stored.slice(offset, offset + limit).map((externalId) => ({
          externalId,
          email: null,
          emailVerified: false,
          attributes: {},
        }));
      },
      // ★ `SubjectDirectory` 要求 `count`（回滚「按策略批量」要报进度）
      async count() {
        return (await storage.subjects.listExternalIds('newapi-provider')).length;
      },
    },
    logger,
  };


  const admin = createAdminHandler({
    // ★ 真实 PG 模式下必须注入事务（否则 /api/admin/* 全部 500）
    ...(db === undefined ? {} : { transaction: <T>(fn: () => Promise<T>): Promise<T> => db!.transaction(async () => fn()) }),
    // ★★ 这些依赖**必须**注入，否则对应的管理端点根本不会挂载（返回 404）。
    //   我在 R22–R28 写了插件/用户/调用方/断言等一批端点，但**忘了在这里注入**，
    //   于是它们只在单元测试里可用——真实服务里全部 404。
    //   （`tools/path-probe.ts` 就是为发现这类问题而写的。）
    plugins: pluginStore,
    settings: settingsStore,
    users: userAdminStore,
    verifyClients: verifyClientAdmin,
    oidcProviders: oidcProviderStore,
    uiContributions: uiContributionStore,
    pluginTokens: pluginTokenStore,
    invocations: pluginInvocationStore,
    rollbackDeps,
    pluginRuntime,
    // ★ P1-4：签名密钥的可运维入口（查看状态 + 手动触发轮换）。
    //   ★ 用箭头**惰性引用** `runKeyRotationOnce`：它的定义在本调用点之后（TDZ），
    //     而这里只是把函数交出去，真正求值发生在请求到达时。
    //   ★ 用 IIFE 捕获**局部常量**：`signingKeyStore` 是外层 `let`，
    //     TS 无法在闭包内保持收窄（否则报 "possibly undefined"）。
    ...(signingKeyStore === undefined
      ? {}
      : (() => {
          const store = signingKeyStore;
          return {
            signingKeys: {
              list: () => store.list(),
              rotateOnce: (now: Date) => runKeyRotationOnce(store, now),
            },
          };
        })()),
    // ★★ 审计可见性（`docs/06`「开发者仅见名下站点」）：由装配层给出**该开发者名下的站点集合**——
    //   站点集合是站点级的（需跨站点查询），管理端不该自己拼这个条件。
    auditSiteIdsOfDeveloper: async (developerId: string) =>
      (await siteRegistry.listSitesOf(developerId)).map((site) => site.id),
    // ★★ 灰度一键熔断（`docs/07 M6-3` / `docs/05 §6.3.1`）：
    //   真实模式落 `ag_platform_settings`（键 `policy_rollout_aborts`）——熔断是止血，
    //   **重启不能忘**；内存模式用内存实现（demo 下语义一致）。
    rolloutAborts: db === undefined ? new InMemoryRolloutAbortStore() : new DbRolloutAbortStore(settingsStore),
    // ★ P1-11：外置插件**包体**的权威存储（上传入口）。
    //   ★ 只在真实 PG 模式提供——内存模式没有"外置插件包"这个概念（重启即丢）。
    ...(db === undefined ? {} : { pluginPackages: new DbPluginPackageStore(db) }),
    // ★★ P1-5：跨站点分配查询——**唯一入口**。
    //   ★ 端点必须先用 `evaluateCrossSite()` 判定并写审计，才允许调用它
    //     （`listCrossSite` 不带 `site_id` 条件，这正是"跨站点"的本义）。
    ...(db === undefined
      ? {}
      : {
          policyAssignmentsCrossSite: () =>
            new DbPolicyAssignmentStore(db, DEMO_SITE).listCrossSite(),
        }),
    pluginInstances: pluginInstanceStore,
    assertions: assertionAdminStore,
    grants: grantStore,
    endpoints: endpointStore,
    configs: pluginConfigStore,
    subjects: subjectStore,
    identities: identityStore,
    policies: policyStore,
    audit,
    registry,
    // ★★★★ R98：此前这里是一个**桩**——它的 `listSubjects` **永远返回空列表**、
    //   `getSubject` **永远返回 null**，却带着真实 provider 的 id 与 shapes。
    //   ★ 这是**最坏的一种状态**：它不报错、不像占位符，**看起来像在工作**。
    //   ★ 而真实的 `createNewApiProvider`（`src/plugin/builtin/newapi-provider.ts`，
    //     含真实 HTTP 调用与分页/退避）**从未被装配**——
    //     这正是 `module-wiring` 把它报为「未被生产代码引用」的原因。
    //
    //   ★ 现在的行为（**不再伪装**）：
    //     · 配置了 `AG_NEWAPI_BASE_URL` + `AG_NEWAPI_PAT` → 用**真实 provider**；
    //     · 未配置 → 用桩，但**启动时打 WARN 日志明确说明**（而不是静默）。
    providerForSite: resolveProvider,
    // （下面这段原本内联在此处；R99 提取为 `resolveProvider`，供对账复用）
    logger,
  });

  // ★★★★★ R78：**真实模式下此前没有可用的 OIDC 客户端**——
  //   `tools/serve.ts` 只有 `createDemoIdp()`（issuer = `http://localhost/demo-idp`），
  //   而真实模式下 demo 登录被正确禁用（404）。
  //   ★ `AG_OIDC_ISSUER` / `_CLIENT_ID` / `_REDIRECT_URI` 只被
  //     `assertProductionReady` **校验**，**从未用于构造客户端**——
  //     于是「真实 PG 模式下的 OIDC 授权码登录」根本没有接线。
  //
  //   ★ 本修复：真实模式用环境变量构造**真实验签**的 `OidcClient`
  //     （它会拉 `.well-known/openid-configuration` 并按 JWKS 验签、校验 nonce）。
  const demoIdp = createDemoIdp();
  const oidc: OidcClient =
    db === undefined
      ? demoIdp.client
      : (() => {
          const issuer = process.env['AG_OIDC_ISSUER'];
          const clientId = process.env['AG_OIDC_CLIENT_ID'];
          // ★ `redirectUri` 用 `AG_OIDC_REDIRECT_URI`，缺省时**从 publicUrl 推导**：
          //   `assertProductionReady` 对 redirectUri 只是 **warn**（不是 error），
          //   因此这里不能比它更严格——否则「只缺 redirectUri」的部署会启动失败。
          //   ★ 我第一版直接抛错，立刻打断了 `test/serve-real.test.ts` 的冒烟测试。
          const redirectUri =
            process.env['AG_OIDC_REDIRECT_URI'] ?? `${process.env['AG_PUBLIC_URL'] ?? `http://localhost:${port}`}/api/auth/callback`;
          if (issuer === undefined || clientId === undefined) {
            // `assertProductionReady` 已经拦过这两种；这里是**第二道**防线（fail-closed）
            throw new Error('真实模式缺少 OIDC 配置（AG_OIDC_ISSUER / AG_OIDC_CLIENT_ID）');
          }
          return new OidcClient({
            config: {
              issuer,
              clientId,
              redirectUri,
              ...(process.env['AG_OIDC_CLIENT_SECRET'] === undefined ? {} : { clientSecret: process.env['AG_OIDC_CLIENT_SECRET'] }),
            },
            // ★★ 必须**适配**，不能直接传 `globalThis.fetch`：
            //   `HttpFetcher` 返回 `{ status, headers, text }`，而 `fetch` 返回 `Response`。
            //   ★ 我第一版写成 `globalThis.fetch as unknown as HttpFetcher`——
            //     类型断言**掩盖了形状不符**，运行时才报「发现文档不是合法 JSON」
            //     （因为 `response.text` 是**函数**，不是字符串）。
            //   ★ 与之前的 `as never` 同一类错误：**断言不是适配**。
            fetch: async (url, init) => {
              const response = await fetch(url, init === undefined ? {} : { method: init.method, headers: init.headers, body: init.body });
              return {
                status: response.status,
                headers: Object.fromEntries(response.headers.entries()),
                text: await response.text(),
              };
            },
          });
        })();
  const tokens = demoIdp.tokens;

  const eligibilitySource = {
    async forUser({ principal, siteId }: { principal: { email: string | null; emailVerified: boolean; userId: string; username: string }; siteId: string }) {
      // ★ 真实 PG 模式下**必须**包事务：下面会用到 `emailPipeline`（写事实）与
      //   `policyStore`（读策略），两者都走 `db.query`，而本函数由**路由处理器**调用
      //   （不在业务事务内）→ 不包会直接 500。
      //   这与 `SessionService` 是同一类问题；处置方式也相同（在入口包一层）。
      if (db !== undefined) {
        return await db.transaction(async () => forUserInner({ principal, siteId }));
      }
      return await forUserInner({ principal, siteId });
    },
  };

  const forUserInner = async ({ principal, siteId }: { principal: { email: string | null; emailVerified: boolean; userId: string; username: string }; siteId: string }) => {
      // 取该主体的邮箱事实（演示：直接从会话主体算一次）
      const facts = principal.email === null
        ? null
        : evaluateEmailDomain({
            email: principal.email,
            emailVerified: principal.emailVerified,
            config: { allowDomains: ['*.edu.cn', '*.edu', '*.ac.uk'], denyDomains: ['*.evil.com'], requireVerified: true },
          });
      const now = new Date();
      // ★★ 必须按**当前主体**构造 pipeline 并取快照。
      //   `FactPipeline` 与 `collectFactSnapshot` 的 `userId` 默认值都是字符串 `'platform'`，
      //   而 `ag_plugin_facts.user_id` 是 **uuid 列** —— 真实 PG 下会直接报
      //   `invalid input syntax for type uuid: "platform"`（资格查询 500）。
      //   内存模式的 key 是字符串，因此**只在真实 PG 下暴露**。
      const userPipeline = new FactPipeline({ store: factStore, manifest: emailManifest, userId: principal.userId });
      if (facts !== null) await userPipeline.emit({ ...facts }, now);
      const collection = await collectFactSnapshot(
        factStore,
        [{ pluginId: 'email', fields: ['domain', 'is_edu', 'matched_rule', 'verified'], ttl: '30d' }],
        now,
        // ★ 参数顺序：`(store, sources, now, userId, logger?)`——主体必填在前
        principal.userId,
        logger,
      );
      const policies = (await policyStore.list(siteId)).filter((p) => p.enabled !== false);

      // ★★ P0-1：`subject:*` 的**快照解析**（跨系统寻址，`docs/04 §1.2.7.2`）。
      //   ★ 必须在这里做：求值（`evaluateEligibility`）是**同步**的，
      //     而「查绑定 → 读下游主体属性」是异步的——与 `fact:*` 同构。
      //   ★ 只在策略**真的用到** `subject:*` 时才解析（避免无谓的下游调用）。
      const subjectKeys = new Set<string>();
      for (const policy of policies) collectSubjectKeys(policy.spec, subjectKeys);
      let subjectSnapshot: Record<string, unknown> | undefined;
      if (subjectKeys.size > 0 && db !== undefined) {
        const provider = resolveProvider();
        const snapshot = await collectSubjectSnapshot({
          userId: principal.userId,
          keys: [...subjectKeys],
          resolver: new DbPluginBindingStore(db, siteId),
          readSubject: async ({ externalId }) => {
            const subject = await provider.getSubject(externalId);
            return subject === null ? undefined : (subject.attributes as Record<string, unknown>);
          },
        });
        subjectSnapshot = snapshot.values;
        if (snapshot.failures.length > 0) {
          // ★ 不是错误：解析失败会落到 `$onMissing`（H1：不降级）。
          //   但排障需要知道"差哪一项、为什么"。
          logger.debug('跨系统寻址部分失败（将交 $onMissing 决定）', {
            failures: snapshot.failures.length,
            first: snapshot.failures[0]?.reason,
          });
        }
      }

      const report = evaluateEligibility(
        {
          policies,
          user: { status: 'active', email_verified: principal.emailVerified, username: principal.username, email: principal.email },
          facts: collection.snapshot,
          // ★★ P0-1：跨系统寻址的取值（采集阶段已解析好，这里只传递）
          ...(subjectSnapshot === undefined ? {} : { subject: subjectSnapshot }),
          now,
        },
        logger,
      );
      return {
        progress: report.progress,
        todos: report.todos,
        results: report.results.map((r) => ({
          code: r.code,
          name: r.name ?? r.code,
          decision: r.evaluation.decision,
          summary: r.evaluation.summary,
          actions: r.evaluation.actions,
          items: r.view.items,
        })),
      };
  };

  // ── 站点注册表与两级选择（M7-5/M7-6/M7-7 的 HTTP 面）──
  // ★ 单站点部署用 standalone 兜底：自动建出默认开发者与默认站点，用户不感知两级选择。
  //   真实 PG 模式下改用**持久化**注册表（重启不丢站点/开发者）；
  //   注意用 `createTransactionalSiteRegistry`——SiteRegistry 的方法不在业务事务内，
  //   直接使用 DbSiteRegistry 会触发 `assertInTransaction`。
  const siteRegistry = db === undefined ? new InMemorySiteRegistry() : createTransactionalSiteRegistry(db);

  // R91: developer onboarding service (P0-1).
  //   Previously InvitationService was instantiated ONLY in tests, and
  //   recordDeveloperIdentity had NO call site -> no developer could ever log in.
  //   Real mode uses DbInvitationStore (PG) and injects the identity write as
  //   onboardIdentity, which redeem() calls INTERNALLY so callers cannot forget it.
  const invitationStore: import('../src/core/invitations.ts').InvitationStore =
    db === undefined ? new InMemoryInvitationStore() : createTransactionalInvitationStore(db);
  const invitationService = new InvitationService({
    store: invitationStore,
    sites: siteRegistry,
    // ★★★ R101（方案 A）：入驻时**同时**建立「开发者 ↔ 平台用户」映射。
    //   ① `ensureDeveloperUser` 建 `ag_users` 并回填 `ag_developers.user_id`；
    //   ② `ag_identities.user_id` **指向该 `userId`**（而不是 `developerId`）——
    //      ★ 这是对 R76 的一致性修正：表语义要求 `user_id` → `ag_users.id`。
    //   ★ 两步都在 `redeem()` 内部触发，调用方**无法忘记**。
    onboardIdentity: async ({ developerId, oidcSubject, username, email, emailVerified }) => {
      if (db === undefined) return; // demo 模式没有真实身份表
      const userId = await ensureDeveloperUser(db, { developerId, username, email, emailVerified });
      await recordDeveloperIdentity(db, { developerId: userId, oidcSubject });
    },
    logger,
  });

  // ★★★ R95：**事件外发**装配（P1-1 的第二半）。
  //   此前全部组件都已存在（`EventBus` · `DbOutboxStore` · `OutboxDispatcher`），
  //   但 **`serve.ts` 从未注入 `bus`** → `patrol.ts` / `reconciler.ts` 里
  //   `if (this.options.bus !== undefined)` 恒为假 → **事件产生点静默不工作**。
  //   ★ 本处接上：事件 → 订阅 → **写入发件箱**（可靠落库）→ 定时投递。
  const eventBus = new EventBus({
    ...(logger === undefined ? {} : { logger }),
    onHandlerError: (error, event) => {
      logger?.error('事件订阅者抛错', { type: event.type, error: error instanceof Error ? error.message : String(error) });
    },
  });
  // ★ 发件箱（真实模式落 `ag_event_outbox`；demo 用内存）
  const outboxStore: import('../src/kernel/events.ts').OutboxStore =
    db === undefined ? new InMemoryOutboxStore() : createTransactionalOutboxStore(db, DEMO_SITE);
  // ★★★★ **不要**用「订阅所有事件 → 写发件箱」来实现 outbox！
  //
  //   ★ 我最初就是这么写的（注册一个通配订阅者去 append），而**测试立刻抓到了它**：
  //     第二次 `dispatchDue()` 又投递了 1 条——
  //     因为投递时也走 `bus.emit(event)`，
  //     于是**那个通配订阅者又把同一事件写回发件箱** → **无限自我复制**。
  //
  //   ★ 正确做法（transactional outbox 的本意，见 `events.ts` 文件头注释）：
  //     **业务代码在写业务数据的事务内 append**——
  //     发件箱记录与业务数据**同事务提交**，投递是**另一个方向**（outbox → bus → 订阅者）。
  //   ★ 因此本处**不注册任何通配订阅者**；`outboxStore` 供业务代码在事务内写入。
  //
  //   ⚠ 现状：`patrol.ts` / `reconciler.ts` 用的是 `bus.emitSafely`（**进程内**），
  //     把它们改成严格的事务内 append 是**后续工作**（见 reports/architecture-gaps.md）。
  const outboxDispatcher = new OutboxDispatcher({
    store: outboxStore,
    bus: eventBus,
    ...(logger === undefined ? {} : { logger }),
  });

  // ★★★ R99：**渠道对账（reconciler）**接线（P1-1 的最后一环）。
  //   此前 `core/reconciler.ts` **没有任何调用** → **对账不会发生** →
  //   下游主体目录与真实渠道**会逐渐漂移**。
  //   ★ 现在组件齐全：真实 provider（R98）· PG 同步状态（R93）· 事件总线（R95）。
  //   ★ `reconcile()` 会自动选择 full（首次）或 incremental（有 lastFullSyncAt 后）。
  const reconciler = new Reconciler({
    // ★ 用与 admin 相同的 provider 解析（未配置渠道时会**显式抛错**，不会静默）
    // ★ 与 admin 端**同一个解析函数**（避免两处不一致）
    provider: resolveProvider(),
    subjects: subjectStore,
    // ★ PG 同步状态（R93 新增）——重启后**游标不丢**，因此增量同步不会从头再来
    state: db === undefined ? new InMemorySyncStateStore() : createTransactionalSyncStateStore(db, DEMO_SITE),
    bus: eventBus,
    ...(logger === undefined ? {} : { logger }),
  });


  /**
   * ★★★★ R104（步骤 4）：**插件自动调度**——按「开发者级实例」解析主体并采集。
   *
   * ★ 此前插件只能**手动触发**（`POST /api/admin/plugins/:id/collect`，需调用方给 userId），
   *   因为「开发者级插件的事实记在谁名下」**未决**。
   * ★ 方案 A 落地后（R101–R103），主体可解析为**开发者的平台用户 id**：
   *     插件实例（`ag_plugin_instances`，`scope='developer'`）
   *       → `developer_id`
   *       → `ensureDeveloperUser`（幂等）取 `userId`
   *       → `FactPipeline.userId = userId`
   *
   * ★ 取不到就**跳过并记日志**（不抛错、不静默）：
   *   未配置实例 / 开发者未建立映射 / 插件清单未知 —— 三种情况都跳过。
   */
  const runPluginCollection = async (): Promise<void> => {
    if (db === undefined || pluginInstanceStore === undefined) return;
    const instances = await pluginInstanceStore.listEnabledDeveloperInstances();
    for (const instance of instances) {
      if (instance.developerId === null) {
        logger.debug('插件实例缺少 developer_id，跳过', { pluginId: instance.pluginId });
        continue;
      }
      const manifest = (BUILTIN_MANIFESTS as readonly { id?: string }[]).find((entry) => entry.id === instance.pluginId);
      if (manifest === undefined) {
        logger.debug('插件清单未知，跳过', { pluginId: instance.pluginId });
        continue;
      }
      // ★ 解析主体：开发者的**平台用户 id**（方案 A 的映射）
      let userId: string;
      try {
        const developer = await siteRegistry.findDeveloper(instance.developerId);
        if (developer === undefined) {
          logger.debug('插件实例的开发者不存在，跳过', { developerId: instance.developerId });
          continue;
        }
        userId = await ensureDeveloperUser(db, {
          developerId: developer.id,
          username: developer.username,
          email: developer.email,
          emailVerified: true,
        });
      } catch (error) {
        logger.debug('解析插件实例的主体失败，跳过', {
          pluginId: instance.pluginId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      // ★ 采集（失败不影响其它实例）
      try {
        const outcome = await pluginRuntime.runOnce(manifest as never, { userId });
        if (outcome.ok) {
          logger.info('插件采集完成', { pluginId: outcome.pluginId, written: outcome.written.length });
        } else {
          logger.warn('插件采集失败', { pluginId: outcome.pluginId, error: outcome.error });
        }
      } catch (error) {
        logger.warn('插件采集异常', {
          pluginId: instance.pluginId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // ★ 未配置渠道连接时**明确告知**（而不是让桩静默返回空列表）
  if (process.env['AG_NEWAPI_BASE_URL'] === undefined || process.env['AG_NEWAPI_PAT'] === undefined) {
    logger.warn(
      '渠道（newapi-provider）未配置：AG_NEWAPI_BASE_URL / AG_NEWAPI_PAT 缺失——' +
        '主体同步与对账**不可用**（调用会显式报错，不会静默返回空列表）。' +
        '★ 这是**刻意的降级**：静默返回空列表会被误读为「渠道里没有主体」。',
    );
  }

  const standalone = await ensureStandalone(siteRegistry);
  const consoleRoutes = createConsoleRoutes({
    sessions,
    registry: siteRegistry,
    // 当前用户可见的开发者集合：standalone 下只有默认开发者
    listDeveloperIds: async () => [standalone.developer.id],
    // ★★ 站点准入闸门——与 `POST /api/me/site` 走**同一道**。
    //   ★ 前端门户走的是本模块的 `POST /api/me/selection`：
    //     所以这里不注入 = 闸门**不存在**（本会话核实过——我第一版就漏了这一处）。
    ...(db === undefined
      ? {}
      : {
          emailAdmission: makeSiteAdmissionCheck({
            listRules: (siteId: string) => new DbEmailRuleStore(db, siteId).list(),
            // ★★ 「站点不存在」必须**拒绝**——否则 `?site=<随便一个 uuid>` 会因为
            //   "没有规则"（`decideEmailAdmission([], …)` 默认允许）而被**放过**。
            //   这两件事必须分开：**没有规则 = 允许**；**站点不存在 = 拒绝**。
            siteExists: async (siteId: string) => {
              const site = await siteRegistry.findSite(siteId);
              // ★ 「不存在」与「不可用（停用）」都必须拒绝——两者都会让
              //   `decideEmailAdmission([], …)` 返回"默认允许"。
              return site !== undefined && site.status === 'active';
            },
          }),
        }),
    // 注：UI 贡献宿主（M4-8）尚未接入本入口——`/api/ui/manifest` 会返回空结构
    logger,
  });

  // ── 跨项目协同（M5）与 OIDC IdP（M5-6 outbound）的 HTTP 面 ──
  // ★ 这两组路由此前**完全没有挂载**到 serve.ts：`/api/verify/v1/*` 与 `/oauth/*`
  //   在生产服务里根本不存在——M5 的能力只存在于单元测试里。
  //   这是「设计落地 ≠ 生产落地」的又一实例。
  // ★★ P1-4 接线：真实模式下**从表加载**签名密钥（替代运行时生成）。
  //   ★ 修复前的形态：`new SigningKeySet()` + 运行时生成 → **重启即换密钥** →
  //     已签发的 ID Token / 断言在**真正验签的**下游那里全部验不过；
  //     而 `docs/05 §8.4.1` 的「先发布、后使用」**前提就是密钥持久**——
  //     否则每次重启都等于一次「未发布就使用」的轮换。
  signingKeyStore =
    db === undefined || masterKey === undefined ? undefined : new DbOidcSigningKeyStore(db, masterKey);
  let signingKeys: SigningKeySet;
  if (signingKeyStore !== undefined) {
    signingKeys = await signingKeyStore.loadSigningKeySet();
    if (signingKeys.active === undefined) {
      // 冷启动：库里还没有密钥 → 生成一把并启用（走「先发布、后使用」的冷启动路径）
      const now = new Date();
      const created = await signingKeyStore.createStandby({ alg: ASSERTION_ALG, now });
      await signingKeyStore.activateAtomically({
        retiringKid: null,
        activeKid: created.kid,
        now,
        removeAfter: new Date(now.getTime() + 24 * 3_600_000),
      });
      signingKeys = await signingKeyStore.loadSigningKeySet();
      logger.info('已生成并启用首把 OIDC 签名密钥', { kid: created.kid });
    } else {
      logger.info('已从数据库加载 OIDC 签名密钥', {
        activeKid: signingKeys.active.kid,
        published: signingKeys.publishable().length,
      });
    }
  } else {
    // demo / 无主密钥：**显式**降级到内存（并说出来，而不是静默）
    signingKeys = new SigningKeySet();
    const generated = await generateSigningKey(`key-${Date.now()}`);
    signingKeys.add({ ...generated, status: 'active', createdAt: new Date() } as ManagedSigningKey);
    logger.warn('未配置数据库或 AG_MASTER_KEY：签名密钥仅在内存中（**重启即换**，仅适用于演示）');
  }
  // ★★★ 真实 PG 模式**必须**用 DB 实现：
  //   原先这里无条件用 `InMemoryVerifyClientStore`，导致真实模式下
  //   ① 调用方只存在内存（重启即丢）；② 管理端写 DB、校验端读内存 →
  //   **创建的调用方永远校验不过**；③ `ag_secrets` 从未被写入。
  //   这正是目标第 (1) 条禁止的「用内存模式冒充真实模式」。

  // ★ 与 verifyClients 同一策略：真实模式用 DB，demo 用内存
  const nonceStore: import('../src/verify/hmac.ts').NonceStore =
    db === undefined ? new InMemoryNonceStore() : createTransactionalNonceStore(db);

  // ★★ R64：设备码挑战必须**持久化**（此前无条件用内存实现）——
  //   设备码是**跨请求、跨实例**的协议（客户端轮询可能落到别的实例），
  //   内存实现下多实例授权**永远完不成**、重启后全部失效。
  const challengeStore: import('../src/verify/device-code.ts').ChallengeStore =
    db === undefined ? new InMemoryChallengeStore() : createTransactionalChallengeStore(db);
  const deviceCode = new DeviceCodeService({ store: challengeStore, publicUrl: config.publicUrl ?? 'http://127.0.0.1', now: () => new Date() });
  const verifyRoutes = createVerifyRoutes({
    clients: verifyClients,
    // ★★ R58：nonce 防重放必须**持久化**（此前无条件用内存实现）——
    //   多实例下 A 实例用过的 nonce，B 实例不认识 → 重放防护失效。
    nonces: nonceStore,
    deviceCode,
    signingKeys,
    issuer: config.publicUrl ?? 'http://127.0.0.1',
    // 断言来源：从**资格状态**取（真实模式下来自 PG）
    assertionSource: {
      async lookup(subject) {
        return { matched: true, displayName: subject.value, assertions: { eligible: false, note: '尚未接入资格联动' } };
      },
    },
    logger,
    now: () => new Date(),
  });
  // ★★ **OAuth 存储必须落库**（与 P0-2 的 `AlertSilenceStore` **完全同型**的问题）：
  //   `DbOAuthStore` 早已实现，但这里**无条件用内存实现** →
  //   本平台作为 IdP 时，**重启会丢掉全部客户端注册与授权码**：
  //   · 授权码丢失 = 正在进行的授权流程全部失败；
  //   · 客户端丢失 = 所有 RP 需重新注册。
  const oauthStore = db === undefined ? new InMemoryOAuthStore() : createTransactionalOAuthStore(db);
  // 注册一个示例 RP（生产应由 admin 通过 /admin/oidc/providers 管理）
  await oauthStore.saveClient({
    clientId: 'gate-portal',
    name: '内置示例客户端',
    redirectUris: [`${(config.publicUrl ?? 'http://127.0.0.1').replace(/\/+$/, '')}/api/auth/callback`],
    scopes: ['openid', 'profile', 'email'],
    status: 'active',
  });
  const oauthRoutes = createOAuthRoutes({
    store: oauthStore,
    issuer: config.publicUrl ?? 'http://127.0.0.1',
    signingKeys: [signingKeys.requireActive()],
    loadSubject: async () => undefined,
    logger,
    now: () => new Date(),
  });

  // ── 冷启动引导（生产必需）──
  // ★ 全新部署时没有任何会话，而 OIDC 授权**又需要先有会话**——这是一个循环。
  //   生产上的标准解法是「一次性引导令牌」：启动时打印到 stdout（只有运维看得到），
  //   用它换一个管理员会话，**用后即焚**。
  //   仅在 demo 关闭时生成（demo 模式下本来就有演示登录）。
  const bootstrapToken = demo ? undefined : randomBytes(32).toString('base64url');
  const bootstrapRoute: Route = {
    method: 'GET',
    path: '/api/auth/bootstrap',
    auth: 'none',
    handler: async (ctx): Promise<RouteResult> => {
      if (bootstrapToken === undefined) {
        return { status: 404, body: { error: '引导入口已关闭（demo 模式请使用演示登录）' } };
      }
      if (ctx.query['token'] !== bootstrapToken) {
        // ★ 不区分「令牌错」与「令牌已用过」——避免成为探针
        return { status: 403, body: { error: '引导令牌无效或已失效' } };
      }
      const principal = principalFromClaims(
        // ★ `sub` 必须是**纯 uuid**：`ag_sessions.user_id` 是 uuid 列，
        //   带 `bootstrap:` 前缀会被 PG 拒绝（invalid input syntax for type uuid）。
        { sub: standalone.developer.id, emailVerified: true, preferredUsername: standalone.developer.username },
        { realm: 'developer', role: 'admin', activeSiteId: standalone.site.id },
      );
      const created = await sessions.create(principal);
      ctx.setCookie(SESSION_COOKIE, created.token, { sameSite: 'Lax', path: '/', maxAgeSec: 12 * 3600 });
      logger.warn('引导令牌已被使用——该令牌此后失效', { developerId: standalone.developer.id });
      return { status: 302, headers: { Location: '/' }, body: '' };
    },
  };

  // ── 登录准入（两条链路隔离）──
  // ★ 生产必须接线：否则 `/api/auth/login?realm=developer` 会让任何人直接成为开发者。
  //   开发者身份表暂用内存实现（生产应落 `ag_developers` 关联表），已在报告中登记为缺口。
  // ★ 开发者身份查找：真实模式查 `ag_identities`（`owner_scope='developer'`）；
  //   demo 模式返回 undefined（没有入驻数据）。
  //   ★ 「入驻」的写入端见 `recordDeveloperIdentity`（由邀请码入驻流程调用）。
  const developerIdentityLookup: import('../src/core/invitations.ts').DeveloperLookup =
    db === undefined ? { findByIdentity: async () => undefined } : createTransactionalDeveloperIdentityLookup(db);
  // ★★★★ R63：终端用户必须**持久化**（此前无条件用内存实现）——
  //   内存实现的后果：**重启后用户「消失」**（下次登录被当新用户重建，
  //   历史资格/动作/审计全部对不上）。见 `src/db/end-user-adapter.ts`。
  const endUsers: EndUserStore = db === undefined ? new InMemoryEndUserStore() : createTransactionalEndUserStore(db);
  const loginResolver = async (input: { ref: string; oidcSubject: string; email: string; emailVerified: boolean; displayName?: string }) => {
    const outcome = await resolveLogin(
      {
        ref: input.ref,
        oidcSubject: input.oidcSubject,
        email: input.email.length > 0 ? input.email : `${input.oidcSubject}@unknown.invalid`,
        emailVerified: input.emailVerified,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      },
      {
        // ★★★★★ R76：此前这里是「空 Map 且无人写入」——
        //   结果是 `findByIdentity` 永远返回 undefined，
        //   `assertDeveloperMayLogin` 永远返回 `not_onboarded`，
        //   **开发者永远无法登录**（而测试全绿，因为测试手工构造了 lookup）。
        //   ★ 现在改为**真实 PG 实现**（查 `ag_identities`）。
        developerIdentities: developerIdentityLookup,
        endUsers,
        sites: siteRegistry,
        // ★★ 这里**刻意不注入** `emailRules`（本会话按"统一登录 + 站点自选"核实后修正）。
        //   理由：登录是**平台级统一**的，而 `ag_email_rules` 是**站点级**表；
        //   登录后会话的 `activeSiteId` 是 **null**（站点由用户自选或传参指定）。
        //   在登录时拿某个（默认）站点的规则去判，是**错的站点**——
        //   准入的**权威检查点**在 `POST /api/me/site`（见 `routes.ts` 的 `switchSite`）。
        logger,
      },
    );
    if (!outcome.ok) return { ok: false as const, reason: outcome.reason, message: outcome.message };
    return {
      ok: true as const,
      realm: outcome.realm,
      role: (outcome.realm === 'developer' ? 'developer' : 'user') as 'admin' | 'developer' | 'user',
      principalId: outcome.principalId,
    };
  };

  /**
   * ★★ L-1：邀请码核销的**唯一实现**（两处路由装配共用）。
   *   ★ 抽出来而不是复制两份：两份实现迟早会漂移，而"核销"是**不可逆**操作——
   *     两个入口行为不一致会造成真实的资损。
   *   ★ 取舍：**核销成功后写事实；事实写入失败不回滚核销**——
   *     码的消耗不可逆（回滚要减 `usedCount`，并发下会重开超发窗口），
   *     而事实写入可重试。失败时返回 `grantedPending: true`。
   */
  const inviteRedeemImpl =
    db === undefined
      ? undefined
      : async ({ siteId, userId, code }: { siteId: string; userId: string; code: string }) => {
          const store = new DbInviteCodeStore(db, siteId);
          const redeemed = await store.redeem({ code, now: new Date() });
          if (!redeemed.ok) {
            const messages = {
              not_found: '邀请码不存在',
              expired: '邀请码已过期',
              exhausted: '邀请码已被用完',
            } as const;
            return { ok: false, reason: redeemed.reason, message: messages[redeemed.reason] };
          }
          // ★ 授予的事实**只允许 manifest 声明的字段**——
          //   否则拿到"创建邀请码"权限的人可以借它往事实库写任意字段。
          const facts = buildInviteFacts({
            grantsFacts: redeemed.invite.grantsFacts,
            inviteCodeId: redeemed.invite.id,
          });
          try {
            await new FactPipeline({
              store: factStore,
              manifest: validateManifest(INVITE_GRANTS_MANIFEST),
              userId,
            }).emit(facts, new Date());
          } catch (error) {
            logger.error('邀请码已核销，但授予事实失败（需人工重试）', {
              inviteCodeId: redeemed.invite.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              ok: true,
              granted: facts,
              grantedPending: true,
              message: '邀请码已核销，但权益发放失败，请带着该记录联系管理员重试',
            };
          }
          return { ok: true, granted: facts };
        };

  const appRoutes = createAppRoutes({
    sessions,
    loginResolver,
    oidc,
    loginTransactions,
    csrfSecret,
    admin,
    eligibility: eligibilitySource,
    // ★ 用箭头包装而不是直接传 `checkinService`：本处 `createAppRoutes` 的装配
    //   早于 `checkinService` 的构造（后者依赖 `actionRegistry`），直接引用会触发 TDZ；
    //   而路由表只是**配置**，handler 在**请求时**才求值，因此惰性引用既安全又等价。
    checkin: {
      status: (input) => checkinService.status(input),
      checkin: (input) => checkinService.checkin(input),
      history: (input) => checkinService.history(input),
    },
    // ★★ 站点准入闸门（`ag_email_rules`）——**权威检查点**在**切换站点**时。
    //   ★ 登录是平台级统一的，站点由用户自选/传参指定；`activeSiteId` 默认 `null`，
    //     而 `switchSite` 是**唯一**设置它的路径——所以在这里校验是**完整覆盖**。
    ...(db === undefined
      ? {}
      : {
          // ★ 两处路由装配共用**同一份**实现（见 `makeSiteAdmissionCheck`）
          emailAdmission: makeSiteAdmissionCheck({
            listRules: (siteId: string) => new DbEmailRuleStore(db, siteId).list(),
            // ★★ 「站点不存在」必须**拒绝**——否则 `?site=<随便一个 uuid>` 会因为
            //   "没有规则"（`decideEmailAdmission([], …)` 默认允许）而被**放过**。
            //   这两件事必须分开：**没有规则 = 允许**；**站点不存在 = 拒绝**。
            siteExists: async (siteId: string) => {
              const site = await siteRegistry.findSite(siteId);
              // ★ 「不存在」与「不可用（停用）」都必须拒绝——两者都会让
              //   `decideEmailAdmission([], …)` 返回"默认允许"。
              return site !== undefined && site.status === 'active';
            },
          }),
        }),
    // ★★ L-1：邀请码核销（**共享实现**，见上面的 `inviteRedeemImpl`——
    //   核销是不可逆操作，两个入口的行为必须完全一致）
    ...(inviteRedeemImpl === undefined ? {} : { inviteRedeem: inviteRedeemImpl }),
    // ★ 用户自助：我的身份绑定（用户 id 只从会话取）
    identities: identityStore,
    invitations: invitationService,
    defaultSiteId: DEMO_SITE,
    logger,
    version: '0.1.0-m0',
  });

  // 演示登录入口：直接建会话（省去真实 IdP 往返）
  const demoLogin: Route = {
    method: 'GET',
    path: '/api/auth/demo-login',
    auth: 'none',
    handler: async (ctx) => {
      if (!demo) return { status: 404, body: { error: '演示登录已关闭' } };
      const email = ctx.query['email'] ?? 'alice@tsinghua.edu.cn';
      const realm = ctx.query['realm'] === 'developer' ? 'developer' : 'enduser';
      const code = randomToken(8);
      tokens.set(code, { sub: `demo:${email}`, email, email_verified: true, preferred_username: email.split('@')[0] });
      const principal = principalFromClaims(
        { sub: `demo:${email}`, email, emailVerified: true, preferredUsername: email.split('@')[0] ?? 'demo' },
        {
          realm,
          // ★ 允许显式指定角色：`?role=developer` 用于演示
          //   「开发者不能安装插件、不能新增 OIDC」这条边界（M7-7）。
          //   默认仍是 admin——单站点部署的默认账号本来就是管理员。
          role: ctx.query['role'] === 'developer' ? 'developer' : realm === 'developer' ? 'admin' : 'user',
          activeSiteId: DEMO_SITE,
        },
      );
      const { token } = await sessions.create(principal);
      ctx.setCookie(SESSION_COOKIE, token, { sameSite: 'Lax', path: '/', maxAgeSec: 12 * 3600 });
      return { status: 302, headers: { Location: '/' }, body: '' };
    },
  };

  const portal: Route = {
    method: 'GET',
    path: '/',
    auth: 'none',
    handler: () => ({ body: renderPortalHtml({ demo }), contentType: 'text/html; charset=utf-8' }),
  };

  // ── 巡检接线（M2-6）：评估 → 迁移 → 动作计划 → 执行 → 回读 ──
  const scheduler = new Scheduler({
    store: storage.jobs,
    logger,
    holder: `instance-${process.pid}`,
    // ★ 真实 PG 模式必须包事务：DbJobStore 经 Db.query 调用，
    //   而后者有「必须在事务内」的断言——不包则调度器一注册就抛 TransactionRequiredError。
    ...(db === undefined ? {} : { transaction: <T>(fn: () => Promise<T>): Promise<T> => db.transaction(async () => fn()) }),
  });

  // 动作注册表：把策略里的动作名绑定到「经 provider 写回」的实现
  /**
   * 下游读写接口（`DownstreamApi`）—— 动作插件经它访问下游，**核心不认识具体系统**。
   *
   * ★★★ P0-5（后半）：`src/plugin/builtin/newapi-actions.ts` 此前**零生产引用**——
   *   即「签到发额度」所需的 `add_quota` 在服务里**根本不存在**（而策略可以引用它）。
   */
  const downstreamApi: DownstreamApi | undefined =
    newApiConfig === undefined || providerTransport === undefined
      ? undefined
      : createNewApiDownstreamApi({
          providerDeps: {
            transport: providerTransport,
            pat: newApiConfig.pat,
            config: { baseUrl: newApiConfig.baseUrl },
          },
          getSubject: async (externalId) => {
            const subject = await resolveProvider().getSubject(externalId);
            return subject === null ? null : { attributes: subject.attributes };
          },
        });

  /**
   * `policyId` → 策略 code。
   *
   * ★ 为什么需要这个反查：`ag_user_policy_state` 的外键是 `policy_id`（uuid），
   *   而生命周期存储的接口按 **code** 键（`LifecycleStateStore.get/save` 一直如此）——
   *   两个世界的桥就是这里。内存模式下 policyId 就是 code（装配两侧自洽）。
   */
  const policyCodeOf = async (policyId: string): Promise<string | undefined> => {
    if (db === undefined) return policyId;
    const rows = await db.query<{ code: string }>('SELECT code FROM ag_policies WHERE id = $1 LIMIT 1', [
      policyId,
    ]);
    return rows[0]?.code;
  };

  const actionRegistry = new ActionRegistry();
  const downstreamGroups = new Map<string, string>(); // externalId → 当前分组（演示用）
  actionRegistry.register(
    'newapi-set-group:set_group',
    createSetGroupHandler({
      externalIdOf: (context) => context.userId,
      getSubject: async (externalId) => {
        const stored = await storage.subjects.get('newapi-provider', externalId);
        return stored === null || stored === undefined ? null : { attributes: stored.attributes };
      },
      setGroup: async (externalId, group) => {
        // ★ P0-5：真实渠道已配置 → **真的写回下游**
        //   （read-modify-write 与敏感字段剔除在 `writeBackAttributes` 内强制）
        if (writeBackGroup !== undefined) {
          await writeBackGroup(externalId, group);
          logger.info('动作写回下游（真实 provider）', { externalId, group });
          return;
        }
        if (!demo) {
          // ★ 真实模式 + 未配置渠道：**拒绝假装写回成功**（fail-closed）。
          //   静默写内存正是「演示实现被当作生产路径」的根因——它让失败看起来像成功。
          throw new Error(
            '渠道未配置（AG_NEWAPI_BASE_URL / AG_NEWAPI_PAT）——拒绝假装写回成功；请配置渠道，或显式以 demo 模式运行',
          );
        }
        downstreamGroups.set(externalId, group);
        logger.info('动作写回下游（演示实现）', { externalId, group });
      },
      // ★★ P0-2 接线：**写回前**记录「首次接管前的原值」——级联回退的 baseline。
      //   幂等由存储侧保证（仅当该动作键为空时写），故此处无条件调用；
      //   顺序由 `test/action-restore.test.ts` 锁定（写在写回之后就变成「接管后的值」）。
      rememberBaseline: async ({ userId, policyId, from }) => {
        const code = await policyCodeOf(policyId);
        if (code === undefined) return;
        await storage.lifecycle.rememberBaseline({
          siteId: DEMO_SITE,
          userId,
          policyCode: code,
          actionKey: 'newapi-set-group:set_group',
          value: from,
        });
      },
      now: () => new Date(),
    }),
  );

  // `checkin:grant` / `checkin:revoke`：写本地资格标记（docs/05 §3.2 的内置动作）。
  // ★ 演示策略声明了它，若这里不注册，运行时会判为「未注册的动作」而失败——
  //   这暴露了一个真实落差：策略的**静态校验**（knownActions）通过，
  //   不代表**运行时**真的有实现。两处清单必须一起维护。
  // ★★ 此前资格写的是**进程内 Map**（`grantedCheckins`）——重启后全部丢失、
  //   多实例下不一致；而 `ag_checkin_entitlements` 表**早已声明却零读写**。
  //   现改为经 `storage.checkins` 落库（内存模式仍是内存实现，真实模式落 PG）。
  const checkins = storage.checkins;
  actionRegistry.register('checkin:grant', {
    async execute(context) {
      const scope = String(context.params['scope'] ?? 'daily');
      const before = await checkins.find(context.siteId, context.userId, scope);
      await checkins.grant({
        siteId: context.siteId,
        userId: context.userId,
        scope,
        sourcePolicyId: context.policyId,
      });
      // ★ 已有效 → skipped（保持 docs/05 §3.5 修正七「全部 skipped ⇒ granted」的收敛语义）
      if (before !== undefined && before.revokedAt === undefined) {
        return { status: 'skipped', reason: 'no_change' };
      }
      return { status: 'succeeded' };
    },
    async verify(context) {
      const scope = String(context.params['scope'] ?? 'daily');
      const found = await checkins.find(context.siteId, context.userId, scope);
      const verified = found !== undefined && found.revokedAt === undefined;
      return { verified, actual: verified ? scope : null, expected: scope };
    },
  });
  actionRegistry.register('checkin:revoke', {
    async execute(context) {
      const scope = String(context.params['scope'] ?? 'daily');
      const before = await checkins.find(context.siteId, context.userId, scope);
      await checkins.revoke({ siteId: context.siteId, userId: context.userId, scope });
      if (before === undefined || before.revokedAt !== undefined) {
        return { status: 'skipped', reason: 'no_change' };
      }
      return { status: 'succeeded' };
    },
    async verify(context) {
      const scope = String(context.params['scope'] ?? 'daily');
      const found = await checkins.find(context.siteId, context.userId, scope);
      const verified = found === undefined || found.revokedAt !== undefined;
      return { verified, actual: verified ? null : scope, expected: null };
    },
  });

  // ★★★ P0-5（后半）：接入真实 newapi 管理动作。
  //   此前 `src/plugin/builtin/newapi-actions.ts` **零生产引用**——
  //   「签到发额度」所需的能力在服务里根本不存在，而策略静态校验却可以引用它。
  //   `manageActionsAvailable` 与 knownActions 共用同一判据，两处不会漂移。
  if (downstreamApi !== undefined) {
    actionRegistry.register('newapi-add-quota:add_quota', createAddQuotaAction({ api: downstreamApi }));
    actionRegistry.register('newapi-set-status:set_status', createSetStatusAction({ api: downstreamApi }));
    logger.info('已注册真实 newapi 管理动作', {
      actions: ['newapi-add-quota:add_quota', 'newapi-set-status:set_status'],
    });
  }

  /**
   * ★★★ P0-1b/P0-1c：签到服务（`docs/05 §5.2.1` 的三步写入顺序 + `docs/06 §4` 的三端点）。
   *
   * ★ 发额度**不经 `ActionExecutor`**：签到的幂等锚点是 `ag_checkin_records` 的
   *   `(siteId, userId, checkinDate)`，而不是 `ag_actions_log` 的 `actionSeq` 键——
   *   后者只在**状态迁移**时递增，策略稳定在 `granted` 时不变，会让第 2…N 天
   *   复用同一个键而被永久去重（**跨日持续少发**）。因此这里直接调用已注册的
   *   `add_quota` handler，并传入**含逻辑日**的幂等键。
   */
  const checkinService = new CheckinService({
    entitlements: storage.checkins,
    records: storage.checkinRecords,
    grantQuota: async ({ siteId, userId, amount, idempotencyKey }) => {
      const handler = actionRegistry.get('newapi-add-quota:add_quota');
      if (handler === undefined) {
        throw new Error('add_quota 动作未注册（渠道未配置）——签到发额度不可用');
      }
      const result = await handler.execute({
        siteId,
        userId,
        policyId: '', // ★ 签到不经策略：幂等锚点在 `ag_checkin_records`
        actionSeq: 0,
        idempotencyKey,
        params: { value: amount },
        attempt: 1,
      });
      if (result.status !== 'succeeded') {
        throw new Error(
          `add_quota 未成功：${result.status}${result.reason === undefined ? '' : `（${result.reason}）`}`,
        );
      }
      return {};
    },
    config: {
      requireScope: 'daily',
      timezone: process.env['AG_CHECKIN_TIMEZONE'] ?? 'Asia/Shanghai',
      reward: {
        min: 1000,
        max: 5000,
        cap: 20000,
        streakBonus: [
          { days: 7, multiplier: 1.5 },
          { days: 30, multiplier: 3 },
        ],
      },
    },
  });

  /**
   * ★★ P0-2 接线：级联回退（`docs/05 §3.5` 修正二的**四步算法**）。
   *
   * `restore` 要回答两个问题：
   *   ① 该主体**仍满足**的策略各要求哪一档？← 状态表（`listByUser`）× 策略定义（`requiredGroupOf`）
   *   ② 该策略**首次接管前的原值**是什么？← `ag_user_policy_state.baseline`
   */
  const restoreSource: RestoreSource = createRestoreSource({
    lifecycle: storage.lifecycle,
    listPolicies: async (siteId) =>
      (await policyStore.list(siteId)).filter((policy) => policy.enabled !== false),
    policyIdOfCode: async (code) => (db === undefined ? code : resolvePolicyId?.(code)),
    policyCodeOfId: policyCodeOf,
    actionKey: 'newapi-set-group:set_group',
  });

  actionRegistry.register(
    'newapi-set-group:restore',
    createRestoreGroupHandler({
      source: restoreSource,
      actionKey: 'newapi-set-group:set_group',
      externalIdOf: (context) => context.userId,
      currentGroup: async (externalId) => {
        const subject = await resolveProvider().getSubject(externalId);
        return subject === null ? null : String(subject.attributes['group'] ?? '');
      },
      setGroup: async (externalId, group) => {
        // 与 `set_group` 同一套写回策略（真实渠道 → 真实写回；真实模式未配置 → fail-closed）
        if (writeBackGroup !== undefined) {
          await writeBackGroup(externalId, group);
          logger.info('级联回退写回下游', { externalId, group });
          return;
        }
        if (!demo) {
          throw new Error(
            '渠道未配置（AG_NEWAPI_BASE_URL / AG_NEWAPI_PAT）——拒绝假装写回成功',
          );
        }
        downstreamGroups.set(externalId, group);
        logger.info('级联回退写回下游（演示实现）', { externalId, group });
      },
      onConflict: ({ userId, candidates }) => {
        // ★ 决胜失败必须**响亮**：这是「宁可不动，也不随机选」的落点
        logger.error('级联回退决胜冲突：拒绝执行，需人工裁决', { userId, candidates });
      },
    }),
  );

  const resolvePolicyRef = async (
    code: string,
    version: number,
  ): Promise<{ policyId: string; policyVersionId: string } | undefined> => {
    if (db === undefined) return undefined;
    const rows = await db.query<{ policy_id: string; id: string }>(
      `SELECT v.policy_id, v.id FROM ag_policy_versions v
         JOIN ag_policies p ON p.id = v.policy_id
        WHERE p.code = $1 AND v.version = $2 LIMIT 1`,
      [code, version],
    );
    const row = rows[0];
    return row === undefined ? undefined : { policyId: row.policy_id, policyVersionId: row.id };
  };

  const evaluations =
    db === undefined
      ? new InMemoryEvaluationStore()
      : new DbEvaluationStore(db, DEMO_SITE, resolvePolicyRef);

  const patrolService = new PatrolService({
    siteId: DEMO_SITE,
    // ★ 巡检间隔可配置（默认 5 分钟）。生产上运维可能需要调整频率；
    //   验证时也需要缩短它才能观察「巡检是否真的执行」。
    ...(process.env['AG_PATROL_INTERVAL_MS'] === undefined
      ? {}
      : { intervalMs: Number.parseInt(process.env['AG_PATROL_INTERVAL_MS'], 10) }),
    // ★ 动态取策略：发布即生效，无需重启
    policies: async () => (await policyStore.list(DEMO_SITE)).filter((policy) => policy.enabled !== false),
    directory: {
      async list(_siteId, limit, offset) {
        const stored = await storage.subjects.listExternalIds('newapi-provider');
        const slice = stored.slice(offset, offset + limit);
        const subjects = [];
        for (const externalId of slice) {
          const record = await storage.subjects.get('newapi-provider', externalId);
          if (record === undefined) continue;
          subjects.push({
            externalId,
            email: typeof record.email === 'string' ? record.email : null,
            emailVerified: true,
            attributes: record.attributes,
          });

        }
        return subjects;
      },
      async count() {
        return (await storage.subjects.listExternalIds('newapi-provider')).length;
      },
    },
    facts: storage.facts,
    factSources: [{ pluginId: 'email', fields: ['domain', 'is_edu', 'matched_rule', 'verified'], ttl: '30d' }],
    states: storage.lifecycle,
    evaluations,
    lifecycle: { gracePeriodMs: 72 * 3_600_000 },
    // 指标由 Patrol 统一打点（ActionExecutor 不持有指标集，避免两处口径不一致）
    executor: new ActionExecutor({
      registry: actionRegistry,
      log: storage.actionLog,
      logger,
      // ★★ 动作参数寻址（`docs/04 §1.2.7.3`）：绑定是**站点级**的（`ag_plugin_bindings`），
      //   而动作计划自带 `plan.siteId` —— 所以按站点构造解析器。
      //   ★ 不注入的后果不是"少个功能"，而是**含寻址的动作会失败**（有意如此：
      //     宁可失败并报原因，也不把寻址串当普通值交给下游 = 改错目标）。
      ...(db === undefined
        ? {}
        : { bindings: (siteId: string) => new DbPluginBindingStore(db, siteId) }),
    }),
    scheduler,
    logger,
    metrics,
    // 真实 PG 模式：巡检必须包事务（Db.query 有「必须在事务内」的断言）
    ...(db === undefined
      ? {}
      : {
          transaction: <T>(fn: () => Promise<T>): Promise<T> => db.transaction(async () => fn()),
        }),
  });

  // ★★ P1-3 接线：**策略版本清理**（`docs/05 §2.1.4` 第 3 条）。
  //   ★ 只在真实 PG 模式启用：内存模式没有「版本保留」这回事（重启即清零）。
  //   ★ 节奏 1h（文档 `cleanup.ttl`）——它比 30s 的调度轮询重得多，故在循环内**节流**。
  const versionPurgeDeps: VersionPurgeDeps | undefined =
    db === undefined
      ? undefined
      : {
          keep: DEFAULT_RETENTION.policyVersions,
          async listVersions() {
            return reuseOrBeginTransaction(db, async () => {
              const rows = await db.query<{ id: string; policy_id: string; version: number }>(
                'SELECT id, policy_id, version FROM ag_policy_versions',
                [],
              );
              return rows.map((row) => ({ id: row.id, policyId: row.policy_id, version: row.version }));
            });
          },
          async listProtectedVersionIds() {
            // ★ 语义见 `retention-cleaner.ts` 文件头：
            //   「被 granted/satisfied 引用的版本」= **这些策略的 `active_version_id`**
            //   （`ag_user_policy_state` 引用的是 policy_id，不是版本 id）
            return reuseOrBeginTransaction(db, async () => {
              const rows = await db.query<{ active_version_id: string }>(
                `SELECT p.active_version_id
                   FROM ag_policies p
                  WHERE p.active_version_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1 FROM ag_user_policy_state s
                       WHERE s.policy_id = p.id AND s.state IN ('granted','satisfied')
                    )`,
                [],
              );
              return new Set(rows.map((row) => row.active_version_id));
            });
          },
          async deleteVersions(ids) {
            await reuseOrBeginTransaction(db, async () => {
              await db.query('DELETE FROM ag_policy_versions WHERE id = ANY($1::uuid[])', [ids]);
            });
          },
        };
  let lastVersionPurgeAt = 0;

  // ★★ P1-4 接线：**密钥轮换**（`docs/05 §8.4.1` 的四步流程）。
  //   ★ 每次调度只问「下一步该做什么」；`wait` 由判定函数表达**截止时间**，
  //     而不是让某个函数 sleep 30 分钟（那样既不可测，进程重启后也无从恢复）。
  const rotationOptions: RotationOptions = {
    activeAlg: ASSERTION_ALG,
    // 下游 JWKS 缓存 TTL；等待窗口 = **TTL × 6**（文档默认 30 分钟）
    jwksCacheTtlMs: 5 * 60_000,
    // 旧公钥在 JWKS 中保留的最短时长（≥ token 最长有效期）
    retireAfterMs: 24 * 3_600_000,
    // 主动轮换周期（`oidc.signing.rotateEvery`）
    rotateEveryMs: 90 * 24 * 3_600_000,
  };
  let lastKeyRotationAt = 0;

  /**
   * ★★ 轮换的**审计**（`docs/05 §8.4.1`：「轮换是高危操作，应有操作记录」）。
   *
   * ★ 为什么不能只写日志：轮换直接影响**全站登录**（零 active 窗口 = 登录中断），
   *   而日志会被轮转、会随进程消失；审计表才是"谁在何时把哪把密钥变成了什么状态"的依据。
   */
  const auditKeyRotation = async (input: {
    action: string;
    kid: string | null;
    detail: unknown;
    at: Date;
  }): Promise<void> => {
    await storage.audit.record({
      siteId: DEMO_SITE,
      actorId: 'system',
      actorType: 'system',
      action: input.action,
      targetType: 'oidc_signing_key',
      targetId: input.kid ?? '-',
      after: { detail: input.detail, at: input.at.toISOString() },
    });
  };

  const runKeyRotationOnce = async (
    store: DbOidcSigningKeyStore,
    now: Date,
  ): Promise<{ action: string; detail: string }> => {
    const keys = await store.list();
    if (needsNewStandby({ keys, options: rotationOptions, now })) {
      await applyRotationStep({
        store,
        step: { action: 'publish_standby', alg: rotationOptions.activeAlg, reason: '轮换周期到期' },
        now,
        retireAfterMs: rotationOptions.retireAfterMs,
      });
      await auditKeyRotation({
        action: 'oidc.key_published',
        kid: null,
        detail: { reason: '轮换周期到期', alg: rotationOptions.activeAlg },
        at: now,
      });
      logger.info('已发布新的 standby 签名密钥（等待下游缓存过期后再切换）');
      return { action: 'publish_standby', detail: '已发布 standby（等待下游缓存过期后再切换）' };
    }
    const step = nextRotationStep({ keys, options: rotationOptions, now });
    // `none` / `wait` 无副作用——绝大多数轮询落在这里
    if (step.action === 'none' || step.action === 'wait') {
      return { action: step.action, detail: step.reason };
    }
    const result = await applyRotationStep({
      store,
      step,
      now,
      retireAfterMs: rotationOptions.retireAfterMs,
    });
    await auditKeyRotation({
      action:
        step.action === 'activate'
          ? 'oidc.key_activated'
          : step.action === 'retire'
            ? 'oidc.key_retired'
            : 'oidc.key_published',
      kid:
        step.action === 'activate'
          ? step.activeKid
          : step.action === 'retire'
            ? step.kid
            : null, // publish_standby：新 kid 在 applyRotationStep 内部生成，这里不猜
      detail: { step: step.action, detail: result.detail, reason: step.reason },
      at: now,
    });
    logger.info('密钥轮换动作已执行', { action: step.action, detail: result.detail });
    return { action: step.action, detail: result.detail };
  };

  // 调度循环：定期跑到期任务（单飞由调度器租约 + PatrolService 进程内互斥共同保证）
  let schedulerTimer: NodeJS.Timeout | undefined;
  if (config.mode !== 'demo' || process.env['AG_ENABLE_PATROL'] === '1') {
    await patrolService.start();
    schedulerTimer = setInterval(() => {
      void scheduler.runDue(new Date()).catch((error: unknown) => {
        logger.error('调度轮询失败', { error: error instanceof Error ? error.message : String(error) });
      });
      // ★★★★ R104（步骤 4）：**插件自动采集**——按开发者级实例解析主体并采集。
      //   ★ 与对账同一节奏；失败不影响调度循环。
      void runPluginCollection().catch((error: unknown) => {
        logger.debug('插件自动采集跳过/失败', { error: error instanceof Error ? error.message : String(error) });
      });
      // ★★★ R99：**渠道对账**（拉取渠道主体 → 与本地目录对齐 → 发事件）。
      //   ★ 失败**不影响调度循环**（与事件投递同样的容错姿态）：
      //     渠道未配置或上游不可达时，记日志并继续，而不是让整个调度停摆。
      void reconciler.reconcile().then(
        (outcome) => {
          if (outcome.scanned > 0 || outcome.created > 0 || outcome.changed > 0) {
            logger.info('渠道对账完成', {
              mode: outcome.mode,
              scanned: outcome.scanned,
              created: outcome.created,
              changed: outcome.changed,
              markedDeleted: outcome.markedDeleted,
            });
          }
        },
        (error: unknown) => {
          // ★ 未配置渠道时会走到这里（provider 显式抛错）——记 debug 而非 error，
          //   避免「未配置」这一**已知状态**淹没真正的故障。
          logger.debug('渠道对账跳过/失败', { error: error instanceof Error ? error.message : String(error) });
        },
      );
      // ★★★ R95：**投递到期事件**（发件箱 → 订阅者），与调度同一节奏。
      void outboxDispatcher.dispatchDue().then(
        (stats) => {
          if (stats.delivered > 0 || stats.dead > 0) {
            logger.info('事件投递完成', stats);
          }
        },
        (error: unknown) => {
          logger.error('事件投递失败', { error: error instanceof Error ? error.message : String(error) });
        },
      );
      // ★★ P1-3：**策略版本清理**（1h 节流，见上方 `versionPurgeDeps` 的说明）。
      //   ★ 被 granted/satisfied 的策略的 active 版本**永不清理**——
      //     否则状态表指向被删版本，永久授权无法复现、无法回滚。
      if (versionPurgeDeps !== undefined && Date.now() - lastVersionPurgeAt >= 3_600_000) {
        lastVersionPurgeAt = Date.now();
        void purgePolicyVersions(versionPurgeDeps).then(
          (report) => {
            if (report.purged.length > 0 || report.skippedProtected.length > 0) {
              logger.info('策略版本清理完成', {
                purged: report.purged.length,
                // ★ 这个数字长期 > 0 说明系统里有大量长期存活的授权（§2.1.4 关心的那类）
                skippedProtected: report.skippedProtected.length,
                remaining: report.remaining,
              });
            }
          },
          (error: unknown) => {
            logger.error('策略版本清理失败', {
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
      }
      // ★★ P1-4：**密钥轮换**（5 分钟节流）。`none`/`wait` 无副作用，因此节流只为省查询。
      if (signingKeyStore !== undefined && Date.now() - lastKeyRotationAt >= 300_000) {
        lastKeyRotationAt = Date.now();
        void runKeyRotationOnce(signingKeyStore, new Date()).catch((error: unknown) => {
          logger.error('密钥轮换失败', { error: error instanceof Error ? error.message : String(error) });
        });
      }
    }, 30_000);
    schedulerTimer.unref?.();
    logger.info('巡检调度已启动', { jobKey: patrolService.jobKey, pollIntervalMs: 30_000 });
  } else {
    logger.warn('演示模式默认不启动巡检（设 AG_ENABLE_PATROL=1 可启用）');
  }

  // ── 健康检查：区分 liveness 与 readiness ──
  const health = new HealthRegistry();
  health.register(eventLoopCheck());
  if (usePostgres && db !== undefined) {
    health.register(
      databaseCheck(async () => {
        await probe('SELECT 1');
      }),
    );
    health.register(
      migrationCheck({
        expected: '0001_init',
        // 同样走裸驱动：readiness 探测不在业务事务内
        current: async () => {
          const rows = await probe('SELECT name FROM ag_migrations ORDER BY name DESC LIMIT 1');
          return rows[0]?.name ?? null;
        },
      }),
    );
  }
  // ★ 用**真实巡检状态**：调度器在跑、且巡检未因连续失败而停摆
  health.register(
    schedulerCheck({
      started: () => patrolService.status().registered,
      stuckJobs: () => (patrolService.isStuck() ? 1 : 0),
    }),
  );

  const appRoutesWithOps = createAppRoutes({
    sessions,
    oidc,
    loginTransactions,
    csrfSecret,
    admin,
    eligibility: eligibilitySource,
    // ★ 用箭头包装而不是直接传 `checkinService`：本处 `createAppRoutes` 的装配
    //   早于 `checkinService` 的构造（后者依赖 `actionRegistry`），直接引用会触发 TDZ；
    //   而路由表只是**配置**，handler 在**请求时**才求值，因此惰性引用既安全又等价。
    checkin: {
      status: (input) => checkinService.status(input),
      checkin: (input) => checkinService.checkin(input),
      history: (input) => checkinService.history(input),
    },
    // ★★ L-1：邀请码核销（**共享实现**——两处路由装配必须行为一致）
    ...(inviteRedeemImpl === undefined ? {} : { inviteRedeem: inviteRedeemImpl }),
    defaultSiteId: DEMO_SITE,
    logger,
    version: '0.2.0-m0',
    health,
    metrics,
  });

  const app = createAppServer({
    sessions,
    routes: [portal, demoLogin, bootstrapRoute, ...appRoutesWithOps, ...consoleRoutes, ...verifyRoutes, ...oauthRoutes],
    csrfSecret,
    port,
    host,
    logger,
    metrics,
  });

  // ★★ P1-3 接线：**启动期不变量**（`docs/05 §2.1.4` · `docs/11 §13.1`）。
  //
  //   ★ 顺序遵循文档要求：**机制先落地**（保留期参数 + 清理选择，见 `src/core/retention.ts`，
  //     已单测），**此处才加校验**——否则校验的是不存在的参数，成为恒真/恒假的**假检查**。
  //   ★ 违规是**告警**而非拒绝启动：它是「运维风险」（出了事查不出来 / 回滚不了），
  //     不是「数据损坏」；拒绝启动会把一个本来可运行的实例变成不可用（自伤式加固）。
  {
    // ★ P1-2 接线：告警静默（`docs/05:225`）。
    //   ★ 为什么用内存实现可接受：静默是**短时**操作（上限 7 天），
    //     重启丢失的后果是「静默失效、告警重新出现」——**安全方向**（不会漏告警）。
    //     真实模式落库已登记为待办（不影响正确性，只影响重启后的体验）。
    const alertSilences = new AlertSilenceService({
      // ★★ P0-2：真实模式用**持久**存储（重启不再丢静默）。
      //   ★ 方向说明：内存实现"丢了静默"是**安全**的（告警重现，不会漏告警），
      //     但"我明明静默了，怎么又告警了"是一类**说不清**的运维现象——
      //     项目里其他平台级状态都落库了，这一项不该例外。
      store:
        settingsStore === undefined
          ? new InMemoryAlertSilenceStore()
          : new DbAlertSilenceStore(settingsStore),
      audit: storage.audit,
      siteId: DEMO_SITE,
    });

    const violations = checkStartupInvariants({
      settings: DEFAULT_RETENTION,
      // ★ 不变量 1（`事实 TTL ≥ 主体数 ÷ 外部 API 配额`）需要 provider 的**配额声明**，
      //   而当前 `provider.capabilities` 里没有配额字段 → **如实跳过**，
      //   不注入一个编造的配额去"通过"检查（那正是假检查的另一种形态）。
    });
    for (const violation of violations) {
      // ★ 经静默服务：被静默时**不打扰人，但仍写 `alert.raised` 审计**——
      //   否则事后无法回答「静默期间到底发生过没有」。
      const shouldNotify = await alertSilences.raise({
        code: violation.name,
        detail: violation.detail,
      });
      if (shouldNotify) {
        logger.warn('启动期不变量未满足', {
          invariant: violation.name,
          detail: violation.detail,
          suggestion: violation.suggestion,
        });
      }
    }
  }

  const { url } = await app.listen();
  logger.info('access-gate 已启动', { url, mode: demo ? 'demo' : 'real', site: DEMO_SITE });
  process.stdout.write(`\n  access-gate 已启动\n`);
  process.stdout.write(`  地址    : ${url}\n`);
  process.stdout.write(`  模式    : ${demo ? 'DEMO（内置假 IdP + 内存数据）' : 'REAL（真实 PG + 真实 OIDC）'}\n`);
  process.stdout.write(`  存储    : ${storage.mode === 'postgres' ? 'PostgreSQL' : '内存（重启即丢）'}\n`);
  process.stdout.write(`  健康检查: ${url}/healthz  · 就绪 ${url}/healthz/ready  · 存活 ${url}/healthz/live\n`);
  process.stdout.write(`  指标    : ${url}/metrics\n`);
  process.stdout.write(
    `  巡检    : ${patrolService.status().registered ? `已启动（任务 ${patrolService.jobKey}）` : '未启动（演示模式默认关闭）'}\n`,
  );
  if (demo) {
    process.stdout.write(`  演示登录: ${url}/api/auth/demo-login?email=alice@tsinghua.edu.cn\n`);
    process.stdout.write(`            ${url}/api/auth/demo-login?email=bob@gmail.com\n`);
    process.stdout.write(`            ${url}/api/auth/demo-login?email=admin@example.com&realm=developer  （管理员）\n`);
  }
  if (bootstrapToken !== undefined) {
    process.stdout.write(`\n  ★ 冷启动引导（一次性，用后即焚）：\n`);
    process.stdout.write(`     ${url}/api/auth/bootstrap?token=${bootstrapToken}\n`);
    process.stdout.write(`     在浏览器打开此链接即可获得管理员会话；该令牌不会再次显示。\n`);
  }
  process.stdout.write(`\n  按 Ctrl+C 退出\n\n`);

  // ── 优雅启停（M6-7）：顺序「先停流量 → 再释放资源」──
  const shutdown = new GracefulShutdown({ logger, totalTimeoutMs: 30_000 });
  shutdown.onStart(() => {
    // ★ 只影响 readiness：此刻进程还在处理在途请求，标记 liveness 失败会被 SIGKILL
    health.markNotReady();
  });
  shutdown.add({
    name: 'propagation-window',
    timeoutMs: 3_000,
    // 让负载均衡真正停止转发后再释放资源（否则会有 5xx 尖峰）
    run: () => waitMs(2_000),
  });
  shutdown.add({
    name: 'stop-patrol',
    // 先停巡检并**等在途一轮结束**：不打断，避免留下半迁移状态
    run: async () => {
      if (schedulerTimer !== undefined) clearInterval(schedulerTimer);
      await patrolService.stop();
      await scheduler.close();
    },
  });
  shutdown.add({ name: 'http-server', run: () => app.close() });
  if (storage.dispose !== undefined) {
    shutdown.add({ name: 'database-pool', run: () => storage.dispose!() });
  }
  shutdown.installSignalHandlers();
}

await main();
