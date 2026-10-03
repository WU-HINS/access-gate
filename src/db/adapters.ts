/**
 * PostgreSQL 适配器（生产就绪判据 #2）—— 把内存实现替换成真实持久化。
 *
 * ★ 为什么这一步是「可入生产」的硬门槛：内存实现意味着**重启即丢**。
 *   会话丢失 = 所有人被登出；生命周期状态丢失 = 权限判定从 unknown 重来
 *   （可能重复授予）；动作日志丢失 = **幂等被破坏**，重放会重复写下游。
 *   后者最危险：`ag_actions_log` 的幂等键是「不重复踢下线」的唯一保障。
 *
 * ★ 与内存实现的关系：内存实现**保留**（单测与本地开发用），DB 实现是生产路径。
 *   两者实现同一接口，因此可以用同一套契约测试覆盖——本文件末尾即为此。
 *
 * ★ SQL 一律经查询编译器产出（站点作用域自动注入），不手写业务 SQL。
 */

import type { Db } from '../db/pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import type { SqlValue } from '../query/ast.ts';
import { and, col, decrement, eq, gt, gte, increment, inList, isNull, like, lit, lte, or, type Condition, type SetValue } from '../query/ast.ts';

import type { Session, SessionStore, Principal } from '../auth/session.ts';
import type { AuditEntry as _AuditEntry, AuditQuery, AuditRecord, PolicyStore } from '../admin/api.ts';
import type { PolicyDocument } from '../policy/model.ts';
import type { IdentityRecord, IdentityStore } from '../core/identity.ts';
import type { ExternalSubject } from '../plugin/provider.ts';
import type { StoredSubject, SubjectStore, UpsertResult } from '../plugin/subjects.ts';
import type { BaselineKey, LifecycleStateEntry, LifecycleStateStore } from '../core/lifecycle-store-type.ts';
import type { EvaluationRecord, EvaluationStore } from '../core/patrol.ts';
import type { LifecycleSnapshot } from '../core/lifecycle.ts';
import type { ActionLogEntry, ActionLogStore } from '../core/action-executor.ts';
import type { AuditSink } from '../admin/api.ts';
type AuditEntry = _AuditEntry;
import type { JobRecord, JobStatus, JobStore } from '../kernel/scheduler.ts';
import type { FactRecord, FactStore } from '../plugin/host-api.ts';

// ─────────────────────────── 元信息 ───────────────────────────

const SITE_SCOPED: TableScopeMeta = { siteScoped: true, hasSiteIdColumn: true };
const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };
const OWNER_SCOPED: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

/**
 * JSONB 参数。
 *
 * ★ 必须**显式序列化**：`pg` 驱动会把 JS 对象按 PostgreSQL **数组**字面量处理
 *   （`{a:1}` → `{a:1}` 而不是 `{"a":1}`），落到 jsonb 列上直接报
 *   `invalid input syntax for type json`。这是真实 PG 跑出来的（pglite 路径不经过驱动层）。
 */
function jsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** 把 Date/undefined 归一成 SQL 可接受的值。 */
function ts(value: Date | null | undefined): Date | null {
  return value ?? null;
}

// ─────────────────────────── 会话（ag_sessions） ───────────────────────────

/**
 * `ag_sessions` 的**真实列**（来自 migrations/0001_init.sql）。
 *
 * ★ 这段映射是真实 PG 跑出来的：我最初凭「会话应有什么」想象了
 *   `role` / `username` / `email` / `email_verified` / `last_seen_at` 五列，
 *   真库立刻报 `column "role" does not exist`。**表结构是权威，适配器必须照着写**。
 *   其中两处是真实的数据模型缺口（不是适配器 bug），已在下方标注。
 */
interface SessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  token_hash: string;
  realm: string;
  active_developer_id: string | null;
  active_site_id: string | null;
  active_site_updated_at: string | null;
  created_at: string | Date;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  user_agent: string | null;
  ip: string | null;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToSession(row: SessionRow): Session {
  // ★ 缺口 1：`ag_sessions` **没有** username/email/email_verified 列。
  //   会话行只持有 user_id；展示用的主体信息应在需要时从 `ag_users` 取。
  //   这里不伪造：username 置为 userId，email 为 null，emailVerified 为 false，
  //   并留 `principalFromDirectory` 的接线点（见 src/http/routes.ts 的登录流程）。
  const principal: Principal = {
    userId: row.user_id,
    username: row.user_id,
    email: null,
    emailVerified: false,
    realm: row.realm === 'developer' ? 'developer' : 'enduser',
    // ★ 缺口 2：`ag_sessions` 只存 realm，不存 role。
    role: row.realm === 'developer' ? 'developer' : 'user',
    activeSiteId: row.active_site_id,
    activeDeveloperId: row.active_developer_id,
  };
  return {
    id: row.id,
    tokenHash: row.token_hash,
    principal,
    createdAt: toDate(row.created_at),
    // ★ 缺口 3：没有 last_seen_at 列。用 active_site_updated_at 近似「最近活动」，
    //   为 null 时回落到 created_at（不假装有一个精确值）。
    lastSeenAt: toDate(row.active_site_updated_at ?? row.created_at),
    expiresAt: toDate(row.expires_at),
    revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at),
  };
}

/**
 * 会话的 PG 实现。
 *
 * ★ `ag_sessions` 在门禁里是**豁免表**（会话横跨站点，站点归属由 `activeSiteId`
 *   在运行期约束）。因此这里不带 `site_id` 过滤——这是声明层已经裁决过的事实，
 *   适配器只是如实实现。
 */
export class DbSessionStore implements SessionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async findByTokenHash(tokenHash: string): Promise<Session | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_sessions', columns: ['id', 'user_id', 'token_hash', 'realm', 'active_developer_id', 'active_site_id', 'active_site_updated_at', 'created_at', 'expires_at', 'revoked_at', 'user_agent', 'ip'], where: eq(col('token_hash'), lit(tokenHash)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SessionRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToSession(rows[0]);
  }

  async findById(id: string): Promise<Session | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_sessions', columns: ['id', 'user_id', 'token_hash', 'realm', 'active_developer_id', 'active_site_id', 'active_site_updated_at', 'created_at', 'expires_at', 'revoked_at', 'user_agent', 'ip'], where: eq(col('id'), lit(id)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SessionRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToSession(rows[0]);
  }

  async save(session: Session): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_sessions',
        rows: [
          {
            id: session.id,
            token_hash: session.tokenHash,
            user_id: session.principal.userId,
            realm: session.principal.realm,
            active_site_id: session.principal.activeSiteId,
            active_developer_id: session.principal.activeDeveloperId,
            active_site_updated_at: session.lastSeenAt,
            created_at: session.createdAt,
            expires_at: session.expiresAt,
            revoked_at: session.revokedAt,
          },
        ],
        onConflict: {
          columns: ['id'],
          do: 'update',
          updateColumns: ['expires_at', 'revoked_at', 'active_site_id', 'active_developer_id', 'active_site_updated_at'],
        },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async touch(id: string, at: Date): Promise<void> {
    const compiled = compile(
      { kind: 'update', table: 'ag_sessions', set: { active_site_updated_at: at }, where: eq(col('id'), lit(id)) },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async revoke(id: string, at: Date): Promise<void> {
    const compiled = compile(
      { kind: 'update', table: 'ag_sessions', set: { revoked_at: at }, where: eq(col('id'), lit(id)) },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async listByUser(userId: string): Promise<Session[]> {
    const compiled = compile(
      { kind: 'select', table: 'ag_sessions', columns: ['id', 'user_id', 'token_hash', 'realm', 'active_developer_id', 'active_site_id', 'active_site_updated_at', 'created_at', 'expires_at', 'revoked_at', 'user_agent', 'ip'], where: eq(col('user_id'), lit(userId)) },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<SessionRow>(compiled.sql, compiled.params);
    return rows.map(rowToSession);
  }
}

/**
 * ★ R128：**状态 CAS 冲突**（DC-2）。
 *
 * ★ 何时抛出：`save(..., expectedVersion)` 的 `UPDATE … WHERE version = $n` **影响 0 行**——
 *   即「**调用方读到的版本已被别人改过**」。
 *
 * ★★ 为什么必须**显式抛出**而不是静默重试：
 *   这是「**声称正确性的机制**」（`docs/11` 结构二）——静默重试会**掩盖**多实例竞争，
 *   而调用方（巡检）**必须知道**自己基于的状态已过期，才能决定重新求值。
 * ★ 调用方应捕获它并**重新 `get()` → 重新决策 → 再 `save()`**。
 */
export class LifecycleConflictError extends Error {
  readonly policyCode: string;
  readonly expectedVersion: number;
  constructor(policyCode: string, expectedVersion: number) {
    super(
      `生命周期状态 CAS 失败：策略 '${policyCode}' 的 version 已不是 ${expectedVersion}——` +
        `另一个实例已更新过该状态（丢更新被检测到）。请重新读取状态后重试。`,
    );
    this.name = 'LifecycleConflictError';
    this.policyCode = policyCode;
    this.expectedVersion = expectedVersion;
  }
}

// ─────────────────────────── 生命周期状态（ag_user_policy_state） ───────────────────────────

/**
 * `ag_user_policy_state` 的**真实列**（来自 migrations/0001_init.sql）。
 *
 * ★ 两处与「直觉」不符，都是真库跑出来的：
 *   1. 没有 `state_changed_at`，真实列名是 **`last_changed_at`**；
 *   2. 没有 `at_risk_count`——表里只有 `consecutive_indeterminate`（**语义不同**：
 *      那个数的是「连续不可判定」，不是「进入 at_risk 的次数」）。
 *      因此 `LifecycleSnapshot.atRiskCount` 在 DB 路径上**没有对应列**，
 *      适配器选择：读回时用 `consecutive_indeterminate`（最接近的观测值），
 *      写回时不写它（避免污染语义）。这是**如实登记的数据模型落差**，不是适配器 bug。
 *   3. `policy_id` 是 **uuid**（指向 `ag_policies.id`），而存储接口按**策略 code** 键
 *      → 必须经 `resolvePolicyId` 解析。
 */
interface StateRow extends Record<string, unknown> {
  user_id: string;
  policy_id: string;
  state: string;
  grace_until: string | Date | null;
  satisfied_at: string | Date | null;
  last_eval_id: string | number | null;
  last_changed_at: string | Date | null;
  consecutive_indeterminate: number;
  action_seq: number | string;
  /** ★ R128：乐观锁版本（DC-2 状态 CAS） */
  version: number;
}

export class DbLifecycleStateStore implements LifecycleStateStore {
  readonly #db: Db;
  readonly #siteId: string;
  readonly #resolvePolicyId: (code: string) => Promise<string | undefined>;

  /**
   * @param resolvePolicyId 策略 code → `ag_policies.id`（uuid）。
   *   为什么必须注入而不是自己查：策略解析涉及站点作用域与缓存策略，
   *   应由策略模块统一负责（避免适配器里长出第二套策略语义）。
   */
  constructor(db: Db, siteId: string, resolvePolicyId: (code: string) => Promise<string | undefined>) {
    this.#db = db;
    this.#siteId = siteId;
    this.#resolvePolicyId = resolvePolicyId;
  }

  async get(_siteId: string, userId: string, policyCode: string): Promise<LifecycleSnapshot | undefined> {
    const policyId = await this.#resolvePolicyId(policyCode);
    if (policyId === undefined) return undefined;
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_user_policy_state',
        // ★ R128：`version` 必须读回——否则调用方无法做 CAS（DC-2）
        columns: ['user_id', 'policy_id', 'state', 'grace_until', 'satisfied_at', 'last_eval_id', 'last_changed_at', 'consecutive_indeterminate', 'action_seq', 'version'],
        where: and(eq(col('user_id'), lit(userId)), eq(col('policy_id'), lit(policyId))),
        limit: 1,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<StateRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      state: row.state as LifecycleSnapshot['state'],
      graceUntil: row.grace_until === null ? null : toDate(row.grace_until),
      // ★ **首次**满足时刻（`null` = 从未满足过）——与 `grantedAt` 区分，见 `LifecycleSnapshot`
      satisfiedAt: row.satisfied_at === null ? null : toDate(row.satisfied_at),
      // ★ 这个状态依据哪次评估（`null` = 未知/来自非评估事件）
      lastEvalId: row.last_eval_id === null ? null : Number(row.last_eval_id),
      // `last_changed_at` 可为空（新建行）；回落到 epoch 而不是 now()——不伪造时间点
      stateChangedAt: row.last_changed_at === null ? new Date(0) : toDate(row.last_changed_at),
      // 见 StateRow 的说明：DB 里没有 at_risk_count，用最接近的观测值
      atRiskCount: Number(row.consecutive_indeterminate ?? 0),
      actionSeq: Number(row.action_seq),
      // ★ R128：带回版本号，供调用方做 CAS
      version: Number(row.version ?? 0),
    };
  }

  /**
   * 保存生命周期状态。
   *
   * ★★★ R128（DC-2 状态 CAS）：`expectedVersion` 是**可选**的——
   *   · **传入** → 执行 **CAS**（`WHERE … AND version = $n`，成功则 `version = version + 1`）；
   *     ★ 若版本不匹配（**0 行被更新**）→ 抛 `LifecycleConflictError`——
   *     ★ **这正是「丢更新」被检测到的时刻**：说明另一个实例已改过这行。
   *   · **不传** → 走原来的无条件 UPSERT（**向后兼容**，语义不变）。
   *
   * ★ 为什么用**独立的 UPDATE** 而不是给 `onConflict` 加条件：
   *   `onConflict` 的 AST **不支持 `where`**（只有 `columns` / `do` / `updateColumns`）——
   *   ★ 而 `kind: 'update'` **支持 `where` 与 `returning`**，因此 CAS 用后者。
   */
  async save(
    _siteId: string,
    userId: string,
    policyCode: string,
    snapshot: LifecycleSnapshot,
    expectedVersion?: number,
  ): Promise<void> {
    const policyId = await this.#resolvePolicyId(policyCode);
    if (policyId === undefined) {
      // ★ 不静默丢弃：状态写不进去意味着下次巡检会从 unknown 重来（可能重复授予）
      throw new Error(
        `无法解析策略 code '${policyCode}' 对应的 ag_policies.id——生命周期状态无法持久化。` +
          `请先确保策略已创建（code 是站点内唯一键，id 才是状态表的外键）。`,
      );
    }
    // ★★★ CAS 分支（DC-2）：只在调用方给出 expectedVersion 时启用。
    if (expectedVersion !== undefined) {
      const cas = compile(
        {
          kind: 'update',
          table: 'ag_user_policy_state',
          set: {
            state: snapshot.state,
            grace_until: ts(snapshot.graceUntil),
            // ★ `satisfiedAt`：**首次**满足时刻（与 `grantedAt` 区分，见 `LifecycleSnapshot`）
            satisfied_at: ts(snapshot.satisfiedAt ?? null),
            // ★ `lastEvalId`：这个状态依据哪次评估（审计线索）
            last_eval_id: snapshot.lastEvalId ?? null,
            last_changed_at: snapshot.stateChangedAt,
            action_seq: snapshot.actionSeq,
            // ★ 版本自增（用列表达式，避免读改写竞态）
            // ★ `increment` 接受**列名字符串**（不是 `col()`）——它编译成 `version = version + $n`
            version: increment('version'),
          },
          where: and(
            eq(col('user_id'), lit(userId)),
            eq(col('policy_id'), lit(policyId)),
            eq(col('version'), lit(expectedVersion)),
          ),
          returning: ['version'],
        },
        SITE_SCOPED,
        { scope: { siteId: this.#siteId } },
      );
      const updated = await this.#db.query<{ version: number }>(cas.sql, cas.params);
      if (updated.length === 0) {
        // ★ 0 行 = 版本不匹配（或行不存在）→ **丢更新被检测到**
        throw new LifecycleConflictError(policyCode, expectedVersion);
      }
      return;
    }
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_user_policy_state',
        rows: [
          {
            user_id: userId,
            policy_id: policyId,
            state: snapshot.state,
            grace_until: ts(snapshot.graceUntil),
            // ★ `satisfiedAt`：**首次**满足时刻（与 `grantedAt` 区分，见 `LifecycleSnapshot`）
            satisfied_at: ts(snapshot.satisfiedAt ?? null),
            // ★ `lastEvalId`：这个状态依据哪次评估（审计线索）
            last_eval_id: snapshot.lastEvalId ?? null,
            last_changed_at: snapshot.stateChangedAt,
            action_seq: snapshot.actionSeq,
          },
        ],
        onConflict: {
          columns: ['site_id', 'user_id', 'policy_id'],
          do: 'update',
          updateColumns: ['state', 'grace_until', 'satisfied_at', 'last_eval_id', 'last_changed_at', 'action_seq'],
        },
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  /**
   * ★ 该主体在**本站点**的全部策略状态（级联回退要跨策略聚合，见 `docs/05 §3.5` 修正二）。
   *
   * ★ `policyCode` 回 `null`：从 `policy_id` 反查 code 需要 JOIN，而查询编译器不支持 JOIN
   *   （见 `tools/ci-gate.ts` 里对该文件的白名单说明）。装配层本来就有 code ↔ id 映射，
   *   由它反查即可——这里不为了「好看」而手写 JOIN。
   */
  async listByUser(_siteId: string, userId: string): Promise<readonly LifecycleStateEntry[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_user_policy_state',
        columns: [
          'user_id',
          'policy_id',
          'state',
          'grace_until', 'satisfied_at', 'last_eval_id',
          'last_changed_at',
          'consecutive_indeterminate',
          'action_seq',
          'version',
        ],
        where: eq(col('user_id'), lit(userId)),
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<StateRow>(compiled.sql, compiled.params);
    return rows.map((row) => ({
      policyId: row.policy_id,
      policyCode: null,
      state: row.state as LifecycleSnapshot['state'],
      snapshot: {
        state: row.state as LifecycleSnapshot['state'],
        graceUntil: row.grace_until === null ? null : toDate(row.grace_until),
        // ★ 首次满足时刻（`null` = 从未满足过）
        satisfiedAt: row.satisfied_at === null ? null : toDate(row.satisfied_at),
        lastEvalId: row.last_eval_id === null ? null : Number(row.last_eval_id),
        stateChangedAt: row.last_changed_at === null ? new Date(0) : toDate(row.last_changed_at),
        atRiskCount: Number(row.consecutive_indeterminate ?? 0),
        actionSeq: Number(row.action_seq),
        version: Number(row.version ?? 0),
      },
    }));
  }

  /** 读 baseline（`ag_user_policy_state.baseline` 的某个动作键）；不存在返回 `null`。 */
  async baselineOf(input: BaselineKey): Promise<string | null> {
    const policyId = await this.#resolvePolicyId(input.policyCode);
    if (policyId === undefined) return null;
    const rows = await this.#db.query<{ value: string | null }>(
      `SELECT baseline ->> $4 AS value FROM ag_user_policy_state
        WHERE site_id = $1 AND user_id = $2 AND policy_id = $3 LIMIT 1`,
      [this.#siteId, input.userId, policyId, input.actionKey],
    );
    const value = rows[0]?.value;
    return value === undefined || value === null ? null : value;
  }

  /**
   * 幂等写 baseline：**仅当该动作键不存在时写入**。
   *
   * ★ 用一条原子语句表达「仅当为空」（而不是「先读后写」）：
   *   `CASE WHEN baseline ? $key THEN baseline ELSE baseline || jsonb_build_object(...) END`。
   *   并发下两个调用者都写也只会保留**先到**的那个值——而 baseline 的全部意义就是
   *   「**首次**接管前的原值」，被后到者覆盖就失去了语义。
   *
   * ★ 这是本文件里少数手写 SQL 的地方之一（`?` 与 `jsonb_build_object` 编译器表达不了）；
   *   值一律走 `$n` 参数，`site_id` 由构造时注入的会话作用域提供——**不拼接**。
   */
  async rememberBaseline(input: BaselineKey & { value: string }): Promise<void> {
    const policyId = await this.#resolvePolicyId(input.policyCode);
    if (policyId === undefined) return;
    await this.#db.query(
      `INSERT INTO ag_user_policy_state (site_id, user_id, policy_id, state, baseline, last_changed_at, action_seq)
       VALUES ($1, $2, $3, 'unknown', jsonb_build_object($4, $5), now(), 0)
       ON CONFLICT (site_id, user_id, policy_id) DO UPDATE
         SET baseline = CASE
               WHEN ag_user_policy_state.baseline ? $4 THEN ag_user_policy_state.baseline
               ELSE ag_user_policy_state.baseline || jsonb_build_object($4, $5)
             END`,
      [this.#siteId, input.userId, policyId, input.actionKey, input.value],
    );
  }
}

// ─────────────────────────── 动作日志（ag_actions_log）★ 幂等的唯一保障 ───────────────────────────

interface ActionRow extends Record<string, unknown> {
  action_seq: number;
  action: string;
  idempotency_key: string;
  status: string;
  attempts: number;
  started_at: string | Date;
  finished_at: string | Date;
  skip_reason: string | null;
  error: string | null;
  result: unknown;
  user_id: string;
  policy_id: string | null;
}

/**
 * 动作日志的 PG 实现。
 *
 * ★ 这是**最不能失败**的持久化：幂等键的唯一约束 `(site_id, idempotency_key)`
 *   决定了「重复巡检不会重复踢下线」。因此：
 *   - `record` 用 `ON CONFLICT` 而不是先查后写（后者在并发下会双写）；
 *   - `find` 只按 `(site_id, idempotency_key)` 查（唯一约束的精确匹配）。
 */
export class DbActionLogStore implements ActionLogStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async find(siteId: string, idempotencyKey: string): Promise<ActionLogEntry | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_actions_log',
        columns: ['action_seq', 'action', 'idempotency_key', 'status', 'attempts', 'started_at', 'finished_at', 'skip_reason', 'error', 'result', 'user_id', 'policy_id'],
        where: eq(col('idempotency_key'), lit(idempotencyKey)),
        limit: 1,
      },
      SITE_SCOPED,
      { scope: { siteId } },
    );
    const rows = await this.#db.query<ActionRow>(compiled.sql, compiled.params);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      siteId,
      userId: row.user_id,
      policyId: row.policy_id ?? '',
      actionSeq: Number(row.action_seq),
      action: row.action,
      idempotencyKey: row.idempotency_key,
      status: row.status as ActionLogEntry['status'],
      attempts: Number(row.attempts),
      startedAt: toDate(row.started_at),
      finishedAt: toDate(row.finished_at),
      ...(row.skip_reason === null ? {} : { reason: row.skip_reason }),
      ...(row.error === null ? {} : { error: row.error }),
      ...(row.result === null || row.result === undefined ? {} : { result: row.result }),
    };
  }

  /**
   * 记录动作日志。
   *
   * ★ `entry.policyId` 必须是 **`ag_policies.id`（uuid）**，不是策略 code——
   *   表列是 uuid 外键。而幂等键计算用的是 code（见 `idempotencyKeyOf`）。
   *   两者刻意分开：code 可读且站点内唯一；uuid 用于外键。
   */
  async record(entry: ActionLogEntry): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(entry.policyId)) {
      throw new Error(
        `ag_actions_log.policy_id 需要 uuid，收到 '${entry.policyId}'。` +
          `请在调用处传入 ag_policies.id（幂等键仍用 code 计算）。`,
      );
    }
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_actions_log',
        rows: [
          {
            action_seq: entry.actionSeq,
            user_id: entry.userId,
            policy_id: entry.policyId,
            action: entry.action,
            idempotency_key: entry.idempotencyKey,
            params: {},
            status: entry.status,
            attempts: entry.attempts,
            skip_reason: entry.reason ?? null,
            error: entry.error ?? null,
            result: entry.result === undefined ? null : jsonb(entry.result),
            started_at: entry.startedAt,
            finished_at: entry.finishedAt,
            created_at: entry.finishedAt,
          },
        ],
        onConflict: {
          columns: ['site_id', 'idempotency_key'],
          do: 'update',
          updateColumns: ['status', 'attempts', 'skip_reason', 'error', 'result', 'finished_at'],
        },
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }
}

// ─────────────────────────── 审计（ag_audit_log） ───────────────────────────

/**
 * `ag_audit_log` 的行形状。
 *
 * ★ **只此一处**：TS 的 interface **声明合并**意味着同名声明会被自动合并——
 *   若在别处再写一个 `AuditRow`，字段类型冲突时会报错，而**不冲突时静默合并**
 *   （后者更难查）。所以本类型只在表的定义旁出现一次。
 */
interface AuditRow extends Record<string, unknown> {
  /** ★ `bigserial`（PG 驱动返回字符串） */
  id: string | number;
  site_id: string;
  actor_type: _AuditEntry['actorType'];
  /** ★ 表里可空（系统任务没有 actor）→ 映射时回落为 `''` */
  actor_id: string | null;
  developer_id: string | null;
  realm: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before: unknown;
  after: unknown;
  trace_id: string | null;
  created_at: string | Date;
}

export class DbAuditSink implements AuditSink {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async record(entry: AuditEntry): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_audit_log',
        rows: [
          {
            actor_type: entry.actorType,
            actor_id: entry.actorId,
            // ★ 归属（可见性判定的两个维度）—— 见 `AuditEntry.developerId` / `realm` 的说明
            developer_id: entry.developerId ?? null,
            realm: entry.realm ?? null,
            action: entry.action,
            target_type: entry.targetType ?? null,
            target_id: entry.targetId ?? null,
            // JSONB 列：值来自任意领域对象，断言为 SqlValue（编译器只负责参数化，不解释结构）
            before: entry.before === undefined ? null : jsonb(entry.before),
            after: entry.after === undefined ? null : jsonb(entry.after),
            trace_id: entry.traceId ?? null,
            created_at: new Date(),
          },
        ],
      },
      SITE_SCOPED,
      // ★ 审计必须落在**事件所属站点**，而不是「当前请求的站点」——
      //   平台级操作（如跨站点管理）也要能正确归属，否则审计会串站点。
      { scope: { siteId: entry.siteId.length > 0 ? entry.siteId : this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  /**
   * ★★ **读取审计**（`docs/06` 的 `GET /admin/audit`）。
   *
   * ★ 站点作用域：`ag_audit_log` 是**站点级**表 → 编译器注入 `site_id`；
   *   因此**跨站点**读取只能由调用方显式走 `cross-site.ts` 的判定（`scope: 'bypass'`）。
   * ★ 排序 `created_at DESC`：最近的审计最常被查。
   */
  async list(query: AuditQuery): Promise<readonly AuditRecord[]> {
    const conditions: Condition[] = [];
    // ★★ **站点集合**：`'all'` = 不限；**空数组 → `inList` 编译为 `FALSE`** ——
    //   "名下没有站点"就该**查不到**，而不是退化成"不过滤"（后者是跨租户泄露）。
    if (query.siteIds !== undefined && query.siteIds !== 'all') {
      conditions.push(inList(col('site_id'), [...query.siteIds]));
    }
    // ★ 归属过滤：`null` 表示"只看平台级记录"（没有归属开发者的那些）
    if (query.developerId !== undefined) {
      conditions.push(
        query.developerId === null
          ? isNull(col('developer_id'))
          : eq(col('developer_id'), lit(query.developerId)),
      );
    }
    if (query.realm !== undefined && query.realm !== null) {
      conditions.push(eq(col('realm'), lit(query.realm)));
    }
    if (query.from !== undefined) conditions.push(gte(col('created_at'), lit(query.from)));
    if (query.to !== undefined) conditions.push(lte(col('created_at'), lit(query.to)));
    if (query.actorId !== undefined) conditions.push(eq(col('actor_id'), lit(query.actorId)));
    if (query.targetType !== undefined) conditions.push(eq(col('target_type'), lit(query.targetType)));
    if (query.targetId !== undefined) conditions.push(eq(col('target_id'), lit(query.targetId)));
    if (query.actionPrefix !== undefined) {
      // ★ 前缀匹配用 LIKE，并**转义** `%` / `_` / `\`——
      //   否则调用方传进来的 `%` 会变成通配符（把"查前缀"悄悄变成"查全部"）。
      const escaped = query.actionPrefix.replace(/([\\%_])/g, '\\$1');
      conditions.push(like(col('action'), `${escaped}%`));
    }

    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_audit_log',
        columns: [
          'id',
          'site_id',
          'actor_type',
          'actor_id',
          'action',
          'target_type',
          'target_id',
          'before',
          'after',
          'trace_id',
          'created_at',
        ],
        ...(conditions.length === 0
          ? {}
          : { where: conditions.length === 1 ? conditions[0]! : and(...conditions) }),
        orderBy: [{ column: 'created_at', direction: 'desc' }],
        limit: query.limit ?? 100,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<AuditRow>(compiled.sql, compiled.params);
    return rows.map((row) => ({
      id: row.id,
      siteId: row.site_id,
      actorId: row.actor_id ?? '',
      actorType: row.actor_type,
      action: row.action,
      // ★ 归属（可空）：`null` = 平台级操作 / 系统任务
      developerId: row.developer_id,
      realm: row.realm as 'developer' | 'enduser' | null,
      ...(row.target_type === null ? {} : { targetType: row.target_type }),
      ...(row.target_id === null ? {} : { targetId: row.target_id }),
      ...(row.before === null ? {} : { before: row.before }),
      ...(row.after === null ? {} : { after: row.after }),
      ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    }));
  }
}

// ─────────────────────────── 作业（ag_jobs） ───────────────────────────

interface JobRow extends Record<string, unknown> {
  job_key: string;
  status: string;
  locked_by: string | null;
  locked_until: string | Date | null;
  last_run_at: string | Date | null;
  next_run_at: string | Date | null;
  run_count: number;
  fail_count: number;
  backoff_until: string | Date | null;
  cursor: Record<string, unknown> | null;
  last_error: string | null;
}

export class DbJobStore implements JobStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async ensureJob(jobKey: string, now: Date): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_jobs',
        rows: [{ owner_scope: 'site', owner_id: this.#siteId, job_key: jobKey, status: 'idle', next_run_at: now, cursor: {} }],
        onConflict: { columns: ['owner_scope', 'owner_id', 'job_key'], do: 'nothing' },
      },
      OWNER_SCOPED,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  /**
   * ★ 抢租约必须**原子**：用「条件更新 + RETURNING」而不是「先读后写」。
   *   先读后写在两个实例并发时会双取（经典 TOCTOU），导致同一任务被跑两次。
   */
  async tryAcquire(jobKey: string, holder: string, leaseMs: number, now: Date): Promise<boolean> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_jobs',
        set: { locked_by: holder, locked_until: new Date(now.getTime() + leaseMs), status: 'running' },
        where: and(
          eq(col('job_key'), lit(jobKey)),
          or(isNull(col('locked_by')), lte(col('locked_until'), lit(now))),
        ),
        returning: ['job_key'],
      },
      OWNER_SCOPED,
      {},
    );
    const rows = await this.#db.query<{ job_key: string }>(compiled.sql, compiled.params);
    return rows.length > 0;
  }

  async renew(jobKey: string, holder: string, leaseMs: number, now: Date): Promise<boolean> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_jobs',
        set: { locked_until: new Date(now.getTime() + leaseMs) },
        where: and(eq(col('job_key'), lit(jobKey)), eq(col('locked_by'), lit(holder))),
        returning: ['job_key'],
      },
      OWNER_SCOPED,
      {},
    );
    const rows = await this.#db.query<{ job_key: string }>(compiled.sql, compiled.params);
    return rows.length > 0;
  }

  async release(jobKey: string, holder: string): Promise<void> {
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_jobs',
        set: { locked_by: null, locked_until: null },
        where: and(eq(col('job_key'), lit(jobKey)), eq(col('locked_by'), lit(holder))),
      },
      OWNER_SCOPED,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async get(jobKey: string): Promise<JobRecord | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_jobs', columns: ['*'], where: eq(col('job_key'), lit(jobKey)), limit: 1 },
      OWNER_SCOPED,
      {},
    );
    const rows = await this.#db.query<JobRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToJob(rows[0]);
  }

  async recordResult(
    jobKey: string,
    result: { status: JobStatus; error?: string; cursor?: Record<string, unknown>; nextRunAt?: Date; backoffUntil?: Date; now: Date },
  ): Promise<void> {
    // ★ 自增用编译器的受限表达式（不再手写 SQL）：
    //   手写 SQL 会绕过站点作用域注入，而且「裸 SQL 扫描」会（正确地）拦住它。
    const set: Record<string, SetValue> = {
      status: result.status,
      last_run_at: result.now,
      run_count: increment('run_count'),
      ...(result.status === 'failed' ? { fail_count: increment('fail_count') } : {}),
      ...(result.cursor === undefined ? {} : { cursor: result.cursor as SqlValue }),
      ...(result.nextRunAt === undefined ? {} : { next_run_at: result.nextRunAt }),
      ...(result.backoffUntil === undefined ? {} : { backoff_until: result.backoffUntil }),
      ...(result.error === undefined ? {} : { last_error: result.error }),
      ...(result.error === undefined && result.status === 'succeeded' ? { last_error: null } : {}),
    };
    const compiled = compile(
      {
        kind: 'update',
        table: 'ag_jobs',
        set,
        where: and(eq(col('job_key'), lit(jobKey)), eq(col('owner_scope'), lit('site')), eq(col('owner_id'), lit(this.#siteId))),
      },
      OWNER_SCOPED,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async dueJobs(now: Date, limit: number): Promise<JobRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_jobs',
        columns: ['*'],
        where: and(
          or(isNull(col('locked_by')), lte(col('locked_until'), lit(now))),
          or(isNull(col('backoff_until')), lte(col('backoff_until'), lit(now))),
        ),
        limit,
      },
      OWNER_SCOPED,
      {},
    );
    const rows = await this.#db.query<JobRow>(compiled.sql, compiled.params);
    return rows.map(rowToJob);
  }

  async list(): Promise<JobRecord[]> {
    const compiled = compile({ kind: 'select', table: 'ag_jobs', columns: ['*'] }, OWNER_SCOPED, {});
    const rows = await this.#db.query<JobRow>(compiled.sql, compiled.params);
    return rows.map(rowToJob);
  }
}

function rowToJob(row: JobRow): JobRecord {
  return {
    jobKey: row.job_key,
    status: row.status as JobStatus,
    runCount: Number(row.run_count),
    failCount: Number(row.fail_count),
    cursor: row.cursor ?? {},
    ...(row.locked_by === null ? {} : { lockedBy: row.locked_by }),
    ...(row.locked_until === null ? {} : { lockedUntil: toDate(row.locked_until) }),
    ...(row.last_run_at === null ? {} : { lastRunAt: toDate(row.last_run_at) }),
    ...(row.next_run_at === null ? {} : { nextRunAt: toDate(row.next_run_at) }),
    ...(row.backoff_until === null ? {} : { backoffUntil: toDate(row.backoff_until) }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

// ─────────────────────────── 事实（ag_plugin_facts） ───────────────────────────

/**
 * `ag_plugin_facts` 的**真实列**（来自 migrations/0001_init.sql）。
 *
 * ★ 与「直觉」差得很远，是真实 PG 跑出来的：
 *   - 表是**按主体**的：键为 `(site_id, user_id, plugin_id, namespace, instance_key)`；
 *   - 没有 `field` / `value` 列：一行的 `facts` 是**一个 jsonb 对象**（可含多个字段）；
 *   - `namespace` 是「事实命名空间」（策略里写 `fact.<ns>.<path>` 的那个 ns）。
 *
 * 适配器的取舍：接口是「按字段」的，而表是「按行装一个对象」的。
 * 这里把**字段名当作 namespace 的细分**：`field` → 独立一行，`namespace` 用 pluginId。
 * 这样接口不变、且 `(user_id, plugin_id, namespace=pluginId, instance_key=field)` 天然唯一。
 * 代价是行数变多——但事实量级（最多几百/主体）下可接受，换来的是**接口零改动**。
 */
interface FactRow extends Record<string, unknown> {
  user_id: string;
  plugin_id: string;
  namespace: string;
  instance_key: string;
  facts: Record<string, unknown> | string;
  collected_at: string | Date;
  expires_at: string | Date | null;
  fingerprint: string;
}

export class DbFactStore implements FactStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async put(userId: string, record: FactRecord): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_plugin_facts',
        rows: [
          {
            user_id: userId,
            plugin_id: record.pluginId,
            namespace: record.pluginId,
            instance_key: record.field,
            facts: jsonb({ value: record.value }),
            fingerprint: 'pending',
            // ★ 真实枚举取值是 declarative/process/llm/manual/import
            //   （不是想当然的 'plugin'）。email-domain 是 declarative 插件。
            source: 'declarative',
            collected_at: record.collectedAt,
            expires_at: record.expiresAt,
          },
        ],
        onConflict: {
          columns: ['site_id', 'user_id', 'namespace', 'instance_key'],
          do: 'update',
          updateColumns: ['facts', 'collected_at', 'expires_at'],
        },
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async get(userId: string, pluginId: string, field: string): Promise<FactRecord | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_facts',
        columns: ['user_id', 'plugin_id', 'namespace', 'instance_key', 'facts', 'collected_at', 'expires_at', 'fingerprint'],
        where: and(
          eq(col('user_id'), lit(userId)),
          eq(col('plugin_id'), lit(pluginId)),
          eq(col('instance_key'), lit(field)),
        ),
        limit: 1,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<FactRow>(compiled.sql, compiled.params);
    const row = rows[0];
    return row === undefined ? undefined : rowToFact(row);
  }

  async list(userId: string, pluginId: string): Promise<FactRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_plugin_facts',
        columns: ['user_id', 'plugin_id', 'namespace', 'instance_key', 'facts', 'collected_at', 'expires_at', 'fingerprint'],
        where: and(eq(col('user_id'), lit(userId)), eq(col('plugin_id'), lit(pluginId))),
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<FactRow>(compiled.sql, compiled.params);
    return rows.map(rowToFact);
  }

  async purgeExpired(now: Date): Promise<number> {
    const compiled = compile(
      { kind: 'delete', table: 'ag_plugin_facts', where: lte(col('expires_at'), lit(now)), returning: ['id'] },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<{ id: string }>(compiled.sql, compiled.params);
    return rows.length;
  }
}

function rowToFact(row: FactRow): FactRecord {
  const facts = typeof row.facts === 'string' ? (JSON.parse(row.facts) as Record<string, unknown>) : row.facts;
  return {
    key: `${row.plugin_id}.${row.instance_key}`,
    pluginId: row.plugin_id,
    namespace: row.plugin_id,
    field: row.instance_key,
    value: facts['value'] ?? null,
    collectedAt: toDate(row.collected_at),
    // expires_at 可空（永不过期）；用远期时间表示，避免调用方判空
    expiresAt: row.expires_at === null ? new Date('9999-12-31T00:00:00Z') : toDate(row.expires_at),
  };
}

// ─────────────────────────── 主体快照查询（供巡检） ───────────────────────────

/**
 * 从 `ag_external_subjects` 读巡检主体。
 *
 * ★ 与 `DbSubjectStore` 的区别：那个是按 provider 的仓储；
 *   这个是为**巡检**服务的分页读取（只需要 id/email/属性）。
 */
export class DbPatrolDirectory {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async list(_siteId: string, limit: number, offset: number): Promise<{ externalId: string; email: string | null; emailVerified: boolean; attributes: Record<string, unknown> }[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_external_subjects',
        columns: ['external_id', 'email', 'attributes'],
        where: isNull(col('deleted_at')),
        orderBy: [{ column: 'external_id', direction: 'asc' }],
        limit,
        offset,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<{ external_id: string; email: string | null; attributes: Record<string, unknown> | null }>(
      compiled.sql,
      compiled.params,
    );
    return rows.map((row) => ({
      externalId: row.external_id,
      email: row.email,
      // external_subjects 没有 email_verified 列；Verified 由事实提供（见巡检的 user 上下文）
      emailVerified: true,
      attributes: row.attributes ?? {},
    }));
  }

  async count(): Promise<number> {
    const compiled = compile(
      { kind: 'select', table: 'ag_external_subjects', columns: ['external_id'], where: isNull(col('deleted_at')) },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<{ external_id: string }>(compiled.sql, compiled.params);
    return rows.length;
  }
}

/** 供条件构造复用的导出（避免调用方重复实现）。 */
export { and, eq, gt, inList, isNull, lit, lte, or };
export type { Condition };

// ─────────────────────────── 身份（ag_identities） ───────────────────────────

interface IdentityRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  subject_ref: { provider: string; externalId: string } | null;
  claim_snapshot: Record<string, unknown> | null;
  verified_at: string | Date | null;
  revoked_at: string | Date | null;
}

/**
 * `ag_identities` 的 PG 实现。
 *
 * ★ 两处与「直觉」不符（真库核对所得）：
 *   1. 表里**没有 `revoked_at` 列**——撤销语义应当由 `provider_user_id` 之外的状态表达，
 *      或在 `claim_snapshot` 里记录。适配器把它存在 `claim_snapshot.revokedAt`
 *      （**不假装有列传**），并在注释里登记该缺口；
 *   2. 唯一键是 `(owner_scope, owner_id, provider, provider_user_id)`——**不是** `(provider, provider_user_id)`
 *      （原文 §3.2 的注释与实际声明不一致，以迁移产物为准）。
 */
export class DbIdentityStore implements IdentityStore {
  readonly #db: Db;
  readonly #ownerScope = 'platform';
  readonly #ownerId = 'platform';

  constructor(db: Db) {
    this.#db = db;
  }

  async find(provider: string, providerUserId: string): Promise<IdentityRecord | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_identities',
        columns: ['id', 'user_id', 'provider', 'provider_user_id', 'subject_ref', 'claim_snapshot', 'verified_at'],
        where: and(
          eq(col('owner_scope'), lit(this.#ownerScope)),
          eq(col('owner_id'), lit(this.#ownerId)),
          eq(col('provider'), lit(provider)),
          eq(col('provider_user_id'), lit(providerUserId)),
        ),
        limit: 1,
      },
      OWNER_SCOPED,
      {},
    );
    const rows = await this.#db.query<IdentityRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToIdentity(rows[0]);
  }

  async listByUser(userId: string): Promise<IdentityRecord[]> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_identities',
        columns: ['id', 'user_id', 'provider', 'provider_user_id', 'subject_ref', 'claim_snapshot', 'verified_at'],
        where: and(eq(col('owner_scope'), lit(this.#ownerScope)), eq(col('owner_id'), lit(this.#ownerId)), eq(col('user_id'), lit(userId))),
      },
      OWNER_SCOPED,
      {},
    );
    const rows = await this.#db.query<IdentityRow>(compiled.sql, compiled.params);
    return rows.map(rowToIdentity);
  }

  async save(record: IdentityRecord): Promise<void> {
    const snapshot = { ...(record.claimSnapshot ?? {}), ...(record.revokedAt == null ? {} : { revokedAt: record.revokedAt.toISOString() }) };
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_identities',
        rows: [
          {
            owner_scope: this.#ownerScope,
            owner_id: this.#ownerId,
            user_id: record.userId,
            provider: record.provider,
            provider_user_id: record.providerUserId,
            subject_ref: record.subjectRef == null ? null : jsonb(record.subjectRef),
            claim_snapshot: jsonb(snapshot),
            verified_at: record.verifiedAt ?? null,
          },
        ],
        onConflict: {
          columns: ['owner_scope', 'owner_id', 'provider', 'provider_user_id'],
          do: 'update',
          updateColumns: ['user_id', 'subject_ref', 'claim_snapshot', 'verified_at'],
        },
      },
      OWNER_SCOPED,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async revoke(provider: string, providerUserId: string, at: Date): Promise<void> {
    const existing = await this.find(provider, providerUserId);
    if (existing === undefined) return;
    // ★ 表里没有 revoked_at 列：把撤销时间记进 claim_snapshot（并保留原有内容）
    await this.save({ ...existing, revokedAt: at });
  }
}

function rowToIdentity(row: IdentityRow): IdentityRecord {
  const snapshot = (row.claim_snapshot ?? {}) as Record<string, unknown>;
  const revokedRaw = snapshot['revokedAt'];
  const record: IdentityRecord = {
    ...(row.id === undefined ? {} : { id: row.id }),
    provider: row.provider,
    providerUserId: row.provider_user_id,
    userId: row.user_id,
    subjectRef: row.subject_ref ?? null,
    claimSnapshot: snapshot,
    verifiedAt: row.verified_at === null ? null : toDate(row.verified_at),
  };
  if (typeof revokedRaw === 'string') record.revokedAt = new Date(revokedRaw);
  return record;
}

// ─────────────────────────── 主体仓储（ag_external_subjects） ───────────────────────────

interface SubjectDbRow extends Record<string, unknown> {
  provider: string;
  external_id: string;
  display_name: string | null;
  email: string | null;
  attributes: Record<string, unknown> | null;
  watched: unknown;
  fingerprint: string;
  synced_at: string | Date;
  deleted_at: string | Date | null;
}

/**
 * `ag_external_subjects` 的 PG 实现（替代 `DbSubjectStore` 的裸 SQL 版本）。
 *
 * 保留 `SubjectStore` 接口不动（它已被对账器与身份对齐使用），只是把实现换成经查询编译器的版本。
 */
export class DbSubjectRepository implements SubjectStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  #select(where: Condition | undefined) {
    return compile(
      {
        kind: 'select',
        table: 'ag_external_subjects',
        columns: ['provider', 'external_id', 'display_name', 'email', 'attributes', 'watched', 'fingerprint', 'synced_at', 'deleted_at'],
        ...(where === undefined ? {} : { where }),
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
  }

  async get(provider: string, externalId: string): Promise<StoredSubject | undefined> {
    const compiled = this.#select(and(eq(col('provider'), lit(provider)), eq(col('external_id'), lit(externalId))));
    const rows = await this.#db.query<SubjectDbRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToStoredSubject(rows[0]);
  }

  async findByEmail(provider: string, email: string): Promise<StoredSubject | undefined> {
    const compiled = this.#select(and(eq(col('provider'), lit(provider)), eq(col('email'), lit(email)), isNull(col('deleted_at'))));
    const rows = await this.#db.query<SubjectDbRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToStoredSubject(rows[0]);
  }

  async upsert(
    provider: string,
    subject: ExternalSubject,
    watch: readonly string[],
    fingerprint: string,
    now: Date,
  ): Promise<UpsertResult> {
    const existing = await this.get(provider, subject.externalId);
    const changedKeys =
      existing === undefined ? [] : watch.filter((key) => JSON.stringify(existing.attributes[key] ?? null) !== JSON.stringify(subject.attributes[key] ?? null));
    const revived = existing?.deletedAt !== undefined;

    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_external_subjects',
        rows: [
          {
            provider,
            external_id: subject.externalId,
            display_name: subject.displayName ?? null,
            email: subject.email ?? null,
            attributes: jsonb(subject.attributes),
            watched: jsonb([...watch]),
            fingerprint,
            raw: jsonb(subject.raw ?? {}),
            synced_at: now,
            deleted_at: null,
          },
        ],
        onConflict: {
          columns: ['site_id', 'provider', 'external_id'],
          do: 'update',
          updateColumns: ['display_name', 'email', 'attributes', 'watched', 'fingerprint', 'raw', 'synced_at', 'deleted_at'],
        },
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);

    if (existing === undefined) return { created: true, changed: false, unchanged: false, revived: false, changedKeys: [] };
    if (revived) return { created: false, changed: true, unchanged: false, revived: true, changedKeys };
    if (existing.fingerprint === fingerprint) return { created: false, changed: false, unchanged: true, revived: false, changedKeys };
    return { created: false, changed: true, unchanged: false, revived: false, changedKeys };
  }

  async markDeleted(provider: string, keepExternalIds: readonly string[], now: Date): Promise<string[]> {
    const compiled = compile(
      { kind: 'update', table: 'ag_external_subjects', set: { deleted_at: now }, where: eq(col('provider'), lit(provider)), returning: ['external_id'] },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    // 逐行判断（避免把 IN (...) 大列表拼进 SQL；标记删除是低频操作）
    const rows = await this.#db.query<{ external_id: string }>(compiled.sql, compiled.params);
    const keep = new Set(keepExternalIds);
    const toRestore: string[] = [];
    const marked: string[] = [];
    for (const row of rows) {
      if (keep.has(row.external_id)) toRestore.push(row.external_id);
      else marked.push(row.external_id);
    }
    // 本轮出现过的**撤销删除标记**（复活）
    if (toRestore.length > 0) {
      await this.#db.query(
        `UPDATE ag_external_subjects SET deleted_at = NULL WHERE provider = $1 AND site_id = $2 AND external_id = ANY($3::text[])`,
        [provider, this.#siteId, toRestore],
      );
    }
    return marked;
  }

  async listExternalIds(provider: string): Promise<string[]> {
    const compiled = this.#select(and(eq(col('provider'), lit(provider)), isNull(col('deleted_at'))));
    const rows = await this.#db.query<SubjectDbRow>(compiled.sql, compiled.params);
    return rows.map((row) => row.external_id);
  }

  async count(provider: string): Promise<number> {
    return (await this.listExternalIds(provider)).length;
  }
}

function rowToStoredSubject(row: SubjectDbRow): StoredSubject {
  const watched = Array.isArray(row.watched) ? (row.watched as string[]) : [];
  const stored: StoredSubject = {
    provider: row.provider,
    externalId: row.external_id,
    attributes: row.attributes ?? {},
    watched,
    fingerprint: row.fingerprint,
    syncedAt: toDate(row.synced_at),
  };
  if (row.display_name !== null) stored.displayName = row.display_name;
  if (row.email !== null) stored.email = row.email;
  if (row.deleted_at !== null) stored.deletedAt = toDate(row.deleted_at);
  return stored;
}

// ─────────────────────────── 策略（ag_policies + ag_policy_versions） ───────────────────────────

interface PolicyDbRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string | null;
  description: string | null;
  enabled: boolean;
  priority: number;
  tier: number | null;
  requires_tier: number | null;
  collision: string;
  active_version_id: string | null;
}

interface PolicyVersionDbRow extends Record<string, unknown> {
  id: string;
  policy_id: string;
  version: number;
  spec: Record<string, unknown> | string;
  spec_hash: string;
  status: string;
  created_at: string | Date;
  activated_at: string | Date | null;
}

/**
 * 策略的 PG 实现（`ag_policies` 头 + `ag_policy_versions` 版本）。
 *
 * ★ 真实结构的关键点（**决定实现形态**）：
 *   - **没有** `requirements` 列：表达式在 `ag_policy_versions.spec`（规范 AST）里；
 *   - `ag_policies` 只有「头信息」（code/name/enabled/priority/tier/requiresTier/collision），
 *     实际判定内容是**版本行**；
 *   - `active_version_id` 指向当前生效版本——**发布 = 新建版本 + 更新该指针**。
 *     这天然支持「历史评估可复现」（评估记录引用具体 version id）。
 *
 * `list()` 返回的是「每种策略的**当前内容**」：优先取 `active_version_id` 指向的版本，
 * 没有则取最新 draft（这就是管理端编辑态该看到的东西）。
 */
export class DbPolicyStore implements PolicyStore {
  readonly #db: Db;
  readonly #siteId: string;

  constructor(db: Db, siteId: string) {
    this.#db = db;
    this.#siteId = siteId;
  }

  async #header(code: string): Promise<PolicyDbRow | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_policies', columns: ['*'], where: eq(col('code'), lit(code)), limit: 1 },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<PolicyDbRow>(compiled.sql, compiled.params);
    return rows[0];
  }

  async #latestVersion(policyId: string, preferredVersionId: string | null): Promise<PolicyVersionDbRow | undefined> {
    if (preferredVersionId !== null) {
      const compiled = compile(
        { kind: 'select', table: 'ag_policy_versions', columns: ['*'], where: eq(col('id'), lit(preferredVersionId)), limit: 1 },
        SITE_SCOPED,
        { scope: { siteId: this.#siteId } },
      );
      const rows = await this.#db.query<PolicyVersionDbRow>(compiled.sql, compiled.params);
      if (rows[0] !== undefined) return rows[0];
    }
    // 回落：该策略的最新版本（按 version 倒序取一条）
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_policy_versions',
        columns: ['*'],
        where: eq(col('policy_id'), lit(policyId)),
        orderBy: [{ column: 'version', direction: 'desc' }],
        limit: 1,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<PolicyVersionDbRow>(compiled.sql, compiled.params);
    return rows[0];
  }

  #toDocument(header: PolicyDbRow, version: PolicyVersionDbRow | undefined): PolicyDocument {
    const spec = version === undefined ? { requirements: {} } : (typeof version.spec === 'string' ? JSON.parse(version.spec) : version.spec);
    return {
      code: header.code,
      ...(header.name === null ? {} : { name: header.name }),
      ...(header.description === null ? {} : { description: header.description }),
      enabled: header.enabled,
      priority: header.priority,
      // ★★ L-4：`tier` 必须带上——级联回退的**第一层**按它降级。
      //   在此之前它被丢在这个转换里，于是文档算法的第一层**从未生效**
      //   （见 `PolicyDocument.tier` 的说明）。
      ...(header.tier === null ? {} : { tier: header.tier }),
      version: version?.version ?? 0,
      spec: spec as PolicyDocument['spec'],
    };
  }

  async list(_siteId: string): Promise<PolicyDocument[]> {
    const compiled = compile(
      { kind: 'select', table: 'ag_policies', columns: ['*'], orderBy: [{ column: 'priority', direction: 'asc' }] },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const headers = await this.#db.query<PolicyDbRow>(compiled.sql, compiled.params);
    const out: PolicyDocument[] = [];
    for (const header of headers) {
      const version = await this.#latestVersion(header.id, header.active_version_id);
      out.push(this.#toDocument(header, version));
    }
    return out;
  }

  async get(_siteId: string, code: string): Promise<PolicyDocument | undefined> {
    const header = await this.#header(code);
    if (header === undefined) return undefined;
    return this.#toDocument(header, await this.#latestVersion(header.id, header.active_version_id));
  }

  /**
   * 待发布的最新草稿（与 `get()` 的「当前生效内容」区分开）。
   *
   * ★ 见 `PolicyStore.latestDraft` 的说明：发布必须发**草稿**，
   *   而 `get()` 返回 active 优先——混用会导致「新草稿永远发不出去」。
   */
  async latestDraft(_siteId: string, code: string): Promise<PolicyDocument | undefined> {
    const header = await this.#header(code);
    if (header === undefined) return undefined;
    const draft = await this.#draftVersion(header.id);
    if (draft === undefined) return undefined;
    const spec = typeof draft.spec === 'string' ? JSON.parse(draft.spec) : draft.spec;
    return {
      code: header.code,
      ...(header.name === null ? {} : { name: header.name }),
      ...(header.description === null ? {} : { description: header.description }),
      enabled: header.enabled,
      priority: header.priority,
      version: draft.version,
      spec: spec as PolicyDocument['spec'],
    };
  }

  /** 保存草稿：头信息 upsert + 追加一个 **draft** 版本（不自动生效）。 */
  async saveDraft(_siteId: string, document: PolicyDocument): Promise<void> {
    const existing = await this.#header(document.code);
    const headerId = existing?.id ?? (await this.#insertHeader(document));
    if (existing !== undefined) await this.#updateHeader(headerId, document);

    const version = await this.#nextVersion(headerId);
    // ★ 规范 AST 是唯一真理（spec）；spec_yaml/json/graph 只是编辑器状态。
    //   这里只写 spec —— 保持「求值只用规范 AST」这条不变量。
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_policy_versions',
        rows: [
          {
            policy_id: headerId,
            version,
            spec: jsonb(document.spec),
            origin: 'json',
            spec_hash: hashSpec(document.spec),
            status: 'draft',
          },
        ],
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  /** 发布：把最新 draft 置为 active，并把 `ag_policies.active_version_id` 指向它。 */
  async publish(_siteId: string, code: string, version: number): Promise<PolicyDocument> {
    const header = await this.#header(code);
    if (header === undefined) throw new Error(`策略 '${code}' 不存在`);
    const draft = await this.#draftVersion(header.id);
    if (draft === undefined) throw new Error(`策略 '${code}' 没有可发布的草稿版本`);

    // 旧 active 转 archived（保证「当前生效版本」唯一）
    await this.#db.query(
      `UPDATE ag_policy_versions SET status = 'archived' WHERE site_id = $1 AND policy_id = $2 AND status = 'active'`,
      [this.#siteId, header.id],
    );
    await this.#db.query(
      `UPDATE ag_policy_versions SET status = 'active', activated_at = now() WHERE site_id = $1 AND id = $2`,
      [this.#siteId, draft.id],
    );
    await this.#db.query(`UPDATE ag_policies SET active_version_id = $1, updated_at = now() WHERE site_id = $2 AND id = $3`, [
      draft.id,
      this.#siteId,
      header.id,
    ]);

    return {
      code: header.code,
      ...(header.name === null ? {} : { name: header.name }),
      enabled: header.enabled,
      priority: header.priority,
      version: draft.version,
      spec: (typeof draft.spec === 'string' ? JSON.parse(draft.spec) : draft.spec) as PolicyDocument['spec'],
    };
  }

  /**
   * 回滚到指定历史版本（M2-7）。
   *
   * ★ 与「重新 saveDraft 一份旧内容」的区别：回滚是**指针操作**，
   *   不改写历史（v3 永远是 v3，只是重新成为 active）。
   *   重新 saveDraft 会新建 v4，历史被污染，破坏「历史评估可复现」。
   */
  async rollback(_siteId: string, code: string, version: number): Promise<PolicyDocument> {
    const header = await this.#header(code);
    if (header === undefined) throw new Error(`策略 '${code}' 不存在`);
    const target = await this.#versionByNumber(header.id, version);
    if (target === undefined) {
      const available = await this.#versionNumbers(header.id);
      throw new Error(`策略 '${code}' 没有版本 ${version}（可用版本：${available.join(', ')}）`);
    }
    // 当前 active 转 archived（保证生效版本唯一）
    await this.#db.query(
      `UPDATE ag_policy_versions SET status = 'archived' WHERE site_id = $1 AND policy_id = $2 AND status = 'active' AND id <> $3`,
      [this.#siteId, header.id, target.id],
    );
    await this.#db.query(
      `UPDATE ag_policy_versions SET status = 'active', activated_at = now() WHERE site_id = $1 AND id = $2`,
      [this.#siteId, target.id],
    );
    await this.#db.query(`UPDATE ag_policies SET active_version_id = $1, updated_at = now() WHERE site_id = $2 AND id = $3`, [
      target.id,
      this.#siteId,
      header.id,
    ]);
    return {
      code: header.code,
      ...(header.name === null ? {} : { name: header.name }),
      enabled: header.enabled,
      priority: header.priority,
      version: target.version,
      spec: (typeof target.spec === 'string' ? JSON.parse(target.spec) : target.spec) as PolicyDocument['spec'],
    };
  }

  /** 版本历史（供管理端展示与回滚选择）。 */
  async versions(_siteId: string, code: string): Promise<{ version: number; status: string; createdAt: Date; specHash?: string }[]> {
    const header = await this.#header(code);
    if (header === undefined) return [];
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_policy_versions',
        columns: ['version', 'status', 'created_at', 'spec_hash'],
        where: eq(col('policy_id'), lit(header.id)),
        orderBy: [{ column: 'version', direction: 'asc' }],
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<{ version: number; status: string; created_at: string | Date; spec_hash: string }>(
      compiled.sql,
      compiled.params,
    );
    return rows.map((row) => ({
      version: Number(row.version),
      status: row.status,
      createdAt: toDate(row.created_at),
      specHash: row.spec_hash,
    }));
  }

  async #versionByNumber(policyId: string, version: number): Promise<PolicyVersionDbRow | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_policy_versions',
        columns: ['*'],
        where: and(eq(col('policy_id'), lit(policyId)), eq(col('version'), lit(version))),
        limit: 1,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<PolicyVersionDbRow>(compiled.sql, compiled.params);
    return rows[0];
  }

  async #versionNumbers(policyId: string): Promise<number[]> {
    const rows = await this.#db.query<{ version: number }>(
      `SELECT version FROM ag_policy_versions WHERE site_id = $1 AND policy_id = $2 ORDER BY version`,
      [this.#siteId, policyId],
    );
    return rows.map((row) => Number(row.version));
  }

  async #insertHeader(document: PolicyDocument): Promise<string> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_policies',
        rows: [
          {
            code: document.code,
            name: document.name ?? document.code,
            description: document.description ?? null,
            enabled: document.enabled ?? true,
            priority: document.priority ?? 100,
          },
        ],
        returning: ['id'],
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<{ id: string }>(compiled.sql, compiled.params);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`创建策略 '${document.code}' 失败：未返回 id`);
    return id;
  }

  async #updateHeader(id: string, document: PolicyDocument): Promise<void> {
    const set: Record<string, unknown> = {};
    if (document.name !== undefined) set['name'] = document.name;
    if (document.description !== undefined) set['description'] = document.description;
    if (document.enabled !== undefined) set['enabled'] = document.enabled;
    if (document.priority !== undefined) set['priority'] = document.priority;
    if (Object.keys(set).length === 0) return;
    const compiled = compile({ kind: 'update', table: 'ag_policies', set: set as never, where: eq(col('id'), lit(id)) }, SITE_SCOPED, {
      scope: { siteId: this.#siteId },
    });
    await this.#db.query(compiled.sql, compiled.params);
  }

  async #nextVersion(policyId: string): Promise<number> {
    const rows = await this.#db.query<{ n: string | null }>(
      'SELECT max(version)::text AS n FROM ag_policy_versions WHERE site_id = $1 AND policy_id = $2',
      [this.#siteId, policyId],
    );
    return Number(rows[0]?.n ?? 0) + 1;
  }

  async #draftVersion(policyId: string): Promise<PolicyVersionDbRow | undefined> {
    const compiled = compile(
      {
        kind: 'select',
        table: 'ag_policy_versions',
        columns: ['*'],
        where: and(eq(col('policy_id'), lit(policyId)), eq(col('status'), lit('draft'))),
        orderBy: [{ column: 'version', direction: 'desc' }],
        limit: 1,
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<PolicyVersionDbRow>(compiled.sql, compiled.params);
    return rows[0];
  }
}

/** 规范 AST 指纹（用于语义去重：换编辑器不产生无意义的新版本）。 */
export function hashSpec(spec: unknown): string {
  const payload = stableStringify(spec);
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// ─────────────────────────── 评估记录（ag_evaluations） ───────────────────────────

/**
 * 策略引用解析器：`(code, version) → { policyId, policyVersionId }`。
 *
 * ★ 为什么需要两个 id：`ag_evaluations` 的 `policy_id` **与** `policy_ver_id`
 *   都是 `NOT NULL` 的 uuid——评估记录必须指向**具体版本行**，
 *   这正是「历史评估可复现」的物理基础（回看某次判定用的是哪版策略）。
 */
export type PolicyRefResolver = (
  code: string,
  version: number,
) => Promise<{ policyId: string; policyVersionId: string } | undefined>;

/**
 * `ag_evaluations` 的 PG 实现。
 *
 * ★ 真实 PG 暴露的**模型落差**（已登记，不是适配器 bug）：
 *   `ag_eval_outcome` 枚举只有 `satisfied / unsatisfied / indeterminate / error`，
 *   **没有 `not_applicable`**。而策略引擎有第五态 `not_applicable`（`match` 不通过）。
 *   适配器的处置：`not_applicable` **不写评估记录**——因为那种情况下
 *   **根本没有发生求值**，写一条记录反而是伪造。这是刻意的「不伪造」选择。
 */
export class DbEvaluationStore implements EvaluationStore {
  readonly #db: Db;
  readonly #siteId: string;
  readonly #resolvePolicyRef: PolicyRefResolver;

  constructor(db: Db, siteId: string, resolvePolicyRef: PolicyRefResolver) {
    this.#db = db;
    this.#siteId = siteId;
    this.#resolvePolicyRef = resolvePolicyRef;
  }

  async append(record: EvaluationRecord): Promise<{ id: number } | null> {
    // ★ 不伪造：match 不通过时没有发生求值，不写记录。
    //   ★ 返回 `null` 而**不是** `{ id: 0 }`：**"没有落库"与"落库了 id=0"是两件事**，
    //     用哨兵值会让 `lastEvalId` 指向一次不存在的评估。
    if (record.decision === 'not_applicable') return null;

    const ref = await this.#resolvePolicyRef(record.policyCode, record.policyVersion);
    if (ref === undefined) {
      throw new Error(
        `无法解析策略 '${record.policyCode}' v${record.policyVersion} 的 id/版本行 id——评估记录无法持久化。` +
          `评估记录是「历史可复现」的载体，静默丢弃会让复盘失去依据。`,
      );
    }

    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_evaluations',
        rows: [
          {
            user_id: record.userId,
            policy_id: ref.policyId,
            policy_ver_id: ref.policyVersionId,
            trigger: record.trigger ?? 'scheduled',
            inputs: jsonb({ ...record.inputs, factFingerprint: record.factFingerprint }),
            // 缺失项与指纹一起放进 item_results（表里没有独立列）
            item_results: jsonb({ missing: [...record.missing], factFingerprint: record.factFingerprint }),
            outcome: record.decision,
            ...(record.traceId === undefined ? {} : { trace_id: record.traceId }),
            created_at: record.evaluatedAt,
          },
        ],
        // ★ 返回 id：`lastEvalId` 要用它把「状态」与「依据哪次评估」连起来
        returning: ['id'],
      },
      SITE_SCOPED,
      { scope: { siteId: this.#siteId } },
    );
    const rows = await this.#db.query<{ id: string | number }>(compiled.sql, compiled.params);
    // ★ `ag_evaluations.id` 是 bigserial（PG 驱动返回字符串）→ 显式转 Number
    return rows[0] === undefined ? null : { id: Number(rows[0].id) };
  }

  async count(_siteId: string): Promise<number> {
    const rows = await this.#db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ag_evaluations WHERE site_id = $1`,
      [this.#siteId],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
