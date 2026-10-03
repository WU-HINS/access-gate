# 二进制部署（无容器）—— 步骤与判据

> **为什么不用容器**：本项目的部署形态是「**二进制 + 外部 PostgreSQL**」。
> 容器化不是必需项（`reports/containerization-runbook.md` 保留为可选项）。
>
> ★ 本文的每一步都有**可验证的判据**；"看起来起来了"不算数。

## 零、前置条件

| 项 | 要求 | 怎么验 |
|---|---|---|
| Node.js | **22+**（依赖 `--experimental-strip-types` 与 `AbortSignal.timeout`） | `node -v` |
| PostgreSQL | 14+，**已建库与账号** | `psql "$AG_DATABASE_URL" -c 'select 1'` |
| 系统用户 | 非 root（unit 里是 `access-gate`） | `id access-gate` |
| 目录 | `/opt/access-gate`（代码）+ `/etc/access-gate`（配置） | — |
| OIDC 提供方 | issuer / clientId / secret / redirectUri **已注册** | 见步骤 3 |

## 一、准备代码与配置

```bash
# ① 代码（二进制路径：不需要构建步骤——Node 直接跑 TS）
install -d /opt/access-gate && cd /opt/access-gate
#   把仓库内容放这里（含 node_modules，或 `npm ci --omit=dev`）
npm ci --omit=dev

# ② 配置（密钥**不进 unit 文件**）
install -d -m 0750 /etc/access-gate
install -m 0640 deploy/access-gate.env.example /etc/access-gate/env
chown root:access-gate /etc/access-gate/env
$EDITOR /etc/access-gate/env          # 填入 AG_MASTER_KEY / AG_DATABASE_URL / OIDC / AG_SECURE_COOKIES
```

★ `AG_MASTER_KEY` 生成：`openssl rand -hex 32`。**它是加密主密钥，丢了等于所有加密数据不可恢复** —— 放进密码管理器，不要只留在服务器上。

## 二、迁移（**独立步骤，不在 unit 里**）

```bash
cd /opt/access-gate
AG_DATABASE_URL=... npm run db:migrate
# 判据：
npm run db:check      # → 门禁 0 · 漂移 0
```

★ **为什么不在 `ExecStartPre` 跑**：多实例会并发迁移；而迁移是**变更操作**，应由发布流程显式执行，而不是每次重启都尝试。

## 三、启动

```bash
install -m 0644 deploy/access-gate.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now access-gate
```

> ⚠️ **诚实标注**：编写本文的环境**没有 systemd**，因此 unit 文件的语法**未经
> `systemd-analyze verify` 校验**。首次部署时请先跑一次（它只做静态检查，不影响运行中的服务）：
>
> ```bash
> systemd-analyze verify /etc/systemd/system/access-gate.service
> ```
>
> 若它报 `ReadWritePaths` 相关错误，检查 `plugins/` 目录是否存在且属主为 `access-gate`。

## 四、验证（**四条判据**）

```bash
# 判据 1 · 进程活着且健康检查分层正确
curl -s localhost:8799/healthz/live   # → 200 {"status":"healthy", checks:[{kind:"liveness"...}]}
curl -s localhost:8799/healthz/ready  # → 200（含 database readiness 检查）
#   ★ 两者**必须能分别失败**：DB 挂了应 ready 失败而 live 仍 200
#     （这样编排系统会"摘流量"而不是"重启进程"）

# 判据 2 · 指标可抓
curl -s localhost:8799/metrics | head

# 判据 3 · 鉴权链生效（未登录不是"没挂载"）
curl -s -o /dev/null -w '%{http_code}\n' localhost:8799/api/me   # → 401

# 判据 4 · 首次部署拿到管理员（**一次性**）
journalctl -u access-gate | grep bootstrap
#   日志里会给一个 `/api/auth/bootstrap?token=...` 链接；在浏览器打开即得管理员会话。
#   ★ 令牌**不会再次显示**（用后即焚）；拿到后立刻改配置并保存好。
```

**在开发机上先验证二进制本身能跑**（起临时 PG，不碰生产）：

```bash
node --experimental-strip-types tools/dev-smoke.ts
# 它会：起真实 PG → 迁移 → 起二进制 → 探活 → 打印启动日志 → 清理
```

## 五、日常操作

| 操作 | 命令 |
|---|---|
| 看状态 | `systemctl status access-gate` |
| 看日志 | `journalctl -u access-gate -f` |
| 重载配置 | 改 `/etc/access-gate/env` 后 `systemctl restart access-gate` |
| 备份 | `npm run backup`（判据：恢复演练通过） |
| 健康探测 | 见步骤四的判据 1 |

## 六、升级流程

```bash
systemctl stop access-gate          # ① 停（SIGTERM，30s 内在途请求走完）
cd /opt/access-gate && git pull     # ② 取新代码
npm ci --omit=dev                   # ③ 依赖
AG_DATABASE_URL=... npm run db:migrate   # ④ 迁移（显式）
npm run db:check                    # ⑤ 门禁 0 / 漂移 0
systemctl start access-gate         # ⑥ 起
curl -s localhost:8799/healthz/ready # ⑦ 就绪
```

**回滚**：策略回滚走 `admin/api.ts` 的回滚端点（单条 / 按主体 / 按策略批量）；
代码回滚 = `git checkout <上一版>` + 重复上面 ③⑥⑦。
★ **迁移不回滚**（DDL 回滚需单独评审）—— 所以迁移应当**向后兼容**（加列不删列）。

## 七、多实例

| 关注点 | 现状 |
|---|---|
| **巡检单飞** | ✅ 调度器**租约**（真实 PG 上"条件更新 + RETURNING 原子抢锁"）保证跨实例串行 |
| **会话** | ✅ 落库（`ag_sessions`），实例间共享 |
| **插件包体** | ✅ 权威在 DB；本地 `plugins/runtime` 是**可丢弃缓存**，启动按 digest 拉回 |
| **OAuth 状态** | ✅ 落库（`ag_oauth_*`）—— 本会话修复（此前无条件用内存实现） |
| **限流/预算** | 🟡 网关的 per-minute 限流是**进程内**计数 → 多实例下实际配额 = 单实例配额 × 实例数（**已知**，见 `DELIVERY-CONTRACT.md`） |

## 八、什么算"部署成功"

- [ ] 步骤四的**四条判据**全过
- [ ] `npm run db:check` → 门禁 0 / 漂移 0
- [ ] 冷启动引导令牌已用掉，且管理员能登录
- [ ] `journalctl` 无 error 级别启动日志
- [ ] 备份演练通过（`npm run backup`）
