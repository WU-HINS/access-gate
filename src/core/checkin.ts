/**
 * 签到资格（`ag_checkin_entitlements`）—— docs/02 §6.4 · docs/05 §3.2 / §5.2。
 *
 * ★ 为什么需要这个文件：`checkin:grant` / `checkin:revoke` 此前写的是
 *   `tools/serve.ts` 里的**进程内 `Map`**（`grantedCheckins`）——
 *   后果是**重启后全部资格丢失**、多实例下各自为政：
 *   用户「已解锁签到」在一台实例上成立、在另一台上不成立。
 *
 * ★ 而表 `ag_checkin_entitlements` **早已由 `docs/02` 声明并建好**，却零读写——
 *   属于本仓库反复出现的形态：「**上游产物已就绪，下游没消费**」。
 *
 * ★ 语义（对齐 docs/05 §3.2「写本地资格标记」与「删除资格标记」）：
 *   · 资格是**站点级**的；唯一键 `(siteId, userId, scope)`。
 *   · `grant` **幂等**：已授予且未撤销时**不改 `grantedAt`**——「同一幂等键执行 N 次 ≡ 1 次」
 *     要求重复执行不改变事实时间；曾被撤销时重新授予（清 `revokedAt`）。
 *   · `revoke` **幂等**：已撤销时不再改动 `revokedAt`。
 *
 * ★ `grantedAt` 记的是**首次授予时间**（不是最近一次）。若需要「每次授予的时间线」，
 *   承载物是审计流水（`ag_audit_log`），而不是把本表变成流水表——
 *   因为本表的存在意义正是「当前是否有效」这一个可判定问题。
 */

export interface CheckinEntitlement {
  siteId: string;
  userId: string;
  scope: string;
  /** 是哪条策略授予的（可空：手动授予 / 迁移数据） */
  sourcePolicyId?: string;
  /** 首次授予时间 */
  grantedAt: Date;
  /** 为空 = 当前有效；非空 = 已撤销 */
  revokedAt?: Date;
}

export interface CheckinEntitlementStore {
  find(siteId: string, userId: string, scope: string): Promise<CheckinEntitlement | undefined>;
  /** 该主体当前**有效**（未撤销）的全部资格 */
  listActive(siteId: string, userId: string): Promise<CheckinEntitlement[]>;
  /** 幂等授予（不改变已有效资格的 `grantedAt`） */
  grant(input: {
    siteId: string;
    userId: string;
    scope: string;
    sourcePolicyId?: string;
    now?: Date;
  }): Promise<void>;
  /** 幂等撤销 */
  revoke(input: { siteId: string; userId: string; scope: string; now?: Date }): Promise<void>;
}

/** 判断一条资格当前是否有效（唯一判据：`revokedAt` 为空）。 */
export function isActive(entitlement: CheckinEntitlement): boolean {
  return entitlement.revokedAt === undefined || entitlement.revokedAt === null;
}

export class InMemoryCheckinEntitlementStore implements CheckinEntitlementStore {
  readonly #rows = new Map<string, CheckinEntitlement>();

  #key(siteId: string, userId: string, scope: string): string {
    return `${siteId}\u0000${userId}\u0000${scope}`;
  }

  async find(siteId: string, userId: string, scope: string): Promise<CheckinEntitlement | undefined> {
    const found = this.#rows.get(this.#key(siteId, userId, scope));
    return found === undefined ? undefined : { ...found };
  }

  async listActive(siteId: string, userId: string): Promise<CheckinEntitlement[]> {
    return [...this.#rows.values()]
      .filter((row) => row.siteId === siteId && row.userId === userId && isActive(row))
      .map((row) => ({ ...row }));
  }

  async grant(input: {
    siteId: string;
    userId: string;
    scope: string;
    sourcePolicyId?: string;
    now?: Date;
  }): Promise<void> {
    const key = this.#key(input.siteId, input.userId, input.scope);
    const existing = this.#rows.get(key);
    const now = input.now ?? new Date();
    if (existing === undefined) {
      this.#rows.set(key, {
        siteId: input.siteId,
        userId: input.userId,
        scope: input.scope,
        ...(input.sourcePolicyId === undefined ? {} : { sourcePolicyId: input.sourcePolicyId }),
        grantedAt: now,
      });
      return;
    }
    // ★ 已有效 → 完全不动（幂等：不改 grantedAt、不写新行）
    if (isActive(existing)) return;
    // ★ 曾被撤销 → 重新授予：清 revokedAt；grantedAt 保持首次授予时间
    const next: CheckinEntitlement = {
      siteId: existing.siteId,
      userId: existing.userId,
      scope: existing.scope,
      ...(input.sourcePolicyId === undefined ? {} : { sourcePolicyId: input.sourcePolicyId }),
      grantedAt: existing.grantedAt,
    };
    this.#rows.set(key, next);
  }

  async revoke(input: { siteId: string; userId: string; scope: string; now?: Date }): Promise<void> {
    const key = this.#key(input.siteId, input.userId, input.scope);
    const existing = this.#rows.get(key);
    // ★ 不存在时不创建「已撤销」的空行——撤销一个从未授予的资格是 no-op
    if (existing === undefined) return;
    if (!isActive(existing)) return; // 幂等
    this.#rows.set(key, { ...existing, revokedAt: input.now ?? new Date() });
  }
}

// ─────────────────────────── 签到记录（`ag_checkin_records`） ───────────────────────────

/**
 * 一次签到的**发放状态**。
 *
 * ★ `unknown` 与 `pending` 的区别来自 `docs/05 §5.2.1` 的 DC-3：
 *   超时后**无法判定**下游是否已发（`add_quota` 是**增量**操作，读回无法判定），
 *   因此**禁止自动重发**——只走对账核销。这是「发了但响应丢了」不会变成「重复发」的前提。
 */
export type CheckinGrantState = 'pending' | 'in_flight' | 'confirmed' | 'unknown';

export interface CheckinRecord {
  siteId: string;
  userId: string;
  /** **站点时区**下的自然日，`YYYY-MM-DD`（docs/05 §5.2 的时区语义） */
  checkinDate: string;
  quotaAwarded: number;
  grantState: CheckinGrantState;
  requestId?: string;
  grantVia: string;
  providerLogId?: number;
  streak: number;
}

export interface CheckinRecordStore {
  /**
   * **幂等锚点**：插入成功返回 `true`；同日已存在返回 `false`（**绝不覆盖**已有行）。
   *
   * ★ 为什么它是签到防重复发额度的**唯一**依靠：`add_quota` 是增量操作，
   *   幂等不能靠下游读回；而「先写记录再发额度」把「是否已签」变成
   *   **数据库层面的原子判定**（唯一键），而不是「查询‒判断‒写入」的三步竞态。
   */
  tryInsert(record: CheckinRecord): Promise<boolean>;
  find(siteId: string, userId: string, checkinDate: string): Promise<CheckinRecord | undefined>;
  /** 最近 N 条（按日期倒序），供 history 与连签计算 */
  listRecent(siteId: string, userId: string, limit: number): Promise<CheckinRecord[]>;
  markGranted(input: {
    siteId: string;
    userId: string;
    checkinDate: string;
    providerLogId?: number;
    requestId?: string;
  }): Promise<void>;
  /** 发额度**结果未知**（超时/5xx）：保持记录、标记 unknown，交由对账核销——**不自动重发** */
  markUnknown(input: { siteId: string; userId: string; checkinDate: string; error: string }): Promise<void>;
}

export class InMemoryCheckinRecordStore implements CheckinRecordStore {
  readonly #rows = new Map<string, CheckinRecord>();

  #key(siteId: string, userId: string, checkinDate: string): string {
    return `${siteId}\u0000${userId}\u0000${checkinDate}`;
  }

  async tryInsert(record: CheckinRecord): Promise<boolean> {
    const key = this.#key(record.siteId, record.userId, record.checkinDate);
    if (this.#rows.has(key)) return false; // ★ 绝不覆盖：同日第二次签到必须走「已签到」分支
    this.#rows.set(key, { ...record });
    return true;
  }

  async find(siteId: string, userId: string, checkinDate: string): Promise<CheckinRecord | undefined> {
    const found = this.#rows.get(this.#key(siteId, userId, checkinDate));
    return found === undefined ? undefined : { ...found };
  }

  async listRecent(siteId: string, userId: string, limit: number): Promise<CheckinRecord[]> {
    return [...this.#rows.values()]
      .filter((row) => row.siteId === siteId && row.userId === userId)
      .sort((a, b) => (a.checkinDate < b.checkinDate ? 1 : -1))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async markGranted(input: {
    siteId: string;
    userId: string;
    checkinDate: string;
    providerLogId?: number;
    requestId?: string;
  }): Promise<void> {
    const key = this.#key(input.siteId, input.userId, input.checkinDate);
    const existing = this.#rows.get(key);
    if (existing === undefined) return;
    this.#rows.set(key, {
      ...existing,
      grantState: 'confirmed',
      ...(input.providerLogId === undefined ? {} : { providerLogId: input.providerLogId }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
  }

  async markUnknown(input: {
    siteId: string;
    userId: string;
    checkinDate: string;
    error: string;
  }): Promise<void> {
    const key = this.#key(input.siteId, input.userId, input.checkinDate);
    const existing = this.#rows.get(key);
    if (existing === undefined) return;
    this.#rows.set(key, { ...existing, grantState: 'unknown', requestId: input.error.slice(0, 64) });
  }
}
