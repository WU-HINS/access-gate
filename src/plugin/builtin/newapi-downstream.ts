/**
 * `DownstreamApi` 的 new-api 实现 —— **动作插件与下游之间的唯一适配层**。
 *
 * ★ 为什么单独成文件（而不是写在 `tools/serve.ts` 里）：
 *   装配层与「`docs/07 §5` 场景 A 的端到端验收」**必须用同一份实现**。
 *   本仓库有过明确教训：*测试手写装置与生产实现不一致，于是不变量在测试中静默失效*
 *   （见 `reports/schema-doc-defects.md` 末尾：`pg-real.test.ts` 曾手写一个漏掉
 *   `assertInTransaction` 的 `Db`）。把适配层提升为生产模块，测试就直接压在生产路径上。
 *
 * ★ 两条硬约束**在写回实现内部强制**，不依赖调用方自觉：
 *   ① 必须先 `GET` 再 `PUT`（下游 `PUT /api/user/` 是整体替换，缺字段会被清空）；
 *   ② **绝不带 `password`**（带上会改掉/清空用户密码——不可逆损坏）。
 *   两者都在 `writeBackAttributes` 里，本文件**只做转发**，不允许自造 payload。
 */

import {
  writeBackAttributes,
  type NewApiProviderDeps,
} from './newapi-provider.ts';
import type { DownstreamApi } from './newapi-actions.ts';

export interface NewApiDownstreamOptions {
  /** 与 provider 共用的连接信息（同一份解析结果，避免两处漂移） */
  providerDeps: NewApiProviderDeps;
  /** 读主体：由装配层注入（经 provider 的 `getSubject`） */
  getSubject: (externalId: string) => Promise<{ attributes: Record<string, unknown> } | null>;
}

export function createNewApiDownstreamApi(options: NewApiDownstreamOptions): DownstreamApi {
  const { transport, pat, config } = options.providerDeps;
  const base = config.baseUrl.replace(/\/+$/, '');

  return {
    get: (externalId) => options.getSubject(externalId),

    async put(externalId, attributes) {
      // ★ 只接受 `group`：其他字段的写回必须走各自的动作插件，
      //   否则会绕过 `writeBackAttributes` 的白名单构造（那正是「不带 password」的保障）。
      const group = attributes['group'];
      if (typeof group !== 'string') {
        throw new Error('写回仅支持 group 字段（其他字段请走对应的动作插件）');
      }
      await writeBackAttributes(options.providerDeps, externalId, { group });
    },

    async manage(externalId, action, value) {
      const body: Record<string, unknown> = { id: Number(externalId), action };
      if (value !== undefined) body['value'] = value;
      const response = await transport.request({
        method: 'POST',
        url: `${base}/api/user/manage`,
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body,
      });
      if (response.status < 200 || response.status >= 300) {
        // 消息里带状态码：动作层按 4xx 判「不可重试」（配置/权限错，重试无意义）
        throw new Error(`下游 manage 失败（${response.status}）：${response.text.slice(0, 200)}`);
      }
    },
  };
}
