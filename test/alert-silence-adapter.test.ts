/**
 * ★ P0-2：告警静默的**持久化**（`docs/11 §13.1`）。
 *
 * ★ 本文件要证明四件事：
 *   ① 落库后能读回，且 **`until` / `createdAt` 是 `Date` 实例**——
 *      若退化成字符串，`until > now` 会变成**字符串比较**，静默期限静默地失效；
 *   ② **同码覆盖**（重新静默 = 更新期限，不堆多条）；
 *   ③ `remove` 生效，且"不存在时不写"；
 *   ④ 单条记录结构损坏时**只丢那一条**，不让整个静默列表读不出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryPlatformSettingsStore } from '../src/app/platform-mode.ts';
import { ALERT_SILENCES_KEY, DbAlertSilenceStore } from '../src/db/alert-silence-adapter.ts';
import type { AlertSilence } from '../src/core/alert-silence.ts';

const T0 = new Date('2026-09-26T00:00:00Z');
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

const silenceOf = (over: Partial<AlertSilence> = {}): AlertSilence => ({
  code: 'invariant.checkin',
  until: plus(T0, 3_600_000),
  by: 'admin-1',
  reason: '已知问题，正在修复',
  createdAt: T0,
  ...over,
});

function makeStore(): { store: DbAlertSilenceStore; settings: InMemoryPlatformSettingsStore } {
  const settings = new InMemoryPlatformSettingsStore();
  return { store: new DbAlertSilenceStore(settings), settings };
}

test('★ put → list 命中，且 `until` / `createdAt` 是 **Date 实例**（不是字符串）', async () => {
  const { store } = makeStore();
  await store.put(silenceOf());

  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.code, 'invariant.checkin');
  assert.equal(rows[0]!.until instanceof Date, true, '★ 必须是 Date——否则期限比较会退化成字符串比较');
  assert.equal(rows[0]!.createdAt instanceof Date, true);
  assert.equal(rows[0]!.until.toISOString(), plus(T0, 3_600_000).toISOString());
  assert.equal(rows[0]!.by, 'admin-1');
  assert.equal(rows[0]!.reason, '已知问题，正在修复');
});

test('★ 端到端：读回的 `until` 能正确做**时间比较**（静默生效/到期）', async () => {
  const { store } = makeStore();
  await store.put(silenceOf({ until: plus(T0, 60_000) }));

  const [row] = await store.list();
  assert.ok(row !== undefined);
  // 到期前 1ms：静默有效
  assert.equal(row.until.getTime() > plus(T0, 59_999).getTime(), true);
  // 到期瞬间：不再有效
  assert.equal(row.until.getTime() > plus(T0, 60_000).getTime(), false);
});

test('★ 同码覆盖：重新静默 = **更新期限**，不堆多条', async () => {
  const { store } = makeStore();
  await store.put(silenceOf({ until: plus(T0, 60_000) }));
  await store.put(silenceOf({ until: plus(T0, 7_200_000), reason: '延长观察' }));

  const rows = await store.list();
  assert.equal(rows.length, 1, '★ 同一告警码只应有一条静默');
  assert.equal(rows[0]!.until.toISOString(), plus(T0, 7_200_000).toISOString());
  assert.equal(rows[0]!.reason, '延长观察');
});

test('不同告警码各自独立；`*`（全部静默）也是一条普通记录', async () => {
  const { store } = makeStore();
  await store.put(silenceOf({ code: 'a' }));
  await store.put(silenceOf({ code: 'b' }));
  await store.put(silenceOf({ code: '*' }));
  assert.deepEqual(
    (await store.list()).map((row) => row.code).sort(),
    ['*', 'a', 'b'],
  );
});

test('remove：移除指定码；**不存在时不写**（避免无意义写）', async () => {
  const { store, settings } = makeStore();
  await store.put(silenceOf({ code: 'a' }));
  await store.put(silenceOf({ code: 'b' }));

  await store.remove('a');
  assert.deepEqual((await store.list()).map((row) => row.code), ['b']);

  const before = await settings.get(ALERT_SILENCES_KEY);
  await store.remove('not-exist');
  const after = await settings.get(ALERT_SILENCES_KEY);
  assert.equal(after?.updatedAt.getTime(), before?.updatedAt.getTime(), '不存在时不该产生写入');
});

test('空存储 → 空列表（不是报错）', async () => {
  const { store } = makeStore();
  assert.deepEqual(await store.list(), []);
});

test('★ 结构损坏的记录**只丢那一条**，其余照常读出（不让整个列表不可用）', async () => {
  const { store, settings } = makeStore();
  await store.put(silenceOf({ code: 'good' }));
  // 直接往平台设置里塞一条坏记录（模拟历史遗留/手工改坏）
  await settings.put(
    ALERT_SILENCES_KEY,
    [
      { code: 'good', until: plus(T0, 3_600_000).toISOString(), by: 'x', reason: '', createdAt: T0.toISOString() },
      { code: 123, until: 'not-a-date' }, // 坏
      { until: plus(T0, 3_600_000).toISOString() }, // 缺 code
      'garbage', // 根本不是对象
    ],
    null,
    T0,
  );

  const rows = await store.list();
  assert.equal(rows.length, 1, '★ 坏记录被丢弃，好记录仍可读');
  assert.equal(rows[0]!.code, 'good');
});
