# 未引用模块分类（15 项）—— 目标 (2)

> **方法**：对每个模块看**用途声明**（文件头）+ **导出符号在生产代码里的引用数**（排除模块自身与审计工具）。
>
> **分类**：
> - **A · 真的未接线** = 能力已实现、被测试覆盖，但服务里没有调用路径 → **是缺口**；
> - **B · 可选能力** = 设计上按部署/开关启用；
> - **C · 库 / UI 侧** = 给外部使用，或属前端编辑能力（服务端不需要接线）；
> - **误报** = 工具只认静态 `import`，看不见**动态 `import()`** 的接线。

## 一、逐项结果

| # | 模块 | 用途 | 分类 | 判定 |
|---|---|---|---|---|
| 1 | `src/core/cross-site.ts` | 跨站点访问判定 | **误报** | ✅ 已接线（`admin/api.ts` 里 `await import()`） |
| 2 | `src/plugin/schema-compat.ts` | 插件升级兼容检查 | **误报** | ✅ 已接线（同上） |
| 3 | `src/policy/branches.ts` | 有序分支求值器（M3-1） | **C（重复实现）** | ⚠️ `evaluator.ts:128-151` **内联实现了**同样的求值 → 本模块多余。★ **但两套逻辑并存有漂移风险** |
| 4 | `src/policy/planning.ts` | 依赖规划 / 渠道推断（M3-11/12/13） | **C（被替代）** | `collectFactRefs`（`policy/model.ts`）+ `validatePolicy` 已覆盖其核心；9 个导出**零外部引用** |
| 5 | `src/policy/rollout.ts` | 灰度发布 + 一键熔断（M6-3） | **A（部分）** | 分桶被 `inRollout`（`core/policy-assignments.ts`，Round 6 实现）替代；★ **`abortRollout`（一键熔断）未实现** |
| 6 | `src/policy/action-addressing.ts` | 动作参数里的统一寻址（M3-5） | **A（真未接线）** | ★ 3 个导出（`resolveActionTargets` / `TARGET_PARAM_KEYS` / `looksAddressLike`）**零外部引用** —— 动作参数里的寻址**没有实现** |
| 7 | `src/admin/audit-scope.ts` | 全局审计与可见性（M7-9） | **A？** | 待核实（审计可见性是否生产能力） |
| 8 | `src/core/rollback.ts` | 回滚编排（M6-2） | **A？** | 待核实（回滚 API/UI） |
| 9 | `src/db/advisory-lock.ts` | PG 咨询锁（驱动层） | **A？** | 待核实（多实例互斥——**多实例部署必需**？） |
| 10 | `src/db/oauth-store-adapter.ts` | 本平台作 IdP 的 PG 适配器 | **A？** | 待核实（OAuth IdP 能力是否启用） |
| 11 | `src/plugin/builtin/bot-bridge.ts` | `bot-bridge` **参考实现**（M4-16） | **B** | 参考实现：按需安装的内置插件，不是"服务必须调用" |
| 12 | `src/plugin/renderers.ts` | 宿主内置 UI 渲染器（M4-9） | **C** | UI 侧能力（服务端只提供契约） |
| 13 | `src/policy/authoring.ts` | 三形态策略编写（M6-10） | **C** | 编辑侧（前端/编辑器用） |
| 14 | `src/policy/editor.ts` | 表达式编辑器三视图（M3-8/9） | **C** | 编辑侧 |
| 15 | `src/verify/confirm-page.ts` | 用户确认页（M5-4） | **C** | UI 侧 |

**汇总**：**误报 2 · C 类 6 · B 类 1 · A 类（含待核）6**。

## 二、A 类里已经查清的（本轮实测）

### A-1 · `action-addressing.ts` —— 动作参数的寻址**没有实现**

- **它该做什么**：动作参数里也可能指向"某个具体对象"，如 `{ target: 'subject:<provider>.<attr>' }`。
- **现状**：`resolveActionTargets` / `TARGET_PARAM_KEYS` / `looksAddressLike` **零外部引用**。
- **后果**：策略的 `actions[].params` 里写寻址表达式**不会被解析**——要么原样传给下游（下游看不懂），要么静默当成普通字符串。
- **处置建议**：**接线**（动作执行器在提交参数前调用 `resolveActionTargets`），或**在 `docs/04 §1.5` 显式标注"动作参数暂不支持寻址"**。

### A-2 · `rollout.ts` —— 分桶被替代，**熔断缺失**

- **分桶**：`bucketOf(userId, rolloutId)` 与 Round 6 的 `inRollout`（`sha256(policyId:userId) % 100`）**功能重复**，后者已接线且带"跨策略分桶独立"的测试。
- **熔断**：`abortRollout(config, { by, reason, at })` —— **一键熔断**（把灰度整体切回旧侧）。**没有任何实现**。
- **处置建议**：分桶**删掉重复实现**（或让 `inRollout` 复用它的算法）；熔断要么实现，要么在 `docs/05 §6.3.1` 标注"未实现"。

### A-3 · `branches.ts` —— 不是"缺能力"，是"**两套实现**"

- 求值路径**认** `branches`：`evaluator.ts:128-151` 自己实现了"首个 satisfied 命中即停"。
- **所以功能在**（策略的分支形态能用）—— 但 `branches.ts` 是**第二套**。
- **风险**：两套逻辑对"全不命中 → `defaultOutcome`"等边界的处理若不一致，会出现"编辑器预览与运行期结论不同"（**本仓库最贵的一类缺陷**）。
- **处置建议**：**留一套**（推荐把 `branches.ts` 变成 `evaluator.ts` 调用的唯一实现，或删掉它并注明）。

## 三、4 项已核实（Round 5–6）

| 模块 | 核实结论 | 处置 |
|---|---|---|
| `advisory-lock`（PG 咨询锁） | ✅ **C · 被替代**：`patrol-service.ts` 用**调度器租约**（真实 PG 上"条件更新 + RETURNING 原子抢锁"）实现跨实例单飞。★ 我原本最担心的"**多实例下每个实例都跑一遍巡检、动作重复下发**"**不存在** | 保留（另一种可选实现）或删除 |
| `rollback`（回滚编排） | ✅ **已接线**：`admin/api.ts:1926` 的回滚端点调用 `rollbackForSubject` / `rollbackByPolicy`。★ 但 `patrol-service.ts:134` 留着"**一直未接线**"的**过时注释** —— **本轮已更正** | 完成 |
| **`oauth-store-adapter`** | ★★ **A · 真未接线**（与 P0-2 `AlertSilenceStore` **完全同型**）：`serve.ts` **无条件**用 `InMemoryOAuthStore` → **重启丢失全部客户端注册与授权码**。★ 修的时候撞上更根上的问题：内存实现叫 `registerClient`（**同步**）、PG 实现叫 `saveClient`（**异步**）—— **两个名字、两种时序**，装配层无法直接替换 | ✅ **本轮已修**：把 `saveClient` 提到 `OAuthStore` 接口上（`registerClient` 保留为**同义**同步别名）；`serve.ts` 改为 `db === undefined ? InMemory : createTransactionalOAuthStore(db)` |
| **`audit-scope`**（审计可见性） | ★★ **A · 真未接线，且是安全性质**：`canSeeAudit` / `auditVisibilityOf` **零引用**；进一步核实发现 **审计查询功能本身不存在** —— `/api/admin/audit` 端点没有、`AuditSink` **只有 `record`（写入）没有读取接口** | ⏳ **待决**，见 §四 |

## 四、`audit-scope` 的处置（需决策）

**发现**：**审计只写不读** —— `AuditSink.record(...)` 在很多地方被调用（本会话我也一直在写审计），
但**没有任何读取/查询审计的代码**。

**后果**：审计是「**排障与追责**」的依据（`audit-scope.ts` 文件头原话），
"只写不读"意味着**出了事答不出"谁在什么时候做了什么"** —— 数据躺在库里，没人能查。

**两条路**：
1. **实现审计查询**：给 `AuditSink` 加读取接口（读审计表）+ `GET /api/admin/audit` 端点 +
   用 `audit-scope` 做可见性过滤 —— **推荐**，因为它与"可上生产"直接相关，
   且 `audit-scope` 的实现**已经就绪、只差接线**；它解决的正是"跨租户信息泄露"这类最敏感的问题；
2. **登记为已知限制**：在 `DELIVERY-CONTRACT` 写明"审计只写不读，排障需直接查库"。

★ 暂按**第 1 条**排期（下一轮或目标 (4) 之后）。

