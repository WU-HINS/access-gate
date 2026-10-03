/**
 * OIDC 提供方注册（`ag_oidc_providers`）—— 联邦登录的前置。
 *
 * ★ 枚举取值**先查迁移产物**：
 *   `ag_oidc_direction = 'outbound' | 'inbound'`
 *   `ag_oidc_status    = 'active' | 'suspended' | 'revoked'`
 *
 * ★★ 安全关键：`client_secret_ref` 是**引用**（指向 `ag_secrets` 的 key），
 *   **不是密钥本身**。这样：
 *   ① 表里没有明文密钥（一次数据库泄露不等于密钥泄露）；
 *   ② 密钥轮换只需改 `ag_secrets`，不用动注册记录；
 *   ③ 读取密钥必须经过 `SecretStore`（有主密钥才能解密）。
 *
 *   ★ 本会话 R30 发现「`ag_secrets` 从未被任何代码读写」——本模块是它的第二个使用者
 *     （第一个是协同验证调用方密钥），因此**复用**而非另建一套。
 *
 * ★ `ag_oidc_providers` 在 `docs/02` 的**平台级豁免清单**里
 *   （理由：平台级 IdP 配置），因此本表不带 `site_id`。
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { col, eq, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export type OidcDirection = 'outbound' | 'inbound';
export type OidcStatus = 'active' | 'suspended' | 'revoked';

export interface OidcProviderRecord {
  id: string;
  /** 短标识（路径参数用；如 `platform:enduser`）——★ varchar，不是 uuid */
  ref: string;
  label: string;
  direction: OidcDirection;
  issuer: string;
  wellKnown: string | null;
  clientId: string | null;
  /** ★ 指向 `ag_secrets` 的 key——**不是密钥本身** */
  clientSecretRef: string | null;
  redirectUris: string[];
  scopes: string[];
  signingAlgs: string[];
  exposedClaims: string[];
  allowPlatformLogin: boolean;
  status: OidcStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertOidcProviderInput {
  ref: string;
  label: string;
  direction: OidcDirection;
  issuer: string;
  wellKnown?: string;
  clientId?: string;
  clientSecretRef?: string;
  redirectUris?: readonly string[];
  scopes?: readonly string[];
  signingAlgs?: readonly string[];
  exposedClaims?: readonly string[];
  allowPlatformLogin?: boolean;
}

/**
 * `issuer` 冲突（另一个 ref 已注册同一 IdP）。
 *
 * ★ 为什么不能静默重试：两个不同的 `ref` 指向同一 IdP 是**配置错误**
 *   （会导致「同一个身份在两条链路上建两个号」），必须让运维显式处理。
 */
export class OidcIssuerConflict extends Error {
  override readonly name = 'OidcIssuerConflict';
  constructor(issuer: string) {
    super(
      `issuer '${issuer}' 已被另一个 OIDC 提供方注册（uq_ag_oidc_providers_issuer）——` +
        `同一 IdP 不应有两个 ref（会导致同一身份在两条链路上各建一个号）`,
    );
  }
}

export interface OidcProviderStore {
  list(): Promise<OidcProviderRecord[]>;
  findByRef(ref: string): Promise<OidcProviderRecord | undefined>;
  upsert(input: UpsertOidcProviderInput): Promise<OidcProviderRecord>;
  setStatus(ref: string, status: OidcStatus): Promise<OidcProviderRecord | undefined>;
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryOidcProviderStore implements OidcProviderStore {
  private readonly records = new Map<string, OidcProviderRecord>();

  async list(): Promise<OidcProviderRecord[]> {
    return [...this.records.values()].sort((a, b) => (a.ref < b.ref ? -1 : 1)).map((record) => ({ ...record }));
  }
  async findByRef(ref: string): Promise<OidcProviderRecord | undefined> {
    const found = this.records.get(ref);
    return found === undefined ? undefined : { ...found };
  }
  async upsert(input: UpsertOidcProviderInput): Promise<OidcProviderRecord> {
    const now = new Date();
    // ★★ 内存实现也要模拟 PG 的 `uq_ag_oidc_providers_issuer`——
    //   否则「内存模式通过、真实模式 409」会成为又一处语义漂移
    //   （本会话已出现多次：分页多取一条、id 形态、枚举取值）。
    for (const record of this.records.values()) {
      if (record.ref !== input.ref && record.issuer === input.issuer) {
        throw new OidcIssuerConflict(input.issuer);
      }
    }
    const existing = this.records.get(input.ref);
    const record: OidcProviderRecord = {
      id: existing?.id ?? `oidc-${input.ref}`,
      ref: input.ref,
      label: input.label,
      direction: input.direction,
      issuer: input.issuer,
      wellKnown: input.wellKnown ?? null,
      clientId: input.clientId ?? null,
      clientSecretRef: input.clientSecretRef ?? null,
      redirectUris: [...(input.redirectUris ?? [])],
      scopes: [...(input.scopes ?? [])],
      signingAlgs: [...(input.signingAlgs ?? [])],
      exposedClaims: [...(input.exposedClaims ?? [])],
      allowPlatformLogin: input.allowPlatformLogin ?? false,
      status: existing?.status ?? 'active',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(input.ref, record);
    return { ...record };
  }
  async setStatus(ref: string, status: OidcStatus): Promise<OidcProviderRecord | undefined> {
    const found = this.records.get(ref);
    if (found === undefined) return undefined;
    const next: OidcProviderRecord = { ...found, status, updatedAt: new Date() };
    this.records.set(ref, next);
    return { ...next };
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface ProviderRow extends Record<string, unknown> {
  id: string;
  ref: string;
  label: string;
  direction: string;
  issuer: string;
  well_known: string | null;
  client_id: string | null;
  client_secret_ref: string | null;
  redirect_uris: unknown;
  scopes: unknown;
  signing_algs: unknown;
  exposed_claims: unknown;
  allow_platform_login: boolean;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const COLUMNS = [
  'id', 'ref', 'label', 'direction', 'issuer', 'well_known', 'client_id', 'client_secret_ref',
  'redirect_uris', 'scopes', 'signing_algs', 'exposed_claims', 'allow_platform_login', 'status',
  'created_at', 'updated_at',
];

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return [];
}

function rowToRecord(row: ProviderRow): OidcProviderRecord {
  return {
    id: row.id,
    ref: row.ref,
    label: row.label,
    direction: row.direction as OidcDirection,
    issuer: row.issuer,
    wellKnown: row.well_known,
    clientId: row.client_id,
    clientSecretRef: row.client_secret_ref,
    redirectUris: toArray(row.redirect_uris),
    scopes: toArray(row.scopes),
    signingAlgs: toArray(row.signing_algs),
    exposedClaims: toArray(row.exposed_claims),
    allowPlatformLogin: row.allow_platform_login === true,
    status: row.status as OidcStatus,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class DbOidcProviderStore implements OidcProviderStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<OidcProviderRecord[]> {
    const compiled = compile(
      { kind: 'select', table: 'ag_oidc_providers', columns: COLUMNS, orderBy: [{ column: 'ref', direction: 'asc' }] },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ProviderRow>(compiled.sql, compiled.params);
    return rows.map(rowToRecord);
  }

  async findByRef(ref: string): Promise<OidcProviderRecord | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_oidc_providers', columns: COLUMNS, where: eq(col('ref'), lit(ref)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ProviderRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async upsert(input: UpsertOidcProviderInput): Promise<OidcProviderRecord> {
    const now = new Date();
    // ★ 按 `ref` 幂等：同一 ref 重复注册应**更新**而不是插重复行。
    //
    // ★★ 表上**确实有** `uq_ag_oidc_providers_ref`（以及 `uq_ag_oidc_providers_issuer`）
    //   —— 我上一轮误判为「没有唯一约束」，原因是查证时用了
    //   `grep ... | head -5`，**只看到前几条索引就下了结论**。
    //   ★ 教训：`head` 会让我看到一部分就当全部——**核对存在性时不要截断输出**。
    //
    //   因此这里「先查后写」是**性能优化**（避免每次都走冲突分支），
    //   而**并发安全由数据库的唯一约束保证**。冲突时要转成**可读的 409**，
    //   而不是把 PG 的原始错误抛成 500（见下面的 catch）。
    const existing = await this.findByRef(input.ref);
    if (existing !== undefined) {
      const compiled = compile(
        {
          kind: 'update',
          table: 'ag_oidc_providers',
          set: {
            label: input.label,
            direction: input.direction,
            issuer: input.issuer,
            well_known: input.wellKnown ?? null,
            client_id: input.clientId ?? null,
            client_secret_ref: input.clientSecretRef ?? null,
            redirect_uris: JSON.stringify([...(input.redirectUris ?? [])]),
            scopes: JSON.stringify([...(input.scopes ?? [])]),
            signing_algs: JSON.stringify([...(input.signingAlgs ?? [])]),
            exposed_claims: JSON.stringify([...(input.exposedClaims ?? [])]),
            allow_platform_login: input.allowPlatformLogin ?? false,
            updated_at: now,
          },
          where: eq(col('id'), lit(existing.id)),
          returning: COLUMNS,
        },
        PLATFORM,
        {},
      );
      const rows = await this.#db.query<ProviderRow>(compiled.sql, compiled.params);
      const row = rows[0];
      if (row === undefined) throw new Error(`更新 OIDC 提供方 '${input.ref}' 失败：未返回行`);
      return rowToRecord(row);
    }

    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_oidc_providers',
        rows: [
          {
            ref: input.ref,
            label: input.label,
            direction: input.direction,
            issuer: input.issuer,
            well_known: input.wellKnown ?? null,
            client_id: input.clientId ?? null,
            client_secret_ref: input.clientSecretRef ?? null,
            redirect_uris: JSON.stringify([...(input.redirectUris ?? [])]),
            scopes: JSON.stringify([...(input.scopes ?? [])]),
            signing_algs: JSON.stringify([...(input.signingAlgs ?? [])]),
            exposed_claims: JSON.stringify([...(input.exposedClaims ?? [])]),
            allow_platform_login: input.allowPlatformLogin ?? false,
            status: 'active',
          },
        ],
        returning: COLUMNS,
      },
      PLATFORM,
      {},
    );
    try {
      const rows = await this.#db.query<ProviderRow>(compiled.sql, compiled.params);
      const row = rows[0];
      if (row === undefined) throw new Error(`注册 OIDC 提供方 '${input.ref}' 失败：未返回行`);
      return rowToRecord(row);
    } catch (error) {
      // ★★ 并发下「先查后写」可能同时判定「不存在」→ 两方都插 → 撞唯一约束。
      //   此时**重新走一次更新路径**（对方刚插的那行就是我们要更新的行）。
      const message = error instanceof Error ? error.message : String(error);
      if (/uq_ag_oidc_providers_ref|uq_ag_oidc_providers_issuer|duplicate key/i.test(message)) {
        const conflicted = await this.findByRef(input.ref);
        if (conflicted !== undefined) return this.upsert(input);
        // ★ ref 没冲突，那就是 **issuer** 冲突（另一个 ref 已用同一 issuer）——
        //   这不该静默重试（会把两个不同的 ref 指向同一 IdP），必须显式报错。
        throw new OidcIssuerConflict(input.issuer);
      }
      throw error;
    }
  }

  async setStatus(ref: string, status: OidcStatus): Promise<OidcProviderRecord | undefined> {
    const compiled = compile(
      { kind: 'update', table: 'ag_oidc_providers', set: { status, updated_at: new Date() }, where: eq(col('ref'), lit(ref)), returning: COLUMNS },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ProviderRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalOidcProviderStore(db: Db): OidcProviderStore {
  const inner = new DbOidcProviderStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    list: () => wrap(() => inner.list()),
    findByRef: (ref) => wrap(() => inner.findByRef(ref)),
    upsert: (input) => wrap(() => inner.upsert(input)),
    setStatus: (ref, status) => wrap(() => inner.setStatus(ref, status)),
  };
}
