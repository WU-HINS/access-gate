/**
 * 告警静默的**持久化存储**（`docs/11 §13.1` / P0-2）。
 *
 * ★★ 为什么需要它：`AlertSilenceStore` 此前**只有内存实现**（`InMemoryAlertSilenceStore`），
 *   于是真实模式下**重启即丢静默**。方向是安全的（静默失效 → 告警重现，不会漏告警），
 *   但既然项目里其他平台级状态（平台设置、调用方密钥、绑定…）都落库了，这一项不该例外——
 *   否则"我明明静默了，怎么又告警了"会变成一类**说不清**的运维现象。
 *
 * ★ 承载方式：**平台设置**（`ag_platform_settings` 的键值），键名 `alert_silences`，
 *   值是静默数组。理由：静默是**低频运维状态**，条目数是个位到几十，
 *   为它单开一张表（还要配套迁移/索引/清理）不划算；而平台设置本来就有
 *   "带 `updated_by` / `lockedByEnv` 的键值"语义。
 *
 * ★ 两处必须守住的语义（与内存实现一致）：
 *   ① **同码覆盖**：重新静默 = **更新期限**，不是堆多条（否则 `isSilenced` 取哪条都说不清）；
 *   ② **日期往返**：`until` / `createdAt` 经 JSON 会变字符串，读出时必须还原为 `Date`——
 *      否则 `until > now` 的比较会退化成**字符串比较**，静默期限静默地失效。
 *
 * ★ 已知取舍：读-改-写存在并发竞态。静默是**低频人工操作**（且写的是"最后写入者生效"的语义），
 *   因此不引入乐观锁；真要高并发运维，应改为单行表 + 行锁。
 */

import type { PlatformSettingsStore } from '../app/platform-mode.ts';
import type { AlertSilence, AlertSilenceStore } from '../core/alert-silence.ts';

/** 平台设置里的键名 */
export const ALERT_SILENCES_KEY = 'alert_silences';

interface StoredSilence {
  code: string;
  until: string;
  by: string;
  reason: string;
  createdAt: string;
}

function serialize(silence: AlertSilence): StoredSilence {
  return {
    code: silence.code,
    until: silence.until.toISOString(),
    by: silence.by,
    reason: silence.reason,
    createdAt: silence.createdAt.toISOString(),
  };
}

/** 解析一条存储记录；**结构不符时丢弃**（而不是让整个静默列表读不出来） */
function parseSilence(raw: unknown): AlertSilence | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Partial<StoredSilence>;
  if (typeof record.code !== 'string' || typeof record.until !== 'string') return undefined;
  const until = new Date(record.until);
  if (Number.isNaN(until.getTime())) return undefined;
  const createdAtRaw = typeof record.createdAt === 'string' ? new Date(record.createdAt) : new Date(0);
  return {
    code: record.code,
    until,
    by: typeof record.by === 'string' ? record.by : 'unknown',
    reason: typeof record.reason === 'string' ? record.reason : '',
    createdAt: Number.isNaN(createdAtRaw.getTime()) ? new Date(0) : createdAtRaw,
  };
}

export class DbAlertSilenceStore implements AlertSilenceStore {
  readonly #settings: PlatformSettingsStore;

  constructor(settings: PlatformSettingsStore) {
    this.#settings = settings;
  }

  async #readAll(): Promise<AlertSilence[]> {
    const record = await this.#settings.get(ALERT_SILENCES_KEY);
    const raw = record?.value;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const parsed = parseSilence(item);
      return parsed === undefined ? [] : [parsed];
    });
  }

  async #writeAll(rows: readonly AlertSilence[], at: Date): Promise<void> {
    // ★ `by = null`：这是**系统**写入（`updated_by` 是 uuid 列，
    //   用 `'system'` 冒充 uuid 在本会话已踩过四次坑）。
    await this.#settings.put(ALERT_SILENCES_KEY, rows.map(serialize), null, at);
  }

  async list(): Promise<readonly AlertSilence[]> {
    return this.#readAll();
  }

  async put(silence: AlertSilence): Promise<void> {
    const rows = await this.#readAll();
    // ★ 同码覆盖（与内存实现一致）：重新静默 = 更新期限
    const next = [...rows.filter((row) => row.code !== silence.code), silence];
    await this.#writeAll(next, silence.createdAt);
  }

  async remove(code: string): Promise<void> {
    const rows = await this.#readAll();
    const next = rows.filter((row) => row.code !== code);
    if (next.length === rows.length) return; // 不存在 → 不写（避免无意义写）
    await this.#writeAll(next, new Date());
  }
}
