/**
 * 策略版本清理的**编排**（`docs/05 §2.1.4` 第 3 条要求）。
 *
 * > **清理任务必须跳过**：`keepVersions` 清理时**跳过**仍被
 * > `state IN ('granted','satisfied')` 引用到的版本（否则状态指向被删版本 = 悬空引用）。
 *
 * ★★ 一处必须说清的语义（否则清理会删错东西）：
 *   `ag_user_policy_state` 引用的是 **`policy_id`（策略）**，而不是版本 id；
 *   真正把「状态」与「某个具体版本」连起来的是 **`ag_policies.active_version_id`**。
 *   因此「被 granted/satisfied 引用的版本」应当实现为：
 *   **凡是有 `granted` / `satisfied` 状态的策略，其 `active_version_id` 必须保留**。
 *   只按「最新 N 个」清理而不保护它，就会删掉一个**正在生效的**版本——
 *   而状态表指向被删版本，等于**永久授权无法复现**（正是 §2.1.4 要防的）。
 *
 * ★ 本模块只做**编排**（取值 → 判定 → 删除），判定本身在 `src/core/retention.ts`
 *   的 `planVersionPurge`（纯函数，已单测）。这样「删哪些」是可穷举的，
 *   而「从哪读、往哪删」由装配层注入。
 */

import { planVersionPurge, type VersionRef } from './retention.ts';

export interface VersionPurgeDeps {
  /** 列出全部策略版本 */
  listVersions(): Promise<readonly VersionRef[]>;
  /**
   * 列出**必须保留**的版本 id —— 即「有 `granted`/`satisfied` 状态的策略」的
   * `active_version_id`（见文件头的语义说明）。
   */
  listProtectedVersionIds(): Promise<ReadonlySet<string>>;
  /** 物理删除（调用方已保证传入的 id 是待删的） */
  deleteVersions(ids: readonly string[]): Promise<void>;
  /** `keepVersions`（每个策略保留的最新版本个数） */
  keep: number;
}

export interface PurgeReport {
  /** 实际删除的版本 id */
  purged: readonly string[];
  /** 因「仍被引用」而**幸免**的版本 id（★ 这是本任务最值得观测的数字） */
  skippedProtected: readonly string[];
  /** 清理后剩余的版本数 */
  remaining: number;
}

export async function purgePolicyVersions(deps: VersionPurgeDeps): Promise<PurgeReport> {
  const versions = await deps.listVersions();
  const protectedIds = await deps.listProtectedVersionIds();

  const purged = planVersionPurge({
    versions,
    keep: deps.keep,
    referencedVersionIds: protectedIds,
  });

  // ★ 统计「本来会被删、但因被引用而幸免」的——若这个数字长期 > 0，
  //   说明有大量长期存活的授权（正是 §2.1.4 关心的那类），值得在运维面板上看见。
  const wouldPurge = planVersionPurge({
    versions,
    keep: deps.keep,
    referencedVersionIds: new Set<string>(),
  });
  const skippedProtected = wouldPurge.filter((id) => protectedIds.has(id));

  if (purged.length > 0) {
    await deps.deleteVersions(purged);
  }

  return {
    purged,
    skippedProtected,
    remaining: versions.length - purged.length,
  };
}
