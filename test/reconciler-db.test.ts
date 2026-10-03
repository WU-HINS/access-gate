/**
 * DB 侧主体存储的端到端验收：真实 pglite 上跑 complete 的「建表 → 对账 → 查询 → 标记删除」。
 *
 * ★ 为什么必须有这一组：内存实现绕过了 SQL——而 SQL 恰恰是最容易出错的地方
 *   （站点注入、ON CONFLICT 列序、NOT(OR(...)) 的括号、jsonb 往返、timestamptz 解析）。
 *   本文件用真实 PostgreSQL 语义验证这些，并同时验证**站点隔离**在对账链路上成立。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/pool.ts';
import { DbSubjectStore } from '../src/plugin/subjects.ts';
import { InMemorySyncStateStore, Reconciler } from '../src/core/reconciler.ts';
import { EventBus } from '../src/kernel/events.ts';
import type { ExternalSubject, ProviderCapabilities, ProviderPlugin, SubjectPage, SubjectSchema } from '../src/plugin/provider.ts';

const SITE_A = '11111111-1111-1111-1111-111111111111';
const SITE_B = '22222222-2222-2222-2222-222222222222';

const SCHEMA: SubjectSchema = {
  type: 'object',
  properties: { group: { type: 'string', watch: true }, request_count: { type: 'integer', watch: false } },
};

function subject(id: string, group: string, extra: Record<string, unknown> = {}): ExternalSubject {
  return {
    externalId: id,
    displayName: `u${id}`,
    email: `${id}@example.com`,
    attributes: { group, request_count: 0, ...extra },
  };
}

function providerWith(subjects: ExternalSubject[], capabilities: Partial<ProviderCapabilities> = {}) {
  let data = [...subjects];
  const provider: ProviderPlugin & { setSubjects(next: ExternalSubject[]): void } = {
    id: 'fakeprovider',
    subjectSchema: SCHEMA,
    capabilities: { list: true, findByIdentity: false, get: true, cursor: false, update: false, create: false, ...capabilities },
    setSubjects(next) {
      data = [...next];
    },
    async listSubjects(cursor: string | null, limit: number): Promise<SubjectPage> {
      const offset = cursor === null ? 0 : Number(cursor);
      const slice = data.slice(offset, offset + limit);
      const next = offset + limit;
      return { subjects: slice, nextCursor: next < data.length ? String(next) : null };
    },
    async getSubject(externalId) {
      return data.find((s) => s.externalId === externalId) ?? null;
    },
  };
  return provider;
}

/** 建出与 `docs/02` 一致的 ag_external_subjects（用真实 DDL 的最小等价形态）。 */
async function createSchema(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
  await db.exec(`
    -- PostgreSQL 18 原生 uuidv7()（与 02 §1 的 defaultSql('uuidv7()') 一致）；
    -- pglite 不含 pgcrypto 扩展，故不能用 gen_random_uuid()
    CREATE TABLE ag_external_subjects (
      site_id      uuid NOT NULL,
      id           uuid PRIMARY KEY DEFAULT uuidv7(),
      provider     varchar(64) NOT NULL,
      external_id  varchar(128) NOT NULL,
      display_name varchar(128) NULL,
      email        varchar(255) NULL,
      attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
      watched      jsonb NOT NULL DEFAULT '[]'::jsonb,
      fingerprint  varchar(64) NOT NULL,
      raw          jsonb NOT NULL DEFAULT '{}'::jsonb,
      synced_at    timestamptz NOT NULL DEFAULT now(),
      deleted_at   timestamptz NULL,
      CONSTRAINT uq_ag_external_subjects UNIQUE (site_id, provider, external_id)
    );
  `);
}

test('DB 主体存储：真实 pglite 上 upsert/查询/软删除，且站点隔离成立', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createSchema(db);

  const storeA = new DbSubjectStore(db, SITE_A);
  const storeB = new DbSubjectStore(db, SITE_B);

  // 首次 upsert → created
  const created = await db.transaction(async () =>
    storeA.upsert('fakeprovider', subject('1', 'basic'), ['group'], 'fp-1', new Date()),
  );
  assert.equal(created.created, true);

  // 同指纹再 upsert → unchanged（只更新 synced_at）
  const unchanged = await db.transaction(async () =>
    storeA.upsert('fakeprovider', subject('1', 'basic'), ['group'], 'fp-1', new Date()),
  );
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.changed, false);

  // 指纹变化 → changed
  const changed = await db.transaction(async () =>
    storeA.upsert('fakeprovider', subject('1', 'pro'), ['group'], 'fp-2', new Date()),
  );
  assert.equal(changed.changed, true);

  // 读回：jsonb / timestamptz 往返正确
  const loaded = await db.transaction(async () => storeA.get('fakeprovider', '1'));
  assert.equal(loaded!.displayName, 'u1');
  assert.equal(loaded!.attributes['group'], 'pro');
  assert.ok(loaded!.syncedAt instanceof Date);

  // ★ 站点隔离：B 站点看不到 A 的数据
  const fromB = await db.transaction(async () => storeB.get('fakeprovider', '1'));
  assert.equal(fromB, undefined, 'B 站点不得看到 A 的主体');
  assert.equal(await db.transaction(async () => storeB.count('fakeprovider')), 0);

  // 全表实际只有 1 行（隔离不是靠客户端过滤）
  const total = await db.transaction(async () => db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_external_subjects'));
  assert.equal(total[0]!.n, '1');

  // 软删除：listExternalIds 不再返回，但行仍在（deleted_at 有值）
  const marked = await db.transaction(async () => storeA.markDeleted('fakeprovider', [], new Date()));
  assert.deepEqual(marked, ['1'], 'markDeleted 必须返回被标记的 externalId（用于发事件）');
  assert.equal(await db.transaction(async () => storeA.count('fakeprovider')), 0);
  const rows = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_external_subjects WHERE deleted_at IS NOT NULL'),
  );
  assert.equal(rows[0]!.n, '1', '软删除不得物理删行');

  // 复活：再次 upsert 应清空 deleted_at
  const revived = await db.transaction(async () =>
    storeA.upsert('fakeprovider', subject('1', 'basic'), ['group'], 'fp-3', new Date()),
  );
  assert.equal(revived.revived, true);
  assert.equal(await db.transaction(async () => storeA.count('fakeprovider')), 1);
});

test('DB 对账端到端：真实 pglite 上全量对账 → 下游删主体 → 标记 deleted 并发事件', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createSchema(db);

  const store = new DbSubjectStore(db, SITE_A);
  const state = new InMemorySyncStateStore();
  const bus = new EventBus();
  const events: string[] = [];
  bus.on('subject.*', (event) => void events.push(`${event.type}:${(event.payload as { externalId: string }).externalId}`));

  const provider = providerWith([subject('1', 'basic'), subject('2', 'basic')]);
  // ★ 对账器自带事务边界：整轮包在一个事务里（半对账状态不可接受）
  const reconciler = new Reconciler({
    provider,
    subjects: store,
    state,
    bus,
    transactionRunner: (fn) => db.transaction(async () => fn()),
  });

  const first = await reconciler.reconcileFull();
  assert.equal(first.created, 2);
  assert.deepEqual(events, ['subject.created:1', 'subject.created:2']);

  events.length = 0;
  provider.setSubjects([subject('1', 'basic')]);
  const second = await reconciler.reconcileFull();
  assert.equal(second.markedDeleted, 1);
  assert.deepEqual(events, ['subject.deleted:2']);
});

test('DB 对账：全量对账会在同一站点内发 attributes_changed（watch 字段）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createSchema(db);

  const store = new DbSubjectStore(db, SITE_A);
  const state = new InMemorySyncStateStore();
  const bus = new EventBus();
  const events: { type: string; changedKeys?: string[] }[] = [];
  bus.on('subject.*', (event) =>
    void events.push({ type: event.type, changedKeys: (event.payload as { changedKeys?: string[] }).changedKeys }),
  );

  const provider = providerWith([subject('1', 'basic')]);
  const reconciler = new Reconciler({
    provider,
    subjects: store,
    state,
    bus,
    transactionRunner: (fn) => db.transaction(async () => fn()),
  });
  await reconciler.reconcileFull();
  events.length = 0;

  provider.setSubjects([subject('1', 'vip')]);
  const outcome = await reconciler.reconcileFull();
  assert.equal(outcome.changed, 1);
  assert.deepEqual(events, [{ type: 'subject.attributes_changed', changedKeys: ['group'] }]);
});
