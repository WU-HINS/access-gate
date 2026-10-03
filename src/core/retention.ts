/**
 * 保留期机制与两条**启动期不变量**（`docs/05 §2.1.4` · `docs/11 §13.1`）。
 *
 * ★★ 为什么必须先实现机制、再加校验（`reports/architecture-gaps.md` 的原话）：
 * > 正确的修复顺序是**先实现保留期机制**（参数 + 清理任务），**再**加不变量校验——
 * > 而不是「先把校验写上」（那会校验**不存在的参数**，成为**恒真或恒假的假检查**）。
 *
 * 本文件同时给出两半：**参数**（`RetentionSettings`）与**清理选择**（`planVersionPurge`），
 * 以及两条不变量判定。它们都是**纯函数**——同样的输入永远得到同样的结论，
 * 因此可以被启动期调用、也可以在测试里穷举。
 *
 * ── 两条不变量 ──
 *
 * | # | 不变量 | 来源 |
 * |---|---|---|
 * | 1 | `事实 TTL ≥ 主体数 ÷ 外部 API 配额` | 一代 H3 |
 * | 2 | `maxGrantLifetime ≤ min(策略版本 / 评估 / 审计 / 动作流水 的保留期)` | 第 7 代 N9 |
 *
 * ★ 不变量 2 要解决的问题（文档原话）：
 * > `one_shot` 策略是**永久授权**，但其版本（keepVersions: 3）、评估（90 天）、
 * > 审计（180 天）、动作流水（30 天）**都有保质期**。
 * > 后果：一个 3 年前的永久授权，**既无法复现、也无法解释、更无法回滚**。
 */

export interface RetentionSettings {
  /**
   * 策略版本保留**个数**（超出即候选清理）。
   * ★ 但**被 `granted` / `satisfied` 状态引用的版本永不清理**——见 `planVersionPurge`。
   */
  policyVersions: number;
  /** 评估记录保留（天） */
  evaluationsDays: number;
  /** 审计日志保留（天） */
  auditDays: number;
  /** 动作流水保留（天） */
  actionsDays: number;
  /** 事实保留下限（天）——即不变量 1 里的 `事实 TTL` */
  factsDays: number;
  /** `one_shot` 等长期授权的**最长有效期**（天） */
  maxGrantLifetimeDays: number;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  policyVersions: 3,
  evaluationsDays: 90,
  auditDays: 180,
  actionsDays: 30,
  factsDays: 7,
  // ★ 默认取**最短的那一项**（动作流水 30 天），因此默认配置天然满足不变量 2。
  //   刻意不把它设成「无限」——那正是文档要防的「永久授权无法回滚」。
  maxGrantLifetimeDays: 30,
};

export interface InvariantViolation {
  /** 稳定的机器可读名（用于告警码与测试断言） */
  name: string;
  detail: string;
  suggestion: string;
}

/**
 * 不变量 2（第 7 代 N9）：**授权有效期 ≤ 最短保留期**。
 *
 * ★ 为什么以「最短」为准：回滚一次授权需要同时能拿到
 *   策略版本（复现判定依据）、评估记录（复现输入）、审计（谁在何时批的）、
 *   动作流水（改之前是什么）。**任何一环过期，回滚就断了**。
 */
export function checkGrantLifetimeInvariant(
  settings: RetentionSettings,
): InvariantViolation | null {
  const shortest = Math.min(
    settings.evaluationsDays,
    settings.auditDays,
    settings.actionsDays,
  );
  if (settings.maxGrantLifetimeDays > shortest) {
    return {
      name: 'grant_lifetime_exceeds_retention',
      detail:
        `maxGrantLifetime=${settings.maxGrantLifetimeDays} 天 > 最短保留期 ${shortest} 天` +
        `（评估 ${settings.evaluationsDays} / 审计 ${settings.auditDays} / 动作流水 ${settings.actionsDays}）`,
      suggestion:
        `把 maxGrantLifetime 降到 ≤ ${shortest} 天，或延长对应保留期——` +
        '否则永久授权既无法复现、也无法解释、更无法回滚（docs/05 §2.1.4）',
    };
  }
  return null;
}

/**
 * 不变量 1（一代 H3）：**事实 TTL ≥ 主体数 ÷ 外部 API 配额**。
 *
 * ★ 为什么这是硬约束而不是优化项：TTL 太短会让事实频繁过期 → 每次评估都要重新采集 →
 *   配额被瞬间打满 → 采集返回 `missing` → 大面积 `indeterminate`（而按 H1 不降级，
 *   于是系统「健康地什么都不做」——正是第 8 代点出的静默黑洞）。
 */
export function checkFactTtlInvariant(input: {
  factsDays: number;
  subjectCount: number;
  /** 该外部 API 的配额（次/小时） */
  quotaPerHour: number;
}): InvariantViolation | null {
  if (input.quotaPerHour <= 0) {
    return {
      name: 'fact_ttl_quota_missing',
      detail: `外部 API 配额未配置或非正数（quotaPerHour=${input.quotaPerHour}）`,
      suggestion: '先声明该 provider 的配额（provider manifest 的 quota 声明），否则 TTL 下限无从计算',
    };
  }
  const requiredHours = input.subjectCount / input.quotaPerHour;
  const requiredDays = requiredHours / 24;
  if (input.factsDays < requiredDays) {
    return {
      name: 'fact_ttl_too_short',
      detail:
        `事实 TTL=${input.factsDays} 天 < 主体数 ${input.subjectCount} ÷ 配额 ${input.quotaPerHour}/h ` +
        `= ${requiredDays.toFixed(2)} 天`,
      suggestion:
        `把事实 TTL 提到 ≥ ${Math.ceil(requiredDays)} 天，或提高配额/降低主体数——` +
        '否则事实会持续过期、采集打满配额、评估大面积 indeterminate（docs/10 H3）',
    };
  }
  return null;
}

export interface VersionRef {
  id: string;
  policyId: string;
  version: number;
}

/**
 * 选出**应清理**的策略版本。
 *
 * ★★ 两条规则，缺一不可：
 *   ① 每个策略只保留最新的 `keep` 个版本；
 *   ② **仍被 `granted` / `satisfied` 状态引用的版本，永不清理**——
 *      否则状态表会指向一个被删掉的版本（悬空引用），
 *      而「永久授权」恰恰会长期引用某个老版本（这正是文档 §2.1.4 的要求）。
 *
 * ★ 注意 ② 会**推翻** ①：如果最老的版本仍被引用，即使它超出 `keep` 也不能删。
 *   把两者写成一个函数，是为了让这条「例外」无法被遗漏。
 */
export function planVersionPurge(input: {
  versions: readonly VersionRef[];
  keep: number;
  /** 当前被 `granted` / `satisfied` 状态引用的版本 id */
  referencedVersionIds: ReadonlySet<string>;
}): string[] {
  const byPolicy = new Map<string, VersionRef[]>();
  for (const version of input.versions) {
    const list = byPolicy.get(version.policyId) ?? [];
    list.push(version);
    byPolicy.set(version.policyId, list);
  }

  const purge: string[] = [];
  for (const list of byPolicy.values()) {
    const sorted = [...list].sort((a, b) => b.version - a.version); // 新 → 旧
    for (const version of sorted.slice(Math.max(0, input.keep))) {
      // ★ 例外：仍被引用的版本永不清理（否则状态表悬空、永久授权无法回滚）
      if (input.referencedVersionIds.has(version.id)) continue;
      purge.push(version.id);
    }
  }
  return purge.sort();
}

/** 一次性跑完两条不变量（启动期调用点）。返回空数组 = 全部通过。 */
export function checkStartupInvariants(input: {
  settings: RetentionSettings;
  /** 事实 TTL 的配额校验；未提供则跳过不变量 1（例如尚未接入任何 provider） */
  factTtl?: { subjectCount: number; quotaPerHour: number };
}): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const lifetime = checkGrantLifetimeInvariant(input.settings);
  if (lifetime !== null) violations.push(lifetime);
  if (input.factTtl !== undefined) {
    const ttl = checkFactTtlInvariant({
      factsDays: input.settings.factsDays,
      subjectCount: input.factTtl.subjectCount,
      quotaPerHour: input.factTtl.quotaPerHour,
    });
    if (ttl !== null) violations.push(ttl);
  }
  return violations;
}
