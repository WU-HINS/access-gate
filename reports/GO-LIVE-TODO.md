# 投产就绪 · 可执行 TODO（无人值守推进）

> 与 `architecture-gaps.md` 的区别：那份是**登记**（"为什么不在本轮修"），
> 这份是**执行计划**——每条都带「判据」与「状态」，且**必须能被一条命令验证**。
>
> ★ 本文件的方法论来自本仓库自己的教训（`FINAL-STATUS.md` §六）：
> **报告里的结论会过时**。因此每条缺口的状态都以**当轮实测**为准，不采信旧报告文字。

---

## 0. 基线（每次改动前后都要重跑）

> ## ✅ 最终状态（本会话收口）—— **请先读这里**
>
> **P0 全部关闭**；**P1 绝大部分关闭**；剩余项已逐条登记（含**新增的三条真实接线缺口**）。
>
> | 交付物 | 位置 |
> |---|---|
> | **交付契约**（交付了什么 / 你需要做什么 / 已知限制） | [`DELIVERY-CONTRACT.md`](./DELIVERY-CONTRACT.md) |
> | **缺口评估**（P0 已全部关闭 + 关闭证据） | [`DELIVERY-READINESS.md`](./DELIVERY-READINESS.md) |
>
> ### 本会话新关闭的项
>
> 三张零读写表（`ag_email_rules` · `ag_invite_codes` · `ag_policy_assignments`）·
> **`crossSite` 接线**（第一个真实消费方）· **`subject:*` 跨系统寻址**（求值 + 快照 + serve 接线）·
> `AlertSilenceStore` 持久化 · `$maxSkew` 时间偏斜 · 保留期清理调度 · `one_shot` 发布校验 ·
> OIDC 密钥轮换（PG 存储 + 从表加载 + 审计 + 管理端点）· 插件升级兼容检查 ·
> 插件包体存储 + 本地缓存 + 上传端点 · 告警静默 · LLM 缓存持久化 + 网关缓存注入 ·
> 插件绑定存储 · 指标标签白名单
>
> ### ★ 仍然存在的真实缺口（**不要因为"测试全绿"而忽略**）
>
> | 缺口 | 性质 |
> |---|---|
> | ~~`email-rule-adapter` / `invite-code-adapter` 的**使用路径未接**~~ | ✅ **已关闭**：邮箱准入 `resolveLogin`（**建号之前**）+ 邀请码核销端点；**18 条测试** |
> | ~~`llm-gateway` 未装配~~ | ✅ **已关闭**：provider（唯一实现）+ 条件装配 + **HostApi 通道**；**12 条测试** |
> | ~~`package-cache` 启动拉回未接~~ | ✅ **已关闭**：`restorePluginPackages`（按 digest 拉回）；**5 条测试** |
> | ~~`ag_plugin_instances` 的 2 条 R6 warn~~ | ✅ **已关闭**：`onConflict` 加**谓词支持** → **R6 warn 2 → 0** |
> | ~~级联回退按 `priority` 而非 `tier`~~ | ✅ **已关闭**：`tier` 打通全链路（DB → 文档 → 回退判定） |
> | 容器化真跑 / 小时级长跑 | **需外部环境**（脚本已就绪，见 `DELIVERY-CONTRACT.md` 步骤 3/4） |
> | L-6 `process` 契约 / L-7 状态列审计 | **需外部环境 / 需逐列审计**（定性见 `DELIVERY-CONTRACT.md` §三） |
>
> 完整清单见 `DELIVERY-CONTRACT.md` §三（L-1 … L-10）。

---

| 门禁 | 命令 | 基线值（**本会话最终实测**） |
|---|---|---|
| 单元 + 集成 | `npm test` | **1496 / 1496 · 0 跳过** |
| 完整门禁 | `npm run ci` | **13 项全 PASS**（0 FAIL / 0 WARN；含真实 PG · 真实服务进程 · 性能 · 宿主无知） |
| 类型 | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | 0 错误（★ `npm run typecheck` 在本环境报 `tsc: Permission denied`，用这条替代） |

> ★ 真实 PG 端到端：`node --experimental-strip-types tools/serve-real-e2e.ts`
> ★ **不要同时跑 `npm test` 与 `npm run ci`**——两者都会启动真实 PG。

---

## 1. 已核实为「已修复」的旧结论（不要重复排查）

| 旧报告的结论 | 实测（本轮） | 证据 |
|---|---|---|
| 开发者入驻流程是断的（`recordDeveloperIdentity` 无调用点） | ✅ **已接线** | `tools/serve.ts:736` |
| 对账从不发生（`core/reconciler.ts` 无调用） | ✅ **已接线 + 定时** | `tools/serve.ts:780` / `1195` |
| 事件外发落不了库（`outbox-adapters.ts` 无人使用） | ✅ **已装配** | `tools/serve.ts:753-754` |
| 用户与开发者身份只在内存（`EndUserStore`） | ✅ **已落库** | `tools/serve.ts:978` → `createTransactionalEndUserStore` |
| 宿主 API 根本没有装配 | ✅ **已装配** | `tools/serve.ts:380` → `PluginRuntimeOrchestrator` |
| DC-2 状态 CAS 未实现（`version` 列零使用） | ✅ **已实现** | `src/db/adapters.ts:355-362`（`returning: ['version']` + 冲突分支） |
| Discovery 虚报算法 | ✅ **已修** | 由 `exportJWK` 派生（`algorithmsOfSigningKeys`） |
| 4 个 store 只有内存实现 | 🟡 **降为 2 个**：`RuntimeCache`（疑似刻意）、`VerifyClientStore`（误判，实为 `VerifyClientLookup`） | `tools/impl-pairing.ts` 实测 |

> ★ 工具自身的误判也要记住：`impl-pairing` 按**接口名**配对，
> 因此把 `HostApi`、`VerifyClientStore` 报成"只有内存实现/未使用"，而它们其实已装配。
> **工具输出是信号，不是结论。**

---

## 1.5 目标 (1)「文档层 P0 缺口」的收口（本轮实测）

| 缺口（评估时提出） | 当前状态 |
|---|---|
| 幂等键语义（冻结公式 vs "幂等键含日期"） | ✅ `docs/05` 只剩冻结公式 `hash(siteId,userId,policyId,actionSeq,action)`；"含日期"已清除 |
| 站点表门禁自洽 | ✅ 门禁由**人工白名单**改为**声明派生 R1–R6**（R3 逐表签署豁免理由）；`ag_policy_versions` 唯一键补 `siteId` 首列、`ag_provider_sync_state` 补 `siteId` + 复合主键 |
| 作用域白名单漏表 | ✅ **机制替代**：派生规则不再依赖白名单（漏表无处可漏） |
| `ag_sessions` 缺列 | ✅ `docs/02:128-132` 已有 `realm` / `activeDeveloperId` / `activeSiteId` |
| 宿主无知残留（`user.newapiGroup` / `sync.newapi.*` / `gate_newapi_request_total`） | ✅ `docs/04` / `docs/05` 已 0 命中；CI 第 7 项 PASS |
| 事件死信 / outbox 表 | ✅ `docs/02 §8.5 / §8.6` 已声明（`db:generate` 235 条语句） |
| **工期口径统一** | ✅ **本轮**：`docs/07 §7` 写明两套口径的**前提与适用条件**（48/118 属"完整设计"、30–34/60–70 属"MVP 清单"），并要求引用时注明前提 |
| **R6 门禁假阳性**（本轮新发现） | ✅ 修 `src/schema/gate/scope.ts`：R6 现识别**部分唯一索引谓词**（`where: 'x IS NOT NULL'`）。★ **但实测发现 `ON CONFLICT` 无法推断带谓词的唯一索引**（PG 报 `42P10`）→ `ag_plugin_instances` 的两条谓词**已回退**（保留 2 条 R6 warn，不阻塞），正确修法已登记在 `docs/02` 该表声明处：① 先给 `onConflict` 加谓词支持，或 ② 按 `11 §14.1` 改用 `ownerScope`+`ownerId` 双非空列。`ag_plugin_bindings` 的那条**保留**（不破坏 ON CONFLICT，且确实修掉"未绑定行可重复插入"） |
| **`docs/02 §2` 域清单过时**（本轮新发现） | ✅ 36 → **47 张**；并让 `tools/verify-tables.ts` **同源解析该清单**比对，不再硬编码表数 |
| **`verify-tables` 长期空转**（本轮新发现） | ✅ 表数期望硬编码 `40` → 该工具**退出码恒为 1**、等于空转；现改为同源比对（`✅ 无问题 / exit 0`） |

**门禁实跑（本轮）**：`verify-tables` **0 error / 0 warn** · `db:check` **门禁 0 / 漂移 0**（47 表 · 47 枚举 · 96 索引 · 235 条 DDL 语句）。

---

## 1.6 目标 (2)(3)：场景 A 验收与一键命令（本轮交付）

`docs/07 §5` 场景 A 的 8 步此前**分散**在多个测试里，**没有任何一条命令**串起来跑过；
而其中「写回下游」与「发额度」两条路径在本轮之前**根本未接线**。
本轮新增 `test/scenario-a.test.ts`（真实 HTTP 下游 + 真实动作插件 + 真实签到），并固化为命令。

| 步骤（`07 §5`） | 覆盖位置 | 验证命令 |
|---|---|---|
| ① 配置 provider（`config.scope: site`） | `test/scenario-a.test.ts` | `npm run verify:scenario-a` |
| ② 配置策略（edu 分支 + `checkin:grant`） | `test/policy.test.ts` · `test/patrol.test.ts` | `npm test` |
| ③ 用户登录 + 邮箱验证 | `test/auth.test.ts` · `test/oidc-*.test.ts` | `npm test` |
| ④ 评估后下游分组变 `basic` | **`test/scenario-a.test.ts`**（真实 `PUT /api/user/`） | `npm run verify:scenario-a` |
| ⑤ 用户侧「我的资格」 | `test/eligibility.test.ts` | `npm test` |
| ⑥ 签到成功、额度到账 | **`test/scenario-a.test.ts`**（真实 `POST /api/user/manage`） | `npm run verify:scenario-a` |
| ⑦ 重复巡检 10 次无额外写回 | **`test/scenario-a.test.ts`**（数下游 PUT 次数）＋ `test/patrol.test.ts`（状态机层） | 两者都跑 |
| ⑧ 不再满足 → 回退 | **`test/scenario-a.test.ts`**（回退写回）＋ `test/lifecycle.test.ts`（宽限期计时） | 两者都跑 |

**该文件额外固化的两条硬约束**（此前只有单元级证据，没有端到端证据）：
- 写回请求体**绝不包含 `password` / `access_token`**（带上即不可逆损坏）；
- `username` / `display_name` / `remark` **必须回填**（下游 `PUT /api/user/` 是整体替换语义）。

**一键命令总表**（objective (3) 要求的"可直接执行的脚本与步骤"）：

| 命令 | 覆盖 |
|---|---|
| `npm test` | 1080 项（含场景 A、签到编排、签到资格） |
| `npm run ci` | 13 项门禁（含真实 PG 集成 · 真实服务进程 e2e · 性能 · 宿主无知） |
| **`npm run verify:scenario-a`** | **场景 A 关键链路（真实 HTTP 下游）** |
| `npm run verify:all` | 场景 A → 真实 PG e2e（23 步）→ path-probe（68）→ 巡检存活 → 短长跑 |
| `npm run backup` | 备份/恢复演练（`tools/backup-restore.ts`） |
| `npm run security` | 安全自查（12 项） |
| ★ 需外部环境 | 容器化：`tools/docker-preflight.ts`（静态 11/11）+ `containerization-runbook.md`；小时级长跑：`tools/soak.ts --minutes=…` |

> ★ 目标 (1) 的"使 `02 §1` 门禁成为**可执行且能通过**的谓词"**已达成**：
> 它现在既能报错（R3 未豁免即 error），也能被修好（R6 认部分唯一索引），
> 且有一条独立的自检命令可复跑。

---

## 2. 待修（按「投产阻断」排序）

### P0 —— 会导致资损 / 数据错误 / 功能不可用

| # | 缺口 | 判据（可验证） | 状态 |
|---|---|---|---|
| **P0-1a** | `checkin:grant` / `checkin:revoke` 写**进程内 Map** → 重启丢资格 | `ag_checkin_entitlements` 有读写；重启后资格仍在；幂等（重复 grant 不改 `granted_at`） | ✅ **本轮完成**（`src/core/checkin.ts` + `src/db/checkin-adapter.ts` + `storage.checkins` + `test/checkin-entitlement.test.ts` 2/2） |
| **P0-1b** | `ag_checkin_records` 零读写 → **发额度无幂等锚点**（重复发额度 = 资损） | 三步编排落地（写记录 → 发额度 → 回填）；`ON CONFLICT (site_id,user_id,checkin_date) DO NOTHING`；同日第二次签到返回"今日已签到"而非再发 | ✅ **本轮完成**（`src/core/checkin-service.ts` + `CheckinRecordStore`（内存/PG）+ `test/checkin-service.test.ts` **7/7**，含真实 pglite 的 `ON CONFLICT DO NOTHING` 验证） |
| **P0-1c** | 无 `/me/checkin` 端点（`docs/06 §4`） | 三个端点可用（status / checkin / history）且走资格判定五步短路（`docs/05 §5.2`） | ✅ **本轮完成**（`/api/me/checkin/status` · `POST /api/me/checkin` · `/api/me/checkin/history`；站点从**会话**取，不接受请求参数） |
| **P0-2** | **级联回退缺失**（🔴 文档标注严重）：`baseline` 零使用 · `restore` 动作未注册 | 策略 B 失效时回退到**仍满足的** A 所要求的档位，而不是静态 `default` | ✅ **已完成（动作层 + 存储层 + 接线）**：`src/core/action-restore.ts`（4 步算法；决胜并列时**拒绝执行并告警**；`baselineDrifted` 交上层按 `driftPolicy` 处理）· `src/core/restore-source.ts`（状态表 × 策略定义 → 要求清单，**serve.ts 与验收共用同一实现**）· `src/policy/required-group.ts`（提取要求的档位，**刻意不看 `onUnsatisfied`**——看它就会复现原始缺陷）· `LifecycleStateStore` 扩展 `listByUser`/`baselineOf`/`rememberBaseline`（内存 + PG，后者用 `CASE WHEN baseline ? $key` 原子表达「仅当为空时写」）· `serve.ts` 接线（`policyCodeOf` 反查 + `rememberBaseline` 注入 + `restore` 注册 + `knownActions`）· 测试 **20 条**（16 判定 + 4 端到端）。★ **已知限制**：运行期 `PolicyDocument` 不带 `tier`，当前以 `priority` 决胜（即文档算法「tier 高者 → priority 小者」的第二级）——把 `tier` 带进 `PolicyDocument` 已登记 |
| **P0-3** | 平台级事实写入 (`FactPipeline` 的平台级主体语义) | 平台级插件采集不报错 | ✅ **已修（本轮核实）**：`reports/adr-plugin-fact-subject.md` 的**方案 A 已落地**——`ensureDeveloperUser` 在入驻时建 `ag_users` 并回填 `ag_developers.user_id`（`tools/serve.ts:795`），插件自动调度按开发者解析主体（`:860-887`）；`ag_developers` 已有 `user_id` 列 |
| **P0-4** | `in-process` **无任何准入检查**（`runtime` 只被存储） | 未签名插件写 `runtime: 'in-process'` 被拒 | ✅ **本轮完成**（`src/plugin/in-process-admission.ts`：三条件 AND，且**一次列出全部缺失项**；接入 `setStatus('enabled')` 的**两处**实现（内存 / PG）；`test/in-process-admission.test.ts` **10/10**，含 2 条**接入点**测试——断言「被拒后状态**未**变成 enabled」）。★ **官方信任列表默认为空**（第三方要 `in-process` 必须由平台显式加入）：这是刻意的 fail-closed 默认，列表来源（平台设置项）登记为**待决策项** |
| **P0-5** | **真实 newapi 动作插件未被装配**：`src/plugin/builtin/newapi-actions.ts` 零生产引用（只在 `tools/audit-gap.ts` 里被当静态证据提到）；`tools/serve.ts` 注册的 `set_group` 无论是否配置渠道都只写进程内 `downstreamGroups` → **动作报告成功而下游分组永远不变** | `set_group` / `add_quota` / `set_status` 在服务里经真实 provider 写回下游；内存演示实现被替换；`module-wiring` 的该条从"待判断"变为"已接" | ✅ **本轮完成**：`set_group`（经 `writeBackAttributes`）+ **`add_quota` / `set_status`**（经 `DownstreamApi.manage` → `POST /api/user/manage`）**全部接线**；`knownActions` 与动作注册**共用 `manageActionsAvailable` 判据**（两处清单不再可能漂移）；真实模式未配置渠道时 `set_group` **fail-closed 抛错**，不再静默写内存 |

### P1 —— 可带风险上线，但应在投产前关闭

| # | 缺口 | 判据 | 状态 |
|---|---|---|---|
| P1-1 | 指标不带 `siteId`（无法按站点下钻，`docs/05:608`） | `metrics.ts` 有站点维度且打点处传入 | ✅ **已完成（本轮）**：`src/kernel/metrics.ts` 加**强制标签白名单**（`renderLabels` 是全部打点的唯一必经之路）——禁止无界标签（`userId`/`subjectId`/`externalId`/`email`/`traceId`/`sessionId`/`kid`/`ip`）与白名单外标签，两者均**抛错**（防时序基数爆炸，`docs/05 §7.1.1`）。**18 处打点全部补 `siteId`**（原标签名 `site` → `siteId`；HTTP 指标标为**平台级** `'platform'`，因为一个请求可能属于任何站点且 `finish` 时已无会话上下文）。★ 门禁**真实起作用**：它当场抓到 `test/ops.test.ts` 里的任意标签（`a`/`b`/`queue`）并促其改名。★ 待办：文档要求「**所有**指标必须带 `siteId`」——当前是「白名单强制 + 关键指标带 `siteId`」；"无标签打点也强制 siteId"未做（那会要求所有打点处显式传参） |
| P1-2 | 告警**静默**能力整体不存在（`docs/05:225`） | `silence` 带期限 + 到期自动恢复 + 三个审计事件 | ✅ **已完成（本轮）**：`src/core/alert-silence.ts` —— `validateSilence`（拒绝过去时间 / 超长 / "9999 年永不过期"）· `isSilenced`（判定只有 `until > now`，**到期自动恢复不依赖任何清理任务**——靠清理任务"恢复"会引入新黑洞：任务没跑就永久压制）· `expiredSilences`（仅回收存储）· `AlertSilenceService`（三个审计事件 `alert.raised` / `alert.acknowledged` / `alert.silenced`；`raise()` 返回「是否应打扰人」，**被静默也写审计** `suppressed: true`）。已接入 `tools/serve.ts` 的启动期不变量告警。`test/alert-silence.test.ts` **13/13**。★ 待办：真实模式的静默持久化（当前内存实现；重启丢失的方向**安全**——静默失效、告警重现，不会漏告警） |
| P1-3 | 保留期机制 + 两条启动期不变量（`docs/05:234`） | 参数存在 + 清理任务 + 启动校验（否则校验的是不存在的参数） | 🟡 **机制 + 启动校验完成（本轮）**：`src/core/retention.ts` —— `RetentionSettings`（5 项保留期 + `maxGrantLifetime`）· 不变量 2「授权有效期 ≤ **最短**保留期」· 不变量 1「事实 TTL ≥ 主体数 ÷ 配额」（配额未声明时报「无从计算」而非静默通过）· `planVersionPurge`（保留最新 N 个，但**永不清理被 `granted`/`satisfied` 引用的版本**）· `checkStartupInvariants` 聚合。`tools/serve.ts` 在 `app.listen()` 前跑校验并**告警**（不拒绝启动：运维风险 ≠ 数据损坏，拒绝启动会把可运行实例变成不可用）。`test/retention.test.ts` **13/13**。**待做**：① 不变量 1 的输入——provider 配额声明（当前 `capabilities` 无配额字段，**如实跳过**，不编造配额去"通过"检查）② ~~`planVersionPurge` 的调度接线~~ ✅ **Round 15 完成**：`src/core/retention-cleaner.ts` 的 `purgePolicyVersions`（**编排**：取值 → 判定 → 删除；判定复用纯函数 `planVersionPurge`，故"删哪些"可穷举）+ **接线**到 `tools/serve.ts` 调度循环（**1h 节流** + `reuseOrBeginTransaction` 包装 + PG 查询）。★ **语义澄清（关键）**：`ag_user_policy_state` 引用的是 `policy_id` 而**不是版本 id** → 真正要保护的是「**有 granted/satisfied 状态的策略的 `active_version_id`**」；若只按"最新 N 个"清理，会删掉一个**正在生效的**版本。`skippedProtected`（本来会被删、因被引用而幸免）作为运维可见指标。`test/retention-cleaner.test.ts` **6/6**③ ~~`one_shot` 必须声明 `maxLifetime` 的发布校验~~ ✅ **Round 29 完成**：`PolicySpec.lifecycle`（`mode` + `maxLifetime`）此前**代码里完全没有**（文档声明了、类型里没有）——现补上；`validatePolicy` 加三条校验（**未声明** / **无法解析** / **超过最短保留期**），报错刻意说明后果（"授权不能比它的证据活得更久"）。★ 校验必须在**发布时**：`one_shot` 一旦授予就不再因条件变化而撤销，而这个决定收不回来。`test/policy-lifecycle-validation.test.ts` **6/6** |
| P1-4 | OIDC 签名密钥**轮换流程**未实现（高危操作无安全通道） | 四步流程 + 同事务切换（否则零 active 窗口 → 全站登录中断） | 🟡 **本轮完成判定层与顺序证明**：`src/core/oidc-key-rotation.ts`（`nextRotationStep` 纯函数判定 + `needsNewStandby` 发起判定 + `OidcSigningKeyStore` 契约 + `applyRotationStep` 只执行一步）；`test/oidc-key-rotation.test.ts` **9/9** —— 其中两条**在真实 PG 上证明**了文档点名的两种错法：① 先升后降**必然撞** `uq_ag_oidc_keys_active_alg`；② 拆两条语句**真的出现零 active 窗口**。★ **本轮新发现（比原缺口更靠前）**：OIDC 签名密钥**从未落库**——`tools/serve.ts:952` 用内存 `SigningKeySet` 运行时生成，`ag_oidc_signing_keys` 表在 `src/` 里**零引用**。★ **PG 存储已完成（Round 17）**：`src/db/oidc-signing-key-adapter.ts` 的 `DbOidcSigningKeyStore` —— `list` / `createStandby`（jose `generateKeyPair` + `exportPrivateJwk` + **AES-256-GCM 加密私钥**落库）/ `activateAtomically`（**同事务先降后升**）/ `retire` / **`loadSigningKeySet`**（从表加载 + 解密 + `importJWK`，含 retiring——旧 token 靠它验签）。`test/oidc-signing-key-adapter.test.ts` **6/6**：含**签名/验签往返**（证明"加密存储 → 解密加载"链路正确，这是密钥持久化唯一有意义的验收）与**「重启后是同一把密钥」**（新建 store 实例加载 → 同一 kid，直接反驳"重启即换密钥"）。★ 过程中 CI 第 6/8/9 项三次拦住我（模板字面量插值列名 = 裸 SQL 拼接形态；注释里写了驱动查询的字面形态）——已按门禁要求修正，并把该文件加入仓储层白名单**附理由 + 一条证明运行时兜底的测试**。★ **接线已完成（Round 18/19/28）**：`tools/serve.ts` 真实模式下用 `loadSigningKeySet()` **从表加载**（冷启动生成首把并启用；无 DB/主密钥时**显式**降级到内存并记 warn）· 调度循环里**轮换**（5 分钟节流；`none`/`wait` 无副作用，等待期由判定函数的截止时间表达，不 sleep）· **审计**（`oidc.key_published` / `key_activated` / `key_retired`——高危操作必须留痕，日志会轮转而审计不会）· **管理端点**（`GET /api/admin/oidc/signing-keys` 查看状态 + `POST …/rotate` 手动触发，**与调度器同一套判定**，不会因"手动"跳过等待期）。`test/oidc-signing-keys-admin.test.ts` **4/4**（未装配 → **501**）。★ **CI 第 11 项再次拦住我**：加了 handler 却忘了在 `routes.ts` 里 `mount` → 报「实现存在但用户调不到（404）」——**这正是该检查器的价值**（`mount()` 用固定 path，漏列清单就会静默 404）。**P1-4 至此完成** |
| P1-5 | 事实**时间一致性** ①②③ | `ExplainNode` 携带 `collectedAt`；`$maxSkew` 超限判 `indeterminate` | ✅ **全部完成**：① 同批采集共享 `collectedAt`（**原子写入**，早已实现）· ② 结果树标注采集时间（Round 8：`ExplainNode.collectedAt` + `EvaluationContext.factCollectedAt` + `eligibility`/`patrol` 两处注入）· ③ **`$maxSkew`（Round 16）**：`ReservedProps.$maxSkew` + `applyMaxSkew`（在**每个节点出口**应用——用「包装 + 内部函数」而不是在每个 `return` 处插代码，否则**漏掉的分支恰好就是"不会判 indeterminate"的那条**）+ `collectCollectedAtMs`；★ **超限判 `indeterminate` 而非 `false`**（H1：绝不用半新半旧的数据下结论/降级）；★ 顺带把 `parseDuration` 提取到**零依赖**模块 `src/kernel/duration.ts`（求值器不该依赖插件宿主，也有循环依赖风险）。`test/expr-max-skew.test.ts` **8/8** + `test/fact-collected-at.test.ts` **5/5** |
| P1-6 | 插件升级**向后兼容检查** | `factSchema` 对比 + 反向索引 + 阻止升级 | 🟡 **判定层完成（本轮）**：`src/plugin/schema-compat.ts` —— `diffFactSchema`（removed / type_changed / added；★ 只比字段名与类型，**`title` 等展示属性变化不算变更**，否则改文案就触发审查）· `factPathsOfNamespace`（**反向索引**，复用 `collectFactRefs` 保证与发布侧**同一套口径**；含**分支条件**里的引用）· `checkUpgradeCompatibility`（被**已发布**策略引用的删除/改类型 → **拒绝**并列出策略 code；无人引用 → 允许 + **警示**）· `describeUpgradeRejection`（拒绝理由**点明「发布侧的正向校验挡不住」**，避免运维误以为发布时已检查过）。`test/schema-compat.test.ts` **9/9**（含 namespace ≠ 插件 id 的 enricher 情形）。★ **接线已完成（本轮）**：`src/admin/api.ts` 的 `POST /api/admin/plugins/install` 在 `plugins.install` **之前**调用 `checkPluginUpgrade`，拒绝时返回 **409** 并附可读原因（点明「发布侧正向校验挡不住」）。★ **意外收获**：`AdminDeps.policies` **本就存在**（原以为要扩展 deps）→ 接线成本比预估低。★ **已知边界**：① 只查**当前站点**的策略（插件是平台级、策略是站点级，严格做法需跨站点通道 → P1-7）② 草稿也纳入检查（保守：宁可多挡一次升级）③ 任一侧未声明 `factSchema` 时放行（**已知盲区**，注释与测试同时记下） |
| P1-7 | `crossSite()` 显式跨站点 API（`docs/08:278-284`） | 带 `reason` + 按角色收敛 + 写审计 | 🟡 **判定层完成（本轮）**：`src/core/cross-site.ts` —— 角色收敛（`admin` 全部 / `developer` **仅名下** / `enduser` 拒绝）· **必填 `reason`**（连 admin 也不例外）· ★ `developer` 请求**非名下站点 → 拒绝而不是静默过滤**（越权必须响亮，不能伪装成"没有数据"）· ★ **只有 `allowed` 的判定才能转出 `scope: 'bypass'`** · 审计条目 `cross_site.query`。`test/cross-site.test.ts` **9/9**。★ **关于接线（如实说明）**：查询层早有 `scope:'bypass'` + 强制 `bypassReason`，但**全项目零使用**——本模块补的正是缺失的判定「**谁**可以绕过、绕过**哪些**站点」。**当前无真实触发点**（「列出我的站点」走平台级表 `ag_sites` 即可，不需要 bypass；「跨站点统计站点级表」的查询尚未实现），故未接入查询。它的当下价值是：把「绕过站点隔离」从**随手传一个字符串**变成**必须经过判定**——这正是文档说的「要么做不到，要么有人去关掉作用域检查」里被防住的那一半 |
| P1-8 | `add_quota` 幂等键的**文档/代码语义冲突**（本会话评估 Top #1） | 代码按 `§3.0.1` 冻结公式（不含日期桶），而 `docs/05 §3.2/§5.3`、`09 §3.2`、`07 M2-3` 写"幂等键含日期" → **跨日签到会复用同一键** | ✅ **已裁决并落地**（P0-1b 时）：签到的幂等锚点是 `ag_checkin_records` 唯一键，**不经** `ActionExecutor` 的 `actionSeq` 键；`CheckinService` 传入**含逻辑日**的幂等键，测试断言「跨日必须重新发额度」与「同日绝不允许发第二次」 |
| P1-9 | 核心**硬编码具体插件事实路径**（`evaluator.ts` 的 `FIELD_TEXT` 含 `github`/`qq`/`llm`） | 文案从 `factSchema.title` 派生；`github` 等进 CI 品牌名清单 | ✅ **已修（本轮核实）**：`FIELD_TEXT` 硬编码表**已删除**（改为 `$label` 优先 → 兜底原样显示路径）；CI 第 7 项已有 `PLUGIN_BRANDS`（`github`/`qq`/`discord`/`telegram`/`linuxdo`，数组拼接避免自指），并**刻意排除** `llm`/`checkin`（通用能力名词而非品牌）—— **M4-17 后半已被真实覆盖** |
| P1-10 | 零读写表（`table-coverage`） | 逐表判断「未实现」还是「被替代」并收口 | 🟡 **本轮收口（9 → 4 → 3 张）**：前几轮修掉 5 张（签到资格/记录、OIDC 密钥、插件包体、LLM 缓存），本轮再修 **`ag_plugin_bindings`**。**逐表判断结论——4 张都不是「被替代」**（即 `table-coverage` 警告的警惕情形**未出现**）：① `ag_plugin_bindings` ✅ **本轮已实现**（`src/db/plugin-binding-adapter.ts`：`BindingResolver` 的 PG 实现 + `upsert`/`revoke`/`listByUser`；★ **软撤销不删行**——绑定历史是审计线索；★ 表 5 态 ↔ 接口 3 态的**显式映射**，`stale`/`failed` 归 `pending` 而**非** `active`，因为两者都**不能用来解析主体**）② `ag_email_rules` ❌ **未实现**（注意区分：`email-domain` 插件的 `allowDomains` 是**采集事实**用，本表是**注册准入闸门**——用途不同，不构成替代）③ `ag_invite_codes` ❌ **未实现**（终端用户邀请码；`ag_dev_invitations` 是**开发者入驻**用的，功能不同）④ `ag_policy_assignments` ❌ **未实现**（策略分流/灰度，属 M3 范围）。**待做**：②③④ 逐项实现，或在文档中**显式标注为前瞻**（当前的沉默才是问题） |
| P1-11 | 包体存储（`ag_plugin_packages.blob` 全零使用） | 外置插件安装可用 | 🟡 **存储层完成（Round 20）**：`src/db/plugin-package-adapter.ts` 的 `DbPluginPackageStore`（`put` / `get` / `list` / `verify` / `prune`）——★ `digest` **由存储自己算**（不接受调用方声称的值，否则完整性校验形同虚设）；★ `list()` **不选 blob 列**（`docs/02 §4`：含 `node_modules` 的 process 插件包可达数十 MB）；★ `verify()` **重新计算**比对（库里的 digest 列只证明"存的时候是什么"）；★ `prune()` 与策略版本清理规则**不同**（插件包无"被状态引用"问题——运行时用的是已解包的本地副本）。`test/plugin-package-adapter.test.ts` **8/8**。★ **本地缓存已完成（Round 30）**：`src/plugin/package-cache.ts` 的 `FileSystemPackageCache.ensure()`（本地命中即用；否则按 digest 从权威存储拉回并校验）——★ 三条纪律：① **本地不可信**（命中也要**重算 digest**）② 不匹配则**丢弃并重拉**（缓存本来就可丢弃，不该因此让服务起不来）③ **权威存储 digest 不符 → 抛错且不写本地**（投毒/存储损坏，绝不把错误固化）。★ 顺带把 `digestOf` 提取到**零依赖**模块 `src/kernel/digest.ts`（插件层不该依赖数据访问层）。`test/package-cache.test.ts` **7/7**（含★「容器重建后仍能拉回」——这正是 D9 要证明的事）。★ **安装端点已完成（Round 31）**：`POST /api/admin/plugins/packages`（base64 上传 → `put`；`digest` **由存储自算**、不接受调用方声称的值；写审计 `plugin.package_uploaded`——包体后续会被解包执行，属高危操作）+ `routes.ts` **mount** + `serve.ts` 注入。`test/plugin-packages-admin.test.ts` **5/5**（未装配 → 501；三种参数缺失各自有明确提示；空包体不写入）。**P1-11 至此完成**（存储 + 本地缓存 + 安装端点） |
| P1-12 | `ag_llm_cache` 持久化（实际走宿主内存缓存，重启全丢） | 成本问题，非正确性 | 🟡 **存储层完成（Round 21–24）**：`src/db/llm-cache-adapter.ts` 的 `DbLlmCacheStore`（`get` / `put` / `purgeExpired`）——★ `get()` **自己判过期**（`expires_at > now`），因此"过期即未命中"**不依赖清理任务**（与告警静默同一纪律：靠清理任务"恢复"会引入"任务没跑 → 一直命中旧结果"的静默问题）；★ 作用域隔离（`ownerScope` / `ownerId`）；★ token 计数随缓存带回，**成本可核算**。`test/llm-cache-adapter.test.ts` **8/8**。★ **澄清一个易被误改的设计**：唯一键 `(ownerScope, ownerId, inputHash)` **不含 `model` 列是刻意的**——`llm-gateway.#cacheKey()` 算的是 `sha256(model + messages + temperature)`，**模型已参与哈希**（换模型 → 不同 `inputHash` → 不同行，不撞键）；`model` / `promptVer` 列用于**排障与统计**，不是键的一部分。★ **接线完成（Round 27）**：`LlmGatewayOptions` 新增 `cacheStore` / `cacheOwner` / `cacheTtlMs` / `promptVer`；网关**持久优先、未注入时退回进程内 Map**（向后兼容），并用 **`import type`** 只依赖形状、不引入跨层运行时耦合；★ **过期语义只保留一个实现点**（`cacheStore.get` 自己判，网关不再判一次——否则两处迟早不一致）。`test/llm-gateway-cache.test.ts` **6/6**：含 ★★「**重启后仍命中持久缓存**」（新建网关实例 → `provider.calls === 0`，直接证明"重复付费"已修）、`cache: false` **既不读也不写**、TTL 到期重新调用、作用域隔离。**待做**：`serve.ts` 注入 `DbLlmCacheStore`（真实模式）+ 命中率指标 |

### P2 —— 需要外部条件（无法在本环境闭环）

| # | 缺口 | 缺什么 |
|---|---|---|
| P2-1 | 容器化真跑（`docker build` + `compose up` + 卷持久化） | **本环境无 Docker**；已有静态 11/11 + Runbook |
| P2-2 | 小时级长跑（无缓慢泄漏） | 需数小时时间窗口（当前仅 25 分钟） |

---

## 3. 本轮的改动记录

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/core/checkin.ts` | 新增 | `CheckinEntitlementStore` 接口 + 内存实现（幂等语义集中在此） |
| `src/db/checkin-adapter.ts` | 新增 | PG 实现；幂等由 `ON CONFLICT` 承担，`revoke` 用 `WHERE revoked_at IS NULL` 天然幂等 |
| `src/app/storage.ts` | 改 | `StorageBundle.checkins`（两种模式各自装配） |
| `tools/serve.ts` | 改 | `checkin:grant` / `checkin:revoke` 从内存 Map 改为 `storage.checkins`；`knownActions` 补 `checkin:revoke` |
| `test/checkin-entitlement.test.ts` | 新增 | 内存 + **真实 pglite** 双实现，断言全部围绕**幂等与持久语义**（重启后仍在的唯一有效测试） |
| `tools/serve.ts` | 改 | **P0-5 前半**：渠道连接信息只解析一处（`newApiConfig` / `providerTransport`）；新增 `writeBackGroup`；`set_group` 在配置了渠道时**真的写回下游**，真实模式未配置渠道时 **fail-closed 抛错**（此前一律静默写内存） |
| `tools/ci-gate.ts` | 改 | 第 8 项白名单补 `src/db/checkin-adapter.ts`（与 `kv-adapter` 同性质：由调用方保证事务内） |

### ★ 本轮踩到并修好的一条门禁（值得记）

CI 第 8 项（单一事务入口）**第一次就抓到了我的新适配器**：

```
[FAIL] 8. 单一事务入口（禁事务外驱动查询）
        src/db/checkin-adapter.ts:125 驱动查询出现在 withTransaction 之外
```

处理方式不是"把文件加进白名单了事"，而是三件事一起做：
1. 加白名单（与 `kv-adapter` / `adapters.ts` 同性质：由调用方保证事务内）；
2. ★ **在注释里写明白名单的依据**（运行时由 `Db.query()` 的 `assertInTransaction` 兜底）；
3. ★★ **加一条测试把那个依据变成可执行事实**——`test/checkin-entitlement.test.ts` 的第 3 条：
   绕开工厂包装直接调用 → 必须抛 `/事务外执行/`。

> 这与本仓库的中心教训一致：**「声称」必须配一条能失败的检查**。
> 白名单是声称，那条测试是检查。
