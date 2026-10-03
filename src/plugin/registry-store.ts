/**
 * 插件注册表存储（`ag_plugins`）—— 生产落地的 P0 基础设施。
 *
 * ★★ 为什么需要它：`ag_plugins` 表**在 schema 里存在**，但**没有任何适配器**——
 *   而 `serve.ts` 里的 `PluginRegistry` 是**硬编码数组**：
 *
 *     installedPlugins: () => ['email', 'checkin', 'github', 'newapi-provider']
 *
 *   后果有三层：
 *   1. **插件列表与数据库无关**——装了新插件，策略校验看不到它；
 *   2. `/admin/plugins` 的 34 条管理端点**没有数据源**（写了也没数据）；
 *   3. 「插件平台」是本项目的核心卖点，但它**无法被运营**。
 *
 * ★ 本模块只做「读 + 状态流转」的最小集合，对应 P0 里最核心的几条：
 *   列表 · 详情 · 安装 · 信任 · 启用/停用。
 *   其余（配置版本、端点、日志、令牌、UI 贡献）留待后续——它们都需要各自的表。
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { col, eq, lit } from '../query/ast.ts';
import type { PluginManifest } from './manifest.ts';
import { assertInProcessAdmitted, type InProcessAdmissionInput } from './in-process-admission.ts';
import { createHash } from 'node:crypto';

/** `ag_plugins` 是**平台级**表（插件不属于某个站点）。 */
const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export type PluginKind = 'channel' | 'enricher' | 'action' | 'feature' | 'identity' | 'provider';
export type PluginRuntime = 'declarative' | 'process' | 'container' | 'in-process';
/**
 * ★★ 取值**必须与迁移产物逐字一致**（本会话第三次因凭直觉写枚举而踩坑）：
 *
 * ```
 * ag_plugin_source: 'builtin' | 'uploaded' | 'url' | 'directory'
 * ag_plugin_status: 'installed' | 'validated' | 'enabled' | 'disabled' | 'error' | 'removed'
 * ```
 *
 * 我最初写的是 `'external' | 'local'` 与 `'failed' | 'uninstalled'`——
 * 两者都**不在枚举里**，真实 PG 会直接拒绝（内存实现则不会暴露）。
 * ★ 这与 `DeveloperStatus.pending`、`FactSource.plugin` 是同一类错误。
 */
export type PluginSource = 'builtin' | 'uploaded' | 'url' | 'directory';
export type PluginStatus = 'installed' | 'validated' | 'enabled' | 'disabled' | 'error' | 'removed';

export interface PluginRecord {
  id: string;
  kind: PluginKind;
  name: string;
  version: string;
  apiVersion: string;
  runtime: PluginRuntime;
  source: PluginSource;
  status: PluginStatus;
  /** 完整 manifest（jsonb） */
  manifest: PluginManifest | Record<string, unknown>;
  /** 事实命名空间（唯一索引：仅 enabled 时唯一） */
  namespace: string;
  /** 内容指纹（用于判断「同一插件是否被改过」） */
  digest: string;
  /** 是否通过签名校验 */
  signatureVerified: boolean;
  runtimeState: Record<string, unknown>;
  enabledAt: Date | null;
  lastError: string | null;
  installedAt: Date;
  updatedAt: Date;
}

/**
 * 从插件记录派生 `in-process` 准入输入（`docs/03:67` 的三个条件）。
 *
 * ★ `adminApprovedAt` 取自 `runtimeState.trust.backend` —— 即 `setTrust()` 写入的
 *   「管理员显式确认后端代码信任」的**时间戳**；未确认或已撤销时为 `null`。
 *   （刻意不把「签名隐含的信任」算作管理员确认：签名是**发布方**的证据，
 *     而本条件要求的是**本部署的管理员**对「代码进主进程」这一风险点头。）
 */
function admissionInputOf(record: PluginRecord): InProcessAdmissionInput {
  const trust = record.runtimeState['trust'] as
    | { backend?: { trusted?: boolean; at?: string | null } }
    | undefined;
  const rawAt = trust?.backend?.trusted === true ? trust.backend.at : null;
  const parsed = typeof rawAt === 'string' ? new Date(rawAt) : null;
  return {
    pluginId: record.id,
    runtime: record.runtime,
    source: record.source,
    signatureVerified: record.signatureVerified,
    adminApprovedAt: parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed : null,
  };
}

export interface InstallPluginInput {
  manifest: PluginManifest;
  source: PluginSource;
  /** 内容指纹（由调用方计算；不提供则按 manifest 序列化算） */
  digest?: string;
  /** 是否已验签（未签名插件为 false） */
  signatureVerified?: boolean;
}

/** 插件注册表存储接口。 */
export interface PluginStore {
  list(): Promise<PluginRecord[]>;
  get(id: string): Promise<PluginRecord | undefined>;
  /** 按命名空间查（用于「这个 namespace 属于哪个插件」） */
  findByNamespace(namespace: string): Promise<PluginRecord | undefined>;
  install(input: InstallPluginInput): Promise<PluginRecord>;
  setStatus(id: string, status: PluginStatus, options?: { lastError?: string | null }): Promise<PluginRecord | undefined>;
  /** 标记信任（后端/前端分别确认，与 `governance.ts` 的语义一致） */
  setTrust(id: string, scope: 'backend' | 'frontend', trusted: boolean, by: string, at: Date): Promise<PluginRecord | undefined>;
  /**
   * 覆写运行时状态（jsonb）。
   *
   * ★ 权限授予（`runtime_state.grants`）存在这里，而不是单独建表——
   *   它与「信任状态」同属「这个插件的运营态」，放一起便于一次性读出。
   */
  setRuntimeState(id: string, state: Record<string, unknown>): Promise<PluginRecord | undefined>;
  /** 已安装且启用的插件 id（供 `PluginRegistry.installedPlugins()`） */
  enabledIds(): Promise<string[]>;
}

/** 计算 manifest 的内容指纹（**与插件包用同一算法**，避免两处漂移）。 */
export function manifestDigest(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex').slice(0, 32);
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryPluginStore implements PluginStore {
  private readonly records = new Map<string, PluginRecord>();

  async list(): Promise<PluginRecord[]> {
    return [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((record) => ({ ...record }));
  }
  async get(id: string): Promise<PluginRecord | undefined> {
    const found = this.records.get(id);
    return found === undefined ? undefined : { ...found };
  }
  async findByNamespace(namespace: string): Promise<PluginRecord | undefined> {
    for (const record of this.records.values()) {
      if (record.namespace === namespace) return { ...record };
    }
    return undefined;
  }
  async install(input: InstallPluginInput): Promise<PluginRecord> {
    const manifest = input.manifest as unknown as Record<string, unknown>;
    const now = new Date();
    const record: PluginRecord = {
      id: input.manifest.id,
      kind: (manifest['kind'] as PluginKind) ?? 'feature',
      name: (manifest['name'] as string) ?? input.manifest.id,
      version: (manifest['version'] as string) ?? '0.0.0',
      apiVersion: (manifest['apiVersion'] as string) ?? 'gate.plugin/v1',
      runtime: (manifest['runtime'] as PluginRuntime) ?? 'declarative',
      source: input.source,
      status: 'installed',
      manifest: input.manifest,
      namespace: (manifest['namespace'] as string) ?? input.manifest.id,
      digest: input.digest ?? manifestDigest(input.manifest),
      signatureVerified: input.signatureVerified ?? false,
      runtimeState: {},
      enabledAt: null,
      lastError: null,
      installedAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return { ...record };
  }
  async setStatus(id: string, status: PluginStatus, options: { lastError?: string | null } = {}): Promise<PluginRecord | undefined> {
    const found = this.records.get(id);
    if (found === undefined) return undefined;
    // ★ P0-4：启用时的 `in-process` 准入闸（`docs/03:67` 的三条件 AND）。
    //   放在 **enable** 而不是 install：文档 §1.12.1 明确「插件仍可装但 enable 被拒」——
    //   安装只是落盘，启用才是「把代码放进主进程」。
    if (status === 'enabled') assertInProcessAdmitted(admissionInputOf(found));
    const next: PluginRecord = {
      ...found,
      status,
      enabledAt: status === 'enabled' ? new Date() : found.enabledAt,
      lastError: options.lastError === undefined ? found.lastError : options.lastError,
      updatedAt: new Date(),
    };
    this.records.set(id, next);
    return { ...next };
  }
  async setTrust(id: string, scope: 'backend' | 'frontend', trusted: boolean, by: string, at: Date): Promise<PluginRecord | undefined> {
    const found = this.records.get(id);
    if (found === undefined) return undefined;
    const trust = { ...((found.runtimeState['trust'] as Record<string, unknown>) ?? {}) };
    trust[scope] = { trusted, by: trusted ? by : null, at: trusted ? at.toISOString() : null };
    const next: PluginRecord = {
      ...found,
      // ★ 撤销后端信任时**一并停用**（与 governance.ts 的语义一致）
      status: scope === 'backend' && !trusted && found.status === 'enabled' ? 'disabled' : found.status,
      runtimeState: { ...found.runtimeState, trust },
      updatedAt: at,
    };
    this.records.set(id, next);
    return { ...next };
  }
  async setRuntimeState(id: string, state: Record<string, unknown>): Promise<PluginRecord | undefined> {
    const found = this.records.get(id);
    if (found === undefined) return undefined;
    const next: PluginRecord = { ...found, runtimeState: { ...state }, updatedAt: new Date() };
    this.records.set(id, next);
    return { ...next };
  }
  async enabledIds(): Promise<string[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'enabled')
      .map((record) => record.id)
      .sort();
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface PluginRow extends Record<string, unknown> {
  id: string;
  kind: string;
  name: string;
  version: string;
  api_version: string;
  runtime: string;
  source: string;
  status: string;
  manifest: Record<string, unknown> | string;
  namespace: string;
  digest: string;
  signature_verified: boolean;
  runtime_state: Record<string, unknown> | string;
  enabled_at: string | Date | null;
  last_error: string | null;
  installed_at: string | Date;
  updated_at: string | Date;
}

const COLUMNS = [
  'id', 'kind', 'name', 'version', 'api_version', 'runtime', 'source', 'status',
  'manifest', 'namespace', 'digest', 'signature_verified', 'runtime_state',
  'enabled_at', 'last_error', 'installed_at', 'updated_at',
];

function parseJson<T>(value: Record<string, unknown> | string | null, fallback: T): T {
  if (value === null) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function rowToRecord(row: PluginRow): PluginRecord {
  return {
    id: row.id,
    kind: row.kind as PluginKind,
    name: row.name,
    version: row.version,
    apiVersion: row.api_version,
    runtime: row.runtime as PluginRuntime,
    source: row.source as PluginSource,
    status: row.status as PluginStatus,
    manifest: parseJson<Record<string, unknown>>(row.manifest, {}),
    namespace: row.namespace,
    digest: row.digest,
    signatureVerified: row.signature_verified === true,
    runtimeState: parseJson<Record<string, unknown>>(row.runtime_state, {}),
    enabledAt: row.enabled_at === null ? null : new Date(row.enabled_at as string),
    lastError: row.last_error,
    installedAt: new Date(row.installed_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function jsonb(value: unknown): string {
  return JSON.stringify(value ?? {});
}

/**
 * `ag_plugins` 的 PG 适配器。
 *
 * ★ 与其他仓储层一致：**由调用方保证在事务内**（`Db.query` 有 `assertInTransaction`）。
 *   真实模式下必须用 `createTransactionalPluginStore` 包装，
 *   否则路由处理器调用时会抛 `TransactionRequiredError`——
 *   这是本会话已出现**六次**的同类问题。
 */
export class DbPluginStore implements PluginStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<PluginRecord[]> {
    const compiled = compile(
      { kind: 'select', table: 'ag_plugins', columns: COLUMNS, orderBy: [{ column: 'id', direction: 'asc' }] },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<PluginRow>(compiled.sql, compiled.params);
    return rows.map(rowToRecord);
  }

  async get(id: string): Promise<PluginRecord | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_plugins', columns: COLUMNS, where: eq(col('id'), lit(id)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<PluginRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async findByNamespace(namespace: string): Promise<PluginRecord | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_plugins', columns: COLUMNS, where: eq(col('namespace'), lit(namespace)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<PluginRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async install(input: InstallPluginInput): Promise<PluginRecord> {
    const manifest = input.manifest as unknown as Record<string, unknown>;
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_plugins',
        rows: [
          {
            id: input.manifest.id,
            kind: (manifest['kind'] as string) ?? 'feature',
            name: (manifest['name'] as string) ?? input.manifest.id,
            version: (manifest['version'] as string) ?? '0.0.0',
            api_version: (manifest['apiVersion'] as string) ?? 'gate.plugin/v1',
            runtime: (manifest['runtime'] as string) ?? 'declarative',
            source: input.source,
            status: 'installed',
            manifest: jsonb(input.manifest),
            namespace: (manifest['namespace'] as string) ?? input.manifest.id,
            digest: input.digest ?? manifestDigest(input.manifest),
            signature_verified: input.signatureVerified ?? false,
            runtime_state: jsonb({}),
          },
        ],
        returning: COLUMNS,
        // ★ 幂等：重复安装同一 id 时更新（而不是报唯一冲突）
        onConflict: { columns: ['id'], do: 'update', updateColumns: ['version', 'manifest', 'digest', 'signature_verified', 'updated_at'] },
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<PluginRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) throw new Error(`安装插件 '${input.manifest.id}' 失败：未返回行`);
    return rowToRecord(row);
  }

  async setStatus(id: string, status: PluginStatus, options: { lastError?: string | null } = {}): Promise<PluginRecord | undefined> {
    // ★ P0-4：启用时的 `in-process` 准入闸（与内存实现同一判据，见 admissionInputOf）
    if (status === 'enabled') {
      const current = await this.get(id);
      if (current === undefined) return undefined;
      assertInProcessAdmitted(admissionInputOf(current));
    }
    const set: Record<string, import('../query/ast.ts').SqlValue> = { status, updated_at: new Date() };
    if (status === 'enabled') set['enabled_at'] = new Date();
    if (options.lastError !== undefined) set['last_error'] = options.lastError;
    const compiled = compile(
      { kind: 'update', table: 'ag_plugins', set, where: eq(col('id'), lit(id)), returning: COLUMNS },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<PluginRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async setTrust(id: string, scope: 'backend' | 'frontend', trusted: boolean, by: string, at: Date): Promise<PluginRecord | undefined> {
    const current = await this.get(id);
    if (current === undefined) return undefined;
    const trust = { ...((current.runtimeState['trust'] as Record<string, unknown>) ?? {}) };
    trust[scope] = { trusted, by: trusted ? by : null, at: trusted ? at.toISOString() : null };
    // ★ 撤销后端信任时一并停用
    const nextStatus = scope === 'backend' && !trusted && current.status === 'enabled' ? 'disabled' : current.status;
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_plugins',
        set: { runtime_state: jsonb({ ...current.runtimeState, trust }), status: nextStatus, updated_at: at },
        where: eq(col('id'), lit(id)),
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<PluginRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async setRuntimeState(id: string, state: Record<string, unknown>): Promise<PluginRecord | undefined> {
    const compiled = compile(
      { kind: 'update', table: 'ag_plugins', set: { runtime_state: jsonb(state), updated_at: new Date() }, where: eq(col('id'), lit(id)), returning: COLUMNS },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<PluginRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async enabledIds(): Promise<string[]> {
    const compiled = compile(
      { kind: 'select', table: 'ag_plugins', columns: ['id'], where: eq(col('status'), lit('enabled')), orderBy: [{ column: 'id', direction: 'asc' }] },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ id: string }>(compiled.sql, compiled.params);
    return rows.map((row) => row.id);
  }
}

/**
 * 自带事务的包装（真实 PG 模式下**必须**用它）。
 *
 * ★ 理由与 `createTransactionalSiteRegistry` 相同：`PluginStore` 的方法
 *   由路由处理器调用（不在业务事务内），而 `Db.query` 有事务断言。
 *   本会话已因这类问题修了六次，因此**在工厂里包好**，而不是指望调用方记得。
 */
export function createTransactionalPluginStore(db: Db): PluginStore {
  const inner = new DbPluginStore(db);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    list: () => wrap(() => inner.list()),
    get: (id) => wrap(() => inner.get(id)),
    findByNamespace: (namespace) => wrap(() => inner.findByNamespace(namespace)),
    install: (input) => wrap(() => inner.install(input)),
    setStatus: (id, status, options) => wrap(() => inner.setStatus(id, status, options)),
    setTrust: (id, scope, trusted, by, at) => wrap(() => inner.setTrust(id, scope, trusted, by, at)),
    setRuntimeState: (id, state) => wrap(() => inner.setRuntimeState(id, state)),
    enabledIds: () => wrap(() => inner.enabledIds()),
  };
}
