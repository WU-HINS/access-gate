# 最终状态（access-gate 生产可用性评估）

> ## ⚠️ 更新（本会话核实）：**§二 的数字与 §三 的"未修"清单均已过时**
>
> 本文件写于 Sep 25。此后本会话逐条核实：**§三 的 7 条"已知未修"里 6 条已修**。
>
> ### §二 数字对照
>
> | 本文写 | 实测 |
> |---|---|
> | `npm test` **1049/1049** | **1496/1496**（0 跳过） |
> | `npm run ci` **12 项 PASS** | **13 项 PASS**（新增「架构验收 M4-17：宿主无知」） |
> | 未引用模块 **23** | **19**（重新分类见 `unwired-modules.md`，其中含 **2 个工具盲区**） |
> | 接口面覆盖率 **58.7%** | **未复测**（★ 如实标注，不编数字） |
>
> ### §三 逐条核实（**7 条里 6 条已修**）
>
> | §三 声称的缺口 | 实测 |
> |---|---|
> | 平台级事实无法写入 PG | ✅ **已修**——`ensureDeveloperUser`（**方案 A**：开发者也是平台用户），5 处引用 |
> | `developerIdentities` 写入端未接线 | ✅ **已修**——`recordDeveloperIdentity` 4 处真实引用 |
> | 宿主 API 运行时编排未接 | ✅ **已修**——`pluginRuntime` 已注入 admin deps |
> | `OAuthStore` / `InvitationStore` / `SyncStateStore` / `KvStore` 只有内存实现 | 🟡 **降到 1 个真实项**：`AlertSilenceStore`（已补 `DbAlertSilenceStore` + 装配）；`VerifyClientStore` 是工具误判（实际有 `DbVerifyClientLookup`） |
> | `core/reconciler.ts`（对账）无调用 | ✅ **已修**——`reconciler.reconcile()` 已在调度循环 |
> | `db/outbox-adapters.ts`（事件外发）无人使用 | ✅ **已修**——`createTransactionalOutboxStore` 已装配 |
> | 23 个未引用模块 | 🟡 **19 个**，已重新分类（含 2 个工具盲区 + 2 个**真实**"存储已实现但使用路径未接"） |
>
> ★★ **§三 末尾那句话仍然完全成立**，而且本会话又验证了它一次：
> > 「**路线图完成度**」与「**接线完成度**」是两个坐标
>
> 修完 P0 之后暴露出的**新形态**正是这个坐标差：三张表的**存储**完成了，
> 但**使用路径**（准入 / 核销）还没接 → 见 `unwired-modules.md` §二。

> **结论：目标未完全达成。** 六项要求中 **4 项达成、1 项部分达成、1 项因环境无法验证**。
>
> ★ 本文件是**结论**，不是过程记录。逐轮证据见 `reports/M0-acceptance.md`（**152 节**；编号有跳号——早期缺 84，已核出）。
> ★ 本文件**每次都会与实际输出核对**——旧版本曾出现「11 项 PASS / 1039/1039」等**过时数字**（R86 发现并修正）。

---

## 一、逐条对照

| # | 目标要求 | 状态 | 证据 |
|---|---|---|---|
| **(1)** | 真实 PostgreSQL 模式启动 + 完整主线（登录 → 两级选择 → 控制台导航 → 资格查询） | ✅ **达成** | `tools/serve-real-e2e.ts` **19/19**；★ **默认进 CI**（第 10 项） |
| **(2)** | 容器化真跑（`docker build` + `compose up` + 健康检查 + 优雅启停 + **卷持久化**） | ❌ **未验证** | ★ 本环境**无 Docker**；已有静态 11/11 + 183 行 Runbook |
| **(3)** | 真实 IdP 两条链路隔离（真实授权码流程） | ✅ **达成** | ★ 真实服务进程 + 真实 PG + **真实 RSA 验签的 stub IdP**；⑤-8a~e 全通过；**默认进 CI** |
| **(4)** | 性能（管理读 ≥500 QPS · p99 有界 · **10 万主体**） | ✅ **达成** | `bench.ts --assert`：管理读 **974/s**（p99 63ms）· 10 万主体 **6.3s**；★ **默认进 CI**（第 12 项） |
| **(5)** | 长跑稳定（巡检 + 定时任务，无泄漏 / 无累积错误） | 🟡 **部分** | **25 分钟** · 50 QPS · **71952 请求 0 失败** · 巡检 **48 次递增** · `fail_count` **全程 0** · ★ **RSS 后半段 11 分钟仅涨 0.2MB**；★ **仍非小时级**，且**不在 CI** |
| **(6)** | 报告 + `npm run ci` 全绿 + `npm test` 0 跳过 | ✅ **达成** | `npm test` **1049/1049（0 跳过）** · `npm run ci` **12 项 PASS（0 FAIL / 0 WARN）** |

### (1) 的细节（19 步真实主线）

真实 PG 18（embedded-postgres 二进制）启动 → 迁移 → `--mode=real` 起服务 →
`/healthz/ready` → OIDC 端点挂载 → **引导令牌登录** → 两级选择（第一级/第二级）→
提交选择并写入会话 → 控制台导航 → 权限边界 → **资格查询** → 站点持久化 →
★ **真实 OIDC 授权码流程**（⑤-8a~e）。

★ 这一项修掉的真实缺陷（都是「内存模式能跑、真实模式不能」）：
迁移运行器不支持外部 PG · **`ag_migrations` 从未被创建** · 协同验证/OAuth 路由未挂载 ·
`SessionService`/`eligibilitySource`/巡检/admin 缺事务包装 ·
`ag_sessions.user_id` 与 `bootstrap:` 前缀冲突 · **冷启动没有任何登录方式** ·
**真实模式下协同验证用内存 store** · 插件列表硬编码 ·
★ **登录状态无持久化**（R57）· ★ **真实模式下没有可用的 OIDC 客户端**（R78）。

### (3) 的细节（两条链路隔离）

| 验证 | 结果 |
|---|---|
| `platform:enduser` 首次登录 → **自动建号** | ✅ |
| 二次登录 → **复用同一账号**（同一 id） | ✅ |
| `platform:developer` 未入驻 → 拒绝 | ✅ |
| 入驻后 → 可登录（返回该开发者 id） | ✅ |
| ★★ **同一 OIDC sub 在两条链路上是不同主体** | ✅ |
| 终端用户不得走开发者链路 | ✅ |

★ 修复前的状态（R76 实测）：**开发者永远无法登录**——`serve.ts` 的 `developerIdentities`
是一个**空 Map 且无人写入**，而测试用的是**手工构造的 lookup**，因此**全绿**。

---

## 二、当前实测数字（最后一次完整运行）

| 项 | 数值 |
|---|---|
| `npm test` | **1049 / 1049**（**0 跳过**） |
| `npm run ci` | **12 项 PASS**（0 FAIL / 0 WARN） |
| `serve-real-e2e.ts` | **19 / 19** |
| `path-probe.ts` | **68 / 68**（含契约 / 错误结构 / 敏感字段 / 写后读 / 字段值） |
| `path-probe --self-test` | **15 / 15** |
| `patrol-liveness.ts` | **5 / 5** |
| `authz-coverage.ts` | **35 / 35** 分支已鉴权（自测 4/4） |
| `docker-preflight.ts` | 静态 **11 / 11**（★ **5 项显式标注无法验证**） |
| 接口面覆盖率 | **58.7%**（未匹配 52 条） |
| 未引用模块 | **23**（分类见 `unwired-modules.md`） |
| 管理读 | **974.4/s** · p50 31ms · p95 45ms · **p99 63ms** · 0 失败 |
| 10 万主体全量评估 | **6299ms**（15875/s）· 0 失败 |
| 残留 PG 进程 | **0** |

★ **性能数字的诚实标注**：本会话早期测得管理读 505–723/s，后期 900–980/s。
★★ 这个提升**主要来自环境资源差异**，不是代码优化。
★ 本会话**真实**的性能优化只有一次：`InMemoryFactStore` 的 O(n²) → 索引化
（12000 主体 **220.7s → 2.48s**，约 **89 倍**）——那次效果远超环境波动。

---

## 三、★ 交付时**已知未修**的缺口（必须与 §一 的「达成」一起读）

| 缺口 | 后果 | 状态 |
|---|---|---|
| **平台级事实无法写入 PG** | `FactPipeline` 默认 `userId='platform'`（字符串）vs `ag_plugin_facts.user_id`（NOT NULL uuid） | ★ **未修**——需设计决策 |
| **`developerIdentities` 的写入端未接线** | 开发者**入驻**时没有写 `ag_identities` 的调用点（读取端 R76 已修） | ★ **未修** |
| **宿主 API 运行时编排未接** | `host-factory` 可装配（R66），`runtime-orchestrator` 可用（R70），但**尚未在 serve.ts 的被调路径上** | 🟡 **未接** |
| **`OAuthStore` / `InvitationStore` / `SyncStateStore` / `KvStore`** | 只有内存实现（其中 **4 个表已存在**） | ★ **未修**（见 `architecture-gaps.md`） |
| **`core/reconciler.ts`（对账）** | 服务里没有任何调用 → **对账不会发生** | ★ **未修** |
| **`db/outbox-adapters.ts`（事件外发）** | 全项目无人使用 → **事件落不了库** | ★ **未修** |
| **23 个未引用模块** | 含权限治理、LLM 网关、策略规划/灰度/分支等 | 🟡 分类见 `unwired-modules.md` |

★★ **「路线图完成度」与「接线完成度」是两个坐标**：
本项目的设计文档路线图已 **90/90**，但**服务里真正被调用的能力**要小得多。

---

## 四、★ 未被 CI 覆盖的两项（详见 `ci-coverage.md`）

| 项 | 为什么不在 CI | 复跑方式 |
|---|---|---|
| **(2) 容器化** | 环境**无 Docker** | 按 `containerization-runbook.md` 执行；静态检查：`node tools/docker-preflight.ts` |
| **(5) 长跑** | 12 分钟会让 CI 从 ~5 分钟变成 ~17 分钟 | `node --experimental-strip-types tools/soak.ts --minutes=25 --interval=60 --load=50` |

★★ 诚实结论：**(5) 仍然依赖「有人记得跑」**——与性能项修好之前的状态相同。
★ 而 **(2)** 不是「忘了跑」，是**环境不具备**：**静态检查不能替代真实执行**。

---

## 五、可复跑清单（全部命令）

```bash
# ── 主门禁 ──
npm test                                   # 1049/1049 · 0 跳过
npm run ci                                 # 12 项 PASS（含真实 PG + 真实服务进程 + 性能）

# ── 真实 PG 端到端（19 步，含真实 OIDC 授权码流程）──
node --experimental-strip-types tools/serve-real-e2e.ts

# ── 动态验证 ──
node --experimental-strip-types tools/path-probe.ts              # 68/68
node --experimental-strip-types tools/path-probe.ts --self-test   # 15/15（证明检查不恒真）
node --experimental-strip-types tools/patrol-liveness.ts          # 巡检真的在执行
node --experimental-strip-types tools/bench.ts --assert           # 性能达标断言

# ── 长跑（★ 不在 CI，需人工复跑）──
node --experimental-strip-types tools/soak.ts --minutes=25 --interval=60 --load=50

# ── 静态审计 ──
node --experimental-strip-types tools/route-coverage.ts      # 路由已挂载
node --experimental-strip-types tools/authz-coverage.ts      # 鉴权覆盖
node --experimental-strip-types tools/impl-pairing.ts        # 内存/PG 配对 + 服务里未使用
node --experimental-strip-types tools/module-wiring.ts       # 23 个未引用模块
node --experimental-strip-types tools/api-coverage.ts        # 接口面 58.7%
node --experimental-strip-types tools/table-coverage.ts      # 12 张表未被读写
node --experimental-strip-types tools/docker-preflight.ts    # 容器化静态 11/11
```

★ **每次运行后核对**：`pgrep -cx postgres` 应为 **0**（不遗留 PG 进程）。
★★ **不要同时跑 `npm test` 与 `ci-gate`**——两者都会启动真实 PG，会互相冲突（R77 踩过）。

---

## 六、本会话最有价值的部分：**让缺陷可见的机制**

| 机制 | 抓到过什么 |
|---|---|
| `serve-real-e2e.ts`（真实 PG + 真实进程） | ★ **开发者永远无法登录**（R76）· ★ **真实模式无 OIDC 登录**（R78） |
| `path-probe`（68 路径 × 六层检查） | 6 个 500（嵌套事务）· 2 个 500（非法 uuid）· 1 处静默降级 |
| `patrol-liveness` | 巡检**执行即失败**（而 `run_count` 仍 +1，看起来正常） |
| `route-coverage` | 3 条路由未挂载（含**回滚**） |
| `table-coverage` | `ag_secrets` 从未被读写 · 4 个管理端点未注入依赖 |
| `impl-pairing` | ★ **登录状态无持久化** · ★ **用户身份只在内存** · ★ **插件宿主 API 未装配** |
| `module-wiring` | ★ **26 个模块未被任何生产代码引用** |
| CI 的 skip 门禁 + skip **原因** | 26 个测试静默跳过（`fail 0` + CI PASS） |
| **把端到端搬进默认 CI**（R81） | ★ 第一次跑就抓到「**测试全通过但进程不退出**」 |

★★ 一条贯穿全会话的规律：**每次扩大检查范围，都会先抓到检查者自己**——
探针漏检中文错误 · 契约猜错字段 · 恒真断言 · 硬编码缩进 · 解析过滤掉 `skipped` ·
`skipped` 有计数没原因 · 报告里的过时数字。

★★★ 也正因如此，**最重要的修复往往不是「补功能」，而是「把验证搬进默认路径」**：
R76/R78 那类「声称有、实际没有」的缺陷，**只有在默认路径上才会被持续暴露**。

---

## 附四：方案 A 落地（R101–R106）—— **开发者级插件的事实归属**

> **人类决策**：采纳 `reports/adr-plugin-fact-subject.md` 的**方案 A**，无人值守实现。

### 交付内容（6 步全部完成）

| 步骤 | 内容 | 证据 |
|---|---|---|
| (1) | `ag_developers` 加列 `user_id`（→ `ag_users.id`，可空） | 走「文档 → 抽取 → DDL」；**47 张表 · 门禁 0 · 漂移 0** |
| (2) | 迁移回填（`ensureDeveloperUser` **幂等**建立映射） | 真实 PG 测试 |
| (3) | 入驻时（`redeem()` **内部**）同时建 `ag_users` + 回填 | ★ **调用方无法忘记**（R91 教训的结构性延续） |
| (4) | 插件自动调度接线（按开发者解析主体，取不到则**跳过并记日志**） | 接入调度循环 |
| (5) | 真实 PG 端到端（入驻 → 主体解析 → **事实归属**） | `pg-real` **36/36** |
| (6) | 每步更新报告 | 本文档 + `M0-acceptance.md` §150–153 |

### ★ 顺带修复一个**影响所有双作用域表的生成器缺陷**

★ 写 `ag_plugin_instances` 适配器时，插入 `scope='developer'` 的行被**数据库拒绝**：

```sql
-- 修复前（错）：CHECK 只有 site 分支
CHECK ((scope = 'site' AND site_id IS NOT NULL AND developer_id IS NULL))
```

★★ 而 `docs/02` 里**正确声明了两半**（`dualScopeCheck` 用 `+` 拼接）。
★★★ 根因在抽取工具的**正则**：`[^'"]*` 不允许字符串内部有引号，
而表达式含 `'site'` / `'developer'` → 匹配提前结束 → **后半被静默丢弃**。

★★★★ **后果**：`scope='developer'` 的行**永远无法插入** →
**「开发者级插件配置」在数据库层面不可能** —— 这正是「`configScope: 'developer'` 从未实现」的根因之一。
★ 且它**影响所有使用 `dualScopeCheck` 的表**（系统性缺陷）。

★ 修复后生成的 CHECK 两个分支齐全（见 `migrations/0001_init.sql`）。

### ★ 三层验证齐全

| 层级 | 工具 | 结果 |
|---|---|---|
| **单元** | `test/plugin-admin.test.ts` | 35/35 |
| **真实 PG（集成）** | `test/pg-real.test.ts` | **36/36** |
| ★ **真实服务进程（端到端）** | `tools/serve-real-e2e.ts` | **23/23** |
| ★ **默认 CI** | `npm run ci` | **12 项 PASS** |

### 最新实测数字（本次核对）

| 项 | 数值 |
|---|---|
| `npm test` | **1065 / 1065**（**0 跳过**） |
| `npm run ci` | **12 项 PASS**（0 FAIL） |
| `serve-real-e2e.ts` | **23 / 23** |
| 未引用模块 | **20**（R67 时 26 → 现 20） |
| 路由 | admin/api.ts **58 条 · 0 条未挂载** |
| DDL | **47 张表 · 门禁 0 · 漂移 0** |

### ★ 仍未完成的（都不属于「代码可推进」）

| 项 | 前提 |
|---|---|
| 外置插件的自动调度 | 需「从包体读清单」的能力（当前只支持 `BUILTIN_MANIFESTS`） |
| 容器化真跑 | ★ 需有 Docker 的环境 |
| 小时级长跑 | ★ 需数小时的时间窗口 |
| `uq_ag_users_email` 放开 | ★ 需设计决策（同一邮箱既做开发者又做终端用户） |
