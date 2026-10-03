/**
 * 巡检服务验收（M2-6 接线）。
 *
 * 断言重点：
 *   - **进程内单飞**：并发调用 `runOnce()` 只执行**一轮**。
 *     若失效，同一进程的两个巡检会同时读同一状态再各自迁移 →
 *     `actionSeq` 双递增 → **凭空产生新幂等键 → 重复写下游**（会踢用户下线）。
 *   - **动态取策略**：每轮重新读取 → 「发布即生效」，不需重启。
 *   - **失败不吞**：连续失败计数 + `isStuck()`（供 readiness 降级）。
 *   - **事务包裹**：DB 模式下每轮巡检必须在事务内（否则 `Db.query` 的
 *     「必须在事务内」断言会抛错——真实接线时暴露的问题）。
 *   - **stop 等待在途**：不打断正在跑的巡检（避免留下半迁移状态）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PatrolService, STUCK_FAILURE_THRESHOLD } from '../src/core/patrol-service.ts';
import { InMemoryEvaluationStore, InMemoryLifecycleStateStore, type SubjectDirectory } from '../src/core/patrol.ts';
import { ActionExecutor, ActionRegistry, InMemoryActionLogStore } from '../src/core/action-executor.ts';
import { Scheduler, InMemoryJobStore } from '../src/kernel/scheduler.ts';
import { FactPipeline, InMemoryFactStore } from '../src/plugin/host-api.ts';
import { EMAIL_DOMAIN_MANIFEST, evaluateEmailDomain } from '../src/plugin/builtin/email-domain.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import type { PolicyDocument } from '../src/policy/model.ts';

const SITE = 'site-1';
const NOW = new Date('2025-06-01T00:00:00Z');

const POLICY: PolicyDocument = {
  code: 'edu',
  name: '教育邮箱',
  version: 1,
  enabled: true,
  spec: {
    requirements: { expression: { matches: { 'fact.email.domain': ['*.edu.cn'] } } },
    actions: { onSatisfied: [{ action: 'checkin:grant', params: {} }] },
  },
};

interface Harness {
  service: PatrolService;
  scheduler: Scheduler;
  /** 调度器的作业存储（Scheduler.store 是私有字段，测试自己持有引用） */
  jobStore: InMemoryJobStore;
  policyLoads: () => number;
  /** 让下一轮巡检抛错 */
  failNext: (error?: Error) => void;
  transactionCalls: () => number;
  close: () => Promise<void>;
}

async function makeHarness(options: { withTransaction?: boolean } = {}): Promise<Harness> {
  const factStore = new InMemoryFactStore();
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  // ★ 事实按主体存：主体 externalId 为 'u1'，管线也必须写 'u1'
  const pipeline = new FactPipeline({ store: factStore, manifest, userId: 'u1' });
  await pipeline.emit({ domain: 'tsinghua.edu.cn', is_edu: true, matched_rule: 'allow:*.edu.cn', verified: true }, NOW);

  const directory: SubjectDirectory = {
    async list(_siteId, limit, offset) {
      const all = [{ externalId: 'u1', email: 'a@tsinghua.edu.cn', emailVerified: true, attributes: { group: 'default' } }];
      return all.slice(offset, offset + limit);
    },
    async count() {
      return 1;
    },
  };

  const registry = new ActionRegistry();
  let actionCalls = 0;
  registry.register('checkin:grant', {
    async execute() {
      actionCalls += 1;
      return { status: 'succeeded' };
    },
  });

  const executor = new ActionExecutor({ registry, log: new InMemoryActionLogStore(), sleep: async () => undefined, now: () => NOW });

  let policyLoads = 0;
  let pendingFailure: Error | undefined;
  let transactionCalls = 0;

  const jobStore = new InMemoryJobStore();
  const scheduler = new Scheduler({ store: jobStore, logger: silentLogger, holder: 'test' });

  const service = new PatrolService({
    siteId: SITE,
    policies: async () => {
      policyLoads += 1;
      return [POLICY];
    },
    directory,
    facts: factStore,
    factSources: [{ pluginId: 'email', fields: ['domain', 'verified'], ttl: '30d' }],
    states: new InMemoryLifecycleStateStore(),
    evaluations: new InMemoryEvaluationStore(),
    lifecycle: { gracePeriodMs: 72 * 3_600_000 },
    executor,
    scheduler,
    logger: silentLogger,
    now: () => NOW,
    ...(options.withTransaction === true
      ? {
          transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
            transactionCalls += 1;
            if (pendingFailure !== undefined) {
              const error = pendingFailure;
              pendingFailure = undefined;
              throw error;
            }
            return fn();
          },
        }
      : {}),
  });

  return {
    service,
    scheduler,
    jobStore,
    policyLoads: () => policyLoads,
    failNext: (error = new Error('模拟下游故障')) => {
      pendingFailure = error;
    },
    transactionCalls: () => transactionCalls,
    close: async () => {
      await service.stop();
      await scheduler.close();
    },
    // 暴露动作调用数供断言
    ...({ actionCalls: () => actionCalls } as object),
  } as Harness;
}

// ─────────────────────────── 单飞 ───────────────────────────

test('★ 进程内单飞：并发 5 次 runOnce 只执行一轮（否则 actionSeq 双递增 → 重复写下游）', async () => {
  const harness = await makeHarness();
  try {
    const reports = await Promise.all([1, 2, 3, 4, 5].map(() => harness.service.runOnce()));
    // 只加载一次策略 = 只构造了一个 Patrol = 只跑了一轮
    assert.equal(harness.policyLoads(), 1, '★ 并发调用必须复用同一轮，而不是各自跑一轮');
    // 返回的是同一个结果对象
    assert.ok(reports.every((r) => r === reports[0]), '并发调用应返回同一个报告');
    assert.equal(harness.service.status().totalRuns, 1, 'totalRuns 只应计 1 次');

    // 顺序调用才是新的一轮
    await harness.service.runOnce();
    assert.equal(harness.policyLoads(), 2);
    assert.equal(harness.service.status().totalRuns, 2);
  } finally {
    await harness.close();
  }
});

test('单飞：一轮结束后可再次执行（锁被正确释放）', async () => {
  const harness = await makeHarness();
  try {
    await harness.service.runOnce();
    await harness.service.runOnce();
    assert.equal(harness.service.status().totalRuns, 2);
    assert.equal(harness.service.status().running, false, '执行结束后 running 应为 false');
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 动态策略 ───────────────────────────

test('★ 动态取策略：每轮重新读取 → 「发布即生效」，无需重启', async () => {
  const harness = await makeHarness();
  try {
    await harness.service.runOnce();
    await harness.service.runOnce();
    await harness.service.runOnce();
    assert.equal(harness.policyLoads(), 3, '每轮都应重新读取策略（而不是启动时快照）');
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 调度器接线 ───────────────────────────

test('★ 注册为调度任务：ensureJob 被调用（否则 dueJobs 永远为空 → 调度器从不执行）', async () => {
  const harness = await makeHarness();
  try {
    await harness.service.start();
    assert.equal(harness.service.status().registered, true);
    const job = await harness.jobStore.get(harness.service.jobKey);
    assert.ok(job !== undefined, '任务必须写入存储，否则调度器永远看不到它');
    assert.equal(job.jobKey, harness.service.jobKey);

    // 调度器跑到期任务 → 应真的执行一轮巡检
    const summaries = await harness.scheduler.runDue(NOW);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.outcome, 'succeeded');
    assert.equal(harness.service.status().totalRuns, 1, '调度触发应真的跑了一轮');
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 失败处理 ───────────────────────────

test('★ 失败不吞：计入连续失败数；达阈值后 isStuck() 为真（供 readiness 降级）', async () => {
  const harness = await makeHarness({ withTransaction: true });
  try {
    for (let i = 1; i <= STUCK_FAILURE_THRESHOLD; i += 1) {
      harness.failNext(new Error(`故障 ${i}`));
      await assert.rejects(harness.service.runOnce(), /故障/);
      assert.equal(harness.service.status().consecutiveFailures, i, `第 ${i} 次失败后计数应为 ${i}`);
      assert.equal(harness.service.status().lastOutcome, 'failed');
      assert.equal(harness.service.status().lastError, `故障 ${i}`);
    }
    assert.equal(harness.service.isStuck(), true, '连续失败达阈值 → 判定为停摆');

    // 成功后应清零
    await harness.service.runOnce();
    assert.equal(harness.service.status().consecutiveFailures, 0);
    assert.equal(harness.service.isStuck(), false);
    assert.equal(harness.service.status().lastError, null);
  } finally {
    await harness.close();
  }
});

test('失败时 runOnce 抛错（不静默返回空报告——那会让调用方以为成功了）', async () => {
  const harness = await makeHarness({ withTransaction: true });
  try {
    harness.failNext(new Error('下游不可用'));
    await assert.rejects(harness.service.runOnce(), /下游不可用/);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 事务包裹 ───────────────────────────

test('★ 事务包裹：提供 transaction 时每轮巡检都在事务内执行（DB 模式的硬要求）', async () => {
  const harness = await makeHarness({ withTransaction: true });
  try {
    await harness.service.runOnce();
    assert.ok(harness.transactionCalls() > 0, '★ 必须走事务：Db.query 有「必须在事务内」的断言，否则巡检跑不起来');
  } finally {
    await harness.close();
  }
});

test('事务包裹：同一主体的所有策略在同一事务内（部分失败不留半迁移状态）', async () => {
  const harness = await makeHarness({ withTransaction: true });
  try {
    // ★ 这条测试原本断言「恰好 1 次事务」，隐含假设「只有主体处理需要事务」——
    //   而那个假设在**真实 PG 下是错的**：`directory.list()` 会查主体表，
    //   事务外调用会让巡检**执行即失败**（见 reports 的 R12）。
    //
    //   ★ 但也不该绑定精确次数（那样每次实现优化都要改测试）。
    //   这里断言**语义**：事务次数 ≥ 2（分页 + 主体处理都要有事务），
    //   且**有界**（不会退化成「每个策略一个事务」）。
    await harness.service.runOnce();
    const calls = harness.transactionCalls();
    assert.ok(calls >= 2, `分页取数与主体处理都必须在事务内（实际 ${calls} 次）`);
    // 1 个主体 + 1 条策略 → 分页 2 次（含跳出循环的空批）+ 主体处理 1 次 = 3
    assert.ok(calls <= 4, `不应退化成「每策略一个事务」（实际 ${calls} 次）`);
  } finally {
    await harness.close();
  }
});

// ─────────────────────────── 停止 ───────────────────────────

test('★ stop：等待在途巡检结束（不打断，避免留下半迁移状态）', async () => {
  const harness = await makeHarness();
  try {
    await harness.service.start();
    const running = harness.service.runOnce();
    const stopped = harness.service.stop();
    await Promise.all([running, stopped]);
    assert.equal(harness.service.status().registered, false);
    assert.equal(harness.service.status().running, false);
  } finally {
    await harness.close();
  }
});

test('status：初始状态明确（未注册、无失败、无统计）', async () => {
  const harness = await makeHarness();
  try {
    const status = harness.service.status();
    assert.equal(status.registered, false);
    assert.equal(status.running, false);
    assert.equal(status.lastFinishedAt, null);
    assert.equal(status.lastOutcome, null);
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(status.totalRuns, 0);
    assert.equal(status.lastStats, null);
  } finally {
    await harness.close();
  }
});

test('status.lastStats：一轮完成后可读到统计（运维快速查看）', async () => {
  const harness = await makeHarness();
  try {
    await harness.service.runOnce();
    const stats = harness.service.status().lastStats;
    assert.ok(stats !== null);
    assert.equal(stats!.satisfied, 1);
    assert.equal(stats!.stateChanged, 1);
  } finally {
    await harness.close();
  }
});
