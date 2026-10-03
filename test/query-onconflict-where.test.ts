/**
 * ★★ L-5：`onConflict` 支持**部分唯一索引的谓词**（`ON CONFLICT (cols) WHERE <谓词>`）。
 *
 * ★ 为什么需要它（这条能力修的是一个**静默失效**的形态）：
 *   `ag_plugin_instances` 的唯一键建在**可空列**（`developer_id` / `site_id`）上，
 *   而 PG 把 NULL 视为**互不相同** → 唯一约束**静默失效**（可插入任意多组重复逻辑键）。
 *   ★ 正确修法是加部分唯一索引（`where developer_id IS NOT NULL`）——
 *     但那样 `ON CONFLICT (developer_id)` 会报 **42P10**，除非谓词一起给出。
 *
 * ★ 本文件用**对照组**直接证明这一点：同样的 SQL，不带谓词时报 42P10，带上就命中。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compile } from '../src/query/compile.ts';
import { createDb } from '../src/db/pool.ts';
import type { Query } from '../src/query/ast.ts';

const OWNER = '11111111-1111-1111-1111-111111111111';
const META = { siteScoped: false } as never;

function insertQuery(where?: string): Query {
  return {
    kind: 'insert',
    table: 't',
    rows: [{ owner_id: OWNER, key: 'k' }],
    onConflict: {
      columns: ['owner_id', 'key'],
      do: 'update',
      updateColumns: ['key'],
      ...(where === undefined ? {} : { where }),
    },
    returning: ['id'],
  } as never;
}

// ─────────────────────── 编译层 ───────────────────────

test('★ 带谓词 → 编译为 `ON CONFLICT (…) WHERE … DO UPDATE`', () => {
  const compiled = compile(insertQuery('owner_id IS NOT NULL'), META);
  assert.match(compiled.sql, /ON CONFLICT \(owner_id, key\) WHERE owner_id IS NOT NULL DO UPDATE SET/);
});

test('★ 不带谓词 → **行为完全不变**（向后兼容）', () => {
  const compiled = compile(insertQuery(), META);
  assert.match(compiled.sql, /ON CONFLICT \(owner_id, key\) DO UPDATE SET/);
  assert.doesNotMatch(compiled.sql, /ON CONFLICT \([^)]*\) WHERE/);
});

test('`do: nothing` 也支持谓词', () => {
  const query = insertQuery('owner_id IS NOT NULL');
  const compiled = compile(
    { ...(query as object), onConflict: { ...(query as never as { onConflict: object }).onConflict, do: 'nothing' } } as never,
    META,
  );
  assert.match(compiled.sql, /ON CONFLICT \(owner_id, key\) WHERE owner_id IS NOT NULL DO NOTHING/);
});

// ─────────────────────── 真实 PG ───────────────────────

async function setup(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
  await db.exec(`
    CREATE TABLE t (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id uuid NULL,
      key text NOT NULL
    );
    CREATE UNIQUE INDEX uq_t_owner_key ON t (owner_id, key) WHERE owner_id IS NOT NULL;
  `);
}

async function run(db: Awaited<ReturnType<typeof createDb>>, query: Query): Promise<void> {
  const compiled = compile(query, META);
  await db.transaction(async () => db.query(compiled.sql, compiled.params));
}

test('★★ 部分唯一索引 + 谓词 → `ON CONFLICT` **真正命中**（第二次是同一条，不产生重复行）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await setup(db);

  await run(db, insertQuery('owner_id IS NOT NULL'));
  await run(db, insertQuery('owner_id IS NOT NULL'));

  const rows = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM t'),
  );
  assert.equal(rows[0]!.n, '1', '★ 第二次必须命中冲突目标（更新），而不是插入第二行');
});

test('★★★ 对照组：**不带**谓词时 PG 报 42P10——证明这条能力是必需的', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await setup(db);

  await assert.rejects(
    () => run(db, insertQuery()),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // PG 的原文：there is no unique or exclusion constraint matching the ON CONFLICT specification
      assert.match(message, /42P10|no unique or exclusion constraint/i);
      return true;
    },
    '★ 这正是"加了部分索引但没加谓词"会踩的坑（本会话 Round 1 就踩过）',
  );
});

test('★ 谓词写错（与实际索引不符）同样报错——不会静默走"无冲突"分支', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await setup(db);
  await assert.rejects(() => run(db, insertQuery('owner_id IS NULL')), /42P10|no unique or exclusion constraint/i);
});
