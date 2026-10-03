/**
 * 动作执行器验收（M2-1）。
 *
 * 断言重点（对应 docs/05 §3 的硬要求）：
 *   - **幂等键公式**：`hash(siteId, userId, policyId, actionSeq, action)`，**不含** targetValue / 时间桶；
 *     同一计划重试复用同一 seq → 不重复执行；状态再迁移（seq 变）→ 回到原值也能重新执行；
 *   - **5xx/超时退避重试；4xx 不重试**（重试无意义且放大故障）；
 *   - **值不变直接跳过**（改分组会踢用户下线，绝不能发无谓请求）；
 *   - **部分成功 → partially_applied**（不是 failed：已生效的部分必须如实记录）；
 *   - **回读未达成不算成功**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActionExecutor,
  ActionRegistry,
  createSetGroupHandler,
  DEFAULT_RETRY,
  idempotencyKeyOf,
  InMemoryActionLogStore,
  type ActionContext,
  type ActionResult,
} from '../src/core/action-executor.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

const PLAN_INPUT = {
  siteId: 'site-1',
  userId: 'user-1',
  policyId: 'policy-1',
  actionSeq: 7,
  actions: [{ action: 'checkin:grant', params: { scope: 'daily' } }],
};

function executor(registry: ActionRegistry, log = new InMemoryActionLogStore(), sleeps: number[] = []) {
  return {
    log,
    sleeps,
    executor: new ActionExecutor({
      registry,
      log,
      retry: DEFAULT_RETRY,
      sleep: async (ms) => void sleeps.push(ms),
      now: () => new Date('2025-06-01T00:00:00Z'),
      verifyAfterExecute: true,
    }),
  };
}

// ─────────────────────────── 幂等键 ───────────────────────────

test('★ 幂等键公式：hash(siteId, userId, policyId, actionSeq, action)，不含 targetValue', () => {
  const base = { siteId: 's', userId: 'u', policyId: 'p', actionSeq: 1, action: 'a:b' };
  const key = idempotencyKeyOf(base);
  assert.match(key, /^[0-9a-f]{32}$/);
  // 纯函数：同样输入同样输出
  assert.equal(key, idempotencyKeyOf(base));
  // 五个维度任一变化 → 键变化
  for (const [field, value] of [
    ['siteId', 's2'],
    ['userId', 'u2'],
    ['policyId', 'p2'],
    ['actionSeq', 2],
    ['action', 'a:c'],
  ] as const) {
    assert.notEqual(idempotencyKeyOf({ ...base, [field]: value }), key, `${field} 变化应改变幂等键`);
  }
});

test('★ actionSeq 同时满足两个相反要求：重试不重复执行；seq 变化后回到原值也能重新执行', async () => {
  const registry = new ActionRegistry();
  let calls = 0;
  registry.register('checkin:grant', {
    async execute() {
      calls += 1;
      return { status: 'succeeded' };
    },
  });
  const { executor: exec, log } = executor(registry);

  const plan1 = exec.buildPlan(PLAN_INPUT);
  await exec.execute(plan1);
  assert.equal(calls, 1);

  // 同一计划重试（同 seq）→ 幂等命中，不再执行
  const retry = await exec.execute(exec.buildPlan(PLAN_INPUT));
  assert.equal(calls, 1, '同一 actionSeq 的重试不得重复执行');
  assert.equal(retry.steps[0]!.idempotentHit, true);

  // 状态再次迁移（seq 递增）→ 新键 → 即使目标值与上次相同也会执行
  const plan2 = exec.buildPlan({ ...PLAN_INPUT, actionSeq: 8 });
  await exec.execute(plan2);
  assert.equal(calls, 2, 'seq 变化后应重新执行（这就是取代「时间桶」的机制）');

  // 日志里两条记录并存
  assert.ok((await log.find('site-1', plan1.steps[0]!.idempotencyKey)) !== undefined);
  assert.ok((await log.find('site-1', plan2.steps[0]!.idempotencyKey)) !== undefined);
});

test('幂等键含 siteId：同用户同策略在不同站点互不去重（跨站点不串味）', async () => {
  const registry = new ActionRegistry();
  let calls = 0;
  registry.register('checkin:grant', {
    async execute() {
      calls += 1;
      return { status: 'succeeded' };
    },
  });
  const { executor: exec } = executor(registry);
  await exec.execute(exec.buildPlan(PLAN_INPUT));
  await exec.execute(exec.buildPlan({ ...PLAN_INPUT, siteId: 'site-2' }));
  assert.equal(calls, 2);
});

test('buildPlan：同一计划内重复声明同一动作只保留一次（键相同，重复无意义）', () => {
  const registry = new ActionRegistry();
  const { executor: exec } = executor(registry);
  const plan = exec.buildPlan({
    ...PLAN_INPUT,
    actions: [
      { action: 'checkin:grant', params: { scope: 'daily' } },
      { action: 'checkin:grant', params: { scope: 'daily' } },
      { action: 'checkin:grant', params: { scope: 'monthly' } },
    ],
  });
  assert.equal(plan.steps.length, 1, '同 action 在同 seq 下键相同，应去重');
});

// ─────────────────────────── 失败与重试 ───────────────────────────

test('★ 可重试失败（5xx/超时）→ 按退避序列重试；最终成功', async () => {
  const registry = new ActionRegistry();
  let attempts = 0;
  registry.register('notify:webhook', {
    async execute() {
      attempts += 1;
      if (attempts < 3) return { status: 'failed', reason: '下游 503', retryable: true };
      return { status: 'succeeded' };
    },
  });
  const { executor: exec, sleeps } = executor(registry);
  const outcome = await exec.execute(exec.buildPlan({ ...PLAN_INPUT, actions: [{ action: 'notify:webhook' }] }));
  assert.equal(outcome.status, 'succeeded');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1_000, 5_000], '按 1s/5s 退避');
});

test('★ 不可重试失败（4xx/配置错）→ **不重试**（重试无意义且放大故障）', async () => {
  const registry = new ActionRegistry();
  let attempts = 0;
  registry.register('newapi-set-group:set_group', {
    async execute() {
      attempts += 1;
      return { status: 'failed', reason: '下游 400：参数错误', retryable: false };
    },
  });
  const { executor: exec, sleeps } = executor(registry);
  const outcome = await exec.execute(exec.buildPlan({ ...PLAN_INPUT, actions: [{ action: 'newapi-set-group:set_group' }] }));
  assert.equal(outcome.status, 'failed');
  assert.equal(attempts, 1, '不可重试失败只尝试一次');
  assert.deepEqual(sleeps, []);
});

test('退避序列用尽后停止（不无限重试）', async () => {
  const registry = new ActionRegistry();
  let attempts = 0;
  registry.register('notify:webhook', {
    async execute() {
      attempts += 1;
      return { status: 'failed', reason: '一直 503', retryable: true };
    },
  });
  const { executor: exec, sleeps } = executor(registry);
  const outcome = await exec.execute(exec.buildPlan({ ...PLAN_INPUT, actions: [{ action: 'notify:webhook' }] }));
  assert.equal(outcome.status, 'failed');
  assert.equal(attempts, DEFAULT_RETRY.backoffMs.length, `尝试次数应等于退避序列长度 ${DEFAULT_RETRY.backoffMs.length}`);
  assert.equal(sleeps.length, DEFAULT_RETRY.backoffMs.length - 1, '最后一次失败后不再等待');
});

test('未注册的动作 → failed 且提示检查插件（不静默跳过）', async () => {
  const registry = new ActionRegistry();
  const { executor: exec } = executor(registry);
  const outcome = await exec.execute(exec.buildPlan({ ...PLAN_INPUT, actions: [{ action: 'ghost:do' }] }));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.steps[0]!.error!, /未注册的动作 'ghost:do'/);
});

// ─────────────────────────── 阻断与补偿 ───────────────────────────

test('★ optional:false 失败 → 阻断后续并补偿已成功步骤；结论 partially_applied', async () => {
  const registry = new ActionRegistry();
  const calls: string[] = [];
  registry.register('a:first', {
    async execute() {
      calls.push('first');
      return { status: 'succeeded' };
    },
  });
  registry.register('a:second', {
    async execute() {
      calls.push('second');
      return { status: 'failed', reason: '下游 500', retryable: false };
    },
  });
  registry.register('a:third', {
    async execute() {
      calls.push('third');
      return { status: 'succeeded' };
    },
  });
  registry.register('a:undo_first', {
    async execute() {
      calls.push('undo_first');
      return { status: 'succeeded' };
    },
  });

  const { executor: exec } = executor(registry);
  const plan = exec.buildPlan({
    ...PLAN_INPUT,
    actions: [
      { action: 'a:first', compensation: { action: 'a:undo_first', params: {} } },
      { action: 'a:second' },
      { action: 'a:third' },
    ],
  });
  const outcome = await exec.execute(plan);
  assert.deepEqual(calls, ['first', 'second', 'undo_first'], 'second 失败后阻断 third，并补偿 first');
  assert.deepEqual(outcome.blocked, ['a:third']);
  assert.deepEqual(outcome.compensated, ['a:first']);
  assert.equal(outcome.status, 'partially_applied', '已生效的部分必须如实记录，不能报 failed');
});

test('optional:true 失败 → 不阻断后续，结论 failed（有失败即非成功）', async () => {
  const registry = new ActionRegistry();
  const calls: string[] = [];
  registry.register('a:opt', {
    async execute() {
      calls.push('opt');
      return { status: 'failed', reason: '非关键失败', retryable: false };
    },
  });
  registry.register('a:main', {
    async execute() {
      calls.push('main');
      return { status: 'succeeded' };
    },
  });
  const { executor: exec } = executor(registry);
  const outcome = await exec.execute(
    exec.buildPlan({ ...PLAN_INPUT, actions: [{ action: 'a:opt', optional: true }, { action: 'a:main' }] }),
  );
  assert.deepEqual(calls, ['opt', 'main'], 'optional 失败不阻断');
  assert.equal(outcome.status, 'partially_applied');
  assert.deepEqual(outcome.blocked, []);
});

test('全部失败 → failed；空计划 → noop', async () => {
  const registry = new ActionRegistry();
  registry.register('a:bad', {
    async execute() {
      return { status: 'failed', reason: 'x', retryable: false };
    },
  });
  const { executor: exec } = executor(registry);
  assert.equal((await exec.execute(exec.buildPlan({ ...PLAN_INPUT, actions: [{ action: 'a:bad' }] }))).status, 'failed');
  assert.equal((await exec.execute(exec.buildPlan({ ...PLAN_INPUT, actions: [] }))).status, 'noop');
});

// ─────────────────────────── 回读校验 ───────────────────────────

test('★ 回读未达成 → verified=false（不得当成成功）', async () => {
  const registry = new ActionRegistry();
  registry.register('newapi-set-group:set_group', {
    async execute() {
      return { status: 'succeeded' };
    },
    async verify() {
      return { verified: false, actual: 'default', expected: 'vip2' };
    },
  });
  const { executor: exec } = executor(registry);
  const outcome = await exec.execute(exec.buildPlan({ ...PLAN_INPUT, actions: [{ action: 'newapi-set-group:set_group' }] }));
  assert.equal(outcome.status, 'succeeded', 'execute 成功即记录成功');
  assert.equal(outcome.steps[0]!.verified, false, '但必须如实标记回读未达成');
});

test('回读抛错 → verified=false（不把校验异常当通过）', async () => {
  const registry = new ActionRegistry();
  registry.register('a:x', {
    async execute() {
      return { status: 'succeeded' };
    },
    async verify() {
      throw new Error('回读超时');
    },
  });
  const { executor: exec } = executor(registry);
  const outcome = await exec.execute(exec.buildPlan({ ...PLAN_INPUT, actions: [{ action: 'a:x' }] }));
  assert.equal(outcome.steps[0]!.verified, false);
});

// ─────────────────────────── set_group 防抖 ───────────────────────────

test('★ set_group：值不变 → skipped/no_change（绝不发无谓请求，因为会踢用户下线）', async () => {
  let writes = 0;
  const handler = createSetGroupHandler({
    externalIdOf: () => '42',
    getSubject: async () => ({ attributes: { group: 'vip2' } }),
    setGroup: async () => void (writes += 1),
  });
  const result = await handler.execute(contextOf({ group: 'vip2' }));
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_change');
  assert.equal(writes, 0);
});

test('set_group：值不同 → 写回并成功；回读确认目标达成', async () => {
  let current = 'default';
  let writes = 0;
  const handler = createSetGroupHandler({
    externalIdOf: () => '42',
    getSubject: async () => ({ attributes: { group: current } }),
    setGroup: async (_id, group) => {
      writes += 1;
      current = group;
    },
  });
  const result = await handler.execute(contextOf({ group: 'vip2' }));
  assert.equal(result.status, 'succeeded');
  assert.equal(writes, 1);
  const check = await handler.verify!(contextOf({ group: 'vip2' }));
  assert.equal(check.verified, true);
  assert.equal(check.actual, 'vip2');
});

test('★ set_group：目标未绑定 → blocked_unbound（不是失败，不计入失败率）', async () => {
  const handler = createSetGroupHandler({
    externalIdOf: () => '42',
    getSubject: async () => null,
    setGroup: async () => undefined,
  });
  const result = await handler.execute(contextOf({ group: 'vip2' }));
  assert.equal(result.status, 'blocked_unbound');
  assert.match(result.reason!, /尚未绑定/);
});

test('set_group：最小变更间隔内 → skipped/rate_limited', async () => {
  let writes = 0;
  const now = new Date('2025-06-01T00:00:00Z');
  const handler = createSetGroupHandler({
    externalIdOf: () => '42',
    getSubject: async () => ({ attributes: { group: 'default' } }),
    setGroup: async () => void (writes += 1),
    minChangeIntervalMs: 60_000,
    lastChangeAt: () => new Date(now.getTime() - 10_000),
    now: () => now,
  });
  const result = await handler.execute(contextOf({ group: 'vip2' }));
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'rate_limited');
  assert.equal(writes, 0);
});

test('set_group：缺 group 参数 → failed 且不可重试（配置错误）', async () => {
  const handler = createSetGroupHandler({
    externalIdOf: () => '42',
    getSubject: async () => ({ attributes: { group: 'default' } }),
    setGroup: async () => undefined,
  });
  const result = await handler.execute(contextOf({}));
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
});

function contextOf(params: Record<string, unknown>): ActionContext {
  return {
    siteId: 'site-1',
    userId: 'user-1',
    policyId: 'policy-1',
    actionSeq: 1,
    idempotencyKey: 'k',
    params,
    attempt: 1,
  };
}

// ─────────────────────────── 注册表 ───────────────────────────

test('ActionRegistry：动作名格式校验；names() 排序稳定（供策略静态校验）', () => {
  const registry = new ActionRegistry();
  registry.register('checkin:grant', { async execute() { return { status: 'succeeded' }; } });
  registry.register('newapi-set-group:set_group', { async execute() { return { status: 'succeeded' }; } });
  assert.deepEqual(registry.names(), ['checkin:grant', 'newapi-set-group:set_group']);
  assert.throws(() => registry.register('NoColon', { async execute() { return { status: 'succeeded' }; } }), /非法/);
});

// ─────────────────────────── 审计可见性 ───────────────────────────

test('执行过程记录日志（成功/退避/回读不一致都可见）', async () => {
  const registry = new ActionRegistry();
  let attempts = 0;
  registry.register('a:flaky', {
    async execute(): Promise<ActionResult> {
      attempts += 1;
      return attempts === 1 ? { status: 'failed', reason: '503', retryable: true } : { status: 'succeeded' };
    },
    async verify() {
      return { verified: false, actual: 'a', expected: 'b' };
    },
  });
  const { sink, records } = collectingSink();
  const log = new InMemoryActionLogStore();
  const exec = new ActionExecutor({
    registry,
    log,
    logger: createLogger({ level: 'debug', sink }),
    sleep: async () => undefined,
    now: () => new Date('2025-06-01T00:00:00Z'),
  });
  await exec.execute(exec.buildPlan({ ...PLAN_INPUT, actions: [{ action: 'a:flaky' }] }));
  assert.ok(records.some((r) => r.level === 'warn' && /退避重试/.test(r.message)));
  assert.ok(records.some((r) => r.level === 'warn' && /回读未达成/.test(r.message)));
});
