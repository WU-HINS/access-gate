/**
 * LLM 网关验收（M4-12）—— docs/03 §1.10。
 *
 * 验收标准：**插件无法绕过预算**。
 *
 * 本文件的重点不是「预算检查存在」，而是三条**边界**：
 *   1. **并发不超额**：★ 先查后用在并发下会超额——N 个并发调用同时通过检查，
 *      然后一起把预算撑爆。必须用「预留 → 调用 → 结算」把检查与占用做成原子的。
 *   2. **上游失败必须释放预留**：否则预算被「幽灵调用」永久占住，插件从此无法调用。
 *   3. **缓存命中不计费但仍计入统计**：算成零成本会低估节省，算成全价会掩盖价值。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmGateway, LlmRejectedError, type LlmProvider } from '../src/plugin/llm-gateway.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

/** 一个可控的假提供方：返回固定用量，可注入失败与延迟。 */
function makeProvider(options: { inputTokens?: number; outputTokens?: number; fail?: boolean; delayMs?: number } = {}): LlmProvider & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async invoke() {
      calls += 1;
      if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.fail === true) throw new Error('上游 503');
      return {
        content: `回答 #${calls}`,
        usage: { inputTokens: options.inputTokens ?? 10, outputTokens: options.outputTokens ?? 20 },
      };
    },
  };
}

/** 构造一个「预计 token 恰好为 100」的请求（content 为空 + maxOutputTokens=100）。 */
const requestOf = (pluginId: string, overrides: Record<string, unknown> = {}) => ({
  pluginId,
  messages: [{ role: 'user' as const, content: '' }],
  maxOutputTokens: 100,
  ...overrides,
});

function makeGateway(overrides: Partial<ConstructorParameters<typeof LlmGateway>[0]> = {}): { gateway: LlmGateway; provider: ReturnType<typeof makeProvider> } {
  const provider = makeProvider();
  const gateway = new LlmGateway({
    provider,
    logger: silentLogger,
    defaultModel: 'gpt-4o-mini',
    now: () => NOW,
    ...overrides,
  });
  return { gateway, provider };
}

// ─────────────────────────── 基本调用 ───────────────────────────

test('M4-12：正常调用返回内容与用量', async () => {
  const { gateway, provider } = makeGateway();
  const result = await gateway.invoke(requestOf('llm-review'));
  assert.equal(result.cached, false);
  assert.equal(result.model, 'gpt-4o-mini');
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(provider.calls, 1);
  assert.equal(gateway.usageOf('llm-review').calls, 1);
  assert.equal(gateway.usageOf('llm-review').usedTokens, 30);
});

test('★ M4-12：缺少 `llm:invoke` 权限 → 拒绝（插件不能白用平台能力）', async () => {
  const { gateway, provider } = makeGateway();
  await assert.rejects(gateway.invoke(requestOf('evil'), []), (error: unknown) => {
    assert.ok(error instanceof LlmRejectedError);
    assert.equal(error.reason, 'permission_denied');
    return true;
  });
  assert.equal(provider.calls, 0, '无权限时不得触达上游');
  assert.equal(gateway.usageOf('evil').rejectedCalls, 1);
});

test('M4-12：模型白名单 —— 插件不得指定任意模型名', async () => {
  const { gateway } = makeGateway({ allowedModels: ['gpt-4o-mini', 'claude-haiku'] });
  await assert.rejects(gateway.invoke(requestOf('p', { model: 'gpt-5-ultra' })), (error: unknown) => {
    assert.ok(error instanceof LlmRejectedError);
    assert.equal(error.reason, 'unknown_model');
    return true;
  });
  // 白名单内的模型可用
  const ok = await gateway.invoke(requestOf('p', { model: 'claude-haiku' }));
  assert.equal(ok.model, 'claude-haiku');
});

// ─────────────────────────── ★ 预算硬闸 ───────────────────────────

test('★ M4-12：预算超限 → **硬拒绝**（不是「警告后继续」）', async () => {
  // 预算 250，每次预计 100、实际 30 → 预计维度先到上限
  const { gateway, provider } = makeGateway({ budgets: { p: { dailyTokens: 250 } } });

  // ★ 必须禁用缓存：内容相同会命中缓存 → 真实用量不增长 → 永远到不了预算上限
  //   （这本身是个正确的行为，但会掩盖我们要验证的预算逻辑）
  await gateway.invoke(requestOf('p', { cache: false })); // projected 100 ≤ 250 ✓ → used=30
  await gateway.invoke(requestOf('p', { cache: false })); // 30+100=130 ✓ → used=60
  await gateway.invoke(requestOf('p', { cache: false })); // 60+100=160 ✓ → used=90
  await gateway.invoke(requestOf('p', { cache: false })); // 90+100=190 ✓ → used=120
  await gateway.invoke(requestOf('p', { cache: false })); // 120+100=220 ✓ → used=150
  await gateway.invoke(requestOf('p', { cache: false })); // 150+100=250 ✓（边界） → used=180
  await assert.rejects(gateway.invoke(requestOf('p', { cache: false })), (error: unknown) => {
    assert.ok(error instanceof LlmRejectedError);
    assert.equal(error.reason, 'budget_exceeded');
    assert.match(error.message, /日预算不足/);
    return true;
  });

  const usage = gateway.usageOf('p');
  assert.equal(usage.rejectedCalls, 1);
  assert.ok(usage.usedTokens <= usage.dailyBudgetTokens, '★ 已用 token 不得超预算');
  assert.equal(provider.calls, 6, '被拒的那次不得触达上游');
});

test('★ M4-12：并发调用**不会超额**（原子预留 —— 这是「无法绕过预算」的核心）', async () => {
  // 预算 250、每次预计 100：最多 2 个并发能通过预留
  const provider = makeProvider({ inputTokens: 0, outputTokens: 100, delayMs: 30 });
  const gateway = new LlmGateway({
    provider,
    logger: silentLogger,
    defaultModel: 'm',
    now: () => NOW,
    budgets: { p: { dailyTokens: 250 } },
  });

  // 同时发起 6 个调用
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => gateway.invoke(requestOf('p'))));
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;

  assert.equal(fulfilled, 2, `★ 预算 250 / 每次 100 → 只能有 2 个成功（实际 ${fulfilled}）`);
  assert.equal(rejected, 4);
  assert.equal(provider.calls, 2, '被拒的不得触达上游');
  assert.equal(gateway.usageOf('p').usedTokens, 200, '实际用量不得超预算');
  assert.ok(gateway.usageOf('p').usedTokens <= 250);

  // 若「先查后用」而非原子预留，会出现 fulfilled > 2 且 usedTokens > 250
  assert.ok(gateway.usageOf('p').reservedTokens === 0, '全部结算后预留应归零');
});

test('★ M4-12：上游失败必须**释放预留**（否则预算被幽灵调用永久占住）', async () => {
  const provider = makeProvider({ fail: true });
  const gateway = new LlmGateway({
    provider,
    logger: silentLogger,
    defaultModel: 'm',
    now: () => NOW,
    budgets: { p: { dailyTokens: 200 } },
  });

  // 失败一次（预计 100 被预留后必须释放）
  await assert.rejects(gateway.invoke(requestOf('p')), (error: unknown) => {
    assert.ok(error instanceof LlmRejectedError);
    assert.equal(error.reason, 'upstream_error');
    return true;
  });
  assert.equal(gateway.usageOf('p').reservedTokens, 0, '★ 失败后预留必须归零');
  assert.equal(gateway.usageOf('p').usedTokens, 0, '失败不计入已用');

  // 失败两次后仍应能通过预算检查（若预留泄漏，第二次之后就会被误拒）
  await assert.rejects(gateway.invoke(requestOf('p')));
  await assert.rejects(gateway.invoke(requestOf('p')), (error: unknown) => {
    const reason = error instanceof LlmRejectedError ? error.reason : 'unknown';
    assert.equal(reason, 'upstream_error', '★ 应是上游错误而不是 budget_exceeded（说明预留没泄漏）');
    return true;
  });
});

// ─────────────────────────── 缓存 ───────────────────────────

test('★ M4-12：缓存命中**不计费但计入统计**（既不低估节省，也不掩盖价值）', async () => {
  const { gateway, provider } = makeGateway();
  const first = await gateway.invoke(requestOf('p'));
  const second = await gateway.invoke(requestOf('p'));

  assert.equal(first.cached, false);
  assert.equal(second.cached, true, '相同输入应命中缓存');
  assert.equal(second.content, first.content);
  assert.equal(provider.calls, 1, '★ 缓存命中不得触达上游');

  const usage = gateway.usageOf('p');
  assert.equal(usage.calls, 1, 'calls 只统计真实调用');
  assert.equal(usage.cachedCalls, 1);
  assert.equal(usage.savedTokens, 30, '节省的 token 单独统计');
  assert.equal(usage.usedTokens, 30, '缓存命中不增加已用 token');
});

test('M4-12：可显式禁用缓存；不同温度/模型不共享缓存', async () => {
  const { gateway, provider } = makeGateway();
  await gateway.invoke(requestOf('p'));
  await gateway.invoke(requestOf('p', { cache: false }));
  assert.equal(provider.calls, 2, '禁用缓存应触达上游');

  await gateway.invoke(requestOf('p', { temperature: 0.9 }));
  assert.equal(provider.calls, 3, '不同温度应产生不同缓存键');

  await gateway.invoke(requestOf('p', { model: 'other' }));
  assert.equal(provider.calls, 4, '不同模型应产生不同缓存键');
});

test('M4-12：跨插件可共享缓存（平台的成本优势）', async () => {
  const { gateway, provider } = makeGateway();
  await gateway.invoke(requestOf('plugin-a'));
  const shared = await gateway.invoke(requestOf('plugin-b'));
  assert.equal(shared.cached, true, '不同插件问同样的问题应共享缓存');
  assert.equal(provider.calls, 1);
  // 但统计归属各自的插件
  assert.equal(gateway.usageOf('plugin-b').cachedCalls, 1);
  assert.equal(gateway.usageOf('plugin-b').calls, 0);
});

// ─────────────────────────── 限流与并发 ───────────────────────────

test('M4-12：每分钟限流（按插件）', async () => {
  const { gateway, provider } = makeGateway({ perMinuteLimit: 2 });
  await gateway.invoke(requestOf('p', { cache: false }));
  await gateway.invoke(requestOf('p', { cache: false, temperature: 1 }));
  await assert.rejects(gateway.invoke(requestOf('p', { cache: false, temperature: 2 })), (error: unknown) => {
    assert.ok(error instanceof LlmRejectedError);
    assert.equal(error.reason, 'rate_limited');
    return true;
  });
  assert.equal(provider.calls, 2);
});

test('M4-12：并发上限（按插件）', async () => {
  const provider = makeProvider({ delayMs: 50 });
  const gateway = new LlmGateway({ provider, logger: silentLogger, defaultModel: 'm', now: () => NOW, maxConcurrency: 2 });
  const results = await Promise.allSettled([
    gateway.invoke(requestOf('p', { cache: false })),
    gateway.invoke(requestOf('p', { cache: false, temperature: 1 })),
    gateway.invoke(requestOf('p', { cache: false, temperature: 2 })),
  ]);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.ok(rejected.length >= 1, '超过并发上限的调用应被拒');
  const reasons = rejected.map((r) => (r.status === 'rejected' && r.reason instanceof LlmRejectedError ? r.reason.reason : 'unknown'));
  assert.ok(reasons.includes('concurrency_exceeded'));
});

// ─────────────────────────── 成本统计 ───────────────────────────

test('M4-12：成本统计按价格表累计（可用于计费与告警）', async () => {
  const { gateway } = makeGateway({
    pricing: { 'gpt-4o-mini': { inputPer1k: 0.15, outputPer1k: 0.6 } },
  });
  await gateway.invoke(requestOf('p'));
  await gateway.invoke(requestOf('p', { cache: false }));
  const usage = gateway.usageOf('p');
  // 每次 30 token → (30/1000) * ((0.15+0.6)/2) = 0.01125
  assert.ok(Math.abs(usage.costUnits - 0.0225) < 1e-9, `成本应累计（实际 ${usage.costUnits}）`);
  assert.ok(Math.abs(gateway.stats().total.costUnits - 0.0225) < 1e-9);
});

test('M4-12：统计视图覆盖全部插件与全局累计', async () => {
  const { gateway } = makeGateway();
  await gateway.invoke(requestOf('a'));
  // ★ 不同内容：内容相同会**跨插件共享缓存**（那是设计优势），
  //   但本用例要验证「两个插件各自被调用」的统计
  await gateway.invoke({ pluginId: 'b', messages: [{ role: 'user', content: '另一个问题' }], maxOutputTokens: 100 });
  const stats = gateway.stats();
  assert.deepEqual(Object.keys(stats.plugins).sort(), ['a', 'b']);
  assert.equal(stats.total.calls, 2);
  assert.equal(stats.total.tokens, 60);
  assert.equal(stats.plugins['a']!.dailyBudgetTokens, 1_000_000, '未配置预算的插件用默认值');
});

test('M4-12：跨日重置已用 token，但累计统计保留', async () => {
  let clock = NOW;
  const provider = makeProvider();
  const gateway = new LlmGateway({ provider, logger: silentLogger, defaultModel: 'm', now: () => clock, budgets: { p: { dailyTokens: 100 } } });

  await gateway.invoke(requestOf('p', { cache: false }));
  assert.equal(gateway.usageOf('p').usedTokens, 30);

  // 次日
  clock = new Date(NOW.getTime() + 24 * 3_600_000);
  assert.equal(gateway.usageOf('p').usedTokens, 0, '跨日应重置当日用量');
  assert.equal(gateway.usageOf('p').calls, 0, '当日调用数也重置');
  assert.equal(gateway.stats().total.calls, 1, '★ 全局累计不随日窗口重置（用于长期成本分析）');

  // 新的一天预算重新可用
  await gateway.invoke(requestOf('p', { cache: false }));
  assert.equal(gateway.usageOf('p').usedTokens, 30);
});

test('M4-12：清空缓存（运维手段）', async () => {
  const { gateway, provider } = makeGateway();
  await gateway.invoke(requestOf('p'));
  gateway.clearCache();
  await gateway.invoke(requestOf('p'));
  assert.equal(provider.calls, 2, '清空缓存后应重新调用上游');
});

test('M4-12：拒绝计数可观测（超预算/超限流都要能被监控发现）', async () => {
  const { gateway } = makeGateway({ perMinuteLimit: 1 });
  await gateway.invoke(requestOf('p', { cache: false }));
  await gateway.invoke(requestOf('p', { cache: false, temperature: 1 })).catch(() => undefined);
  assert.equal(gateway.usageOf('p').rejectedCalls, 1);
});
