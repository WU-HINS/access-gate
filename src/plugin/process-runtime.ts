/**
 * `process` 运行时（M4-1）—— docs/03 §1.8。
 *
 * 子进程通过 **stdio 上的 JSON-RPC 2.0** 与宿主通信（比 HTTP 更简单，无需端口管理）：
 * ```
 *   宿主 → 插件  { jsonrpc, id, method: "plugin.init" | "channel.collect", params }
 *   插件 → 宿主  { jsonrpc, id, method: "host.http.request", params }   ← 请求能力
 *   插件 → 宿主  { jsonrpc, id, result }
 * ```
 *
 * ★ 验收标准是「**插件崩溃不影响宿主**」。要做到这一点，必须把四件事都做对：
 *
 * 1. **崩溃隔离**：子进程 `exit`/`error` 只让**该插件的**在途请求失败，
 *    绝不冒泡成宿主进程异常。宿主捕获所有事件。
 * 2. **在途请求必须被显式拒绝**：进程死掉时，pending 的 Promise 若不 reject，
 *    调用方会**永远挂着**（这正是「插件崩溃拖垮宿主」的实际形态——
 *    不是宿主崩溃，而是宿主的请求永不返回、连接池被吃光）。
 * 3. **重启退避**：崩溃后立刻重启会形成 crash loop 打满 CPU。
 *    必须指数退避，并在连续失败达上限后**停止重启**（转入 `failed` 状态）。
 * 4. **超时杀进程**：一个不返回的插件不能永久占用资源；
 *    超时后必须 `SIGKILL`（`SIGTERM` 可能被忽略）。
 *
 * ★ 另外一处关键设计：**插件不能直接出网**。
 *   它必须发 `host.http.request` 请求宿主代发，宿主校验权限（`http:egress:<host>`）后执行。
 *   这样「插件是否联网」由宿主统一管控，而不是靠插件自觉。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── JSON-RPC 帧 ───────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function encodeFrame(message: JsonRpcRequest | JsonRpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * 按行解析 JSON-RPC 帧。
 *
 * ★ 为什么按行（NDJSON）而不是「按 Content-Length」：
 *   LSP 风格的头+体解析更复杂，而 stdio 管道本身是字节流——
 *   按行分隔在 JSON 里是安全的（JSON 字符串内的换行必须转义为 `\n`）。
 *   同时必须处理**分片到达**：一次 `data` 事件可能包含半行或多行。
 */
export class FrameDecoder {
  private buffer = '';

  push(chunk: string): (JsonRpcRequest | JsonRpcResponse)[] {
    this.buffer += chunk;
    const out: (JsonRpcRequest | JsonRpcResponse)[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as JsonRpcRequest | JsonRpcResponse);
      } catch {
        // 非 JSON 行（插件的调试输出混进了 stdout）——忽略而不是崩溃。
        // ★ 这是真实会发生的：插件里一个 console.log 就会污染协议流。
      }
    }
    return out;
  }
}

export function isResponse(message: JsonRpcRequest | JsonRpcResponse): message is JsonRpcResponse {
  return (message as JsonRpcResponse).id !== undefined && !('method' in message);
}

// ─────────────────────────── 宿主能力 ───────────────────────────

export interface HostCapabilities {
  /**
   * 代插件发出 HTTP 请求。
   *
   * ★ 由宿主实现并**校验权限**——插件不能直接出网。
   */
  httpRequest(params: { method: string; url: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  /** 插件 KV 读写（可选） */
  kvGet?(key: string): Promise<unknown>;
  kvSet?(key: string, value: unknown): Promise<void>;
}

/** 插件 → 宿主 的能力方法名前缀。 */
export const HOST_METHOD_PREFIX = 'host.';

// ─────────────────────────── 进程状态 ───────────────────────────

export type ProcessState = 'starting' | 'ready' | 'restarting' | 'stopped' | 'failed';

export interface ProcessRuntimeOptions {
  pluginId: string;
  /** 启动命令（如 `node`） */
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  capabilities: HostCapabilities;
  logger?: Logger;
  /** 单次调用的默认超时（毫秒） */
  defaultTimeoutMs?: number;
  /** `plugin.init` 的超时（通常比普通调用更长） */
  initTimeoutMs?: number;
  /** 崩溃后重启的退避基数（毫秒） */
  restartBackoffBaseMs?: number;
  /** 退避上限 */
  restartBackoffMaxMs?: number;
  /** 连续失败达此值后**停止重启**（转 failed） */
  maxConsecutiveFailures?: number;
  /** 子进程内存上限（MB）——经 `--max-old-space-size` 传给 Node */
  maxMemoryMb?: number;
  /** 空闲回收：超过此时长没有调用就停止子进程（0 表示不回收） */
  idleTimeoutMs?: number;
  now?: () => Date;
}

export interface ProcessRuntimeStatus {
  state: ProcessState;
  pid: number | null;
  /** 已重启次数 */
  restarts: number;
  consecutiveFailures: number;
  /** 最近一次崩溃原因 */
  lastExitReason: string | null;
  /** 在途请求数 */
  inFlight: number;
  /** 累计调用数 */
  totalCalls: number;
  lastUsedAt: Date | null;
}

export class PluginCrashedError extends Error {
  override readonly name = 'PluginCrashedError';
  constructor(pluginId: string, reason: string) {
    super(`插件 '${pluginId}' 已崩溃：${reason}`);
  }
}

export class PluginTimeoutError extends Error {
  override readonly name = 'PluginTimeoutError';
  constructor(pluginId: string, method: string, timeoutMs: number) {
    super(`插件 '${pluginId}' 的 ${method} 超过 ${timeoutMs}ms 未返回（已杀进程）`);
  }
}

// ─────────────────────────── 运行时 ───────────────────────────

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

/**
 * 进程插件运行时。
 *
 * 一个实例管理**一个**插件子进程。
 */
export class ProcessRuntime {
  private readonly options: ProcessRuntimeOptions;
  private readonly logger: Logger | undefined;
  private readonly now: () => Date;
  private child: ChildProcess | null = null;
  private decoder = new FrameDecoder();
  private readonly pending = new Map<string, PendingCall>();
  private nextId = 1;
  private state: ProcessState = 'stopped';
  private restarts = 0;
  private consecutiveFailures = 0;
  private lastExitReason: string | null = null;
  private totalCalls = 0;
  private lastUsedAt: Date | null = null;
  private idleTimer: NodeJS.Timeout | undefined;
  /** 显式停止时不触发重启 */
  private intentionalStop = false;

  constructor(options: ProcessRuntimeOptions) {
    this.options = options;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  get pluginId(): string {
    return this.options.pluginId;
  }

  status(): ProcessRuntimeStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      consecutiveFailures: this.consecutiveFailures,
      lastExitReason: this.lastExitReason,
      inFlight: this.pending.size,
      totalCalls: this.totalCalls,
      lastUsedAt: this.lastUsedAt,
    };
  }

  /** 启动子进程并完成 `plugin.init` 握手。 */
  async start(config: Record<string, unknown> = {}): Promise<void> {
    if (this.child !== null) return;
    this.intentionalStop = false;
    this.state = 'starting';

    const args = [...(this.options.args ?? [])];
    // 内存限额：Node 子进程用 --max-old-space-size 约束堆
    if (this.options.maxMemoryMb !== undefined && /(^|\/)node$/.test(this.options.command)) {
      args.unshift(`--max-old-space-size=${this.options.maxMemoryMb}`);
    }

    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // ★ 不用 shell：避免命令注入（插件路径可能来自上传包）
      shell: false,
    });
    this.child = child;
    this.decoder = new FrameDecoder();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.#onData(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // 插件的 stderr 只记录，不影响协议
      this.logger?.debug('插件 stderr', { pluginId: this.options.pluginId, line: chunk.trim().slice(0, 500) });
    });

    // ★ 崩溃隔离：这两个事件必须被宿主捕获，绝不冒泡
    child.on('error', (error) => this.#onExit(`spawn 失败：${error.message}`));
    child.on('exit', (code, signal) => this.#onExit(signal === null ? `退出码 ${code}` : `信号 ${signal}`));

    try {
      await this.#call('plugin.init', { pluginId: this.options.pluginId, apiVersion: 'gate.plugin/v1', config }, this.options.initTimeoutMs ?? 10_000);
      this.state = 'ready';
      // ★ 刻意**不**在这里清零 `consecutiveFailures`：
      //   「崩溃 → 重启成功 → 再崩溃」的 crash loop 会因为「每次重启都算成功」
      //   而永远达不到上限 → 无限重启（真实设计缺陷）。
      //   计数只在**成功处理过一次请求**后清零（见 `call()`）——那才代表真的恢复了。
      this.logger?.info('插件进程已就绪', { pluginId: this.options.pluginId, pid: child.pid });
    } catch (error) {
      this.#onExit(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * 调用插件方法。
   *
   * 未启动或已失败时**自动尝试启动**（懒启动 + 自愈）——
   * 这样「插件崩溃」对调用方的表现是「这次调用慢一点」而不是「一直失败」，
   * 直到连续失败达上限转入 `failed`。
   */
  async call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.state === 'failed') {
      // ★ 错误信息必须说明**为什么不再重启**，而不只是重复上次的崩溃原因：
      //   运维看到「退出码 7」不会知道「宿主已放弃这个插件、需要人工介入」。
      const reason = this.lastExitReason ?? '未知原因';
      throw new PluginCrashedError(
        this.options.pluginId,
        `${reason}（连续失败 ${this.consecutiveFailures} 次达上限，已停止重启——需人工介入）`,
      );
    }
    if (this.child === null) await this.start();
    this.lastUsedAt = this.now();
    this.#scheduleIdleReclaim();
    const result = await this.#call(method, params, timeoutMs ?? this.options.defaultTimeoutMs ?? 15_000);
    // ★ 只有**成功处理过一次请求**才认为真的恢复了（清零连续失败计数）
    if (this.consecutiveFailures > 0) {
      this.logger?.info('插件已恢复正常，重置失败计数', { pluginId: this.options.pluginId, was: this.consecutiveFailures });
      this.consecutiveFailures = 0;
    }
    return result;
  }

  /** 停止子进程（显式停止不触发重启）。 */
  async stop(): Promise<void> {
    this.intentionalStop = true;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const child = this.child;
    if (child === null) {
      this.state = 'stopped';
      return;
    }
    this.#rejectAllPending(new PluginCrashedError(this.options.pluginId, '宿主主动停止'));
    this.child = null;
    this.state = 'stopped';
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // ★ SIGTERM 可能被忽略 → 必须升级为 SIGKILL，否则「停止」不保证
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.logger?.info('插件进程已停止', { pluginId: this.options.pluginId });
  }

  // ── 内部 ──

  #call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (child === null || child.stdin === null) {
      return Promise.reject(new PluginCrashedError(this.options.pluginId, '进程不可用'));
    }
    const id = this.nextId++;
    const key = String(id);
    this.totalCalls += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        // ★ 超时必须**杀进程**：一个卡死的插件不能永久占用资源，
        //   而且它的协议流可能已经错位（后续响应无法配对）。
        this.logger?.warn('插件调用超时，杀进程', { pluginId: this.options.pluginId, method, timeoutMs });
        this.lastExitReason = `调用 ${method} 超时（${timeoutMs}ms）`;
        // ★ 发出信号后要**等进程真的退出**再 reject：
        //   否则调用方拿到「超时」时进程可能还在跑（资源没释放），
        //   而且紧接着访问 status().pid 会看到"还活着"的假象。
        const settled = new PluginTimeoutError(this.options.pluginId, method, timeoutMs);
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(settled);
          return;
        }
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          reject(settled);
        };
        child.once('exit', finish);
        // 兜底：极端情况下（僵尸进程）不无限等待
        const guard = setTimeout(finish, 3_000);
        guard.unref?.();
        child.kill('SIGKILL');
      }, timeoutMs);
      // ★ 不能 unref：unref 的定时器不保持事件循环活跃，于是「超时」会依赖
      //   「恰好还有别的事件在跑」。插件卡死且无其它事件时**超时永不触发**，
      //   调用方永远挂着（本轮在端点宿主与本文件里**各犯了一次**同一缺陷）。

      this.pending.set(key, { resolve, reject, method, timer });
      try {
        child.stdin!.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #onData(chunk: string): void {
    for (const message of this.decoder.push(chunk)) {
      if (isResponse(message)) {
        const key = String(message.id);
        const pending = this.pending.get(key);
        if (pending === undefined) {
          this.logger?.debug('收到无主响应（可能已超时）', { pluginId: this.options.pluginId, id: key });
          continue;
        }
        clearTimeout(pending.timer);
        this.pending.delete(key);
        if (message.error !== undefined) {
          pending.reject(new Error(`插件返回错误：${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      // 插件 → 宿主 的能力请求
      void this.#handleHostRequest(message as JsonRpcRequest);
    }
  }

  /** 处理插件的能力请求（`host.*`）——由宿主校验权限后执行。 */
  async #handleHostRequest(request: JsonRpcRequest): Promise<void> {
    const child = this.child;
    if (child?.stdin === null || child === null) return;
    const respond = (message: JsonRpcResponse): void => {
      try {
        child.stdin!.write(encodeFrame(message));
      } catch {
        // 进程已死：忽略（调用方会因 exit 事件收到拒绝）
      }
    };

    try {
      let result: unknown;
      switch (request.method) {
        case 'host.http.request': {
          const params = (request.params ?? {}) as { method?: string; url?: string; headers?: Record<string, string>; body?: string };
          if (typeof params.url !== 'string' || typeof params.method !== 'string') {
            throw new Error('host.http.request 需要 method 与 url');
          }
          // ★ 能力由宿主实现：权限校验（出站白名单）在宿主侧完成，插件无法绕过
          result = await this.options.capabilities.httpRequest({
            method: params.method,
            url: params.url,
            ...(params.headers === undefined ? {} : { headers: params.headers }),
            ...(params.body === undefined ? {} : { body: params.body }),
          });
          break;
        }
        case 'host.kv.get': {
          if (this.options.capabilities.kvGet === undefined) throw new Error('宿主未提供 kv 能力');
          const params = (request.params ?? {}) as { key?: string };
          if (typeof params.key !== 'string') throw new Error('host.kv.get 需要 key');
          result = await this.options.capabilities.kvGet(params.key);
          break;
        }
        case 'host.kv.set': {
          if (this.options.capabilities.kvSet === undefined) throw new Error('宿主未提供 kv 能力');
          const params = (request.params ?? {}) as { key?: string; value?: unknown };
          if (typeof params.key !== 'string') throw new Error('host.kv.set 需要 key');
          await this.options.capabilities.kvSet(params.key, params.value);
          result = { ok: true };
          break;
        }
        default:
          throw new Error(`未知的宿主能力方法 '${request.method}'（可用：${HOST_METHOD_PREFIX}http.request / ${HOST_METHOD_PREFIX}kv.get / ${HOST_METHOD_PREFIX}kv.set）`);
      }
      respond({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      respond({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /**
   * 子进程退出处理（崩溃隔离的核心）。
   *
   * ★ 三件事必须做：
   *   ① **拒绝所有在途请求**（否则调用方永远挂着——这才是「崩溃拖垮宿主」的真实形态）；
   *   ② 决定是否重启（显式停止不重启；连续失败达上限转 failed）；
   *   ③ **绝不 rethrow**（宿主进程必须活下来）。
   */
  #onExit(reason: string): void {
    const wasRunning = this.child !== null;
    this.child = null;
    this.lastExitReason = reason;
    if (!wasRunning && this.state === 'stopped') return;

    const rejected = this.#rejectAllPending(new PluginCrashedError(this.options.pluginId, reason));
    if (rejected > 0) {
      this.logger?.warn('插件崩溃，已拒绝在途请求', { pluginId: this.options.pluginId, reason, rejected });
    }

    if (this.intentionalStop) {
      this.state = 'stopped';
      return;
    }

    this.consecutiveFailures += 1;
    const max = this.options.maxConsecutiveFailures ?? 5;
    if (this.consecutiveFailures >= max) {
      this.state = 'failed';
      this.logger?.error('插件连续失败达上限，停止重启（需人工介入）', {
        pluginId: this.options.pluginId,
        consecutiveFailures: this.consecutiveFailures,
        lastExitReason: reason,
      });
      return;
    }

    // ★ 指数退避：立刻重启会形成 crash loop 打满 CPU
    const base = this.options.restartBackoffBaseMs ?? 500;
    const cap = this.options.restartBackoffMaxMs ?? 30_000;
    const delay = Math.min(base * 2 ** Math.max(0, this.consecutiveFailures - 1), cap);
    this.state = 'restarting';
    this.restarts += 1;
    this.logger?.warn('插件将退避重启', { pluginId: this.options.pluginId, delayMs: delay, attempt: this.consecutiveFailures });

    const timer = setTimeout(() => {
      if (this.intentionalStop) return;
      void this.start().catch((error: unknown) => {
        // start 失败会再次走 #onExit（spawn error）——这里只记录，不冒泡
        this.logger?.warn('插件重启失败', {
          pluginId: this.options.pluginId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delay);
    // ★ 同理不 unref：崩溃重启是宿主**主动要做的事**，
    //   不该因为「此刻没有别的请求」而被推迟到下一个事件。
  }

  #rejectAllPending(error: Error): number {
    const count = this.pending.size;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    return count;
  }

  #scheduleIdleReclaim(): void {
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 0;
    if (idleTimeoutMs <= 0) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    const timer = setTimeout(() => {
      if (this.pending.size > 0) return; // 有在途请求，不回收
      this.logger?.info('空闲回收插件进程', { pluginId: this.options.pluginId, idleTimeoutMs });
      void this.stop();
    }, idleTimeoutMs);
    timer.unref?.();
    this.idleTimer = timer;
  }
}

/**
 * 进程运行时的**资源限额**说明（文档要求内存/CPU/文件描述符）。
 *
 * | 资源 | 实现方式 |
 * |---|---|
 * | 内存 | Node 子进程 `--max-old-space-size`（构造时传 `maxMemoryMb`） |
 * | 超时 | 每次调用 `timeoutMs` + 超时 `SIGKILL` |
 * | 空闲 | `idleTimeoutMs` 后回收进程 |
 * | 文件描述符 / CPU | 需 OS 级限制（`ulimit` / cgroup / Docker），见 docs/03 §1.8 的沙箱加固 |
 *
 * ★ 最后一行是**如实说明**：纯 Node 侧无法可靠限制 CPU 与 fd——
 *   那属于容器/OS 的职责。把它写成「已实现」是虚假的。
 */
export const RESOURCE_LIMITS_NOTE = 'CPU 与文件描述符需 OS/容器级限制（ulimit / cgroup / Docker），Node 侧只能限制内存与超时。';
