# 设计决策记录（ADR）

> 本文件记录**被否决的方案与原因**，防止未来重复讨论已排除的路径。
> 正文（01–06）只描述**最终设计**，不带迭代痕迹；需要"为什么不那样做"时查这里。

| # | 决策 | 状态 |
|---|---|---|
| [D1](#d1--插件运行期装配-vs-编译期模块) | 插件运行期装配 | ✅ 采纳 |
| [D2](#d2--判定语言嵌套表达式-vs-模式枚举) | 嵌套表达式 + 有序分支 | ✅ 采纳 |
| [D3](#d3--表达式三形态等价) | YAML / JSON / 图形 等价 | ✅ 采纳 |
| [D4](#d4--寻址统一语法-vs-多套写法) | 统一寻址 + 绑定解析 | ✅ 采纳 |
| [D5](#d5--引擎定位通用信任引擎-vs-new-api-附属) | 通用信任引擎 | ✅ 采纳 |
| [D6](#d6--对账通用-vs-new-api-专用) | 通用对账器 | ✅ 采纳 |
| [D7](#d7--插件能力含前端-ui) | UI 贡献是一等能力 | ✅ 采纳 |
| [D8](#d8--插件实例维度插件自声明) | 实例维度由插件声明 | ✅ 采纳 |
| [D9](#d9--插件包存储内置随项目外置落-db) | 内置随项目，外置落 DB | ✅ 采纳 |
| [D10](#d10--数据库仅-postgresql) | 仅 PostgreSQL | ✅ 采纳 |
| [D11](#d11--数据库独占) | 数据库独占，不 JOIN 下游表 | ✅ 采纳 |
| [D12](#d12--身份域两个-vs-三个) | 两身份域（admin 也是开发者） | ✅ 采纳 |
| [D13](#d13--层级开发者--站点) | 开发者 → 站点 | ✅ 采纳 |
| [D14](#d14--平台模式平台设置项-vs-环境变量) | 平台设置项 | ✅ 采纳 |
| [D15](#d15--账号模型id-锚点--用户名可变) | id 锚点 + 用户名可变 | ✅ 采纳 |
| [D16](#d16--站点隔离双层强制) | 应用层注入 + RLS | ✅ 采纳 |

---

## D1 · 插件：运行期装配 vs 编译期模块

**否决**：把验证渠道做成随主程序发布的模块（`src/modules/channel-github`）。

**理由**：模块是**编译期**的——新增渠道要改主程序、重新构建、重新部署；且主程序会"认识" GitHub，无法接纳未知渠道。

**采纳**：运行期插件体系 + **宿主无知**（核心代码不出现任何具体系统名）。硬性验收：删除 `plugins/builtin/` 后主程序仍能启动。见 03 文档 §1。

---

## D2 · 判定语言：嵌套表达式 vs 模式枚举

**否决**：`requirements.mode = any|all|quorum|weighted` + 扁平 `items[]`。

**理由**：两级结构只能表达"若干条件里满足几个"，**表达不了"不同分支有不同条件"**——"QQ > 40 直接解锁；20 < QQ < 40 则要求与其它渠道组合达成"写不出来。

**采纳**：最基础的 `all/any/not/比较` 任意嵌套 + 有序 `branches`（if / else-if / else，首个命中生效）。`atLeast` / `score` 只是语法糖。见 04 文档 §1。

---

## D3 · 表达式三形态等价

**采纳**：**AST 是唯一真理**，YAML（给人）/ JSON（给程序）/ Graph（给图形编辑器）三种等价表示。

**关键设计**：`specHash` 只对**规范 AST** 计算——同一逻辑用不同视图编辑不会产生无意义的版本差异；前后端共用 `@gate/expr`，保证"编辑器所见"与"服务端所算"不漂移。见 04 文档 §1.2.6。

---

## D4 · 寻址：统一语法 vs 多套写法

**否决**：`fact.<ns>.<path>` / `subject.<attr>` / `binding.<pluginId>.<field>` 三套并存。

**理由**：无实例维度（一个插件可能接多个 bot / 站点）；无法表达"**用户在某个下游系统里是谁**"。

**采纳**：`<root>:<plugin>[@<instanceKey>][#<siteSlug>].<path>` + **绑定解析**（平台用户 → 该实例下的主体，绑定键由插件声明，**非唯一则拒绝自动绑定**）。见 04 文档 §1.2.7。

---

## D5 · 引擎定位：通用信任引擎 vs new-api 附属

**否决**：核心内置 `ag_newapi_users` 镜像表、`sync-newapi` 同步器、`sdk-newapi` 包，表达式隐含 `users.group`。

**理由**：项目沦为 new-api 的附属工具，无法服务其他下游系统。

**采纳**：核心只认识 **Subject / Fact / Policy / Grant**；new-api 降级为 `newapi-provider` + `newapi-*` action 插件，与第三方接入**完全同构**。见 03 文档 §1.16。

---

## D6 · 对账：通用 vs new-api 专用

**否决**：核心内置 new-api 的分页细节。

**采纳**：通用对账器 + provider 的 `listSubjects`；**真增量是优化而非前提**（并非所有下游都提供 `since` 过滤）。见 05 文档 §4。

---

## D7 · 插件能力：含前端 UI

**否决**：插件只提供后端能力（采集 / 判定 / 动作 / 端点）。

**理由**：很多功能**天然是面向用户的界面**——最典型是**签到**：平台侧的签到插件必须能给用户一个入口与页面，否则功能等于不存在。

**采纳**：UI 贡献为一等能力（`nav` / `page` / `slot` / `settings`），默认 `declarative`（零前端代码、零 XSS）。见 03 文档 §1.17。

---

## D8 · 插件实例维度：插件自声明

**否决**：平台强制"站点内插件配置一律唯一"。

**理由**：凭据类需共享、目标类需独立、webhook 类需多例——**应由插件声明，不该平台强制**。

**采纳**：`config.scope`（`developer` 推荐 / `site`）+ `instances.mode`（`singleton` / `multi`），四象限组合。见 03 文档 §1.19。

---

## D9 · 插件包存储：内置随项目，外置落 DB

**否决**：把文件系统作为插件包的**持久层**。

**理由**：**文件系统不保证持久化**——容器重建、Pod 漂移、多实例无共享卷都会丢。

**采纳**：**内置随主程序构建产物**（不进 DB）；**外置落数据库**（`ag_plugin_packages.blob`）；本地仅作**可丢弃的运行时缓存**，启动按 digest 拉回。见 03 文档 §1.19.4。

---

## D10 · 数据库：仅 PostgreSQL

**否决**：MySQL / SQLite 兼容 + 方言映射 + 驱动抽象层。

**理由**：多方言带来大量降级分支（UPSERT 三态、RETURNING 回退、部分索引模拟…）；锁定 PG 可换来 **RLS / `pg_advisory_lock` / 部分唯一索引 / 声明式分区 / `jsonb`+GIN**。

**采纳**：数据访问层从四层简化为**三层**（无方言层）；`ag_locks` 表删除。见 01 文档 §5。

---

## D11 · 数据库：独占

**采纳**：本项目**独占一个 PostgreSQL 数据库**，不与下游系统共用；**绝不 JOIN 下游表**——下游数据只能经 provider 插件同步。

**理由**：**"不 JOIN 下游表"是 provider 抽象成立的前提**——若 SQL 里出现 `users.group`，核心就又耦合回去了。另有三点：迁移自由、权限最小化（RLS 才有意义）、故障隔离。见 01 文档 §5.0。

---

## D12 · 身份域：两个 vs 三个

**否决**：admin 作为独立身份域、且不走 OIDC。

**理由**：OIDC 提供方本身就是**受信任的平台**；为 admin 另立一套认证体系会把流程割裂（且 admin 本身也是开发者）。

**采纳**：`developer`（含 admin，仅靠 `role` 区分）+ `enduser` 两个域。见 08 文档 §3。

---

## D13 · 层级：开发者 → 站点

**采纳**：**站点是隔离边界 + 配置单元**；一个开发者可建多个站点；终端用户**先选开发者、再选站点**。

**理由**：站点作为唯一作用域边界，使"插件配置在哪里维护"和"数据归谁"两个问题同时有了答案。见 08 文档 §2、§6。

---

## D14 · 平台模式：平台设置项 vs 环境变量

**否决**：`SAAS_MODE` 作为纯环境变量。

**理由**：需求明确"admin 可以更改系统设置"；且两种模式**数据模型完全相同**，切换成本极低、完全可逆。

**采纳**：平台设置项（**DB 为准**），环境变量仅提供**初始值** + 可选锁定。见 08 文档 §11。

---

## D15 · 账号模型：id 锚点 + 用户名可变

**采纳**：`id`（UUID）**永不变**为身份锚点；`username` 唯一但**可变**；账密与 OIDC **可并存**。

**关键要求**：会话/绑定/审计/令牌一律引用 `id`；URL 不用 username；改名写审计并记用户名快照。见 08 文档 §3.2。

---

## D16 · 站点隔离：双层强制

**采纳**：应用层自动注入 `site_id`（第一道）+ **PostgreSQL RLS**（`FORCE ROW LEVEL SECURITY`，第二道）。

**理由**：应用层注入依赖代码正确性；RLS 由数据库强制——**即使业务代码有 bug 或有人写了裸 SQL，也读不到别的站点数据**。见 01 文档 §5.5。

---


## D17 · 站点级 RLS：**推迟**（辩论裁决）

**辩题**：站点级 RLS 补完 vs 推迟。**裁决：推迟**，但附 4 项**不可推迟**前置。

**双方的事实错误（辩论中核实）**：
- 反方「文档全篇没有第二个独立开发者」**错误**——08 §243-244（开发者 A 3 站点 / B 1 站点）、08 §387（4 个开发者）、05 §674（A/B/C）均存在
- 正方「补完 RLS 能覆盖结构一」**错误**——RLS 按 `site_id` 键控，管不到 12 张能力层表（它们按 `ownerScope/ownerId` 隔离）

**裁决理由**：在四个关键假设上，当前取值全落在「推迟」一侧——
① 无站点级协作者角色（08 §3/§8 只有 developer/admin）→ 站点隔离当前是**数据卫生**而非安全边界；
② 07 §5 场景 A 是**单站点**（第 1 个实例）；
③ 若采纳 Kysely + 200 行 ScopePlugin，「漏注入」发生面降约一个数量级；
④ A 的成本可观测（全局事务约束 / 调度器改按站点分片 / 对账「每 100 行一事务」与逐站点事务**互斥** / BYPASSRLS 全局旁路 / 分区 RLS 无人维护）。

**4 项不可推迟前置**（缺一则 B 不成立）：
1. `siteId` 非空列 + 唯一键以 `site_id` 打头
2. 集中注入 + 无作用域 **fail-closed 抛错**
3. ★ **保留「所有业务查询走 `ctx.db.transaction(fn)` 单一入口」+ CI 禁止事务外查询**——这是把后补成本压到 **O(1)** 的唯一条件（九代 MVP 清单漏了这条，必须补）
4. 采纳 Kysely + 200 行 ScopePlugin

**可判定的 spike**：M0 后只做两件事（12 张表 policy DDL + 事务包装器加一行 `SET LOCAL`），测改动文件数——`≤3` → B 成立；`>10` → **立即改判 A**。
**切换触发**：出现 ≥2 个互不信任 developer 共享实例（saas + 外部入驻）→ 按 O(1) 成本立即切换。

---

## D18 · 行级租约：**加**（窄版本）；全局 fencing token：**砍**（辩论裁决）

**辩题**：fencing token 加 vs 砍。**裁决：加窄版本，砍宽版本**——推翻第 9 代「自造故障」的结论。

**辩论核实的关键外部事实**（推翻反方前提）：
- `pg.Pool` 默认 `idleTimeoutMillis = 10000` → **锁连接 10 秒后被回收，进程仍活着而锁已丢失**
- PG `tcp_keepalives_idle` 默认 0 → 取 OS 默认；Linux 为 7200s + 75s×9 → 半开连接下最长 **≈7875s（2h11m）** 才判定对端死亡
- `actions.retry` 只扫 `failed`，而 `ag_actions_log` **无租约列** → `running` 行**无任何恢复路径**

**裁决**：
- ✅ **加**：`ag_actions_log` 抄 `ag_jobs` 的 `lockedBy` / `lockedUntil`；`actions.retry` 扫描条件扩为 `failed OR (running AND lockedUntil < now())`；写路径带 `WHERE status=? AND lockedBy=?`（或 version CAS）
- ❌ **砍**：全局 `fencingToken` 贯穿每个 Repository 写方法、`ctx.locks` 的 `ttl/renew` 自研语义

**成本**：窄版本 **≈1–1.5 人日**（5 张表 × 1 列 + 谓词），不触碰自研查询层。
**升级触发**：出现「不可读回且无幂等键」的新动作类型，或 ≥3 实例下**实测**到重复副作用。

---

## D19 · 审计不可篡改：**砍逐行哈希链**，改「REVOKE 执行验证 + 归档锚点」（辩论裁决）

**辩题**：审计哈希链补 vs 砍。**裁决：砍逐行链**，但必须补两项（约 1.5 人日）。

**辩论核实的关键事实**：
- **REVOKE 生效前提是 `app_role ≠ 表属主`，而 13 份文档从未规定表属主是谁** → 自部署下常见「一个角色兼任属主与应用」→ **REVOKE 是 no-op**
- REVOKE 不撤 `TRUNCATE`；属主可重新 GRANT、可 DROP
- 「异步补链会断链」是**事实错误**：行不可变 + 只对**已关闭分区**建链（月度），零写路径影响
- 真正的难点是 `bigserial id 序 ≠ 提交序`，但按月分区后自然消解

**裁决**：
- ❌ **砍**：逐行 `prevHash` 链 + 写路径改造 + 串行化 + 三步校验
- ✅ **补 (i)**：`REVOKE UPDATE, DELETE, TRUNCATE ON ag_audit_log FROM app_role`，且**写成可执行门禁**（CI 里以 app_role 真跑四条篡改语句，任一成功即失败）——**先判定表属主，否则是 no-op**
- ✅ **补 (ii)**：`audit.archive` DROP PARTITION **前**对将删分区计算 `(partition, rowCount, 行级 Merkle 根)` 并签 JWS，落 `ag_audit_anchors`；**无锚点则拒绝 DROP**

**为什么锚点值得做**：把「历史永远不可证明」降级为「**锚点粒度可证明**」，且未来升级到行级链**无需回填**。

---

## D20 · `indeterminate` 语义：**拆回本义**（辩论裁决）

**辩题**：H1「indeterminate 不降级」是否产生了更坏的问题？**裁决：反方胜**。

**H1 的原则成立**（降级的证据要求高于升级），但**实现错了**——把 `indeterminate` 定义为「有关键事实 missing」，使它成了**垃圾桶**。

**关键证据**：
- 09 §4.2 的插件边界**已区分**三类根因（401→unbound / 403→rate_limited / 404→not_found），但 `collect.errors` 的映射**没有任何下游消费** → **信息在边界被丢弃**
- 同一个 401：标 `$required` → **永久冻结**；未标 → 72h 后 **revoked**——**两个结局都不是 09 §4.2 写好的那个**
- 05 §2.1.2 的四件套**全部面向运维**，**无用户侧入口** → 401 场景下运维查 token/网络永远查不到，**用户永远不知道要重新绑定**

**裁决**：`indeterminate` 收紧为「**外部不可用且不可归因于主体**」；其余按 owner 走既有四条通路：

| 根因 | owner | 处置 |
|---|---|---|
| `unbound`（401，用户可自愈） | user | → 待绑定队列 + **用户侧**提示「请重新绑定」 |
| `not_found`（404） | subject | → `unsatisfied` |
| `rate_limited` / quota | platform | → 独立归因 `throttled` |
| 外部服务不可用 | platform | → `indeterminate`（本义） |
| schema / 类型漂移 | plugin | → `error` |

**对称化**：`fail_open` 允许 missing → passed，即**渠道故障时用户被升级**——同样违反 H1 原则，必须补升级方向的约束。

**CI 黄金对照实验**：同一主体、同一策略两版本 P1(`$required:true`) / P2(默认 `fail_closed`)，注入 401/403/404，断言 **结局与 `$required` 解耦**。修复前必失败，修复后必通过。
**反向回归**：场景 D（断开 new-api）与 T3（30 天后 GitHub 故障）**必须仍走 indeterminate**——若被降级，说明拆过头。

---

## D21 · 双作用域表的 R1-b 唯一键判据：**默认豁免**（实现方裁决，M0 收敛）

**背景**：`02 §1` 的 R1 有两条判据——(a) `site_id` 必须 notNull；(b) **若有唯一键，其首列必须是 `site_id`**。
R5 允许「双作用域表」豁免 (a)（因为它的 `site_id` 按语义可空），但**没有说是否连带豁免 (b)**。

**冲突**：`ag_plugin_instances` 同时承载 developer 级与 site 级配置，其 developer 级唯一键
`uq_ag_plugin_inst_dev = (developerId, pluginId, instanceKey)` 的**首列按定义不可能是 `site_id`**。
若 (b) 不豁免，R5 的豁免就形同虚设——唯一正确的写法会被门禁永久判错。

**裁决**：双作用域表（`dualScoped === true`）的 **R1-b 默认豁免**，跨作用域覆盖改由 **R5 强制的 scope CHECK** 承担：

```sql
CHECK ((scope = 'site'      AND site_id IS NOT NULL AND developer_id IS NULL)
    OR (scope = 'developer' AND developer_id IS NOT NULL AND site_id IS NULL))
```

**为什么这个组合是充分的**（三条，缺一不可）：

| # | 论点 |
|---|---|
| 1 | **结构不可能**：developer 级唯一键不可能以 `site_id` 开头；严格读法让正确写法永久报错 |
| 2 | **豁免有替代保障**：R5 的 CHECK 恰好保证「scope=site 时只有 siteId、scope=developer 时只有 developerId」，即 R1-b 想防的「跨作用域覆盖」改由 CHECK 承担 |
| 3 | **代价不对称**：严格读法的唯一后果是逼实现方去放宽规则（比明确豁免更糟） |

**边界与诊断**：豁免**只对 `dualScoped === true` 生效**；且它**不依赖** R5 的 CHECK 是否存在
（缺 CHECK 时 R5 自己会报 error，不需要 R1-b 再报一次）。需要量化严格读法时传
`checkScopeRules(tables, exemptions, { dualScopeUniqueKeys: 'strict' })`。

**连带修正（同一轮）**：

| 表 | 修正 | 依据 |
|---|---|---|
| `ag_email_rules` | 补 `siteId notNull` + 唯一键 `(siteId, matchType, pattern)` | 邮箱准入域是**站点级**配置（与 `ag_invite_codes` 同理）；原表既无 siteId 也无 ownerScope，落在 R3 且未豁免 |
| `ag_dev_invitations` | 补 `siteId notNull` 并提到首列；唯一键改 `(siteId, codeHash)`；**移出 R3 豁免清单** | 原状「有可空 siteId」→ 走 R1，R3 豁免**永不生效**（F1）；修法二选一，选站点化更贴合「邀请码归属站点」 |
| `ag_policy_versions` | 唯一键改 `(siteId, policyId, version)` | 版本属于某个站点的某条策略；跨站点同 `(policyId, version)` 会静默冲突 |
| `ag_plugin_configs` / `ag_plugin_packages` | 补入 R3 豁免并**逐表给出理由** | 前者归属由父实例决定；后者是平台级分发物 |
| `ag_checkin_records` | `newapiLogId` → `providerLogId`；`grantVia` 默认值 `'newapi'` → `'provider'` | 违反 README 硬约束「核心代码中不得出现任何具体系统名（可机械检查）」，CI 第 7 项真实 FAIL |

**验证**：`npm run ci` **8/8 PASS**（此前 6/8）；`npm test` 66/66；四种人为 drift 均被检出。
原始输出见 `reports/M0-acceptance.md`。

**可回退性**：`docs/` 在本轮修改前的快照保存在 `.snapshots/docs-0011/`。

---

## 待确认（未定案）

见 [07-实施路线图 §5](./07-实施路线图.md) 的 Q1–Q15。
