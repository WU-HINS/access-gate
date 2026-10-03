# 08 · SaaS 站点化与身份域

> 需求原话：
> - **"admin 也能用 OIDC，admin 本身也是开发者。"**
> - **"项目使用站点化概念：开发者 : {唯一站点ID(站点昵称)}。"**
> - **"用户选择是先选择开发者，再选择站点。每个站点的插件配置唯一，按现有实现就是只能写一个目标平台，如单个 new-api。"**

---

## 1. 整体形态

```
┌──────────────────────────────────────────────────────────────────────────┐
│  控制平面（Control Plane）—— 平台运营者 【admin 角色】                     │
│  开发者管理 · 站点管理 · OIDC 注册（唯一来源）· 插件安装 · SMTP · 网络      │
├──────────────────────────────────────────────────────────────────────────┤
│  站点平面（Site Plane）—— 开发者 【developer 角色】                        │
│   开发者 A                                                            │
│     ├── 站点 A1 (siteId: a1, 昵称: 主站)   ← 插件配置唯一 · 策略 · 主体    │
│     └── 站点 A2 (siteId: a2, 昵称: 测试站)                                │
│   开发者 B                                                            │
│     └── 站点 B1 (siteId: b1, 昵称: 社区)                                  │
├──────────────────────────────────────────────────────────────────────────┤
│  用户平面（User Plane）—— 终端用户 【enduser】                            │
│   先选开发者 → 再选站点 → 查看该站点下的资格 / 绑定 / 签到                  │
└──────────────────────────────────────────────────────────────────────────┘
```

**平台模式可切**：`standalone` 与 `saas` 由 **admin 在平台设置中切换**（不是硬编码的部署参数），两者共用同一套数据模型，切换无需迁移、不删数据（详见 §11）。

---

## 2. 核心层级：开发者 → 站点

```
Developer（开发者账号）
  developerId    开发者唯一标识
  displayName    展示名
  role           admin | developer        ← ★ admin 只是 developer 的特权角色
  email          强制绑定并验证

    └── Site（站点）★ 隔离边界 + 配置单元
          siteId      唯一站点 ID（slug，用于 URL 与寻址）
          nickname    站点昵称（展示用）
          status      启用 / 停用
          quota       配额
            ├── 插件配置（每个插件唯一一份）
            ├── 策略与阶梯
            ├── 主体与绑定
            ├── 动作与审计
            └── 用户侧可见的资格 / 签到
```

| 关系 | 基数 | 说明 |
|---|---|---|
| Developer → Site | **一对多** | 一个开发者可以建多个站点（主站 / 测试站 / 子项目） |
| Site → 插件配置 | **一对一（每插件）** | ★ 见 §4 |
| EndUser → Site | 隐式 | 用户是平台级的，通过"选择"进入某站点上下文 |

---

## 3. 两个身份域（不是三个）

| 域 | 谁 | 登录方式 | 说明 |
|---|---|---|---|
| `developer` | **开发者，含 admin** | 开发者 OIDC（admin 配置，不可注册，需先绑定） | admin 是 `role=admin` 的开发者 |
| `enduser` | 终端用户 | 普通用户 OIDC（admin 配置） | 可自动建号（可配置收紧） |

> **admin 也走 OIDC，admin 本身也是开发者**——OIDC 提供方是受信任的平台，无需为 admin 另立一套认证体系。

### 3.1 admin 的特权如何体现

同一个 OIDC、同一个登录入口，**仅靠角色区分**：

```
开发者 OIDC 登录成功
   ↓
查 developer 账号
   ├─ role = developer → 建立会话 → 进入 /console（只能看自己的站点）
   └─ role = admin     → 建立会话 → 直接解锁 /admin 平台控制台
```

> **认证强度由 OIDC 保证**：OIDC 提供方是**受信任的平台**（由 admin 亲自配置），其自身已具备认证强度与风控能力。平台**不再叠加二次验证**——避免把"日常以开发者身份工作"与"进入平台控制台"割裂成两套流程。

| 能力 | admin 角色 | developer 角色 |
|---|---|---|
| 访问 `/admin/*` 平台控制台 | ✅ | ❌ |
| 查看 / 管理**所有**开发者与站点 | ✅ | ❌ |
| 安装 / 卸载插件 | ✅ | ❌ |
| 注册 OIDC（唯一来源） | ✅ | ❌ |
| 系统设置（SMTP / 网络 / MFA） | ✅ | ❌ |
| 创建站点、邀请开发者 | ✅ | ❌ |
| 管理**自己的**站点（策略 / 插件配置 / 主体 / 审计） | ✅ | ✅ |

---

### 3.2 账号模型：账密 / OIDC + 唯一用户名（可变）

**开发者（含 admin）与普通用户同构**：

| 字段 | 可变 | 说明 |
|---|---|---|
| `id`（UUID） | ❌ **永不变** | **身份锚点**——会话、绑定、审计、策略引用全部指向它 |
| `username` | ✅ 可改 | **唯一**；登录与展示用 |
| `email` | ✅ 可改 | **唯一**；通知、找回、OIDC 匹配用 |
| `passwordHash` | ✅ 可改 | **可选**；与 OIDC 可**并存** |
| OIDC 绑定 | ✅ 可增删 | 一个账号可绑定多个 IdP |

**登录方式（两者都支持，可并存）**：

```
① 用户名 + 密码
② OIDC（按 realm 区分：开发者 OIDC / 普通用户 OIDC）
③ 两者都配 → 任选其一登录
```

**"用户名可变"带来的设计要求**（容易踩坑）：

| 要求 | 做法 |
|---|---|
| 身份锚定 `id` | 会话、绑定、审计、令牌一律引用 `id`，**绝不引用 username** |
| URL 不用 username | 路由用 `id` / `siteId`；否则一改名就断链 |
| 改名校验唯一 | 唯一索引 + 冲突检查，失败给出明确提示 |
| 审计记快照 | 审计同时记 `actorId` 与**当时的 username**（便于人读） |
| 改名写审计 | `account.rename` 事件，记录旧名 → 新名 |
| 会话不受影响 | 因锚定 `id`，改名后现有会话继续有效，**无需重新登录** |

**OIDC 与已有账号的关联规则**（防账号劫持）：

```
OIDC 回调
   ↓
① 该 (ref, sub) 已绑定  → 直接登录对应账号
② 未绑定 → 按 email 匹配已有账号
     ├─ 匹配到且 email_verified=true → 提示"绑定到已有账号？"
     │     用户确认后绑定；【开发者侧】还需已入驻，否则拒绝
     └─ 未匹配到 → 开发者：❌ 拒绝（需邀请码入驻）
                   普通用户：按注册策略建号，或拒绝
```

**开发者额外规则**：`passwordHash` 为空**且**未绑定 OIDC 的账号无法登录——入驻流程**强制至少配置一种**登录方式，避免"邀请后卡死"。

---

## 4. 站点 = 隔离边界 + 配置单元

### 4.1 插件配置：由插件自己声明作用域与实例

> **实例维度由插件声明**（**不是平台强制"站点内唯一"**）：凭据类插件共享一份，目标类插件按站点独立，webhook 类插件可多例。详见 03 文档 §1.19。

| 声明（manifest） | 含义 | 典型插件 |
|---|---|---|
| `config.scope: developer` + `instances.mode: singleton` | 一个开发者一份，**所有站点共享** | GitHub App 凭据、LLM Key、SMTP |
| `config.scope: site` + `instances.mode: singleton` | **每个站点一份** | newapi-provider（各站点指向不同 new-api） |
| `config.scope: site` + `instances.mode: multi` | 每个站点多份 | webhook 接收器、bot 适配器 |
| `config.scope: developer` + `instances.mode: multi` | 一个开发者多份 | 多个 LLM 供应商 |

**默认**：`developer` + `singleton`（最省事，适合大多数凭据型插件）。

**对寻址的影响**（04 文档 §1.2.7）：

```yaml
fact:github.total_stars           # developer 级 singleton —— 不带 @
subject:newapi.group              # site 级 singleton —— 不带 @
fact:webhook@orders.event_count   # site 级 multi —— 必须带 @instanceKey
```

**收益**：

1. **凭据类只配一次**（GitHub、LLM）——避免每个站点重复填 secret，也避免 secret 散落多份；
2. **目标类按站点独立**（newapi-provider）——符合"每个站点接一个目标平台"；
3. **多实例场景也支持**（多 webhook、多 bot 适配器）——由插件按需申请。

### 4.2 数据隔离边界 = 站点

| 表类别 | 作用域 |
|---|---|
| `ag_policies` / `ag_evaluations` / `ag_user_policy_state` / `ag_actions_log` | **站点级** |
| `ag_external_subjects` / `ag_plugin_bindings` / `ag_plugin_facts` | **站点级** |
| `ag_plugin_instances` | **跨作用域**（developer 级共享 / site 级独立，由插件声明） |
| `ag_developers` / `ag_sites` / `ag_plugins` / `ag_oidc_providers` | **平台级**（无 siteId） |

---

## 5. 入驻与登录

### 5.1 开发者入驻（邀请码，一次性 + 1h TTL）

```
① admin 生成邀请码
     POST /admin/invitations
     { "targetEmail": "dev@corp.com", "ttl": "1h", "uses": 1,
       "siteMode": "auto" | "existing", "siteId": null }
     → { "code": "DEV-7F3A-K92M", "expiresAt": "…" }

② 开发者打开 /console/join?code=DEV-7F3A-K92M

③ 校验：存在 · 未使用 · 未过期(≤1h) · 邮箱匹配

④ 跳转【开发者 OIDC】授权（ref = platform:developer）

⑤ 回调 → 取 sub/email → 写 ag_identities

⑥ 【强制绑定邮箱】必须验证通过

⑦ 创建 developer 账号；按 siteMode 自动建默认站点或加入指定站点

⑧ 邀请码原子核销（UPDATE … WHERE used_at IS NULL）
```

### 5.2 "不可注册，需绑定后才可登录"

```
开发者 OIDC 登录回调
   ↓
查 ag_identities(provider='identity:oidc@platform:developer', providerUserId=sub)
   ├─ 命中且账号启用 → 建立会话
   └─ 未命中         → ❌ 拒绝："此身份尚未入驻，请使用管理员发放的邀请码完成入驻。"
```

### 5.3 普通用户登录

统一 OIDC（ref = `platform:enduser`）→ 首次自动建号（可配置为需邀请 / 域名白名单）→ 进入 `/me`。

### 5.4 两套链路隔离

| | 开发者（含 admin） | 普通用户 |
|---|---|---|
| OIDC ref | `platform:developer` | `platform:enduser` |
| 注册 | ❌ 仅邀请 + 绑定 | ✅ 可自动建号 |
| 会话 Cookie | `ag_dev_session`（Path=/console,/admin） | `ag_user_session`（Path=/） |
| `ag_sessions.realm` | `developer` | `enduser` |

---

## 6. 用户路径：先开发者，再站点

```
用户登录 /login
   ↓
/me                                   ← 门户首页
   ├─ 选择开发者                       ← 第一级
   │    开发者 A   （3 个站点）
   │    开发者 B   （1 个站点）
   │    …
   └─ 选择站点                         ← 第二级
        站点 A1 · 主站
        站点 A2 · 测试站
        …
   ↓
/me/:developerId/:siteId              ← 站点上下文
   ├─ 我的资格（策略进度 + 结果树）
   ├─ 身份绑定（该站点要求的渠道）
   ├─ 每日签到（若该站点启用）
   └─ 权益记录
```

会话中记录 `activeDeveloperId` + `activeSiteId`，顶部提供**两级切换器**。

**用户是平台级的**（不做站点成员关系）：通过选择进入某站点上下文，只看到该站点的数据。**站点之间互不可见**——站点 A1 的开发者看不到用户在 A2 或 B1 的任何状态。

---

## 7. 站点作用域的强制注入（★ 安全关键）

```ts
// ① 请求进入 → 解析会话 → 建立站点作用域
ctx.scope = { realm, developerId, siteId: session.activeSiteId, actorId };

// ② Repository 自动注入站点条件
await ctx.db.select(policies).where(eq(policies.enabled, true)).run();
//   SELECT … FROM ag_policies WHERE enabled = $1 AND site_id = $2
//                                                      ^^^^^^^^^^^ 由层注入

// ③ 无站点作用域的业务查询 → 抛错（fail-closed）
//   MissingSiteScopeError

// ④ 跨站点操作必须显式声明
await ctx.db.select(sites).crossSite({ reason: 'developer console' })
//   developer 角色：仅限自己名下的站点
//   admin 角色：全部站点，且写审计
```

**三条硬规则**：业务代码不得手写 `site_id`；无作用域的查询抛错（不是返回空）；`crossSite()` 按角色收敛并审计。

**fail-fast**：`siteScoped: true` 的表缺 `site_id` 列 → `db:check` **启动失败**。

---

## 8. admin 系统设置清单

| 分类 | 项 |
|---|---|
| **身份** | 开发者 OIDC · 普通用户 OIDC · **OIDC 注册表（唯一来源）** · 会话策略 · 登录告警 |
| **平台模式** | `standalone` / `saas` 切换（含数据影响提示与审计） |
| **入驻** | 邀请码生成 / 吊销 / 列表 · 普通用户注册策略 · 邮箱域名白名单 |
| **开发者** | 开发者列表 · 提升 / 降级 admin · 禁用 / 删除 · 重置绑定 · 重置会话 |
| **站点** | 站点列表（全部） · 配额 · 停用 / 归档 |
| **普通用户** | 用户列表 · 禁用 / 删除 · 查看其站点上下文 |
| **通信** | SMTP（邀请 / 验证 / 告警） |
| **网络** | 出站白名单 · 代理 · 限速 · IP 允许/拒绝 · SSRF 防护 |
| **插件** | 安装 / 卸载 / 启用 / 禁用 · 权限授予 · 信任确认 · 来源策略 |
| **审计** | 全局审计 · 导出 · 保留策略 |

---

## 9. 前端与 URL

```
/                            平台门户
/login                       普通用户 OIDC 登录

/me                          用户门户（会话 ag_user_session）
  ├── /me/developers         选择开发者
  ├── /me/:devId/sites       选择站点
  └── /me/:devId/:siteId/*   站点上下文（资格 / 绑定 / 签到 / 权益）

/console/*                   开发者控制台（会话 ag_dev_session）
  ├── /console/join          邀请码入驻
  ├── /console/sites         我的站点列表
  └── /console/:siteId/*     站点内：策略 / 插件配置 / 主体 / 动作 / 审计

/admin/*                     平台控制台（同 ag_dev_session，role=admin 可直接访问）
  ├── /admin/developers      开发者管理
  ├── /admin/sites           站点管理
  ├── /admin/invitations     邀请码
  ├── /admin/oidc            OIDC 注册（唯一来源）
  ├── /admin/plugins         插件安装与信任
  ├── /admin/users           普通用户管理
  ├── /admin/settings        系统设置（SMTP / 网络 / 安全）
  └── /admin/audit           全局审计
```

---

## 10. 审计

每条记录带 `realm` + `developerId` + `siteId`：

| 操作者 | 可见范围 |
|---|---|
| admin | 全部 |
| developer | 自己名下站点 |
| enduser | 自己的操作 |

敏感读取（如查看主体 OIDC 原值）同样写审计。

---

## 11. 平台模式：admin 在平台设置中切换

`SAAS_MODE` **不是写死的部署参数，而是平台设置项**（`/admin/settings/platform`）：

- **首启向导**里设定初始值；环境变量 `SAAS_MODE` 仅作为**首次启动的默认值**；
- 之后由 **admin 在 UI 随时切换**，无需改配置文件、无需重启；
- 存储：`ag_platform_settings`（**DB 为准**），环境变量只提供初始值。

### 11.1 两种模式的行为差异

| 维度 | `standalone` | `saas` |
|---|---|---|
| 站点概念 | 隐藏；只有内置默认站点 | 开发者可建多个站点 |
| 开发者入驻 | 关闭（只有内置开发者） | 邀请码入驻 |
| 用户门户 | 无两级选择，直达资格页 | 先选开发者 → 再选站点 |
| 开发者控制台 | 隐藏 | 可见 |
| 数据归属 | 全部在默认站点 | 按站点隔离 |
| **数据模型** | **完全相同**（站点字段始终存在） | 同左 |

> **关键**：两种模式**共用同一套数据模型**。`standalone` 只是"隐藏站点 UI + 关闭入驻入口"，不是另一套 schema——所以切换**不需要迁移**。

### 11.2 切换流程

**standalone → saas**

```
① 二次确认（输入 ENABLE SAAS）
② 自动确保存在：内置开发者（admin 账号本身）+ 默认站点
③ 存量数据本就在默认站点下，无需迁移
④ 写审计（谁、何时、从什么切到什么）
⑤ 立即生效，无需重启
```

**saas → standalone**

```
① 二次确认；若已有多个开发者 / 站点 → 【强警告】并列出数量
     "当前有 4 个开发者、7 个站点。切换到 standalone 后：
        · 站点 UI 与开发者控制台将被隐藏
        · 不再允许创建站点或邀请开发者
        · 【不会删除任何数据】，重新开启后原样恢复"
② 仅隐藏 UI + 关闭入驻入口
③ 【不删除任何数据】
④ 写审计
```

**安全设计**：降级到 standalone **绝不删除数据**，`saas ⇄ standalone` 完全可逆。

### 11.3 为什么不做成纯环境变量

| 理由 | 说明 |
|---|---|
| 需求明确 | "admin 可以更改系统设置"——模式属于系统设置 |
| 切换成本极低 | 两种模式数据模型相同，只是 UI 与权限开关 |
| 自部署体验 | 装完即可在界面决定是否开放对接，不必改配置文件重启 |
| 可逆 | 随时可回退，数据无损 |

### 11.4 环境变量作为初始值与锁定

```yaml
platform:
  mode:
    initial: standalone | saas     # 仅首次启动生效，随后写入平台设置
    locked: false                  # true 时 UI 只读（强合规 / 托管场景）
```

| 配置 | 行为 |
|---|---|
| `initial` | 首次启动写入 `ag_platform_settings` 的 `platform.mode`；此后不再读取 |
| `locked: true` | 该设置项在 UI 上只读，并提示"由环境变量锁定" |

**这是平台设置的通用机制**（DB 为准 → 环境变量提供初始值 → 可选锁定），适用于 SMTP、网络、OIDC 等所有设置，不只是 `SAAS_MODE`。

---
## 12. 与既有设计的衔接

| 既有设计 | 在站点化下的变化 |
|---|---|
| 统一寻址（04 文档 §1.2.7） | `@instanceKey` 仅在插件声明 `instances.mode: multi` 时必需；跨站点引用用 `#<siteSlug>` 且默认禁止 |
| 插件体系（03 文档 §1） | **安装权归 admin**；开发者只配置**本站点**的插件参数（每插件一份） |
| OIDC 双向联邦（03 文档 §1.18） | `platform:developer` 与 `platform:enduser` 两个固定 ref；站点不得新增 |
| 策略与判定（04 文档 §1–§5） | 策略、评估、状态机、动作全部**站点级** |
| 跨项目协同（03 文档 §1.14） | 调用方（`verify_clients`）归属站点；断言只覆盖该站点数据 |
| 数据模型（02 文档） | `ag_tenants` → **`ag_developers` + `ag_sites`**；业务表 `tenant_id` → **`site_id`** |

---

## 13. 待确认

| # | 问题 | 备选 |
|---|---|---|
| S1 | 一个开发者可建几个站点 | **多个（默认）** / 仅 1 个 |
| S2 | 站点 `siteId` 由谁定 | 开发者自填 slug（默认，需唯一）/ admin 分配 / 系统生成 |
| S3 | 普通用户能否自建站点 | 不能（默认）/ 能（自动升级为开发者） |
| S4 | 普通用户注册策略 | 开放（默认）/ 需邀请 / 邮箱域名白名单 |
| ~~S5~~ | ~~数据隔离强度~~ | **已决：单库 + 行级隔离 + RLS**（应用层注入 `site_id` + 数据库 `FORCE ROW LEVEL SECURITY`）。若未来出现强合规要求（金融 / 医疗客户），可演进为"每站点独立 schema"（连接池按站点路由）或"独立库"——**应用层接口不变**，只换连接解析策略 |
| S6 | 站点的插件配置是否允许"多实例"（当前：站点内每插件唯一，需要两个目标就建两个站点） | 保持唯一（默认）/ 允许站点内多实例 |
