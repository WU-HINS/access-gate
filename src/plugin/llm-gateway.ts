/**
 * LLM 网关（M4-12）—— docs/03 §1.10。
 *
 * ★ 设计立场（文档原话）：**LLM 是平台能力，不是插件**。
 *   预算、缓存、限流、成本统计、多模型路由**都在宿主**；
 *   插件只能声明 `permissions: ["llm:invoke"]` 并调用 `llm.invoke`。
 *
 * ★ 验收标准是「**插件无法绕过预算**」。要做到这一点，三件事缺一不可：
 *
 * 1. **网络白名单挡住自建客户端**（由 `HostApi` 的出站白名单负责，见 host-api.ts）；
 * 2. **预算是硬闸**：超限直接拒绝，不是「警告后继续」；
 * 3. **★ 预算检查与扣减必须原子**：先查后用在并发下会超额——
 *    N 个并发调用可能都通过检查，然后一起把预算撑爆。
 *    因此这里用 **预留（reserve）→ 调用 → 结算（settle）**：
 *    预留阶段就把额度占住，结算时按实际用量调整。
 *
 * ★ 另一处刻意的设计：**缓存命中不计费，但仍计入统计**。
 *   若把缓存命中算成「零成本」，成本报表会低估真实节省；
 *   若算成「全价」，又会掩盖缓存的价值。因此分开记录 `cachedCalls` 与 `savedTokens`。
 */

import { createHash } from 'node:crypto';

import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── 类型 ───────────────────────────

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmInvokeRequest {
  pluginId: string;
  /** 指定模型（缺省用路由默认） */
  model?: string;
  messages: readonly LlmMessage[];
  /** 期望的最大输出 token（用于预算预留） */
  maxOutputTokens?: number;
  temperature?: number;
  /** 是否允许使用缓存（默认允许） */
  cache?: boolean;
}

export interface LlmInvokeResult {
  content: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** 是否命中缓存（命中则不计费） */
  cached: boolean;
  /** 本次调用是否被拒绝（超预算/超限流/无权限） */
  rejected?: { reason: LlmRejection; message: string };
}

export type LlmRejection =
  | 'permission_denied'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'concurrency_exceeded'
  | 'unknown_model'
  | 'upstream_error';

export class LlmRejectedError extends Error {
  override readonly name = 'LlmRejectedError';
  readonly reason: LlmRejection;
  constructor(reason: LlmRejection, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** LLM 提供方（宿主注入；测试与真实实现可替换）。 */
export interface LlmProvider {
  invoke(input: {
    model: string;
    messages: readonly LlmMessage[];
    maxOutputTokens?: number;
    temperature?: number;
  }): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }>;
}

export interface ModelPricing {
  /** 每 1K 输入 token 的价格（用于成本统计；单位由部署方约定，这里用「分」） */
  inputPer1k: number;
  outputPer1k: number;
}

/**
 * ★ P1-12：LLM 缓存的类型契约住在 `src/db/llm-cache-adapter.ts`。
 *   这里刻意用 **`import type`**（运行时不存在）——网关只依赖**形状**，
 *   不依赖数据访问层的实现，因此不构成运行时耦合。
 *   （若将来要严格分层，可把接口提到本层；那是纯搬迁，不是语义变化。）
 */
import type { LlmCacheOwnerScope, LlmCacheStore } from '../db/llm-cache-adapter.ts';

export interface LlmGatewayOptions {
  provider: LlmProvider;
  logger?: Logger;
  /** 默认模型 */
  defaultModel: string;
  /** 允许的模型集合（防止插件指定任意模型名） */
  allowedModels?: readonly string[];
  /** 模型价格表（成本统计用） */
  pricing?: Record<string, ModelPricing>;
  /** 各插件的日预算（token）；未列出的插件用 `defaultDailyTokens` */
  budgets?: Record<string, { dailyTokens: number }>;
  defaultDailyTokens?: number;
  /** 每分钟调用上限（按插件） */
  perMinuteLimit?: number;
  /**
   * ★★ **配额守卫**（`docs/05 §6.4`）：提供时，限流与预算走**跨实例**的 `QuotaGuard`
   *   （键与归属同构：`quota:{ownerScope}:{ownerId}:{pluginId}:{instanceKey}:{resource}`）。
   *
   * ★ 未提供时退回**进程内**计数（向后兼容）——但那正是 L-13：
   *   **多实例部署下实际配额 = 单实例配额 × 实例数**。真实模式应注入它。
   */
  quota?: import('../core/quota-guard.ts').QuotaGuard;
  /**
   * 配额键的**归属**（默认平台级）。
   *
   * ★ 默认平台级是**如实**的：LLM 凭据与预算属于平台，且插件宿主没有站点上下文
   *   （`HostApi` 里不存在 siteId）。若将来按站点/开发者分预算，只改这里 ——
   *   键的形状不变，因此**不需要动网关的其它代码**。
   */
  quotaOwner?: {
    ownerScope: import('../core/quota-guard.ts').OwnerScope;
    ownerId: string;
    instanceKey?: string;
  };
  /** 并发上限（按插件） */
  maxConcurrency?: number;
  /** 估算 token 的粗略比例（字符数 / 该值）——用于预留 */
  charsPerToken?: number;
  /**
   * ★★ P1-12：可选的**持久**缓存（`ag_llm_cache`）。
   *
   * ★ 未提供时退回进程内 `Map`（**重启即丢**——同一批主体在每次重启后都会被
   *   **重新付费**评审一遍）。真实模式应注入 `DbLlmCacheStore`。
   */
  cacheStore?: LlmCacheStore;
  /** 持久缓存的作用域；缺省 `platform`（不同站点/开发者各自计费时按需覆盖） */
  cacheOwner?: { ownerScope: LlmCacheOwnerScope; ownerId: string };
  /** 持久缓存的 TTL（毫秒）；缺省 7 天。`null` = 永不过期 */
  cacheTtlMs?: number | null;
  /** 提示词模板版本（**只写进缓存用于排障，不参与键**——键由 `#cacheKey` 决定） */
  promptVer?: string;
  now?: () => Date;
}

// ─────────────────────────── 用量与成本 ───────────────────────────

export interface PluginUsage {
  /** 当日已用 token（结算后） */
  usedTokens: number;
  /** 当前预留中的 token（在途调用） */
  reservedTokens: number;
  dailyBudgetTokens: number;
  calls: number;
  cachedCalls: number;
  /** 缓存节省的 token（估算） */
  savedTokens: number;
  rejectedCalls: number;
  /** 累计成本（按价格表计算） */
  costUnits: number;
  /** 当日窗口起点（UTC 日期） */
  windowStart: string;
}

export interface LlmGatewayStats {
  plugins: Record<string, PluginUsage>;
  /** 全局累计（跨插件） */
  total: { calls: number; cachedCalls: number; tokens: number; costUnits: number };
}

// ─────────────────────────── 网关 ───────────────────────────

interface Reservation {
  pluginId: string;
  tokens: number;
}

export class LlmGateway {
  private readonly options: LlmGatewayOptions;
  private readonly logger: Logger | undefined;
  private readonly now: () => Date;
  private readonly usage = new Map<string, PluginUsage>();
  private readonly cache = new Map<string, { content: string; model: string; usage: { inputTokens: number; outputTokens: number } }>();
  private readonly minuteBuckets = new Map<string, { windowStart: number; count: number }>();
  private readonly inFlight = new Map<string, number>();
  /** 全局累计（不随日窗口重置） */
  private readonly total = { calls: 0, cachedCalls: 0, tokens: 0, costUnits: 0 };

  constructor(options: LlmGatewayOptions) {
    this.options = options;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  // ── 用量视图 ──

  usageOf(pluginId: string): PluginUsage {
    return this.#usageFor(pluginId);
  }

  stats(): LlmGatewayStats {
    return {
      plugins: Object.fromEntries([...this.usage.entries()].map(([id, entry]) => [id, { ...entry }])),
      total: { ...this.total },
    };
  }

  #usageFor(pluginId: string): PluginUsage {
    const windowStart = this.#windowStart();
    const existing = this.usage.get(pluginId);
    if (existing !== undefined && existing.windowStart === windowStart) return existing;
    // 跨日重置：**已用 token 归零，但累计统计（calls/costUnits）保留在 total 里**
    const fresh: PluginUsage = {
      usedTokens: 0,
      reservedTokens: 0,
      dailyBudgetTokens: this.options.budgets?.[pluginId]?.dailyTokens ?? this.options.defaultDailyTokens ?? 1_000_000,
      calls: 0,
      cachedCalls: 0,
      savedTokens: 0,
      rejectedCalls: 0,
      costUnits: 0,
      windowStart,
    };
    this.usage.set(pluginId, fresh);
    return fresh;
  }

  #windowStart(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /**
   * ★★ 构造**与归属同构**的配额键（`docs/05 §6.3.1`）。
   *
   * ★ 这里刻意**不**提供"只传资源名"的便捷重载 —— 那正是文档记录的事故形态
   *   （`llm:tokens` 这种只有资源名的键，会让"邻居掏空桶"被归因成"渠道不可信"）。
   * `ownerScope` / `ownerId` 来自 `quotaOwner`（默认平台级：LLM 凭据属于平台）。
   */
  #quotaKeyFor(pluginId: string, resource: string): import('../core/quota-guard.ts').QuotaKey {
    const owner = this.options.quotaOwner ?? { ownerScope: 'platform' as const, ownerId: 'platform' };
    return {
      ownerScope: owner.ownerScope,
      ownerId: owner.ownerId,
      pluginId,
      instanceKey: owner.instanceKey ?? 'default',
      resource,
    };
  }

  // ── 估算与缓存键 ──

  #estimateTokens(request: LlmInvokeRequest): number {
    const charsPerToken = this.options.charsPerToken ?? 4;
    const inputChars = request.messages.reduce((sum, message) => sum + message.content.length, 0);
    const inputTokens = Math.ceil(inputChars / charsPerToken);
    const outputTokens = request.maxOutputTokens ?? 512;
    return inputTokens + outputTokens;
  }

  #cacheKey(request: LlmInvokeRequest): string {
    // 只对**语义输入**取键：模型 + 消息 + 温度（不含 pluginId——
    // 不同插件问同样的问题应该能共享缓存，这是平台的成本优势）
    const payload = JSON.stringify({
      model: request.model ?? this.options.defaultModel,
      messages: request.messages.map((m) => [m.role, m.content]),
      temperature: request.temperature ?? 0,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * ★★ P1-12：读缓存——**优先持久存储**，未注入时退回进程内 `Map`。
   *
   * ★ 这里**不再判过期**：`cacheStore.get()` 自己判（`expires_at > now`）。
   *   过期语义只保留**一个实现点**，否则两处判断迟早会不一致。
   */
  async #readCache(
    cacheKey: string,
  ): Promise<
    { content: string; model: string; usage: { inputTokens: number; outputTokens: number } } | undefined
  > {
    const store = this.options.cacheStore;
    if (store === undefined) return this.cache.get(cacheKey);
    const owner = this.options.cacheOwner ?? { ownerScope: 'platform' as const, ownerId: 'platform' };
    const entry = await store.get({
      ownerScope: owner.ownerScope,
      ownerId: owner.ownerId,
      inputHash: cacheKey,
      now: this.now(),
    });
    if (entry === undefined) return undefined;
    // 存进去的就是这个形状（见 `#writeCache`）——写入侧是唯一的形状来源
    return entry.result as {
      content: string;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
    };
  }

  /** ★★ P1-12：写缓存（持久优先）。TTL 缺省 7 天；`cacheTtlMs: null` = 永不过期。 */
  async #writeCache(
    cacheKey: string,
    value: { content: string; model: string; usage: { inputTokens: number; outputTokens: number } },
    pluginId: string,
  ): Promise<void> {
    const store = this.options.cacheStore;
    if (store === undefined) {
      this.cache.set(cacheKey, value);
      return;
    }
    const owner = this.options.cacheOwner ?? { ownerScope: 'platform' as const, ownerId: 'platform' };
    const ttl = this.options.cacheTtlMs === undefined ? 7 * 24 * 3_600_000 : this.options.cacheTtlMs;
    const now = this.now();
    await store.put({
      ownerScope: owner.ownerScope,
      ownerId: owner.ownerId,
      inputHash: cacheKey,
      model: value.model,
      promptVer: this.options.promptVer ?? 'v1',
      pluginId,
      result: value,
      promptTokens: value.usage.inputTokens,
      completionTokens: value.usage.outputTokens,
      expiresAt: ttl === null ? null : new Date(now.getTime() + ttl),
      createdAt: now,
    });
  }

  // ── 调用 ──

  /**
   * 调用 LLM。
   *
   * 顺序：**权限 → 模型白名单 → 缓存 → 限流 → 并发 → 预算预留 → 调用 → 结算**。
   *
   * ★ 预算放在**最后**（预留之前的所有检查都更便宜）：
   *   但一旦进入预留就必须原子——否则并发会超额。
   */
  async invoke(request: LlmInvokeRequest, grantedPermissions: readonly string[] = ['llm:invoke']): Promise<LlmInvokeResult> {
    const usage = this.#usageFor(request.pluginId);

    // ① 权限
    if (!grantedPermissions.includes('llm:invoke')) {
      usage.rejectedCalls += 1;
      throw new LlmRejectedError('permission_denied', `插件 '${request.pluginId}' 缺少 'llm:invoke' 权限`);
    }

    // ② 模型白名单（防插件指定任意模型名绕过定价）
    const model = request.model ?? this.options.defaultModel;
    const allowed = this.options.allowedModels;
    if (allowed !== undefined && !allowed.includes(model)) {
      usage.rejectedCalls += 1;
      throw new LlmRejectedError('unknown_model', `模型 '${model}' 不在允许列表（${allowed.join(', ')}）`);
    }

    // ③ 缓存（命中不计费，但计入统计）
    const cacheKey = this.#cacheKey(request);
    if (request.cache !== false) {
      const hit = await this.#readCache(cacheKey);
      if (hit !== undefined) {
        usage.cachedCalls += 1;
        usage.savedTokens += hit.usage.inputTokens + hit.usage.outputTokens;
        this.total.cachedCalls += 1;
        this.logger?.debug('LLM 缓存命中（不计费）', { pluginId: request.pluginId, model: hit.model });
        return {
          content: hit.content,
          model: hit.model,
          usage: { ...hit.usage, totalTokens: hit.usage.inputTokens + hit.usage.outputTokens },
          cached: true,
        };
      }
    }

    // ④ 每分钟限流
    const limit = this.options.perMinuteLimit;
    if (limit !== undefined) {
      if (this.options.quota !== undefined) {
        // ★★ 走 `QuotaGuard`（**跨实例** + 键与归属同构）——`windowMs = 60_000` 即"每分钟 N 次"
        const decision = await this.options.quota.withTokenBucket(
          this.#quotaKeyFor(request.pluginId, 'llm:calls'),
          { capacity: limit, refillPerHour: limit * 60, windowMs: 60_000 },
          async () => undefined,
        );
        if (!decision.ok) {
          usage.rejectedCalls += 1;
          // ★ 文案直接来自守卫（含 `owner=… resource=…`）——§6.3.1：归因必须能定位到"谁把额度用完"
          throw new LlmRejectedError('rate_limited', decision.message);
        }
      } else {
        const nowMs = this.now().getTime();
        const windowStart = Math.floor(nowMs / 60_000) * 60_000;
        const bucket = this.minuteBuckets.get(request.pluginId);
        const count = bucket === undefined || bucket.windowStart !== windowStart ? 0 : bucket.count;
        if (count >= limit) {
          usage.rejectedCalls += 1;
          throw new LlmRejectedError(
            'rate_limited',
            `插件 '${request.pluginId}' 超过每分钟 ${limit} 次的 LLM 调用上限` +
              `（**进程内计数**：多实例下配额会被放大，见 L-13）`,
          );
        }
        this.minuteBuckets.set(request.pluginId, { windowStart, count: count + 1 });
      }
    }

    // ⑤ 并发上限
    const maxConcurrency = this.options.maxConcurrency;
    const current = this.inFlight.get(request.pluginId) ?? 0;
    if (maxConcurrency !== undefined && current >= maxConcurrency) {
      usage.rejectedCalls += 1;
      throw new LlmRejectedError('concurrency_exceeded', `插件 '${request.pluginId}' 并发 LLM 调用已达上限 ${maxConcurrency}`);
    }

    // ⑥ ★ 预算预留（原子：检查与占用在同一次同步执行内完成）
    const estimate = this.#estimateTokens(request);
    if (this.options.quota !== undefined) {
      // ★★ 走 `QuotaGuard`：预占是**跨实例**的原子操作（不是进程内计数）
      const decision = await this.options.quota.withBudget(
        this.#quotaKeyFor(request.pluginId, 'llm:tokens'),
        { daily: usage.dailyBudgetTokens, amount: estimate },
        async () => undefined,
      );
      if (!decision.ok) {
        usage.rejectedCalls += 1;
        throw new LlmRejectedError('budget_exceeded', decision.message);
      }
    } else {
      this.#reserve(request.pluginId, estimate, usage);
    }

    this.inFlight.set(request.pluginId, current + 1);
    try {
      const response = await this.options.provider.invoke({
        model,
        messages: request.messages,
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      });

      const actual = response.usage.inputTokens + response.usage.outputTokens;
      // ⑦ 结算：释放预留，按**实际**用量计入
      this.#settle(usage, estimate, actual, model);
      // ★★ `QuotaGuard` 的结算（跨实例计数）：把预占 `estimate` 调成**实际** `actual` ——
      //   允许把 used 推到 limit 之上（如实记账，让**下一次**调用被拒）
      if (this.options.quota !== undefined) {
        await this.options.quota.settle(this.#quotaKeyFor(request.pluginId, 'llm:tokens'), {
          reserved: estimate,
          actual,
        });
      }

      usage.calls += 1;
      this.total.calls += 1;
      this.total.tokens += actual;

      if (request.cache !== false) {
        await this.#writeCache(
          cacheKey,
          { content: response.content, model, usage: response.usage },
          request.pluginId,
        );
      }

      return {
        content: response.content,
        model,
        usage: { ...response.usage, totalTokens: actual },
        cached: false,
      };
    } catch (error) {
      // ★ 上游失败必须**释放预留**，否则预算会被"幽灵调用"永久占住
      this.#release(usage, estimate);
      if (this.options.quota !== undefined) {
        await this.options.quota.releaseReservation(this.#quotaKeyFor(request.pluginId, 'llm:tokens'), {
          reserved: estimate,
        });
      }
      usage.rejectedCalls += 1;
      this.logger?.warn('LLM 上游调用失败，已释放预算预留', {
        pluginId: request.pluginId,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new LlmRejectedError('upstream_error', error instanceof Error ? error.message : String(error));
    } finally {
      const after = this.inFlight.get(request.pluginId) ?? 1;
      if (after <= 1) this.inFlight.delete(request.pluginId);
      else this.inFlight.set(request.pluginId, after - 1);
    }
  }

  /**
   * 预留预算（**原子**）。
   *
   * ★ 这是「插件无法绕过预算」的核心：
   *   检查 `used + reserved + estimate <= budget` 与「把 estimate 加进 reserved」
   *   必须在**同一次同步执行**内完成（中间没有 await），
   *   否则并发调用会同时通过检查，然后一起超额。
   */
  #reserve(pluginId: string, estimate: number, usage: PluginUsage): void {
    const projected = usage.usedTokens + usage.reservedTokens + estimate;
    if (projected > usage.dailyBudgetTokens) {
      usage.rejectedCalls += 1;
      throw new LlmRejectedError(
        'budget_exceeded',
        `插件 '${pluginId}' 的日预算不足：已用 ${usage.usedTokens} + 在途 ${usage.reservedTokens} + 本次预计 ${estimate} > 预算 ${usage.dailyBudgetTokens}`,
      );
    }
    usage.reservedTokens += estimate;
  }

  #settle(usage: PluginUsage, estimate: number, actual: number, model: string): void {
    usage.reservedTokens = Math.max(0, usage.reservedTokens - estimate);
    usage.usedTokens += actual;
    const pricing = this.options.pricing?.[model];
    if (pricing !== undefined) {
      // 价格表按 1K token 计价；这里换算为「单位成本」
      const cost = (actual / 1000) * ((pricing.inputPer1k + pricing.outputPer1k) / 2);
      usage.costUnits += cost;
      this.total.costUnits += cost;
    }
  }

  #release(usage: PluginUsage, estimate: number): void {
    usage.reservedTokens = Math.max(0, usage.reservedTokens - estimate);
  }

  /** 清空缓存（运维用）。 */
  clearCache(): void {
    this.cache.clear();
  }
}
