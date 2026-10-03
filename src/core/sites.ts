/**
 * 开发者与站点模型（M7-1）—— docs/08 §2。
 *
 * ```
 *   Developer（开发者账号）
 *     └── Site（站点）★ 隔离边界 + 配置单元
 * ```
 *
 * | 关系 | 基数 |
 * |---|---|
 * | Developer → Site | **一对多**（主站 / 测试站 / 子项目） |
 * | Site → 插件配置 | 一对一（每插件） |
 * | EndUser → Site | **隐式**——用户是平台级的，通过「选择」进入某站点上下文 |
 *
 * ★ M7-1 的验收标准是「**`standalone` 下一切照旧**」。
 *   这句话是本模块最重要的一条约束：站点化是**可选的**多租户能力，
 *   单站点部署必须**零配置可用**、行为与之前完全一致。
 *   因此 `ensureStandalone()` 会自动建出「一个默认开发者 + 一个默认站点」，
 *   且 `resolveSite()` 在单站点模式下**永远返回该默认站点**——
 *   调用方不需要知道「站点」这个概念存在。
 *
 * ★ 表结构说明（核对 `migrations/0001_init.sql`，非凭想象）：
 *   - `ag_developers`：`id / username / display_name / email / password_hash /
 *     email_verified / role / status / locale / security / last_login_at / ...`
 *     （`id` 即主键，**没有** `developer_id` 列；`role` ∈ admin|developer）
 *   - `ag_sites`：`id(uuid) / site_id(slug) / nickname / developer_id / status /
 *     quota / settings / ...`
 *     ★ **两个标识分工**：`site_id` 是面向 URL 与寻址的 **slug**，
 *       `id` 是内部 uuid 主键。混淆它们会让「换 slug」变成「换站点身份」。
 */

import { randomUUID } from 'node:crypto';

import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── 类型 ───────────────────────────

export type DeveloperRole = 'admin' | 'developer';
/**
 * 开发者状态。
 *
 * ★ 取值与迁移产物**严格对齐**（`ag_dev_status` 枚举：`active | suspended | deleted`）。
 *   早期这里写的是 `pending`——那是我凭直觉加的，表里根本没有这个取值，
 *   落到 PG 上会被枚举拒绝。**表是权威**。
 */
export type DeveloperStatus = 'active' | 'suspended' | 'deleted';
export type SiteStatus = 'active' | 'suspended' | 'archived';

export interface Developer {
  /** 内部 uuid 主键（`ag_developers.id`） */
  id: string;
  /** 登录名（可变） */
  username: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  /** ★ admin 只是 developer 的特权角色，不是独立的身份域 */
  role: DeveloperRole;
  status: DeveloperStatus;
  locale?: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface SiteQuota {
  /** 允许的主体数上限（0 或未设表示不限） */
  maxSubjects?: number;
  /** 每日动作执行次数上限 */
  maxDailyActions?: number;
}

export interface Site {
  /** 内部 uuid 主键（`ag_sites.id`） */
  id: string;
  /** ★ 面向 URL 与寻址的 slug（`ag_sites.site_id`） */
  siteId: string;
  nickname: string;
  developerId: string;
  status: SiteStatus;
  quota: SiteQuota;
  settings: Record<string, unknown>;
  createdAt: Date;
}

export interface SiteRegistry {
  createDeveloper(input: {
    username: string;
    displayName: string;
    email: string;
    role?: DeveloperRole;
    emailVerified?: boolean;
    id?: string;
  }): Promise<Developer>;
  findDeveloper(id: string): Promise<Developer | undefined>;
  findDeveloperByUsername(username: string): Promise<Developer | undefined>;
  setDeveloperStatus(id: string, status: DeveloperStatus): Promise<void>;

  createSite(input: { siteId: string; nickname: string; developerId: string; quota?: SiteQuota; settings?: Record<string, unknown>; id?: string }): Promise<Site>;
  findSite(siteId: string): Promise<Site | undefined>;
  /** 该开发者名下的全部站点（一对多） */
  listSitesOf(developerId: string): Promise<Site[]>;
  setSiteStatus(siteId: string, status: SiteStatus): Promise<void>;
  updateSiteQuota(siteId: string, quota: SiteQuota): Promise<void>;
}

export class SiteError extends Error {
  override readonly name = 'SiteError';
  readonly code: 'slug_taken' | 'username_taken' | 'not_found' | 'invalid_slug' | 'developer_missing' | 'site_suspended' | 'developer_suspended' | 'quota_exceeded';
  constructor(code: SiteError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// ─────────────────────────── slug 规则 ───────────────────────────

/** slug 必须是 URL 与寻址安全的：小写字母/数字/连字符，不能以连字符开头或结尾。 */
export const SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function assertValidSiteSlug(slug: string): void {
  if (!SITE_SLUG_PATTERN.test(slug)) {
    throw new SiteError(
      'invalid_slug',
      `站点 slug '${slug}' 非法：只允许小写字母/数字/连字符，长度 1-63，且不能以连字符开头或结尾` +
        `（slug 会出现在 URL 与寻址表达式里，必须安全）`,
    );
  }
  // 保留 slug：避免与宿主/平台自身路由冲突
  if (['api', 'admin', 'verify', 'plugins', 'auth', 'me', '_'].includes(slug)) {
    throw new SiteError('invalid_slug', `站点 slug '${slug}' 是保留字（会与平台路由冲突）`);
  }
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemorySiteRegistry implements SiteRegistry {
  private readonly developers = new Map<string, Developer>();
  private readonly developersByName = new Map<string, string>();
  private readonly sites = new Map<string, Site>();

  async createDeveloper(input: {
    username: string;
    displayName: string;
    email: string;
    role?: DeveloperRole;
    emailVerified?: boolean;
    id?: string;
  }): Promise<Developer> {
    const existing = this.developersByName.get(input.username.toLowerCase());
    if (existing !== undefined) throw new SiteError('username_taken', `用户名 '${input.username}' 已被占用`);
    const developer: Developer = {
      id: input.id ?? randomUUID(),
      username: input.username,
      displayName: input.displayName,
      email: input.email,
      emailVerified: input.emailVerified ?? false,
      role: input.role ?? 'developer',
      status: 'active',
      lastLoginAt: null,
      createdAt: new Date(),
    };
    this.developers.set(developer.id, developer);
    this.developersByName.set(developer.username.toLowerCase(), developer.id);
    return { ...developer };
  }

  async findDeveloper(id: string): Promise<Developer | undefined> {
    const found = this.developers.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async findDeveloperByUsername(username: string): Promise<Developer | undefined> {
    const id = this.developersByName.get(username.toLowerCase());
    if (id === undefined) return undefined;
    return this.findDeveloper(id);
  }

  async setDeveloperStatus(id: string, status: DeveloperStatus): Promise<void> {
    const found = this.developers.get(id);
    if (found === undefined) throw new SiteError('not_found', `开发者 '${id}' 不存在`);
    this.developers.set(id, { ...found, status });
  }

  async createSite(input: {
    siteId: string;
    nickname: string;
    developerId: string;
    quota?: SiteQuota;
    settings?: Record<string, unknown>;
    id?: string;
  }): Promise<Site> {
    assertValidSiteSlug(input.siteId);
    if (this.sites.has(input.siteId)) throw new SiteError('slug_taken', `站点 slug '${input.siteId}' 已被占用`);
    if (!this.developers.has(input.developerId)) {
      throw new SiteError('developer_missing', `开发者 '${input.developerId}' 不存在（站点必须归属一个开发者）`);
    }
    const site: Site = {
      id: input.id ?? randomUUID(),
      siteId: input.siteId,
      nickname: input.nickname,
      developerId: input.developerId,
      status: 'active',
      quota: input.quota ?? {},
      settings: input.settings ?? {},
      createdAt: new Date(),
    };
    this.sites.set(input.siteId, site);
    return { ...site };
  }

  async findSite(siteId: string): Promise<Site | undefined> {
    const found = this.sites.get(siteId);
    return found === undefined ? undefined : { ...found, quota: { ...found.quota }, settings: { ...found.settings } };
  }

  async listSitesOf(developerId: string): Promise<Site[]> {
    return [...this.sites.values()]
      .filter((site) => site.developerId === developerId)
      .sort((a, b) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0))
      .map((site) => ({ ...site, quota: { ...site.quota }, settings: { ...site.settings } }));
  }

  async setSiteStatus(siteId: string, status: SiteStatus): Promise<void> {
    const found = this.sites.get(siteId);
    if (found === undefined) throw new SiteError('not_found', `站点 '${siteId}' 不存在`);
    this.sites.set(siteId, { ...found, status });
  }

  async updateSiteQuota(siteId: string, quota: SiteQuota): Promise<void> {
    const found = this.sites.get(siteId);
    if (found === undefined) throw new SiteError('not_found', `站点 '${siteId}' 不存在`);
    this.sites.set(siteId, { ...found, quota: { ...quota } });
  }
}

// ─────────────────────────── standalone 兼容层 ───────────────────────────

/** standalone 模式下的默认 slug（单站点部署时对用户完全透明）。 */
export const DEFAULT_STANDALONE_SLUG = 'default';
export const DEFAULT_STANDALONE_DEVELOPER = 'owner';

export interface StandaloneBootstrap {
  registry: SiteRegistry;
  developer: Developer;
  site: Site;
  /** 是否本次新建（false 表示复用了已存在的） */
  created: boolean;
}

/**
 * 确保存在「一个默认开发者 + 一个默认站点」。
 *
 * ★ 这正是「`standalone` 下一切照旧」的实现：
 *   单站点部署时管理员**不需要先建开发者再建站点**，
 *   平台首次启动即自动兜底，之后一切按原有站点作用域行为运行。
 *
 * 幂等：重复调用不会重复创建（也不报错）——否则重启即失败。
 */
export async function ensureStandalone(
  registry: SiteRegistry,
  options: { slug?: string; nickname?: string; developerUsername?: string; developerEmail?: string } = {},
): Promise<StandaloneBootstrap> {
  const slug = options.slug ?? DEFAULT_STANDALONE_SLUG;
  const existingSite = await registry.findSite(slug);
  if (existingSite !== undefined) {
    const developer = await registry.findDeveloper(existingSite.developerId);
    if (developer === undefined) {
      throw new SiteError('developer_missing', `默认站点 '${slug}' 的归属开发者不存在（数据不一致）`);
    }
    return { registry, developer, site: existingSite, created: false };
  }

  const username = options.developerUsername ?? DEFAULT_STANDALONE_DEVELOPER;
  let developer = await registry.findDeveloperByUsername(username);
  if (developer === undefined) {
    developer = await registry.createDeveloper({
      username,
      displayName: '站点所有者',
      email: options.developerEmail ?? 'owner@localhost',
      // ★ 单站点部署的默认账号必须有 admin 角色，否则连管理端都进不去
      role: 'admin',
      emailVerified: false,
    });
  }
  const site = await registry.createSite({ siteId: slug, nickname: options.nickname ?? '默认站点', developerId: developer.id });
  return { registry, developer, site, created: true };
}

// ─────────────────────────── 站点解析与校验 ───────────────────────────

export type SiteResolution =
  | { ok: true; site: Site; developer: Developer }
  | { ok: false; reason: 'site_not_found' | 'site_suspended' | 'developer_suspended' | 'developer_not_found'; message: string };

/**
 * 解析某请求应落在哪个站点（并校验其可用性）。
 *
 * ★ `standalone` 下 `requestedSlug` 通常为 `undefined`——
 *   此时回落到默认站点，调用方无需感知站点概念。
 */
export async function resolveSite(
  registry: SiteRegistry,
  options: { requestedSlug?: string; standaloneSlug?: string } = {},
): Promise<SiteResolution> {
  const slug = options.requestedSlug ?? options.standaloneSlug ?? DEFAULT_STANDALONE_SLUG;
  const site = await registry.findSite(slug);
  if (site === undefined) {
    return { ok: false, reason: 'site_not_found', message: `站点 '${slug}' 不存在` };
  }
  if (site.status !== 'active') {
    // ★ 停用的站点必须拒绝服务，而不是「服务但标记停用」——
    //   后者会让「停用」变成一个纯展示状态，失去实际约束力。
    return { ok: false, reason: 'site_suspended', message: `站点 '${slug}' 已${site.status === 'suspended' ? '停用' : '归档'}` };
  }
  const developer = await registry.findDeveloper(site.developerId);
  if (developer === undefined) {
    return { ok: false, reason: 'developer_not_found', message: `站点 '${slug}' 的归属开发者不存在` };
  }
  if (developer.status !== 'active') {
    // 开发者被停用 → 其名下所有站点一并拒绝（一对多的级联语义）
    return { ok: false, reason: 'developer_suspended', message: `站点 '${slug}' 的归属开发者已停用` };
  }
  return { ok: true, site, developer };
}

/**
 * 站点是否还能接纳更多主体（配额检查）。
 *
 * ★ 返回**可解释的结果**而不是布尔：管理端需要知道「因为配额满了」还是「因为站点停用」。
 */
export function checkSubjectQuota(site: Site, currentSubjects: number): { allowed: true } | { allowed: false; limit: number; message: string } {
  const limit = site.quota.maxSubjects;
  if (limit === undefined || limit <= 0) return { allowed: true };
  if (currentSubjects >= limit) {
    return {
      allowed: false,
      limit,
      message: `站点 '${site.siteId}' 的主体数已达配额上限 ${limit}（当前 ${currentSubjects}）`,
    };
  }
  return { allowed: true };
}

/** 开发者的站点一览（管理端「我的站点」页用）。 */
export async function developerOverview(
  registry: SiteRegistry,
  developerId: string,
): Promise<{ developer: Developer; sites: Site[] } | undefined> {
  const developer = await registry.findDeveloper(developerId);
  if (developer === undefined) return undefined;
  return { developer, sites: await registry.listSitesOf(developerId) };
}

/**
 * `standalone` 与多站点模式的行为差异（供文档与 UI 提示）。
 *
 * | 维度 | standalone（单站点） | 多站点 |
 * |---|---|---|
 * | 站点数量 | 恒为 1（自动兜底） | 开发者可建多个 |
 * | 站点选择 | 不需要（永远默认站点） | 用户显式选择 / 按域名映射 |
 * | 站点 slug 可见性 | 通常对用户不可见 | 出现在 URL 中 |
 * | 配置作用域 | 全部落在默认站点 | 每站点各自一份 |
 */
export const STANDALONE_SEMANTICS_NOTE =
  '单站点部署零配置可用：平台自动建出默认开发者与默认站点，站点 slug 对用户不可见，行为与站点化之前完全一致。';
