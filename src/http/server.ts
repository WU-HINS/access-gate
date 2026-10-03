/**
 * 最小 HTTP 服务器（M0-1 / M0-9）—— 零依赖，只用 `node:http`。
 *
 * 为什么不用 Fastify/Express：本项目的 M0-1 需要的是「把已有能力暴露出去」，
 * 而框架带来的中间件生态在这里反而是负担（我们要显式控制认证顺序、作用域解析、
 * 审计写入与响应形态）。零依赖还有两个实际好处：容器镜像更小；CI 里不需要网络。
 *
 * 中间件顺序（**顺序本身就是安全语义**，不可随意调整）：
 *   ① 请求 id / traceId 绑定（审计与日志贯通）
 *   ② 会话解析（把 Cookie → Principal）
 *   ③ CSRF 校验（仅状态变更方法）
 *   ④ 路由分发
 *   ⑤ 统一错误 → 响应（不泄露内部堆栈）
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

import { createLogger, newTraceId, silentLogger, withTraceId, type Logger } from '../kernel/logger.ts';
import {
  buildClearCookie,
  buildSetCookie,
  parseCookies,
  SESSION_COOKIE,
  SessionService,
  verifyCsrf,
  type Principal,
  type Session,
} from '../auth/session.ts';

// ─────────────────────────── 类型 ───────────────────────────

export interface RequestContext {
  method: string;
  path: string;
  /**
   * 路径参数（来自 `:param` 形式的路由）。
   *
   * ★ 此前**缺失**：`matchRoute` 明明解析了 `:param` 并返回 `params`，
   *   但构造 `RequestContext` 时把它丢了 —— 于是每个带参数的 handler
   *   都只能**在内部再写一次正则**重新解析路径（`admin/api.ts` 就是这样做的）。
   *   两级解析不仅冗余，而且两份正则容易漂移（路由层改路径、handler 忘了改）。
   */
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody: string;
  /** 已解析的主体（未登录为 null） */
  principal: Principal | null;
  session: Session | null;
  traceId: string;
  /** 设置响应 Cookie（登录/登出/切站点用） */
  setCookie(name: string, value: string, options?: Parameters<typeof buildSetCookie>[2]): void;
  clearCookie(name: string): void;
}

export type RouteHandler = (ctx: RequestContext) => Promise<RouteResult> | RouteResult;

export interface RouteResult {
  status?: number;
  /** 对象 → JSON；字符串 → text/plain；Buffer → 原样 */
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface Route {
  method: string;
  /** 精确路径，或含 `:param` 的模式（如 `/api/policies/:code/publish`） */
  path: string;
  handler: RouteHandler;
  /** 是否需要登录 */
  auth?: 'none' | 'required';
  /** 是否豁免 CSRF（仅限幂等的 GET/HEAD，或明确的 webhook 回调） */
  csrfExempt?: boolean;
}

export interface ServerDeps {
  sessions: SessionService;
  /** 指标集（M6-1）；未提供则不收集 */
  metrics?: import('../kernel/metrics.ts').AppMetrics;
  routes: readonly Route[];
  logger?: Logger;
  /** CSRF 签名密钥（进程启动时生成或从配置读取） */
  csrfSecret: string;
  /** 最大请求体（防内存打爆） */
  maxBodyBytes?: number;
  /** 生产环境应为 true：Cookie 加 Secure */
  secureCookies?: boolean;
}

export interface ServerOptions extends ServerDeps {
  port: number;
  host?: string;
}

// ─────────────────────────── 路径匹配 ───────────────────────────

interface MatchResult {
  handler: RouteHandler;
  params: Record<string, string>;
  route: Route;
}

export function matchRoute(routes: readonly Route[], method: string, path: string): MatchResult | undefined {
  for (const route of routes) {
    if (route.method.toUpperCase() !== method.toUpperCase()) continue;
    const params = matchPath(route.path, path);
    if (params !== undefined) return { handler: route.handler, params, route };
  }
  return undefined;
}

function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const patternParts = pattern.split('/').filter((p) => p.length > 0);
  const pathParts = path.split('/').filter((p) => p.length > 0);
  if (patternParts.length !== pathParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i]!;
    const actual = pathParts[i]!;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}

// ─────────────────────────── 请求体 ───────────────────────────

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 读取请求体并在超限时**优雅地**返回 413。
 *
 * ★ 关键：超限时**不能** `request.destroy()`——那会连响应一起销毁，
 *   客户端永远等不到 413（表现为「请求挂死」）。正确做法是：
 *   丢弃剩余数据（`resume()` 让流走完）**再**返回错误，让响应能正常送达。
 *   早期实现用了 destroy，导致测试整个文件挂起——这类问题在真实环境里
 *   表现为「上传大文件时请求卡住」，比报错难排查得多。
 */
async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      tooLarge = true;
      chunks.length = 0; // 不再保留数据，只把流读完
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }
  if (tooLarge) throw new HttpBodyTooLarge(size, maxBytes);
  return Buffer.concat(chunks).toString('utf8');
}

class HttpBodyTooLarge extends Error {
  readonly size: number;
  readonly max: number;
  constructor(size: number, max: number) {
    super(`请求体 ${size} 字节超过上限 ${max}`);
    this.size = size;
    this.max = max;
  }
}

// ─────────────────────────── 服务器 ───────────────────────────

export interface AppServer {
  server: Server;
  /** 启动监听；返回实际地址（支持 port=0 由系统分配） */
  listen(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

export function createAppServer(options: ServerOptions): AppServer {
  const logger = options.logger ?? silentLogger;
  const maxBodyBytes = options.maxBodyBytes ?? 1 * 1024 * 1024;

  const server = createServer((request, response) => {
    void handleRequest(request, response, options, logger, maxBodyBytes);
  });

  // ★ 关闭时要能真正断开：keep-alive 连接会让 `server.close()` 一直等到超时，
  //   表现为「测试挂起」或「进程不退出」。设置空闲超时并在 close 时销毁剩余连接。
  server.keepAliveTimeout = 1_000;
  server.headersTimeout = 5_000;

  return {
    server,
    listen(): Promise<{ url: string; port: number }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host ?? '127.0.0.1', () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            resolve({ url: `http://${options.host ?? '127.0.0.1'}:${options.port}`, port: options.port });
            return;
          }
          resolve({ url: `http://${options.host ?? '127.0.0.1'}:${address.port}`, port: address.port });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          // 关闭后销毁剩余连接（含 keep-alive），否则事件循环不会退出
          server.closeAllConnections();
          if (error === undefined) resolve();
          else reject(error);
        });
        // 保险：即使 close 回调因连接未断而延迟，也主动断开
        server.closeIdleConnections();
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
  logger: Logger,
  maxBodyBytes: number,
): Promise<void> {
  const traceId = request.headers['x-request-id']?.toString() ?? newTraceId();
  const startedAt = process.hrtime.bigint();
  const metrics = options.metrics;
  // ★ P1-1：HTTP 指标是**平台级**——一个请求可能属于任何站点，
  //   且 `finish` 回调触发时已无会话上下文。因此站点维度固定 `'platform'`；
  //   按站点下钻由 `patrol*` / `actions*` 指标承担（它们能拿到真实 siteId）。
  const httpMetricSite = 'platform';
  metrics?.httpInFlight.inc({ siteId: httpMetricSite });
  response.on('finish', () => {
    metrics?.httpInFlight.dec({ siteId: httpMetricSite });
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    // ★ 路由标签用**路径模板**而不是原始路径：原始路径会把 userId 之类的动态段
    //   变成指标标签，导致时间序列爆炸（且可能泄露敏感信息）。
    metrics?.httpDuration.observe(seconds, { siteId: httpMetricSite, method: request.method ?? 'GET' });
    metrics?.httpRequests.inc({
      siteId: httpMetricSite,
      method: request.method ?? 'GET',
      status: String(response.statusCode),
    });
  });
  await withTraceId(traceId, async () => {
    const cookies = parseCookies(request.headers.cookie);
    const pendingCookies: string[] = [];
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const method = (request.method ?? 'GET').toUpperCase();

    let body: unknown;
    let rawBody = '';
    try {
      rawBody = method === 'GET' || method === 'HEAD' ? '' : await readBody(request, maxBodyBytes);
      if (rawBody.length > 0) {
        const contentType = request.headers['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            sendJson(response, 400, { error: '请求体不是合法 JSON' });
            return;
          }
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(rawBody));
        } else {
          body = rawBody;
        }
      }
    } catch (error) {
      if (error instanceof HttpBodyTooLarge) {
        // ★ 不 destroy：响应要能发出去（destroy 会让客户端永远等不到结果）
        sendJson(response, 413, { error: error.message });
        return;
      }
      sendJson(response, 400, { error: '读取请求体失败' });
      return;
    }

    // ② 会话解析
    const token = cookies[SESSION_COOKIE];
    const auth = await options.sessions.authenticate(token);
    const session = auth.ok ? auth.session : null;
    const principal = session === null ? null : session.principal;
    if (!auth.ok && auth.reason !== 'missing') {
      logger.debug('会话无效', { reason: auth.reason, path: url.pathname });
      pendingCookies.push(buildClearCookie(SESSION_COOKIE));
    }

    const match = matchRoute(options.routes, method, url.pathname);
    if (match === undefined) {
      sendJson(response, 404, { error: `未知端点：${method} ${url.pathname}`, traceId });
      return;
    }

    // ③ 认证与 CSRF（顺序不可调换：先确认身份，再校验 CSRF）
    const route = match.route;
    if (route.auth === 'required' && principal === null) {
      sendJson(response, 401, { error: '未登录', traceId });
      return;
    }
    if (STATE_CHANGING.has(method) && route.csrfExempt !== true) {
      const provided = request.headers['x-csrf-token']?.toString();
      if (session === null || !verifyCsrf(session.id, options.csrfSecret, provided)) {
        sendJson(response, 403, { error: 'CSRF 校验失败（缺少或错误的 X-CSRF-Token）', traceId });
        return;
      }
    }

    const query: Record<string, string | undefined> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    const ctx: RequestContext = {
      method,
      path: url.pathname,
      params: match.params,
      query,
      headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])),
      body,
      rawBody,
      principal,
      session,
      traceId,
      setCookie: (name, value, cookieOptions) => {
        pendingCookies.push(buildSetCookie(name, value, { secure: options.secureCookies === true, ...cookieOptions }));
      },
      clearCookie: (name) => {
        pendingCookies.push(buildClearCookie(name));
      },
    };

    // ④ 分发
    try {
      const result = await match.handler(ctx);
      sendResult(response, result, pendingCookies, traceId);
    } catch (error) {
      logger.error('路由处理异常', {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(response, 500, { error: '内部错误', traceId }, pendingCookies);
    }
  });
}

function sendResult(response: ServerResponse, result: RouteResult, cookies: string[], traceId: string): void {
  const status = result.status ?? 200;
  if (result.headers !== undefined) {
    for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
  }
  if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);
  response.setHeader('X-Request-Id', traceId);

  const body = result.body;
  if (body === undefined) {
    response.statusCode = status;
    response.end();
    return;
  }
  if (typeof body === 'string') {
    response.statusCode = status;
    response.setHeader('Content-Type', result.contentType ?? 'text/plain; charset=utf-8');
    response.end(body);
    return;
  }
  if (Buffer.isBuffer(body)) {
    response.statusCode = status;
    response.setHeader('Content-Type', result.contentType ?? 'application/octet-stream');
    response.end(body);
    return;
  }
  sendJson(response, status, body, cookies);
}

function sendJson(response: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);
  response.end(JSON.stringify(body));
}

/** 生成 CSRF 密钥（进程级）。生产环境应从配置读取以便多实例一致。 */
export function newCsrfSecret(): string {
  return randomBytes(32).toString('base64url');
}

export { createLogger };
