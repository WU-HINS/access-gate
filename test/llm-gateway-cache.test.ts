/**
 * ★★ P1-12：LLM 缓存的**持久化**接线（`docs/03 §1.10`）。
 *
 * 修复前的形态：`llm-gateway` 的缓存是进程内 `Map` → **重启即丢** →
 * 同一批主体在每次重启后都会被**重新付费**评审一遍。
 *
 * ★ 本文件要证明的三件事：
 *   ① 注入持久缓存后，第二次调用**不再调上游**（省的是真金白银）；
 *   ② **「重启」后仍命中**——新建网关实例 + 同一个持久缓存，`provider.calls === 0`；
 *   ③ `cache: false` 时**既不读也不写**（显式禁用必须彻底）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmGateway, type LlmProvider } from '../src/plugin/llm-gateway.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import type { LlmCacheEntry, LlmCacheStore } from '../src/db/llm-cache-adapter.ts';

const NOW = new Date('2026-09-26T00:00:00Z');

/**
 * 内存版缓存存储 —— **只实现接口**（PG 实现有自己的测试；
 * 这里要验的是「网关有没有正确使用这个接口」）。
 * ★ 它刻意复刻 PG 实现的**过期语义**（`get` 自己判），否则两边会分叉。
 */
class FakeLlmCacheStore implements LlmCacheStore {
  readonly entries = new Map<string, LlmCacheEntry>();
  #key(ownerScope: string, ownerId: string, inputHash: string): string {
    return `${ownerScope}\u0000${ownerId}\u0000${inputHash}`;
  }
  async get(input: {
    ownerScope: LlmCacheEntry['ownerScope'];
    ownerId: string;
    inputHash: string;
    now: Date;
  }): Promise<LlmCacheEntry | undefined> {
    const entry = this.entries.get(this.#key(input.ownerScope, input.ownerId, input.inputHash));
    if (entry === undefined) return undefined;
    const expiresAt = entry.expiresAt;
    if (expiresAt !== null && expiresAt !== undefined && expiresAt.getTime() <= input.now.getTime()) {
      return undefined;
    }
    return entry;
  }
  async put(entry: LlmCacheEntry): Promise<void> {
    this.entries.set(this.#key(entry.ownerScope, entry.ownerId, entry.inputHash), entry);
  }
  async purgeExpired(): Promise<number> {
    return 0;
  }
}

function makeProvider(): LlmProvider & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async invoke() {
      calls += 1;
      return {
        content: `回答 #${calls}`,
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
}

const requestOf = () => ({
  pluginId: 'llm-review',
  messages: [{ role: 'user' as const, content: '评审这个 PR' }],
});

test('★ 注入持久缓存 → 第二次调用命中，上游只被调一次（省的是真金白银）', async () => {
  const store = new FakeLlmCacheStore();
  const provider = makeProvider();
  const gateway = new LlmGateway({
    provider,
    logger: silentLogger,
    defaultModel: 'gpt-4o-mini',
    now: () => NOW,
    cacheStore: store,
  });

  const first = await gateway.invoke(requestOf());
  const second = await gateway.invoke(requestOf());

  assert.equal(provider.calls, 1, '★ 第二次必须命中缓存，不再付费');
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.content, first.content);
  assert.equal(store.entries.size, 1, '缓存里应恰好一条');
});

test('★★ 「重启」后仍命中：新建网关实例 + 同一持久缓存 → 上游调用数为 0', async () => {
  const store = new FakeLlmCacheStore();

  const before = makeProvider();
  const firstGateway = new LlmGateway({
    provider: before,
    logger: silentLogger,
    defaultModel: 'gpt-4o-mini',
    now: () => NOW,
    cacheStore: store,
  });
  await firstGateway.invoke(requestOf());
  assert.equal(before.calls, 1);

  // ★ 模拟进程重启：**新的 gateway**（它的内存 Map 是空的），但持久缓存还在
  const after = makeProvider();
  const afterGateway = new LlmGateway({
    provider: after,
    logger: silentLogger,
    defaultModel: 'gpt-4o-mini',
    now: () => NOW,
    cacheStore: store,
  });
  const result = await afterGateway.invoke(requestOf());

  assert.equal(after.calls, 0, '★ 重启后必须命中持久缓存——这正是「重复付费」的修复点');
  assert.equal(result.cached, true);
});

test('未注入持久缓存 → 退回进程内 Map（同一实例内仍命中，但重启即丢）', async () => {
  const provider = makeProvider();
  const gateway = new LlmGateway({
    provider,
    logger: silentLogger,
    defaultModel: 'gpt-4o-mini',
    now: () => NOW,
  });
  await gateway.invoke(requestOf());
  const second = await gateway.invoke(requestOf());
  assert.equal(provider.calls, 1, '同一实例内内存缓存仍然有效');
  assert.equal(second.cached, true);
});

test('★ `cache: false` → **既不读也不写**（显式禁用必须彻底）', async () => {
  const store = new FakeLlmCacheStore();
  const provider = makeProvider();
  const gateway = new LlmGateway({
    provider,
    logger: silentLogger,
    defaultModel: 'gpt-4o-mini',
    now: () => NOW,
    cacheStore: store,
  });

  await gateway.invoke({ ...requestOf(), cache: false });
  await gateway.invoke({ ...requestOf(), cache: false });

  assert.equal(provider.calls, 2, '★ 禁用缓存时必须每次真调');
  assert.equal(store.entries.size, 0, '★ 也不该写进持久缓存');
});

test('★ TTL 到期 → 不再命中（过期由 `get` 判，不依赖清理任务）', async () => {
  const store = new FakeLlmCacheStore();
  const provider = makeProvider();
  let now = NOW;
  const gateway = new LlmGateway({
    provider,
    logger: silentLogger,
    defaultModel: 'gpt-4o-mini',
    now: () => now,
    cacheStore: store,
    cacheTtlMs: 60_000,
  });

  await gateway.invoke(requestOf());
  now = new Date(NOW.getTime() + 30_000);
  assert.equal((await gateway.invoke(requestOf())).cached, true, 'TTL 内应命中');

  now = new Date(NOW.getTime() + 60_000);
  assert.equal((await gateway.invoke(requestOf())).cached, false, '★ 到期后必须重新调用');
  assert.equal(provider.calls, 2);
});

test('作用域可配：不同 `cacheOwner` 互不命中（多站点各自计费时用得上）', async () => {
  const store = new FakeLlmCacheStore();
  const siteA = makeProvider();
  const gatewayA = new LlmGateway({
    provider: siteA,
    logger: silentLogger,
    defaultModel: 'gpt-4o-mini',
    now: () => NOW,
    cacheStore: store,
    cacheOwner: { ownerScope: 'site', ownerId: 'site-a' },
  });
  await gatewayA.invoke(requestOf());

  const siteB = makeProvider();
  const gatewayB = new LlmGateway({
    provider: siteB,
    logger: silentLogger,
    defaultModel: 'gpt-4o-mini',
    now: () => NOW,
    cacheStore: store,
    cacheOwner: { ownerScope: 'site', ownerId: 'site-b' },
  });
  await gatewayB.invoke(requestOf());

  assert.equal(siteB.calls, 1, '★ 站点 B 不得命中站点 A 的缓存');
  assert.equal(store.entries.size, 2);
});
