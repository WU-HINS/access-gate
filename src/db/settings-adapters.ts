/**
 * 平台设置的 PostgreSQL 适配器（`ag_platform_settings`）。
 *
 * ★ 与其他仓储层一致：**由调用方保证在事务内**（`Db.query` 有事务断言）。
 *   真实模式下请用 `createTransactionalSettingsStore`（本文件提供），
 *   否则路由处理器调用时会抛 `TransactionRequiredError`——
 *   这是本会话已出现**七次**的同类问题，因此在工厂里一次性包好。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { col, eq, lit } from '../query/ast.ts';
import type { PlatformSettingRecord, PlatformSettingsStore } from '../app/platform-mode.ts';

/** `ag_platform_settings` 是**平台级**表。 */
const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

interface SettingRow extends Record<string, unknown> {
  key: string;
  value: unknown;
  locked_by_env: boolean;
  updated_by: string | null;
  updated_at: string | Date;
}

const COLUMNS = ['key', 'value', 'locked_by_env', 'updated_by', 'updated_at'];

function rowToRecord(row: SettingRow): PlatformSettingRecord {
  return {
    key: row.key,
    value: row.value,
    lockedByEnv: row.locked_by_env === true,
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at as string),
  };
}

function jsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class DbPlatformSettingsStore implements PlatformSettingsStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async get(key: string): Promise<PlatformSettingRecord | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_platform_settings', columns: COLUMNS, where: eq(col('key'), lit(key)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SettingRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async put(key: string, value: unknown, by: string | null, at: Date): Promise<PlatformSettingRecord> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_platform_settings',
        rows: [{ key, value: jsonb(value), locked_by_env: false, updated_by: by, updated_at: at }],
        returning: COLUMNS,
        onConflict: { columns: ['key'], do: 'update', updateColumns: ['value', 'updated_by', 'updated_at'] },
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SettingRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) throw new Error(`写入平台设置 '${key}' 失败：未返回行`);
    return rowToRecord(row);
  }

  async putIfAbsent(key: string, value: unknown, by: string | null, at: Date, lockedByEnv = false): Promise<PlatformSettingRecord> {
    // ★ `ON CONFLICT DO NOTHING` + 回读：保证「首次写入后不再覆盖」
    //   （文档 §11：`initial` 仅首次生效，此后以设置为准）
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_platform_settings',
        rows: [{ key, value: jsonb(value), locked_by_env: lockedByEnv, updated_by: by, updated_at: at }],
        returning: COLUMNS,
        onConflict: { columns: ['key'], do: 'nothing' },
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SettingRow>(compiled.sql, compiled.params);
    if (rows[0] !== undefined) return rowToRecord(rows[0]);
    const existing = await this.get(key);
    if (existing === undefined) throw new Error(`写入平台设置 '${key}' 失败：冲突后回读为空`);
    return existing;
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它）。 */
export function createTransactionalSettingsStore(db: Db): PlatformSettingsStore {
  const inner = new DbPlatformSettingsStore(db);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    get: (key) => wrap(() => inner.get(key)),
    put: (key, value, by, at) => wrap(() => inner.put(key, value, by, at)),
    putIfAbsent: (key, value, by, at, lockedByEnv) => wrap(() => inner.putIfAbsent(key, value, by, at, lockedByEnv)),
  };
}
