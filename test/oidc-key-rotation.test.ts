/**
 * OIDC 签名密钥轮换（`docs/05 §8.4.1`）—— 判定表 + **顺序的必要性**。
 *
 * ★ 本文件最重要的两条：
 *   ① 纯函数判定表（无 active 必须立刻补、standby 未过等待期只能等、retiring 到期才移出）；
 *   ② **真实 PG 上证明「先升后降必撞唯一索引」** —— 文档点名的第一种错法。
 *      这不是"注释里说说"：把顺序写反，测试必须失败。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/pool.ts';
import {
  applyRotationStep,
  InMemoryOidcSigningKeyStore,
  needsNewStandby,
  nextRotationStep,
  type RotationOptions,
  type SigningKeyRecord,
} from '../src/core/oidc-key-rotation.ts';

const OPTIONS: RotationOptions = {
  activeAlg: 'ES256',
  jwksCacheTtlMs: 5 * 60_000, // 等待窗口 = TTL × 6 = 30 分钟
  retireAfterMs: 24 * 3_600_000,
};

const T0 = new Date('2026-09-26T00:00:00Z');
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

function key(over: Partial<SigningKeyRecord> & { kid: string }): SigningKeyRecord {
  return {
    alg: 'ES256',
    status: 'active',
    activatedAt: T0,
    retiredFromSigningAt: null,
    removeAfter: null,
    createdAt: T0,
    ...over,
  };
}

// ─────────────────────────── ① 判定表 ───────────────────────────

test('无 active 也无 standby → 必须先发布 standby（不能直接签发）', () => {
  const step = nextRotationStep({ keys: [], options: OPTIONS, now: T0 });
  assert.equal(step.action, 'publish_standby');
});

test('★ 零 active 但有 standby → 立刻启用它（兜底：即使库被改坏也不许停在无 active）', () => {
  const step = nextRotationStep({
    keys: [key({ kid: 'es256-2', status: 'standby' })],
    options: OPTIONS,
    now: T0,
  });
  assert.equal(step.action, 'activate');
  assert.equal(step.action === 'activate' && step.activeKid, 'es256-2');
  assert.equal(step.action === 'activate' && step.retiringKid, null);
});

test('★ standby 未过等待期（TTL × 6）→ 只能 wait（先发布、后使用）', () => {
  const step = nextRotationStep({
    keys: [key({ kid: 'es256-1' }), key({ kid: 'es256-2', status: 'standby', createdAt: T0 })],
    options: OPTIONS,
    now: plus(T0, 29 * 60_000), // 差 1 分钟
  });
  assert.equal(step.action, 'wait');
  assert.equal(step.action === 'wait' && step.until.toISOString(), plus(T0, 30 * 60_000).toISOString());
});

test('standby 已过等待期 → activate，并指定旧的为 retiring', () => {
  const step = nextRotationStep({
    keys: [key({ kid: 'es256-1' }), key({ kid: 'es256-2', status: 'standby', createdAt: T0 })],
    options: OPTIONS,
    now: plus(T0, 31 * 60_000),
  });
  assert.equal(step.action, 'activate');
  assert.equal(step.action === 'activate' && step.activeKid, 'es256-2');
  assert.equal(step.action === 'activate' && step.retiringKid, 'es256-1');
});

test('retiring 超过保留期 → retire（移出 JWKS）', () => {
  const step = nextRotationStep({
    keys: [
      key({ kid: 'es256-2' }),
      key({
        kid: 'es256-1',
        status: 'retiring',
        removeAfter: plus(T0, 24 * 3_600_000),
      }),
    ],
    options: OPTIONS,
    now: plus(T0, 25 * 3_600_000),
  });
  assert.equal(step.action, 'retire');
  assert.equal(step.action === 'retire' && step.kid, 'es256-1');
});

test('其他算法（RS256）的密钥不干扰当前 activeAlg 的判定', () => {
  const step = nextRotationStep({
    keys: [
      key({ kid: 'es256-1' }),
      key({ kid: 'rsa-1', alg: 'RS256', status: 'active' }),
      key({ kid: 'rsa-2', alg: 'RS256', status: 'standby', createdAt: T0 }),
    ],
    options: OPTIONS,
    now: plus(T0, 60 * 60_000),
  });
  assert.equal(step.action, 'none', 'RS256 的 standby 不该触发 ES256 的切换');
});

test('needsNewStandby：到期且无在途 standby → true；已有 standby → false', () => {
  const rotateEveryMs = 90 * 24 * 3_600_000;
  assert.equal(
    needsNewStandby({
      keys: [key({ kid: 'es256-1', activatedAt: plus(T0, -100 * 24 * 3_600_000) })],
      options: { ...OPTIONS, rotateEveryMs },
      now: T0,
    }),
    true,
  );
  assert.equal(
    needsNewStandby({
      keys: [
        key({ kid: 'es256-1', activatedAt: plus(T0, -100 * 24 * 3_600_000) }),
        key({ kid: 'es256-2', status: 'standby' }),
      ],
      options: { ...OPTIONS, rotateEveryMs },
      now: T0,
    }),
    false,
    '已有 standby 在途时不再生成（否则会堆出一串 standby）',
  );
  assert.equal(
    needsNewStandby({ keys: [key({ kid: 'es256-1' })], options: OPTIONS, now: T0 }),
    false,
    '未配置 rotateEvery 时不自动发起',
  );
});

// ─────────────────────────── ② 执行（内存 store） ───────────────────────────

test('执行 publish → wait → activate → retire 的完整序列（内存 store）', async () => {
  const store = new InMemoryOidcSigningKeyStore();
  let now = T0;

  // 首次发布
  const first = nextRotationStep({ keys: await store.list(), options: OPTIONS, now });
  assert.equal(first.action, 'publish_standby');
  const published = await applyRotationStep({ store, step: first, now, retireAfterMs: OPTIONS.retireAfterMs });
  assert.equal(published.applied, true);

  // ★ 刚发布的密钥**不签发**：此时仍无 active → 下一步是把它启起来（这是冷启动路径）
  const second = nextRotationStep({ keys: await store.list(), options: OPTIONS, now });
  assert.equal(second.action, 'activate');

  // 走完冷启动：先把第一个启为 active
  await applyRotationStep({ store, step: second, now, retireAfterMs: OPTIONS.retireAfterMs });
  assert.equal((await store.list()).filter((k) => k.status === 'active').length, 1);

  // 到了轮换周期 → 发布第二个 standby
  now = plus(T0, 91 * 24 * 3_600_000);
  const third = nextRotationStep({
    keys: await store.list(),
    options: { ...OPTIONS, rotateEveryMs: 90 * 24 * 3_600_000 },
    now,
  });
  assert.equal(third.action, 'none', 'nextRotationStep 只答「已生成的走到哪一步」，发起由 needsNewStandby 决定');
  assert.equal(
    needsNewStandby({ keys: await store.list(), options: { ...OPTIONS, rotateEveryMs: 90 * 24 * 3_600_000 }, now }),
    true,
  );
  await applyRotationStep({
    store,
    step: { action: 'publish_standby', alg: 'ES256', reason: '周期到期' },
    now,
    retireAfterMs: OPTIONS.retireAfterMs,
  });

  // 等待期内只能等
  const waiting = nextRotationStep({ keys: await store.list(), options: OPTIONS, now: plus(now, 10 * 60_000) });
  assert.equal(waiting.action, 'wait');
  assert.equal(
    (await applyRotationStep({ store, step: waiting, now: plus(now, 10 * 60_000), retireAfterMs: OPTIONS.retireAfterMs }))
      .applied,
    false,
  );

  // 等待期满 → 切换；恰好一个 active，旧的是 retiring 且带 removeAfter
  const at = plus(now, 31 * 60_000);
  const activating = nextRotationStep({ keys: await store.list(), options: OPTIONS, now: at });
  assert.equal(activating.action, 'activate');
  await applyRotationStep({ store, step: activating, now: at, retireAfterMs: OPTIONS.retireAfterMs });

  const keys = await store.list();
  assert.equal(keys.filter((k) => k.status === 'active').length, 1, '★ 任何时刻恰好一个 active');
  const retiring = keys.find((k) => k.status === 'retiring');
  assert.ok(retiring !== undefined);
  assert.equal(retiring.removeAfter?.toISOString(), plus(at, OPTIONS.retireAfterMs).toISOString());

  // 保留期满 → retire
  const later = plus(at, OPTIONS.retireAfterMs + 1000);
  const retiring2 = nextRotationStep({ keys: await store.list(), options: OPTIONS, now: later });
  assert.equal(retiring2.action, 'retire');
  await applyRotationStep({ store, step: retiring2, now: later, retireAfterMs: OPTIONS.retireAfterMs });
  assert.equal((await store.list()).filter((k) => k.status === 'retired').length, 1);
});

// ─────────────────────────── ③ 顺序的必要性（真实 PG） ───────────────────────────

test('★ 真实 pglite：**先升后降必然撞唯一索引**（文档点名的第一种错法）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  // 与 `docs/02 §7.4` 一致的两个**部分唯一索引**（每种算法至多一个 active / 一个 standby）
  await db.exec(`
    CREATE TABLE ag_oidc_signing_keys (
      kid varchar(64) PRIMARY KEY,
      alg varchar(16) NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'standby',
      activated_at timestamptz NULL,
      retired_from_signing_at timestamptz NULL,
      remove_after timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_ag_oidc_keys_active_alg ON ag_oidc_signing_keys (alg) WHERE status = 'active';
    CREATE UNIQUE INDEX uq_ag_oidc_keys_standby_alg ON ag_oidc_signing_keys (alg) WHERE status = 'standby';
    INSERT INTO ag_oidc_signing_keys (kid, alg, status) VALUES ('es256-old', 'ES256', 'active');
    INSERT INTO ag_oidc_signing_keys (kid, alg, status) VALUES ('es256-new', 'ES256', 'standby');
  `);

  // ★ 错法一：先升后降 → 两个 active 同时存在 → 撞 uq_ag_oidc_keys_active_alg
  await assert.rejects(
    async () =>
      db.transaction(async () => {
        await db.query("UPDATE ag_oidc_signing_keys SET status = 'active' WHERE kid = 'es256-new'");
        await db.query("UPDATE ag_oidc_signing_keys SET status = 'retiring' WHERE kid = 'es256-old'");
      }),
    (error: unknown) => {
      assert.match(String((error as Error).message), /duplicate key|unique|唯一/i);
      return true;
    },
    '先升后降必须失败——这正是「顺序不可换」的经验证据',
  );

  // ★ 正确顺序：先降后升，同一个事务
  await db.transaction(async () => {
    await db.query("UPDATE ag_oidc_signing_keys SET status = 'retiring' WHERE kid = 'es256-old'");
    await db.query("UPDATE ag_oidc_signing_keys SET status = 'active' WHERE kid = 'es256-new'");
  });
  const actives = await db.transaction(async () =>
    db.query<{ kid: string }>("SELECT kid FROM ag_oidc_signing_keys WHERE status = 'active'"),
  );
  assert.deepEqual(actives.map((r) => r.kid), ['es256-new'], '★ 任何时刻恰好一个 active');

  // ★ 另一种错法：拆成两个事务 —— 中间存在「零 active」窗口
  //   （这里不断言失败，而是**量化**那个窗口确实存在：事务之间 active 数为 0 或 2）
  await db.transaction(async () => {
    await db.query("UPDATE ag_oidc_signing_keys SET status = 'standby' WHERE kid = 'es256-new'");
  });
  const between = await db.transaction(async () =>
    db.query<{ n: string }>("SELECT count(*)::text AS n FROM ag_oidc_signing_keys WHERE status = 'active'"),
  );
  assert.equal(between[0]!.n, '0', '★ 拆语句就会真的出现「零 active」——这就是全站登录中断的成因');
});
