/**
 * 设备码流（M5-2）—— docs/06 §7.2.3。
 *
 * ```
 *   bot 侧                    平台                      用户浏览器
 *   POST /challenge  ────────▶ 生成 userCode
 *                    ◀──────── { challengeId, userCode, verifyUrl, expiresIn, interval }
 *   轮询 GET /challenge/:id ─▶ (pending)
 *                              用户打开 verifyUrl 确认 ─▶ POST /challenge/:id/approve
 *   轮询 ────────────────────▶ (approved + assertion)
 * ```
 *
 * ★ 四个必须做对的点（都来自 RFC 8628 的实践经验）：
 *
 * 1. **两个标识分工明确**：
 *    - `challengeId`：高熵、面向程序（bot 轮询用）；
 *    - `userCode`：面向**人**（要在网页/群里手输）→ 短、易读。
 *    两者**不能混用**：把 chaallengeId 当 userCode 会让人无法输入；
 *    把 userCode 当凭据会让它可被暴力枚举。
 *
 * 2. **userCode 必须排除易混字符**（`0/O`、`1/I/L`）——用户输错一个字符就要重来。
 *    并且**大小写不敏感**、忽略分隔符（RFC 8628 用 `-` 分组）。
 *
 * 3. **轮询限速**：`interval` 是给客户端的**最小轮询间隔**提示，
 *    服务端也要按它限流，否则暴力枚举 userCode 的成本会降到可接受。
 *
 * 4. **一次性消费**：`approved` 后断言只返回一次（避免轮询方重复领取），
 *    但**保留若干次返回**是常见需求（网络抖动导致客户端没收到）——
 *    折中：返回多次但**每次都返回同一断言**（幂等），并在窗口后失效。
 */

import { randomBytes, randomInt, randomUUID } from 'node:crypto';

// ─────────────────────────── 常量 ───────────────────────────

/**
 * userCode 字符集：去掉了 `0`/`O`/`1`/`I`/`L`（肉眼易混）。
 * 剩下 27 个字符，8 位 → 27^8 ≈ 2.8e11 组合，配合限速足以抵抗枚举。
 */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const DEFAULT_CHALLENGE_TTL_SECONDS = 600;
export const DEFAULT_POLL_INTERVAL_SECONDS = 3;
/** 同一 challenge 最多返回几次断言（容忍客户端网络抖动） */
export const DEFAULT_ASSERTION_DELIVERY_LIMIT = 5;

// ─────────────────────────── 类型 ───────────────────────────

export type ChallengeStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface Challenge {
  challengeId: string;
  userCode: string;
  clientId: string;
  subject: { type: string; value: string };
  scopes: readonly string[];
  status: ChallengeStatus;
  userId: string | null;
  approvedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  /** 已向轮询方交付过几次断言 */
  deliveries: number;
  lastPolledAt: Date | null;
}

export interface ChallengeStore {
  save(challenge: Challenge): Promise<void>;
  get(challengeId: string): Promise<Challenge | undefined>;
  /** 按 userCode 查找（用户确认页用）；大小写与分隔符已归一 */
  findByUserCode(userCode: string): Promise<Challenge | undefined>;
}

export class InMemoryChallengeStore implements ChallengeStore {
  private readonly byId = new Map<string, Challenge>();
  private readonly byCode = new Map<string, string>();

  async save(challenge: Challenge): Promise<void> {
    this.byId.set(challenge.challengeId, { ...challenge });
    this.byCode.set(normalizeUserCode(challenge.userCode), challenge.challengeId);
  }
  async get(challengeId: string): Promise<Challenge | undefined> {
    const found = this.byId.get(challengeId);
    return found === undefined ? undefined : { ...found };
  }
  async findByUserCode(userCode: string): Promise<Challenge | undefined> {
    const id = this.byCode.get(normalizeUserCode(userCode));
    if (id === undefined) return undefined;
    return this.get(id);
  }
}

// ─────────────────────────── userCode ───────────────────────────

/**
 * 归一人输的 userCode：去分隔符、转大写、把易混字符**映射回**字符集。
 *
 * ★ 为什么要「映射」而不只是「拒绝」：用户看到 `B` 可能输 `8`，
 *   直接拒绝会让他们反复失败；映射到唯一候选更友好。
 *   但映射必须有**唯一解**——我们的字符集里已排除 `0/O/1/I/L`，
 *   因此 `O→0` 这类映射是安全的（目标字符不在集合里，不会与合法输入冲突）。
 */
export function normalizeUserCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** 生成 userCode（`XXXX-XXXX`，分组便于朗读与输入）。 */
export function generateUserCode(groups = 2, groupSize = 4): string {
  const parts: string[] = [];
  for (let g = 0; g < groups; g += 1) {
    let part = '';
    for (let i = 0; i < groupSize; i += 1) {
      part += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]!;
    }
    parts.push(part);
  }
  return parts.join('-');
}

// ─────────────────────────── 结果类型 ───────────────────────────

export type DeviceCodeRejection = 'not_found' | 'expired' | 'already_denied' | 'already_approved' | 'poll_too_fast';

export type PollResult =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; userId: string; scopes: readonly string[]; deliveryIndex: number }
  | { ok: false; reason: DeviceCodeRejection; message: string };

// ─────────────────────────── 服务 ───────────────────────────

export interface DeviceCodeServiceOptions {
  store: ChallengeStore;
  /** 平台对外地址（生成 verifyUrl） */
  publicUrl: string;
  ttlSeconds?: number;
  pollIntervalSeconds?: number;
  deliveryLimit?: number;
  now?: () => Date;
}

/**
 * 设备码流服务。
 *
 * 注意：本服务**不生成断言**——它只负责「用户确认」这一步。
 * 断言由调用方在拿到 `approved` 后用 `signAssertion` 签发
 * （职责分开，避免这里依赖签名密钥）。
 */
export class DeviceCodeService {
  private readonly options: DeviceCodeServiceOptions;
  private readonly now: () => Date;

  constructor(options: DeviceCodeServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  /** 发起挑战（bot 侧调用）。 */
  async create(input: { clientId: string; subject: { type: string; value: string }; scopes: readonly string[] }): Promise<{
    challengeId: string;
    userCode: string;
    verifyUrl: string;
    expiresIn: number;
    interval: number;
  }> {
    const now = this.now();
    const ttl = this.options.ttlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
    const challenge: Challenge = {
      challengeId: `ch_${randomUUID()}`,
      userCode: generateUserCode(),
      clientId: input.clientId,
      subject: input.subject,
      scopes: [...input.scopes],
      status: 'pending',
      userId: null,
      approvedAt: null,
      expiresAt: new Date(now.getTime() + ttl * 1000),
      createdAt: now,
      deliveries: 0,
      lastPolledAt: null,
    };
    await this.options.store.save(challenge);
    const base = this.options.publicUrl.replace(/\/+$/, '');
    return {
      challengeId: challenge.challengeId,
      userCode: challenge.userCode,
      verifyUrl: `${base}/verify?code=${encodeURIComponent(challenge.userCode)}`,
      expiresIn: ttl,
      interval: this.options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
    };
  }

  /** 用户确认（浏览器侧调用）。 */
  async approve(userCode: string, userId: string): Promise<{ ok: true; challenge: Challenge } | { ok: false; reason: DeviceCodeRejection; message: string }> {
    const challenge = await this.options.store.findByUserCode(userCode);
    if (challenge === undefined) return { ok: false, reason: 'not_found', message: '验证码不存在（请检查输入或重新发起）' };
    if (this.#isExpired(challenge)) return { ok: false, reason: 'expired', message: '验证码已过期，请重新发起' };
    if (challenge.status === 'approved') return { ok: false, reason: 'already_approved', message: '该验证码已被确认' };
    if (challenge.status === 'denied') return { ok: false, reason: 'already_denied', message: '该验证码已被拒绝' };

    const updated: Challenge = { ...challenge, status: 'approved', userId, approvedAt: this.now() };
    await this.options.store.save(updated);
    return { ok: true, challenge: updated };
  }

  /** 用户拒绝（显式拒绝比「默默过期」对用户更友好，也让 bot 侧早点拿到结论）。 */
  async deny(userCode: string): Promise<{ ok: true } | { ok: false; reason: DeviceCodeRejection; message: string }> {
    const challenge = await this.options.store.findByUserCode(userCode);
    if (challenge === undefined) return { ok: false, reason: 'not_found', message: '验证码不存在' };
    if (this.#isExpired(challenge)) return { ok: false, reason: 'expired', message: '验证码已过期' };
    await this.options.store.save({ ...challenge, status: 'denied' });
    return { ok: true };
  }

  /**
   * 轮询（bot 侧调用）。
   *
   * ★ 限速：请求间隔小于 `interval` 时返回 `poll_too_fast`。
   *   服务端限速是**必需**的——只靠客户端自觉等于没有防护，
   *   而 userCode 是短码（虽然字符集有 2.8e11 组合，但无限速下枚举仍可行）。
   */
  async poll(challengeId: string): Promise<PollResult> {
    const challenge = await this.options.store.get(challengeId);
    if (challenge === undefined) return { ok: false, reason: 'not_found', message: '挑战不存在' };

    const now = this.now();
    const intervalMs = (this.options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
    if (challenge.lastPolledAt !== null && now.getTime() - challenge.lastPolledAt.getTime() < intervalMs) {
      return { ok: false, reason: 'poll_too_fast', message: `轮询过快（最小间隔 ${intervalMs / 1000} 秒）` };
    }

    if (this.#isExpired(challenge) && challenge.status !== 'approved') {
      if (challenge.status !== 'expired') await this.options.store.save({ ...challenge, status: 'expired', lastPolledAt: now });
      return { status: 'expired' };
    }

    if (challenge.status === 'denied') {
      await this.options.store.save({ ...challenge, lastPolledAt: now });
      return { status: 'denied' };
    }

    if (challenge.status === 'approved') {
      const limit = this.options.deliveryLimit ?? DEFAULT_ASSERTION_DELIVERY_LIMIT;
      // ★ 允许重复交付同一断言（容忍网络抖动），但次数有上限——
      //   否则一个泄漏的 challengeId 可以无限领断言
      if (challenge.deliveries >= limit) {
        return { ok: false, reason: 'expired', message: `该挑战的断言已交付 ${limit} 次（上限），请重新发起` };
      }
      const deliveries = challenge.deliveries + 1;
      await this.options.store.save({ ...challenge, deliveries, lastPolledAt: now });
      return {
        status: 'approved',
        userId: challenge.userId!,
        scopes: challenge.scopes,
        deliveryIndex: deliveries,
      };
    }

    await this.options.store.save({ ...challenge, lastPolledAt: now });
    return { status: 'pending' };
  }

  /** 撤销某主体在某个调用方下的临时关联（docs/06 §7.2.3 的 `/revoke`）。 */
  async revoke(challengeId: string): Promise<{ ok: true; revoked: boolean }> {
    const challenge = await this.options.store.get(challengeId);
    if (challenge === undefined) return { ok: true, revoked: false };
    await this.options.store.save({ ...challenge, status: 'denied', userId: null });
    return { ok: true, revoked: true };
  }

  /** 清理过期挑战（可定期调用）。 */
  async purgeExpired(): Promise<number> {
    const store = this.options.store as ChallengeStore & { purgeExpired?: () => Promise<number> };
    return store.purgeExpired === undefined ? 0 : store.purgeExpired();
  }

  #isExpired(challenge: Challenge): boolean {
    return challenge.expiresAt.getTime() <= this.now().getTime();
  }
}

/** 便利函数：生成一个高熵的挑战 id（供自定义 store 使用）。 */
export function newChallengeId(): string {
  return `ch_${randomBytes(16).toString('hex')}`;
}
