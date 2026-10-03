/**
 * 回滚编排（M6-2）—— docs/07 M6-2「回滚 API 与 UI（单条 / 按主体 / 按策略批量）」。
 *
 * | 形态 | 语义 |
 * |---|---|
 * | **单条** | 把策略指针切回历史版本（**仅切版本，不重算**）——已由 `PolicyStore.rollback` 提供 |
 * | **按主体** | 切版本 + 只对**一个主体**重新求值 |
 * | **按策略批量** | 切版本 + 对**该站点所有主体**分批重新求值 |
 *
 * ★ 本模块最重要的一条语义判断：**回滚 ≠ 把状态字段改回去**。
 *
 *   直觉做法是「把 `ag_user_policy_state.state` 从 granted 改回 at_risk」。
 *   但那是错的：状态字段是**过去某次求值的产物**，而中间可能已经发生了别的事
 *   （事实更新、绑定撤销、策略又改过一次）。直接改字段会得到一个
 *   **任何一次求值都不会产生的状态**——它看起来正常，却与现实不符。
 *
 *   正确做法：**切版本 + 重新求值**。回滚只是改变了「用哪一版策略算」，
 *   至于主体该处于什么状态，交给**同一套求值器**去算。
 *   这也是本模块**直接复用 `Patrol`** 的原因：求值、迁移（H1/H2）、
 *   动作计划、幂等键、事务边界全都只有一份实现。
 */

import type { Logger } from '../kernel/logger.ts';

import type { Patrol, PatrolReport, SubjectDirectory } from './patrol.ts';
import type { PolicyDocument } from '../policy/model.ts';

// ─────────────────────────── 类型 ───────────────────────────

export interface RollbackTarget {
  siteId: string;
  policyCode: string;
  /** 回滚到哪个历史版本 */
  targetVersion: number;
  /** 当前生效版本（用于审计与对比；缺省由实现读取） */
  fromVersion?: number;
}

export interface RollbackResult {
  siteId: string;
  policyCode: string;
  targetVersion: number;
  /** 实际处理的主体数 */
  subjectsProcessed: number;
  /** 发生状态迁移的主体数 */
  stateChanged: number;
  /** 实际执行的动作数 */
  actionsExecuted: number;
  /** 幂等命中数（重复回滚时为非零——说明回滚是幂等的） */
  idempotentHits: number;
  /** 单个主体的失败清单（**不中断整体**） */
  failures: { externalId: string; message: string }[];
  /** 策略求值异常（多为策略配置问题） */
  errors: { externalId: string; message: string }[];
  durationMs: number;
}

export interface RollbackDeps {
  /** 把策略指针切到历史版本（`PolicyStore.rollback`） */
  switchVersion: (siteId: string, code: string, version: number) => Promise<PolicyDocument>;
  /** 取当前生效内容（切版本后调用，用于重算） */
  currentPolicy: (siteId: string, code: string) => Promise<PolicyDocument | undefined>;
  /** 构造一轮巡检器（**复用全部求值/迁移/执行/幂等逻辑**） */
  buildPatrol: (input: { policies: readonly PolicyDocument[]; directory: SubjectDirectory; maxSubjects?: number }) => Patrol;
  /** 完整的主体目录（按策略批量回滚时用） */
  directory: SubjectDirectory;
  logger?: Logger;
  /** 批量回滚的每批主体数（默认 500）——分批是为了可观测与可中断 */
  batchSize?: number;
  /** 进度回调（长批量操作必须可观测） */
  onProgress?: (done: number, total: number) => void;
}

// ─────────────────────────── 目录包装 ───────────────────────────

/**
 * 把完整目录**收窄到单个主体**。
 *
 * ★ 为什么用包装而不是「新写一个单主体目录」：
 *   回滚必须走**与常规巡检完全相同**的路径（同样的字段读取、同样的批量语义），
 *   否则「单主体回滚」与「批量回滚里的同一主体」可能得到不同结果。
 */
export function makeSubjectScopedDirectory(directory: SubjectDirectory, externalId: string): SubjectDirectory {
  return {
    async list(_siteId, limit, offset) {
      if (offset > 0) return [];
      const all = await directory.list(_siteId, Number.MAX_SAFE_INTEGER, 0);
      const target = all.filter((subject) => subject.externalId === externalId).slice(0, limit);
      return target;
    },
    async count(siteId) {
      const all = await directory.list(siteId, Number.MAX_SAFE_INTEGER, 0);
      return all.some((subject) => subject.externalId === externalId) ? 1 : 0;
    },
  };
}

// ─────────────────────────── 汇总 ───────────────────────────

function summarize(input: RollbackTarget, report: PatrolReport, durationMs: number): RollbackResult {
  return {
    siteId: input.siteId,
    policyCode: input.policyCode,
    targetVersion: input.targetVersion,
    subjectsProcessed: report.subjects,
    stateChanged: report.stats.stateChanged,
    actionsExecuted: report.stats.actionsExecuted,
    idempotentHits: report.stats.idempotentHits,
    failures: report.outcomes
      .filter((outcome) => outcome.planOutcome?.status === 'failed')
      .map((outcome) => {
        const step = outcome.planOutcome?.steps.find((entry) => entry.status === 'failed');
        return {
          externalId: outcome.externalId,
          // ★ 失败原因有两个来源：`error`（抛异常）与 `reason`（handler 主动返回失败）。
          //   早期只读 `error`，于是「下游拒绝了这次动作」这类**主动失败**会丢掉具体原因，
          //   运维只看到笼统的「动作执行失败」——排障时最需要的信息恰好没了。
          message: step?.error ?? step?.reason ?? '动作执行失败',
        };
      }),
    errors: report.errors.map((error) => ({ externalId: error.externalId, message: error.message })),
    durationMs,
  };
}

// ─────────────────────────── 切版本 + 重算 ───────────────────────────

/** 切版本并取回内容（两种回滚形态共用的第一步）。 */
async function switchAndLoad(
  deps: RollbackDeps,
  input: RollbackTarget,
): Promise<{ policy: PolicyDocument; switched: boolean }> {
  const current = await deps.currentPolicy(input.siteId, input.policyCode);
  // ★ 已经是目标版本 → **不重复切**（幂等；重复回滚同一版本不应产生副作用）
  if (current !== undefined && current.version === input.targetVersion) {
    deps.logger?.info('策略已在目标版本，跳过切换（仅重算）', {
      policyCode: input.policyCode,
      version: input.targetVersion,
    });
    return { policy: current, switched: false };
  }
  const switched = await deps.switchVersion(input.siteId, input.policyCode, input.targetVersion);
  return { policy: switched, switched: true };
}

/**
 * **按主体**回滚：切版本 + 只对该主体重新求值。
 *
 * 适用场景：某个用户的资格被误改，需要单独把他拉回旧版本的判定结果。
 */
export async function rollbackForSubject(
  deps: RollbackDeps,
  input: RollbackTarget & { externalId: string },
): Promise<RollbackResult> {
  const startedAt = Date.now();
  const { policy } = await switchAndLoad(deps, input);
  const patrol = deps.buildPatrol({
    policies: [policy],
    directory: makeSubjectScopedDirectory(deps.directory, input.externalId),
    maxSubjects: 1,
  });
  const report = await patrol.runOnce();
  deps.onProgress?.(report.subjects, report.subjects);
  return summarize(input, report, Date.now() - startedAt);
}

/**
 * **按策略批量**回滚：切版本 + 对该站点所有主体分批重新求值。
 *
 * ★ 两处刻意的设计：
 *   1. **分批**（`batchSize`）而不是一个大事务：批量回滚可能涉及大量主体，
 *      单个大事务会长时间持锁并让回滚日志膨胀；分批还让进度**可观测、可中断**；
 *   2. **失败不中断整体**：某个主体的动作失败不应阻止其余主体回滚——
 *      失败清单在结果里逐条列出（`failures`），由运维决定是否重试。
 */
export async function rollbackByPolicy(deps: RollbackDeps, input: RollbackTarget): Promise<RollbackResult> {
  const startedAt = Date.now();
  const { policy } = await switchAndLoad(deps, input);
  const batchSize = deps.batchSize ?? 500;

  const aggregate: PatrolReport = {
    siteId: input.siteId,
    startedAt: new Date(startedAt),
    finishedAt: new Date(startedAt),
    policies: 1,
    subjects: 0,
    outcomes: [],
    stats: {
      satisfied: 0, unsatisfied: 0, indeterminate: 0, notApplicable: 0, error: 0,
      stateChanged: 0, actionsExecuted: 0, idempotentHits: 0, verifyFailed: 0,
    },
    errors: [],
  };

  // ★ 分批：每批独立跑一轮巡检（各批之间共享 states，因此状态迁移是累积的）
  let offset = 0;
  let done = 0;
  for (;;) {
    const page = await deps.directory.list(input.siteId, batchSize, offset);
    if (page.length === 0) break;
    const scoped: SubjectDirectory = {
      async list(_siteId, limit, innerOffset) {
        // 本批的切片（已在内存里，不再回查）
        void _siteId;
        void limit;
        void innerOffset;
        return page;
      },
      async count() {
        return page.length;
      },
    };
    const patrol = deps.buildPatrol({ policies: [policy], directory: scoped });
    const report = await patrol.runOnce();

    aggregate.subjects += report.subjects;
    aggregate.outcomes.push(...report.outcomes);
    aggregate.errors.push(...report.errors);
    for (const key of Object.keys(aggregate.stats) as (keyof PatrolReport['stats'])[]) {
      aggregate.stats[key] += report.stats[key];
    }
    done += page.length;
    deps.onProgress?.(done, done + (page.length === batchSize ? batchSize : 0));

    offset += page.length;
    if (page.length < batchSize) break;
  }
  aggregate.finishedAt = new Date();
  return summarize(input, aggregate, Date.now() - startedAt);
}

// ─────────────────────────── 回滚前的影响面预估 ───────────────────────────

/**
 * 回滚前的**影响面预估**（与 M2-8 的试算同一思路，但针对「切到旧版本」）。
 *
 * ★ 为什么回滚也要预估：回滚会**改分组 → 踢用户下线**。
 *   运维在按下按钮前必须知道「这次会动多少人」，
 *   而不是按完看日志才发现影响了一万用户。
 */
export interface RollbackPreview {
  targetVersion: number;
  /** 当前处于「新版本下获得权限」的主体数 */
  currentlyGranted: number;
  /** 回滚后预计会失去权限的主体数（供人工确认） */
  estimatedRevocations: number;
  /** 样本量（预估基于这些主体） */
  sampled: number;
  note: string;
}

export function describeRollbackPreview(input: { targetVersion: number; currentlyGranted: number; estimatedRevocations: number; sampled: number }): RollbackPreview {
  return {
    targetVersion: input.targetVersion,
    currentlyGranted: input.currentlyGranted,
    estimatedRevocations: input.estimatedRevocations,
    sampled: input.sampled,
    note:
      input.estimatedRevocations > 0
        ? `回滚到 v${input.targetVersion} 预计让 ${input.estimatedRevocations} 个主体失去权限（抽样 ${input.sampled} 个主体）。` +
          `失去权限会触发动作（可能改分组并踢下线），请确认后再执行。`
        : `回滚到 v${input.targetVersion} 预计不收回任何主体的权限（抽样 ${input.sampled} 个主体）。`,
  };
}
