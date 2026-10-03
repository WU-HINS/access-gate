/**
 * ★★ **LLM 网关接入 `QuotaGuard`**（`docs/05 §6.4` + `§6.3.1`）。
 *
 * 本会话查出的 L-13：网关的限流与预算此前是**进程内**计数 ——
 * 多实例部署下实际配额 = 单实例配额 × 实例数，且键里没有归属维度
 * （§6.3.1 记录的事故形态：邻居掏空桶，而告警去怪渠道）。
 *
 * 本文件钉住四件事：
 *  ① ★★ 限流与预算**走 QuotaGuard**（跨实例、键与归属同构）；
 *  ② ★★ 超限文案带 **owner**（§6.3.1 的告警要求）；
 *  ③ ★★ 结算**如实**：实际用量超过预估时把计数推上去（否则配额被无限突破）；
 *  ④ ★★ 上游失败**释放预占**（不产生"幽灵调用"）。
 *  ⑤ ★ 未装配 `quota` 时退回进程内计数（向后兼容），但文案里**点明**它会被多实例放大。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmGateway, LlmRejectedError, type LlmProvider } from '../src/plugin/llm-gateway.ts';
import { InMemoryQuotaCounterStore, QuotaGuard } from '../src/core/quota-guard.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2026-09-28T10:00:00Z');

function makeProvider(options: { inputTokens?: number; outputTokens?: number; fail?: boolean } = {}): LlmProvider & {
  calls: number;
  /** ★ 可变开关：用于"先失败、后恢复"的场景 */
  fail: boolean;
} {
  let calls = 0;
  const state = { fail: options.fail === true };
  return {
    get calls() {
      return calls;
    },
    get fail() {
      return state.fail;
    },
    set fail(next: boolean) {
      state.fail = next;
    },
    async invoke() {
      calls += 1;
      if (state.fail) throw new Error('上游 503');
      return {
        content: 'ok',
        usage: { inputTokens: options.inputTokens ?? 10, outputTokens: options.outputTokens ?? 20 },
      };
    },
  };
}

/** 预估 token 恰好为 100（content 为空 + `maxOutputTokens: 100`） */
const requestOf = (pluginId: string, overrides: Record<string, unknown> = {}) => ({
  pluginId,
  messages: [{ role: 'user' as const, content: '' }],
  maxOutputTokens: 100,
  // ★ 关缓存：否则同样的请求会命中缓存，**根本走不到限流/预算**那两步
  cache: false,
  ...overrides,
});

function makeGateway(options: {
  provider?: ReturnType<typeof makeProvider>;
  quota?: QuotaGuard;
  perMinuteLimit?: number;
  defaultDailyTokens?: number;
}) {
  const provider = options.provider ?? makeProvider();
  const gateway = new LlmGateway({
    provider,
    logger: silentLogger,
    defaultModel: 'test-model',
    now: () => NOW,
    ...(options.quota === undefined ? {} : { quota: options.quota }),
    ...(options.perMinuteLimit === undefined ? {} : { perMinuteLimit: options.perMinuteLimit }),
    ...(options.defaultDailyTokens === undefined ? {} : { defaultDailyTokens: options.defaultDailyTokens }),
  });
  return { gateway, provider };
}

const guardOf = () => new QuotaGuard({ store: new InMemoryQuotaCounterStore(), now: () => NOW });

const rejectionOf = async (fn: () => Promise<unknown>): Promise<LlmRejectedError> => {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof LlmRejectedError, `期望 LlmRejectedError，实际 ${String(error)}`);
    return error;
  }
  throw new Error('期望被拒绝，但调用成功了');
};

// ─────────────────────── ① 限流走 QuotaGuard ───────────────────────

test('★★★ 每分钟限流走 `QuotaGuard`，且文案带 **owner**（§6.3.1 的告警要求）', async () => {
  const { gateway, provider } = makeGateway({ quota: guardOf(), perMinuteLimit: 2 });

  await gateway.invoke(requestOf('p1'));
  await gateway.invoke(requestOf('p1'));
  const rejected = await rejectionOf(() => gateway.invoke(requestOf('p1')));

  assert.equal(rejected.reason, 'rate_limited');
  assert.match(
    rejected.message,
    /owner=platform:platform/,
    '★ 文案必须能定位到"谁把额度用完了"——否则管理员会去查渠道，而渠道是好的',
  );
  assert.match(rejected.message, /resource=llm:calls/);
  assert.equal(provider.calls, 2, '★ 被限流的那次不该触达上游');
});

test('★★ 归属隔离：不同插件的额度**互不影响**（per-plugin 键）', async () => {
  const { gateway } = makeGateway({ quota: guardOf(), perMinuteLimit: 1 });

  await gateway.invoke(requestOf('p1'));
  await rejectionOf(() => gateway.invoke(requestOf('p1')));

  // p2 用尽了自己的额度，但 p1 的额度不该影响 p2
  await gateway.invoke(requestOf('p2'));
  const rejectedP2 = await rejectionOf(() => gateway.invoke(requestOf('p2')));
  assert.equal(rejectedP2.reason, 'rate_limited');
});

// ─────────────────────── ② 预算走 QuotaGuard ───────────────────────

test('★★★ 日预算走 `QuotaGuard`，超限文案带 owner', async () => {
  const { gateway } = makeGateway({ quota: guardOf(), defaultDailyTokens: 100 });

  await gateway.invoke(requestOf('p1')); // 预占 100
  const rejected = await rejectionOf(() => gateway.invoke(requestOf('p1')));

  assert.equal(rejected.reason, 'budget_exceeded');
  assert.match(rejected.message, /owner=platform:platform/);
  assert.match(rejected.message, /resource=llm:tokens/);
});

test('★★★ 结算**如实**：实际用量超过预估时，计数被推到真实值（下次必被拒）', async () => {
  // 预估 100（maxOutputTokens=100），实际 150 → 结算后 used = 150 > 预算 100
  const { gateway } = makeGateway({
    quota: guardOf(),
    defaultDailyTokens: 100,
    provider: makeProvider({ inputTokens: 100, outputTokens: 50 }),
  });

  const first = await gateway.invoke(requestOf('p1'));
  assert.equal(first.usage.totalTokens, 150);

  const rejected = await rejectionOf(() => gateway.invoke(requestOf('p1')));
  assert.equal(
    rejected.reason,
    'budget_exceeded',
    '★ 若结算用"release 再 reserve"，超额的实际用量会记账失败 → 计数低于真实 → 配额被无限突破',
  );
});

// ─────────────────────── ③ 失败释放 ───────────────────────

test('★★★ 上游失败 → 释放预占（不产生"幽灵调用"占住额度）', async () => {
  const provider = makeProvider({ fail: true });
  const { gateway } = makeGateway({ quota: guardOf(), defaultDailyTokens: 100, provider });

  await rejectionOf(() => gateway.invoke(requestOf('p1'))); // 上游 503 → upstream_error
  // 预占应已归还：同样的 100 预算还能用
  provider.fail = false;
  const ok = await gateway.invoke(requestOf('p1'));
  assert.equal(ok.content, 'ok', '★ 一次上游故障不该把额度永久占住');
});

// ─────────────────────── ④ 向后兼容 ───────────────────────

test('★ 未装配 `quota` → 退回进程内计数，且文案**点明**多实例下会被放大', async () => {
  const { gateway } = makeGateway({ perMinuteLimit: 1 }); // 没有 quota
  await gateway.invoke(requestOf('p1'));
  const rejected = await rejectionOf(() => gateway.invoke(requestOf('p1')));

  assert.equal(rejected.reason, 'rate_limited');
  assert.match(
    rejected.message,
    /进程内计数/,
    '★ 不装配时仍是"能跑"的，但必须**说清**它的口径缺陷（否则 L-13 会再次被忽略）',
  );
});
