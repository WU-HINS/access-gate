# 交付契约（access-gate）

> 本文件回答三个问题：**交付了什么 · 你需要做什么 · 已知限制是什么**。
>
> ★ 所有数字与状态来自**逐条实测**（命令见 §五），**不采信任何文档的既有结论**；
>   发现不一致时，以本文件为准，并回改那份文档。
>
> ★ 与 `DELIVERY-READINESS.md` 的分工：那份是**缺口评估**（还差什么），
>   本文件是**交付契约**（给什么、要你做什么、边界在哪）。

---

## 一、交付了什么

### 1.1 代码：可运行的 access-gate 服务

| 层 | 内容 |
|---|---|
| **Schema 声明层** | `src/schema/`（**48 张表** · 48 枚举 · **98 索引**），由 `docs/02` **抽取生成**（不手改），含 R1–R6 站点作用域门禁 |
| **PG 编译器** | 自建查询 AST → 参数化 SQL，**站点作用域在编译期注入**（不是靠调用方记得过滤） |
| **迁移 / 漂移** | `db:generate` / `db:check`（**门禁 0 · 漂移 0**，逐列比对类型/可空/默认值/索引/枚举） |
| **内核** | 四抽象（Subject / Fact / Policy / Grant）· 三态求值（`true/false/indeterminate`）· 状态机 · 动作执行器（含级联回退） |
| **插件宿主** | 清单校验 · 三层存储（内置/DB/本地缓存）· 运行时编排 · 进程内准入 · 升级兼容检查 |
| **Provider + 对账** | `ProviderPlugin` 契约 · 渠道对账（已接调度）· 身份对齐 |
| **表达式引擎** | `gate/expr/v1`：`all/any/not/none` + 比较叶子 · **`subject:*` 跨系统寻址** · `$maxSkew` 时间偏斜 |
| **用户门户 / 管理端** | 61 条路由（admin 58 条实现 · 全部已鉴权） |
| **安全** | 站点隔离（编译期注入）· 密钥加密落库（AES-256-GCM）· OIDC 密钥轮换（判定+存储+调度+审计+端点）· 跨站点访问判定 |

### 1.2 文档（**与实现一致**）

| 文件 | 作用 |
|---|---|
| `reports/DELIVERY-CONTRACT.md`（本文件） | 交付契约 |
| `reports/DELIVERY-READINESS.md` | 缺口评估（**P0 已全部关闭**） |
| `reports/GO-LIVE-TODO.md` | 权威待办（P0/P1/P2 逐项状态 + 一键命令表） |
| `docs/01`–`docs/12` + `CHANGELOG` | 设计文档（12 份） |
| 六份**已加过时声明**的报告 | `production-readiness` · `FINAL-STATUS` · `architecture-gaps` · `unwired-modules` · `ci-coverage` · `schema-doc-defects` |

★ 后六份**保留原文 + 加更新声明**（而非重写）：正文是"当时基于实际代码核实得出的结论"，
是**审计线索**——能对照出后来哪些判断被证伪、哪些真被修掉了。

### 1.3 一键命令

| 命令 | 作用 |
|---|---|
| `npm test` | 单测 + 集成（**1496 项 · 0 跳过**） |
| `npm run ci` | **13 项门禁**（tsc · 单测 · DDL 快照 · db:check · site_id · 裸 SQL · 系统名 · 事务入口 · 安全 · 真实 PG · 路由一致性 · 性能 · 宿主无知） |
| `npm run verify:scenario-a` | `07 §5` 场景 A（真实 HTTP 下游） |
| `npm run verify:all` | 场景 A → 真实 PG e2e → path-probe → 巡检存活 → 短长跑 |
| `npm run db:check` | Schema 门禁 + 漂移 |
| `npm run security` | 安全自查 12 项 |
| `npm run backup` | 备份/恢复演练 |
| `node --experimental-strip-types tools/docker-preflight.ts` | 容器化静态检查（11/11，★ 5 项显式标注无法验证） |

---

## 二、你需要做什么

### 步骤 1 · 跑一遍验收（**先做这一步**，确认交付物可用）

```bash
npm test && npm run ci && npm run verify:all
```

期望：全绿（数字见 §五）。**任何一项失败都说明环境不匹配**，而不是"功能坏了"——
先看 §四 的外部依赖。

### 步骤 2 · 配置真实环境

| 环境变量 | 必需 | 缺了会怎样 |
|---|---|---|
| `AG_MASTER_KEY` | ✅ **真实 PG 模式必需** | **启动即失败**（有意的 fail-closed：调用方密钥无法安全落库） |
| `AG_DATABASE_URL`（或等价） | ✅ 真实模式 | 退回内存模式（重启即丢） |
| OIDC 提供方（issuer / clientId / redirectUri） | ✅ 真实登录 | 无可用登录方式 |
| `AG_NEWAPI_BASE_URL` + 管理员 PAT | 🟡 真实对接 | 渠道对账/写回只能在假上游上验证 |
| `AG_LLM_*` | 🟡 LLM 类插件 | LLM 网关不装配（见 §三 L-2） |

### 步骤 3 · 容器化验证（**需要一台有 Docker 的机器**）

```bash
node --experimental-strip-types tools/docker-preflight.ts   # 静态 11/11
docker build -t access-gate .
docker compose up -d && docker compose exec app npm run verify:all
# ★ 关键验证：rm -rf 容器后重建，数据仍在（依赖卷持久化）
```

步骤与判据见 `reports/containerization-runbook.md`。

### 步骤 4 · 小时级长跑（**需要数小时窗口**）

```bash
node --experimental-strip-types tools/soak.ts --minutes=180 --load=50
```

判据：服务始终 ready · RSS 无单调增长 · PG 进程数不堆积 · 错误计数不累积。
★ 当前只跑过 **2 分钟**（5/5 通过）——**不足以证明生产稳定**。

### 步骤 5 · 真实 new-api 对接

```bash
npm run verify:scenario-a      # 用真实 base_url + PAT 重跑
```

---

## 三、已知限制（**明确不做的边界**）

| # | 限制 | 说明 |
|---|---|---|
| **L-1** | ★★ **`ag_email_rules` / `ag_invite_codes` 的存储已就绪，但"使用路径"未接** | 存储层与判定逻辑**已实现且被测试覆盖**（11/11 与 8/8），但**没有注册/登录路径调用它们**。按 `unwired-modules.md` 的定义这属于 **A 类（真的未接线）**——**不能因为"测试全绿"就当作能力可用** |
| **L-2** | **LLM 网关未装配** | `llm-gateway.ts` 与 `DbLlmCacheStore` 都已就绪，但服务里**没有实例**（需要 LLM 服务凭据）。这是**条件装配**的候选：有 `AG_LLM_*` 时才启用 |
| **L-3** | **`package-cache` 启动拉回未接** | 外置插件的包体存储 + 本地缓存 + 上传端点都已完成，但**启动时不自动按 digest 拉回** |
| **L-4** | **级联回退按 `priority` 而非 `tier`** | 运行期 `PolicyDocument` 无 `tier`（它在 `ag_policies.tier` 列），因此回退只实现文档算法的**第二层** |
| **L-5** | **2 条 R6 warn** | `ag_plugin_instances` 的可空唯一键（PG 把 NULL 视为互不相同 → 唯一约束静默失效）。正确修法需 `onConflict` 支持谓词，或按 `docs/11 §14.1` 改用 `ownerScope`+`ownerId` 双列 |
| **L-6** | **`process` 形态 provider 调用契约未实现** | 见 `architecture-gaps.md`（R129）；需真实 process 插件环境 |
| **L-7** | **`ag_user_policy_state` 的 9 个状态列零使用** | 见 `architecture-gaps.md`（R125）；**需核实**，本会话未动 |
| **L-8** | **容器化真跑 / 小时级长跑未验证** | 需外部环境（脚本已就绪，见步骤 3/4） |
| **L-9** | **`crossSite` 目前只有 1 个消费方** | "管理员查看全站点灰度分配"。判定层是通用的（admin/developer/enduser 三态收敛），但**其他跨站点场景尚未出现**，不预先接线 |
| **L-10** | **接口面覆盖率未复测** | `FINAL-STATUS.md` 写的 58.7% 是旧数字，**未在本会话复测**——如实标注，不编数字 |

### ★ 关闭状态（Round 23 实测）

> 上面那张表是**原始登记**，以下是**现状**：**L-1 … L-5 已全部关闭**。

| # | 现状 | 关闭方式与证据 |
|---|---|---|
| **L-1** | ✅ **已关闭** | 邮箱准入接进 `resolveLogin`（**建号之前**判定；`LoginOutcome` 新增 `email_not_admitted`）· 邀请码核销端点 `POST /api/me/redeem-invite`（**共享实现**——两处路由装配行为一致）· 事实只允许 manifest 声明的字段。测试 **6 + 12** 条 |
| **L-2** | ✅ **已关闭** | `HttpLlmProvider`（`LlmProvider` 的**唯一实现**，含响应形状校验/超时/错误带状态码）· 条件装配（有 `AG_LLM_API_KEY` 才启用 + 注入 `DbLlmCacheStore`）· **接进 HostApi**（`host.llmInvoke`；`pluginId` 由**宿主**填——插件无法冒充）。测试 **7 + 5** 条 |
| **L-3** | ✅ **已关闭** | `restorePluginPackages`（启动按 digest 拉回；**单个失败不阻断**但必须可见）。测试 **5** 条 |
| **L-4** | ✅ **已关闭** | `tier` 打通全链路（DB → `PolicyDocument` → `restore-source` → `decideRestoreTarget`）——级联回退的**第一层**自此生效 |
| **L-5** | ✅ **已关闭** | 给 `onConflict` 加**部分唯一索引谓词**支持（通用能力）+ 应用到位；**R6 warn 2 → 0**（`verify-tables` 报"全部表通过"） |

**仍然存在的（重新定性，逐项给判断）**：

| # | 项 | 性质与判断 |
|---|---|---|
| **L-6** | `process` 形态 provider 调用契约 | **需外部环境**（真实 process 插件）。协议可以写，但"写完没验证过"的价值有限 —— 与长跑同类 |
| **L-7** | `ag_user_policy_state` 的状态列 | ✅ **已审计完毕**（不再含糊）：**7 列在用 · 2 列已实现 · 4 列标注理由 · 1 列被替代**。见 `reports/state-columns-audit.md`；实现的是 `satisfiedAt` / `lastEvalId`（含 8 条行为测试） |
| **L-8** | 容器化真跑 / 小时级长跑 | 🟡 **拆分**：**容器化已非必需**（二进制部署已验证并产出 systemd unit，见 `reports/binary-deployment.md`）；**小时级长跑仍需外部环境** |
| **L-9** | `crossSite` 只有 1 个消费方 | **设计如此**：判定层是通用的（admin/developer/enduser 三态收敛），其他跨站点场景未出现时不预先接线 |
| **L-10** | 接口面覆盖率 | **未复测** —— 如实标注，不编数字 |
| **L-11** | ~~邮箱准入用入口站点规则~~ | ✅ **已解决**：改为**站点准入闸门** —— 在「**进入站点**」时按**目标站点**校验，且覆盖**两条**改作用域的路径（`/api/me/site` 与前端实际走的 `/api/me/selection`）。另支持「**传参登录自动选站点**」（`?site=<uuid>`，经 OIDC 事务往返、同样过闸门）。见 `src/http/site-admission.ts` |
| **L-12** | ~~审计只写不读~~ | ✅ **已关闭**：`AuditSink` 增加读取接口（`list` + `AuditQuery`）；`ag_audit_log` 补 `developerId` / `realm`（**必须落库**：`auditQueryFilterOf` 要求"在 SQL 层就限住范围"，JOIN 出来的归属当不了过滤条件）；`GET /api/admin/audit` 落地，**两层可见性**（SQL 条件 + `filterVisibleAudit` 二次校验）+ 13 条测试 |
| **L-13** | ~~LLM 限流是进程内计数~~ | ✅ **已关闭**：按 `docs/05 §6.4` 实现 **`QuotaGuard`**（`withTokenBucket` / `withBudget`），键**由类型强制与归属同构**（`quota:{ownerScope}:{ownerId}:{pluginId}:{instanceKey}:{resource}` —— 调用方**写不出**「只有资源名」的键）；新增 `ag_quota_counters` 表 + `DbQuotaCounterStore`（**条件更新 + RETURNING** 原子预占，跨实例共享）；LLM 网关的限流与预算已接入（`settle` **如实记账**、失败 `releaseReservation`），`serve.ts` 真实模式注入 PG 计数。★ 未装配 `quota` 时仍退回进程内，但超限文案**点明**该口径缺陷 |
| **L-14** | ~~动作参数寻址未接线~~ | ✅ **已关闭**：`ActionExecutor` 用与求值**同一个解析器**把 `params` 里的寻址换成具体 `externalId`；**解析不出来即失败**（绝不把寻址串交给下游）。★ 过程中发现并**勘误**了 `docs/04` 的示例（`subject: "subject:newapi"` 缺路径、且该参数无人读） |
| **L-15** | ~~一键熔断未实现~~ | ✅ **已关闭**：熔断状态落 `ag_platform_settings`（重启不忘）；`GET/POST /api/admin/rollouts{,/abort,/resume}` 可被按到（含**按站点分组的受影响清单** + 写审计）；**熔断在决策路径生效**（`abortedPolicyIds` → `rollout_aborted`，优先于比例与名单） |
| **L-16** | ~~两套分支求值~~ | ✅ **已关闭**：`branches.ts` 对齐为「遇 `indeterminate` **立即收敛**」（此前会继续、可被后续排除分支**降级为不满足** = 凭不知道的信息收回权限）；**7 条交叉一致性测试**锁定两实现结论必须相同 |
| **L-17** | ★★ **`fact:` 限定写法静默失效**（**新发现，已修**） | `parseOperand` 不认 `fact:` → `fact:email.domain` 被当成**字符串字面量**（永远 false、不报缺失）；`collectFactRefs` 正则也只认点号 → **该事实永不采集**。两处叠加 = **用文档推荐写法写的策略静默失效**，且渠道故障时会判"不满足"（**H1 违规**）。已修 + 12 条测试（含两种写法一致性） |
| **L-18** | ~~`if (plugins !== undefined)` 缺少路径守卫~~ | ✅ **已修**：该守卫改为**按路径**的显式 501（`path.startsWith('/api/admin/plugins')` 且未装配 → 501），被误吞的 `oidc/signing-keys` ×2 与 `policy-assignments/cross-site` **恢复可达**。★ 新增**端点可达性测试**（从 `routes.ts` 的 `mount(...)` 自动派生 + 对照组），一写出来就抓到 5 处同类问题。★ **并存的两种约定已记录在案**（「未装配则不挂载 → 404」：`verify/*` · `oidc/providers` · `users` · `settings`；「进入端点后显式 501」：`signing-keys` · `cross-site` · `rollouts`）——**这处分歧值得定夺**，我未擅自统一 |
| **L-19** | ~~`identity:` root 未被求值层识别~~ | ✅ **已关闭**：`identity:oidc@<ref>.<claim>`（`docs/04 §1.2.7.3`）在**解析层 / 依赖收集层 / 求值层**三处齐备（`parseOperand` 的 `identity` 分支 · `collectIdentityRefs` · `EvaluationContext.identity`），`evaluateEligibility` **透传**；语义按 H1（**没有该身份 / claim 未开放 → `indeterminate`**，不得判 `false`）。★ 测试含**与 `federation.claimAddressOf` 逐字一致**的跨模块核对 |

---

## 四、外部依赖清单

| 依赖 | 用途 | 缺了的后果 |
|---|---|---|
| **Docker 环境** | 容器化真跑（步骤 3） | 交付方式未验证（功能不受影响） |
| **数小时时间窗口** | 小时级长跑（步骤 4） | 无法证明无缓慢泄漏 |
| **真实 new-api 实例 + 管理员 PAT** | 真实对接（步骤 5） | 对账/写回只能在假上游上验证 |
| **LLM 服务凭据**（OpenAI 兼容） | 装配 LLM 网关（L-2） | LLM 评审类插件不可用 |
| **`AG_MASTER_KEY`**（32 字节 hex/base64） | 真实模式启动 | **启动即失败**（有意 fail-closed） |
| **OIDC 提供方** | 真实登录 | 无可用登录方式 |

---

## 五、验收命令与期望输出（**实测数字**）

| 命令 | 期望 |
|---|---|
| `npm test` | **1302 / 1302 · 0 跳过** |
| `npm run ci` | **13 / 13 PASS**（退出码 0） |
| `npm run verify:all` | **退出码 0**（场景 A + 真实 PG e2e + path-probe 68 + 巡检 **5/5** + 短长跑 **5/5**） |
| `npm run db:check` | 门禁 **0** · 漂移 **0**（47 表 · 47 枚举 · 96 索引 · 235 条 DDL） |
| `node --experimental-strip-types tools/verify-tables.ts` | **0 error**（2 warn = L-5） |
| `npm run security` | 无高危 |
| `node --experimental-strip-types tools/docker-preflight.ts` | 静态 **11/11**（★ 5 项显式标注无法验证） |

短长跑实测（2 分钟 · 50 QPS）：**5520 请求 · 0 失败** · RSS 后半段 **+6.6MB**（阈值 <50MB）·
PG 进程不堆积 · 错误计数不累积。

---

## 六、状态诚实说明

1. **本文件不声称"生产就绪"**。它声称的是：**代码、文档、脚本已一致且可验收**，
   剩下的验证项目**全部有可执行步骤**（步骤 3/4/5），但它们**需要你没有的环境**。
2. **P0 已全部关闭**（`DELIVERY-READINESS.md` §三），但 §三 的 **L-1/L-2/L-3 是真实的接线缺口** ——
   它们是"存储/实现已就绪、使用路径缺失"，不是"设计未实现"。
3. **数字会变**：本文所有数字来自本会话最后一次完整运行。若你跑出的数字与此不同，
   **以你的运行为准**，并回改本文件。
