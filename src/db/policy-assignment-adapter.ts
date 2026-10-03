/**
 * 策略分配的 PG 存储（`ag_policy_assignments`）。
 *
 * ★ 站点作用域：所有语句都带 `site_id`（含 `remove`）。
 * ★ 仓储层（`src/db/`）：由调用方保证在事务内（`reuseOrBeginTransaction`），
 *   运行时由查询层的 `assertInTransaction` 兜底。
 */

import type { Db } from './pool.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type {
  AssignmentTargetType,
  PolicyAssignment,
  PolicyAssignmentStore,
} from '../core/policy-assignments.ts';

interface AssignmentRow extends Record<string, unknown> {
  id: string;
  policy_id: string;
  target_type: AssignmentTargetType;
  target_ref: string | null;
  rollout_percent: number;
  enabled: boolean;
  created_at: Date | string;
}

function rowToAssignment(row: AssignmentRow): PolicyAssignment {
  return {
    id: row.id,
    policyId: row.policy_id,
    targetType: row.target_type,
    ...(row.target_ref === null ? {} : { targetRef: row.target_ref }),
    rolloutPercent: row.rollout_percent,
    enabled: row.enabled,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

export class DbPolicyAssignmentStore implements PolicyAssignmentStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async list(policyId?: string): Promise<readonly PolicyAssignment[]> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<AssignmentRow>(
        policyId === undefined
          ? `SELECT id, policy_id, target_type, target_ref, rollout_percent, enabled, created_at
               FROM ag_policy_assignments
              WHERE site_id = $1
              ORDER BY created_at, id`
          : `SELECT id, policy_id, target_type, target_ref, rollout_percent, enabled, created_at
               FROM ag_policy_assignments
              WHERE site_id = $1 AND policy_id = $2
              ORDER BY created_at, id`,
        policyId === undefined ? [this.#siteId] : [this.#siteId, policyId],
      ),
    );
    return rows.map(rowToAssignment);
  }

  async put(assignment: PolicyAssignment): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () => {
      await this.#db.query(
        `INSERT INTO ag_policy_assignments
           (id, site_id, policy_id, target_type, target_ref, rollout_percent, enabled, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE
           SET policy_id = EXCLUDED.policy_id,
               target_type = EXCLUDED.target_type,
               target_ref = EXCLUDED.target_ref,
               rollout_percent = EXCLUDED.rollout_percent,
               enabled = EXCLUDED.enabled`,
        [
          assignment.id,
          this.#siteId,
          assignment.policyId,
          assignment.targetType,
          assignment.targetRef ?? null,
          assignment.rolloutPercent,
          assignment.enabled,
          assignment.createdAt,
        ],
      );
    });
  }

  async remove(id: string): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () => {
      await this.#db.query('DELETE FROM ag_policy_assignments WHERE id = $1 AND site_id = $2', [
        id,
        this.#siteId,
      ]);
    });
  }

  /**
   * ★★ **跨站点**列出全部分配（管理端统计用）。
   *
   * ★ 方法名刻意带 `CrossSite`：调用处一眼能看出"这条查询不受站点作用域约束"。
   *   而**不受约束必须有理由**——因此调用方**必须**先经过 `evaluateCrossSite()` 判定
   *   并写审计（见 `src/core/cross-site.ts`）。
   * ★ 这里**不注入 `site_id` 条件**正是"跨站点"的含义；安全性由**调用方的判定**保证，
   *   而不是由这条 SQL 保证——这正是 `crossSite()` 存在的理由：
   *   让"绕过站点隔离"成为**必须经过判定**的动作，而不是随手写一句 SQL。
   */
  async listCrossSite(): Promise<readonly PolicyAssignment[]> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<AssignmentRow>(
        `SELECT id, policy_id, target_type, target_ref, rollout_percent, enabled, created_at
           FROM ag_policy_assignments
          ORDER BY created_at, id`,
        [],
      ),
    );
    return rows.map(rowToAssignment);
  }
}
