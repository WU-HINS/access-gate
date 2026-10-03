/**
 * 插件调用记录（`ag_plugin_invocations`）—— 运维可观测性。
 *
 * ★ 枚举取值**先查迁移产物**：
 *   `ag_invocation_status = 'ok'|'timeout'|'error'|'denied'|'rate_limited'|'crashed'`
 *
 * ★★ 本表是**站点级**（`site_id NOT NULL`）——因此查询必须带站点作用域。
 *   本实现把 `siteId` 交给**查询编译器**（`compile(..., { scope: { siteId } })`），
 *   由它自动注入 `site_id = $n` 并在缺失时 **fail-closed 拒绝编译**。
 *
 *   ★ 这是本项目「站点作用域注入」设计的价值：
 *     **我不需要（也不可能忘记）手写站点过滤**——忘不了，因为它编译不过。
 *
 * ★ `id` 是 `bigserial`（**数字**，不是 uuid）——与 `ag_verify_assertions` 同类。
 *   我在做断言流水时已踩过「以为 id 是 uuid」的坑，这次先查了。
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { and, col, eq, gt, lit, type Condition } from '../query/ast.ts';
import { reuseOrBeginTransaction } from '../db/tx.ts';

/**
 * ★ 站点级表的元信息。
 *
 * `siteScoped: true` + `hasSiteIdColumn: true` → 编译器会**注入**站点过滤。
 * 若声明 `siteScoped: true` 却没有 `site_id` 列，编译器会报「声明缺陷」。
 */
const SITE_SCOPED: TableScopeMeta = { siteScoped: true, hasSiteIdColumn: true };

export type InvocationStatus = 'ok' | 'timeout' | 'error' | 'denied' | 'rate_limited' | 'crashed';

export interface InvocationRecord {
  /** ★ `bigserial` → 数字 */
  id: number;
  pluginId: string;
  op: string;
  userId: string | null;
  status: InvocationStatus;
  /** 被拒绝时**缺哪个权限**（安全排查的关键线索） */
  deniedPermission: string | null;
  egressHost: string | null;
  durationMs: number;
  costTokens: number;
  error: string | null;
  traceId: string | null;
  createdAt: Date;
}

export interface ListInvocationsInput {
  siteId: string;
  pluginId: string;
  status?: InvocationStatus;
  /** 只看最近 N 毫秒内的 */
  sinceMs?: number;
  limit: number;
  offset: number;
}

export interface PluginInvocationStore {
  list(input: ListInvocationsInput): Promise<{ invocations: InvocationRecord[]; hasMore: boolean }>;
  /** ★ 按状态聚合计数（运维最常问的是「失败有多少」） */
  summary(input: { siteId: string; pluginId: string; sinceMs?: number }): Promise<Record<InvocationStatus, number>>;
}

const ALL_STATUSES: readonly InvocationStatus[] = ['ok', 'timeout', 'error', 'denied', 'rate_limited', 'crashed'];

function emptySummary(): Record<InvocationStatus, number> {
  return Object.fromEntries(ALL_STATUSES.map((status) => [status, 0])) as Record<InvocationStatus, number>;
}

// ─────────────────────────── 内存实现 ───────────────────────────

export class InMemoryPluginInvocationStore implements PluginInvocationStore {
  private readonly rows: { siteId: string; record: InvocationRecord }[] = [];

  seed(siteId: string, record: InvocationRecord): void {
    this.rows.push({ siteId, record: { ...record } });
  }

  async list(input: ListInvocationsInput): Promise<{ invocations: InvocationRecord[]; hasMore: boolean }> {
    // ★ 与 PG 实现同语义：**先按站点过滤**（内存实现也要遵守，否则测试掩盖跨站问题）
    const cutoff = input.sinceMs === undefined ? 0 : Date.now() - input.sinceMs;
    const filtered = this.rows
      .filter((row) => row.siteId === input.siteId && row.record.pluginId === input.pluginId)
      .filter((row) => input.status === undefined || row.record.status === input.status)
      .filter((row) => row.record.createdAt.getTime() >= cutoff)
      .sort((a, b) => b.record.createdAt.getTime() - a.record.createdAt.getTime())
      .map((row) => ({ ...row.record }));
    // 调用方传 limit+1（多取一条判断 hasMore）——与项目的其他列表端点一致
    const page = filtered.slice(input.offset, input.offset + Math.max(1, input.limit - 1));
    return { invocations: page, hasMore: input.offset + page.length < filtered.length };
  }

  async summary(input: { siteId: string; pluginId: string; sinceMs?: number }): Promise<Record<InvocationStatus, number>> {
    const cutoff = input.sinceMs === undefined ? 0 : Date.now() - input.sinceMs;
    const out = emptySummary();
    for (const row of this.rows) {
      if (row.siteId !== input.siteId || row.record.pluginId !== input.pluginId) continue;
      if (row.record.createdAt.getTime() < cutoff) continue;
      out[row.record.status] += 1;
    }
    return out;
  }
}

// ─────────────────────────── PostgreSQL 实现 ───────────────────────────

interface InvocationRow extends Record<string, unknown> {
  id: string | number;
  plugin_id: string;
  op: string;
  user_id: string | null;
  status: string;
  denied_permission: string | null;
  egress_host: string | null;
  duration_ms: number;
  cost_tokens: number;
  error: string | null;
  trace_id: string | null;
  created_at: string | Date;
}

const COLUMNS = ['id', 'plugin_id', 'op', 'user_id', 'status', 'denied_permission', 'egress_host', 'duration_ms', 'cost_tokens', 'error', 'trace_id', 'created_at'];

function rowToRecord(row: InvocationRow): InvocationRecord {
  return {
    // ★ bigserial 可能以字符串返回（大整数保护）
    id: typeof row.id === 'string' ? Number.parseInt(row.id, 10) : row.id,
    pluginId: row.plugin_id,
    op: row.op,
    userId: row.user_id,
    status: row.status as InvocationStatus,
    deniedPermission: row.denied_permission,
    egressHost: row.egress_host,
    durationMs: row.duration_ms,
    costTokens: row.cost_tokens,
    error: row.error,
    traceId: row.trace_id,
    createdAt: new Date(row.created_at as string),
  };
}

export class DbPluginInvocationStore implements PluginInvocationStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async list(input: ListInvocationsInput): Promise<{ invocations: InvocationRecord[]; hasMore: boolean }> {
    const conditions: Condition[] = [eq(col('plugin_id'), lit(input.pluginId))];
    if (input.status !== undefined) conditions.push(eq(col('status'), lit(input.status)));
    if (input.sinceMs !== undefined) conditions.push(gt(col('created_at'), lit(new Date(Date.now() - input.sinceMs))));
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_invocations',
        columns: COLUMNS,
        where: and(...conditions),
        orderBy: [{ column: 'created_at', direction: 'desc' }],
        limit: input.limit,
        offset: input.offset,
      },
      SITE_SCOPED,
      // ★★ 站点作用域注入：编译器据此自动加 `site_id = $n`（缺 siteId 则 fail-closed）
      { scope: { siteId: input.siteId } },
    );
    const rows = await this.#db.query<InvocationRow>(compiled.sql, compiled.params);
    const page = rows.slice(0, Math.max(1, input.limit - 1));
    return { invocations: page.map(rowToRecord), hasMore: rows.length > page.length };
  }

  async summary(input: { siteId: string; pluginId: string; sinceMs?: number }): Promise<Record<InvocationStatus, number>> {
    // ★ 聚合无法用编译器表达（`count(*) FILTER` / `GROUP BY`）——但**站点过滤仍由编译器注入**，
    //   因此这里不在 `src/**` 手写 SQL 的问题**不存在**：本方法是仓储层，
    //   而 `tools/ci-gate.ts` 第 6 项扫的是 `src/**`——★ 仓储层在白名单里（DRIVER_FILES）。
    const conditions: Condition[] = [eq(col('plugin_id'), lit(input.pluginId))];
    if (input.sinceMs !== undefined) conditions.push(gt(col('created_at'), lit(new Date(Date.now() - input.sinceMs))));
    const compiled = compile(
      { kind: 'select', table: 'ag_plugin_invocations', columns: ['status'], where: and(...conditions) },
      SITE_SCOPED,
      { scope: { siteId: input.siteId } },
    );
    const rows = await this.#db.query<{ status: string }>(compiled.sql, compiled.params);
    // ★ 在**应用层**聚合（而不是写 `GROUP BY` SQL）——
    //   代价是传输行数，收益是**站点过滤仍由编译器保证**（不可能漏）。
    //   ★ 这是刻意的权衡：可观测性数据量可控，而「漏站点过滤」是安全问题。
    const out = emptySummary();
    for (const row of rows) {
      const status = row.status as InvocationStatus;
      if (status in out) out[status] += 1;
    }
    return out;
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalPluginInvocationStore(db: Db): PluginInvocationStore {
  const inner = new DbPluginInvocationStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    list: (input) => wrap(() => inner.list(input)),
    summary: (input) => wrap(() => inner.summary(input)),
  };
}
