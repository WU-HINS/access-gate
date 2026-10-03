/**
 * OIDC 签名密钥的 PG 存储（`ag_oidc_signing_keys`）—— 补齐 `docs/02 §7.4` 声明的表。
 *
 * ★★ 为什么必须有它（本轮核实出的事实）：
 *   该表在 `src/` 里**零引用**，而 `tools/serve.ts` 用内存 `SigningKeySet`
 *   **运行时生成**密钥。后果不只是"轮换没有通道"，而是**密钥本身不持久**：
 *   **重启即换密钥** → 已签发的 ID Token / 断言在真正验签的下游那里全部验不过。
 *   而 `docs/05 §8.4.1` 的「先发布、后使用」**前提就是密钥持久**——
 *   否则每次重启都等于一次"未发布就使用"的轮换。
 *
 * ★ 私钥加密复用 `src/secrets/crypto.ts` 的 AES-256-GCM（与 `ag_secrets` 同一套主密钥），
 *   但**不放进 `ag_secrets`**：签名密钥需要独立的状态机（active/standby/retiring/retired）
 *   与轮换元数据（`docs/02 §7.4` 的说明）。
 *
 * ★ 本文件属**仓储层**（`src/db/`）：由调用方保证在事务内，运行时由
 *   查询层内的 `assertInTransaction` 兜底（见 `tools/ci-gate.ts` 的白名单说明）。
 */

import { exportJWK, importJWK } from 'jose';
import type { KeyObject } from 'node:crypto';

import type { Db } from './pool.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import { openSecret, sealSecret } from '../secrets/crypto.ts';
import { exportPrivateJwk, generateSigningKey, SigningKeySet, type ManagedSigningKey } from '../verify/jws.ts';
import type {
  OidcSigningKeyStore,
  SigningKeyRecord,
  SigningKeyStatus,
} from '../core/oidc-key-rotation.ts';

interface KeyRow extends Record<string, unknown> {
  kid: string;
  alg: string;
  status: SigningKeyStatus;
  activated_at: Date | string | null;
  retired_from_signing_at: Date | string | null;
  remove_after: Date | string | null;
  created_at: Date | string;
}

interface LoadRow extends KeyRow {
  public_jwk: unknown;
  private_ciphertext: string;
  private_iv: string;
  private_auth_tag: string;
  master_key_version: number;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toOptionalDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function rowToRecord(row: KeyRow): SigningKeyRecord {
  return {
    kid: row.kid,
    alg: row.alg,
    status: row.status,
    activatedAt: toOptionalDate(row.activated_at),
    retiredFromSigningAt: toOptionalDate(row.retired_from_signing_at),
    removeAfter: toOptionalDate(row.remove_after),
    createdAt: toDate(row.created_at),
  };
}

// ★ 列名刻意**写字面量**、不抽常量：CI 第 6 项禁止模板字面量里的插值
//   （即使插的是常量——那正是「裸 SQL 拼接」的形态）。下面各查询同样不用插值。

export class DbOidcSigningKeyStore implements OidcSigningKeyStore {
  readonly #db: Db;
  readonly #masterKey: Buffer;

  constructor(db: Db, masterKey: Buffer) {
    this.#db = db;
    this.#masterKey = masterKey;
  }

  async list(): Promise<readonly SigningKeyRecord[]> {
    return reuseOrBeginTransaction(this.#db, async () => {
      const rows = await this.#db.query<KeyRow>(
        'SELECT kid, alg, status, activated_at, retired_from_signing_at, remove_after, created_at FROM ag_oidc_signing_keys ORDER BY created_at',
        [],
      );
      return rows.map(rowToRecord);
    });
  }

  /**
   * 生成新密钥并以 `standby` 落库（**不签发**）。
   *
   * ★ `kid` 用 `alg + 时间戳（36 进制）` 生成：它必须**全局唯一**且**可读**，
   *   因为下游 JWKS 缓存与 ID Token header 都靠它选 key。
   */
  async createStandby(input: { alg: string; now: Date }): Promise<SigningKeyRecord> {
    const kid = `${input.alg.toLowerCase()}-${input.now.getTime().toString(36)}`;
    const key = await generateSigningKey(kid);
    const privateJwk = await exportPrivateJwk(key);
    const publicJwk = await exportJWK(key.publicKey);
    const sealed = sealSecret(JSON.stringify(privateJwk), this.#masterKey);

    await reuseOrBeginTransaction(this.#db, async () => {
      await this.#db.query(
        `INSERT INTO ag_oidc_signing_keys
           (kid, kty, alg, crv, public_jwk, private_ciphertext, private_iv, private_auth_tag,
            master_key_version, status, created_at)
         VALUES ($1, 'EC', $2, 'P-256', $3::jsonb, $4, $5, $6, $7, 'standby', $8)`,
        [
          kid,
          input.alg,
          JSON.stringify(publicJwk),
          sealed.ciphertext,
          sealed.iv,
          sealed.authTag,
          sealed.keyVersion,
          input.now,
        ],
      );
    });

    return {
      kid,
      alg: input.alg,
      status: 'standby',
      activatedAt: null,
      retiredFromSigningAt: null,
      removeAfter: null,
      createdAt: input.now,
    };
  }

  /**
   * ★★ **唯一允许的切换方式**：同一事务内**先降后升**。
   *
   * ★ 顺序不可换：`uq_ag_oidc_keys_active_alg` 是**部分唯一索引**（每种算法至多一个 active），
   *   先升就会撞它（`test/oidc-key-rotation.test.ts` 在真实 PG 上证明了这一点）。
   * ★ 也不能拆成两个事务：中间会出现**零 active 窗口** → 全站登录中断。
   */
  async activateAtomically(input: {
    retiringKid: string | null;
    activeKid: string;
    now: Date;
    removeAfter: Date;
  }): Promise<void> {
    await this.#db.transaction(async () => {
      if (input.retiringKid !== null) {
        await this.#db.query(
          `UPDATE ag_oidc_signing_keys
              SET status = 'retiring', retired_from_signing_at = $2, remove_after = $3
            WHERE kid = $1`,
          [input.retiringKid, input.now, input.removeAfter],
        );
      }
      await this.#db.query(
        `UPDATE ag_oidc_signing_keys SET status = 'active', activated_at = $2 WHERE kid = $1`,
        [input.activeKid, input.now],
      );
    });
  }

  async retire(input: { kid: string; now: Date }): Promise<void> {
    await reuseOrBeginTransaction(this.#db, async () => {
      await this.#db.query(`UPDATE ag_oidc_signing_keys SET status = 'retired' WHERE kid = $1`, [
        input.kid,
      ]);
    });
  }

  /**
   * ★ 从表**加载**可发布的密钥集（`active` + `standby` + `retiring`，不含 `retired`）。
   *
   * ★ 为什么 retiring 也要加载：已签发但未过期的 token 需要旧公钥才能验签——
   *   轮换时立刻撤下旧公钥会让那些 token「验签失败」，而它们本该有效
   *   （`SigningKeySet` 的注释把这条记为"真实的线上事故形态"）。
   *
   * ★ 私钥在这里被**解密**（AES-256-GCM，`authTag` 不匹配即抛错——GCM 保证未被篡改）。
   */
  async loadSigningKeySet(): Promise<SigningKeySet> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<LoadRow>(
        `SELECT kid, alg, status, activated_at, retired_from_signing_at, remove_after, created_at,
                public_jwk, private_ciphertext, private_iv, private_auth_tag, master_key_version
           FROM ag_oidc_signing_keys
          WHERE status <> 'retired'
          ORDER BY created_at`,
        [],
      ),
    );

    const set = new SigningKeySet();
    for (const row of rows) {
      const privateJwk = JSON.parse(
        openSecret(
          {
            ciphertext: row.private_ciphertext,
            iv: row.private_iv,
            authTag: row.private_auth_tag,
            keyVersion: row.master_key_version,
          },
          this.#masterKey,
        ),
      ) as Record<string, unknown>;
      const publicJwk =
        typeof row.public_jwk === 'string'
          ? (JSON.parse(row.public_jwk) as Record<string, unknown>)
          : (row.public_jwk as Record<string, unknown>);

      // ★ `importJWK` 的返回类型是 `CryptoKey | Uint8Array`（WebCrypto 优先），
      //   而本项目的 `SigningKey.privateKey` 刻意收窄为 `KeyObject`（jose 的签名接口要它）。
      //   这里显式转两次：不是"绕过类型"，而是把 jose 的联合返回**收敛到我们已经验证过的那一支**
      //   ——`test/oidc-signing-key-adapter.test.ts` 的「签名/验签往返」就是那个验证。
      const privateKey = (await importJWK(privateJwk, row.alg)) as unknown as KeyObject;
      const publicKey = (await importJWK(publicJwk, row.alg)) as unknown as KeyObject;
      const managed: ManagedSigningKey = {
        kid: row.kid,
        privateKey,
        publicKey,
        status: row.status,
        createdAt: toDate(row.created_at),
      };
      set.add(managed);
    }
    return set;
  }
}
