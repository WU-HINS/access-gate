/**
 * 内容摘要（SHA-256）—— **零依赖**模块。
 *
 * ★ 为什么单独一个文件：`digestOf` 同时被
 *   · `src/db/plugin-package-adapter.ts`（包体完整性校验）
 *   · `src/plugin/package-cache.ts`（**本地运行时缓存**的校验）
 *   使用，而后者属于插件层——直接从 db 层取会让「插件缓存」依赖「数据访问层」。
 *   （与 `src/kernel/duration.ts` 打破同类耦合是同一手法。）
 */

import { createHash } from 'node:crypto';

/** `sha256:<hex>` —— 带算法前缀，便于将来换算法而不产生歧义。 */
export function digestOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
