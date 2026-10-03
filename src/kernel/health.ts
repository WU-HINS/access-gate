/**
 * 健康检查（M6-7）—— 区分 **liveness** 与 **readiness**。
 *
 * ★ 为什么必须分开（这是容器编排里最常见的误用）：
 *   - **liveness**（`/healthz/live`）：进程是否还活着。它**只能检查进程自身**
 *     （事件循环是否响应）。若把「数据库连不上」放进 liveness，编排器会不断重启容器——
 *     而数据库故障重启应用毫无帮助，只会让故障扩大。
 *   - **readiness**（`/healthz/ready`）：是否**能接受流量**。它检查依赖（DB、迁移版本、
 *     调度器）。不 ready 时编排器只是把它移出负载均衡，不重启。
 *
 * ★ 另外两条约束：
 *   1. **探测必须有超时**：一个卡住的依赖检查会让 `/healthz` 也卡住，进而被编排器判定为
 *      进程死亡。本模块给每个检查强制超时，超时即 `unhealthy`。
 *   2. **不泄露敏感信息**：`detail` 只写「什么坏了」，不写连接串/密钥。
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  status: HealthStatus;
  /** 人类可读的原因（**不得包含密钥/连接串**） */
  detail?: string;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 结构化附加信息（如迁移版本、队列深度） */
  meta?: Record<string, unknown>;
}

export interface HealthCheck {
  name: string;
  /**
   * `liveness`：进程自身；`readiness`：依赖是否可用；`both`：两者都看。
   */
  kind: 'liveness' | 'readiness' | 'both';
  /** 该检查是否关键（critical 失败 → unhealthy；非关键失败 → degraded） */
  critical?: boolean;
  run(): Promise<HealthCheckResult> | HealthCheckResult;
}

export interface HealthReport {
  status: HealthStatus;
  checkedAt: string;
  durationMs: number;
  checks: { name: string; kind: string; status: HealthStatus; detail?: string; durationMs: number; meta?: Record<string, unknown> }[];
}

export interface HealthRegistryOptions {
  /** 单个检查的超时（默认 2 秒） */
  checkTimeoutMs?: number;
  now?: () => Date;
}

export class HealthRegistry {
  private readonly checks: HealthCheck[] = [];
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  /** 优雅关闭时置 false：readiness 立刻失败，但 liveness 仍为真（进程还在收尾） */
  private ready = true;

  constructor(options: HealthRegistryOptions = {}) {
    this.timeoutMs = options.checkTimeoutMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
  }

  register(check: HealthCheck): this {
    if (this.checks.some((c) => c.name === check.name)) {
      throw new Error(`健康检查 '${check.name}' 重复注册`);
    }
    this.checks.push(check);
    return this;
  }

  /**
   * 运行检查并汇总。
   *
   * 汇总规则（刻意保守）：
   *   - 任一 **critical** 检查 unhealthy → 整体 unhealthy；
   *   - 任一非 critical 检查 unhealthy，或任一检查 degraded → 整体 degraded；
   *   - 全部 healthy → healthy。
   *   `degraded` 表示「能服务但功能受限」——编排器应继续送流量，但监控必须告警。
   */
  async run(kind?: 'liveness' | 'readiness'): Promise<HealthReport> {
    const startedAt = process.hrtime.bigint();
    // 已标记 not-ready：readiness 直接失败（不再执行依赖检查，省掉无意义的探测）
    if (!this.ready && (kind === 'readiness' || kind === undefined)) {
      return {
        status: 'unhealthy',
        checkedAt: this.now().toISOString(),
        durationMs: 0,
        checks: [{ name: 'shutdown', kind: 'readiness', status: 'unhealthy', detail: '正在优雅关闭：不再接受新流量', durationMs: 0 }],
      };
    }
    const selected = this.checks.filter((c) => kind === undefined || c.kind === kind || c.kind === 'both');
    const results: HealthReport['checks'] = [];
    let overall: HealthStatus = 'healthy';

    for (const check of selected) {
      const checkStart = process.hrtime.bigint();
      let result: HealthCheckResult;
      try {
        result = await withTimeout(check.run(), this.timeoutMs, check.name);
      } catch (error) {
        // 探测异常/超时一律视为 unhealthy（**不能**当成健康——那等于探测失效）
        result = {
          status: 'unhealthy',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      const durationMs = Number(process.hrtime.bigint() - checkStart) / 1e6;
      results.push({
        name: check.name,
        kind: check.kind,
        status: result.status,
        durationMs: Math.round(durationMs * 100) / 100,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
        ...(result.meta === undefined ? {} : { meta: result.meta }),
      });

      if (result.status === 'unhealthy') {
        if (check.critical === false) {
          if (overall === 'healthy') overall = 'degraded';
        } else {
          overall = 'unhealthy';
        }
      } else if (result.status === 'degraded' && overall === 'healthy') {
        overall = 'degraded';
      }
    }

    return {
      status: overall,
      checkedAt: this.now().toISOString(),
      durationMs: Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100,
      checks: results,
    };
  }

  names(): string[] {
    return this.checks.map((c) => c.name);
  }

  /**
   * 标记为「不再就绪」——优雅关闭的第一步。
   *
   * ★ 为什么必须**只影响 readiness**：此刻进程还在处理在途请求与释放资源，
   *   把它标记为 liveness 失败会让编排器直接 SIGKILL，优雅关闭就白做了。
   */
  markNotReady(): void {
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }
}

function withTimeout<T>(value: Promise<T> | T, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`健康检查 '${label}' 超过 ${ms}ms 未返回`)), ms);
    Promise.resolve(value)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

// ─────────────────────────── 内置检查 ───────────────────────────

/**
 * 事件循环健康（liveness 的**唯一**正确内容）。
 *
 * 做法：用 `setTimeout(0)` 量一次实际延迟。若事件循环被同步代码长时间占住，
 * 延迟会显著放大——此时进程虽然「还在」，但已经无法服务，重启是正确的处置。
 */
export function eventLoopCheck(options: { thresholdMs?: number } = {}): HealthCheck {
  const thresholdMs = options.thresholdMs ?? 1_000;
  return {
    name: 'event_loop',
    kind: 'liveness',
    async run() {
      const started = process.hrtime.bigint();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const lagMs = Number(process.hrtime.bigint() - started) / 1e6;
      return lagMs > thresholdMs
        ? { status: 'unhealthy', detail: `事件循环延迟 ${Math.round(lagMs)}ms 超过阈值 ${thresholdMs}ms`, meta: { lagMs: Math.round(lagMs) } }
        : { status: 'healthy', meta: { lagMs: Math.round(lagMs * 100) / 100 } };
    },
  };
}

/** 数据库连通性（readiness）。`ping` 由调用方提供（复用 `Db.query`）。 */
export function databaseCheck(ping: () => Promise<void>): HealthCheck {
  return {
    name: 'database',
    kind: 'readiness',
    async run() {
      const started = process.hrtime.bigint();
      await ping();
      return { status: 'healthy', durationMs: Number(process.hrtime.bigint() - started) / 1e6 };
    },
  };
}

/**
 * 迁移状态（readiness）：库结构版本是否与代码期望一致。
 *
 * 为什么要单独检查：**「应用起来了但库结构是旧的」**是最危险的中间态——
 * 进程健康、接口可用，但每个查询都可能失败或写坏数据。
 */
export function migrationCheck(options: {
  /** 期望的迁移标识（如 `0001_init`） */
  expected: string;
  /** 读取当前已应用的迁移标识 */
  current: () => Promise<string | null>;
}): HealthCheck {
  return {
    name: 'migration',
    kind: 'readiness',
    async run() {
      const applied = await options.current();
      if (applied === null) {
        return { status: 'unhealthy', detail: '数据库中没有迁移记录（未执行 db:migrate）' };
      }
      if (applied !== options.expected) {
        return {
          status: 'unhealthy',
          detail: `迁移版本不匹配：库中为 '${applied}'，期望 '${options.expected}'`,
          meta: { applied, expected: options.expected },
        };
      }
      return { status: 'healthy', meta: { applied } };
    },
  };
}

/** 调度器状态（readiness）：是否已启动、是否有任务长期失败。 */
export function schedulerCheck(options: {
  started: () => boolean;
  /** 长期失败的任务数（如连续失败达上限） */
  stuckJobs?: () => number;
}): HealthCheck {
  return {
    name: 'scheduler',
    kind: 'readiness',
    // 调度器没起来时应用仍可服务只读请求 → 降级而非不可用
    critical: false,
    async run() {
      if (!options.started()) return { status: 'unhealthy', detail: '调度器未启动（巡检不会运行）' };
      const stuck = options.stuckJobs?.() ?? 0;
      if (stuck > 0) {
        return { status: 'degraded', detail: `有 ${stuck} 个任务连续失败达上限，需人工介入`, meta: { stuckJobs: stuck } };
      }
      return { status: 'healthy' };
    },
  };
}

// ─────────────────────────── 优雅启停 ───────────────────────────

export interface ShutdownStep {
  name: string;
  run(): Promise<void>;
  /** 超时（毫秒）；超时后继续下一步（不能因为一个资源关不掉就永远不退出） */
  timeoutMs?: number;
}

export interface GracefulShutdownOptions {
  logger?: { info: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void; error: (m: string, f?: Record<string, unknown>) => void };
  /** 整体超时（默认 30 秒）；到点强制退出 */
  totalTimeoutMs?: number;
  /** 退出函数（默认 process.exit） */
  exit?: (code: number) => void;
}

/**
 * 优雅启停（M6-7）。
 *
 * ★ 顺序必须「先停止接收新流量，再释放资源」：
 *   ① 标记 not-ready（编排器把实例移出 LB）
 *   ② 等一个**传播窗口**（让 LB 真正停止转发）
 *   ③ 停止调度器（不再发起新任务）
 *   ④ 等在途任务结束（有超时）
 *   ⑤ 关闭 HTTP 服务器
 *   ⑥ 释放 DB 连接
 *   顺序颠倒会造成「请求打到已关闭的 DB」这类 5xx 尖峰。
 */
export class GracefulShutdown {
  private readonly steps: ShutdownStep[] = [];
  private readonly logger: GracefulShutdownOptions['logger'];
  private readonly totalTimeoutMs: number;
  private readonly exit: (code: number) => void;
  private shuttingDown = false;
  private ready = true;
  private onShutdownStart: (() => void) | undefined;

  constructor(options: GracefulShutdownOptions = {}) {
    this.logger = options.logger;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 30_000;
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  /** 注册「开始关闭」的回调（通常是把 readiness 标记为 false）。 */
  onStart(callback: () => void): this {
    this.onShutdownStart = callback;
    return this;
  }

  add(step: ShutdownStep): this {
    this.steps.push(step);
    return this;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get isReady(): boolean {
    return this.ready && !this.shuttingDown;
  }

  markNotReady(): void {
    this.ready = false;
  }

  /** 注册进程信号处理（SIGTERM/SIGINT）。 */
  installSignalHandlers(): void {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        this.logger?.info('收到关闭信号', { signal });
        void this.shutdown();
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.onShutdownStart?.();
    const startedAt = Date.now();

    const globalTimer = setTimeout(() => {
      this.logger?.error('优雅关闭超时，强制退出', { totalTimeoutMs: this.totalTimeoutMs });
      this.exit(1);
    }, this.totalTimeoutMs);
    globalTimer.unref?.();

    try {
      for (const step of this.steps) {
        const stepStarted = Date.now();
        try {
          await withTimeout(step.run(), step.timeoutMs ?? 10_000, step.name);
          this.logger?.info('关闭步骤完成', { step: step.name, durationMs: Date.now() - stepStarted });
        } catch (error) {
          // 单个步骤失败不阻断后续：关不掉一个资源也要把其余资源关掉
          this.logger?.warn('关闭步骤失败（继续后续步骤）', {
            step: step.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      clearTimeout(globalTimer);
      this.logger?.info('关闭完成', { durationMs: Date.now() - startedAt });
      this.exit(0);
    }
  }
}

/** 等待一个传播窗口（让 LB 真正停止转发后再释放资源）。 */
export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
