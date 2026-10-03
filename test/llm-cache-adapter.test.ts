/**
 * LLM 结果缓存的 PG 存储（`docs/03 §1.10`）。
 *
 * ★ 本文件要证明的三件事：
 *   ① **过期即未命中，且不依赖清理任务**——否则"清理任务没跑 → 一直命中旧结果"
 *      会变成一类静默的成本/正确性问题（与告警静默同一条纪律）；
 *   ② 作用域隔离（`ownerScope` / `ownerId`）成立；
 *   ③ **换模型得到不同的 `inputHash` → 两行共存**——这条同时澄清了
 *      「唯一键为何不含 `model` 列」（模型已参与哈希，见适配器文件头）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createDb } from '../src/db/pool.ts';
import { DbLlmCacheStore, type LlmCacheEntry } from '../src/db/llm-cache-adapter.ts';

const T0 = new Date('2026-09-26T00:00:00Z');
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** 与 `llm-gateway.#cacheKey()` 同一口径：`sha256(model + messages + temperature)` */
function inputHashOf(model: string, messages: string, temperature = 0): string {
  return createHash('sha256')
    .update(JSON.stringify({ model, messages, temperature }))
    .digest('hex');
}

function entry(over: Partial<LlmCacheEntry> = {}): LlmCacheEntry {
  return {
    ownerScope: 'platform',
    ownerId: 'platform',
    inputHash: inputHashOf('gpt-4o-mini', '评审这个 PR'),
    model: 'gpt-4o-mini',
    promptVer: 'v3',
    pluginId: 'llm-review',
    result: { pr_score: 72 },
    promptTokens: 1200,
    completionTokens: 40,
    expiresAt: plus(T0, 7 * 24 * 3_600_000),
    createdAt: T0,
    ...over,
  };
}

async function createTable(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
  await db.exec(`
    CREATE TABLE ag_llm_cache (
      owner_scope varchar(16) NOT NULL,
      owner_id varchar(64) NOT NULL,
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      input_hash varchar(64) NOT NULL,
      model varchar(128) NOT NULL,
      prompt_ver varchar(32) NOT NULL,
      plugin_id varchar(64) NULL,
      result jsonb NOT NULL,
      prompt_tokens integer NOT NULL DEFAULT 0,
      completion_tokens integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NULL,
      UNIQUE (owner_scope, owner_id, input_hash)
    );
    CREATE INDEX ix_ag_llm_cache_expiry ON ag_llm_cache (expires_at);
  `);
}

test('put → get 命中，且 token 计数与结果都被带回（成本可核算）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbLlmCacheStore(db);
  const record = entry();
  await store.put(record);

  const hit = await store.get({
    ownerScope: 'platform',
    ownerId: 'platform',
    inputHash: record.inputHash,
    now: plus(T0, 1000),
  });
  assert.ok(hit !== undefined);
  assert.deepEqual(hit.result, { pr_score: 72 });
  assert.equal(hit.promptTokens, 1200);
  assert.equal(hit.completionTokens, 40);
  assert.equal(hit.pluginId, 'llm-review');
});

test('★ 过期即未命中——**不依赖清理任务**（未调用 purgeExpired）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbLlmCacheStore(db);
  const record = entry({ expiresAt: plus(T0, 60_000) });
  await store.put(record);

  // 到期前 1ms：命中
  assert.ok(
    (await store.get({ ownerScope: 'platform', ownerId: 'platform', inputHash: record.inputHash, now: plus(T0, 59_999) })) !==
      undefined,
  );
  // ★ 到期瞬间：未命中（**没有跑任何清理**）
  assert.equal(
    await store.get({ ownerScope: 'platform', ownerId: 'platform', inputHash: record.inputHash, now: plus(T0, 60_000) }),
    undefined,
  );
  // 而那行**还在库里**（清理只是回收，不是正确性）
  assert.equal(await store.purgeExpired(plus(T0, 60_000)), 1);
});

test('expiresAt = null → 永不过期（显式表达"这条结果不会变"）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbLlmCacheStore(db);
  const record = entry({ expiresAt: null });
  await store.put(record);
  assert.ok(
    (await store.get({
      ownerScope: 'platform',
      ownerId: 'platform',
      inputHash: record.inputHash,
      now: plus(T0, 365 * 24 * 3_600_000),
    })) !== undefined,
  );
});

test('★ 作用域隔离：不同 owner 不互相命中', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbLlmCacheStore(db);
  const record = entry({ ownerScope: 'site', ownerId: 'site-a' });
  await store.put(record);

  assert.ok(
    (await store.get({ ownerScope: 'site', ownerId: 'site-a', inputHash: record.inputHash, now: T0 })) !== undefined,
  );
  assert.equal(
    await store.get({ ownerScope: 'site', ownerId: 'site-b', inputHash: record.inputHash, now: T0 }),
    undefined,
    '★ 站点 B 不得命中站点 A 的缓存',
  );
  assert.equal(
    await store.get({ ownerScope: 'platform', ownerId: 'platform', inputHash: record.inputHash, now: T0 }),
    undefined,
  );
});

test('★ 换模型 → 不同 inputHash → **两行共存**（唯一键不含 model 是刻意的）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbLlmCacheStore(db);
  const withMini = entry({ model: 'gpt-4o-mini', inputHash: inputHashOf('gpt-4o-mini', '评审这个 PR') });
  const withBig = entry({ model: 'gpt-4o', inputHash: inputHashOf('gpt-4o', '评审这个 PR') });
  await store.put(withMini);
  await store.put(withBig);

  const a = await store.get({ ownerScope: 'platform', ownerId: 'platform', inputHash: withMini.inputHash, now: T0 });
  const b = await store.get({ ownerScope: 'platform', ownerId: 'platform', inputHash: withBig.inputHash, now: T0 });
  assert.equal(a?.model, 'gpt-4o-mini');
  assert.equal(b?.model, 'gpt-4o');
  assert.notEqual(a?.inputHash, b?.inputHash, '模型参与哈希 → 换模型必然换键');
});

test('幂等：同 (ownerScope, ownerId, inputHash) 重复 put → 覆盖，不堆多行', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbLlmCacheStore(db);
  const record = entry();
  await store.put(record);
  await store.put({ ...record, result: { pr_score: 90 }, promptVer: 'v4' });

  const hit = await store.get({
    ownerScope: 'platform',
    ownerId: 'platform',
    inputHash: record.inputHash,
    now: plus(T0, 1000),
  });
  assert.deepEqual(hit?.result, { pr_score: 90 }, '重新计算的结果应更新缓存');
  assert.equal(hit?.promptVer, 'v4');
  const all = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_llm_cache'),
  );
  assert.equal(all[0]!.n, '1');
});

test('purgeExpired：只删已过期的，返回删除条数', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbLlmCacheStore(db);
  await store.put(entry({ inputHash: inputHashOf('m', 'a'), expiresAt: plus(T0, -1) }));
  await store.put(entry({ inputHash: inputHashOf('m', 'b'), expiresAt: plus(T0, 1000) }));
  await store.put(entry({ inputHash: inputHashOf('m', 'c'), expiresAt: null }));

  assert.equal(await store.purgeExpired(T0), 1);
  const remaining = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_llm_cache'),
  );
  assert.equal(remaining[0]!.n, '2', '未过期与永不过期的都要留下');
});

test('★ 运行时兜底：事务外直接查询会被拒（CI 第 8 项白名单的依据）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  await assert.rejects(
    async () => db.query('SELECT input_hash FROM ag_llm_cache'),
    /事务外执行/,
  );

  const store = new DbLlmCacheStore(db);
  await store.put(entry());
  assert.equal((await store.purgeExpired(T0)), 0);
});
