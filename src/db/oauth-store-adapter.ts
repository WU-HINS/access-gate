/**
 * 本平台作为 **OAuth 授权服务器**（IdP）的 PG 适配器（R96，P1-2）。
 *
 * ★★★ 为什么需要它：`OAuthStore` 此前**只有内存实现**，且 **schema 里没有对应的表**。
 *   · `/oauth/authorize` → 用户在浏览器同意 → `/oauth/token` 是**跨请求**的协议流程；
 *   · **多实例部署**时授权码在 A 实例签发、兑换请求可能落到 B 实例 → **第三方无法完成授权**；
 *   · **重启后**已发放的授权码与刷新令牌**全部失效**。
 *
 * ★★ 两处**必须原子**的地方：
 *   ① `redeemCode()` —— 接口注释写明「取并**标记为已兑换**（原子；返回 undefined 表示不存在或已用过）」。
 *      ★ 若写成「先 SELECT 判断 redeemed、再 UPDATE」：两个并发兑换会**都**看到 `redeemed=false`，
 *        于是同一个授权码被兑换两次——**授权码的一次性语义失效**（这是 OAuth 的核心安全属性）。
 *      ★ 因此用**单条 `UPDATE … WHERE code = $1 AND redeemed = false RETURNING …`**：
 *        条件与写入在同一条语句里，由数据库保证只有一个并发事务能更新到那一行。
 *   ② 刷新令牌**只存哈希**（与协同验证调用方密钥、插件令牌同一纪律）。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { AuthorizationCode, OAuthClient, OAuthStore } from '../http/oauth-routes.ts';

/** 三张表都是**平台级**（无 `site_id`）——见 `docs/02` 的 R3 豁免清单。 */
const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return [];
}

// ─────────────────────────── 客户端 ───────────────────────────

interface ClientRow extends Record<string, unknown> {
  client_id: string;
  name: string;
  redirect_uris: unknown;
  scopes: unknown;
  status: string;
}

const CLIENT_COLUMNS = ['client_id', 'name', 'redirect_uris', 'scopes', 'status'];

function rowToClient(row: ClientRow): OAuthClient {
  return {
    clientId: row.client_id,
    name: row.name,
    redirectUris: toArray(row.redirect_uris),
    scopes: toArray(row.scopes),
    status: row.status as 'active' | 'disabled',
  };
}

// ─────────────────────────── 授权码 ───────────────────────────

interface CodeRow extends Record<string, unknown> {
  code: string;
  client_id: string;
  redirect_uri: string;
  subject: string;
  display_name: string | null;
  scopes: unknown;
  code_challenge: string;
  nonce: string | null;
  issued_at: string | Date;
  expires_at: string | Date;
  redeemed: boolean;
}

const CODE_COLUMNS = [
  'code', 'client_id', 'redirect_uri', 'subject', 'display_name', 'scopes',
  'code_challenge', 'nonce', 'issued_at', 'expires_at', 'redeemed',
];

function rowToCode(row: CodeRow): AuthorizationCode {
  return {
    code: row.code,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    subject: row.subject,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    scopes: toArray(row.scopes),
    codeChallenge: row.code_challenge,
    ...(row.nonce === null ? {} : { nonce: row.nonce }),
    issuedAt: new Date(row.issued_at as string),
    redeemed: row.redeemed,
  };
}

// ─────────────────────────── 刷新令牌 ───────────────────────────

interface RefreshRow extends Record<string, unknown> {
  token_hash: string;
  client_id: string;
  subject: string;
  scopes: unknown;
  expires_at: string | Date;
  revoked: boolean;
}

export class DbOAuthStore implements OAuthStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async findClient(clientId: string): Promise<OAuthClient | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_oauth_clients', columns: CLIENT_COLUMNS, where: eq(col('client_id'), lit(clientId)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ClientRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToClient(rows[0]);
  }

  /** 注册（或更新）一个第三方客户端。 */
  async saveClient(client: OAuthClient): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_oauth_clients',
        rows: [
          {
            client_id: client.clientId,
            name: client.name,
            redirect_uris: JSON.stringify([...client.redirectUris]),
            scopes: JSON.stringify([...client.scopes]),
            status: client.status,
          },
        ],
        returning: ['client_id'],
        onConflict: { columns: ['client_id'], do: 'update', updateColumns: ['name', 'redirect_uris', 'scopes', 'status'] },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async saveCode(code: AuthorizationCode): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_oauth_codes',
        rows: [
          {
            code: code.code,
            client_id: code.clientId,
            redirect_uri: code.redirectUri,
            subject: code.subject,
            display_name: code.displayName ?? null,
            scopes: JSON.stringify([...code.scopes]),
            code_challenge: code.codeChallenge,
            nonce: code.nonce ?? null,
            issued_at: code.issuedAt,
            // ★ 过期时间：授权码是**短期**凭证（缺省 5 分钟；由 `expiresAt` 传入更准确）
            expires_at: new Date(code.issuedAt.getTime() + 5 * 60_000),
            redeemed: code.redeemed,
          },
        ],
        returning: ['code'],
        onConflict: { columns: ['code'], do: 'nothing' },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  /**
   * ★★ **原子兑换**：`UPDATE … WHERE code = $1 AND redeemed = false RETURNING …`。
   *
   * ★ 返回 `undefined` = 不存在 **或** 已兑换（两者对调用方等价：**不能发令牌**）。
   */
  async redeemCode(code: string): Promise<AuthorizationCode | undefined> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_oauth_codes',
        set: { redeemed: true },
        where: and(eq(col('code'), lit(code)), eq(col('redeemed'), lit(false))),
        returning: CODE_COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<CodeRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToCode(rows[0]);
  }

  async saveRefresh(
    tokenHash: string,
    input: { clientId: string; subject: string; scopes: readonly string[]; expiresAt: Date },
  ): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_oauth_refresh_tokens',
        rows: [
          {
            token_hash: tokenHash,
            client_id: input.clientId,
            subject: input.subject,
            scopes: JSON.stringify([...input.scopes]),
            expires_at: input.expiresAt,
            revoked: false,
          },
        ],
        returning: ['token_hash'],
        onConflict: { columns: ['token_hash'], do: 'nothing' },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async findRefresh(
    tokenHash: string,
  ): Promise<{ clientId: string; subject: string; scopes: readonly string[]; expiresAt: Date; revoked: boolean } | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_oauth_refresh_tokens',
        columns: ['token_hash', 'client_id', 'subject', 'scopes', 'expires_at', 'revoked'],
        where: eq(col('token_hash'), lit(tokenHash)),
        limit: 1,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<RefreshRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      clientId: row.client_id,
      subject: row.subject,
      scopes: toArray(row.scopes),
      expiresAt: new Date(row.expires_at as string),
      revoked: row.revoked,
    };
  }

  async revoke(tokenHash: string): Promise<void> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_oauth_refresh_tokens',
        set: { revoked: true },
        where: eq(col('token_hash'), lit(tokenHash)),
        returning: ['token_hash'],
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalOAuthStore(db: Db): OAuthStore & { saveClient(client: OAuthClient): Promise<void> } {
  const inner = new DbOAuthStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    findClient: (clientId) => wrap(() => inner.findClient(clientId)),
    saveClient: (client) => wrap(() => inner.saveClient(client)),
    saveCode: (code) => wrap(() => inner.saveCode(code)),
    redeemCode: (code) => wrap(() => inner.redeemCode(code)),
    saveRefresh: (tokenHash, input) => wrap(() => inner.saveRefresh(tokenHash, input)),
    findRefresh: (tokenHash) => wrap(() => inner.findRefresh(tokenHash)),
    revoke: (tokenHash) => wrap(() => inner.revoke(tokenHash)),
  };
}
