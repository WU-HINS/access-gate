/**
 * 插件包的**本地运行时缓存**（D9：本地仅作可丢弃缓存，启动按 digest 拉回）。
 *
 * ★ 本文件要证明的四件事：
 *   ① 本地缺失 → 从权威存储拉回（这是"容器重建后插件仍可用"的实现）；
 *   ② 本地命中 → 直接用（**且不再查数据库**——缓存的意义就在这）；
 *   ③ **本地被篡改 → 丢弃并重新拉回**（本地缓存不可信，命中也要重算 digest）；
 *   ④ **权威存储的包体 digest 不符 → 抛错**（投毒/存储损坏，绝不写进本地把错误固化）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { digestOf } from '../src/kernel/digest.ts';
import { FileSystemPackageCache } from '../src/plugin/package-cache.ts';
import type { PluginPackageStore } from '../src/db/plugin-package-adapter.ts';

const PKG = Buffer.from('console.log("plugin");'.repeat(20), 'utf8');
const DIGEST = digestOf(PKG);

/** 假权威存储：只实现 `get`（其余方法本测试用不到） */
function makeStore(packages: Record<string, Buffer>, calls = { get: 0 }): {
  store: PluginPackageStore;
  calls: { get: number };
} {
  return {
    calls,
    store: {
      async get(input) {
        calls.get += 1;
        const blob = packages[`${input.pluginId}@${input.version}`];
        if (blob === undefined) return undefined;
        return {
          pluginId: input.pluginId,
          version: input.version,
          digest: digestOf(blob),
          sizeBytes: blob.byteLength,
          storageKind: 'db' as const,
          createdAt: new Date('2026-09-26T00:00:00Z'),
          blob,
        };
      },
      async put() {
        throw new Error('本测试不该调用 put');
      },
      async list() {
        return [];
      },
      async verify() {
        return true;
      },
      async prune() {
        return [];
      },
    },
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gate-pkg-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('★ 本地缺失 → 从权威存储拉回（「容器重建后插件仍可用」的实现）', async () => {
  await withTempDir(async (dir) => {
    const { store } = makeStore({ 'gitlab@1.0.0': PKG });
    const cache = new FileSystemPackageCache({ dir, store });

    const result = await cache.ensure({ pluginId: 'gitlab', version: '1.0.0', digest: DIGEST });
    assert.equal(result.fromCache, false, '首次必须从权威存储拉回');
    assert.equal(Buffer.compare(await readFile(result.path), PKG), 0, '本地文件应与包体逐字节一致');
  });
});

test('★ 本地命中 → 直接用，且**不再查数据库**（缓存的意义就在这）', async () => {
  await withTempDir(async (dir) => {
    const { store, calls } = makeStore({ 'gitlab@1.0.0': PKG });
    const cache = new FileSystemPackageCache({ dir, store });

    await cache.ensure({ pluginId: 'gitlab', version: '1.0.0', digest: DIGEST });
    assert.equal(calls.get, 1);

    const second = await cache.ensure({ pluginId: 'gitlab', version: '1.0.0', digest: DIGEST });
    assert.equal(second.fromCache, true);
    assert.equal(calls.get, 1, '★ 命中本地缓存时不该再查权威存储');
  });
});

test('★ 本地被篡改 → **丢弃并重新拉回**（本地缓存不可信，命中也要重算 digest）', async () => {
  await withTempDir(async (dir) => {
    const { store, calls } = makeStore({ 'gitlab@1.0.0': PKG });
    const cache = new FileSystemPackageCache({ dir, store });

    // 先拉回一次，然后**篡改本地文件**
    const first = await cache.ensure({ pluginId: 'gitlab', version: '1.0.0', digest: DIGEST });
    await writeFile(first.path, Buffer.from('恶意内容', 'utf8'));

    const repaired = await cache.ensure({ pluginId: 'gitlab', version: '1.0.0', digest: DIGEST });
    assert.equal(repaired.fromCache, false, '★ 篡改过的缓存必须被丢弃');
    assert.equal(calls.get, 2, '必须重新查权威存储');
    assert.equal(Buffer.compare(await readFile(repaired.path), PKG), 0, '本地文件必须被修正');
  });
});

test('权威存储里也没有 → 抛错（并说明权威副本应在数据库）', async () => {
  await withTempDir(async (dir) => {
    const { store } = makeStore({});
    const cache = new FileSystemPackageCache({ dir, store });
    await assert.rejects(
      () => cache.ensure({ pluginId: 'gitlab', version: '9.9.9', digest: DIGEST }),
      /不在权威存储中/,
    );
  });
});

test('★ 权威存储的包体 digest 与期望不符 → 抛错，且**不写本地**（防投毒/存储损坏）', async () => {
  await withTempDir(async (dir) => {
    // 存储里的内容与"期望 digest"不是同一份
    const { store } = makeStore({ 'gitlab@1.0.0': Buffer.from('被替换过的包体', 'utf8') });
    const cache = new FileSystemPackageCache({ dir, store });

    await assert.rejects(
      () => cache.ensure({ pluginId: 'gitlab', version: '1.0.0', digest: DIGEST }),
      /digest 与期望不符/,
    );
    assert.deepEqual(await cache.listLocal(), [], '★ 校验失败时绝不能把错误内容写进本地');
  });
});

test('listLocal：列出本地缓存文件（排障用；目录不存在时返回空而不是报错）', async () => {
  await withTempDir(async (dir) => {
    const { store } = makeStore({ 'gitlab@1.0.0': PKG });
    const cache = new FileSystemPackageCache({ dir, store });
    assert.deepEqual(await cache.listLocal(), [], '缓存为空不是错误');

    await cache.ensure({ pluginId: 'gitlab', version: '1.0.0', digest: DIGEST });
    assert.deepEqual(await cache.listLocal(), [path.join('gitlab', '1.0.0.gatespkg')]);
  });
});

test('★ 空目录（模拟容器重建）→ 同一个 store 仍能拉回（缓存是可丢弃的）', async () => {
  await withTempDir(async (dir) => {
    const { store } = makeStore({ 'gitlab@1.0.0': PKG });
    const cache = new FileSystemPackageCache({ dir, store });
    await cache.ensure({ pluginId: 'gitlab', version: '1.0.0', digest: DIGEST });

    // ★ 模拟容器重建：把整个缓存目录删掉（它是"可丢弃"的）
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const restored = await cache.ensure({ pluginId: 'gitlab', version: '1.0.0', digest: DIGEST });
    assert.equal(restored.fromCache, false);
    assert.equal(Buffer.compare(await readFile(restored.path), PKG), 0, '★ 权威在 DB，所以缓存丢了也能拉回');
  });
});
