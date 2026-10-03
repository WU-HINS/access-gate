# 站点作用域派生门禁 R1–R6 · 实施与验收证据

> 工作流：`src/schema/gate/**` + `test/gate.test.ts`（**只写这三处 + 本报告**，未改 `docs/**`、`package.json`、`tsconfig.json`、`dsl.ts`、`normalize.ts`、`ir.ts`）。
> 权威口径：`docs/12-Schema声明层接口契约.md`（冻结件）§3/§4/§5.1；`docs/02-数据模型.md` §1 行 21（★ CI 门禁段）；`docs/00-开工检查表.md` §2.1。
> 运行环境：`node v22.23.2`，`npx tsc` → `Version 5.9.3`。文档快照：`docs/02-数据模型.md` md5 `c7daa50253c360c4c61623d8d314b69e`，`docs/00-开工检查表.md` md5 `904202693d428254b58f0bdf9d89eee8`。

## 0. 交付物

| 文件 | 内容 |
|---|---|
| `src/schema/gate/types.ts` | `PlatformExemption` / `ExemptionInput` / `ScopeGateOptions`（补充类型；`ScopeViolation` 直接复用 `src/schema/ir.ts`） |
| `src/schema/gate/exemptions.ts` | `PLATFORM_EXEMPTIONS`（8 张表，**逐表理由、互不相同、非空**）+ `findExemption()` |
| `src/schema/gate/scope.ts` | `checkScopeRules` · `formatViolations` · `hasErrors` · `checkMentionsDualScope` |
| `test/gate.test.ts` | 22 个 `node:test` 用例（R1–R6 反例/正例 + 恒真性 + 报告 + 02 §1 四张点名表夹具 + 文档缺陷复核） |
| `reports/gate-evidence.md` | 本文件 |

规则到实现的映射（可核对）：

| 规则 | 入口 | 判据 | severity |
|---|---|---|---|
| R1 | `checkScopeRules` → 有 `site_id` 分支 | ①`site_id.nullable === false`（`dualScoped` 时豁免，交给 R5）②每条 `unique` 索引 `columns[0] === 'site_id'` | error |
| R2 | 无 `site_id`、但有 `owner_scope` | `owner_scope` 与 `owner_id` 都**存在且非空** | error |
| R3 | 两者皆无 | 在 `PLATFORM_EXEMPTIONS` 中 **且**（`table.exemptReason` 或清单 `reason`）trim 后非空 | error |
| R4 | `hasErrors(violations)` | 任一 error → 调用方非零退出（消费方约定，非检查项） | — |
| R5 | `table.dualScoped === true` | `checks` 中至少一条 `expr` 归一后同时含 `scope`/`site_id`/`developer_id` 且含 `IS NULL`/`IS NOT NULL` | error |
| R6 | 每条 `unique` 索引 | 其列中存在表内可空列 → 逐索引各报一条 | warn（不阻塞） |

---

## 1. 验收一：单测全绿

命令：

```bash
node --experimental-strip-types --test test/gate.test.ts
```

原始输出（TAP；`console.log` 的夹具报告被 `#` 前缀原样保留；进程退出码 0，完整输出 176 行）：

```text
# 站点作用域门禁（R1–R6）：3 个 error / 2 个 warn
# ────────────────────────────────────────────────────────────────
# ✗ error [R3] ag_plugin_configs
#         现象：既无 site_id 也无 owner_scope，且未在 PLATFORM_EXEMPTIONS 中逐表签署理由（清单理由与 options.exemptReason 均为空 → 视为未豁免）。
#         修法：补 siteId: col.uuid().notNull() 或 ownerScope + ownerId 双非空；若确为平台级表，请在 src/schema/gate/exemptions.ts 逐表写入理由，并同时给 defineTable 的 options.exemptReason。
# ✗ error [R1] ag_plugin_instances
#         现象：唯一键 uq_ag_plugin_inst_dev 的首列是 'developer_id'，不是 site_id（完整列序：[developer_id, plugin_id, instance_key]）；站点作用域表的唯一键不含 site_id 会造成静默的跨站点数据污染。
#         修法：本表已是双作用域表（dualScoped=true），其 developer 级唯一键 uq_ag_plugin_inst_dev 的首列按定义不可能以 site_id 开头：请由契约方裁决 R5 是否连带豁免 R1-b（诊断读法见 options.dualScopeUniqueKeys: 'scope-aware'），或把唯一键按作用域拆分并在 R5 的 CHECK 中保证一致性。
# ✗ error [R5] ag_plugin_instances
#         现象：双作用域表（dualScoped=true，有 scope 判别列且 site_id 可空）缺少 scope CHECK：checks 中没有任何一条同时提到 scope / site_id / developer_id 且含 IS NULL / IS NOT NULL，故「scope 与哪个 id 非空」无法在数据库层保持一致。
#         修法：加 options.dualScopeCheck 或 t.check(...)："(scope = 'site' AND site_id IS NOT NULL AND developer_id IS NULL) OR (scope = 'developer' AND developer_id IS NOT NULL AND site_id IS NULL)"。
# ! warn  [R6] ag_plugin_instances
#         现象：唯一键 uq_ag_plugin_inst_dev 的列 [developer_id] 可空：PostgreSQL 把 NULL 视为互不相同 → 唯一约束静默失效，可插入任意多组重复逻辑键。
#         修法：改用非空列组成唯一键（推荐 R2 的 owner_scope + owner_id 组合），或用部分唯一索引 t.unique(..., { where: 'developer_id IS NOT NULL' }) 并接受应用层兜底。
# ! warn  [R6] ag_plugin_instances
#         现象：唯一键 uq_ag_plugin_inst_site 的列 [site_id] 可空：PostgreSQL 把 NULL 视为互不相同 → 唯一约束静默失效，可插入任意多组重复逻辑键。
#         修法：改用非空列组成唯一键（推荐 R2 的 owner_scope + owner_id 组合），或用部分唯一索引 t.unique(..., { where: 'site_id IS NOT NULL' }) 并接受应用层兜底。
# ────────────────────────────────────────────────────────────────
# 结论：存在 error → 消费方（db:check / npm run ci）必须非零退出（R4）。
# [读法差异] ag_plugin_instances：strict=R1,R5,R6,R6 | scope-aware=R5,R6,R6
# 站点作用域门禁（R1–R6）：2 个 error / 0 个 warn
# ────────────────────────────────────────────────────────────────
# ✗ error [R1] ag_dev_invitations
#         现象：site_id 列可空（列 site_id，kind=uuid）；R1 要求站点作用域键必须 notNull，否则站点隔离失去数据库层强制点。
#         修法：把 siteId 声明为 col.uuid().notNull()；若本表确实是双作用域表（有 scope 判别列、site_id 按语义可空），请改用 R5：显式标记 options.dualScopeCheck 并提供 scope CHECK。
# ✗ error [R1] ag_dev_invitations
#         现象：唯一键 uq_ag_dev_invitations_code 的首列是 'code_hash'，不是 site_id（完整列序：[code_hash]）；站点作用域表的唯一键不含 site_id 会造成静默的跨站点数据污染。
#         修法：把唯一键改为以 siteId 开头，例如 t.unique(['siteId', 'code_hash'], { name: 'uq_ag_dev_invitations_code' })；若必须保留 developer 级唯一键，请把本表改为双作用域表（R5）。
# ────────────────────────────────────────────────────────────────
# 结论：存在 error → 消费方（db:check / npm run ci）必须非零退出（R4）。
ok 1 - R1 反例：有 site_id 列但可空 → error
ok 2 - R1 反例：唯一键首列不是 site_id → error（唯一键名与列名进报告）
ok 3 - R1 正例：site_id 非空 + 唯一键首列是 site_id → 无违规
ok 4 - R2 反例：无 site_id、owner_scope 可空 → error
ok 5 - R2 反例：有 owner_scope 但缺 owner_id 列 → error
ok 6 - R2 反例：owner_id 可空 → error
ok 7 - R2 正例：owner_scope + owner_id 双非空 → 无违规
ok 8 - R3 反例：既无 site_id 也无 owner_scope 且不在豁免清单 → error
ok 9 - R3 反例：在清单中但清单理由为空 → 视为未豁免（error）
ok 10 - R3 反例：只写了 options.exemptReason 但不在清单中 → error（清单是唯一权威）
ok 11 - R3 正例：ag_plugins 带 exemptReason 且清单有理由 → 不得产生 error
ok 12 - R3 正例：豁免清单与 02 §1 逐字一致，且每张表理由非空、互不相同
ok 13 - R5 反例：双作用域表（site_id 可空 + scope 列）但无 scope CHECK → error
ok 14 - R5 正例：双作用域表带 CHECK（scope/site_id/developer_id + IS NOT NULL）→ 无 R5 违规
ok 15 - R5 判据：CHECK 必须同时提到 scope / site_id / developer_id 且含 IS NULL 或 IS NOT NULL
ok 16 - R6 反例：唯一键含可空列 → warn（不阻塞）
ok 17 - R6 正例：唯一键全为非空列 → 无 warn
ok 18 - 门禁不是恒真：完全合规的站点表返回空数组，且 hasErrors=false
ok 19 - formatViolations：人类可读报告含表名 / 规则 / 具体列 / 建议修法
ok 20 - 02 §1 四张点名表（文档夹具）：判定 + 打印原始报告（供 reports/gate-evidence.md 引用）
ok 21 - 02 §1 四张点名表：R5 两种读法的差异量化（strict 默认 vs scope-aware 诊断）
ok 22 - 文档缺陷 F1 复核：豁免清单里的 ag_dev_invitations 实际命中 R1，R3 豁免不生效
# tests 22
# suites 0
# pass 22
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

**结论**：22/22 通过。任务书要求的反例（R1 可空、R1 唯一键首列、R2 可空/缺列、R3 未豁免、R5 无 CHECK、R6 可空列）各至少一个且断言了 `rule` 与 `severity`；正例（`ag_plugins` 带 exemptReason 不产生 error；完全合规站点表返回**空数组**）覆盖「门禁不是恒真」。

补充：仓库级 `npm test`（`test/*.test.ts`，含并行工作流的 `compile.test.ts`）同样全绿：

```text
$ npm test
1..40
# tests 40
# pass 40
# fail 0
```

---

## 2. 验收二：类型检查

命令与原始输出（本工作流文件全部落地后的验收时刻 23:33–23:35：**进程退出码 0，无任何输出**）：

```bash
$ npx tsc -p tsconfig.json --noEmit
$ echo $?
0
```

⚠️ **但在撰写本报告期间（23:35:29 起）**，并行工作流的 `tools/extract-doc-schema.ts` 开始向 `src/schema/tables/` 产出真实声明，其中 `plugin.ts` / `integration.ts` 含**未转义的单引号**（生成器缺陷，见 §3 前置事实），使全量 tsc 再次失败；错误**全部**落在这两个文件，与本工作流无关：

```bash
$ npx tsc -p tsconfig.json --noEmit ; echo $?
2
src/schema/tables/integration.ts(101,81): error TS1005: ',' expected.
src/schema/tables/integration.ts(101,87): error TS1005: ',' expected.
src/schema/tables/integration.ts(101,90): error TS1005: ':' expected.
src/schema/tables/integration.ts(102,82): error TS1005: ',' expected.
src/schema/tables/integration.ts(102,89): error TS1005: ',' expected.
src/schema/tables/integration.ts(102,92): error TS1005: ':' expected.
src/schema/tables/integration.ts(160,81): error TS1005: ',' expected.
src/schema/tables/integration.ts(160,88): error TS1005: ',' expected.
src/schema/tables/plugin.ts(33,84): error TS1005: ',' expected.
src/schema/tables/plugin.ts(33,91): error TS1005: ',' expected.
src/schema/tables/plugin.ts(33,94): error TS1005: ':' expected.
# 涉及文件统计：9 × src/schema/tables/integration.ts，3 × src/schema/tables/plugin.ts
# 来自 src/schema/gate/** 或 test/gate.test.ts 的错误：0 条
```

因此「本工作流文件类型干净」改用**收窄工程**复核（工程配置原样 `extends`，只把 `include` 收窄到本工作流文件）：

```bash
# /tmp/tsconfig.gate.json:
# { "extends": "/workspace/newapi 429/tsconfig.json",
#   "compilerOptions": { "typeRoots": ["/workspace/newapi 429/node_modules/@types"] },
#   "include": ["/workspace/newapi 429/src/schema/gate/**/*.ts", "/workspace/newapi 429/test/gate.test.ts"] }

$ npx tsc -p /tmp/tsconfig.gate.json --noEmit
$ echo $?
0
```

**过程说明（值得记录）**：验收过程中 `npx tsc -p tsconfig.json --noEmit` 一度报错，但错误**全部**落在并行工作流的文件上（先 `src/schema/compile/fixtures.ts` / `ci-checks.ts` 的链式类型与语法错误，后 `tools/extract-doc-schema.ts` 的 8 条 `TS1005/TS1109/TS1128` 语法错误）。其中一次现象是：`dsl.ts` 当时尚未补 `ChainableMethods`，02 文档的链式写法（`col.uuid().primaryKey().defaultSql('uuidv7()')`）**通不过 tsc**（本工作流在 `test/gate.test.ts` 里也命中 88 条 `TS2339`；同一时刻并行工作流为此新建了 `src/schema/compile/chain.ts` 做类型补丁）。该缺陷已由 `dsl.ts`（mtime 23:29:54，新增 `export interface ChainableMethods`，`ColumnType<T> = ColumnSpec & ChainableMethods & {...}`）修复，本工作流随后撤回临时补丁、改回 `col.*` 直写；此后 23:33–23:35 的全量 tsc 为 0 错误（见上），23:35:29 之后又因 `src/schema/tables/*.ts` 的生成器缺陷而失败（同样与本工作流无关，且**只**影响全量跑，不影响收窄工程）。

---

## 3. 验收三：02 §1 点名的四张「当前违规」表

**前置事实（时间线，避免误读）**：

- 本工作流实现门禁与夹具时（约 23:23–23:31），`ls -la src/schema/tables/` **目录为空**（`total 0`）；工作区里唯一的表模块是并行工作流的夹具 `src/schema/compile/fixtures.ts`，其表名以 `ag_fixture_` 开头，**不是**真实声明。
- 撰写本报告期间（23:35:29）并行工作流的 `tools/extract-doc-schema.ts` 开始向 `src/schema/tables/` 产出真实声明（`identity/plugin/policy/execution/integration/ops.ts` + `index.ts`）。此时它们**尚不可加载**（生成器把 `where` 谓词的单引号原样嵌套，产出非法 TS），原始证据：

```text
$ for f in src/schema/tables/*.ts; do node --experimental-strip-types --input-type=module -e "import('./$f')…"; done
src/schema/tables/execution.ts -> OK
src/schema/tables/identity.ts -> OK
src/schema/tables/index.ts -> FAIL Expected ',', got 'ident'
src/schema/tables/integration.ts -> FAIL Expected ',', got 'ident'
src/schema/tables/ops.ts -> OK
src/schema/tables/plugin.ts -> FAIL Expected ',', got 'ident'
src/schema/tables/policy.ts -> OK

$ sed -n '101p' src/schema/tables/integration.ts
      t.unique(['alg'], { name: 'uq_ag_oidc_keys_active_alg', where: 'status = 'active'' }),
```

因此本节**用与 02 逐字一致的夹具**（`test/gate.test.ts` 的 `DOC_FIXTURES`）判定，**没有伪造任何「真实声明」的运行结果**。真实声明可加载后必须重跑（届时用 `checkScopeRules(normalizeTables(allTables))` 覆盖 40 张表，而不是这四张）。

| 文档位置 | 夹具表 | 门禁判定（strict，默认读法） | 与文档的一致性 |
|---|---|---|---|
| 02 行 734–748 | `ag_policy_assignments` | ✅ **无任何违规**（`siteId notNull`；无唯一键） | 与 00 §2.2 行 40「✅ 补 siteId notNull」一致 |
| 02 行 392–409 | `ag_plugin_configs` | ❌ **R3 error**（既无 `site_id` 也无 `owner_scope`，且不在豁免清单） | **与 00 §2.2 行 43「✅ 已修正」矛盾**；与 02 行 21 自己仍把它列在「当前违规」一致 |
| 02 行 232–256 | `ag_plugin_instances` | ❌ **R1 error**（`uq_ag_plugin_inst_dev` 首列 `developer_id`）+ ❌ **R5 error**（声明里没有任何 CHECK）+ ⚠️ **R6 warn ×2**（两条唯一键各含可空列） | **与 00 §2.2 行 42「✅ R5 豁免 + CHECK 约束说明」矛盾**：注释写了 CHECK（02 行 242–243），但 `defineTable(..., { siteScoped: false })`（行 256）没有提供 |
| 02 行 947–968 | `ag_provider_sync_state` | ✅ **无任何违规**（`siteId notNull`；唯一性判据首列 `site_id`） | 与 00 §2.2 行 41 一致（但见 §4-F5 的 DSL 改写） |

夹具与文档的唯一改写（其余逐字照抄）：文档用 `t.primaryKey(['siteId','provider'], {name:'pk_ag_provider_sync_state'})`（02 行 967），而冻结的 `dsl.ts` 的 `TableHelper` **没有** `primaryKey` 方法、IR 也没有复合主键字段 → 夹具改用 `t.unique([...])` 等价表达（列序一致），未改动任何列声明。

**汇总判定**：四张表里 **2 张仍不合规**（`ag_plugin_configs` R3；`ag_plugin_instances` R5 + R1/R6），因此 00 §2.2「四张违规表已修正 ★」的表述**不成立**；`db:check` 在这些声明下会非零退出（R4）。

### 3b. 加分证据：对「真实声明」的一次可用快照（部分模块，23:36）

`src/schema/tables/` 的 7 个模块里，`plugin.ts` / `integration.ts` / `index.ts` 因生成器转义缺陷不可加载（见上文），其余 4 个模块可加载。对它们**跑真实声明**（不是夹具）：

```bash
$ node --experimental-strip-types --input-type=module - <<'EOF'
import { normalizeTable } from './src/schema/normalize.ts';
import { checkScopeRules, formatViolations, hasErrors } from './src/schema/gate/scope.ts';
const files = ['identity', 'policy', 'execution', 'ops'];
const tables = [];
for (const f of files) {
  const mod = await import(`./src/schema/tables/${f}.ts`);
  for (const v of Object.values(mod)) {
    if (v && typeof v === 'object' && Array.isArray(v.columns) && typeof v.name === 'string') {
      tables.push(normalizeTable(v));
    }
  }
}
console.log(`已加载模块 [${files.join(', ')}] 共 ${tables.length} 张表：`);
console.log(tables.map((t) => t.tableName).join(', '));
const violations = checkScopeRules(tables);
console.log(formatViolations(violations));
console.log('hasErrors =', hasErrors(violations));
EOF
```

原始输出：

```text
已加载模块 [identity, policy, execution, ops] 共 20 张表：
ag_dev_invitations, ag_developers, ag_email_rules, ag_identities, ag_invite_codes, ag_platform_settings, ag_plugin_instances, ag_sessions, ag_sites, ag_users, ag_policies, ag_policy_assignments, ag_policy_versions, ag_actions_log, ag_checkin_entitlements, ag_checkin_records, ag_evaluations, ag_user_policy_state, ag_audit_log, ag_jobs
站点作用域门禁（R1–R6）：6 个 error / 2 个 warn
────────────────────────────────────────────────────────────────
✗ error [R1] ag_dev_invitations
        现象：site_id 列可空（列 site_id，kind=uuid）；R1 要求站点作用域键必须 notNull，否则站点隔离失去数据库层强制点。
        修法：把 siteId 声明为 col.uuid().notNull()；若本表确实是双作用域表（有 scope 判别列、site_id 按语义可空），请改用 R5：显式标记 options.dualScopeCheck 并提供 scope CHECK。
✗ error [R1] ag_dev_invitations
        现象：唯一键 uq_ag_dev_invitations_code 的首列是 'code_hash'，不是 site_id（完整列序：[code_hash]）；站点作用域表的唯一键不含 site_id 会造成静默的跨站点数据污染。
        修法：把唯一键改为以 siteId 开头，例如 t.unique(['siteId', 'code_hash'], { name: 'uq_ag_dev_invitations_code' })；若必须保留 developer 级唯一键，请把本表改为双作用域表（R5）。
✗ error [R3] ag_email_rules
        现象：既无 site_id 也无 owner_scope，且未在 PLATFORM_EXEMPTIONS 中逐表签署理由（清单理由与 options.exemptReason 均为空 → 视为未豁免）。
        修法：补 siteId: col.uuid().notNull() 或 ownerScope + ownerId 双非空；若确为平台级表，请在 src/schema/gate/exemptions.ts 逐表写入理由，并同时给 defineTable 的 options.exemptReason。
✗ error [R1] ag_plugin_instances
        现象：唯一键 uq_ag_plugin_inst_dev 的首列是 'developer_id'，不是 site_id（完整列序：[developer_id, plugin_id, instance_key]）；站点作用域表的唯一键不含 site_id 会造成静默的跨站点数据污染。
        修法：本表已是双作用域表（dualScoped=true），其 developer 级唯一键 uq_ag_plugin_inst_dev 的首列按定义不可能以 site_id 开头：请由契约方裁决 R5 是否连带豁免 R1-b（诊断读法见 options.dualScopeUniqueKeys: 'scope-aware'），或把唯一键按作用域拆分并在 R5 的 CHECK 中保证一致性。
✗ error [R5] ag_plugin_instances
        现象：双作用域表（dualScoped=true，有 scope 判别列且 site_id 可空）缺少 scope CHECK：checks 中没有任何一条同时提到 scope / site_id / developer_id 且含 IS NULL / IS NOT NULL，故「scope 与哪个 id 非空」无法在数据库层保持一致。
        修法：加 options.dualScopeCheck 或 t.check(...)："(scope = 'site' AND site_id IS NOT NULL AND developer_id IS NULL) OR (scope = 'developer' AND developer_id IS NOT NULL AND site_id IS NULL)"。
! warn  [R6] ag_plugin_instances
        现象：唯一键 uq_ag_plugin_inst_dev 的列 [developer_id] 可空：PostgreSQL 把 NULL 视为互不相同 → 唯一约束静默失效，可插入任意多组重复逻辑键。
        修法：改用非空列组成唯一键（推荐 R2 的 owner_scope + owner_id 组合），或用部分唯一索引 t.unique(..., { where: 'developer_id IS NOT NULL' }) 并接受应用层兜底。
! warn  [R6] ag_plugin_instances
        现象：唯一键 uq_ag_plugin_inst_site 的列 [site_id] 可空：PostgreSQL 把 NULL 视为互不相同 → 唯一约束静默失效，可插入任意多组重复逻辑键。
        修法：改用非空列组成唯一键（推荐 R2 的 owner_scope + owner_id 组合），或用部分唯一索引 t.unique(..., { where: 'site_id IS NOT NULL' }) 并接受应用层兜底。
✗ error [R1] ag_policy_versions
        现象：唯一键 uq_ag_policy_versions 的首列是 'policy_id'，不是 site_id（完整列序：[policy_id, version]）；站点作用域表的唯一键不含 site_id 会造成静默的跨站点数据污染。
        修法：把唯一键改为以 siteId 开头，例如 t.unique(['siteId', 'policy_id'], { name: 'uq_ag_policy_versions' })；若必须保留 developer 级唯一键，请把本表改为双作用域表（R5）。
────────────────────────────────────────────────────────────────
结论：存在 error → 消费方（db:check / npm run ci）必须非零退出（R4）。
hasErrors = true
```

**这次真实运行得到的结论**：

1. `ag_policy_assignments`（已在 `policy.ts` 落地）**真实声明合规**——与 00 §2.2 行 40 一致。
2. `ag_plugin_instances`（真实声明在 `identity.ts`）复现 **R1 + R5 + R6×2** → §4-F2 在真实声明上成立（不是夹具造出来的）。
3. `ag_dev_invitations`（真实声明）复现 **2×R1** → §4-F1 在真实声明上成立。
4. **新增发现**：`ag_email_rules`（R3，无作用域列且未豁免）与 `ag_policy_versions`（R1，唯一键首列是 `policy_id`）也违规，而这两张表**不在** 02 行 21 的「**当前违规（必须修正或补豁免理由）**」四张表清单里。这说明该清单本身也不完整（与该行自述「实测 40 张表中 14 张不在任何白名单」相呼应，但清单未随之更新）。
5. `ag_plugin_configs`（`plugin.ts`）与 `ag_provider_sync_state`（`integration.ts`）因模块不可加载**未能在真实声明上验证**——上文 §3 的夹具结论对这两张表仍成立，但必须在生成器修好后重跑。
6. 快照下 `hasErrors = true`：**当前真实声明状态过不了门禁**（R4 会非零退出），这与 00 §2.2 的「已修正」叙事相反。

---

## 4. 文档规则本身的歧义 / 矛盾（**未修改 docs/**）

### F1（高）R3 豁免清单与 R1 判据互斥：`ag_dev_invitations` 的豁免永远不会生效

- 原文（02 行 21）：「**豁免清单（须逐表签署理由）**：… `ag_developers` / `ag_dev_invitations`（开发者域，按 ownerScope 隔离）」
- 原文（02 行 282）：`siteId:      col.uuid().nullable(),`
- 原文（02 行 292）：`t.unique(['codeHash'],                { name: 'uq_ag_dev_invitations_code' }),`
- 原文（02 行 306）：``| `ag_plugins` / `ag_oidc_providers` / `ag_developers` / `ag_sites` / `ag_dev_invitations` | 平台级（`siteScoped: false`） |``

`ag_dev_invitations` **有 `site_id` 列**（且可空、唯一键首列是 `code_hash`），所以走 R1 分支：R3 的成立条件是「既无 `site_id` 也无 `owner_scope`」，该表**永远不满足**，清单里的理由也就永远不被读取。复核用例 `ok 22` 的原始输出：

```text
# ✗ error [R1] ag_dev_invitations
#         现象：site_id 列可空（列 site_id，kind=uuid）；…
# ✗ error [R1] ag_dev_invitations
#         现象：唯一键 uq_ag_dev_invitations_code 的首列是 'code_hash'，不是 site_id（完整列序：[code_hash]）；…
```

另外该清单的理由「按 ownerScope 隔离」与声明不符：`grep -n ownerScope docs/02-数据模型.md` 显示 `owner_scope` 只出现在 `ag_identities` / `ag_plugin_grants` / `ag_plugin_storage` / `ag_llm_cache` / `ag_plugin_endpoints` / `ag_secrets` / `ag_jobs` 等表，`ag_developers`、`ag_dev_invitations` **都没有 `owner_scope`**（见 F6）。

**建议（契约方裁决，我不改契约）**：要么把 `ag_dev_invitations.siteId` 改 `notNull` 并把 `uq_ag_dev_invitations_code` 改为 `(siteId, codeHash)`，要么给它 `ownerScope+ownerId`，要么把「R3 豁免」扩展为「R1 也认可以清单理由豁免」（这会削弱 R1，不建议）。

### F2（高）00 §2.2「四张违规表已修正」与实际声明不一致

- 原文（00 行 36）：「### 2.2 四张违规表已修正」
- 原文（00 行 42）：``| ag_plugin_instances | siteId 可空、首键是 developerId | ✅ **R5 豁免** + CHECK 约束说明 |``
- 原文（00 行 43）：``| ag_plugin_configs | 「双配置权威」… | ✅ 职责澄清为**配置版本历史**，加 instanceId 指向权威 |``
- 对照（02 行 242–243）只有**注释**里的 CHECK 说明；`ag_plugin_instances` 的 `defineTable` 第 4 参只有 `{ siteScoped: false }`（02 行 256），既无 `t.check` 也无 `options.dualScopeCheck` → R5 必然报错。
- 对照（02 行 392–409）`ag_plugin_configs` 全文无 `siteId` / `ownerScope`：「职责澄清」不产生任何作用域列 → R3 必然报错。

「说明/澄清」不等于「声明改动」，建议 §2.2 把这两行改为「⏳ 待修」并给出具体声明 diff。

### F3（中）R5 的豁免范围歧义：它是否也豁免 R1 的「唯一键首列必须是 siteId」？

- 原文（00 行 52）：「**R5** | **双作用域表**（有 scope 判别列）可豁免 notNull，但须有 CHECK 保证「scope 与哪个 id 非空」一致」
- 原文（02 行 21，R5 子串）：「**R5** … **双作用域表**（有 scope 判别列）可以豁免「site_id 非空」，但**必须有 CHECK 约束**」（任务书口径同）
- 原文（12 行 109）：`/** ★ 双作用域表标记（R5）：由 options.dualScopeCheck 或 scope 判别列存在性推导 */`

争议点：双作用域表**按设计**同时承载 developer 级与 site 级记录，其 developer 级唯一键（`uq_ag_plugin_inst_dev`，首列 `developer_id`）**不可能**以 `site_id` 开头。若 R5 只豁免 notNull，则这类表在 R1 下必然 error，R5 的豁免形同虚设。我**按字面实现为默认（strict）**，并额外提供 `ScopeGateOptions.dualScopeUniqueKeys: 'strict' | 'scope-aware'` 仅作**诊断**用途，量化两种读法：

```text
# [读法差异] ag_plugin_instances：strict=R1,R5,R6,R6 | scope-aware=R5,R6,R6
```

结论不依赖该裁决：**两种读法下 `ag_plugin_instances` 都是 error**（缺 CHECK），差别只在于多一条还是少一条 R1。建议契约 §5.1 明确 R5 是否连带豁免 R1-b。

### F4（中）02 §3.10 的 fail-fast 规则没有进入 R1–R6

- 原文（02 行 308）：「> ⚠️ **fail-fast 保护**：`siteScoped: true` 的表若缺少 `site_id` 列，`db:check` **启动失败**——不允许"先上线后补隔离"。」

派生规则里没有对应项：一张 `siteScoped: true`、无 `siteId` 但有 `ownerScope`+`ownerId` 的表会被 **R2 放行**，与 §3.10 的 fail-fast 冲突。建议在契约 §5.1 增加对应规则（如 R7），或在 02 §3.10 标注该判据已由 R2/R3 取代。

### F5（中）`t.primaryKey([...])` 在冻结的 DSL 与 IR 中都无法表达

- 原文（02 行 967）：`t.primaryKey(['siteId', 'provider'], { name: 'pk_ag_provider_sync_state' }),`
- 现状：`dsl.ts` 的 `TableHelper` 只有 `index` / `unique` / `check`（**列级** `primaryKey()` 存在，**表级**不存在）；`src/schema/ir.ts` 行 45 只有列级 `primaryKey: boolean`，**没有复合主键字段**。

后果：02 行 967 的写法无法编译；即使在 IR 层手工表达，`ag_provider_sync_state` 在 IR 里也**没有任何主键列**，DDL 编译与漂移检测拿不到 `(site_id, provider)` 这个复合主键（10 §S2 的「对账调度单元」正是它）。夹具因此改用 `t.unique([...])` 等价表达（见 §3 注）。

### F6（低）豁免清单理由「按 ownerScope 隔离」与声明不符

`ag_developers`（02 行 177–200 的 `defineTable`）与 `ag_dev_invitations`（02 行 273–292）都**没有 `owner_scope` 列**，而 02 行 21 给出的豁免理由是「开发者域，按 ownerScope 隔离」。R2 才消费 `ownerScope`，R3 只对「两者皆无」的表生效——该理由对这两张表都不成立（对 `ag_developers` 而言它确实无 `siteId`/`ownerScope`，走 R3，理由是自相矛盾的）。

### F7（信息）R6 的粒度未定义，我实现为「逐唯一键各报一条」

`ag_plugin_instances` 两条唯一键都含可空列 → 2 条 warn（见 §1 原始输出）。契约（12 行 133 / §5.1 行 155–156）只说「含可空列时必须给出告警级发现」，未规定按表聚合还是按索引聚合。当前实现按索引 → 报告更可操作；若消费方（`db:check` 计数）需要按表聚合，需在契约中写明。

---

## 5. 未决问题

1. **真实声明尚未全量可用**：`src/schema/tables/` 在 23:35 才开始产出，且 `plugin.ts` / `integration.ts` / `index.ts` 因生成器转义缺陷不可加载（§3 前置事实）；§3 的四表结论基于逐字夹具，§3b 已在可加载的 20 张真实表上复核其中两张。生成器修好后必须用 `checkScopeRules(normalizeTables(allTables))` 全量重跑并替换 §3/§3b。
2. **R4 的消费方尚未接线**：`db:check` / `npm run ci`（`tools/**`，属其他工作流）尚未调用 `hasErrors`；本工作流只交付约定与辅助函数，未端到端验证「非零退出」。
3. **同时有 `site_id` 与 `owner_scope` 的表**：02 行 20 要求「所有平台能力层表」都带 `ownerScope + ownerId`，而 R1 只查 `site_id`。两者并存时是否要求 R2 也成立，契约未定；我按 R2 仅在「无 `site_id`」时生效实现。
4. **违规输出顺序未冻结**：当前按「输入表序 → 每表 R1 → R2/R3 → R5 → R6」确定性输出，未做去重/排序；契约未规定。
5. **`formatViolations` 的文本格式未被契约冻结**（未规定字段分隔、是否中文）；我只保证「表名 + 规则 + 具体列 + 建议修法」四要素齐全并被 `ok 19` 断言。
