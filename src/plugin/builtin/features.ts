/**
 * 内置插件（M4-13 / M4-14 / M4-15）—— `github` / `llm-review` / `checkin`。
 * 依据 docs/03 §1.9（内置与第三方**完全同构**）、§1.10（LLM 是平台能力）、§1.17（feature 插件）。
 *
 * ★ 本文件体现三条设计立场，它们都是文档明确要求的：
 *
 * 1. **内置插件与第三方插件同构**（§1.9）：这里只是**三个普通插件的实现**，
 *    没有任何「内置特权」。宿主对它们的加载路径与第三方一致——
 *    因此「删掉 `src/plugin/builtin/` 主程序仍能启动」这条验收标准才可能成立。
 *
 * 2. **`llm-review` 不认识 GitHub**（§1.10）：它声明 `consumes: ['*.items']` 这样的
 *    **通用数组字段**，产出 `llm.pr_score`。同一个插件既能评 GitHub PR、
 *    也能评 GitLab MR、也能评「某社区的发帖质量」——只要上游 channel 产出数组字段。
 *    ★ 因此它的入参类型是**中性的** `ReviewItem[]`，而不是 `GitHubPr[]`。
 *
 * 3. **LLM 调用走宿主**（§1.10）：`llm-review` 只声明 `llm:invoke` 权限，
 *    预算/缓存/限流由宿主（`src/plugin/llm-gateway.ts`）负责。它**不自建客户端**。
 */

import { createHash } from 'node:crypto';

import type { PluginManifest } from '../manifest.ts';

// ═══════════════════════════ M4-13 `github` ═══════════════════════════

/**
 * GitHub channel 插件（声明式采集）。
 *
 * ★ 采集本身由宿主的出站通道代发（`http:egress` 白名单），
 *   插件只声明「要请求什么、从响应里取哪些字段」——这就是 `declarative` 的含义。
 */
export const GITHUB_MANIFEST: PluginManifest = {
  apiVersion: 'gate.plugin/v1',
  kind: 'channel',
  id: 'github',
  name: 'GitHub',
  version: '1.0.0',
  runtime: 'declarative',
  permissions: ['http:egress'],
  local: true,
  configSchema: {
    type: 'object',
    properties: {
      // 开发者级配置：token 只配一次，被该开发者名下所有站点共享（M4-3）
      token: { type: 'string', title: 'Personal Access Token', secret: true },
      username: { type: 'string', title: 'GitHub 用户名' },
    },
    required: ['username'],
  },
  configScope: 'developer',
  instances: { mode: 'singleton' },
  collect: {
    request: { method: 'GET', url: 'https://api.github.com/users/{{config.username}}' },
    extract: [
      { path: '$.public_repos', as: 'public_repos' },
      { path: '$.followers', as: 'followers' },
      { path: '$.created_at', as: 'created_at' },
    ],
  },
  factSchema: {
    type: 'object',
    properties: {
      public_repos: { type: 'integer' },
      followers: { type: 'integer' },
      created_at: { type: 'string' },
    },
  },
} as unknown as PluginManifest;

/** 计算账号年龄（天）——一个**纯函数**，便于测试且不依赖网络。 */
export function accountAgeDays(createdAt: string, now: Date): number {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - created.getTime()) / 86_400_000));
}

// ═══════════════════════════ M4-14 `llm-review` ═══════════════════════════

export const LLM_REVIEW_MANIFEST: PluginManifest = {
  apiVersion: 'gate.plugin/v1',
  kind: 'enricher',
  id: 'llm-review',
  name: 'LLM 质量评审',
  version: '1.0.0',
  runtime: 'declarative',
  permissions: ['llm:invoke', 'cache:write:self'],
  local: true,
  // ★ 只声明**消费通用数组字段**，不出现任何具体系统名
  consumes: ['items'],
  produces: {
    namespace: 'llm',
    factSchema: {
      type: 'object',
      properties: {
        pr_score: { type: 'number', minimum: 0, maximum: 100 },
        pr_count_effective: { type: 'integer' },
        reason: { type: 'string' },
      },
    },
  },
  configSchema: {
    type: 'object',
    properties: {
      promptVersion: { type: 'string', default: 'v3' },
      batchSize: { type: 'integer', default: 5 },
      maxItems: { type: 'integer', default: 30 },
      rubric: { type: 'object' },
      model: { type: 'string', default: 'gpt-4o-mini' },
      budget: { type: 'object' },
    },
  },
  configScope: 'site',
  instances: { mode: 'singleton' },
} as unknown as PluginManifest;

/** 评分细则（四个维度，权重之和应为 1；不精确时由 `normalizeRubric` 归一化）。 */
export interface Rubric {
  substantiality: number;
  influence: number;
  complexity: number;
  collaboration: number;
}

/** 默认评分细则（权重之和为 1）。 */
export const DEFAULT_RUBRIC: Rubric = { substantiality: 0.4, influence: 0.25, complexity: 0.2, collaboration: 0.15 };

/**
 * **中性的**评审条目（不绑任何具体系统）。
 *
 * ★ 这是「`llm-review` 不认识 GitHub」在类型上的体现：
 *   它只要求「有标题、可能有正文、可能有关联数字」。
 *   上游是 GitHub PR、GitLab MR 还是论坛帖子，与它无关。
 */
export interface ReviewItem {
  /** 标题（必填：没有标题的条目无法评审） */
  title: string;
  /** 正文/描述 */
  body?: string;
  /** 变更规模（行数 / 字数，语义由上游决定） */
  size?: number;
  /** 讨论数（评论 / 回复） */
  discussions?: number;
  /** 关联方（协作者 / 共同作者） */
  collaborators?: number;
}

export interface LlmReviewConfig {
  rubric?: Partial<Rubric>;
  maxItems?: number;
  batchSize?: number;
  model?: string;
}

export interface LlmReviewResult {
  prScore: number;
  prCountEffective: number;
  reason: string;
  /** 是否使用了 LLM（false 表示走了纯启发式——用于「LLM 不可用时的降级」） */
  usedLlm: boolean;
}

/** LLM 调用接口（由宿主注入；**插件不自建客户端**）。 */
export interface ReviewLlm {
  invoke(input: { model: string; messages: { role: 'system' | 'user'; content: string }[] }): Promise<{ content: string }>;
}

/** 权重归一化（配置可能不精确到 1；不归一化会让总分**系统性偏移**）。 */
export function normalizeRubric(rubric: Partial<Rubric> = {}): Rubric {
  const merged = { ...DEFAULT_RUBRIC, ...rubric };
  const total = merged.substantiality + merged.influence + merged.complexity + merged.collaboration;
  if (total <= 0) return { ...DEFAULT_RUBRIC };
  return {
    substantiality: merged.substantiality / total,
    influence: merged.influence / total,
    complexity: merged.complexity / total,
    collaboration: merged.collaboration / total,
  };
}

/**
 * 单条目的启发式打分（0-100）。
 *
 * ★ 为什么需要启发式而不是「全部交给 LLM」：
 *   1. **LLM 不可用时的降级路径**（预算耗尽 / 上游故障）——不能让整条评审链断掉；
 *   2. **成本**：先用启发式过滤掉明显无意义的条目（空标题、零变更），
 *      再把真正需要判断的交给 LLM。
 */
export function scoreItemHeuristically(item: ReviewItem, rubric: Rubric = DEFAULT_RUBRIC): { score: number; parts: Record<string, number> } {
  const clamp = (value: number): number => Math.max(0, Math.min(100, value));
  // 每个维度映射到 0-100（阈值来自经验，可配置化）
  const parts = {
    substantiality: clamp((item.body ?? '').length / 10), // 1000 字符正文 ≈ 满分
    influence: clamp((item.discussions ?? 0) * 10),
    complexity: clamp((item.size ?? 0) / 5), // 500 行 ≈ 满分
    collaboration: clamp((item.collaborators ?? 0) * 20),
  };
  const score =
    parts.substantiality * rubric.substantiality +
    parts.influence * rubric.influence +
    parts.complexity * rubric.complexity +
    parts.collaboration * rubric.collaboration;
  return { score: Math.round(score * 100) / 100, parts };
}

/**
 * 评审一批条目。
 *
 * ★ 三处刻意的设计：
 *   1. **空标题条目直接剔除**（不计入 `prCountEffective`）——它们无论怎么评都是噪音；
 *   2. **`maxItems` 截断**：条目过多时只评最有信息量的（按 size 降序），
 *      避免一次评审耗尽 LLM 预算；
 *   3. **LLM 失败时降级到启发式**（`usedLlm: false`），而不是让整轮失败。
 */
export async function reviewItems(
  items: readonly ReviewItem[],
  config: LlmReviewConfig,
  deps: { llm?: ReviewLlm; cache?: Map<string, LlmReviewResult> },
): Promise<LlmReviewResult> {
  const rubric = normalizeRubric(config.rubric);
  const maxItems = config.maxItems ?? 30;
  const model = config.model ?? 'gpt-4o-mini';

  // ① 剔除无效条目
  const valid = items.filter((item) => item.title.trim().length > 0);
  if (valid.length === 0) {
    return { prScore: 0, prCountEffective: 0, reason: '没有有效条目（全部缺少标题）', usedLlm: false };
  }

  // ② 截断：优先保留信息量大的（size 降序），再按原顺序稳定排序
  const selected = [...valid]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.size ?? 0) - (a.item.size ?? 0) || a.index - b.index)
    .slice(0, maxItems)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.item);

  // ③ 启发式基线（永远先算：既是降级路径，也是与 LLM 结果对照的基线）
  const heuristicScores = selected.map((item) => scoreItemHeuristically(item, rubric).score);
  const heuristicAverage = heuristicScores.reduce((sum, score) => sum + score, 0) / selected.length;

  // ④ 缓存键：只对**语义输入**取（同一条目同细则不重复计费）
  const cacheKey = createHash('sha256')
    .update(JSON.stringify({ promptVersion: config.model ?? '', rubric, items: selected.map((item) => [item.title, item.body ?? '', item.size ?? 0]) }))
    .digest('hex');
  const cached = deps.cache?.get(cacheKey);
  if (cached !== undefined) return { ...cached, reason: `${cached.reason}（缓存命中）` };

  // ⑤ LLM 评审（失败则降级）
  let llmScore: number | undefined;
  let usedLlm = false;
  let reason = '';
  if (deps.llm !== undefined) {
    try {
      const response = await deps.llm.invoke({
        model,
        messages: [
          { role: 'system', content: `你是代码贡献质量评审员（细则权重 ${JSON.stringify(rubric)}）。只输出一个 0-100 的整数。` },
          { role: 'user', content: JSON.stringify(selected.slice(0, config.batchSize ?? 5)) },
        ],
      });
      const parsed = Number.parseInt(response.content.trim(), 10);
      if (Number.isFinite(parsed)) {
        llmScore = Math.max(0, Math.min(100, parsed));
        usedLlm = true;
        reason = `LLM 评审（模型 ${model}），启发式基线 ${heuristicAverage.toFixed(1)}`;
      } else {
        reason = `LLM 返回无法解析（'${response.content.slice(0, 40)}'），已降级到启发式`;
      }
    } catch (error) {
      // ★ 降级而不是失败：LLM 预算耗尽 / 上游故障不应让整条评审链断掉
      reason = `LLM 调用失败（${error instanceof Error ? error.message : String(error)}），已降级到启发式`;
    }
  } else {
    reason = '未提供 LLM 能力，使用启发式评分';
  }

  // ⑥ 融合：LLM 结果与启发式各占一半（避免 LLM 单点失真，也避免启发式过于机械）
  const finalScore = llmScore === undefined ? heuristicAverage : (llmScore + heuristicAverage) / 2;
  const result: LlmReviewResult = {
    prScore: Math.round(finalScore * 100) / 100,
    prCountEffective: selected.length,
    reason,
    usedLlm,
  };
  deps.cache?.set(cacheKey, result);
  return result;
}

// ═══════════════════════════ M4-15 `checkin` ═══════════════════════════

export const CHECKIN_MANIFEST: PluginManifest = {
  apiVersion: 'gate.plugin/v1',
  kind: 'feature',
  id: 'checkin',
  name: '每日签到',
  version: '1.0.0',
  runtime: 'declarative',
  permissions: ['storage:write:self', 'route:register', 'ui:contribute:nav,page,slot', 'policy:read:self'],
  local: true,
  configSchema: {
    type: 'object',
    properties: {
      requirePolicy: { type: 'string', title: '需要哪条策略为 granted' },
      quotaMin: { type: 'integer', default: 1000 },
      quotaMax: { type: 'integer', default: 5000 },
      streakBonus: { type: 'array', title: '连签阶梯' },
      timezone: { type: 'string', default: 'Asia/Shanghai' },
    },
  },
  configScope: 'site',
  instances: { mode: 'singleton' },
} as unknown as PluginManifest;

export interface StreakBonus {
  /** 达到该连续天数时触发 */
  streak: number;
  /** 额外奖励 */
  bonus: number;
}

export interface CheckinConfig {
  requirePolicy?: string;
  quotaMin?: number;
  quotaMax?: number;
  streakBonus?: readonly StreakBonus[];
  timezone?: string;
}

export interface CheckinState {
  /** 上次签到的**本地日期**（`YYYY-MM-DD`） */
  lastDate: string | null;
  /** 当前连续天数 */
  streak: number;
}

export type CheckinOutcome =
  | { ok: true; streak: number; baseAward: number; bonusAward: number; totalAward: number; reason: string }
  | { ok: false; reason: 'already_checked_in' | 'policy_not_granted'; message: string };

/**
 * 计算某时刻在指定时区的**本地日期**。
 *
 * ★ 为什么必须按配置时区算：签到的「今天」是**用户所在地的今天**。
 *   用服务器 UTC 会导致跨时区用户在「当地还是昨天」时被判成「今天已签到」，
 *   或反之——这类 off-by-one 在跨时区产品里是常见投诉来源。
 */
export function localDateOf(now: Date, timezone: string): string {
  try {
    // en-CA 的短日期格式恰好是 YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    // 时区非法 → 回落到 UTC（不抛错：签到不该因配置笔误而完全不可用）
    return now.toISOString().slice(0, 10);
  }
}

/** 前一天的本地日期（用于判断连签）。 */
export function previousDateOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * 基础奖励（在 `quotaMin..quotaMax` 之间）。
 *
 * ★ 用**确定性哈希**而不是 `Math.random()`：同一用户在同一天重复计算得到同一奖励，
 *   这样「重试 / 重放」不会产生不同金额（与灰度分桶同一理由）。
 *   奖励金额一旦展示给用户，就不能因为一次重试而变。
 */
export function baseAwardOf(userId: string, date: string, config: CheckinConfig): number {
  const min = config.quotaMin ?? 1000;
  const max = config.quotaMax ?? 5000;
  if (max <= min) return min;
  const digest = createHash('sha256').update(`${userId}\u0000${date}`, 'utf8').digest();
  return min + (digest.readUInt32BE(0) % (max - min + 1));
}

/** 连签阶梯加成（取**已达到的最高档**，而不是累加——阶梯语义是「达标即享」）。 */
export function streakBonusOf(streak: number, config: CheckinConfig): number {
  const bonuses = config.streakBonus ?? [];
  let best = 0;
  for (const entry of bonuses) {
    if (streak >= entry.streak && entry.bonus > best) best = entry.bonus;
  }
  return best;
}

/**
 * 执行签到。
 *
 * ★ 三条语义：
 *   1. **同一天只能签一次**（按本地日期判断，不是按 UTC）；
 *   2. **连签**：昨天签过 → streak+1；否则重新从 1 开始（断签不清历史，只重置连续数）；
 *   3. **策略门槛**：若配置了 `requirePolicy`，该策略必须是 `granted` 才能签到——
 *      这是「签到资格由策略决定」的落点（策略系统与功能插件的耦合点，且**只通过配置耦合**）。
 */
export function performCheckin(input: {
  userId: string;
  now: Date;
  state: CheckinState;
  config: CheckinConfig;
  /** 已 granted 的策略 code 集合 */
  grantedPolicies?: readonly string[];
}): CheckinOutcome {
  const timezone = input.config.timezone ?? 'Asia/Shanghai';
  const today = localDateOf(input.now, timezone);

  // ① 策略门槛
  if (input.config.requirePolicy !== undefined && input.config.requirePolicy.length > 0) {
    const granted = input.grantedPolicies ?? [];
    if (!granted.includes(input.config.requirePolicy)) {
      return {
        ok: false,
        reason: 'policy_not_granted',
        message: `签到需要策略 '${input.config.requirePolicy}' 处于 granted 状态（当前未满足）`,
      };
    }
  }

  // ② 同日重复签到
  if (input.state.lastDate === today) {
    return { ok: false, reason: 'already_checked_in', message: `今天（${today}）已经签到过了` };
  }

  // ③ 连签判定
  const continued = input.state.lastDate !== null && input.state.lastDate === previousDateOf(today);
  const streak = continued ? input.state.streak + 1 : 1;

  const baseAward = baseAwardOf(input.userId, today, input.config);
  const bonusAward = streakBonusOf(streak, input.config);
  return {
    ok: true,
    streak,
    baseAward,
    bonusAward,
    totalAward: baseAward + bonusAward,
    reason: continued
      ? `连续第 ${streak} 天签到（基础 ${baseAward}${bonusAward > 0 ? ` + 连签奖励 ${bonusAward}` : ''}）`
      : `签到成功（基础 ${baseAward}）；此前未连续签到，连续数从 1 开始`,
  };
}

/** 连签日历（供 UI 的 calendar 块渲染）。 */
export function streakCalendar(state: CheckinState, now: Date, config: CheckinConfig, days = 30): { date: string; checked: boolean; isToday: boolean }[] {
  const timezone = config.timezone ?? 'Asia/Shanghai';
  const today = localDateOf(now, timezone);
  const out: { date: string; checked: boolean; isToday: boolean }[] = [];
  let cursor = today;
  for (let i = 0; i < days; i += 1) {
    // 只标记「今天」与「上次签到日」——完整历史应由 ag_checkin_records 提供
    const checked = cursor === today ? state.lastDate === today : cursor === state.lastDate;
    out.push({ date: cursor, checked, isToday: cursor === today });
    cursor = previousDateOf(cursor);
  }
  return out;
}

/** 三个内置插件的 manifest 汇总（供宿主注册与验收核对）。 */
export const BUILTIN_MANIFESTS: readonly PluginManifest[] = [GITHUB_MANIFEST, LLM_REVIEW_MANIFEST, CHECKIN_MANIFEST];
