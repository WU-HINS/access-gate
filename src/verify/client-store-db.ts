/**
 * 协同验证调用方的 **PG 实现**（`find` + `resolveSecret`）。
 *
 * ★★★ 为什么必须写它：R30 的表使用核对发现——
 *   `tools/serve.ts` 在**真实 PG 模式下也用的是 `InMemoryVerifyClientStore`**：
 *
 *   ```ts
 *   const verifyClients = new InMemoryVerifyClientStore();   // ← 内存！
 *   ```
 *
 *   后果链：
 *   1. 调用方只存在于进程内存，**重启即丢失**；
 *   2. 管理端（`DbVerifyClientAdminStore`）写 `ag_verify_clients` 表，
 *      而校验端读内存 → **创建了调用方，HMAC 校验永远找不到它**；
 *   3. `ag_secrets` 从未被写入 → 即使有 DB 实现，`resolveSecret` 也无处可取。
 *
 * ★ 这正是目标第 (1) 条禁止的「**用内存模式冒充真实模式**」。
 *
 * ★ 本实现的两条链路：
 *   · `find(clientId)` → `ag_verify_clients`（按 `client_id` 查，不是主键 id）
 *   · `resolveSecret(clientId)` → `ag_secrets`（key = `verify-client:<clientId>`）
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, isNull, lit } from '../query/ast.ts';
import type { SecretStore } from '../secrets/store.ts';
import type { VerifyClient, VerifyClientStore } from './hmac.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

/**
 * ★★ 直接**复用** `hmac.ts` 的 `VerifyClient` 与 `VerifyClientStore`，
 *   而不是在这里另写一份形状相同的接口。
 *
 *   我最初写了一份「形状一致」的本地接口（多了 `secretPrefix`、把可选字段写成必填），
 *   结果 tsc 报「`InMemoryVerifyClientStore` 不能赋给 `VerifyClientStore`」——
 *   这正是「两处定义会漂移」的实证。
 */
export type { VerifyClient, VerifyClientStore } from './hmac.ts';

/** 调用方原始密钥在 `ag_secrets` 里的 key（**唯一约定**，读写两侧共用）。 */
export function secretKeyFor(clientId: string): string {
  return `verify-client:${clientId}`;
}

export interface VerifyClientLookup extends VerifyClientStore {
  resolveSecret(clientId: string): Promise<string | undefined>;
}

interface ClientRow extends Record<string, unknown> {
  client_id: string;
  name: string;
  scopes: unknown;
  allowed_subjects: unknown;
  callback_url: string | null;
  status: string;
  secret_prefix: string;
}

const COLUMNS = ['client_id', 'name', 'scopes', 'allowed_subjects', 'callback_url', 'status'];

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return [];
}

export class DbVerifyClientLookup implements VerifyClientLookup {
  readonly #db: Db;
  readonly #secrets: SecretStore;
  readonly #masterKey: Buffer;
  constructor(db: Db, secrets: SecretStore, masterKey: Buffer) {
    this.#db = db;
    this.#secrets = secrets;
    this.#masterKey = masterKey;
  }

  async find(clientId: string): Promise<VerifyClient | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_verify_clients', columns: COLUMNS, where: eq(col('client_id'), lit(clientId)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ClientRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) return undefined;
    // ★ 字段名与 `VerifyClient` 完全一致；`callbackUrl` 为 null 时**省略**
    //   （接口里它是 `callbackUrl?: string`，写成 null 会偏离语义）
    return {
      clientId: row.client_id,
      name: row.name,
      scopes: toArray(row.scopes),
      allowedSubjects: toArray(row.allowed_subjects),
      ...(row.callback_url === null ? {} : { callbackUrl: row.callback_url }),
      status: row.status as VerifyClient['status'],
    };
  }

  async resolveSecret(clientId: string): Promise<string | undefined> {
    // ★★ 只在**未被停用/吊销**时返回密钥——停用的调用方不应能通过 HMAC 校验。
    //   （`find` 已返回状态，但这里再查一次是因为调用方可能只用 `resolveSecret`。）
    const client = await this.find(clientId);
    if (client === undefined || client.status !== 'active') return undefined;
    return this.#secrets.get(secretKeyFor(clientId), this.#masterKey);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它）。 */
export function createTransactionalVerifyClientLookup(db: Db, secrets: SecretStore, masterKey: Buffer): VerifyClientLookup {
  const inner = new DbVerifyClientLookup(db, secrets, masterKey);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => db.transaction(async () => fn());
  return {
    find: (clientId) => wrap(() => inner.find(clientId)),
    resolveSecret: (clientId) => wrap(() => inner.resolveSecret(clientId)),
  };
}

void isNull;
