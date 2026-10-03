/**
 * 断言流水与撤销（`ag_verify_assertions`）—— P0（安全关键）。
 *
 * ★★ 本模块最重要的一条：**撤销必须幂等且立即生效**。
 *   撤销是「发现异常后止血」的动作——若它需要重试（或重复调用会报错），
 *   运维在最紧张的时刻会怀疑「到底撤没撤掉」。
 *   因此：重复撤销**保留首次撤销时间**（那是「什么时候发现的」的证据），
 *   并始终返回当前状态。
 *
 * ★ 表结构的两个易错点（**都先查了迁移产物**）：
 *   1. `id` 是 **`bigserial`**（不是 uuid）——路径参数是**数字**，
 *      与 `ag_verify_clients.id`（uuid）不同；
 *   2. `via` 的枚举是 `'direct' | 'challenge' | 'event'`。
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { and, col, eq, gt, isNull, lit, type Condition } from '../query/ast.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export type AssertionVia = 'direct' | 'challenge' | 'event';

export interface AssertionRecord {
  /** ★ `bigserial` → 数字（不是 uuid） */
  id: number;
  clientId: string;
  subjectType: string;
  subjectValue: string;
  matched: boolean;
  via: AssertionVia;
  /** 断言内容（管理员可见——审计需要） */
  claims: Record<string, unknown>;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ListAssertionsInput {
  clientId?: string;
  /** 只看未撤销且未过期的（默认只看全部） */
  onlyActive?: boolean;
  limit: number;
  offset: number;
}

export interface AssertionAdminStore {
  list(input: ListAssertionsInput): Promise<{ assertions: AssertionRecord[]; total: number; hasMore: boolean }>;
  get(id: number): Promise<AssertionRecord | undefined>;
  /**
   * 撤销（**幂等**：已撤销时保留首次撤销时间并返回当前状态）。
   */
  revoke(id: number, at: Date): Promise<{ record: AssertionRecord; alreadyRevoked: boolean } | undefined>;
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryAssertionAdminStore implements AssertionAdminStore {
  private readonly records = new Map<number, AssertionRecord>();
  seed(record: AssertionRecord): void {
    this.records.set(record.id, { ...record, claims: { ...record.claims } });
  }

  async list(input: ListAssertionsInput): Promise<{ assertions: AssertionRecord[]; total: number; hasMore: boolean }> {
    const now = Date.now();
    const filtered = [...this.records.values()]
      .filter((record) => {
        if (input.clientId !== undefined && record.clientId !== input.clientId) return false;
        if (input.onlyActive === true && (record.revokedAt !== null || record.expiresAt.getTime() <= now)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const page = filtered.slice(input.offset, input.offset + Math.max(1, input.limit - 1));
    return { assertions: page.map((record) => ({ ...record })), total: page.length, hasMore: input.offset + page.length < filtered.length };
  }

  async get(id: number): Promise<AssertionRecord | undefined> {
    const found = this.records.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async revoke(id: number, at: Date): Promise<{ record: AssertionRecord; alreadyRevoked: boolean } | undefined> {
    const found = this.records.get(id);
    if (found === undefined) return undefined;
    if (found.revokedAt !== null) return { record: { ...found }, alreadyRevoked: true };
    const next: AssertionRecord = { ...found, revokedAt: at };
    this.records.set(id, next);
    return { record: { ...next }, alreadyRevoked: false };
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface AssertionRow extends Record<string, unknown> {
  id: string | number;
  client_id: string;
  subject_type: string;
  subject_value: string;
  matched: boolean;
  via: string;
  claims: Record<string, unknown> | string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

const COLUMNS = ['id', 'client_id', 'subject_type', 'subject_value', 'matched', 'via', 'claims', 'expires_at', 'revoked_at', 'created_at'];

function rowToRecord(row: AssertionRow): AssertionRecord {
  return {
    // ★ bigserial 在 pg 里可能以字符串返回（大整数保护），这里显式转数字
    id: typeof row.id === 'string' ? Number.parseInt(row.id, 10) : row.id,
    clientId: row.client_id,
    subjectType: row.subject_type,
    subjectValue: row.subject_value,
    matched: row.matched === true,
    via: row.via as AssertionVia,
    claims: typeof row.claims === 'string' ? (JSON.parse(row.claims) as Record<string, unknown>) : row.claims,
    expiresAt: new Date(row.expires_at as string),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at as string),
    createdAt: new Date(row.created_at as string),
  };
}

export class DbAssertionAdminStore implements AssertionAdminStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async list(input: ListAssertionsInput): Promise<{ assertions: AssertionRecord[]; total: number; hasMore: boolean }> {
    // ★ 条件完全走编译器（`and` / `eq` / `isNull`），不手写 SQL——
    //   这样既安全，也能通过 CI 的裸 SQL 扫描（R26 的教训）。
    const conditions: Condition[] = [];
    if (input.clientId !== undefined) conditions.push(eq(col('client_id'), lit(input.clientId)));
    if (input.onlyActive === true) {
      conditions.push(isNull(col('revoked_at')));
      // ★ 用编译器的 `gt` 辅助（手写 Condition 对象会因联合类型太宽而报错）
      conditions.push(gt(col('expires_at'), lit(new Date())));
    }
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_verify_assertions',
        columns: COLUMNS,
        ...(conditions.length === 0 ? {} : { where: and(...conditions) }),
        orderBy: [{ column: 'created_at', direction: 'desc' }],
        limit: input.limit,
        offset: input.offset,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<AssertionRow>(compiled.sql, compiled.params);
    // 与 user-store 一致：调用方传 limit+1，多取一条判断 hasMore（避免 count(*)）
    const page = rows.slice(0, Math.max(1, input.limit - 1));
    return { assertions: page.map(rowToRecord), total: page.length, hasMore: rows.length > page.length };
  }

  async get(id: number): Promise<AssertionRecord | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_verify_assertions', columns: COLUMNS, where: eq(col('id'), lit(id)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<AssertionRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async revoke(id: number, at: Date): Promise<{ record: AssertionRecord; alreadyRevoked: boolean } | undefined> {
    // ★ 幂等：只在 `revoked_at IS NULL` 时写入（保留首次撤销时间）
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_verify_assertions',
        set: { revoked_at: at },
        where: and(eq(col('id'), lit(id)), isNull(col('revoked_at'))),
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<AssertionRow>(compiled.sql, compiled.params);
    if (rows[0] !== undefined) return { record: rowToRecord(rows[0]), alreadyRevoked: false };
    // 没更新到：要么不存在，要么已经撤销过——回读区分这两种情况
    const existing = await this.get(id);
    return existing === undefined ? undefined : { record: existing, alreadyRevoked: true };
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它）。 */
export function createTransactionalAssertionAdminStore(db: Db): AssertionAdminStore {
  const inner = new DbAssertionAdminStore(db);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    list: (input) => wrap(() => inner.list(input)),
    get: (id) => wrap(() => inner.get(id)),
    revoke: (id, at) => wrap(() => inner.revoke(id, at)),
  };
}
