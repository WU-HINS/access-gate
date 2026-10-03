/**
 * 插件端点宿主（M4-6）—— docs/03 §1.13。
 *
 * ★ 核心约束（文档原话）：**插件不能自己监听端口**。
 *   对外暴露的每个路径都必须在 `manifest.endpoints` 中声明，
 *   由宿主挂载、鉴权、限流、审计。这样才可能做到
 *   「插件注册端点**全程不改主程序、不重启**」。
 *
 * ★ 四道必须有的防线（对应验收标准）：
 *
 * 1. **路径安全**：保留路径（`/api/plugins/_*`）、路径穿越（`..` / 编码穿越）、
 *    以及**注册到宿主已有路由**上的尝试一律拒绝。
 *    最后一条尤其重要：插件若能覆盖 `/api/admin/*`，就等于拿到管理员权限。
 *
 * 2. **冲突检测**：同一 `(method, path)` 只能被一个插件占用——
 *    否则「谁生效」取决于加载顺序，是极难排查的问题。
 *
 * 3. **五种鉴权**：`none` / `hmac` / `pluginToken` / `session` / `admin`。
 *    其中 `hmac` 的**密钥托管在宿主，插件拿不到**（插件只声明 `secretRef`）。
 *
 * 4. **三维限流**：按 IP / token / 插件。单维限流可被绕开
 *    （换 IP 绕 IP 限流；一个插件内多 token 绕 token 限流）。
 */

import type { Logger } from '../kernel/logger.ts';
import type { PluginManifest } from './manifest.ts';

// ─────────────────────────── 声明类型 ───────────────────────────

export type EndpointAuth = 'none' | 'hmac' | 'pluginToken' | 'session' | 'admin';

export const ENDPOINT_AUTH_KINDS: readonly EndpointAuth[] = ['none', 'hmac', 'pluginToken', 'session', 'admin'];

export interface EndpointRateLimit {
  perMinute: number;
  /** 是否按来源 IP 单独计数 */
  perIp?: boolean;
  /** 是否按 token 单独计数 */
  perToken?: boolean;
}

export interface EndpointDeclaration {
  path: string;
  method: string;
  auth: EndpointAuth;
  visibility?: 'public' | 'internal';
  description?: string;
  rateLimit?: EndpointRateLimit;
  hmac?: { header: string; algo: 'sha256'; secretRef: string };
  maxBodyBytes?: number;
  timeoutMs?: number;
  /** 请求体 JSON Schema（用于 OpenAPI 生成与宿主侧校验） */
  requestSchema?: Record<string, unknown>;
  /** 响应体 JSON Schema */
  responseSchema?: Record<string, unknown>;
}

export interface EndpointIssue {
  path: string;
  method: string;
  code:
    | 'reserved_path'
    | 'path_traversal'
    | 'invalid_path'
    | 'invalid_method'
    | 'unknown_auth'
    | 'hmac_config_missing'
    | 'host_route_conflict'
    | 'plugin_conflict'
    | 'none_auth_not_approved'
    | 'rate_limit_invalid';
  message: string;
  severity: 'error' | 'warning';
}

// ─────────────────────────── 校验 ───────────────────────────

/** 宿主专用保留前缀（docs/03 §1.13.1）。 */
export const RESERVED_PATH_PREFIX = '/api/plugins/_';

/**
 * 路径安全检查。
 *
 * ★ 三层都要查：
 *   - 原始文本里的 `..`；
 *   - **解码后**的 `..`（`%2e%2e` 绕过朴素检查）；
 *   - 二次编码（`%252e`）—— 解码一次仍是 `%2e`，再解一次才是 `.`。
 *     这里用「反复解码直到稳定，最多 3 次」来覆盖。
 */
export function inspectPath(path: string): { ok: true; normalized: string } | { ok: false; reason: 'reserved_path' | 'path_traversal' | 'invalid_path'; message: string } {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, reason: 'invalid_path', message: '路径不能为空' };
  }
  if (!path.startsWith('/')) {
    return { ok: false, reason: 'invalid_path', message: `路径必须以 '/' 开头（实际 '${path}'）` };
  }
  if (path.includes('?') || path.includes('#')) {
    return { ok: false, reason: 'invalid_path', message: '声明里不得包含查询串或片段（只声明路径）' };
  }
  if (path.includes('//')) {
    return { ok: false, reason: 'invalid_path', message: '路径不得含连续斜杠' };
  }

  // 反复解码（最多 3 次）后再检查穿越
  let decoded = path;
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return { ok: false, reason: 'invalid_path', message: `路径包含非法的百分号编码：'${path}'` };
    }
    if (next === decoded) break;
    decoded = next;
  }

  const segments = decoded.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      return { ok: false, reason: 'path_traversal', message: `路径包含目录穿越（'${path}' → '${decoded}'）` };
    }
    if (segment === '.') {
      return { ok: false, reason: 'path_traversal', message: `路径包含当前目录引用（'${path}'）` };
    }
    // 反斜杠在 Windows 风格解析下也可能是分隔符
    if (segment.includes('\\')) {
      return { ok: false, reason: 'path_traversal', message: `路径包含反斜杠（'${path}'）——可能被当作分隔符` };
    }
  }

  if (path.startsWith(RESERVED_PATH_PREFIX)) {
    return { ok: false, reason: 'reserved_path', message: `'${RESERVED_PATH_PREFIX}*' 是宿主保留路径（插件不得占用）` };
  }
  // 插件端点必须挂在 /api/plugins/<pluginId>/ 下——这样宿主路由与插件路由天然分区
  if (!path.startsWith('/api/plugins/')) {
    return {
      ok: false,
      reason: 'invalid_path',
      message: `插件端点必须挂在 '/api/plugins/<pluginId>/' 下（实际 '${path}'）——否则会与宿主路由争抢命名空间`,
    };
  }
  return { ok: true, normalized: decoded };
}

/** 收集 manifest 声明的端点（缺省为空数组）。 */
export function endpointDeclarationsOf(manifest: PluginManifest): EndpointDeclaration[] {
  const raw = (manifest as { endpoints?: unknown }).endpoints;
  if (!Array.isArray(raw)) return [];
  return raw as EndpointDeclaration[];
}

/**
 * 校验一组插件的端点声明。
 *
 * 返回**全部**问题而不是第一个——「修一个报一个」在插件开发里体验极差。
 */
export function validateEndpointDeclarations(
  manifests: readonly PluginManifest[],
  options: { hostRoutes?: readonly { method: string; path: string }[]; approvedNoneAuth?: readonly string[] } = {},
): EndpointIssue[] {
  const issues: EndpointIssue[] = [];
  const hostRoutes = new Set((options.hostRoutes ?? []).map((route) => `${route.method.toUpperCase()} ${route.path}`));
  const approvedNone = new Set(options.approvedNoneAuth ?? []);
  /** `METHOD /path` → 占用它的插件 id（冲突检测） */
  const owners = new Map<string, string>();

  for (const manifest of manifests) {
    for (const declaration of endpointDeclarationsOf(manifest)) {
      const path = String(declaration.path ?? '');
      const method = String(declaration.method ?? '').toUpperCase();
      const at = { path, method };

      const inspected = inspectPath(path);
      if (!inspected.ok) {
        issues.push({ ...at, code: inspected.reason, message: inspected.message, severity: 'error' });
        continue;
      }
      if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) {
        issues.push({ ...at, code: 'invalid_method', message: `不支持的 HTTP 方法 '${declaration.method}'`, severity: 'error' });
        continue;
      }
      if (!ENDPOINT_AUTH_KINDS.includes(declaration.auth)) {
        issues.push({
          ...at,
          code: 'unknown_auth',
          message: `未知的鉴权类型 '${declaration.auth}'（可用：${ENDPOINT_AUTH_KINDS.join(' / ')}）`,
          severity: 'error',
        });
        continue;
      }
      if (declaration.auth === 'hmac' && declaration.hmac === undefined) {
        issues.push({
          ...at,
          code: 'hmac_config_missing',
          message: 'auth=hmac 必须提供 hmac 配置（header / algo / secretRef）',
          severity: 'error',
        });
        continue;
      }
      if (declaration.rateLimit !== undefined && (!Number.isInteger(declaration.rateLimit.perMinute) || declaration.rateLimit.perMinute <= 0)) {
        issues.push({ ...at, code: 'rate_limit_invalid', message: 'rateLimit.perMinute 必须是正整数', severity: 'error' });
        continue;
      }

      // ★ 与宿主已有路由冲突 → 拒绝（否则插件可覆盖 /api/admin/*，等于拿到管理员权限）
      const key = `${method} ${path}`;
      if (hostRoutes.has(key)) {
        issues.push({
          ...at,
          code: 'host_route_conflict',
          message: `'${key}' 已被宿主路由占用——插件不得覆盖宿主端点（这会绕过宿主的鉴权与审计）`,
          severity: 'error',
        });
        continue;
      }

      // ★ 插件之间冲突
      const owner = owners.get(key);
      if (owner !== undefined && owner !== manifest.id) {
        issues.push({
          ...at,
          code: 'plugin_conflict',
          message: `'${key}' 已被插件 '${owner}' 占用（同一路径只能属于一个插件——否则「谁生效」取决于加载顺序）`,
          severity: 'error',
        });
        continue;
      }
      owners.set(key, manifest.id);

      // `none` 鉴权需要管理员显式批准（UI 上红色警示）
      if (declaration.auth === 'none' && !approvedNone.has(key)) {
        issues.push({
          ...at,
          code: 'none_auth_not_approved',
          message: `'${key}' 使用 auth=none（完全公开）——需管理员显式批准后才生效`,
          severity: 'warning',
        });
      }
    }
  }
  return issues;
}

// ─────────────────────────── 限流 ───────────────────────────

export interface RateLimitDecision {
  allowed: boolean;
  /** 剩余可用次数 */
  remaining: number;
  /** 被拒绝时的重试建议（秒） */
  retryAfterSeconds?: number;
  /** 命中的维度（便于排障与告警） */
  dimension?: 'ip' | 'token' | 'plugin';
}

interface Bucket {
  windowStart: number;
  count: number;
}

/**
 * 三维限流器（IP / token / 插件）。
 *
 * ★ 为什么必须三维：单维限流可被绕开——
 *   换 IP 绕 IP 限流；一个插件内换 token 绕 token 限流；
 *   而「插件级」上限保证一个失控插件不会吃光整个平台的配额。
 *
 * 窗口是**固定窗口**（每分钟重置）。滑动窗口更精确但需要存时间戳列表，
 * 在「防滥用」场景下固定窗口足够（代价是最坏情况可瞬时打满 2 倍配额）。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  check(input: {
    pluginId: string;
    path: string;
    method: string;
    limit: EndpointRateLimit;
    ip?: string;
    token?: string;
  }): RateLimitDecision {
    const now = this.now();
    const windowMs = 60_000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const base = `${input.method} ${input.path}`;

    // 三个维度各自计数，**任一超限即拒**
    const dimensions: { dimension: 'ip' | 'token' | 'plugin'; key: string; limit: number }[] = [
      { dimension: 'plugin', key: `plugin:${input.pluginId}:${base}`, limit: input.limit.perMinute },
    ];
    if (input.limit.perIp === true && input.ip !== undefined) {
      dimensions.push({ dimension: 'ip', key: `ip:${input.ip}:${base}`, limit: input.limit.perMinute });
    }
    if (input.limit.perToken === true && input.token !== undefined) {
      dimensions.push({ dimension: 'token', key: `token:${input.token}:${base}`, limit: input.limit.perMinute });
    }

    let worst: RateLimitDecision = { allowed: true, remaining: input.limit.perMinute };
    for (const entry of dimensions) {
      const bucket = this.buckets.get(entry.key);
      const count = bucket === undefined || bucket.windowStart !== windowStart ? 0 : bucket.count;
      const remaining = entry.limit - count - 1;
      if (remaining < 0) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
          dimension: entry.dimension,
        };
      }
      if (remaining < worst.remaining) worst = { allowed: true, remaining, dimension: entry.dimension };
    }

    // 全部通过才计数（避免「被拒的请求也消耗配额」导致雪崩）
    for (const entry of dimensions) {
      const bucket = this.buckets.get(entry.key);
      if (bucket === undefined || bucket.windowStart !== windowStart) {
        this.buckets.set(entry.key, { windowStart, count: 1 });
      } else {
        bucket.count += 1;
      }
    }
    return worst;
  }

  /** 清理过期窗口（可定期调用，防内存增长）。 */
  purge(): number {
    const now = this.now();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    let purged = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart < windowStart) {
        this.buckets.delete(key);
        purged += 1;
      }
    }
    return purged;
  }
}

// ─────────────────────────── 宿主 ───────────────────────────

export interface EndpointPrincipal {
  kind: EndpointAuth;
  /** `session` / `admin` 时的用户 id */
  userId?: string;
  /** `pluginToken` 时的令牌 id */
  tokenId?: string;
  /** `hmac` 时的调用方标识 */
  clientId?: string;
}

export type EndpointAuthResult =
  | { ok: true; principal: EndpointPrincipal }
  | { ok: false; status: number; error: string };

/**
 * 鉴权实现（由宿主注入；插件只声明 `auth` 类型，**不接触密钥**）。
 *
 * ★ 类型是**函数**而不是「含 authenticate 方法的对象」：
 *   它的语义就是「一个鉴权函数」。用接口包一层会让调用方写成
 *   `{ authenticate: fn }`，而注入方自然想直接传 `fn`——
 *   这种形态不匹配会在每个使用点变成噪音（真实踩到过）。
 */
export type EndpointAuthenticator = (input: {
  declaration: EndpointDeclaration;
  headers: Record<string, string | undefined>;
  /** 原始 body（hmac 校验用） */
  rawBody: string;
  method: string;
  path: string;
  session?: { userId: string; isAdmin: boolean } | null;
  pluginId: string;
}) => Promise<EndpointAuthResult>;

export interface MountedEndpoint {
  pluginId: string;
  declaration: EndpointDeclaration;
  /** 规范化后的路径 */
  path: string;
  method: string;
}

export interface EndpointHostOptions {
  hostRoutes?: readonly { method: string; path: string }[];
  /** 管理员已批准的 auth=none 端点（`METHOD /path`） */
  approvedNoneAuth?: readonly string[];
  authenticator: EndpointAuthenticator;
  limiter?: RateLimiter;
  logger?: Logger;
  /** 审计回调（插件端点全部要审计） */
  audit?: (entry: {
    pluginId: string;
    method: string;
    path: string;
    principal: EndpointPrincipal | null;
    status: number;
    durationMs: number;
    rejectedReason?: string;
  }) => void;
}

export interface EndpointInvocation {
  pluginId: string;
  declaration: EndpointDeclaration;
  principal: EndpointPrincipal | null;
  rawBody: string;
  headers: Record<string, string | undefined>;
  ip?: string;
  session?: { userId: string; isAdmin: boolean } | null;
}

export type EndpointOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string; reason: string };

/**
 * 插件端点宿主。
 *
 * ★ 「注册端点不改主程序、不重启」的实现方式：
 *   `mount()` 只更新**宿主内部的路由表**（内存），下一次请求即生效。
 *   因此插件的安装/卸载/升级都不需要重启进程。
 */
export class EndpointHost {
  private readonly options: EndpointHostOptions;
  private readonly mounted = new Map<string, MountedEndpoint>();
  private readonly limiter: RateLimiter;
  private readonly handlers = new Map<string, (invocation: EndpointInvocation) => Promise<EndpointOutcome>>();

  constructor(options: EndpointHostOptions) {
    this.options = options;
    this.limiter = options.limiter ?? new RateLimiter();
  }

  /** 已挂载的端点（供 `/api/plugins/_endpoints` 与 OpenAPI 生成）。 */
  list(): MountedEndpoint[] {
    return [...this.mounted.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * 挂载一个插件的全部端点声明。
   *
   * 校验不通过时**整体拒绝**（不做「部分挂载」——那会让插件的可用端点取决于声明顺序）。
   */
  mount(input: {
    manifest: PluginManifest;
    handler: (invocation: EndpointInvocation) => Promise<EndpointOutcome>;
  }): { ok: true; mounted: MountedEndpoint[] } | { ok: false; issues: EndpointIssue[] } {
    const issues = validateEndpointDeclarations([input.manifest], {
      ...(this.options.hostRoutes === undefined ? {} : { hostRoutes: this.options.hostRoutes }),
      ...(this.options.approvedNoneAuth === undefined ? {} : { approvedNoneAuth: this.options.approvedNoneAuth }),
    });
    const errors = issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) return { ok: false, issues };

    const declarations = endpointDeclarationsOf(input.manifest);
    const result: MountedEndpoint[] = [];
    for (const declaration of declarations) {
      const inspected = inspectPath(String(declaration.path));
      if (!inspected.ok) continue; // 上面已校验过，这里只是取规范路径
      const method = String(declaration.method).toUpperCase();
      const key = `${method} ${inspected.normalized}`;
      // 与其它插件冲突（跨调用检查）
      const existing = this.mounted.get(key);
      if (existing !== undefined && existing.pluginId !== input.manifest.id) {
        return {
          ok: false,
          issues: [
            {
              path: inspected.normalized,
              method,
              code: 'plugin_conflict',
              message: `'${key}' 已被插件 '${existing.pluginId}' 占用`,
              severity: 'error',
            },
          ],
        };
      }
      const mounted: MountedEndpoint = { pluginId: input.manifest.id, declaration, path: inspected.normalized, method };
      this.mounted.set(key, mounted);
      this.handlers.set(key, input.handler);
      result.push(mounted);
    }
    this.options.logger?.info('插件端点已挂载（无需重启）', {
      pluginId: input.manifest.id,
      endpoints: result.map((entry) => `${entry.method} ${entry.path}`),
    });
    return { ok: true, mounted: result };
  }

  /** 卸载某插件的全部端点。 */
  unmount(pluginId: string): number {
    let removed = 0;
    for (const [key, entry] of [...this.mounted]) {
      if (entry.pluginId === pluginId) {
        this.mounted.delete(key);
        this.handlers.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.options.logger?.info('插件端点已卸载', { pluginId, removed });
    return removed;
  }

  /**
   * 处理一次调用（宿主在 HTTP 层调用）。
   *
   * 顺序：**匹配 → 鉴权 → 限流 → 执行 → 审计**。
   * 限流放在鉴权**之后**：未认证的请求不应消耗配额（否则可被用来打满别人的配额）。
   */
  async invoke(input: {
    method: string;
    path: string;
    headers: Record<string, string | undefined>;
    rawBody: string;
    ip?: string;
    session?: { userId: string; isAdmin: boolean } | null;
  }): Promise<EndpointOutcome> {
    const startedAt = Date.now();
    const method = input.method.toUpperCase();
    const key = `${method} ${input.path}`;
    const entry = this.mounted.get(key);
    if (entry === undefined) {
      return { ok: false, status: 404, error: '插件端点不存在', reason: 'not_mounted' };
    }

    // ① 鉴权
    const auth = await this.options.authenticator({
      declaration: entry.declaration,
      headers: input.headers,
      rawBody: input.rawBody,
      method,
      path: input.path,
      pluginId: entry.pluginId,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
    if (!auth.ok) {
      this.#audit(entry, null, auth.status, startedAt, auth.error);
      return { ok: false, status: auth.status, error: auth.error, reason: 'auth_failed' };
    }

    // ② 限流（鉴权之后）
    const limit = entry.declaration.rateLimit;
    if (limit !== undefined) {
      const decision = this.limiter.check({
        pluginId: entry.pluginId,
        path: entry.path,
        method,
        limit,
        ...(input.ip === undefined ? {} : { ip: input.ip }),
        ...(auth.principal.tokenId === undefined ? {} : { token: auth.principal.tokenId }),
      });
      if (!decision.allowed) {
        this.#audit(entry, auth.principal, 429, startedAt, `rate_limited:${decision.dimension}`);
        return {
          ok: false,
          status: 429,
          error: `请求过于频繁（${decision.dimension ?? 'unknown'} 维度），${decision.retryAfterSeconds ?? 60} 秒后重试`,
          reason: 'rate_limited',
        };
      }
    }

    // ③ 执行
    const handler = this.handlers.get(key);
    if (handler === undefined) return { ok: false, status: 404, error: '插件端点未实现', reason: 'no_handler' };

    // body 大小限制（声明的 maxBodyBytes 是插件的自我约束，宿主强制）
    const maxBody = entry.declaration.maxBodyBytes;
    if (maxBody !== undefined && Buffer.byteLength(input.rawBody, 'utf8') > maxBody) {
      this.#audit(entry, auth.principal, 413, startedAt, 'body_too_large');
      return { ok: false, status: 413, error: `请求体超过该端点声明的上限 ${maxBody} 字节`, reason: 'body_too_large' };
    }

    try {
      const outcome = await this.#withTimeout(
        handler({
          pluginId: entry.pluginId,
          declaration: entry.declaration,
          principal: auth.principal,
          rawBody: input.rawBody,
          headers: input.headers,
          ...(input.ip === undefined ? {} : { ip: input.ip }),
          ...(input.session === undefined ? {} : { session: input.session }),
        }),
        entry.declaration.timeoutMs ?? 10_000,
      );
      this.#audit(entry, auth.principal, outcome.status, startedAt, outcome.ok ? undefined : outcome.reason);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.error('插件端点执行失败', { pluginId: entry.pluginId, path: entry.path, error: message });
      this.#audit(entry, auth.principal, 500, startedAt, message);
      return { ok: false, status: 500, error: '插件端点执行失败', reason: 'handler_error' };
    }
  }

  /** 端点超时（声明的 `timeoutMs`，默认 10 秒）——防插件卡死占用宿主连接。 */
  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          // ★ 不能 unref：unref 的定时器**不保持事件循环活跃**，
          //   于是「超时」这件事会依赖「恰好还有别的事件在跑」。
          //   若插件卡死且没有其它事件，超时永远不会触发——
          //   表现就是「请求一直挂着」，后续工作也被拖住（真实踩到过：
          //   测试运行器报 cancelledByParent「Promise 仍挂起但事件循环已耗尽」）。
          timer = setTimeout(() => reject(new Error(`插件端点超过 ${timeoutMs}ms 未返回`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #audit(entry: MountedEndpoint, principal: EndpointPrincipal | null, status: number, startedAt: number, rejectedReason?: string): void {
    this.options.audit?.({
      pluginId: entry.pluginId,
      method: entry.method,
      path: entry.path,
      principal,
      status,
      durationMs: Date.now() - startedAt,
      ...(rejectedReason === undefined ? {} : { rejectedReason }),
    });
  }

  /**
   * 生成 OpenAPI 片段（供 `/api/plugins/_openapi` 汇总）。
   *
   * ★ 为什么由宿主生成而不是插件提供：插件提供的 OpenAPI 可能与实际挂载的路由不一致，
   *   而宿主的 `mounted` 是**权威事实**。文档应当由事实生成，而不是由声明生成。
   */
  toOpenApiPaths(): Record<string, Record<string, unknown>> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const entry of this.list()) {
      const operation: Record<string, unknown> = {
        summary: entry.declaration.description ?? `${entry.pluginId} 的端点`,
        tags: [entry.pluginId],
        security: entry.declaration.auth === 'none' ? [] : [{ [entry.declaration.auth]: [] }],
        responses: { 200: { description: '成功' } },
      };
      if (entry.declaration.requestSchema !== undefined) {
        operation['requestBody'] = {
          content: { 'application/json': { schema: entry.declaration.requestSchema } },
        };
      }
      const pathEntry = paths[entry.path] ?? {};
      pathEntry[entry.method.toLowerCase()] = operation;
      paths[entry.path] = pathEntry;
    }
    return paths;
  }
}
