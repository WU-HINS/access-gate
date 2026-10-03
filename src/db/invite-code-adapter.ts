/**
 * 邀请码的 PG 存储（`ag_invite_codes`）。
 *
 * ★★ 核销用**单条 `UPDATE … WHERE … RETURNING`**（见 `redeem`）：
 *   "检查 `used_count < max_uses`"与"递增"在同一条语句里完成，
 *   由数据库保证原子——**读-改-写会在并发下超发**。
 * ★ 站点作用域：所有语句都带 `site_id`。
 * ★ 仓储层（`src/db/`）：由调用方保证在事务内（`reuseOrBeginTransaction`），
 *   运行时由查询层的 `assertInTransaction` 兜底。
 */

import type { Db } from './pool.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { CreateInviteInput, InviteCode, InviteCodeStore, RedeemResult } from '../core/invite-codes.ts';

interface InviteRow extends Record<string, unknown> {
  id: string;
  code: string;
  created_by: string | null;
  max_uses: number;
  used_count: number;
  grants_facts: unknown;
  expires_at: Date | string | null;
  created_at: Date | string;
}

// ★ 列名刻意**写字面量**、不抽常量：CI 第 6 项禁止模板字面量里的插值
//   （即使插的是常量——那正是「裸 SQL 拼接」的形态）。下面各查询同样不用插值。

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToInvite(row: InviteRow): InviteCode {
  return {
    id: row.id,
    code: row.code,
    ...(row.created_by === null ? {} : { createdBy: row.created_by }),
    maxUses: row.max_uses,
    usedCount: row.used_count,
    grantsFacts:
      row.grants_facts !== null && typeof row.grants_facts === 'object'
        ? (row.grants_facts as Record<string, unknown>)
        : {},
    expiresAt: row.expires_at === null ? null : toDate(row.expires_at),
    createdAt: toDate(row.created_at),
  };
}

export class DbInviteCodeStore implements InviteCodeStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async list(): Promise<readonly InviteCode[]> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<InviteRow>(
        `SELECT id, code, created_by, max_uses, used_count, grants_facts, expires_at, created_at FROM ag_invite_codes WHERE site_id = $1 ORDER BY created_at, code`,
        [this.#siteId],
      ),
    );
    return rows.map(rowToInvite);
  }

  async create(input: CreateInviteInput): Promise<InviteCode> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<InviteRow>(
        `INSERT INTO ag_invite_codes
           (site_id, code, created_by, max_uses, used_count, grants_facts, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 0, $5::jsonb, $6, $7)
         RETURNING id, code, created_by, max_uses, used_count, grants_facts, expires_at, created_at`,
        [
          this.#siteId,
          input.code,
          input.createdBy ?? null,
          input.maxUses ?? 1,
          JSON.stringify(input.grantsFacts ?? {}),
          input.expiresAt ?? null,
          input.now,
        ],
      ),
    );
    return rowToInvite(rows[0]!);
  }

  /**
   * ★★ **原子核销**：检查与递增在同一条语句里。
   *
   * ★ 0 行受影响时**再查一次**以区分原因（`not_found` / `expired` / `exhausted`）——
   *   用户需要知道"邀请码不存在"还是"已被用完"，这两者的处置完全不同。
   */
  async redeem(input: { code: string; now: Date }): Promise<RedeemResult> {
    const updated = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<InviteRow>(
        `UPDATE ag_invite_codes
            SET used_count = used_count + 1
          WHERE site_id = $1 AND code = $2
            AND (expires_at IS NULL OR expires_at > $3)
            AND used_count < max_uses
          RETURNING id, code, created_by, max_uses, used_count, grants_facts, expires_at, created_at`,
        [this.#siteId, input.code, input.now],
      ),
    );
    if (updated[0] !== undefined) return { ok: true, invite: rowToInvite(updated[0]) };

    // 未更新成功 → 查原因（只读，不改变状态）
    const existing = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<InviteRow>(
        `SELECT id, code, created_by, max_uses, used_count, grants_facts, expires_at, created_at FROM ag_invite_codes WHERE site_id = $1 AND code = $2 LIMIT 1`,
        [this.#siteId, input.code],
      ),
    );
    const row = existing[0];
    if (row === undefined) return { ok: false, reason: 'not_found' };
    if (row.expires_at !== null && toDate(row.expires_at).getTime() <= input.now.getTime()) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: false, reason: 'exhausted' };
  }

  async remove(id: string): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () => {
      await this.#db.query('DELETE FROM ag_invite_codes WHERE id = $1 AND site_id = $2', [
        id,
        this.#siteId,
      ]);
    });
  }
}
