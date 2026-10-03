/**
 * 开发者 ↔ 平台用户的**映射建立**（方案 A，R101）。
 *
 * ★★★ 为什么需要它：`ag_plugin_facts.user_id` 与 `ag_identities.user_id` 的语义都是
 *   **平台用户**（`ag_users.id`）；而**开发者级插件**（`configScope: 'developer'`）
 *   采集的事实属于**该开发者**——但 `ag_developers.id` 与 `ag_users.id`
 *   **不是同一个值**（R76 核实）。
 *
 * ★ 方案 A：让**开发者也是平台用户**（他确实要登录、有身份、有会话），
 *   用 `ag_developers.user_id` 建立映射。
 *
 * ★★ 本函数做三件事（**一次事务内**，缺一不可）：
 *   ① 建一条 `ag_users` 记录（`id` = 新的平台用户 id）；
 *   ② 回填 `ag_developers.user_id`；
 *   ③ 返回该 `userId`——供调用方写 `ag_identities`（**开发者身份映射必须指向它**，
 *      而不是 `developerId`）。
 *
 * ★★★ 为什么放在**被调函数内部**（而不是让调用方自己组合）：
 *   本会话已两次因「依赖调用方记得做」而出缺口
 *   （`recordDeveloperIdentity` 无调用点 · 入驻未写身份映射）。
 *   ★ 因此这里把「建用户 + 回填」做成**一个不可分割的步骤**。
 */

import { randomUUID } from 'node:crypto';

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, isNull, lit, or } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

/**
 * 为开发者建立（或复用）对应的平台用户，并回填 `ag_developers.user_id`。
 *
 * ★ **幂等**：若该开发者已有 `user_id`，直接返回它（不重复建用户）。
 *
 * @returns 平台用户 id（`ag_users.id`）——**写 `ag_identities` 时用它**
 */
export async function ensureDeveloperUser(
  db: Db,
  input: { developerId: string; username: string; email: string; emailVerified: boolean },
): Promise<string> {
  return reuseOrBeginTransaction(db, async () => {
    // ① 幂等：已有映射则直接复用
    const readLink = compile(
      { kind: 'select', table: 'ag_developers', columns: ['user_id'], where: eq(col('id'), lit(input.developerId)), limit: 1 },
      PLATFORM,
      {},
    );
    const existing = await db.query<{ user_id: string | null }>(readLink.sql, readLink.params);
    const already = existing[0]?.user_id;
    if (typeof already === 'string' && already.length > 0) return already;

    // ② 建平台用户（`source='developer'` 便于区分来源）
    const userId = randomUUID();
    const insertUser = compile(
      {
        kind: 'insert',
        table: 'ag_users',
        rows: [
          {
            id: userId,
            email: input.email,
            email_verified: input.emailVerified,
            username: input.username,
            // ★ `ag_user_source` 枚举只有 `'local' | 'oidc'`——
            //   开发者是**通过 OIDC 登录**的（`platform:developer` 链路），因此用 `'oidc'`。
            //   ★ 我第一版写了 `'developer'`，真实 PG 立刻报
            //     `invalid input value for enum ag_user_source`（枚举必须先查迁移产物）。
            source: 'oidc',
            // ★ 开发者是**已验证**的主体（入驻要求强制邮箱绑定）
            status: input.emailVerified ? 'active' : 'pending',
            profile: JSON.stringify({ role: 'developer' }),
          },
        ],
        returning: ['id'],
        onConflict: { columns: ['id'], do: 'nothing' },
      },
      PLATFORM,
      {},
    );
    await db.query(insertUser.sql, insertUser.params);

    // ③ 回填 `ag_developers.user_id`
    const link = compile(
      {
        kind: 'update',
        table: 'ag_developers',
        set: { user_id: userId },
        where: and(eq(col('id'), lit(input.developerId)), or(isNull(col('user_id')), eq(col('user_id'), lit(userId)))),
        returning: ['id'],
      },
      PLATFORM,
      {},
    );
    const linked = await db.query<{ id: string }>(link.sql, link.params);
    if (linked.length === 0) {
      // 并发下另一事务已回填 → 读回它（保证返回的是**实际**映射）
      const reread = compile(
        { kind: 'select', table: 'ag_developers', columns: ['user_id'], where: eq(col('id'), lit(input.developerId)), limit: 1 },
        PLATFORM,
        {},
      );
      const rows = await db.query<{ user_id: string | null }>(reread.sql, reread.params);
      const actual = rows[0]?.user_id;
      if (typeof actual === 'string' && actual.length > 0) return actual;
      throw new Error(`为开发者 ${input.developerId} 建立平台用户映射失败（并发回填后仍读不到）`);
    }
    return userId;
  });
}
