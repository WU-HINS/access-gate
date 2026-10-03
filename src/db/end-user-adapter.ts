/**
 * 终端用户的 PG 适配器（`ag_users` + `ag_identities`）—— **数据丢失级**缺口的修复。
 *
 * ★★★★ 为什么这是最高优先级：
 *
 *   此前 `serve.ts` 无条件使用 `InMemoryEndUserStore`，后果是：
 *   · **服务重启 → 终端用户「消失」**：他们下次登录会被当作**新用户重新建号**，
 *     用户 id 变化 → 该用户的历史**资格、动作、审计**全部对不上；
 *   · **多实例** → 在 A 实例建号的用户，在 B 实例被当作新用户。
 *
 *   ★ 代码注释里早就写着「已在报告中登记为缺口」——**登记 ≠ 修复**。
 *     本适配器把它真正修掉。
 *
 * ★ 两条写入路径（与联邦登录的语义对应）：
 *   ① `ag_users` —— 平台身份锚点（`id` 即 OIDC sub，永不变）；
 *   ② `ag_identities` —— 「哪个 provider 的哪个 sub」映射到该用户。
 *
 *   ★ 两者必须**同时写**：只写 `ag_users` 则下次登录找不到映射（又建一个新号）；
 *     只写 `ag_identities` 则用户详情查不到。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import type { EndUser, EndUserStore } from '../auth/flows.ts';

/** `ag_users` / `ag_identities` 都是**平台级**表（用户跨站点）。 */
const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

/**
 * `EndUser.status`（`active|suspended`）→ `ag_users.status`（`pending|active|suspended|deleted`）。
 *
 * ★ 两个枚举**不完全一样**：`ag_users` 多出 `pending`（未验证邮箱）与 `deleted`（软删）。
 *   `EndUser` 的视图更窄，因此映射是「取交集」——
 *   `pending`/`deleted` 在 `EndUser` 侧都表现为 `suspended`（不可用）。
 */
function toEndUserStatus(status: string): EndUser['status'] {
  return status === 'active' ? 'active' : 'suspended';
}

interface UserRow extends Record<string, unknown> {
  id: string;
  username: string;
  email: string;
  email_verified: boolean;
  status: string;
  profile: Record<string, unknown> | string | null;
}

const USER_COLUMNS = ['id', 'username', 'email', 'email_verified', 'status', 'profile'];

function rowToEndUser(row: UserRow): EndUser {
  const profile = typeof row.profile === 'string' ? (JSON.parse(row.profile) as Record<string, unknown>) : (row.profile ?? {});
  return {
    id: row.id,
    username: row.username,
    // ★ displayName 存在 `profile.displayName`（`ag_users` 没有独立列）
    displayName: typeof profile['displayName'] === 'string' ? profile['displayName'] : row.username,
    email: row.email,
    emailVerified: row.email_verified === true,
    status: toEndUserStatus(row.status),
  };
}

export class DbEndUserStore implements EndUserStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 通过 `ag_identities` 找到平台用户 id（**这是「同一 sub 不重复建号」的关键**）。
   *
   * ★★ 关于「撤销」：`ag_identities` **没有 `revoked_at` 列**——
   *   `DbIdentityStore` 的实现把撤销时间塞进 **`claim_snapshot.revokedAt`**（jsonb）。
   *   ★ 我最初按直觉写了一个「撤销列为空」的条件，真实 PG 立刻报
   *     `column "revoked_at" does not exist`。
   *   ★ 教训：**先读已有实现，再写新实现**——
   *     同一个表在别处已经有一套约定，凭直觉写会撞上它。
   *
   *   因此这里：查出候选行 → **在应用层判断 `claim_snapshot.revokedAt`**。
   *   （撤销的绑定应视为「未绑定」→ 下次登录重新建号。）
   */
  async findByIdentity(provider: string, providerUserId: string): Promise<string | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_identities',
        columns: ['user_id', 'claim_snapshot'],
        where: and(eq(col('provider'), lit(provider)), eq(col('provider_user_id'), lit(providerUserId))),
        limit: 1,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ user_id: string; claim_snapshot: Record<string, unknown> | string | null }>(
      compiled.sql,
      compiled.params,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const snapshot =
      typeof row.claim_snapshot === 'string'
        ? (JSON.parse(row.claim_snapshot) as Record<string, unknown>)
        : (row.claim_snapshot ?? {});
    // ★ 已撤销的绑定视为不存在（与 `DbIdentityStore` 的 `revokedAt` 约定一致）
    if (snapshot['revokedAt'] != null) return undefined;
    return row.user_id;
  }

  async find(id: string): Promise<EndUser | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_users', columns: USER_COLUMNS, where: eq(col('id'), lit(id)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UserRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToEndUser(rows[0]);
  }

  async create(input: {
    provider: string;
    providerUserId: string;
    username: string;
    displayName: string;
    email: string;
    emailVerified: boolean;
  }): Promise<EndUser> {
    // ★★ 先查身份映射：若已存在，**返回既有用户**而不是建新号。
    //   这是「重启后不重复建号」的核心——即使调用方没先调 findByIdentity。
    const existing = await this.findByIdentity(input.provider, input.providerUserId);
    if (existing !== undefined) {
      const found = await this.find(existing);
      if (found !== undefined) return found;
    }

    const id = randomUUID();
    const userCompiled = compile(
      {
        kind: 'insert',
        table: 'ag_users',
        rows: [
          {
            id,
            email: input.email,
            email_verified: input.emailVerified,
            username: input.username,
            // ★ `source='oidc'`：本用户来自联邦登录（不是本地注册）
            source: 'oidc',
            // ★ 邮箱已验证 → `active`；未验证 → `pending`（与 ag_user_status 枚举一致）
            status: input.emailVerified ? 'active' : 'pending',
            profile: JSON.stringify({ displayName: input.displayName }),
          },
        ],
        returning: USER_COLUMNS,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<UserRow>(userCompiled.sql, userCompiled.params);
    const row = rows[0];
    if (row === undefined) throw new Error(`创建终端用户失败：未返回行（username=${input.username}）`);

    // ★ 第二步：写身份映射（同一次事务内——由 `createTransactionalEndUserStore` 保证）
    const identityCompiled = compile(
      {
        kind: 'insert',
        table: 'ag_identities',
        rows: [
          {
            owner_scope: 'platform',
            owner_id: 'platform',
            user_id: id,
            provider: input.provider,
            provider_user_id: input.providerUserId,
            claim_snapshot: JSON.stringify({ email: input.email, email_verified: input.emailVerified }),
          },
        ],
        returning: ['id'],
        // ★ 同一 (provider, providerUserId) 已存在 → 更新为指向本用户（换绑场景）
        onConflict: {
          columns: ['owner_scope', 'owner_id', 'provider', 'provider_user_id'],
          do: 'update',
          // ★ 没有 `revoked_at` 列——重新绑定时把 `claim_snapshot` 整体覆写
          //   （新快照里不含 `revokedAt`，等于**清除撤销标记**）
          updateColumns: ['user_id', 'claim_snapshot'],
        },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(identityCompiled.sql, identityCompiled.params);

    return rowToEndUser(row);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalEndUserStore(db: Db): EndUserStore {
  const inner = new DbEndUserStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    findByIdentity: (provider, providerUserId) => wrap(() => inner.findByIdentity(provider, providerUserId)),
    find: (id) => wrap(() => inner.find(id)),
    create: (input) => wrap(() => inner.create(input)),
  };
}
