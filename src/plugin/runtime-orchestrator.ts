/**
 * 插件运行时编排（**从「可装配」到「能用」的那一步**）。
 *
 * ★★★ 为什么需要它（R65/R66/R74 的连续发现）：
 *
 *   1. R65：`HostApi` **只在测试里被 `new`** → 插件宿主能力在服务里全不可用；
 *   2. R66：写了装配器 `host-factory.ts`（KV 落库 + 按插件隔离，有真实 PG 测试）——
 *      但**没有地方调用它**；
 *   3. R74：找到执行原语 `runCollect(manifest, host)`（`declarative-runner.ts`）——
 *      它同样**未被接线**。
 *
 *   本文件把三者串起来：**取 manifest → 装配 HostApi → runCollect → 落事实**。
 *
 * ★ 与巡检（`Patrol`）的关系：巡检负责「**策略求值 → 动作执行**」；
 *   本编排器负责「**插件采集 → 事实写入**」。
 *   两者是**上下游**：插件写事实 → 策略读事实 → 动作被触发。
 *   ★ 因此本编排器**应当先于**巡检运行（事实是求值的输入）。
 *
 * ★ 失败处置：**单个插件失败不中断整轮**（与 `Patrol` 的「单主体失败不中断」同一原则）——
 *   一个插件出错不应让其它插件的事实采集停摆。失败记录在报告的 `failures` 里。
 */

import { runCollect, DeclarativeError } from './declarative-runner.ts';
import { FactPipeline, type FactStore } from './host-api.ts';
import { createHostApiFor, type SecretReader } from './host-factory.ts';
import type { PluginManifest } from './manifest.ts';
import type { Logger } from '../kernel/logger.ts';
import type { Db } from '../db/pool.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';

export interface PluginRunOutcome {
  pluginId: string;
  ok: boolean;
  /** 本次写入的事实字段（完整路径，如 `fact.email.domain`） */
  written: string[];
  /** 出站请求的响应状态（便于把 401/403 与 5xx 区分归因） */
  status: number | null;
  /** 逐条提取的命中情况（排障用：哪个路径没取到值） */
  extracted: { path: string; as: string; matched: number }[];
  /** 失败原因（`ok=false` 时有值） */
  error: string | null;
  durationMs: number;
}

export interface PluginRunReport {
  outcomes: PluginRunOutcome[];
  /** 成功采集的插件数 */
  succeeded: number;
  /** 失败的插件数（**不中断整轮**） */
  failed: number;
  /** 共写入的事实字段数 */
  factsWritten: number;
  durationMs: number;
}

export interface RuntimeOrchestratorOptions {
  /** 真实模式提供 `db`（KV 落库）；demo 模式省略 */
  db?: Db;
  facts: FactStore;
  secrets?: SecretReader;
  logger?: Logger;
  /**
   * 该编排器的**默认主体 id**。
   *
   * ★ 事实按主体存（没有「平台级事实」），因此**每次 `runOnce` 都必须有主体**——
   *   但主体可以**按次覆盖**（`runOnce(manifest, { userId })`），
   *   所以构造时它可以是**可选**的：`runOnce` 会在两者都缺失时**抛错**（fail-fast）。
   *   ★ 这样「同一编排器服务不同主体」的用法不需要为每次调用新建编排器。
   */
  userId?: string;
  /** 可注入的 `fetch`（**测试必需**——否则插件会真的打外网） */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * ★★ L-2：**LLM 通道**（透传给宿主 API）。
   *   ★ 未提供时插件的 `llmInvoke` **显式抛错**——它给了插件一条"受约束的路"，
   *     从而让"自己发 HTTP 绕过配额"不再是唯一选择。
   */
  llm?: import('./host-api.ts').HostApiOptions['llm'];
}

/**
 * 插件运行时编排器。
 *
 * ★ 它**只负责执行**；「何时执行」由调用方决定（调度器 / 管理端点 / 巡检前置步骤）。
 */
export class PluginRuntimeOrchestrator {
  readonly #options: RuntimeOrchestratorOptions;

  constructor(options: RuntimeOrchestratorOptions) {
    this.#options = options;
  }

  /**
   * 执行**一个**声明式插件：装配宿主 API → 采集 → 落事实。
   *
   * ★ 非 `declarative` 的插件（process/container）**不由本编排器执行**——
   *   `runCollect` 会明确拒绝，这里把它的错误转成 `ok: false` 而不是抛出。
   */
  async runOnce(manifest: PluginManifest, overrides: { userId?: string } = {}): Promise<PluginRunOutcome> {
    // ★★★ 必须包在事务里：本方法会调 `FactPipeline.emit`（内部走 `Db.query`），
    //   而 `Db.query` 有 `assertInTransaction` —— 我第一版**忘了包**，真实 PG 立刻报：
    //     `拒绝在事务外执行 query（单一事务入口，D17 前置 3）`
    //   ★ 这是本会话**第 8 次**同类问题。根因始终一样：
    //     **任何「由外部注入的回调」都可能落在事务外**。
    // ★ 主体可**按次覆盖**（`overrides.userId`）——
    //   因为「同一个编排器服务不同主体」是常见用法（如管理端手动触发某主体的采集）。
    const userId = overrides.userId ?? this.#options.userId;
    // ★ fail-fast：主体必须明确（P0-2 的语义）——不要让它一路走到 PG 才报 uuid 错
    if (userId === undefined || userId.length === 0) {
      throw new Error(
        'runOnce 需要明确的**主体 id**（构造时的 userId 或本次调用的 overrides.userId）——' +
          '事实是**按主体**存的，不存在「平台级事实」。',
      );
    }
    if (this.#options.db !== undefined) {
      return reuseOrBeginTransaction(this.#options.db, () => this.#runOnceInner(manifest, userId));
    }
    return this.#runOnceInner(manifest, userId);
  }

  async #runOnceInner(manifest: PluginManifest, userId: string): Promise<PluginRunOutcome> {
    const startedAt = Date.now();
    const now = this.#options.now?.() ?? new Date();
    try {
      // ① 装配宿主 API（KV / 缓存 / 密钥 / 出网都由它提供）
      const host = createHostApiFor(
        {
          ...(this.#options.db === undefined ? {} : { db: this.#options.db }),
          facts: this.#options.facts,
          ...(this.#options.secrets === undefined ? {} : { secrets: this.#options.secrets }),
          ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
          // ★ 用本次解析出的主体（`overrides.userId` 优先）——不是构造时的那个
          userId,
          ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
          ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
          // ★★ L-2：LLM 通道（插件只能走它 —— 配额/白名单/审计必然生效）
          ...(this.#options.llm === undefined ? {} : { llm: this.#options.llm }),
        },
        manifest,
      );

      // ② 采集（请求 → 提取 → 派生）
      const result = await runCollect(
        manifest,
        host,
        { now },
        this.#options.logger,
      );

      // ③ 落事实：**由 `FactPipeline` 加命名空间前缀并做 schema 校验**
      const pipeline = new FactPipeline({
        store: this.#options.facts,
        manifest,
        userId,
      });
      const emitted = await pipeline.emit(result.facts, now);

      return {
        pluginId: manifest.id,
        ok: true,
        written: emitted.written,
        status: result.status,
        extracted: result.extracted,
        error: null,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      // ★ 单插件失败**不抛出**（由整轮编排汇总）——一个插件出错不应让其它插件停摆
      const message = error instanceof Error ? error.message : String(error);
      const prefix = error instanceof DeclarativeError ? '[declarative] ' : '';
      return {
        pluginId: manifest.id,
        ok: false,
        written: [],
        status: null,
        extracted: [],
        error: `${prefix}${message}`,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * 执行**一轮**（多个插件）。
   *
   * ★ 顺序执行（不并发）：插件的出站请求可能打到同一上游，
   *   并发会放大对上游的压力，也可能触发限流——**先正确，再快**。
   */
  async runAll(manifests: readonly PluginManifest[]): Promise<PluginRunReport> {
    const startedAt = Date.now();
    const outcomes: PluginRunOutcome[] = [];
    for (const manifest of manifests) {
      outcomes.push(await this.runOnce(manifest));
    }
    return {
      outcomes,
      succeeded: outcomes.filter((outcome) => outcome.ok).length,
      failed: outcomes.filter((outcome) => !outcome.ok).length,
      factsWritten: outcomes.reduce((sum, outcome) => sum + outcome.written.length, 0),
      durationMs: Date.now() - startedAt,
    };
  }
}
