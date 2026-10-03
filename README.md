# access-gate · M0 地基（Schema 声明层 → PG DDL → 作用域门禁）

> 本仓库当前实现的是设计文档 `docs/` 所定义的 **M0 地基**。
> 设计文档是**唯一事实来源**：本仓库的 40 张表声明由 `tools/extract-doc-schema.ts` **从 `docs/02-数据模型.md` 提取生成**，
> 不允许手抄——手抄必然产生静默漂移。

---

## 快速开始

```bash
npm install --cache /tmp/npmcache   # 依赖：typescript / @electric-sql/pglite / @types/node

npm run schema:extract   # docs/02 → src/schema/tables/*.ts（并断言 6 处文档缺陷修复点）
node --experimental-strip-types tools/verify-tables.ts   # 结构自检 + R1–R6 门禁
npm test                 # 单测（66 个用例）
npm run db:generate      # 声明 → migrations/0001_init.sql + sql/schema.sql
npm run db:migrate       # 把全部 DDL 真跑到空库（pglite，进程内 PG 18.3）
npm run db:check         # ① R1–R6 门禁 ② 与活库结构比对做漂移检测
npm run ci               # 7 项 CI 门禁汇总
```

### 当前 CI 状态

`npm run ci` = **PASS（8/8，退出码 0）**：

| 项 | 状态 |
|---|---|
| 1. tsc --noEmit | ✅ |
| 2. 单测（66 个用例 / 5 个文件） | ✅ |
| 3. DDL 编译快照对比 | ✅ |
| 4. `db:check`（门禁 R1–R6 + 漂移检测） | ✅ |
| 5. site_id 缺失检测 | ✅ |
| 6. 禁止裸 SQL 扫描 | ✅ |
| 7. 核心代码具体系统名 = 0 | ✅ |
| 8. 单一事务入口（禁事务外驱动查询） | ✅ |

> 第 3 轮时 CI 是 6/8，两处 FAIL 都**不是实现缺陷**——门禁与 grep **正确地**拦住了 `docs/02` 的真实问题
> （作用域归属错误、残留具体系统名）。第 4 轮**修的是文档而不是门禁**，于是自然转绿。
> 裁决记录见 `docs/CHANGELOG.md` 的 **ADR D21**；缺陷台账见 `reports/schema-doc-defects.md`；
> 验收判定见 `reports/M0-acceptance.md`。

---

## 目录

```
docs/                      设计文档（15 份 + 冻结契约 12）
tools/
  extract-doc-schema.ts    ★ docs/02 → 真实声明（含文档缺陷修复表 REPAIRS）
  verify-tables.ts         结构自检 + 门禁（可复跑验收）
  db-generate.ts           声明 → DDL 文本
  db-migrate.ts            空库真跑
  db-check.ts              门禁 + 漂移检测（支持 --drift-demo / --no-gate）
  ci-gate.ts               7 项 CI 门禁（支持 --self-test 证明门禁非恒真）
src/schema/
  ir.ts                    规范化 IR（冻结件，消费方唯一接口）
  dsl.ts                   defineTable / declare / col.* / t.*（含 t.primaryKey）
  normalize.ts             声明 → IR
  tables/                  ★ 40 张表（提取生成，勿手改）
  gate/                    R1–R6 门禁 + 平台级豁免清单
  compile/                 DDL 编译 / 漂移检测 / CI 静态检查
src/db/                    ★ 作用域 fail-closed / AsyncLocalStorage 事务上下文 / 静态守卫 / pglite 驱动层
test/                      单测
migrations/ sql/           DDL 产物
reports/                   缺陷台账 / 门禁证据 / 数据库 spike 证据 / M0 验收报告
```

---

## 三条铁律

1. **不手写 DDL**：`migrations/*.sql` 只能由 `npm run db:generate` 产出。
2. **不改文档来迁就实现**：发现文档缺陷 → 登记进 `reports/schema-doc-defects.md`，由设计方裁决。
   提取器对每处修复都**断言命中行号**，文档被修正后会立即报错而不是静默漂移。
3. **消费方只读 IR**：门禁 / DDL 编译 / 漂移检测都只读 `NormalizedTable`，不读 `docs/`，不读表文件源码文本。
   接口冻结在 `docs/12-Schema声明层接口契约.md`。

---

## 现在可以做什么（M0 + M1 已完成）

**一条命令启动，浏览器打开就能看到「我的资格」：**

```bash
node --experimental-strip-types tools/serve.ts
#   access-gate 已启动
#   地址    : http://127.0.0.1:8787
#   模式    : DEMO（内置假 IdP + 内存数据）
```

打开后点「alice@tsinghua.edu.cn（教育邮箱）」即可看到：

```
我的资格        进度：1 / 2 条策略已达成
【教育邮箱解锁签到】已达成
  ✅ 教育邮箱
  ✅ 邮箱已验证
  → 将执行：checkin:grant
【GitHub 贡献者】待确认
  ❓ GitHub 总 star 数 ≥ 100（关键事实缺失，请稍后重试或完成绑定）
  → 不执行任何动作（无法判定时不推进状态）
```

换成 `bob@gmail.com` 会看到「❌ 教育邮箱（当前 "gmail.com"，需要 ["*.edu.cn", …]）」并回退到默认分组——
**这就是 `docs/07` 定义的 M1 验收场景**。

### 无界面方式（脚本/CI 用）

```bash
node --experimental-strip-types tools/demo-eligibility.ts alice@tsinghua.edu.cn
```

### 已完成的能力

| 里程碑 | 状态 | 内容 |
|---|---|---|
| **M0 地基** | ✅ 12/12 | Schema 声明层 + DDL 编译 + 漂移检测 + 站点作用域门禁 R1–R6 + 查询编译器 + 内核（日志/DI/事件总线/调度器）+ 认证会话 + 前端门户 |
| **M1 第一个切片** | ✅ 11/11 | provider 契约 + 通用对账器 + `newapi-provider` + 插件宿主 + `email-domain` + 身份对齐 + 表达式引擎 + 策略模型 + 「我的资格」+ 管理端 |

`npm run ci` **8/8 PASS**；`npm test` **298/298**（19 个测试文件）。

### 已知边界（不要当成已完成）

- **DEMO 模式不做真实验签**：内置假 IdP 仅用于演示；接入真实 IdP 请用 `OidcClient`（含 JWKS 验签、PKCE、nonce）。
- **切换站点只写了会话**，尚未做「该用户可访问哪些站点」的授权校验（需站点成员模型）。
- **动作执行器尚未实现**（M2）：策略求值会给出「将执行什么动作」，但**不会真的调用下游**写回。
- **`pg_advisory_lock` 的跨实例抢占未验证**（pglite 单连接），需真实 PostgreSQL。
- 前端是**零构建 SPA**（有意识的取舍），不是 `docs/07` F0 建议的 Vite/React/Tailwind。

### 下一步（M2 · 闭环，首个可用版本）

动作执行器 + 状态机 + 幂等键 + 巡检调度 + 策略版本化 + 试算影响面。做完 M2 才算「首个可用版本」。
