/**
 * 全局审计与可见性（M7-9）—— docs/07 M7-9、docs/08 §2。
 *
 * ```
 *   审计记录的三个作用域维度：realm + developerId + siteId
 *     · admin      → 可见**全部**
 *     · developer  → 仅见**名下站点**
 *     · enduser    → 仅见**自己**的记录
 * ```
 *
 * ★ 验收标准（docs/07 M7-9 原文）：**「admin 可见全部；开发者仅见名下站点」**。
 *
 * ★ 为什么审计可见性必须**显式建模**而不是「查询时带个 where」：
 *   审计是**排障与追责**的依据。若可见性靠各调用点自觉拼条件，
 *   漏一处就是一次**跨租户信息泄露**——而泄露的是「谁在什么时候做了什么」，
 *   比泄露业务数据更敏感（它暴露了另一个租户的运营活动）。
 *
 * ★ 另一条容易被忽略的规则：**可见性判定要看记录的归属，而不是查询者的当前站点**。
 *   开发者在站点 A 的上下文里，也**不该**看到站点 B 的审计（即使都是他名下）——
 *   否则「站点是隔离边界」这句话在审计这一面就不成立。
 */

// ─────────────────────────── 类型 ───────────────────────────

export interface AuditRecordScope {
  /** 记录发生在哪个站点（平台级操作为 null） */
  siteId: string | null;
  /** 记录归属于哪个开发者（平台级操作为 null） */
  developerId: string | null;
  /**
   * 记录所在的身份域。
   *
   * ★ 可空：**系统任务**（`actorType='job'`）不属于任何身份域。
   *   判定逻辑当前不读它（只读 `actorId` / `developerId`），但类型必须允许 `null` ——
   *   否则落库的 `null` 会被迫在映射时编一个域，那才是真正的语义污染。
   */
  realm: 'developer' | 'enduser' | null;
  /** 操作者（用于「仅见自己」的判定） */
  actorId: string;
}

export interface AuditViewer {
  userId: string;
  realm: 'developer' | 'enduser';
  role: 'admin' | 'developer' | 'user';
  /** 查看者名下的开发者 id（developer 域才有） */
  developerId?: string | null;
  /** 查看者当前所在站点（**不影响可见性判定**，仅用于展示） */
  activeSiteId?: string | null;
}

export type AuditVisibility =
  | { visible: true; reason: 'admin_all' | 'own_developer' | 'own_records' }
  | { visible: false; reason: 'cross_developer' | 'cross_realm' | 'other_user' };

export interface AuditQueryFilter {
  /** 需要在 SQL 层加的条件（供查询编译器使用） */
  siteIds: readonly string[] | 'all';
  developerId: string | null;
  actorId: string | null;
  realm: 'developer' | 'enduser' | null;
  description: string;
}

// ─────────────────────────── 判定 ───────────────────────────

/**
 * 判定某查看者能否看到某条审计记录。
 *
 * 判定顺序（**从宽到严，且先看域**）：
 *   ① admin 且在 developer 域 → 全部可见；
 *   ② enduser 域 → **只看自己**（哪怕 role 字段被写成 admin——域是更强的边界）；
 *   ③ developer → 仅名下开发者的记录；
 *   ④ 其余 → 不可见。
 */
export function auditVisibilityOf(viewer: AuditViewer, record: AuditRecordScope): AuditVisibility {
  // ② 先看域：普通用户域无论如何都只能看自己
  if (viewer.realm === 'enduser') {
    return record.actorId === viewer.userId
      ? { visible: true, reason: 'own_records' }
      : { visible: false, reason: 'other_user' };
  }

  // ① admin（developer 域）→ 全部
  if (viewer.role === 'admin') return { visible: true, reason: 'admin_all' };

  // ③ developer → 仅名下开发者的记录
  if (viewer.developerId !== undefined && viewer.developerId !== null) {
    if (record.developerId === null) {
      // ★ 平台级记录（developerId 为 null）对普通开发者不可见：
      //   它们通常涉及平台配置、其他开发者的入驻等，不属于任何单一开发者。
      return { visible: false, reason: 'cross_realm' };
    }
    return record.developerId === viewer.developerId
      ? { visible: true, reason: 'own_developer' }
      : { visible: false, reason: 'cross_developer' };
  }

  // ④ 没有 developerId 的 developer 域身份：只能看自己产生的记录
  return record.actorId === viewer.userId ? { visible: true, reason: 'own_records' } : { visible: false, reason: 'cross_developer' };
}

export function canSeeAudit(viewer: AuditViewer, record: AuditRecordScope): boolean {
  return auditVisibilityOf(viewer, record).visible;
}

/** 过滤一批记录（**用同一套判定**，避免「列表可见但详情不可见」这类不一致）。 */
export function filterVisibleAudit<T extends AuditRecordScope>(viewer: AuditViewer, records: readonly T[]): T[] {
  return records.filter((record) => canSeeAudit(viewer, record));
}

// ─────────────────────────── 查询条件 ───────────────────────────

/**
 * 把可见性转成**查询层条件**（供 SQL 使用）。
 *
 * ★ 为什么需要它：内存过滤只适用于小数据集；真实审计表很大，
 *   必须在 SQL 层就限住范围（否则「先查全部再过滤」既慢又可能在日志/指标里
 *   泄露可见范围之外的数据量）。
 *
 * ★ 关键：`siteIds` 对 admin 是 `'all'`，对开发者是**名下站点集合**，
 *   对普通用户是**空数组 + actorId 限定**（他看不到站点级审计，只看自己的操作）。
 */
export function auditQueryFilterOf(viewer: AuditViewer, options: { siteIdsOfDeveloper?: readonly string[] } = {}): AuditQueryFilter {
  if (viewer.realm === 'enduser') {
    return {
      // ★ 普通用户不带 siteIds 过滤，而是用 actorId 限定到「自己的记录」——
      //   因为他们的记录可能横跨多个站点（用户是平台级的）
      siteIds: 'all',
      developerId: null,
      actorId: viewer.userId,
      realm: 'enduser',
      description: `仅本人（${viewer.userId}）的操作记录`,
    };
  }
  if (viewer.role === 'admin') {
    return { siteIds: 'all', developerId: null, actorId: null, realm: null, description: '全部审计（admin）' };
  }
  return {
    siteIds: options.siteIdsOfDeveloper ?? [],
    developerId: viewer.developerId ?? null,
    actorId: null,
    realm: 'developer',
    description: `仅开发者 '${viewer.developerId ?? '（未指定）'}' 名下的 ${(options.siteIdsOfDeveloper ?? []).length} 个站点`,
  };
}

/**
 * 列表可见性与详情可见性必须一致的**自检**。
 *
 * ★ 为什么值得做：最常见的一类审计越权是「列表用了过滤、详情忘了过滤」——
 *   于是攻击者从列表拿不到 id，却能用猜到的 id 直接读详情。
 *   这个自检把「列表」与「详情」两条路径放在一起比对。
 */
export function auditVisibilityIsConsistent(viewer: AuditViewer, records: readonly AuditRecordScope[]): { consistent: boolean; problems: string[] } {
  const problems: string[] = [];
  const listed = filterVisibleAudit(viewer, records);
  for (const record of records) {
    const inList = listed.includes(record);
    const inDetail = canSeeAudit(viewer, record);
    if (inList !== inDetail) {
      problems.push(`记录（site=${record.siteId ?? 'null'} actor=${record.actorId}）在列表与详情中的可见性不一致`);
    }
  }
  return { consistent: problems.length === 0, problems };
}

/**
 * 审计可见性的三条规则声明（供测试与文档引用）。
 *
 * 做成数据而不是散落在注释里——这样「规则有几条、分别是什么」可以被机器核对。
 */
export const AUDIT_VISIBILITY_RULES: readonly { id: string; rule: string }[] = [
  { id: 'admin-all', rule: 'admin（developer 域）可见全部审计' },
  { id: 'developer-own-sites', rule: 'developer 仅见名下开发者的记录；平台级记录（developerId 为 null）不可见' },
  { id: 'enduser-own-records', rule: 'enduser 域仅见自己产生的记录（域优先于角色）' },
  { id: 'detail-parity', rule: '列表与详情的可见性必须一致（不能列表过滤而详情不过滤）' },
];
