/**
 * LLM 结果缓存的 PG 存储（`ag_llm_cache`）—— 补齐 `docs/03 §1.10` / `docs/09 §5.3` 声明的表。
 *
 * ★★ 它解决的是**成本**问题（`docs` 明确把它定性为成本而非正确性）：
 *   `src/plugin/llm-gateway.ts` 的缓存是 `private readonly cache = new Map(...)`——
 *   **重启即丢**，于是同一批主体在每次重启后都会被**重新付费**评审一遍。
 *
 * ★ 一条必须澄清、否则后人会"顺手改坏"的设计（本轮核实过）：
 *   **唯一键 `(ownerScope, ownerId, inputHash)` 不含 `model` 列是刻意的。**
 *   因为 `llm-gateway.#cacheKey()` 计算的是 `sha256(model + messages + temperature)`——
 *   **模型已经参与哈希**：换模型 → 不同 `inputHash` → 不同行，不会撞唯一键。
 *   把 `model` 加进唯一键只会造成两套并行的失效语义（改哈希口径 vs 改唯一键），
 *   反而更容易出不一致。`model` / `promptVer` 列的作用是**排障与统计**，不是键的一部分。
 *
 * ★ 过期语义与告警静默（`src/core/alert-silence.ts`）保持一致：
 *   **`get` 自己判过期**（`expires_at > now`），因此「过期即未命中」**不依赖清理任务**——
 *   否则"清理任务没跑 → 一直命中旧结果"会变成一类静默的成本/正确性问题。
 */

import type { Db } from './pool.ts';
import { reuseOrBeginTransaction } from './tx.ts';

export type LlmCacheOwnerScope = 'platform' | 'developer' | 'site' | 'user';

export interface LlmCacheEntry {
  ownerScope: LlmCacheOwnerScope;
  ownerId: string;
  /** `sha256(model + messages + temperature)` 的十六进制（64 字符） */
  inputHash: string;
  model: string;
  /** 提示词模板版本（**仅用于排障/统计**，不参与键——见文件头） */
  promptVer: string;
  pluginId?: string;
  result: unknown;
  promptTokens: number;
  completionTokens: number;
  expiresAt?: Date | null;
  createdAt: Date;
}

export interface LlmCacheStore {
  /** 命中返回条目；**已过期视为未命中**（不依赖清理任务） */
  get(input: {
    ownerScope: LlmCacheOwnerScope;
    ownerId: string;
    inputHash: string;
    now: Date;
  }): Promise<LlmCacheEntry | undefined>;
  /** 写入（同 `(ownerScope, ownerId, inputHash)` 覆盖——重新计算的结果应当更新缓存） */
  put(entry: LlmCacheEntry): Promise<void>;
  /** 回收过期行（**仅回收存储**；正确性不依赖它） */
  purgeExpired(now: Date): Promise<number>;
}

interface CacheRow extends Record<string, unknown> {
  owner_scope: LlmCacheOwnerScope;
  owner_id: string;
  input_hash: string;
  model: string;
  prompt_ver: string;
  plugin_id: string | null;
  result: unknown;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: Date | string;
  expires_at: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToEntry(row: CacheRow): LlmCacheEntry {
  return {
    ownerScope: row.owner_scope,
    ownerId: row.owner_id,
    inputHash: row.input_hash,
    model: row.model,
    promptVer: row.prompt_ver,
    ...(row.plugin_id === null ? {} : { pluginId: row.plugin_id }),
    result: row.result,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    expiresAt: row.expires_at === null ? null : toDate(row.expires_at),
    createdAt: toDate(row.created_at),
  };
}

export class DbLlmCacheStore implements LlmCacheStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(input: {
    ownerScope: LlmCacheOwnerScope;
    ownerId: string;
    inputHash: string;
    now: Date;
  }): Promise<LlmCacheEntry | undefined> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<CacheRow>(
        `SELECT owner_scope, owner_id, input_hash, model, prompt_ver, plugin_id, result,
                prompt_tokens, completion_tokens, created_at, expires_at
           FROM ag_llm_cache
          WHERE owner_scope = $1 AND owner_id = $2 AND input_hash = $3
            AND (expires_at IS NULL OR expires_at > $4)
          LIMIT 1`,
        [input.ownerScope, input.ownerId, input.inputHash, input.now],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToEntry(row);
  }

  async put(entry: LlmCacheEntry): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () => {
      await this.#db.query(
        `INSERT INTO ag_llm_cache
           (owner_scope, owner_id, input_hash, model, prompt_ver, plugin_id, result,
            prompt_tokens, completion_tokens, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         ON CONFLICT (owner_scope, owner_id, input_hash) DO UPDATE
           SET model = EXCLUDED.model,
               prompt_ver = EXCLUDED.prompt_ver,
               plugin_id = EXCLUDED.plugin_id,
               result = EXCLUDED.result,
               prompt_tokens = EXCLUDED.prompt_tokens,
               completion_tokens = EXCLUDED.completion_tokens,
               created_at = EXCLUDED.created_at,
               expires_at = EXCLUDED.expires_at`,
        [
          entry.ownerScope,
          entry.ownerId,
          entry.inputHash,
          entry.model,
          entry.promptVer,
          entry.pluginId ?? null,
          JSON.stringify(entry.result ?? null),
          entry.promptTokens,
          entry.completionTokens,
          entry.createdAt,
          entry.expiresAt ?? null,
        ],
      );
    });
  }

  async purgeExpired(now: Date): Promise<number> {
    return reuseOrBeginTransaction(this.#db, async () => {
      const rows = await this.#db.query<{ input_hash: string }>(
        `DELETE FROM ag_llm_cache WHERE expires_at IS NOT NULL AND expires_at <= $1 RETURNING input_hash`,
        [now],
      );
      return rows.length;
    });
  }
}
