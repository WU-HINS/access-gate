/**
 * 设备码挑战的 PG 适配器（`ag_verify_challenges`）—— 架构缺口修复（第 4 个）。
 *
 * ★★ 为什么必须持久化（此前只有内存实现）：
 *
 *   设备码是**跨请求、跨实例**的协议：
 *   `/device/authorize`（客户端拿 challenge）→ 用户在浏览器输入 userCode 并确认
 *   → `/device/token`（客户端**轮询**换 token）。
 *
 *   内存实现下：
 *   · **多实例** → 轮询请求被负载均衡到别的实例 → `challenge_id` 找不到 → **授权永远完不成**；
 *   · **重启** → 进行中的设备授权全部失效。
 *
 * ★ 表的两处「代码有、表没有」（R64 补入 `docs/02`）：
 *   · `deliveries` —— 已向轮询方交付过几次断言（**决定能否重复换 token**）；
 *   · `lastPolledAt` —— 最近轮询时间（诊断「客户端是否在轮询」）。
 *
 * ★ `findByUserCode` 的归一化：内存实现把 `normalizeUserCode` 的结果当 Map key；
 *   PG 实现**存归一化后的值**（同一个函数），这样两边的语义一致——
 *   否则「用户输入 `abcd-1234`」在内存能查到、在 PG 查不到（本会话反复出现的语义漂移）。
 */

import type { Db } from './pool.ts';
import { compile, type TableScopeMeta } from '../query/compile.ts';
import { col, eq, lit } from '../query/ast.ts';
import { reuseOrBeginTransaction } from './tx.ts';
import { normalizeUserCode, type Challenge, type ChallengeStore, type ChallengeStatus } from '../verify/device-code.ts';

const PLATFORM: TableScopeMeta = { siteScoped: false, hasSiteIdColumn: false };

interface ChallengeRow extends Record<string, unknown> {
  challenge_id: string;
  user_code: string;
  client_id: string;
  subject_type: string;
  subject_value: string;
  scopes: unknown;
  status: string;
  user_id: string | null;
  approved_at: string | Date | null;
  expires_at: string | Date;
  deliveries: number;
  last_polled_at: string | Date | null;
  created_at: string | Date;
}

const COLUMNS = [
  'challenge_id', 'user_code', 'client_id', 'subject_type', 'subject_value', 'scopes',
  'status', 'user_id', 'approved_at', 'expires_at', 'deliveries', 'last_polled_at', 'created_at',
];

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return [];
}

function toDate(value: string | Date | null): Date | null {
  return value === null ? null : new Date(value);
}

function rowToChallenge(row: ChallengeRow): Challenge {
  return {
    challengeId: row.challenge_id,
    userCode: row.user_code,
    clientId: row.client_id,
    subject: { type: row.subject_type, value: row.subject_value },
    scopes: toArray(row.scopes),
    status: row.status as ChallengeStatus,
    userId: row.user_id,
    approvedAt: toDate(row.approved_at),
    expiresAt: new Date(row.expires_at as string),
    deliveries: row.deliveries,
    lastPolledAt: toDate(row.last_polled_at),
    createdAt: new Date(row.created_at as string),
  };
}

export class DbChallengeStore implements ChallengeStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async save(challenge: Challenge): Promise<void> {
    const compiled = compile(
      {
        kind: 'insert',
        table: 'ag_verify_challenges',
        rows: [
          {
            owner_scope: 'platform',
            owner_id: 'platform',
            challenge_id: challenge.challengeId,
            // ★ 存**归一化**后的 userCode（与内存实现的 Map key 同一函数）
            user_code: normalizeUserCode(challenge.userCode),
            client_id: challenge.clientId,
            subject_type: challenge.subject.type,
            subject_value: challenge.subject.value,
            scopes: JSON.stringify([...challenge.scopes]),
            status: challenge.status,
            user_id: challenge.userId,
            approved_at: challenge.approvedAt,
            expires_at: challenge.expiresAt,
            deliveries: challenge.deliveries,
            last_polled_at: challenge.lastPolledAt,
            created_at: challenge.createdAt,
          },
        ],
        returning: ['challenge_id'],
        // ★ 同一 challengeId 再次 save（如状态从 pending → approved）→ **更新**
        onConflict: {
          columns: ['challenge_id'],
          do: 'update',
          updateColumns: ['status', 'user_id', 'approved_at', 'deliveries', 'last_polled_at'],
        },
      },
      PLATFORM,
      {},
    );
    await this.#db.query(compiled.sql, compiled.params);
  }

  async get(challengeId: string): Promise<Challenge | undefined> {
    const compiled = compile(
      { kind: 'select', table: 'ag_verify_challenges', columns: COLUMNS, where: eq(col('challenge_id'), lit(challengeId)), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ChallengeRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToChallenge(rows[0]);
  }

  async findByUserCode(userCode: string): Promise<Challenge | undefined> {
    // ★ 用**同一个归一化函数**（大小写与分隔符已归一）——见文件头说明
    const compiled = compile(
      { kind: 'select', table: 'ag_verify_challenges', columns: COLUMNS, where: eq(col('user_code'), lit(normalizeUserCode(userCode))), limit: 1 },
      PLATFORM,
      {},
    );
    const rows = await this.#db.query<ChallengeRow>(compiled.sql, compiled.params);
    return rows[0] === undefined ? undefined : rowToChallenge(rows[0]);
  }
}

/** 自带事务的包装（真实 PG 模式下**必须**用它；已在外层事务时复用）。 */
export function createTransactionalChallengeStore(db: Db): ChallengeStore {
  const inner = new DbChallengeStore(db);
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => reuseOrBeginTransaction(db, fn);
  return {
    save: (challenge) => wrap(() => inner.save(challenge)),
    get: (challengeId) => wrap(() => inner.get(challengeId)),
    findByUserCode: (userCode) => wrap(() => inner.findByUserCode(userCode)),
  };
}
