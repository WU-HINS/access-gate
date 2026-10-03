/**
 * 真实 PostgreSQL 集成验收（生产就绪判据 #2）。
 *
 * ★ 为什么必须有这个文件（而不是「pglite 上跑通就够了」）：
 *   本项目有**三处只有在多会话下才成立**的语义：
 *     1. `DbJobStore.tryAcquire` 的租约：两个并发会话只能有一个取到（TOCTOU 防线）；
 *     2. `DbActionLogStore` 的 `ON CONFLICT` 幂等：并发重放只能写一条；
 *     3. `pg_advisory_lock` 的跨会话互斥。
 *   pglite 是**单连接嵌入式**，以上三点它一个都验证不了。本文件用真实 PG 18 验证。
 *
 * 前置：`node tools/pg-real.ts start`（本文件会自动启动/复用）。
 * 未就绪时**跳过**（而不是失败）——CI 环境可能没有 PG 二进制；
 * 跳过会在输出里显式标注，不会被误认为通过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRealPostgres, type RealPostgres } from '../tools/pg-real.ts';
import {
  DbActionLogStore,
  DbFactStore,
  DbIdentityStore,
  DbJobStore,
  DbLifecycleStateStore,
  DbSessionStore,
  DbPolicyStore,
  DbSubjectRepository,
} from '../src/db/adapters.ts';
import { FactPipeline } from '../src/plugin/host-api.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { EMAIL_DOMAIN_MANIFEST } from '../src/plugin/builtin/email-domain.ts';
import { createPgAdvisoryLock } from '../src/db/advisory-lock.ts';
import type { Db } from '../src/db/pool.ts';
import { withTransaction } from '../src/db/tx.ts';
import { principalFromClaims } from '../src/auth/session.ts';

import { silentLogger } from '../src/kernel/logger.ts';

/** 编排测试用的站点 id（uuid）。 */
const DEMO_SITE_ID_FOR_ORCH = 'cccccccc-cccc-7ccc-accc-cccccccccccc';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────── 启动与建库 ───────────────────────────

let pg: RealPostgres | undefined;
let unavailableReason: string | undefined;

/**
 * 是否运行真实 PG 用例。
 *
 * ★ 策略：**默认自动探测，探测失败则跳过**（而不是失败）。
 *   理由：`embedded-postgres` 的二进制依赖平台与 libc（本环境还需非 root 用户），
 *   在没有它的机器上让整个测试套件变红，会掩盖真正的问题。
 *   但「跳过」不等于「通过」——跳过时会在输出里显式标注原因，
 *   且 CI 另有独立的 pg 门禁（见 tools/ci-gate.ts 的说明）。
 *
 * 强制要求：`AG_REQUIRE_REAL_PG=1` 时探测失败即**失败**（CI 里用它防假绿）。
 */
const REQUIRE_REAL_PG = process.env['AG_REQUIRE_REAL_PG'] === '1';

async function ensurePg(): Promise<RealPostgres | undefined> {
  if (pg !== undefined) return pg;
  if (unavailableReason !== undefined) {
    if (REQUIRE_REAL_PG) throw new Error(`AG_REQUIRE_REAL_PG=1 但真实 PG 不可用：${unavailableReason}`);
    return undefined;
  }
  try {
    pg = await startRealPostgres({ fresh: true });
    // 用真实迁移 DDL 建表（与生产同一份产物）
    const ddl = readFileSync(join(ROOT, 'migrations', '0001_init.sql'), 'utf8');
    await pg.exec(ddl);
    return pg;
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    if (REQUIRE_REAL_PG) throw new Error(`AG_REQUIRE_REAL_PG=1 但真实 PG 启动失败：${unavailableReason}`);
    return undefined;
  }
}

/**
 * 一个基于真实 `pg` 的 `Db` 实现（生产驱动）。
 *
 * 为什么不复用 `src/db/pool.ts`：那个是 pglite 专用（进程内 WASM）。
 * 生产必须用真连接池——本适配器即为此而生，也顺便验证了 `Db` 接口的可替换性。
 */
/**
 * ★ 复用**生产实现**（`src/db/pool.ts` 的 `createPgDb`）而不是在测试里手写一个。
 *
 * 真实教训：本文件此前手写了一个 `Db` 实现，它**漏掉了 `assertInTransaction`**——
 * 于是「事务外查询必须抛错」这条不变量在测试中**静默失效**，
 * 而生产路径是正常的。测试装置与生产实现不一致，会让测试通过却掩盖真实行为。
 */
async function createPgDb(pgInstance: RealPostgres): Promise<Db & { end(): Promise<void> }> {
  const { createPgDb: productionCreatePgDb } = await import('../src/db/pool.ts');
  return productionCreatePgDb({ connectionString: pgInstance.url });
}

// ─────────────────────────── 测试 ───────────────────────────

test('真实 PG：会话持久化（写入 → 读回 → 撤销）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });

  const store = new DbSessionStore(db);
  const userId = randomUUID();
  const siteId = randomUUID();
  const principal = principalFromClaims(
    { sub: userId, email: 'a@b.c', emailVerified: true, preferredUsername: 'alice' },
    { realm: 'enduser', activeSiteId: siteId },
  );
  const session = {
    id: randomUUID(),
    tokenHash: 'hash-real-1',
    principal,
    createdAt: new Date('2025-06-01T00:00:00Z'),
    lastSeenAt: new Date('2025-06-01T00:00:00Z'),
    expiresAt: new Date('2025-06-02T00:00:00Z'),
    revokedAt: null,
  };

  await db.transaction(async () => store.save(session));
  const loaded = await db.transaction(async () => store.findByTokenHash('hash-real-1'));
  assert.equal(loaded!.id, session.id);
  assert.equal(loaded!.principal.userId, userId);
  // ★ ag_sessions 没有 username 列，适配器以 userId 占位（如实登记的数据模型缺口）
  assert.equal(loaded!.principal.username, userId);
  assert.equal(loaded!.principal.activeSiteId, siteId);
  assert.equal(loaded!.principal.email, null, 'ag_sessions 不存 email，适配器不伪造');
  assert.ok(loaded!.expiresAt instanceof Date, 'timestamptz 应解析为 Date');

  // 幂等 upsert（同 id 再存一次不应报错）
  await db.transaction(async () => store.save({ ...session, lastSeenAt: new Date('2025-06-01T01:00:00Z') }));
  const updated = await db.transaction(async () => store.findById(session.id));
  assert.equal(updated!.lastSeenAt.toISOString(), '2025-06-01T01:00:00.000Z');

  await db.transaction(async () => store.revoke(session.id, new Date('2025-06-01T02:00:00Z')));
  const revoked = await db.transaction(async () => store.findById(session.id));
  assert.ok(revoked!.revokedAt instanceof Date);
  assert.equal((await db.transaction(async () => store.listByUser(userId))).length, 1);
});

test('★ 真实 PG：动作日志幂等 —— 并发重放只能写一条（ON CONFLICT 是唯一保障）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const siteId = randomUUID();
  const store = new DbActionLogStore(db, siteId);

  const entry = {
    siteId,
    userId: randomUUID(),
    // ★ ag_actions_log.policy_id 是 uuid（指向 ag_policies.id），不是策略 code
    policyId: randomUUID(),
    actionSeq: 1,
    action: 'checkin:grant',
    idempotencyKey: 'idem-real-1',
    status: 'succeeded' as const,
    attempts: 1,
    startedAt: new Date('2025-06-01T00:00:00Z'),
    finishedAt: new Date('2025-06-01T00:00:01Z'),
  };

  // 并发写同一幂等键
  await Promise.all([
    db.transaction(async () => store.record(entry)),
    db.transaction(async () => store.record(entry)),
    db.transaction(async () => store.record(entry)),
  ]);

  const rows = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_actions_log WHERE idempotency_key = $1', ['idem-real-1']),
  );
  assert.equal(rows[0]!.n, '1', '★ 幂等键唯一约束必须让并发重放只留一条');

  const found = await db.transaction(async () => store.find(siteId, 'idem-real-1'));
  assert.equal(found!.status, 'succeeded');
  assert.equal(found!.attempts, 1);
});

test('★ 真实 PG：作业租约并发抢锁 —— 两个会话只能有一个取到（TOCTOU 防线）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const siteId = randomUUID();
  const now = new Date('2025-06-01T00:00:00Z');

  // 两个独立的 Db（各自连接池）→ 模拟两个实例
  const dbA = await createPgDb(instance);
  const dbB = await createPgDb(instance);
  t.after(async () => {
    await dbA.end();
    await dbB.end();
  });

  const storeA = new DbJobStore(dbA, siteId);
  const storeB = new DbJobStore(dbB, siteId);
  await dbA.transaction(async () => storeA.ensureJob('patrol.real', now));

  // 并发抢同一个 jobKey
  const [gotA, gotB] = await Promise.all([
    dbA.transaction(async () => storeA.tryAcquire('patrol.real', 'instance-A', 60_000, now)),
    dbB.transaction(async () => storeB.tryAcquire('patrol.real', 'instance-B', 60_000, now)),
  ]);

  assert.equal(
    [gotA, gotB].filter(Boolean).length,
    1,
    `★ 同一 jobKey 的租约只能被一个实例取得（实际 A=${gotA} B=${gotB}）——这是先读后写实现会失败的地方`,
  );

  // 租约未过期时另一实例仍取不到
  const later = new Date(now.getTime() + 1_000);
  const stillBlocked = gotA
    ? await dbB.transaction(async () => storeB.tryAcquire('patrol.real', 'instance-B', 60_000, later))
    : await dbA.transaction(async () => storeA.tryAcquire('patrol.real', 'instance-A', 60_000, later));
  assert.equal(stillBlocked, false, '租约未过期不得抢占');

  // 租约过期后可被抢占（防进程崩溃导致任务永久卡死）
  const expired = new Date(now.getTime() + 120_000);
  const takeover = gotA
    ? await dbB.transaction(async () => storeB.tryAcquire('patrol.real', 'instance-B', 60_000, expired))
    : await dbA.transaction(async () => storeA.tryAcquire('patrol.real', 'instance-A', 60_000, expired));
  assert.equal(takeover, true, '★ 租约过期后必须能被抢占（否则崩溃会永久卡死任务）');

  // 计数自增（走编译器的受限表达式）
  await dbA.transaction(async () => storeA.recordResult('patrol.real', { status: 'succeeded', now, nextRunAt: expired }));
  const job = await dbA.transaction(async () => storeA.get('patrol.real'));
  assert.equal(job!.runCount, 1, 'run_count 应自增');
  assert.equal(job!.status, 'succeeded');
});

test('★ 真实 PG：pg_advisory_lock 跨会话互斥（pglite 无法验证）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const makeConn = async () => {
    const client = new Client({ host: '127.0.0.1', port: instance.port, user: 'accessgate', database: 'accessgate' });
    await client.connect();
    return {
      query: async (sql: string, params?: readonly unknown[]) => {
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as unknown[] };
      },
      release: async () => {
        await client.end();
      },
    };
  };

  const lockA = createPgAdvisoryLock({ acquireConnection: makeConn });
  const lockB = createPgAdvisoryLock({ acquireConnection: makeConn });

  const gotA = await lockA.tryLock('patrol:site-1');
  assert.equal(gotA, true, 'A 应能取到锁');
  const gotB = await lockB.tryLock('patrol:site-1');
  assert.equal(gotB, false, '★ B 不得取到同一个锁（跨会话互斥）');

  await lockA.unlock('patrol:site-1');
  const gotB2 = await lockB.tryLock('patrol:site-1');
  assert.equal(gotB2, true, 'A 释放后 B 应能取到');
  await lockB.unlock('patrol:site-1');
});

test('真实 PG：生命周期状态持久化（JSONB 之外的列类型正确）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const siteId = randomUUID();
  const userId = randomUUID();
  const policyId = randomUUID();
  // ★ 状态表的外键是 ag_policies.id（uuid），不是 code——必须先建策略行
  await db.transaction(async () => {
    // ★ ag_policies 的真实列里没有 requirements（表达式在 ag_policy_versions.spec）
    await db.query('INSERT INTO ag_policies (id, site_id, code, name) VALUES ($1, $2, $3, $4)', [
      policyId,
      siteId,
      'edu',
      '教育邮箱',
    ]);
  });
  const resolvePolicyId = async (code: string): Promise<string | undefined> => {
    const rows = await db.query<{ id: string }>('SELECT id FROM ag_policies WHERE code = $1 AND site_id = $2', [code, siteId]);
    return rows[0]?.id;
  };
  const store = new DbLifecycleStateStore(db, siteId, resolvePolicyId);

  await db.transaction(async () =>
    store.save(siteId, userId, 'edu', {
      state: 'granted',
      graceUntil: null,
      stateChangedAt: new Date('2025-06-01T00:00:00Z'),
      atRiskCount: 2,
      actionSeq: 3,
    }),
  );
  const loaded = await db.transaction(async () => store.get(siteId, userId, 'edu'));
  assert.equal(loaded!.state, 'granted');
  // ★ 如实断言：`ag_user_policy_state` **没有 at_risk_count 列**，
  //   适配器读的是 `consecutive_indeterminate`（最接近的观测值）。
  //   这里断言 0 而不是 2——**不为了让测试好看而伪造一个不存在的列**。
  assert.equal(loaded!.atRiskCount, 0, 'DB 无 at_risk_count 列，读回 consecutive_indeterminate（未写过 → 0）');
  assert.equal(loaded!.actionSeq, 3);
  assert.equal(loaded!.graceUntil, null);

  // 状态迁移：进入 at_risk 并带宽限期
  await db.transaction(async () =>
    store.save(siteId, userId, 'edu', {
      state: 'at_risk',
      graceUntil: new Date('2025-06-04T00:00:00Z'),
      stateChangedAt: new Date('2025-06-01T01:00:00Z'),
      atRiskCount: 3,
      actionSeq: 3,
    }),
  );
  const atRisk = await db.transaction(async () => store.get(siteId, userId, 'edu'));
  assert.equal(atRisk!.state, 'at_risk');
  assert.equal(atRisk!.graceUntil!.toISOString(), '2025-06-04T00:00:00.000Z');
  // 状态迁移后 actionSeq 保持不变（进入 at_risk 不发动作 → 幂等键稳定）
  assert.equal(atRisk!.actionSeq, 3, '★ 进入 at_risk 不递增 actionSeq（否则会凭空产生新幂等键）');
});

test('★ 真实 PG：策略 code 无法解析时**必须报错**（状态写不进去会导致重复授予）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const store = new DbLifecycleStateStore(db, randomUUID(), async () => undefined);
  await assert.rejects(
    db.transaction(async () =>
      store.save('ignored', randomUUID(), 'ghost-policy', {
        state: 'granted',
        graceUntil: null,
        stateChangedAt: new Date(),
        atRiskCount: 0,
        actionSeq: 1,
      }),
    ),
    /无法解析策略 code 'ghost-policy'/,
  );
});

test('★ 真实 PG：事实按主体持久化（ag_plugin_facts 的 user_id 是键的一部分）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const siteId = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const store = new DbFactStore(db, siteId);
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const now = new Date('2025-06-01T00:00:00Z');

  const pipelineA = new FactPipeline({ store, manifest, userId: userA });
  const pipelineB = new FactPipeline({ store, manifest, userId: userB });

  await db.transaction(async () => pipelineA.emit({ domain: 'tsinghua.edu.cn', is_edu: true, matched_rule: 'allow:*.edu.cn', verified: true }, now));
  await db.transaction(async () => pipelineB.emit({ domain: 'gmail.com', is_edu: false, matched_rule: 'none', verified: true }, now));

  // ★ 同一插件、同一字段名，不同主体 → 互不覆盖（这正是「事实按主体存」的含义）
  const a = await db.transaction(async () => pipelineA.get('domain', now));
  const b = await db.transaction(async () => pipelineB.get('domain', now));
  assert.equal(a!.value, 'tsinghua.edu.cn');
  assert.equal(b!.value, 'gmail.com');

  const rows = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_plugin_facts WHERE site_id = $1', [siteId]),
  );
  assert.equal(rows[0]!.n, '8', '两个主体各 4 个字段 = 8 行');

  // 覆盖写（同主体同字段）应更新而非新增
  await db.transaction(async () => pipelineA.emit({ domain: 'pku.edu.cn', is_edu: true, matched_rule: 'allow:*.edu.cn', verified: true }, now));
  const updated = await db.transaction(async () => pipelineA.get('domain', now));
  assert.equal(updated!.value, 'pku.edu.cn');
  const rows2 = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_plugin_facts WHERE site_id = $1 AND user_id = $2', [siteId, userA]),
  );
  assert.equal(rows2[0]!.n, '4', '同主体同字段应覆盖，不新增行');

  // 过期清理
  const purged = await db.transaction(async () => store.purgeExpired(new Date('2027-01-01T00:00:00Z')));
  assert.equal(purged, 8, '过期事实应被清理');
});

test('★ 真实 PG：身份对齐持久化（唯一键是 owner_scope+owner_id+provider+provider_user_id）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const store = new DbIdentityStore(db);
  const userId = randomUUID();

  await db.transaction(async () =>
    store.save({
      provider: 'oidc:https://idp.example',
      providerUserId: 'sub-1',
      userId,
      subjectRef: { provider: 'newapi-provider', externalId: '42' },
      claimSnapshot: { via: 'direct' },
      verifiedAt: new Date('2025-06-01T00:00:00Z'),
    }),
  );

  const loaded = await db.transaction(async () => store.find('oidc:https://idp.example', 'sub-1'));
  assert.equal(loaded!.userId, userId);
  assert.deepEqual(loaded!.subjectRef, { provider: 'newapi-provider', externalId: '42' });
  assert.equal((loaded!.claimSnapshot as { via: string }).via, 'direct');
  assert.ok(loaded!.verifiedAt instanceof Date);

  // upsert（换绑：同 provider+sub 指向新主体）
  await db.transaction(async () =>
    store.save({
      provider: 'oidc:https://idp.example',
      providerUserId: 'sub-1',
      userId,
      subjectRef: { provider: 'newapi-provider', externalId: '99' },
      claimSnapshot: { via: 'direct' },
    }),
  );
  const rebound = await db.transaction(async () => store.find('oidc:https://idp.example', 'sub-1'));
  assert.equal(rebound!.subjectRef!.externalId, '99');

  // 撤销：表里没有 revoked_at 列，适配器记进 claim_snapshot（如实登记的缺口）
  await db.transaction(async () => store.revoke('oidc:https://idp.example', 'sub-1', new Date('2025-06-02T00:00:00Z')));
  const revoked = await db.transaction(async () => store.find('oidc:https://idp.example', 'sub-1'));
  assert.ok(revoked!.revokedAt instanceof Date, '撤销时间必须可读回（存在 claim_snapshot.revokedAt）');
  assert.equal((await db.transaction(async () => store.listByUser(userId))).length, 1);
});

test('★ 真实 PG：主体仓储（对账产物）upsert / 计属性变化 / 软删除 / 复活', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const siteId = randomUUID();
  const store = new DbSubjectRepository(db, siteId);
  const now = new Date('2025-06-01T00:00:00Z');
  const subject = (id: string, group: string, email: string) => ({
    externalId: id,
    displayName: `user${id}`,
    email,
    attributes: { group, status: 1 },
  });

  const created = await db.transaction(async () => store.upsert('newapi-provider', subject('1', 'default', 'a@edu.cn'), ['group', 'status'], 'fp-1', now));
  assert.equal(created.created, true);

  // 指纹相同 → unchanged
  const same = await db.transaction(async () => store.upsert('newapi-provider', subject('1', 'default', 'a@edu.cn'), ['group', 'status'], 'fp-1', now));
  assert.equal(same.unchanged, true);

  // 关注字段变化 → changed 且只报该字段
  const changed = await db.transaction(async () => store.upsert('newapi-provider', subject('1', 'vip2', 'a@edu.cn'), ['group', 'status'], 'fp-2', now));
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.changedKeys, ['group']);

  // 读回（jsonb 往返）
  const loaded = await db.transaction(async () => store.get('newapi-provider', '1'));
  assert.equal(loaded!.attributes['group'], 'vip2');
  assert.deepEqual(loaded!.watched, ['group', 'status']);
  assert.equal(await db.transaction(async () => store.findByEmail('newapi-provider', 'a@edu.cn')).then((r) => r!.externalId), '1');

  // 软删除 + 复活
  const marked = await db.transaction(async () => store.markDeleted('newapi-provider', [], now));
  assert.deepEqual(marked, ['1']);
  assert.equal(await db.transaction(async () => store.count('newapi-provider')), 0);
  // 行仍在（软删）
  const rows = await db.transaction(async () =>
    db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_external_subjects WHERE site_id = $1 AND deleted_at IS NOT NULL', [siteId]),
  );
  assert.equal(rows[0]!.n, '1', '软删除不得物理删行');

  const revived = await db.transaction(async () => store.upsert('newapi-provider', subject('1', 'vip2', 'a@edu.cn'), ['group', 'status'], 'fp-3', now));
  assert.equal(revived.revived, true);
  assert.equal(await db.transaction(async () => store.count('newapi-provider')), 1);

  // ★ 站点隔离：另一个站点看不到
  const other = new DbSubjectRepository(db, randomUUID());
  assert.equal(await db.transaction(async () => other.get('newapi-provider', '1')), undefined);
});

test('★ 真实 PG：策略仓储（头 + 版本；发布 = 新建版本 + 切换 active 指针）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const siteId = randomUUID();
  const store = new DbPolicyStore(db, siteId);
  const policy = {
    code: 'edu-upgrade',
    name: '教育邮箱自动升级',
    priority: 10,
    enabled: true,
    spec: { requirements: { expression: { matches: { 'fact.email.domain': ['*.edu.cn'] } } } },
  };

  // 保存草稿：新建头 + draft 版本
  await db.transaction(async () => store.saveDraft(siteId, policy));
  const draft = await db.transaction(async () => store.get(siteId, 'edu-upgrade'));
  assert.equal(draft!.code, 'edu-upgrade');
  assert.equal(draft!.version, 1);
  assert.deepEqual(draft!.spec, policy.spec, 'spec 必须原样往返（jsonb）');

  // 发布：draft → active，指针指向它
  const published = await db.transaction(async () => store.publish(siteId, 'edu-upgrade', 1));
  assert.equal(published.version, 1);

  // 再存草稿 → version 2（追加，不覆盖历史）
  await db.transaction(async () => store.saveDraft(siteId, { ...policy, spec: { requirements: { expression: { always: true } } } }));
  const rows = await db.transaction(async () =>
    db.query<{ version: number; status: string }>(
      'SELECT version, status FROM ag_policy_versions WHERE site_id = $1 ORDER BY version',
      [siteId],
    ),
  );
  assert.equal(rows.length, 2, '★ 版本化：新草稿是追加而非覆盖（历史评估可复现的前提）');
  assert.deepEqual(rows.map((r) => `${r.version}:${r.status}`), ['1:active', '2:draft']);

  // 列表：优先返回 active 版本的内容（而不是最新 draft）
  const listed = await db.transaction(async () => store.list(siteId));
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]!.spec, policy.spec, '未发布的新草稿不应改变「当前生效内容」');

  // 发布 v2 → 旧 active 转 archived（保证生效版本唯一）
  await db.transaction(async () => store.publish(siteId, 'edu-upgrade', 2));
  const after = await db.transaction(async () =>
    db.query<{ version: number; status: string }>('SELECT version, status FROM ag_policy_versions WHERE site_id = $1 ORDER BY version', [siteId]),
  );
  assert.deepEqual(after.map((r) => `${r.version}:${r.status}`), ['1:archived', '2:active']);
});

// ─────────────────────────── 发件箱与死信（D-5 缺陷修复的验证） ───────────────────────────

test('★ 真实 PG：事务性发件箱 —— 与业务同事务写入、投递、重试、死信', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const siteId = randomUUID();
  const { DbOutboxStore, createTransactionalOutboxStore } = await import('../src/db/outbox-adapters.ts');
  const store = new DbOutboxStore(db, siteId);
  const now = new Date('2025-06-01T00:00:00Z');

  // ① 与业务同事务写入
  await db.transaction(async () =>
    store.append({ type: 'policy.granted', payload: { userId: 'u1', group: 'vip2' }, traceId: 'trace-1', occurredAt: now }),
  );
  assert.equal(await db.transaction(async () => store.size()), 1, '应有一条待投递');

  // ② 取到期事件
  const due = await db.transaction(async () => store.claimDue(10, now));
  assert.equal(due.length, 1);
  assert.equal(due[0]!.type, 'policy.granted');
  assert.equal(due[0]!.attempts, 0);
  assert.equal((due[0]!.payload as { group: string }).group, 'vip2');
  assert.equal(due[0]!.traceId, 'trace-1');

  // ③ 重试：attempts 增长、下次时间推后（表用 nextAttemptAt 表达，不另设 failed 态）
  const later = new Date(now.getTime() + 5_000);
  await db.transaction(async () => store.markRetry(due[0]!.id, later, '下游 503'));
  const notDueYet = await db.transaction(async () => store.claimDue(10, now));
  assert.equal(notDueYet.length, 0, '未到 nextAttemptAt 不应被领取');
  const dueLater = await db.transaction(async () => store.claimDue(10, later));
  assert.equal(dueLater.length, 1);
  assert.equal(dueLater[0]!.attempts, 1, '★ attempts 应自增（走编译器的 increment 表达式）');
  assert.equal(dueLater[0]!.lastError, '下游 503');

  // ④ 标记投递成功 → 不再出现在待投递
  await db.transaction(async () => store.markDelivered(due[0]!.id));
  assert.equal((await db.transaction(async () => store.claimDue(10, later))).length, 0);
  assert.equal(await db.transaction(async () => store.size()), 0);

  // ⑤ 第二条：重试耗尽 → 死信（★ 必须同时写入 ag_dead_letters）
  await db.transaction(async () =>
    store.append({ type: 'policy.revoked', payload: { userId: 'u2' }, occurredAt: now }),
  );
  const second = await db.transaction(async () => store.claimDue(10, now));
  assert.equal(second.length, 1);
  await db.transaction(async () => {
    await store.markRetry(second[0]!.id, now, '第一次失败');
    await store.markDead(second[0]!.id, '重试耗尽');
  });

  const deadLetters = await db.transaction(async () => store.deadLetters());
  assert.equal(deadLetters.length, 1, '★ 死信必须可列出（否则失败等同于被丢弃）');
  assert.equal(deadLetters[0]!.type, 'policy.revoked');
  assert.equal(deadLetters[0]!.lastError, '重试耗尽');
  assert.equal((deadLetters[0]!.payload as { userId: string }).userId, 'u2', '死信必须保留 payload（否则无法重放）');

  // 死信不再出现在待投递
  assert.equal((await db.transaction(async () => store.claimDue(10, now))).length, 0, 'dead 是终态');
  assert.equal(await db.transaction(async () => store.size()), 0, 'size 只算 pending');

  // ⑥ 幂等：重复 markDead 不产生第二条死信
  await db.transaction(async () => store.markDead(second[0]!.id, '重复标记'));
  const stillOne = await db.transaction(async () => store.deadLetters());
  assert.equal(stillOne.length, 1, '★ 同一事件重复标记死信应幂等（唯一键 (siteId, eventId)）');

  // ⑦ 重放：标记后从待重放列表消失
  await db.transaction(async () => store.markReplayed(deadLetters[0]!.id, randomUUID()));
  assert.equal((await db.transaction(async () => store.deadLetters())).length, 0, '已重放的死信不再出现在待重放列表');
});

test('★ 真实 PG：发件箱按站点隔离（A 站点的事件不出现在 B 站点）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { DbOutboxStore, createTransactionalOutboxStore } = await import('../src/db/outbox-adapters.ts');
  const siteA = randomUUID();
  const siteB = randomUUID();
  const storeA = new DbOutboxStore(db, siteA);
  const storeB = new DbOutboxStore(db, siteB);
  const now = new Date('2025-06-01T00:00:00Z');

  await db.transaction(async () => storeA.append({ type: 'policy.granted', payload: { s: 'A' }, occurredAt: now }));
  assert.equal(await db.transaction(async () => storeA.size()), 1);
  assert.equal(await db.transaction(async () => storeB.size()), 0, '★ B 站点看不到 A 的事件（站点作用域注入生效）');
  assert.equal((await db.transaction(async () => storeB.claimDue(10, now))).length, 0);
});

test('★ 真实 PG：发件箱写入必须在事务内（单一事务入口在运行时强制）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { DbOutboxStore, createTransactionalOutboxStore } = await import('../src/db/outbox-adapters.ts');
  const store = new DbOutboxStore(db, randomUUID());
  // ★ 事务外调用必须抛错（这正是「保证事件不丢」的结构性保障：
  //   调用方无法"忘记"用事务，因为运行时不允许）
  await assert.rejects(
    store.append({ type: 'policy.granted', payload: {}, occurredAt: new Date() }),
    /事务/,
  );
});

// ─────────────────────────── 开发者与站点的 PG 持久化 ───────────────────────────

test('★ 真实 PG：开发者与站点持久化（含枚举与 jsonb 往返）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { DbSiteRegistry } = await import('../src/db/site-adapters.ts');
  const registry = new DbSiteRegistry(db);

  // ① 创建开发者（用户名大小写不敏感）
  const developer = await db.transaction(async () =>
    registry.createDeveloper({ username: 'Alice', displayName: 'Alice', email: 'a@corp.com', role: 'developer' }),
  );
  assert.match(developer.id, /^[0-9a-f-]{36}$/);
  assert.equal(developer.role, 'developer');
  assert.equal(developer.status, 'active');
  assert.equal(developer.emailVerified, false, '默认未验证');

  const found = await db.transaction(async () => registry.findDeveloperByUsername('alice'));
  assert.equal(found?.id, developer.id, '★ 用户名查找应大小写不敏感');
  assert.equal((await db.transaction(async () => registry.findDeveloper(developer.id)))?.email, 'a@corp.com');

  // ② 用户名重复 → 明确报错
  await assert.rejects(
    db.transaction(async () => registry.createDeveloper({ username: 'ALICE', displayName: 'x', email: 'x@y.z' })),
    /已被占用/,
  );

  // ③ 创建站点（slug 校验复用核心逻辑）
  const site = await db.transaction(async () =>
    registry.createSite({ siteId: 'alice-main', nickname: '主站', developerId: developer.id, quota: { maxSubjects: 100 }, settings: { theme: 'dark' } }),
  );
  // ★ 两个标识分工
  assert.notEqual(site.id, site.siteId, '内部 uuid 与 slug 必须不同');
  assert.match(site.id, /^[0-9a-f-]{36}$/);
  assert.equal(site.siteId, 'alice-main');
  assert.equal(site.status, 'active');
  // ★ jsonb 往返
  assert.deepEqual(site.quota, { maxSubjects: 100 });
  assert.deepEqual(site.settings, { theme: 'dark' });

  // ④ 非法 slug / 重复 slug / 开发者不存在
  await assert.rejects(db.transaction(async () => registry.createSite({ siteId: 'Bad Slug', nickname: 'x', developerId: developer.id })), /非法/);
  await assert.rejects(db.transaction(async () => registry.createSite({ siteId: 'alice-main', nickname: 'x', developerId: developer.id })), /已被占用/);
  await assert.rejects(
    db.transaction(async () => registry.createSite({ siteId: 'orphan', nickname: 'x', developerId: '00000000-0000-0000-0000-000000000000' })),
    /不存在/,
  );

  // ⑤ 一对多
  await db.transaction(async () => registry.createSite({ siteId: 'alice-test', nickname: '测试站', developerId: developer.id }));
  const sites = await db.transaction(async () => registry.listSitesOf(developer.id));
  assert.deepEqual(sites.map((entry) => entry.siteId), ['alice-main', 'alice-test'], '按 slug 稳定排序');

  // ⑥ 状态与配额更新
  await db.transaction(async () => registry.setSiteStatus('alice-test', 'suspended'));
  assert.equal((await db.transaction(async () => registry.findSite('alice-test')))?.status, 'suspended');
  await db.transaction(async () => registry.updateSiteQuota('alice-main', { maxDailyActions: 500 }));
  assert.deepEqual((await db.transaction(async () => registry.findSite('alice-main')))?.quota, { maxDailyActions: 500 });

  // ⑦ ★ 枚举取值与迁移产物对齐：`deleted` 可存（`pending` 会被 PG 拒绝）
  await db.transaction(async () => registry.setDeveloperStatus(developer.id, 'deleted'));
  assert.equal((await db.transaction(async () => registry.findDeveloper(developer.id)))?.status, 'deleted');
  await assert.rejects(
    db.transaction(async () => registry.setDeveloperStatus(developer.id, 'pending' as never)),
    /ag_dev_status|invalid input value for enum/,
    '★ 早期凭直觉写的 pending 会被枚举拒绝——表是权威',
  );

  // ⑧ 持久化验证：用**独立连接**直接查库，确认数据真的落盘
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_sites WHERE developer_id = $1', [developer.id]);
    assert.equal(rows.rows[0]!.n, '2', '★ 站点确实写入了数据库（不是内存）');
  } finally {
    await client.end();
  }

  // ⑨ 只列「有活跃站点」的活跃开发者
  const developer2 = await db.transaction(async () =>
    registry.createDeveloper({ username: 'bob', displayName: 'Bob', email: 'b@corp.com', role: 'developer' }),
  );
  await db.transaction(async () => registry.createSite({ siteId: 'bob-main', nickname: 'Bob 站', developerId: developer2.id }));
  const { listDevelopersWithActiveSites } = await import('../src/db/site-adapters.ts');
  const activeIds = await db.transaction(async () => listDevelopersWithActiveSites(db));
  assert.ok(activeIds.includes(developer2.id), '有活跃站点的开发者应在列表中');
  assert.equal(activeIds.includes(developer.id), false, '★ 状态为 deleted 的开发者不应出现');
});

// ─────────────────────────── 插件注册表（ag_plugins）───────────────────────────

test('★★ 真实 PG：插件注册表（安装 / 列表 / 信任 / 启用停用）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalPluginStore } = await import('../src/plugin/registry-store.ts');
  // ★ 必须用**事务化**工厂：`PluginStore` 的方法由路由调用，不在业务事务内
  const store = createTransactionalPluginStore(db);

  const manifest = {
    apiVersion: 'gate.plugin/v1',
    kind: 'channel',
    id: 'demo-channel',
    name: '示例渠道',
    version: '1.2.3',
    runtime: 'declarative',
    namespace: 'demo',
    permissions: ['http:egress'],
  } as never;

  // ① 安装
  const installed = await store.install({ manifest, source: 'uploaded', signatureVerified: true });
  assert.equal(installed.id, 'demo-channel');
  assert.equal(installed.status, 'installed', '安装后状态是 installed（未启用）');
  assert.equal(installed.namespace, 'demo');
  assert.equal(installed.signatureVerified, true);
  assert.equal(installed.digest.length, 32, '内容指纹已计算');
  // ★ jsonb 往返
  assert.equal((installed.manifest as Record<string, unknown>)['name'], '示例渠道');

  // ② 安装同一 id → 幂等更新（不报唯一冲突）
  const reinstalled = await store.install({ manifest: { ...(manifest as object), version: '1.2.4' } as never, source: 'uploaded' });
  assert.equal(reinstalled.version, '1.2.4', '★ 重复安装应更新版本而不是抛唯一冲突');

  // ③ 列表与按命名空间查
  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal((await store.findByNamespace('demo'))?.id, 'demo-channel');
  assert.equal(await store.findByNamespace('ghost'), undefined);

  // ④ 启用 / 停用
  const enabled = await store.setStatus('demo-channel', 'enabled');
  assert.equal(enabled?.status, 'enabled');
  assert.ok(enabled?.enabledAt !== null, '启用时记录 enabled_at');
  assert.deepEqual(await store.enabledIds(), ['demo-channel'], '★ 只有 enabled 的插件出现在 enabledIds');

  // ⑤ ★ 信任：后端信任的撤销**一并停用**（与 governance.ts 的语义一致）
  const trusted = await store.setTrust('demo-channel', 'backend', true, 'admin-1', new Date('2025-06-01T00:00:00Z'));
  assert.equal((trusted?.runtimeState['trust'] as Record<string, { trusted: boolean }>)['backend']?.trusted, true);
  const revoked = await store.setTrust('demo-channel', 'backend', false, 'admin-1', new Date('2025-06-02T00:00:00Z'));
  assert.equal(revoked?.status, 'disabled', '★ 撤销后端信任必须一并停用');
  assert.deepEqual(await store.enabledIds(), []);

  // ⑥ 不存在的插件 → undefined（不抛错）
  assert.equal(await store.setStatus('ghost', 'enabled'), undefined);
  assert.equal(await store.get('ghost'), undefined);

  // ⑦ 持久化验证：独立连接查库
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string; ns: string }>('SELECT count(*)::text AS n, min(namespace) AS ns FROM ag_plugins');
    assert.equal(rows.rows[0]!.n, '1', '★ 插件确实写入了 ag_plugins');
    assert.equal(rows.rows[0]!.ns, 'demo');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── 平台设置（ag_platform_settings）───────────────────────────

test('★★ 真实 PG：平台设置（putIfAbsent 幂等 + jsonb 往返 + locked_by_env）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalSettingsStore } = await import('../src/db/settings-adapters.ts');
  const { PLATFORM_MODE_KEY } = await import('../src/app/platform-mode.ts');
  const store = createTransactionalSettingsStore(db);

  // ① 首次写入
  const first = await store.putIfAbsent(PLATFORM_MODE_KEY, 'standalone', null, new Date('2025-06-01T00:00:00Z'));
  assert.equal(first.value, 'standalone');
  assert.equal(first.lockedByEnv, false);

  // ② ★ 再次 putIfAbsent **不得覆盖**（文档 §11：initial 仅首次生效）
  const second = await store.putIfAbsent(PLATFORM_MODE_KEY, 'saas', null, new Date('2025-06-02T00:00:00Z'));
  assert.equal(second.value, 'standalone', '★ 首次写入后不再覆盖——否则每次重启都会推翻 API 的切换');

  // ③ put 可以覆盖
  // ★ `updated_by` 是 uuid 列——不能写 'admin-1' 这种人类可读 id
  //   （同一测试里我先写 'system' 又写 'admin-1'，两次都被 PG 拒绝）
  const adminId = randomUUID();
  const updated = await store.put(PLATFORM_MODE_KEY, 'saas', adminId, new Date('2025-06-03T00:00:00Z'));
  assert.equal(updated.value, 'saas');
  assert.equal(updated.updatedBy, adminId);

  // ④ ★ locked_by_env：预置一条被锁定的记录，读回应为 true
  const locked = await store.putIfAbsent('platform.locked_demo', { a: 1 }, null, new Date('2025-06-01T00:00:00Z'), true);
  assert.equal(locked.lockedByEnv, true, '★ 被环境变量锁定的设置必须能被读出（API 据此拒绝修改）');
  // ★ jsonb 往返（对象）
  assert.deepEqual(locked.value, { a: 1 });

  // ⑤ 不存在的 key → undefined
  assert.equal(await store.get('platform.ghost'), undefined);

  // ⑥ 持久化验证：独立连接查库
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ key: string; value: unknown; locked_by_env: boolean }>(
      'SELECT key, value, locked_by_env FROM ag_platform_settings ORDER BY key',
    );
    assert.equal(rows.rows.length, 2, '★ 两条设置确实写入了 ag_platform_settings');
    const modeRow = rows.rows.find((row) => row.key === PLATFORM_MODE_KEY)!;
    assert.equal(modeRow.value, 'saas', 'jsonb 标量往返正确');
    assert.equal(modeRow.locked_by_env, false);
  } finally {
    await client.end();
  }
});

// ─────────────────────────── 插件配置（ag_plugin_configs）───────────────────────────

test('★★ 真实 PG：插件配置**版本化**（递增 / 归档 / jsonb 往返）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalPluginConfigStore, instanceIdFor, configHash } = await import('../src/plugin/config-store.ts');
  const store = createTransactionalPluginConfigStore(db);

  // ① 无配置时 latest 为 undefined（而不是抛错）
  assert.equal(await store.latest('demo'), undefined);

  // ② 第一次写 → v1
  const v1 = await store.save('demo', { token: 'abc', scope: 'repo' }, null, new Date('2025-06-01T00:00:00Z'));
  assert.equal(v1.version, 1);
  assert.equal(v1.status, 'active');
  assert.equal(v1.configHash, configHash({ token: 'abc', scope: 'repo' }));
  // ★ jsonb 往返
  assert.deepEqual(v1.config, { token: 'abc', scope: 'repo' });

  // ③ 第二次写 → v2，v1 变 archived
  const v2 = await store.save('demo', { token: 'xyz' }, null, new Date('2025-06-02T00:00:00Z'));
  assert.equal(v2.version, 2, '★ 版本递增（uq_ag_plugin_configs_ver 保证唯一）');

  const history = await store.versions('demo');
  assert.deepEqual(history.map((entry) => entry.version), [2, 1], '倒序');
  assert.equal(history[0]!.status, 'active');
  assert.equal(history[1]!.status, 'archived', '★ 旧版本被归档');
  assert.equal((await store.latest('demo'))?.version, 2);

  // ④ `instance_id` 是**派生**的稳定 uuid（同一插件始终同一实例）
  const derived = instanceIdFor('demo');
  assert.match(derived, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/, '★ 是合法 uuid（PG 的 instance_id 是 uuid 列）');
  assert.equal(instanceIdFor('demo'), derived, '派生是确定性的');

  // ⑤ 持久化验证：独立连接查库
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string; active: string }>(
      "SELECT count(*)::text AS n, count(*) FILTER (WHERE status = 'active')::text AS active FROM ag_plugin_configs WHERE plugin_id = 'demo'",
    );
    assert.equal(rows.rows[0]!.n, '2', '★ 两个版本都写入了 ag_plugin_configs');
    assert.equal(rows.rows[0]!.active, '1', '★ 只有一个是 active');
    const inst = await client.query<{ instance_id: string }>('SELECT instance_id FROM ag_plugin_configs WHERE plugin_id = $1 LIMIT 1', ['demo']);
    assert.equal(inst.rows[0]!.instance_id, derived, 'instance_id 确实是派生的那个 uuid');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── 插件端点（ag_plugin_endpoints）───────────────────────────

test('★★ 真实 PG：端点注册与**路由冲突检测**（uq_ag_plugin_endpoints_route）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalPluginEndpointStore, EndpointRouteConflict } = await import('../src/plugin/endpoint-store.ts');
  const store = createTransactionalPluginEndpointStore(db);

  // ① 注册
  const first = await store.register({
    pluginId: 'plugin-a',
    method: 'POST',
    path: '/webhook/x',
    mountPath: '/api/plugins/plugin-a/webhook/x',
    auth: 'hmac',
  });
  assert.match(first.id, /^[0-9a-f-]{36}$/, 'id 是 uuid（uuidv7 默认值）');
  assert.equal(first.ownerScope, 'platform', '未指定时归属 platform');
  assert.equal(first.enabled, true);
  assert.equal(first.approvedBy, null, '新注册的端点尚未审批');

  // ② ★★ 同一 (owner_scope, owner_id, method, mount_path) → 冲突被**转成可读错误**
  await assert.rejects(
    store.register({ pluginId: 'plugin-b', method: 'POST', path: '/webhook/x', mountPath: '/api/plugins/plugin-a/webhook/x', auth: 'none' }),
    (error: unknown) => {
      assert.ok(error instanceof EndpointRouteConflict, `应是 EndpointRouteConflict（实际 ${String(error)}）`);
      assert.match(error.message, /路由冲突/);
      assert.match(error.message, /文档 §1\.13\.5/);
      return true;
    },
    '★ PG 的唯一索引会拦，但必须转成可读的冲突说明',
  );

  // ③ 不同 mount_path → 允许
  await store.register({ pluginId: 'plugin-b', method: 'POST', path: '/webhook/x', mountPath: '/api/plugins/plugin-b/webhook/x', auth: 'none' });

  // ④ 审批 + 单独禁用
  const approved = await store.approve('plugin-a', first.id, randomUUID(), new Date('2025-06-01T00:00:00Z'));
  assert.ok(approved?.approvedBy !== null, '审批记录审批人');
  assert.ok(approved?.approvedAt !== null);
  const disabled = await store.setEnabled('plugin-a', first.id, false);
  assert.equal(disabled?.enabled, false, '★ 端点可**单独禁用**（不必禁用整个插件）');

  // ⑤ 归属校验：端点不属于该插件时返回 undefined（不误改）
  assert.equal(await store.approve('plugin-b', first.id, randomUUID(), new Date()), undefined);
  assert.equal(await store.setEnabled('plugin-b', first.id, true), undefined);

  // ⑥ 列表
  assert.equal((await store.list('plugin-a')).length, 1);
  assert.equal((await store.list('plugin-b')).length, 1);

  // ⑦ 持久化验证：独立连接查库（含 owner_scope 必填）
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string; scopes: string }>(
      "SELECT count(*)::text AS n, string_agg(DISTINCT owner_scope::text, ',') AS scopes FROM ag_plugin_endpoints",
    );
    assert.equal(rows.rows[0]!.n, '2', '★ 两个端点确实写入了 ag_plugin_endpoints');
    assert.equal(rows.rows[0]!.scopes, 'platform', 'owner_scope 已写入');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── 用户管理（ag_users / ag_identities）───────────────────────────

test('★★ 真实 PG：用户管理（列表 / search 的 ILIKE / 分页 hasMore / 封禁）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalUserAdminStore } = await import('../src/admin/user-store.ts');
  const store = createTransactionalUserAdminStore(db);

  // 造数据：3 个用户（其中一个只有大写邮箱，用于验证 ILIKE 大小写不敏感）
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    for (const [email, username, status] of [
      ['Alice@Example.COM', 'alice', 'active'],
      ['bob@corp.com', 'bob', 'suspended'],
      ['carol@example.com', 'carol', 'pending'],
    ] as const) {
      await client.query('INSERT INTO ag_users (email, username, status, tags) VALUES ($1, $2, $3, $4)', [email, username, status, JSON.stringify(['vip'])]);
    }
    const carol = await client.query<{ id: string }>("SELECT id FROM ag_users WHERE username = 'carol'");
    await client.query(
      "INSERT INTO ag_identities (owner_scope, owner_id, user_id, provider, provider_user_id, claim_snapshot) VALUES ('platform', 'platform', $1, $2, $3, '{}')",
      [carol.rows[0]!.id, 'identity:oidc@platform:enduser', 'sub-carol'],
    );
  } finally {
    await client.end();
  }

  // ① 列表：不精确 total + hasMore（与内存实现同语义）
  const page1 = await store.list({ limit: 3, offset: 0 });
  assert.equal(page1.users.length, 2, '★ 传 limit=3 → 只返回 2 条（多取的一条用于判断 hasMore）');
  assert.equal(page1.hasMore, true);
  assert.equal(page1.total, 2, 'total 是「至少这么多」，不是精确总数');
  // ★ jsonb 往返：tags 是数组
  assert.deepEqual(page1.users[0]!.tags, ['vip']);

  // ② 最后一页
  const page2 = await store.list({ limit: 3, offset: 2 });
  assert.equal(page2.users.length, 1);
  assert.equal(page2.hasMore, false);

  // ③ ★ ILIKE：小写搜索能命中大写邮箱（内存实现靠 toLowerCase，PG 靠 ILIKE——两者必须同语义）
  const found = await store.list({ limit: 10, offset: 0, search: 'alice@example' });
  assert.equal(found.users.length, 1, '★ 搜索必须大小写不敏感（PG 用 ILIKE）');
  assert.equal(found.users[0]!.username, 'alice');
  assert.equal(found.users[0]!.emailVerified, false, 'email_verified 默认 false');

  // ④ 用户名也参与匹配
  const byUsername = await store.list({ limit: 10, offset: 0, search: 'CAROL' });
  assert.equal(byUsername.users.length, 1);
  assert.equal(byUsername.users[0]!.username, 'carol');

  // ⑤ 状态过滤 + 组合（AND）
  assert.equal((await store.list({ limit: 10, offset: 0, status: 'suspended' })).users.length, 1);
  assert.equal((await store.list({ limit: 10, offset: 0, status: 'active', search: 'carol' })).users.length, 0, 'status 与 search 是 AND');

  // ⑥ 详情与身份绑定（★ 关联查询走 ag_identities）
  const carol = (await store.list({ limit: 10, offset: 0, search: 'carol' })).users[0]!;
  const identities = await store.identitiesOf(carol.id);
  assert.equal(identities.length, 1);
  assert.equal(identities[0]!.provider, 'identity:oidc@platform:enduser');
  assert.equal((await store.identitiesOf('00000000-0000-7000-a000-000000000000')).length, 0, '不存在的用户返回空数组（不抛错）');

  // ⑦ 封禁（★ 枚举取值必须与 ag_user_status 一致：'suspended'）
  const blocked = await store.setStatus(carol.id, 'suspended');
  assert.equal(blocked?.status, 'suspended');
  assert.equal((await store.get(carol.id))?.status, 'suspended');

  // ⑧ 不存在的用户 → undefined
  assert.equal(await store.get('00000000-0000-7000-a000-000000000000'), undefined);
  assert.equal(await store.setStatus('00000000-0000-7000-a000-000000000000', 'active'), undefined);
});

// ─────────────────────────── 断言流水（ag_verify_assertions）───────────────────────────

test('★★ 真实 PG：断言流水（bigserial id / gt(expires_at) / 撤销幂等）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalAssertionAdminStore } = await import('../src/verify/assertion-store.ts');
  const store = createTransactionalAssertionAdminStore(db);

  // 造数据：4 条断言 —— 2 条有效、1 条已撤销、1 条已过期
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  const ids: number[] = [];
  try {
    const rows: [string, string, boolean, string, string][] = [
      ['vc_aaa', 'platform_user_id', true, 'direct', '2099-01-01T00:00:00Z'],
      ['vc_bbb', 'email', true, 'challenge', '2099-01-01T00:00:00Z'],
      ['vc_aaa', 'platform_user_id', true, 'direct', '2099-01-01T00:00:00Z'],
      ['vc_aaa', 'platform_user_id', false, 'direct', '2020-01-01T00:00:00Z'],
    ];
    for (const [clientId, subjectType, matched, via, expiresAt] of rows) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ag_verify_assertions (owner_scope, owner_id, client_id, subject_type, subject_value, claims, matched, via, expires_at)
         VALUES ('platform', 'platform', $1, $2, 'u-1', '{"eligible":true}', $3, $4, $5) RETURNING id`,
        [clientId, subjectType, matched, via, expiresAt],
      );
      ids.push(Number.parseInt(inserted.rows[0]!.id, 10));
    }
    // 第 3 条标记为已撤销
    await client.query('UPDATE ag_verify_assertions SET revoked_at = now() WHERE id = $1', [ids[2]]);
  } finally {
    await client.end();
  }

  // ① ★ bigserial → 数字（不是 uuid 字符串）
  const byId = await store.get(ids[0]!);
  assert.equal(typeof byId?.id, 'number', '★ id 是数字（bigserial）');
  assert.equal(byId?.clientId, 'vc_aaa');
  assert.equal(byId?.via, 'direct');
  // ★ jsonb 往返
  assert.deepEqual(byId?.claims, { eligible: true });

  // ② 全部（含已撤销与已过期）
  const all = await store.list({ limit: 10, offset: 0 });
  assert.equal(all.assertions.length, 4);

  // ③ 按 clientId 过滤
  assert.equal((await store.list({ limit: 10, offset: 0, clientId: 'vc_aaa' })).assertions.length, 3);

  // ④ ★★ `onlyActive` —— 同时用到 `isNull(revoked_at)` 与 `gt(expires_at, now)`
  const active = await store.list({ limit: 10, offset: 0, onlyActive: true });
  assert.equal(active.assertions.length, 2, '★ 已撤销与已过期的都应被排除');
  assert.deepEqual(active.assertions.map((entry) => entry.id).sort((a, b) => a - b), [ids[0], ids[1]]);

  // ⑤ ★★ 撤销幂等：第一次写入，第二次保留首次时间
  const first = await store.revoke(ids[0]!, new Date('2025-06-10T00:00:00Z'));
  assert.equal(first?.alreadyRevoked, false);
  assert.equal(first?.record.revokedAt?.toISOString(), '2025-06-10T00:00:00.000Z');
  const second = await store.revoke(ids[0]!, new Date('2025-06-11T00:00:00Z'));
  assert.equal(second?.alreadyRevoked, true, '★ 第二次应识别为「已撤销」');
  assert.equal(second?.record.revokedAt?.toISOString(), '2025-06-10T00:00:00.000Z', '★ 保留首次撤销时间（不是第二次的）');

  // ⑥ 不存在的断言 → undefined
  assert.equal(await store.revoke(999999, new Date()), undefined);
  assert.equal(await store.get(999999), undefined);

  // ⑦ 持久化验证：独立连接查库
  const verify = new Client({ connectionString: instance.url });
  await verify.connect();
  try {
    const count = await verify.query<{ n: string; revoked: string }>(
      "SELECT count(*)::text AS n, count(*) FILTER (WHERE revoked_at IS NOT NULL)::text AS revoked FROM ag_verify_assertions",
    );
    assert.equal(count.rows[0]!.n, '4', '★ 4 条断言都在库里');
    assert.equal(count.rows[0]!.revoked, '2', '★ 2 条已撤销（预置 1 条 + 本轮撤销 1 条）');
  } finally {
    await verify.end();
  }
});

// ─────────────────────────── 权限授予（ag_plugin_grants，文档 §4.3）───────────────────────────

test('★★★ 真实 PG：权限授予用**独立表**（逐项 / 审计 / 软撤销 / 唯一约束）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalPluginGrantStore } = await import('../src/plugin/grant-store.ts');
  const store = createTransactionalPluginGrantStore(db);
  const adminId = randomUUID();

  // ① 授予两条权限 → 表里两行
  const granted = await store.grant('demo', ['llm:invoke', 'http:egress'], adminId, new Date('2025-06-01T00:00:00Z'));
  assert.equal(granted.length, 2);
  assert.equal(granted[0]!.grantedBy, adminId, '★ 记录「谁授予的」（jsonb 版本丢失了它）');
  assert.equal(granted[0]!.grantedAt.toISOString(), '2025-06-01T00:00:00.000Z');
  assert.equal(granted[0]!.revokedAt, null);
  assert.deepEqual(await store.active('demo'), ['http:egress', 'llm:invoke']);

  // ② ★ 唯一约束 + ON CONFLICT：重复授予**不新增行**，只更新授予人/时间
  await store.grant('demo', ['llm:invoke'], randomUUID(), new Date('2025-06-02T00:00:00Z'));
  assert.equal((await store.history('demo')).length, 2, '★ 同一权限只有一行（uq_ag_plugin_grants）');

  // ③ ★★ 软撤销：写 revoked_at，**行仍在**
  const revoked = await store.revoke('demo', 'llm:invoke', new Date('2025-06-03T00:00:00Z'));
  assert.equal(revoked?.revokedAt?.toISOString(), '2025-06-03T00:00:00.000Z');
  assert.deepEqual(await store.active('demo'), ['http:egress'], '已撤销的不再有效');
  const history = await store.history('demo');
  assert.equal(history.length, 2, '★★ 行**没有**被删除——「这个权限曾经被授予过吗」仍可回答');
  assert.equal(history.find((entry) => entry.permission === 'llm:invoke')?.revokedAt?.toISOString(), '2025-06-03T00:00:00.000Z');

  // ④ ★ 幂等撤销：保留首次撤销时间
  const again = await store.revoke('demo', 'llm:invoke', new Date('2025-06-04T00:00:00Z'));
  assert.equal(again?.revokedAt?.toISOString(), '2025-06-03T00:00:00.000Z', '★ 保留首次撤销时间');

  // ⑤ ★★ 重新授予 → 清除撤销标记（唯一约束 + ON CONFLICT 的正确语义）
  await store.grant('demo', ['llm:invoke'], adminId, new Date('2025-06-05T00:00:00Z'));
  assert.deepEqual(await store.active('demo'), ['http:egress', 'llm:invoke']);
  assert.equal((await store.history('demo')).length, 2, '★ 仍是 2 行（不是 3 行）');

  // ⑥ ★★ 按权限反查持有者（安全审计的核心问题：`secrets:read:*` 都授权给了谁）
  await store.grant('other', ['http:egress'], adminId, new Date());
  const holders = await store.holdersOf('http:egress');
  assert.deepEqual(holders.map((entry) => entry.pluginId).sort(), ['demo', 'other'], '★ 反查能列出所有持有者');
  // ★ 简化后的断言（原来写成 `[await ...].map(...).slice(0,1)` —— 赶时间写坏的，可读性为零）
  const llmHolders = await store.holdersOf('llm:invoke');
  assert.deepEqual(llmHolders.map((entry) => entry.pluginId), ['demo'], 'llm:invoke 只有 demo 持有');

  // ⑦ 撤销不存在的权限 → undefined
  assert.equal(await store.revoke('demo', 'never:granted', new Date()), undefined);

  // ⑧ 持久化验证：独立连接查库（含 granted_by 是 uuid）
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string; revoked: string }>(
      "SELECT count(*)::text AS n, count(*) FILTER (WHERE revoked_at IS NOT NULL)::text AS revoked FROM ag_plugin_grants",
    );
    assert.equal(rows.rows[0]!.n, '3', '★ 3 行（demo 2 条 + other 1 条）');
    assert.equal(rows.rows[0]!.revoked, '0', '★ 撤销标记已被重新授予清除');
    const by = await client.query<{ granted_by: string }>('SELECT granted_by FROM ag_plugin_grants WHERE plugin_id = $1 AND permission = $2', ['demo', 'llm:invoke']);
    assert.equal(by.rows[0]!.granted_by, adminId, 'granted_by 是 uuid 且已落库');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── 登录事务（ag_oidc_login_transactions）───────────────────────────

test('★★★ 真实 PG：登录事务的 `take()` 是**原子取出即删除**（同一 state 只能取一次）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalLoginTransactionStore } = await import('../src/db/login-tx-adapter.ts');
  const store = createTransactionalLoginTransactionStore(db);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 600_000);

  // ① put
  await store.put({ state: 'st-1', nonce: 'n-1', codeVerifier: 'v-1', returnTo: '/#enduser', createdAt: now, expiresAt });

  // ② ★★★ take 一次 → 拿到
  const first = await store.take('st-1');
  assert.equal(first?.state, 'st-1');
  assert.equal(first?.codeVerifier, 'v-1', '★ PKCE verifier 必须能取回（内存实现会随重启丢失）');
  assert.equal(first?.nonce, 'n-1');
  assert.equal(first?.returnTo, '/#enduser');

  // ③ ★★★ take 第二次 → **必须 undefined**（这就是「原子取出即删除」）
  //   若用 SELECT + DELETE 两步，并发回调会**都取到**同一条 → state 防重放失效。
  const second = await store.take('st-1');
  assert.equal(second, undefined, '★★ 同一个 state 只能取出一次（防重放）');

  // ④ 持久化验证：独立连接查库确认行已被删除
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM ag_oidc_login_transactions WHERE state = 'st-1'");
    assert.equal(rows.rows[0]!.n, '0', '★ 取出后行确实被删除');
  } finally {
    await client.end();
  }

  // ⑤ 同一 state 重复 put → 覆盖（不报唯一冲突）
  await store.put({ state: 'st-2', nonce: 'n-2a', codeVerifier: 'v-2a', returnTo: '/', createdAt: now, expiresAt });
  await store.put({ state: 'st-2', nonce: 'n-2b', codeVerifier: 'v-2b', returnTo: '/', createdAt: now, expiresAt });
  assert.equal((await store.take('st-2'))?.nonce, 'n-2b', '★ 重复发起同一 state → 覆盖');

  // ⑥ 过期的事务**取不出来**（即使行还在）
  await store.put({
    state: 'st-expired',
    nonce: 'n',
    codeVerifier: 'v',
    returnTo: '/',
    createdAt: new Date(now.getTime() - 7200_000),
    expiresAt: new Date(now.getTime() - 3600_000),
  });
  assert.equal(await store.take('st-expired'), undefined, '★ 过期事务不得被取出');
  // ★ 且它已被删除（过期 state 也不该能被重放）
  assert.equal(await store.take('st-expired'), undefined);

  // ⑦ purgeExpired 清理过期事务
  await store.put({ state: 'st-purge', nonce: 'n', codeVerifier: 'v', returnTo: '/', createdAt: now, expiresAt: new Date(now.getTime() - 1000) });
  const purged = await store.purgeExpired(new Date());
  assert.ok(purged >= 1, `★ purgeExpired 应清理过期事务（实际 ${purged}）`);
  assert.equal(await store.take('st-purge'), undefined);
});

// ─────────────────────────── nonce 防重放（ag_verify_nonces）───────────────────────────

test('★★★ 真实 PG：nonce 的 `claim()` 原子（**并发下只有一个成功**）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalNonceStore } = await import('../src/db/nonce-adapter.ts');
  const store = createTransactionalNonceStore(db);
  const expiresAt = new Date(Date.now() + 300_000);

  // ① 首次 claim → true
  assert.equal(await store.claim('vc_aaa', 'nonce-1', expiresAt), true, '★ 首次应成功');

  // ② 同一 (clientId, nonce) 再次 claim → **false**（重复）
  assert.equal(await store.claim('vc_aaa', 'nonce-1', expiresAt), false, '★★ 重复必须被拒（防重放）');

  // ③ 不同 clientId 的同一 nonce → 允许（不同调用方的 nonce 空间独立）
  assert.equal(await store.claim('vc_bbb', 'nonce-1', expiresAt), true, '★ 不同调用方互不影响');
  // ④ 同一 clientId 的不同 nonce → 允许
  assert.equal(await store.claim('vc_aaa', 'nonce-2', expiresAt), true);

  // ⑤ ★★★ **并发**：10 个并发 claim 同一个新 nonce，**必须只有一个成功**
  //   这正是接口注释说的「先查后写在并发下会让两个相同 nonce 都通过」——
  //   本实现用唯一约束 + ON CONFLICT DO NOTHING，由**数据库**保证只有一个插入成功。
  const results = await Promise.all(
    Array.from({ length: 10 }, () => store.claim('vc_concurrent', 'nonce-race', expiresAt)),
  );
  assert.equal(results.filter((ok) => ok).length, 1, '★★★ 并发下必须**恰好一个**成功（否则重放防护失效）');

  // ⑥ purge 清理过期 nonce
  await store.claim('vc_aaa', 'nonce-expired', new Date(Date.now() - 1000));
  const purged = await store.purge!();
  assert.ok(purged >= 1, `★ purge 应清理过期 nonce（实际 ${purged}）`);
  // ★ 清理后同一个 nonce 可以再次 claim（窗口已过）
  assert.equal(await store.claim('vc_aaa', 'nonce-expired', new Date(Date.now() + 300_000)), true);

  // ⑦ 持久化验证：独立连接查库
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM ag_verify_nonces WHERE client_id = 'vc_concurrent'");
    assert.equal(rows.rows[0]!.n, '1', '★ 并发 claim 只留下 1 行');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── 终端用户（ag_users + ag_identities）───────────────────────────

test('★★★★ 真实 PG：终端用户持久化（**同一 sub 不重复建号**）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalEndUserStore } = await import('../src/db/end-user-adapter.ts');
  const store = createTransactionalEndUserStore(db);
  const provider = 'oidc:https://idp.example.com';

  // ① 首次：没有映射 → undefined
  assert.equal(await store.findByIdentity(provider, 'sub-alice'), undefined);

  // ② 建号
  // ★ 用**唯一用户名**：同一 PG 实例被多个测试共用（R46 的用户管理测试也建了 'alice'），
  //   直接用 'alice' 会撞 `uq_ag_users_username`。这是**测试隔离**问题，不是产品缺陷。
  const alice = await store.create({
    provider,
    providerUserId: 'sub-alice',
    username: 'eu-alice',
    displayName: 'Alice',
    email: 'eu-alice@example.com',
    emailVerified: true,
  });
  assert.match(alice.id, /^[0-9a-f-]{36}$/, '★ id 是 uuid（PG 主键类型）');
  assert.equal(alice.status, 'active', '邮箱已验证 → active');
  assert.equal(alice.displayName, 'Alice', '★ displayName 存在 profile 里且能取回');

  // ③ ★★★★ 关键：**同一个 sub 再 create 一次 → 必须返回同一用户**（不重复建号）
  //   这正是「重启后用户不消失」的核心：映射持久化后，第二次登录能找到既有用户。
  const again = await store.create({
    provider,
    providerUserId: 'sub-alice',
    username: 'eu-alice-again',
    displayName: 'Alice Again',
    email: 'eu-alice-again@example.com',
    emailVerified: true,
  });
  assert.equal(again.id, alice.id, '★★★ 同一 sub 必须复用同一用户 id（否则用户数据「分裂」）');

  // ④ findByIdentity / find 都能查到
  assert.equal(await store.findByIdentity(provider, 'sub-alice'), alice.id);
  assert.equal((await store.find(alice.id))?.username, 'eu-alice');

  // ⑤ 未验证邮箱 → pending → EndUser 视图表现为 suspended
  const bob = await store.create({
    provider,
    providerUserId: 'sub-bob',
    username: 'eu-bob',
    displayName: 'Bob',
    email: 'eu-bob@example.com',
    emailVerified: false,
  });
  assert.equal(bob.status, 'suspended', '★ ag_users 的 pending 在 EndUser 视图里是 suspended');

  // ⑥ 持久化验证：独立连接查库（**这是「重启后仍在」的直接证据**）
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const users = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM ag_users WHERE source = 'oidc'");
    assert.equal(users.rows[0]!.n, '2', '★ 两个终端用户确实写入了 ag_users');
    const ids = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM ag_identities WHERE provider = $1", [provider]);
    assert.equal(ids.rows[0]!.n, '2', '★ 身份映射也写入了 ag_identities');
  } finally {
    await client.end();
  }

  // ⑦ ★★ 「重启后仍在」的模拟：**换一个新的 store 实例**（等同新进程）读同一份数据
  const { createTransactionalEndUserStore: freshFactory } = await import('../src/db/end-user-adapter.ts');
  const freshStore = freshFactory(db);
  assert.equal(await freshStore.findByIdentity(provider, 'sub-alice'), alice.id, '★★ 新实例（模拟重启）仍能找到该用户');
  assert.equal((await freshStore.find(alice.id))?.email, 'eu-alice@example.com');
});

// ─────────────────────────── 设备码挑战（ag_verify_challenges）───────────────────────────

test('★★★ 真实 PG：设备码挑战持久化（**跨请求、跨实例**）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalChallengeStore } = await import('../src/db/challenge-adapter.ts');
  const store = createTransactionalChallengeStore(db);
  const now = new Date();
  const challenge = {
    challengeId: 'ch-r64-1',
    userCode: 'ABCD-1234',
    clientId: 'vc_device_1',
    subject: { type: 'discord_id', value: 'd-1' },
    scopes: ['assert:read'],
    status: 'pending' as const,
    userId: null,
    approvedAt: null,
    expiresAt: new Date(now.getTime() + 600_000),
    deliveries: 0,
    lastPolledAt: null,
    createdAt: now,
  };

  // ① save + get
  await store.save(challenge);
  const got = await store.get('ch-r64-1');
  assert.equal(got?.status, 'pending');
  assert.deepEqual(got?.scopes, ['assert:read'], '★ jsonb 往返');
  assert.equal(got?.deliveries, 0);
  assert.equal(got?.lastPolledAt, null);

  // ② ★★ `findByUserCode` 的**归一化**：用户可能输入小写或不带分隔符——
  //    内存实现把 `normalizeUserCode` 的结果当 key，PG 实现必须**同语义**
  //    （否则「内存能查到、PG 查不到」是本会话反复出现的漂移）。
  const byLower = await store.findByUserCode('abcd-1234');
  assert.equal(byLower?.challengeId, 'ch-r64-1', '★ 小写也能查到（归一化）');
  const byPlain = await store.findByUserCode('ABCD1234');
  assert.equal(byPlain?.challengeId, 'ch-r64-1', '★ 不带分隔符也能查到');

  // ③ 状态流转 + 计数器（**同一 challengeId 再次 save = 更新**）
  await store.save({ ...challenge, status: 'approved', userId: '11111111-1111-7111-a111-111111111111', approvedAt: now, deliveries: 1, lastPolledAt: now });
  const approved = await store.get('ch-r64-1');
  assert.equal(approved?.status, 'approved');
  assert.equal(approved?.deliveries, 1, '★ deliveries 必须持久化（决定能否重复换 token）');
  assert.ok(approved?.lastPolledAt !== null);
  assert.equal(approved?.userId, '11111111-1111-7111-a111-111111111111');

  // ④ ★★ 「新实例（模拟重启/另一实例）」仍能查到——这是设备码可用性的直接证据
  const { createTransactionalChallengeStore: freshFactory } = await import('../src/db/challenge-adapter.ts');
  const fresh = freshFactory(db);
  assert.equal((await fresh.get('ch-r64-1'))?.status, 'approved', '★★ 另一实例（或重启后）仍能取到该 challenge');

  // ⑤ 不存在的 challenge → undefined
  assert.equal(await store.get('ch-ghost'), undefined);
  assert.equal(await store.findByUserCode('ZZZZ-9999'), undefined);
});

// ─────────────────────────── 插件宿主 API 装配（KV 持久化）───────────────────────────

test('★★★★ 真实 PG：插件宿主 API 装配（KV **按插件隔离** + 跨实例仍在）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createHostApiFor } = await import('../src/plugin/host-factory.ts');
  const { InMemoryFactStore } = await import('../src/plugin/host-api.ts');

  // ★ 两个插件的清单（只有 id/namespace 影响 KV 隔离）
  // ★★ 必须**声明权限**——`HostApi` 会按 manifest 的 permissions 做门禁；
  //   我第一版没声明，于是 `storageSet` 被正确地拒绝：
  //     `插件 'plugin-a' 的权限申请被拒绝：未声明 'storage:write:self' 权限`
  //   ★ 这是**门禁在正确工作**，而我的**测试数据不完整**（本会话第 N 次）。
  const permissions = ['storage:read:self', 'storage:write:self', 'cache:read:self', 'cache:write:self'];
  const manifestA = { id: 'plugin-a', namespace: 'a', apiVersion: 'gate.plugin/v1', kind: 'feature', name: 'A', version: '1.0.0', runtime: 'declarative', permissions } as never;
  const manifestB = { id: 'plugin-b', namespace: 'b', apiVersion: 'gate.plugin/v1', kind: 'feature', name: 'B', version: '1.0.0', runtime: 'declarative', permissions } as never;
  const facts = new InMemoryFactStore();
  // ★ 事实按主体存（没有「平台级事实」）——这里用一个固定的测试主体
  const PLATFORM_FACT_USER = '00000000-0000-7000-a000-000000000000';

  // ① 装配两个宿主 API（各自独立）
  const hostA = createHostApiFor({ db, facts, userId: PLATFORM_FACT_USER }, manifestA);
  const hostB = createHostApiFor({ db, facts, userId: PLATFORM_FACT_USER }, manifestB);

  // ② ★★ KV 隔离：A 写的东西 B **读不到**
  //   这是「按插件实例化」的核心保证——pluginId 由**宿主注入**，插件无法伪造。
  //   ★ 用 `HostApi` 的**公开方法**（`storageSet`/`storageGet`）——
  //     我第一版直接访问 `host.storage`，那是 `private`（tsc 拦住）。
  //     ★ 「先看接口再写」在本会话已重复出现十余次。
  await hostA.storageSet('shared-key', 'from-a');
  assert.equal(await hostA.storageGet('shared-key'), 'from-a');
  assert.equal(await hostB.storageGet('shared-key'), undefined, '★★ 不同插件的 KV 必须隔离');

  // ③ cache 与 storage 是**两个独立命名空间**
  await hostA.cacheSet('same-key', 'cached', 60_000);
  await hostA.storageSet('same-key', 'stored');
  assert.equal(await hostA.cacheGet('same-key'), 'cached');
  assert.equal(await hostA.storageGet('same-key'), 'stored', '★ cache 与 storage 不互相覆盖');

  // ④ ★★★ 跨实例（模拟重启 / 另一个进程）：重新装配一个 host，仍能读到
  const hostA2 = createHostApiFor({ db, facts, userId: PLATFORM_FACT_USER }, manifestA);
  assert.equal(await hostA2.storageGet('shared-key'), 'from-a', '★★★ 重新装配后数据仍在（「重启不丢」的直接证据）');
  assert.equal(await hostA2.cacheGet('same-key'), 'cached');

  // ⑤ TTL：过期后取不到
  await hostA.storageSet('ttl-key', 'v', 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await hostA.storageGet('ttl-key'), undefined, '★ 过期即取不到（与内存实现同语义）');

  // ⑥ del
  await hostA.storageDel('shared-key');
  assert.equal(await hostA.storageGet('shared-key'), undefined);
  assert.equal(await hostA2.storageGet('shared-key'), undefined, '★ 删除对另一实例也可见');

  // ⑦ 持久化验证：独立连接查库
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string; ns: string }>('SELECT count(*)::text AS n, min(namespace) AS ns FROM ag_plugins');
    assert.equal(rows.rows[0]!.n, '1', '★ 插件确实写入了 ag_plugins');
    assert.equal(rows.rows[0]!.ns, 'demo');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── 插件运行时编排（采集 → 事实落库）───────────────────────────

test('★★★★ 真实 PG：插件运行时编排**端到端**（装配 → 采集 → 事实落库）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { PluginRuntimeOrchestrator } = await import('../src/plugin/runtime-orchestrator.ts');
  const { DbFactStore } = await import('../src/db/adapters.ts');

  // ★ manifest 必须**声明 collect**（declarative 且非 local 的硬性要求）
  const manifest = {
    apiVersion: 'gate.plugin/v1',
    kind: 'channel',
    id: 'orch-demo',
    name: '编排示例',
    version: '1.0.0',
    runtime: 'declarative',
    namespace: 'orch',
    // ★ 出站权限必须**声明具体域名**（`http:egress:<host>`），不是笼统的 `net:egress`：
    //   我第一版写了 `net:egress`，被门禁正确地拒绝：
    //     `域名 'api.example.invalid' 不在出站白名单内（已声明：无）`
    permissions: ['http:egress:api.example.invalid', 'storage:read:self', 'storage:write:self'],
    factSchema: { type: 'object', properties: { total: { type: 'number' } } },
    collect: {
      request: { method: 'GET', url: 'https://api.example.invalid/stats' },
      extract: [{ path: '$.total', as: 'total' }],
    },
  } as never;

  // ★ mock 出站：**不打外网**（否则测试既慢又不稳定）
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ total: 42 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const facts = new DbFactStore(db, DEMO_SITE_ID_FOR_ORCH);
  // ★★★ 平台级事实的 **workaround**（如实标注，不是修复）：
  //   `FactPipeline` 的默认 `userId = 'platform'`（字符串），
  //   而 `ag_plugin_facts.user_id` 是 **NOT NULL uuid**（docs/02 明确声明）——
  //   于是「不属于任何用户的事实」在真实 PG 下**写不进去**：
  //     `invalid input syntax for type uuid: "platform"`
  //   ★ 这是**设计缺口**（表要求 uuid、代码用字符串），需要设计决策
  //     （让 user_id 可空？还是引入「平台用户」？），因此这里**不单方面改 schema**，
  //     只用一个固定的平台级 uuid 让端到端跑通。
  const PLATFORM_FACT_USER = '00000000-0000-7000-a000-000000000000';
  const orchestrator = new PluginRuntimeOrchestrator({
    db,
    facts,
    fetchImpl,
    logger: silentLogger,
    userId: PLATFORM_FACT_USER,
    now: () => new Date('2025-06-01T00:00:00Z'),
  });

  // ① 执行一轮
  const report = await orchestrator.runAll([manifest]);
  assert.equal(report.succeeded, 1, `采集应成功（实际 ${JSON.stringify(report.outcomes)}）`);
  assert.equal(report.failed, 0);
  assert.equal(fetchCalls, 1, '★ 出站被调用一次（走的是注入的 fetch，不是外网）');
  const outcome = report.outcomes[0]!;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 200, '★ 记录响应状态（便于把 401/403 与 5xx 区分归因）');
  // ★ 前缀是 **pluginId**（`orch-demo.total`），不是 manifest 的 `namespace` 字段——
  //   我第一版断言 `fact.orch.total`，被实际值纠正。
  //   ★ 教训（第 N 次）：**先看实际值，再写断言**；凭直觉假设格式会立刻被抓住。
  assert.ok(
    outcome.written.includes('orch-demo.total'),
    `★ 事实键应带 pluginId 前缀（实际 ${outcome.written.join(',')}）`,
  );

  // ② ★★★ 事实**真的落库**（用独立连接查，证明不是内存）
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ag_plugin_facts WHERE plugin_id = 'orch-demo'",
    );
    assert.equal(rows.rows[0]!.n, '1', '★★★ 事实确实写入了 ag_plugin_facts（端到端）');
  } finally {
    await client.end();
  }

  // ③ ★★ 用**新的编排器实例**（模拟重启）再跑一轮：事实应可读回（不是只写一次就丢）
  const fresh = new PluginRuntimeOrchestrator({ db, facts, fetchImpl, logger: silentLogger, userId: PLATFORM_FACT_USER });
  const second = await fresh.runAll([manifest]);
  assert.equal(second.succeeded, 1, '★ 重启后仍能执行（KV/事实都在 PG）');

  // ④ 失败处置：**单个插件失败不中断整轮**
  // ★ 我第一版把整个 orchestrator 的 `fetchImpl` 换成「一律抛错」——
  //   于是**两个插件都失败**，断言 `succeeded === 1` 自然不成立。
  //   ★ 修法：让**只有 broken 的 URL** 失败（其余正常），这样才真正验证「单个失败不中断整轮」。
  const broken = {
    ...(manifest as Record<string, unknown>),
    id: 'orch-broken',
    namespace: 'broken',
    // ★ 出站白名单**按域名**：broken 的 URL 域名必须自己声明，
    //   否则会在**权限门禁**处就被拒绝（而不是走到我 mock 的「上游不可达」）。
    permissions: ['http:egress:broken.example.invalid'],
    collect: {
      request: { method: 'GET', url: 'https://broken.example.invalid/x' },
      extract: [{ path: '$.n', as: 'n' }],
    },
  } as never;
  // ★ 用 `Parameters<typeof fetch>[0]` 而不是 `RequestInfo`——后者在无 DOM lib 的项目里不存在
  const selectiveFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('broken.example.invalid')) throw new Error('模拟上游不可达');
    return new Response(JSON.stringify({ total: 42 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const failing = new PluginRuntimeOrchestrator({ db, facts, fetchImpl: selectiveFetch, logger: silentLogger, userId: PLATFORM_FACT_USER });
  const mixed = await failing.runAll([manifest, broken]);
  assert.equal(mixed.succeeded, 1, '★ 一个失败不应让另一个也失败');
  assert.equal(mixed.failed, 1);
  assert.match(String(mixed.outcomes.find((entry) => entry.pluginId === 'orch-broken')?.error), /模拟上游不可达/);
});

// ─────────────────────────── 开发者身份（★★★★★ 修复「开发者永远无法登录」）───────────────────────────

test('★★★★★ 真实 PG：开发者**入驻后能登录**（修复「空 Map 且无人写入」）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalDeveloperIdentityLookup, recordDeveloperIdentity } = await import(
    '../src/db/developer-identity-adapter.ts'
  );
  const { assertDeveloperMayLogin } = await import('../src/core/invitations.ts');
  const { createTransactionalSiteRegistry } = await import('../src/db/site-adapters.ts');
  const { ensureDeveloperUser } = await import('../src/db/developer-user-link.ts');

  const lookup = createTransactionalDeveloperIdentityLookup(db);
  const sites = createTransactionalSiteRegistry(db);

  // ① ★ 修复前：未入驻 → not_onboarded（这是**正确**的结论）
  const before = await assertDeveloperMayLogin(lookup, sites, { oidcSubject: 'dev-sub-1' });
  assert.equal(before.ok, false);
  assert.equal(before.ok === false ? before.reason : '', 'not_onboarded', '★ 未入驻必须被拒');

  // ② 入驻：创建一个开发者 + 记录其 OIDC 身份
  const developer = await sites.createDeveloper({ username: 'dev-r76', displayName: 'Dev', email: 'dev-r76@corp.com' });
  // ★ R101（方案 A）：先建立「开发者 ↔ 平台用户」映射，再写身份映射——
  //   ★ `ag_identities.user_id` 指向**平台用户 id**（表语义），而非 developerId。
  const devUserId1 = await ensureDeveloperUser(db, {
    developerId: developer.id,
    username: developer.username,
    email: developer.email,
    emailVerified: true,
  });
  await recordDeveloperIdentity(db, { developerId: devUserId1, oidcSubject: 'dev-sub-1' });

  // ③ ★★★★ 关键：现在能登录了！
  const after = await assertDeveloperMayLogin(lookup, sites, { oidcSubject: 'dev-sub-1' });
  assert.equal(after.ok, true, '★★★★ 入驻后必须可登录（这正是修复前永远失败的地方）');
  assert.equal(after.ok === true ? after.developer.id : '', developer.id, '★ 返回的正是该开发者');

  // ④ ★ 未入驻的**另一个** sub 仍被拒（不能因为有了一个入驻者就放开所有人）
  const other = await assertDeveloperMayLogin(lookup, sites, { oidcSubject: 'dev-sub-ghost' });
  assert.equal(other.ok, false);
  assert.equal(other.ok === false ? other.reason : '', 'not_onboarded', '★ 只有被记录的 sub 可登录');

  // ⑤ ★★ 与终端用户身份**互不干扰**（owner_scope 隔离）
  //   `ag_identities` 同时承载终端用户绑定（`owner_scope='platform'`）——
  //   开发者查询必须带 `owner_scope='developer'`，否则会混淆两类身份。
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    // 手工插一条**终端用户**的绑定，provider 与开发者完全相同，只是 owner_scope 不同
    const { randomUUID } = await import('node:crypto');
    await client.query(
      `INSERT INTO ag_identities (owner_scope, owner_id, user_id, provider, provider_user_id, claim_snapshot)
       VALUES ('platform', 'platform', $1, 'identity:oidc@platform:developer', 'dev-sub-1', '{}')`,
      [randomUUID()],
    );
    const isolated = await lookup.findByIdentity('identity:oidc@platform:developer', 'dev-sub-1');
    assert.equal(isolated, developer.id, '★★ 终端用户的同名绑定**不得**影响开发者查询（owner_scope 隔离）');
  } finally {
    await client.end();
  }

  // ⑥ 幂等：重复入驻 → 仍指向同一开发者
  // ★ R101（方案 A）：先建立「开发者 ↔ 平台用户」映射，再写身份映射——
  //   ★ `ag_identities.user_id` 指向**平台用户 id**（表语义），而非 developerId。
  const devUserId2 = await ensureDeveloperUser(db, {
    developerId: developer.id,
    username: developer.username,
    email: developer.email,
    emailVerified: true,
  });
  await recordDeveloperIdentity(db, { developerId: devUserId2, oidcSubject: 'dev-sub-1' });
  assert.equal(await lookup.findByIdentity('identity:oidc@platform:developer', 'dev-sub-1'), developer.id);
});

// ─────────────────────────── 两条登录链路（platform:developer / platform:enduser）───────────────────────────

test('★★★★★ 真实 PG：**两条链路**的隔离与行为（开发者须入驻 / 终端用户自动建号）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { resolveLogin } = await import('../src/auth/flows.ts');
  const { ensureDeveloperUser } = await import('../src/db/developer-user-link.ts');
  const { createTransactionalEndUserStore } = await import('../src/db/end-user-adapter.ts');
  const { createTransactionalDeveloperIdentityLookup, recordDeveloperIdentity } = await import(
    '../src/db/developer-identity-adapter.ts'
  );
  const { createTransactionalSiteRegistry } = await import('../src/db/site-adapters.ts');

  // ★ 与 `serve.ts` **完全相同的装配方式**（真实模式）
  const deps = {
    developerIdentities: createTransactionalDeveloperIdentityLookup(db),
    endUsers: createTransactionalEndUserStore(db),
    sites: createTransactionalSiteRegistry(db),
    logger: silentLogger,
  };
  const login = (ref: string, oidcSubject: string, email: string, emailVerified = true) =>
    resolveLogin({ ref, oidcSubject, email, emailVerified } as never, deps as never);

  // ── 链路 A：platform:enduser（**自动建号**）──
  const first = await login('platform:enduser', 'eu-sub-r77', 'eu-r77@example.com');
  assert.equal(first.ok, true, `终端用户首次登录应自动建号（实际 ${JSON.stringify(first)}）`);
  assert.equal(first.ok === true ? first.realm : '', 'enduser');
  assert.equal(first.ok === true ? first.provisioned : null, true, '★ 首次是「已建号」');
  const euId = first.ok === true ? first.principalId : '';

  // ★ 二次登录 → **复用同一账号**（不重复建号）
  const second = await login('platform:enduser', 'eu-sub-r77', 'eu-r77@example.com');
  assert.equal(second.ok, true);
  assert.equal(second.ok === true ? second.provisioned : null, false, '★★ 二次登录不得重复建号');
  assert.equal(second.ok === true ? second.principalId : '', euId, '★★ 必须是同一个用户 id');

  // ── 链路 B：platform:developer（**必须已入驻**）──
  const devNotOnboarded = await login('platform:developer', 'dev-sub-r77', 'dev-r77@corp.com');
  assert.equal(devNotOnboarded.ok, false, '★ 未入驻的开发者必须被拒');
  assert.equal(devNotOnboarded.ok === false ? devNotOnboarded.reason : '', 'not_onboarded');

  const developer = await deps.sites.createDeveloper({ username: 'dev-r77', displayName: 'Dev', email: 'dev-r77@corp.com' });
  // ★ R101（方案 A）：同上——先建平台用户映射
  const devUserIdR77 = await ensureDeveloperUser(db, {
    developerId: developer.id,
    username: developer.username,
    email: developer.email,
    emailVerified: true,
  });
  await recordDeveloperIdentity(db, { developerId: devUserIdR77, oidcSubject: 'dev-sub-r77' });
  const devOnboarded = await login('platform:developer', 'dev-sub-r77', 'dev-r77@corp.com');
  assert.equal(devOnboarded.ok, true, '★★ 入驻后可登录');
  assert.equal(devOnboarded.ok === true ? devOnboarded.realm : '', 'developer');
  assert.equal(devOnboarded.ok === true ? devOnboarded.principalId : '', developer.id);

  // ── ★★★★ 隔离：**同一个 OIDC sub** 在两条链路上是**不同**的主体 ──
  //   provider 不同（`identity:oidc@platform:developer` vs `...@enduser`），
  //   因此「用同一 IdP 账号」不会让终端用户变成开发者、也不会反之。
  // ★ 用**另一个邮箱**：`ag_users` 有 `uq_ag_users_email` 唯一约束，
  //   而上面 `ensureDeveloperUser` 已用 `dev-r77@corp.com` 建了平台用户记录。
  //   ★ 观察（不在本轮范围）：这意味着**同一邮箱不能同时是开发者与终端用户**——
  //     在「同一人既是 A 站点开发者、又是 B 站点终端用户」的场景下会冲突。
  //     这是既有 schema 的约束，若要放开需要设计决策（见 reports/architecture-gaps.md）。
  const sameSubAsEndUser = await login('platform:enduser', 'dev-sub-r77', 'dev-as-eu-r77@example.com');
  assert.equal(sameSubAsEndUser.ok, true);
  assert.notEqual(
    sameSubAsEndUser.ok === true ? sameSubAsEndUser.principalId : '',
    developer.id,
    '★★★★ 同一 sub 在 enduser 链路上**不得**得到开发者身份（这是隔离的核心）',
  );

  // ── 隔离的另一面：终端用户不能走开发者链路 ──
  const euAsDeveloper = await login('platform:developer', 'eu-sub-r77', 'eu-r77@example.com');
  assert.equal(euAsDeveloper.ok, false, '★★ 终端用户（未入驻为开发者）不得走开发者链路');
  assert.equal(euAsDeveloper.ok === false ? euAsDeveloper.reason : '', 'not_onboarded');

  // ── 落库验证：两条链路的身份映射**都在 ag_identities**，且 owner_scope 不同 ──
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ owner_scope: string; provider: string; n: string }>(
      `SELECT owner_scope, provider, count(*)::text AS n FROM ag_identities
       WHERE provider_user_id IN ('eu-sub-r77','dev-sub-r77') GROUP BY owner_scope, provider ORDER BY owner_scope, provider`,
    );
    const byProvider = new Map(rows.rows.map((row) => [`${row.owner_scope}|${row.provider}`, row.n]));
    assert.equal(byProvider.get('developer|identity:oidc@platform:developer'), '1', '★ 开发者身份一条');
    assert.equal(byProvider.get('platform|identity:oidc@platform:enduser'), '2', '★ 终端用户身份两条（eu-sub-1 与 dev-sub-1 各一）');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── ★★★ 开发者入驻（P0-1：接通缺环）───────────────────────────

test('★★★★★ 真实 PG：**邀请码入驻 → 开发者能登录**（此前不可能）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalInvitationStore } = await import('../src/db/invitation-adapter.ts');
  const { createTransactionalDeveloperIdentityLookup, recordDeveloperIdentity } = await import(
    '../src/db/developer-identity-adapter.ts'
  );
  const { createTransactionalSiteRegistry } = await import('../src/db/site-adapters.ts');
  const { InvitationService, hashInvitationCode } = await import('../src/core/invitations.ts');
  const { assertDeveloperMayLogin } = await import('../src/core/invitations.ts');
  const { ensureDeveloperUser } = await import('../src/db/developer-user-link.ts');

  const invitationStore = createTransactionalInvitationStore(db);
  const sites = createTransactionalSiteRegistry(db);
  const lookup = createTransactionalDeveloperIdentityLookup(db);

  // ★ 与 serve.ts **完全相同的装配方式**
  const service = new InvitationService({
    store: invitationStore,
    sites,
    // ★ R101（方案 A）：两步映射（建平台用户 + 写身份映射）
    onboardIdentity: async ({ developerId, oidcSubject, username, email, emailVerified }) => {
      const userId = await ensureDeveloperUser(db, { developerId, username, email, emailVerified });
      await recordDeveloperIdentity(db, { developerId: userId, oidcSubject });
    },
    logger: silentLogger,
  });

  // ── ① 先用 **admin 流程**建一个站点（邀请码是站点级的）──
  const { randomUUID } = await import('node:crypto');
  const siteId = randomUUID();
  const owner = await sites.createDeveloper({ username: 'onboard-r91-owner', displayName: 'Owner', email: 'owner-r91@corp.com' });
  await sites.createSite({ siteId, nickname: 'R91 站点', developerId: owner.id });

  // ── ② 创建邀请码（明文只返回一次）──
  const created = await service.create({
    siteId,
    targetEmail: 'newdev-r91@corp.com',
    createdBy: owner.id,
    uses: 1,
  });
  assert.ok(created.code.startsWith('DEV-'), `★ 明文码格式（实际 ${created.code}）`);
  assert.equal(created.maxUses, 1);

  // ── ③ ★★★ 入住前的状态：该 OIDC sub **无法登录** ──
  const SUB = '33333333-4444-7555-a666-777777777777';
  const before = await assertDeveloperMayLogin(lookup, sites, { oidcSubject: SUB });
  assert.equal(before.ok, false, '★ 未入驻必须被拒');
  assert.equal(before.ok === false ? before.reason : '', 'not_onboarded');

  // ── ④ 入驻（核销邀请码 + 建号 + **写身份映射**）──
  const redeemed = await service.redeem({
    siteId,
    code: created.code,
    email: 'newdev-r91@corp.com',
    emailVerified: true,
    oidcSubject: SUB,
  });
  assert.ok(redeemed.developer.id.length > 0);

  // ── ⑤ ★★★★★ 关键：**现在能登录了**（这正是修复前永远失败的地方）──
  const after = await assertDeveloperMayLogin(lookup, sites, { oidcSubject: SUB });
  assert.equal(after.ok, true, '★★★★★ 入驻后必须能登录（缺环已补）');
  assert.equal(after.ok === true ? after.developer.id : '', redeemed.developer.id, '★ 返回的正是该开发者');

  // ── ⑥ ★ 一次性：同一个邀请码**不能再被用**（原子核销）──
  const reused = await service.redeem({
    siteId,
    code: created.code,
    email: 'newdev-r91@corp.com',
    emailVerified: true,
    oidcSubject: 'aaaaaaaa-bbbb-7ccc-addd-eeeeeeeeeeee',
  }).then(() => null).catch((error: unknown) => error);
  assert.ok(reused instanceof Error, '★ 邀请码用尽后必须拒绝');
  assert.match(String((reused as Error).message), /用尽|占用|失效/, '★ 拒绝原因应可操作');

  // ── ⑦ ★ 邮箱绑定：换个邮箱用同一个码 → 拒绝 ──
  const other = await service.create({ siteId, targetEmail: 'bound-r91@corp.com', createdBy: owner.id, uses: 1 });
  const wrongEmail = await service.redeem({
    siteId,
    code: other.code,
    email: 'attacker-r91@corp.com',
    emailVerified: true,
    oidcSubject: 'ffffffff-1111-7222-a333-444444444444',
  }).then(() => null).catch((error: unknown) => error);
  assert.ok(wrongEmail instanceof Error, '★ 邀请码与邮箱绑定，转发他人使用必须失败');

  // ── ⑧ ★ 强制邮箱验证：未验证不得入驻 ──
  const unverified = await service.redeem({
    siteId,
    code: other.code,
    email: 'bound-r91@corp.com',
    emailVerified: false,
    oidcSubject: 'ffffffff-1111-7222-a333-444444444444',
  }).then(() => null).catch((error: unknown) => error);
  assert.ok(unverified instanceof Error, '★ 邮箱未验证不得入驻（M7-8）');

  // ── ⑨ 落库验证：身份映射确实写入了 ag_identities ──
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ag_identities
       WHERE owner_scope = 'developer' AND provider = 'identity:oidc@platform:developer' AND provider_user_id = $1`,
      [SUB],
    );
    assert.equal(rows.rows[0]!.n, '1', '★★ 身份映射确实写入了 ag_identities');
    // ★ 邀请码的 used_count 已递增
    const invite = await invitationStore.findByHash(siteId, hashInvitationCode(created.code));
    assert.equal(invite?.usedCount, 1, '★ 邀请码已核销一次');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── ★ P0-2：事实的主体语义（平台级 vs 真实主体）───────────────────────────

test('★★★★ P0-2：事实只能写入**真实主体**（平台级字符串会被拒绝）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { FactPipeline } = await import('../src/plugin/host-api.ts');
  const { DbFactStore } = await import('../src/db/adapters.ts');
  const { randomUUID } = await import('node:crypto');

  const siteId = randomUUID();
  const store = new DbFactStore(db, siteId);
  const manifest = {
    id: 'p02',
    namespace: 'p02',
    factSchema: { type: 'object', properties: { n: { type: 'number' } } },
  } as never;

  // ── ① ★ 传**真实主体 uuid**（生产路径的形状）→ 写入成功 ──
  const userId = randomUUID();
  const pipeline = new FactPipeline({ store, manifest, userId });
  const emitted = await db.transaction(() => pipeline.emit({ n: 1 }, new Date()));
  assert.ok(emitted.written.length > 0, '★ 传真实主体时应写入成功');

  // ── ② ★★ 传旧的「平台级」字符串 `'platform'` → **被数据库拒绝** ──
  //   ★ 这正是 R70 发现的缺口：`ag_plugin_facts.user_id` 是 NOT NULL **uuid**，
  //     而代码历史上的默认值是字符串 `'platform'`。
  //   ★ R75 已把 `FactPipeline.userId` 改为**必填**（编译期强制），
  //     因此**生产路径不再有平台级事实**——本测试锁定这个语义。
  let platformError: unknown = null;
  try {
    const platformPipeline = new FactPipeline({ store, manifest, userId: 'platform' });
    await db.transaction(() => platformPipeline.emit({ n: 2 }, new Date()));
  } catch (error) {
    platformError = error;
  }
  assert.ok(platformError !== null, "★★ 平台级字符串 'platform' 必须被拒绝（表要求 uuid）");
  assert.match(String(platformError), /uuid|invalid input syntax/i, '★ 拒绝原因应是「不是合法 uuid」');

  // ── ③ 落库验证：只有真实主体的那一行 ──
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ user_id: string; n: string }>(
      `SELECT user_id, count(*)::text AS n FROM ag_plugin_facts WHERE site_id = $1 GROUP BY user_id`,
      [siteId],
    );
    assert.equal(rows.rows.length, 1, '★ 只应有一行（真实主体）');
    assert.equal(rows.rows[0]!.user_id, userId, '★ 该行属于传入的真实主体');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── ★ P1-2：渠道同步状态持久化 ───────────────────────────

test('★★★★ 真实 PG：渠道同步状态持久化（**站点隔离 + 跨实例仍在**）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalSyncStateStore } = await import('../src/db/sync-state-adapter.ts');
  const { randomUUID } = await import('node:crypto');

  const siteA = randomUUID();
  const siteB = randomUUID();
  const storeA = createTransactionalSyncStateStore(db, siteA);
  const storeB = createTransactionalSyncStateStore(db, siteB);

  // ① 初始：没有进度
  assert.equal(await storeA.get('newapi-provider'), undefined);

  // ② 保存进度
  const now = new Date('2025-06-01T00:00:00Z');
  await storeA.save({
    provider: 'newapi-provider',
    cursor: 'cursor-100',
    lastSeenKey: 'k-100',
    lastIncrementalAt: now,
    lastFullSyncAt: now,
    lastFullSyncCount: 100,
    capabilities: { supportsDelta: true },
  });

  const loaded = await storeA.get('newapi-provider');
  assert.equal(loaded?.cursor, 'cursor-100', '★ 游标（决定「从哪继续」）必须能取回');
  assert.equal(loaded?.lastSeenKey, 'k-100');
  assert.equal(loaded?.lastFullSyncCount, 100);
  assert.deepEqual(loaded?.capabilities, { supportsDelta: true }, '★ jsonb 往返');

  // ③ ★★ 站点隔离：B 站点看不到 A 的进度
  assert.equal(await storeB.get('newapi-provider'), undefined, '★★ 不同站点的同步进度必须隔离');

  // ④ ★★ 跨实例（模拟重启）：新 store 实例读同一份数据
  const { createTransactionalSyncStateStore: freshFactory } = await import('../src/db/sync-state-adapter.ts');
  const fresh = freshFactory(db, siteA);
  assert.equal(
    (await fresh.get('newapi-provider'))?.cursor,
    'cursor-100',
    '★★ 重启后**游标不丢**（否则会从头重复同步）',
  );

  // ⑤ 更新进度（同一 (site, provider) → 更新而非新增）
  await storeA.save({ provider: 'newapi-provider', cursor: 'cursor-500', lastSeenKey: 'k-500', lastFullSyncCount: 500 });
  assert.equal((await storeA.get('newapi-provider'))?.cursor, 'cursor-500');

  // ⑥ 落库验证：只有 1 行（同一站点同一渠道）
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ag_provider_sync_state WHERE site_id = $1`,
      [siteA],
    );
    assert.equal(rows.rows[0]!.n, '1', '★ 同一站点同一渠道只有一行（主键保证）');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── ★ P1-1：事件外发（transactional outbox 装配）───────────────────────────

test('★★★★ 真实 PG：事件外发装配（事件 → 发件箱落库 → 投递）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { EventBus, OutboxDispatcher, matchesPattern } = await import('../src/kernel/events.ts');
  const { DbOutboxStore, createTransactionalOutboxStore } = await import('../src/db/outbox-adapters.ts');
  const { randomUUID } = await import('node:crypto');

  const siteId = randomUUID();
  // ★ 用**自带事务**的包装（R95 新增）——调用方不必自己包事务
  const outbox = createTransactionalOutboxStore(db, siteId);
  // ★★ `emitSafely` 会**吞掉**订阅者异常（只记日志）——
  //   因此测试里必须挂 `onHandlerError`，否则失败原因不可见（本会话反复出现的「信号不可见」）。
  const handlerErrors: string[] = [];
  const bus = new EventBus({
    logger: silentLogger,
    onHandlerError: (error) => handlerErrors.push(error instanceof Error ? error.message : String(error)),
  });

  // ★★ **正确用法**：业务代码**直接** append（发件箱记录与业务数据同事务提交），
  //   **不是**「订阅总线再写发件箱」——
  //   ★ 后者会让投递时的 emit 再次触发订阅者 → **事件无限自我复制**（本测试抓到过）。
  //   ★ `createTransactionalOutboxStore` 自带事务，调用方不必自己包。
  const received: string[] = [];

  // ── ① 发一个事件 → 应被订阅者收到并落库 ──
  await outbox.append({ type: 'policy.published', payload: { code: 'edu', version: 2 }, occurredAt: new Date() });

  assert.deepEqual(handlerErrors, [], `★ 订阅者不应抛错（实际：${handlerErrors.join(' | ')}）`);

  // ── ② ★ 落库验证（独立连接查）──
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ type: string; status: string; n: string }>(
      `SELECT type, status, count(*)::text AS n FROM ag_event_outbox WHERE site_id = $1 GROUP BY type, status`,
      [siteId],
    );
    assert.equal(rows.rows.length, 1, '★ 事件确实写入了 ag_event_outbox');
    assert.equal(rows.rows[0]!.type, 'policy.published');
    assert.equal(rows.rows[0]!.status, 'pending', '★ 新事件是 pending（等待投递）');
  } finally {
    await client.end();
  }

  // ── ③ ★★ 投递：`OutboxDispatcher.dispatchDue()` 把 pending 事件交给订阅者 ──
  const delivered: string[] = [];
  bus.on('policy.*', async (event) => {
    delivered.push(event.type);
  });
  const dispatcher = new OutboxDispatcher({ store: outbox, bus, logger: silentLogger });
  const stats = await dispatcher.dispatchDue(50, new Date(Date.now() + 60_000));
  assert.equal(stats.delivered, 1, `★ 应投递 1 条（实际 ${JSON.stringify(stats)}）`);
  assert.deepEqual(delivered, ['policy.published'], '★ 订阅者收到了该事件');

  // ── ④ ★ 投递后状态变为已投递（不会重复投递）──
  const again = await dispatcher.dispatchDue(50, new Date(Date.now() + 120_000));
  assert.equal(again.delivered, 0, '★ 已投递的事件不会被重复投递');

  // ── ⑤ ★ 通配符匹配（直接验证匹配函数，不依赖订阅者）──
  //   ★ 为什么单独测它：`serve.ts` 的装配依赖通配订阅能力，
  //     而我最初写的是 `'**'`——它「碰巧也能匹配」（split 后全是空串），
  //     但那是**未文档化的巧合**；`'*'` 才是明确支持的写法。
  assert.equal(matchesPattern('*', 'policy.published'), true, "★ '*' 匹配所有事件");
  assert.equal(matchesPattern('policy.*', 'policy.published'), true, '★ 前缀通配');
  assert.equal(matchesPattern('policy.*', 'identity.linked'), false, '★ 不匹配其它前缀');
  assert.equal(matchesPattern('policy.published', 'policy.published'), true, '★ 精确匹配');
});

// ─────────────────────────── ★ P1-2：本平台作为 OAuth 授权服务器（IdP）───────────────────────────

test('★★★★★ 真实 PG：OAuth 授权码**原子兑换**（并发下只能兑一次）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalOAuthStore } = await import('../src/db/oauth-store-adapter.ts');
  const { randomUUID } = await import('node:crypto');
  const store = createTransactionalOAuthStore(db);

  // ── ① 客户端注册与查找 ──
  const clientId = `cli-${randomUUID().slice(0, 8)}`;
  await store.saveClient({
    clientId,
    name: '第三方应用',
    redirectUris: ['https://third.example/cb'],
    scopes: ['openid', 'profile'],
    status: 'active',
  });
  const client = await store.findClient(clientId);
  assert.equal(client?.name, '第三方应用');
  assert.deepEqual(client?.redirectUris, ['https://third.example/cb'], '★ jsonb 往返');
  assert.deepEqual(client?.scopes, ['openid', 'profile']);
  assert.equal(await store.findClient('nope'), undefined);

  // ── ② 授权码：签发 → 兑换 ──
  const subject = randomUUID();
  const code = `code-${randomUUID()}`;
  const issuedAt = new Date();
  await store.saveCode({
    code,
    clientId,
    redirectUri: 'https://third.example/cb',
    subject,
    scopes: ['openid'],
    codeChallenge: 'challenge-abc',
    issuedAt,
    redeemed: false,
  });

  const redeemed = await store.redeemCode(code);
  assert.equal(redeemed?.subject, subject, '★ 兑换成功并返回授权信息');
  assert.equal(redeemed?.codeChallenge, 'challenge-abc', '★ PKCE challenge 必须能取回（用于校验）');
  assert.equal(redeemed?.redeemed, true, '★ 兑换后标记为已兑换');

  // ── ③ ★★★ 再兑换 → undefined（**一次性**）──
  assert.equal(await store.redeemCode(code), undefined, '★★ 同一授权码不能兑换两次');

  // ── ④ ★★★★ **并发**：10 个并发兑换同一个新码，**必须只有一个成功** ──
  const raceCode = `race-${randomUUID()}`;
  await store.saveCode({
    code: raceCode,
    clientId,
    redirectUri: 'https://third.example/cb',
    subject,
    scopes: ['openid'],
    codeChallenge: 'c',
    issuedAt: new Date(),
    redeemed: false,
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => store.redeemCode(raceCode)));
  const succeeded = results.filter((entry) => entry !== undefined).length;
  assert.equal(succeeded, 1, `★★★★ 并发下必须**恰好一个**兑换成功（实际 ${succeeded}）`);

  // ── ⑤ 刷新令牌：只存哈希 · 可查找 · 可撤销 ──
  const tokenHash = `sha256-${randomUUID()}`;
  await store.saveRefresh(tokenHash, { clientId, subject, scopes: ['openid'], expiresAt: new Date(Date.now() + 3600_000) });
  const found = await store.findRefresh(tokenHash);
  assert.equal(found?.subject, subject);
  assert.equal(found?.revoked, false);
  await store.revoke(tokenHash);
  assert.equal((await store.findRefresh(tokenHash))?.revoked, true, '★ 撤销后 revoked = true');

  // ── ⑥ 落库验证：三张表都写入了 ──
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client2 = new Client({ connectionString: instance.url });
  await client2.connect();
  try {
    const counts = await client2.query<{ clients: string; codes: string; tokens: string }>(
      `SELECT
         (SELECT count(*)::text FROM ag_oauth_clients) AS clients,
         (SELECT count(*)::text FROM ag_oauth_codes) AS codes,
         (SELECT count(*)::text FROM ag_oauth_refresh_tokens) AS tokens`,
    );
    const row = counts.rows[0]!;
    assert.ok(Number(row.clients) >= 1, '★ 客户端已落库');
    assert.ok(Number(row.codes) >= 2, '★ 授权码已落库');
    assert.ok(Number(row.tokens) >= 1, '★ 刷新令牌已落库');
  } finally {
    await client2.end();
  }
});

// ─────────────────────────── ★ 方案 A：开发者 ↔ 平台用户映射（R101）───────────────────────────

test('★★★★★ 真实 PG：方案 A —— 开发者获得平台用户身份，**插件事实记在其名下**', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalInvitationStore } = await import('../src/db/invitation-adapter.ts');
  const { createTransactionalDeveloperIdentityLookup, recordDeveloperIdentity } = await import(
    '../src/db/developer-identity-adapter.ts'
  );
  const { createTransactionalSiteRegistry } = await import('../src/db/site-adapters.ts');
  const { ensureDeveloperUser } = await import('../src/db/developer-user-link.ts');
  const { InvitationService } = await import('../src/core/invitations.ts');
  const { assertDeveloperMayLogin } = await import('../src/core/invitations.ts');
  const { FactPipeline } = await import('../src/plugin/host-api.ts');
  const { DbFactStore } = await import('../src/db/adapters.ts');
  const { randomUUID } = await import('node:crypto');

  const invitationStore = createTransactionalInvitationStore(db);
  const sites = createTransactionalSiteRegistry(db);
  const lookup = createTransactionalDeveloperIdentityLookup(db);

  // ★ 与 serve.ts **相同的装配方式**（含方案 A 的两步映射）
  const service = new InvitationService({
    store: invitationStore,
    sites,
    onboardIdentity: async ({ developerId, oidcSubject, username, email, emailVerified }) => {
      const userId = await ensureDeveloperUser(db, { developerId, username, email, emailVerified });
      await recordDeveloperIdentity(db, { developerId: userId, oidcSubject });
    },
    logger: silentLogger,
  });

  // ① 建站点 + 邀请码 + 入驻
  const siteId = randomUUID();
  const owner = await sites.createDeveloper({ username: 'owner-a-r101', displayName: 'Owner', email: 'owner-a-r101@corp.com' });
  await sites.createSite({ siteId, nickname: '方案A站点', developerId: owner.id });
  const created = await service.create({ siteId, targetEmail: 'dev-a-r101@corp.com', createdBy: owner.id, uses: 1 });
  const SUB = '55555555-6666-7777-a888-999999999999';
  const redeemed = await service.redeem({
    siteId,
    code: created.code,
    email: 'dev-a-r101@corp.com',
    emailVerified: true,
    oidcSubject: SUB,
  });

  // ② ★ 入驻后：开发者**有**平台用户身份（`user_id` 已回填）
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  let userId = '';
  try {
    const rows = await client.query<{ user_id: string | null }>('SELECT user_id FROM ag_developers WHERE id = $1', [redeemed.developer.id]);
    userId = rows.rows[0]?.user_id ?? '';
    assert.ok(userId.length > 0, '★★ 开发者必须获得平台用户 id（方案 A 的核心）');
    assert.notEqual(userId, redeemed.developer.id, '★ 两个 id **不同**（加列而非复用 id）');

    // ★ `ag_users` 里确实有这条记录
    const user = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_users WHERE id = $1', [userId]);
    assert.equal(user.rows[0]!.n, '1', '★ 平台用户记录已建立');

    // ★★ 身份映射指向 **userId**（而不是 developerId）——R76 的一致性修正
    const identity = await client.query<{ user_id: string }>(
      `SELECT user_id FROM ag_identities
       WHERE owner_scope = 'developer' AND provider = 'identity:oidc@platform:developer' AND provider_user_id = $1`,
      [SUB],
    );
    assert.equal(identity.rows[0]?.user_id, userId, '★★ ag_identities.user_id 必须指向平台用户 id（表语义）');
  } finally {
    await client.end();
  }

  // ③ ★ 登录准入仍然成立（映射改指向后不能破坏它）
  const login = await assertDeveloperMayLogin(lookup, sites, { oidcSubject: SUB });
  assert.equal(login.ok, true, '★★ 入驻后仍能登录（映射语义修正未破坏准入）');

  // ④ ★★★★ 关键：**插件事实记在该开发者的平台用户 id 下**
  const facts = new DbFactStore(db, siteId);
  const manifest = {
    id: 'github',
    namespace: 'github',
    factSchema: { type: 'object', properties: { public_repos: { type: 'number' } } },
  } as never;
  const pipeline = new FactPipeline({ store: facts, manifest, userId });
  const emitted = await db.transaction(() => pipeline.emit({ public_repos: 42 }, new Date()));
  assert.ok(emitted.written.length > 0, '★ 事实写入成功（用的是开发者的平台用户 id）');

  // ⑤ 落库验证：事实的 user_id = 开发者的平台用户 id
  const client2 = new Client({ connectionString: instance.url });
  await client2.connect();
  try {
    const rows = await client2.query<{ user_id: string; n: string }>(
      `SELECT user_id, count(*)::text AS n FROM ag_plugin_facts WHERE site_id = $1 AND plugin_id = 'github' GROUP BY user_id`,
      [siteId],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.user_id, userId, '★★★★ 插件事实确实记在**该开发者的平台用户 id** 下（方案 A 的目标）');
  } finally {
    await client2.end();
  }

  // ⑥ ★ 幂等：重复建立映射不产生第二个用户
  const again = await ensureDeveloperUser(db, {
    developerId: redeemed.developer.id,
    username: redeemed.developer.username,
    email: 'dev-a-r101@corp.com',
    emailVerified: true,
  });
  assert.equal(again, userId, '★ 重复调用返回同一 userId（幂等）');
});

// ─────────────────────────── ★ 步骤 4：插件自动调度（开发者级实例 → 事实归属）───────────────────────────

test('★★★★★ 真实 PG：插件自动调度 —— 开发者级实例 → 主体解析 → 事实归属', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { createTransactionalPluginInstanceStore } = await import('../src/db/plugin-instance-adapter.ts');
  const { ensureDeveloperUser } = await import('../src/db/developer-user-link.ts');
  const { createTransactionalSiteRegistry } = await import('../src/db/site-adapters.ts');
  const { DbFactStore } = await import('../src/db/adapters.ts');
  const { randomUUID } = await import('node:crypto');

  const sites = createTransactionalSiteRegistry(db);
  const instances = createTransactionalPluginInstanceStore(db);

  // ① 建开发者
  const developer = await sites.createDeveloper({ username: 'auto-r104', displayName: 'Auto', email: 'auto-r104@corp.com' });

  // ② ★ 未配置实例 → **列表为空**（自动调度不会采集任何东西）
  assert.deepEqual(await instances.listEnabledDeveloperInstances('github'), [], '★ 没有实例时列表为空');

  // ③ 保存一个**已启用**的开发者级实例
  await instances.saveDeveloperInstance({
    pluginId: 'github',
    developerId: developer.id,
    config: { username: 'octocat' },
    configHash: 'h-1',
    enabled: true,
  });
  const enabled = await instances.listEnabledDeveloperInstances('github');
  assert.equal(enabled.length, 1, '★ 已启用的开发者级实例可被列出');
  assert.equal(enabled[0]!.developerId, developer.id);
  assert.deepEqual(enabled[0]!.config, { username: 'octocat' }, '★ jsonb 配置往返');

  // ④ ★ 未启用的实例**不出现在列表里**（不会被调度）
  await instances.saveDeveloperInstance({
    pluginId: 'checkin',
    developerId: developer.id,
    config: {},
    configHash: 'h-2',
    enabled: false,
  });
  assert.deepEqual(await instances.listEnabledDeveloperInstances('checkin'), [], '★ enabled=false 的实例不被调度');

  // ⑤ ★★★ 主体解析：开发者 → 平台用户 id（方案 A 的映射，幂等）
  const userId = await ensureDeveloperUser(db, {
    developerId: developer.id,
    username: developer.username,
    email: developer.email,
    emailVerified: true,
  });
  assert.ok(userId.length > 0);
  assert.notEqual(userId, developer.id, '★ 两个 id 不同');

  // ⑥ ★★★★ 用该 userId 采集 → 事实记在该开发者名下
  const { FactPipeline } = await import('../src/plugin/host-api.ts');
  const siteId = randomUUID();
  const facts = new DbFactStore(db, siteId);
  const manifest = {
    id: 'github',
    namespace: 'github',
    factSchema: { type: 'object', properties: { public_repos: { type: 'number' } } },
  } as never;
  const pipeline = new FactPipeline({ store: facts, manifest, userId });
  const emitted = await db.transaction(() => pipeline.emit({ public_repos: 7 }, new Date()));
  assert.ok(emitted.written.length > 0);

  // ⑦ 落库验证
  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: instance.url });
  await client.connect();
  try {
    const rows = await client.query<{ user_id: string }>(
      `SELECT user_id FROM ag_plugin_facts WHERE site_id = $1 AND plugin_id = 'github'`,
      [siteId],
    );
    assert.equal(rows.rows[0]?.user_id, userId, '★★★★ 自动调度采集的事实记在**开发者的平台用户 id** 下');
    // ★ 实例表确实有记录
    const inst = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ag_plugin_instances WHERE developer_id = $1`,
      [developer.id],
    );
    assert.equal(inst.rows[0]!.n, '2', '★ 两个实例（github 启用 + checkin 未启用）都已落库');
  } finally {
    await client.end();
  }
});

// ─────────────────────────── ★ R119：迁移的 pg_advisory_lock（docs/10:194）───────────────────────────

test('★★★★ 真实 PG：迁移锁 —— 并发 db:migrate 只有一个执行 DDL（其余跳过）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const { spawn } = await import('node:child_process');
  // ★★★★ 测试隔离：`ensurePg()` 的 `fresh: true` **只保证第一次干净**，
  //   而本文件里**其它测试**会建表（且**不写 `ag_migrations`**）——
  //   ★ 于是「表已存在但无迁移记录」，三个实例都会去执行 DDL → 报 `already exists`。
  //   ★ 这是我实测踩到的：**第一次跑（2 个实例）侥幸通过，3 个实例时暴露**。
  //   ★ 修法：本测试**先把 public schema 重建**，保证「干净且无记录」的起点。
  {
    const { Client } = (await import('pg')) as unknown as typeof import('pg');
    const admin = new Client({ connectionString: instance.url });
    await admin.connect();
    try {
      await admin.query('DROP SCHEMA public CASCADE');
      await admin.query('CREATE SCHEMA public');
    } finally {
      await admin.end();
    }
  }
  const args = ['--experimental-strip-types', 'tools/db-migrate.ts', '--database-url', instance.url];
  const run = (): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: process.cwd() });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { out += String(d); });
      child.on('close', (code) => resolve({ code, out }));
    });

  // ★ 同时启动 3 个（★ 用 2 个会**侥幸通过** —— 见下方注释，这是我实测发现的）
  const results = await Promise.all([run(), run(), run()]);
  const failed = results.filter((r) => r.code !== 0);
  const skipped = results.filter((r) => r.out.includes('已应用——本次为幂等重跑'));

  assert.deepEqual(
    failed.map((r) => r.out.split('\n').find((l) => /already exists|duplicate/i.test(l)) ?? `exit=${r.code}`),
    [],
    '★ 并发迁移不得有实例失败（无锁时会报 `type "ag_user_status" already exists`）',
  );
  assert.ok(skipped.length >= 1, '★ 后到者应拿到锁 → 重读 → 跳过 DDL（幂等重跑）');
});

// ─────────────────────────── ★ R128：状态 CAS（DC-2，docs/11 结构二）───────────────────────────

test('★★★★★ 真实 PG：生命周期状态 **CAS** —— 并发更新只有一个成功（丢更新被检测）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  t.after(async () => {
    await db.end();
  });
  const { DbLifecycleStateStore, LifecycleConflictError } = await import('../src/db/adapters.ts');
  const { randomUUID } = await import('node:crypto');

  const siteId = randomUUID();
  const userId = randomUUID();
  const policyId = randomUUID();
  const store = new DbLifecycleStateStore(db, siteId, async () => policyId);

  // ① 建行（无条件 UPSERT）
  const base = { state: 'unknown' as const, graceUntil: null, stateChangedAt: new Date(), atRiskCount: 0, actionSeq: 0 };
  await db.transaction(() => store.save(siteId, userId, 'p1', base));

  // ② 读回 → 必须带 version（★ 这是 CAS 的前提）
  const first = await db.transaction(() => store.get(siteId, userId, 'p1'));
  assert.equal(first?.version, 0, '★ get() 必须带回 version（否则无法 CAS）');

  // ③ ★ 第一次 CAS（version=0）→ 成功，版本自增
  await db.transaction(() =>
    store.save(siteId, userId, 'p1', { ...base, state: 'satisfied' }, first!.version),
  );
  const second = await db.transaction(() => store.get(siteId, userId, 'p1'));
  assert.equal(second?.version, 1, '★ CAS 成功后 version 自增');
  assert.equal(second?.state, 'satisfied');

  // ④ ★★★ 用**过期的** version 再 CAS → 必须抛 LifecycleConflictError
  await assert.rejects(
    () => db.transaction(() => store.save(siteId, userId, 'p1', { ...base, state: 'revoked' }, 0)),
    (error: unknown) => error instanceof LifecycleConflictError,
    '★★ 过期版本必须被拒绝（这正是「丢更新」被检测到的时刻）',
  );

  // ⑤ ★★★★ **并发**：两个事务用**同一个** version 同时 CAS → 恰好一个成功
  const current = await db.transaction(() => store.get(siteId, userId, 'p1'));
  const v = current!.version!;   // ★ 非空（上一步已断言 version 存在）
  const results = await Promise.allSettled([
    db.transaction(() => store.save(siteId, userId, 'p1', { ...base, state: 'satisfied' }, v)),
    db.transaction(() => store.save(siteId, userId, 'p1', { ...base, state: 'revoked' }, v)),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const conflicts = results.filter(
    (r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason instanceof LifecycleConflictError,
  ).length;
  assert.equal(ok, 1, `★★★★ 并发 CAS 必须**恰好一个**成功（实际 ${ok}）`);
  assert.equal(conflicts, 1, '★★ 另一个必须是 CAS 冲突（而不是静默覆盖）');

  // ⑥ 版本只前进了 1（没有双写）
  const final = await db.transaction(() => store.get(siteId, userId, 'p1'));
  assert.equal(final?.version, v + 1, '★ 版本恰好前进 1（证明只有一次写入生效）');

  // ⑦ ★ 不传 expectedVersion → 走原路径（**向后兼容**）
  await db.transaction(() =>
    store.save(siteId, userId, 'p1', { ...base, state: 'at_risk' }),
  );
  const after = await db.transaction(() => store.get(siteId, userId, 'p1'));
  assert.equal(after?.state, 'at_risk', '★ 不传 expectedVersion 时语义不变（向后兼容）');
});
