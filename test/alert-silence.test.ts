/**
 * 告警静默（`docs/05:225`）—— 「带期限 + 到期自动恢复」的可执行证明。
 *
 * ★ 本文件要证明的三件事：
 *   ① **永久静默无法被设置**（过去时间、超长、"9999 年" 都被拒）；
 *   ② **到期自动恢复不依赖任何清理任务**（不跑 purge，静默也已经失效）——
 *      否则「任务没跑 → 告警被永久压制而无人知道」就是一个新的静默黑洞；
 *   ③ 三个审计事件都写，且**被静默的告警也留痕**（`suppressed: true`）——
 *      否则事后无法回答「静默期间到底发生过没有」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AuditEntry, AuditSink } from '../src/admin/api.ts';
import {
  AlertSilenceService,
  DEFAULT_MAX_SILENCE_MS,
  expiredSilences,
  InMemoryAlertSilenceStore,
  isSilenced,
  validateSilence,
  type AlertSilence,
} from '../src/core/alert-silence.ts';

const T0 = new Date('2026-09-26T00:00:00Z');
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

function silence(over: Partial<AlertSilence> = {}): AlertSilence {
  return {
    code: 'grant_lifetime_exceeds_retention',
    until: plus(T0, 3_600_000),
    by: 'admin@example.com',
    reason: '正在修复，先压 1 小时',
    createdAt: T0,
    ...over,
  };
}

// ─────────────────────────── 校验：永久静默不可能 ───────────────────────────

test('校验：合法的带期限静默 → 通过', () => {
  assert.deepEqual(validateSilence({ until: plus(T0, 3_600_000), now: T0 }), { ok: true });
});

test('★ 校验：过去的时间 → 拒绝（"静默到昨天"没有意义，多半是误操作）', () => {
  const result = validateSilence({ until: plus(T0, -1000), now: T0 });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /必须晚于当前时间/);
});

test('★ 校验：**超长静默**（含"永不过期"）→ 拒绝', () => {
  const forever = validateSilence({ until: new Date('9999-12-31T00:00:00Z'), now: T0 });
  assert.equal(forever.ok, false);
  assert.match(forever.ok === false ? forever.reason : '', /超过上限 7 天/);

  // 恰好等于上限 → 允许（边界）
  assert.deepEqual(
    validateSilence({ until: plus(T0, DEFAULT_MAX_SILENCE_MS), now: T0 }),
    { ok: true },
  );
  // 超过上限 1ms → 拒绝
  assert.equal(
    validateSilence({ until: plus(T0, DEFAULT_MAX_SILENCE_MS + 1), now: T0 }).ok,
    false,
  );
});

test('校验：非法时间 → 拒绝', () => {
  const result = validateSilence({ until: new Date('不是时间'), now: T0 });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /不是合法时间/);
});

// ─────────────────────────── 判定：到期自动恢复 ───────────────────────────

test('★ 判定：未到期 → 被静默；**到期 → 自动恢复**（不依赖任何清理任务）', () => {
  const silences = [silence({ until: plus(T0, 60_000) })];

  assert.equal(isSilenced({ silences, code: 'grant_lifetime_exceeds_retention', now: T0 }), true);
  // 到期前 1ms 仍然静默
  assert.equal(
    isSilenced({ silences, code: 'grant_lifetime_exceeds_retention', now: plus(T0, 59_999) }),
    true,
  );
  // ★ 到期瞬间即失效——**没有跑任何清理**
  assert.equal(
    isSilenced({ silences, code: 'grant_lifetime_exceeds_retention', now: plus(T0, 60_000) }),
    false,
  );
  assert.equal(
    isSilenced({ silences, code: 'grant_lifetime_exceeds_retention', now: plus(T0, 600_000) }),
    false,
  );
});

test('判定：只影响被静默的码；`*` 通配影响全部', () => {
  const silences = [silence({ code: 'fact_ttl_too_short' })];
  assert.equal(isSilenced({ silences, code: 'fact_ttl_too_short', now: T0 }), true);
  assert.equal(isSilenced({ silences, code: 'grant_lifetime_exceeds_retention', now: T0 }), false);

  const wildcard = [silence({ code: '*' })];
  assert.equal(isSilenced({ silences: wildcard, code: '任意码', now: T0 }), true);
});

test('expiredSilences：只筛出已到期的（用于回收存储，不参与正确性）', () => {
  const silences = [
    silence({ code: 'a', until: plus(T0, -1) }),
    silence({ code: 'b', until: plus(T0, 1000) }),
  ];
  assert.deepEqual(
    expiredSilences({ silences, now: T0 }).map((s) => s.code),
    ['a'],
  );
});

// ─────────────────────────── 服务：三个审计事件 ───────────────────────────

function makeService() {
  const entries: AuditEntry[] = [];
  const audit: AuditSink = {
    async record(entry) {
      entries.push(entry);
    },
    // ★ `AuditSink` 现在还有 `list`（审计查询）—— 本文件只关心写入，故返回空
    async list() {
      return [];
    },
  };
  const store = new InMemoryAlertSilenceStore();
  const service = new AlertSilenceService({ store, audit, siteId: 'site-1', now: () => T0 });
  return { service, store, entries };
}

test('服务：设置静默 → 写 `alert.silenced` 审计（含期限与理由）', async () => {
  const { service, entries } = makeService();
  const result = await service.silence({
    code: 'fact_ttl_too_short',
    until: plus(T0, 3_600_000),
    by: 'admin@example.com',
    reason: '正在扩容配额',
  });
  assert.equal(result.ok, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.action, 'alert.silenced');
  assert.equal(entries[0]!.targetId, 'fact_ttl_too_short');
  assert.deepEqual(entries[0]!.after, {
    until: plus(T0, 3_600_000).toISOString(),
    reason: '正在扩容配额',
  });
});

test('服务：非法静默**不落库、不写审计**（校验在副作用之前）', async () => {
  const { service, store, entries } = makeService();
  const result = await service.silence({
    code: 'x',
    until: new Date('9999-12-31T00:00:00Z'),
    by: 'admin',
    reason: '永久压住',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(entries, []);
});

test('★ 服务：静默中的告警**不打扰人，但仍写 `alert.raised`（suppressed: true）**', async () => {
  const { service, entries } = makeService();
  await service.silence({
    code: 'grant_lifetime_exceeds_retention',
    until: plus(T0, 3_600_000),
    by: 'admin',
    reason: '正在处理',
  });

  const shouldNotify = await service.raise({
    code: 'grant_lifetime_exceeds_retention',
    detail: 'maxGrantLifetime=3650 天 > 最短保留期 30 天',
  });
  assert.equal(shouldNotify, false, '静默期内不打扰人');
  // ★ 但必须留痕：否则事后无法回答「静默期间到底发生过没有」
  const raised = entries.filter((e) => e.action === 'alert.raised');
  assert.equal(raised.length, 1);
  assert.deepEqual(raised[0]!.after, {
    detail: 'maxGrantLifetime=3650 天 > 最短保留期 30 天',
    suppressed: true,
  });
});

test('服务：未静默的告警 → 应打扰人，审计 suppressed=false', async () => {
  const { service, entries } = makeService();
  const shouldNotify = await service.raise({ code: 'fact_ttl_too_short', detail: 'TTL 太短' });
  assert.equal(shouldNotify, true);
  assert.equal((entries[0]!.after as { suppressed: boolean }).suppressed, false);
});

test('服务：`acknowledge` 写 `alert.acknowledged`', async () => {
  const { service, entries } = makeService();
  await service.acknowledge({ code: 'fact_ttl_too_short', by: 'admin', note: '已扩容' });
  assert.equal(entries[0]!.action, 'alert.acknowledged');
  assert.equal(entries[0]!.targetId, 'fact_ttl_too_short');
});

test('★ 服务：`purgeExpired` **只回收存储**——不跑它，静默也已失效（正确性不依赖清理）', async () => {
  const { service, store } = makeService();
  await service.silence({ code: 'a', until: plus(T0, 1000), by: 'admin', reason: 'x' });
  assert.equal(await service.isSilenced('a'), true);

  // 时间推进到静默之后：**不调用 purgeExpired**
  const later = new AlertSilenceService({
    store,
    now: () => plus(T0, 2000),
  });
  assert.equal(await later.isSilenced('a'), false, '★ 到期即恢复，与清理任务无关');
  assert.equal((await store.list()).length, 1, '存储里那行还在——清理只是回收，不是正确性');

  // 回收之后仍然不影响判定
  assert.equal(await later.purgeExpired(), 1);
  assert.equal(await later.isSilenced('a'), false);
});
