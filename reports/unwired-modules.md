# 未接线清单（模块级）

> ## ⚠️ 更新（本会话重新核实）—— **请先读这一节**
>
> **数字变了**：未引用模块 **26 → 19**（本会话新接了几个，也新建了几个）。
> **更重要的是：分类结果变了**，并且**发现了两个真实的"沉默缺失"**。
>
> ### 一、★ 工具**盲区**（已接线，但工具不认）
>
> `tools/module-wiring.ts` 只认**静态** `import ... from '<模块>.ts'`，
> 因此**动态 import 的接线它看不见**：
>
> | 模块 | 真实状态 |
> |---|---|
> | `src/core/cross-site.ts` | ✅ **已接线**：`admin/api.ts` 的 `GET /api/admin/policy-assignments/cross-site` 里 `await import('../core/cross-site.ts')`（判定 + 403 + 审计）；`test/cross-site-admin.test.ts` **4/4** |
> | `src/plugin/schema-compat.ts` | ✅ **已接线**：`POST /api/admin/plugins/install` 里 `await import('../plugin/schema-compat.ts')`（升级兼容检查）；`test/schema-compat.test.ts` **13/13** |
>
> ★ 这两条**不是缺陷，是工具的盲区**——盲区本身值得记下来，否则下次还会被误报。
>
> ### 二、★★ 真实的"实现了但没接线"（**这正是要消除的沉默缺失**）
>
> | 模块 | 现状 | 缺什么 |
> |---|---|---|
> | `src/db/email-rule-adapter.ts` | 存储 + 判定已实现（`test/email-rules.test.ts` **11/11**） | **准入路径未接**：没有注册/登录路径调用 `decideEmailAdmission()` |
> | `src/db/invite-code-adapter.ts` | 存储 + **原子核销**已实现（`test/invite-codes.test.ts` **8/8**） | **核销路径未接**：没有端点或注册流程调用 `redeem()` |
>
> ★ 这两项是**本会话实现的**（P0-3）。**存储层完成 ≠ 能力可用**——
>   按本文件自己的定义（A 类 = "能力已实现、被测试覆盖，但服务里没有调用路径"），
>   它们**正是 A 类**。所以必须在这里显式登记，**不能因为"测试全绿"就当作完成**。
>
> ### 三、A 类（真的未接线，按交付影响排序）
>
> | 模块 | 影响 | 处置 |
> |---|---|---|
> | `src/plugin/llm-gateway.ts` | 插件可**绕过 LLM 配额** | 条件装配（有 `AG_LLM_*` 凭据时启用 + 注入 `DbLlmCacheStore`） |
> | `src/db/email-rule-adapter.ts` · `src/db/invite-code-adapter.ts` | 见上（P0-3 的存储已就绪，使用路径缺失） | 接到准入 / 核销路径 |
> | `src/plugin/package-cache.ts` | 外置插件**启动时不按 digest 拉回** | 接到启动路径 |
> | `src/db/oauth-store-adapter.ts` | OAuth 状态可能重启即丢（若路由仍用内存实现） | **需核实** |
> | `src/db/advisory-lock.ts` | 多实例互斥（若调度器已用别的机制则不需要） | **需核实** |
> | `src/admin/audit-scope.ts` | 审计范围过滤 | **需核实** |
> | `src/core/rollback.ts` · `src/policy/{rollout,planning,branches,editor,authoring,action-addressing}.ts` | 策略编辑 / 规划 / 灰度 / 分支 | **需逐项核实**——部分可能是 UI 侧能力，服务端**不需要**接线 |
> | `src/verify/confirm-page.ts` | 协同验证确认页 | **需核实**（可能是 UI） |
>
> ### 四、仍然有效的结论
>
> 本文件原来的判断**依然成立**：本工具**刻意不作为 CI 门禁**——
> 判失败会逼人去"**消数字**"（删模块或加假引用），而不是去判断哪些能力真的该接。
> 上面 §三 里标着"**需核实**"的项，正是需要**判断**而不是需要"清零"的部分。

---

> **生成方式**：扫描 `src/**/*.ts`，检查每个模块是否被**任何生产文件**（`src/` 与 `tools/`，
> 排除 `test/`）通过 `import ... from '<模块名>.ts'` 引用。
>
> ```
> src/ 模块总数：119
> ★ 未被任何生产文件引用的模块：26
> ```
>
> ★★ 本会话此前一直在修「**路由未挂载**」（`route-coverage`）与「**store 未装配**」
> （`impl-pairing`），但**模块级**的未引用**从未被检查**。
> 这是「路线图 90/90」与「服务里真的用了这些能力」之间**最大的缝**。

---

## 一、先分清「三类」——不能一刀切说全是缺陷

| 类型 | 含义 | 是否缺陷 |
|---|---|---|
| **A. 真的未接线** | 能力已实现、被测试覆盖，但服务里没有任何调用路径 | ★ **是** |
| **B. 可选能力** | 设计上按部署/开关启用（如容器运行时、进程运行时） | 否（但应说明如何启用） |
| **C. 库/工具** | 提供给外部使用（如协同验证 SDK），本服务不调用 | 否 |

★ 下面逐条判断。★★ 判断依据是**模块的注释与它的对外角色**，不是我的猜测。

---

## 二、A 类：真的未接线（**应优先修**）

| 模块 | 能力 | 为什么是缺陷 |
|---|---|---|
| `core/reconciler.ts` | 对账 / 渠道同步引擎 | `docs/05` 声明它是核心机制；服务里没有任何调用 → **对账不会发生** |
| `core/rollback.ts` | 回滚 | 目标第 4 项点名「回滚」；管理端点有 `/policies/:code/rollback`，但**引擎未接** |
| `plugin/governance.ts` | 权限治理（声明≠授予的判定） | 我实现 `/admin/plugins/:id/grants` 时**重新写了一套**判定——★ 本就该用它 |
| `plugin/endpoints.ts` | 端点注册 / 冲突检测 | 我实现 `endpoint-store.ts` 时**重新写了一套**——同上 |
| `plugin/llm-gateway.ts` | LLM 网关（配额 / 缓存 / 计费） | 插件用 LLM 的唯一合规出口；未接 → **插件可绕过配额直连模型** |
| `policy/planning.ts` | 策略依赖规划 | 发布策略前应检查依赖；未接 → **可发布出依赖缺失的策略** |
| `policy/rollout.ts` | 灰度发布 | `ag_policy_assignments.rollout_percent` 是为它准备的；未接 → **灰度不可用** |
| `policy/branches.ts` | 策略分支 | 同上 |
| `policy/editor.ts` · `authoring.ts` | 策略编辑器 / 创作 | 管理端「策略编辑」相关端点会用到 |
| `policy/action-addressing.ts` | 动作寻址（重跑某次动作） | 目标第 4 项提到「重跑 / 重试」 |
| `plugin/declarative-runner.ts` | 声明式插件执行器 | ★ **内置插件（email/checkin）本该由它执行** |
| `plugin/renderers.ts` | 策略结果渲染 | 前端展示需要 |
| `verify/confirm-page.ts` | 设备码确认页 | 设备码流程**缺了用户确认页** → 流程不完整 |
| `db/outbox-adapters.ts` | **PG outbox 适配器** | 事件外发在真实模式下**落不了库** |
| `db/advisory-lock.ts` | 咨询锁 | 定时任务在多实例下需要它做互斥 |
| `admin/audit-scope.ts` | 审计范围过滤 | 审计查询应受站点范围约束 |

## 三、B 类：可选能力（应说明**如何启用**）

| 模块 | 说明 |
|---|---|
| `plugin/process-runtime.ts` | 插件以**独立进程**运行（隔离性更好）——按部署选择 |
| `plugin/declarative-webhook.ts` | 声明式插件的 webhook 模式 |
| `plugin/storage-tiers.ts` | 存储分层（热/冷）——按规模启用 |
| `plugin/builtin/bot-bridge.ts` · `newapi-actions.ts` · `newapi-provider.ts` | **内置插件**：它们的 manifest 在 `builtin/features.ts` 里被引用，但**运行逻辑**没有被装配 → ★ 与 R65 的 `HostApi` 是同一类问题 |

★ 尤其是最后一行：**内置插件的「声明」被用到（策略校验能看到它们），
而「执行」没有** → 与 `HostApi` 未装配是同一个根因。

## 四、C 类：库 / 工具（本服务不调用是**正确的**）

| 模块 | 说明 |
|---|---|
| `verify/sdk.ts` | 协同验证 SDK——**给调用方（外部）用的**，本服务只提供接口 |
| `kernel/di.ts` | 依赖注入工具——可能被外部装配器使用，或已废弃 |
| `plugin/host-factory.ts` | ★ **R66 新增**，装配器本身需要被 `serve.ts` 引用（下一步） |

---

## 五、这一发现意味着什么

★★★ **「路线图 90/90」衡量的是「设计与实现」，「生产可用」衡量的是「接好线的能力」。**

本会话建立了三层「有但没用」的检查：

| 层级 | 工具 | 发现过 |
|---|---|---|
| **路由级** | `route-coverage` | 3 条路由未挂载（含回滚） |
| **装配级** | `impl-pairing` | `HostApi` 未装配 |
| **模块级** | ★ **本文件**（尚未工具化） | **26 个模块未被引用** |

★ 三层都指向同一个模式：**「实现存在」不等于「服务里能用」**。

---

## 五之二、★★ 逐条排查后：**接线需要什么条件**（R68 起的实测结论）

★ 只列「未引用」不够——每一条**接线所需的前置条件**才是可执行的结论。

| 模块 | 接线点 | 前置条件 | 结论 |
|---|---|---|---|
| `plugin/governance.ts` | `enable` 端点 | **无** | ✅ **已接**（R68）—— 改为调 `canEnable()`，消除重复判定 |
| `plugin/endpoints.ts` | 端点注册 | **无** | ✅ **已接**（R68）—— 改为调 `inspectPath(mountPath)` |
| `plugin/host-factory.ts` | 插件运行时 | ★ **运行时编排**（何时调用插件） | 已可装配（R66）；**编排未接** |
| `policy/planning.ts` | 策略发布前校验 | ★ **需要扩展 `PluginRegistry`**：要 `namespaces`/`kind` 才能构造 `PluginDescriptor` | 接口变更，需设计 |
| `core/rollback.ts` | `rollback` 端点 | ★ **需要提取 `buildPatrol`**（`PatrolService` 未暴露它） | 中等重构 |
| `db/outbox-adapters.ts` | 事件外发 | ★ **需要编排**：谁产生事件、谁投递（`OutboxStore` 全项目无人用） | 需设计 |
| `core/reconciler.ts` | 渠道对账 | ★ 同上（对账循环未接） | 需设计 |
| `db/advisory-lock.ts` | 多实例互斥 | 需要接入调度器/巡检的互斥逻辑 | 需设计 |

★★ **规律**：**「接线点明确」的已经接完了**（R68 的两个）；
剩下的都需要**先做设计或接口变更**，而不是「加一行注入」。

★ 这解释了为什么 `unwired-modules.md` 里的 A 类有 16 条，却只有 2 条能立刻修——
**「未接线」的修复成本差异极大**，从「改一行」到「设计一套编排」。

### ★★ 顺带发现：`core/rollback.ts` 的**三种形态只做了一种**

```
| 形态 | 语义 | 状态 |
|---|---|---|
| 单条 | 切版本（仅切，不重算） | ✅ 已由 PolicyStore.rollback 提供（我的端点用了它） |
| 按主体 | 切版本 + 只对一个主体重新求值 | ★ rollbackForSubject 未接线 |
| 按策略批量 | 切版本 + 对该站点所有主体分批重新求值 | ★ rollbackByPolicy 未接线 |
```

★ 而这**正是目标第 4 项点名的**「回滚（单条 / 按主体 / 按策略批量）」——
即：**目标声称达成的能力，实际只做了三分之一**。

---

## 六、建议的修复顺序

★ 按「对生产可用的影响」排序：

1. **`db/outbox-adapters.ts`** —— 事件外发落库（基础设施，影响面广）；
2. **`plugin/governance.ts` + `plugin/endpoints.ts`** —— ★ 我已**重写了两套**等价逻辑，
   应改用它们（否则**两套判定会漂移**）；
3. **`core/reconciler.ts`** —— 对账不发生 = 主体数据会漂移；
4. **`plugin/declarative-runner.ts` + `builtin/*`** —— 内置插件真正能执行（与 `HostApi` 同一根因）；
5. **`policy/planning.ts` / `rollout.ts` / `branches.ts`** —— 策略发布的前置校验与灰度；
6. **`core/rollback.ts`** —— 目标点名的能力；
7. **`plugin/llm-gateway.ts`** —— 防插件绕过 LLM 配额；
8. 其余（A 类剩余 + B 类说明）。

★ 并在 CI 里加一项**模块级未引用检查**（本文件已给出实现思路）——
否则这一类缺口无法被持续发现。
