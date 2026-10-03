/**
 * provider 契约 + 通用对账器验收（M1-1 / M1-2）。
 *
 * 断言重点（对应 docs/05 §4）：
 *   - 指纹**只**由 `watch: true` 的字段决定（噪声字段变化不得触发下游）；
 *   - 三条路径各自成立：真增量 / 降级（遇已知 id 即停）/ 全量（未出现者标 deleted）；
 *   - **首次运行必须走全量**（否则漏掉「下游已删」的主体）；
 *   - 能力声明与实测不一致**必须告警**，不得静默降级。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fnv1a64,
  probeProvider,
  subjectFingerprint,
  watchedFields,
  type ExternalSubject,
  type ProviderCapabilities,
  type ProviderPlugin,
  type SubjectPage,
  type SubjectSchema,
} from '../src/plugin/provider.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemorySyncStateStore, Reconciler, SUBJECT_EVENTS } from '../src/core/reconciler.ts';
import { EventBus, type DomainEvent } from '../src/kernel/events.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

// ─────────────────────────── 测试用 provider ───────────────────────────

const SCHEMA: SubjectSchema = {
  type: 'object',
  properties: {
    group: { type: 'string', watch: true },
    status: { type: 'integer', watch: true },
    request_count: { type: 'integer', watch: false },
    last_login: { type: 'string', watch: false },
  },
  required: ['group'],
};

function makeSubject(id: string, group: string, extra: Record<string, unknown> = {}): ExternalSubject {
  return {
    externalId: id,
    displayName: `user-${id}`,
    email: `${id}@example.com`,
    attributes: { group, status: 1, request_count: 0, last_login: '2025-01-01', ...extra },
  };
}

interface FakeProviderOptions {
  subjects: ExternalSubject[];
  capabilities?: Partial<ProviderCapabilities>;
  /** 每页条数 */
  pageSize?: number;
  /** 是否支持真游标（nextCursor） */
  withCursor?: boolean;
}

function makeProvider(options: FakeProviderOptions): ProviderPlugin & { setSubjects(s: ExternalSubject[]): void } {
  let subjects = [...options.subjects];
  const pageSize = options.pageSize ?? 100;
  const capabilities: ProviderCapabilities = {
    list: true,
    findByIdentity: false,
    get: true,
    cursor: options.withCursor ?? false,
    update: false,
    create: false,
    ...options.capabilities,
  };

  return {
    id: 'fakeprovider',
    subjectSchema: SCHEMA,
    capabilities,
    setSubjects(next: ExternalSubject[]) {
      subjects = [...next];
    },
    async listSubjects(cursor: string | null, limit: number): Promise<SubjectPage> {
      const size = Math.min(limit, pageSize);
      const offset = cursor === null ? 0 : Number(cursor);
      const slice = subjects.slice(offset, offset + size);
      const nextOffset = offset + size;
      return {
        subjects: slice,
        nextCursor: nextOffset < subjects.length ? String(nextOffset) : null,
      };
    },
    async getSubject(externalId: string): Promise<ExternalSubject | null> {
      return subjects.find((s) => s.externalId === externalId) ?? null;
    },
  };
}

function collectEvents(bus: EventBus): DomainEvent[] {
  const events: DomainEvent[] = [];
  bus.on('subject.*', (event) => void events.push(event));
  return events;
}

// ─────────────────────────── 指纹 ───────────────────────────

test('watchedFields：只取 watch:true 的字段，且顺序稳定（排序）', () => {
  assert.deepEqual(watchedFields(SCHEMA), ['group', 'status']);
});

test('指纹：只由 watch 字段决定——噪声字段（request_count/last_login）变化不改变指纹', () => {
  const a = makeSubject('1', 'basic');
  const b = makeSubject('1', 'basic', { request_count: 999, last_login: '2026-01-01' });
  const watch = watchedFields(SCHEMA);
  assert.equal(subjectFingerprint('p', a, watch), subjectFingerprint('p', b, watch));
});

test('指纹：watch 字段变化即变化；不同 provider 前缀不同；键顺序无关', () => {
  const watch = watchedFields(SCHEMA);
  const base = makeSubject('1', 'basic');
  assert.notEqual(subjectFingerprint('p', base, watch), subjectFingerprint('p', makeSubject('1', 'pro'), watch));
  assert.notEqual(subjectFingerprint('p', base, watch), subjectFingerprint('q', base, watch));
  assert.notEqual(subjectFingerprint('p', base, watch), subjectFingerprint('p', makeSubject('2', 'basic'), watch));

  // 键顺序无关（stableStringify 排序）
  const reordered: ExternalSubject = { externalId: '1', attributes: { status: 1, group: 'basic' } };
  assert.equal(subjectFingerprint('p', base, watch), subjectFingerprint('p', reordered, watch));
});

test('fnv1a64：确定性且区分大小写', () => {
  assert.equal(fnv1a64('abc'), fnv1a64('abc'));
  assert.notEqual(fnv1a64('abc'), fnv1a64('abd'));
  assert.match(fnv1a64('abc'), /^[0-9a-f]{16}$/);
});

// ─────────────────────────── 能力探测 ───────────────────────────

test('能力探测：声明 cursor=true 但实测没有 nextCursor → 报不一致（不得静默降级）', async () => {
  const provider = makeProvider({ subjects: [makeSubject('1', 'a')], capabilities: { cursor: true }, withCursor: false });
  const result = await probeProvider(provider);
  assert.deepEqual(result.mismatches, ['cursor']);
  assert.equal(result.declared.cursor, true);
  assert.equal(result.actual.cursor, false);
});

test('能力探测：声明 findByIdentity=true 但没有实现 findSubject → 报不一致', async () => {
  const provider = makeProvider({ subjects: [], capabilities: { findByIdentity: true } });
  const result = await probeProvider(provider);
  assert.ok(result.mismatches.includes('findByIdentity'));
});

// ─────────────────────────── 对账：全量 ───────────────────────────

test('全量对账：新建主体发 subject.created；未出现者标 deleted 并发 subject.deleted', async () => {
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  const bus = new EventBus();
  const events = collectEvents(bus);
  const provider = makeProvider({ subjects: [makeSubject('1', 'a'), makeSubject('2', 'b')] });

  const reconciler = new Reconciler({ provider, subjects: store, state, bus });
  const first = await reconciler.reconcileFull();
  assert.equal(first.mode, 'full');
  assert.equal(first.scanned, 2);
  assert.equal(first.created, 2);
  assert.equal(first.markedDeleted, 0);
  assert.equal(events.filter((e) => e.type === SUBJECT_EVENTS.created).length, 2);
  assert.equal(await store.count('fakeprovider'), 2);

  // 下游删掉主体 2 → 全量应把它标记 deleted 并发事件
  provider.setSubjects([makeSubject('1', 'a')]);
  events.length = 0;
  const second = await reconciler.reconcileFull();
  assert.equal(second.markedDeleted, 1);
  assert.equal(second.unchanged, 1);
  assert.equal(events.filter((e) => e.type === SUBJECT_EVENTS.deleted).length, 1);
  assert.equal(await store.count('fakeprovider'), 1, '软删除后不计入有效主体');
});

test('全量对账：属性变化发 subject.attributes_changed 并带 changedKeys；噪声字段变化不发事件', async () => {
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  const bus = new EventBus();
  const events = collectEvents(bus);
  const provider = makeProvider({ subjects: [makeSubject('1', 'a')] });
  const reconciler = new Reconciler({ provider, subjects: store, state, bus });

  await reconciler.reconcileFull();
  events.length = 0;

  // 只改噪声字段 → 无事件
  provider.setSubjects([makeSubject('1', 'a', { request_count: 42 })]);
  const noise = await reconciler.reconcileFull();
  assert.equal(noise.unchanged, 1);
  assert.equal(noise.changed, 0);
  assert.equal(events.length, 0, '噪声字段变化不得触发下游');

  // 改 watch 字段 → 发事件且 changedKeys 正确
  provider.setSubjects([makeSubject('1', 'pro')]);
  const real = await reconciler.reconcileFull();
  assert.equal(real.changed, 1);
  const changedEvent = events.find((e) => e.type === SUBJECT_EVENTS.attributesChanged);
  assert.ok(changedEvent !== undefined);
  assert.deepEqual((changedEvent.payload as { changedKeys: string[] }).changedKeys, ['group']);
});

test('全量对账：软删除的主体再次出现 → 发 subject.created（复活需重新评估）', async () => {
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  const bus = new EventBus();
  const events = collectEvents(bus);
  const provider = makeProvider({ subjects: [makeSubject('1', 'a'), makeSubject('2', 'b')] });
  const reconciler = new Reconciler({ provider, subjects: store, state, bus });

  await reconciler.reconcileFull();
  provider.setSubjects([makeSubject('1', 'a')]);
  await reconciler.reconcileFull();
  events.length = 0;

  provider.setSubjects([makeSubject('1', 'a'), makeSubject('2', 'b')]);
  const revived = await reconciler.reconcileFull();
  assert.equal(revived.revived, 1);
  assert.equal(events.filter((e) => e.type === SUBJECT_EVENTS.created).length, 1);
});

// ─────────────────────────── 对账：增量 ───────────────────────────

test('真增量：用 nextCursor 翻页到底，并保存游标；下次从游标继续', async () => {
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  const subjects = Array.from({ length: 5 }, (_, i) => makeSubject(String(i + 1), 'a'));
  const provider = makeProvider({ subjects, pageSize: 2, withCursor: true });
  const reconciler = new Reconciler({ provider, subjects: store, state, pageSize: 2 });

  // 先做一次全量（首次运行走全量的前置）
  await reconciler.reconcileFull();
  const outcome = await reconciler.reconcileIncremental();
  assert.equal(outcome.mode, 'incremental');
  assert.equal(outcome.scanned, 5);
  assert.equal(outcome.unchanged, 5);
  assert.equal(outcome.cursor, null, '翻到底后游标为 null');
});

test('降级增量：无游标能力 → 拉首页，遇到已知 id 即停（不重复扫描全表）', async () => {
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  const subjects = Array.from({ length: 6 }, (_, i) => makeSubject(String(i + 1), 'a'));
  const provider = makeProvider({ subjects, pageSize: 10, withCursor: false });
  const reconciler = new Reconciler({ provider, subjects: store, state, pageSize: 10 });

  await reconciler.reconcileFull();

  // 首页包含全部 6 个（已全部已知）→ 第 1 个就命中已知 id，立刻停
  const outcome = await reconciler.reconcileIncremental();
  assert.equal(outcome.mode, 'incremental-degraded');
  assert.equal(outcome.stoppedEarly, true);
  assert.equal(outcome.scanned, 1, '遇到已知 id 立即停止');
});

test('降级增量：下游新增了主体（排在最前）→ 扫描到已知 id 之前的新主体', async () => {
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  // 下游按主键倒序：新主体排在最前
  const provider = makeProvider({ subjects: [makeSubject('3', 'a'), makeSubject('2', 'a'), makeSubject('1', 'a')], pageSize: 10 });
  const reconciler = new Reconciler({ provider, subjects: store, state, pageSize: 10 });

  // 先让 1、2 已知
  provider.setSubjects([makeSubject('2', 'a'), makeSubject('1', 'a')]);
  await reconciler.reconcileFull();

  // 下游新增 3（排最前）
  provider.setSubjects([makeSubject('3', 'a'), makeSubject('2', 'a'), makeSubject('1', 'a')]);
  const outcome = await reconciler.reconcileIncremental();
  assert.equal(outcome.created, 1);
  assert.equal(outcome.scanned, 2, '扫到 3（新建）后遇到已知的 2 即停');
  assert.equal(await store.count('fakeprovider'), 3);
});

test('★ 首次运行必须走全量（否则漏掉「下游已删但平台还不知道」的主体）', async () => {
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  const provider = makeProvider({ subjects: [makeSubject('1', 'a')], withCursor: false });
  const reconciler = new Reconciler({ provider, subjects: store, state });

  const first = await reconciler.reconcile();
  assert.equal(first.mode, 'full', '没有 lastFullSyncAt 时必须全量');

  const second = await reconciler.reconcile();
  assert.equal(second.mode, 'incremental-degraded', '全量成功过之后走增量');
});

test('对账：下游抛错时异常向上传播（不吞错），且不破坏已有数据', async () => {
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  const provider = makeProvider({ subjects: [makeSubject('1', 'a')] });
  const reconciler = new Reconciler({ provider, subjects: store, state });
  await reconciler.reconcileFull();

  const broken: ProviderPlugin = {
    ...provider,
    async listSubjects(): Promise<SubjectPage> {
      throw new Error('下游 503');
    },
  };
  const failing = new Reconciler({ provider: broken, subjects: store, state });
  await assert.rejects(failing.reconcileFull(), /下游 503/);
  assert.equal(await store.count('fakeprovider'), 1, '失败不得破坏已对账数据');
});

test('对账：能力不一致时记 warn 日志（可运维发现），并出现在 outcome 里', async () => {
  const store = new InMemorySubjectStore();
  const state = new InMemorySyncStateStore();
  const { sink, records } = collectingSink();
  const provider = makeProvider({ subjects: [makeSubject('1', 'a')], capabilities: { cursor: true }, withCursor: false });
  const reconciler = new Reconciler({ provider, subjects: store, state, logger: createLogger({ level: 'debug', sink }) });

  const outcome = await reconciler.reconcileFull();
  assert.deepEqual(outcome.capabilityMismatches, ['cursor']);
  assert.ok(records.some((r) => r.level === 'warn' && /能力/.test(r.message)), '必须记 warn');
});
