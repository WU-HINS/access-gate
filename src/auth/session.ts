/**
 * 会话与认证骨架（M0-9）。
 *
 * 设计取舍（三条都有具体理由，不是「简单就好」）：
 *
 * 1. **不引入 session 中间件库**：本项目的会话只依赖 `node:crypto` 的随机数与
 *    一次哈希，引入 express-session / fastify-session 反而会带来「store 隐式全量加载」
 *    这类不适合本项目的问题（我们要按站点/主体做隔离与审计）。
 *
 * 2. **会话 token 只存哈希**：与 `ag_secrets` / `ag_invite_codes` 的处理一致
 *    （`ag_sessions` 声明里就是 `tokenHash`）。明文只在 Set-Cookie 里出现一次——
 *    数据库泄露不等于会话可被直接冒用。
 *
 * 3. **站点作用域只从会话解析**：管理端（M1-11）已经按这个约定实现，
 *    这里把「会话里有什么」定死：`realm` / `activeSiteId` / `role` 三者缺一不可判定。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

// ─────────────────────────── 主体与会话 ───────────────────────────

export type Realm = 'developer' | 'enduser';
export type Role = 'admin' | 'developer' | 'user';

/** 已认证主体（认证中间件的输出，也是审计的 actor 来源） */
export interface Principal {
  userId: string;
  username: string;
  email: string | null;
  emailVerified: boolean;
  realm: Realm;
  role: Role;
  /** 当前站点（多站点用户必须先选定；管理端与作用域注入都依赖它） */
  activeSiteId: string | null;
  /** 所属开发者（realm=developer 时有值） */
  activeDeveloperId: string | null;
}

export interface Session {
  /** 会话 id（对外可见，用于审计与撤销） */
  id: string;
  /** token 的 sha256 十六进制（**明文不入库**） */
  tokenHash: string;
  principal: Principal;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionStore {
  /** 按 token 哈希查（含已撤销/已过期，由调用方判断） */
  findByTokenHash(tokenHash: string): Promise<Session | undefined>;
  /** 按会话 id 查（管理用途：撤销） */
  findById(id: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  /** 刷新 lastSeenAt（节流由调用方控制） */
  touch(id: string, at: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  /** 某用户的全部会话（改密码/封禁时批量撤销） */
  listByUser(userId: string): Promise<Session[]>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly byId = new Map<string, Session>();

  async findByTokenHash(tokenHash: string): Promise<Session | undefined> {
    for (const session of this.byId.values()) {
      if (session.tokenHash === tokenHash) return { ...session };
    }
    return undefined;
  }
  async findById(id: string): Promise<Session | undefined> {
    const found = this.byId.get(id);
    return found === undefined ? undefined : { ...found };
  }
  async save(session: Session): Promise<void> {
    this.byId.set(session.id, { ...session });
  }
  async touch(id: string, at: Date): Promise<void> {
    const found = this.byId.get(id);
    if (found !== undefined) found.lastSeenAt = at;
  }
  async revoke(id: string, at: Date): Promise<void> {
    const found = this.byId.get(id);
    if (found !== undefined) found.revokedAt = at;
  }
  async listByUser(userId: string): Promise<Session[]> {
    return [...this.byId.values()].filter((s) => s.principal.userId === userId).map((s) => ({ ...s }));
  }
}

// ─────────────────────────── token 与 cookie ───────────────────────────

export const SESSION_COOKIE = 'ag_session';

/** 常量时间比较（防时序侧信道）；长度不同直接返回 false。 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
  // 32 字节 → base64url，约 43 字符；足够抗暴力且便于放进 Cookie
  return randomBytes(32).toString('base64url');
}

export interface CookieOptions {
  /** 生产环境必须 true（本项目对外只应经 HTTPS） */
  secure?: boolean;
  /** 默认 Lax：跨站导航可用，跨站 POST 不带 → CSRF 基础防护 */
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  maxAgeSec?: number;
  httpOnly?: boolean;
}

export function buildSetCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure === true) parts.push('Secure');
  if (options.maxAgeSec !== undefined) parts.push(`Max-Age=${options.maxAgeSec}`);
  return parts.join('; ');
}

export function buildClearCookie(name: string, path = '/'): string {
  return `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 解析 Cookie 头（只取需要的键，避免引入 cookie 库）。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined || header.length === 0) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key.length > 0) out[key] = decodeURIComponent(value);
  }
  return out;
}

// ─────────────────────────── 会话服务 ───────────────────────────

export interface SessionServiceOptions {
  store: SessionStore;
  /** 会话有效期（默认 12 小时） */
  ttlMs?: number;
  /** lastSeenAt 的刷新节流（默认 60 秒；避免每请求一次写库） */
  touchIntervalMs?: number;
  now?: () => Date;
  /**
   * 事务包装（**真实 PG 模式必需**）。
   *
   * ★ 为什么：`SessionService` 的操作都是**短操作**，而 `Db.query` 有
   *   `assertInTransaction` 断言。路由处理器**不在**业务事务里，
   *   因此真实模式下 `create()` 会抛 `TransactionRequiredError` → 登录 500。
   *   这与 `Scheduler` / `Patrol` 遇到的是**同一类问题**，处置方式也相同：
   *   由构造方注入一个「把这段包进事务」的包装。
   */
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface CreateSessionResult {
  session: Session;
  /** 明文 token——**只在这一次返回**，之后无法再取回 */
  token: string;
}

export class SessionService {
  private readonly store: SessionStore;
  private readonly ttlMs: number;
  private readonly touchIntervalMs: number;
  private readonly now: () => Date;
  private readonly tx: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(options: SessionServiceOptions) {
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? 12 * 3_600_000;
    this.touchIntervalMs = options.touchIntervalMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    // 默认直通（内存 store 无需事务）；真实 PG 模式由调用方注入
    this.tx = options.transaction ?? (<T>(fn: () => Promise<T>) => fn());
  }

  async create(principal: Principal): Promise<CreateSessionResult> {
    return this.tx(async () => {
    const now = this.now();
    const token = newSessionToken();
    const session: Session = {
      // ★ 必须是 uuid：`ag_sessions.id` 是 uuid 列（真实 PG 跑出来的约束）。
      //   早期用 `sess_<base64url>` 前缀串——语义上更好读，但落不了库。
      //   可读性由日志里的独立字段承担，不靠主键格式。
      id: randomUUID(),
      tokenHash: hashToken(token),
      principal,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
      revokedAt: null,
    };
    await this.store.save(session);
    return { session, token };
    });
  }

  /**
   * 校验 token 并返回主体。
   *
   * ★ 四种失效各自返回**明确原因**（而不是笼统的 undefined）：
   *   过期 / 已撤销 / 不存在。审计与前端提示都需要区分——
   *   「会话过期」应引导重新登录，「已撤销」则应提示「你已被登出（可能在其他设备操作）」。
   */
  async authenticate(token: string | undefined): Promise<AuthOutcome> {
    // ★ 必须包事务：`authenticate` 会调 `store.findByTokenHash`，
    //   而它在 **HTTP 中间件**里被调用（不在业务事务内）。
    //   漏掉它的后果是**每个鉴权请求都 500**——比漏掉 create 严重得多。
    return this.tx(async () => this.#authenticateInner(token));
  }

  async #authenticateInner(token: string | undefined): Promise<AuthOutcome> {
    if (token === undefined || token.length === 0) return { ok: false, reason: 'missing' };
    const session = await this.store.findByTokenHash(hashToken(token));
    if (session === undefined) return { ok: false, reason: 'unknown' };
    const now = this.now();
    if (session.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (session.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };

    if (now.getTime() - session.lastSeenAt.getTime() >= this.touchIntervalMs) {
      await this.store.touch(session.id, now);
    }
    return { ok: true, session };
  }

  /**
   * 更新会话的**当前作用域**（activeDeveloperId / activeSiteId）。
   *
   * ★ 这是「当前站点」的唯一写入点（`ag_sessions.active_site_id` 是 RLS / SET LOCAL 的取值来源）。
   *   若允许别处（如请求体）指定 siteId，站点隔离就形同虚设——
   *   因此本方法只应由 `site-selection.selectContext` 的调用方使用，
   *   且传入的 siteId 必须是**内部 uuid**（不是 slug）。
   */
  async setActiveScope(session: Session, scope: { developerId: string; siteId: string }): Promise<Session> {
    return this.tx(async () => {
    const updated: Session = {
      ...session,
      principal: { ...session.principal, activeDeveloperId: scope.developerId, activeSiteId: scope.siteId },
    };
    await this.store.save(updated);
    return updated;
    });
  }

  async revoke(id: string): Promise<void> {
    await this.store.revoke(id, this.now());
  }

  /** 批量撤销某用户的全部会话（改密码 / 封禁 / 改分组后强制重登时使用）。 */
  async revokeAllForUser(userId: string): Promise<number> {
    return this.tx(async () => {
    const sessions = await this.store.listByUser(userId);
    const now = this.now();
    let count = 0;
    for (const session of sessions) {
      if (session.revokedAt === null) {
        await this.store.revoke(session.id, now);
        count += 1;
      }
    }
    return count;
    });
  }

  /** 切换当前站点（多站点用户）。**站点作用域的唯一来源**，因此单独成方法并留痕。 */
  async switchSite(sessionId: string, siteId: string): Promise<Session | undefined> {
    const session = await this.store.findById(sessionId);
    if (session === undefined || session.revokedAt !== null) return undefined;
    const updated: Session = { ...session, principal: { ...session.principal, activeSiteId: siteId } };
    await this.store.save(updated);
    return updated;
  }
}

export type AuthOutcome =
  | { ok: true; session: Session }
  | { ok: false; reason: 'missing' | 'unknown' | 'expired' | 'revoked' };

// ─────────────────────────── 登录态升级 ───────────────────────────

export interface LoginClaims {
  sub: string;
  email?: string | null;
  emailVerified: boolean;
  preferredUsername?: string;
}

/**
 * 由 OIDC claims 构造主体。
 *
 * ★ `realm` 的判定**不依赖 claims**，而由调用方按「哪条登录入口」决定：
 *   developer 控制台与普通用户门户是**两个入口**（docs/08 §3 两身份域）。
 *   让 IdP 声明领域等于把授权边界交给外部系统——那是危险的。
 */
export function principalFromClaims(
  claims: LoginClaims,
  options: { realm: Realm; role?: Role; activeSiteId?: string | null; activeDeveloperId?: string | null },
): Principal {
  return {
    userId: claims.sub,
    username: claims.preferredUsername ?? claims.email ?? claims.sub,
    email: claims.email ?? null,
    emailVerified: claims.emailVerified,
    realm: options.realm,
    role: options.role ?? (options.realm === 'developer' ? 'developer' : 'user'),
    activeSiteId: options.activeSiteId ?? null,
    activeDeveloperId: options.activeDeveloperId ?? null,
  };
}

// ─────────────────────────── CSRF ───────────────────────────

/**
 * 双提交 Cookie 的 CSRF 校验。
 *
 * 为什么状态变更请求必须校验：会话 Cookie 是 `SameSite=Lax`，它挡住了跨站表单 POST，
 * 但**挡不住**同站的 XSS 或某些浏览器对 Lax 的实现差异。对管理端（能改分组、发布策略）
 * 这种高价值操作，多一道校验的成本几乎为零。
 */
export function csrfTokenFor(sessionId: string, secret: string): string {
  return createHash('sha256').update(`${sessionId}\u0000${secret}`).digest('base64url');
}

export function verifyCsrf(sessionId: string, secret: string, provided: string | undefined): boolean {
  if (provided === undefined || provided.length === 0) return false;
  const expected = csrfTokenFor(sessionId, secret);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
