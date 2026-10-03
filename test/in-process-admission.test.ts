/**
 * `in-process` 准入闸的判定表（`docs/03:67` 的三个 AND 条件）。
 *
 * ★ 这组测试的价值在于：把「一个未签名插件写 `runtime: 'in-process'` 就能进主进程」
 *   这个**当前真实存在的缺口**，变成一条会失败的断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertInProcessAdmitted,
  evaluateInProcessAdmission,
  InProcessNotAdmittedError,
  type InProcessAdmissionInput,
} from '../src/plugin/in-process-admission.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import type { PluginManifest } from '../src/plugin/manifest.ts';

const BASE: InProcessAdmissionInput = {
  pluginId: 'gitlab',
  runtime: 'in-process',
  source: 'uploaded',
  signatureVerified: true,
  adminApprovedAt: new Date('2026-09-26T00:00:00Z'),
  officialAllowlist: ['gitlab'],
};

test('非 in-process 的 runtime 一律放行（本闸只管「进主进程」）', () => {
  for (const runtime of ['declarative', 'process', 'container'] as const) {
    const result = evaluateInProcessAdmission({ ...BASE, runtime, signatureVerified: false, adminApprovedAt: null });
    assert.equal(result.admitted, true, `${runtime} 不应被本闸拦截`);
    assert.deepEqual(result.denials, []);
  }
});

test('in-process + 内置插件 → 放行（三个条件由发布流程保证）', () => {
  const result = evaluateInProcessAdmission({
    ...BASE,
    source: 'builtin',
    signatureVerified: false,
    adminApprovedAt: null,
    officialAllowlist: [],
  });
  assert.equal(result.admitted, true, '内置插件不应因「运行时未逐次确认」而被挡在冷启动之外');
});

test('★ in-process + 未签名的第三方 → 拒绝（此前这个组合没有任何门）', () => {
  const result = evaluateInProcessAdmission({ ...BASE, signatureVerified: false });
  assert.equal(result.admitted, false);
  assert.deepEqual(result.denials, ['not_signed']);
});

test('in-process + 已签名但不在官方信任列表 → 拒绝', () => {
  const result = evaluateInProcessAdmission({ ...BASE, officialAllowlist: [] });
  assert.equal(result.admitted, false);
  assert.deepEqual(result.denials, ['not_officially_trusted']);
});

test('in-process + 已签名 + 在列表 + 管理员未确认 → 拒绝（签名不等于被允许）', () => {
  const result = evaluateInProcessAdmission({ ...BASE, adminApprovedAt: null });
  assert.equal(result.admitted, false);
  assert.deepEqual(result.denials, ['not_admin_approved']);
});

test('in-process + 三条件齐备 → 放行', () => {
  assert.equal(evaluateInProcessAdmission(BASE).admitted, true);
});

test('多个缺失 → **一次列出全部**（管理员一次修完，而不是修一条撞下一条）', () => {
  const result = evaluateInProcessAdmission({
    ...BASE,
    signatureVerified: false,
    officialAllowlist: [],
    adminApprovedAt: null,
  });
  assert.equal(result.admitted, false);
  assert.deepEqual(result.denials, ['not_signed', 'not_officially_trusted', 'not_admin_approved']);
});

test('assertInProcessAdmitted：拒绝时抛错，且消息里写明「三条件为 AND」与全部缺失项', () => {
  assert.throws(
    () =>
      assertInProcessAdmitted({
        ...BASE,
        signatureVerified: false,
        officialAllowlist: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof InProcessNotAdmittedError);
      assert.equal(error.pluginId, 'gitlab');
      assert.deepEqual(error.denials, ['not_signed', 'not_officially_trusted']);
      assert.match(error.message, /运行时|宿主进程内/);
      assert.match(error.message, /AND/);
      assert.match(error.message, /包签名未验证通过/);
      assert.match(error.message, /不在官方信任列表内/);
      return true;
    },
  );
  // 满足条件时不抛
  assert.doesNotThrow(() => assertInProcessAdmitted(BASE));
  // 非 in-process 不抛（即使三条全不满足）
  assert.doesNotThrow(() =>
    assertInProcessAdmitted({ ...BASE, runtime: 'process', signatureVerified: false, adminApprovedAt: null, officialAllowlist: [] }),
  );
});

// ─────────────────────────── ★ 接入点（不只是纯函数） ───────────────────────────

function manifestOf(runtime: 'in-process' | 'declarative', id: string): PluginManifest {
  return {
    apiVersion: 'gate.plugin/v1',
    id,
    kind: 'channel',
    name: id,
    version: '1.0.0',
    runtime,
    ...(runtime === 'declarative' ? {} : { entry: './plugin.mjs' }),
    engines: { gate: '>=1.0.0' },
    permissions: [],
    configSchema: { type: 'object', properties: {} },
    config: { scope: 'site', instances: { mode: 'singleton' } },
  } as unknown as PluginManifest;
}

test('★ 接入点：`store.setStatus(enabled)` 真的拦住未签名的 `in-process` 插件', async () => {
  const store = new InMemoryPluginStore();

  // ① 未签名的第三方 in-process → enable 被拒（**这就是修复前不存在的门**）
  await store.install({
    manifest: manifestOf('in-process', 'gitlab'),
    source: 'uploaded',
    signatureVerified: false,
  });
  await assert.rejects(
    () => store.setStatus('gitlab', 'enabled'),
    (error: unknown) => {
      assert.ok(error instanceof InProcessNotAdmittedError);
      assert.equal(error.pluginId, 'gitlab');
      return true;
    },
  );
  // 被拒后状态**未变成 enabled**（不是「先启用再报错」）
  assert.notEqual((await store.get('gitlab'))?.status, 'enabled');

  // ② 同一闸不影响声明式插件（本闸只管「进主进程」）
  await store.install({
    manifest: manifestOf('declarative', 'email-domain'),
    source: 'uploaded',
    signatureVerified: false,
  });
  assert.equal((await store.setStatus('email-domain', 'enabled'))?.status, 'enabled');

  // ③ 内置插件豁免 —— 否则冷启动会把官方插件全挡在门外（可用性事故）
  await store.install({
    manifest: manifestOf('in-process', 'bot-bridge'),
    source: 'builtin',
    signatureVerified: true,
  });
  assert.equal((await store.setStatus('bot-bridge', 'enabled'))?.status, 'enabled');
});

test('★ 接入点：补齐「签名 + 管理员确认」后仍不在官方列表 → 仍被拒（fail-closed 的当前形态）', async () => {
  const store = new InMemoryPluginStore();
  await store.install({
    manifest: manifestOf('in-process', 'gitlab'),
    source: 'uploaded',
    signatureVerified: true,
  });
  // 管理员确认后端代码信任（写入 runtimeState.trust.backend）
  await store.setTrust('gitlab', 'backend', true, 'admin@example.com', new Date('2026-09-26T00:00:00Z'));

  // ★ 当前实现的官方信任列表**默认为空**（第三方要 in-process 必须由平台显式加入）——
  //   这是刻意的 fail-closed 默认，列表来源登记在 reports/GO-LIVE-TODO.md。
  await assert.rejects(
    () => store.setStatus('gitlab', 'enabled'),
    (error: unknown) => {
      assert.ok(error instanceof InProcessNotAdmittedError);
      assert.deepEqual(error.denials, ['not_officially_trusted']);
      return true;
    },
  );
});
