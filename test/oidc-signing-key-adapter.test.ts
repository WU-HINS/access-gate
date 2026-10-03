/**
 * OIDC 签名密钥的 PG 存储（`docs/02 §7.4` / `docs/05 §8.4`）。
 *
 * ★ 本文件要证明的三件事：
 *   ① **签名/验签往返成立**——私钥经 AES-256-GCM 落库、解密后仍可用于签名
 *      （这是"密钥持久化"唯一有意义的验收：能签、能被验）；
 *   ② **重启后是同一把密钥**（新建 store 实例加载 → 同一 `kid`）——
 *      直接反驳修复前「重启即换密钥、旧 token 全部验不过」的形态；
 *   ③ 轮换切换**恰好一个 active**，且旧的转 `retiring`（仍发布，供旧 token 验签）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, jwtVerify } from 'jose';

import { createDb } from '../src/db/pool.ts';
import { DbOidcSigningKeyStore } from '../src/db/oidc-signing-key-adapter.ts';

const MASTER_KEY = Buffer.alloc(32, 7);
const T0 = new Date('2026-09-26T00:00:00Z');
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** 与 `docs/02 §7.4` 一致的最小 DDL（含两个**部分唯一索引**） */
async function createTable(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
  await db.exec(`
    CREATE TABLE ag_oidc_signing_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kid varchar(64) NOT NULL,
      kty varchar(16) NOT NULL,
      alg varchar(16) NOT NULL,
      crv varchar(16) NULL,
      public_jwk jsonb NOT NULL,
      private_ciphertext text NOT NULL,
      private_iv varchar(32) NOT NULL,
      private_auth_tag varchar(32) NOT NULL,
      master_key_version integer NOT NULL DEFAULT 1,
      status varchar(16) NOT NULL DEFAULT 'standby',
      activated_at timestamptz NULL,
      retired_from_signing_at timestamptz NULL,
      remove_after timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (kid)
    );
    CREATE UNIQUE INDEX uq_ag_oidc_keys_active_alg ON ag_oidc_signing_keys (alg) WHERE status = 'active';
    CREATE UNIQUE INDEX uq_ag_oidc_keys_standby_alg ON ag_oidc_signing_keys (alg) WHERE status = 'standby';
  `);
}

test('★ 签名/验签往返：私钥加密落库 → 解密加载 → 仍可签名且能被验签', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbOidcSigningKeyStore(db, MASTER_KEY);
  const created = await store.createStandby({ alg: 'ES256', now: T0 });
  assert.equal(created.status, 'standby');
  assert.match(created.kid, /^es256-/);

  // 发布后启用（冷启动路径：retiringKid = null）
  await store.activateAtomically({
    retiringKid: null,
    activeKid: created.kid,
    now: T0,
    removeAfter: plus(T0, 24 * 3_600_000),
  });

  const set = await store.loadSigningKeySet();
  const active = set.requireActive();
  assert.equal(active.kid, created.kid);

  // ★ 真正的验收：签一个 JWT 并验签
  const token = await new SignJWT({ sub: 'user-1' })
    .setProtectedHeader({ alg: 'ES256', kid: active.kid })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(active.privateKey);
  const { payload } = await jwtVerify(token, active.publicKey);
  assert.equal(payload['sub'], 'user-1');
});

test('★ 重启后仍是同一把密钥（新建 store 实例加载 → 同一 kid）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const first = new DbOidcSigningKeyStore(db, MASTER_KEY);
  const created = await first.createStandby({ alg: 'ES256', now: T0 });
  await first.activateAtomically({
    retiringKid: null,
    activeKid: created.kid,
    now: T0,
    removeAfter: plus(T0, 24 * 3_600_000),
  });

  // ★ 模拟进程重启：**新的 store 实例**（内存里什么都没有）
  const afterRestart = new DbOidcSigningKeyStore(db, MASTER_KEY);
  const set = await afterRestart.loadSigningKeySet();
  assert.equal(
    set.requireActive().kid,
    created.kid,
    '★ 重启必须加载到**同一把**密钥——这正是「重启即换密钥」缺陷的修复证据',
  );
});

test('★ 轮换：同事务先降后升 → 恰好一个 active，旧的转 retiring（仍在发布集合里）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbOidcSigningKeyStore(db, MASTER_KEY);
  const oldKey = await store.createStandby({ alg: 'ES256', now: T0 });
  await store.activateAtomically({
    retiringKid: null,
    activeKid: oldKey.kid,
    now: T0,
    removeAfter: plus(T0, 24 * 3_600_000),
  });

  const at = plus(T0, 31 * 60_000);
  const newKey = await store.createStandby({ alg: 'ES256', now: at });
  await store.activateAtomically({
    retiringKid: oldKey.kid,
    activeKid: newKey.kid,
    now: at,
    removeAfter: plus(at, 24 * 3_600_000),
  });

  const records = await store.list();
  assert.equal(records.filter((r) => r.status === 'active').length, 1, '★ 恰好一个 active');
  assert.equal(records.find((r) => r.kid === newKey.kid)?.status, 'active');
  const retired = records.find((r) => r.kid === oldKey.kid);
  assert.equal(retired?.status, 'retiring');
  assert.equal(retired?.removeAfter?.toISOString(), plus(at, 24 * 3_600_000).toISOString());

  // ★ retiring 仍要加载进「可发布集合」——旧 token 靠它验签
  const set = await store.loadSigningKeySet();
  assert.equal(set.publishable().length, 2, 'active + retiring 都要发布');
  assert.equal(set.requireActive().kid, newKey.kid);
});

test('retire：移出发布集合（status=retired 后不再加载）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbOidcSigningKeyStore(db, MASTER_KEY);
  const key = await store.createStandby({ alg: 'ES256', now: T0 });
  await store.retire({ kid: key.kid, now: plus(T0, 1000) });

  assert.equal((await store.list())[0]?.status, 'retired');
  assert.equal((await store.loadSigningKeySet()).publishable().length, 0);
});

test('★ 错误的 masterKey 解密失败（GCM 认证标签不匹配 → 抛错，而不是静默给出坏密钥）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbOidcSigningKeyStore(db, MASTER_KEY);
  await store.createStandby({ alg: 'ES256', now: T0 });

  const wrongKey = new DbOidcSigningKeyStore(db, Buffer.alloc(32, 9));
  await assert.rejects(() => wrongKey.loadSigningKeySet(), /unable to authenticate|bad decrypt|认证/i);
});

test('★ 运行时兜底：事务外直接查询会被拒（CI 第 8 项白名单的依据）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  // 本适配器被加入 `ci-gate` 第 8 项的仓储层白名单，理由正是「运行时由查询层的
  // `assertInTransaction` 兜底」。这条测试把那个**理由**变成**可执行的事实**：
  // 绕开 `reuseOrBeginTransaction` 包装 → 必须抛错。
  await assert.rejects(
    async () => db.query('SELECT kid FROM ag_oidc_signing_keys'),
    /事务外执行/,
  );

  // 而经 store 包装的调用（内部 reuseOrBeginTransaction）正常
  const store = new DbOidcSigningKeyStore(db, MASTER_KEY);
  await store.createStandby({ alg: 'ES256', now: T0 });
  assert.equal((await store.list()).length, 1);
});
