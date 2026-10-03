/**
 * 灰度发布与一键熔断（M6-3 / M3-10）—— docs/07 M6-3、M3-10、docs/05 §6.3.1。
 *
 * ```
 *   策略 v3（旧）  ──灰度 10%──▶  策略 v4（新）
 *                     │
 *              一键熔断 ┘  立刻全部回到 v3（止血）
 * ```
 *
 * ★ 验收标准（M3-10 原文）：**「同一用户灰度结果稳定」**。
 *   这句话直接排除了最自然的实现——**随机数**。
 *   若用 `Math.random() < 0.1`，同一个用户这秒在新版本、下秒在旧版本：
 *   他的资格判定会**来回翻转**，而每次翻转都可能触发动作（改分组 → 踢下线）。
 *
 *   因此分桶必须是 `hash(userId, rolloutId)` 的**确定性函数**：
 *   同一用户在同一次灰度里恒在同一侧；换一次灰度（新 `rolloutId`）才重新分桶。
 *
 * ★ 第二处要点：**一键熔断必须连白名单一起回滚**。
 *   熔断的语义是「新版本有问题，立刻止血」——
 *   若白名单（通常是开发者/测试账号）仍留在新版本上，他们继续吃到故障数据，
 *   而且会误以为「灰度没问题」。止血就是止血，不区分名单。
 *
 * ★ 第三处（docs/05 §6.3.1 的通用规则）：**限流/熔断/预算的键必须与资源归属同构**。
 *   因此熔断状态是**按站点 + 策略**分区的，并由调用方提供分组清单
 *   （「按站点分组的受影响清单」）。
 */

import { createHash } from 'node:crypto';

// ─────────────────────────── 类型 ───────────────────────────

export interface RolloutConfig {
  /** 灰度标识：**换 id 即重新分桶**（用于「重新开始一次灰度」） */
  id: string;
  siteId: string;
  policyCode: string;
  /** 旧版本（灰度外的用户继续用它） */
  fromVersion: number;
  /** 新版本（灰度内的用户用它） */
  toVersion: number;
  /** 灰度比例 0-100 */
  percentage: number;
  /** 白名单：始终在新版本（熔断时一并回滚） */
  allowUserIds?: readonly string[];
  /** 黑名单：始终在旧版本（优先级高于白名单与比例） */
  denyUserIds?: readonly string[];
  /** 熔断状态：非空表示**已熔断**，所有用户回旧版本 */
  abortedAt?: Date | null;
  abortedBy?: string | null;
  abortReason?: string | null;
}

export type RolloutSide = 'new' | 'old';

export interface RolloutDecision {
  /** 该用户走哪个版本 */
  side: RolloutSide;
  version: number;
  /** 判定依据（审计与排障必需：用户会问「为什么我被分到新版本」） */
  reason: 'aborted' | 'denied' | 'allowed' | 'percentage' | 'not_in_percentage';
  /** 稳定的分桶值 0-99（便于复现与核对） */
  bucket: number;
}

// ─────────────────────────── 稳定分桶 ───────────────────────────

/**
 * 计算稳定分桶值（0-99）。
 *
 * ★ **必须是纯函数**：同样的 `(userId, rolloutId)` 永远得到同一个值。
 *   这也是「同一用户灰度结果稳定」的实现基础。
 *
 * 用 sha256 而不是简单取模：`userId` 若是递增 id（`user-1`, `user-2`…），
 * 直接取模会把「连续的 10% 用户」全部分进灰度——
 * 那批用户很可能是同一时间注册的同类用户，灰度结论会**系统性偏差**。
 */
export function bucketOf(userId: string, rolloutId: string): number {
  const digest = createHash('sha256').update(`${rolloutId}\u0000${userId}`, 'utf8').digest();
  // 取前 4 字节作为无符号整数，再映射到 0-99
  const value = digest.readUInt32BE(0);
  return value % 100;
}

/**
 * 判定某用户在本次灰度里走哪个版本。
 *
 * 判定优先级（高 → 低）：**熔断 → 黑名单 → 白名单 → 比例**。
 * ★ 熔断在最前：止血不能被任何名单或比例阻挡。
 */
export function resolveRollout(config: RolloutConfig, userId: string): RolloutDecision {
  const bucket = bucketOf(userId, config.id);

  // ① 熔断：所有用户回旧版本（**包括白名单**）
  if (config.abortedAt !== undefined && config.abortedAt !== null) {
    return { side: 'old', version: config.fromVersion, reason: 'aborted', bucket };
  }
  // ② 黑名单：始终旧版本
  if (config.denyUserIds?.includes(userId) === true) {
    return { side: 'old', version: config.fromVersion, reason: 'denied', bucket };
  }
  // ③ 白名单：始终新版本
  if (config.allowUserIds?.includes(userId) === true) {
    return { side: 'new', version: config.toVersion, reason: 'allowed', bucket };
  }
  // ④ 比例
  const percentage = Math.max(0, Math.min(100, config.percentage));
  if (bucket < percentage) {
    return { side: 'new', version: config.toVersion, reason: 'percentage', bucket };
  }
  return { side: 'old', version: config.fromVersion, reason: 'not_in_percentage', bucket };
}

// ─────────────────────────── 一键熔断 ───────────────────────────

/**
 * 一键熔断（**纯函数**：返回新配置，不改原对象）。
 *
 * ★ 幂等：重复熔断不报错、不改写首次熔断的时间与原因——
 *   「谁最先发现」这个信息在事后复盘里比「最后一次点按钮的人」更有价值。
 */
export function abortRollout(config: RolloutConfig, input: { by: string; reason: string; at: Date }): RolloutConfig {
  if (config.abortedAt !== undefined && config.abortedAt !== null) return config;
  return { ...config, abortedAt: input.at, abortedBy: input.by, abortReason: input.reason };
}

/** 恢复灰度（清除熔断状态，用于「修复后重新放量」）。 */
export function resumeRollout(config: RolloutConfig): RolloutConfig {
  return { ...config, abortedAt: null, abortedBy: null, abortReason: null };
}

/**
 * 熔断后的**受影响清单**（docs/05 §6.3.1 要求「按站点分组的受影响清单」）。
 *
 * ★ 为什么需要：熔断是「立刻全部回滚」，运维必须知道**这次回滚动了谁**——
 *   否则无法判断「影响面有多大、要不要通知用户」。
 */
export interface AffectedGroup {
  siteId: string;
  policyCode: string;
  fromVersion: number;
  /** 熔断前处于新版本的用户数（即「被回滚的用户」） */
  rolledBackUsers: number;
  reason: string;
}

export function affectedByAbort(configs: readonly RolloutConfig[], userIdsBySite: Record<string, readonly string[]>): AffectedGroup[] {
  const out: AffectedGroup[] = [];
  for (const config of configs) {
    if (config.abortedAt === undefined || config.abortedAt === null) continue;
    const users = userIdsBySite[config.siteId] ?? [];
    // 熔断前在新版本的用户 = 按比例/白名单会被判 new 的那些
    const before = { ...config, abortedAt: null, abortedBy: null, abortReason: null };
    const rolledBack = users.filter((userId) => resolveRollout(before, userId).side === 'new').length;
    out.push({
      siteId: config.siteId,
      policyCode: config.policyCode,
      fromVersion: config.fromVersion,
      rolledBackUsers: rolledBack,
      reason: config.abortReason ?? '未提供原因',
    });
  }
  return out.sort((a, b) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0));
}

/**
 * 判断是否应**自动熔断**（按错误率）。
 *
 * ★ 与「一键熔断」的区别：这是**自动**止损，`abortRollout` 是人工按下按钮。
 *   两者共用同一份熔断状态，因此不会互相覆盖（自动熔断先触发就保留它的时间与原因）。
 */
export function shouldAutoAbort(input: {
  /** 灰度流量中的失败数 */
  failures: number;
  /** 灰度流量总数 */
  total: number;
  /** 失败率阈值（0-1，如 0.05 表示 5%） */
  threshold: number;
  /** 最小样本量：样本太小不判（避免一次失败就熔断） */
  minSamples?: number;
}): { abort: boolean; rate: number; reason?: string } {
  const minSamples = input.minSamples ?? 20;
  if (input.total < minSamples) {
    return { abort: false, rate: input.total === 0 ? 0 : input.failures / input.total };
  }
  const rate = input.failures / input.total;
  if (rate > input.threshold) {
    return {
      abort: true,
      rate,
      reason: `灰度失败率 ${(rate * 100).toFixed(1)}% 超过阈值 ${(input.threshold * 100).toFixed(1)}%（样本 ${input.total}）`,
    };
  }
  return { abort: false, rate };
}

// ─────────────────────────── 分布核对 ───────────────────────────

/**
 * 核对分桶分布（供运维在放量前自检）。
 *
 * ★ 为什么值得做成函数：若哈希实现有偏（或 `rolloutId` 选得不好），
 *   实际放量比例会与配置**明显偏离**——而这类偏差只有统计才能发现，
 *   靠肉眼看几个用户是看不出来的。
 */
export function inspectDistribution(config: RolloutConfig, userIds: readonly string[]): {
  total: number;
  inRollout: number;
  actualPercentage: number;
  configuredPercentage: number;
  /** 偏差（绝对值）；超过 5 个百分点值得关注 */
  deviationPoints: number;
} {
  const before = { ...config, abortedAt: null, abortedBy: null, abortReason: null };
  const inRollout = userIds.filter((userId) => resolveRollout(before, userId).side === 'new').length;
  const actual = userIds.length === 0 ? 0 : (inRollout / userIds.length) * 100;
  const configured = Math.max(0, Math.min(100, config.percentage));
  return {
    total: userIds.length,
    inRollout,
    actualPercentage: Math.round(actual * 100) / 100,
    configuredPercentage: configured,
    deviationPoints: Math.round(Math.abs(actual - configured) * 100) / 100,
  };
}
