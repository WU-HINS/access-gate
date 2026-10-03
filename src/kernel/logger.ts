/**
 * 结构化日志（M0-8）。
 *
 * 设计取舍：
 *   - **不引入 pino/winston**：M0 只需要「结构化 + 级别 + 可注入输出」，
 *     依赖越少越容易在 CI 与插件沙箱里跑。接口留出 `sink`，将来接 pino 只换 sink。
 *   - **脱敏是一等公民**：审计要求「任何 API/日志/审计都不返回私钥/令牌」（02 §7.4），
 *     因此在**写入前**统一脱敏，而不是依赖每个调用点自觉。
 *   - **traceId 贯穿**：与 `ag_actions_log.traceId` / `ag_audit_log.traceId` 对齐，
 *     用 AsyncLocalStorage 承载，避免给每个函数加参数。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  time: string;
  level: LogLevel;
  message: string;
  /** 关联四元组的首元素：跨 HTTP / 后台任务贯通 */
  traceId?: string;
  /** 结构化字段（已脱敏） */
  fields?: Readonly<Record<string, unknown>>;
}

export type LogSink = (record: LogRecord) => void;

/** 敏感字段名（大小写不敏感、按片段匹配）：命中即替换为 '[REDACTED]' */
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /apikey/i,
  /api_key/i,
  /privatekey/i,
  /private_key/i,
  /ciphertext/i,
  /auth_?tag/i,
  /master_?key/i,
  /credential/i,
  /pat$/i,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

const MAX_DEPTH = 6;

/**
 * 递归脱敏：对象/数组里的敏感键值替换为 '[REDACTED]'；深度超限截断（防止日志被大对象拖死）。
 * 循环引用用 WeakSet 防御。
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  const obj = value as object;
  if (seen.has(obj)) return '[CIRCULAR]';
  seen.add(obj);

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? '[REDACTED]' : redact(item, depth + 1, seen);
  }
  return out;
}

// ─────────────────────────── traceId 上下文 ───────────────────────────

const traceStorage = new AsyncLocalStorage<string>();

export function currentTraceId(): string | undefined {
  return traceStorage.getStore();
}

/** 在 traceId 上下文中执行（HTTP 请求入口 / 后台任务入口各调一次）。 */
export function withTraceId<T>(traceId: string, fn: () => T): T {
  return traceStorage.run(traceId, fn);
}

export function newTraceId(): string {
  // 不引入 uuid 依赖：48 位十六进制足够关联一次请求
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────── Logger ───────────────────────────

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** 派生子 logger：字段合并（子字段优先） */
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  base?: Record<string, unknown>;
  /** 是否脱敏（默认 true；测试里可关掉以断言原始值） */
  redactFields?: boolean;
}

/** 默认 sink：一行一条 JSON 到 stdout（容器友好） */
export const stdoutSink: LogSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? stdoutSink;
  const base = options.base ?? {};
  const doRedact = options.redactFields ?? true;

  const emit = (recordLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) return;
    const merged = { ...base, ...(fields ?? {}) };
    const traceId = currentTraceId();
    const record: LogRecord = {
      time: new Date().toISOString(),
      level: recordLevel,
      message,
      ...(traceId === undefined ? {} : { traceId }),
    };
    if (Object.keys(merged).length > 0) {
      record.fields = (doRedact ? redact(merged) : merged) as Record<string, unknown>;
    }
    sink(record);
  };

  const logger: Logger = {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ level, sink, base: { ...base, ...fields }, redactFields: doRedact }),
  };
  return logger;
}

/** 静默 logger（测试与「不关心日志」的调用点用）。 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** 收集日志的 sink（测试用）：`records` 可直接断言。 */
export function collectingSink(): { sink: LogSink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: (record) => records.push(record), records };
}
