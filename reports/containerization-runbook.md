# 容器化验证 Runbook（本环境**无法执行**，但步骤可直接照做）

> **为什么单独写这份文件**：本环境**没有 Docker**（未安装、daemon 不可用、无 podman），
> 因此 `docker build` / `docker compose up` / 卷持久化这 5 项**无法验证**。
>
> ★ 但「无法验证」不等于「只能写四个字」。下面是**可执行的具体步骤**，
> 每一行都指出现有配置里的对应位置——接手者照做即可。
>
> ★ 另有一条**已被静态检查捕获的真实缺陷**记在最后一节。

---

## 0. 前置

```bash
cd <项目根>
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export AG_MASTER_KEY="$(openssl rand -hex 32)"      # ★ 真实模式强制要求（R31 起）
export AG_OIDC_ISSUER="https://<你的 IdP>/realms/<realm>"
export AG_OIDC_CLIENT_ID="access-gate"
export AG_PUBLIC_URL="http://127.0.0.1:8787"
```

★ `AG_MASTER_KEY` **缺失时服务会启动即失败**（不是静默退回内存）——
这是刻意的：调用方密钥必须加密存入 `ag_secrets`，否则重启后 HMAC 校验全部失效且无法察觉。

---

## 1. 构建

```bash
docker build -t access-gate:local .
```

**预期**：构建成功。

**若失败**：先看 `.dockerignore`（本会话曾因 `COPY package*.json ./` 漏掉 lockfile
导致 `npm ci` 失败，已修为显式 `COPY package.json package-lock.json ./`）。

---

## 2. 起栈

```bash
docker compose up -d
docker compose ps            # 期望：db = healthy，app = healthy
```

**预期时序**（`docker-compose.yml` 已配置，勿改成裸 `depends_on`）：
1. `db` 启动 → `pg_isready` 通过 → `healthy`；
2. `app` 因 `depends_on: condition: service_healthy` 才启动（**不靠 sleep 赌博**）；
3. `app` 的 healthcheck 探 `/healthz/ready`（**不是** `/healthz`——
   容器「活着」不代表「能服务」）。

**若 `app` 一直 `starting`**：

```bash
docker compose logs app | tail -40
```

★ 最可能的三个原因（都是「启动即失败」而非「慢慢起」）：

| 现象 | 原因 |
|---|---|
| `缺少主密钥` | 未设 `AG_MASTER_KEY`（已由 preflight ⑥ 静态覆盖） |
| `请设置 AG_OIDC_ISSUER` | compose 用了 `:?` 语法，缺变量直接拒绝启动 |
| `数据库迁移未完成` | `/healthz/ready` 会查迁移记录；先 `docker compose run --rm app npm run db:migrate` |

---

## 3. 健康检查（**真实**探测，不是看 `ps`）

```bash
curl -sS http://127.0.0.1:8787/healthz/live    # 存活
curl -sS http://127.0.0.1:8787/healthz/ready   # 就绪（查迁移 + 作业状态）

# ★ 也验证容器内自探（healthcheck 用的就是这条）
docker compose exec app node -e "fetch('http://127.0.0.1:8787/healthz/ready').then(r=>process.exit(r.ok?0:1))"
```

★ `/healthz/ready` **不是**「进程还在」——它会检查迁移是否应用、作业是否停摆。
本会话正是靠它发现「巡检执行失败但进程看起来正常」。

---

## 4. 优雅启停（**必须**验证，最容易假装通过的一项）

```bash
# ① 确认配置了宽限期（短于应用优雅关闭总超时会被 SIGKILL）
grep -E "stop_grace_period" docker-compose.yml

# ② 计时停止，并确认退出码
time docker compose stop app
docker compose ps app                  # 期望：Exited (0)

# ③ 反向验证：确认没有被强杀
docker compose logs app | grep -i "SIGKILL" && echo "★ 被强杀——宽限期太短" || echo "OK：正常退出"
```

★ 本会话的真实教训：**`process.on('exit')` 在信号杀死时不触发**，
导致 PG 实例泄漏 65 分钟。因此「进程退出了」不等于「清理做了」。

---

## 5. ★★ 数据卷在**容器重建后仍然存在**（本项最关键）

```bash
# ① 通过真实接口写入一条可验证的数据（不是直接改库）
TOKEN=$(docker compose logs app | grep -oE "bootstrap\?token=[A-Za-z0-9_-]+" | head -1 | cut -d= -f2)
curl -sS -c /tmp/ag.jar "http://127.0.0.1:8787/api/auth/bootstrap?token=${TOKEN}" -o /dev/null
curl -sS -b /tmp/ag.jar -X POST http://127.0.0.1:8787/api/admin/settings/platform \
  -H 'content-type: application/json' -d '{"mode":"saas"}'

# ② ★ 彻底删除容器（不是 restart——restart 保留容器层，测不出卷）
docker compose down                    # ★ 不加 -v！加了会删卷
docker volume ls | grep ag-db-data     # 期望：卷仍在

# ③ 重建并确认数据仍在
docker compose up -d
sleep 5
curl -sS -b /tmp/ag.jar http://127.0.0.1:8787/api/admin/settings/platform
# ★ 期望：仍返回 mode=saas（若回到 standalone，说明写入没落盘或卷没生效）
```

★★ **这一项是「容器化」的核心价值**：没有它，容器只是一次性进程。
`docker-compose.yml` 已声明 `ag-db-data:/var/lib/postgresql/data`（有静态检查覆盖），
但**只有真实执行 `down` + `up` 才能证明它有效**。

**反向验证（推荐）**：

```bash
docker compose down -v && docker compose up -d   # 删卷后重建
curl -sS -b /tmp/ag.jar http://127.0.0.1:8787/api/admin/settings/platform
# ★ 期望：回到 mode=standalone（初始值）——这证明上一步的「数据仍在」确实来自卷，
#   而不是来自别处的缓存
```

---

## 6. 本会话**已经**发现的容器化真实缺陷（静态检查抓到的）

### `docker-compose.yml` 缺少 `AG_MASTER_KEY`

R31 我给真实模式加了「必须有 `AG_MASTER_KEY`」的强制要求，**却忘了同步 compose**
→ `docker compose up` 会**启动即失败**。

★ 而当时 `tools/docker-preflight.ts` 是 **10/10 通过**——
因为它只查 compose 自身的静态正确性，**不查「compose 与运行时代码的要求是否一致」**。

**修复**：

1. compose 补上 `AG_MASTER_KEY: ${AG_MASTER_KEY:?请设置…}`（`:?` 语法缺失即拒绝启动）；
2. `docker-preflight` 新增 **⑥ 部署一致性** 检查：从 `serve.ts` 提取
   「参与了 `=== undefined` 判断且附近有 `throw`」的环境变量，断言它们都在 compose 里声明。

★ 该检查**自测过**：临时移除 compose 的 `AG_MASTER_KEY` →
立刻报 `❌ 缺少：AG_MASTER_KEY —— docker compose up 会启动即失败`。

★★ 这个检查的**演进过程**本身值得记（三轮，每轮都是自测逼出来的）：

| 轮次 | 做法 | 结果 |
|---|---|---|
| ① | `process.env['AG_X']` 之后 300 字符内有 `throw` | **恒真**——实际代码里两者隔十几行，一个都没匹配到 |
| ② | 窗口放宽到 2000 字符 | **误报** `AG_PLATFORM_MODE`（它是**可选**的） |
| ③ | **变量追踪**：`const X = process.env['AG_Y']` + `X === undefined` | ✅ 正确（提取到恰好 1 个必需变量） |

★ 教训：**检查的正则宽度是个真实的权衡**——太窄会恒真（假通过），太宽会误报。
而**只有自测能区分这两种失败**。

---

## 7. 验收清单（照做后逐项打勾）

- [ ] `docker build` 成功
- [ ] `docker compose up -d` 后 `db` 与 `app` 都是 `healthy`
- [ ] `/healthz/live` 与 `/healthz/ready` 都返回 200
- [ ] `docker compose stop app` 后退出码为 0，日志无 SIGKILL
- [ ] `docker compose down`（**不带 `-v`**）后卷 `ag-db-data` 仍在
- [ ] 重建后此前写入的平台设置**仍在**（`mode=saas` 而非 `standalone`）
- [ ] `docker compose down -v` 后重建，数据**回到初始值**（反证上一步来自卷）

★ 全部打勾后，请把结果（含实际命令输出）追加到 `reports/M0-acceptance.md`，
并把本文件的「无法验证」标记改为「已验证」。
