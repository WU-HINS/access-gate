/**
 * 存储装配与生产配置自查验收（判据 #2 的收口）。
 *
 * 断言重点：
 *   - **拒绝静默降级**：`mode=postgres` 缺 db / 缺 resolvePolicyId 时**抛错**，
 *     绝不回落到内存（否则「以为在用 PG 其实在用内存」会在重启时丢掉**幂等记录** → 重复写下游）；
 *   - **生产配置 fail-fast**：缺 DATABASE_URL / OIDC / Secure Cookie 时一次性列全并拒绝启动；
 *   - **demo 模式必须显式开启**（内置假 IdP 不做验签）；
 *   - **真实 PG 装配可用**：用真实实例装配出一整套存储并跑通读写。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertProductionReady,
  checkProductionConfig,
  createStorage,
  createSessionService,
  productionConfigFromEnv,
  ProductionConfigError,
  StorageConfigError,
  type ProductionConfig,
} from '../src/app/storage.ts';
import { startRealPostgres, type RealPostgres } from '../tools/pg-real.ts';
import type { Db } from '../src/db/pool.ts';
import { withTransaction } from '../src/db/tx.ts';
import { principalFromClaims } from '../src/auth/session.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────── 配置自查（纯函数，无需环境） ───────────────────────────

test('★ 生产配置自查：缺 DATABASE_URL / OIDC / Secure Cookie → 一次性列出全部错误并拒绝启动', () => {
  const issues = checkProductionConfig({ mode: 'real' });
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.field);
  assert.ok(errors.includes('AG_DATABASE_URL'), '缺数据库必须报错');
  assert.ok(errors.includes('AG_OIDC_*'), '缺 OIDC 必须报错');
  assert.ok(errors.includes('AG_SECURE_COOKIES'), '生产必须启用 Secure Cookie');
  assert.throws(() => assertProductionReady({ mode: 'real' }), ProductionConfigError);

  // 报错信息要能直接指导修复（含字段名与原因）
  try {
    assertProductionReady({ mode: 'real' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    assert.match(message, /AG_DATABASE_URL/);
    assert.match(message, /幂等记录/, '要说明「为什么不能用内存」而不只是「缺配置」');
  }
});

test('配置自查：连接串协议不对 / issuer 非 https → 报错', () => {
  const issues = checkProductionConfig({
    mode: 'real',
    databaseUrl: 'mysql://x',
    secureCookies: true,
    oidc: { issuer: 'http://insecure.example', clientId: 'c', redirectUri: 'https://x/cb' },
  });
  const errors = issues.filter((i) => i.severity === 'error');
  assert.ok(errors.some((i) => i.field === 'AG_DATABASE_URL' && /postgres:\/\//.test(i.message)));
  assert.ok(errors.some((i) => i.field === 'AG_OIDC_ISSUER' && /https/.test(i.message)));
});

test('★ demo 模式必须显式开启（内置假 IdP 不做验签）', () => {
  const notAllowed = checkProductionConfig({ mode: 'demo' });
  assert.ok(notAllowed.some((i) => i.severity === 'error' && i.field === 'AG_MODE'));
  assert.throws(() => assertProductionReady({ mode: 'demo' }), ProductionConfigError);

  const allowed = checkProductionConfig({ mode: 'demo', allowDemo: true });
  assert.equal(allowed.filter((i) => i.severity === 'error').length, 0);
  assert.ok(allowed.some((i) => i.severity === 'warning' && /不做验签/.test(i.message)), '允许 demo 时必须明确警告');
});

test('配置自查：完整生产配置通过（只有非致命 warning）', () => {
  const config: ProductionConfig = {
    mode: 'real',
    databaseUrl: 'postgres://accessgate:pw@db:5432/accessgate',
    secureCookies: true,
    publicUrl: 'https://gate.example.com',
    oidc: {
      issuer: 'https://idp.example.com',
      clientId: 'gate',
      redirectUri: 'https://gate.example.com/api/auth/callback',
    },
  };
  assert.equal(checkProductionConfig(config).filter((i) => i.severity === 'error').length, 0);
  assert.doesNotThrow(() => assertProductionReady(config));
});

test('productionConfigFromEnv：从环境变量组装，并自动推导回调 URL', () => {
  const config = productionConfigFromEnv({
    AG_MODE: 'real',
    AG_DATABASE_URL: 'postgres://u@h/db',
    AG_PUBLIC_URL: 'https://gate.example.com/',
    AG_OIDC_ISSUER: 'https://idp.example.com',
    AG_OIDC_CLIENT_ID: 'gate',
    AG_SECURE_COOKIES: '1',
  } as NodeJS.ProcessEnv);
  assert.equal(config.mode, 'real');
  assert.equal(config.oidc!.redirectUri, 'https://gate.example.com/api/auth/callback', '回调 URL 由 AG_PUBLIC_URL 推导');
  assert.equal(config.secureCookies, true);
  assert.equal(checkProductionConfig(config).filter((i) => i.severity === 'error').length, 0);

  // 缺少 OIDC 三件套时不组装 oidc（由自查报错，而不是组装出半个对象）
  const partial = productionConfigFromEnv({ AG_MODE: 'real' } as NodeJS.ProcessEnv);
  assert.equal(partial.oidc, undefined);
});

// ─────────────────────────── 存储装配 ───────────────────────────

test('★ 存储装配：postgres 模式缺 db / 缺 resolvePolicyId → 抛错（绝不静默回落内存）', () => {
  assert.throws(
    () => createStorage({ mode: 'postgres', siteId: 's1' }),
    (error: unknown) => {
      assert.ok(error instanceof StorageConfigError);
      assert.match(error.message, /AG_DATABASE_URL/);
      return true;
    },
  );

  // 有 db 但没有 resolvePolicyId：状态表外键是 uuid，缺了它状态落不了库
  const fakeDb = {} as Db;
  assert.throws(
    () => createStorage({ mode: 'postgres', siteId: 's1', db: fakeDb }),
    (error: unknown) => {
      assert.ok(error instanceof StorageConfigError);
      assert.match(error.message, /resolvePolicyId/);
      assert.match(error.message, /uuid/, '要解释为什么需要它');
      return true;
    },
  );
});

test('存储装配：memory 模式提供全套实现，且各接口可用', async () => {
  const storage = createStorage({ mode: 'memory', siteId: 'site-1' });
  assert.equal(storage.mode, 'memory');
  assert.equal(storage.dispose, undefined, '内存模式无需释放资源');

  // 会话可用
  const sessions = createSessionService(storage.sessions);
  const { token } = await sessions.create(principalFromClaims({ sub: 'u1', emailVerified: true }, { realm: 'enduser' }));
  assert.equal((await sessions.authenticate(token)).ok, true);

  // 主体仓储可用
  await storage.subjects.upsert('p', { externalId: '1', attributes: { group: 'a' } }, ['group'], 'fp', new Date());
  assert.equal((await storage.subjects.get('p', '1'))!.fingerprint, 'fp');

  // 策略可用
  await storage.policies.saveDraft('site-1', { code: 'x', spec: { requirements: { expression: { always: true } } } });
  assert.equal((await storage.policies.list('site-1')).length, 1);

  // 审计可用
  await storage.audit.record({ siteId: 'site-1', actorId: 'a', actorType: 'admin', action: 'test' });
});

// ─────────────────────────── 真实 PG 装配 ───────────────────────────

let pg: RealPostgres | undefined;
let unavailableReason: string | undefined;
const REQUIRE = process.env['AG_REQUIRE_REAL_PG'] === '1';

async function ensurePg(): Promise<RealPostgres | undefined> {
  if (pg !== undefined) return pg;
  if (unavailableReason !== undefined) {
    if (REQUIRE) throw new Error(`AG_REQUIRE_REAL_PG=1 但真实 PG 不可用：${unavailableReason}`);
    return undefined;
  }
  try {
    pg = await startRealPostgres({ fresh: true });
    await pg.exec(readFileSync(join(ROOT, 'migrations', '0001_init.sql'), 'utf8'));
    return pg;
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    if (REQUIRE) throw new Error(`AG_REQUIRE_REAL_PG=1 但真实 PG 启动失败：${unavailableReason}`);
    return undefined;
  }
}

async function createPgDb(instance: RealPostgres): Promise<Db & { end(): Promise<void> }> {
  const pgModule = (await import('pg')) as unknown as typeof import('pg');
  const pool = new pgModule.Pool({ host: '127.0.0.1', port: instance.port, user: 'accessgate', database: 'accessgate', max: 8 });
  const db: Db & { end(): Promise<void> } = {
    raw: pool as unknown as Db['raw'],
    async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const result = await pool.query(sql, params as unknown[]);
      return result.rows as T[];
    },
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    transaction<T>(fn: (tx: never) => Promise<T>, opts: { label?: string } = {}): Promise<T> {
      return withTransaction(
        {
          begin: async () => void (await pool.query('BEGIN')),
          commit: async () => void (await pool.query('COMMIT')),
          rollback: async () => void (await pool.query('ROLLBACK')),
        },
        fn as never,
        opts,
      );
    },
    async close(): Promise<void> {
      await pool.end();
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
  return db;
}

test('★ 真实 PG：装配出一整套存储并跑通读写（生产路径的端到端验证）', async (t) => {
  const instance = await ensurePg();
  if (instance === undefined) {
    t.skip(`真实 PG 不可用，跳过：${unavailableReason ?? '未知原因'}`);
    return;
  }
  const db = await createPgDb(instance);
  const siteId = crypto.randomUUID();
  t.after(async () => {
    await db.end();
  });

  // 生命周期状态表的外键是 ag_policies.id → 先建策略行，再给出解析器
  const policyId = crypto.randomUUID();
  await db.transaction(async () => {
    await db.query('INSERT INTO ag_policies (id, site_id, code, name) VALUES ($1, $2, $3, $4)', [policyId, siteId, 'edu', '教育邮箱']);
  });
  const resolvePolicyId = async (code: string): Promise<string | undefined> => {
    const rows = await db.query<{ id: string }>('SELECT id FROM ag_policies WHERE code = $1 AND site_id = $2', [code, siteId]);
    return rows[0]?.id;
  };

  const storage = createStorage({ mode: 'postgres', siteId, db, resolvePolicyId });
  assert.equal(storage.mode, 'postgres');

  // ① 会话
  const sessions = createSessionService(storage.sessions);
  const { token } = await sessions.create(
    principalFromClaims({ sub: crypto.randomUUID(), emailVerified: true }, { realm: 'enduser', activeSiteId: siteId }),
  );
  const auth = await sessions.authenticate(token);
  assert.equal(auth.ok, true);

  // ② 生命周期状态（经真实表 + code→id 解析）
  const userId = crypto.randomUUID();
  await db.transaction(async () =>
    storage.lifecycle.save(siteId, userId, 'edu', {
      state: 'granted',
      graceUntil: null,
      stateChangedAt: new Date('2025-06-01T00:00:00Z'),
      atRiskCount: 0,
      actionSeq: 1,
    }),
  );
  const state = await db.transaction(async () => storage.lifecycle.get(siteId, userId, 'edu'));
  assert.equal(state!.state, 'granted');
  assert.equal(state!.actionSeq, 1);

  // ③ 动作日志（幂等的持久化基础）
  await db.transaction(async () =>
    storage.actionLog.record({
      siteId,
      userId,
      actionSeq: 1,
      // ★ ag_actions_log.policy_id 是 uuid（外键指向 ag_policies.id）。
      //   幂等键里用的是**策略 code**（可读、站点内唯一），两者刻意分开：
      //   code 用于幂等键计算，uuid 用于落库外键。
      policyId,
      action: 'checkin:grant',
      idempotencyKey: 'idem-app-1',
      status: 'succeeded',
      attempts: 1,
      startedAt: new Date(),
      finishedAt: new Date(),
    }),
  );
  assert.equal((await db.transaction(async () => storage.actionLog.find(siteId, 'idem-app-1')))!.status, 'succeeded');

  // ④ 作业（调度器持久化）
  await db.transaction(async () => storage.jobs.ensureJob('patrol', new Date('2025-06-01T00:00:00Z')));
  assert.equal((await db.transaction(async () => storage.jobs.get('patrol')))!.jobKey, 'patrol');

  // ⑤ 主体仓储
  await db.transaction(async () =>
    storage.subjects.upsert('newapi-provider', { externalId: '42', attributes: { group: 'basic' } }, ['group'], 'fp-42', new Date()),
  );
  assert.equal((await db.transaction(async () => storage.subjects.get('newapi-provider', '42')))!.fingerprint, 'fp-42');

  // ⑥ 策略
  await db.transaction(async () =>
    storage.policies.saveDraft(siteId, { code: 'edu-2', spec: { requirements: { expression: { always: true } } } }),
  );
  assert.ok((await db.transaction(async () => storage.policies.list(siteId))).some((p) => p.code === 'edu-2'));

  // ⑦ 审计
  await db.transaction(async () =>
    storage.audit.record({ siteId, actorId: 'admin-1', actorType: 'admin', action: 'policy.publish', targetType: 'policy', targetId: 'edu' }),
  );
  const auditRows = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM ag_audit_log WHERE site_id = $1', [siteId]);
  assert.equal(auditRows[0]!.n, '1');

  // dispose 应能关闭连接池（这里不真关，避免影响后续用例；只断言它存在）
  assert.equal(typeof storage.dispose, 'function');
});
