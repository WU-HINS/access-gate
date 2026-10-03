/**
 * newapi 动作插件验收（M2-2 / M2-3）—— docs/05 §3.2。
 *
 * 本文件的断言重点是**安全与幂等**，而不是「能调用下游」：
 *   - **★ 敏感字段绝不回填**：`PUT /api/user/` 是整体替换语义，
 *     若把下游返回的 `password` 原样写回，轻则覆盖密码、重则把哈希写成明文。
 *     这条不能依赖调用方自觉，必须在**出口强制剔除**。
 *   - **read-modify-write 回填全部既有属性**：只传 `{group}` 会清空用户名/备注。
 *   - **用户级互斥**：并发 read-modify-write 会互相覆盖（后写的赢）。
 *   - **`add_quota` 不做值比对**（累加语义），幂等完全依赖宿主的 `actionSeq`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAddQuotaAction,
  createSetGroupAction,
  createSetStatusAction,
  NEVER_WRITE_BACK_FIELDS,
  NO_LOCK,
  registerNewapiActions,
  stripSensitiveFields,
  type DownstreamApi,
  type UserLock,
} from '../src/plugin/builtin/newapi-actions.ts';
import { ActionRegistry, type ActionContext } from '../src/core/action-executor.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

function contextOf(params: Record<string, unknown>, userId = 'u1'): ActionContext {
  return { siteId: 'site-1', userId, policyId: 'p', actionSeq: 1, idempotencyKey: 'k', params, attempt: 1 };
}

/** 一个记录调用的假下游。 */
function makeApi(initial: Record<string, Record<string, unknown>> = {}) {
  const state: Record<string, Record<string, unknown>> = structuredClone(initial);
  const puts: { externalId: string; attributes: Record<string, unknown> }[] = [];
  const manages: { externalId: string; action: string; value?: unknown }[] = [];
  const api: DownstreamApi = {
    async get(externalId) {
      const found = state[externalId];
      return found === undefined ? null : { attributes: { ...found } };
    },
    async put(externalId, attributes) {
      puts.push({ externalId, attributes: { ...attributes } });
      state[externalId] = { ...attributes };
    },
    async manage(externalId, action, value) {
      manages.push({ externalId, action, ...(value === undefined ? {} : { value }) });
      if (action === 'add_quota') {
        const current = state[externalId] ?? {};
        state[externalId] = { ...current, quota: Number(current['quota'] ?? 0) + Number(value) };
      } else if (action === 'disable') {
        state[externalId] = { ...(state[externalId] ?? {}), status: 2 };
      } else if (action === 'enable') {
        state[externalId] = { ...(state[externalId] ?? {}), status: 1 };
      }
    },
  };
  return { api, state, puts, manages };
}

// ─────────────────────────── ★ 敏感字段 ───────────────────────────

test('★ M2-2：`stripSensitiveFields` 剔除全部敏感字段（大小写不敏感）', () => {
  const { safe, stripped } = stripSensitiveFields({
    username: 'alice',
    group: 'default',
    password: 'hunter2',
    password_hash: '$2b$...',
    accessToken: 'tok',
    api_key: 'k',
    TOTP_SECRET: 'x',
    remark: '备注',
  });
  assert.deepEqual(Object.keys(safe).sort(), ['group', 'remark', 'username']);
  assert.equal(stripped.length, 5);
  assert.ok(stripped.includes('password'));
  assert.ok(stripped.includes('TOTP_SECRET'), '大小写不敏感');
  // 黑名单本身要覆盖关键字段
  for (const field of ['password', 'password_hash', 'access_token', 'secret', 'api_key', 'private_key', 'totp_secret']) {
    assert.ok(NEVER_WRITE_BACK_FIELDS.includes(field), `黑名单应含 ${field}`);
  }
});

test('★ M2-2：`set_group` 写回时**绝不携带** password（一次疏忽就会破坏用户凭据）', async () => {
  const { api, puts } = makeApi({
    '42': { username: 'alice', display_name: 'Alice', group: 'default', remark: '老用户', password_hash: '$2b$secret', access_token: 'tok-1' },
  });
  const handler = createSetGroupAction({ api, now: () => NOW });

  const result = await handler.execute(contextOf({ group: 'vip2' }, '42'));
  assert.equal(result.status, 'succeeded');
  assert.equal(puts.length, 1);

  const written = puts[0]!.attributes;
  assert.equal(written['group'], 'vip2');
  // ★ 普通字段必须回填（整体替换语义）
  assert.equal(written['username'], 'alice');
  assert.equal(written['display_name'], 'Alice');
  assert.equal(written['remark'], '老用户');
  // ★ 敏感字段必须被剔除
  assert.equal(written['password_hash'], undefined, '★ 绝不能把 password_hash 写回下游');
  assert.equal(written['access_token'], undefined);
  // 剔除情况要可观测（detail 里报告）
  assert.deepEqual((result.detail as { strippedSensitiveFields: string[] }).strippedSensitiveFields.sort(), ['access_token', 'password_hash']);
});

// ─────────────────────────── set_group 幂等三重保障 ───────────────────────────

test('M2-2：`set_group` 值不变 → skipped/no_change（避免无谓的下游 PUT）', async () => {
  const { api, puts } = makeApi({ '42': { username: 'a', group: 'vip2' } });
  const handler = createSetGroupAction({ api, now: () => NOW });
  const result = await handler.execute(contextOf({ group: 'vip2' }, '42'));
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_change');
  assert.equal(puts.length, 0, '值不变不得触达下游');
});

test('★ M2-2：`set_group` 最小变更间隔（改分组会踢用户下线，必须防抖）', async () => {
  const { api, puts } = makeApi({ '42': { username: 'a', group: 'default' } });
  const handler = createSetGroupAction({
    api,
    now: () => NOW,
    minChangeIntervalMs: 60_000,
    lastChangeAt: () => new Date(NOW.getTime() - 10_000), // 10 秒前刚改过
  });
  const result = await handler.execute(contextOf({ group: 'vip2' }, '42'));
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'rate_limited');
  assert.equal(puts.length, 0);
});

test('★ M2-2：`set_group` **用户级互斥** —— 并发不互相覆盖', async () => {
  const { api } = makeApi({ '42': { username: 'a', group: 'default' } });
  // 一个「慢」的锁实现：串行化同用户的调用
  const queues = new Map<string, Promise<unknown>>();
  const lock: UserLock = {
    withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
      const previous = queues.get(userId) ?? Promise.resolve();
      const next = previous.then(fn, fn);
      queues.set(userId, next.catch(() => undefined));
      return next;
    },
  };
  const handler = createSetGroupAction({ api, lock, now: () => NOW });

  // 并发两次（不同目标值）：互斥保证它们**串行**执行，第二次看到第一次的结果
  const [first, second] = await Promise.all([
    handler.execute(contextOf({ group: 'vip2' }, '42')),
    handler.execute(contextOf({ group: 'vip3' }, '42')),
  ]);
  assert.equal(first.status, 'succeeded');
  // 第二次可能 succeeded（改到 vip3）或 skipped（若已因幂等命中）——但绝不能是「基于旧值覆盖」
  assert.ok(['succeeded', 'skipped'].includes(second.status));
  const finalGroup = (await api.get('42'))!.attributes['group'];
  assert.ok(['vip2', 'vip3'].includes(String(finalGroup)));
});

test('M2-2：`set_group` 目标未绑定 → blocked_unbound（不是失败）', async () => {
  const { api } = makeApi({});
  const handler = createSetGroupAction({ api, now: () => NOW });
  const result = await handler.execute(contextOf({ group: 'vip2' }, 'ghost'));
  assert.equal(result.status, 'blocked_unbound');
  assert.match(result.reason!, /尚未绑定/);
});

test('M2-2：`set_group` 缺 group 参数 → failed 且不可重试（配置错误）', async () => {
  const { api } = makeApi({ '42': { group: 'default' } });
  const handler = createSetGroupAction({ api, now: () => NOW });
  const result = await handler.execute(contextOf({}, '42'));
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
});

test('M2-2：`set_group` 回读确认目标达成', async () => {
  const { api } = makeApi({ '42': { username: 'a', group: 'default' } });
  const handler = createSetGroupAction({ api, now: () => NOW });
  await handler.execute(contextOf({ group: 'vip2' }, '42'));
  const check = await handler.verify!(contextOf({ group: 'vip2' }, '42'));
  assert.equal(check.verified, true);
  assert.equal(check.actual, 'vip2');
});

// ─────────────────────────── add_quota ───────────────────────────

test('★ M2-3：`add_quota` 是**累加**语义 —— 不做值比对（重复执行会重复加）', async () => {
  const { api, state, manages } = makeApi({ '42': { quota: 100 } });
  const handler = createAddQuotaAction({ api });
  await handler.execute(contextOf({ value: 50 }, '42'));
  assert.equal(state['42']!['quota'], 150);
  // 再执行一次：仍然加（幂等由宿主的 actionSeq 保障，不由本动作保障）
  await handler.execute(contextOf({ value: 50 }, '42'));
  assert.equal(state['42']!['quota'], 200, '★ 累加语义：动作本身不去重，幂等键在宿主');
  assert.equal(manages.length, 2);
  assert.equal(manages[0]!.action, 'add_quota');
});

test('M2-3：`add_quota` 参数校验（零/非数字 → 配置错误不重试）', async () => {
  const { api } = makeApi({ '42': {} });
  const handler = createAddQuotaAction({ api });
  for (const bad of [0, 'abc', Number.NaN]) {
    const result = await handler.execute(contextOf({ value: bad }, '42'));
    assert.equal(result.status, 'failed', `${String(bad)} 应被拒`);
    assert.equal(result.retryable, false);
  }
});

test('★ M2-3：`add_quota` 错误分类 —— 4xx 不重试、5xx 可重试', async () => {
  const failing = (message: string): DownstreamApi => ({
    async get() {
      return { attributes: {} };
    },
    async put() {},
    async manage() {
      throw new Error(message);
    },
  });
  const client4xx = createAddQuotaAction({ api: failing('下游 400：参数错误') });
  const r4 = await client4xx.execute(contextOf({ value: 10 }, '42'));
  assert.equal(r4.status, 'failed');
  assert.equal(r4.retryable, false, '4xx 是配置/权限错误，重试无意义');

  const client5xx = createAddQuotaAction({ api: failing('下游 503：暂时不可用') });
  const r5 = await client5xx.execute(contextOf({ value: 10 }, '42'));
  assert.equal(r5.status, 'failed');
  assert.equal(r5.retryable, true, '5xx 应重试');
});

test('M2-3：`add_quota` 下游未提供 manage 能力 → 明确失败', async () => {
  const api: DownstreamApi = {
    async get() {
      return { attributes: {} };
    },
    async put() {},
  };
  const result = await createAddQuotaAction({ api }).execute(contextOf({ value: 10 }, '42'));
  assert.equal(result.status, 'failed');
  assert.match(result.reason!, /未提供 manage 能力/);
});

// ─────────────────────────── set_status ───────────────────────────

test('★ M2-3：`set_status` 幂等 —— 值不变则跳过（避免审计噪音与无谓调用）', async () => {
  const { api, manages } = makeApi({ '42': { status: 1 } });
  const handler = createSetStatusAction({ api });
  const result = await handler.execute(contextOf({ enabled: true }, '42'));
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_change');
  assert.equal(manages.length, 0);

  // 改为禁用 → 真的调用
  const disabled = await handler.execute(contextOf({ enabled: false }, '42'));
  assert.equal(disabled.status, 'succeeded');
  assert.equal(manages[0]!.action, 'disable');
});

test('M2-3：`set_status` 未绑定 / 参数非法 / 回读', async () => {
  const { api } = makeApi({});
  const handler = createSetStatusAction({ api });
  const unbound = await handler.execute(contextOf({ enabled: false }, 'ghost'));
  assert.equal(unbound.status, 'blocked_unbound');

  const bad = await handler.execute(contextOf({ enabled: 'yes' }, '42'));
  assert.equal(bad.status, 'failed');
  assert.equal(bad.retryable, false);

  const { api: api2 } = makeApi({ '42': { status: 1 } });
  const handler2 = createSetStatusAction({ api: api2 });
  await handler2.execute(contextOf({ enabled: false }, '42'));
  const check = await handler2.verify!(contextOf({ enabled: false }, '42'));
  assert.equal(check.verified, true);
  assert.equal(check.actual, false);
});

// ─────────────────────────── 注册表 ───────────────────────────

test('★ M2-2/M2-3：一次性注册三个动作（动作名符合 `<pluginId>:<actionName>` 规范形）', () => {
  const registry = new ActionRegistry();
  const { api } = makeApi({ '42': {} });
  const names = registerNewapiActions(registry, {
    setGroup: { api, now: () => NOW },
    manage: { api },
  });
  assert.deepEqual(names, ['newapi-set-group:set_group', 'newapi-add-quota:add_quota', 'newapi-set-status:set_status']);
  assert.deepEqual(registry.names(), [...names].sort());
});

test('M2-2/M2-3：NO_LOCK 直接执行（单进程串行场景的默认）', async () => {
  let ran = false;
  const result = await NO_LOCK.withLock('u1', async () => {
    ran = true;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(ran, true);
});
