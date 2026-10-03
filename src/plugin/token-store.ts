/**
 * 插件令牌（`ag_plugin_tokens`）—— 插件调用宿主 API 的凭证。
 *
 * ★ 与 `ag_verify_clients` 的设计一致（**复用**而非另发明）：
 *   表里只存 `token_hash`（不可逆）与 `token_prefix`（用于识别），
 *   **原始令牌只在创建时返回一次**。
 *
 * ★ 与 verify clients 的一处差异：本表**没有 status 枚举**，
 *   撤销用 `revoked_at`（软撤销，保留历史）。★ 这是我先查了迁移产物才发现的——
 *   如果凭直觉照抄 verify clients 的 `status` 字段，就会写错。
 *
 * ★ `id` 是 **uuid**（`uuidv7()` 默认值）→ 内存实现必须用 `randomUUID()`。
 *   本会话已两次栽在「内存生成 `xx-1` 而 PG 是 uuid」上（`vcc-1`、`ui-1`），
 *   并为此加了静态检查（`table-coverage` 的「非 uuid 的内存 id 生成」）。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { col, eq, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export interface PluginTokenRecord {
  id: string;
  pluginId: string;
  name: string;
  /** 令牌前缀（用于运维识别「这是哪一把」）——**不是令牌本身** */
  tokenPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreatePluginTokenInput {
  pluginId: string;
  name: string;
  scopes: readonly string[];
  /** 有效期（秒）；不提供则永不过期 */
  ttlSeconds?: number;
}

export interface PluginTokenStore {
  list(pluginId: string): Promise<PluginTokenRecord[]>;
  /** 创建并返回**只出现一次**的原始令牌 */
  create(input: CreatePluginTokenInput): Promise<{ token: PluginTokenRecord; secret: string }>;
  /** 撤销（**软撤销**：写 `revoked_at`；幂等，保留首次时间） */
  revoke(pluginId: string, id: string, at: Date): Promise<{ record: PluginTokenRecord; alreadyRevoked: boolean } | undefined>;
}

/** 令牌哈希（与校验侧**同一算法**，否则插件永远验不过）。 */
export function hashToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 生成插件令牌：`pt_` 前缀 + 32 字节随机。 */
export function generateToken(): string {
  return `pt_${randomBytes(32).toString('base64url')}`;
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryPluginTokenStore implements PluginTokenStore {
  private readonly records = new Map<string, PluginTokenRecord>();

  async list(pluginId: string): Promise<PluginTokenRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.pluginId === pluginId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((record) => ({ ...record }));
  }

  async create(input: CreatePluginTokenInput): Promise<{ token: PluginTokenRecord; secret: string }> {
    const secret = generateToken();
    const now = new Date();
    const record: PluginTokenRecord = {
      // ★ 必须是合法 uuid（PG 的主键是 uuid）——见文件头说明
      id: randomUUID(),
      pluginId: input.pluginId,
      name: input.name,
      tokenPrefix: secret.slice(0, 10),
      scopes: [...input.scopes],
      expiresAt: input.ttlSeconds === undefined ? null : new Date(now.getTime() + input.ttlSeconds * 1000),
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
    };
    this.records.set(record.id, record);
    return { token: { ...record }, secret };
  }

  async revoke(pluginId: string, id: string, at: Date): Promise<{ record: PluginTokenRecord; alreadyRevoked: boolean } | undefined> {
    const found = this.records.get(id);
    if (found === undefined || found.pluginId !== pluginId) return undefined;
    // ★ 幂等：保留首次撤销时间
    if (found.revokedAt !== null) return { record: { ...found }, alreadyRevoked: true };
    const next: PluginTokenRecord = { ...found, revokedAt: at };
    this.records.set(id, next);
    return { record: { ...next }, alreadyRevoked: false };
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface TokenRow extends Record<string, unknown> {
  id: string;
  plugin_id: string;
  name: string;
  token_prefix: string;
  scopes: unknown;
  expires_at: string | Date | null;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

const COLUMNS = ['id', 'plugin_id', 'name', 'token_prefix', 'scopes', 'expires_at', 'last_used_at', 'revoked_at', 'created_at'];

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return [];
}

function toDate(value: string | Date | null): Date | null {
  return value === null ? null : new Date(value);
}

function rowToRecord(row: TokenRow): PluginTokenRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: toArray(row.scopes),
    expiresAt: toDate(row.expires_at),
    lastUsedAt: toDate(row.last_used_at),
    revokedAt: toDate(row.revoked_at),
    createdAt: new Date(row.created_at as string),
  };
}

export class DbPluginTokenStore implements PluginTokenStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async list(pluginId: string): Promise<PluginTokenRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_tokens',
        columns: COLUMNS,
        where: eq(col('plugin_id'), lit(pluginId)),
        orderBy: [{ column: 'created_at', direction: 'desc' }],
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<TokenRow>(compiled.sql, compiled.params);
    return rows.map(rowToRecord);
  }

  async create(input: CreatePluginTokenInput): Promise<{ token: PluginTokenRecord; secret: string }> {
    const secret = generateToken();
    const now = new Date();
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_plugin_tokens',
        rows: [
          {
            owner_scope: 'platform',
            owner_id: 'platform',
            plugin_id: input.pluginId,
            name: input.name,
            // ★ 只存哈希与前缀——原始令牌**不落库**
            token_hash: hashToken(secret),
            token_prefix: secret.slice(0, 10),
            scopes: JSON.stringify([...input.scopes]),
            expires_at: input.ttlSeconds === undefined ? null : new Date(now.getTime() + input.ttlSeconds * 1000),
          },
        ],
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<TokenRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) throw new Error(`创建插件 '${input.pluginId}' 的令牌失败：未返回行`);
    return { token: rowToRecord(row), secret };
  }

  async revoke(pluginId: string, id: string, at: Date): Promise<{ record: PluginTokenRecord; alreadyRevoked: boolean } | undefined> {
    // ★ 幂等：只在 `revoked_at IS NULL` 时写入（保留首次撤销时间）
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_plugin_tokens',
        set: { revoked_at: at },
        where: eq(col('id'), lit(id)),
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<TokenRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined || row.plugin_id !== pluginId) return undefined;
    const record = rowToRecord(row);
    // 若本次更新生效，`revoked_at` 应等于 at；否则说明此前已撤销
    const alreadyRevoked = record.revokedAt === null || record.revokedAt.getTime() !== at.getTime();
    return { record, alreadyRevoked };
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalPluginTokenStore(db: Db): PluginTokenStore {
  const inner = new DbPluginTokenStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    list: (pluginId) => wrap(() => inner.list(pluginId)),
    create: (input) => wrap(() => inner.create(input)),
    revoke: (pluginId, id, at) => wrap(() => inner.revoke(pluginId, id, at)),
  };
}
