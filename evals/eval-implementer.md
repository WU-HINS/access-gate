# access-gate 全量架构评估 ·【自下而上的实现者】视角

> 评估者视角标识：`implementer`
> 判据：**照文档写代码**。挑 6 个最复杂的模块（表达式求值器 / 绑定解析 / 动作执行器 / 通用对账器 / 插件宿主 / 站点作用域注入），逐段读设计，自问「这段我写得下去吗」。
> 每条问题必须能落到**我要写的那一个函数 / 那一条语句**。
>
> **阅读范围（实际打开并逐段读过）**：01 总体设计、02 数据模型、03 插件体系、04 表达式引擎、05 核心机制、06 接口与界面、07 实施路线图、08 SaaS 站点化、09 内置插件实现、10 架构推演、11 第二代推演、CHANGELOG(D1–D20)、README。14 只作为提示词与基线对照物。
>
> **不复述 deepseek 基线 6 条**。唯一例外：基线第 3 条（`ag_plugin_instances` / `ag_provider_sync_state` 逃出作用域白名单「已修复」）经核查**修复不彻底**，见 Top10 #9 —— 这两张表被追加进白名单后，其表声明**依然无法满足该白名单的谓词**（详见该条）。

---

## 第一部分 · 架构成熟度评分（1–5，1=不可用 / 3=可用但明显风险 / 5=可放心开工）

| 维度 | 我的评分 | 一句话结论 |
|---|---|---|
| 架构自洽性 | **3** | 立场统一，但「同一事物两个权威来源」在我真正要写的 6 个模块里各出现至少一次 |
| 数据模型完备性 | **2** | 白名单逃逸 + 主键与多版本冲突 + 会话缺列 + DDL 声明损坏 |
| 安全与隔离 | **2** | D16/D17 五处并存；隔离唯一防线依赖一个**不存在的列**；密钥「一次性」与示例代码复用矛盾 |
| 可运维性 | **3** | 全文档设计密度最高的一维，但多个承诺仍无承载表/列 |
| 可实现性 | **2** | 6 个重点模块**每个**都有「写不下去」的点，且原因是规格缺失而非理解不足 |
| 工期与范围可信度 | **1** | 不是「低估」，而是**范围不可确定**（双工期口径 + 3 个未答的范围决策 + M1 依赖 M4 的运行时） |

**架构自洽性 3**：四抽象（Subject/Fact/Policy/Grant）、宿主无知、AST 唯一真理三条主线在 01 §4.2.4 / 03 §1.16.3 / 04 §1.2.6 之间是自洽的，且都配了可执行验收（删 `plugins/builtin/` 仍能启动、grep 门禁、property-based 往返）。扣分在于「同一事物的权威来源数」：动作标识有规范形却到处残留点号写法（02 §6.3 注释第 825 行的 `notify.webhook`）、幂等键在同一份文档里既有冻结公式又有 `reason` 入键（Top10 #1）、`siteScoped` 标记与白名单门禁并存（Top10 #9）。

**数据模型完备性 2**：正面看，02 §1 的「列必须在表内声明」这条门禁是三代推演最有价值的产出，并且真实修复了 15 张表 24 个缺失列。但我实际拿 02 去写 `defineTable` 时，至少有 4 处会当场炸：`ag_plugin_configs` 与 `ag_policy_assignments` 两张业务表**不在任何一个白名单里**（02 §1 的两份清单都不含它们），等于逃出门禁；`ag_plugins` 主键是 `id` 导致「同一 id 多版本并存」无法落库（02 §4.1 vs 03 §1.12）；`ag_sessions` 没有 `realm/activeDeveloperId/activeSiteId` 三列，而站点作用域注入的取值来源正是 `session.activeSiteId`（01 §5.5 vs 02 §3.3）；`baseline` 的默认值写成 `defaultSql("{}")`，生成的 DDL 是 `DEFAULT {}`（02 §6.1）。

**安全与隔离 2**：隔离设计的**意图**是最清楚的（01 §5.0 不 JOIN 下游表是 provider 抽象的前提、D11）。但落地面有硬伤：① `FORCE ROW LEVEL SECURITY` 在 D16/README/01 §5.5/08 §13 S5 里是「已采纳/已决」，在 D17/07 里是「推迟」，**五处并存**；② 推迟 RLS 后，站点隔离的唯一防线是应用层注入，而注入的值来自 `ag_sessions.activeSiteId`——这一列在 02 里不存在；③ 03 §1.5 的「密钥不落插件：`secrets.get()` 返回一次性使用凭据」与 09 §2.3 的 `const pat = await ctx.host.secrets.get(...)` 后在 1000 次分页请求中反复使用，是两种互斥的安全模型。

**可运维性 3**：这是全文档投入最深的一维——指标标签白名单与基数上限（05 §7.1.1）、状态型周期告警 + 告警审计（05 §2.1.2）、审计敏感度分级与阻断（05 §7.1.3）、启动期两条不变量（11 §13.1）、行级租约（D18）。扣分在于**承诺多于承载物**：05 §7.1.2 明确给出 `ag_event_outbox` / `ag_dead_letters` 两张表，但 02 全文档 0 命中，06 §5.5 也没有它自己承诺的「死信队列列表与重放入口」。

**可实现性 2**：给 2 分而不是 1 分，是因为**地基部分（M0）是可写的**：`defineTable` / 查询 AST / PG 编译器 / advisory lock / fail-closed 抛错这几项规格足够（01 §5.1–§5.4、07 M0-1..M0-11a 的验收可测）。给 2 分而不是 3 分，是因为 M1 之后的每个模块我都至少卡一次，且卡点集中在**宿主 API 签名、对账器能力字段、动作幂等键、绑定寻址**这四处契约上——这四处恰是 11 §14.6 自己承认「没冻结就不能动 M1」的两件冻结。

**工期与范围可信度 1**：理由是**范围的不可判定**，不是工期的乐观：07 §7（M0–M2 = 48 人日、M0–M6 = 118）与 11 §12.6（30–34 / 60–70）是两套都写在正式文档里的口径，且 11 §12.5 明确「设计尚未收敛，等第 9 代 10 项减法裁决」；07 §8 的 Q1（集成模式，决定 M1-7 范围）/ Q4（签到路线）/ Q11（是否支持第三方插件）**仍未答**；同时 07 M1-3 要求交付 `newapi-provider`（09 §2.2 声明 `runtime: process`），而 process 运行时是 **M4-1**。也就是说：**M1 要我写的东西，其运行时在 M4 才交付**。这不是估算问题，是范围定义问题。

---

## 第二部分 · 关键问题 Top 10（按严重度排序）

> 排序依据：**它会让我在哪一步停下**，其次是后果面。全部为 10/11/14 未覆盖项（#9 为「修复不彻底」）。

### #1 幂等键公式缺「步序号」——同一计划内重复动作必然撞唯一键

- **位置**：05 §3.0.1（冻结公式）、05 §3.1（`ActionPlan.steps`、`ActionStep.idempotencyKey`）、02 §6.3（`uq_ag_actions_idem`）、03 §1.17.7（`reason` 入键）
- **现象**：公式为 `idempotencyKey = hash(siteId, userId, policyId, actionSeq, action)`，唯一约束是 `(siteId, idempotencyKey)`。**输入里没有任何区分同一次计划内不同步骤的东西**。而 §3.1 的 `steps` 是**有序数组**、§3.5 修正六的场景是 `[set_group, grant_checkin, notify]`。同时 03 §1.17.7 又写「调用方提供 `reason` 参与幂等键计算」，与「冻结公式」互斥（`reason` 不在公式里）。
- **后果**：一个分支里出现两个同名动作（例如 `tag.add` 加两个标签、或 04 §1.3 形态 A 的 `onSatisfied` 与分支级 actions 合并后产生重复条目）时，第二条 INSERT 直接违反唯一约束；异常被吞则第二、三步**静默不执行并停留在 planned**（04 §1.5.1 的「门禁」只覆盖枚举，不覆盖这条）。若改为「撞键就 UPDATE」，则把两步合成一步，`ag_actions_log.`result` 只剩最后一条。两种走法都不对。
- **修正建议**：公式补第 6 个输入 `stepSeq`（计划内 1-based 步序，冻结在 `ActionStep` 上）：`hash(siteId, userId, policyId, actionSeq, stepSeq, action)`；并在 05 §3.0.1 的「唯一约束」行同步改为 `(siteId, idempotencyKey)` 不变 + 明确 `stepSeq` 参与；同时把 03 §1.17.7 的 `reason` 从「参与幂等键」降级为「只入审计与 result」，或明确插件间调用另立一套键（`hash(pluginId, action, externalId, reason)`）并说明何者优先。
- **严重度**：**严重**
- **我会卡在哪一步**：写 `buildActionPlan()` 里那一句 `steps.map(s => ({...s, idempotencyKey: hash(siteId,userId,policyId,actionSeq,s.action)}))` —— 我盯着 `s.action` 循环里没有任何 `map` 的第二个参数（index）可用，意识到这是错的，然后没有任何文档告诉我正确的第 6 个输入该叫什么。冻结公式这四个字让我**不能自己加**。

### #2 事实依赖一次性收集 vs「未走到的分支不触发采集」——同一份文档给出两个互斥算法

- **位置**：04 §1.4（渠道自动推断的收益与 ⚠ 注）、04 §1.5（`evaluate()` 伪代码第 2 步 `collectFactRefs(policy.spec.requirements)`）、07 M3-12 验收
- **现象**：§1.5 的算法是「**先**对整份 `requirements` 收集依赖 → 拓扑排序 → 采集（第 2 步）→ **再**按分支求值并短路（第 3 步）」。也就是说**采集发生在分支求值之前，短路根本省不到任何采集**。但 §1.4 的 ⚠ 注写「`fast` 模式下，第一个分支命中后，后续分支引用的事实**不会被采集**」，并且 07 M3-12 把「未走到的分支不触发采集」写成了**验收项**。
- **后果**：我按 §1.5 写 → M3-12 验收失败；我按 §1.4/验收写 → 必须在求值过程中**惰性采集**，那么 `evaluate()` 签名就要改（需要 `ctx.ensureFacts` 可重入、每节点 await、并对"求值过程发起外部调用"违反 04 §1.10「求值过程无副作用」的约束）。更糟的是 `explain` 模式声称「**不触发新采集**，只用已有事实」，而用户的「我的资格」页（06 §2 `progress`）恰恰是 `explain`——若 `fast` 短路时从未采集分支 3 的事实，用户看到的第 3 分支**永远是 unknown**，而文档没有任何地方定义"谁在什么时机为未走到的分支采一次事实"。
- **修正建议**：二选一并写进 04 §1.5：(a) 放弃短路省采集，把 §1.4 的 ⚠ 注与 M3-12 验收改为「短路的收益是**省外部调用以外的加工**」；(b) 采纳惰性采集，明确 `ensureFacts` 可在节点求值中调用（把它从 §1.10「无副作用」的例外中显式豁免），并定义 `explain` 的补齐策略（建议：`explain` 允许一次"补齐采集"，并记 `ag_plugin_invocations`）。同时 `collectFactRefs()` 的**返回类型**必须写出来（`{namespace, instanceKey, path}[]`）。
- **严重度**：**严重**
- **我会卡在哪一步**：写 `evaluate(user, policy, mode, ctx)` 的第 2 步——`const needed = collectFactRefs(policy.spec.requirements)`。这个函数名在 04/05/07 里出现 4 次，**没有一次给出签名**（返回什么形状？是否含 instanceKey 与 #siteSlug？去重键是什么？）。我甚至无法开始写它。

### #3 站点作用域注入的取值来源在数据模型里不存在（会话缺列）

- **位置**：01 §5.5（`app.site_id` 由**会话的 activeSiteId** 派生）、08 §7（`ctx.scope = { realm, developerId, siteId: session.activeSiteId, actorId }`）、02 §3.3（`ag_sessions` 实际列）、02 §3.10（只在散文里说「加 realm + activeDeveloperId + activeSiteId」）
- **现象**：02 §3.3 的 `ag_sessions` 声明只有 `id / userId / tokenHash / userAgent / ip / expiresAt / revokedAt / createdAt`——**没有 realm、没有 activeDeveloperId、没有 activeSiteId**。02 §3.10 只在「既有表的站点化变更」表里用一行散文写了要加，而 §1 的门禁要求「`t.unique` 引用的列必须已在表内声明」，恰恰没有一条规则要求"散文里说加的列必须落进声明"。
- **后果**：站点作用域注入的**唯一取值来源不存在** → `ctx.scope.siteId` 恒为 undefined → 要么 fail-closed 抛 `MissingSiteScopeError`（整个平台不可用），要么退化成"默认站点"兜底（01 §5.5 明文禁止：「禁止用『默认站点』兜底」）→ 站点 A 的数据被写进站点 B，且**不报错**。这正是 02 §1 自己命名的「静默的跨站点数据污染」。此外 06 §1 说 Cookie 名是 `ag_session`，08 §5.4 说是 `ag_dev_session` / `ag_user_session`（且 `Path=/console,/admin` 不是合法的单个 Path），会话实体有三个名字。
- **修正建议**：把 §3.10 的三列正式写入 02 §3.3 声明（`realm` 非空枚举 + `activeDeveloperId`/`activeSiteId` 可空 uuid），把 `ag_sessions` 纳入平台能力层白名单（`ownerScope/ownerId` 或明确豁免），并统一 Cookie 名为 `ag_user_session`/`ag_dev_session` 两个（`ag_session` 删除），Path 分别写 `/` 与 `/console`（`/admin` 用 realm 判定而非 Path）。
- **严重度**：**严重**
- **我会卡在哪一步**：写请求上下文中间件的第一行：`const siteId = session.activeSiteId` —— TypeScript 立刻报 `Property 'activeSiteId' does not exist on type 'Session'`，而"这个字段归谁加"我要翻三份文档才能确认是 02 §3.10 的散文。

### #4 插件宿主 API 与内置插件的示例代码对不上（签名/成员/语义三处）

- **位置**：03 §1.5（`PluginHost` 定义）、09 §2.3 / §3.1 / §3.3（可照着写的示例）、05 §2.2（`ctx.locks.withUserLock`）、01 §4.2.1（`ctx.config.get<T>(path)`）
- **现象**：三处硬对不上。
  1. `config.get`：03 §1.5 是 `config: { get<T>(): T }`（**无形参**），01 是 `ctx.config.get<T>(path)`（**有 path**），09 §2.3 调用 `ctx.host.config.get()`（无参）。而 `newapi-provider` 声明 `instances.mode: singleton` 尚可，`llm-review` 声明 `multi`（09 §5.3）时，**无参的 `config.get()` 无法知道该取哪个实例的配置**。
  2. `actions.invoke` 与 `locks`：03 §1.17.7 与 07 M4-11 都用 `ctx.host.actions.invoke(...)`，09 §3.1 用 `ctx.host.locks.withSubjectLock`，05 §2.2 用 `ctx.locks.withUserLock(user.id)`——**这四个成员在 03 §1.5 的 `PluginHost` 接口里一个都没有**，且 `withSubjectLock`（键=subject）与 `withUserLock`（键=user）对同一次写是两把不同的锁。
  3. `secrets.get` 的语义：03 §1.5「密钥不落插件：返回**一次性使用凭据**」vs 09 §2.3 取出 PAT 后在同一函数里循环用 1000 次（分页对账）——若真是一次性，09 的实现第一次请求后就失效；若不是，03 的安全表述是错的（而 03 §1.11 的安全汇总把这条当作核心对策）。
- **后果**：M1-4/M1-5（宿主 API 最小版）的**验收对象无从定义**；M1-3 的 provider 我只能"猜"一个 API 并自行实现，等 M4 引入 process 运行时后必然返工（进程形态下这些调用要走 JSON-RPC，方法名还得再定一次）。
- **修正建议**：把 `PluginHost` 提为**版本化契约文件**（`gate.host/v1`）并冻结六件事：① `config.get({instanceKey})` 的唯一签名；② `actions.invoke` 的入参/出参/错误；③ 锁的**唯一键域**（建议只保留 `withSubjectLock({provider, externalId})`，删 `withUserLock`）；④ `secrets.get` 的生命周期（建议明确「宿主一次性注入、插件只拿到 request 作用域的短时凭据」，并删掉 09 §2.3 的手工 `Authorization` 头，改为 `http.request({ authRef })`）；⑤ 每个方法的权限字符串；⑥ 与 JSON-RPC 方法名的映射表。
- **严重度**：**严重**
- **我会卡在哪一步**：写 `listSubjects()` 的第一行 `const cfg = ctx.host.config.get()` —— 我在 IDE 里看着 03 §1.5 的接口定义，发现 `get<T>()` 没有形参先编译不过，改成 `get(cfgPath)` 又要决定 path 的语法（是 `'baseUrl'` 还是 `'newapi-provider.baseUrl'`），01 与 03 各给一个答案。

### #5 `set_group` 的写回载荷有两套权威实现，其中一套违反它自己文档里的"必须完整回填"

- **位置**：05 §2.2（`applyGroupChange` 用 `{...fresh.attributes, group, remark}` 全量回填）、09 §3.1（`execute()` 只组装 `id/username/display_name/group/remark`）、09 §2.6（坑点表：`PUT /api/user/` 需完整对象，缺字段会被覆盖）、01 §2.4（同坑）
- **现象**：09 §2.6 与 01 §2.4 用源码结论写死了「缺字段会被覆盖，必须先 GET 再 PUT，回填 username/display_name/remark」，但紧接着 09 §3.1 给出的可照抄代码**只回填了 4 个字段**——而 05 §4.6 列出的 `attributes` 里还有 `status / role / quota / used_quota / request_count / aff_code / oidc_id`（02 §7.1 的属性袋清单同样列出这些）。两份文档都自称权威：05 §2.2 是「核心机制」，09 §3.1 是「可照着写代码」。
- **后果**：按 09 §3.1 实现 → 每次改分组都可能把 `oidc_id`（身份对齐键！）或 `aff_code` 覆盖为空 → 下一次对账 `fingerprint` 变化 → 触发 `SubjectAttributesChanged` → 对账把变化当"外部漂移"→ 若 `driftPolicy=platform_wins`（默认，05 §4.5）则**反向改写**，进入"你改我、我改你"的震荡；`oidc_id` 被抹掉还会直接**断开身份对齐**（05 §1.2 对齐来源 1）。
- **修正建议**：把「写回载荷」收敛为宿主提供的一个原语 `provider.patchSubject(externalId, { group })`，由 **provider 插件（而非 action 插件）**负责「读全量 → 合并 → 写回」并保证白名单字段；09 §3.1 的示例改为调用该原语。若坚持由 action 组装，则必须给出**权威字段清单**（哪些字段必须回填、哪些必须不带：`password`、`role` 见 09 §2.6），并让 09 §3.1 与 05 §2.2 二者之一作废。
- **严重度**：**严重**
- **我会卡在哪一步**：写 `newapi-set-group/plugin.mjs` 的 `execute()` 里组装 `payload` 那一行——`const payload = { ...? }`。我需要 `fresh.attributes` 的全集，但 09 §3.1 明写只带 4 个字段，且 §2.6 说"绝不能带 password / role"；同时 05 §2.2 写 `...fresh.attributes`（会带 role！）与 §2.6 冲突。三个文档三种 payload，我只能猜。

### #6 通用对账器的能力字段、指纹字段、降级路径三处都无权威定义

- **位置**：05 §4.1（指纹来自 `subjectSchema` 中 `watch: true`）、05 §4.2（降级路径「按 provider 声明的主键**倒序**，遇到已知 id 即停」；增量条件 `capabilities.cursor === true`）、03 §1.16.2（ProviderPlugin 接口，capabilities 只有 `list/findByIdentity/update/create`）、09 §2.2（manifest 里 `provider.watch: [...]`）、09 §2.3（实现按 `sort_order=asc` 全量分页）、02 §7.1（`watched` 列，注释写"由 subjectSchema 中 watch: true 决定"）
- **现象**：三处独立缺陷。
  1. 05 §4.2 的增量快路径条件引用 `provider.capabilities.cursor`，但 03 §1.16.2 声明的 `capabilities` **没有 `cursor` 这个成员**（`capabilities` 的类型在 C1 里只能写那四个）。05 §4.4 的能力探测也只存 `declared/actual` 两份快照，没有"主键字段名/是否倒序/是否支持 sinceId"这类可编程声明。
  2. 指纹的"关注属性集合"有三个来源：`subjectSchema` 里的 `watch: true`（05 §4.1 + 02 §7.1 注释）、manifest 的 `provider.watch` 数组（09 §2.2 实际写法）、以及落库的 `watched` 列（02 §7.1）。三者**互不引用**，而 `fingerprint` 的值直接决定"是否发 `SubjectAttributesChanged`"（05 §4.1）——算错就是要么漏掉变更（策略永不重评）要么每轮全量误报。
  3. 降级路径：05 §4.2 要求**主键倒序 + 遇到已知 id 即停**，09 §2.3 的实现是**主键升序 + 按 total 翻页直到 nextCursor=null**（等价于全量）。二者是**不同的成本模型**（O(新用户) vs O(全表)），而两者同时被写进文档；M1-2 验收「10 万主体 < 5 分钟」到底按哪个算？
- **后果**：M1-2「通用对账器」无法开工——它的三个输入（能力、指纹字段、增量策略）都需要我先发明，而 05 §4.2 明文说这三点"是优化而非前提"，等于把设计责任推给实现者；一旦我选了升序全量，10 万用户每分钟跑一次首页探测（05 §4.2 默认 1 min）就是 1000 次请求/分钟。
- **修正建议**：把 provider 的**同步元数据**并入 `ProviderPlugin` 接口并写进 03 §1.16.2：`sync: { primaryKey: string, order: 'asc'|'desc', supportsCursor: boolean, cursorParam?: string, pageSizeMax: number }`；指纹字段**只保留一个来源**（建议 manifest `provider.watch`，因为它是声明式的、可静态校验的），删掉 `subjectSchema.watch` 与 02 §7.1 注释中的"由 subjectSchema 决定"，让 `watched` 列只做**审计快照**；降级路径二选一并在 05 §4.2 与 09 §2.3 同步（建议升序全量 + 每轮 `lastSeenKey` 水位，因为它对"中途新增的 id 回填"更安全）。
- **严重度**：**高**
- **我会卡在哪一步**：写 `syncDegradedHead(provider)` 的第一行 `if (provider.capabilities.cursor)` —— 编译器直接报 `Property 'cursor' does not exist`；然后我去写 `computeFingerprint(subject)`，卡在 `const watched = ???`（subjectSchema 遍历？manifest.provider.watch？`subject.watched` 列？）。

### #7 绑定解析：`instance` 的语义混用，且 `binding.*` 没有根、字段也没有列

- **位置**：04 §1.2.3（`binding.<pluginId>.<field>`：`status/externalName/boundAt/age_days`）、04 §1.2.7.1（寻址语法 `<root>:<pluginId>[@<instanceKey>][#<siteSlug>].<path>`，root 只有 `subject|fact|identity|me`）、04 §1.2.7.2（「查 `ag_plugin_bindings`(平台用户, plugin=newapi, instance=**site-a**)」）、04 §1.2.7.3（动作参数 `instance: site-a`）、02 §4.4（`ag_plugin_bindings` 的列是 `instanceKey`，无 `boundAt`）、03 §1.19.3（singleton 实例键写死，multi 才带 `@`）
- **现象**：四处不一致。
  1. `instance=site-a` —— `site-a` 是**站点 slug**，而 `instanceKey` 是**插件实例键**（03 §1.19.3 的例子是 `@orders`）。`newapi-provider` 声明 `instances.mode: singleton`（09 §2.2），其规范化实例键按 02 §3.8 是 `'default'`。按 04 §1.2.7.2 去查 `instanceKey='site-a'` 的行**永远查不到** → 绑定恒 missing → 所有 `subject:newapi.*` 恒 missing → 用户永远看到"未绑定"。
  2. 同一份 04 里，`binding.<pluginId>.<field>`（§1.2.3，**点号**）与 `<root>:<plugin>...`（§1.2.7.1，**冒号 + 括号槽位**）是两套语法；且 `binding` **不在 root 全集里**。
  3. `binding.*` 的可用字段 `boundAt` / `age_days` 在 02 §4.4 里没有对应列（只有 `createdAt`，也没有 `age_days` 的计算定义）。
  4. §1.2.7.2 的示例绑定键用 `ref: "platform:gate"`，而 08 §12 规定只有 `platform:developer` 与 `platform:enduser` 两个固定 ref 且「站点不得新增」，09 §2.2 用的也是后两个。
- **后果**：绑定解析是**跨系统取值的唯一入口**（04 §1.2.7 开头即声明），它写不对则 `subject:*` 全链路不可用；而 M3-4「绑定解析」的验收只写了"唯一性强制；多候选进人工裁决"，无法发现上述任一问题。
- **修正建议**：① 把 `binding` 正式纳入 root 全集并给出规范形 `binding:<pluginId>[@<instanceKey>].<field>`，删掉 §1.2.3 的点号写法；② 明确 `instanceKey` 与 `siteSlug` 是**两个独立槽位**（`@`=实例，`#`=站点），把 04 §1.2.7.2/§1.2.7.3 所有 `instance: site-a` 改为 `siteSlug: site-a`（或删掉，因为默认就在当前站点）；③ 给出 `boundAt`/`age_days` 的**唯一映射**（建议 `boundAt = ag_plugin_bindings.createdAt`、`age_days = floor((now-createdAt)/1d)` 并注明时区基准，参照 10 §P8 的 UTC 约定）；④ 固定 ref 全集写进 02 §7.9 的约束或 08 §12，并把 04 示例改成 `platform:enduser`。
- **严重度**：**高**
- **我会卡在哪一步**：写 `resolveBinding(userId, pluginId, instanceKey, siteId)` 的调用方——在 `evalExpr` 里解析 `subject:newapi.group` 时，我必须构造查询，而 `instanceKey` 从哪来（'default'？当前站点 slug？）三份文档三个答案；再往下写 `binding:github.status` 时，我的 `parseAddress()` 的 root 枚举里没有 `binding`，正则直接不匹配。

### #8 `score` 节点的权重来源三处不一致；`$ttl` 没有定义域

- **位置**：04 §1.2.1（`{ score: { threshold: 150, of: [{ weight: 2, expr: E1 }, ...] } }`）、04 §1.2.4（`$weight: 2  # 在 score 节点中的权重`）、04 §1.5.1 ②（`atLeast/score：「已达成的通过数」不足以判定、且至少一个 indeterminate → indeterminate`）、04 §1.2.4 与 §1.5.1 ①（`$ttl` = 「该分支依赖事实的最大复用年龄」）
- **现象**：`score` 的权重有**两种语法载体**（子节点对象里的 `weight` 字段 vs 保留属性 `$weight`），而三值传播规则把 `score` 与 `atLeast` 并排写成「已达成的**通过数**」——**用计数描述一个加权分节点**。于是"如何判定 score 是否 indeterminate"无法推导：是"剩余未判定的权重之和 < threshold - 已得权重"，还是"剩余可判定项数 < 某个数"？两种算法结果不同。另外 `$ttl`（"事实的最大复用年龄"）与插件的 `cacheTtl`（09 §4.2）/ `ag_plugin_facts.expiresAt`（02 §4.5）是**三个**决定"这份事实算不算过期"的量，谁覆盖谁没写；`$ttl` 用的 `24h` 是 duration 字符串，而 02 里全是 `timestamptz`。
- **后果**：`score` 是 04 §1.9 迁移映射表里 `mode: weighted` 的**唯一去处**（旧策略迁移必须用它），写不出来等同"旧策略迁移工具"不可交付；`$ttl` 写不出来则 §1.5.1 ① 的「事实缺失**或过期**」这一分支无法编码，而它决定了 `fail_closed` 是否触发。
- **修正建议**：① 保留一种权重载体（建议 `$weight`，因为它是"元数据不影响求值语义"的统一机制，见 §1.2.4），删掉 §1.2.1 示例里的 `{weight, expr}`；② 在 §1.5.1 ② 给 `score` **单独的**三值规则（写成公式：`已被判 true 的权重和 + 所有 indeterminate 的权重和 < threshold → false；否则若存在 indeterminate → indeterminate`），并把 `atLeast` 保留为计数规则；③ 定义新鲜度优先级：`$ttl`（策略级，覆盖）→ 插件 `cacheTtl`（事实级，默认）→ 硬上限（配置），并说明与 `$required` 的先后。
- **严重度**：**中高**
- **我会卡在哪一步**：写 `evalScore(node, ctx)` 的返回处——我需要一个 `passed: boolean | 'indeterminate'` 的判定式，而现在是「已达成的通过数不足以判定」这句中文；我不知道该对 `weights` 数组求和还是对 `passed` 计数。同一个函数里我还要决定 `const ttl = node.$ttl ?? fact.expiresAt` 的取值优先级。

### #9 `ag_plugin_instances` 与 `ag_provider_sync_state`：白名单"已修复"但**声明依然无法通过该白名单**（基线第 3 条修复不彻底）

- **位置**：02 §1（站点作用域白名单，标注"12 表"却列出 **14** 项，含 `ag_plugin_instances` 与 `ag_provider_sync_state`，谓词要求「每表必须含 `siteId: col.uuid().notNull()`，若有唯一键其首列必须是 `siteId`」）、02 §3.8（`ag_plugin_instances`：`siteId: col.uuid()**.nullable()**`、唯一键 `uq_ag_plugin_inst_dev = ['developerId','pluginId','instanceKey']` **首列不是 siteId**、表尾标 `{ siteScoped: false }`）、02 §7.2（`ag_provider_sync_state`：**根本没有 siteId 列**，主键是 `provider`）、08 §7 与 02 §299（缺 `site_id` → `db:check` **启动失败**）、11 §12.2 N1（"白名单 24 表，真的跑一遍谓词，10 表失败；已修复：补齐 10 张表"）
- **现象**：这两张表被**追加进白名单文本**，但表声明一行没改。逐条对谓词：`ag_plugin_instances` 的 `siteId` 是 nullable（谓词要求 notNull），且它有一条以 `developerId` 打头的唯一键（谓词要求首列 siteId）；`ag_provider_sync_state` 连列都没有。同时这两张表的"跨作用域"本质（developer 级配置行 / 平台级同步游标）与"站点级表"的谓词**在设计上互相排斥**——`ag_plugin_instances` 甚至自标 `siteScoped: false`，而 02 §1 又明说门禁「**不依赖 `siteScoped` 标记**」。
- **后果**：M0-5/M0-11 的 `db:check` 一旦**真的执行**这条谓词（这正是第 5 代 N1 的教训：谓词从未被执行验证），会在启动时直接失败；若为了通过而把 `siteId` 强改为 notNull，则 developer 级配置行必须捏造一个 siteId（03 §1.19.1 明说"所有站点共享一份"），唯一键 `uq_ag_plugin_inst_dev` 也随之失去意义；`ag_provider_sync_state` 加 siteId 后主键 `provider` 变成"一个站点一个游标"，与 10 §S2「按 `(siteId, providerId)` 分片」吻合但与「平台级 capability 探测」冲突（能力探测是平台级的，05 §4.4）。
- **修正建议**：把白名单**拆成三条规则**而不是一条：① 站点作用域表（真站点级）；② **跨作用域表**（`ag_plugin_instances`：允许 `siteId` 与 `developerId` 二选一非空，用 `CHECK (num_nonnulls(site_id, developer_id) = 1)` 表达，唯一键改为「作用域键 + pluginId + instanceKey」按作用域分两条部分唯一索引）；③ 平台能力层表（`ag_provider_sync_state` 保留 `provider` 单键，但补 `ownerScope/ownerId` 以符合 §1 的第二条清单，并在 05 §4.4 说明能力探测是平台级的）。同时把 §1 的"12 表"改成与实际条目一致的数目——**标签与列表不一致本身就是"哪份是权威"的隐患**。
- **严重度**：**高**（且属"已宣称修复但未修复"）
- **我会卡在哪一步**：写 `db:check` 的白名单常量与谓词函数：`for (const t of SITE_SCOPED_TABLES) assert(t.cols.siteId?.notNull)` —— 我照着 §1 的清单把这两张表填进去，函数在启动时立刻报 `ag_provider_sync_state: siteId missing`；我不改代码就得改表声明，而改表声明会破坏 03 §1.19 的作用域语义。这是我第一次意识到"白名单文本"和"表声明"是两个不同的人写的。

### #10 02 的 Schema 声明存在**无法生成 DDL** 的硬缺陷（M0-2/M0-4 的第一天）

- **位置**：02 §6.1（`baseline: col.jsonb().notNull().defaultSql("{}")`）、02 §6.3（标题 `### 6.3 `ag_actions_log` ——` 之后**代码块外的孤立行** `traceId: ... 动作执行与幂等`；代码块内 `actionSeq: col.bigint().notNull(), // ...\n` 带**字面量 \n**）、02 §6.2/§7（`ag_evaluations` 与 `ag_audit_log` 声明 `id: bigserial().primaryKey()`，而 02 §10 声明这两张表按月 `PARTITION BY RANGE (created_at)`；10 §R7 已指出 PG 要求分区表唯一约束必须含分区键，并给了修正 `t.primaryKey(['id','createdAt'])`，但 02 未改）、02 §6.4（`ag_checkin_records` 的 `defineTable(...)` 缺少收尾的 `]` 与 `}`；`ag_checkin_entitlements` 整段嵌在 blockquote 的代码围栏里）
- **现象**：这些不是"风格问题"，而是**声明层的可执行性**问题。02 的开篇明文规定「TS 片段是 Schema 声明层的目标写法；**DDL 由声明推导，禁止手写**」。`defaultSql("{}")` 生成的 SQL 是 `DEFAULT {}`（jsonb 需要 `'{}'`，同文档其它 20 余处 jsonb 默认值都写成 `"'{}'"`，只有 `baseline` 漏了引号）；其余各表中的 `defaultSql` 均带引号（02 §3.1/§3.3/§3.6/…），唯 `baseline` 例外，属**孤例缺陷**。`ag_actions_log` 的 `traceId` 出现在标题与代码块之间：05 §7.3 要求 trace_id 贯通"HTTP → 评估 → **动作** → new-api → 审计"，02 §6.2 的 `ag_evaluations.traceId` 注释自称"关联四元组的**首元素**"，因此 `ag_actions_log.traceId` 应当存在——但它到底是不是该表的列，**从被破坏的文档结构里无法判定**。
- **后果**：M0-4（PG SQL 编译器）的 snapshot 测试会因为一个 `DEFAULT {}` 而失败，而修它意味着我**手改文档里的声明**——违反"禁止手写 DDL"的立场；分区表 PK 不含分区键则 `CREATE TABLE ... PARTITION BY RANGE` 直接报错（10 §R7 已给出结论但未落地）；`ag_actions_log` 缺 `traceId` 会让 05 §7.3 的"链路贯通"断在动作环节，而这正是排障时最需要的一环。
- **修正建议**：把 02 的声明当成**可编译产物**来做一次 0.5 人日的 spike：写一个 30 行的脚本，把全部 `defineTable` 片段落成 `.ts` 并调用 `col.*` 的桩实现，再生成 DDL 并在空库执行——这一步会一次性暴露上述全部缺陷（以及 §1 白名单逃逸）。同时：① `baseline` 改 `defaultSql("'{}'")`；② 修复 §6.3 的标题/围栏/`\n`，并**明确 `traceId` 是否为 `ag_actions_log` 的列**；③ 按 10 §R7 把 `ag_evaluations`/`ag_audit_log` 的 PK 改为 `(id, createdAt)`（或声明"不设主键 + 唯一索引 (id, created_at)"）；④ 把 `ag_checkin_entitlements` 从 blockquote 里提出为正式声明。
- **严重度**：**高**
- **我会卡在哪一步**：`packages/db` 的第一个集成测试：生成 `CREATE TABLE ag_user_policy_state (... baseline jsonb NOT NULL DEFAULT {} ...)`，PG 报 `syntax error at or near "}"`。我打开 02 §6.1 核对，发现是文档里的声明写错了——而"禁止手写 DDL"意味着我**必须回去改文档**，这在流程上不属于实现者的权限。

---

### 第二部分附 · 次级清单（12 条，均为 10/11/14 未覆盖或未落地）

| # | 问题 | 位置 | 我会卡在哪一步 | 严重度 |
|---|---|---|---|---|
| S-1 | `ag_plugins` 主键为 `id`（`col.varchar(64).primaryKey()`），无法容纳"同一 id 多版本并存"；`ag_plugin_status` 枚举无 `retired` | 02 §4.1 vs 03 §1.12 / 06 §5.4.2 | 写 `installPlugin()` 的 upsert：同一 id 装 v1.1 时是 INSERT 新行还是 UPDATE 旧行？两处文档两种答案，且 `retired` 落不进枚举 | 高 |
| S-2 | `ag_plugin_configs`（varchar pluginId + version，无任何作用域列、不在两份白名单）与 `ag_plugin_instances`（02 §3.8「配置与实例共用一张表」）是**两个配置权威** | 02 §4.2 vs §3.8、03 §1.19.2 | 写 `resolvePluginConfig(pluginId, siteId)`：先查哪张表？06 §5.4 的 `/admin/plugins/:id/config/versions` 又更新哪张？ | 高 |
| S-3 | `ag_policy_assignments` 无 `siteId` 且不在任何白名单，但它是策略域数据（灰色发布 `rolloutPercent` 按 userId 哈希） | 02 §5.2、02 §1 | 写 `loadAssignments(policyId)` 时无法加站点条件；跨站点同一`targetRef`会串 | 高 |
| S-4 | `09 §2.5` 的 `probe()` 返回 `create: false`，而 §2.2 manifest 声明 `capabilities.create: true` → 05 §4.4 要求"声明与实测不一致必须显式告警" → 内置 provider **每次全量周期都告警一次** | 09 §2.2 vs §2.5、05 §4.4 | 写 `probeProvider()` 的 diff：我照 §2.5 写还是照 §2.2 写？两边都在同文档 | 中高 |
| S-5 | GitHub 采集模板的变量是 `"{{ config.totalStarsMode == 'exact' ? 100 : 100 }}"`（三元两支同值 = 无操作），且 `top100`/`exact` 声明的差异（分页遍历）在 manifest 里**没有任何 `collect.pagination` 声明**；模板表达式语言（是否支持 `==`/`?:`）在 03 §1.7 只列了 `{{ secrets.* }}`/`{{ binding.* }}`/`{{ config.* }}`/`{{ user.* }}` | 09 §4.2、03 §1.7 | 写 declarative 解释器的模板求值：我要不要实现运算符与三元？不实现则示例是死代码，实现则语言规格要我自己定 | 中高 |
| S-6 | 07 M1-3 要求交付 `newapi-provider`，但 09 §2.2 声明 `runtime: process`，而 process 运行时是 M4-1 | 07 §3 M1/M4 | 排期表第二步就无法满足：M1 要么用 in-process 写一个与 09 §2.2 不一致的 provider，要么等 M4 | 高 |
| S-7 | 事件目录有 4 个来源且命名分隔符不统一：06 §7.1（7 个，`policy.granted`/`checkin:granted`）、05 §4.3（`subject.*`）、05 §2.2（`binding.revoked`）、05 §7.1.2（`assertion.revoked`） | 03 §1.15 / 05 §2.2/§4.3/§7.1.2 / 06 §7.1 | 写事件类型注册表与 `events:subscribe:<type>` 权限解析器：`checkin:granted` 与 `policy.granted` 是两种词法，我的匹配器要同时吃点和冒号 | 中高 |
| S-8 | 05 §7.1.2 承诺的 `ag_event_outbox` / `ag_dead_letters` 在 02 **不存在**；06 §5.5 也没有 05 指定的"死信列表与重放入口" | 05 §7.1.2 / 02 / 06 §5.5 | 写"至少一次投递"的持久化：没有表就没有同事务写入点，我只能自己造一张表并违反"02 是唯一 schema 权威" | 高 |
| S-9 | 06 §1「所有写操作接受 `Idempotency-Key` 头」，但全文档没有 HTTP 级幂等键的存储、冲突语义（同键不同体？）、有效期 | 06 §1 | 写 `POST /admin/users/:id/link` 的幂等中间件：键存在哪？与 05 §3.0.1 的动作幂等键是什么关系？ | 中高 |
| S-10 | 插件端点的 `X-Signature-256` HMAC（03 §1.13.2）没有**规范签名串**；只有协同协议的 `X-Gate-Signature` 定义了拼接式（06 §7.2.2） | 03 §1.13.2 / 06 §7.2.2 | 写 webhook 校验器：我要拿哪些字段、什么顺序、`bodyHash` 大小写？只能自己定，然后与外部对接方各定一套 | 中高 |
| S-11 | 03 全文的交叉引用指向**不存在的 §2.x**（§2.13/§2.14/§2.16/§2.17 等 15+ 处），09 §3 开头也写"设计规范见 03 §2"；03 实际只有 §1.1–§1.19 | 03 §1.13/§1.14/§1.16/§1.17、09 开头 | 追查"端点的六项职责/协同协议"时被指到空章节；我必须靠关键字反查 | 中 |
| S-12 | `ag_invocations.op` 的取值集不一致（02 §4.6 注释：collect/enrich/execute/bind/refresh/health；03 §1.13.5 要求 `op='endpoint'`；03 §1.17.7 要求 `op='action.invoke'`），且 07 M1-5 验收要求"白名单外域名与内网地址被拒"却没有对应的 `op` 值 | 02 §4.6 / 03 §1.13.5 / §1.17.7 | 写 `recordInvocation({op})` 的枚举常量：三处三个集合，我取并集则 `op` 语义发散，取交集则丢失端点与插件间调用的审计 | 中 |

---

## 第三部分 · 开工可行性判定

### 1. 现在可以开工 M1 吗？

**不可以直接开工 M1（但可以立刻开工 M0）。**

判定依据不是"设计还不够好"，而是三条**可验证的阻塞**：
- 07 M1-3 要交付的 provider 插件其运行时（`process`）属于 M4-1（S-6）；
- M1-2「通用对账器」的三个输入（能力字段/指纹字段/降级路径）无权威定义（#6）；
- M1-8「表达式引擎最小版（路径寻址）」依赖寻址与绑定契约（#7），而 11 §14.6 自己把它列为"做完才动 M1"的冻结项，至今 ⏳。

M0（12–15 人日）**不受这三条影响**，其验收对象（`defineTable`/查询编译/注入+fail-closed/单一事务入口/CI 门禁）在 07 M0-1..M0-11a 里是明确的；M0-11a 的"后补 RLS 改动文件数 ≤ 3"也已经是可判定的 spike。

### 2. 最小清单（先补 7 项，≈15 人日；可与 M0 并行，不占关键路径）

| # | 要补什么 | 交付物 | 人日 |
|---|---|---|---|
| F1 | **动作执行契约冻结**：幂等键补 `stepSeq`、写回载荷唯一权威（`provider.patchSubject`）、`reason` 的归属、`restore` 的剩余档位来源 | 05 §3.0.1/§3.1/§3.5 定稿 + 09 §3.1 示例同步 | 2 |
| F2 | **对账器契约冻结**：`ProviderPlugin.sync`（primaryKey/order/supportsCursor/pageSizeMax）、指纹字段单源、降级路径二选一、全量同步中途失败时 `deleted` 的判定 | 03 §1.16.2 + 05 §4.1/§4.2 定稿 + 09 §2.3 同步 | 2 |
| F3 | **02 Schema 可编译化 spike**：跑一次声明→DDL→空库；修 `baseline` 默认值、§6.3 结构、分区表 PK、`ag_sessions` 三列、白名单三分（含 `ag_plugin_instances`/`ag_provider_sync_state`） | 02 修订 + 30 行 spike 脚本 | 3 |
| F4 | **宿主 API v1 冻结**：`config.get({instanceKey})`、`actions.invoke`、锁的唯一键域、`secrets` 生命周期、权限字符串、与 JSON-RPC 方法名映射 | 新契约文件 `gate.host/v1` + 03 §1.5 同步 | 2 |
| F5 | **表达式求值契约冻结**：依赖收集的时机（惰性 vs 预取）、`score` 的三值公式、`$ttl` 优先级、类型强制（coercion）表、`none/atMost/exactly` 三值补全 | 04 §1.5.1/§1.10 定稿 | 3 |
| F6 | **绑定解析与寻址冻结**：`instanceKey` vs `siteSlug` 分槽、`binding` 入 root、`boundAt/age_days` 映射、固定 ref 全集 | 04 §1.2.7 + 02 §4.4/§7.9 同步 | 1.5 |
| F7 | **范围裁决**：M1 的 provider 用什么运行时（建议 M1 允许 `in-process` 官方插件，把「第三方进程隔离」留到 M4）；图形编辑器是否砍（第 9 代建议砍，07 §4 仍列 F3 为独立工程）；Q1/Q4/Q11 | 07 §7 单一工期口径 + §8 决策记录 | 1.5 |
| | **合计** | | **≈15** |

> **关键结论**：F1–F7 合计 ≈15 人日，与 M0 的 12–15 人日**同量级**。也就是说，只要**并行开工 M0**，这 7 项冻结不会延长关键路径（M0 完成时 F1–F7 也应完成）；反之若先补 F 再开 M0，关键路径会被拉长约 15 人日。这是我建议的**唯一正确顺序：M0 立即开，F1–F7 与 M0 并行**。

### 3. 若坚持立即开工 M1（不做冻结），可接受的风险与不可接受的风险

**可接受的**（有兜底、可回滚、影响面可枚举）：
- `explain` 模式的事实不全（#2）——用户看到"unknown"而非错误结论，且 `fail_closed` 保证不误升级；
- 对账器只用"升序全量 + 水位"（#6 的一种选择）——成本高但语义正确，M6 再优化；
- 09 §2.5 的 `create` 不一致告警（S-4）——噪音，不影响正确性。

**不可接受的（会导致静默错误 / 不可逆副作用）**：
- #5 的写回载荷（可能抹掉 `oidc_id`，**不可逆**，且断链后对账会长期震荡）；
- #1 的幂等键（重复执行 `set_group` = 多踢一次会话；重复 `add_quota` = 真金白银）；
- #3 的 `session.activeSiteId` 缺失（跨站点静默污染，02 §1 自认"不报错"）；
- #9 的白名单谓词（`db:check` 要么启动失败，要么根本没在跑——后者等于隔离门禁不存在）。

---

## 第四部分 · 最强与最弱

### 1. 最出色的一个决策

**D1 + D5 合起来的那一条：把「下游系统」也做成插件（provider），并用「删除 `plugins/builtin/` 后主程序仍能启动 + 核心 grep `newapi` = 0」作为硬性验收**（03 §1.16、03 §1.9、07 M4-17、D5）。

理由：这是全文档**唯一一条同时满足"改变产品形态"与"有机械可执行判据"的决策**。它把项目从"new-api 附属工具"变成通用引擎，而它的正确性不靠论证——删掉目录还能启动、grep 为 0 就是为 0。我作为实现者能把它写成 CI 门禁（`grep -r "newapi\|new-api" packages/core && exit 1`），并且它反过来约束了所有接口的形状（`ExternalSubject` 属性袋、`listSubjects` 契约、`subject.*` 寻址），使我要写的核心代码里**没有任何一个具体系统的分支**——这在实际编码中省掉的复杂度远大于它带来的抽象成本。

> 需要同时指出：这条决策的**验收尚未通过**（基线第 4 条的宿主无知残留未修），但那是**未完成的修复**，不是决策错误。

### 2. 最危险的一个决策

**D17「站点级 RLS 推迟」，但没有把 D16/README/01 §5.5/08 §13 S5 里"已采纳双层强制"的表述一并撤回。**

理由：这不是"选错方案"，而是**安全属性在五处被宣称、在零处被强制**。
- 01 §5.5 至今写着两道防线、给出 `FORCE ROW LEVEL SECURITY` 的 DDL、并声称"即使业务代码有 bug 或有人写了裸 SQL，也读不到别的站点数据"；README 的 D16 行写"站点隔离双层强制"；08 §13 S5 写"已决：单库 + 行级隔离 + RLS"；CHANGELOG D16 写"✅ 采纳"。只有 D17 与 07 说推迟。
- 更危险的是：**推迟之后，唯一的防线是应用层注入，而注入的取值来源 `ag_sessions.activeSiteId` 在 02 里不存在**（#3）。于是真实状态是"零道防线"，而文档在四处宣称两道。
- 这条正是本项目自己的方法论判定的最高危形态：11 §14.2「四场裁决自己也有承载物缺失」+ 11 §12.2「不可判定的短语比错误更危险」。D17 的裁决理由（"站点隔离当前是数据卫生而非安全边界"）在**单站点场景**成立，但它没有说明"多站点 SaaS 开启后谁负责把这条防线补回来"——而 08 §11 承诺 `saas` 可被 admin 一键打开（无需迁移、无需重启）。

### 3. 如果只能改一处

**改 02：把「Schema 声明 → DDL → 空库」这条链真正跑通一次，并把它变成 M0 的出口条件（不改任何设计，只加 0.5 人日的 spike + CI）。**

理由：这一处能一次性暴露我在本报告中给出的**最大一批**问题，而且是**机器发现、不靠人读**：
- `defaultSql("{}")` → PG 语法错误（#10）；
- 分区表 PK 不含分区键 → `CREATE TABLE` 失败（#10，10 §R7 已给结论）；
- `ag_sessions` 缺三列 → 06/08 的会话与作用域代码编译不过（#3）；
- 白名单谓词真跑 → `ag_plugin_instances`/`ag_provider_sync_state` 立即失败（#9）；
- 唯一键引用未声明列 / 表不在任何白名单 → 直接列出（#9、S-2、S-3）。

它的性价比最高：**成本 0.5 人日 + 一个 CI job，收益是把"文本自洽"升级为"结构可执行"**——这正是 11 §12.5 承认的、本项目尚未跨过的那一步（"推演本身已收敛，但设计尚未收敛"）。

---

## 附录 · 我明确「无法判断」的事项（缺什么）

| 事项 | 为什么无法判断 | 需要什么才能判断 |
|---|---|---|
| RLS 到底要不要在 M0 建 | D16/D17/01 §5.5/08 §13 S5/README 五处并存，无"后者的优先级"规则 | 一次显式裁决：D17 是否**取代** D16，并要求撤回 01 §5.5/08 §13 S5/README 的表述 |
| `score` 节点在旧策略迁移中的实际使用率 | 04 §1.9 的迁移映射表把 `weighted` 指向 `score`，但没有真实旧策略样本 | 一份现有的 `mode: weighted` 策略样例（含 threshold 与权重） |
| 对账 10 万主体 < 5 分钟是否可达 | M1-2 的验收与 05 §4.2 的降级路径（逐页探测）冲突；09 §2.7 的"实测约 1 分钟"没有给出测量环境（页大小/退避/网络） | 一次针对真实 new-api 的压测（07 §9 的 3 天 Spike 只覆盖 PAT/踢人/字段，不含对账吞吐） |
| 09 §2.5 `probe()` 的 `update: tryGet('/api/user/1')` 能否证明写权限 | 用 GET 推断 PUT 权限，作者自己也写了"真正写时再校验" | new-api 的权限模型说明，或一次真实的 PUT 探测 |
| `ag_audit_log` 的容量估算 | 02 §10 自己标注"★ 口径待实测：02 §10 与 10 §Q6 相差 20–50×" | 实测量（每用户每日审计条数） |
| dev/enduser 的 OIDC 会话如何隔离到不同 Cookie Path | 08 §5.4 的 `Path=/console,/admin` 不是合法语法 | 一次设计确认：用 `realm` 判定还是两条 Cookie |
