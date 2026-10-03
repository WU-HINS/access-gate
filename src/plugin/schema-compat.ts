/**
 * 插件升级的**向后兼容检查**（`docs/10 M6` 修正）。
 *
 * ★★ 它修的是什么（文档原话）：
 * > 插件 v2 删除了 `total_stars`，而线上 5 条策略引用了它。
 * > **修正：升级时做向后兼容检查**
 * > ```
 * > factSchema 对比：
 * >   · 删除字段 → 扫描引用该字段的已发布策略
 * >        ├─ 有引用 → 【阻止升级】并列出策略 code
 * >        └─ 无引用 → 允许，UI 警示
 * >   · 修改类型 → 同样检查（求值语义可能变化）
 * >   · 新增字段 → 允许
 * > ```
 *
 * ★★ 为什么**发布侧的正向校验挡不住它**（这是本条存在的全部理由）：
 *   那些策略**在插件升级之前就已经发布了**——升级时它们不会被重新校验。
 *   于是：插件删掉 `total_stars` 后，已发布策略仍引用它 →
 *   运行期表现为「**永远差这一项**」→ 按 H1 保持 `indeterminate`（不降级，这是对的）→
 *   ★ **但没有人被告知「为什么」**（策略看起来是好的，事实看起来是缺的）。
 *
 * ★ 本文件补的是**反向索引**：从「字段」查到「谁在用它」。
 *   正向（发布时）从「策略」查「字段存不存在」——两者方向相反，缺一不可。
 */

import type { JsonSchemaSubset } from './manifest.ts';
import { collectFactRefs, type PolicySpec } from '../policy/model.ts';

export interface FactFieldChange {
  field: string;
  kind: 'removed' | 'type_changed' | 'added';
  /** 变更前的类型（`removed` / `type_changed` 时有值） */
  from?: string;
  /** 变更后的类型（`type_changed` / `added` 时有值） */
  to?: string;
}

type SchemaProperties = Record<string, { type?: string } | undefined>;

/**
 * 对比两个版本的 `factSchema`（**纯函数**）。
 *
 * ★ 只比较**字段名与类型**：`title` / `description` 之类的展示属性变化不影响求值语义，
 *   把它们算成"变更"会让每次改文案都触发一次兼容性审查（噪音）。
 */
export function diffFactSchema(input: {
  oldSchema: JsonSchemaSubset;
  newSchema: JsonSchemaSubset;
}): FactFieldChange[] {
  const oldProps = (input.oldSchema.properties ?? {}) as SchemaProperties;
  const newProps = (input.newSchema.properties ?? {}) as SchemaProperties;
  const changes: FactFieldChange[] = [];

  for (const [field, oldDef] of Object.entries(oldProps)) {
    const newDef = newProps[field];
    if (newDef === undefined) {
      changes.push({
        field,
        kind: 'removed',
        ...(oldDef?.type === undefined ? {} : { from: oldDef.type }),
      });
      continue;
    }
    if (oldDef?.type !== newDef.type) {
      changes.push({
        field,
        kind: 'type_changed',
        ...(oldDef?.type === undefined ? {} : { from: oldDef.type }),
        ...(newDef.type === undefined ? {} : { to: newDef.type }),
      });
    }
  }

  for (const [field, newDef] of Object.entries(newProps)) {
    if (oldProps[field] === undefined) {
      changes.push({
        field,
        kind: 'added',
        ...(newDef?.type === undefined ? {} : { to: newDef.type }),
      });
    }
  }

  return changes;
}

/**
 * **反向索引**：某条策略引用了该命名空间下的哪些事实路径。
 *
 * ★ 复用 `collectFactRefs`（它递归遍历表达式树，并跳过 `$label` 等保留属性），
 *   因此策略用的是「单一事实来源」的那套解析——不会出现两套口径。
 */
export function factPathsOfNamespace(input: {
  spec: PolicySpec;
  namespace: string;
}): string[] {
  const prefix = `fact.${input.namespace}.`;
  return [...collectFactRefs(input.spec)].filter((path) => path.startsWith(prefix)).sort();
}

export interface ReferencingPolicy {
  code: string;
  spec: PolicySpec;
}

export interface UpgradeCheckInput {
  /** 该插件声明的事实命名空间（★ 可能 ≠ 插件 id：enricher 可自定义 `produces.namespace`） */
  namespace: string;
  oldSchema: JsonSchemaSubset;
  newSchema: JsonSchemaSubset;
  /** **已发布**的策略（草稿不参与——它们还没生效，可以改） */
  policies: readonly ReferencingPolicy[];
}

export type UpgradeDecision =
  | {
      allowed: true;
      changes: readonly FactFieldChange[];
      /** 允许升级但需要 UI 警示的说明（如"删除了 2 个无人引用的字段"） */
      warnings: readonly string[];
    }
  | {
      allowed: false;
      changes: readonly FactFieldChange[];
      /** 阻止升级的具体原因：哪些策略的哪个字段会失效 */
      blocking: readonly { code: string; field: string }[];
    };

export function checkUpgradeCompatibility(input: UpgradeCheckInput): UpgradeDecision {
  const changes = diffFactSchema({ oldSchema: input.oldSchema, newSchema: input.newSchema });
  const breaking = changes.filter(
    (change) => change.kind === 'removed' || change.kind === 'type_changed',
  );

  // 反向索引：字段 → 引用它的策略
  const blocking: { code: string; field: string }[] = [];
  for (const change of breaking) {
    const fullPath = `fact.${input.namespace}.${change.field}`;
    for (const policy of input.policies) {
      if (factPathsOfNamespace({ spec: policy.spec, namespace: input.namespace }).includes(fullPath)) {
        blocking.push({ code: policy.code, field: change.field });
      }
    }
  }

  if (blocking.length > 0) {
    return { allowed: false, changes, blocking };
  }

  const warnings: string[] = [];
  const removed = breaking.filter((change) => change.kind === 'removed');
  const retyped = breaking.filter((change) => change.kind === 'type_changed');
  if (removed.length > 0) {
    warnings.push(
      `删除了 ${removed.length} 个字段（${removed.map((c) => c.field).join(', ')}）——` +
        '当前无已发布策略引用，但**已归档/草稿策略**可能仍在用，UI 应提示',
    );
  }
  if (retyped.length > 0) {
    warnings.push(
      `修改了 ${retyped.length} 个字段的类型（${retyped
        .map((c) => `${c.field}: ${c.from ?? '?'} → ${c.to ?? '?'}`)
        .join(', ')}）——同样无引用，但求值语义可能变化`,
    );
  }

  return { allowed: true, changes, warnings };
}

export interface PluginUpgradeInput {
  /** 旧版本记录（**首次安装**时为 `undefined`） */
  previous: { namespace: string; manifest: { factSchema?: JsonSchemaSubset } } | undefined;
  /** 新版本 manifest */
  next: { id: string; factSchema?: JsonSchemaSubset };
  /** 已发布策略（装配层从策略存储取） */
  policies: readonly ReferencingPolicy[];
}

/**
 * 升级前的**一站式检查**：`null` = 允许升级；字符串 = 拒绝原因（可直接回给管理端）。
 *
 * ★ 首次安装直接放行（没有旧版本可比较）。
 * ★ 任一侧未声明 `factSchema` 时放行——这是**已知盲区**（无法比较），
 *   而不是"检查通过"。装配层若要更严，应先要求插件必须声明 `factSchema`。
 */
export function checkPluginUpgrade(input: PluginUpgradeInput): string | null {
  if (input.previous === undefined) return null;
  const oldSchema = input.previous.manifest.factSchema;
  const newSchema = input.next.factSchema;
  if (oldSchema === undefined || newSchema === undefined) return null;

  const decision = checkUpgradeCompatibility({
    // ★ 按 **namespace** 匹配（可能 ≠ 插件 id：enricher 可自定义 `produces.namespace`）
    namespace: input.previous.namespace,
    oldSchema,
    newSchema,
    policies: input.policies,
  });
  return describeUpgradeRejection(decision);
}

/** 人类可读的拒绝原因（直接用于管理端提示与测试断言）。 */
export function describeUpgradeRejection(decision: UpgradeDecision): string | null {
  if (decision.allowed) return null;
  const lines = decision.blocking.map((entry) => `策略 '${entry.code}' 引用了字段 '${entry.field}'`);
  return (
    `拒绝升级：新版本删除了/修改了仍被**已发布**策略引用的字段——\n` +
    lines.map((line) => `  · ${line}`).join('\n') +
    '\n（发布侧的正向校验挡不住这个场景：这些策略在升级前就已发布。' +
    '请先修改这些策略，或让新版本保留该字段。）'
  );
}
