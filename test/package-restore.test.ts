/**
 * ★ P0-3/L-3：外置插件包体的**启动拉回**（D9：本地仅作可丢弃缓存，启动按 digest 拉回）。
 *
 * ★ 本文件的核心是**两条相反的要求**：
 *   ① 单个插件失败**不阻断**其他插件、也不阻断启动（一个损坏的包不该让服务起不来）；
 *   ② 但失败**必须可见**（`failed` 列表）——否则"某个插件没加载"会变成说不清的现象。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { restorePluginPackages, type ExternalPluginRef } from '../src/plugin/package-restore.ts';
import type { EnsurePackageResult, PluginPackageCache } from '../src/plugin/package-cache.ts';

/** 假缓存：按配置决定"命中/拉回/抛错"，并记录调用 */
function makeCache(
  behaviour: Record<string, 'cached' | 'restored' | 'fail'>,
  calls: { pluginId: string; version: string; digest: string }[] = [],
): PluginPackageCache {
  return {
    async ensure(input): Promise<EnsurePackageResult> {
      calls.push(input);
      const key = `${input.pluginId}@${input.version}`;
      const mode = behaviour[key] ?? 'restored';
      if (mode === 'fail') throw new Error(`包体不在权威存储中：${key}`);
      return { path: `/cache/${input.pluginId}/${input.version}.gatespkg`, fromCache: mode === 'cached' };
    },
    async listLocal() {
      return [];
    },
  };
}

const PLUGIN = (pluginId: string, version = '1.0.0'): ExternalPluginRef => ({
  pluginId,
  version,
  digest: `sha256:${pluginId.padEnd(64, '0')}`,
});

test('本地缺失 → 拉回；本地命中 → 计入 alreadyCached', async () => {
  const calls: { pluginId: string; version: string; digest: string }[] = [];
  const cache = makeCache({ 'a@1.0.0': 'restored', 'b@1.0.0': 'cached' }, calls);

  const report = await restorePluginPackages({
    cacheDir: '/cache',
    cache,
    listExternalPlugins: async () => [PLUGIN('a'), PLUGIN('b')],
  });

  assert.deepEqual(report.restored, ['a@1.0.0']);
  assert.deepEqual(report.alreadyCached, ['b@1.0.0']);
  assert.deepEqual(report.failed, []);
  assert.equal(calls.length, 2, '每个外置插件都要尝试一次');
});

test('★★ 单个失败**不阻断**其他（一个损坏的包不该让服务起不来）', async () => {
  const cache = makeCache({
    'broken@1.0.0': 'fail',
    'good@1.0.0': 'restored',
    'also-good@2.0.0': 'restored',
  });

  const report = await restorePluginPackages({
    cacheDir: '/cache',
    cache,
    listExternalPlugins: async () => [PLUGIN('broken'), PLUGIN('good'), PLUGIN('also-good', '2.0.0')],
  });

  assert.deepEqual(report.restored, ['good@1.0.0', 'also-good@2.0.0'], '★ 失败之后的插件仍要被处理');
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0]!.pluginId, 'broken');
  assert.match(report.failed[0]!.reason, /不在权威存储中/);
});

test('★ 失败**必须可见**：报告里带 pluginId / version / 原因（否则现象说不清）', async () => {
  const cache = makeCache({ 'x@3.0.0': 'fail' });
  const report = await restorePluginPackages({
    cacheDir: '/cache',
    cache,
    listExternalPlugins: async () => [PLUGIN('x', '3.0.0')],
  });
  assert.deepEqual(report.restored, []);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0]!.version, '3.0.0');
  assert.ok(report.failed[0]!.reason.length > 0);
});

test('没有外置插件 → 空报告（不报错）', async () => {
  const cache = makeCache({});
  const report = await restorePluginPackages({
    cacheDir: '/cache',
    cache,
    listExternalPlugins: async () => [],
  });
  assert.deepEqual(report, { restored: [], alreadyCached: [], failed: [] });
});

test('把 `digest` 原样传给缓存（★ 完整性校验的依据，不能被忽略）', async () => {
  const calls: { pluginId: string; version: string; digest: string }[] = [];
  const cache = makeCache({}, calls);
  const ref = PLUGIN('a');
  await restorePluginPackages({
    cacheDir: '/cache',
    cache,
    listExternalPlugins: async () => [ref],
  });
  assert.equal(calls[0]!.digest, ref.digest, '★ 传错 digest 会让本地缓存校验形同虚设');
});
