/**
 * ★ P0-3：邀请码（`ag_invite_codes`）—— 此前**零读写**。
 *
 * ★ 本文件的核心断言是**原子性**：
 *   `maxUses` 是"限次"承诺，而"检查 + 递增"若不是原子的，并发核销就会**超发**
 *   （一个限 1 次的邀请码被用 5 次）。这里用**并发核销**直接验证它。
 * ★ 另一条：核销失败必须**区分原因**（不存在 / 过期 / 用尽）——
 *   用户看到"邀请码无效"却不知道该换一个还是找管理员，是真实的运维摩擦。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateInviteCode,
  InMemoryInviteCodeStore,
  type InviteCodeStore,
} from '../src/core/invite-codes.ts';
import { createDb } from '../src/db/pool.ts';
import { DbInviteCodeStore } from '../src/db/invite-code-adapter.ts';

const T0 = new Date('2026-09-26T00:00:00Z');
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

// ─────────────────────────── 生成 ───────────────────────────

test('生成邀请码：长度正确，且**不含易混字符**（会被人工抄写）', () => {
  const code = generateInviteCode(12);
  assert.equal(code.length, 12);
  assert.doesNotMatch(code, /[0O1IL]/, '★ 0/O/1/I/L 不该出现——抄错是真实的运维摩擦');
  assert.match(code, /^[A-Z2-9]+$/);
  // 两次生成不同（随机性冒烟）
  assert.notEqual(generateInviteCode(12), generateInviteCode(12));
});

// ─────────────────────────── 内存实现 ───────────────────────────

test('内存：create → 核销成功（usedCount +1，返回 grantsFacts）', async () => {
  const store = new InMemoryInviteCodeStore();
  await store.create({ code: 'BETA-1', maxUses: 2, grantsFacts: { cohort: 'beta' }, now: T0 });

  const first = await store.redeem({ code: 'BETA-1', now: T0 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.invite.usedCount, 1);
  assert.deepEqual(first.invite.grantsFacts, { cohort: 'beta' });

  const second = await store.redeem({ code: 'BETA-1', now: T0 });
  assert.equal(second.ok, true);
  const third = await store.redeem({ code: 'BETA-1', now: T0 });
  assert.equal(third.ok, false);
  assert.equal(third.ok === false ? third.reason : '', 'exhausted');
});

test('内存：三种失败原因各自可辨', async () => {
  const store = new InMemoryInviteCodeStore();
  await store.create({ code: 'EXPIRED', expiresAt: plus(T0, 1000), now: T0 });
  await store.create({ code: 'USED', maxUses: 1, now: T0 });
  await store.redeem({ code: 'USED', now: T0 });

  assert.equal((await store.redeem({ code: 'NOPE', now: T0 })).ok, false);
  assert.deepEqual(await store.redeem({ code: 'NOPE', now: T0 }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await store.redeem({ code: 'EXPIRED', now: plus(T0, 1000) }), {
    ok: false,
    reason: 'expired',
  });
  assert.deepEqual(await store.redeem({ code: 'USED', now: T0 }), { ok: false, reason: 'exhausted' });
  // 过期前仍可核销
  assert.equal((await store.redeem({ code: 'EXPIRED', now: plus(T0, 999) })).ok, true);
});

// ─────────────────────────── PG 实现 ───────────────────────────

const SITE = '11111111-1111-1111-1111-111111111111';
const OTHER_SITE = '22222222-2222-2222-2222-222222222222';

async function createTable(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
  await db.exec(`
    CREATE TABLE ag_invite_codes (
      site_id uuid NOT NULL,
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code varchar(64) NOT NULL,
      created_by uuid NULL,
      max_uses integer NOT NULL DEFAULT 1,
      used_count integer NOT NULL DEFAULT 0,
      grants_facts jsonb NOT NULL DEFAULT '{}',
      expires_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (site_id, code)
    );
  `);
}

async function withStore<T>(fn: (store: DbInviteCodeStore) => Promise<T>): Promise<T> {
  const db = await createDb();
  try {
    await createTable(db);
    return await fn(new DbInviteCodeStore(db, SITE));
  } finally {
    await db.close();
  }
}

test('★ PG：create → 核销成功 → usedCount 落库（`createdAt` 为 Date）', async () => {
  await withStore(async (store) => {
    const created = await store.create({
      code: 'PG-1',
      maxUses: 2,
      grantsFacts: { invited: true },
      now: T0,
    });
    assert.equal(created.usedCount, 0);
    assert.equal(created.createdAt instanceof Date, true);

    const redeemed = await store.redeem({ code: 'PG-1', now: T0 });
    assert.equal(redeemed.ok, true);
    if (!redeemed.ok) return;
    assert.equal(redeemed.invite.usedCount, 1);
    assert.deepEqual(redeemed.invite.grantsFacts, { invited: true });

    const listed = await store.list();
    assert.equal(listed[0]!.usedCount, 1, '★ 递增必须真的落库');
  });
});

test('★★ PG：**并发核销不超发**（限 3 次的邀请码，10 个并发请求恰好 3 次成功）', async () => {
  await withStore(async (store) => {
    await store.create({ code: 'RACE', maxUses: 3, now: T0 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.redeem({ code: 'RACE', now: T0 })),
    );
    const succeeded = results.filter((result) => result.ok).length;
    assert.equal(succeeded, 3, '★ 恰好 3 次——多一次就是超发，少一次就是漏发');

    const [row] = await store.list();
    assert.equal(row!.usedCount, 3, '★ usedCount 绝不能超过 maxUses');
    assert.ok(row!.usedCount <= row!.maxUses);
  });
});

test('★ PG：失败原因区分（not_found / expired / exhausted）', async () => {
  await withStore(async (store) => {
    await store.create({ code: 'EXP', expiresAt: plus(T0, 1000), now: T0 });
    await store.create({ code: 'FULL', maxUses: 1, now: T0 });
    await store.redeem({ code: 'FULL', now: T0 });

    assert.deepEqual(await store.redeem({ code: 'MISSING', now: T0 }), {
      ok: false,
      reason: 'not_found',
    });
    assert.deepEqual(await store.redeem({ code: 'EXP', now: plus(T0, 1000) }), {
      ok: false,
      reason: 'expired',
    });
    assert.deepEqual(await store.redeem({ code: 'FULL', now: T0 }), {
      ok: false,
      reason: 'exhausted',
    });
  });
});

test('★ PG：站点隔离（另一站点核销不到，也删不掉）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const siteA = new DbInviteCodeStore(db, SITE);
  const siteB = new DbInviteCodeStore(db, OTHER_SITE);
  const invite = await siteA.create({ code: 'SITE-A', now: T0 });

  assert.deepEqual(await siteB.redeem({ code: 'SITE-A', now: T0 }), {
    ok: false,
    reason: 'not_found',
  });
  assert.deepEqual(await siteB.list(), []);

  await siteB.remove(invite.id);
  assert.equal((await siteA.list()).length, 1, '★ 跨站点 remove 不该生效');
});

test('契约一致性：内存与 PG 对同一组输入给出**相同结论**（除 id 生成方式）', async () => {
  const memory: InviteCodeStore = new InMemoryInviteCodeStore();
  const outcomes: { memory: string[]; pg: string[] } = { memory: [], pg: [] };

  await memory.create({ code: 'X', maxUses: 1, now: T0 });
  outcomes.memory.push(String((await memory.redeem({ code: 'X', now: T0 })).ok));
  outcomes.memory.push(String((await memory.redeem({ code: 'X', now: T0 })).ok));
  outcomes.memory.push(String((await memory.redeem({ code: 'MISSING', now: T0 })).ok));

  await withStore(async (store) => {
    await store.create({ code: 'X', maxUses: 1, now: T0 });
    outcomes.pg.push(String((await store.redeem({ code: 'X', now: T0 })).ok));
    outcomes.pg.push(String((await store.redeem({ code: 'X', now: T0 })).ok));
    outcomes.pg.push(String((await store.redeem({ code: 'MISSING', now: T0 })).ok));
  });

  assert.deepEqual(outcomes.pg, outcomes.memory);
  assert.deepEqual(outcomes.memory, ['true', 'false', 'false']);
});
