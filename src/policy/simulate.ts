/**
 * 影响面试算（M2-8）—— 「这条策略若发布，会影响到谁」。
 *
 * ★ 本模块最重要的一条设计：**复用真实的 `transition` 函数**。
 *   若试算自己写一套「预测逻辑」，就会出现「试算说没事，发布后却收回了权限」——
 *   而权限收回会**踢用户下线**（约束 C）。试算的全部价值就在于
 *   「用同一套判定逻辑预演一遍」，因此它必须是**纯函数 + 同一个迁移实现**。
 *
 * ★ 第二重要的设计：把「**会导致权限收回**的主体单独列出」。
 *   发布一条策略最常见的灾难是「不小心让一批已授权用户掉权限」。
 *   因此 `atRiskSubjects` / `revokedSubjects` 是试算报告的一等公民，
 *   而不是埋在逐主体明细里让人自己找。
 */

import type { Logger } from '../kernel/logger.ts';

import { transition, type LifecyclePolicy, type LifecycleSnapshot } from '../core/lifecycle.ts';
import { evaluatePolicy, type PolicyDecision } from './evaluator.ts';
import type { PolicyDocument } from './model.ts';

/** 试算输入：一个主体在当前时刻的全部相关输入 */
export interface SimulateSubject {
  externalId: string;
  /** 该主体在各策略上的**当前**状态（缺省视为 unknown） */
  states?: Record<string, LifecycleSnapshot>;
  user: { email?: string | null; email_verified?: boolean; status?: string; tags?: readonly string[] };
  /** 事实值（`fact.<ns>.<path>` → 值） */
  facts: Record<string, unknown>;
}

export interface SimulateOptions {
  /** 候选策略（未发布的草稿也可以） */
  policies: readonly PolicyDocument[];
  subjects: readonly SimulateSubject[];
  lifecycle: LifecyclePolicy;
  /** 试算时间基准（影响宽限期计算） */
  now: Date;
  logger?: Logger;
}

/** 单个主体在单条策略上的试算结论 */
export interface SimulateSubjectResult {
  externalId: string;
  policyCode: string;
  decision: PolicyDecision;
  stateBefore: LifecycleSnapshot['state'];
  stateAfter: LifecycleSnapshot['state'];
  /** 是否发生状态迁移 */
  changed: boolean;
  /** 会产生的动作意图 */
  actionIntent: 'grant' | 'revoke' | 'none';
  /** 会执行的动作名（仅当 actionIntent != none） */
  actions: string[];
  missing: readonly string[];
}

export interface SimulateReport {
  now: string;
  policyCount: number;
  subjectCount: number;
  results: SimulateSubjectResult[];
  stats: {
    satisfied: number;
    unsatisfied: number;
    indeterminate: number;
    notApplicable: number;
    error: number;
    stateChanged: number;
    /** 会授予的主体数 */
    grants: number;
    /** 会收回的主体数 */
    revocations: number;
  };
  /**
   * ★ 高危影响：**会导致权限收回**的主体。
   *
   * 收回会踢用户下线，因此这是发布前必须人工确认的清单。
   */
  revocations: { externalId: string; policyCode: string; from: LifecycleSnapshot['state']; to: LifecycleSnapshot['state'] }[];
  /** 会进入 at_risk（宽限期内）的主体——它们**尚未**失去权限，但已进入观察期 */
  atRisk: { externalId: string; policyCode: string; graceUntil: string | null }[];
  /** 会新授予权限的主体 */
  grants: { externalId: string; policyCode: string; actions: string[] }[];
  /** 需要人工核对的配置问题（求值异常） */
  errors: { externalId: string; policyCode: string; message: string }[];
  /**
   * 影响面判定（供管理端直接给结论，而不是让用户自己解读数字）。
   */
  verdict: 'no_impact' | 'grants_only' | 'needs_review' | 'dangerous';
}

/**
 * 跑一次影响面试算（**纯函数**：不写库、不发动作、不改状态）。
 */
export function simulate(options: SimulateOptions): SimulateReport {
  const results: SimulateSubjectResult[] = [];
  const revocations: SimulateReport['revocations'] = [];
  const atRisk: SimulateReport['atRisk'] = [];
  const grants: SimulateReport['grants'] = [];
  const errors: SimulateReport['errors'] = [];
  const stats: SimulateReport['stats'] = {
    satisfied: 0,
    unsatisfied: 0,
    indeterminate: 0,
    notApplicable: 0,
    error: 0,
    stateChanged: 0,
    grants: 0,
    revocations: 0,
  };

  for (const subject of options.subjects) {
    for (const policy of options.policies) {
      const evaluation = evaluatePolicy({
        policy,
        context: {
          facts: (namespace, path) => subject.facts[`fact.${namespace}.${path}`],
          user: {
            email: subject.user.email ?? null,
            email_verified: subject.user.email_verified ?? false,
            status: subject.user.status ?? 'active',
            tags: subject.user.tags ?? [],
          },
          bindings: {},
          now: options.now,
        },
      });

      switch (evaluation.decision) {
        case 'satisfied': stats.satisfied += 1; break;
        case 'unsatisfied': stats.unsatisfied += 1; break;
        case 'indeterminate': stats.indeterminate += 1; break;
        case 'not_applicable': stats.notApplicable += 1; break;
        case 'error':
          stats.error += 1;
          errors.push({ externalId: subject.externalId, policyCode: policy.code, message: evaluation.error ?? '未知求值异常' });
          break;
      }

      const before: LifecycleSnapshot =
        subject.states?.[policy.code] ?? { state: 'unknown', stateChangedAt: options.now, atRiskCount: 0, actionSeq: 0 };

      // ★ 复用**真实**迁移函数：试算与线上走同一套判定
      const migration = transition(before, { kind: 'evaluated', decision: evaluation.decision, at: options.now }, options.lifecycle);
      if (migration.changed) stats.stateChanged += 1;

      const actions =
        migration.actionIntent === 'grant'
          ? (evaluation.actions ?? []).map((a) => a.action)
          : migration.actionIntent === 'revoke'
            ? (policy.spec.actions?.onUnsatisfied ?? []).map((a) => a.action)
            : [];

      results.push({
        externalId: subject.externalId,
        policyCode: policy.code,
        decision: evaluation.decision,
        stateBefore: before.state,
        stateAfter: migration.next.state,
        changed: migration.changed,
        actionIntent: migration.actionIntent,
        actions,
        missing: evaluation.missing,
      });

      // 高危影响归类
      const nowRevoked = migration.next.state === 'revoked';
      if (migration.actionIntent === 'revoke' && nowRevoked) {
        stats.revocations += 1;
        revocations.push({ externalId: subject.externalId, policyCode: policy.code, from: before.state, to: migration.next.state });
      } else if (migration.next.state === 'at_risk') {
        // ★ 只要**落点是 at_risk** 就列入观察期，而不是只记「从已授权掉下来」的：
        //   已经在 at_risk 的主体若宽限被不断顺延，它**一直在走向收回**——
        //   这正是最需要人工关注的状态（早期实现漏掉了这一类，试算会报「无影响」）。
        atRisk.push({
          externalId: subject.externalId,
          policyCode: policy.code,
          graceUntil: migration.next.graceUntil?.toISOString() ?? null,
        });
      }
      if (migration.actionIntent === 'grant') {
        stats.grants += 1;
        grants.push({ externalId: subject.externalId, policyCode: policy.code, actions });
      }
    }
  }

  // 影响面判定：把「需要人看」的情况直接给出结论
  let verdict: SimulateReport['verdict'];
  if (revocations.length > 0) verdict = 'dangerous';
  else if (atRisk.length > 0 || errors.length > 0) verdict = 'needs_review';
  else if (grants.length > 0) verdict = 'grants_only';
  else verdict = 'no_impact';

  options.logger?.info('影响面试算完成', {
    policies: options.policies.length,
    subjects: options.subjects.length,
    revocations: revocations.length,
    atRisk: atRisk.length,
    grants: grants.length,
    verdict,
  });

  return {
    now: options.now.toISOString(),
    policyCount: options.policies.length,
    subjectCount: options.subjects.length,
    results,
    stats,
    revocations,
    atRisk,
    grants,
    errors,
    verdict,
  };
}

/**
 * 比较两个版本的策略在同一批主体上的影响差异（**发布前对比**）。
 *
 * 用途：管理端「改这条策略前，先看看会多影响谁」。
 */
export function compareVersions(options: {
  current: PolicyDocument;
  candidate: PolicyDocument;
  subjects: readonly SimulateSubject[];
  lifecycle: LifecyclePolicy;
  now: Date;
}): {
  current: SimulateReport;
  candidate: SimulateReport;
  /** 结论发生变化的 (主体, 策略) 组合 */
  diffs: { externalId: string; policyCode: string; from: PolicyDecision; to: PolicyDecision }[];
  /** 候选版本新增的收回（这是最需要警惕的） */
  newRevocations: SimulateReport['revocations'];
} {
  const current = simulate({ policies: [options.current], subjects: options.subjects, lifecycle: options.lifecycle, now: options.now });
  const candidate = simulate({ policies: [options.candidate], subjects: options.subjects, lifecycle: options.lifecycle, now: options.now });

  const currentByKey = new Map(current.results.map((r) => [`${r.externalId}\u0000${r.policyCode}`, r]));
  const diffs: { externalId: string; policyCode: string; from: PolicyDecision; to: PolicyDecision }[] = [];
  for (const result of candidate.results) {
    const previous = currentByKey.get(`${result.externalId}\u0000${result.policyCode}`);
    if (previous !== undefined && previous.decision !== result.decision) {
      diffs.push({ externalId: result.externalId, policyCode: result.policyCode, from: previous.decision, to: result.decision });
    }
  }

  // 候选版本**新增**的收回（当前版本没有收回，候选版本有）
  const currentRevoked = new Set(current.revocations.map((r) => `${r.externalId}\u0000${r.policyCode}`));
  const newRevocations = candidate.revocations.filter((r) => !currentRevoked.has(`${r.externalId}\u0000${r.policyCode}`));

  return { current, candidate, diffs, newRevocations };
}
