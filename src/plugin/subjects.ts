/**
 * 主体存储（M1-1/M1-2）—— `ag_external_subjects` 的仓储层。
 *
 * 表结构（从 `src/schema/tables/integration.ts` 的声明读出，非手抄）：
 *   site_id, id, provider, external_id, display_name, email, attributes(jsonb),
 *   watched(jsonb), fingerprint, raw(jsonb), synced_at, deleted_at
 *   唯一键 (site_id, provider, external_id)
 *
 * ★ 站点作用域：本仓储的**每个**方法都要求 `siteId`，且 SQL 由查询编译器产出
 *   （自动注入 `site_id`），调用方无法「忘记过滤」。
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, inList, isNull, lit, or } from '../query/ast.ts';
import type { ExternalSubject } from './provider.ts';

/** 与声明一致的站点表元信息（用于查询编译器的注入判定）。 */
export const EXTERNAL_SUBJECTS_META: TableScopeMeta = { siteScoped: true, hasSiteIdColumn: true };

export interface StoredSubject {
  provider: string;
  externalId: string;
  displayName?: string;
  email?: string;
  attributes: Record<string, unknown>;
  watched: readonly string[];
  fingerprint: string;
  syncedAt: Date;
  deletedAt?: Date;
}

export interface UpsertResult {
  /** 此前不存在（本轮新发现） */
  created: boolean;
  /** 此前已存在但指纹不同（触发 attributes_changed） */
  changed: boolean;
  /** 此前存在且指纹相同（只更新 synced_at） */
  unchanged: boolean;
  /** 此前被标记 deleted，本轮又出现（复活） */
  revived: boolean;
  /** 变化的键（changed 时有值） */
  changedKeys: string[];
}

export interface SubjectStore {
  get(provider: string, externalId: string): Promise<StoredSubject | undefined>;
  findByEmail(provider: string, email: string): Promise<StoredSubject | undefined>;
  upsert(provider: string, subject: ExternalSubject, watch: readonly string[], fingerprint: string, now: Date): Promise<UpsertResult>;
  /**
   * 标记在本轮全量中未出现的主体为 deleted（**软删除**，不物理删）。
   * 返回**被标记的 externalId 列表**（而不是计数）——调用方要靠它发 `subject.deleted` 事件，
   * 只返回计数会让「谁被删了」丢失，下游无法据此把平台用户转 blocked（docs/05 §4.3）。
   */
  markDeleted(provider: string, keepExternalIds: readonly string[], now: Date): Promise<string[]>;
  /** 该 provider 下所有未删除主体的 externalId（全量对账的「上一轮集合」） */
  listExternalIds(provider: string): Promise<string[]>;
  count(provider: string): Promise<number>;
}

function diffKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  watch: readonly string[],
): string[] {
  return watch.filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
}

/** 内存实现：用于单测与无 DB 的开发模式。 */
export class InMemorySubjectStore implements SubjectStore {
  /** provider → externalId → 记录 */
  private readonly data = new Map<string, Map<string, StoredSubject>>();

  private bucket(provider: string): Map<string, StoredSubject> {
    let bucket = this.data.get(provider);
    if (bucket === undefined) {
      bucket = new Map();
      this.data.set(provider, bucket);
    }
    return bucket;
  }

  async get(provider: string, externalId: string): Promise<StoredSubject | undefined> {
    return this.bucket(provider).get(externalId);
  }

  async findByEmail(provider: string, email: string): Promise<StoredSubject | undefined> {
    for (const record of this.bucket(provider).values()) {
      if (record.deletedAt === undefined && record.email === email) return record;
    }
    return undefined;
  }

  async upsert(
    provider: string,
    subject: ExternalSubject,
    watch: readonly string[],
    fingerprint: string,
    now: Date,
  ): Promise<UpsertResult> {
    const bucket = this.bucket(provider);
    const existing = bucket.get(subject.externalId);
    const next: StoredSubject = {
      provider,
      externalId: subject.externalId,
      attributes: subject.attributes,
      watched: watch,
      fingerprint,
      syncedAt: now,
      ...(subject.displayName === undefined ? {} : { displayName: subject.displayName }),
      ...(subject.email === undefined ? {} : { email: subject.email }),
    };

    if (existing === undefined) {
      bucket.set(subject.externalId, next);
      return { created: true, changed: false, unchanged: false, revived: false, changedKeys: [] };
    }

    const wasDeleted = existing.deletedAt !== undefined;
    const changedKeys = diffKeys(existing.attributes, subject.attributes, watch);
    const changed = existing.fingerprint !== fingerprint;

    // 未删除且指纹未变：只更新 synced_at（轻量路径，不触发下游）
    bucket.set(subject.externalId, next);

    if (wasDeleted) return { created: false, changed: true, unchanged: false, revived: true, changedKeys };
    if (!changed) return { created: false, changed: false, unchanged: true, revived: false, changedKeys: [] };
    return { created: false, changed: true, unchanged: false, revived: false, changedKeys };
  }

  async markDeleted(provider: string, keepExternalIds: readonly string[], now: Date): Promise<string[]> {
    const keep = new Set(keepExternalIds);
    const marked: string[] = [];
    for (const [externalId, record] of this.bucket(provider)) {
      if (keep.has(externalId) || record.deletedAt !== undefined) continue;
      record.deletedAt = now;
      marked.push(externalId);
    }
    return marked;
  }

  async listExternalIds(provider: string): Promise<string[]> {
    return [...this.bucket(provider).values()].filter((r) => r.deletedAt === undefined).map((r) => r.externalId);
  }

  async count(provider: string): Promise<number> {
    return (await this.listExternalIds(provider)).length;
  }
}

// ─────────────────────────── DB 实现 ───────────────────────────

interface SubjectRow extends Record<string, unknown> {
  provider: string;
  external_id: string;
  display_name: string | null;
  email: string | null;
  attributes: Record<string, unknown> | null;
  watched: string[] | null;
  fingerprint: string;
  synced_at: Date | string;
  deleted_at: Date | string | null;
}

function toStored(row: SubjectRow): StoredSubject {
  const stored: StoredSubject = {
    provider: row.provider,
    externalId: row.external_id,
    attributes: row.attributes ?? {},
    watched: row.watched ?? [],
    fingerprint: row.fingerprint,
    syncedAt: row.synced_at instanceof Date ? row.synced_at : new Date(String(row.synced_at)),
  };
  if (row.display_name !== null) stored.displayName = row.display_name;
  if (row.email !== null) stored.email = row.email;
  if (row.deleted_at !== null) stored.deletedAt = row.deleted_at instanceof Date ? row.deleted_at : new Date(String(row.deleted_at));
  return stored;
}

/**
 * 基于 `Db` 的实现。所有 SQL 由查询编译器产出 → 自动注入 `site_id`。
 *
 * ★ 注意 `upsert` 的原子性：写法是「先查后写」。真正的并发安全依赖
 *   `(site_id, provider, external_id)` 唯一键 + 同事务内的冲突处理（见 `reconciler`）。
 *   这里保持简单，因为对账器**每站点同时只有一个实例**（调度器单飞保证）。
 */
export class DbSubjectStore implements SubjectStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  private compileSelect(where: ReturnType<typeof and> | undefined) {
    return compile(
      {
        kind: 'select',
        table: 'ag_external_subjects',
        columns: ['provider', 'external_id', 'display_name', 'email', 'attributes', 'watched', 'fingerprint', 'synced_at', 'deleted_at'],
        ...(where === undefined ? {} : { where }),
      },
      EXTERNAL_SUBJECTS_META,
      { scope: { siteId: this.#siteId } },
    );
  }

  async get(provider: string, externalId: string): Promise<StoredSubject | undefined> {
    const compiled = this.compileSelect(and(eq(col('provider'), lit(provider)), eq(col('external_id'), lit(externalId))));
    const rows = await this.#db.query<SubjectRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : toStored(rows[0]);
  }

  async findByEmail(provider: string, email: string): Promise<StoredSubject | undefined> {
    const compiled = this.compileSelect(
      and(eq(col('provider'), lit(provider)), eq(col('email'), lit(email)), isNull(col('deleted_at'))),
    );
    const rows = await this.#db.query<SubjectRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : toStored(rows[0]);
  }

  async upsert(
    provider: string,
    subject: ExternalSubject,
    watch: readonly string[],
    fingerprint: string,
    now: Date,
  ): Promise<UpsertResult> {
    const existing = await this.get(provider, subject.externalId);
    const attributes = subject.attributes;
    const changedKeys = existing === undefined ? [] : diffKeys(existing.attributes, attributes, watch);
    const revived = existing?.deletedAt !== undefined;

    // 唯一键 (site_id, provider, external_id) 冲突时更新；site_id 由编译器注入，客户端无法覆盖
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_external_subjects',
        rows: [
          {
            provider,
            external_id: subject.externalId,
            display_name: subject.displayName ?? null,
            email: subject.email ?? null,
            attributes,
            watched: [...watch],
            fingerprint,
            synced_at: now,
            deleted_at: null,
          },
        ],
        onConflict: {
          columns: ['site_id', 'provider', 'external_id'],
          do: 'update',
          updateColumns: ['display_name', 'email', 'attributes', 'watched', 'fingerprint', 'synced_at', 'deleted_at'],
        },
      },
      EXTERNAL_SUBJECTS_META,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);

    if (existing === undefined) return { created: true, changed: false, unchanged: false, revived: false, changedKeys: [] };
    if (revived) return { created: false, changed: true, unchanged: false, revived: true, changedKeys };
    if (existing.fingerprint === fingerprint) {
      return { created: false, changed: false, unchanged: true, revived: false, changedKeys };
    }
    return { created: false, changed: true, unchanged: false, revived: false, changedKeys };
  }

  async markDeleted(provider: string, keepExternalIds: readonly string[], now: Date): Promise<string[]> {
    // 本轮未出现的 → deleted_at = now
    const notInList = keepExternalIds.length === 0 ? undefined : or(...keepExternalIds.map((id) => eq(col('external_id'), lit(id))));
    const where =
      keepExternalIds.length === 0
        ? and(eq(col('provider'), lit(provider)), isNull(col('deleted_at')))
        : and(eq(col('provider'), lit(provider)), isNull(col('deleted_at')), { kind: 'not', condition: notInList! });

    const compiled = compile(
      { kind: 'update', table: 'ag_external_subjects', set: { deleted_at: now }, where },
      EXTERNAL_SUBJECTS_META,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<{ external_id: string }>(`${compiled.sql} RETURNING external_id`, compiled.params);
    return rows.map((row) => row.external_id);
  }

  async listExternalIds(provider: string): Promise<string[]> {
    const compiled = this.compileSelect(and(eq(col('provider'), lit(provider)), isNull(col('deleted_at'))));
    const rows = await this.#db.query<SubjectRow>(compiled.sql, compiled.params);
    return rows.map((row) => row.external_id);
  }

  async count(provider: string): Promise<number> {
    return (await this.listExternalIds(provider)).length;
  }
}

/** 辅助：按一批 externalId 过滤（供需要时复用）。 */
export function inExternalIds(ids: readonly string[]) {
  return inList(col('external_id'), [...ids]);
}
