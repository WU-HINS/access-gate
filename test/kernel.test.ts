/**
 * 内核服务验收（M0-8）：日志脱敏 / DI 生命周期 / 事件总线隔离 / 发件箱至少一次投递 / 调度器单飞。
 *
 * 断言重点：
 *   - 日志**必须**脱敏（否则私钥/令牌会进日志，违反 02 §7.4）；
 *   - 事件订阅者抛错**不得**影响其它订阅者（否则一个坏插件能静默掐断事件链）；
 *   - 发件箱投递失败**必须**退避重试、超限进死信（不得静默丢弃）；
 *   - 调度器同一 jobKey **必须**单飞（并发调用只能有一个真正执行）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectingSink,
  createLogger,
  isSensitiveKey,
  newTraceId,
  redact,
  withTraceId,
} from '../src/kernel/logger.ts';
import { Container, DiError, createToken } from '../src/kernel/di.ts';
import {
  backoffDelay,
  EventBus,
  InMemoryOutboxStore,
  matchesPattern,
  OutboxDispatcher,
} from '../src/kernel/events.ts';
import { InMemoryJobStore, Scheduler } from '../src/kernel/scheduler.ts';

// ─────────────────────────── 日志 ───────────────────────────

test('日志脱敏：敏感键（含嵌套与数组）一律替换，非敏感键保留', () => {
  const { sink, records } = collectingSink();
  const logger = createLogger({ level: 'debug', sink });
  logger.info('下游调用', {
    pluginId: 'newapi-provider',
    apiKey: 'sk-live-123',
    nested: { clientSecret: 'shh', safe: 1 },
    list: [{ token: 't1', name: 'ok' }],
    pat: 'pat-xyz',
  });

  const fields = records[0]!.fields!;
  assert.equal(fields['pluginId'], 'newapi-provider');
  assert.equal(fields['apiKey'], '[REDACTED]');
  assert.equal(fields['pat'], '[REDACTED]');
  assert.deepEqual(fields['nested'], { clientSecret: '[REDACTED]', safe: 1 });
  assert.deepEqual(fields['list'], [{ token: '[REDACTED]', name: 'ok' }]);
});

test('日志脱敏：循环引用与大深度不会抛错或死循环', () => {
  const cyclic: Record<string, unknown> = { name: 'a' };
  cyclic['self'] = cyclic;
  const redacted = redact(cyclic) as Record<string, unknown>;
  assert.equal(redacted['name'], 'a');
  assert.equal(redacted['self'], '[CIRCULAR]');

  let deep: Record<string, unknown> = { bottom: 1 };
  for (let i = 0; i < 10; i += 1) deep = { child: deep };
  assert.doesNotThrow(() => redact(deep));
});

test('isSensitiveKey：覆盖 password/secret/token/authorization/privateKey/ciphertext 等', () => {
  for (const key of ['password', 'dbPassword', 'client_secret', 'accessToken', 'authorization', 'privateKey', 'ciphertext', 'authTag', 'masterKey'])
    assert.equal(isSensitiveKey(key), true, `${key} 应被判为敏感`);
  for (const key of ['pluginId', 'username', 'email', 'count']) assert.equal(isSensitiveKey(key), false, `${key} 不应敏感`);
});

test('traceId：AsyncLocalStorage 贯穿；日志自动带上；不同上下文互不干扰', () => {
  const { sink, records } = collectingSink();
  const logger = createLogger({ sink });
  const id = newTraceId();
  withTraceId(id, () => logger.info('inside'));
  logger.info('outside');
  assert.equal(records[0]!.traceId, id);
  assert.equal(records[1]!.traceId, undefined);
});

test('子 logger：字段合并且子字段优先；级别过滤生效', () => {
  const { sink, records } = collectingSink();
  const logger = createLogger({ level: 'warn', sink, base: { component: 'kernel', level: 'base' } });
  const child = logger.child({ component: 'scheduler' });
  logger.info('不该出现');
  child.warn('该出现');
  assert.equal(records.length, 1);
  assert.equal(records[0]!.fields!['component'], 'scheduler');
});

// ─────────────────────────── DI ───────────────────────────

test('DI：单例惰性初始化且复用；transient 每次新建；未注册即报错', async () => {
  const container = new Container();
  const counter = createToken<{ n: number }>('counter');
  let built = 0;
  container.singleton(counter, () => {
    built += 1;
    return { n: built };
  });

  assert.equal(built, 0, '惰性：注册时不构造');
  assert.equal(container.resolve(counter), container.resolve(counter));
  assert.equal(built, 1);

  const transientToken = createToken<object>('t');
  container.transient(transientToken, () => ({}));
  assert.notEqual(container.resolve(transientToken), container.resolve(transientToken));

  assert.throws(() => container.resolve(createToken('nope')), DiError);
});

test('DI：close() 逆序释放（先起后停），并聚合释放错误', async () => {
  const container = new Container();
  const order: string[] = [];
  container.registerDisposable({ close: () => void order.push('first') });
  container.registerDisposable({ close: () => void order.push('second') });
  container.registerDisposable({
    close: () => {
      order.push('third');
      throw new Error('释放失败');
    },
  });
  await assert.rejects(container.close(), AggregateError);
  assert.deepEqual(order, ['third', 'second', 'first']);
  assert.throws(() => container.resolve(createToken('x')), DiError);
});

// ─────────────────────────── 事件总线 ───────────────────────────

test('通配符匹配：*、前缀、后缀与精确匹配', () => {
  assert.equal(matchesPattern('*', 'anything.at.all'), true);
  assert.equal(matchesPattern('policy.*', 'policy.published'), true);
  assert.equal(matchesPattern('policy.*', 'identity.linked'), false);
  assert.equal(matchesPattern('*.published', 'policy.published'), true);
  assert.equal(matchesPattern('policy.published', 'policy.published'), true);
  assert.equal(matchesPattern('policy.published', 'policy.published.extra'), false);
});

test('事件总线：一个订阅者抛错不影响其它订阅者（隔离），once 只触发一次', async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.on('policy.*', () => {
    throw new Error('坏订阅者');
  });
  bus.on('policy.*', () => void seen.push('good-1'));
  bus.once('policy.published', () => void seen.push('once'));

  // ★ 隔离 + 可见：坏订阅者被隔离（好订阅者照常执行），但失败必须抛出以便上游重试
  await assert.rejects(bus.emit({ type: 'policy.published', payload: {}, occurredAt: new Date() }), AggregateError);
  await assert.rejects(bus.emit({ type: 'policy.published', payload: {}, occurredAt: new Date() }), AggregateError);

  assert.deepEqual(seen, ['good-1', 'once', 'good-1']);

  // 不关心失败时用 emitSafely：不抛错，但仍执行其它订阅者
  const safeSeen: string[] = [];
  const bus2 = new EventBus();
  bus2.on('*', () => {
    throw new Error('坏');
  });
  bus2.on('*', () => void safeSeen.push('ok'));
  await bus2.emitSafely({ type: 'x.y', payload: {}, occurredAt: new Date() });
  assert.deepEqual(safeSeen, ['ok']);
});

// ─────────────────────────── 发件箱 ───────────────────────────

test('发件箱：投递成功标记 delivered；失败退避重试；超限进死信并可见', async () => {
  const store = new InMemoryOutboxStore();
  const bus = new EventBus();
  let failTimes = 0;
  bus.on('grant.*', () => {
    if (failTimes < 2) {
      failTimes += 1;
      throw new Error('下游暂时不可用');
    }
  });

  const dispatcher = new OutboxDispatcher({ store, bus, maxAttempts: 5, baseBackoffMs: 1_000, maxBackoffMs: 8_000 });
  await store.append({ type: 'grant.revoked', payload: { userId: 'u1' }, occurredAt: new Date() });

  const t0 = new Date();
  // 第 1 次：订阅者失败 → 记 1 次尝试，退避 base=1000ms
  assert.deepEqual(await dispatcher.dispatchDue(10, t0), { delivered: 0, retried: 1, dead: 0 });
  // 退避期内不再投递
  assert.deepEqual(await dispatcher.dispatchDue(10, new Date(t0.getTime() + 500)), { delivered: 0, retried: 0, dead: 0 });
  // 第 2 次（t0+1100）：仍失败 → 退避翻倍到 2000ms
  assert.deepEqual(await dispatcher.dispatchDue(10, new Date(t0.getTime() + 1_100)), { delivered: 0, retried: 1, dead: 0 });
  // 2000ms 退避期内不再投递
  assert.deepEqual(await dispatcher.dispatchDue(10, new Date(t0.getTime() + 2_000)), { delivered: 0, retried: 0, dead: 0 });
  // 第 3 次（t0+3200）：订阅者恢复 → 投递成功
  assert.deepEqual(await dispatcher.dispatchDue(10, new Date(t0.getTime() + 3_200)), { delivered: 1, retried: 0, dead: 0 });
  assert.equal(failTimes, 2);

  // 一直失败的 → 进死信
  const store2 = new InMemoryOutboxStore();
  const bus2 = new EventBus();
  bus2.on('*', () => {
    throw new Error('永远失败');
  });
  const dispatcher2 = new OutboxDispatcher({ store: store2, bus: bus2, maxAttempts: 2, baseBackoffMs: 10, maxBackoffMs: 10 });
  await store2.append({ type: 'x.y', payload: {}, occurredAt: new Date() });
  await dispatcher2.dispatchDue(10, new Date());
  const after = await dispatcher2.dispatchDue(10, new Date(Date.now() + 100));
  assert.equal(after.dead, 1);
  assert.equal((await store2.deadLetters()).length, 1, '死信必须可见，不能静默丢弃');
});

test('退避计算：指数增长且封顶', () => {
  assert.equal(backoffDelay(1, 1_000, 60_000), 1_000);
  assert.equal(backoffDelay(2, 1_000, 60_000), 2_000);
  assert.equal(backoffDelay(3, 1_000, 60_000), 4_000);
  assert.equal(backoffDelay(20, 1_000, 60_000), 60_000);
});

// ─────────────────────────── 调度器 ───────────────────────────

test('调度器单飞：同一 jobKey 并发触发只真正执行一次', async () => {
  const store = new InMemoryJobStore();
  const scheduler = new Scheduler({ store, holder: 'A' });
  let executions = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await scheduler.register({
    jobKey: 'sync.provider.full',
    intervalMs: 1_000,
    run: async () => {
      executions += 1;
      await gate;
    },
  });

  const first = scheduler.runDue(new Date());
  // 第二次在第一次持有租约期间触发
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await scheduler.runDue(new Date());
  release();
  const firstSummary = await first;

  assert.equal(executions, 1, '同一 jobKey 不得并发执行');
  assert.equal(firstSummary[0]!.outcome, 'succeeded');
  // 第二次因池内 running 或租约不可得被跳过/丢租约，但绝不重复执行
  assert.ok(['skipped', 'lease-lost'].includes(second[0]?.outcome ?? 'skipped'));
});

test('调度器：失败按指数退避，成功写回 cursor（断点续跑），到上限后停止', async () => {
  const store = new InMemoryJobStore();
  const scheduler = new Scheduler({ store, holder: 'A' });
  let attempt = 0;
  await scheduler.register({
    jobKey: 'job.a',
    intervalMs: 1_000,
    backoffBaseMs: 100,
    maxBackoffMs: 1_000,
    maxConsecutiveFailures: 3,
    run: async ({ cursor }) => {
      attempt += 1;
      if (attempt < 2) throw new Error(`第 ${attempt} 次失败`);
      return { cursor: { ...cursor, page: attempt } };
    },
  });

  const t0 = new Date();
  const first = await scheduler.runDue(t0, 10);
  assert.equal(first[0]!.outcome, 'failed');
  const afterFail = await store.get('job.a');
  assert.equal(afterFail!.failCount, 1);
  assert.ok(afterFail!.backoffUntil!.getTime() > t0.getTime(), '失败必须设置退避时间');

  // 退避期内不跑
  assert.deepEqual(await scheduler.runDue(new Date(t0.getTime() + 50), 10), []);
  // 退避到期 → 成功并写回 cursor
  const second = await scheduler.runDue(new Date(t0.getTime() + 200), 10);
  assert.equal(second[0]!.outcome, 'succeeded');
  const afterOk = await store.get('job.a');
  assert.deepEqual(afterOk!.cursor, { page: 2 });

  // 连续失败到上限 → 停止调度（不再有下一次 nextRunAt）
  const store2 = new InMemoryJobStore();
  const scheduler2 = new Scheduler({ store: store2, holder: 'B' });
  await scheduler2.register({
    jobKey: 'job.b',
    intervalMs: 1_000,
    backoffBaseMs: 1,
    maxBackoffMs: 1,
    maxConsecutiveFailures: 2,
    run: async () => {
      throw new Error('一直失败');
    },
  });
  let clock = new Date();
  await scheduler2.runDue(clock, 10);
  clock = new Date(clock.getTime() + 10);
  await scheduler2.runDue(clock, 10);
  const stopped = await store2.get('job.b');
  assert.equal(stopped!.status, 'failed');
  assert.equal(stopped!.failCount, 2);
});

test('调度器：租约过期后可被抢占（防进程崩溃导致任务永久卡死）', async () => {
  const store = new InMemoryJobStore();
  const holderA = new Scheduler({ store, holder: 'A' });
  const holderB = new Scheduler({ store, holder: 'B' });
  let ranA = 0;
  let ranB = 0;

  // A 取租约但不释放（模拟崩溃）
  const t0 = new Date();
  assert.equal(await store.tryAcquire('job.x', 'A', 1_000, t0), true);
  assert.equal(await store.tryAcquire('job.x', 'B', 1_000, new Date(t0.getTime() + 500)), false, '租约未过期不得抢占');

  await holderA.register({ jobKey: 'job.x', intervalMs: 1_000, run: async () => void (ranA += 1) });
  await holderB.register({ jobKey: 'job.x', intervalMs: 1_000, run: async () => void (ranB += 1) });

  // 租约过期后 B 可执行
  const later = new Date(t0.getTime() + 2_000);
  const summaries = await holderB.runDue(later, 10);
  assert.equal(summaries[0]!.outcome, 'succeeded');
  assert.equal(ranB, 1);
  assert.equal(ranA, 0);
});

test('调度器：未注册该任务时不执行（多实例分工）', async () => {
  const store = new InMemoryJobStore();
  await store.tryAcquire('job.y', 'other', 1_000, new Date(0));
  await store.release('job.y', 'other');
  const scheduler = new Scheduler({ store, holder: 'me' });
  assert.deepEqual(await scheduler.runDue(new Date(), 10), []);
});
