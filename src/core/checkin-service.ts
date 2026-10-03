/**
 * 签到服务（`docs/05 §5.1 / §5.2 / §5.2.1`）—— **资格判定 + 三步写入顺序**。
 *
 * ★★ 本文件的核心是 `docs/05 §5.2.1` 的那条顺序，它的标题就是「★ 防重复发额度」：
 *
 * ```
 * ① INSERT ag_checkin_records … ON CONFLICT (site_id, user_id, checkin_date) DO NOTHING
 *      ├─ 插入成功 → 继续
 *      └─ 冲突     → 直接返回「今日已签到」（幂等成功，不报错）
 * ② 调发额度
 *      ├─ 成功     → 回填 grant_state = confirmed
 *      └─ 失败/超时 → 记录保留，转 unknown，**禁止自动重发**（只走对账核销）
 * ```
 * ★ **为什么不能反过来**（先发额度再写记录）：两个并发请求会**都发出额度**，
 *   唯一键只挡住记录 → 账实不符且用户多得。
 *   把「是否已签」变成**数据库层面的原子判定**，而不是「查询‒判断‒写入」的三步竞态。
 *
 * ★★ 关于幂等键（本会话评估的 Top #1，此处给出**可执行**的裁决）：
 *   签到的幂等锚点是 `ag_checkin_records` 的唯一键 `(siteId, userId, checkinDate)`，
 *   **不是** `ag_actions_log` 的 `hash(siteId,userId,policyId,actionSeq,action)`。
 *   原因：`actionSeq` 只在**状态迁移**时递增——策略状态稳定在 `granted` 时它不变，
 *   于是第 2…N 天的 `add_quota` 会复用同一个键 → 被永久去重 → **持续少发**。
 *   因此本服务**不经 `ActionExecutor`**，而是直接调用已注册的 `add_quota` handler，
 *   并传入**含逻辑日**的 `idempotencyKey`（`checkin:<site>:<user>:<date>`）。
 */

import { createHash } from 'node:crypto';

import {
  isActive,
  type CheckinEntitlementStore,
  type CheckinRecord,
  type CheckinRecordStore,
} from './checkin.ts';

export interface CheckinRewardConfig {
  min: number;
  max: number;
  cap: number;
  /** 连签阶梯：`days` 天起乘 `multiplier` */
  streakBonus: readonly { days: number; multiplier: number }[];
}

export interface CheckinConfig {
  /** 需要哪条资格（`checkin:grant` 写入的 `scope`）才可签 */
  requireScope: string;
  /** **站点时区**——签到自然日的边界（`docs/05 §5.2`：跑「某一天」用站点时区，跑「多长时间」用 UTC） */
  timezone: string;
  reward: CheckinRewardConfig;
}

export interface CheckinServiceDeps {
  entitlements: CheckinEntitlementStore;
  records: CheckinRecordStore;
  /**
   * 发额度。由**装配层**注入（内部调用已注册的 `newapi-add-quota:add_quota` handler），
   * 因此本服务不依赖任何具体下游系统。
   */
  grantQuota: (input: {
    siteId: string;
    userId: string;
    amount: number;
    reason: string;
    idempotencyKey: string;
  }) => Promise<{ providerLogId?: number }>;
  config: CheckinConfig;
  now?: () => Date;
}

export interface CheckinStatus {
  eligible: boolean;
  reason?: string;
  /** 今日是否已签到 */
  today: boolean;
  /** 当前连续签到天数 */
  streak: number;
  /** 下一次可得的额度（今日未签＝今天；今日已签＝明天的预估） */
  nextReward: number;
}

export type CheckinOutcome =
  | { ok: true; alreadyCheckedIn: boolean; quotaAwarded: number; streak: number }
  | { ok: false; reason: 'not_eligible' | 'grant_failed'; message: string };

/** 站点时区下的自然日（`YYYY-MM-DD`）。`en-CA` 的输出恰好就是 ISO 日期。 */
export function logicalDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 前一个自然日（纯日期算术，不涉时区换算）。 */
export function previousDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * 额度金额：在 `[min, max]` 内**确定性**取值（以 `userId + 日期` 为种子）。
 *
 * ★ 为什么不用 `Math.random()`：签到的**可复现**与**可测试**都依赖它——
 *   随机数会让「同一天的金额」在重放/对账时对不上，也让测试必须容忍任意值。
 */
export function stableAmount(userId: string, date: string, reward: CheckinRewardConfig): number {
  const digest = createHash('sha256').update(`${userId}:${date}`).digest();
  const ratio = digest.readUInt32BE(0) / 0xffff_ffff;
  const span = Math.max(0, reward.max - reward.min);
  const amount = Math.floor(reward.min + ratio * span);
  return Math.min(amount, reward.cap);
}

/** 连签阶梯：取满足条件的最大倍率。 */
export function streakMultiplier(streak: number, reward: CheckinRewardConfig): number {
  let multiplier = 1;
  for (const tier of reward.streakBonus) {
    if (streak >= tier.days) multiplier = Math.max(multiplier, tier.multiplier);
  }
  return multiplier;
}

export class CheckinService {
  readonly #deps: CheckinServiceDeps;

  constructor(deps: CheckinServiceDeps) {
    this.#deps = deps;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  #amountFor(userId: string, date: string, streak: number): number {
    const base = stableAmount(userId, date, this.#deps.config.reward);
    const scaled = Math.floor(base * streakMultiplier(streak, this.#deps.config.reward));
    return Math.min(scaled, this.#deps.config.reward.cap);
  }

  async #eligible(siteId: string, userId: string): Promise<boolean> {
    const entitlement = await this.#deps.entitlements.find(
      siteId,
      userId,
      this.#deps.config.requireScope,
    );
    return entitlement !== undefined && isActive(entitlement);
  }

  async status(input: { siteId: string; userId: string }): Promise<CheckinStatus> {
    const today = logicalDate(this.#now(), this.#deps.config.timezone);
    const [eligible, todayRecord, yesterdayRecord] = await Promise.all([
      this.#eligible(input.siteId, input.userId),
      this.#deps.records.find(input.siteId, input.userId, today),
      this.#deps.records.find(input.siteId, input.userId, previousDate(today)),
    ]);

    // 「当前连续天数」：今日已签取今日的；否则取昨日已累计的（即将续签）
    const streak = todayRecord?.streak ?? yesterdayRecord?.streak ?? 0;
    const nextStreak = todayRecord === undefined ? streak + 1 : streak + 1;
    return {
      eligible,
      ...(eligible ? {} : { reason: '尚未取得签到资格（需策略判定通过并授予）' }),
      today: todayRecord !== undefined,
      streak,
      nextReward: this.#amountFor(input.userId, today, nextStreak),
    };
  }

  async history(input: { siteId: string; userId: string; limit?: number }): Promise<CheckinRecord[]> {
    return this.#deps.records.listRecent(input.siteId, input.userId, input.limit ?? 30);
  }

  async checkin(input: { siteId: string; userId: string }): Promise<CheckinOutcome> {
    if (!(await this.#eligible(input.siteId, input.userId))) {
      return {
        ok: false,
        reason: 'not_eligible',
        message: '需先取得签到资格（策略判定通过并授予 `checkin:grant`）',
      };
    }

    const today = logicalDate(this.#now(), this.#deps.config.timezone);
    const existing = await this.#deps.records.find(input.siteId, input.userId, today);
    if (existing !== undefined) {
      // ★ 幂等成功：不报错、不重复发额度
      return {
        ok: true,
        alreadyCheckedIn: true,
        quotaAwarded: existing.quotaAwarded,
        streak: existing.streak,
      };
    }

    const yesterday = await this.#deps.records.find(
      input.siteId,
      input.userId,
      previousDate(today),
    );
    const streak = yesterday === undefined ? 1 : yesterday.streak + 1;
    const amount = this.#amountFor(input.userId, today, streak);

    // ── ① 幂等锚点：先写记录（唯一键 = 站点 + 主体 + 自然日） ──
    const inserted = await this.#deps.records.tryInsert({
      siteId: input.siteId,
      userId: input.userId,
      checkinDate: today,
      quotaAwarded: amount,
      grantState: 'pending',
      grantVia: 'provider',
      streak,
    });
    if (!inserted) {
      // 并发下另一个请求先插入 → 按「今日已签到」返回（不重复发额度）
      const row = await this.#deps.records.find(input.siteId, input.userId, today);
      return {
        ok: true,
        alreadyCheckedIn: true,
        quotaAwarded: row?.quotaAwarded ?? amount,
        streak: row?.streak ?? streak,
      };
    }

    // ── ② 发额度（**显式幂等键含逻辑日**，见文件头说明） ──
    try {
      const granted = await this.#deps.grantQuota({
        siteId: input.siteId,
        userId: input.userId,
        amount,
        reason: `checkin:${today}`,
        idempotencyKey: `checkin:${input.siteId}:${input.userId}:${today}`,
      });
      // ── ③ 回填发放结果 ──
      await this.#deps.records.markGranted({
        siteId: input.siteId,
        userId: input.userId,
        checkinDate: today,
        ...(granted.providerLogId === undefined ? {} : { providerLogId: granted.providerLogId }),
      });
      return { ok: true, alreadyCheckedIn: false, quotaAwarded: amount, streak };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#deps.records.markUnknown({
        siteId: input.siteId,
        userId: input.userId,
        checkinDate: today,
        error: message,
      });
      return {
        ok: false,
        reason: 'grant_failed',
        message: `额度发放结果未知（已留记录，交由对账核销，**不自动重发**）：${message}`,
      };
    }
  }
}
