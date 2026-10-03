/**
 * 「我的资格」求值编排（M1-10）—— 把四层串成一次可解释的判定。
 *
 * ```
 *   ① 事实（插件产出，带 TTL）──┐
 *   ② 用户/绑定（平台侧）      ──┼──▶ ③ 策略求值 ──▶ ④ 资格视图（用户可读）
 *   ③ 表达式引擎（三态）        ──┘                        └─▶ 结果树（可解释）
 * ```
 *
 * ★ 三条硬约束（都来自前面的设计决定，这里只是把它们组装起来）：
 *   1. **事实过期 = 缺失**：不返回陈旧值（否则用户看到的是「上次的结论」）。
 *   2. **缺失 → indeterminate**：编排层不得把它降级成 false（H1）。
 *   3. **求值必须可复现**：给定 (策略版本, 用户快照, 事实快照, now) 就必须得到同一结论——
 *      因此本函数只接受**已经取好的快照**，不在内部读数据库或时钟。
 */

import type { Logger } from '../kernel/logger.ts';
import type { FactPipeline, FactStore } from '../plugin/host-api.ts';
import { parseDuration } from '../plugin/host-api.ts';
import type { EvaluationContext } from './expr.ts';
import { evaluatePolicy, toEligibilityView, type EligibilityView, type PolicyEvaluation } from './evaluator.ts';
import type { PolicyDocument } from './model.ts';

/** 事实快照：一次求值用到的全部事实（键为完整表达式路径，如 `fact.email.domain`）。 */
export interface FactSnapshot {
  values: Readonly<Record<string, unknown>>;
  /** 每个事实的采集时间（用于展示新鲜度） */
  collectedAt?: Readonly<Record<string, Date>>;
}

export interface EligibilityInput {
  policies: readonly PolicyDocument[];
  user: Record<string, unknown>;
  bindings?: Record<string, Record<string, unknown>>;
  /**
   * ★★ **跨系统寻址的取值**（`subject:<provider>.<attr>`，`docs/04 §1.2.7.2`）。
   *
   * ★ 由调用方在**采集阶段**用 `collectSubjectSnapshot()` 解析好（见 `subject-snapshot.ts`）：
   *   本函数是**同步**的，而「查绑定 → 读下游主体属性」是异步的。
   * ★ 省略 = 本次评估不涉及 `subject:*`（或绑定基础设施未装配）——
   *   此时 `subject:*` 求值为 `undefined` → 交 `$onMissing` 决定（**不降级**，H1）。
   */
  subject?: Readonly<Record<string, unknown>>;
  /**
   * ★★ **身份域断言**（`identity:oidc@<ref>.<claim>`，`docs/04 §1.2.7.3`）：
   *   键是**完整地址**（与 `claimAddressOf` 的产出逐字一致），值为该 claim。
   *
   * ★ 省略 = 本次评估不涉及 `identity:*` → 求值为 `undefined` → 交 `$onMissing` 决定
   *   （**不降级**，H1：把"不知道这个用户在某 OIDC 下的 claim"当成 `false` 会误收回权限）。
   * ★ 只应包含**声明开放**的 claim（`docs/03`：其余 claim 既不落库也不可见）。
   */
  identity?: Readonly<Record<string, unknown>>;
  facts: FactSnapshot;
  /** 时间基准（**必须显式传入**，保证同一输入得到同一结论） */
  now: Date;
  /** 关键事实缺失时的处置（默认 fail_closed → indeterminate） */
  missingPolicy?: 'indeterminate' | 'false';
}

export interface PolicyEligibility {
  code: string;
  name?: string;
  version?: number;
  evaluation: PolicyEvaluation;
  view: EligibilityView;
}

export interface EligibilityReport {
  /** 各策略的判定（按优先级排序） */
  results: PolicyEligibility[];
  /** 综合进度：满足 / 总适用策略数（用户侧「我的资格」进度条） */
  progress: { satisfied: number; total: number };
  /** 需要用户去完成的事项（不可判定或未满足的叶子标签） */
  todos: string[];
  evaluatedAt: Date;
}

export class EligibilityError extends Error {
  override readonly name = 'EligibilityError';
}

/**
 * 求值「我的资格」。
 *
 * 策略按 `priority` 升序（数字小优先，与 `ag_policies` 的语义一致），
 * 未声明 priority 的排在最后并保持声明顺序（稳定排序）。
 */
export function evaluateEligibility(input: EligibilityInput, logger?: Logger): EligibilityReport {
  const context: EvaluationContext = {
    facts: (namespace, path) => input.facts.values[`fact.${namespace}.${path}`],
    // ★ P5 ②：把快照里的采集时间接进求值上下文——结果树的叶子因此能显示「这条依据是多久前采的」
    ...(input.facts.collectedAt === undefined
      ? {}
      : {
          factCollectedAt: (fullPath: string) => input.facts.collectedAt?.[fullPath],
        }),
    user: input.user,
    bindings: input.bindings ?? {},
    // ★★ P0-1：`subject:*` 的取值——采集阶段解析好，这里只做**同步**读取
    subject: input.subject ?? {},
    // ★★ `identity:*` 同构（`docs/04 §1.2.7.3`）：采集阶段预加载，求值时同步读取
    identity: input.identity ?? {},
    now: input.now,
    ...(input.missingPolicy === undefined ? {} : { missingPolicy: input.missingPolicy }),
  };

  const ordered = [...input.policies]
    .map((policy, index) => ({ policy, index, weight: policy.priority ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.weight === b.weight ? a.index - b.index : a.weight - b.weight))
    .map((entry) => entry.policy);

  const results: PolicyEligibility[] = [];
  for (const policy of ordered) {
    if (policy.enabled === false) continue;
    const evaluation = evaluatePolicy({ policy, context });
    results.push({
      code: policy.code,
      ...(policy.name === undefined ? {} : { name: policy.name }),
      ...(policy.version === undefined ? {} : { version: policy.version }),
      evaluation,
      view: toEligibilityView(evaluation),
    });
  }

  const applicable = results.filter((r) => r.evaluation.decision !== 'not_applicable');
  const satisfied = applicable.filter((r) => r.evaluation.decision === 'satisfied').length;
  const todos = [...new Set(applicable.flatMap((r) => (r.evaluation.decision === 'satisfied' ? [] : r.view.missingLabels.concat(r.view.items.filter((i) => i.state === 'false').map((i) => i.label)))))]

  logger?.info('资格求值完成', {
    policies: results.length,
    satisfied,
    applicable: applicable.length,
    todos: todos.length,
  });

  return {
    results,
    progress: { satisfied, total: applicable.length },
    todos,
    evaluatedAt: input.now,
  };
}

// ─────────────────────────── 事实快照收集 ───────────────────────────

/** 插件声明（用于建快照）：id + 需读取的字段 + TTL */
export interface PluginFactSource {
  pluginId: string;
  fields: readonly string[];
  /** 事实有效期（缺省 24h）；**过期即视为缺失** */
  ttl?: string;
}

export interface FactCollectionResult {
  snapshot: FactSnapshot;
  /** 因过期或未采集而缺失的字段（完整表达式路径） */
  missing: string[];
  /** 采集时间早于 now - ttl 而被判为过期的字段 */
  expired: string[];
}

/**
 * 从事实存储收集快照。
 *
 * ★ 过期事实**不进快照**（进入 `expired`）：把过期值当成有效值会让判定基于陈旧数据，
 *   在「渠道故障」场景下这正是 H1 想避免的——宁可判 indeterminate，也不要用旧数据下结论。
 */
export async function collectFactSnapshot(
  store: FactStore,
  sources: readonly PluginFactSource[],
  now: Date,
  /**
   * 主体 id（事实按主体存）—— **必填**。
   *
   * ★★★ R75：此前默认 `'platform'`，与 `FactPipeline` 是**同一个遗留假设**
   *   （「事实是全局的」，已被 `FactStore` 的说明明确否定）。
   *   ★ 而 `ag_plugin_facts.user_id` 是 NOT NULL uuid，字符串 `'platform'` 写不进去——
   *     默认值让「忘了传主体」变成**运行到真实 PG 才炸**。
   *   ★ 改成必填后，调用方必须回答「取谁的快照」。
   */
  userId: string,
  logger?: Logger,
): Promise<FactCollectionResult> {
  const values: Record<string, unknown> = {};
  const collectedAt: Record<string, Date> = {};
  const missing: string[] = [];
  const expired: string[] = [];

  for (const source of sources) {
    const ttlMs = parseDuration(source.ttl, 24 * 3_600_000);
    for (const field of source.fields) {
      const key = `fact.${source.pluginId}.${field}`;
      const record = await store.get(userId, source.pluginId, field);
      if (record === undefined) {
        missing.push(key);
        continue;
      }
      const age = now.getTime() - record.collectedAt.getTime();
      if (age > ttlMs) {
        expired.push(key);
        logger?.warn('事实已过期，按缺失处理（不使用陈旧值）', {
          key,
          ageMs: age,
          ttlMs,
          collectedAt: record.collectedAt.toISOString(),
        });
        continue;
      }
      values[key] = record.value;
      collectedAt[key] = record.collectedAt;
    }
  }

  return { snapshot: { values, collectedAt }, missing, expired };
}

/** 便捷：从某个 FactPipeline 收集该插件声明的所有事实。 */
export async function collectFromPipeline(
  pipeline: FactPipeline,
  pluginId: string,
  now: Date,
  userId = 'platform',
): Promise<FactCollectionResult> {
  const records = await (pipeline as unknown as { store?: FactStore }).store?.list(userId, pluginId);
  const values: Record<string, unknown> = {};
  const collectedAt: Record<string, Date> = {};
  const missing: string[] = [];
  const expired: string[] = [];
  for (const record of records ?? []) {
    const key = `fact.${pluginId}.${record.field}`;
    if (record.expiresAt.getTime() <= now.getTime()) {
      expired.push(key);
      continue;
    }
    values[key] = record.value;
    collectedAt[key] = record.collectedAt;
  }
  return { snapshot: { values, collectedAt }, missing, expired };
}
