/**
 * 协同验证调用方管理（`ag_verify_clients`）—— P0（M5 的运营面）。
 *
 * ★★ 本模块最重要的一条安全设计：**密钥只在创建时返回一次**。
 *
 *   表里只存 `secret_hash`（不可逆）与 `secret_prefix`（用于识别，如 `vc_a1b2…`）。
 *   创建响应里返回原始密钥，此后**任何接口都无法再取回它**——
 *   这不是「不方便」，而是密钥管理的正确形态：
 *   若平台能取回明文密钥，那么一次数据库泄露就等于所有调用方密钥泄露。
 *
 * ★ 枚举取值**先查迁移产物**：`ag_client_status = 'active' | 'suspended' | 'revoked'`
 *   （与 `ag_plugin_status` 不同——后者是 `installed/validated/enabled/disabled/error/removed`。
 *    同类字段的枚举可能不同，所以每张表都要单独查。）
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { secretKeyFor } from './client-store-db.ts';
import type { SecretStore } from '../secrets/store.ts';

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { col, eq, lit } from '../query/ast.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export type ClientStatus = 'active' | 'suspended' | 'revoked';

export interface VerifyClientRecord {
  id: string;
  clientId: string;
  name: string;
  /** 密钥前缀（用于运维识别「这是哪一把密钥」） */
  secretPrefix: string;
  scopes: string[];
  allowedSubjects: string[];
  callbackUrl: string | null;
  status: ClientStatus;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface CreateClientInput {
  name: string;
  scopes: readonly string[];
  allowedSubjects?: readonly string[];
  callbackUrl?: string;
  createdBy?: string | null;
}

export interface VerifyClientAdminStore {
  list(): Promise<VerifyClientRecord[]>;
  get(id: string): Promise<VerifyClientRecord | undefined>;
  /** 创建并返回**只出现一次**的原始密钥 */
  create(input: CreateClientInput): Promise<{ client: VerifyClientRecord; secret: string }>;
  setStatus(id: string, status: ClientStatus): Promise<VerifyClientRecord | undefined>;
  /** 轮换密钥（旧密钥立即失效） */
  rotate(id: string): Promise<{ client: VerifyClientRecord; secret: string } | undefined>;
  remove(id: string): Promise<boolean>;
}

/** 密钥哈希（与 HMAC 校验侧**同一算法**，否则调用方永远验不过）。 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 生成调用方密钥：`vc_` 前缀 + 32 字节随机（base64url）。 */
export function generateSecret(): string {
  return `vc_${randomBytes(32).toString('base64url')}`;
}

export function generateClientId(): string {
  return `vc_${randomBytes(8).toString('hex')}`;
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryVerifyClientAdminStore implements VerifyClientAdminStore {
  private readonly records = new Map<string, VerifyClientRecord>();

  async list(): Promise<VerifyClientRecord[]> {
    return [...this.records.values()].sort((a, b) => (a.clientId < b.clientId ? -1 : 1)).map((record) => ({ ...record }));
  }
  async get(id: string): Promise<VerifyClientRecord | undefined> {
    const found = this.records.get(id);
    return found === undefined ? undefined : { ...found };
  }
  async create(input: CreateClientInput): Promise<{ client: VerifyClientRecord; secret: string }> {
    const secret = generateSecret();
    const record: VerifyClientRecord = {
      // ★★ 必须是**合法 uuid**：PG 实现的 `id` 是 `uuid` 列（`uuidv7()` 默认值），
      //   而这里曾生成 `vcc-1` 这种字符串 → 内存实现与 PG 实现的 id 形态不一致。
      //   后果：接口层加了 uuid 校验后，**内存模式的测试全部失败**，
      //   而真实模式正常——这正是「两个实现语义不一致」的典型（R26 的分页也是）。
      id: randomUUID(),
      clientId: generateClientId(),
      name: input.name,
      secretPrefix: secret.slice(0, 10),
      scopes: [...input.scopes],
      allowedSubjects: [...(input.allowedSubjects ?? [])],
      callbackUrl: input.callbackUrl ?? null,
      status: 'active',
      lastUsedAt: null,
      createdAt: new Date(),
    };
    this.records.set(record.id, record);
    return { client: { ...record }, secret };
  }
  async setStatus(id: string, status: ClientStatus): Promise<VerifyClientRecord | undefined> {
    const found = this.records.get(id);
    if (found === undefined) return undefined;
    const next: VerifyClientRecord = { ...found, status };
    this.records.set(id, next);
    return { ...next };
  }
  async rotate(id: string): Promise<{ client: VerifyClientRecord; secret: string } | undefined> {
    const found = this.records.get(id);
    if (found === undefined) return undefined;
    const secret = generateSecret();
    const next: VerifyClientRecord = { ...found, secretPrefix: secret.slice(0, 10) };
    this.records.set(id, next);
    return { client: { ...next }, secret };
  }
  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface ClientRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  name: string;
  secret_prefix: string;
  scopes: unknown;
  allowed_subjects: unknown;
  callback_url: string | null;
  status: string;
  last_used_at: string | Date | null;
  created_at: string | Date;
}

const COLUMNS = ['id', 'client_id', 'name', 'secret_prefix', 'scopes', 'allowed_subjects', 'callback_url', 'status', 'last_used_at', 'created_at'];

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return [];
}

function rowToRecord(row: ClientRow): VerifyClientRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    secretPrefix: row.secret_prefix,
    scopes: toArray(row.scopes),
    allowedSubjects: toArray(row.allowed_subjects),
    callbackUrl: row.callback_url,
    status: row.status as ClientStatus,
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at as string),
    createdAt: new Date(row.created_at as string),
  };
}

export class DbVerifyClientAdminStore implements VerifyClientAdminStore {
  readonly #db: Db;
  /** ★ 原始密钥的加密存储（`ag_secrets`）——不提供时只写哈希，`resolveSecret` 将取不到值 */
  readonly #secrets: SecretStore | undefined;
  readonly #masterKey: Buffer | undefined;
  constructor(db: Db, secrets?: SecretStore, masterKey?: Buffer) {
    this.#db = db;
    this.#secrets = secrets;
    this.#masterKey = masterKey;
  }

  /**
   * 把原始密钥写入 `ag_secrets`（**加密**）。
   *
   * ★★ 为什么必须做：`secret_hash` 只能**查找**调用方，无法**重算 HMAC**——
   *   后者需要原文。而 `hmac.ts` 从设计之初就注明「原始值必须加密存储
   *   （`ag_secrets` + 主密钥）」。只写哈希会让真实模式下的 HMAC 校验永远失败。
   */
  async #sealSecret(clientId: string, secret: string): Promise<void> {
    if (this.#secrets === undefined || this.#masterKey === undefined) return;
    await this.#secrets.put(secretKeyFor(clientId), secret, this.#masterKey);
  }

  async list(): Promise<VerifyClientRecord[]> {
    const compiled = compile(
      { kind: 'select', table: 'ag_verify_clients', columns: COLUMNS, orderBy: [{ column: 'client_id', direction: 'asc' }] },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ClientRow>(compiled.sql, compiled.params);
    return rows.map(rowToRecord);
  }

  async get(id: string): Promise<VerifyClientRecord | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_verify_clients', columns: COLUMNS, where: eq(col('id'), lit(id)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ClientRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async create(input: CreateClientInput): Promise<{ client: VerifyClientRecord; secret: string }> {
    const secret = generateSecret();
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_verify_clients',
        rows: [
          {
            owner_scope: 'platform',
            owner_id: 'platform',
            client_id: generateClientId(),
            name: input.name,
            // ★ 只存哈希与前缀——原始密钥**不落库**
            secret_hash: hashSecret(secret),
            secret_prefix: secret.slice(0, 10),
            scopes: JSON.stringify([...input.scopes]),
            allowed_subjects: JSON.stringify([...(input.allowedSubjects ?? [])]),
            callback_url: input.callbackUrl ?? null,
            status: 'active',
            created_by: input.createdBy ?? null,
          },
        ],
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ClientRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) throw new Error('创建调用方失败：未返回行');
    const record = rowToRecord(row);
    // ★ 原始密钥加密落库（`ag_secrets`）——校验侧据此重算 HMAC
    await this.#sealSecret(record.clientId, secret);
    return { client: record, secret };
  }

  async setStatus(id: string, status: ClientStatus): Promise<VerifyClientRecord | undefined> {
    const compiled = compile(
      { kind: 'update', table: 'ag_verify_clients', set: { status }, where: eq(col('id'), lit(id)), returning: COLUMNS },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ClientRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async rotate(id: string): Promise<{ client: VerifyClientRecord; secret: string } | undefined> {
    const secret = generateSecret();
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_verify_clients',
        set: { secret_hash: hashSecret(secret), secret_prefix: secret.slice(0, 10) },
        where: eq(col('id'), lit(id)),
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ClientRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) return undefined;
    const record = rowToRecord(row);
    // ★ 轮换后**覆盖** `ag_secrets` 里的原文（旧密钥立即失效）
    await this.#sealSecret(record.clientId, secret);
    return { client: record, secret };
  }

  async remove(id: string): Promise<boolean> {
    const compiled = compile({ kind: 'delete', table: 'ag_verify_clients', where: eq(col('id'), lit(id)) }, PLATFORM, {});
    const rows = await this.#db.query<{ id: string }>(compiled.sql, compiled.params);
    return rows.length > 0;
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它）。 */
export function createTransactionalVerifyClientAdminStore(db: Db, secrets?: SecretStore, masterKey?: Buffer): VerifyClientAdminStore {
  const inner = new DbVerifyClientAdminStore(db, secrets, masterKey);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    list: () => wrap(() => inner.list()),
    get: (id) => wrap(() => inner.get(id)),
    create: (input) => wrap(() => inner.create(input)),
    setStatus: (id, status) => wrap(() => inner.setStatus(id, status)),
    rotate: (id) => wrap(() => inner.rotate(id)),
    remove: (id) => wrap(() => inner.remove(id)),
  };
}
