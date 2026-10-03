/**
 * 开发者入驻：邀请码 + 强制邮箱绑定（M7-2 / M7-8）—— docs/08 §5.1、§5.2。
 *
 * ```
 *   ① admin 生成邀请码 { targetEmail, ttl ≤1h, uses, siteMode }
 *   ② 开发者打开 /console/join?code=DEV-7F3A-K92M
 *   ③ 校验：存在 · 未过期 · 未用尽 · **邮箱匹配**
 *   ④ 跳转【开发者 OIDC】授权
 *   ⑤ 回调 → 写 ag_identities
 *   ⑥ 【强制绑定邮箱】必须验证通过
 *   ⑦ 创建 developer 账号；按 siteMode 建/加入站点
 *   ⑧ 邀请码**原子核销**（UPDATE … WHERE used_at IS NULL）
 * ```
 *
 * ★ 四件必须做对的事（每一条都对应一种真实的滥用/故障）：
 *
 * 1. **只存 `code_hash`，不存明文**（表结构即如此：`code_hash` + `code_prefix`）。
 *    邀请码等价于「一次性开户凭据」，明文入库意味着**任何能读库的人都能开户**。
 *    `code_prefix` 仅用于管理员在界面上辨认（"哪个码"），不足以还原明文。
 *
 * 2. **原子核销**（第 ⑧ 步必须在创建账号**之前**且**原子**）：
 *    若「先查未用 → 再创建账号 → 再标记已用」，两个并发请求会**同时通过检查**，
 *    建出两个开发者账号。核销必须是 `UPDATE … WHERE used_at IS NULL AND …` + 检查影响行数。
 *
 * 3. **邮箱匹配**：邀请码绑定 `targetEmail`，防止「邀请链接被转发到群里被人抢注」。
 *
 * 4. **TTL 上限硬编码为 1 小时**：不是"建议"，而是**服务端强制**——
 *    客户端传 `ttl: 30d` 会被夹到 1h。邀请码的有效期是安全参数，不能由请求方决定。
 *
 * ★ `siteMode` 的语义（结合真实表结构）：表里没有单独的「目标站点」列，
 *   因此 `site_mode='existing'` 解释为「加入**签发该邀请码的站点**」（`site_id` 作用域列），
 *   这对「一个站点邀请一个开发者来协助」是最自然的语义。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Logger } from '../kernel/logger.ts';
import type { Developer, Site, SiteRegistry } from './sites.ts';

// ─────────────────────────── 常量 ───────────────────────────

/**
 * 邀请码 TTL 上限：**1 小时**（docs/08 §5.1）。
 *
 * ★ 这是服务端**硬夹**，不是建议值：邀请码是安全参数，
 *   不能让请求方传 `30d` 就生效。
 */
export const INVITATION_TTL_MAX_MS = 60 * 60_000;
export const INVITATION_TTL_DEFAULT_MS = 60 * 60_000;

/** 邀请码字符集：排除易混的 `0/O/1/I/L`（管理员需要口头/截图传递它）。 */
export const INVITATION_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type SiteMode = 'auto' | 'existing';

// ─────────────────────────── 类型 ───────────────────────────

export interface Invitation {
  id: string;
  /** 作用域站点（也是 `siteMode='existing'` 时要加入的站点） */
  siteId: string;
  /** 明文码的 sha256（**不存明文**） */
  codeHash: string;
  /** 明文前 8 位（仅用于管理员辨认） */
  codePrefix: string;
  targetEmail: string;
  siteMode: SiteMode;
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
  usedAt: Date | null;
  usedBy: string | null;
  createdBy: string;
  createdAt: Date;
}

export interface InvitationStore {
  save(invitation: Invitation): Promise<void>;
  findByHash(siteId: string, codeHash: string): Promise<Invitation | undefined>;
  /**
   * **原子核销**：仅当「未过期 且 未用尽」时占用一次使用额度。
   *
   * ★ 必须是原子的（PG 实现用单条 `UPDATE … WHERE …` + 影响行数判断）。
   *   返回 `false` 表示「条件不满足或已被并发抢占」——两者对调用方等价：
   *   **不能继续创建账号**。
   */
  consume(siteId: string, codeHash: string, usedBy: string, now: Date): Promise<boolean>;
  list(siteId: string): Promise<Invitation[]>;
}

export class InvitationError extends Error {
  override readonly name = 'InvitationError';
  readonly code:
    | 'not_found'
    | 'expired'
    | 'exhausted'
    | 'email_mismatch'
    | 'email_not_verified'
    | 'ttl_too_long'
    | 'already_registered'
    | 'invalid_code';
  constructor(code: InvitationError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// ─────────────────────────── 码的生成与哈希 ───────────────────────────

/** 生成邀请码（`DEV-XXXX-XXXX`，分组便于朗读与截图）。 */
export function generateInvitationCode(): string {
  const groups = [4, 4];
  const pick = (length: number): string =>
    Array.from({ length }, () => INVITATION_ALPHABET[Math.floor(Math.random() * INVITATION_ALPHABET.length)]!).join('');
  return `DEV-${groups.map(pick).join('-')}`;
}

/**
 * 归一化用户输入的邀请码：去空格、转大写、把易混字符映射回字符集。
 *
 * 与设备码流（M5-2）同样的理由：用户看到 `B` 可能输 `8`，
 * 直接拒绝会让他们反复失败；映射有唯一解（目标字符不在集合里）。
 */
export function normalizeInvitationCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    // ★ 去掉**所有**非字母数字字符：用户抄写邀请码时格式千变万化
    //   （`DEV-7F3A-K92M` / `DEV 7F3A K92M` / `dev7f3ak92m` 都指同一个码）。
    //   早期只去掉空格，于是 `DEV 7F3A-K92M` 里残留的连字符导致匹配失败。
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** 计算码的哈希（**只此一处**，保证「存」与「查」用同一算法）。 */
export function hashInvitationCode(code: string): string {
  return createHash('sha256').update(normalizeInvitationCode(code), 'utf8').digest('hex');
}

/** 常量时间比较（防止通过响应时间差异逐字符猜测邀请码）。 */
export function constantTimeCodeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryInvitationStore implements InvitationStore {
  private readonly invitations = new Map<string, Invitation>();
  #key(siteId: string, codeHash: string): string {
    return `${siteId}\u0000${codeHash}`;
  }
  async save(invitation: Invitation): Promise<void> {
    this.invitations.set(this.#key(invitation.siteId, invitation.codeHash), { ...invitation });
  }
  async findByHash(siteId: string, codeHash: string): Promise<Invitation | undefined> {
    const found = this.invitations.get(this.#key(siteId, codeHash));
    return found === undefined ? undefined : { ...found };
  }
  async consume(siteId: string, codeHash: string, usedBy: string, now: Date): Promise<boolean> {
    // ★ 内存实现「原子」是天然的（同一 tick 内检查与修改之间没有 await）
    const key = this.#key(siteId, codeHash);
    const found = this.invitations.get(key);
    if (found === undefined) return false;
    if (found.expiresAt.getTime() <= now.getTime()) return false;
    if (found.usedCount >= found.maxUses) return false;
    this.invitations.set(key, { ...found, usedCount: found.usedCount + 1, usedAt: now, usedBy });
    return true;
  }
  async list(siteId: string): Promise<Invitation[]> {
    return [...this.invitations.values()]
      .filter((invitation) => invitation.siteId === siteId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((invitation) => ({ ...invitation }));
  }
}

// ─────────────────────────── 服务 ───────────────────────────

export interface InvitationServiceOptions {
  store: InvitationStore;
  /** 创建账号与站点用 */
  sites: SiteRegistry;
  /**
   * ★★★ 入驻成功后**写入开发者身份映射**（`ag_identities`）。
   *
   * ★★★ 为什么它是**必需**的（R91 的缺环修复）：
   *   此前 `redeem()` 创建了开发者账号，但**没有**写 `ag_identities`——
   *   而登录准入（`assertDeveloperMayLogin`）查的正是那张表。
   *   于是**入驻成功也永远登录不了**（除非手工插库）。
   *
   * ★ 为什么放在**这里**而不是让端点自己调：
   *   把它设为 `redeem()` 的**内部步骤**，调用方**无法忘记**——
   *   ★ 此前正是「依赖调用方记得调」导致了缺环（`recordDeveloperIdentity` 无任何调用点）。
   *   ★ 这是本会话反复出现的教训：**必须做的步骤要放进被调函数里，不要依赖调用方纪律**。
   */
  onboardIdentity: (input: {
    developerId: string;
    oidcSubject: string;
    /** ★ R101（方案 A）：建立「开发者 ↔ 平台用户」映射需要这些信息 */
    username: string;
    email: string;
    emailVerified: boolean;
  }) => Promise<void>;
  logger?: Logger;
  now?: () => Date;
}

export interface CreateInvitationInput {
  /** 作用域站点（也是 `siteMode='existing'` 时加入的站点） */
  siteId: string;
  targetEmail: string;
  ttlMs?: number;
  uses?: number;
  siteMode?: SiteMode;
  createdBy: string;
}

/** 创建邀请码的结果：**明文码只在此返回一次** */
export interface CreatedInvitation {
  code: string;
  codePrefix: string;
  expiresAt: Date;
  targetEmail: string;
  siteMode: SiteMode;
  maxUses: number;
}

export interface RedeemInput {
  siteId: string;
  /** 用户输入的邀请码（可含空格/小写/易混字符） */
  code: string;
  /** OIDC 回调带回的邮箱 */
  email: string;
  /** 邮箱是否已验证（**强制**：未验证不得入驻） */
  emailVerified: boolean;
  /** OIDC subject（写入 ag_identities 用） */
  oidcSubject: string;
  /** 开发者用户名（缺省由邮箱推导） */
  username?: string;
  displayName?: string;
}

export interface RedeemResult {
  developer: Developer;
  site: Site;
  /** 本次是否新建了站点（siteMode=auto 且默认站点不存在时） */
  siteCreated: boolean;
}

export class InvitationService {
  private readonly options: InvitationServiceOptions;
  private readonly logger: Logger | undefined;
  private readonly now: () => Date;

  constructor(options: InvitationServiceOptions) {
    this.options = options;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 生成邀请码（admin 调用）。
   *
   * ★ TTL **服务端硬夹到 1 小时**：请求方传更长的值不会生效，
   *   但会返回实际生效的 `expiresAt`，让调用方看到真实结果（不静默忽略）。
   */
  async create(input: CreateInvitationInput): Promise<CreatedInvitation> {
    const requested = input.ttlMs ?? INVITATION_TTL_DEFAULT_MS;
    const ttlMs = Math.min(Math.max(requested, 60_000), INVITATION_TTL_MAX_MS);
    if (requested > INVITATION_TTL_MAX_MS) {
      this.logger?.warn('邀请码 TTL 超过上限，已夹到 1 小时', { requested, applied: ttlMs });
    }
    const email = input.targetEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new InvitationError('email_mismatch', `targetEmail '${input.targetEmail}' 不是合法邮箱（邀请码必须绑定邮箱）`);
    }

    const now = this.now();
    const code = generateInvitationCode();
    const invitation: Invitation = {
      id: randomBytes(16).toString('hex'),
      siteId: input.siteId,
      codeHash: hashInvitationCode(code),
      codePrefix: code.slice(0, 8),
      targetEmail: email,
      siteMode: input.siteMode ?? 'auto',
      maxUses: Math.max(1, input.uses ?? 1),
      usedCount: 0,
      expiresAt: new Date(now.getTime() + ttlMs),
      usedAt: null,
      usedBy: null,
      createdBy: input.createdBy,
      createdAt: now,
    };
    await this.options.store.save(invitation);
    this.logger?.info('邀请码已生成', { siteId: input.siteId, codePrefix: invitation.codePrefix, targetEmail: email, expiresAt: invitation.expiresAt });

    // ★ 明文码**只在此返回一次**（库里只有 hash）
    return {
      code,
      codePrefix: invitation.codePrefix,
      expiresAt: invitation.expiresAt,
      targetEmail: email,
      siteMode: invitation.siteMode,
      maxUses: invitation.maxUses,
    };
  }

  /**
   * 核销邀请码并完成入驻（OIDC 回调里调用）。
   *
   * 校验链（顺序刻意：**便宜且无副作用的检查在前，原子核销在最后**）：
   *   ① 找到（按 hash）→ ② 未过期 → ③ 未用尽 → ④ **邮箱匹配** → ⑤ **邮箱已验证**
   *   → ⑥ **原子核销** → ⑦ 创建账号与站点
   *
   * ★ 第 ⑥ 步必须在第 ⑦ 步**之前**且原子：否则并发会建出两个账号。
   */
  async redeem(input: RedeemInput): Promise<RedeemResult> {
    const now = this.now();
    const codeHash = hashInvitationCode(input.code);

    const invitation = await this.options.store.findByHash(input.siteId, codeHash);
    if (invitation === undefined) {
      throw new InvitationError('not_found', '邀请码无效（不存在或已被使用）');
    }
    if (invitation.expiresAt.getTime() <= now.getTime()) {
      throw new InvitationError('expired', `邀请码已于 ${invitation.expiresAt.toISOString()} 过期（有效期最长 1 小时）`);
    }
    if (invitation.usedCount >= invitation.maxUses) {
      throw new InvitationError('exhausted', `邀请码已用尽（${invitation.usedCount}/${invitation.maxUses}）`);
    }

    // ④ 邮箱匹配（大小写不敏感；用常量时间比较防时序探测）
    const email = input.email.trim().toLowerCase();
    if (!constantTimeCodeEqual(email, invitation.targetEmail)) {
      // ★ 错误信息不透露目标邮箱（否则可被用来枚举「这个码邀请的是谁」）
      throw new InvitationError('email_mismatch', '本次授权的邮箱与该邀请码不匹配（邀请码与邮箱绑定，不可转发他人使用）');
    }

    // ⑤ 强制邮箱绑定（M7-8）：未验证的邮箱不得入驻
    if (!input.emailVerified) {
      throw new InvitationError('email_not_verified', '邮箱尚未验证——入驻要求强制邮箱绑定，请先完成验证');
    }

    // ⑥ ★ 原子核销（必须在创建账号之前）
    const consumed = await this.options.store.consume(input.siteId, codeHash, input.oidcSubject, now);
    if (!consumed) {
      // 条件不满足或已被并发抢占——对调用方等价：不能继续
      throw new InvitationError('exhausted', '邀请码刚刚被占用或已失效，请重新申请');
    }

    // ⑦ 创建账号（若已存在同名则复用——同一人重试时不应建重复账号）
    const derived = email.split('@')[0]!.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
    const username = input.username ?? (derived.length > 0 ? derived : `dev${Date.now()}`);
    let developer = await this.options.sites.findDeveloperByUsername(username);
    if (developer === undefined) {
      developer = await this.options.sites.createDeveloper({
        username,
        displayName: input.displayName ?? username,
        email,
        role: 'developer',
        emailVerified: true,
      });
    }

    // 按 siteMode 决定加入哪个站点
    let siteCreated = false;
    let site = await this.options.sites.findSite(invitation.siteMode === 'existing' ? invitation.siteId : input.siteId);
    if (site === undefined) {
      site = await this.options.sites.createSite({
        siteId: input.siteId,
        nickname: `${developer.displayName} 的站点`,
        developerId: developer.id,
      });
      siteCreated = true;
    }

    // ★★★ 写入开发者身份映射（`ag_identities`）——**入驻的最后一步，也是最容易漏的一步**。
    //   登录准入查的就是它；漏掉它 = 入驻成功但**永远登录不了**。
    //   ★ 放在 `redeem()` 内部（而不是让端点自己调）是为了让调用方**无法忘记**。
    //   ★ 失败则整体失败（抛出）——不允许「账号建了、身份没写」的半完成状态。
    await this.options.onboardIdentity({
      developerId: developer.id,
      oidcSubject: input.oidcSubject,
      // ★ 方案 A：建 `ag_users` 需要这些字段（用户名/邮箱/是否已验证）
      username: developer.username,
      email,
      emailVerified: input.emailVerified,
    });

    this.logger?.info('开发者入驻完成', {
      developerId: developer.id,
      siteId: site.siteId,
      siteMode: invitation.siteMode,
      siteCreated,
    });
    return { developer, site, siteCreated };
  }

  /** 邀请码列表（管理端用；**不含明文码**，只有前缀）。 */
  async list(siteId: string): Promise<Invitation[]> {
    return this.options.store.list(siteId);
  }
}

// ─────────────────────────── §5.2 不可注册 ───────────────────────────

/**
 * 「不可注册，需绑定后才可登录」（docs/08 §5.2）。
 *
 * ```
 *   开发者 OIDC 登录回调
 *     查 ag_identities(provider='identity:oidc@platform:developer', providerUserId=sub)
 *       ├─ 命中且账号启用 → 建立会话
 *       └─ 未命中         → ❌ 拒绝
 * ```
 *
 * ★ 为什么普通用户不是这样：普通用户**首次自动建号**（§5.3），
 *   开发者必须**先入驻**。两套链路的差异必须显式体现在这里，
 *   而不是靠「有没有邀请码」这种隐式条件。
 */
export interface DeveloperLookup {
  findByIdentity(provider: string, providerUserId: string): Promise<string | undefined>;
}

export const DEVELOPER_IDENTITY_PROVIDER = 'identity:oidc@platform:developer';

/** 开发者登录前的准入检查。 */
export async function assertDeveloperMayLogin(
  lookup: DeveloperLookup,
  sites: SiteRegistry,
  input: { oidcSubject: string },
): Promise<{ ok: true; developer: Developer } | { ok: false; reason: 'not_onboarded' | 'suspended'; message: string }> {
  const developerId = await lookup.findByIdentity(DEVELOPER_IDENTITY_PROVIDER, input.oidcSubject);
  if (developerId === undefined) {
    return {
      ok: false,
      reason: 'not_onboarded',
      message: '此身份尚未入驻，请使用管理员发放的邀请码完成入驻。',
    };
  }
  const developer = await sites.findDeveloper(developerId);
  if (developer === undefined) {
    return { ok: false, reason: 'not_onboarded', message: '此身份尚未入驻，请使用管理员发放的邀请码完成入驻。' };
  }
  if (developer.status !== 'active') {
    return { ok: false, reason: 'suspended', message: `开发者账号已${developer.status === 'suspended' ? '停用' : '待激活'}，请联系管理员` };
  }
  return { ok: true, developer };
}

/** 普通用户首次自动建号（§5.3）——与开发者的「必须入驻」形成显式对照。 */
export const ENDUSER_AUTO_PROVISION_NOTE =
  '普通用户首次 OIDC 登录自动建号（可配置为需邀请或域名白名单）；开发者必须凭邀请码入驻后才能登录。';
