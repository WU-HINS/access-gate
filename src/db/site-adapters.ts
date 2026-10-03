/**
 * 开发者与站点的 PostgreSQL 适配器 —— 让多站点模式**真正持久化**
 * （此前只有内存实现，重启即丢，见上一轮登记的缺口）。
 *
 * ★ 两张表都是**平台级**（不带站点作用域注入）：
 *   - `ag_developers`：开发者域，按 R3 豁免清单（「开发者域」）；
 *   - `ag_sites`：站点表本身——它的 `site_id` 列是 **slug**（面向 URL 与寻址），
 *     **不是**作用域引用。若对它注入 `site_id = <当前站点>`，语义会变成
 *     「查我自己」，因此这里显式用 `PLATFORM`（不注入）。
 *
 * ★ 字段映射的两处易错点（都以迁移产物为准）：
 *   1. `Developer.status` 的取值是 `active | suspended | deleted`
 *      （**没有** `pending`——早期凭直觉加的值会被枚举拒绝）；
 *   2. `Site` 有**两个标识**：`id`（内部 uuid）与 `siteId`（slug）。
 *      写反会让「换 slug」变成「换站点身份」。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { col, eq, lit, type SqlValue } from '../query/ast.ts';
import type { Developer, DeveloperRole, DeveloperStatus, Site, SiteQuota, SiteRegistry, SiteStatus } from '../core/sites.ts';
import { assertValidSiteSlug, SiteError } from '../core/sites.ts';

/** 平台级表：不注入站点作用域（`ag_sites.site_id` 是 slug，不是作用域引用）。 */
const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

function jsonb(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

interface DeveloperRow extends Record<string, unknown> {
  id: string;
  username: string;
  display_name: string;
  email: string;
  email_verified: boolean;
  role: string;
  status: string;
  locale: string | null;
  last_login_at: string | Date | null;
  created_at: string | Date;
}

interface SiteRow extends Record<string, unknown> {
  id: string;
  site_id: string;
  nickname: string;
  developer_id: string;
  status: string;
  quota: Record<string, unknown> | string | null;
  settings: Record<string, unknown> | string | null;
  created_at: string | Date;
}

const DEVELOPER_COLUMNS = ['id', 'username', 'display_name', 'email', 'email_verified', 'role', 'status', 'locale', 'last_login_at', 'created_at'];
const SITE_COLUMNS = ['id', 'site_id', 'nickname', 'developer_id', 'status', 'quota', 'settings', 'created_at'];

function rowToDeveloper(row: DeveloperRow): Developer {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    emailVerified: row.email_verified === true,
    role: row.role as DeveloperRole,
    status: row.status as DeveloperStatus,
    ...(row.locale === null ? {} : { locale: row.locale }),
    lastLoginAt: row.last_login_at === null ? null : toDate(row.last_login_at),
    createdAt: toDate(row.created_at),
  };
}

function parseJson<T>(value: Record<string, unknown> | string | null, fallback: T): T {
  if (value === null) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function rowToSite(row: SiteRow): Site {
  return {
    id: row.id,
    siteId: row.site_id,
    nickname: row.nickname,
    developerId: row.developer_id,
    status: row.status as SiteStatus,
    quota: parseJson<SiteQuota>(row.quota, {}),
    settings: parseJson<Record<string, unknown>>(row.settings, {}),
    createdAt: toDate(row.created_at),
  };
}

/**
 * 开发者与站点的 PG 实现。
 *
 * 说明：本适配器的每个方法都是**独立的短操作**，因此都需要调用方在事务内
 * （`Db.query` 的 `assertInTransaction` 在运行时强制）。
 */
export class DbSiteRegistry implements SiteRegistry {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // ─────────────────────────── 开发者 ───────────────────────────

  async createDeveloper(input: {
    username: string;
    displayName: string;
    email: string;
    role?: DeveloperRole;
    emailVerified?: boolean;
    id?: string;
  }): Promise<Developer> {
    const existing = await this.findDeveloperByUsername(input.username);
    if (existing !== undefined) {
      throw new SiteError('username_taken', `用户名 '${input.username}' 已被占用`);
    }
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_developers',
        rows: [
          {
            id: input.id ?? randomUUID(),
            username: input.username,
            display_name: input.displayName,
            email: input.email,
            email_verified: input.emailVerified ?? false,
            role: input.role ?? 'developer',
            status: 'active',
          },
        ],
        returning: DEVELOPER_COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<DeveloperRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) throw new SiteError('not_found', '创建开发者失败：未返回行');
    return rowToDeveloper(row);
  }

  async findDeveloper(id: string): Promise<Developer | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_developers', columns: DEVELOPER_COLUMNS, where: eq(col('id'), lit(id)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<DeveloperRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToDeveloper(rows[0]);
  }

  /**
   * 用户名大小写不敏感（与内存实现一致）。
   *
   * ★ 这里**手写 SQL**而不是走查询编译器：`lower(username) = lower($1)`
   *   是函数式比较，编译器（只支持列与字面量）表达不了。
   *   但列清单**显式写出**、值走 `$1` 参数——没有字符串插值，
   *   因此既满足「禁拼接 SQL」的意图，也不必进白名单。
   */
  async findDeveloperByUsername(username: string): Promise<Developer | undefined> {
    const rows = await this.#db.query<DeveloperRow>(
      'SELECT id, username, display_name, email, email_verified, role, status, locale, last_login_at, created_at' +
        ' FROM ag_developers WHERE lower(username) = lower($1) LIMIT 1',
      [username],
    );
    return rows[0] === undefined ? undefined : rowToDeveloper(rows[0]);
  }

  async setDeveloperStatus(id: string, status: DeveloperStatus): Promise<void> {
    const compiled = compile(
      { kind: 'update', table: 'ag_developers', set: { status }, where: eq(col('id'), lit(id)) },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  /** 列出全部开发者 id（供两级选择的第一级；由宿主决定可见范围）。 */
  async listDeveloperIds(): Promise<string[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_developers',
        columns: ['id'],
        where: eq(col('status'), lit('active')),
        orderBy: [{ column: 'created_at', direction: 'asc' }],
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ id: string }>(compiled.sql, compiled.params);
    return rows.map((row) => row.id);
  }

  // ─────────────────────────── 站点 ───────────────────────────

  async createSite(input: {
    siteId: string;
    nickname: string;
    developerId: string;
    quota?: SiteQuota;
    settings?: Record<string, unknown>;
    id?: string;
  }): Promise<Site> {
    // slug 校验复用核心逻辑（**不重复实现**：两处校验迟早不一致）
    assertValidSiteSlug(input.siteId);
    const existing = await this.findSite(input.siteId);
    if (existing !== undefined) throw new SiteError('slug_taken', `站点 slug '${input.siteId}' 已被占用`);
    const developer = await this.findDeveloper(input.developerId);
    if (developer === undefined) {
      throw new SiteError('developer_missing', `开发者 '${input.developerId}' 不存在（站点必须归属一个开发者）`);
    }
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_sites',
        rows: [
          {
            id: input.id ?? randomUUID(),
            site_id: input.siteId,
            nickname: input.nickname,
            developer_id: input.developerId,
            status: 'active',
            quota: jsonb(input.quota ?? {}),
            settings: jsonb(input.settings ?? {}),
          },
        ],
        returning: SITE_COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SiteRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) throw new SiteError('not_found', '创建站点失败：未返回行');
    return rowToSite(row);
  }

  async findSite(siteId: string): Promise<Site | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_sites', columns: SITE_COLUMNS, where: eq(col('site_id'), lit(siteId)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SiteRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToSite(rows[0]);
  }

  async listSitesOf(developerId: string): Promise<Site[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_sites',
        columns: SITE_COLUMNS,
        where: eq(col('developer_id'), lit(developerId)),
        orderBy: [{ column: 'site_id', direction: 'asc' }],
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SiteRow>(compiled.sql, compiled.params);
    return rows.map(rowToSite);
  }

  async setSiteStatus(siteId: string, status: SiteStatus): Promise<void> {
    const compiled = compile(
      { kind: 'update', table: 'ag_sites', set: { status }, where: eq(col('site_id'), lit(siteId)) },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async updateSiteQuota(siteId: string, quota: SiteQuota): Promise<void> {
    const compiled = compile(
      { kind: 'update', table: 'ag_sites', set: { quota: jsonb(quota) as SqlValue }, where: eq(col('site_id'), lit(siteId)) },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }
}

/** 便捷：列出所有「有活跃站点」的开发者 id（两级选择第一级的默认范围）。 */
export async function listDevelopersWithActiveSites(db: Db): Promise<string[]> {
  const rows = await db.query<{ developer_id: string }>(
    `SELECT DISTINCT s.developer_id
       FROM ag_sites s
       JOIN ag_developers d ON d.id = s.developer_id
      WHERE s.status = 'active' AND d.status = 'active'
      ORDER BY s.developer_id`,
    [],
  );
  return rows.map((row) => row.developer_id);
}

/**
 * 把 `SiteRegistry` 包装成**自带事务**的版本。
 *
 * ★ 为什么必需：`SiteRegistry` 接口没有表达「操作需要在事务内」，
 *   而 `Db.query` 有 `assertInTransaction` 断言。
 *   调用方（如 `ensureStandalone` / 两级选择）**不在**业务事务里，
 *   直接使用 `DbSiteRegistry` 会抛 `TransactionRequiredError`——
 *   这正是上一轮 `Scheduler` 遇到过的同类问题。
 *
 * ★ 为什么在这里包（而不是让每个调用方记得开事务）：
 *   站点/开发者元数据的读写都是**短操作**，逐个包事务是最简单且不会漏的做法；
 *   而把它做成工厂，调用方只需选择「内存还是 PG」，不需要知道事务细节。
 */
export function createTransactionalSiteRegistry(db: Db): SiteRegistry {
  const inner = new DbSiteRegistry(db);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    createDeveloper: (input) => wrap(() => inner.createDeveloper(input)),
    findDeveloper: (id) => wrap(() => inner.findDeveloper(id)),
    findDeveloperByUsername: (username) => wrap(() => inner.findDeveloperByUsername(username)),
    setDeveloperStatus: (id, status) => wrap(() => inner.setDeveloperStatus(id, status)),
    createSite: (input) => wrap(() => inner.createSite(input)),
    findSite: (siteId) => wrap(() => inner.findSite(siteId)),
    listSitesOf: (developerId) => wrap(() => inner.listSitesOf(developerId)),
    setSiteStatus: (siteId, status) => wrap(() => inner.setSiteStatus(siteId, status)),
    updateSiteQuota: (siteId, quota) => wrap(() => inner.updateSiteQuota(siteId, quota)),
  };
}

/** 便捷：从「事务化注册表」列出有活跃站点的开发者（第一级的默认范围）。 */
export async function listDevelopersWithActiveSitesTx(db: Db): Promise<string[]> {
  return listDevelopersWithActiveSites(db);
}
