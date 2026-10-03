# Schema 文档缺陷报告（机器化暴露）

> **产生方式**：`tools/extract-doc-schema.ts` 从 `docs/02-数据模型.md` 提取 40 张表声明 → `src/schema/tables/*.ts`
> → `normalizeTables()` → 门禁 `checkScopeRules()` + 结构自检 `tools/verify-tables.ts`。
> **复现命令**（全部可重跑，不需要人工判断）：
>
> ```bash
> node --experimental-strip-types tools/extract-doc-schema.ts   # 提取 + 断言修复点
> node --experimental-strip-types tools/verify-tables.ts        # 结构自检 + R1–R6 门禁
> node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
> ```
>
> **纪律**：本报告只**登记**缺陷，不改 `docs/**`。凡标「已由提取器修正」的，都是提取器在生成时按固定规则修复，
> 并在 `tools/extract-doc-schema.ts` 的 `REPAIRS` 中**断言命中行号**——文档一旦被修正，提取器会立即报错而不是静默漂移。

---

## 0. 摘要

| 类别 | 数量 | 严重度 |
|---|---|---|
| 使代码块**无法解析**的结构性损坏（重复收尾符、缺围栏、块引用内混排） | 6 处 | 高 |
| 使声明**语义与文档承诺不符**的作用域归属缺陷 | 3 张表（R3） | 高 |
| 「已修正」声称与实际声明不符 | 2 张表 | 高 |
| 规则自身缺陷（豁免清单指向错误的规则分支、规则未覆盖已承诺的 fail-fast） | 2 处 | 中 |
| 核心代码出现**具体系统名**（违反 D5 硬约束） | 1 张表 3 处 | 中 |
| 声明无法表达设计意图（复合主键、分区） | 2 处 | 中 |
| 唯一键含可空列 → UNIQUE 静默失效 | 3 处 | 中 |
| 列/表定义错位复制 | 1 处 | 中 |

**一句话结论**：`docs/02` 作为「单一事实来源」是**基本可用**的，但它**不能直接当代码用**——40 张表里有 6 处结构性损坏会
让任何手工或自动的 DDL 生成在解析阶段就失败；另有 3 张表的作用域归属不满足它自己 §1 定的派生规则。

---

## 1. 结构性损坏（6 处，已由提取器按固定规则修正）

这 6 处是「文档代码块本身不合法」的问题。它们**不会**在阅读时被发现（人眼会脑补补齐），但会让
`tsc` / 任何解析器失败。这正是「先跑一次 DDL spike」的价值所在。

| ID | 位置 | 原文现象 | 影响 | 提取器的修正 | 文档应怎么改 |
|---|---|---|---|---|---|
| **D-1** | `02:71-72` | `ag_users` 定义后**连续两行** `]);` | 该代码块多一个收尾符 → 解析失败 | 删除第二个 `]);` | 删掉第 72 行 |
| **D-2** | `02:109-110` | `ag_identities` 定义后同样连续两行 `]);` | 同上 | 删除第二个 `]);` | 删掉第 110 行 |
| **D-6** | `02:829-832` | `### 6.3 ag_actions_log` 标题下先出现一行散装的 `traceId: ...`，其后方才是 ` ```ts ` 围栏 | `traceId` 落在围栏外，**不属于任何声明**；`ag_actions_log` 缺这一列 | 把该列移回表体首列 | 把第 832 行的 ` ```ts ` 上移到 `### 6.3` 标题之后 |
| **D-4** | `02:875-883` | `ag_checkin_entitlements` 定义在**块引用**（`> `）内，且缺主键 `id`（该行文本出现在 `ag_checkin_records` 里） | 该表无主键；块引用前缀使块内首行带 `> ` | 补 `id: col.uuid().primaryKey().defaultSql('uuidv7()')` | **需设计方裁决**：确认该表主键是 UUIDv7 还是自然键 `(siteId,userId,scope)` |
| **D-3** | `02:877-878` | `siteId` 被声明**两次**（877 行单独一次、878 行又与 `userId` 同行一次） | 重复列 → 解析失败 | 合并为一条 `siteId` + 一条 `userId` | 删掉 878 行里的 `siteId: col.uuid().notNull(),` |
| **D-5** | `02:876-883` | 块引用内部前缀不统一（`> ` 与 `>   ` 混排），缩进与其它行不一致 | 提取器需特殊处理；人工阅读易误判归属 | 统一剥离 `> ` 前缀并规范化缩进 | 统一块引用前缀与缩进 |

> **D-4 的修正带有推断成分**，已在提取器的 `note` 里显式标注：若设计意图是「以 `(siteId,userId,scope)` 为自然键、不要代理主键」，
> 则应当改文档而不是补 `id`。**这一条需要设计方确认**，不能由实现方默认。

---

## 2. 作用域归属缺陷（R1/R3/R5/R6）

门禁规则见 `02 §1`（R1–R5）与 `docs/12-Schema声明层接口契约.md §5.1`（R6 为契约新增）。
实跑结果：**8 error / 3 warn**（`tools/verify-tables.ts` 原始输出可复现）。

### 2.1 R3 违规：既无 `siteId` 也无 `ownerScope`，且未在豁免清单

| 表 | 位置 | 判定 | 建议 |
|---|---|---|---|
| `ag_email_rules` | `02:140` | ❌ R3 error | 补 `siteId notNull`（它是站点级邮箱规则）或补 `ownerScope+ownerId` 双非空 |
| `ag_plugin_configs` | `02:390` | ❌ R3 error | **与 `00 §2.2` 行 43 的「✅ 已修正」矛盾**：声明里没有任何作用域列 |
| `ag_plugin_packages` | `02:645` | ❌ R3 error | 它显式写了 `siteScoped:false`（平台级），但**未进豁免清单、也没有 `exemptReason`** → R3 要求「逐表签署理由」 |

### 2.2 R1 违规：有 `siteId` 但唯一键首列不是 `siteId`，或 `siteId` 可空

| 表 | 位置 | 判定 | 说明 |
|---|---|---|---|
| `ag_plugin_instances` | `02:230` | ❌ R1（唯一键 `uq_ag_plugin_inst_dev` 首列是 `developer_id`）+ ❌ R5（**没有任何 CHECK**）+ ⚠️ R6×2 | 与 `00 §2.2` 行 42 的「✅ R5 豁免 + CHECK 约束说明」矛盾：注释里写了 CHECK 的语义，但 `defineTable` 的 `options` 只传了 `{ siteScoped: false }`，**CHECK 从未落地** |
| `ag_dev_invitations` | `02:271` | ❌ R1×2（`site_id` 可空 + 唯一键首列是 `code_hash`） | 它**在 R3 豁免清单里**（`02:21`），但因为它有 `siteId` 列，走的是 R1 分支 → **R3 豁免永不生效** |
| `ag_policy_versions` | `02:702` | ❌ R1（唯一键 `uq_ag_policy_versions` 首列是 `policy_id`） | **不在 `02:21` 的「当前违规」四张表清单里** → 该清单本身不完整 |

### 2.3 R6 告警：唯一键含可空列 → PostgreSQL UNIQUE 静默失效

`02 §1` 已经指出「PG 把多个 NULL 视为互不相同 → 唯一约束静默失效」，但**原文没有任何检查**。契约 §4-A7 把它补成 R6（warn 级）。

| 表 | 索引 | 可空列 |
|---|---|---|
| `ag_plugin_instances` | `uq_ag_plugin_inst_dev` | `developer_id` |
| `ag_plugin_instances` | `uq_ag_plugin_inst_site` | `site_id` |
| `ag_plugin_bindings` | `uq_ag_bindings_external` | `external_id` |

### 2.4 结构自检发现的第三类问题：`siteScoped` 缺省语义

`02:306` 声称 `ag_plugins` / `ag_oidc_providers` / `ag_developers` / `ag_sites` / `ag_dev_invitations` 是「平台级（`siteScoped: false`）」，
但实际声明里：
- `ag_plugins`、`ag_oidc_providers`、`ag_oidc_signing_keys` **没有写** `siteScoped:false`（走缺省值）；
- `ag_sites`、`ag_dev_invitations` **写了** `siteScoped:false`，但它们**有 `siteId` 列**。

即「`siteScoped`」在文档里被当成「平台级」的同义词用，而它与「表是否带 `site_id` 列」并不等价。**建议**：把该标志改名为
`platformLevel`，或干脆取消该标志，一律由「是否有 `site_id` 列」派生（与 R1 一致）。

---

## 3. 规则自身的缺陷

| ID | 位置 | 问题 | 建议 |
|---|---|---|---|
| **F1** | `02:21` | 豁免清单里 `ag_dev_invitations` 的理由是「按 `ownerScope` 隔离」，但该表**没有 `ownerScope` 列**、且有可空 `siteId` → 走 R1，R3 分支永不成立，**豁免形同虚设** | 要么补 `siteId notNull`，要么把它改成真正的双作用域表（R5 + CHECK） |
| **F3** | `02 §1` R5 | R5 只写「可豁免 `siteId` 的 notNull」，**没说是否连带豁免 R1 的『唯一键首列必须是 siteId』**。双作用域表的 developer 级唯一键按定义不可能以 `site_id` 开头 → 严格读法下 R5 豁免没有意义 | 在 `docs/12-…契约.md §5.1` 明确：R5 豁免应**同时**覆盖 R1 的两条判据（`notNull` 与「首列」），并要求 CHECK |
| **F4** | `02:308` | 「`siteScoped: true` 的表若缺少 `site_id` 列，`db:check` 启动失败」——**这条 fail-fast 没有对应的派生规则**：R2 对「无 `siteId` 但有 `ownerScope`」放行，R3 只看豁免清单，都不覆盖它 | 要么补成 R7，要么标注该条已被 R1/R2/R3 取代 |
| **F5** | `02:967` | `t.primaryKey(['siteId','provider'], …)` —— 该写法在 Schema 声明层**不存在**（契约 §2 的 `TableHelper` 只有 `index`/`unique`/`check`）→ `ag_provider_sync_state` 在 IR 里没有主键 | ✅ **已修**：`dsl.ts` 增加 `t.primaryKey()`、IR 增加 `NormalizedTable.primaryKey`、提取器支持该写法；契约升到 v1.1。自检已确认该表主键为 `(site_id, provider)` |
| **F6** | `02:1322` | 「`ag_evaluations` 与 `ag_audit_log` 按月 `PARTITION BY RANGE (created_at)`；Schema 层提供 `t.partitionByRange()`」——**两张表的声明里都没有任何分区标记**，且 `t.partitionByRange()` 不存在 | 补声明能力，或把该句标注为「M6 待办」 |
| **F7** | `02:1322` | 分区表的 **PK 必须包含分区键**（PG 要求），但 `ag_evaluations` 的 PK 是 `id`、`ag_audit_log` 的 PK 是 `id`，都不含 `created_at` → 一旦真分区就会建表失败 | 与 F6 一并裁决 |

---

## 4. 核心代码含具体系统名（违反 D5 硬约束）

`02 §2.5` 声称「`sync.newapi.*` / `gate_newapi_request_total` 去具体系统名 ✅」，但 `ag_checkin_records`（`02:886` 起）里仍有：

| 位置 | 内容 |
|---|---|
| `02:895` | `grantVia: col.varchar(32).notNull().default('newapi')` —— **默认值是具体系统名** |
| `02:898` | `newapiLogId: col.bigint().nullable()` —— **列名含具体系统名** |

**影响**：CI 门禁第 7 项（核心代码 grep `newapi`/`new-api` 为 0）会**真实 FAIL**；这也直接违反 `README` 的硬约束
「核心代码中不得出现任何具体系统名（可机械检查）」。
**建议**：改为系统无关命名，例如 `grantVia` 默认 `'provider'`、`newapiLogId` → `providerLogId`。
**注意**：这是**文档缺陷**，提取器忠实提取，未做任何遮掩——CI 的 FAIL 是诚实结果。

---

## 5. 错位复制与其它

| ID | 位置 | 现象 |
|---|---|---|
| **D-4 附带** | `02:879` | `ag_checkin_entitlements` 的 `id` 行与 `ag_checkin_records` 的 `id` 行内容重复，疑似「一段定义被复制到两处后各自残缺」 |
| **X-1** | `05 §7.1.2` | 承诺 `ag_event_outbox` / `ag_dead_letters` 两张表，但 `02` **没有任何声明** → 提取结果里不存在这两张表（未编造） |
| **X-2** | `02 §2` | 域划分清单共 40 张表，与提取结果**完全一致**（40/40）——这一项是**通过**的，登记在此以示核对过 |

---

## 6. 本次未覆盖 / 未决

| # | 项 | 状态 |
|---|---|---|
| 1 | D-4 的主键归属（代理键 vs 自然键） | **待设计方裁决** |
| 2 | R5 是否连带豁免 R1 的「唯一键首列」判据 | 待契约方在 `docs/12` 明确 |
| 3 | `siteScoped` 语义（平台级 vs 带 site_id） | 待契约方统一 |
| 4 | F5（复合主键）、F6/F7（分区） | M0 待办，未阻塞 DDL 主链路 |
| 5 | 真实 PG 上跑全量 DDL 的结果 | 见 `reports/db-spike-evidence.md`（由数据库管道工作流产出） |

---

## D-5 状态更新：**已修复**（第 32 轮）

`ag_event_outbox` / `ag_dead_letters` 已在 `docs/02-数据模型.md §8.5 / §8.6` 补上声明。

| 项 | 处置 |
|---|---|
| 文档声明 | 两张表均**站点作用域**（`siteId NOT NULL`，满足 R1-a） |
| 唯一键 | 均为 `(siteId, eventId)`——**首列是 siteId**（满足 R1-b） |
| 索引 | `ix_ag_outbox_due`（取待投递）· `ix_ag_dead_letters_pending`（运维列表） |
| 提取链路 | `schema:extract` → 42 张表（原 40）· `db:generate` → DDL 216→**223** 条语句 |
| 门禁 | `db:check` **0 门禁 / 0 漂移**（42 表 / 46 枚举 / 90 索引） |
| 适配器 | `src/db/outbox-adapters.ts`（`DbOutboxStore`）+ **真实 PG 13 项用例** |

### ★ 修复过程中暴露的**两个真实缺陷**

1. **提取器的分组清单会静默丢表**：新增两张表后 `index.ts` 显示 42 张，
   而各模块之和只有 40 张——两张表**凭空消失、无任何报错**（无声明、无 DDL）。
   根因是 `DOMAIN_FILES` 是**手工维护**的分组清单（HANDOFF §6 所说「人工白名单是缺陷之源」的又一例证）。
   处置：补入分组，并让提取器对**未分组的表显式报错**（而非静默跳过）。

2. **测试装置与生产实现不一致**：`test/pg-real.test.ts` 手写了一个 `Db` 实现，
   它**漏掉了 `assertInTransaction`**——于是「事务外查询必须抛错」这条不变量
   在测试中**静默失效**，而生产路径正常。测试通过却掩盖了真实行为。
   处置：测试改为**复用生产实现** `src/db/pool.ts` 的 `createPgDb`。
