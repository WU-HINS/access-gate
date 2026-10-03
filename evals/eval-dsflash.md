# access-gate 全量架构评估推演 · 评估方 `deepseek-v4.1-flash`

> 实读范围：`docs/` 全部 13 份（README · 01–11 · CHANGELOG，共 9997 行）。
> 本评估优先给出**前九代 + 四场辩论未覆盖**的问题；已覆盖但修复不彻底的逐条注明。

---

## 第一部分 · 架构成熟度评分

| 维度 | 分 | 评分理由 | 支撑证据 | 扣分项 |
|---|---|---|---|---|
| **1 架构自洽性** | **3** | 主干契约确实冻结了（四抽象、寻址语法、状态机、动作规范形），D1–D16 与 D17–D20 都带可核对依据。但同一语义仍有两个权威来源：幂等键公式与 `add_quota` 的"日期桶"、`user.*` 与 `me.*` 两套 root、`platform:gate` 与 `platform:developer/enduser` 两套 ref 全集。这些不是措辞问题——每一处都对应一条可执行差异（键不同、校验不同）。 | 04 §1.2.7.1（root 表）vs 04 §1.2.2/§1.2.3/§1.3（`user.*`）；05 §3.0.1（冻结公式）vs 05 §3.2/§5.3、09 §3.2、07 M2-3（"幂等键含日期"）；03 §1.18.1（`platform:gate`）vs 08 §5.4/§12、09 §2.2（`platform:developer`/`enduser`） | 三代"规格冻结"声称已冻结寻址/标识符族（11 §11.1），实际正文仍并存双写法；D20 要求 04 §1.5.1 重写，11 §14.6 自认"当前仍写 `$required` 直判"，未修 |
| **2 数据模型完备性** | **3** | 三代补了 15 张表 24 个缺失列，覆盖面明显提升；但**门禁规则与表声明至今互不满足**：2 张站点表的唯一键首列不是 `siteId`，2 张表逃出两张白名单，`ag_sessions` 的 3 个列仍只在"变更说明表"里而不在表声明里。也就是说"白名单驱动门禁"仍然会在真跑时失败——而这正是第 5 代 N1 的原始罪名。 | 02 §1（站点 12 表：唯一键首列必须 `siteId`）vs 02 §6.3 `t.unique(['idempotencyKey'])`、02 §5.1 `t.unique(['policyId','version'])`；05 §3.0.1（"唯一约束 `(siteId, idempotencyKey)`"）与 02 §6.3 不一致；02 §3.10 声明要给 `ag_sessions` 加 `realm`/`activeDeveloperId`/`activeSiteId`，但 02 §3.3 的 `ag_sessions` 声明中没有这三列，而 08 §5.4/§7 却直接引用 `ag_sessions.realm` 与 `session.activeSiteId`；02 §3.8 `ag_plugin_instances`、02 §7.2 `ag_provider_sync_state` 均不在 02 §1 的两张白名单内 | 白名单漏表 → 这两张表无需任何作用域列即可通过门禁；`ag_plugin_instances` 用**可空** `developerId`/`siteId` 做唯一键（即 11 §3 自己点名的"NULL 互不相同 → 约束静默失效"陷阱），且无 CHECK 约束保证"scope=site 时 siteId 非空"；`ag_provider_sync_state` 主键仍为 `provider`，S2（10 §13）要求的 `(siteId, provider)` 未落地 |
| **3 安全与隔离** | **2** | D17 把 RLS 推迟后，能力层表的隔离**唯一地**交给 `ownerScope`+`ownerId` 双列（11 §14.1 自述），而这张双列白名单本身漏表：`ag_plugin_instances` 持有 `config`（内含凭据引用、指向哪个下游）却既无 `ownerScope` 也无非空 `siteId`。同时 X12（`redirect` 无白名单、设备码流无限流）、X13（邮箱兜底可接管含 admin 的账号）、X9（主密钥不在备份路径）三项在 11 §4 标"⏳ 待补"后仍无一落地。 | 11 §14.1（"推迟 RLS 后，能力层表的隔离唯一地交给双列"）；02 §1 双列白名单 12 表不含 `ag_plugin_instances`/`ag_provider_sync_state`；11 §4 X9/X12/X13 状态列；03 §1.14（`/api/verify/v1/*` 无限流声明）；08 §5.1 入驻链路 | 隔离从"应用层 + DB 层两道"退化为"一层，且这层有洞"；`ag_plugin_instances.config` 可被非归属开发者读写时，泄露的是**下游地址与凭据名**；邮箱兜底接管（X13）影响面直达 `role=admin` 的开发者账号 |
| **4 可运维性** | **2** | 指标目录、审计分级、告警重复周期、trace 贯通都写了，方向是对的（H1 的后半个修正 05 §2.1.2 是全文质量最高的一节）。但"承诺了新表却没人声明"的模式反复出现：事件不丢所需的 `ag_event_outbox`/`ag_dead_letters`、审计锚点所需的 `ag_audit_anchors`、迁移所需的 `ag_migrations`，在 02 里全部不存在。可运维性的前提是**承载物存在**，否则指标与告警都是对着空气。 | 05 §7.1.2 声称新增 `ag_event_outbox` + `ag_dead_letters`（02 全文无此二表）；CHANGELOG D19 要求 `ag_audit_anchors`（11 §14.2 已确认不存在）；02 §9.2.1 规则引用 `ag_migrations`（10 §4 M4/M5 标注"承载表未声明"）；05 §6.1 任务键 `sync.newapi.full` 与 05 §6.3 全局锁 `job:sync.newapi.full` 未按站点分片（S2/S6 未落地） | `granted` 事件推送失败 → 进不存在的 DLQ → bot 缓存过期 → 用户在下游失去资格而平台侧一切正常（六代已发现，05 补了文字但**未补表**）；D20 的 `throttled` 在 05 §6.4 仍被明文转成 `missing`，无产出路径 |
| **5 可实现性** | **3** | 09 是全套文档里唯一"可照着写代码"的部分：`newapi-provider` 的 `listSubjects`/`toSubject`/`redact`、`newapi-set-group` 的 read-modify-write 回填要点、GitHub 的 declarative manifest 都能直接落键盘。扣分在于三条"写不下去"仍在：declarative `action` 规格缺失、JSON-RPC 方法表（S1–S18）与寻址/标识符规格标"⏳ 待落地"、`ag_sessions` 缺列导致会话与站点上下文无法实现。 | 09 §2.3/§2.4/§3.1/§4.2（可照抄）；11 §11.3（S1–S18、S1–S12 标"待落地"）；11 §14.6（"补一条 declarative action 规格——否则 M1 无动作实现载体"）；11 §8 结构四 | M1-8/M1-9 可实现度可以，但 M2-2 的动作执行器需要一个 `action` 契约；`ag_sessions` 三列缺失使 08 §7 的 `${ctx.scope}` 与两级站点选择器无源可取 |
| **6 工期与范围可信度** | **2** | 07 §7 给了后端/前端分列、累计与出口，格式是可信的；但它与第 9 代 MVP 结论**没有被同步**：07 仍写 M0–M2 = 48 人日、M0–M6 = 118 人日，11 §12.6 则给出 30–34 与 60–70。两套数字并存，且 07 是唯一的排期权威。容量口径同病：02 §10 与 10 §Q6 相差 20–50×（02 §10 自己标注"口径待实测"），X15 未修。 | 07 §7（48 / 118）；11 §12.6（30–34 / 60–70）；02 §10（审计表口径"待实测"）；11 §4 X15；11 §12.6 与 11 §14.1 对"约 12 张表"vs"实需 ≥19 张"的矛盾 | 同一里程碑两套工期使"能不能开工"无法用数字回答；"约 12 张表"的 MVP 清单不足以承载场景 A（签到需 `ag_checkin_records` + `ag_checkin_entitlements` + `ag_actions_log` + `ag_jobs`…） |

**评分汇总**：3 / 3 / 2 / 2 / 3 / 2（均分 2.5）。**全给 3 分等于无信息**，故刻意区分：自洽性与可实现性有实打实的资产（AST + 09），安全与运维则因"推迟 RLS + 表未声明"落在"可用但明显风险"以下。

---

## 第二部分 · 关键问题 Top 10

> 标注 `[新]` = 前九代推演与四组博弈未覆盖（已 grep 回原文核对）；`[残]` = 已覆盖但修复不彻底。

| # | 标题 | 位置 | 现象（具体到规则） | 后果 | 修正建议 | 严重度 |
|---|---|---|---|---|---|---|
| **1** `[新]` | **冻结的幂等键公式杀掉了跨日签到** | 05 §3.0.1 vs 05 §3.2 / §5.3 / 09 §3.2 / 07 M2-3 | §3.0.1 宣布"唯一权威公式（冻结）"：`hash(siteId, userId, policyId, actionSeq, action)`，并明确"**不再依赖时间桶**"；但 §3.2 动作表与 §5.3、09 §3.2、07 M2-3 四处都写 `newapi-add-quota:add_quota` 的"幂等键含日期（同一天只发一次）"。`actionSeq` 只在**状态迁移**时递增（§3.0.1 规则表 + 02 §6.1 `actionSeq`） | 用户连续签到且策略状态稳定在 `granted` 时 `actionSeq` 不变 → 第 2…N 天的 `add_quota` 复用同一 `idempotencyKey`；按 §3.5"重试语义（冻结）"对同一行做 UPDATE 而非插入 → **签到成功、额度不发**，且 05 §5.2.1 ③ 的补偿重发仍撞同一键。真金白银的**持续少发**（方向与二代 X6"重复发"相反） | 二选一并在全文对齐：(a) 幂等键补逻辑日维度，`hash(siteId, userId, policyId, actionSeq, action, logicalDate)`，`logicalDate` 取站点时区（05 §5.1 已有 `timezone`）；(b) 把 `add_quota` 移出 `ag_actions_log` 幂等域，改为以 `ag_checkin_records.(siteId,userId,checkinDate)` 为唯一锚点、`ag_actions_log` 只记流水。建议 (a)，并把"按逻辑日自增 actionSeq"写成 §3.0.1 的第五条规则 | **高** |
| **2** `[新]` | **站点表白名单被自己的表违反** | 02 §1 vs 02 §6.3 / §5.1 | 02 §1 白名单规定：站点作用域 12 表"若有唯一键，其首列必须是 `siteId`"。但 `ag_actions_log`（在白名单内）声明 `t.unique(['idempotencyKey'])`（02 §6.3），`ag_policy_versions`（在白名单内）声明 `t.unique(['policyId','version'])`（02 §5.1）。且 05 §3.0.1 明写"唯一约束 `(siteId, idempotencyKey)`"——与 02 不一致 | 门禁一旦真实执行（第 5 代 N1 的要求），`db:check` 会在这两张表上报错 → 按 02 §9.3 属 `missing_*` 级 → **启动失败**；若门禁不执行，则 `idempotencyKey` 的跨站点唯一性失去保障，同名/同 seq 的两站点动作行相撞 | 把两处唯一键改为 `['siteId','idempotencyKey']` 与 `['siteId','policyId','version']`（后者更稳）；或显式把这两表移出"首列 siteId"规则并在 02 §1 说明理由（不推荐——`ag_actions_log` 的键本就该带站点）。同时补一条**门禁自检**：对白名单表逐条求值谓词，任一失败即 CI 失败 | **高** |
| **3** `[新]` | **两张表逃出全部作用域白名单** | 02 §3.8 / §7.2 vs 02 §1、11 §14.1 | `ag_plugin_instances`（持有 `config`、`scope`、`developerId`/`siteId` 可空）与 `ag_provider_sync_state`（主键 `provider`、无 `siteId`）**既不在站点 12 表**，**也不在能力层 12 表**。前者用可空双列做唯一键（正是 11 §3 点名的 NULL 陷阱）且无 CHECK 保证 scope 与列的非空对应；后者是 S2 要求改成 `(siteId, provider)` 的表，仍是 `provider` 单主键 | D17 推迟 RLS 后，能力层隔离**唯一**依赖 `ownerScope`/`ownerId`（11 §14.1）——这两张表根本不在该机制的覆盖范围内。`ag_plugin_instances.config` 含下游地址与凭据引用名；`ag_provider_sync_state` 含游标与能力探测，跨站点串写会造成对账状态互相覆盖 | 两表均补 `ownerScope`+`ownerId` 非空列并加入白名单；`ag_plugin_instances` 增加 `CHECK`（`scope='site' → siteId IS NOT NULL AND developerId IS NULL`，反之亦然），并把唯一键改为 `(ownerScope, ownerId, pluginId, instanceKey)`；`ag_provider_sync_state` 主键改 `(siteId, provider)` 并进站点表白名单 | **高** |
| **4** `[残]` | **`ag_sessions` 的三个列只在"变更说明"里** | 08 §5.4 / §7、02 §3.10 vs 02 §3.3 | 02 §3.10 的表格明确写"`ag_sessions` 加 `realm` + `activeDeveloperId` + `activeSiteId`"，08 §5.4 表格直接引用 `ag_sessions.realm`，08 §7 的 `ctx.scope` 依赖 `session.activeSiteId`。但 02 §3.3 的 `sessions` 声明里**没有这三个列**。三代（11 §11.2 ①）声称"补齐 15 张表的 24 个缺失列"，此为残留 | 会话无法区分 developer/enduser 域（08 §5.4 的两套 cookie 与 realm 隔离失效）；08 §7 的站点作用域注入无值可取；dev 会话在 standalone→saas 切换后无 `activeSiteId` → 注入抛错（fail-closed）→ **控制台不可用** | 在 02 §3.3 `sessions` 中补 `realm: col.enum('ag_realm',['developer','enduser']).notNull()`、`activeDeveloperId`、`activeSiteId`（后两者可空，登录后写入），并同步 06 §2 的会话响应 | **高** |
| **5** `[新]` | **"宿主无知"门禁有 ≥4 处规范级残留** | 04 §1.2.3、05 §6.1、05 §7.1、06 §5.2.1 vs 03 §1.16.3、07 M6-9 | 03 §1.16.3 的硬性验收是"核心代码 grep `newapi`/`new-api` → 0 命中"，07 M6-9 把它设为 CI 门禁。但核心内置契约里仍有：`user.newapiGroup`（04 §1.2.3 内置用户 schema 字段）、任务键 `sync.newapi.full`/`sync.newapi.head`（05 §6.1）与锁名 `job:sync.newapi.full`（05 §6.3）、指标 `gate_newapi_request_total`（05 §7.1）、`newapiUserId`（06 §5.2.1 会话/详情响应字段，02 §3.1 已用 `primarySubject` 取代它）。11 §8 只点了 `ctx.newapi.*`，而 05 §2.2 已改为 `ctx.providers.forSite()` | M6-9 门禁必然失败；更实质的是 `user.newapiGroup` 把下游分组固化成**平台用户属性**，与 03 §1.16.3"改为 `subject.group`（由 provider 解析）"直接冲突——多 provider 下无法表达"哪个 provider 的 group"，且它不在任何 `subjectSchema` 内，策略静态校验**校验不到它**（04 §1.2.7.5 只校验 `fact`/`subject`/`identity`/`me`） | 删除 `user.newapiGroup`，改为 `subject:newapi.group`（跨系统用 `subject:<provider>.<attr>`）；任务键改 `sync.<provider>.full` 且带 `siteId` 分片；指标改 `gate_provider_request_total{provider,siteId}`；06 响应字段改 `primarySubject: { provider, externalId }`；并把"grep 门禁"扩为**同时扫 `newapi|new-api|github|discord`** 在 `packages/`、`core/` 下的命中 | **高** |
| **6** `[残]` | **事件不丢 / 审计锚点：承诺了表，02 里没有** | 05 §7.1.2、CHANGELOG D19 vs 02 全文 | 05 §7.1.2 以"修正"口吻新增 `ag_event_outbox`（与业务同事务写入）与 `ag_dead_letters`（重试 3 次后落此，06 §5.5 提供重放入口），但 02 全文档没有这两张表的声明；D19 要求的 `ag_audit_anchors` 同样不存在（11 §14.2 已自认）。06 §5.5 的任务/审计清单里也没有死信列表与重放入口 | 六代发现的问题原样保留：`granted` 事件丢失 → 下游缓存 5 分钟后过期 → **用户在下游失去资格而平台 granted、审计完整、无告警**；反向 `revoked` 丢失更危险。审计锚点缺失使"归档即不可证明" | 在 02 补齐 `ag_event_outbox`（`eventId` 唯一 + `status: pending/delivered/dead` + 与业务同事务的写入契约）与 `ag_dead_letters`（含 `eventId`/`attempts`/`lastError`/`redrivenAt`），并让 06 §5.5 增加列表 + 重放端点；`ag_audit_anchors` 按 D19 落表或显式写"推迟到有归档需求时"（当前是**沉默缺失**） | **中高** |
| **7** `[新]` | **同一里程碑两套工期口径** | 07 §7 vs 11 §12.6 | 07 §7 表格：M0–M2 = 48 人日，累计 M0–M6 = 118 人日（"若只求最小可用 M0–M2 = 48"）。11 §12.6 的 MVP 清单结论：M0–M2 "从 48 → 约 30–34 人日"，完整 M0–M6 "从 118 → 约 60–70 人日"。07 未同步、未标注差异来源 | 第三部分"能不能开工"无法用数字回答；对外承诺与内部排期各用一套；第 9 代减法的收益（-56 人日）在**唯一的排期权威文档里不存在** | 把 07 §7 按第 9 代结论重算，并在表下注明"减法前的 48/118 与减法后的 30–34/60–70 分别适用哪套 MVP 清单"；同时把 11 §14.1"约 12 张表 vs 实需 ≥19 张"的裁决结果写进 07 §3 的 M1/M2 任务表 | **中高** |
| **8** `[残]` | **OIDC `ref` 全集未冻结，正文已产生冲突实例** | 03 §1.18.1 / 04 §1.2.7.2 vs 08 §5.4 / §12 / 09 §2.2 | 03 §1.18.1 的标识符示例是 `platform:gate`，04 §1.2.7.2 的 `newapi-provider` 绑定键写 `ref: "platform:gate"`；而 08 §5.4 规定开发者/用户两个固定 ref 为 `platform:developer` 与 `platform:enduser`，08 §12 明言"站点不得新增"，09 §2.2 用这两个。11 §3 把"ref 全集"列为 7 项待裁决之一 | 同一份 `newapi-provider` manifest 在不同文档里绑定到不同的 ref → 绑定键无法唯一命中 → 04 §1.2.7.2 的"唯一性硬要求"失效 → 对齐退化为 `missing` → 按 D20 走 `unbound`，用户侧永远看到"请重新绑定" | 立刻裁决：`platform:gate` 废弃，统一为 `platform:developer` + `platform:enduser`（并在 01 §6.2 的 new-api 接入说明里同步）；把 ref 全集写进 03 §1.18.2 的"唯一权威表"并加静态校验白名单 | **中** |
| **9** `[新]` | **寻址 root 双名并存，静态校验只认其中一个** | 04 §1.2.2 / §1.2.3 / §1.3 vs 04 §1.2.7.1 / §1.2.7.5 | §1.2.2 的比较示例用 `user.status`、`user.tags`；§1.2.3 操作数表首行是 `user.<field>`；§1.3 形态 A 用 `user.status`。而 §1.2.7.1 定义的 root 只有 `subject|fact|identity|me`；§1.2.7.5 的静态校验清单里只有"`root=me` 的 path 是否在内置用户 schema 内"，**没有 `user` 这一项** | 照 §1.2.2 写出 `{ eq: { user.status: "active" } }` 的策略，在 §1.2.7.5 的校验器里是一个**未知 root**——要么被静默跳过（校验漏洞），要么被拒（文档示例即错）。这是"契约未冻结"在**最常用的一行示例**上的残留 | 统一为 `me.*`（与 04 §1.2.7.1 及 06 §10.3 的 `me.email_verified` 用法一致），全局替换 04 §1.2.2/§1.2.3/§1.3 的 `user.*`；并在 §1.2.7.5 补一行"未知 root → 拒绝发布" | **中** |
| **10** `[残]` | **H3 的不等式没有可求值的形参** | 10 §H3 / 09 §2.2 / 02 §7.2 | H3 要求启动期校验 `事实 TTL ≥ 主体数 ÷ 外部 API 配额`。但：配额不在 `provider.capabilities`（09 §2.2 只有 `list`/`findByIdentity`/`update`/`create`），`ag_provider_sync_state.capabilities` 是自由 jsonb 且无配额字段定义；TTL 来自插件 `configSchema` 的 `cacheTtl`（09 §4.2）而**逐行**写在 `ag_plugin_facts.expiresAt`；主体数没有承载表或统计口径。二代 X8 指出"定量乘数全缺"但只覆盖了 LLM 预算 | 该不等式**没有任何输入能喂给断言**（正是第 5 代"不可执行的保证"的标准形态），因此 H3 至今标"⏳ 待补"（10 §4）也就不奇怪。配额耗尽时事实变 `missing`，按 D20 应收敛为 `throttled`，而 `throttled` 无产出路径（11 §14.2） | 在 `provider` manifest 增加 `quota: { refillPerHour, bucket }` 声明并纳入 `capabilities` 的**实测**；在 02 补一张按 `(siteId, provider, instanceKey)` 的配额余量表或复用 `ag_jobs`；启动校验改为对每个 provider 实例逐条比较，不满足即告警并写 `throttled` 归因 | **中** |

**关于"前几代已覆盖但修复不彻底"的补充**：`ag_provider_sync_state`（S2）、`throttled` 产出路径（D20）、`04 §1.5.1`（D20 要求重写）、审计锚点（D19）四处，11 §14.6 自己列为"三项待修 + 两件冻结"，本次评估确认**状态未变**。

---

## 第三部分 · 开工可行性判定

**1. 现在可以开工 M1 吗？**

**不可以直接开 M1**；但 **M0（地基）今天就可以开工**——这是本次评估与"整体不可开工"结论的关键区别。

理由：M0 的 11 项（Schema 声明层 / 查询 AST / PG 编译器 / 注入+抛错 / 驱动 / 迁移 / 内核 / 认证会话 / F0 前端 / 事务入口 / CI 门禁）不依赖任何 Top 10 缺口；其中唯一被阻塞的是 **M0-11 CI 门禁**（缺口 #2/#3 未修时，门禁要么误报要么永不触发——第 5 代 N1 的原始教训）。M1 则直接踩中缺口 #2/#3/#4/#5：`ag_actions_log` 幂等键、`ag_sessions` 缺列、宿主无知残留会分别打穿 M1-7（身份对齐）、M1-9（策略静态校验）、M1-3（`newapi-provider`）。

**2. 必须补的最小清单**

| 项 | 内容 | 关联缺口 | 人日 |
|---|---|---|---|
| F1 | 统一幂等键语义：05 §3.0.1 补逻辑日维度（或为 `add_quota` 定义独立锚点），同步 05 §3.2/§5.3、09 §3.2、07 M2-3 四处 | #1 | 0.5 |
| F2 | 修 02 §1 门禁自洽：`ag_actions_log`/`ag_policy_versions` 唯一键补 `siteId`；`ag_plugin_instances`/`ag_provider_sync_state` 加 `ownerScope`+`ownerId` 并入白名单（含 CHECK）；**并真跑一次谓词** | #2 #3 | 1.0 |
| F3 | 02 §3.3 `sessions` 补 `realm`/`activeDeveloperId`/`activeSiteId`；06 §2 会话响应同步 | #4 | 1.0 |
| F4 | 消除宿主无知残留：`user.newapiGroup`→`subject:<provider>.<attr>`、`sync.newapi.*`→`sync.<provider>.*`、`gate_newapi_request_total`→`gate_provider_request_total`、06 的 `newapiUserId`→`primarySubject` | #5 | 0.5 |
| F5 | 冻结 MVP 表清单（列名级，≥19 张）+ declarative `action` 规格 + JSON-RPC 方法表落地（11 §14.6 的两件冻结 + 一项待修） | 可实现性 | 1.5 |
| F6 | 统一工期口径：07 §7 按 11 §12.6 重算并注明适用哪套清单 | #7 | 0.5 |
| | **合计** | | **5.0 人日** |

补完 F1–F6 后 M1 可开工；若同时采纳缺口 #6/#8/#9/#10 的修正，再约 +1.5 人日（但 #9 属"文档替换 + 校验器加一行"，#10 可推迟到 M4）。

**3. 若你认为可以直接开工，说明带着哪些可接受风险开工**

若坚持"边补边开"，可接受的风险只有三类，其余不可接受：

- **可接受**：性能数字全部是估算（10 §15.4 自认）——07 §9 的 3 天 Spike 正好覆盖 PAT 可读性、`PUT` 是否真踢人、响应字段完整性；LLM 评分细则有效性（需真实数据）；PG RLS 性能与分区维护成本（D17 已把 RLS 推迟，风险敞口同步消失）。
- **可接受**：M7 的 SaaS 细节（S1–S6、S4 隐私边界）在单站点落地前无法验证——08 §11 已保证两种模式共用同一套 schema，切换可逆。
- **不可接受**：缺口 #2/#3/#4——它们不是"晚改"，而是**改建表语句**。M2 的动作执行器一旦按 `t.unique(['idempotencyKey'])` 落库，M7 SaaS 化时补 `siteId` 需要同时改唯一键、幂等键生成点与全部历史数据；缺口 #1 更直接——它会让 M2-3（`add_quota`）的验收"重试不重复发放"通过，却掩盖"跨日不发"的资损，**验收标准本身测不出来**。

---

## 第四部分 · 最强与最弱

**1. 最出色的一个决策**

**`D3`：AST 是唯一真理，YAML / JSON / Graph 只是序列化，`specHash` 只对规范 AST 计算（04 §1.2.6）。** 它一次性解决了三个通常互相纠缠的问题：多编辑器不产生语义分叉（往返保真由 property-based 测试承载，07 M3-6 可执行）、版本去重不被编辑器切换污染（"内容未变"可判定）、前后端不漂移（共享 `@gate/expr`）。更难得的是它给了**可证伪的验收**：随机 AST 三向往返语义等价且保序——这是全文里少数几条"能跑起来证明自己"的设计。

**2. 最危险的一个决策**

**`D17` 的执行面：推迟 RLS 的同时，把能力层隔离"唯一地"交给 `ownerScope`+`ownerId` 双列（11 §14.1），而这套双列的覆盖白名单本身漏表。** 决策逻辑（无站点级协作者 → 隔离当前是数据卫生）成立，前置 3（单一事务入口）也确实把后补成本压到 O(1)；但"把两道防线减成一道"与"这道防线有洞"叠加后，危险等级变了：`ag_plugin_instances.config`（下游地址 + 凭据引用名）与 `ag_provider_sync_state`（对账游标）**既不受 RLS 约束，也不受双列约束，也不在门禁白名单里**。这不是"晚点补 RLS"的问题，而是"当前没有任何机制在管它们"。

**3. 如果你只能改一处**

**把 02 §1 的门禁从"白名单 + 首列 siteId"改成"对全部表逐条求值的可执行谓词"，并在 M0 出口真的跑一次（含故意写错一张表看它是否报错）。** 理由不是"门禁重要"，而是：第 5 代 N1 已经证明这条门禁**从未被执行过**（白名单 24 表真跑一遍有 10 表失败），而本次 Top 10 中 #2、#3、#4 全部是这一处修正的**直接产物**——一次真实的求值就能把它们从"推演里的怀疑"变成"CI 的红色"。这符合 11 §13 的第 2 条教训（**声称必须能执行**），也是唯一一处"改一个文件、跑一次命令，就能同时暴露三条高危"的杠杆点。
