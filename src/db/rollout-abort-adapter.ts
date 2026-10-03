/**
 * 灰度熔断状态的**持久化**（`ag_platform_settings` 的键值，键名 `policy_rollout_aborts`）。
 *
 * ★ 为什么必须落库：`abortRollout` 是**纯函数**，按下熔断按钮后若只存在于某次返回值里，
 *   **重启即忘** —— 而熔断是"止血"操作，忘掉止血比忘掉灰度更严重。
 *
 * ★ 承载方式：**平台设置**（与 `alert_silences` 同一手法）。
 *   熔断是**低频人工运维状态**（条目数个位到几十），为它单开一张表
 *   （还要配套迁移/索引/清理）不划算；平台设置本来就有"带 `updated_by` 的键值"语义。
 *
 * ★ 两处必须守住的语义（与内存实现一致）：
 *   ① **幂等且保留首次**：重复熔断不覆盖时间与原因（"谁最先发现"更有复盘价值）；
 *   ② **日期往返**：`abortedAt` 经 JSON 会变字符串，读出时必须还原为 `Date` ——
 *      否则排序与展示都会错（`alert_silences` 已踩过这个坑）。
 */

import type { PlatformSettingsStore } from '../app/platform-mode.ts';
import type { RolloutAbort, RolloutAbortStore } from '../core/rollout-abort.ts';

/** 平台设置里的键名 */
export const ROLLOUT_ABORTS_KEY = 'policy_rollout_aborts';

interface StoredAbort {
  siteId: string;
  policyId: string;
  policyCode: string;
  fromVersion: number;
  abortedAt: string;
  abortedBy: string;
  reason: string;
}

function serialize(abort: RolloutAbort): StoredAbort {
  return {
    siteId: abort.siteId,
    policyId: abort.policyId,
    policyCode: abort.policyCode,
    fromVersion: abort.fromVersion,
    abortedAt: abort.abortedAt.toISOString(),
    abortedBy: abort.abortedBy,
    reason: abort.reason,
  };
}

/** 解析一条存储记录；**结构不符时丢弃**（而不是让整个熔断列表读不出来） */
function parseAbort(raw: unknown): RolloutAbort | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Partial<StoredAbort>;
  if (
    typeof record.siteId !== 'string' ||
    typeof record.policyId !== 'string' ||
    typeof record.abortedAt !== 'string'
  ) {
    return undefined;
  }
  const abortedAt = new Date(record.abortedAt);
  if (Number.isNaN(abortedAt.getTime())) return undefined;
  return {
    siteId: record.siteId,
    policyId: record.policyId,
    policyCode: typeof record.policyCode === 'string' ? record.policyCode : record.policyId,
    fromVersion: typeof record.fromVersion === 'number' ? record.fromVersion : 0,
    abortedAt,
    abortedBy: typeof record.abortedBy === 'string' ? record.abortedBy : 'unknown',
    reason: typeof record.reason === 'string' ? record.reason : '',
  };
}

export class DbRolloutAbortStore implements RolloutAbortStore {
  readonly #settings: PlatformSettingsStore;

  constructor(settings: PlatformSettingsStore) {
    this.#settings = settings;
  }

  async #readAll(): Promise<RolloutAbort[]> {
    const record = await this.#settings.get(ROLLOUT_ABORTS_KEY);
    const raw = record?.value;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const parsed = parseAbort(item);
      return parsed === undefined ? [] : [parsed];
    });
  }

  async #writeAll(rows: readonly RolloutAbort[], at: Date): Promise<void> {
    // ★ `by = null`：这是**系统**写入（`updated_by` 是 uuid 列，
    //   用字符串冒充 uuid 在本项目已踩过多次）。
    await this.#settings.put(ROLLOUT_ABORTS_KEY, rows.map(serialize), null, at);
  }

  async list(): Promise<readonly RolloutAbort[]> {
    return this.#readAll();
  }

  async abort(input: {
    siteId: string;
    policyId: string;
    policyCode: string;
    fromVersion: number;
    by: string;
    reason: string;
    at: Date;
  }): Promise<RolloutAbort> {
    const rows = await this.#readAll();
    const existing = rows.find((row) => row.siteId === input.siteId && row.policyId === input.policyId);
    // ★ 幂等且保留首次（与内存实现、与 `abortRollout` 的纯函数语义一致）
    if (existing !== undefined) return existing;

    const row: RolloutAbort = {
      siteId: input.siteId,
      policyId: input.policyId,
      policyCode: input.policyCode,
      fromVersion: input.fromVersion,
      abortedAt: input.at,
      abortedBy: input.by,
      reason: input.reason,
    };
    await this.#writeAll([...rows, row], input.at);
    return row;
  }

  async resume(siteId: string, policyId: string): Promise<boolean> {
    const rows = await this.#readAll();
    const next = rows.filter((row) => !(row.siteId === siteId && row.policyId === policyId));
    if (next.length === rows.length) return false; // 不存在 → 不写（避免无意义写）
    await this.#writeAll(next, new Date());
    return true;
  }

  async abortedPolicyIds(siteId: string): Promise<readonly string[]> {
    const rows = await this.#readAll();
    return rows.filter((row) => row.siteId === siteId).map((row) => row.policyId);
  }
}
