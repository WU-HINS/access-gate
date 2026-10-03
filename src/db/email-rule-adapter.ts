/**
 * 邮箱准入规则的 PG 存储（`ag_email_rules`）。
 *
 * ★ 仓储层（`src/db/`）：由调用方保证在事务内（`reuseOrBeginTransaction` 已包好每个方法），
 *   运行时由查询层的 `assertInTransaction` 兜底。
 * ★ 站点作用域：所有查询都带 `site_id`——准入规则是**站点级**的（`docs/08 §5`）。
 */

import type { Db } from './pool.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { EmailMatchType, EmailListType, EmailRule, EmailRuleStore } from '../core/email-rules.ts';

interface RuleRow extends Record<string, unknown> {
  id: string;
  list_type: EmailListType;
  match_type: EmailMatchType;
  pattern: string;
  priority: number;
  note: string | null;
  enabled: boolean;
  created_at: Date | string;
}

function rowToRule(row: RuleRow): EmailRule {
  return {
    id: row.id,
    listType: row.list_type,
    matchType: row.match_type,
    pattern: row.pattern,
    priority: row.priority,
    ...(row.note === null ? {} : { note: row.note }),
    enabled: row.enabled,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

export class DbEmailRuleStore implements EmailRuleStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async list(): Promise<readonly EmailRule[]> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<RuleRow>(
        `SELECT id, list_type, match_type, pattern, priority, note, enabled, created_at
           FROM ag_email_rules
          WHERE site_id = $1
          ORDER BY priority, id`,
        [this.#siteId],
      ),
    );
    return rows.map(rowToRule);
  }

  async put(rule: EmailRule): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () => {
      await this.#db.query(
        `INSERT INTO ag_email_rules
           (id, site_id, list_type, match_type, pattern, priority, note, enabled, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE
           SET list_type = EXCLUDED.list_type,
               match_type = EXCLUDED.match_type,
               pattern = EXCLUDED.pattern,
               priority = EXCLUDED.priority,
               note = EXCLUDED.note,
               enabled = EXCLUDED.enabled`,
        [
          rule.id,
          this.#siteId,
          rule.listType,
          rule.matchType,
          rule.pattern,
          rule.priority,
          rule.note ?? null,
          rule.enabled,
          rule.createdAt,
        ],
      );
    });
  }

  async remove(id: string): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () => {
      // ★ 带 `site_id`：跨站点删规则必须是**做不到**的（而不是"靠调用方记得过滤"）
      await this.#db.query('DELETE FROM ag_email_rules WHERE id = $1 AND site_id = $2', [
        id,
        this.#siteId,
      ]);
    });
  }
}
