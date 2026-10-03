# db-spike 证据报告：docs/02 Schema → DDL → 空库真跑 → 漂移检测 → CI 门禁

> **M0 第一个动作（实现者 #10 的「只改一处」spike）的实测记录。**
> 每条验收 = 一条可复跑命令 + 原始输出片段 + 结论。所有输出均为本机实测原文，
> 仅去掉 Node 的 `UNDICI-EHPA` 代理告警（用 `NODE_NO_WARNINGS=1` 抑制）。

| 项 | 值 |
|---|---|
| 工作目录 | `/workspace/newapi 429` |
| Node | `v22.23.2` |
| 数据库 | `@electric-sql/pglite@0.5.8` = **PostgreSQL 18.3（wasm32）**，默认**进程内内存实例** |
| 表声明来源 | `src/schema/tables/index.ts`（真实声明，**40 张表**；提取器 `tools/extract-doc-schema.ts` 由 Captain 产出） |
| IR 规模 | 表 40 · 列 495 · 索引 85（空列索引 **0**） |
| DDL 规模 | `CREATE TABLE` 40 · `CREATE TYPE` 45 · `CREATE INDEX` 85 · 触发器函数 15 · 触发器语句 30 · **语句总数 215** |
| 产物 | `migrations/0001_init.sql`（35 249 字节）· `sql/schema.sql`（34 818 字节） |

---

## 0. 结论速览

| # | 验收项 | 结论 | 关键数字 |
|---|---|---|---|
| 1 | 空库真跑全部 DDL | ✅ **PASS** | 40 张表 / 215 条语句 / **失败 0 条** / 8.8s |
| 2 | `--drift-demo` 四种人为漂移 | ✅ **全部检出**（各自退出码 1） | type / missing-column / extra-column / missing-index |
| 3 | `migrations/0001_init.sql` 表数 == `src/schema/tables` 导出表数 | ✅ **PASS** | `CREATE TABLE` 40 == `allTables` 40 |
| 4 | docs/02 两处「无法生成 DDL」损坏 | ⚠ **当前均不可复现**（损坏①已消除；损坏②残留为 02:830 孤立行，围栏内 20 列可跑但**静默丢 `trace_id`**） | 见 §5 |
| 5 | `npm run ci` | ❌ **FAIL（退出码 1）**：8 项中 6 PASS / 2 FAIL | 4. 门禁 8 error（R1/R3/R5）· 7. 核心代码含具体系统名 3 处 |
| — | 空库**零漂移** | ✅ 表/列/类型/可空/长度/默认值/主键/索引/枚举全一致 | 漂移 0 条 |

> **一句话**：**40 张表的 DDL 已经能真跑到 PostgreSQL 上，且与 IR 零漂移**；`npm run ci` 的 2 项 FAIL **不是管道缺陷，而是真实数据模型问题**（作用域门禁 R1/R3/R5 的 8 条 error、以及 docs/02 原文里的具体系统名）。

---

## 1. 复跑命令

```bash
npm install --cache /tmp/npmcache            # @electric-sql/pglite + typescript + @types/node
npm run db:generate                          # IR → migrations/0001_init.sql + sql/schema.sql
npm run db:migrate                           # 全部 DDL 真跑到空库（内存实例）
npm run db:check                             # (a) 作用域门禁 (b) 漂移检测
npm run db:check -- --drift-demo column-type # 人为漂移演示（4 种）
npm run ci                                   # 8 项 CI 门禁（1–7 本工作流；8 由 M0-11a 并入）
npm run ci -- --self-test                    # 证明第 5/6/7 项不是恒真
```

---

## 2. 验收 1：空库真跑全部 DDL

**命令**：`npm run db:migrate`

```
db:migrate 开始
  来源    : 真实声明 src/schema/tables/index.ts（40 张表）
  实例    : 内存（进程内，PGlite）
  待执行  : 215 条语句（表 40 · 枚举 45 · 索引 85）

db:migrate OK —— 实际创建 40 张表，执行 215 条语句，耗时 8819ms
  实际表名（按字母序）：
    - ag_actions_log
    - ag_audit_log
    - ag_checkin_entitlements
    - ag_checkin_records
    - ag_dev_invitations
    - ag_developers
    - ag_email_rules
    - ag_evaluations
    - ag_external_subjects
    - ag_identities
    - ag_invite_codes
    - ag_jobs
    - ag_llm_cache
    - ag_oidc_providers
    - ag_oidc_signing_keys
    - ag_platform_settings
    - ag_plugin_bindings
    - ag_plugin_configs
    - ag_plugin_endpoints
    - ag_plugin_facts
    - ag_plugin_grants
    - ag_plugin_instances
    - ag_plugin_invocations
    - ag_plugin_packages
    - ag_plugin_storage
    - ag_plugin_tokens
    - ag_plugin_ui_contributions
    - ag_plugins
    - ag_policies
    - ag_policy_assignments
    - ag_policy_versions
    - ag_provider_sync_state
    - ag_secrets
    - ag_sessions
    - ag_sites
    - ag_user_policy_state
    - ag_users
    - ag_verify_assertions
    - ag_verify_challenges
    - ag_verify_clients
  一致性  : IR 声明 40 张 == 活库 40 张 ✅
```

退出码 `0`。

**结论**：**40 张表全部在真 PG 上创建成功，失败 0 条**。活库表集合与 IR 完全一致。

### 2.1 `--data-dir`（可选持久化）

**命令**：`npm run db:migrate -- --data-dir /tmp/pgdata-demo`

```
db:migrate OK —— 实际创建 40 张表，执行 215 条语句，耗时 9291ms
  一致性  : IR 声明 40 张 == 活库 40 张 ✅
EXIT=0          （目录 41MB）
```

**复跑同一目录**（DDL 是 `CREATE` 而非 `IF NOT EXISTS`，**迁移本身不幂等**）：

```
FAIL: 第 1/215 条语句执行失败
  语句类型 : enum
  归属表   : <无>
  枚举类型 : ag_user_status
  PG 原始报错: type "ag_user_status" already exists
  语句文本 :
    | CREATE TYPE ag_user_status AS ENUM ('pending', 'active', 'suspended', 'deleted');
EXIT=1
```

**结论**：`--data-dir` 可用；**失败路径按契约打印「语句序号 / 语句类型 / 归属表 / 枚举名 / PG 原始报错 / 语句原文」**，可定位到具体语句与表。迁移重放应由迁移器版本管理，不用 `IF NOT EXISTS` 掩盖结构差异——这是刻意保留的行为。

---

## 3. 验收 2：`--drift-demo` 四种人为漂移

四条命令均用 `--no-gate` 运行，使**退出码 1 完全来自漂移**（不含门禁影响）；每次演示都先跑基线（0 条漂移），再对活库执行一条人为破坏 DDL。

### 3.1 `column-type`（退出码 **1**）

**命令**：`npm run db:check -- --no-gate --drift-demo column-type`

```
  基线：DDL 真跑 215 条语句（表 40 · 枚举 45 · 索引 85），漂移发现 0 条

  drift-demo(column-type)：把 ag_users.email 从 varchar(255) 改为 text
  人为破坏 DDL：ALTER TABLE ag_users ALTER COLUMN email TYPE text;
 1. [type] ag_users — 列 email 类型不一致
      期望: character varying (udt=varchar)
      实际: text (udt=text)
 2. [length] ag_users — 列 email 长度不一致
      期望: 255
      实际: <无>

  检出 2 条漂移；期望 kind=type，命中 kind=type
PASS: drift-demo(column-type) 被检出（退出码 1，与非漂移场景可区分）
db:check 汇总：门禁=0 漂移=1 → 退出码 1
```

### 3.2 `drop-column`（退出码 **1**）

```
  drift-demo(drop-column)：删除活库中的列 ag_users.password_hash
  人为破坏 DDL：ALTER TABLE ag_users DROP COLUMN password_hash;
 1. [missing-column] ag_users — IR 声明了列 ag_users.password_hash（varchar），活库中不存在
      期望: varchar
      实际: <无>
  检出 1 条漂移；期望 kind=missing-column，命中 kind=missing-column
db:check 汇总：门禁=0 漂移=1 → 退出码 1
```

### 3.3 `add-column`（退出码 **1**）

```
  drift-demo(add-column)：给 ag_users 增加 IR 未声明的列 zz_drift_demo
  人为破坏 DDL：ALTER TABLE ag_users ADD COLUMN zz_drift_demo text;
 1. [extra-column] ag_users — 活库中存在列 ag_users.zz_drift_demo，IR 未声明
      期望: <无>
      实际: text (udt=text)
  检出 1 条漂移；期望 kind=extra-column，命中 kind=extra-column
db:check 汇总：门禁=0 漂移=1 → 退出码 1
```

### 3.4 `drop-index`（退出码 **1**）

```
  drift-demo(drop-index)：删除活库中的索引 uq_ag_users_email（ag_users）
  人为破坏 DDL：DROP INDEX uq_ag_users_email;
 1. [missing-index] ag_users — IR 声明了索引 uq_ag_users_email，活库中不存在
      期望: unique(email) where deleted_at is null
      实际: <无>
  检出 1 条漂移；期望 kind=missing-index，命中 kind=missing-index
db:check 汇总：门禁=0 漂移=1 → 退出码 1
```

**结论**：**四种人为漂移全部被检出，退出码均为 1**；且每种都先证明「不破坏时 0 条漂移」——**检测既非恒真也非恒假**。
（默认模式 `npm run db:check -- --drift-demo column-type` 同样退出 1，输出为 `门禁=1 漂移=1`。）

---

## 4. 验收 3：真实声明的表数核对

**命令**：

```bash
grep -c '^CREATE TABLE' migrations/0001_init.sql
node --experimental-strip-types --input-type=module -e "
import { loadTables } from './src/schema/compile/load-tables.ts';
const l = await loadTables({ requireReal: true });
console.log(l.tables.length);"
```

**原始输出**：

```
CREATE TABLE 语句数（migrations/0001_init.sql）: 40
CREATE TYPE  语句数（migrations/0001_init.sql）: 45
CREATE INDEX 语句数（migrations/0001_init.sql）: 85
表级复合主键数（migrations/0001_init.sql）: 1
src/schema/tables/index.ts 的 allTables 导出表数: 40
```

**`db:generate` 自身的输出**：

```
db:generate 完成
  来源              : 真实声明 src/schema/tables/index.ts（40 张表）
  表  (CREATE TABLE): 40
  枚举(CREATE TYPE) : 45
  索引(CREATE INDEX): 85
  onUpdateNow 触发器表: 15
  语句总数          : 215
  写入              : migrations/0001_init.sql
  写入              : sql/schema.sql
```

**结论**：**`CREATE TABLE` 40 == `allTables` 导出 40** ✅；索引 85 == IR 索引 85（空列索引 0）。

`migrations/0001_init.sql` 头部（产物自带来源与规模，且声明「禁止手改」）：

```
-- access-gate 初始化迁移（0001_init）
--
-- ⚠ 自动生成，请勿手改：本文件由 `npm run db:generate` 从 Schema 声明层 IR 推导。
--    （契约见 docs/12-Schema声明层接口契约.md §5.2「DDL 禁止手写」）
-- 来源：真实声明 src/schema/tables/index.ts（40 张表）
-- 规模：表 40 · 枚举 45 · 索引 85
-- 复跑：npm run db:generate && npm run db:migrate && npm run db:check

CREATE TYPE ag_user_status AS ENUM ('pending', 'active', 'suspended', 'deleted');
```

---

## 5. 验收 4：docs/02 两处「无法生成 DDL」损坏的实测结论

方法：把 docs/02 的目标代码围栏**原样取出**，仅把 `export const` 去掉后用 `new Function` 真执行（围栏内是纯 JS 语法，无类型标注），再编译 DDL 并真跑到空库。

### 5.1 损坏①：`defaultSql` 生成无效的 `DEFAULT {}`（`docs/00` §2.4）

**实测命令**（一次性探针，跑完即删）：取 `docs/02` §3.1 `ag_users` 围栏（行 48–73）。

```
===== B. 损坏① docs/02 §3.1 ag_users（含 jsonb defaultSql）—— 围栏原样执行 =====
  围栏：行 48–73（声明在行 49）
  围栏原样执行：SyntaxError —— Unexpected token ']'
  围栏末尾 3 行：
    |   t.index (['status'],      { name: 'ix_ag_users_status' }),
    | ]);
    | ]);

===== B2. 去掉孤立的收尾符 `]);` 后重新执行 =====
  删除行数：1（maps docs/02 行 72 的孤立 `]);`）
  执行：成功
  编译产物（含默认值的列）：
    | id uuid PRIMARY KEY DEFAULT uuidv7(),
    | email_verified boolean DEFAULT false NOT NULL,
    | status ag_user_status DEFAULT 'pending' NOT NULL,
    | source ag_user_source DEFAULT 'local' NOT NULL,
    | locale varchar(16) DEFAULT 'zh-CN' NOT NULL,
    | tags jsonb DEFAULT '[]' NOT NULL,
    | profile jsonb DEFAULT '{}' NOT NULL,
    | created_at timestamptz DEFAULT now() NOT NULL,
    | updated_at timestamptz DEFAULT now() NOT NULL,
  是否出现非法 DEFAULT {}：否
  空库真跑：成功（9 条语句）
```

**结论（损坏①）**：
1. **`DEFAULT {}` 在当前链路上不可复现**。`docs/02` 的 jsonb 默认值一律写成带引号的 `defaultSql("'[]'")` / `defaultSql("'{}'")`；`dsl.ts` 把它们规范化为 `{form:'sql', expr:"'[]'"}`，编译器**原样输出** `DEFAULT '[]'` / `DEFAULT '{}'`，真跑成功（9 条语句）。
2. **该损坏类若再出现，会被 PG 立刻拦下**。取「把 DefaultValue 对象串成 `DEFAULT {}`」的形态直跑：

```
===== B3. 反例：直接跑「编译器把 DefaultValue 对象串成 DEFAULT {}」的形态 =====
  PG 原始报错：syntax error at or near "{"
  对照：DEFAULT '[]' 成功
```

→ 即 `CREATE TABLE t_bad (x jsonb NOT NULL DEFAULT {});` 在 PG18 上报 `syntax error at or near "{"`，`db:migrate` 会带着「第 N 条语句 / 表名 / 原始报错」fail-fast。
3. 附带实测到的**新损坏**（`docs/12` §6 的 D-4「多余的 `]);`」）：`docs/02` **行 72** 的孤立 `]);` 使 §3.1 围栏**原样不可执行**（`SyntaxError: Unexpected token ']'`）；删掉该行后正常。

### 5.2 损坏②：`actionSeq` 行尾字面量换行符（`docs/00` §2.4）

分两步实测。

**(a) 字面量 `\n`（反斜杠 + n 两个字符）是否还在文档里**：

```
===== A. docs/02 中的「字面量换行符」（反斜杠 + n 两个字符） =====
命中行数：0

===== A2. 02:826-833 原始字节（JSON 转义，可看出行尾） =====
  826: "]);"
  827: "```"
  828: ""
  829: "### 6.3 `ag_actions_log` ——"
  830: "  traceId:    col.varchar(48).nullable(),   // ★ 关联四元组的首元素：跨 HTTP/后台任务贯通 动作执行与幂等"
  831: ""
  832: "```ts"
  833: "export const actionsLog = defineTable('ag_actions_log', {"
```

**(b) §6.3 围栏（行 832–868）原样执行**：

```
===== C. 损坏② docs/02 §6.3 ag_actions_log —— 围栏原样执行 =====
  围栏：行 832–868（声明在行 833）
  围栏原样执行：成功
  编译产物片段：
    | CREATE TABLE ag_actions_log (
    | action_seq bigint NOT NULL,
  该表列数：20；含 trace_id 列：false
  空库真跑：成功（5 条语句）

===== C2. 若把 docs/02 行 830 的孤立行一并计入 §6.3 声明 =====
  行 830 原文："  traceId:    col.varchar(48).nullable(),   // ★ 关联四元组的首元素：跨 HTTP/后台任务贯通 动作执行与幂等"
  执行：SyntaxError —— Unexpected token 'return'
```

**结论（损坏②）**：
1. **字面量 `\n` 已不在 docs/02 中**（`grep` 命中 0 行）——`docs/00` §2.4 的「✅ 已删」属实。
2. **残留的是它的孪生形态：一个被挤出代码围栏的列声明**。`ag_actions_log` 的 `traceId` 列现在**孤零零地停在 `docs/02` 行 830**（`### 6.3` 标题与 ` ```ts ` 之间的正文里，**不在任何围栏内**）。
   - 只取围栏（行 832–868）→ 执行成功、真跑成功，但该表**只有 20 列、没有 `trace_id`** —— **静默丢列**（`traceId` 是 05 契约里「关联四元组的首元素」，丢了不会报任何错）。
   - 若提取器把行 830 也并进声明 → `SyntaxError: Unexpected token 'return'`，**报错但位置误导**。
   → 因此**「行尾字面量换行符」这类损坏的真实危害是「静默丢列」**，不是「PG 报错」。这也正是本次 spike 必须做的理由。
3. **真实声明（`src/schema/tables/execution.ts`）已正确处理**：`actionsLog` 里 `traceId` 在列，注释标注来源 `docs/02-数据模型.md:831`。即提取器补偿了文档的位移，**文档原文仍应修**（`docs/` 不在本工作流可写范围，仅登记）。

---

## 6. 验收 5：`npm run ci` 逐项结果

**命令**：`npm run ci`（退出码 **1**）

> 第 1–7 项由本工作流实现；**第 8 项「单一事务入口」由 M0-11a 工作流并入同一入口**（调用契约 §2 的
> `src/db/guard.ts` → `scanSource`）。因此最终输出是 **8 项**，下表为最终快照。

```
==============================================================================
access-gate CI 门禁（M0-11）
  表声明来源: 真实声明 src/schema/tables/index.ts（40 张表）
==============================================================================

[PASS] 1. tsc --noEmit
        类型检查通过

[PASS] 2. 单测（test/compile.test.ts, test/gate.test.ts, test/guard.test.ts, test/scope-e2e.test.ts, test/scope.test.ts）
        # tests 66
        # suites 0
        # pass 66
        # fail 0

[PASS] 3. DDL 编译快照对比
        sql/schema.sql 与编译产物逐字节一致（34818 字节）

[FAIL] 4. db:check（门禁 + 漂移检测）
        退出码 1

[PASS] 5. site_id 缺失检测
        siteScoped 表 34/40 张，全部含 site_id 列

[PASS] 6. 禁止裸 SQL 扫描（src/**/*.ts）
        扫描 22 个文件，0 命中

[FAIL] 7. 核心代码具体系统名 = 0（src/**）
        src/schema/tables/_extracted.json:2840 核心代码出现具体系统名「newapi」；核心必须系统无关（应写 subject/provider 抽象） —— "name": "newapiLogId",
        src/schema/tables/execution.ts:141 核心代码出现具体系统名「newapi」；核心必须系统无关（应写 subject/provider 抽象） —— grantVia:      col.varchar(32).notNull().default("newapi"),
        src/schema/tables/execution.ts:142 核心代码出现具体系统名「newapi」；核心必须系统无关（应写 subject/provider 抽象） —— newapiLogId:   col.bigint().nullable(),

[PASS] 8. 单一事务入口（禁事务外驱动查询）
        扫描 22 个文件（白名单：src/db/{tx,pool}.ts），0 命中

==============================================================================
CI 汇总
  [PASS] 1. tsc --noEmit
  [PASS] 2. 单测（test/compile.test.ts, test/gate.test.ts, test/guard.test.ts, test/scope-e2e.test.ts, test/scope.test.ts）
  [PASS] 3. DDL 编译快照对比
  [FAIL] 4. db:check（门禁 + 漂移检测）
  [PASS] 5. site_id 缺失检测
  [PASS] 6. 禁止裸 SQL 扫描（src/**/*.ts）
  [FAIL] 7. 核心代码具体系统名 = 0（src/**）
  [PASS] 8. 单一事务入口（禁事务外驱动查询）

CI 结果：FAIL（退出码 1）
```

### 6.1 第 4 项为什么 FAIL：门禁的真实结论（R4 生效）

`db:check` 第 (a) 阶段对 40 张真实表跑 R1–R6：

```
站点作用域门禁（R1–R6）：8 个 error / 3 个 warn
✗ error [R3] ag_email_rules        既无 site_id 也无 owner_scope，且未在 PLATFORM_EXEMPTIONS 中逐表签署理由
✗ error [R1] ag_plugin_instances   唯一键 uq_ag_plugin_inst_dev 的首列是 'developer_id'，不是 site_id
✗ error [R5] ag_plugin_instances   双作用域表缺少 scope CHECK
! warn  [R6] ag_plugin_instances   uq_ag_plugin_inst_dev 的列 [developer_id] 可空 → 唯一约束静默失效
! warn  [R6] ag_plugin_instances   uq_ag_plugin_inst_site 的列 [site_id] 可空 → 唯一约束静默失效
✗ error [R1] ag_dev_invitations    site_id 列可空
✗ error [R1] ag_dev_invitations    唯一键 uq_ag_dev_invitations_code 的首列是 'code_hash'，不是 site_id
✗ error [R3] ag_plugin_configs     既无 site_id 也无 owner_scope，且未在清单中豁免
! warn  [R6] ag_plugin_bindings    uq_ag_bindings_external 的列 [external_id] 可空
✗ error [R3] ag_plugin_packages    既无 site_id 也无 owner_scope，且未在清单中豁免
✗ error [R1] ag_policy_versions    唯一键 uq_ag_policy_versions 的首列是 'policy_id'，不是 site_id
结论：存在 error → 消费方（db:check / npm run ci）必须非零退出（R4）。
FAIL: 门禁发现 8 条 error（warn 3 条）→ R4：db:check 必须非零退出
```

第 (b) 阶段同时证明**结构本身零漂移**：

```
  基线：DDL 真跑 215 条语句（表 40 · 枚举 45 · 索引 85），漂移发现 0 条
db:check OK —— 表/列/类型/可空/长度/默认值/主键/索引/枚举全部一致，0 条漂移

db:check 汇总：门禁=1 漂移=0 → 退出码 1
```

**结论**：第 4 项 FAIL 是 **R4 按契约生效**——不是漂移检测或管道故障。`db:check` 已接门禁模块的 `hasErrors()` 判定 R4（`formatViolations()` 渲染报告），退出码 1。

### 6.2 第 7 项为什么 FAIL：文档原文的具体系统名（**诚实 FAIL，不加白名单**）

- `src/schema/tables/execution.ts:141` `grantVia: col.varchar(32).notNull().default("newapi")`
- `src/schema/tables/execution.ts:142` `newapiLogId: col.bigint().nullable()`
- `src/schema/tables/_extracted.json:2840`（提取产物里的同名列）

根因是 **`docs/02-数据模型.md` 的 `ag_checkin_records` 原文**（`newapiLogId` 与 `grantVia ... default('newapi')`），**不是提取器缺陷**；`docs/` 不在本工作流可写范围，故**按诚实 FAIL 呈现**，由 Captain 作为已知未达标项裁定（改文档 / 改列名 / 或明确豁免——但**没有**静默白名单）。

### 6.3 门禁非恒真的证明：`npm run ci -- --self-test`

```
== CI 门禁自检（--self-test）：用故意违规的输入证明门禁不是恒真 ==
[PASS] 5. site_id 缺失检测 —— 故意去掉 site_id → 检出 1 条（期望 1）
[PASS] 5. site_id 缺失检测（反例） —— siteScoped:false → 检出 0 条（期望 0）
[PASS] 6. 裸 SQL 扫描 —— 模板字面量拼接 SELECT → 检出 1 条（期望 ≥1）
[PASS] 6. 裸 SQL 扫描（反例：参数化字面量） —— 无插值的参数化 SQL → 检出 0 条（期望 0）
[PASS] 7. 系统名扫描 —— 出现 newapi → 检出 1 条（期望 1）
[PASS] 7. 系统名扫描（反例） —— 系统无关命名 → 检出 0 条（期望 0）

自检 PASS：门禁 5/6/7 均可被故意违规触发。
```

退出码 `0`。

### 6.4 一个必须记录的观察：第 1 项是**全仓库** tsc

`npm run ci` 的第 1 项 `tsc --noEmit` 覆盖 `src/** + test/** + tools/**`，因此**任何并行工作流的中间状态都会让 CI 变红**。实测到一次：

```
[FAIL] 1. tsc --noEmit
        src/db/scope.ts(141,9): error TS18049: 'session' is possibly 'null' or 'undefined'.
        src/db/scope.ts(141,52): error TS18049: 'session' is possibly 'null' or 'undefined'.
        src/db/scope.ts(142,29): error TS18049: 'session' is possibly 'null' or 'undefined'.
```

该文件（M0-5 站点作用域工作流）在几十秒后由作者改完，同一命令随即 `TSC=0`。
**结论**：CI 门禁只对「一致的树」有意义；并行开发期出现红项时，先确认是**自己的改动**还是**队友的中间状态**，不要据此判定管道故障。

### 6.5 跨工作流口径冲突（已上报，待裁决）：两套「裸 SQL」扫描器

第 6 项用本工作流的 `scanRawSql`（`src/schema/compile/ci-checks.ts`），第 8 项用契约 §2 的
`src/db/guard.ts → scanSource`（M0-11a 工作流）。后者除 `outside-transaction` 外还会报 `raw-sql`，
而它的关键字集**包含 DDL**（`CREATE TABLE` / `ALTER TABLE` / `DROP TABLE`），于是把 **DDL 编译器**判成违规：

```
src/schema/compile/ddl.ts:231 [raw-sql] `CREATE TRIGGER ${trg} BEFORE UPDATE ON ${tbl} FOR EACH ROW EXECUTE FUNCTION ${fn}();`
src/schema/compile/ddl.ts:305 [raw-sql] `CREATE TABLE ${quoteIdent(table.tableName)} (\n${lines.join(',\n')}\n);`
```

这是**误报**：契约 §5.2 明确要求「DDL 由 IR 推导、禁止手写」，DDL 编译器按定义必须用插值拼装 DDL；
它不是业务查询，也不存在参数化占位符的替代写法（标识符不能参数化）。
（同类误报已修 1 处：本工作流 `ci-checks.ts` 注释里曾内联一个反引号包住的 SQL 例子，已被扫到，已改写。）

**现状**：第 8 项只消费 `rule === 'outside-transaction'`，所以 `npm run ci` 不受影响（第 8 项 PASS）。
**建议**（`src/db/guard.ts` 不在本工作流可写范围）：`raw-sql` 规则把关键字限制为 DML，
或把 `src/schema/compile/**` 加入白名单——否则一旦有人把 guard 的 `raw-sql` 也接进 CI，DDL 编译器会持续红。

---

## 7. 过程中被机器化暴露并修复的缺陷

这一节是 spike 的**主要产出**：这些缺陷在「只读文档 + 只跑单测」时都是不可见的。

| # | 缺陷 | 暴露方式 | 状态 |
|---|---|---|---|
| D-1 | **`dsl.ts` 的 `ColumnType<T>` 未声明链式方法** → docs/02 的 `col.uuid().primaryKey().defaultSql('uuidv7()')` 全仓库 TS2339 | `tsc --noEmit` | ✅ Captain 已修（`ChainableMethods`）；我的类型补丁 `compile/chain.ts` 已删除 |
| D-2 | **提取器把「索引」说明误当声明** → 32 处 `t.index([])`，会生成非法的 `CREATE INDEX ... ()` | `db:generate` 报「声明损坏：32 处索引没有任何列」 | ✅ Captain 已修（`callArgs` needle 错位 + `t.index (` 空格）；现 85 条索引全部有效、空列 0 |
| D-3 | **where 谓词里的单引号未转义** → `where: 'status = 'active''`（4 处），JS 语法错误 | `tsc --noEmit` TS1005 | ✅ Captain 已修（`tsString()` 外层用双引号） |
| D-4 | **`defaultSql` 多包一层引号** | 提取器自检 | ✅ Captain 已修（`unwrapLiteral()`） |
| D-5 | **`t.primaryKey([...])` 表级复合主键被编译器静默忽略** → `ag_provider_sync_state` 的 `PRIMARY KEY (site_id, provider)` **没进 DDL**；且漂移检测两边同时忽略 → **报 0 漂移**（最危险的一类：假绿） | 检查 `migrations/0001_init.sql` 与 IR 的 `table.primaryKey` 字段 | ✅ **本工作流已修**：`ddl.ts` 新增 `tablePrimaryKey()` / `effectiveNullable()`，`drift.ts` 主键与可空性比较改用它；新增 2 条回归测试（含「去掉活库主键必须检出」的反例） |
| D-6 | **漂移比较口径把枚举字面量谓词判成差异** → PG 把 `status = 'enabled'` 反解为 `status = 'enabled'::ag_plugin_status`，误报 4 条 `index-definition` | 真实声明的首轮全量真跑 | ✅ **本工作流已修**：`normalizePredicate()` 先剥 `::type`；新增单测 + 集成测试 |
| D-7 | **bigserial 默认值误报**：IR 未声明默认值，PG 自动 `nextval(...)` → 假漂移 | 夹具集成测试 | ✅ 已修：只比较 IR **声明了**默认值的列 |
| D-8 | **enum 的 `data_type` 大小写**：IR 期望 `USER-DEFINED`，比较时只 lowercase 了实际值 → 假漂移 | 夹具集成测试 | ✅ 已修 |
| D-9 | **CI 第 7 项自命中**：检测器自己的正则字面量 `/newapi|new-api/i` 被自己扫到 | 首轮 `npm run ci` | ✅ 已修：模式由片段拼出（`['new','api'].join('')`），并加注释说明原因 |
| D-10 | **提取器未调用 `setDeclaredLine()`** → 所有表 `source.line === 0`，缺陷报告无法回溯到 docs 行号 | 聚合报错里出现 `docs/02-数据模型.md:0` | ⏳ 未修（低危，登记） |
| D-11 | **`src/schema/tables/_extracted.json` 被第 7 项扫到**（`src/**` 含构建中间产物） | 首轮 `npm run ci` | ⏳ 待裁定：或把中间产物移出 `src/`，或接受 FAIL |

### 7.1 修复 D-5 前后的实测对照

**修复前**（`migrations/0001_init.sql` 里的 `ag_provider_sync_state`，**没有主键**）：

```
CREATE TABLE ag_provider_sync_state (
  site_id uuid NOT NULL,
  provider varchar(64) NOT NULL,
  ...
  updated_at timestamptz DEFAULT now() NOT NULL
);                                   ← 缺 PRIMARY KEY，且 db:check 报 0 漂移（假绿）
```

IR 侧事实：`table.primaryKey = ["site_id","provider"]`，`columns with primaryKey=true = []`（表级复合主键不走列级标记）。

**修复后**：

```
  updated_at timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (site_id, provider)
);
```

新增回归测试（`test/compile.test.ts`）：
- `复合主键：t.primaryKey([...]) 走表级 PRIMARY KEY，且不内联`
- `复合主键：空库真跑 + 漂移检测识别主键成员与顺序`（含反例：`DROP CONSTRAINT ag_composite2_pkey` → 必须报 `primary-key` 漂移，`expected='site_id, provider'`）

---

## 8. PGlite / PG 的能力与口径限制（实测）

| # | 限制 | 实测事实与应对 |
|---|---|---|
| L-1 | **PGlite 0.5.8 = PostgreSQL 18.3**，不是 17 | `select version()` = `PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten`。**`uuidv7()` 原生存在**（PG18 新特性），docs/02 里 40 张表的 `defaultSql('uuidv7()')` 无需任何 shim；`CREATE OR REPLACE TRIGGER` 亦可（PG14+）。我原本准备了「uuidv7 缺失」的兜底方案，实测后**不需要**。 |
| L-2 | **`bytea` 没有长度属性** | `col.binary(32)` → `bytea`，`information_schema.columns.character_maximum_length` 恒为 `NULL`。因此 `binary(n)` 的 `length` **不参与漂移比较**（`expectedType()` 里显式注释）。 |
| L-3 | **`information_schema` 无法区分 `DEFAULT NULL` 与「无默认值」** | 两者 `column_default` 都是 `NULL`。漂移比较把「IR 声明 `DEFAULT NULL`」与「活库无默认值」视为等价；**IR 未声明默认值时整列跳过比较**（bigserial 的 `nextval(...)` 因此不会误报）。 |
| L-4 | **PG 会重写部分索引谓词** | `pg_get_expr(indpred, indrelid)` 把 `status = 'enabled'` 反解成 `(status = 'enabled'::ag_plugin_status)`（枚举/域类型字面量加显式转换）。`normalizePredicate()` 先剥外层括号、再剥全部 `::type`、再归一化空白与大小写。 |
| L-5 | **PG 为主键自动创建 `<table>_pkey` 唯一索引** | 漂移检测必须排除 `indisprimary` 索引，否则每张表恒报 `extra-index`。主键单独用 `pg_constraint(contype='p')` 的 `conkey` 顺序比较。 |
| L-6 | **PGlite 是嵌入式单连接实例** | 不支持多会话/并发连接与真实 `pg_advisory_lock` 双实例抢占——M0-8 的「两实例抢锁只有一者成功」必须用真实 PG 验证，本 spike 只覆盖 DDL 与结构。 |
| L-7 | **内存实例每次冷启动都要重建** | 40 张表 / 215 条语句约 **8.8–10.8s**（wasm 单线程）。故默认内存（避免磁盘 IO），`--data-dir` 仅在需要时用。 |
| L-8 | **迁移不幂等** | DDL 是 `CREATE`/`CREATE TYPE` 而非 `IF NOT EXISTS`；对已有数据的目录复跑会在第 1 条语句失败（见 §2.1）。这是刻意行为：结构差异应由迁移版本管理，而不是被 `IF NOT EXISTS` 掩盖。 |

---

## 9. 未决问题 / 未达标项（交裁决）

| # | 事项 | 现状 | 需要谁裁定 |
|---|---|---|---|
| U-1 | **CI 第 7 项**：核心代码含具体系统名（execution.ts:141/142、_extracted.json:2840） | **FAIL（诚实呈现，未加白名单）** | 需改 `docs/02` 原文（`newapiLogId` / `default('newapi')`）或明确豁免口径 |
| U-2 | **门禁 8 error / 3 warn**（R1/R3/R5） | `db:check` 退出 1；`npm run ci` 第 4 项 FAIL | 需修声明（如 `ag_dev_invitations.siteId` 非空、唯一键首列含 siteId、`ag_email_rules`/`ag_plugin_configs`/`ag_plugin_packages` 补作用域或豁免、`ag_plugin_instances` 的 R5 边界由契约方裁决） |
| U-3 | **`ag_plugin_instances` 的 R1-b 与 R5 冲突** | 门禁自己给出诊断读法 `options.dualScopeUniqueKeys: 'scope-aware'`；当前 `db:check` 用**默认 strict** | 契约方裁决（本工作流不擅自放宽门禁） |
| U-4 | **`src/schema/tables/_extracted.json` 在 `src/**` 内** | 被第 7 项扫到；它更像构建中间产物 | 建议移出 `src/`（如 `build/` 或 `.tmp/`） |
| U-5 | **`source.line` 全为 0** | 提取器未调用 `setDeclaredLine()`，缺陷报告无法回溯到文档行号 | 提取器作者（低危） |
| U-6 | **`docs/02` 行 830 孤立行（`traceId` 在围栏外）** | 真实声明已补偿（`execution.ts` 标注来源 02:831），但文档原文仍会**静默丢列** | 文档作者（本工作流不改 `docs/`） |
| U-7 | **`docs/02` 行 72 孤立 `]);`**（`docs/12` D-4） | 使 §3.1 围栏原样不可执行 | 文档作者 |
| U-8 | **05 §7.1.2 承诺的 `ag_event_outbox` / `ag_dead_letters`** | `src/schema/tables/` 中确认**无声明**；**未为它们编造 DDL** | 范围裁决（M0 不含，按 `docs/12` D-5 登记） |
| U-9 | **`normalize.primaryKeyColumns()` 不认表级复合主键** | 冻结件里它对 `table.primaryKey` 返回 `[]`；任何消费方误用都会静默丢主键（D-5 就是这么发生的） | 建议契约方把 `table.primaryKey` 并入该辅助函数，或在契约里写明「消费方必须用 `compile/ddl.tablePrimaryKey()`」 |
| U-10 | **两套「裸 SQL」扫描器口径冲突**（§6.5） | guard 的 `raw-sql` 关键字集含 DDL，把 DDL 编译器判成违规；当前因第 8 项只取 `outside-transaction` 而未影响 CI | `src/db/guard.ts` 作者：限制为 DML 或白名单 `src/schema/compile/**` |
| U-11 | **CI 第 1/2 项是全仓库的**，并行工作流的中间状态会让 CI 变红 | 实测到 `src/db/scope.ts` 与新建测试文件的两次瞬时红项（数十秒后自愈） | 流程约定：判定 FAIL 前先确认是否为本工作流改动 |

---

## 10. 交付物与命令对照

| 文件 | 作用 | 关键命令 |
|---|---|---|
| `src/schema/compile/ddl.ts` | IR → PG DDL（枚举去重 / 类型映射 / 默认值三形态 / 单列与复合主键 / 部分唯一索引 / CHECK / onUpdateNow 触发器 / 空列索引拒绝） | `db:generate` · `db:migrate` |
| `src/schema/compile/drift.ts` | PGlite 开库 + 逐条真跑（失败定位）+ `information_schema`/`pg_catalog` 回读 + 差异比对 + drift-demo 计划 | `db:migrate` · `db:check` |
| `src/schema/compile/load-tables.ts` | 装载真实声明（`src/schema/tables/index.ts` 的 `allTables`），未就绪时回落夹具并**显式标注** | 全部工具 |
| `src/schema/compile/fixtures.ts` | 5 张夹具表（真实声明未就绪时的自检用；**不是验收对象**） | `test/compile.test.ts` |
| `src/schema/compile/ci-checks.ts` | CI 第 5/6/7 项纯函数（含 `--self-test`） | `npm run ci` |
| `tools/db-generate.ts` | 产出 `migrations/0001_init.sql` + `sql/schema.sql` | `npm run db:generate` |
| `tools/db-migrate.ts` | 空库真跑；`--data-dir` 可选持久化 | `npm run db:migrate` |
| `tools/db-check.ts` | 门禁（缺失即 SKIP + 非零）+ 漂移检测 + `--drift-demo` | `npm run db:check` |
| `tools/ci-gate.ts` | CI 门禁 1–7 项 + `--self-test`（第 8 项由 M0-11a 工作流并入） | `npm run ci` |
| `test/compile.test.ts` | 23 条单测/集成测试（类型映射、默认值三形态、主键（含复合）、部分唯一索引、枚举去重、触发器幂等、枚举谓词、空列索引拒绝） | `npm test` |
| `migrations/0001_init.sql` · `sql/schema.sql` | 由真实声明生成的 DDL 与快照 | `db:generate` |
