/**
 * 通用对账器（M1-2）—— docs/05 §4。
 *
 * **为什么必须通用**：对账逻辑若内嵌某个下游系统的分页细节，核心就再次耦合到具体系统
 * （D6）。因此对账器只调 provider 的 `listSubjects`，自己不做任何系统相关的假设：
 *   - 分页细节由 provider 翻译；
 *   - 「有没有真增量」由 `capabilities.cursor` + 实测 `nextCursor` 决定；
 *   - 属性变化的判定由 `subjectSchema` 里 `watch: true` 的字段决定。
 *
 * 三条路径（docs/05 §4.2）：
 *   | 路径 | 条件 | 行为 |
 *   |---|---|---|
 *   | 增量（真） | `capabilities.cursor` 且返回了 `nextCursor` | 用 `nextCursor` 拉取变更 |
 *   | 增量（降级） | 无游标 | 拉首页（下游按主键倒序），**遇到已知 id 即停** |
 *   | 全量 | 周期性 | 分页遍历全部主体，本轮未出现者标记 `deleted` |
 *
 * ★ 降级路径是**常态**（并非所有 REST 系统都支持 `since` 过滤）；
 *   真增量是优化而非前提——这样任何 REST 系统都能接入。
 */

import type { Logger } from '../kernel/logger.ts';
import type { EventBus } from '../kernel/events.ts';
import { currentTraceId } from '../kernel/logger.ts';
import type { ExternalSubject, ProviderPlugin } from '../plugin/provider.ts';
import { probeProvider, subjectFingerprint, watchedFields } from '../plugin/provider.ts';
import type { SubjectStore, UpsertResult } from '../plugin/subjects.ts';

// ─────────────────────────── 同步状态 ───────────────────────────

export interface SyncState {
  provider: string;
  cursor: string | null;
  /** 降级路径用：已见的最大主键（下游按主键倒序时，遇到它就停） */
  lastSeenKey: string | null;
  lastIncrementalAt?: Date;
  lastFullSyncAt?: Date;
  lastFullSyncCount: number;
  lastError?: string;
  /** 声明 vs 实测的能力（docs/05 §4.4） */
  capabilities?: Record<string, unknown>;
}

export interface SyncStateStore {
  get(provider: string): Promise<SyncState | undefined>;
  save(state: SyncState): Promise<void>;
}

export class InMemorySyncStateStore implements SyncStateStore {
  private readonly states = new Map<string, SyncState>();
  async get(provider: string): Promise<SyncState | undefined> {
    return this.states.get(provider);
  }
  async save(state: SyncState): Promise<void> {
    this.states.set(state.provider, { ...state });
  }
}

// ─────────────────────────── 对账结果 ───────────────────────────

export interface ReconcileOutcome {
  provider: string;
  mode: 'incremental' | 'incremental-degraded' | 'full';
  /** 实际扫描的主体数 */
  scanned: number;
  created: number;
  changed: number;
  unchanged: number;
  revived: number;
  /** 全量模式下被标记 deleted 的数量（增量模式下恒为 0） */
  markedDeleted: number;
  /** 是否因为降级路径「遇到已知 id 即停」而提前结束 */
  stoppedEarly: boolean;
  /** 探测到的能力不一致（非空必须告警） */
  capabilityMismatches: string[];
  cursor: string | null;
  durationMs: number;
}

export interface ReconcilerOptions {
  provider: ProviderPlugin;
  subjects: SubjectStore;
  state: SyncStateStore;
  bus?: EventBus;
  logger?: Logger;
  /** 每页条数（provider 可自行截断为更小值） */
  pageSize?: number;
  /** 单轮最大页数（防御：避免下游游标异常导致无限翻页） */
  maxPages?: number;
  /** 是否在本轮做能力探测（默认每轮一次，符合 docs/05 §4.4） */
  probeCapabilities?: boolean;
  /** 注入时间基准（测试用） */
  now?: () => Date;
  /**
   * ★ 事务边界。
   *
   * 为什么对账器必须自己持有事务：`DbSubjectStore` 的每个方法都要求「在事务内」
   * （M0-11a 单一事务入口）。若对账器在每个 upsert 处各自开事务：
   *   ① 一轮对账产生 N 个事务 → 中途失败会留下**半对账状态**（部分主体已更新、游标未推进）；
   *   ② 站点注入的「单一入口」约定被架空。
   * 因此对账器把**整轮**包在一个事务里：要么全成、要么全败（游标也不会推进）。
   *
   * 不传则说明存储自带事务语义（如内存实现），此时不额外开启。
   */
  transactionRunner?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** 领域事件名（docs/05 §4.3，系统无关） */
export const SUBJECT_EVENTS = {
  created: 'subject.created',
  attributesChanged: 'subject.attributes_changed',
  deleted: 'subject.deleted',
} as const;

export class Reconciler {
  private readonly provider: ProviderPlugin;
  private readonly subjects: SubjectStore;
  private readonly state: SyncStateStore;
  private readonly bus: EventBus | undefined;
  private readonly logger: Logger | undefined;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly probe: boolean;
  private readonly now: () => Date;
  private readonly transactionRunner: (<T>(fn: () => Promise<T>) => Promise<T>) | undefined;

  constructor(options: ReconcilerOptions) {
    this.transactionRunner = options.transactionRunner;
    this.provider = options.provider;
    this.subjects = options.subjects;
    this.state = options.state;
    this.bus = options.bus;
    this.logger = options.logger;
    this.pageSize = options.pageSize ?? 200;
    this.maxPages = options.maxPages ?? 10_000;
    this.probe = options.probeCapabilities ?? true;
    this.now = options.now ?? (() => new Date());
  }

  private get watch(): string[] {
    return watchedFields(this.provider.subjectSchema);
  }

  /**
   * 能力探测 + 不一致告警（docs/05 §4.4：**启动时与每个全量周期执行**）。
   *
   * 抽成方法的原因：增量与全量两条路径都要探测，早期只在增量里做了，
   * 结果「全量对账不告警能力不一致」——而全量正是最需要发现接口变化的路径。
   * 探测本身失败也必须可见（记 'probe-failed'），不得静默当成一致。
   */
  private async probeCapabilities(): Promise<string[]> {
    if (!this.probe) return [];
    try {
      const mismatches = (await probeProvider(this.provider)).mismatches;
      if (mismatches.length > 0) {
        this.logger?.warn('provider 声明能力与实测不一致（必须核查，不得静默降级）', {
          provider: this.provider.id,
          mismatches,
        });
      }
      return mismatches;
    } catch (error) {
      this.logger?.warn('provider 能力探测失败（无法核对声明与实测）', {
        provider: this.provider.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return ['probe-failed'];
    }
  }

  /** 处理一个主体：算指纹 → upsert → 按结果发事件。返回 upsert 结论。 */
  private async handleSubject(subject: ExternalSubject, now: Date): Promise<UpsertResult> {
    const watch = this.watch;
    const fingerprint = subjectFingerprint(this.provider.id, subject, watch);
    const result = await this.subjects.upsert(this.provider.id, subject, watch, fingerprint, now);

    if (result.created) {
      await this.emit(SUBJECT_EVENTS.created, { provider: this.provider.id, externalId: subject.externalId });
    } else if (result.revived) {
      // 复活 = 等价于「新出现」：下游收回过的资格应重新评估
      await this.emit(SUBJECT_EVENTS.created, { provider: this.provider.id, externalId: subject.externalId });
    } else if (result.changed) {
      await this.emit(SUBJECT_EVENTS.attributesChanged, {
        provider: this.provider.id,
        externalId: subject.externalId,
        changedKeys: result.changedKeys,
      });
    }
    return result;
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    if (this.bus === undefined) return;
    const traceId = currentTraceId();
    // 事件总线在订阅者失败时抛 AggregateError；对账不应因下游订阅者失败而中断整轮
    await this.bus.emitSafely({
      type,
      payload,
      occurredAt: this.now(),
      ...(traceId === undefined ? {} : { traceId }),
    });
  }

  /**
   * 增量对账。
   *
   * 真增量：从 `state.cursor` 继续，直到 `nextCursor === null`。
   * 降级：拉首页，**遇到已知 id 即停**（下游按主键倒序是契约）。
   */
  async reconcileIncremental(): Promise<ReconcileOutcome> {
    if (this.transactionRunner !== undefined) {
      return this.transactionRunner(() => this.#reconcileIncremental());
    }
    return this.#reconcileIncremental();
  }

  async #reconcileIncremental(): Promise<ReconcileOutcome> {
    const startedAt = Date.now();
    const now = this.now();
    const providerId = this.provider.id;
    const previous = (await this.state.get(providerId)) ?? {
      provider: providerId,
      cursor: null,
      lastSeenKey: null,
      lastFullSyncCount: 0,
    };

    const capabilityMismatches = await this.probeCapabilities();

    const useCursor = this.provider.capabilities.cursor;
    const counts = { created: 0, changed: 0, unchanged: 0, revived: 0 };
    let scanned = 0;
    let stoppedEarly = false;
    let cursor: string | null = useCursor ? previous.cursor : null;
    let lastSeenKey = previous.lastSeenKey;
    let pages = 0;

    while (pages < this.maxPages) {
      pages += 1;
      const page = await this.provider.listSubjects(cursor, this.pageSize);
      if (page.subjects.length === 0) break;

      let hitKnown = false;
      for (const subject of page.subjects) {
        scanned += 1;
        if (!useCursor) {
          // 降级路径：首页遇到已知 id 即停（下游按主键倒序）
          const known = await this.subjects.get(providerId, subject.externalId);
          if (known !== undefined && known.deletedAt === undefined) {
            hitKnown = true;
            break;
          }
        }
        const result = await this.handleSubject(subject, now);
        if (result.created) counts.created += 1;
        else if (result.revived) counts.revived += 1;
        else if (result.changed) counts.changed += 1;
        else counts.unchanged += 1;
        lastSeenKey = subject.externalId;
      }

      cursor = page.nextCursor;
      if (!useCursor && (hitKnown || page.subjects.length < this.pageSize)) {
        stoppedEarly = hitKnown;
        break;
      }
      if (cursor === null) break;
    }

    await this.state.save({
      ...previous,
      cursor: useCursor ? cursor : previous.cursor,
      lastSeenKey,
      lastIncrementalAt: now,
    });

    const outcome: ReconcileOutcome = {
      provider: providerId,
      mode: useCursor ? 'incremental' : 'incremental-degraded',
      scanned,
      markedDeleted: 0,
      stoppedEarly,
      capabilityMismatches,
      cursor: useCursor ? cursor : null,
      durationMs: Date.now() - startedAt,
      ...counts,
    };
    this.logger?.info('增量对账完成', { ...outcome });
    return outcome;
  }

  /**
   * 全量对账：分页遍历全部主体，**本轮未出现者标记 deleted**（软删除）。
   *
   * 注意：软删除而非物理删除——`ag_external_subjects` 的 `deleted_at` 是逻辑删除标记，
   * 历史评估记录仍要能引用到它。
   */
  async reconcileFull(): Promise<ReconcileOutcome> {
    if (this.transactionRunner !== undefined) {
      return this.transactionRunner(() => this.#reconcileFull());
    }
    return this.#reconcileFull();
  }

  async #reconcileFull(): Promise<ReconcileOutcome> {
    const startedAt = Date.now();
    const now = this.now();
    const providerId = this.provider.id;
    const previous = (await this.state.get(providerId)) ?? {
      provider: providerId,
      cursor: null,
      lastSeenKey: null,
      lastFullSyncCount: 0,
    };

    const capabilityMismatches = await this.probeCapabilities();
    const counts = { created: 0, changed: 0, unchanged: 0, revived: 0 };
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let scanned = 0;

    while (pages < this.maxPages) {
      pages += 1;
      const page = await this.provider.listSubjects(cursor, this.pageSize);
      if (page.subjects.length === 0) break;
      for (const subject of page.subjects) {
        scanned += 1;
        seen.push(subject.externalId);
        const result = await this.handleSubject(subject, now);
        if (result.created) counts.created += 1;
        else if (result.revived) counts.revived += 1;
        else if (result.changed) counts.changed += 1;
        else counts.unchanged += 1;
      }
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    const deletedIds = await this.subjects.markDeleted(providerId, seen, now);
    // ★ 逐个发事件：下游据此把平台用户转 blocked / 停止动作（docs/05 §4.3）
    for (const externalId of deletedIds) {
      await this.emit(SUBJECT_EVENTS.deleted, { provider: providerId, externalId });
    }
    const markedDeleted = deletedIds.length;

    await this.state.save({
      ...previous,
      // ★ 全量成功后清空游标：下一轮增量从「当前」重新开始，避免用陈旧游标跳过数据
      cursor: null,
      lastFullSyncAt: now,
      lastFullSyncCount: seen.length,
    });

    const outcome: ReconcileOutcome = {
      provider: providerId,
      mode: 'full',
      scanned,
      markedDeleted,
      stoppedEarly: false,
      capabilityMismatches,
      cursor: null,
      durationMs: Date.now() - startedAt,
      ...counts,
    };
    this.logger?.info('全量对账完成', { ...outcome });
    return outcome;
  }

  /**
   * 首次运行判定：**没有全量成功过 → 必须走全量**。
   *
   * 为什么不能靠「增量遇到已知 id 就停」来替代首次全量：
   *   降级路径的「已知 id」在首次运行时一个都没有，于是它会一直翻页——
   *   行为上等价于全量，却**不会标记删除**（漏掉「下游已删但平台还不知道」的主体）。
   */
  async reconcile(): Promise<ReconcileOutcome> {
    const state = await this.state.get(this.provider.id);
    if (state?.lastFullSyncAt === undefined) return this.reconcileFull();
    return this.reconcileIncremental();
  }
}
