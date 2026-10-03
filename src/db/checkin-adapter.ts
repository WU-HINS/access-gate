/**
 * 签到资格的 PG 适配器（`ag_checkin_entitlements`）—— 补齐 `docs/02 §6.4` 声明的表。
 *
 * ★ 为什么需要它：`checkin:grant` / `checkin:revoke` 此前写进程内 `Map`
 *   （见 `src/core/checkin.ts` 文件头）——**重启后资格丢失**。
 *
 * ★ 幂等由**数据库约束**承担，而不是靠调用方自觉：
 *   · `grant`   → `INSERT … ON CONFLICT (site_id, user_id, scope) DO UPDATE`
 *                 ★ `updateColumns` **不含 `granted_at`** → 重复授予不改变首次授予时间；
 *                 ★ 只清 `revoked_at`（`EXCLUDED.revoked_at = NULL`）→ 重新授予生效。
 *   · `revoke`  → `UPDATE … WHERE revoked_at IS NULL` → 已撤销时零行受影响（幂等），
 *                 且**不会**为「从未授予」的资格创建空行。
 *
 * ★ 站点作用域：表声明为 `siteScoped: true`，因此站点过滤由**查询编译器注入**
 *   （业务代码不手写 `site_id`，见 `docs/08 §7` 的三条硬规则）。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, isNull, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import {
  isActive,
  type CheckinEntitlement,
  type CheckinEntitlementStore,
  type CheckinGrantState,
  type CheckinRecord,
  type CheckinRecordStore,
} from '../core/checkin.ts';

const SITE_SCOPED: TableScopeMeta = { siteScoped: true, hasSiteIdColumn: true };

interface EntitlementRow extends Record<string, unknown> {
  site_id: string;
  user_id: string;
  scope: string;
  source_policy_id: string | null;
  granted_at: Date | string;
  revoked_at: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToEntitlement(row: EntitlementRow): CheckinEntitlement {
  return {
    siteId: row.site_id,
    userId: row.user_id,
    scope: row.scope,
    ...(row.source_policy_id === null ? {} : { sourcePolicyId: row.source_policy_id }),
    grantedAt: toDate(row.granted_at),
    ...(row.revoked_at === null ? {} : { revokedAt: toDate(row.revoked_at) }),
  };
}

const COLUMNS = ['site_id', 'user_id', 'scope', 'source_policy_id', 'granted_at', 'revoked_at'] as const;

export class DbCheckinEntitlementStore implements CheckinEntitlementStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  /** `siteId` 由构造时绑定（会话派生的站点作用域），因此这里忽略入参——与 `DbLifecycleStateStore` 一致。 */
  async find(_siteId: string, userId: string, scope: string): Promise<CheckinEntitlement | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_checkin_entitlements',
        columns: [...COLUMNS],
        where: and(eq(col('user_id'), lit(userId)), eq(col('scope'), lit(scope))),
        limit: 1,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<EntitlementRow>(compiled.sql, compiled.params);
    const row = rows[0];
    return row === undefined ? undefined : rowToEntitlement(row);
  }

  async listActive(_siteId: string, userId: string): Promise<CheckinEntitlement[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_checkin_entitlements',
        columns: [...COLUMNS],
        where: and(eq(col('user_id'), lit(userId)), isNull(col('revoked_at'))),
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<EntitlementRow>(compiled.sql, compiled.params);
    return rows.map(rowToEntitlement).filter(isActive);
  }

  async grant(input: {
    siteId: string;
    userId: string;
    scope: string;
    sourcePolicyId?: string;
    now?: Date;
  }): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_checkin_entitlements',
        rows: [
          {
            user_id: input.userId,
            scope: input.scope,
            source_policy_id: input.sourcePolicyId ?? null,
            granted_at: input.now ?? new Date(),
            revoked_at: null,
          },
        ],
        onConflict: {
          columns: ['site_id', 'user_id', 'scope'],
          do: 'update',
          // ★ 刻意**不含 `granted_at`**：重复授予不得改变「首次授予时间」（幂等）。
          updateColumns: ['revoked_at', 'source_policy_id'],
        },
        returning: ['id'],
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async revoke(input: { siteId: string; userId: string; scope: string; now?: Date }): Promise<void> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_checkin_entitlements',
        set: { revoked_at: input.now ?? new Date() },
        // ★ `revoked_at IS NULL` 让撤销天然幂等：已撤销的行不匹配 → 零行受影响，不报错。
        where: and(
          eq(col('user_id'), lit(input.userId)),
          eq(col('scope'), lit(input.scope)),
          isNull(col('revoked_at')),
        ),
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }
}

/**
 * 自带事务的包装（真实 PG 模式下必须用它；已在外层事务时复用）。
 * ★ 与 `createTransactionalKvStore` / `createTransactionalEndUserStore` 同一模式（R57）。
 */
export function createTransactionalCheckinEntitlementStore(db: Db, siteId: string): CheckinEntitlementStore {
  const inner = new DbCheckinEntitlementStore(db, siteId);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    find: (s, u, scope) => wrap(() => inner.find(s, u, scope)),
    listActive: (s, u) => wrap(() => inner.listActive(s, u)),
    grant: (input) => wrap(() => inner.grant(input)),
    revoke: (input) => wrap(() => inner.revoke(input)),
  };
}

// ─────────────────────────── 签到记录（`ag_checkin_records`） ───────────────────────────

interface CheckinRecordRow extends Record<string, unknown> {
  site_id: string;
  user_id: string;
  checkin_date: Date | string;
  quota_awarded: number;
  grant_state: CheckinGrantState;
  request_id: string | null;
  grant_via: string;
  provider_log_id: string | number | null;
  streak: number;
}

/** `date` 列在 pg 下可能回传 `Date` 或字符串——统一成 `YYYY-MM-DD`。 */
function toDateString(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/** `bigint` 列默认回传字符串（防精度丢失）——这里显式转数字。 */
function toOptionalNumber(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rowToCheckinRecord(row: CheckinRecordRow): CheckinRecord {
  const providerLogId = toOptionalNumber(row.provider_log_id);
  return {
    siteId: row.site_id,
    userId: row.user_id,
    checkinDate: toDateString(row.checkin_date),
    quotaAwarded: row.quota_awarded,
    grantState: row.grant_state,
    grantVia: row.grant_via,
    streak: row.streak,
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    ...(providerLogId === undefined ? {} : { providerLogId }),
  };
}

const RECORD_COLUMNS = [
  'site_id',
  'user_id',
  'checkin_date',
  'quota_awarded',
  'grant_state',
  'request_id',
  'grant_via',
  'provider_log_id',
  'streak',
] as const;

export class DbCheckinRecordStore implements CheckinRecordStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  /**
   * ★ **幂等锚点**：`ON CONFLICT … DO NOTHING` + `RETURNING id`。
   *   冲突时 PG 不返回行 → `rows.length === 0` → 调用方据此判「今日已签到」。
   *   `DO NOTHING` 而不是 `DO UPDATE`：**绝不能覆盖**已存在的记录
   *   （否则重放会把 `confirmed` 打回 `pending`，破坏对账依据）。
   */
  async tryInsert(record: CheckinRecord): Promise<boolean> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_checkin_records',
        rows: [
          {
            user_id: record.userId,
            checkin_date: record.checkinDate,
            quota_awarded: record.quotaAwarded,
            grant_state: record.grantState,
            grant_via: record.grantVia,
            streak: record.streak,
            ...(record.requestId === undefined ? {} : { request_id: record.requestId }),
          },
        ],
        onConflict: { columns: ['site_id', 'user_id', 'checkin_date'], do: 'nothing' },
        returning: ['id'],
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<{ id: string }>(compiled.sql, compiled.params);
    return rows.length > 0;
  }

  async find(_siteId: string, userId: string, checkinDate: string): Promise<CheckinRecord | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_checkin_records',
        columns: [...RECORD_COLUMNS],
        where: and(eq(col('user_id'), lit(userId)), eq(col('checkin_date'), lit(checkinDate))),
        limit: 1,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<CheckinRecordRow>(compiled.sql, compiled.params);
    const row = rows[0];
    return row === undefined ? undefined : rowToCheckinRecord(row);
  }

  async listRecent(_siteId: string, userId: string, limit: number): Promise<CheckinRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_checkin_records',
        columns: [...RECORD_COLUMNS],
        where: eq(col('user_id'), lit(userId)),
        orderBy: [{ column: 'checkin_date', direction: 'desc' }],
        limit,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<CheckinRecordRow>(compiled.sql, compiled.params);
    return rows.map(rowToCheckinRecord);
  }

  async markGranted(input: {
    siteId: string;
    userId: string;
    checkinDate: string;
    providerLogId?: number;
    requestId?: string;
  }): Promise<void> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_checkin_records',
        set: {
          grant_state: 'confirmed',
          ...(input.providerLogId === undefined ? {} : { provider_log_id: input.providerLogId }),
          ...(input.requestId === undefined ? {} : { request_id: input.requestId }),
        },
        where: and(
          eq(col('user_id'), lit(input.userId)),
          eq(col('checkin_date'), lit(input.checkinDate)),
        ),
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async markUnknown(input: {
    siteId: string;
    userId: string;
    checkinDate: string;
    error: string;
  }): Promise<void> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_checkin_records',
        // ★ 记 unknown（而不是 pending）：超时后**无法判定**下游是否已发，
        //   只有对账核销能定性——自动重发会把「不确定」变成「确定多给」。
        set: { grant_state: 'unknown', request_id: input.error.slice(0, 64) },
        where: and(
          eq(col('user_id'), lit(input.userId)),
          eq(col('checkin_date'), lit(input.checkinDate)),
        ),
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }
}

/** 自带事务的包装（真实 PG 模式下必须用它；已在外层事务时复用）。 */
export function createTransactionalCheckinRecordStore(db: Db, siteId: string): CheckinRecordStore {
  const inner = new DbCheckinRecordStore(db, siteId);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    tryInsert: (record) => wrap(() => inner.tryInsert(record)),
    find: (s, u, d) => wrap(() => inner.find(s, u, d)),
    listRecent: (s, u, limit) => wrap(() => inner.listRecent(s, u, limit)),
    markGranted: (input) => wrap(() => inner.markGranted(input)),
    markUnknown: (input) => wrap(() => inner.markUnknown(input)),
  };
}
