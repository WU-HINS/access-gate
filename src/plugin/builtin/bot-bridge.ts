/**
 * `bot-bridge` 参考实现（M4-16）—— docs/03 §1.14.2、§1.14.3。
 *
 * ★ 验收标准（docs/07 M4-16）：**「展示『标准协议 + 插件适配』的组合」**。
 *
 * 这句话是本模块的全部意义，因此这里刻意把两件事**分开写**：
 *
 * | 层 | 归谁 | 内容 |
 * |---|---|---|
 * | **标准协议** | core（`device-code.ts` + `hmac.ts` + `/api/verify/v1/*`） | challenge / poll / 断言签发 / HMAC 校验 |
 * | **适配** | 本插件 | bot 框架的斜杠命令、消息文案、回调格式 |
 *
 * ★ 因此本模块**不重新实现协议**：它只做「把 bot 框架的交互映射到标准协议」。
 *   这不是「少写点代码」的偷懒，而是文档明确的设计要点：
 *
 *   > **协议属于 core，适配属于插件**。平台不去实现每一个 bot 框架，
 *   > 而是提供稳定协议 + 参考实现 + 官方薄 SDK。
 *
 *   若参考实现自己实现了一遍 challenge/poll，那么「标准协议」就有了两份实现——
 *   两份实现会分叉，而调用方无法知道该信哪一份。
 *
 * ★ 四向闭环中的两个方向由本插件承担（§1.14.3）：
 *   - **外部 → 平台（调）**：bot 调 `/verify/start` + `/verify/poll`；
 *   - **平台 → 外部（推）**：`subscribes` 白名单内的事件回调 bot 的 `callbackUrl`。
 */

import { createHmac } from 'node:crypto';

import type { PluginManifest } from '../manifest.ts';
import type { Logger } from '../../kernel/logger.ts';

// ─────────────────────────── manifest ───────────────────────────

/**
 * bot-bridge 的 manifest（与 docs/03 §1.14.2 的声明逐条对齐）。
 *
 * ★ 权限刻意**收窄到具体路径**：`route:register:/verify/*` 而不是 `route:register:*`。
 *   参考实现要示范「最小权限」，否则第三方会照抄成通配。
 */
export const BOT_BRIDGE_MANIFEST: PluginManifest = {
  apiVersion: 'gate.plugin/v1',
  kind: 'channel',
  id: 'bot-bridge',
  name: 'Bot 桥接（参考实现）',
  version: '1.0.0',
  runtime: 'process',
  permissions: [
    'route:register:/verify/*',
    'route:register:/bind/*',
    'verify:assert',
    'storage:write:self',
    'events:subscribe:policy.granted,policy.revoked',
  ],
  local: true,
  endpoints: [
    { path: '/verify/start', method: 'POST', auth: 'none', visibility: 'public' },
    { path: '/verify/poll', method: 'GET', auth: 'pluginToken' },
    { path: '/bind/complete', method: 'POST', auth: 'hmac' },
  ],
  subscribes: ['policy.granted', 'policy.revoked', 'checkin:granted'],
} as unknown as PluginManifest;

/** 本插件声明订阅的事件（**白名单**：未订阅的一律不分发）。 */
export const BOT_BRIDGE_SUBSCRIPTIONS: readonly string[] = ['policy.granted', 'policy.revoked', 'checkin:granted'];

// ─────────────────────────── 协议接口（由 core 注入） ───────────────────────────

/**
 * 标准协议的能力（**由 core 提供**，插件只消费）。
 *
 * ★ 接口刻意只暴露「协议动作」，不暴露「怎么实现」——
 *   这样参考实现无法（也不需要）自己重造一遍 challenge 存储。
 */
export interface VerifyProtocol {
  /** 发起挑战（core 的 `DeviceCodeService.createChallenge`） */
  startChallenge(input: { subject: { type: string; value: string }; scopes: readonly string[]; clientId: string }): Promise<{
    challengeId: string;
    userCode: string;
    verifyUrl: string;
    expiresIn: number;
    interval: number;
    /** ★ 轮询凭据（只返回给发起方，**不落日志**） */
    pollToken: string;
  }>;
  /** 轮询状态（core 的 `DeviceCodeService.poll`） */
  poll(input: { challengeId: string; pollToken: string }): Promise<
    | { status: 'pending' | 'denied' | 'expired' }
    | { status: 'approved'; assertion: Record<string, unknown> }
  >;
  /** 校验 HMAC 回调（core 的 `verifySignedRequest`） */
  verifyCallback(input: { headers: Record<string, string | undefined>; rawBody: string }): Promise<{ ok: boolean; reason?: string }>;
}

export interface BotBridgeDeps {
  protocol: VerifyProtocol;
  /** 平台对外地址（用于拼 `verifyUrl`） */
  publicUrl: string;
  /** 事件回调的签名密钥引用（宿主托管；插件拿不到明文） */
  callbackSecretRef: string;
  logger?: Logger;
}

// ─────────────────────────── 端点处理 ───────────────────────────

export type StartResult =
  | {
      ok: true;
      /** 展示给用户的码（bot 把它发到频道里） */
      userCode: string;
      /** 用户点开去确认的地址 */
      verifyUrl: string;
      /** ★ 轮询凭据：**只回给发起方**，bot 必须自己保管 */
      pollToken: string;
      challengeId: string;
      expiresIn: number;
      interval: number;
    }
  | { ok: false; status: 400; message: string };

/**
 * `POST /verify/start`（`auth: none`，公开）。
 *
 * ★ 为什么这个端点是公开的：它是**外部系统的入口**——bot 在频道里为某个用户
 *   发起验证时，还没拿到任何平台凭证。安全性由**后续的轮询凭据 + 用户确认**保证：
 *   发起本身不授予任何权限，只是产生一个待确认的挑战。
 *
 * ★ 返回的 `pollToken` 必须与 `userCode` 分开：`userCode` 会显示在**公开频道**里，
 *   而 `pollToken` 是**私密**的轮询凭据。若用 `userCode` 轮询，
 *   频道里任何人都能拿到该用户的断言。
 */
export async function handleStart(
  deps: BotBridgeDeps,
  input: { externalUserId: string; platform: 'discord' | 'slack' | 'telegram' | 'nonebot' | string; scopes?: readonly string[] },
): Promise<StartResult> {
  if (input.externalUserId.trim().length === 0) {
    return { ok: false, status: 400, message: '缺少外部用户标识' };
  }
  const challenge = await deps.protocol.startChallenge({
    // ★ subject 用「平台无关的外部标识」：`<platform>:<id>`
    subject: { type: 'external_id', value: `${input.platform}:${input.externalUserId}` },
    scopes: input.scopes ?? ['assert:read'],
    clientId: `bot-bridge:${input.platform}`,
  });
  deps.logger?.info('bot-bridge 发起验证', {
    platform: input.platform,
    externalUserId: input.externalUserId,
    challengeId: challenge.challengeId,
    // ★ 不记 pollToken（它是凭据）
  });
  return {
    ok: true,
    userCode: challenge.userCode,
    verifyUrl: `${deps.publicUrl.replace(/\/+$/, '')}/verify/challenge`,
    pollToken: challenge.pollToken,
    challengeId: challenge.challengeId,
    expiresIn: challenge.expiresIn,
    interval: challenge.interval,
  };
}

export type PollResult =
  | { ok: true; status: 'pending' | 'denied' | 'expired' }
  | { ok: true; status: 'approved'; assertion: Record<string, unknown> }
  | { ok: false; status: 401 | 404; message: string };

/**
 * `GET /verify/poll`（`auth: pluginToken`）。
 *
 * ★ 必须校验 `pollToken` 与 `challengeId` 的配对：只校验其中一个，
 *   就能用「自己的 pollToken + 别人的 challengeId」读到别人的断言。
 */
export async function handlePoll(deps: BotBridgeDeps, input: { challengeId: string; pollToken: string }): Promise<PollResult> {
  if (input.pollToken.trim().length === 0) {
    return { ok: false, status: 401, message: '缺少轮询凭据（pollToken）——它只回给发起方，不应出现在公开频道里' };
  }
  try {
    const result = await deps.protocol.poll({ challengeId: input.challengeId, pollToken: input.pollToken });
    return result.status === 'approved' ? { ok: true, status: 'approved', assertion: result.assertion } : { ok: true, status: result.status };
  } catch {
    // ★ 不区分「challengeId 不存在」与「pollToken 不匹配」——否则可枚举
    return { ok: false, status: 404, message: '挑战不存在、已过期，或轮询凭据不匹配' };
  }
}

export type BindResult = { ok: true; externalUserId: string; platformUserId: string } | { ok: false; status: 400 | 401; message: string };

/**
 * `POST /bind/complete`（`auth: hmac`）。
 *
 * ★ 这是「外部 → 平台（推）」方向：外部系统主动告知「这个外部账号已绑定到平台的某用户」。
 *   必须验签——否则任何人都能伪造绑定，把**自己的外部账号绑到别人的平台账号**。
 */
export async function handleBindComplete(
  deps: BotBridgeDeps,
  input: { headers: Record<string, string | undefined>; rawBody: string; parsed: { externalUserId?: unknown; platformUserId?: unknown } },
): Promise<BindResult> {
  const verified = await deps.protocol.verifyCallback({ headers: input.headers, rawBody: input.rawBody });
  if (!verified.ok) {
    return { ok: false, status: 401, message: `回调验签失败（${verified.reason ?? '未知原因'}）——拒绝绑定，防止伪造` };
  }
  const externalUserId = input.parsed.externalUserId;
  const platformUserId = input.parsed.platformUserId;
  if (typeof externalUserId !== 'string' || typeof platformUserId !== 'string') {
    return { ok: false, status: 400, message: '缺少 externalUserId 或 platformUserId' };
  }
  deps.logger?.info('bot-bridge 完成绑定', { externalUserId, platformUserId });
  return { ok: true, externalUserId, platformUserId };
}

// ─────────────────────────── 事件推送（平台 → 外部） ───────────────────────────

export interface EventPush {
  event: string;
  payload: Record<string, unknown>;
  at: Date;
}

export type PushDecision =
  | { ok: true; body: string; headers: Record<string, string>; url: string }
  | { ok: false; reason: 'not_subscribed' | 'no_callback'; message: string };

/**
 * 生成「平台 → 外部」的事件推送（带 HMAC 签名）。
 *
 * ★ 三条：
 *   1. **只推已订阅的事件**（`subscribes` 白名单）——否则平台会把**全部**内部事件
 *      推给每个插件，而事件里常含用户与策略信息；
 *   2. **签名**：外部系统必须能验证「这确实来自平台」；
 *   3. **时间戳进签名**：否则一次捕获的推送可以被**无限重放**。
 */
export function buildEventPush(
  input: { event: string; payload: Record<string, unknown>; callbackUrl?: string; secret: string; at: Date },
  subscriptions: readonly string[] = BOT_BRIDGE_SUBSCRIPTIONS,
): PushDecision {
  if (!subscriptions.includes(input.event)) {
    return {
      ok: false,
      reason: 'not_subscribed',
      message: `插件未订阅事件 '${input.event}'（已订阅：${subscriptions.join(', ') || '无'}）——未订阅的事件不应被推送`,
    };
  }
  if (input.callbackUrl === undefined || input.callbackUrl.length === 0) {
    return { ok: false, reason: 'no_callback', message: '未配置 callbackUrl，无法推送' };
  }
  const body = JSON.stringify({ event: input.event, payload: input.payload, at: input.at.toISOString() });
  // ★ 时间戳参与签名（防重放）
  const signature = createHmac('sha256', input.secret).update(`${input.at.getTime()}\n${body}`, 'utf8').digest('hex');
  return {
    ok: true,
    url: input.callbackUrl,
    body,
    headers: {
      'content-type': 'application/json',
      'x-gate-event': input.event,
      'x-gate-signature': `sha256=${signature}`,
      'x-gate-timestamp': String(input.at.getTime()),
    },
  };
}

/** 校验来自平台的推送（供参考实现的对接方自测；与 `buildEventPush` 对称）。 */
export function verifyEventPush(input: {
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  now: Date;
  toleranceMs?: number;
}): { ok: boolean; reason?: 'missing_signature' | 'bad_timestamp' | 'expired' | 'signature_mismatch' } {
  if (input.signature === undefined || !input.signature.startsWith('sha256=')) return { ok: false, reason: 'missing_signature' };
  if (input.timestamp === undefined) return { ok: false, reason: 'bad_timestamp' };
  const timestamp = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  // ★ 时间窗（默认 5 分钟）：超出即拒绝，防重放
  const tolerance = input.toleranceMs ?? 5 * 60_000;
  if (Math.abs(input.now.getTime() - timestamp) > tolerance) return { ok: false, reason: 'expired' };
  const expected = createHmac('sha256', input.secret).update(`${timestamp}\n${input.body}`, 'utf8').digest('hex');
  return expected === input.signature.slice('sha256='.length) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

/**
 * 适配层的示例：把 bot 框架的「斜杠命令」映射到标准协议调用。
 *
 * ★ 这个函数是「**适配属于插件**」的最小示范：
 *   它只做「框架特有的输入 → 标准协议入参」的翻译，
 *   不含任何协议语义（challenge 存储、轮询限速、断言签发都在 core）。
 *   接入新框架时，只需照抄这个形状。
 */
export function adaptSlashCommand(input: {
  platform: string;
  /** 框架给的原始交互对象（形状各异，这里只取需要的字段） */
  interaction: { userId?: unknown; command?: unknown; options?: unknown };
}): { ok: true; externalUserId: string; platform: string; scopes: readonly string[] } | { ok: false; message: string } {
  const userId = input.interaction.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    return { ok: false, message: `无法从 ${input.platform} 的交互对象里取到用户标识` };
  }
  // `options` 里可带 scopes（各框架形状不同，这里做一次归一化）
  const rawOptions = Array.isArray(input.interaction.options) ? (input.interaction.options as { name?: unknown; value?: unknown }[]) : [];
  const scopesOption = rawOptions.find((option) => option.name === 'scopes');
  const scopes =
    typeof scopesOption?.value === 'string'
      ? scopesOption.value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
      : ['assert:read'];
  return { ok: true, externalUserId: userId, platform: input.platform, scopes };
}

/** 各框架的接入形态（docs/03 §1.14.2 的表格，做成数据以便核对）。 */
export const FRAMEWORK_INTEGRATION_MATRIX: readonly { framework: string; approach: string; needsPlatformPlugin: boolean }[] = [
  { framework: 'NoneBot2 / Koishi / BotPy', approach: '官方插件调用 /api/verify/v1/*', needsPlatformPlugin: false },
  { framework: 'Discord / Slack / Telegram Bot', approach: '同上 + 斜杠命令注册', needsPlatformPlugin: false },
  { framework: 'Minecraft 服务端插件（Paper/Velocity）', approach: '调 /api/verify/v1/assert（仅认证用户可进服）', needsPlatformPlugin: false },
  { framework: '需要平台侧 webhook 接收', approach: '装一个 declarative webhook 插件（零代码）', needsPlatformPlugin: true },
  { framework: '需要复杂交互（多步、状态机）', approach: '装 process 形态插件', needsPlatformPlugin: true },
];
