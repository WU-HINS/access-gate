/**
 * 开发者邀请码的 PG 适配器（`ag_dev_invitations`）—— P0-1 的一半。
 *
 * ★★★ 为什么它是「阻塞上线」的一环：
 *   开发者**入驻**需要「邀请码 → 核销 → 写身份映射」三步。此前：
 *   · `InvitationStore` **只有内存实现**（重启即丢，多实例失效）；
 *   · 且**没有任何入驻端点**（`recordDeveloperIdentity` 无调用点）。
 *   → **上线后没有任何开发者能登录**。
 *
 * ★★ `consume()` 必须**原子**（接口注释已写明）：
 *   「PG 实现用单条 `UPDATE … WHERE …` + 影响行数判断」。
 *   ★ 若写成「先 SELECT 判断、再 UPDATE」：两个并发请求会**都**读到「还有额度」，
 *     于是同一个一次性邀请码被用两次——**邀请码的「一次性」语义失效**。
 *   ★ 因此这里用**单条 UPDATE**：把「条件」与「占用」放进同一条语句，
 *     由数据库保证只有一个并发事务能更新到那一行。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, gt, increment, lit, lt } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { Invitation, InvitationStore, SiteMode } from '../core/invitations.ts';

/**
 * ★ `ag_dev_invitations` 是**站点级**表（`site_id NOT NULL`）。
 *
 * ★ 这里**不使用**编译器的站点作用域注入，而是**显式**在 where 里带 `site_id`——
 *   因为本表的查询键（`codeHash`）与站点共同构成业务语义，
 *   且 `consume` 需要把 `site_id` 放进 UPDATE 的 WHERE 里做原子条件。
 *   ★ 因此元信息声明为「非站点级」，**并由本文件的每一处查询显式带上 `site_id`**。
 *   ★ 这是刻意的例外，理由是「原子 UPDATE 需要完全掌控 WHERE 子句」。
 *   ⚠️ 代价：若有人漏写 `site_id`，编译器**不会**拦。
 *     缓解：本文件只有 4 个方法，且每个 where 都在同一屏内可见（见 `test/pg-real.test.ts` 的隔离测试）。
 */
const SITE_SCOPED_BY_HAND: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: true };

interface InvitationRow extends Record<string, unknown> {
  id: string;
  site_id: string;
  code_hash: string;
  code_prefix: string;
  target_email: string;
  site_mode: string;
  max_uses: number;
  used_count: number;
  expires_at: string | Date;
  used_at: string | Date | null;
  used_by: string | null;
  created_by: string;
  created_at: string | Date;
}

const COLUMNS = [
  'id', 'site_id', 'code_hash', 'code_prefix', 'target_email', 'site_mode',
  'max_uses', 'used_count', 'expires_at', 'used_at', 'used_by', 'created_by', 'created_at',
];

function rowToInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    siteId: row.site_id,
    codeHash: row.code_hash,
    codePrefix: row.code_prefix,
    targetEmail: row.target_email,
    siteMode: row.site_mode as SiteMode,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: new Date(row.expires_at as string),
    usedAt: row.used_at === null ? null : new Date(row.used_at as string),
    usedBy: row.used_by,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at as string),
  };
}

export class DbInvitationStore implements InvitationStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async save(invitation: Invitation): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_dev_invitations',
        rows: [
          {
            id: invitation.id,
            site_id: invitation.siteId,
            code_hash: invitation.codeHash,
            code_prefix: invitation.codePrefix,
            target_email: invitation.targetEmail,
            site_mode: invitation.siteMode,
            max_uses: invitation.maxUses,
            used_count: invitation.usedCount,
            expires_at: invitation.expiresAt,
            used_at: invitation.usedAt,
            used_by: invitation.usedBy,
            created_by: invitation.createdBy,
            created_at: invitation.createdAt,
          },
        ],
        returning: ['id'],
        // ★ 同一 id 重复保存 → 更新（幂等）
        onConflict: {
          columns: ['id'],
          do: 'update',
          updateColumns: ['used_count', 'used_at', 'used_by'],
        },
      },
      SITE_SCOPED_BY_HAND,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async findByHash(siteId: string, codeHash: string): Promise<Invitation | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_dev_invitations',
        columns: COLUMNS,
        // ★ 显式带 site_id（见文件头的说明）
        where: and(eq(col('site_id'), lit(siteId)), eq(col('code_hash'), lit(codeHash))),
        limit: 1,
      },
      SITE_SCOPED_BY_HAND,
      {},
    );
    const rows = await this.#db.query<InvitationRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToInvitation(rows[0]);
  }

  /**
   * **原子核销**（★ 单条 UPDATE，见文件头说明）。
   *
   * 条件（全部放进 `WHERE`，与「占用」同一条语句）：
   *   ① 站点匹配；② hash 匹配；
   *   ③ **未过期**（`expires_at > now`）；
   *   ④ **未用尽**（`used_count < max_uses`）。
   *
   * 返回 `false` = 条件不满足 **或** 被并发抢占——两者对调用方等价：**不能建号**。
   */
  async consume(siteId: string, codeHash: string, usedBy: string, now: Date): Promise<boolean> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_dev_invitations',
        // ★ 占用一次额度，并记录「谁用的、何时用的」
        set: {
          // ★ 用编译器的 `increment`（`SetValue = SqlValue | ColumnExpression`）——
          //   它把 `used_count + 1` 编译成参数化 SQL，而不是字符串拼接。
          used_count: increment('used_count'),
          used_at: now,
          used_by: usedBy,
        },
        where: and(
          eq(col('site_id'), lit(siteId)),
          eq(col('code_hash'), lit(codeHash)),
          gt(col('expires_at'), lit(now)),
          // ★ 「未用尽」是**列与列**比较（`used_count < max_uses`）——
          //   `lt(left: Operand, right: Operand)` 支持它（两侧都是 Operand）。
          lt(col('used_count'), col('max_uses')),
        ),
        returning: ['id'],
      },
      SITE_SCOPED_BY_HAND,
      {},
    );
    const rows = await this.#db.query<{ id: string }>(compiled.sql, compiled.params);
    // ★ 影响行数为 1 = 核销成功；为 0 = 条件不满足或已被抢占
    return rows.length > 0;
  }

  async list(siteId: string): Promise<Invitation[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_dev_invitations',
        columns: COLUMNS,
        where: eq(col('site_id'), lit(siteId)),
        orderBy: [{ column: 'created_at', direction: 'desc' }],
      },
      SITE_SCOPED_BY_HAND,
      {},
    );
    const rows = await this.#db.query<InvitationRow>(compiled.sql, compiled.params);
    return rows.map(rowToInvitation);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalInvitationStore(db: Db): InvitationStore {
  const inner = new DbInvitationStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    save: (invitation) => wrap(() => inner.save(invitation)),
    findByHash: (siteId, codeHash) => wrap(() => inner.findByHash(siteId, codeHash)),
    consume: (siteId, codeHash, usedBy, now) => wrap(() => inner.consume(siteId, codeHash, usedBy, now)),
    list: (siteId) => wrap(() => inner.list(siteId)),
  };
}
