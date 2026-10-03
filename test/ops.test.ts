/**
 * 可运营性验收（M6-1 指标 / M6-7 健康检查与优雅启停）。
 *
 * 断言重点：
 *   - **指标文本格式合法**（Prometheus 能抓）：`# HELP` / `# TYPE` / 样本行；
 *   - **标签顺序无关**（同一组标签必须产生同一时间序列，否则会重复计数）；
 *   - **健康检查必须区分 liveness 与 readiness**：DB 故障只影响 readiness，
 *     **不得**影响 liveness（否则编排器会不停重启一个依赖故障的应用）；
 *   - **探测超时必须判 unhealthy**（超时当成健康等于探测失效）；
 *   - **优雅关闭顺序**：先停流量 → 再释放资源；单步失败不阻断后续。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Counter,
  createAppMetrics,
  DEFAULT_BUCKETS,
  Gauge,
  Histogram,
  MetricsRegistry,
} from '../src/kernel/metrics.ts';
import {
  databaseCheck,
  eventLoopCheck,
  GracefulShutdown,
  HealthRegistry,
  migrationCheck,
  schedulerCheck,
} from '../src/kernel/health.ts';

// ─────────────────────────── 指标 ───────────────────────────

test('Counter：自增、标签、文本格式（含 HELP/TYPE）', () => {
  const counter = new Counter('gate_test_total', '测试计数器');
  counter.inc();
  counter.inc({ result: 'ok' }, 2);
  const text = counter.render().join('\n');
  assert.match(text, /# HELP gate_test_total 测试计数器/);
  assert.match(text, /# TYPE gate_test_total counter/);
  assert.match(text, /^gate_test_total 1$/m);
  assert.match(text, /gate_test_total\{result="ok"\} 2/);
  assert.equal(counter.value({ result: 'ok' }), 2);
});

test('★ 标签顺序无关：同一组标签产生同一时间序列（否则 Prometheus 会重复计数）', () => {
  const counter = new Counter('gate_labels_total', 'x');
  counter.inc({ siteId: 's1', status: 'ok' });
  counter.inc({ status: 'ok', siteId: 's1' });
  assert.equal(counter.value({ siteId: 's1', status: 'ok' }), 2);
  const lines = counter.render().filter((l) => l.startsWith('gate_labels_total{'));
  assert.equal(lines.length, 1, '同一组标签只能有一行');
});

test('Counter：负数自增被拒绝（counter 语义上不能减少）', () => {
  const counter = new Counter('gate_neg_total', 'x');
  assert.throws(() => counter.inc({}, -1), /不能减少/);
});

test('指标名非法 → 抛错（Prometheus 规范）', () => {
  assert.throws(() => new Counter('bad-name', 'x'), /非法指标名/);
  assert.throws(() => new Counter('1starts_with_digit', 'x'), /非法指标名/);
});

test('Gauge：set/inc/dec 与回调指标（抓取时求值）', () => {
  const gauge = new Gauge('gate_depth', '队列深度');
  gauge.set(5);
  gauge.inc();
  gauge.dec({ kind: 'queue' }, 2);
  assert.equal(gauge.value(), 6);
  assert.equal(gauge.value({ kind: 'queue' }), -2);

  let dynamic = 10;
  gauge.callback({ kind: 'dynamic' }, () => dynamic);
  dynamic = 42;
  assert.match(gauge.render().join('\n'), /gate_depth\{kind="dynamic"\} 42/);
});

test('★ Gauge：回调抛错不影响抓取（一个坏指标不能让整个 /metrics 挂掉）', () => {
  const gauge = new Gauge('gate_bad_callback', 'x');
  gauge.callback({}, () => {
    throw new Error('计算失败');
  });
  const text = gauge.render().join('\n');
  assert.match(text, /gate_bad_callback 0|NaN/);
});

test('Histogram：分桶计数、sum、count 与 +Inf', () => {
  const histogram = new Histogram('gate_latency_seconds', '耗时', [0.1, 1, 10]);
  histogram.observe(0.05);
  histogram.observe(0.5);
  histogram.observe(5);
  const text = histogram.render().join('\n');
  assert.match(text, /gate_latency_seconds_bucket\{le="0.1"\} 1/);
  assert.match(text, /gate_latency_seconds_bucket\{le="1"\} 2/);
  assert.match(text, /gate_latency_seconds_bucket\{le="10"\} 3/);
  assert.match(text, /gate_latency_seconds_bucket\{le="\+Inf"\} 3/);
  assert.match(text, /gate_latency_seconds_count 3/);
  assert.match(text, /gate_latency_seconds_sum 5.55/);
  assert.equal(histogram.count(), 3);
});

test('Histogram：带标签时 bucket 行格式合法（le 与其它标签同组）', () => {
  const histogram = new Histogram('gate_h_seconds', 'x', [1]);
  histogram.observe(0.5, { policy: 'edu' });
  const text = histogram.render().join('\n');
  assert.match(text, /gate_h_seconds_bucket\{policy="edu",le="1"\} 1/);
  assert.match(text, /gate_h_seconds_count\{policy="edu"\} 1/);
});

test('Registry：同类型重复注册返回同一实例；类型冲突抛错；render 输出完整', () => {
  const registry = new MetricsRegistry();
  const a = registry.counter('gate_x_total', 'x');
  const b = registry.counter('gate_x_total', 'x');
  assert.equal(a, b);
  assert.throws(() => registry.gauge('gate_x_total', 'x'), /类型不同/);
  assert.match(registry.render(), /# TYPE gate_x_total counter/);
  assert.deepEqual(registry.names(), ['gate_x_total']);
});

test('应用指标集：名称前缀统一为 gate_，且包含文档要求的核心指标', () => {
  const metrics = createAppMetrics();
  for (const name of metrics.registry.names()) {
    assert.match(name, /^gate_/, `指标 ${name} 应使用 gate_ 前缀`);
  }
  const names = metrics.registry.names();
  for (const required of [
    'gate_plugin_fact_age_seconds',
    'gate_patrol_duration_seconds',
    'gate_actions_total',
    'gate_http_requests_total',
    'gate_permission_denied_total',
  ]) {
    assert.ok(names.includes(required), `缺少指标 ${required}`);
  }
  assert.deepEqual(DEFAULT_BUCKETS.length > 5, true);
});

test('★ 应用指标：标签里不得出现主体标识（多租户基数会爆炸）', () => {
  const metrics = createAppMetrics();
  metrics.patrolSubjects.inc({ decision: 'satisfied' }, 1);
  metrics.actionsTotal.inc({ action: 'checkin:grant', status: 'succeeded' });
  const text = metrics.registry.render();
  // 断言打点处只用聚合维度
  assert.equal(/userId=|externalId=|email="/.test(text), false, '指标标签不得包含主体标识');
  assert.match(text, /decision="satisfied"/);
});

// ─────────────────────────── 健康检查 ───────────────────────────

test('★ liveness 与 readiness 必须分开：DB 故障只影响 readiness', async () => {
  const registry = new HealthRegistry();
  registry.register(eventLoopCheck());
  registry.register(
    databaseCheck(async () => {
      throw new Error('连接被拒绝');
    }),
  );

  const live = await registry.run('liveness');
  assert.equal(live.status, 'healthy', '★ 依赖故障不得让 liveness 失败（否则编排器会不停重启）');
  assert.equal(live.checks.length, 1);

  const ready = await registry.run('readiness');
  assert.equal(ready.status, 'unhealthy');
  assert.match(ready.checks[0]!.detail!, /连接被拒绝/);
});

test('非关键检查失败 → degraded（能服务但功能受限）', async () => {
  const registry = new HealthRegistry();
  registry.register(databaseCheck(async () => undefined));
  registry.register(
    schedulerCheck({ started: () => false }), // critical: false
  );
  const report = await registry.run('readiness');
  assert.equal(report.status, 'degraded');
  assert.match(report.checks.find((c) => c.name === 'scheduler')!.detail!, /调度器未启动/);
});

test('★ 探测超时必须判 unhealthy（超时当健康等于探测失效）', async () => {
  const registry = new HealthRegistry({ checkTimeoutMs: 30 });
  registry.register({
    name: 'slow_dependency',
    kind: 'readiness',
    run: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'healthy' }), 500)),
  });
  const report = await registry.run('readiness');
  assert.equal(report.status, 'unhealthy');
  assert.match(report.checks[0]!.detail!, /未返回/);
});

test('探测抛错也判 unhealthy（不得当成健康）', async () => {
  const registry = new HealthRegistry();
  registry.register({
    name: 'boom',
    kind: 'readiness',
    run: () => {
      throw new Error('内部错误');
    },
  });
  const report = await registry.run('readiness');
  assert.equal(report.status, 'unhealthy');
  assert.match(report.checks[0]!.detail!, /内部错误/);
});

test('迁移检查：未执行迁移 / 版本不匹配 → unhealthy（「起来了但库是旧的」是最危险的中间态）', async () => {
  const missing = new HealthRegistry();
  missing.register(migrationCheck({ expected: '0001_init', current: async () => null }));
  assert.equal((await missing.run('readiness')).status, 'unhealthy');
  assert.match((await missing.run('readiness')).checks[0]!.detail!, /没有迁移记录/);

  const mismatch = new HealthRegistry();
  mismatch.register(migrationCheck({ expected: '0002_x', current: async () => '0001_init' }));
  const report = await mismatch.run('readiness');
  assert.equal(report.status, 'unhealthy');
  assert.match(report.checks[0]!.detail!, /版本不匹配/);

  const ok = new HealthRegistry();
  ok.register(migrationCheck({ expected: '0001_init', current: async () => '0001_init' }));
  assert.equal((await ok.run('readiness')).status, 'healthy');
});

test('调度器检查：有任务连续失败达上限 → degraded 并给出数量', async () => {
  const registry = new HealthRegistry();
  registry.register(schedulerCheck({ started: () => true, stuckJobs: () => 2 }));
  const report = await registry.run('readiness');
  assert.equal(report.status, 'degraded');
  assert.deepEqual(report.checks[0]!.meta, { stuckJobs: 2 });
});

test('健康报告：耗时与时间戳可读；重复注册同名检查被拒绝', async () => {
  const registry = new HealthRegistry();
  registry.register(eventLoopCheck());
  assert.throws(() => registry.register(eventLoopCheck()), /重复注册/);
  const report = await registry.run();
  assert.ok(report.durationMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(report.checkedAt)));
  assert.deepEqual(registry.names(), ['event_loop']);
});

// ─────────────────────────── 优雅启停 ───────────────────────────

test('★ 优雅关闭：按注册顺序执行；单步失败不阻断后续；最终退出码 0', async () => {
  const steps: string[] = [];
  const exits: number[] = [];
  const shutdown = new GracefulShutdown({ exit: (code) => void exits.push(code) });
  shutdown.onStart(() => void steps.push('mark-not-ready'));
  shutdown.add({ name: 'stop-scheduler', run: async () => void steps.push('stop-scheduler') });
  shutdown.add({
    name: 'drain-inflight',
    run: async () => {
      steps.push('drain-inflight');
      throw new Error('排空超时');
    },
  });
  shutdown.add({ name: 'close-http', run: async () => void steps.push('close-http') });
  shutdown.add({ name: 'close-db', run: async () => void steps.push('close-db') });

  await shutdown.shutdown();
  assert.deepEqual(steps, ['mark-not-ready', 'stop-scheduler', 'drain-inflight', 'close-http', 'close-db']);
  assert.deepEqual(exits, [0]);
  assert.equal(shutdown.isShuttingDown, true);
  assert.equal(shutdown.isReady, false);
});

test('★ 关闭顺序语义：先标记 not-ready（停流量），再释放资源', async () => {
  const order: string[] = [];
  const shutdown = new GracefulShutdown({ exit: () => undefined });
  shutdown.onStart(() => void order.push('not-ready'));
  shutdown.add({ name: 'http', run: async () => void order.push('http-close') });
  await shutdown.shutdown();
  assert.deepEqual(order, ['not-ready', 'http-close']);
  assert.equal(shutdown.isReady, false, '关闭期间不得 ready');
});

test('优雅关闭：重复调用幂等（第二个信号不会重复执行）', async () => {
  let runs = 0;
  const shutdown = new GracefulShutdown({ exit: () => undefined });
  shutdown.add({ name: 'once', run: async () => void (runs += 1) });
  await shutdown.shutdown();
  await shutdown.shutdown();
  assert.equal(runs, 1);
});

test('优雅关闭：单步超时后继续（不能因为一个资源关不掉就永不退出）', async () => {
  const order: string[] = [];
  const shutdown = new GracefulShutdown({ exit: () => undefined, totalTimeoutMs: 5_000 });
  shutdown.add({
    name: 'hang',
    timeoutMs: 20,
    run: () => new Promise<void>(() => undefined), // 永不 resolve
  });
  shutdown.add({ name: 'after', run: async () => void order.push('after') });
  await shutdown.shutdown();
  assert.deepEqual(order, ['after'], '超时步骤被跳过，后续步骤照常执行');
});
