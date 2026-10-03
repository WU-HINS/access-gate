/**
 * ★★ **配额保护**（`docs/05 §6.4`「外部 API 统一走 `QuotaGuard`」+ `§6.3.1`「键必须与资源归属同构」）。
 *
 * ## 为什么要有这个模块（§6.3.1 的事故形态，原文）
 *
 * > **问题**：桶键取「资源名」（`github:graphql`、`llm:tokens`），而资源的归属是 developer / site。
 * > 后果：**开发者 A 的站点把桶打满 → B / C 的采集全部 missing**，而告警把原因归给
 * > 「渠道 X 不可信」——**实际渠道完全正常**，管理员查 token / 网络永远查不到「邻居掏空了桶」。
 *
 * ## 本模块的两个硬约束（都由**类型**强制，而不是靠注释提醒）
 *
 * ① **键必须带归属**：对外接口只接受 `QuotaKey`（含 `ownerScope` / `ownerId`），
 *    **无法**只传一个资源名。这样"非同构键"在**编译期**就写不出来。
 *    最终键形如 `quota:{ownerScope}:{ownerId}:{pluginId}:{instanceKey}:{resource}`（文档给出的形状）。
 * ② **超限不抛错**：返回 `{ ok: false, reason }` 让调用方决定（`docs/05 §6.4`：超限时
 *    「让事实采集返回 `missing`，由策略的 `onMissingFact` 决定」，默认 `fail_closed`）。
 *    抛异常会让"配额用尽"与"代码出错"在调用点混为一谈。
 *
 * ## 与 `docs/05 §6.3.1` 的归因要求
 *
 * 超限的 `message` **必须带 owner 与资源**（而不是只说「渠道 X」）——
 * 因为"渠道正常、是邻居把桶掏空了"这件事，只有 owner 出现在告警里才查得到。
 * 调用方据此产生 `throttled` 归因，**不得复用 `indeterminate` 的文案**。
 *
 * ## 窗口语义（如实说明）
 *
 * `withBudget` 用**自然日**窗口；`withTokenBucket` 用**固定小时窗口**（`limit = capacity`）。
 * 文档示例是 `{ capacity: 5000, refillPerHour: 5000 }`——在突发量等于容量的场景下，
 * 固定小时窗口与"桶"的稳态行为一致；但**真正的令牌桶**（允许在一个窗口内先借后还）
 * 需要更细的状态，本实现**刻意不做**：固定窗口能用**一条原子语句**完成预占（见 `reserve`），
 * 而多实例下"读-改-写"必然超发。**取舍记在这里，不藏着。**
 */

import type { Logger } from '../kernel/logger.ts';

export type OwnerScope = 'platform' | 'developer' | 'site' | 'user';

/**
 * ★★ **与归属同构的配额键**。
 *
 * ★ 这里刻意**不提供**"只传资源名"的重载或可选参数：一旦允许，
 *   `withBudget({ resource: 'llm:tokens' }, ...)` 就会被写出来，
 *   而那正是 §6.3.1 记录的跨租户故障传播 + 错误归因。
 */
export interface QuotaKey {
  ownerScope: OwnerScope;
  /** 归属主体 id（platform 时固定 `'platform'`） */
  ownerId: string;
  /** 发起方插件 id（如 `newapi-provider`） */
  pluginId: string;
  /** 插件实例键（如站点编号 `site-a`）；无实例概念时用 `'default'` */
  instanceKey: string;
  /** 受保护的资源（如 `llm:tokens`、`github:graphql`） */
  resource: string;
}

/** 生成文档规定的键形状（`quota:{ownerScope}:{ownerId}:{pluginId}:{instanceKey}:{resource}`）。 */
export function quotaKeyOf(key: QuotaKey): string {
  return `quota:${key.ownerScope}:${key.ownerId}:${key.pluginId}:${key.instanceKey}:${key.resource}`;
}

/** 供告警/日志使用的人类可读归属描述（**必须**出现在超限文案里）。 */
export function describeQuotaOwner(key: QuotaKey): string {
  return `owner=${key.ownerScope}:${key.ownerId} plugin=${key.pluginId} instance=${key.instanceKey}`;
}

export type QuotaLimitedReason = 'bucket_exhausted' | 'budget_exhausted';

export type QuotaOutcome<T> =
  | { ok: true; value: T; key: string; used: number; limit: number }
  | {
      ok: false;
      reason: QuotaLimitedReason;
      key: string;
      ownerScope: OwnerScope;
      ownerId: string;
      used: number;
      limit: number;
      /** ★ 超限文案**必须带 owner 与资源**（§6.3.1：否则管理员会去查渠道，而渠道是好的） */
      message: string;
      retryAfterMs: number;
    };

/**
 * 计数存储。**必须是原子的条件累加**。
 *
 * ★ 为什么接口只有一个"条件累加"语义、而不给 `get` + `set`：
 *   多实例下 `read → 判断 → write` 必然**超发**（两个实例同时读到 `used = limit - 1`）。
 *   这正是本会话反复出现的"顺序/原子性"类问题，所以在**接口层**就堵死。
 */
export interface QuotaCounterStore {
  /**
   * 原子预占：`used + amount <= limit` 时累加并返回**新值**，否则返回 `null`（超限）。
   * `windowStart` 之前的计数**视为过期**（新窗口从 0 开始）。
   */
  reserve(input: {
    key: string;
    amount: number;
    limit: number;
    windowStart: Date;
    windowMs: number;
  }): Promise<number | null>;
  /** 当前窗口已用（观测用；不参与判定） */
  used(key: string, windowStart: Date): Promise<number>;
  /** 回滚预占（下游调用失败时把额度还回去） */
  release(input: { key: string; amount: number; windowStart: Date }): Promise<void>;
  /**
   * ★★ **结算调整**：无条件按 `delta` 调整（可正可负，下限 0）。
   *
   * ★ 为什么需要它（而不是用 `reserve`/`release` 组合）：调用**已经发生**了，
   *   实际用量可能**超过**当初的预估值。此时不能"因为超额就拒绝记账"——
   *   那会让计数**低于真实**（后续调用继续被放行，配额被无限突破）。
   *   正确语义：**如实记账**（可把 `used` 推到 limit 之上），
   *   让**下一次**调用被正常拒绝。
   */
  adjust(input: { key: string; delta: number; windowStart: Date }): Promise<void>;
}

interface Counter {
  used: number;
  windowStartMs: number;
}

export class InMemoryQuotaCounterStore implements QuotaCounterStore {
  readonly #counters = new Map<string, Counter>();

  async reserve(input: {
    key: string;
    amount: number;
    limit: number;
    windowStart: Date;
    windowMs: number;
  }): Promise<number | null> {
    const current = this.#counters.get(input.key);
    const fresh =
      current === undefined || current.windowStartMs !== input.windowStart.getTime()
        ? { used: 0, windowStartMs: input.windowStart.getTime() }
        : current;
    if (fresh.used + input.amount > input.limit) {
      this.#counters.set(input.key, fresh);
      return null;
    }
    fresh.used += input.amount;
    this.#counters.set(input.key, fresh);
    return fresh.used;
  }

  async used(key: string, windowStart: Date): Promise<number> {
    const current = this.#counters.get(key);
    if (current === undefined || current.windowStartMs !== windowStart.getTime()) return 0;
    return current.used;
  }

  async release(input: { key: string; amount: number; windowStart: Date }): Promise<void> {
    const current = this.#counters.get(input.key);
    if (current === undefined || current.windowStartMs !== input.windowStart.getTime()) return;
    current.used = Math.max(0, current.used - input.amount);
  }

  async adjust(input: { key: string; delta: number; windowStart: Date }): Promise<void> {
    const current = this.#counters.get(input.key);
    const fresh =
      current === undefined || current.windowStartMs !== input.windowStart.getTime()
        ? { used: 0, windowStartMs: input.windowStart.getTime() }
        : current;
    // ★ 下限 0、**上限不设**：结算可把 used 推到 limit 之上（如实记账，让下次被拒）
    fresh.used = Math.max(0, fresh.used + input.delta);
    this.#counters.set(input.key, fresh);
  }
}

export interface QuotaGuardOptions {
  store: QuotaCounterStore;
  now?: () => Date;
  logger?: Logger;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 自然日窗口起点（UTC）；`withBudget` 的语义是"每天" */
function dayStartOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
/** 固定小时窗口起点 */
function hourStartOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

export class QuotaGuard {
  readonly #store: QuotaCounterStore;
  readonly #now: () => Date;
  readonly #logger: Logger | undefined;

  constructor(options: QuotaGuardOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
  }

  /**
   * **日预算**（`docs/05 §6.4` 的 `withBudget('llm:tokens', { daily })`）。
   *
   * ★ `amount` 是本次调用的**预估消耗**（如"期望输出 token"）——
   *   超限时**不抛错**，返回 `{ ok: false }` 由调用方决定（默认让事实返回 `missing`）。
   */
  async withBudget<T>(
    key: QuotaKey,
    options: { daily: number; amount: number },
    fn: () => Promise<T>,
  ): Promise<QuotaOutcome<T>> {
    return this.#reserveAndRun(
      key,
      { limit: options.daily, amount: options.amount, windowMs: DAY_MS, windowStart: dayStartOf(this.#now()), reason: 'budget_exhausted' },
      fn,
    );
  }

  /**
   * **令牌桶**（固定窗口；`limit = capacity`）。
   *
   * ★ `windowMs` 默认一小时（文档示例 `{ capacity: 5000, refillPerHour: 5000 }`）；
   *   传 `60_000` 即"每分钟 N 次"的语义（LLM 网关的 `perMinuteLimit` 就用它）。
   */
  async withTokenBucket<T>(
    key: QuotaKey,
    options: { capacity: number; refillPerHour: number; amount?: number; windowMs?: number },
    fn: () => Promise<T>,
  ): Promise<QuotaOutcome<T>> {
    const windowMs = options.windowMs ?? HOUR_MS;
    const nowMs = this.#now().getTime();
    return this.#reserveAndRun(
      key,
      {
        limit: options.capacity,
        amount: options.amount ?? 1,
        windowMs,
        windowStart: new Date(Math.floor(nowMs / windowMs) * windowMs),
        reason: 'bucket_exhausted',
      },
      fn,
    );
  }

  /**
   * ★★ **结算**：把预占 `reserved` 调整为实际 `actual`（调用**已完成**）。
   *
   * ★ 为什么不是"`release` 再 `reserve`"：`actual` 可能**超过** `reserved`，
   *   而 `reserve` 在超额时会失败 —— 那样计数就**低于真实**，
   *   后续调用会继续被放行，配额被无限突破。
   *   这里用 `adjust` **如实记账**（允许把 `used` 推到 `limit` 之上），
   *   让**下一次**调用被正常拒绝。
   */
  async settle(
    key: QuotaKey,
    input: { reserved: number; actual: number },
    window: 'day' | 'hour' = 'day',
  ): Promise<void> {
    const at = this.#now();
    await this.#store.adjust({
      key: quotaKeyOf(key),
      delta: input.actual - input.reserved,
      windowStart: window === 'day' ? dayStartOf(at) : hourStartOf(at),
    });
  }

  /**
   * ★★ **释放预占**（下游调用**失败**时）。
   *
   * ★ 与 `settle` 的分工：`settle` 用于"调用完成了，把预估调成实际"；
   *   这里是"调用**没发生**（上游报错），把预占**整笔**还回去"。
   *   不释放会让一次下游故障**永久占住**额度（"幽灵调用"）。
   */
  async releaseReservation(
    key: QuotaKey,
    input: { reserved: number },
    window: 'day' | 'hour' = 'day',
  ): Promise<void> {
    const at = this.#now();
    await this.#store.release({
      key: quotaKeyOf(key),
      amount: input.reserved,
      windowStart: window === 'day' ? dayStartOf(at) : hourStartOf(at),
    });
  }

  /** 观测：某键在当前窗口的用量（供指标/告警；不参与判定）。 */
  async usageOf(key: QuotaKey, window: 'day' | 'hour' = 'day'): Promise<number> {
    const at = this.#now();
    return this.#store.used(quotaKeyOf(key), window === 'day' ? dayStartOf(at) : hourStartOf(at));
  }

  async #reserveAndRun<T>(
    key: QuotaKey,
    options: {
      limit: number;
      amount: number;
      windowMs: number;
      windowStart: Date;
      reason: QuotaLimitedReason;
    },
    fn: () => Promise<T>,
  ): Promise<QuotaOutcome<T>> {
    const fullKey = quotaKeyOf(key);
    const reserved = await this.#store.reserve({
      key: fullKey,
      amount: options.amount,
      limit: options.limit,
      windowStart: options.windowStart,
      windowMs: options.windowMs,
    });

    if (reserved === null) {
      const used = await this.#store.used(fullKey, options.windowStart);
      const message =
        `配额不足（${options.reason === 'budget_exhausted' ? '日预算' : '令牌桶'}）：` +
        `${describeQuotaOwner(key)} resource=${key.resource} used=${used}/${options.limit}`;
      // ★ 归因必须带 owner：告警里只有"渠道 X"时，管理员永远查不到"邻居掏空了桶"（§6.3.1）
      this.#logger?.warn('配额超限', {
        quotaKey: fullKey,
        ownerScope: key.ownerScope,
        ownerId: key.ownerId,
        pluginId: key.pluginId,
        instanceKey: key.instanceKey,
        resource: key.resource,
        used,
        limit: options.limit,
        reason: options.reason,
      });
      return {
        ok: false,
        reason: options.reason,
        key: fullKey,
        ownerScope: key.ownerScope,
        ownerId: key.ownerId,
        used,
        limit: options.limit,
        message,
        retryAfterMs: options.windowStart.getTime() + options.windowMs - this.#now().getTime(),
      };
    }

    try {
      const value = await fn();
      return { ok: true, value, key: fullKey, used: reserved, limit: options.limit };
    } catch (error) {
      // ★ 调用失败 → **把预占还回去**：否则一次下游故障会白吃掉额度（"失败也扣费"是最难解释的一类现象）
      await this.#store.release({ key: fullKey, amount: options.amount, windowStart: options.windowStart });
      throw error;
    }
  }
}
