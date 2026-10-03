/**
 * 外置插件包体的**启动拉回**（`docs/03 §1.19.4` / D9）—— L-3。
 *
 * ★★ D9 的原话：
 * > 本地仅作**可丢弃的运行时缓存**，**启动按 digest 拉回**。
 *
 * 而在此之前只实现了"包体落库"（`DbPluginPackageStore`）与"按需拉回"
 * （`FileSystemPackageCache.ensure`）——**没有任何代码在启动时调用它**，
 * 于是"容器重建后插件仍可用"这件事仍然只是**能力**，不是**行为**。
 *
 * ★ 两条刻意的设计：
 *   ① **单个插件失败不阻断其他**，也不阻断启动——一个损坏的包不该让整个服务起不来；
 *   ② 但失败**必须被记录**（`failed` 列表 + 日志）。否则"某个插件没加载"
 *      会变成一类**说不清**的现象——而这类现象正是本项目反复吃亏的地方。
 * ★ `builtin` 插件**不进 DB**（随主程序构建产物），因此不参与拉回。
 */

import type { PluginPackageCache } from './package-cache.ts';

export interface ExternalPluginRef {
  pluginId: string;
  version: string;
  digest: string;
}

export interface RestorePluginPackagesDeps {
  /** 列出**外置**插件（`source <> 'builtin'` 且未 removed） */
  listExternalPlugins(): Promise<readonly ExternalPluginRef[]>;
  /** 本地运行时缓存（按 digest 拉回） */
  cache: PluginPackageCache;
  /** 缓存根目录（仅用于日志/报告展示） */
  cacheDir: string;
}

export interface RestoreReport {
  /** 本次从权威存储**拉回**的 */
  restored: readonly string[];
  /** 本地已命中（digest 一致）的 */
  alreadyCached: readonly string[];
  /** 拉回失败的（★ 不阻断启动，但必须可见） */
  failed: readonly { pluginId: string; version: string; reason: string }[];
}

export async function restorePluginPackages(
  deps: RestorePluginPackagesDeps,
): Promise<RestoreReport> {
  const plugins = await deps.listExternalPlugins();
  const restored: string[] = [];
  const alreadyCached: string[] = [];
  const failed: { pluginId: string; version: string; reason: string }[] = [];

  for (const plugin of plugins) {
    try {
      const result = await deps.cache.ensure({
        pluginId: plugin.pluginId,
        version: plugin.version,
        digest: plugin.digest,
      });
      const label = `${plugin.pluginId}@${plugin.version}`;
      if (result.fromCache) alreadyCached.push(label);
      else restored.push(label);
    } catch (error) {
      // ★ 单个失败不抛出：一个损坏的包不该让整个服务起不来
      failed.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { restored, alreadyCached, failed };
}
