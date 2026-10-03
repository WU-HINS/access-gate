/**
 * ★★ L-2：宿主 API 的 **LLM 唯一入口**（`host.llmInvoke`）。
 *
 * ★ 这条通道存在的意义是**关闭"插件可绕过 LLM 配额"**：
 *   有了它，插件**只能**走网关，于是预算 / 限流 / 并发 / 模型白名单 / 缓存**必然生效**；
 *   没有它，插件自己发 HTTP 就绕过了全部约束。
 *
 * ★ 本文件的两条核心断言：
 *   ① `pluginId` 由**宿主**填入（插件无法冒充别的插件去消耗它的预算）；
 *   ② 未配置网关时**显式抛错**（而不是返回空内容）——
 *      "看起来成功的空回答"会让插件把失败当成模型的判断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostApi } from '../src/plugin/host-api.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { INVITE_GRANTS_MANIFEST } from '../src/plugin/builtin/invite-grants.ts';

const MANIFEST = validateManifest({ ...INVITE_GRANTS_MANIFEST, id: 'llm-review' });

function makeHostApi(llm?: Record<string, unknown>): HostApi {
  return new HostApi({
    manifest: MANIFEST,
    secrets: { get: async () => undefined },
    facts: { emit: async () => ({ written: [] }) } as never,
    ...(llm === undefined ? {} : { llm: llm as never }),
  });
}

test('★★ 未配置网关 → **显式抛错**（而不是返回空内容）', async () => {
  const host = makeHostApi();
  await assert.rejects(
    () => host.llmInvoke({ messages: [{ role: 'user', content: '评审' }] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /未配置 LLM 网关/);
      // ★ 报错要说清"该走哪条路"，而不是只说"不可用"
      assert.match(message, /不应自行发起 LLM 请求/);
      return true;
    },
  );
});

test('★★★ `pluginId` 由**宿主**填入——插件无法冒充别的插件去用它的预算', async () => {
  const calls: { pluginId?: string }[] = [];
  const host = makeHostApi({
    async invoke(input: { pluginId: string }) {
      calls.push(input);
      return {
        content: '回答',
        model: 'gpt-4o-mini',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cached: false,
      };
    },
  });

  await host.llmInvoke({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.pluginId, 'llm-review', '★ 必须由宿主填入 manifest.id');
});

test('参数透传：model / maxOutputTokens / temperature / cache', async () => {
  const captured: Record<string, unknown>[] = [];
  const host = makeHostApi({
    async invoke(input: Record<string, unknown>) {
      captured.push(input);
      return {
        content: 'ok',
        model: 'gpt-4o',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        cached: true,
      };
    },
  });

  const result = await host.llmInvoke({
    messages: [{ role: 'system', content: '你是评审员' }, { role: 'user', content: '看看' }],
    model: 'gpt-4o',
    maxOutputTokens: 500,
    temperature: 0.3,
    cache: false,
  });

  assert.equal(captured[0]!['model'], 'gpt-4o');
  assert.equal(captured[0]!['maxOutputTokens'], 500);
  assert.equal(captured[0]!['temperature'], 0.3);
  assert.equal(captured[0]!['cache'], false);
  assert.equal(result.cached, true, '★ `cached` 要透回来——成本可核算');
  assert.equal(result.usage.totalTokens, 3, '★ 用量原样透传（这个假网关返回的是 1+2）');
});

test('未给可选参数时不添加多余字段（让网关用默认）', async () => {
  const captured: Record<string, unknown>[] = [];
  const host = makeHostApi({
    async invoke(input: Record<string, unknown>) {
      captured.push(input);
      return {
        content: 'ok',
        model: 'm',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cached: false,
      };
    },
  });
  await host.llmInvoke({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal('model' in captured[0]!, false);
  assert.equal('maxOutputTokens' in captured[0]!, false);
  assert.equal('cache' in captured[0]!, false);
});

test('网关抛错时**原样向上传播**（不吞掉原因）', async () => {
  const host = makeHostApi({
    async invoke() {
      throw new Error('插件已超过每日 token 预算');
    },
  });
  await assert.rejects(
    () => host.llmInvoke({ messages: [{ role: 'user', content: 'x' }] }),
    /超过每日 token 预算/,
  );
});
