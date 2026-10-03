/**
 * `ag_secrets` 存储（平台级密钥保险箱）。
 *
 * ★ 用途：保存**需要可解密**的密钥（如协同验证调用方的原始 secret，
 *   因为 HMAC 校验必须用原文重算）。**不可逆**的密钥（密码、会话 token）
 *   一律只存哈希，不放这里。
 *
 * ★ 表设计支持轮换：`key_version` + `rotated_at`——轮换主密钥时
 *   按版本逐步重加密（见 `tools/key-rotation.ts`）。
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';
import { and, col, eq, lit } from '../query/ast.ts';
import { openSecret, sealSecret, type SealedSecret } from './crypto.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

export interface SecretStore {
  /** 写入或覆盖（同一 key 只有一条：`uq_ag_secrets_key`） */
  put(key: string, plaintext: string, masterKey: Buffer): Promise<void>;
  /** 读取并解密（不存在返回 undefined） */
  get(key: string, masterKey: Buffer): Promise<string | undefined>;
  /** 删除 */
  remove(key: string): Promise<boolean>;
}

// ─────────────────────────── 内存实现 ───────────────────────────

/** 内存实现（仅供测试）：**直接存明文**，与 `hmac.ts` 里注明的一致。 */
export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async put(key: string, plaintext: string): Promise<void> {
    this.values.set(key, plaintext);
  }
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async remove(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface SecretRow extends Record<string, unknown> {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
}

const COLUMNS = ['ciphertext', 'iv', 'auth_tag', 'key_version'];

export class DbSecretStore implements SecretStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async put(key: string, plaintext: string, masterKey: Buffer): Promise<void> {
    const sealed: SealedSecret = sealSecret(plaintext, masterKey);
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_secrets',
        rows: [
          {
            owner_scope: 'platform',
            owner_id: 'platform',
            key,
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            auth_tag: sealed.authTag,
            key_version: sealed.keyVersion,
          },
        ],
        returning: ['id'],
        onConflict: { columns: ['owner_scope', 'owner_id', 'key'], do: 'update', updateColumns: ['ciphertext', 'iv', 'auth_tag', 'key_version', 'updated_at'] },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async get(key: string, masterKey: Buffer): Promise<string | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_secrets',
        columns: COLUMNS,
        where: and(eq(col('key'), lit(key)), eq(col('owner_scope'), lit('platform')), eq(col('owner_id'), lit('platform'))),
        limit: 1,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SecretRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) return undefined;
    return openSecret(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version },
      masterKey,
    );
  }

  async remove(key: string): Promise<boolean> {
    const compiled = compile(
      { kind: 'delete', table: 'ag_secrets', where: and(eq(col('key'), lit(key)), eq(col('owner_scope'), lit('platform'))) },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ id: string }>(compiled.sql, compiled.params);
    return rows.length > 0;
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它）。 */
export function createTransactionalSecretStore(db: Db): SecretStore {
  const inner = new DbSecretStore(db);
  // ★★ 复用外层事务（handler 入口已开事务时不再嵌套）——见 `tx.ts` 的说明。
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    put: (key, plaintext, masterKey) => wrap(() => inner.put(key, plaintext, masterKey)),
    get: (key, masterKey) => wrap(() => inner.get(key, masterKey)),
    remove: (key) => wrap(() => inner.remove(key)),
  };
}
