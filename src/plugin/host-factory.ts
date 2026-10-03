/**
 * 插件宿主 API 的**装配器**（R65 缺口的修复）。
 *
 * ★★★★ 问题：`HostApi` 此前**只在测试里被 `new`**——
 *   真实服务里插件的宿主能力（KV 存储 / 缓存 / 密钥 / 出网 / 日志）**全部不可用**。
 *
 *   ★ 这与「未接线」同类，但发生在**类**而非**路由**上：
 *     `impl-pairing` 原本只查「接口有无 PG 实现」，
 *     看不到「这个实现有没有被服务使用」。已加检查（`impl-pairing` 的「服务里未使用」）。
 *
 * ★ 设计要点：
 *   1. **按插件实例化**：每个插件拿到自己的 `HostApi`，
 *      因此 `KvStore` 的 `pluginId` 由宿主注入——**插件无法读写别人的存储**；
 *   2. `cache` 与 `storage` 是**两个独立的 KV 命名空间**（`instance_key` 区分）；
 *   3. `secrets` 通过 `SecretStore` 读取（**需主密钥**——与协同验证调用方密钥同一套）。
 *
 * ★ 本文件只负责「装配」；**何时调用插件**（如按策略触发、按调度运行）
 *   属于运行时编排，不在本文件的范围内。
 */

import type { Db } from '../db/pool.ts';
import { createTransactionalKvStore } from '../db/kv-adapter.ts';
import { HostApi, InMemoryKvStore, type HostApiOptions, type KvStore } from './host-api.ts';
import { FactPipeline } from './host-api.ts';
import type { FactStore } from './host-api.ts';
import type { PluginManifest } from './manifest.ts';
import type { Logger } from '../kernel/logger.ts';

/** 密钥读取（`HostApiOptions.secrets` 的形状）。 */
export interface SecretReader {
  get(name: string): Promise<string | undefined>;
}

export interface HostFactoryOptions {
  /** 真实模式提供 `db`（KV 落库）；demo 模式省略（用内存） */
  db?: Db;
  /** 事实存储（`FactPipeline` 需要） */
  facts: FactStore;
  /** 密钥读取；未提供时插件的 `secrets.get` 一律返回 undefined */
  secrets?: SecretReader;
  logger?: Logger;
  /**
   * 该宿主服务的**主体 id**（必填）。
   *
   * ★ 事实是**按主体**存的（`ag_plugin_facts.user_id` 是 NOT NULL uuid）——
   *   没有「平台级事实」这个概念（该假设已被明确否定，见 `FactStore` 的说明）。
   *   ★ 因此这里**不给默认值**：让调用方必须回答「这个插件服务于谁」。
   */
  userId: string;
  /**
   * 可注入的 `fetch`（**测试必需**）。
   *
   * ★ 没有它，插件的出站请求会真的打到外网——测试既慢又不稳定。
   *   `HostApiOptions` 本来就有这个字段，只是装配器没透传。
   */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * ★★ L-2：**LLM 通道**（透传给 `HostApiOptions.llm`）。
   *   ★ 与 `fetchImpl` 是**同一类问题**：`HostApiOptions` 里本来就有这个字段，
   *     但装配器**没透传**——于是插件"看得到能力、拿不到通道"。
   */
  llm?: HostApiOptions['llm'];
}

/**
 * 为**一个插件**装配宿主 API。
 *
 * ★ 每次调用返回**独立**的 `HostApi`——插件的 KV 命名空间由 `manifest.id` 隔离。
 */
export function createHostApiFor(options: HostFactoryOptions, manifest: PluginManifest): HostApi {
  const pluginId = manifest.id;
  let cache: KvStore;
  let storage: KvStore;
  if (options.db === undefined) {
    // demo 模式：内存（**仅供测试/demo**——重启即丢）
    cache = new InMemoryKvStore();
    storage = new InMemoryKvStore();
  } else {
    // ★ 真实模式：KV 落 `ag_plugin_storage`，命名空间由**宿主**注入
    cache = createTransactionalKvStore(options.db, { pluginId, instanceKey: 'cache' });
    storage = createTransactionalKvStore(options.db, { pluginId, instanceKey: 'storage' });
  }

  return new HostApi({
    manifest,
    // ★ 未提供密钥读取时返回 undefined（而不是抛错）——
    //   插件的 `secrets.get` 语义就是「没有则 undefined」
    secrets: { get: (name: string) => options.secrets?.get(name) ?? Promise.resolve(undefined) },
    cache,
    storage,
    facts: new FactPipeline({
      store: options.facts,
      manifest,
      userId: options.userId,
    }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
    // ★★ L-2：LLM 通道（未配置时为 undefined → 插件的 `llmInvoke` **显式抛错**）
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  });
}
