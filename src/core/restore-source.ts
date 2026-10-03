/**
 * `RestoreSource` 的生产实现 —— 把「仍满足的策略要求哪一档」从**状态表 × 策略定义**里组装出来。
 *
 * ★ 为什么单独成文件：装配层（`tools/serve.ts`）与「级联回退的端到端验收」
 *   **必须用同一份实现**。本仓库吃过这个亏：测试手写等价装置 → 装置与实现不一致
 *   → 不变量在测试中静默失效（见 `reports/schema-doc-defects.md` 末尾的 `Db` 例子）。
 *
 * ★ 两个方向的标识符映射都由**装配层**注入，本模块不猜：
 *   · `policyIdOfCode`：策略 code → 状态表里的 `policy_id`（PG 下是 uuid，内存下就是 code）
 *   · `policyCodeOfId`：反方向（`baselineOf` 需要 code，因为状态存储按 code 键）
 */

import type { PolicyDocument } from '../policy/model.ts';
import { requiredGroupOf } from '../policy/required-group.ts';
import type { RestoreRequirement, RestoreSource } from './action-restore.ts';
import type { LifecycleStateStore } from './lifecycle-store-type.ts';

export interface RestoreSourceOptions {
  lifecycle: LifecycleStateStore;
  /** 该站点**已启用**的策略 */
  listPolicies: (siteId: string) => Promise<readonly PolicyDocument[]>;
  /** 策略 code → 状态表里的 `policy_id` */
  policyIdOfCode: (code: string) => Promise<string | undefined>;
  /** 状态表里的 `policy_id` → 策略 code */
  policyCodeOfId: (policyId: string) => Promise<string | undefined>;
  /** 动作规范形（由装配层注入——核心不得硬编码具体系统名，CI 第 7 项实扫） */
  actionKey: string;
}

export function createRestoreSource(options: RestoreSourceOptions): RestoreSource {
  return {
    async listActiveRequirements({ siteId, userId }): Promise<readonly RestoreRequirement[]> {
      const entries = await options.lifecycle.listByUser(siteId, userId);
      // ★ 只有 `granted` / `satisfied` 参与决胜：
      //   `at_risk` 已在宽限期内（其要求仍然成立，但它是否「仍满足」由状态机裁定，
      //   本函数只做搬运，不替状态机下结论——故只认这两个态）。
      const active = entries.filter((entry) => entry.state === 'granted' || entry.state === 'satisfied');
      if (active.length === 0) return [];

      const policies = await options.listPolicies(siteId);
      const byPolicyId = new Map<string, PolicyDocument>();
      for (const policy of policies) {
        const id = await options.policyIdOfCode(policy.code);
        if (id !== undefined) byPolicyId.set(id, policy);
        // 内存模式下状态表的 `policy_id` 就是 code —— 两条都登记，避免装配差异泄漏到判定里
        byPolicyId.set(policy.code, policy);
      }

      const requirements: RestoreRequirement[] = [];
      for (const entry of active) {
        const policy = byPolicyId.get(entry.policyId);
        // 策略已删除 / 未发布 → 不参与决胜（它会自然走到 baseline 分支）
        if (policy === undefined) continue;
        requirements.push({
          policyId: entry.policyId,
          policyCode: policy.code,
          // ★★ L-4 **已修**：`tier` 现在真的带进了 `PolicyDocument`
          //   （字段见 `src/policy/model.ts`；DB 转换处见 `src/db/adapters.ts` 的 `#toDocument`）。
          //   此前它在「行 → 文档」的转换里被丢掉，于是文档算法的**第一层**（tier 高者）
          //   从未生效——只用到了第二层（priority 小者）。
          tier: policy.tier ?? null,
          priority: policy.priority ?? 100,
          targetGroup: requiredGroupOf(policy.spec, options.actionKey),
        });
      }
      return requirements;
    },

    async baselineOf({ siteId, userId, policyId, actionKey }) {
      const code = await options.policyCodeOfId(policyId);
      if (code === undefined) return null;
      return options.lifecycle.baselineOf({ siteId, userId, policyCode: code, actionKey });
    },
  };
}
