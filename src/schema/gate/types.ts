/**
 * 门禁（`src/schema/gate/**`）的补充类型。
 *
 * 契约 §5.1 已冻结 `ScopeViolation`（见 `src/schema/ir.ts`），本文件只补门禁专有的
 * 「豁免清单条目」与「调用选项」，不改动 IR 结构。
 */

import type { ScopeViolation } from '../ir.ts';

export type { ScopeViolation };

/** R3 豁免清单的一条：**逐表理由必填**（空理由 = 未豁免）。 */
export interface PlatformExemption {
  /** 表名，如 'ag_users' */
  tableName: string;
  /** 逐表签署的豁免理由；`trim()` 后为空字符串 → 该表视为未豁免（R3 违规）。 */
  reason: string;
}

/**
 * `checkScopeRules` 接受的豁免清单形态：
 *  - 数组（权威形态，可携带完整理由，见 `exemptions.ts`）；
 *  - `{ 表名: 理由 }` 记录（便于测试与调用方覆写）。
 * 两种形态下，**理由为空/缺失都视为未豁免**。
 */
export type ExemptionInput =
  | readonly PlatformExemption[]
  | Readonly<Record<string, string>>;

/**
 * 门禁调用选项。**全部为诊断用途**，默认值 = 契约 §5.1 / 02 §1 的字面语义。
 */
export interface ScopeGateOptions {
  /**
   * `'strict'`（默认，字面契约）：R1 的「唯一键首列必须是 site_id」判据**无条件**适用于
   * 有 site_id 列的表，双作用域表也一样——故 `ag_plugin_instances` 的
   * `uq_ag_plugin_inst_dev`（首列 developer_id）在严格读法下是 R1 error。
   *
   * `'scope-aware'`（诊断读法）：把 R5 读成「双作用域表的作用域谓词整体由 CHECK 承载」，
   * 于是双作用域表跳过 R1 的唯一键首列判据（其 developer 级唯一键按定义不可能以 site_id 开头）。
   * 该读法用于量化文档歧义的影响面，**不是**默认行为。
   */
  dualScopeUniqueKeys?: 'strict' | 'scope-aware';
}
