/**
 * 生命周期状态存储的**类型契约**（独立文件）。
 *
 * 为什么单独一个文件：`src/db/adapters.ts` 需要这个接口，而 `src/core/patrol.ts`
 * 需要 `Db` 的实现——放在一起会形成 `db → core/patrol → db` 的循环。
 * 把纯类型抽出来即可打破（类型在运行时不存在，不构成循环）。
 */

import type { LifecycleSnapshot, LifecycleState } from './lifecycle.ts';

/** 一条策略状态 + 它的 `policyId`（级联回退要跨策略聚合，必须能拿到 id） */
export interface LifecycleStateEntry {
  /** PG 下是 uuid；内存模式下用 `policyCode` 代替（两者在各自装配里自洽） */
  policyId: string;
  /**
   * ★ PG 实现下为 `null`：从 `policy_id` 反查 code 需要 JOIN，而查询编译器不支持 JOIN
   *   （见 `tools/ci-gate.ts` 里对适配器文件的白名单说明）。装配层本来就有 code ↔ id
   *   的映射，由它反查即可——这里不为了「好看」而手写 JOIN。内存实现直接给 code。
   */
  policyCode: string | null;
  state: LifecycleState;
  snapshot: LifecycleSnapshot;
}

export interface BaselineKey {
  siteId: string;
  userId: string;
  policyCode: string;
  /** 动作规范形（如 `newapi-set-group:set_group`）——`baseline` / `appliedActions` 的键 */
  actionKey: string;
}

export interface LifecycleStateStore {
  get(siteId: string, userId: string, policyCode: string): Promise<LifecycleSnapshot | undefined>;
  save(siteId: string, userId: string, policyCode: string, snapshot: LifecycleSnapshot): Promise<void>;

  /**
   * ★ 该主体在**本站点**的全部策略状态。
   *
   * 为什么必须补上（而不是让调用方逐策略 `get`）：级联回退（`docs/05 §3.5` 修正二）
   * 的判定是「收集该主体**所有仍处于 granted / satisfied** 的策略所要求的目标值」——
   * 逐策略调用要求调用方**先知道有哪些策略**，而策略集合本身是动态的。
   */
  listByUser(siteId: string, userId: string): Promise<readonly LifecycleStateEntry[]>;

  /** 读 baseline（首次接管前的原值）；不存在返回 `null` */
  baselineOf(input: BaselineKey): Promise<string | null>;

  /**
   * 幂等写 baseline：**仅当该键为空时写入**。
   *
   * ★ 为什么必须「仅当为空」：baseline 的语义是「**首次**接管前的原值」。
   *   若允许覆盖，第二次写回就会把「接管前」改成「接管后」——
   *   级联回退会回到错误的目标（本仓库最贵的一类缺陷：语义正确而实现反了）。
   */
  rememberBaseline(input: BaselineKey & { value: string }): Promise<void>;
}
