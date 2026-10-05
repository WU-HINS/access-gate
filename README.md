# access-gate · 通用信任引擎

一个**插件化**的「信任判定与授予」引擎：把「谁（主体）」+「依据（事实）」+「规则（策略）」+「结论（授予）」
四件事解耦成四个抽象，具体系统（站点、渠道、身份提供方）全部通过插件接入 —— **核心代码里不出现任何具体系统名**（CI 第 7 项门禁扫描）。

> **设计文档是唯一事实来源**：`docs/` 是规格，`reports/` 是**实测证据**。
> `src/schema/` 的表声明由 `tools/extract-doc-schema.ts` **从 `docs/02-数据模型.md` 提取生成**（不手抄 —— 手抄必然静默漂移），
> 提取器对每处文档缺陷修复都**断言命中行号**，文档被改动后会立即报错。
>
> ★ **本文件中的所有数字都由命令实测得出**（见「怎么验证」）。上一版 README 的数字是手写的，
> 已经漂移到「把已实现的能力写成尚未实现」的程度 —— 所以这里改为**数字必须可复跑**。

---

## 快速开始

```bash
npm ci                                   # 依赖：typescript / pg / pglite / embedded-postgres

# ① 跑一遍门禁（最省事的"它还活着吗"）
npm test                                 # 1496 个用例
npm run ci                               # 13 项门禁
npm run verify:all                       # 场景 A → 真实 PG e2e → 路径探针 → 巡检存活 → 短长跑

# ② 二进制冒烟（起真实 PG → 迁移 → 起服务 → 探活 → 清理；不依赖 Docker）
node --experimental-strip-types tools/dev-smoke.ts

# ③ 看看它长什么样（DEMO：内置假 IdP + 内存数据，零外部依赖）
node --experimental-strip-types tools/serve.ts
#   地址    : http://127.0.0.1:8787
#   模式    : DEMO（内置假 IdP + 内存数据）
```

DEMO 模式下打开首页，点「alice@tsinghua.edu.cn（教育邮箱）」，看到的是**判定过程而非结论**（以下是**逐字实测输出**）：

```
【教育邮箱解锁签到】已达成
  ✅ 教育邮箱
  ✅ 邮箱已验证
  → 将执行：checkin:grant

【每日签到】未达成
  ❌ 尚未解锁签到

【GitHub 贡献者】待确认
  ❓ GitHub 总 star 数 ≥ 100（关键事实缺失，请稍后重试或完成绑定）
  → 不执行任何动作（无法判定时不推进状态）

进度：1 / 3 条策略已达成
待完成：尚未解锁签到；GitHub 总 star 数 ≥ 100
```

换成 `alice@gmail.com`，会看到**差在哪一项**并如实回退到默认分组：

```
  ❌ 教育邮箱（当前 "gmail.com"，需要 ["*.edu.cn","*.edu","*.ac.uk"]）
  → 将执行：newapi-set-group:set_group
```

★ 最后一段（`❓ … 关键事实缺失 … → 不执行任何动作`）是本项目的核心纪律（**H1**）：
**"不知道"绝不等于"不满足"** —— 渠道故障时保持原状态，而不是把权限收回去。
这条纪律贯穿求值器、状态机与动作执行器，并有专门的测试锁定。

无界面方式（脚本 / CI 用）：

```bash
node --experimental-strip-types tools/demo-eligibility.ts alice@tsinghua.edu.cn
```

## 怎么验证

| 命令 | 它证明什么 | 实测结果 |
|---|---|---|
| `npm test` | 单测 + 集成（含真实 PG 用例） | **1496 / 1496 · 0 跳过** |
| `npm run ci` | **13 项门禁**：tsc · 单测 · DDL 快照 · db:check · site_id · 裸 SQL · 系统名 · 事务入口 · 安全自查 · 真实 PG 集成 · 路由/鉴权一致性 · 性能（≥500 QPS + 10 万主体）· 宿主无知 | **13 / 13 PASS** |
| `npm run verify:all` | 端到端：场景 A（23 项）· 真实 PG e2e · 路径探针 · 巡检存活 · 短长跑（5510 请求 / 0 失败） | **退出码 0** |
| `npm run db:check` | Schema 门禁 R1–R6 + 漂移检测 | **门禁 0 / 漂移 0**（48 表 · 48 枚举 · 98 索引） |
| `node --experimental-strip-types tools/dev-smoke.ts` | **二进制能在真实 PG 上跑起来**（不等同于容器） | 健康检查 200 · `/api/me` 401 |
| `npm run security` | 越权 / SSRF / 注入 / 密钥 / 会话自查 | 高危项 0 未通过 |

★ 门禁本身也**可被证明非恒真**：`node --experimental-strip-types tools/ci-gate.ts --self-test`（喂它坏输入，必须报错）。

---

## 已经实现的能力

**不是"M0 地基"** —— 下表每一项都有模块与测试为证（`src/` 下同名文件即证据）。

| 能力 | 关键位置 | 说明 |
|---|---|---|
| **四抽象 + 插件体系** | `src/plugin/` | manifest 校验 · 注册表 · 安装/包体/验签 · 令牌/调用记录/授权/信任 · UI 贡献 · schema 兼容 · 本地包缓存（权威在 DB，缓存可丢弃） |
| **表达式引擎** | `src/policy/expr.ts` · `addressing.ts` | 三值逻辑（true / false / **indeterminate**）· 统一寻址 `subject:` / `fact:` / `identity:` / `me:` · `$maxSkew`（用旧数据下结论前先看偏斜） |
| **策略模型与生命周期** | `src/policy/` | 三形态（表达式 / 有序分支 / 决策树）· 版本与发布 · `one_shot` / `auto_revoke` / `periodic` · 试算与影响面 |
| **动作执行器** | `src/core/action-executor.ts` | Plan → Execute → **Verify** · 幂等键 · 退避重试 · **失败补偿** · 动作参数走**同一套寻址**（解析不出即失败，绝不把寻址串交给下游） |
| **生命周期状态机 + 巡检** | `src/core/lifecycle.ts` · `patrol*.ts` | `unknown→satisfied→granted→at_risk→revoked` + 宽限期 · 调度器**租约**保证跨实例单飞 · 状态可回溯到"依据哪次评估" |
| **回滚** | `src/core/rollback.ts` | 单条 / 按主体 / 按策略批量（含级联回退：撤销后重新收敛到正确目标） |
| **灰度与一键熔断** | `src/core/policy-assignments.ts` · `rollout-abort.ts` | 确定性分桶（**全项目只有一处分桶实现**）· 熔断优先于比例与名单 · 按站点分组的受影响清单 |
| **审计（可写**且**可读）** | `src/admin/audit-scope.ts` | 可见性：admin 全部 / 开发者仅名下 / 终端用户仅自己 · **两层校验**（SQL 层限住范围 + 应用层二次判定） |
| **配额保护** | `src/core/quota-guard.ts` | 键**由类型强制与归属同构**（写不出"只有资源名"的键）· 计数落库（跨实例共享）· 结算如实记账 |
| **LLM 网关** | `src/plugin/llm-gateway.ts` | 缓存落库 · 预算与限流走配额守卫 · 上游失败释放预占 |
| **认证与身份** | `src/auth/` | OIDC 登录（PKCE / nonce / JWKS）· 冷启动引导令牌 · 会话 · **站点准入闸门**（邮箱规则按**目标站点**判）· 邀请码 · 身份对齐与联邦 · **本平台亦可作 IdP**（签名密钥轮换） |
| **协同验证** | `src/verify/` | 调用方密钥 · 断言 · nonce 防重放 |
| **运维面** | `tools/` | 指标 · 健康检查（liveness / readiness **分别**）· 备份恢复 · 长跑 · 密钥轮换 · 路径探针 · 巡检存活 |
| **前端** | `web/portal.ts` | **零构建**单文件门户（有意识的取舍，见「已知边界」） |
| **部署** | `Dockerfile` · `deploy/` | 多阶段镜像（非 root + tini）· compose · **systemd unit（二进制路径）** · 见 `reports/binary-deployment.md` |
| **CI/CD** | `.github/workflows/` | 每次 push 跑 13 项门禁；**门禁通过后**才构建镜像并推 GHCR（配置了 DockerHub 则双推） |

## 三条铁律

1. **不手写 DDL**：`migrations/*.sql` 只能由 `npm run db:generate` 产出。
2. **不改文档来迁就实现**：发现文档缺陷 → 登记进 `reports/schema-doc-defects.md`，由设计方裁决。
   提取器对每处修复**断言命中行号**，文档被修正后立即报错而不是静默漂移。
3. **消费方只读 IR**：门禁 / DDL 编译 / 漂移检测都只读 `NormalizedTable`，不读 `docs/`，不读表文件源码文本。接口冻结在 `docs/12-Schema声明层接口契约.md`。

---

## 已知边界（**不要当成已完成**）

完整清单与逐项状态见 **`reports/DELIVERY-CONTRACT.md` §三**（L-6 … L-19）。最要紧的几条：

- **小时级长跑未做**：只跑过 2 分钟（5/5 通过）。生产的泄漏以小时/天计，短长跑**不能**推出长时间稳定。
- **真实 new-api 对接未验证**：对账与写回只在**假上游**上验证过；真实接口的分页/限流/字段差异是未知。
- **`process` 形态 provider 的调用契约未实现**（需真实 process 插件环境）。
- **Docker 镜像只在 CI 里验证过**（开发环境无 docker）；镜像构建的前置门禁是"13 项门禁通过"。
- **管理端有两种并存的错误约定**：部分端点在"未装配"时**不挂载（404）**，部分是**进入后显式 501**。
  各有测试断言，尚未统一（交付契约 L-18）。
- **LLM 限流未装配配额守卫时会退回进程内计数**（多实例下配额被放大）——真实模式已自动注入 PG 计数。
- **前端是零构建 SPA**（有意识的取舍），不是 `docs/07` F0 建议的 Vite/React/Tailwind。
- **DEMO 模式不做真实验签**：内置假 IdP 仅用于演示；真实 IdP 用 `OidcClient`（含 JWKS 验签、PKCE、nonce）。

## 目录

```
docs/                       设计文档（规格 = 唯一事实来源）
reports/                    实测证据：交付契约 / 缺口审计 / 部署说明 / 验收报告
src/
  schema/                   ★ 表声明（提取生成，勿手改）+ R1–R6 门禁 + DDL 编译
  query/                    查询 AST → PG 编译器（站点作用域在**编译期**注入）
  kernel/                   日志 / DI / 事件总线 / 调度器
  auth/  verify/  secrets/  认证会话 / 协同验证 / 密钥
  policy/                   表达式引擎 · 寻址 · 策略模型 · 灰度
  core/                     动作执行 · 生命周期 · 巡检 · 回滚 · 审计 · 配额
  plugin/                   插件宿主与内置插件（provider / 动作 / 桥接 / 渲染）
  admin/  http/  app/       管理端 · 路由与会话 · 应用装配
  db/                       PG 适配器（事务入口统一）
tools/                      31 个：门禁 · 抽取 · 迁移 · 冒烟 · 长跑 · 探针 · 备份
web/                        零构建门户（单文件）
migrations/ sql/            DDL 产物（生成，勿手改）
deploy/                     systemd unit + 环境变量模板
.github/workflows/          CI（13 项门禁）+ Docker（构建推送）
```

## 从哪读起

1. `docs/01-总体设计.md` —— 为什么是这四个抽象
2. `docs/07-实施路线图.md` —— 里程碑与验收标准（90 条）
3. `reports/DELIVERY-CONTRACT.md` —— **交付契约**：已交付什么、接收方要做什么、已知边界、外部依赖
4. `reports/binary-deployment.md` —— 无容器部署的步骤与判据
