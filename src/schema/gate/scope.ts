/**
 * 站点作用域派生门禁 R1–R6（契约 §5.1 / 02 §1）。
 *
 * 铁律：只读 `NormalizedTable[]`（IR），不读 `docs/`、不读 `tables/*.ts` 源码文本。
 *
 * 规则（逐字对照 02 §1 第 21 行与 00 §2.1）：
 *   R1 有 `site_id` 列 → 该列必须 notNull；若有唯一键，其首列必须是 `site_id`。任一不满足 → error。
 *   R2 无 `site_id` 但有 `owner_scope` → `owner_scope` + `owner_id` 双非空。缺列或可空 → error。
 *   R3 两者皆无 → 必须在 PLATFORM_EXEMPTIONS 中，且理由（exemptReason 或清单 reason）非空。
 *   R4 消费方约定：`checkScopeRules` 返回任何 `severity:'error'` → 调用方非零退出（见 `hasErrors`）。
 *   R5 双作用域表（`dualScoped`）豁免「site_id 非空」，但必须有 CHECK 保证 scope 与哪个 id 非空一致。
 *   R6 唯一键包含可空列 → warn（PG 视 NULL 互不相同 → 唯一约束静默失效）；不阻塞。
 */

import type { NormalizedIndex, NormalizedTable, ScopeViolation } from '../ir.ts';
import { PLATFORM_EXEMPTIONS } from './exemptions.ts';
import type { ExemptionInput, PlatformExemption, ScopeGateOptions } from './types.ts';

export type { ExemptionInput, PlatformExemption, ScopeGateOptions, ScopeViolation };

const SITE_ID = 'site_id';
const OWNER_SCOPE = 'owner_scope';
const OWNER_ID = 'owner_id';

/** R4 消费方约定：任一 error → 调用方（db:check）必须非零退出。 */
export function hasErrors(violations: readonly ScopeViolation[]): boolean {
  return violations.some((violation) => violation.severity === 'error');
}

// ───────────────────────────── 内部工具 ─────────────────────────────

function trimToReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 从数组或记录形态的豁免清单里取该表的**原始**理由（空/缺失 → undefined）。 */
function exemptionReasonFor(tableName: string, exemptions: ExemptionInput): string | undefined {
  if (Array.isArray(exemptions)) {
    const list = exemptions as readonly PlatformExemption[];
    const entry = list.find((item) => item !== undefined && item.tableName === tableName);
    return trimToReason(entry?.reason);
  }
  const record = exemptions as Readonly<Record<string, string>>;
  return trimToReason(record[tableName]);
}

/** 唯一键里在表定义中**可空**的列（未知列不参与判定）。 */
function nullableMembers(index: NormalizedIndex, table: NormalizedTable): string[] {
  const byName = new Map(table.columns.map((column) => [column.columnName, column]));
  const names: string[] = [];
  for (const columnName of index.columns) {
    const column = byName.get(columnName);
    if (column !== undefined && column.nullable) names.push(columnName);
  }
  return names;
}

/**
 * 部分唯一索引的谓词是否覆盖了某列（`<column> IS NOT NULL`）。
 *
 * ★ 为什么必须有这个判定：R6 的**建议**之一就是「改用部分唯一索引
 *   `t.unique(..., { where: 'x IS NOT NULL' })`」，但若检查只看「列是否可空」，
 *   那么**按建议修好之后仍然报 warn** —— 门禁成了一条**永远无法通过的断言**
 *   （第 5 代 N1 的同一形态：「声称可修，而判据不认修法」）。
 */
function predicateCoversNotNull(where: string | undefined, columnName: string): boolean {
  if (where === undefined) return false;
  const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\s+IS\\s+NOT\\s+NULL\\b`, 'i').test(where);
}

/** CHECK 表达式是否同时提到 scope / site_id / developer_id，且含 IS NULL / IS NOT NULL。 */
export function checkMentionsDualScope(expr: string): boolean {
  const flat = expr.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mentionsAll = flat.includes('scope') && flat.includes('siteid') && flat.includes('developerid');
  const mentionsNull = /\bis\s+(not\s+)?null\b/i.test(expr);
  return mentionsAll && mentionsNull;
}

// ───────────────────────────── 主入口 ─────────────────────────────

export function checkScopeRules(
  tables: readonly NormalizedTable[],
  exemptions: ExemptionInput = PLATFORM_EXEMPTIONS,
  options: ScopeGateOptions = {},
): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  // ★ 裁决（ADR D21，Captain 2025-09-21）：双作用域表的 R1-b 默认**豁免**。
  //
  // 理由（三条，缺一不可）：
  //   ① 结构不可能：双作用域表同时承载 developer 级与 site 级记录，其 developer 级唯一键
  //      按定义**不可能**以 site_id 开头——严格读法会让 R5 豁免形同虚设；
  //   ② 豁免有替代保障：R5 强制要求 scope CHECK，保证「scope=site 时有 siteId 无 developerId」
  //      ——这正是 R1-b 想防的「跨作用域覆盖」，只是改由 CHECK 而非键序承担；
  //   ③ 误判代价不对称：严格读法会让唯一正确写法永久报错，迫使实现方去放宽规则（更糟）。
  // 诊断用：需要量化严格读法时传 { dualScopeUniqueKeys: 'strict' }。
  const dualScopeKeysExempt = (options.dualScopeUniqueKeys ?? 'scope-aware') === 'scope-aware';

  for (const table of tables) {
    const siteIdColumn = table.columns.find((column) => column.columnName === SITE_ID);
    const ownerScopeColumn = table.columns.find((column) => column.columnName === OWNER_SCOPE);
    const ownerIdColumn = table.columns.find((column) => column.columnName === OWNER_ID);
    const uniqueIndexes = table.indexes.filter((index) => index.unique);

    // ── R1 / R2 / R3：作用域归属（互斥分支，与 02 §1 的判据顺序一致） ──
    if (siteIdColumn !== undefined) {
      // R1-a：site_id 必须非空（R5 双作用域表豁免此项）
      if (siteIdColumn.nullable && !table.dualScoped) {
        violations.push({
          tableName: table.tableName,
          rule: 'R1',
          severity: 'error',
          detail:
            `site_id 列可空（列 ${SITE_ID}，kind=${siteIdColumn.kind}）；` +
            'R1 要求站点作用域键必须 notNull，否则站点隔离失去数据库层强制点。',
          suggestion:
            '把 siteId 声明为 col.uuid().notNull()；' +
            '若本表确实是双作用域表（有 scope 判别列、site_id 按语义可空），请改用 R5：' +
            '显式标记 options.dualScopeCheck 并提供 scope CHECK。',
        });
      }

      // R1-b：唯一键首列必须是 site_id
      if (!(table.dualScoped && dualScopeKeysExempt)) {
        for (const index of uniqueIndexes) {
          const first = index.columns[0];
          if (first === SITE_ID) continue;
          violations.push({
            tableName: table.tableName,
            rule: 'R1',
            severity: 'error',
            detail:
              `唯一键 ${index.name} 的首列是 '${first ?? '<空>'}'，不是 site_id` +
              `（完整列序：[${index.columns.join(', ')}]）；` +
              '站点作用域表的唯一键不含 site_id 会造成静默的跨站点数据污染。',
            suggestion: table.dualScoped
              ? `本表已是双作用域表（dualScoped=true），其 developer 级唯一键 ${index.name} 的首列按定义` +
                '不可能以 site_id 开头：请由契约方裁决 R5 是否连带豁免 R1-b（诊断读法见 ' +
                "options.dualScopeUniqueKeys: 'scope-aware'），或把唯一键按作用域拆分并在 R5 的 CHECK 中保证一致性。"
              : `把唯一键改为以 siteId 开头，例如 t.unique(['siteId', '${first ?? 'xxx'}'], ` +
                `{ name: '${index.name}' })；若必须保留 developer 级唯一键，请把本表改为双作用域表（R5）。`,
          });
        }
      }
    } else if (ownerScopeColumn !== undefined) {
      // R2：owner_scope + owner_id 双非空
      if (ownerScopeColumn.nullable) {
        violations.push({
          tableName: table.tableName,
          rule: 'R2',
          severity: 'error',
          detail: `owner_scope 列可空（列 ${OWNER_SCOPE}），R2 要求与 owner_id 成对且双非空。`,
          suggestion: '把 ownerScope 声明为 col.enum(...).notNull()。',
        });
      }
      if (ownerIdColumn === undefined) {
        violations.push({
          tableName: table.tableName,
          rule: 'R2',
          severity: 'error',
          detail: `有 owner_scope 列但缺少 owner_id 列，R2 要求二者必须成对出现且双非空。`,
          suggestion:
            "补 ownerId: col.varchar(64).notNull().default('platform')（platform 作用域固定为 'platform'）。",
        });
      } else if (ownerIdColumn.nullable) {
        violations.push({
          tableName: table.tableName,
          rule: 'R2',
          severity: 'error',
          detail: `owner_id 列可空（列 ${OWNER_ID}），R2 要求与 owner_scope 成对且双非空。`,
          suggestion: '把 ownerId 声明为 col.varchar(64).notNull().default(...)。',
        });
      }
    } else {
      // R3：既无 site_id 也无 owner_scope → 必须逐表豁免且理由非空
      const tableReason = trimToReason(table.exemptReason);
      const listReason = exemptionReasonFor(table.tableName, exemptions);
      if (listReason === undefined && tableReason === undefined) {
        violations.push({
          tableName: table.tableName,
          rule: 'R3',
          severity: 'error',
          detail:
            '既无 site_id 也无 owner_scope，且未在 PLATFORM_EXEMPTIONS 中逐表签署理由' +
            '（清单理由与 options.exemptReason 均为空 → 视为未豁免）。',
          suggestion:
            '补 siteId: col.uuid().notNull() 或 ownerScope + ownerId 双非空；' +
            '若确为平台级表，请在 src/schema/gate/exemptions.ts 逐表写入理由' +
            '，并同时给 defineTable 的 options.exemptReason。',
        });
      } else if (listReason === undefined) {
        violations.push({
          tableName: table.tableName,
          rule: 'R3',
          severity: 'error',
          detail:
            '不在 PLATFORM_EXEMPTIONS 清单中（仅声明了 options.exemptReason）；' +
            'R3 要求「在清单中」且「理由非空」两个条件同时成立。',
          suggestion: '在 exemptions.ts 的 PLATFORM_EXEMPTIONS 里增加本表条目并逐表签署理由。',
        });
      }
    }

    // ── R5：双作用域表必须有 scope CHECK ──
    if (table.dualScoped) {
      const hasCheck = table.checks.some((check) => check !== undefined && checkMentionsDualScope(check.expr));
      if (!hasCheck) {
        violations.push({
          tableName: table.tableName,
          rule: 'R5',
          severity: 'error',
          detail:
            '双作用域表（dualScoped=true，有 scope 判别列且 site_id 可空）缺少 scope CHECK：' +
            'checks 中没有任何一条同时提到 scope / site_id / developer_id 且含 IS NULL / IS NOT NULL，' +
            '故「scope 与哪个 id 非空」无法在数据库层保持一致。',
          suggestion:
            '加 options.dualScopeCheck 或 t.check(...)：' +
            "\"(scope = 'site' AND site_id IS NOT NULL AND developer_id IS NULL) OR " +
            "(scope = 'developer' AND developer_id IS NOT NULL AND site_id IS NULL)\"。",
        });
      }
    }

    // ── R6：唯一键含可空列 → warn（不阻塞） ──
    //   ★ 已被部分唯一索引谓词覆盖的可空列**不再计入**：谓词把 NULL 行排除在索引之外，
    //     约束不再静默失效——这正是本条自己的建议之一。
    //     （修复前：按建议改完仍报 warn，判据不认修法。）
    for (const index of uniqueIndexes) {
      const nullable = nullableMembers(index, table).filter(
        (columnName) => !predicateCoversNotNull(index.where, columnName),
      );
      if (nullable.length === 0) continue;
      violations.push({
        tableName: table.tableName,
        rule: 'R6',
        severity: 'warn',
        detail:
          `唯一键 ${index.name} 的列 [${nullable.join(', ')}] 可空：` +
          'PostgreSQL 把 NULL 视为互不相同 → 唯一约束静默失效，可插入任意多组重复逻辑键。',
        suggestion:
          '改用非空列组成唯一键（推荐 R2 的 owner_scope + owner_id 组合），' +
          `或用部分唯一索引 t.unique(..., { where: '${nullable[0]} IS NOT NULL' }) 并接受应用层兜底。`,
      });
    }
  }

  return violations;
}

// ───────────────────────────── 人类可读报告 ─────────────────────────────

export function formatViolations(violations: readonly ScopeViolation[]): string {
  const errors = violations.filter((violation) => violation.severity === 'error').length;
  const warns = violations.length - errors;
  const head = `站点作用域门禁（R1–R6）：${errors} 个 error / ${warns} 个 warn`;

  if (violations.length === 0) {
    return `${head}\n✅ 全部表通过：无任何违规（合规输入返回空数组，门禁非恒真）。`;
  }

  const lines: string[] = [head, '─'.repeat(64)];
  for (const violation of violations) {
    const mark = violation.severity === 'error' ? '✗ error' : '! warn ';
    lines.push(`${mark} [${violation.rule}] ${violation.tableName}`);
    lines.push(`        现象：${violation.detail}`);
    lines.push(`        修法：${violation.suggestion}`);
  }
  lines.push('─'.repeat(64));
  lines.push(
    hasErrors(violations)
      ? '结论：存在 error → 消费方（db:check / npm run ci）必须非零退出（R4）。'
      : '结论：无 error（仅 warn，不阻塞；R4 不触发）。',
  );
  return lines.join('\n');
}
