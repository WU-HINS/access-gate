/**
 * 站点作用域派生门禁 R1–R6 的单测。
 *
 * 覆盖要求（任务书）：
 *  - 反例：R1（site_id 可空）、R1（唯一键首列不是 site_id）、R2（owner_scope 可空 / 缺 owner_id）、
 *          R3（不在豁免清单）、R5（双作用域但无 CHECK）、R6（唯一键含可空列）各至少一个；
 *  - 正例：「看似违规但应豁免」的表不得产生 error；完全合规的站点表不得产生任何违规；
 *  - 断言「门禁不是恒真」：合规输入返回空数组。
 *
 * 全部测试数据用 `defineTable(...)` + `normalizeTable(...)` 真实构造。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { col, defineTable, t } from '../src/schema/dsl.ts';
import { normalizeTable } from '../src/schema/normalize.ts';
import type { NormalizedTable, ScopeViolation } from '../src/schema/ir.ts';
import {
  checkMentionsDualScope,
  checkScopeRules,
  formatViolations,
  hasErrors,
} from '../src/schema/gate/scope.ts';
import { PLATFORM_EXEMPTIONS, findExemption } from '../src/schema/gate/exemptions.ts';

// ───────────────────────────── 断言小工具 ─────────────────────────────

const OWNER_SCOPES = ['platform', 'developer', 'site', 'user'] as const;

function gate(
  tables: readonly NormalizedTable[],
  exemptions?: Parameters<typeof checkScopeRules>[1],
  options?: Parameters<typeof checkScopeRules>[2],
): ScopeViolation[] {
  return checkScopeRules(tables, exemptions, options);
}

function only(violations: readonly ScopeViolation[]): ScopeViolation {
  assert.equal(violations.length, 1, `期望恰好 1 条违规，实际 ${violations.length} 条：\n${formatViolations(violations)}`);
  const first = violations[0];
  assert.ok(first);
  return first;
}

function ofRule(violations: readonly ScopeViolation[], rule: ScopeViolation['rule']): ScopeViolation[] {
  return violations.filter((violation) => violation.rule === rule);
}

function onlyOfRule(violations: readonly ScopeViolation[], rule: ScopeViolation['rule']): ScopeViolation {
  const list = ofRule(violations, rule);
  assert.equal(list.length, 1, `期望恰好 1 条 ${rule}，实际 ${list.length} 条：\n${formatViolations(violations)}`);
  const first = list[0];
  assert.ok(first);
  return first;
}

// ───────────────────────────── R1 ─────────────────────────────

test('R1 反例：有 site_id 列但可空 → error', () => {
  const decl = defineTable(
    'ag_r1_nullable_site',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      siteId: col.uuid().nullable(), // ← 违规点
      code: col.varchar(32).notNull(),
    },
    (t) => [t.unique(['siteId', 'code'], { name: 'uq_ag_r1_nullable_site_code' })],
  );

  const violations = gate([normalizeTable(decl)]);
  const violation = onlyOfRule(violations, 'R1');
  assert.equal(violation.rule, 'R1');
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /site_id/);
  assert.equal(hasErrors(violations), true);
  // 附带交叉验证：该唯一键首列是 site_id（R1-b 通过），但列可空 → R6 应同时告警
  assert.equal(ofRule(violations, 'R6').length, 1);
});

test('R1 反例：唯一键首列不是 site_id → error（唯一键名与列名进报告）', () => {
  const decl = defineTable(
    'ag_r1_bad_key',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      siteId: col.uuid().notNull(), // 非空，故只有唯一键首列这一条违规
      code: col.varchar(32).notNull(),
    },
    (t) => [t.unique(['code'], { name: 'uq_ag_r1_bad_key_code' })],
  );

  const violations = gate([normalizeTable(decl)]);
  const violation = only(violations);
  assert.equal(violation.rule, 'R1');
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /uq_ag_r1_bad_key_code/);
  assert.match(violation.detail, /code/);
});

test('R1 正例：site_id 非空 + 唯一键首列是 site_id → 无违规', () => {
  const decl = defineTable(
    'ag_r1_ok',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      siteId: col.uuid().notNull(),
      code: col.varchar(32).notNull(),
    },
    (t) => [
      t.unique(['siteId', 'code'], { name: 'uq_ag_r1_ok_code' }),
      t.index(['code'], { name: 'ix_ag_r1_ok_code' }),
    ],
  );

  assert.deepEqual(gate([normalizeTable(decl)]), []);
});

// ───────────────────────────── R2 ─────────────────────────────

test('R2 反例：无 site_id、owner_scope 可空 → error', () => {
  const decl = defineTable('ag_r2_nullable_scope', {
    id: col.uuid().primaryKey().defaultSql('uuidv7()'),
    ownerScope: col.enum('ag_owner_scope', OWNER_SCOPES).nullable(), // ← 违规点
    ownerId: col.varchar(64).notNull().default('platform'),
  });

  const violations = gate([normalizeTable(decl)]);
  const violation = only(violations);
  assert.equal(violation.rule, 'R2');
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /owner_scope/);
});

test('R2 反例：有 owner_scope 但缺 owner_id 列 → error', () => {
  const decl = defineTable('ag_r2_missing_owner', {
    id: col.uuid().primaryKey().defaultSql('uuidv7()'),
    ownerScope: col.enum('ag_owner_scope', OWNER_SCOPES).notNull(),
    // ownerId 缺失 ← 违规点
  });

  const violations = gate([normalizeTable(decl)]);
  const violation = only(violations);
  assert.equal(violation.rule, 'R2');
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /owner_id/);
});

test('R2 反例：owner_id 可空 → error', () => {
  const decl = defineTable('ag_r2_nullable_owner', {
    id: col.uuid().primaryKey().defaultSql('uuidv7()'),
    ownerScope: col.enum('ag_owner_scope', OWNER_SCOPES).notNull(),
    ownerId: col.varchar(64).nullable(), // ← 违规点
  });

  const violations = gate([normalizeTable(decl)]);
  const violation = only(violations);
  assert.equal(violation.rule, 'R2');
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /owner_id/);
});

test('R2 正例：owner_scope + owner_id 双非空 → 无违规', () => {
  const decl = defineTable(
    'ag_r2_ok',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      ownerScope: col.enum('ag_owner_scope', OWNER_SCOPES).notNull(),
      ownerId: col.varchar(64).notNull().default('platform'),
      key: col.varchar(96).notNull(),
    },
    (t) => [t.unique(['ownerScope', 'ownerId', 'key'], { name: 'uq_ag_r2_ok_key' })],
  );

  assert.deepEqual(gate([normalizeTable(decl)]), []);
});

// ───────────────────────────── R3 ─────────────────────────────

test('R3 反例：既无 site_id 也无 owner_scope 且不在豁免清单 → error', () => {
  const decl = defineTable('ag_r3_orphan', {
    id: col.uuid().primaryKey().defaultSql('uuidv7()'),
    label: col.varchar(64).notNull(),
  });

  const violations = gate([normalizeTable(decl)]);
  const violation = only(violations);
  assert.equal(violation.rule, 'R3');
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /PLATFORM_EXEMPTIONS/);
});

test('R3 反例：在清单中但清单理由为空 → 视为未豁免（error）', () => {
  const decl = defineTable('ag_r3_empty_reason', {
    id: col.uuid().primaryKey().defaultSql('uuidv7()'),
    label: col.varchar(64).notNull(),
  });

  const violations = gate([normalizeTable(decl)], [{ tableName: 'ag_r3_empty_reason', reason: '   ' }]);
  const violation = only(violations);
  assert.equal(violation.rule, 'R3');
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /理由/);
});

test('R3 反例：只写了 options.exemptReason 但不在清单中 → error（清单是唯一权威）', () => {
  const decl = defineTable(
    'ag_r3_reason_without_list',
    { id: col.uuid().primaryKey().defaultSql('uuidv7()'), label: col.varchar(64).notNull() },
    undefined,
    { siteScoped: false, exemptReason: '我说它是平台级表' },
  );

  const violations = gate([normalizeTable(decl)]);
  const violation = only(violations);
  assert.equal(violation.rule, 'R3');
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /不在 PLATFORM_EXEMPTIONS/);
});

test('R3 正例：ag_plugins 带 exemptReason 且清单有理由 → 不得产生 error', () => {
  // 与 02 行 350–385 的 ag_plugins 同形（平台级插件目录）
  const decl = defineTable(
    'ag_plugins',
    {
      id: col.varchar(64).primaryKey(),
      kind: col
        .enum('ag_plugin_kind', ['provider', 'channel', 'enricher', 'action', 'identity', 'feature'])
        .notNull(),
      name: col.varchar(128).notNull(),
      version: col.varchar(32).notNull(),
      apiVersion: col.varchar(32).notNull(),
      namespace: col.varchar(64).notNull(),
      manifest: col.jsonb().notNull(),
      installedAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.index(['kind'], { name: 'ix_ag_plugins_kind' }),
      t.unique(['namespace'], { name: 'uq_ag_plugins_namespace', where: "status = 'enabled'" }),
    ],
    { siteScoped: false, exemptReason: '插件目录是平台级注册表，不属于任何站点（02 §1 豁免清单）' },
  );

  const violations = gate([normalizeTable(decl)]);
  assert.deepEqual(ofRule(violations, 'R3'), []);
  assert.equal(hasErrors(violations), false, formatViolations(violations));
});

test('R3 正例：豁免清单与 02 §1 逐字一致，且每张表理由非空、互不相同', () => {
  // ★ 与 docs/02 §1 的豁免清单逐条对应（第 4 轮修正）：
  //   - 补入 ag_plugin_configs（归属由父实例决定）、ag_plugin_packages（平台级分发物）
  //   - 移出 ag_dev_invitations（已补 siteId notNull，走 R1 而非 R3）
  const expected = [
    'ag_users',
    // ★ R96 新增：本平台作为 **OAuth 授权服务器**（IdP）的三张表
    'ag_oauth_clients',
    'ag_oauth_codes',
    'ag_oauth_refresh_tokens',
    // ★ R58 新增：nonce 防重放（调用方是平台级的，加 site_id 会绕过防重放窗口）
    'ag_verify_nonces',
    // ★ R57 新增：登录事务（用户登录时尚未选定站点，与 ag_sessions 同理）
    'ag_oidc_login_transactions',
    'ag_sessions',
    'ag_plugins',
    'ag_oidc_providers',
    'ag_oidc_signing_keys',
    'ag_platform_settings',
    'ag_developers',
    'ag_plugin_configs',
    'ag_plugin_packages',
    // ★ 本会话新增：配额计数（`docs/05 §6.4` QuotaGuard）—— 限流/预算是**跨实例**资源，
    //   进程内计数会让多实例下的实际配额 = 单实例 × 实例数（L-13），故必须落库；
    //   而 LLM 凭据与预算属于**平台**（插件宿主无 siteId），因此走 R3 而非 R1。
    'ag_quota_counters',
  ];
  assert.deepEqual(
    PLATFORM_EXEMPTIONS.map((entry) => entry.tableName),
    expected,
  );

  const reasons = new Set<string>();
  for (const entry of PLATFORM_EXEMPTIONS) {
    assert.ok(entry.reason.trim().length > 0, `${entry.tableName} 的理由不得为空`);
    assert.equal(reasons.has(entry.reason), false, `${entry.tableName} 的理由与其它表重复（禁止复制粘贴）`);
    reasons.add(entry.reason);
    assert.equal(findExemption(entry.tableName)?.tableName, entry.tableName);
  }
  assert.equal(findExemption('ag_users') !== undefined, true);
  assert.equal(findExemption('ag_nonexistent'), undefined);
});

// ───────────────────────────── R5 ─────────────────────────────

/** 与 02 行 232–256 的 ag_plugin_instances 同形（双作用域）。 */
function dualScopedDecl(options: { withCheck?: boolean } = {}) {
  return defineTable(
    'ag_plugin_instances',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      pluginId: col.varchar(64).notNull(),
      instanceKey: col.varchar(32).notNull().default('default'),
      scope: col.enum('ag_plugin_config_scope', ['developer', 'site']).notNull(),
      developerId: col.uuid().nullable(),
      siteId: col.uuid().nullable(),
      label: col.varchar(128).nullable(),
      config: col.jsonb().notNull(),
      updatedAt: col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
    },
    (t) => [
      t.unique(['developerId', 'pluginId', 'instanceKey'], { name: 'uq_ag_plugin_inst_dev' }),
      t.unique(['siteId', 'pluginId', 'instanceKey'], { name: 'uq_ag_plugin_inst_site' }),
    ],
    options.withCheck === true
      ? {
          siteScoped: false,
          dualScopeCheck:
            "(scope = 'site' AND site_id IS NOT NULL AND developer_id IS NULL) OR " +
            "(scope = 'developer' AND developer_id IS NOT NULL AND site_id IS NULL)",
        }
      : { siteScoped: false },
  );
}

test('R5 反例：双作用域表（site_id 可空 + scope 列）但无 scope CHECK → error', () => {
  const table = normalizeTable(dualScopedDecl());
  assert.equal(table.dualScoped, true, '前置条件：normalizeTable 必须推导出 dualScoped');

  const violations = gate([table]);
  const violation = onlyOfRule(violations, 'R5');
  assert.equal(violation.rule, 'R5');
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /scope/);
  // R5 已豁免「site_id 非空」，故不得因 site_id 可空再报一次 R1 的可空项
  assert.equal(
    ofRule(violations, 'R1').filter((v) => /可空/.test(v.detail)).length,
    0,
  );
  // ★ ADR D21：双作用域表的 R1-b 默认**豁免**（developer 级唯一键不可能以 site_id 开头，
  //   跨作用域覆盖改由 R5 强制的 scope CHECK 承担）。需要严格读法时传 dualScopeUniqueKeys:'strict'。
  assert.equal(ofRule(violations, 'R1').length, 0, formatViolations(violations));
  assert.equal(ofRule(violations, 'R6').length, 2);
});

test('R5 正例：双作用域表带 CHECK（scope/site_id/developer_id + IS NOT NULL）→ 无 R5 违规', () => {
  const table = normalizeTable(dualScopedDecl({ withCheck: true }));
  const violations = gate([table]);
  assert.deepEqual(ofRule(violations, 'R5'), [], formatViolations(violations));
});

test('R5 判据：CHECK 必须同时提到 scope / site_id / developer_id 且含 IS NULL 或 IS NOT NULL', () => {
  assert.equal(
    checkMentionsDualScope(
      "(scope = 'site' AND siteId IS NOT NULL AND developerId IS NULL) OR (scope = 'developer' AND developerId IS NOT NULL AND siteId IS NULL)",
    ),
    true,
    'camelCase 写法归一后必须命中',
  );
  assert.equal(checkMentionsDualScope("(scope = 'site' AND site_id IS NOT NULL)"), false, '缺 developer_id');
  assert.equal(checkMentionsDualScope('(site_id IS NOT NULL AND developer_id IS NULL)'), false, '缺 scope');
  assert.equal(
    checkMentionsDualScope("(scope = 'site' AND site_id = developer_id)"),
    false,
    '提到三列但没有 IS NULL / IS NOT NULL',
  );
});

// ───────────────────────────── R6 ─────────────────────────────

test('R6 反例：唯一键含可空列 → warn（不阻塞）', () => {
  const decl = defineTable(
    'ag_r6_nullable_unique',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      siteId: col.uuid().notNull(),
      developerId: col.uuid().nullable(), // ← 违规点
      instanceKey: col.varchar(32).notNull(),
    },
    (t) => [t.unique(['siteId', 'developerId', 'instanceKey'], { name: 'uq_ag_r6_dev' })],
  );

  const violations = gate([normalizeTable(decl)]);
  const violation = only(violations);
  assert.equal(violation.rule, 'R6');
  assert.equal(violation.severity, 'warn');
  assert.match(violation.detail, /developer_id/);
  assert.match(violation.detail, /NULL/);
  assert.equal(hasErrors(violations), false, 'R6 不得阻塞（R4 只对 error 生效）');
});

test('R6 正例：唯一键全为非空列 → 无 warn', () => {
  const decl = defineTable(
    'ag_r6_ok',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      siteId: col.uuid().notNull(),
      code: col.varchar(32).notNull(),
      note: col.varchar(64).nullable(),
    },
    (t) => [t.unique(['siteId', 'code'], { name: 'uq_ag_r6_ok' })],
  );

  assert.deepEqual(gate([normalizeTable(decl)]), []);
});

// ───────────────────────────── 恒真性 / 报告 ─────────────────────────────

test('门禁不是恒真：完全合规的站点表返回空数组，且 hasErrors=false', () => {
  const decl = defineTable(
    'ag_compliant_site_table',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      siteId: col.uuid().notNull(),
      code: col.varchar(32).notNull(),
      note: col.varchar(128).nullable(),
      createdAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['siteId', 'code'], { name: 'uq_ag_compliant_site_code' }),
      t.index(['note'], { name: 'ix_ag_compliant_note' }),
    ],
  );

  const violations = gate([normalizeTable(decl)]);
  assert.deepEqual(violations, [], '合规输入必须返回空数组——否则门禁恒真、毫无约束力');
  assert.equal(hasErrors(violations), false);
  assert.match(formatViolations(violations), /无任何违规/);
});

test('formatViolations：人类可读报告含表名 / 规则 / 具体列 / 建议修法', () => {
  const decl = defineTable(
    'ag_r6_nullable_unique',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      siteId: col.uuid().nullable(),
      developerId: col.uuid().nullable(),
    },
    (t) => [t.unique(['developerId'], { name: 'uq_ag_r6_dev' })],
  );

  const violations = gate([normalizeTable(decl)]);
  const report = formatViolations(violations);
  assert.match(report, /ag_r6_nullable_unique/);
  assert.match(report, /R1/);
  assert.match(report, /R6/);
  assert.match(report, /site_id/);
  assert.match(report, /修法：/);
  assert.match(report, /error/);
  assert.equal(hasErrors(violations), true);
});

// ───────────────────────────── 02 §1 点名的四张表（夹具） ─────────────────────────────

/**
 * ⚠️ `src/schema/tables/` 目前为空（M0 尚未落地真实声明），以下夹具**逐字照抄 02 文档**，
 * 仅有一处 DSL 层改写（见 `docProviderSyncState` 注释）。判定结论见 reports/gate-evidence.md §3。
 */

// 02 行 734–748：ag_policy_assignments（文档称「已补 siteId notNull」）
const docPolicyAssignments = defineTable(
  'ag_policy_assignments',
  {
    id: col.uuid().primaryKey().defaultSql('uuidv7()'),
    siteId: col.uuid().notNull(),
    policyId: col.uuid().notNull(),
    targetType: col.enum('ag_assign_target', ['all', 'user', 'tag', 'cohort']).notNull(),
    targetRef: col.varchar(128).nullable(),
    rolloutPercent: col.integer().notNull().default(100),
    enabled: col.boolean().notNull().default(true),
    createdAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
  },
  (t) => [
    t.index(['policyId', 'targetType'], { name: 'ix_ag_assignments_policy' }),
    t.index(['targetType', 'targetRef'], { name: 'ix_ag_assignments_target' }),
  ],
);

// 02 行 392–409：ag_plugin_configs（职责澄清为「配置版本历史」，但仍无作用域列）
const docPluginConfigs = defineTable(
  'ag_plugin_configs',
  {
    id: col.bigserial().primaryKey(),
    instanceId: col.uuid().notNull(),
    pluginId: col.varchar(64).notNull(),
    version: col.integer().notNull(),
    config: col.jsonb().notNull(),
    configHash: col.varchar(64).notNull(),
    status: col.enum('ag_config_status', ['draft', 'active', 'archived']).notNull().default('active'),
    updatedBy: col.uuid().nullable(),
    createdAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
  },
  (t) => [
    t.unique(['pluginId', 'version'], { name: 'uq_ag_plugin_configs_ver' }),
    t.index(['pluginId', 'status'], { name: 'ix_ag_plugin_configs_status' }),
  ],
  {
    // ★ 文档第 4 轮修正：本表进入 R3 豁免（归属由父实例 ag_plugin_instances 决定）
    exemptReason: '配置版本历史：归属由父实例决定，不能自带 siteId',
  },
);

// 02 行 232–256：ag_plugin_instances（双作用域）
// ★ 第 4 轮修正：文档已按注释的要求补上 dualScopeCheck（scope CHECK），夹具同步
const docPluginInstances = dualScopedDecl({ withCheck: true });

// 02 行 947–968：ag_provider_sync_state
//   ★ DSL 改写：文档用 `t.primaryKey(['siteId','provider'], ...)`，但冻结的 dsl.ts 的 TableHelper
//     只有 index/unique/check，没有 primaryKey；且 IR 无「复合主键」字段。此处用 t.unique 等价表达
//     其唯一性判据（列序与文档一致），不改动任何列声明。详见 reports/gate-evidence.md §4-F2。
const docProviderSyncState = defineTable(
  'ag_provider_sync_state',
  {
    siteId: col.uuid().notNull(),
    provider: col.varchar(64).notNull(),
    cursor: col.varchar(255).nullable(),
    lastSeenKey: col.varchar(128).nullable(),
    lastIncrementalAt: col.timestamp({ withTz: true }).nullable(),
    lastFullSyncAt: col.timestamp({ withTz: true }).nullable(),
    lastFullSyncCount: col.integer().notNull().default(0),
    lastError: col.text().nullable(),
    capabilities: col.jsonb().notNull().defaultSql("'{}'"),
    driftPolicy: col
      .enum('ag_drift_policy', ['platform_wins', 'manual_wins', 'ignore'])
      .notNull()
      .default('platform_wins'),
    updatedAt: col.timestamp({ withTz: true }).notNull().defaultNow().onUpdateNow(),
  },
  (t) => [t.unique(['siteId', 'provider'], { name: 'pk_ag_provider_sync_state' })],
);

const DOC_FIXTURES: readonly NormalizedTable[] = [
  normalizeTable(docPolicyAssignments),
  normalizeTable(docPluginConfigs),
  normalizeTable(docPluginInstances),
  normalizeTable(docProviderSyncState),
];

test('02 §1 四张点名表（文档夹具）：判定 + 打印原始报告（供 reports/gate-evidence.md 引用）', () => {
  const violations = gate(DOC_FIXTURES);
  const byTable = (tableName: string) =>
    violations.filter((violation) => violation.tableName === tableName);

  // 02 行 736–737：siteId notNull，且唯一键（此处只有普通索引）不适用 → 应合规
  assert.deepEqual(byTable('ag_policy_assignments'), []);

  // 02 行 392–409：既无 siteId 也无 ownerScope；★ 第 4 轮已补 R3 豁免理由 → 不再报错
  assert.deepEqual(byTable('ag_plugin_configs').filter((v) => v.severity === 'error'), []);

  // 02 行 232–256：双作用域表。★ 第 4 轮已补 dualScopeCheck（R5 的 CHECK）→ R5 不再报错；
  //   唯一键含可空列 → R6 warn 保留（PostgreSQL 把 NULL 视为互不相同，属真实风险）
  assert.deepEqual(byTable('ag_plugin_instances').filter((v) => v.severity === 'error'), []);
  assert.equal(byTable('ag_plugin_instances').filter((v) => v.rule === 'R6').length, 2);

  // 02 行 947–968：siteId notNull + 复合唯一键首列 siteId → 应合规
  assert.deepEqual(byTable('ag_provider_sync_state'), []);

  console.log('\n' + formatViolations(violations) + '\n');
});

test('02 §1 四张点名表：R5 两种读法的差异量化（strict 默认 vs scope-aware 诊断）', () => {
  // ★ ADR D21 之后：「strict」成了显式诊断开关，默认已是 scope-aware
  const strict = gate(DOC_FIXTURES, PLATFORM_EXEMPTIONS, { dualScopeUniqueKeys: 'strict' });
  const byDefault = gate(DOC_FIXTURES);

  const strictInstances = strict.filter((v) => v.tableName === 'ag_plugin_instances');
  const defaultInstances = byDefault.filter((v) => v.tableName === 'ag_plugin_instances');

  // strict = 显式不豁免 R1-b → developer 级唯一键首列必被判违反
  assert.equal(
    strictInstances.filter((v) => v.rule === 'R1').length,
    1,
    'strict：R1 唯一键首列判据命中（诊断读法）',
  );
  assert.equal(defaultInstances.filter((v) => v.rule === 'R1').length, 0, '默认（scope-aware）：跳过该判据');
  assert.equal(defaultInstances.filter((v) => v.rule === 'R5').length, 0, '夹具已补 CHECK → 无 R5 违规');

  // ★ 差异量化必须用**无 CHECK** 的双作用域表：那时 R5 不成立，R1-b 豁免的两种读法才会分叉。
  //   这解释了 ADR D21 为何要求「R5 的 CHECK 与 R1-b 豁免成对出现」——缺一不可。
  const noCheck = normalizeTable(dualScopedDecl());
  const strictNoCheck = gate([noCheck], PLATFORM_EXEMPTIONS, { dualScopeUniqueKeys: 'strict' });
  const awareNoCheck = gate([noCheck]);
  assert.equal(strictNoCheck.filter((v) => v.rule === 'R1').length, 1, 'strict + 无 CHECK：R1-b 命中');
  assert.equal(awareNoCheck.filter((v) => v.rule === 'R1').length, 0, 'scope-aware + 无 CHECK：R1-b 跳过');
  assert.equal(awareNoCheck.filter((v) => v.rule === 'R5').length, 1, '两种读法下 R5 缺 CHECK 都报错');

  console.log(
    `\n[读法差异] ag_plugin_instances（无 CHECK）：strict=${strictNoCheck.map((v) => v.rule).join(',')} | ` +
      `scope-aware=${awareNoCheck.map((v) => v.rule).join(',')}\n`,
  );
});

// ───────────────────────────── 文档缺陷复核（§4） ─────────────────────────────

test('文档缺陷 F1 已修复核：ag_dev_invitations 已站点化，且不再依赖 R3 豁免', () => {
  // 与 02 行 273–292 的 ag_dev_invitations 同形：siteId 可空（行 282），唯一键首列是 codeHash
  const decl = defineTable(
    'ag_dev_invitations',
    {
      id: col.uuid().primaryKey().defaultSql('uuidv7()'),
      codeHash: col.varchar(128).notNull(),
      codePrefix: col.varchar(16).notNull(),
      targetEmail: col.varchar(255).notNull(),
      siteMode: col.enum('ag_invite_site_mode', ['auto', 'existing']).notNull().default('auto'),
      siteId: col.uuid().nullable(), // ← 02 行 282：可空
      maxUses: col.integer().notNull().default(1),
      usedCount: col.integer().notNull().default(0),
      expiresAt: col.timestamp({ withTz: true }).notNull(),
      usedAt: col.timestamp({ withTz: true }).nullable(),
      usedBy: col.uuid().nullable(),
      createdBy: col.uuid().notNull(),
      createdAt: col.timestamp({ withTz: true }).notNull().defaultNow(),
    },
    (t) => [
      t.unique(['codeHash'], { name: 'uq_ag_dev_invitations_code' }),
      t.index(['targetEmail', 'expiresAt'], { name: 'ix_ag_dev_invitations_email' }),
    ],
    { siteScoped: false, exemptReason: '平台侧一次性邀请码（02 §1 豁免清单）' },
  );

  const table = normalizeTable(decl);
  // ★ F1 的修法：不再把它列进 R3 豁免清单（否则「有 siteId 却走 R1」会让豁免永不生效）
  assert.equal(
    findExemption('ag_dev_invitations'),
    undefined,
    'F1 已修：它不应再出现在 R3 豁免清单里',
  );

  const violations = gate([table]);
  const r1 = ofRule(violations, 'R1');
  // ① site_id 可空；② 唯一键 uq_ag_dev_invitations_code 首列是 code_hash
  assert.equal(r1.length, 2, formatViolations(violations));
  assert.equal(r1.filter((v) => /可空/.test(v.detail)).length, 1);
  assert.equal(r1.filter((v) => /uq_ag_dev_invitations_code/.test(v.detail)).length, 1);
  assert.equal(ofRule(violations, 'R3').length, 0, '它不在 R3 分支（有 site_id）');
  assert.equal(hasErrors(violations), true, 'R3 豁免救不了 R1：两张清单的判据互斥');

  console.log('\n' + formatViolations(violations) + '\n');
});

// ─────────────────────────── ★ R112：品牌名扫描器（既有效又不误报）───────────────────────────

test('★★★★ 品牌名扫描器：识别正则字面量（否则注释里的品牌名会被误报）', async () => {
  const { scanSystemNames } = await import('../src/schema/compile/ci-checks.ts');
  const cases: [string, string, number][] = [
    // ★ 有效性：真实代码里的品牌名**必须**被报
    // ★ 注意：这里要写**完整的品牌名**（`"git" + "hub"` 是两个独立字符串，不构成品牌名）——
    //   ★ 源码里之所以拆开写，是为了**避免扫描器自指**；测试文件不在扫描范围内，无需拆。
    ['真实代码里的品牌名', 'const p = "github";\n', 1],
    ['字符串里的品牌名', 'const s = "use github here";\n', 1],
    // ★ 不误报：注释里的品牌名**不报**
    ['注释里的品牌名', '  /** 如 "Discord Bot" */\n', 0],
    // ★★ 核心回归：**正则字面量里的引号**不得开启「字符串状态」
    ['正则含引号 + 注释品牌名', 'const a = x.replace(/"/g, "q");\n  /** "Discord" */\n', 0],
    // ★ 驼峰标识符里的子串不得命中（`checkInvariants` 含 `checkIn`）
    ['驼峰标识符', 'function checkInvariants() {}\n', 0],
    // ★ 除法不得被误认为正则开始（否则会吞掉后续代码）
    ['除法', 'const r = a / b;\nconst p = "github";\n', 1],
  ];
  for (const [name, source, expected] of cases) {
    assert.equal(scanSystemNames(source, 't.ts').length, expected, `★ ${name}`);
  }
});
