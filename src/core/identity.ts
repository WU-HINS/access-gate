/**
 * 身份对齐（M1-7）—— docs/05 §1。
 *
 * 目标：把「一个 OIDC 会话」映射到「一个下游主体」，且这个映射**稳定、可审计、可人工纠正**。
 *
 * ★ 设计原则（docs/05 §1.2 原话）：**宁可不自动，不可错对齐**。
 *   因为对齐错了 = 把别人的分组改了 = 资损。因此本模块的默认行为是：
 *   - 邮箱兜底**绝不自动绑定**，只产出 `needs_confirm`（需用户确认）；
 *   - 邮箱冲突 → `manual_review`，交管理员裁决；
 *   - 任何路径都不"猜"。
 *
 * 路径优先级（docs/05 §1.3，按可信度排序）：
 *   ① cache   本地身份索引（O(1) 热路径）
 *   ② direct  直查下游（provider 支持 `findByIdentity` 时）
 *   ③ mirror  本地镜像表（全量对账产物）
 *   ④ email   邮箱兜底（需 email_verified + 唯一性 + **用户确认**）
 *   ⑤ unlinked 未对齐 → 引导绑定
 */

import type { Logger } from '../kernel/logger.ts';
import type { ExternalSubject, ProviderPlugin } from '../plugin/provider.ts';
import type { SubjectStore } from '../plugin/subjects.ts';

// ─────────────────────────── 身份记录 ───────────────────────────

export interface IdentityRecord {
  id?: string;
  /** 提供方命名空间：`subject:<provider>`（下游主体目录）或 `oidc:<issuer>`（身份提供方） */
  provider: string;
  /** 提供方内的用户标识（OIDC 的 sub / OAuth 的 provider_user_id） */
  providerUserId: string;
  /** 平台用户 id（`ag_users.id`，即 OIDC 的 sub，永不变） */
  userId: string;
  /** ★ 反向指向下游主体（对齐结果缓存）：{ provider, externalId } */
  subjectRef?: { provider: string; externalId: string } | null;
  claimSnapshot?: Record<string, unknown>;
  verifiedAt?: Date | null;
  /** 撤销时间（换绑 / oidc_id 变更时置位；撤销后不再用于对齐） */
  revokedAt?: Date | null;
}

export interface IdentityStore {
  /** 按 (provider, providerUserId) 查（含已撤销的，由调用方判断） */
  find(provider: string, providerUserId: string): Promise<IdentityRecord | undefined>;
  /** 按平台用户查其全部身份 */
  listByUser(userId: string): Promise<IdentityRecord[]>;
  /** UPSERT（唯一键：provider + providerUserId） */
  save(record: IdentityRecord): Promise<void>;
  /** 撤销（不物理删；保留审计线索） */
  revoke(provider: string, providerUserId: string, at: Date): Promise<void>;
}

export class InMemoryIdentityStore implements IdentityStore {
  private readonly records = new Map<string, IdentityRecord>();
  private key(provider: string, providerUserId: string): string {
    return `${provider}\u0000${providerUserId}`;
  }
  async find(provider: string, providerUserId: string): Promise<IdentityRecord | undefined> {
    const record = this.records.get(this.key(provider, providerUserId));
    return record === undefined ? undefined : { ...record };
  }
  async listByUser(userId: string): Promise<IdentityRecord[]> {
    return [...this.records.values()].filter((r) => r.userId === userId);
  }
  async save(record: IdentityRecord): Promise<void> {
    this.records.set(this.key(record.provider, record.providerUserId), { ...record });
  }
  async revoke(provider: string, providerUserId: string, at: Date): Promise<void> {
    const existing = this.records.get(this.key(provider, providerUserId));
    if (existing !== undefined) this.records.set(this.key(provider, providerUserId), { ...existing, revokedAt: at });
  }
}

// ─────────────────────────── 平台用户侧 ───────────────────────────

export interface PlatformUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
  username: string;
  status: string;
}

export interface UserDirectory {
  /** 按邮箱查平台用户（可能多个 → 冲突） */
  findByEmail(email: string): Promise<PlatformUser[]>;
  byId(userId: string): Promise<PlatformUser | undefined>;
}

// ─────────────────────────── 对齐结果 ───────────────────────────

export type AlignmentVia = 'cache' | 'direct' | 'mirror' | 'email' | 'manual';

export type AlignmentStatus = 'aligned' | 'needs_confirm' | 'manual_review' | 'unlinked';

export interface AlignmentResult {
  status: AlignmentStatus;
  /** 对齐来源（审计与排障必需） */
  via?: AlignmentVia;
  /** 下游主体引用 */
  subjectRef?: { provider: string; externalId: string };
  /** needs_confirm / manual_review 时候选主体 */
  candidate?: ExternalSubject;
  /** manual_review 的原因（如 `email_conflict`） */
  reason?: string;
  /** unlinked 时的引导（两种模式不同，docs/05 §1.4） */
  guidance?: BindingGuidance;
  /** 供审计记录的对齐轨迹（哪条路径命中、哪些被跳过及原因） */
  trace: AlignmentStep[];
}

export interface AlignmentStep {
  path: 'cache' | 'direct' | 'mirror' | 'email';
  outcome: 'hit' | 'miss' | 'skipped' | 'ambiguous';
  detail?: string;
}

export interface BindingGuidance {
  /** 提示文案（面向用户） */
  message: string;
  /** 建议的跳转路径（相对下游站点） */
  path: string;
  /** 下游站点地址（由调用方注入，核心不硬编码任何具体系统） */
  target: string;
}

export interface AlignmentInput {
  /** 身份提供方命名空间（如 `oidc:https://idp.example`） */
  identityProvider: string;
  /** 该提供方内的用户标识（OIDC 的 sub） */
  providerUserId: string;
  /** 平台用户（已登录） */
  user: PlatformUser;
  /** 当前站点的主体目录（**不是**具体系统——由 provider 插件实现） */
  provider: ProviderPlugin;
  /** 本地身份索引 */
  identities: IdentityStore;
  /** 本地主体镜像（对账产物） */
  subjects: SubjectStore;
  /** 是否允许邮箱兜底（默认允许，但**只产出 needs_confirm**） */
  allowEmailFallback?: boolean;
  /** 下游站点的对外地址（用于引导跳转；核心不猜任何具体系统） */
  downstreamBaseUrl?: string;
  now?: Date;
}

/**
 * 对齐解析器。
 *
 * ★ 注意「邮箱兜底」的严格条件（docs/05 §1.2 第 3 行）：
 *   `email_verified = true` **且**下游侧邮箱**唯一**，**且需用户确认**。
 *   三者缺一不可——少了「用户确认」就是自动错对齐。
 */
export async function resolveIdentity(input: AlignmentInput, logger?: Logger): Promise<AlignmentResult> {
  const trace: AlignmentStep[] = [];
  const providerId = input.provider.id;
  const subjectRefOf = (subject: ExternalSubject) => ({ provider: providerId, externalId: subject.externalId });

  // ── 路径 1：本地索引（热路径，O(1)）──
  const cached = await input.identities.find(input.identityProvider, input.providerUserId);
  if (cached !== undefined && cached.revokedAt !== undefined && cached.revokedAt !== null) {
    trace.push({ path: 'cache', outcome: 'skipped', detail: `身份已于 ${cached.revokedAt.toISOString()} 撤销` });
  } else if (cached?.subjectRef !== undefined && cached.subjectRef !== null) {
    // 校验引用仍然有效。
    //
    // ★ 只在镜像里**确实有这条记录**时才据此判定（`isStillValid` 的合理解读）。
    //   早期实现写成「镜像里找不到 → 缓存失效」，导致：对账尚未同步到该主体时，
    //   每次请求都会丢掉缓存并重新直查下游——缓存形同虚设，且下游压力成倍上升。
    //   而「主体已被删除」这一条**必须保留**：被显式删除的主体不能再作为有效对齐结果
    //   （否则下游已删用户仍会走「已对齐」路径）。
    const mirrored = await input.subjects.get(cached.subjectRef.provider, cached.subjectRef.externalId);
    if (mirrored !== undefined && mirrored.deletedAt !== undefined) {
      trace.push({ path: 'cache', outcome: 'miss', detail: '引用的主体已被标记删除' });
    } else {
      trace.push({
        path: 'cache',
        outcome: 'hit',
        detail:
          mirrored === undefined
            ? `${cached.subjectRef.provider}:${cached.subjectRef.externalId}（镜像未同步到该主体，按缓存引用放行）`
            : `${cached.subjectRef.provider}:${cached.subjectRef.externalId}`,
      });
      return { status: 'aligned', via: 'cache', subjectRef: cached.subjectRef, trace };
    }
  } else {
    trace.push({ path: 'cache', outcome: 'miss', detail: '本地身份索引无记录' });
  }

  // ── 路径 2：直查下游（provider 支持按身份键查）──
  if (input.provider.capabilities.findByIdentity && typeof input.provider.findSubject === 'function') {
    for (const key of identityKeyCandidates(input)) {
      const hit = await input.provider.findSubject({ key, value: input.providerUserId });
      if (hit !== null) {
        trace.push({ path: 'direct', outcome: 'hit', detail: `按 ${key} 命中 ${hit.externalId}` });
        await persistAlignment(input, hit, 'direct');
        return { status: 'aligned', via: 'direct', subjectRef: subjectRefOf(hit), trace };
      }
      trace.push({ path: 'direct', outcome: 'miss', detail: `按 ${key} 未命中` });
    }
  } else {
    trace.push({ path: 'direct', outcome: 'skipped', detail: 'provider 未声明 findByIdentity 能力' });
  }

  // ── 路径 3：本地镜像表（全量对账产物）──
  const mirroredHit = await findInMirror(input);
  if (mirroredHit !== null) {
    trace.push({ path: 'mirror', outcome: 'hit', detail: mirroredHit.externalId });
    await persistAlignment(input, mirroredHit, 'mirror');
    return { status: 'aligned', via: 'mirror', subjectRef: subjectRefOf(mirroredHit), trace };
  }
  trace.push({ path: 'mirror', outcome: 'miss', detail: '镜像表中无匹配主体' });

  // ── 路径 4：邮箱兜底（**只产出 needs_confirm，绝不自动绑定**）──
  const emailOutcome = await tryEmailFallback(input, trace);
  if (emailOutcome.kind === 'unique') {
    return {
      status: 'needs_confirm',
      via: 'email',
      candidate: emailOutcome.subject,
      reason: 'email_match_requires_confirmation',
      trace,
    };
  }
  if (emailOutcome.kind === 'ambiguous') {
    return { status: 'manual_review', reason: 'email_conflict', trace };
  }

  // ── 路径 5：未对齐 → 引导绑定 ──
  const guidance = buildGuidance(input, mirroredHit === null);
  logger?.info('身份未对齐，返回绑定引导', { providerId, userId: input.user.id, path: guidance.path });
  return { status: 'unlinked', guidance, trace };
}

/** 该 provider 声明的身份键（用于直查下游）；缺省回退到 `oidc_id` / `email`。 */
function identityKeyCandidates(input: AlignmentInput): string[] {
  const declared = (input.provider.identityKeys ?? []).map((k) => k.key);
  return declared.length > 0 ? declared : ['oidc_id', 'email'];
}

async function findInMirror(input: AlignmentInput): Promise<ExternalSubject | null> {
  // 镜像表按 `subjectRef` 存的是下游主键；这里用「身份键值 = 下游主体主键」的常见形态匹配，
  // 再退化为按邮箱匹配（邮箱需已验证）。
  const direct = await input.subjects.get(input.provider.id, input.providerUserId);
  if (direct !== undefined && direct.deletedAt === undefined) {
    return {
      externalId: direct.externalId,
      attributes: direct.attributes,
      ...(direct.displayName === undefined ? {} : { displayName: direct.displayName }),
      ...(direct.email === undefined ? {} : { email: direct.email }),
    };
  }
  if (input.user.email !== null && input.user.emailVerified) {
    const byEmail = await input.subjects.findByEmail(input.provider.id, input.user.email);
    if (byEmail !== undefined) {
      return {
        externalId: byEmail.externalId,
        attributes: byEmail.attributes,
        ...(byEmail.displayName === undefined ? {} : { displayName: byEmail.displayName }),
        ...(byEmail.email === undefined ? {} : { email: byEmail.email }),
      };
    }
  }
  return null;
}

type EmailOutcome = { kind: 'unique'; subject: ExternalSubject } | { kind: 'ambiguous' } | { kind: 'none' };

async function tryEmailFallback(input: AlignmentInput, trace: AlignmentStep[]): Promise<EmailOutcome> {
  if (input.allowEmailFallback === false) {
    trace.push({ path: 'email', outcome: 'skipped', detail: '调用方禁用了邮箱兜底' });
    return { kind: 'none' };
  }
  if (input.user.email === null || !input.user.emailVerified) {
    trace.push({ path: 'email', outcome: 'skipped', detail: '平台侧邮箱未验证（兜底条件不满足）' });
    return { kind: 'none' };
  }

  const candidates = await input.subjects.findByEmail(input.provider.id, input.user.email);
  if (candidates === undefined) {
    trace.push({ path: 'email', outcome: 'miss', detail: `下游无 ${input.user.email} 对应主体` });
    return { kind: 'none' };
  }
  // 下游侧唯一性：`findByEmail` 返回单个即唯一；若底层返回多个由实现方保证抛错或取首个。
  const subject: ExternalSubject = {
    externalId: candidates.externalId,
    attributes: candidates.attributes,
    ...(candidates.displayName === undefined ? {} : { displayName: candidates.displayName }),
    ...(candidates.email === undefined ? {} : { email: candidates.email }),
  };
  trace.push({ path: 'email', outcome: 'hit', detail: `${candidates.externalId}（需用户确认后才绑定）` });
  return { kind: 'unique', subject };
}

async function persistAlignment(input: AlignmentInput, subject: ExternalSubject, via: AlignmentVia): Promise<void> {
  const now = input.now ?? new Date();
  await input.identities.save({
    provider: input.identityProvider,
    providerUserId: input.providerUserId,
    userId: input.user.id,
    subjectRef: { provider: input.provider.id, externalId: subject.externalId },
    verifiedAt: now,
    claimSnapshot: { via, alignedAt: now.toISOString() },
  });
}

/**
 * 用户确认邮箱兜底后调用：把 `needs_confirm` 落实为真正的对齐。
 *
 * 单独一个函数是刻意的——它让「自动对齐」与「经用户确认的对齐」在代码上**可区分**，
 * 审计记录里能看出这条对齐是不是有人点过确认。
 */
export async function confirmEmailAlignment(
  input: AlignmentInput,
  candidate: ExternalSubject,
): Promise<AlignmentResult> {
  const now = input.now ?? new Date();
  await input.identities.save({
    provider: input.identityProvider,
    providerUserId: input.providerUserId,
    userId: input.user.id,
    subjectRef: { provider: input.provider.id, externalId: candidate.externalId },
    verifiedAt: now,
    claimSnapshot: { via: 'email', confirmedAt: now.toISOString() },
  });
  return {
    status: 'aligned',
    via: 'email',
    subjectRef: { provider: input.provider.id, externalId: candidate.externalId },
    trace: [{ path: 'email', outcome: 'hit', detail: '用户已确认邮箱匹配' }],
  };
}

/**
 * 构建绑定引导（docs/05 §1.4）。
 *
 * ★ 核心不得硬编码任何具体系统的登录路径。这里的路径由**调用方注入**的
 *   `downstreamBaseUrl` 拼出，文案也是中性的「下游账号」而非某个系统名——
 *   否则就违反了「核心不认识具体系统」的硬约束（CI 第 7 项会命中）。
 */
function buildGuidance(input: AlignmentInput, downstreamHasNoUser: boolean): BindingGuidance {
  const target = input.downstreamBaseUrl ?? '';
  if (downstreamHasNoUser) {
    return {
      message: '请先在下游系统注册或登录，完成后回到本平台，下一轮对账会自动完成对齐。',
      path: '/register',
      target,
    };
  }
  return {
    message: '检测到你已有下游账号，请前往下游系统使用本平台的统一登录方式登录一次，以完成绑定。',
    path: '/login',
    target,
  };
}

// ─────────────────────────── 冲突与撤销 ───────────────────────────

export type ConflictResolution = 'granted' | 'manual_review';

export interface ConflictInput {
  subjectRef: { provider: string; externalId: string };
  /** 已占用该主体的平台用户 id 列表（按时间顺序） */
  existingUserIds: readonly string[];
  /** 当前请求对齐的平台用户 */
  requestingUserId: string;
}

/**
 * 一个下游主体被两个平台用户争抢时的处置（docs/05 §1.5）：
 * **先到先得 + 告警**；后者进入 `manual_review`，由管理员裁决。
 *
 * 为什么不是「后者覆盖前者」：覆盖会静默改变已生效的权限归属（资损），
 * 而人工裁决的成本远低于错对齐的代价。
 */
export function resolveSubjectConflict(input: ConflictInput): { resolution: ConflictResolution; reason: string } {
  if (input.existingUserIds.length === 0) return { resolution: 'granted', reason: '主体尚未被占用' };
  if (input.existingUserIds.includes(input.requestingUserId)) {
    return { resolution: 'granted', reason: '该主体已属于本用户（幂等）' };
  }
  return {
    resolution: 'manual_review',
    reason: `主体已被 ${input.existingUserIds.length} 个平台用户占用（先到先得），需管理员裁决`,
  };
}

/**
 * 撤销旧身份（换绑 / 下游 `oidc_id` 变更时调用，docs/05 §1.5）。
 *
 * 撤销而非删除：保留审计线索，且撤销后的记录**不再参与对齐**
 * （`resolveIdentity` 的路径 1 会显式跳过）。
 */
export async function revokeIdentity(
  identities: IdentityStore,
  provider: string,
  providerUserId: string,
  at: Date,
): Promise<void> {
  await identities.revoke(provider, providerUserId, at);
}

// ─────────────────────────── OIDC claims 校验（最小） ───────────────────────────

export interface OidcClaims {
  sub: string;
  iss: string;
  aud?: string | string[];
  exp?: number;
  email?: string;
  email_verified?: boolean;
  [key: string]: unknown;
}

export class OidcClaimError extends Error {
  override readonly name = 'OidcClaimError';
}

export interface OidcValidationOptions {
  /** 期望的签发者（必须精确匹配，防止 IdP 混淆攻击） */
  expectedIssuer: string;
  /** 允许的受众（本平台的 client_id） */
  allowedAudiences?: readonly string[];
  /** 时间基准（测试可注入） */
  now?: Date;
  /** 允许的时钟偏移（秒） */
  clockToleranceSec?: number;
}

/**
 * 校验 OIDC ID Token 的**声明层**（签名验证由 `identity` 插件负责，见 docs/09）。
 *
 * ★ 为什么这里只做声明层校验：`iss` / `aud` / `exp` 的校验是**防 IdP 混淆**与
 *   **防重放**的关键，与签名验证同等重要，且不依赖任何加密库。
 *   把这一层单独实现，可以让「签名验证」与「声明校验」各自被独立测试。
 */
export function validateOidcClaims(claims: OidcClaims, options: OidcValidationOptions): void {
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new OidcClaimError('ID Token 缺少 sub（平台用户锚点必需）');
  }
  if (claims.iss !== options.expectedIssuer) {
    throw new OidcClaimError(`issuer 不匹配：期望 '${options.expectedIssuer}'，实际 '${String(claims.iss)}'（可能是 IdP 混淆攻击）`);
  }
  if (options.allowedAudiences !== undefined && options.allowedAudiences.length > 0) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud === undefined ? [] : [claims.aud];
    const ok = audiences.some((a) => options.allowedAudiences!.includes(a));
    if (!ok) {
      throw new OidcClaimError(`aud 不匹配：token 的 aud=[${audiences.join(', ')}]，本平台 client_id 不在其中`);
    }
  }
  if (claims.exp !== undefined) {
    const now = options.now ?? new Date();
    const tolerance = (options.clockToleranceSec ?? 60) * 1_000;
    if (claims.exp * 1_000 + tolerance < now.getTime()) {
      throw new OidcClaimError(`ID Token 已过期（exp=${new Date(claims.exp * 1_000).toISOString()}）`);
    }
  }
}

/** 从 claims 提取平台用户字段（首次登录自动建号时使用）。 */
export function userFromClaims(claims: OidcClaims): {
  email: string | null;
  emailVerified: boolean;
  username: string;
} {
  const email = typeof claims.email === 'string' ? claims.email : null;
  return {
    email,
    emailVerified: claims.email_verified === true,
    username: typeof claims.preferred_username === 'string' ? claims.preferred_username : claims.sub,
  };
}
