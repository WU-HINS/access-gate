/**
 * 两条 OIDC 链路与准入策略（M7-3 / M7-4）—— docs/08 §3、§5.2、§5.3、§5.4。
 *
 * ```
 *   开发者链路  ref = platform:developer  →  **必须已入驻**（邀请码），realm = developer
 *   普通用户链路 ref = platform:enduser    →  首次**自动建号**，realm = enduser
 * ```
 *
 * ★ 隔离的关键不在「两个 ref 字符串不同」，而在于
 *   **identity 的 provider 命名空间必须不同**：
 *
 *   若两条链路共用 identity 命名空间，同一个 OIDC `sub` 就会指向**同一条 identity 记录**——
 *   于是一个「在普通用户链路登录过的 sub」可以直接通过开发者的准入检查
 *   （因为 identity 已存在），**绕过邀请码入驻**。这是权限提升漏洞，不是配置问题。
 *
 *   因此：
 *   - 开发者：`identity:oidc@platform:developer`
 *   - 普通用户：`identity:oidc@platform:enduser`
 *   同一 `sub` 在两个命名空间里是**两条独立记录**，互不相通。
 *
 * ★ 第二条关键设计：**准入策略是数据，不是 if-else 散落在回调里**。
 *   两条链路的差异（是否自动建号、是否要求邮箱验证、是否要求已入驻）
 *   集中在一张 `FLOW_POLICIES` 表里，回调只消费它——
 *   这样「新增一条链路」（如管理员链路）不需要改动回调逻辑。
 */

import type { Logger } from '../kernel/logger.ts';
import { randomUUID } from 'node:crypto';
import type { Developer, SiteRegistry } from '../core/sites.ts';
import { assertDeveloperMayLogin } from '../core/invitations.ts';
import { decideEmailAdmission, type EmailRuleStore } from '../core/email-rules.ts';
import { DEFAULT_STANDALONE_SLUG } from '../core/sites.ts';

// ─────────────────────────── 链路定义 ───────────────────────────

export type LoginRef = 'platform:developer' | 'platform:enduser';

/** identity provider 命名空间（★ 两条链路必须不同，否则是权限提升漏洞）。 */
export const IDENTITY_PROVIDER_OF: Record<LoginRef, string> = {
  'platform:developer': 'identity:oidc@platform:developer',
  'platform:enduser': 'identity:oidc@platform:enduser',
};

export interface FlowPolicy {
  /** 会话 realm（决定后续能访问哪个控制台） */
  realm: 'developer' | 'enduser';
  /** 未找到 identity 时是否自动建号 */
  autoProvision: boolean;
  /** 是否必须先通过邀请码入驻 */
  requiresOnboarding: boolean;
  /** 是否强制邮箱已验证（M7-8） */
  requiresVerifiedEmail: boolean;
  /** 自动建号时分配的开发者角色（仅 autoProvision 时有意义） */
  provisionRole?: 'developer' | 'admin';
}

/**
 * 链路策略表。
 *
 * | 链路 | autoProvision | requiresOnboarding | requiresVerifiedEmail |
 * |---|---|---|---|
 * | `platform:developer` | ❌ | ✅ | ✅ |
 * | `platform:enduser` | ✅ | ❌ | ❌（可配置为域名白名单，见 §5.3） |
 */
export const FLOW_POLICIES: Record<LoginRef, FlowPolicy> = {
  'platform:developer': {
    realm: 'developer',
    autoProvision: false,
    requiresOnboarding: true,
    requiresVerifiedEmail: true,
  },
  'platform:enduser': {
    realm: 'enduser',
    autoProvision: true,
    requiresOnboarding: false,
    // 普通用户不强制邮箱验证（否则会挡住大量正常用户）；
    // 需要收紧时改用「域名白名单」而不是「强制验证」
    requiresVerifiedEmail: false,
    provisionRole: 'developer',
  },
};

export function isLoginRef(value: string): value is LoginRef {
  return value === 'platform:developer' || value === 'platform:enduser';
}

// ─────────────────────────── 类型 ───────────────────────────

/** 平台用户账号（与 developer 分开：普通用户不是 developer）。 */
export interface EndUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  status: 'active' | 'suspended';
}

export interface EndUserStore {
  findByIdentity(provider: string, providerUserId: string): Promise<string | undefined>;
  create(input: { provider: string; providerUserId: string; username: string; displayName: string; email: string; emailVerified: boolean }): Promise<EndUser>;
  find(id: string): Promise<EndUser | undefined>;
}

export class InMemoryEndUserStore implements EndUserStore {
  private readonly users = new Map<string, EndUser>();
  private readonly byIdentity = new Map<string, string>();
  private seq = 0;

  async findByIdentity(provider: string, providerUserId: string): Promise<string | undefined> {
    return this.byIdentity.get(`${provider}\u0000${providerUserId}`);
  }

  async create(input: {
    provider: string;
    providerUserId: string;
    username: string;
    displayName: string;
    email: string;
    emailVerified: boolean;
  }): Promise<EndUser> {
    const user: EndUser = {
      // ★ 同上：PG 的 `ag_users.id` 是 uuid（`ag_endusers` 若存在亦然）
      id: randomUUID(),
      username: input.username,
      displayName: input.displayName,
      email: input.email,
      emailVerified: input.emailVerified,
      status: 'active',
    };
    this.users.set(user.id, user);
    this.byIdentity.set(`${input.provider}\u0000${input.providerUserId}`, user.id);
    return { ...user };
  }

  async find(id: string): Promise<EndUser | undefined> {
    const found = this.users.get(id);
    return found === undefined ? undefined : { ...found };
  }
}

/** 开发者身份查找（复用 invitations.ts 的 `DeveloperLookup` 语义）。 */
export interface DeveloperIdentityLookup {
  findByIdentity(provider: string, providerUserId: string): Promise<string | undefined>;
}

// ─────────────────────────── 登录结果 ───────────────────────────

export type LoginOutcome =
  | {
      ok: true;
      realm: 'developer' | 'enduser';
      /** 平台用户 id（开发者链路上是 developer.id） */
      principalId: string;
      /** 本次是否新建账号 */
      provisioned: boolean;
      email: string;
      /** 开发者链路才有 */
      developer?: Developer;
      /** 普通用户链路才有 */
      endUser?: EndUser;
    }
  | { ok: false; reason: 'not_onboarded' | 'suspended' | 'email_unverified' | 'unknown_ref' | 'email_not_admitted'; message: string };

export interface ResolveLoginInput {
  ref: string;
  oidcSubject: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  username?: string;
  /**
   * ⚠️ 测试/危险开关：`platform:enduser` 链路的**域名白名单**。
   * 提供后，不在白名单的邮箱会被拒绝（`docs/08 §5.3` 的「可配置为需邀请/域名白名单」）。
   */
  allowedEmailDomains?: readonly string[];
}

export interface LoginDeps {
  developerIdentities: DeveloperIdentityLookup;
  endUsers: EndUserStore;
  sites: SiteRegistry;
  /**
   * ★★ **站点级邮箱准入闸门**（`ag_email_rules`）——在建号**之前**生效。
   *
   * ★ 为什么它不能由插件的 `allowDomains` 代替：那是**采集事实**（"这邮箱属于哪个域"），
   *   而这是**注册准入**（"这邮箱能不能注册"）——用采集事实做准入 = **先建号、再判定**，
   *   不该进来的人已经进来了（见 `src/core/email-rules.ts` 文件头）。
   * ★ 未注入 = 不启用闸门（与"没有配置任何规则"的语义一致 → 默认允许）。
   * ★★ **何时该注入它**（按"统一登录 + 站点自选"的设计核实后修正）：
   *   登录是**平台级统一**的，而 `ag_email_rules` 是**站点级**表——登录后会话的
   *   `activeSiteId` 是 `null`，站点由用户**自选**或**传参**指定。因此：
   *   · **通常不注入**（`tools/serve.ts` 即如此）——准入由 `POST /api/me/site` 的
   *     **站点准入闸门**在**目标站点**上校验（那才是权威检查点）；
   *   · 只有在调用方**已经知道目标站点**时才注入（例如将来支持"带站点参数登录"）。
   *   ★ 在登录时用某个默认站点的规则去判，是**错的站点**——
   *     它会让"用户选站点 B"这条路径**从未按 B 的规则校验过**。
   */
  emailRules?: EmailRuleStore;
  logger?: Logger;
}

/**
 * 解析一次 OIDC 登录（两条链路共用入口，行为由 `FLOW_POLICIES` 决定）。
 *
 * ★ 顺序刻意安排：**先看 ref 合法性 → 再查 identity → 最后按策略决定准入**。
 *   注意两条链路查的是**不同的 provider 命名空间**（见文件头说明）。
 */
export async function resolveLogin(input: ResolveLoginInput, deps: LoginDeps): Promise<LoginOutcome> {
  if (!isLoginRef(input.ref)) {
    return { ok: false, reason: 'unknown_ref', message: `未知的登录链路 '${input.ref}'（可用：platform:developer / platform:enduser）` };
  }
  const ref: LoginRef = input.ref;
  const policy = FLOW_POLICIES[ref];
  const provider = IDENTITY_PROVIDER_OF[ref];
  const email = input.email.trim().toLowerCase();

  // ★★ **邮箱准入闸门**（`ag_email_rules`）——在**建号之前**判定。
  //   ★ 未注入 `emailRules` = 不启用闸门（等价于"没配置任何规则" → 默认允许）。
  //   ★ 用**规范化后的 email**（小写去空格），与规则的匹配语义一致。
  //   ★ 判定失败 → 明确原因（"命中了拒绝规则" vs "未命中白名单"），
  //     而不是笼统的"邮箱无效"——两者的处置不同。
  if (deps.emailRules !== undefined) {
    const admission = decideEmailAdmission(await deps.emailRules.list(), email);
    if (!admission.allowed) {
      return {
        ok: false,
        reason: 'email_not_admitted',
        message: `该邮箱不被允许注册：${admission.reason}`,
      };
    }
  }

  // ── 开发者链路（M7-3）──
  if (policy.requiresOnboarding) {
    // 强制邮箱绑定（M7-8）
    if (policy.requiresVerifiedEmail && !input.emailVerified) {
      return { ok: false, reason: 'email_unverified', message: '开发者登录要求邮箱已验证（强制邮箱绑定）' };
    }
    const admission = await assertDeveloperMayLogin(deps.developerIdentities, deps.sites, { oidcSubject: input.oidcSubject });
    if (!admission.ok) {
      return { ok: false, reason: admission.reason, message: admission.message };
    }
    return {
      ok: true,
      realm: 'developer',
      principalId: admission.developer.id,
      provisioned: false,
      email: admission.developer.email,
      developer: admission.developer,
    };
  }

  // ── 普通用户链路（M7-4）──
  // 域名白名单（可选收紧）
  if (input.allowedEmailDomains !== undefined && input.allowedEmailDomains.length > 0) {
    const domain = email.split('@')[1] ?? '';
    const allowed = input.allowedEmailDomains.some((pattern) =>
      pattern.startsWith('*.') ? domain.endsWith(pattern.slice(1)) || domain === pattern.slice(2) : domain === pattern,
    );
    if (!allowed) {
      return { ok: false, reason: 'not_onboarded', message: `邮箱域名 '${domain}' 不在允许列表中（本渠道要求域名白名单）` };
    }
  }

  const existingId = await deps.endUsers.findByIdentity(provider, input.oidcSubject);
  if (existingId !== undefined) {
    const user = await deps.endUsers.find(existingId);
    if (user === undefined) {
      // identity 指向不存在的账号：数据不一致，按未入驻处理（不静默建号）
      return { ok: false, reason: 'not_onboarded', message: '该身份关联的账号不存在（数据不一致），请联系管理员' };
    }
    if (user.status !== 'active') {
      return { ok: false, reason: 'suspended', message: '账号已停用，请联系管理员' };
    }
    return { ok: true, realm: 'enduser', principalId: user.id, provisioned: false, email: user.email, endUser: user };
  }

  // 首次登录 → 自动建号（§5.3）
  if (!policy.autoProvision) {
    return { ok: false, reason: 'not_onboarded', message: '此身份尚未入驻，请使用管理员发放的邀请码完成入驻。' };
  }
  const derived = email.split('@')[0]!.replace(/[^a-zA-Z0-9_-]/g, '');
  const user = await deps.endUsers.create({
    provider,
    providerUserId: input.oidcSubject,
    username: input.username ?? (derived.length > 0 ? derived : `user${Date.now()}`),
    displayName: input.displayName ?? derived ?? email,
    email,
    emailVerified: input.emailVerified,
  });
  deps.logger?.info('普通用户首次登录，已自动建号', { userId: user.id, email, ref });
  return { ok: true, realm: 'enduser', principalId: user.id, provisioned: true, email: user.email, endUser: user };
}

// ─────────────────────────── 隔离性自检 ───────────────────────────

/**
 * 断言两条链路**确实隔离**。
 *
 * ★ 做成可执行的断言而不是文档约定：
 *   若将来有人「顺手」把两个 ref 的 provider 改成同一个，
 *   这里会立刻失败——而运行时表现是「普通用户能绕过邀请码入驻」这种权限提升，
 *   靠人工 review 很容易漏掉。
 */
export function assertFlowsIsolated(): void {
  const seen = new Map<string, LoginRef>();
  for (const [ref, provider] of Object.entries(IDENTITY_PROVIDER_OF) as [LoginRef, string][]) {
    const existing = seen.get(provider);
    if (existing !== undefined) {
      throw new Error(
        `★ 两条登录链路共用了 identity 命名空间 '${provider}'（${existing} 与 ${ref}）——` +
          `这会让同一 OIDC sub 在两个链路间相通，普通用户可绕过邀请码入驻（权限提升漏洞）。`,
      );
    }
    seen.set(provider, ref);
  }
}

/** 单站点部署时普通用户进入哪个站点（与 standalone 兜底一致）。 */
export const DEFAULT_ENDUSER_SITE = DEFAULT_STANDALONE_SLUG;
