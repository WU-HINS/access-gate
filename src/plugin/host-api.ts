/**
 * 宿主 API 与事实管线（M1-5 + M1-4）。
 *
 * 设计原则（docs/03 §1.5）：插件**不能**直接 import 主程序内部模块，只能经 `ctx.host`。
 * 因此这里是「能力边界」的唯一实现点，三条硬约束：
 *
 *   1. **权限先行**：`secrets.get(name)` 只对 `manifest.permissions` 里声明过的 key 放行；
 *      `http.request(url)` 只对白名单域名放行。未声明 → 拒绝（不是「默认允许」）。
 *   2. **出站统一收口**：超时、响应体上限、重定向策略都在这里，插件无法绕过。
 *   3. **事实必须过 schema**：`facts.emit` 先按 `factSchema` 校验，再打上
 *      `<pluginId>.` 命名空间前缀，最后带 TTL 落库。**未声明字段一律拒绝**——
 *      否则策略里会出现「看起来能用但永远取不到」的路径。
 *
 * ★ 配额耗尽时的语义（docs/05 §751）：**不抛错**，而是让事实采集返回 `missing`，
 *   由策略的 `onMissingFact` 决定。这里用 `FactQuotaExceeded` 显式表达，调用方据此转 missing。
 */

import type { Logger } from '../kernel/logger.ts';
import { redact } from '../kernel/logger.ts';
import type { JsonSchemaSubset, PluginManifest } from './manifest.ts';

// ─────────────────────────── 事实 ───────────────────────────

export interface FactRecord {
  /** 完整键：`<pluginId>.<field>`（命名空间由宿主添加，插件不得自带前缀） */
  key: string;
  pluginId: string;
  namespace: string;
  field: string;
  value: unknown;
  /** 过期时间（TTL 之后视为 missing） */
  expiresAt: Date;
  collectedAt: Date;
}

/**
 * 事实存储。
 *
 * ★ **事实是按主体存的**（`ag_plugin_facts` 的键是
 *   `(site_id, user_id, plugin_id, namespace, instance_key)`）。
 *   早期接口只有 `(pluginId, field)` 两维——那等于假设「事实是全局的」，
 *   在真实表上根本落不了库（`user_id` 是 NOT NULL），而且语义上也错：
 *   `fact.qq.level` 显然是**某个用户**的 QQ 等级，不是全局值。
 *   这个缺口是真实 PG 跑出来的（见 reports/M0-acceptance.md §21）。
 */
export interface FactStore {
  /** 写入某主体的事实（同 pluginId + field 覆盖） */
  put(userId: string, record: FactRecord): Promise<void>;
  get(userId: string, pluginId: string, field: string): Promise<FactRecord | undefined>;
  list(userId: string, pluginId: string): Promise<FactRecord[]>;
  /** 清理过期事实；返回清理条数 */
  purgeExpired(now: Date): Promise<number>;
}

export class InMemoryFactStore implements FactStore {
  private readonly facts = new Map<string, FactRecord>();
  /**
   * ★ 二级索引：`(userId, pluginId)` → 该作用域下的**字段名集合**。
   *
   * 为什么必需：`list()` 此前是 `[...this.facts.values()].filter(...)`——
   * **遍历全部事实**。而 `FactPipeline.emit()` **每次提交**都要调 `list()`
   * 做配额检查（`maxFactsPerPlugin`），于是「每个主体 emit 一次」变成
   * **O(n²)**：实测 3000 主体 17s、6000 主体 51s、12000 主体 221s
   * （4 倍规模 → 12.8 倍时间）。
   *
   * 有了这个索引，`list()` 只遍历**该作用域**的字段（通常 1–3 个），
   * 与总事实数无关。
   */
  private readonly scopeIndex = new Map<string, Set<string>>();

  private key(userId: string, pluginId: string, field: string): string {
    return `${userId}\u0000${pluginId}\u0000${field}`;
  }
  private scopeKey(userId: string, pluginId: string): string {
    return `${userId}\u0000${pluginId}`;
  }

  async put(userId: string, record: FactRecord): Promise<void> {
    this.facts.set(this.key(userId, record.pluginId, record.field), record);
    const scope = this.scopeKey(userId, record.pluginId);
    const fields = this.scopeIndex.get(scope) ?? new Set<string>();
    fields.add(record.field);
    this.scopeIndex.set(scope, fields);
  }

  async get(userId: string, pluginId: string, field: string): Promise<FactRecord | undefined> {
    return this.facts.get(this.key(userId, pluginId, field));
  }

  async list(userId: string, pluginId: string): Promise<FactRecord[]> {
    const fields = this.scopeIndex.get(this.scopeKey(userId, pluginId));
    if (fields === undefined) return [];
    const out: FactRecord[] = [];
    for (const field of fields) {
      const record = this.facts.get(this.key(userId, pluginId, field));
      if (record !== undefined) out.push(record);
    }
    return out;
  }

  async purgeExpired(now: Date): Promise<number> {
    let purged = 0;
    for (const [key, record] of this.facts) {
      if (record.expiresAt.getTime() <= now.getTime()) {
        this.facts.delete(key);
        // ★ 同步维护索引，否则索引会累积失效字段（内存泄漏 + list 返回已删记录）
        const scope = this.scopeKey(key.split('\u0000')[0]!, record.pluginId);
        this.scopeIndex.get(scope)?.delete(record.field);
        purged += 1;
      }
    }
    return purged;
  }
}

export class FactValidationError extends Error {
  override readonly name = 'FactValidationError';
  readonly issues: readonly string[];
  constructor(pluginId: string, issues: readonly string[]) {
    super(`插件 '${pluginId}' 提交的事实未通过 schema 校验：\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.issues = issues;
  }
}

/** 配额耗尽：**不是错误**，而是「事实缺失」的一种根因（docs/05 §751）。 */
export class FactQuotaExceeded extends Error {
  override readonly name = 'FactQuotaExceeded';
  constructor(pluginId: string, detail: string) {
    super(`插件 '${pluginId}' 事实配额耗尽：${detail}（按 missing 处理，不抛错给用户）`);
  }
}

export interface FactPipelineOptions {
  store: FactStore;
  manifest: PluginManifest;
  /**
   * 该管线服务的主体 id（**必填**）。
   *
   * ★ 事实是**按主体**存的（见 `FactStore` 的说明），因此管线必须知道自己服务于谁。
   *   早期版本没有这一维，导致 DB 路径无法落库（§21）。
   *
   * ★★★ R75：此前它是**可选**的，默认 `'platform'`——那是「事实是全局的」这一
   *   **被明确否定过的假设**的遗留物：
   *   · `ag_plugin_facts.user_id` 是 **NOT NULL uuid**，字符串 `'platform'` **写不进去**；
   *   · `uq_ag_facts_user_namespace` 把 `user_id` 作为**唯一键的一部分**
   *     （若改成可空，PG 的唯一索引允许多个 NULL → **「同一主体一行」的语义被破坏**）。
   *
   *   ★ 因此这里改为**必填**：让「这个管线服务于谁」成为**编译期必须回答的问题**——
   *     而不是运行到真实 PG 才炸。
   */
  userId: string;
  logger?: Logger;
  /** 单次 emit 的最大字段数 */
  maxFieldsPerEmit?: number;
  /** 单插件事实总量上限 */
  maxFactsPerPlugin?: number;
  /** 默认 TTL（manifest.factTtl 缺省时） */
  defaultTtlMs?: number;
}

/**
 * 解析 `24h` / `30m` / `45s` / `7d` / 纯毫秒数字。
 *
 * ★ 实现已移到**零依赖**模块 `src/kernel/duration.ts`（`policy/expr.ts` 的 `$maxSkew`
 *   也要用它，而表达式引擎是零依赖的——直接从本文件取会耦合"表达式引擎"与"插件宿主"）。
 *   这里 re-export，既有 import 不受影响。
 */
import { parseDuration } from '../kernel/duration.ts';

export { parseDuration };

/** 按 JSON Schema 子集校验事实（只做类型/枚举/必需项，够用且可解释）。 */
export function validateFacts(schema: JsonSchemaSubset | undefined, facts: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (schema?.properties === undefined) {
    // 未声明 factSchema：拒绝写入（否则策略路径不可静态校验）
    return ['manifest 未声明 factSchema，拒绝写入事实（策略编辑器无法做路径补全与静态校验）'];
  }
  for (const key of Object.keys(facts)) {
    if (key.includes('.')) {
      issues.push(`字段名 '${key}' 不得包含 '.'（命名空间由宿主添加，插件只提供裸字段名）`);
      continue;
    }
    if (schema.properties[key] === undefined) {
      issues.push(`字段 '${key}' 未在 factSchema 中声明（拒绝写入：否则策略里会出现永远取不到的路径）`);
    }
  }
  for (const required of schema.required ?? []) {
    if (facts[required] === undefined) issues.push(`缺少必需字段 '${required}'`);
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = facts[key];
    if (value === undefined || value === null) continue;
    const type = property.type;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const ok =
      type === undefined ||
      (type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' : type === actual);
    if (!ok) {
      issues.push(`字段 '${key}' 类型应为 ${type}，实际 ${actual}`);
      continue;
    }
    if (property.enum !== undefined && !property.enum.includes(value)) {
      issues.push(`字段 '${key}' 取值 '${String(value)}' 不在枚举内（允许：${property.enum.map(String).join(' | ')}）`);
    }
  }
  return issues;
}

/**
 * 事实管线：校验 → 命名空间 → TTL → 落库。
 *
 * `emit` 的返回值让调用方区分「写成功」与「配额耗尽」——后者应按 missing 处理。
 */
export class FactPipeline {
  private readonly store: FactStore;
  private readonly manifest: PluginManifest;
  private readonly logger: Logger | undefined;
  private readonly maxFieldsPerEmit: number;
  private readonly maxFactsPerPlugin: number;
  private readonly defaultTtlMs: number;
  private readonly userId: string;

  constructor(options: FactPipelineOptions) {
    // ★★ 运行时校验（不能只靠类型）：
    //   `userId: string` 是**编译期**强制，但 **JS 调用方 / 动态构造会绕过它**——
    //   我实测过：`new FactPipeline({ store, manifest })` 在运行时会得到 `userId = undefined`，
    //   然后**一路走到 PG** 才报 `invalid input syntax for type uuid`（错误信息与根因相距很远）。
    //   ★ 这里 fail-fast：在**构造点**给出清晰原因，而不是让错误在数据库层浮现。
    if (typeof options.userId !== 'string' || options.userId.length === 0) {
      throw new Error(
        `FactPipeline 需要明确的**主体 id**（收到 ${JSON.stringify(options.userId)}）——` +
          `事实是**按主体**存的（ag_plugin_facts.user_id 是 NOT NULL uuid），` +
          `不存在「平台级事实」这种语义。`,
      );
    }
    this.userId = options.userId;
    this.store = options.store;
    this.manifest = options.manifest;
    this.logger = options.logger;
    this.maxFieldsPerEmit = options.maxFieldsPerEmit ?? 64;
    this.maxFactsPerPlugin = options.maxFactsPerPlugin ?? 512;
    this.defaultTtlMs = options.defaultTtlMs ?? 24 * 3_600_000;
  }

  get namespace(): string {
    return this.manifest.id;
  }

  /** 把裸字段名变成带命名空间的完整键：`total_stars` → `github.total_stars`。 */
  namespacedKey(field: string): string {
    return `${this.manifest.id}.${field}`;
  }

  async emit(facts: Record<string, unknown>, now = new Date()): Promise<{ written: string[] }> {
    if (Object.keys(facts).length > this.maxFieldsPerEmit) {
      throw new FactQuotaExceeded(this.manifest.id, `单次提交 ${Object.keys(facts).length} 个字段，上限 ${this.maxFieldsPerEmit}`);
    }
    const issues = validateFacts(this.manifest.factSchema, facts);
    if (issues.length > 0) throw new FactValidationError(this.manifest.id, issues);

    const existing = await this.store.list(this.userId, this.manifest.id);
    const incoming = Object.keys(facts);
    const overflow = existing.filter((f) => !incoming.includes(f.field)).length + incoming.length - this.maxFactsPerPlugin;
    if (overflow > 0) {
      throw new FactQuotaExceeded(this.manifest.id, `事实总数将超过上限 ${this.maxFactsPerPlugin}（超出 ${overflow} 个字段）`);
    }

    const ttlMs = parseDuration(this.manifest.factTtl, this.defaultTtlMs);
    const written: string[] = [];
    for (const [field, value] of Object.entries(facts)) {
      const record: FactRecord = {
        key: this.namespacedKey(field),
        pluginId: this.manifest.id,
        namespace: this.manifest.id,
        field,
        value,
        collectedAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
      };
      await this.store.put(this.userId, record);
      written.push(record.key);
    }
    this.logger?.info('事实已写入', { pluginId: this.manifest.id, fields: written.length, ttlMs });
    return { written };
  }

  /** 读取事实；已过期视为缺失（返回 undefined 而不是陈旧值）。 */
  async get(field: string, now = new Date()): Promise<FactRecord | undefined> {
    const record = await this.store.get(this.userId, this.manifest.id, field);
    if (record === undefined) return undefined;
    if (record.expiresAt.getTime() <= now.getTime()) return undefined;
    return record;
  }
}

// ─────────────────────────── 权限 ───────────────────────────

export class PermissionDeniedError extends Error {
  override readonly name = 'PermissionDeniedError';
  constructor(pluginId: string, detail: string) {
    super(`插件 '${pluginId}' 的权限申请被拒绝：${detail}`);
  }
}

export interface PermissionSet {
  /** 是否允许读取某个密钥 */
  canReadSecret(name: string): boolean;
  /** 是否允许访问某个域名（含子域） */
  canEgress(host: string): boolean;
  /** 是否允许写自己的缓存/存储 */
  canWriteOwnStorage(): boolean;
  raw: readonly string[];
}

/** 从 manifest.permissions 构造权限集（唯一解析点）。 */
export function permissionSetOf(manifest: PluginManifest): PermissionSet {
  const raw = manifest.permissions ?? [];
  const secrets = new Set<string>();
  const hosts: string[] = [];
  let ownStorage = false;

  for (const permission of raw) {
    const [area, action, ...rest] = permission.split(':');
    const target = rest.join(':');
    if (area === 'secrets' && action === 'read' && target.length > 0) secrets.add(target);
    if (area === 'http' && action === 'egress' && target.length > 0) hosts.push(target.toLowerCase());
    if ((area === 'storage' || area === 'cache') && action === 'write' && target === 'self') ownStorage = true;
  }

  return {
    raw,
    canReadSecret: (name) => secrets.has(name),
    canEgress: (host) => {
      const lower = host.toLowerCase();
      return hosts.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`));
    },
    canWriteOwnStorage: () => ownStorage,
  };
}

// ─────────────────────────── 宿主 API ───────────────────────────

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** 对象 → JSON；字符串 → 原样 */
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** 已解析的 JSON（Content-Type 含 json 时）或原始文本 */
  data: unknown;
  /** 原始文本（供插件自行解析非 JSON 响应） */
  text: string;
}

export interface KvStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class InMemoryKvStore implements KvStore {
  private readonly data = new Map<string, { value: unknown; expiresAt?: number }>();
  async get(key: string): Promise<unknown> {
    const entry = this.data.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }
  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.data.set(key, ttlMs === undefined ? { value } : { value, expiresAt: Date.now() + ttlMs });
  }
  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export interface HostApiOptions {
  manifest: PluginManifest;
  secrets: { get(name: string): Promise<string | undefined> };
  cache?: KvStore;
  storage?: KvStore;
  facts: FactPipeline;
  logger?: Logger;
  /** 出站响应体上限（字节），防插件拉爆内存 */
  maxResponseBytes?: number;
  /** 出站默认超时 */
  defaultTimeoutMs?: number;
  /** 可注入的 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 时间基准（测试用） */
  now?: () => Date;
  /**
   * ★★ L-2：**LLM 通道（唯一入口）**。
   *
   * ★ 为什么必须有它：`LlmProvider` 的唯一实现与网关都已就绪，但插件若拿不到通道，
   *   就只有两个选择——**自己发 HTTP**（绕过预算 / 限流 / 模型白名单 / 审计，
   *   连"这个插件花了多少钱"都不可知），或者**根本无法调用 LLM**。
   * ★ 未注入时 `llmInvoke()` **显式抛错**（而不是返回空内容）：
   *   "看起来成功的空回答"会让插件把失败当成模型的判断。
   */
  llm?: {
    invoke(input: {
      /** ★ 由**宿主**填入 `this.manifest.id`——插件因此无法冒充别的插件去用它的预算 */
      pluginId: string;
      messages: readonly { role: 'user' | 'system' | 'assistant'; content: string }[];
      model?: string;
      maxOutputTokens?: number;
      temperature?: number;
      cache?: boolean;
    }): Promise<{
      content: string;
      model: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      cached: boolean;
    }>;
  };
}

/**
 * 宿主 API 实现。
 *
 * ★ 密钥读取**每次都查权限**（而不是构造时算一次）——权限可能在运行期被撤销
 *   （docs/03 §1.11 的逐项授予/撤销），缓存权限会造成「撤销后仍可读」。
 */
export class HostApi {
  readonly manifest: PluginManifest;
  readonly permissions: PermissionSet;
  readonly facts: FactPipeline;

  private readonly secrets: HostApiOptions['secrets'];
  private readonly cacheStore: KvStore;
  private readonly storageStore: KvStore;
  private readonly logger: Logger | undefined;
  private readonly maxResponseBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  /** ★★ L-2：LLM 通道（未配置时为 undefined → `llmInvoke` 显式抛错） */
  private readonly llmClient: HostApiOptions['llm'];

  constructor(options: HostApiOptions) {
    this.manifest = options.manifest;
    this.permissions = permissionSetOf(options.manifest);
    this.facts = options.facts;
    this.secrets = options.secrets;
    this.cacheStore = options.cache ?? new InMemoryKvStore();
    this.storageStore = options.storage ?? new InMemoryKvStore();
    this.logger = options.logger;
    this.maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.llmClient = options.llm;
  }

  /**
   * ★★ L-2：**调用 LLM（唯一入口）** —— 受网关的预算 / 限流 / 并发 / 模型白名单 / 缓存约束。
   *
   * ★ 插件名由**宿主**填入（`this.manifest.id`），因此插件**无法冒充**别的插件去消耗它的预算。
   * ★ 未配置网关时**显式抛错**（而不是返回空内容）："看起来成功的空回答"
   *   会让插件把失败当成模型的判断——那比报错更坏。
   */
  async llmInvoke(input: {
    messages: readonly { role: 'user' | 'system' | 'assistant'; content: string }[];
    model?: string;
    maxOutputTokens?: number;
    temperature?: number;
    cache?: boolean;
  }): Promise<{
    content: string;
    model: string;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    cached: boolean;
  }> {
    if (this.llmClient === undefined) {
      throw new Error(
        `插件 '${this.manifest.id}' 调用 LLM 被拒：宿主未配置 LLM 网关。` +
          '插件不应自行发起 LLM 请求——那会绕过平台的预算、限流与审计（见 docs/03 §1.10）。',
      );
    }
    return this.llmClient.invoke({ ...input, pluginId: this.manifest.id });
  }

  get id(): string {
    return this.manifest.id;
  }

  // ── 日志（自动带 pluginId；字段脱敏） ──
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    this.logger?.[level](message, { pluginId: this.manifest.id, ...(meta === undefined ? {} : { meta: redact(meta) }) });
  }

  // ── 密钥 ──
  async getSecret(name: string): Promise<string> {
    if (!this.permissions.canReadSecret(name)) {
      throw new PermissionDeniedError(
        this.manifest.id,
        `未声明权限 'secrets:read:${name}'（当前已声明：${this.permissions.raw.filter((p) => p.startsWith('secrets:')).join(', ') || '无'}）`,
      );
    }
    const value = await this.secrets.get(name);
    if (value === undefined) {
      throw new PermissionDeniedError(this.manifest.id, `密钥 '${name}' 已授权但宿主中不存在（请检查配置）`);
    }
    return value;
  }

  // ── 出站 HTTP（白名单 + 超时 + 体积上限 + 脱敏日志） ──
  async request(request: HttpRequest): Promise<HttpResponse> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new PermissionDeniedError(this.manifest.id, `非法 URL '${request.url}'`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new PermissionDeniedError(this.manifest.id, `只允许 http(s)，实际 '${url.protocol}'`);
    }
    if (!this.permissions.canEgress(url.hostname)) {
      throw new PermissionDeniedError(
        this.manifest.id,
        `域名 '${url.hostname}' 不在出站白名单内（已声明：${this.permissions.raw.filter((p) => p.startsWith('http:')).join(', ') || '无'}）`,
      );
    }

    const timeoutMs = Math.min(request.timeoutMs ?? this.defaultTimeoutMs, 60_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { ...(request.headers ?? {}) };
    let body: string | undefined;
    if (request.body !== undefined && request.method !== 'GET') {
      if (typeof request.body === 'string') body = request.body;
      else {
        body = JSON.stringify(request.body);
        if (headers['Content-Type'] === undefined && headers['content-type'] === undefined) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        redirect: 'follow',
      });
      const text = await response.text();
      if (text.length > this.maxResponseBytes) {
        throw new PermissionDeniedError(
          this.manifest.id,
          `响应体 ${text.length} 字节超过上限 ${this.maxResponseBytes}（防止插件拉爆宿主内存）`,
        );
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const contentType = responseHeaders['content-type'] ?? '';
      let data: unknown = text;
      if (contentType.includes('json') && text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      this.logger?.debug('插件出站请求完成', {
        pluginId: this.manifest.id,
        host: url.hostname,
        method: request.method,
        status: response.status,
        bytes: text.length,
      });
      return { status: response.status, headers: responseHeaders, data, text };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 缓存 / 私有存储（命名空间隔离） ──
  private ownKey(key: string): string {
    // ★★ 分隔符用 **ASCII Unit Separator（0x1F）**，**不是 `\u0000`**。
    //
    //   原因：`\0`（NUL）在 PostgreSQL 的 text/varchar 里**非法**
    //   （`invalid byte sequence for encoding "UTF8": 0x00`）——
    //   于是「内存实现能跑、PG 实现一写就报错」。
    //   ★ 这是 R66 装配 HostApi 时才暴露的：此前 `HostApi` 从未接过 PG 的 KV 适配器。
    //
    //   0x1F 与 NUL 有**同样的性质**（正常 key 里不可能出现，因此拼接无歧义），
    //   但它是**合法的 UTF-8 字符**。
    return `${this.manifest.id}\u001f${key}`;
  }

  async cacheGet<T>(key: string): Promise<T | null> {
    return (await this.cacheStore.get(this.ownKey(key))) as T | null;
  }

  async cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.cacheStore.set(this.ownKey(key), value, ttlMs);
  }

  async storageGet(key: string): Promise<unknown> {
    return this.storageStore.get(this.ownKey(key));
  }

  async storageSet(key: string, value: unknown, ttlMs?: number): Promise<void> {
    if (!this.permissions.canWriteOwnStorage()) {
      throw new PermissionDeniedError(this.manifest.id, "未声明 'storage:write:self' 权限");
    }
    await this.storageStore.set(this.ownKey(key), value, ttlMs);
  }

  async storageDel(key: string): Promise<void> {
    if (!this.permissions.canWriteOwnStorage()) {
      throw new PermissionDeniedError(this.manifest.id, "未声明 'storage:write:self' 权限");
    }
    await this.storageStore.del(this.ownKey(key));
  }

  // ── 事实 ──
  async emitFacts(facts: Record<string, unknown>): Promise<{ written: string[] }> {
    return this.facts.emit(facts, this.now());
  }
}
