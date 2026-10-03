/**
 * 签到编排（`docs/05 §5.2 / §5.2.1`）—— 三步写入顺序与**防重复发额度**。
 *
 * ★ 断言全部围绕「**发了几次额度**」这个可观测事实，而不是「函数被调用了」：
 *   ① 无资格 → 一次都不发；
 *   ② 有资格 → 恰好一次，且顺序是「先写记录、再发额度、后回填」；
 *   ③ 同日第二次 → **仍是恰好一次**（幂等成功，不报错）；
 *   ④ 连签第 2 天 → 记录递增、额度按阶梯；
 *   ⑤ 发额度失败/超时 → 记录留 `unknown`，**不自动重发**（重放不会变成「确定多给」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/pool.ts';
import { InMemoryCheckinEntitlementStore, InMemoryCheckinRecordStore } from '../src/core/checkin.ts';
import {
  CheckinService,
  logicalDate,
  previousDate,
  stableAmount,
  streakMultiplier,
  type CheckinConfig,
} from '../src/core/checkin-service.ts';
import { createTransactionalCheckinRecordStore } from '../src/db/checkin-adapter.ts';

const SITE = '11111111-1111-1111-1111-111111111111';
const USER = '33333333-3333-3333-3333-333333333333';

const CONFIG: CheckinConfig = {
  requireScope: 'daily',
  timezone: 'Asia/Shanghai',
  reward: {
    min: 1000,
    max: 5000,
    cap: 20000,
    streakBonus: [
      { days: 7, multiplier: 1.5 },
      { days: 30, multiplier: 3 },
    ],
  },
};

function makeService(options: { fail?: boolean; now?: () => Date } = {}) {
  const entitlements = new InMemoryCheckinEntitlementStore();
  const records = new InMemoryCheckinRecordStore();
  const grants: { amount: number; idempotencyKey: string }[] = [];
  const service = new CheckinService({
    entitlements,
    records,
    grantQuota: async (input) => {
      grants.push({ amount: input.amount, idempotencyKey: input.idempotencyKey });
      if (options.fail === true) throw new Error('下游超时');
      return { providerLogId: 42 };
    },
    config: CONFIG,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { service, entitlements, records, grants };
}

/** 上海时区 2026-09-26 的上午（UTC 02:00 = 上海 10:00） */
const DAY1 = new Date('2026-09-26T02:00:00Z');
const DAY2 = new Date('2026-09-27T02:00:00Z');

test('签到：无资格 → not_eligible，且**一次额度都不发**', async () => {
  const { service, grants } = makeService({ now: () => DAY1 });
  const outcome = await service.checkin({ siteId: SITE, userId: USER });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'not_eligible');
  assert.equal(grants.length, 0, '无资格不得发额度');
});

test('签到：三步顺序 —— 先写记录（pending）→ 发额度 → 回填 confirmed', async () => {
  const { service, entitlements, records, grants } = makeService({ now: () => DAY1 });
  await entitlements.grant({ siteId: SITE, userId: USER, scope: 'daily' });

  const outcome = await service.checkin({ siteId: SITE, userId: USER });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok === true && outcome.alreadyCheckedIn, false);
  assert.equal(grants.length, 1);

  const today = logicalDate(DAY1, CONFIG.timezone);
  const row = await records.find(SITE, USER, today);
  assert.ok(row !== undefined);
  // ③ 回填：确认发放（证明「发额度」发生在「写记录」之后，而不是反过来）
  assert.equal(row.grantState, 'confirmed');
  assert.equal(row.providerLogId, 42);
  assert.equal(row.quotaAwarded, grants[0]!.amount);
  // 幂等键含**逻辑日**：第 2 天不会复用第 1 天的键（这正是「跨日少发」的修法）
  assert.equal(grants[0]!.idempotencyKey, `checkin:${SITE}:${USER}:${today}`);
});

test('签到：同日第二次 → alreadyCheckedIn，且**总共只发一次额度**', async () => {
  const { service, entitlements, grants } = makeService({ now: () => DAY1 });
  await entitlements.grant({ siteId: SITE, userId: USER, scope: 'daily' });

  const first = await service.checkin({ siteId: SITE, userId: USER });
  const second = await service.checkin({ siteId: SITE, userId: USER });

  assert.equal(first.ok === true && first.alreadyCheckedIn, false);
  assert.equal(second.ok, true, '重复签到是**幂等成功**，不是错误');
  assert.equal(second.ok === true && second.alreadyCheckedIn, true);
  assert.equal(grants.length, 1, '★ 同日绝不允许发第二次额度');
  assert.equal(
    second.ok === true && second.quotaAwarded,
    first.ok === true && first.quotaAwarded,
  );
});

test('签到：连签第 2 天 → streak 递增，且跨日**重新发额度**（幂等键按日区分）', async () => {
  let now = DAY1;
  const { service, entitlements, grants } = makeService({ now: () => now });
  await entitlements.grant({ siteId: SITE, userId: USER, scope: 'daily' });

  const d1 = await service.checkin({ siteId: SITE, userId: USER });
  now = DAY2;
  const d2 = await service.checkin({ siteId: SITE, userId: USER });

  assert.equal(d1.ok === true && d1.streak, 1);
  assert.equal(d2.ok === true && d2.streak, 2, '连续第二天签到 → streak = 2');
  assert.equal(grants.length, 2, '★ 跨日必须重新发放（否则就是「跨日少发」缺陷）');
  assert.notEqual(grants[0]!.idempotencyKey, grants[1]!.idempotencyKey, '幂等键必须含逻辑日');
});

test('签到：发额度失败 → 记录留 unknown，且**不自动重发**（重放不得变成确定多给）', async () => {
  const { service, entitlements, records } = makeService({ now: () => DAY1, fail: true });
  await entitlements.grant({ siteId: SITE, userId: USER, scope: 'daily' });

  const outcome = await service.checkin({ siteId: SITE, userId: USER });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'grant_failed');

  const today = logicalDate(DAY1, CONFIG.timezone);
  const row = await records.find(SITE, USER, today);
  assert.equal(row?.grantState, 'unknown', '结果未知必须落库，供对账核销');

  // ★ 再次调用：因为记录已存在，走「已签到」分支 —— **不会**自动重发
  const again = await service.checkin({ siteId: SITE, userId: USER });
  assert.equal(again.ok === true && again.alreadyCheckedIn, true);
});

test('签到：状态与奖励计算（站点时区 + 连签阶梯 + 确定性金额）', async () => {
  const { service, entitlements } = makeService({ now: () => DAY1 });

  const before = await service.status({ siteId: SITE, userId: USER });
  assert.equal(before.eligible, false);
  assert.equal(before.today, false);
  assert.equal(before.streak, 0);

  await entitlements.grant({ siteId: SITE, userId: USER, scope: 'daily' });
  const after = await service.status({ siteId: SITE, userId: USER });
  assert.equal(after.eligible, true);
  assert.equal(after.today, false);
  assert.ok(after.nextReward > 0);

  await service.checkin({ siteId: SITE, userId: USER });
  const done = await service.status({ siteId: SITE, userId: USER });
  assert.equal(done.today, true);
  assert.equal(done.streak, 1);

  // 确定性：同 (userId, 日期) 的金额恒定（可复现、可对账）
  const date = logicalDate(DAY1, CONFIG.timezone);
  assert.equal(
    stableAmount(USER, date, CONFIG.reward),
    stableAmount(USER, date, CONFIG.reward),
  );
  // 阶梯倍率
  assert.equal(streakMultiplier(1, CONFIG.reward), 1);
  assert.equal(streakMultiplier(7, CONFIG.reward), 1.5);
  assert.equal(streakMultiplier(30, CONFIG.reward), 3);
  // 自然日与前一日（跨月边界）
  assert.equal(logicalDate(DAY1, 'Asia/Shanghai'), '2026-09-26');
  assert.equal(previousDate('2026-03-01'), '2026-02-28');
});

test('真实 pglite：签到记录的幂等锚点与回填（ON CONFLICT DO NOTHING）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await db.exec(`
    CREATE TYPE ag_grant_state AS ENUM ('pending', 'in_flight', 'confirmed', 'unknown');
    CREATE TABLE ag_checkin_records (
      site_id uuid NOT NULL,
      id bigserial PRIMARY KEY,
      user_id uuid NOT NULL,
      checkin_date date NOT NULL,
      quota_awarded integer NOT NULL,
      grant_state ag_grant_state NOT NULL DEFAULT 'pending',
      request_id varchar(64) NULL,
      grant_via varchar(32) NOT NULL DEFAULT 'provider',
      provider_log_id bigint NULL,
      streak integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (site_id, user_id, checkin_date)
    );
  `);

  const records = createTransactionalCheckinRecordStore(db, SITE);
  const base = {
    siteId: SITE,
    userId: USER,
    checkinDate: '2026-09-26',
    quotaAwarded: 2500,
    grantState: 'pending' as const,
    grantVia: 'provider',
    streak: 1,
  };

  // ① 首次插入成功；② 同日重复插入被唯一键挡住（返回 false，且**不覆盖**原值）
  assert.equal(await records.tryInsert(base), true);
  assert.equal(await records.tryInsert({ ...base, quotaAwarded: 9999, streak: 9 }), false);
  const row = await records.find(SITE, USER, '2026-09-26');
  assert.equal(row?.quotaAwarded, 2500, 'ON CONFLICT DO NOTHING 不得覆盖已存在的记录');
  assert.equal(row?.streak, 1);
  assert.equal(row?.grantState, 'pending');

  // ③ 回填 confirmed + 下游流水号
  await records.markGranted({ siteId: SITE, userId: USER, checkinDate: '2026-09-26', providerLogId: 777 });
  const granted = await records.find(SITE, USER, '2026-09-26');
  assert.equal(granted?.grantState, 'confirmed');
  assert.equal(granted?.providerLogId, 777);

  // ④ 结果未知：标记 unknown，记录仍在（对账依据）
  await records.tryInsert({ ...base, checkinDate: '2026-09-27', quotaAwarded: 3000, streak: 2 });
  await records.markUnknown({
    siteId: SITE,
    userId: USER,
    checkinDate: '2026-09-27',
    error: '下游超时',
  });
  const unknown = await records.find(SITE, USER, '2026-09-27');
  assert.equal(unknown?.grantState, 'unknown');

  // ⑤ 最近记录按日期倒序（history 的数据源）
  const recent = await records.listRecent(SITE, USER, 10);
  assert.deepEqual(
    recent.map((r) => r.checkinDate),
    ['2026-09-27', '2026-09-26'],
  );

  // ⑥ 站点隔离：另一个站点看不到
  const other = createTransactionalCheckinRecordStore(db, '22222222-2222-2222-2222-222222222222');
  assert.equal(await other.find('22222222-2222-2222-2222-222222222222', USER, '2026-09-26'), undefined);
});
