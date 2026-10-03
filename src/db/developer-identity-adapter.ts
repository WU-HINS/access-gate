/**
 * 开发者身份查找的 PG 适配器（`ag_identities`）—— ★★★★★ 修复「开发者永远无法登录」。
 *
 * ★★★★ 问题（R76 实测确认）：
 *
 *   `tools/serve.ts` 的 `developerIdentities` 是一个**空 Map 且无人写入**：
 *   ```
 *   const developerIdentities = new Map<string, string>();   // ← 空
 *   developerIdentities: { async findByIdentity(p, s) { return developerIdentities.get(...); } }
 *   ```
 *   → `findByIdentity` **永远返回 undefined** →
 *     `assertDeveloperMayLogin` **永远返回 `not_onboarded`** →
 *     **开发者永远无法登录**。
 *
 *   ★ 而**测试全绿**：`test/invitations.test.ts` 手工构造了一个会返回 id 的 lookup，
 *     验证的是**判定逻辑**，没有验证「真实装配下这个 lookup 是否返回 id」。
 *
 * ★ 修复方案（证据早已齐备，**不需要设计决策**）：
 *   · provider 命名空间**已定义**：`DEVELOPER_IDENTITY_PROVIDER`；
 *   · 映射的存储**已存在**：`ag_identities`（`provider` + `provider_user_id` → `user_id`）；
 *   · 缺的只有「写入」与「读取」两处实现。
 *
 * ★ 关于 `ag_identities.user_id` 的语义：
 *   `docs/02` 注释写「→ ag_users.id」，但 `DEVELOPER_IDENTITY_PROVIDER` 的存在说明
 *   该表**也承载开发者身份**（`owner_scope = 'developer'` 时 `user_id` 是 `ag_developers.id`）。
 *   ★ 本实现用 `owner_scope = 'developer'` + `owner_id = 'platform'` **把两类身份分开**，
 *     因此不会与终端用户的绑定混淆（查询条件里显式带上 owner_scope）。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import { DEVELOPER_IDENTITY_PROVIDER, type DeveloperLookup } from '../core/invitations.ts';

/** `ag_identities` 是平台级表（身份跨站点）。 */
const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

/** 开发者身份的 owner 作用域（与终端用户绑定区分开）。 */
export const DEVELOPER_IDENTITY_OWNER_SCOPE = 'developer';

export class DbDeveloperIdentityLookup implements DeveloperLookup {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 按 OIDC sub 查开发者 id。
   *
   * ★ 显式带 `owner_scope = 'developer'`：否则可能与**终端用户**的同名 provider 记录混淆。
   */
  async findByIdentity(provider: string, providerUserId: string): Promise<string | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_identities',
        columns: ['user_id'],
        where: and(
          eq(col('owner_scope'), lit(DEVELOPER_IDENTITY_OWNER_SCOPE)),
          eq(col('owner_id'), lit('platform')),
          eq(col('provider'), lit(provider)),
          eq(col('provider_user_id'), lit(providerUserId)),
        ),
        limit: 1,
      },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<{ user_id: string }>(compiled.sql, compiled.params);
    const userId = rows[0]?.user_id;
    if (userId === undefined) return undefined;

    // ★★★ R101（方案 A）引入的**必要适配**：
    //   `ag_identities.user_id` 的语义是**平台用户**（`ag_users.id`），
    //   而本接口（`DeveloperLookup.findByIdentity`）的语义是返回**开发者 id**。
    //   ★ 两者在方案 A 下**不再相等**（`ag_developers.user_id` 才是平台用户 id）——
    //     因此这里必须**反查** `ag_developers`。
    //   ★ 若不反查：登录准入会把 `userId` 当作 `developer.id` 返回，
    //     后续按该 id 查开发者会**查不到**（表现为「入驻了却登录不了」）。
    const developer = compile(
      {
        kind: 'select',
        table: 'ag_developers',
        columns: ['id'],
        where: eq(col('user_id'), lit(userId)),
        limit: 1,
      },
      PLATFORM,
      {},
    );
    const found = await this.#db.query<{ id: string }>(developer.sql, developer.params);
    return found[0]?.id;
  }
}

/**
 * 记录「某个 OIDC sub 已入驻为开发者」——**入驻时调用**。
 *
 * ★ 这是修复的关键一半：**没有写入，读取永远是空的**。
 * ★ 幂等：同一 (provider, providerUserId) 重复入驻 → 更新指向的开发者 id（换绑场景）。
 */
export async function recordDeveloperIdentity(
  db: Db,
  input: { developerId: string; oidcSubject: string },
): Promise<void> {
  // ★★ 必须包在事务里（`Db.query` 有 `assertInTransaction`）——
  //   我第一版直接调 `db.query`，真实 PG 立刻报「拒绝在事务外执行 query」。
  //   ★ 这是本会话**第 9 次**同类问题。根因始终一样：
  //     **对外暴露的「写函数」若直接碰 `db.query`，调用方就必须自己包事务**——
  //     而调用方（管理端点 / 入驻流程）**很容易忘记**。
  //   ★ 因此这里自己包（已在外层事务时 `reuseOrBeginTransaction` 会复用，不会嵌套）。
  return reuseOrBeginTransaction(db, () => recordDeveloperIdentityInner(db, input));
}

async function recordDeveloperIdentityInner(
  db: Db,
  input: { developerId: string; oidcSubject: string },
): Promise<void> {
  const compiled = compile(
    {
      kind: 'insert',
      table: 'ag_identities',
      rows: [
        {
          owner_scope: DEVELOPER_IDENTITY_OWNER_SCOPE,
          owner_id: 'platform',
          user_id: input.developerId,
          provider: DEVELOPER_IDENTITY_PROVIDER,
          provider_user_id: input.oidcSubject,
          claim_snapshot: JSON.stringify({ onboardedAt: new Date().toISOString() }),
        },
      ],
      returning: ['id'],
      onConflict: {
        columns: ['owner_scope', 'owner_id', 'provider', 'provider_user_id'],
        do: 'update',
        updateColumns: ['user_id', 'claim_snapshot'],
      },
    },
    PLATFORM,
    {},
  );
  await db.query(compiled.sql, compiled.params);
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalDeveloperIdentityLookup(db: Db): DeveloperLookup {
  const inner = new DbDeveloperIdentityLookup(db);
  return {
    findByIdentity: (provider, providerUserId) => reuseOrBeginTransaction(db, () => inner.findByIdentity(provider, providerUserId)),
  };
}
