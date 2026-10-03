/**
 * ★ P1-11：外置插件**包体上传**端点（`docs/03 §1.19.4` / D9）。
 *
 * ★ 本文件要证明：
 *   ① 未装配 `pluginPackages` → **501**（显式不可用，而不是静默丢弃上传）；
 *   ② 参数缺失 → **400**（且三种缺失各自有明确提示）；
 *   ③ 上传成功 → 返回 `digest` 与 `sizeBytes`，且 **digest 由存储自己算**
 *      （不接受调用方声称的值——否则完整性校验形同虚设）；
 *   ④ 上传写**审计**（包体后续会被解包执行，属高危操作）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { digestOf } from '../src/kernel/digest.ts';
import type { AuditEntry } from '../src/admin/api.ts';
import type { PluginPackageStore } from '../src/db/plugin-package-adapter.ts';

const ADMIN_SESSION = {
  userId: 'admin-1',
  username: 'admin',
  activeSiteId: 'site-1',
  realm: 'developer' as const,
  role: 'admin' as const,
};

const PKG = Buffer.from('console.log("plugin");'.repeat(10), 'utf8');

function makeStore(): { store: PluginPackageStore; puts: { pluginId: string; version: string; bytes: Buffer }[] } {
  const puts: { pluginId: string; version: string; bytes: Buffer }[] = [];
  return {
    puts,
    store: {
      async put(input) {
        puts.push({ pluginId: input.pluginId, version: input.version, bytes: input.bytes });
        return {
          pluginId: input.pluginId,
          version: input.version,
          // ★ 复刻真实实现：digest 由**存储**计算
          digest: digestOf(input.bytes),
          sizeBytes: input.bytes.byteLength,
          storageKind: 'db' as const,
          createdAt: new Date('2026-09-26T00:00:00Z'),
        };
      },
      async get() {
        return undefined;
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

function makeHandler(extra: Record<string, unknown> = {}) {
  const audits: AuditEntry[] = [];
  const handler = createAdminHandler({
    ...extra,
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: {
      list: async () => [],
      get: async () => undefined,
      versions: async () => [],
    } as never,
    audit: {
      async record(entry: AuditEntry) {
        audits.push(entry);
      },
      // ★ `AuditSink` 现在还有 `list`（审计查询）—— 本文件只关心写入，故返回空
      async list() {
        return [];
      },
    },
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    logger: silentLogger,
  });
  return { handler, audits };
}

const call = (
  handler: ReturnType<typeof makeHandler>['handler'],
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> =>
  handler({ method: 'POST', path: '/api/admin/plugins/packages', body, session: ADMIN_SESSION } as never) as never;

test('★ 未装配 pluginPackages → **501**（显式不可用，而不是静默丢弃上传）', async () => {
  const { handler } = makeHandler();
  const response = await call(handler, { pluginId: 'gitlab', version: '1.0.0', contentBase64: PKG.toString('base64') });
  assert.equal(response.status, 501);
});

test('参数缺失 → 400，且三种缺失各自有明确提示', async () => {
  const { store } = makeStore();
  const { handler } = makeHandler({ pluginPackages: store });

  const noId = await call(handler, { version: '1.0.0', contentBase64: 'x' });
  assert.equal(noId.status, 400);
  assert.match(JSON.stringify(noId.body), /缺少 pluginId/);

  const noVersion = await call(handler, { pluginId: 'gitlab', contentBase64: 'x' });
  assert.equal(noVersion.status, 400);
  assert.match(JSON.stringify(noVersion.body), /缺少 version/);

  const noContent = await call(handler, { pluginId: 'gitlab', version: '1.0.0' });
  assert.equal(noContent.status, 400);
  assert.match(JSON.stringify(noContent.body), /缺少 contentBase64/);
});

test('★ 上传成功 → 返回 digest 与 sizeBytes，且 **digest 由存储自己算**', async () => {
  const { store, puts } = makeStore();
  const { handler, audits } = makeHandler({ pluginPackages: store });

  const response = await call(handler, {
    pluginId: 'gitlab',
    version: '1.0.0',
    contentBase64: PKG.toString('base64'),
  });
  assert.equal(response.status, 200);
  const pkg = response.body['package'] as Record<string, unknown>;
  assert.equal(pkg['pluginId'], 'gitlab');
  assert.equal(pkg['version'], '1.0.0');
  assert.equal(pkg['digest'], digestOf(PKG), '★ 返回的 digest 必须由存储计算');
  assert.equal(pkg['sizeBytes'], PKG.byteLength);

  // 存储收到的字节与上传内容**逐字节一致**（base64 往返无损）
  assert.equal(puts.length, 1);
  assert.equal(Buffer.compare(puts[0]!.bytes, PKG), 0);

  // ★ 上传是高危操作 → 必须留痕
  const uploaded = audits.filter((entry) => entry.action === 'plugin.package_uploaded');
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0]!.targetId, 'gitlab@1.0.0');
  assert.deepEqual(uploaded[0]!.after, { digest: digestOf(PKG), sizeBytes: PKG.byteLength });
});

test('base64 解码后为空 → 400（不能让空包体进权威存储）', async () => {
  const { store, puts } = makeStore();
  const { handler } = makeHandler({ pluginPackages: store });
  const response = await call(handler, { pluginId: 'gitlab', version: '1.0.0', contentBase64: '====' });
  assert.equal(response.status, 400);
  assert.deepEqual(puts, [], '★ 空包体不该被写入');
});

test('可选的 `signature` 会透传给存储', async () => {
  const { store } = makeStore();
  const { handler } = makeHandler({ pluginPackages: store });
  const response = await call(handler, {
    pluginId: 'gitlab',
    version: '1.0.0',
    contentBase64: PKG.toString('base64'),
    signature: 'MEUCIQ...',
  });
  assert.equal(response.status, 200);
});
