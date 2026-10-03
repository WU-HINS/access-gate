/**
 * 插件绑定的 PG 存储（`ag_plugin_bindings`）—— 实现 `BindingResolver`（`docs/04 §1.2.7.2`）。
 *
 * ★★ 为什么必须有它：`BindingResolver` 接口与 `ag_plugin_bindings` 表**都已存在**，
 *   唯独**没有 PG 实现**（表零引用）——典型的「上游产物已就绪、下游没消费」。
 *   后果很具体：`subject:newapi.group` 这类**跨系统寻址**在真实模式下解析不到主体，
 *   一律落到 `missing` → 按 H1 保持 `indeterminate` → **策略永远"差这一项"而没人知道为什么**。
 *
 * ★★ 一处**契约不一致**的显式处理（不擅自改任一侧）：
 *   · 表的状态有 5 个：`unbound | bound | stale | revoked | failed`
 *   · 而 `BindingRecord.status` 只有 3 个：`active | revoked | pending`
 *   两者各有理由（表要区分"过期"与"失败"，接口只需回答"能不能用"）。
 *   这里做**显式映射**并在下面写清规则——而不是让两套枚举各自演化、某天突然对不上：
 *     `bound → active`；`revoked → revoked`；`unbound / stale / failed → pending`
 *   （`stale` 与 `failed` 都归 `pending` 而非 `active`：它们**都不能用来解析主体**，
 *     而"为什么不能"由 `lastError` / `lastFactAt` 列回答。）
 *
 * ★ 撤销用**软撤销**（`status='revoked'`，不删行）：绑定历史是审计线索，
 *   而 `find()` 仍会返回它（带 `revoked` 状态），由调用方判 `status !== 'active'` → `missing(revoked)`。
 */

import type { Db } from './pool.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { BindingRecord } from '../policy/addressing.ts';

/** 表里的 5 态 → 接口的 3 态（规则见文件头） */
export function toBindingStatus(status: string): BindingRecord['status'] {
  if (status === 'bound') return 'active';
  if (status === 'revoked') return 'revoked';
  return 'pending'; // unbound / stale / failed
}

/** 接口的 3 态 → 表里的 5 态（写入方向） */
export function toStoredStatus(status: BindingRecord['status']): string {
  if (status === 'active') return 'bound';
  if (status === 'revoked') return 'revoked';
  return 'unbound';
}

interface BindingRow extends Record<string, unknown> {
  user_id: string;
  plugin_id: string;
  instance_key: string;
  external_id: string | null;
  status: string;
}

function rowToRecord(row: BindingRow): BindingRecord {
  return {
    pluginId: row.plugin_id,
    instanceKey: row.instance_key,
    externalId: row.external_id ?? '',
    status: toBindingStatus(row.status),
  };
}

export interface PluginBindingStore {
  /** 按 (平台用户, 插件, 实例) 查绑定（`BindingResolver.find`） */
  find(userId: string, pluginId: string, instanceKey: string): Promise<BindingRecord | undefined>;
  /** 该用户在**本站点**的全部绑定 */
  listByUser(userId: string): Promise<readonly BindingRecord[]>;
  /** 落绑定（幂等：同 `(user, plugin, instance)` 覆盖，含"重新绑定"：revoked → bound） */
  upsert(input: {
    userId: string;
    pluginId: string;
    instanceKey: string;
    externalId: string;
    externalName?: string;
    status?: BindingRecord['status'];
  }): Promise<void>;
  /** **软撤销**（不删行——绑定历史是审计线索） */
  revoke(input: { userId: string; pluginId: string; instanceKey: string }): Promise<void>;
}

export class DbPluginBindingStore implements PluginBindingStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async find(userId: string, pluginId: string, instanceKey: string): Promise<BindingRecord | undefined> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<BindingRow>(
        `SELECT user_id, plugin_id, instance_key, external_id, status
           FROM ag_plugin_bindings
          WHERE site_id = $1 AND user_id = $2 AND plugin_id = $3 AND instance_key = $4
          LIMIT 1`,
        [this.#siteId, userId, pluginId, instanceKey],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToRecord(row);
  }

  async listByUser(userId: string): Promise<readonly BindingRecord[]> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<BindingRow>(
        `SELECT user_id, plugin_id, instance_key, external_id, status
           FROM ag_plugin_bindings
          WHERE site_id = $1 AND user_id = $2
          ORDER BY plugin_id, instance_key`,
        [this.#siteId, userId],
      ),
    );
    return rows.map(rowToRecord);
  }

  async upsert(input: {
    userId: string;
    pluginId: string;
    instanceKey: string;
    externalId: string;
    externalName?: string;
    status?: BindingRecord['status'];
  }): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () => {
      await this.#db.query(
        `INSERT INTO ag_plugin_bindings
           (site_id, user_id, plugin_id, instance_key, external_id, external_name, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (site_id, user_id, plugin_id, instance_key) DO UPDATE
           SET external_id = EXCLUDED.external_id,
               external_name = EXCLUDED.external_name,
               status = EXCLUDED.status,
               updated_at = now()`,
        [
          this.#siteId,
          input.userId,
          input.pluginId,
          input.instanceKey,
          input.externalId,
          input.externalName ?? null,
          toStoredStatus(input.status ?? 'active'),
        ],
      );
    });
  }

  async revoke(input: { userId: string; pluginId: string; instanceKey: string }): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () => {
      // ★ 只改状态、**不删行**：绑定历史是审计线索（"谁在何时解绑过"）。
      // ★ 已经 revoked 时零行受影响，天然幂等。
      await this.#db.query(
        `UPDATE ag_plugin_bindings
            SET status = 'revoked', updated_at = now()
          WHERE site_id = $1 AND user_id = $2 AND plugin_id = $3 AND instance_key = $4
            AND status <> 'revoked'`,
        [this.#siteId, input.userId, input.pluginId, input.instanceKey],
      );
    });
  }
}
