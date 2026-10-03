/**
 * ★ L-2：OpenAI 兼容 LLM provider（`LlmProvider` 的唯一实现）。
 *
 * ★ 本文件的重点是**三种"看起来能用但结果不可信"**的形态：
 *   ① 上游返回 200 但**结构不对** → 必须抛错，而不是把 `undefined` 当内容；
 *   ② 非 2xx → 错误里必须带**状态码与上游片段**（400 与 429 的处置完全不同）；
 *   ③ `usage` 缺失 → 计 0 而不是崩（有些兼容实现不返回 usage）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HttpLlmProvider } from '../src/plugin/llm-provider-http.ts';

/** 假 fetch：返回固定状态与 JSON，并记录请求 */
function fakeFetch(status: number, body: unknown, captured: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const OK_BODY = {
  choices: [{ message: { content: '评审结论：通过' } }],
  usage: { prompt_tokens: 1200, completion_tokens: 40 },
};

test('正常响应 → 返回内容与用量', async () => {
  const provider = new HttpLlmProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    fetchImpl: fakeFetch(200, OK_BODY),
  });
  const result = await provider.invoke({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: '评审这个 PR' }],
  });
  assert.equal(result.content, '评审结论：通过');
  assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 40 });
});

test('★ 请求体符合 OpenAI 兼容约定（含 model / messages / max_tokens / temperature）', async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const provider = new HttpLlmProvider({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test',
    fetchImpl: fakeFetch(200, OK_BODY, captured),
  });
  await provider.invoke({
    model: 'gpt-4o',
    messages: [{ role: 'system', content: '你是评审员' }, { role: 'user', content: '看看' }],
    maxOutputTokens: 500,
    temperature: 0.2,
  });

  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions', '★ 尾部斜杠不该产生 //');
  const body = JSON.parse(String(captured.init?.body));
  assert.equal(body.model, 'gpt-4o');
  assert.deepEqual(body.messages, [
    { role: 'system', content: '你是评审员' },
    { role: 'user', content: '看看' },
  ]);
  assert.equal(body.max_tokens, 500);
  assert.equal(body.temperature, 0.2);
  const headers = captured.init?.headers as Record<string, string>;
  assert.equal(headers['authorization'], 'Bearer sk-test');
});

test('★ 未给 maxOutputTokens / temperature 时**不发送**这两个字段（让上游用默认）', async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const provider = new HttpLlmProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: fakeFetch(200, OK_BODY, captured),
  });
  await provider.invoke({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  const body = JSON.parse(String(captured.init?.body));
  assert.equal('max_tokens' in body, false);
  assert.equal('temperature' in body, false);
});

test('★★ 非 2xx → 抛错，且带**状态码与上游片段**（400 与 429 的处置完全不同）', async () => {
  const provider = new HttpLlmProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: fakeFetch(429, 'rate limit exceeded'),
  });
  await assert.rejects(
    () => provider.invoke({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /429/);
      assert.match(message, /rate limit exceeded/);
      return true;
    },
  );
});

test('★★★ 200 但结构不对（缺 content）→ **抛错**，而不是把 `undefined` 当内容', async () => {
  const provider = new HttpLlmProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    // 典型形态：上游改版、或中间网关返回了一个"看起来成功"的错误页
    fetchImpl: fakeFetch(200, { choices: [{ message: {} }], usage: { prompt_tokens: 1 } }),
  });
  await assert.rejects(
    () => provider.invoke({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    /choices\[0\]\.message\.content/,
  );
});

test('`usage` 缺失 → 计 0（有些兼容实现不返回 usage，不该崩）', async () => {
  const provider = new HttpLlmProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: fakeFetch(200, { choices: [{ message: { content: 'ok' } }] }),
  });
  const result = await provider.invoke({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
});

test('usage 字段类型不对（字符串）→ 计 0 而不是把字符串当数字', async () => {
  const provider = new HttpLlmProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: fakeFetch(200, {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: '1200', completion_tokens: null },
    }),
  });
  const result = await provider.invoke({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
});
