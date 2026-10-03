/**
 * 用户管理存储（`ag_users` / `ag_identities`）—— P0（排障与客服必需）。
 *
 * ★ 枚举取值**先查迁移产物**：
 *   `ag_user_status = 'pending' | 'active' | 'suspended' | 'deleted'`
 *   `ag_user_source = 'local' | 'oidc'`
 *
 * ★★ 一个值得记的对比：`ag_users.status` **有** `pending`，
 *   而 `ag_developers.status`（`ag_dev_status`）**没有**——
 *   我在早期凭直觉给 `DeveloperStatus` 写了 `pending` 而被真实 PG 拒绝。
 *   同类字段的枚举**可能不同**，所以「查过一张表」不等于「另一张也能猜」。
 *
 * ★ `ag_users` 是**平台级**表（用户是平台级的，跨站点）。
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { and, col, eq, like, lit, or, type Condition } from '../query/ast.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export type UserStatus = 'pending' | 'active' | 'suspended' | 'deleted';
export type UserSource = 'local' | 'oidc';

export interface PlatformUserRecord {
  id: string;
  email: string;
  emailVerified: boolean;
  username: string;
  status: UserStatus;
  source: UserSource;
  locale: string;
  tags: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserIdentityRecord {
  id: string;
  provider: string;
  providerUserId: string;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface ListUsersResult {
  users: PlatformUserRecord[];
  /**
   * 本页返回的条数。
   *
   * ★★ **不是精确总数**——精确计数需要 `count(*)`，而 CI 的「禁止裸 SQL 拼接」
   *   与「安全自查」都拒绝拼接式 SQL（即使值走 `$n`）。
   *   与其加白名单放行，不如**如实命名**：这个字段是「至少这么多」。
   *   需要精确总数时应新增一个专门的统计端点（用编译器的聚合能力，若将来支持）。
   */
  total: number;
  /** 是否还有下一页（用「多取一条」判断，无需 count） */
  hasMore: boolean;
}

export interface ListUsersInput {
  /** 按状态过滤 */
  status?: UserStatus;
  /** 邮箱/用户名模糊匹配（大小写不敏感） */
  search?: string;
  limit: number;
  offset: number;
}

export interface UserAdminStore {
  list(input: ListUsersInput): Promise<ListUsersResult>;
  get(id: string): Promise<PlatformUserRecord | undefined>;
  identitiesOf(userId: string): Promise<UserIdentityRecord[]>;
  setStatus(id: string, status: UserStatus): Promise<PlatformUserRecord | undefined>;
  /**
   * 覆写标签（**全量替换**，不是增量追加）。
   *
   * ★ 为什么是全量替换：标签是**运营分类**（VIP / 风险 / 试用…），
   *   「加一个」与「去掉一个」是同一个意图的两面；
   *   增量接口会让「清空标签」变成「逐个删」，而调用方很难确认删干净了。
   */
  setTags(id: string, tags: readonly string[]): Promise<PlatformUserRecord | undefined>;
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryUserAdminStore implements UserAdminStore {
  private readonly users = new Map<string, PlatformUserRecord>();
  private readonly identities = new Map<string, UserIdentityRecord[]>();

  seed(user: PlatformUserRecord, identities: UserIdentityRecord[] = []): void {
    this.users.set(user.id, { ...user });
    if (identities.length > 0) this.identities.set(user.id, identities.map((entry) => ({ ...entry })));
  }

  async list(input: ListUsersInput): Promise<ListUsersResult> {
    const all = [...this.users.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const filtered = all.filter((user) => {
      if (input.status !== undefined && user.status !== input.status) return false;
      if (input.search !== undefined && input.search.length > 0) {
        const needle = input.search.toLowerCase();
        if (!user.email.toLowerCase().includes(needle) && !user.username.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
    // ★★ 与 PG 实现保持**同一语义**：调用方传入的是 `limit + 1`（多取一条），
    //   因此这里也要切掉最后一条再返回。
    //   （最初忘了这一步，被分页测试当场抓到——两个实现的语义不一致
    //     比单个实现写错更难发现，因为内存模式测试与 PG 测试各自都能通过。）
    const page = filtered.slice(input.offset, input.offset + Math.max(1, input.limit - 1));
    return { users: page.map((user) => ({ ...user })), total: page.length, hasMore: input.offset + page.length < filtered.length };
  }

  async get(id: string): Promise<PlatformUserRecord | undefined> {
    const found = this.users.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async identitiesOf(userId: string): Promise<UserIdentityRecord[]> {
    return (this.identities.get(userId) ?? []).map((entry) => ({ ...entry }));
  }

  async setStatus(id: string, status: UserStatus): Promise<PlatformUserRecord | undefined> {
    const found = this.users.get(id);
    if (found === undefined) return undefined;
    const next: PlatformUserRecord = { ...found, status, updatedAt: new Date() };
    this.users.set(id, next);
    return { ...next };
  }
  async setTags(id: string, tags: readonly string[]): Promise<PlatformUserRecord | undefined> {
    const found = this.users.get(id);
    if (found === undefined) return undefined;
    // ★ 去重 + 排序：让「同一组标签」在任何输入顺序下得到**相同结果**
    //   （否则 `['vip','risk']` 与 `['risk','vip']` 会被判为「变了」，而它们语义相同）
    const next: PlatformUserRecord = { ...found, tags: [...new Set(tags)].sort(), updatedAt: new Date() };
    this.users.set(id, next);
    return { ...next };
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  email_verified: boolean;
  username: string;
  status: string;
  source: string;
  locale: string;
  tags: unknown;
  last_login_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const USER_COLUMNS = ['id', 'email', 'email_verified', 'username', 'status', 'source', 'locale', 'tags', 'last_login_at', 'created_at', 'updated_at'];

function rowToUser(row: UserRow): PlatformUserRecord {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified === true,
    username: row.username,
    status: row.status as UserStatus,
    source: row.source as UserSource,
    locale: row.locale,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : typeof row.tags === 'string' ? (JSON.parse(row.tags) as string[]) : [],
    lastLoginAt: row.last_login_at === null ? null : new Date(row.last_login_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class DbUserAdminStore implements UserAdminStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async list(input: ListUsersInput): Promise<ListUsersResult> {
    // ★★ 列表查询**完全走编译器的条件构造**（`and` / `or` / `like(caseInsensitive)`）——
    //   编译器支持 `ILIKE` 与逻辑组合，因此**不需要手写 SQL**。
    //   这比拼接 SQL 更安全（不可能漏参数化），也能通过 CI 的裸 SQL 扫描。
    const conditions: Condition[] = [];
    if (input.status !== undefined) conditions.push(eq(col('status'), lit(input.status)));
    if (input.search !== undefined && input.search.length > 0) {
      const pattern = `%${input.search}%`;
      conditions.push(or(like(col('email'), pattern, true), like(col('username'), pattern, true)));
    }
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_users',
        columns: USER_COLUMNS,
        ...(conditions.length === 0 ? {} : { where: and(...conditions) }),
        orderBy: [{ column: 'created_at', direction: 'desc' }],
        limit: input.limit,
        offset: input.offset,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UserRow>(compiled.sql, compiled.params);
    // ★★ 刻意**不做 `count(*)`**，而是「多取一条」判断是否还有下一页。
    //
    //   原因：CI 的「禁止裸 SQL 拼接」与「安全自查」两项**都正确拦住了**
    //   `SELECT count(*) … WHERE ${conditions.join(' AND ')}` ——
    //   即使拼的是条件片段、值仍走 `$n`，门禁的立场是「不接受任何 SQL 拼接」。
    //
    //   ★ 我选择**改代码而不是加白名单**：让代码可被静态检查，
    //     比让检查工具放行更划算（R22 的同一教训）。
    //   ★ 代价是 `total` 语义变成「**至少这么多**」——因此同时返回
    //     `hasMore`，并把这个不精确性写进响应字段名与注释，而不是假装知道总数。
    // 调用方传入的是 `limit + 1`（多取一条），这里据此判断 hasMore
    const page = rows.slice(0, Math.max(1, input.limit - 1));
    return { users: page.map(rowToUser), total: page.length, hasMore: rows.length > page.length };
  }

  async get(id: string): Promise<PlatformUserRecord | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_users', columns: USER_COLUMNS, where: eq(col('id'), lit(id)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UserRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToUser(rows[0]);
  }

  async identitiesOf(userId: string): Promise<UserIdentityRecord[]> {
    const rows = await this.#db.query<{
      id: string;
      provider: string;
      provider_user_id: string;
      verified_at: string | Date | null;
      created_at: string | Date;
    }>(
      'SELECT id, provider, provider_user_id, verified_at, created_at FROM ag_identities WHERE user_id = $1 ORDER BY provider, provider_user_id',
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      providerUserId: row.provider_user_id,
      verifiedAt: row.verified_at === null ? null : new Date(row.verified_at as string),
      createdAt: new Date(row.created_at as string),
    }));
  }

  async setStatus(id: string, status: UserStatus): Promise<PlatformUserRecord | undefined> {
    const compiled = compile(
      { kind: 'update', table: 'ag_users', set: { status, updated_at: new Date() }, where: eq(col('id'), lit(id)), returning: USER_COLUMNS },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UserRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToUser(rows[0]);
  }

  async setTags(id: string, tags: readonly string[]): Promise<PlatformUserRecord | undefined> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_users',
        // ★ 与内存实现同语义：去重 + 排序（否则两个实现的「标签是否变化」判断会不同）
        set: { tags: JSON.stringify([...new Set(tags)].sort()), updated_at: new Date() },
        where: eq(col('id'), lit(id)),
        returning: USER_COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UserRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToUser(rows[0]);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它）。 */
export function createTransactionalUserAdminStore(db: Db): UserAdminStore {
  const inner = new DbUserAdminStore(db);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    list: (input) => wrap(() => inner.list(input)),
    get: (id) => wrap(() => inner.get(id)),
    identitiesOf: (userId) => wrap(() => inner.identitiesOf(userId)),
    setStatus: (id, status) => wrap(() => inner.setStatus(id, status)),
    setTags: (id, tags) => wrap(() => inner.setTags(id, tags)),
  };
}
