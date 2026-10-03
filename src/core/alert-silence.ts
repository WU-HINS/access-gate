/**
 * 告警静默（`docs/05 §2.1.2` 的四件套之一）—— **必须带期限，且到期自动恢复**。
 *
 * ★★ 为什么必须有它（`reports/architecture-gaps.md` R109 的原话）：
 * > 代码核实：`grep -rniE "silence" src/` → **0 结果**。即「静默」这个能力整体不存在。
 * > 后果：告警无法被临时压制，运维只能「**关掉整个告警**」——
 * > 而声明正是为了避免这种情况才要求「**带期限且自动恢复**」。
 *
 * ★★★ 本实现里最重要的一条设计：**「到期自动恢复」不依赖任何清理任务**。
 *
 * 判定一律是 `until > now`（见 `isSilenced`），因此：
 *   · 即使清理任务从未运行，到期的静默也**已经失效**；
 *   · 清理任务只是**回收存储**，不是正确性的一部分。
 *
 * 反过来做（靠定时任务把过期的静默删掉来"恢复"）会引入一个静默黑洞：
 * **任务没跑 → 告警被永久压制，而没人知道**——正是本仓库反复出现的那类缺陷。
 *
 * ── 三个审计事件（文档要求）──
 * | 事件 | 何时写 |
 * |---|---|
 * | `alert.raised` | 告警被触发（**被静默时也写**，只是标记 `suppressed: true`） |
 * | `alert.acknowledged` | 有人确认了告警 |
 * | `alert.silenced` | 有人设置了静默（含期限与理由） |
 */

import type { AuditSink } from '../admin/api.ts';

export interface AlertSilence {
  /** 被静默的告警码（与 `logger.warn` 的 `invariant` / 告警码一致）；`'*'` = 全部 */
  code: string;
  /** 静默截止时间——**必填**（「永久静默」正是本条要防的） */
  until: Date;
  /** 谁设的 */
  by: string;
  reason: string;
  createdAt: Date;
}

export interface AlertSilenceStore {
  list(): Promise<readonly AlertSilence[]>;
  put(silence: AlertSilence): Promise<void>;
  /** 移除（清理任务用；**正确性不依赖它**——见文件头） */
  remove(code: string): Promise<void>;
}

export class InMemoryAlertSilenceStore implements AlertSilenceStore {
  readonly #rows = new Map<string, AlertSilence>();

  async list(): Promise<readonly AlertSilence[]> {
    return [...this.#rows.values()].map((row) => ({ ...row }));
  }

  async put(silence: AlertSilence): Promise<void> {
    // 同码覆盖：重新静默 = 更新期限（而不是堆多条）
    this.#rows.set(silence.code, { ...silence });
  }

  async remove(code: string): Promise<void> {
    this.#rows.delete(code);
  }
}

/** 默认静默时长上限：7 天。超过它就不是「临时压制」，而是「关掉告警」的另一种写法。 */
export const DEFAULT_MAX_SILENCE_MS = 7 * 24 * 3_600_000;

/**
 * 校验一次静默请求。
 *
 * ★ 三条都拒绝：非法时间、**过去的时间**、**超长（含"永不过期"）**。
 *   文档只写了「必须带期限」，这里把「期限必须是合理的有限值」也一并落下——
 *   否则 `until = 9999-12-31` 就是一个形式上有期限、实质永久的静默。
 */
export function validateSilence(input: {
  until: Date;
  now: Date;
  maxMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  const maxMs = input.maxMs ?? DEFAULT_MAX_SILENCE_MS;
  if (Number.isNaN(input.until.getTime())) {
    return { ok: false, reason: 'until 不是合法时间' };
  }
  if (input.until.getTime() <= input.now.getTime()) {
    return { ok: false, reason: 'until 必须晚于当前时间（静默必须带期限，且不能是过去的时间）' };
  }
  if (input.until.getTime() - input.now.getTime() > maxMs) {
    const days = Math.round(maxMs / 3_600_000 / 24);
    return {
      ok: false,
      reason: `静默时长超过上限 ${days} 天——「永不过期的静默」正是本条要防的（请改用修复或显式关闭该告警）`,
    };
  }
  return { ok: true };
}

/**
 * 该告警码此刻是否被静默。
 *
 * ★★ `until > now` 就是「到期自动恢复」的**全部实现**——不查任何清理状态。
 */
export function isSilenced(input: {
  silences: readonly AlertSilence[];
  code: string;
  now: Date;
}): boolean {
  return input.silences.some(
    (silence) =>
      (silence.code === input.code || silence.code === '*') &&
      silence.until.getTime() > input.now.getTime(),
  );
}

/** 已到期、可回收的静默（**仅用于回收存储**，不参与正确性判定）。 */
export function expiredSilences(input: {
  silences: readonly AlertSilence[];
  now: Date;
}): AlertSilence[] {
  return input.silences.filter((silence) => silence.until.getTime() <= input.now.getTime());
}

export interface AlertSilenceServiceDeps {
  store: AlertSilenceStore;
  audit?: AuditSink;
  /** 审计记录归属的站点（平台级告警用 'platform'） */
  siteId?: string;
  now?: () => Date;
  maxSilenceMs?: number;
}

export class AlertSilenceService {
  readonly #deps: AlertSilenceServiceDeps;

  constructor(deps: AlertSilenceServiceDeps) {
    this.#deps = deps;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  async #audit(input: {
    action: string;
    actorId: string;
    targetId: string;
    after: unknown;
  }): Promise<void> {
    if (this.#deps.audit === undefined) return;
    await this.#deps.audit.record({
      siteId: this.#deps.siteId ?? 'platform',
      actorId: input.actorId,
      actorType: 'admin',
      action: input.action,
      targetType: 'alert',
      targetId: input.targetId,
      after: input.after,
    });
  }

  async list(): Promise<readonly AlertSilence[]> {
    return this.#deps.store.list();
  }

  async isSilenced(code: string): Promise<boolean> {
    return isSilenced({ silences: await this.#deps.store.list(), code, now: this.#now() });
  }

  /** 设置静默：校验 → 落库 → 写 `alert.silenced` 审计。 */
  async silence(input: {
    code: string;
    until: Date;
    by: string;
    reason: string;
  }): Promise<{ ok: true; silence: AlertSilence } | { ok: false; reason: string }> {
    const now = this.#now();
    const check = validateSilence({
      until: input.until,
      now,
      ...(this.#deps.maxSilenceMs === undefined ? {} : { maxMs: this.#deps.maxSilenceMs }),
    });
    if (!check.ok) return check;

    const silence: AlertSilence = {
      code: input.code,
      until: input.until,
      by: input.by,
      reason: input.reason,
      createdAt: now,
    };
    await this.#deps.store.put(silence);
    await this.#audit({
      action: 'alert.silenced',
      actorId: input.by,
      targetId: input.code,
      after: { until: input.until.toISOString(), reason: input.reason },
    });
    return { ok: true, silence };
  }

  /** 确认告警（写 `alert.acknowledged`）。 */
  async acknowledge(input: { code: string; by: string; note?: string }): Promise<void> {
    await this.#audit({
      action: 'alert.acknowledged',
      actorId: input.by,
      targetId: input.code,
      after: { note: input.note ?? null, at: this.#now().toISOString() },
    });
  }

  /**
   * 触发一次告警。
   *
   * ★★ 返回值表示「**是否应该打扰人**」；而**两种情形都写 `alert.raised` 审计**：
   *   被静默时标记 `suppressed: true`。
   *   为什么被静默也要留痕——否则事后无法证明「告警确实触发过、只是被压住了」，
   *   而「静默期间到底有没有发生过」正是事故复盘的第一个问题。
   */
  async raise(input: { code: string; detail: string; by?: string }): Promise<boolean> {
    const suppressed = await this.isSilenced(input.code);
    await this.#audit({
      action: 'alert.raised',
      actorId: input.by ?? 'system',
      targetId: input.code,
      after: { detail: input.detail, suppressed },
    });
    return !suppressed;
  }

  /** 回收已到期的静默（**仅回收存储**；正确性不依赖它，见文件头）。 */
  async purgeExpired(): Promise<number> {
    const expired = expiredSilences({ silences: await this.#deps.store.list(), now: this.#now() });
    for (const silence of expired) {
      await this.#deps.store.remove(silence.code);
    }
    return expired.length;
  }
}
