/**
 * 邀请码（`ag_invite_codes`）—— 补齐 `docs/08 §5` 声明但**零读写**的表。
 *
 * ★★ 核心是**核销的原子性**（这一条写错就会超发）：
 *   `usedCount < maxUses` 的检查与 `usedCount + 1` 的递增**必须在同一次操作内完成**。
 *   若写成"先查、再判断、再更新"，N 个并发核销会**同时通过检查**，
 *   然后一起把 `used_count` 抬到 `maxUses` 之上——一个限 1 次的邀请码被用了 5 次。
 *   ★ 因此 PG 实现用**单条 `UPDATE … WHERE … RETURNING`**（由数据库保证原子），
 *     而不是"读-改-写"。内存实现天然单线程，语义对齐即可。
 *
 * ★ `grantsFacts` 是**邀请码直接授予的事实**（如 `{ invited: true, cohort: 'beta' }`）：
 *   核销成功后由调用方写进事实库——本模块只负责"返回它"，不替调用方决定怎么用。
 */

export interface InviteCode {
  id: string;
  code: string;
  /** 创建者（平台用户 uuid）；系统批量生成时为 undefined */
  createdBy?: string;
  /** 最多可用次数 */
  maxUses: number;
  usedCount: number;
  /** 核销成功后授予的事实 */
  grantsFacts: Record<string, unknown>;
  /** 过期时间；`null`/`undefined` = 永不过期 */
  expiresAt?: Date | null;
  createdAt: Date;
}

/** 核销失败的原因——**必须区分**，否则用户只会看到"邀请码无效" */
export type RedeemFailure = 'not_found' | 'expired' | 'exhausted';

export type RedeemResult =
  | { ok: true; invite: InviteCode }
  | { ok: false; reason: RedeemFailure };

export interface CreateInviteInput {
  code: string;
  maxUses?: number;
  grantsFacts?: Record<string, unknown>;
  expiresAt?: Date | null;
  createdBy?: string;
  now: Date;
}

export interface InviteCodeStore {
  list(): Promise<readonly InviteCode[]>;
  create(input: CreateInviteInput): Promise<InviteCode>;
  /**
   * 核销一次（**原子**）。
   * ★ 成功时返回**递增后**的邀请码与 `grantsFacts`。
   */
  redeem(input: { code: string; now: Date }): Promise<RedeemResult>;
  remove(id: string): Promise<void>;
}

/** 生成一个随机邀请码（便于人工转述：去掉易混字符）。 */
export function generateInviteCode(length = 12): string {
  // ★ 去掉 `0/O/1/I/L`：邀请码会被**人工抄写**，易混字符是真实的运维摩擦
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

export class InMemoryInviteCodeStore implements InviteCodeStore {
  readonly #rows = new Map<string, InviteCode>();

  async list(): Promise<readonly InviteCode[]> {
    return [...this.#rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.code.localeCompare(b.code));
  }

  async create(input: CreateInviteInput): Promise<InviteCode> {
    const invite: InviteCode = {
      id: `inv-${this.#rows.size + 1}-${input.code}`,
      code: input.code,
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      maxUses: input.maxUses ?? 1,
      usedCount: 0,
      grantsFacts: input.grantsFacts ?? {},
      expiresAt: input.expiresAt ?? null,
      createdAt: input.now,
    };
    this.#rows.set(invite.id, invite);
    return { ...invite };
  }

  async redeem(input: { code: string; now: Date }): Promise<RedeemResult> {
    const row = [...this.#rows.values()].find((candidate) => candidate.code === input.code);
    if (row === undefined) return { ok: false, reason: 'not_found' };
    if (row.expiresAt != null && row.expiresAt.getTime() <= input.now.getTime()) {
      return { ok: false, reason: 'expired' };
    }
    if (row.usedCount >= row.maxUses) return { ok: false, reason: 'exhausted' };
    const next: InviteCode = { ...row, usedCount: row.usedCount + 1 };
    this.#rows.set(row.id, next);
    return { ok: true, invite: { ...next } };
  }

  async remove(id: string): Promise<void> {
    this.#rows.delete(id);
  }
}
