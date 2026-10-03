/**
 * OpenAI 兼容的 LLM provider —— `LlmProvider` 的**唯一实现**（L-2 的前半）。
 *
 * ★★ 为什么这件事重要（核实出来的形态）：
 *   在它之前 `LlmProvider` **只有接口、没有任何实现**，于是：
 *   · `llm-gateway` 的**预算 / 限流 / 并发 / 模型白名单 / 缓存**从未被真实使用；
 *   · 而插件若**自己发 HTTP**，就绕过了上面**全部约束**——
 *     包括"这个插件烧了多少钱"这件事本身变得不可知。
 *   ★ 因此"写 provider"与"把网关接进 HostApi"是**同一件事的两半**：
 *     没有 provider，网关就是摆设；没有 HostApi 通道，插件只能自己发 HTTP。
 *
 * ★ 三处防御性设计（都会导致"看起来能用但结果不可信"）：
 *   ① **响应形状校验**：上游返回 200 但结构不对（改版/网关错误页）时必须抛错，
 *      而不是把 `undefined` 当成内容返回——那会让"模型说了什么"变成静默的谎；
 *   ② **超时**：LLM 调用是长尾的，没有超时会让一次卡住的调用占满并发额度；
 *   ③ **错误里带状态码与上游片段**：否则排障只能看到"调用失败"。
 */

import type { LlmProvider } from './llm-gateway.ts';

export interface HttpLlmProviderOptions {
  /** OpenAI 兼容的 base URL（如 `https://api.openai.com/v1`） */
  baseUrl: string;
  apiKey: string;
  /** 单次调用超时（毫秒）；缺省 60s */
  timeoutMs?: number;
  /** 注入 fetch（测试用；缺省用全局 fetch） */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionBody {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

export class HttpLlmProvider implements LlmProvider {
  readonly #options: HttpLlmProviderOptions;

  constructor(options: HttpLlmProviderOptions) {
    this.#options = options;
  }

  async invoke(input: {
    model: string;
    messages: readonly { role: string; content: string }[];
    maxOutputTokens?: number;
    temperature?: number;
  }): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }> {
    const doFetch = this.#options.fetchImpl ?? fetch;
    const response = await doFetch(`${this.#options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#options.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
        ...(input.maxOutputTokens === undefined ? {} : { max_tokens: input.maxOutputTokens }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      }),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 60_000),
    });

    if (!response.ok) {
      // ★ 带上上游片段：否则排障只能看到"调用失败"，而 400 与 429 的处置完全不同
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM 上游返回 ${response.status}${detail.length === 0 ? '' : `：${detail.slice(0, 200)}`}`);
    }

    const body = (await response.json()) as ChatCompletionBody;
    const content = body.choices?.[0]?.message?.content;
    // ★ ①②：形状不对时**抛错**，而不是把 undefined 当内容
    if (typeof content !== 'string') {
      throw new Error('LLM 上游响应缺少 choices[0].message.content（结构不符合 OpenAI 兼容约定）');
    }
    const inputTokens = body.usage?.prompt_tokens;
    const outputTokens = body.usage?.completion_tokens;
    return {
      content,
      usage: {
        inputTokens: typeof inputTokens === 'number' ? inputTokens : 0,
        outputTokens: typeof outputTokens === 'number' ? outputTokens : 0,
      },
    };
  }
}
