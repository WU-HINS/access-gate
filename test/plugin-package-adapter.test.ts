/**
 * 外置插件包体的权威存储（`docs/03 §1.19.4` / D9）。
 *
 * ★ 本文件要证明的三件事：
 *   ① **元数据查询不拉包体**（`docs/02 §4` 的硬约束——含 `node_modules` 的插件包可达数十 MB）；
 *   ② `digest` **由存储自己算**，且 `verify()` **重新计算**比对——
 *      信任库里的 digest 列只证明"存的时候是什么"；
 *   ③ 同 `(pluginId, version)` 重复 put 是**幂等覆盖**，不是堆多行。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/pool.ts';
import { digestOf, DbPluginPackageStore } from '../src/db/plugin-package-adapter.ts';

const PKG = Buffer.from('console.log("plugin v1");'.repeat(50), 'utf8');

async function createTable(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
  await db.exec(`
    CREATE TABLE ag_plugin_packages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plugin_id varchar(64) NOT NULL,
      version varchar(32) NOT NULL,
      digest varchar(128) NOT NULL,
      size_bytes bigint NOT NULL,
      storage_kind varchar(16) NOT NULL DEFAULT 'db',
      object_key varchar(512) NULL,
      blob bytea NULL,
      signature text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (plugin_id, version)
    );
  `);
}

test('★ put：digest **由存储自己算**（不接受调用方声称的值）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginPackageStore(db);
  const meta = await store.put({ pluginId: 'gitlab', version: '1.0.0', bytes: PKG });
  assert.equal(meta.digest, digestOf(PKG));
  assert.match(meta.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(meta.sizeBytes, PKG.byteLength);
  assert.equal(meta.storageKind, 'db');
});

test('★ list：元数据查询**不返回包体**（docs/02 §4：blob 可能很大）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginPackageStore(db);
  await store.put({ pluginId: 'gitlab', version: '1.0.0', bytes: PKG });

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal('blob' in list[0]!, false, '★ 元数据列表绝不能带包体');
  assert.equal(list[0]!.pluginId, 'gitlab');
  assert.equal(list[0]!.digest, digestOf(PKG));
});

test('get：取回包体且与落库前**逐字节一致**', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginPackageStore(db);
  await store.put({ pluginId: 'gitlab', version: '1.0.0', bytes: PKG });

  const record = await store.get({ pluginId: 'gitlab', version: '1.0.0' });
  assert.ok(record?.blob !== undefined);
  assert.equal(Buffer.compare(record.blob, PKG), 0, '包体必须逐字节一致（这是"本地缓存可丢弃"的前提）');
  assert.equal(await store.get({ pluginId: 'gitlab', version: '9.9.9' }), undefined);
});

test('★ verify：重新计算比对——正确 digest 通过，错误 digest 拒绝', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginPackageStore(db);
  const meta = await store.put({ pluginId: 'gitlab', version: '1.0.0', bytes: PKG });

  assert.equal(await store.verify({ pluginId: 'gitlab', version: '1.0.0', digest: meta.digest }), true);
  assert.equal(
    await store.verify({ pluginId: 'gitlab', version: '1.0.0', digest: digestOf(Buffer.from('篡改')) }),
    false,
  );
  // 版本不存在 → false（而不是抛错：调用方据此判"需要重新拉取"）
  assert.equal(await store.verify({ pluginId: 'gitlab', version: '2.0.0', digest: meta.digest }), false);
});

test('★ 幂等：同 (pluginId, version) 重复 put → 覆盖，不堆多行', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginPackageStore(db);
  await store.put({ pluginId: 'gitlab', version: '1.0.0', bytes: PKG });
  const replaced = Buffer.from('v2 内容', 'utf8');
  const second = await store.put({ pluginId: 'gitlab', version: '1.0.0', bytes: replaced });

  assert.equal((await store.list()).length, 1, '★ 不能出现两行');
  assert.equal(second.digest, digestOf(replaced));
  assert.equal((await store.get({ pluginId: 'gitlab', version: '1.0.0' }))?.digest, digestOf(replaced));
});

test('prune：只保留最新 keep 个版本', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginPackageStore(db);
  for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) {
    await store.put({ pluginId: 'gitlab', version, bytes: Buffer.from(version, 'utf8') });
  }
  const pruned = await store.prune({ pluginId: 'gitlab', keep: 2 });
  assert.equal(pruned.length, 2, '保留最新 2 个 → 删 2 个');
  const remaining = (await store.list()).map((m) => m.version);
  assert.equal(remaining.length, 2);
  // 最新两版必须还在（顺序由 created_at 决定，这里只断言集合大小与不含最旧）
  assert.equal(remaining.includes('1.0.0'), false);
  assert.equal(remaining.includes('1.3.0'), true);
});

test('prune：keep 大于实际版本数 → 什么都不删', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbPluginPackageStore(db);
  await store.put({ pluginId: 'gitlab', version: '1.0.0', bytes: PKG });
  assert.deepEqual(await store.prune({ pluginId: 'gitlab', keep: 5 }), []);
  assert.equal((await store.list()).length, 1);
});

test('★ 运行时兜底：事务外直接查询会被拒（CI 第 8 项白名单的依据）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  // 本适配器被加入 `ci-gate` 第 8 项的仓储层白名单，理由正是「运行时由查询层的
  // `assertInTransaction` 兜底」。这条测试把那个**理由**变成**可执行的事实**。
  await assert.rejects(
    async () => db.query('SELECT plugin_id FROM ag_plugin_packages'),
    /事务外执行/,
  );

  const store = new DbPluginPackageStore(db);
  await store.put({ pluginId: 'gitlab', version: '1.0.0', bytes: PKG });
  assert.equal((await store.list()).length, 1);
});
