/**
 * 主密钥加密（`ag_secrets` 的写入/读取）。
 *
 * ★★ 为什么必须有它：`src/verify/hmac.ts` 从设计之初就写着——
 *
 *   「原始 secret 必须**加密存储**（`ag_secrets` + 主密钥）以便重算 HMAC。
 *     内存实现直接存明文（仅供测试），PG 实现应走 `ag_secrets` 解密。」
 *
 *   而 R30 核对表使用时发现：**`ag_secrets` 表从未被任何代码读写**，
 *   且 `serve.ts` 在真实 PG 模式下也用的是 `InMemoryVerifyClientStore`。
 *   于是「HMAC 校验」在真实模式下**根本找不到调用方**——
 *   这是「用内存模式冒充真实模式」的典型（目标第 1 条明确禁止）。
 *
 * ★ 算法：**AES-256-GCM**（带认证标签）。表结构里的 `iv` + `auth_tag`
 *   正是为它准备的——**不是**自己发明的格式，而是按 schema 的字段设计实现。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** 密文三段（与 `ag_secrets` 的三个列一一对应）。 */
export interface SealedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export class MasterKeyMissingError extends Error {
  override readonly name = 'MasterKeyMissingError';
  constructor() {
    super(
      '缺少主密钥：设置 AG_MASTER_KEY（32 字节，hex 或 base64）后方可加解密 `ag_secrets`。' +
        '真实 PG 模式下**必须**提供——否则调用方密钥无法安全落库，HMAC 校验也无法工作。',
    );
  }
}

/** 解析 `AG_MASTER_KEY`（支持 hex 与 base64，必须是 32 字节）。 */
export function parseMasterKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim().length === 0) throw new MasterKeyMissingError();
  const value = raw.trim();
  const buffer = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (buffer.length !== 32) {
    throw new Error(`AG_MASTER_KEY 必须是 32 字节（实际 ${buffer.length} 字节）——AES-256 要求 256 位密钥`);
  }
  return buffer;
}

/** 加密（返回可直接写入 `ag_secrets` 三段的值）。 */
export function sealSecret(plaintext: string, masterKey: Buffer, keyVersion = 1): SealedSecret {
  const iv = randomBytes(12); // GCM 推荐 96 位 IV
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion,
  };
}

/** 解密（`authTag` 不匹配时**抛错**——GCM 保证密文未被篡改）。 */
export function openSecret(sealed: SealedSecret, masterKey: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
