/**
 * 灰度**一键熔断**的状态（`docs/07 M6-3`「灰度发布与一键熔断」）。
 *
 * ★★ 为什么需要独立的状态存储：`policy/rollout.ts` 里的 `abortRollout` 是**纯函数**
 *   （返回新配置、不改原对象），它需要一个**权威的存放处** ——
 *   否则"按下了熔断按钮"只存在于某次函数调用的返回值里，重启即忘。
 *
 * ★ 为什么每条都带 `siteId`：`docs/05 §6.3.1` 明确要求
 *   「熔断区分插件级 / 站点级，并给出**按站点分组的受影响清单**」——
 *   没有站点归属就分不出组，而运维最需要的正是"**这次熔断动了哪些站点**"。
 *
 * ★ 与 `docs/05 §6.3.1` 的"键必须与资源归属同构"一致：灰度是**站点级**资源
 *   （策略属于站点），所以熔断的键也是 `(siteId, policyId)`。
 */

export interface RolloutAbort {
  /** ★ 站点归属（`docs/05 §6.3.1`：熔断要能**按站点分组**） */
  siteId: string;
  policyId: string;
  /** 策略 code（人读用；排障时比 uuid 好认） */
  policyCode: string;
  /** 熔断时被回滚的目标版本（旧版本），便于事后核对"回到了哪一版" */
  fromVersion: number;
  abortedAt: Date;
  abortedBy: string;
  reason: string;
}

export interface RolloutAbortStore {
  list(): Promise<readonly RolloutAbort[]>;
  /**
   * 熔断（**幂等**）。
   *
   * ★ 重复熔断**保留首次**的时间与原因：「谁最先发现」在事后复盘里
   *   比「最后一次点按钮的人」更有价值（与 `abortRollout` 的纯函数语义一致）。
   */
  abort(input: {
    siteId: string;
    policyId: string;
    policyCode: string;
    fromVersion: number;
    by: string;
    reason: string;
    at: Date;
  }): Promise<RolloutAbort>;
  /** 恢复灰度（清除熔断状态）。返回是否确有状态被清除。 */
  resume(siteId: string, policyId: string): Promise<boolean>;
  /** ★ 判定路径用：当前已熔断的**策略 id** 集合（喂给 `AssignmentContext.abortedPolicyIds`） */
  abortedPolicyIds(siteId: string): Promise<readonly string[]>;
}

/** 按站点分组的受影响清单（`docs/05 §6.3.1` 的明文要求）。 */
export interface AbortAffectedGroup {
  siteId: string;
  /** 该站点上被熔断的策略（code + 回到的版本 + 原因 + 谁按的） */
  policies: readonly { policyCode: string; fromVersion: number; abortedBy: string; reason: string; abortedAt: Date }[];
}

/**
 * 把熔断记录**按站点分组**。
 *
 * ★ 为什么要专门一个函数而不是在端点里现写 `reduce`：
 *   端点里的分组逻辑无法被单独测试，而"分组对不对"正是运维看到的第一手信息。
 */
export function groupAbortsBySite(aborts: readonly RolloutAbort[]): AbortAffectedGroup[] {
  const bySite = new Map<string, RolloutAbort[]>();
  for (const abort of aborts) {
    const list = bySite.get(abort.siteId);
    if (list === undefined) bySite.set(abort.siteId, [abort]);
    else list.push(abort);
  }
  return [...bySite.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([siteId, list]) => ({
      siteId,
      policies: [...list]
        .sort((a, b) => a.policyCode.localeCompare(b.policyCode))
        .map((abort) => ({
          policyCode: abort.policyCode,
          fromVersion: abort.fromVersion,
          abortedBy: abort.abortedBy,
          reason: abort.reason,
          abortedAt: abort.abortedAt,
        })),
    }));
}

export class InMemoryRolloutAbortStore implements RolloutAbortStore {
  readonly #rows = new Map<string, RolloutAbort>();

  #key(siteId: string, policyId: string): string {
    return `${siteId}\u0000${policyId}`;
  }

  async list(): Promise<readonly RolloutAbort[]> {
    return [...this.#rows.values()].map((row) => ({ ...row }));
  }

  async abort(input: {
    siteId: string;
    policyId: string;
    policyCode: string;
    fromVersion: number;
    by: string;
    reason: string;
    at: Date;
  }): Promise<RolloutAbort> {
    const key = this.#key(input.siteId, input.policyId);
    const existing = this.#rows.get(key);
    // ★ 幂等：已熔断则**原样返回首次记录**，不覆盖时间与原因
    if (existing !== undefined) return { ...existing };
    const row: RolloutAbort = {
      siteId: input.siteId,
      policyId: input.policyId,
      policyCode: input.policyCode,
      fromVersion: input.fromVersion,
      abortedAt: input.at,
      abortedBy: input.by,
      reason: input.reason,
    };
    this.#rows.set(key, row);
    return { ...row };
  }

  async resume(siteId: string, policyId: string): Promise<boolean> {
    return this.#rows.delete(this.#key(siteId, policyId));
  }

  async abortedPolicyIds(siteId: string): Promise<readonly string[]> {
    return [...this.#rows.values()].filter((row) => row.siteId === siteId).map((row) => row.policyId);
  }
}
