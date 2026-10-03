/**
 * 存储装配（生产就绪判据 #2 的收口点）—— 把「用内存还是用真实 PG」变成一个开关。
 *
 * ★ 为什么需要这一层：
 *   在此之前，`tools/serve.ts` 只有内存实现，而 `src/db/adapters.ts` 里的 PG 适配器
 *   只在测试里被调用过。**「测试里能跑」与「服务起来能用」是两件事**——
 *   本项目的教训（docs/HANDOFF.md §6.2）正是「声称已修但没落地」。
 *   这一层让两者共用同一条装配路径，并用 `assertProductionReady()` 拒绝半套配置。
 *
 * ★ 三种模式（由 `AG_MODE` 决定）：
 *   | 模式 | 存储 | OIDC | 用途 |
 *   |---|---|---|---|
 *   | `demo` | 内存 | 内置假 IdP | 演示 / 本地开发 |
 *   | `real` | **真实 PG** | **真实 OIDC** | 生产 |
 *   | 缺省 | 内存 | 真实 OIDC（若配置） | 过渡 |
 *
 * ★ 生产模式的硬性要求（`assertProductionReady`）：缺任一项即**启动失败**，不降级。
 *   理由：一个「以为在用 PG 其实在用内存」的生产实例，会在重启时静默丢掉所有会话与幂等记录——
 *   后者会导致**重复写下游**。这类静默降级比启动失败危险得多。
 */

import type { Db } from '../db/pool.ts';
import {
  DbActionLogStore,
  DbAuditSink,
  DbFactStore,
  DbIdentityStore,
  DbJobStore,
  DbLifecycleStateStore,
  DbPolicyStore,
  DbSessionStore,
  DbSubjectRepository,
} from '../db/adapters.ts';
import { InMemorySessionStore, SessionService, type SessionStore } from '../auth/session.ts';
import { InMemoryIdentityStore, type IdentityStore } from '../core/identity.ts';
import { InMemoryLifecycleStateStore } from '../core/patrol.ts';
import type { LifecycleStateStore } from '../core/lifecycle-store-type.ts';
import { InMemoryActionLogStore, type ActionLogStore } from '../core/action-executor.ts';
import { InMemoryJobStore, type JobStore } from '../kernel/scheduler.ts';
import { InMemoryFactStore, type FactStore } from '../plugin/host-api.ts';
import { InMemorySubjectStore, type SubjectStore } from '../plugin/subjects.ts';
import { InMemoryPolicyStore, InMemoryAuditSink, type AuditSink, type PolicyStore } from '../admin/api.ts';
import {
  InMemoryCheckinEntitlementStore,
  InMemoryCheckinRecordStore,
  type CheckinEntitlementStore,
  type CheckinRecordStore,
} from '../core/checkin.ts';
import {
  createTransactionalCheckinEntitlementStore,
  createTransactionalCheckinRecordStore,
} from '../db/checkin-adapter.ts';

export type StorageMode = 'memory' | 'postgres';

export interface StorageBundle {
  mode: StorageMode;
  sessions: SessionStore;
  identities: IdentityStore;
  lifecycle: LifecycleStateStore;
  actionLog: ActionLogStore;
  jobs: JobStore;
  facts: FactStore;
  subjects: SubjectStore;
  policies: PolicyStore;
  audit: AuditSink;
  /** 签到资格（`ag_checkin_entitlements`）—— 此前是进程内 Map，重启即丢 */
  checkins: CheckinEntitlementStore;
  /** 签到记录（`ag_checkin_records`）—— **发额度的幂等锚点**（`docs/05 §5.2.1`） */
  checkinRecords: CheckinRecordStore;
  /** 真实 PG 模式下用于关闭连接池 */
  dispose?: () => Promise<void>;
}

export interface StorageOptions {
  mode: StorageMode;
  siteId: string;
  /** 真实 PG 模式必需 */
  db?: Db;
  /** 策略 code → `ag_policies.id`（生命周期状态表的外键是 uuid，见 DbLifecycleStateStore 的说明） */
  resolvePolicyId?: (code: string) => Promise<string | undefined>;
}

export class StorageConfigError extends Error {
  override readonly name = 'StorageConfigError';
}

/**
 * 按模式装配存储。
 *
 * ★ 真实 PG 模式缺 `db` / `resolvePolicyId` 时**抛错**，不静默回落到内存。
 */
export function createStorage(options: StorageOptions): StorageBundle {
  if (options.mode === 'memory') {
    return {
      mode: 'memory',
      sessions: new InMemorySessionStore(),
      identities: new InMemoryIdentityStore(),
      lifecycle: new InMemoryLifecycleStateStore(),
      actionLog: new InMemoryActionLogStore(),
      jobs: new InMemoryJobStore(),
      facts: new InMemoryFactStore(),
      subjects: new InMemorySubjectStore(),
      policies: new InMemoryPolicyStore(),
      audit: new InMemoryAuditSink(),
      checkins: new InMemoryCheckinEntitlementStore(),
      checkinRecords: new InMemoryCheckinRecordStore(),
    };
  }

  const { db, siteId, resolvePolicyId } = options;
  if (db === undefined) {
    throw new StorageConfigError('storage mode=postgres 但未提供 db 连接（AG_DATABASE_URL 是否配置？）');
  }
  if (resolvePolicyId === undefined) {
    throw new StorageConfigError(
      'storage mode=postgres 但未提供 resolvePolicyId：' +
        'ag_user_policy_state.policy_id 是 uuid，而生命周期按策略 code 键——缺了它状态无法落库。',
    );
  }

  return {
    mode: 'postgres',
    sessions: new DbSessionStore(db),
    identities: new DbIdentityStore(db),
    lifecycle: new DbLifecycleStateStore(db, siteId, resolvePolicyId),
    actionLog: new DbActionLogStore(db, siteId),
    jobs: new DbJobStore(db, siteId),
    facts: new DbFactStore(db, siteId),
    subjects: new DbSubjectRepository(db, siteId),
    policies: new DbPolicyStore(db, siteId),
    audit: new DbAuditSink(db, siteId),
    checkins: createTransactionalCheckinEntitlementStore(db, siteId),
    checkinRecords: createTransactionalCheckinRecordStore(db, siteId),
    dispose: async () => {
      await db.close();
    },
  };
}

// ─────────────────────────── 生产就绪断言 ───────────────────────────

export interface ProductionConfig {
  mode: 'demo' | 'real' | 'auto';
  databaseUrl?: string;
  oidc?: { issuer: string; clientId: string; clientSecret?: string; redirectUri: string };
  publicUrl?: string;
  /** 是否允许 demo 模式（生产必须 false） */
  allowDemo?: boolean;
  /** Cookie 是否加 Secure（生产必须 true） */
  secureCookies?: boolean;
}

export interface ConfigIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * 生产配置自查。
 *
 * ★ 为什么把「配置检查」做成可返回列表的纯函数：
 *   启动失败时的报错信息质量，直接决定运维能否在 5 分钟内定位问题。
 *   一次性列出**全部**缺项，比「修一个报一个」高效得多。
 */
export function checkProductionConfig(config: ProductionConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const error = (field: string, message: string): void => void issues.push({ field, message, severity: 'error' });
  const warn = (field: string, message: string): void => void issues.push({ field, message, severity: 'warning' });

  if (config.mode === 'demo') {
    if (config.allowDemo !== true) {
      error('AG_MODE', 'mode=demo 但未显式设置 AG_ALLOW_DEMO=1——生产环境不允许 demo 模式（内置假 IdP 不做验签）');
    } else {
      warn('AG_MODE', 'demo 模式：内置假 IdP **不做验签**，仅用于演示与本地开发');
    }
    return issues;
  }

  // real / auto 模式
  if (config.databaseUrl === undefined || config.databaseUrl.length === 0) {
    error('AG_DATABASE_URL', '未配置数据库连接串。生产不允许使用内存存储（重启会丢失会话与**幂等记录**，导致重复写下游）');
  } else if (!/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    error('AG_DATABASE_URL', `连接串必须以 postgres:// 或 postgresql:// 开头（实际：${config.databaseUrl.slice(0, 24)}…）`);
  }

  if (config.oidc === undefined) {
    error('AG_OIDC_*', '未配置 OIDC（issuer / clientId / redirectUri）');
  } else {
    if (config.oidc.issuer.length === 0) error('AG_OIDC_ISSUER', 'issuer 不能为空');
    if (config.oidc.clientId.length === 0) error('AG_OIDC_CLIENT_ID', 'clientId 不能为空');
    if (config.oidc.redirectUri.length === 0) error('AG_OIDC_REDIRECT_URI', 'redirectUri 不能为空');
    if (!/^https:\/\//.test(config.oidc.issuer) && !/^http:\/\/localhost/.test(config.oidc.issuer)) {
      error('AG_OIDC_ISSUER', 'issuer 必须是 https（或 localhost 用于本地开发）');
    }
    if (!/^https:\/\//.test(config.oidc.redirectUri) && !/^http:\/\/localhost/.test(config.oidc.redirectUri)) {
      warn('AG_OIDC_REDIRECT_URI', 'redirectUri 不是 https——生产应经 TLS');
    }
  }

  if (config.secureCookies !== true) {
    error('AG_SECURE_COOKIES', '生产必须启用 Secure Cookie（否则会话可能在明文连接上被截获）');
  }
  if (config.publicUrl === undefined || config.publicUrl.length === 0) {
    warn('AG_PUBLIC_URL', '未配置对外地址：生成回调 URL 与邮件链接时会缺省，建议显式设置');
  }
  return issues;
}

export class ProductionConfigError extends Error {
  override readonly name = 'ProductionConfigError';
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(
      `生产配置未通过自查（${issues.filter((i) => i.severity === 'error').length} 个错误）：\\n` +
        issues.map((i) => `  - [${i.severity}] ${i.field}: ${i.message}`).join('\\n'),
    );
    this.issues = issues;
  }
}

/** 有 error 即抛错（启动期 fail-fast）。 */
export function assertProductionReady(config: ProductionConfig): ConfigIssue[] {
  const issues = checkProductionConfig(config);
  if (issues.some((i) => i.severity === 'error')) throw new ProductionConfigError(issues);
  return issues;
}

// ─────────────────────────── 从环境变量读取 ───────────────────────────

export function productionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProductionConfig {
  const mode = (env['AG_MODE'] ?? 'auto') as ProductionConfig['mode'];
  const oidcIssuer = env['AG_OIDC_ISSUER'];
  const oidcClientId = env['AG_OIDC_CLIENT_ID'];
  const publicUrl = env['AG_PUBLIC_URL'];
  const redirectUri = env['AG_OIDC_REDIRECT_URI'] ?? (publicUrl === undefined ? undefined : `${publicUrl.replace(/\/+$/, '')}/api/auth/callback`);

  const config: ProductionConfig = {
    mode,
    allowDemo: env['AG_ALLOW_DEMO'] === '1',
    secureCookies: env['AG_SECURE_COOKIES'] === '1',
  };
  if (env['AG_DATABASE_URL'] !== undefined) config.databaseUrl = env['AG_DATABASE_URL'];
  if (publicUrl !== undefined) config.publicUrl = publicUrl;
  if (oidcIssuer !== undefined && oidcClientId !== undefined && redirectUri !== undefined) {
    config.oidc = {
      issuer: oidcIssuer,
      clientId: oidcClientId,
      redirectUri,
      ...(env['AG_OIDC_CLIENT_SECRET'] === undefined ? {} : { clientSecret: env['AG_OIDC_CLIENT_SECRET'] }),
    };
  }
  return config;
}

/** 会话服务工厂：让「会话有效期 / 节流」等参数集中在一处。 */
export function createSessionService(store: SessionStore, options: { ttlMs?: number } = {}): SessionService {
  return new SessionService({ store, ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }) });
}
