# 交付就绪评估（DELIVERY-READINESS）

> **结论：尚不可交付。** 但差距是**具体且可枚举**的（见 §三），且**全部有对应的可执行验收命令**。
>
> ★ 本文件**取代** `production-readiness.md`（Sep 25 版）：后者声称的 8 条缺口**其中 1–4 已全部修复**，
> 而它没有覆盖本文件 §三 的 P0-1（跨系统寻址未接）——那是在它之后才核实出来的。
>
> ★ 生成方式：**逐条实测**（`impl-pairing` / `module-wiring` / `table-coverage` / `verify-tables` / `db:check` / `npm test` / `npm run ci` / `npm run verify:all`），
> 不采信任何文档的既有结论。

---

## 一、已具备的交付能力（有真实运行证据）

| 能力 | 证据 | 一键命令 |
|---|---|---|
| 真实 PG 启动 + 完整主线（登录 → 两级选择 → 控制台 → 资格） | `verify:all` 内的 `serve-real-e2e` **通过** | `npm run verify:all` |
| 07 §5 **场景 A**（edu 升级 + 签到到账，真实 HTTP 下游） | `test/scenario-a.test.ts` 通过 | `npm run verify:scenario-a` |
| 单测 + 集成 | **1243 / 1243 · 0 跳过** | `npm test` |
| 完整门禁 | **13 / 13 PASS**（tsc · 单测 · DDL 快照 · db:check · site_id · 裸 SQL · 系统名 · 事务入口 · 安全 · 真实 PG · 路由一致性 · 性能 · 宿主无知） | `npm run ci` |
| 结构门禁 R1–R6 | **0 error**（2 warn，见 §三 P1-7） | `node --experimental-strip-types tools/verify-tables.ts` |
| Schema 漂移 | **门禁 0 / 漂移 0**（47 表 · 47 枚举 · 96 索引 · 235 条 DDL） | `npm run db:check` |
| 性能 | 管理读 **≥500 QPS** · 10 万主体全量评估（CI 第 12 项） | `npm run ci` |
| 长跑（短时） | 2 分钟 · 50 QPS · **5520 请求 0 失败** · RSS 后半段 +6.6MB | `npm run verify:all` |
| 巡检存活 | **5 / 5** | `npm run verify:all` |
| 备份/恢复演练 | `tools/backup-restore.ts` 已就绪 | `npm run backup` |
| 安全自查 | 12 项（CI 第 9 项） | `npm run security` |

---

## 二、旧报告（`production-readiness.md` Sep 25）声称的 8 条缺口 —— 逐条实测

| # | 旧结论 | **实测（本轮）** | 证据 |
|---|---|---|---|
| 1 | 开发者入驻流程是断的（`recordDeveloperIdentity` 无调用点） | ✅ **已修** | `tools/serve.ts` 中 4 处引用（含真实调用） |
| 2 | 平台级事实写不进 PG | ✅ **已修**（方案 A：开发者也是平台用户） | `ensureDeveloperUser` 5 处 |
| 3 | 事件外发落不了库（outbox 无人使用） | ✅ **已修** | `createTransactionalOutboxStore` 已装配 |
| 4 | 对账不发生（`reconciler` 无调用） | ✅ **已修** | `reconciler.reconcile()` 已在调度循环 |
| 5 | 4 个 store 只有内存实现 | 🟡 **降到 1 个真实项**：`AlertSilenceStore`（`RuntimeCache` 疑似刻意；`VerifyClientStore` 是工具误判——实际有 `DbVerifyClientLookup`） | `tools/impl-pairing.ts` |
| 6 | 23 个模块未接线 | 🟡 **仍 23 个**，但性质变了：5 个"刻意不接"、18 个待判断（含本会话新建的 4 个，见 §三 P1-4/5） | `tools/module-wiring.ts` |
| 7 | 容器化未验证 | ❌ **仍未**（本机无 Docker） | 见 §三 P2-1 |
| 8 | 长跑仅 25 分钟 | 🟡 **有工具**（`soak`），本次跑 2 分钟；**小时级仍需外部窗口** | 见 §三 P2-2 |

---

## 三、剩余缺口（按**交付阻断程度**排序）

### P0 —— ✅ **已全部关闭**（下表保留**关闭前**的描述以便对照）

| # | 缺口 | 关闭方式与证据 |
|---|---|---|
| **P0-1** | `subject:*` 跨系统寻址在求值层未实现 | **求值层**（`expr.ts` 认 `subject:` / `subject.`，冒号形式必须在通用点切分之前）+ **快照层**（`subject-snapshot.ts`：绑定 → externalId → 下游属性，五种失败原因各自可排障）+ **serve 真实接线**（`/api/me/eligibility`，只在策略真的用到 `subject:*` 时才解析）；`test/subject-addressing*.test.ts` **15/15** |
| **P0-2** | `AlertSilenceStore` 只有内存实现 | `DbAlertSilenceStore`（平台设置承载；**Date 往返**——否则期限比较退化成字符串比较 / 同码覆盖 / 坏记录只丢一条）+ 装配；`test/alert-silence-adapter.test.ts` **7/7** |
| **P0-3** | 三张零读写表 | `ag_email_rules`（准入闸门，**白名单模式默认拒绝**）· `ag_invite_codes`（**原子核销**——单条 `UPDATE … RETURNING`，并发不超发）· `ag_policy_assignments`（**确定性灰度**——`hash(policyId+userId)`，含 policyId 以免多实验互相污染）全部实现；**33/33** |

★ **附带完成**：**`crossSite` 接线**（目标点名的项）—— `ag_policy_assignments` 落地后，
"管理员查看全站点灰度分配"成了它的**第一个真实消费方**；被拒返回 **403**（不是 500、不是空列表）并写审计。

#### 关闭前的原始描述（保留以便对照）

### 原始：P0 —— 阻断交付（必须处理）

| # | 缺口 | 为什么阻断 | 位置 |
|---|---|---|---|
| **P0-1** | ★★ **`subject:*` 跨系统寻址在求值层未实现** | `docs/04 §1.2.7`（D4 统一寻址）与 `03 §1.16.3`（"表达式里统一写 `subject.group`"）**都声明了它**，但 `OperandRef.kind` 只有 `fact \| user \| binding \| literal`——**没有 `subject`**；`resolveBinding()`（`policy/addressing.ts:388`）**没有任何生产调用方**。后果：**跨系统策略（如"new-api 分组 与 Discord 角色"联合判定）写不出来**，而这正是"通用信任引擎"相对"new-api 附属工具"的核心区别 | `src/policy/addressing.ts` · `src/policy/expr.ts` · 求值路径 |
| **P0-2** | `AlertSilenceStore` 只有内存实现 | 真实模式重启后静默全部失效。★ 方向**安全**（静默失效 → 告警重现，不会漏告警），但既然 `ag_platform_settings` 之类都落库了，这一项不应例外 | `src/core/alert-silence.ts` |
| **P0-3** | 三张零读写表：`ag_email_rules` / `ag_invite_codes` / `ag_policy_assignments` | 已逐表判断为**"未实现"而非"被替代"**（`email-domain` 插件的 `allowDomains` 是采集事实用，与注册准入闸门不同）。**沉默本身才是问题**——要么实现，要么在 `docs/02` 显式标注为前瞻 | `docs/02` · 对应实现 |

### P1 —— 可带风险交付，但必须登记（已在 `GO-LIVE-TODO.md` 登记）

| # | 缺口 | 现状 |
|---|---|---|
| P1-4 | **`LlmGateway` 未装配**（serve.ts 里完全没有它） | `DbLlmCacheStore`（Round 27）与网关的缓存注入**都已就绪**，但网关本身需要 LLM 服务凭据 → 应做成**条件装配**（有 `AG_LLM_*` 时才启用），与 `AG_NEWAPI_*` 同一模式 |
| P1-5 | `DbPluginBindingStore` / `crossSite` / `package-cache` **无生产消费方** | 三者都是"接口与实现就绪、缺调用点"。`package-cache` 的调用点是"启动时按 digest 拉回"；另两者的调用点取决于 P0-1 是否实现 |
| P1-6 | 18 个未引用模块 | 5 个刻意不接（附理由）、13 个待判断（`rollback` / `branches` / `planning` / `rollout` / `editor` / `authoring` / `renderers` / `bot-bridge` / `advisory-lock` / `oauth-store-adapter` / `audit-scope` / `action-addressing` / `confirm-page`） |
| P1-7 | `ag_plugin_instances` 的 **2 条 R6 warn** | 可空唯一键 → PG 唯一约束静默失效。正确修法需要 `onConflict` 支持谓词，或按 `docs/11 §14.1` 改用 `ownerScope`+`ownerId` 双列 |

### P2 —— 需要外部环境（本环境**无法闭环**，但脚本已就绪）

| # | 缺口 | 需要什么 | 已就绪的部分 |
|---|---|---|---|
| P2-1 | 容器化真跑（`docker build` + `compose up` + 卷持久化） | **一台有 Docker 的机器** | `Dockerfile` · `docker-compose.yml` · `tools/docker-preflight.ts`（静态 11/11）· `reports/containerization-runbook.md` |
| P2-2 | 小时级长跑（证明无缓慢泄漏） | **数小时的时间窗口** | `tools/soak.ts --minutes=N --load=M`（本次 2 分钟 5/5 通过；工具自己声明"不足以证明生产稳定"） |

---

## 四、一键验收命令

| 命令 | 覆盖 | 期望 |
|---|---|---|
| `npm test` | 单测 + 集成（1243 项） | 全绿 · 0 跳过 |
| `npm run ci` | 13 项门禁 | 全 PASS |
| `npm run verify:scenario-a` | 07 §5 场景 A（真实 HTTP 下游） | 通过 |
| `npm run verify:all` | 场景 A → 真实 PG e2e → path-probe → 巡检存活 → 短长跑 | 退出码 0 |
| `npm run db:check` | Schema 门禁 + 漂移 | 门禁 0 / 漂移 0 |
| `node --experimental-strip-types tools/verify-tables.ts` | 结构自检 + R1–R6 | 0 error |
| `npm run security` | 安全自查 12 项 | 无高危 |
| `npm run backup` | 备份/恢复演练 | 通过 |
| `node --experimental-strip-types tools/docker-preflight.ts` | 容器化静态检查 | 11/11（★ 5 项显式标注无法验证） |

---

## 五、外部依赖清单（交付前需要接收方提供）

| 依赖 | 用途 | 缺了会怎样 |
|---|---|---|
| **Docker 环境** | P2-1 容器化真跑 | 交付方式未验证（功能不受影响） |
| **数小时时间窗口** | P2-2 小时级长跑 | 无法证明无缓慢泄漏 |
| **真实 new-api 实例 + 管理员 PAT** | 真实对接（3 天 Spike 的后半） | 对账/写回只能在假上游上验证 |
| **LLM 服务凭据**（OpenAI 兼容） | P1-4 装配 LLM 网关 | LLM 评审类插件不可用 |
| **AG_MASTER_KEY**（32 字节） | 真实模式启动 | **启动即失败**（这是有意的 fail-closed） |
| **OIDC 提供方**（issuer/clientId/redirectUri） | 真实登录 | 真实模式无可用登录方式 |

---

## 六、交付前必须完成的最小清单

1. **P0-1**：实现 `subject:*` 的求值（接 `resolveBinding` + provider 属性）**或**在 `docs/04` 显式标注"未实现，当前用 `fact.*`"——**二选一，不能沉默**。
2. **P0-2**：`AlertSilenceStore` 的 PG 适配器 + 装配。
3. **P0-3**：三张表——实现或显式标注。
4. **P1-4**：`LlmGateway` 条件装配（有凭据才启用）+ 注入 `DbLlmCacheStore`。
5. **P1-5**：`package-cache` 的启动拉回接线；另两者随 P0-1 一起决。
6. **文档**：`docs/` 与 `reports/` 中所有与上述相关的结论同步（本文件 §二 已纠正旧报告）。
