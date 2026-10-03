# GitHub 接入（已完成）

> **状态：✅ 已完成** —— 代码已推送到 `https://github.com/WU-HINS/access-gate`（**private**）。
> 本文件保留**当时的网络诊断**，因为它解释了一次真实排障（"推送失败"不是代码问题），
> 也给出了换环境后快速自检的命令。

## 一、结果

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/WU-HINS/access-gate`（**private**） |
| 默认分支 | `main` |
| 推送方式 | **HTTPS + 代理**（`gh auth setup-git` 作凭据助手） |
| 本地 HEAD | `d1e671a` —— 与远端 `refs/heads/main` **一致** |
| 跟踪关系 | `## main...origin/main` |
| 远端文件数 | **398** |
| 误传的大目录 | **0**（`node_modules/` 与 `new-api/` 均不在远端） |

推送输出（验收判据）：

```
To https://github.com/WU-HINS/access-gate.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
```

## 二、`.gitignore` 的两条关键排除

- `node_modules/` —— 由 `npm ci` 重建；
- **`new-api/`** —— 它是**自带 `.git` 的独立仓库**（约 102M，被对接的上游项目）。
  入库会连带它的历史，并让本仓库凭空膨胀百兆。远端树已核对：该前缀**零条目**。

（`.secrets/` 的忽略规则**保留**——它是"本机凭据目录"的防御性规则，
即使当前目录已空，将来有人往里放东西也不会被误提交。）

## 三、当时的网络诊断（一次真实排障）

现象：`gh repo create` **成功**，但 `git push` 反复失败，报
`gnutls_handshake() failed: The TLS connection was non-properly terminated`。

逐层实测的结论：

| 通道 | 当时结果 | 说明 |
|---|---|---|
| `api.github.com:443` 直连 | ✅ 200 | 所以"创建仓库"能成功 |
| `github.com:443` 直连 | ❌ TLS 被中断 | DNS 正常（指向真实 GitHub IP），TCP 通、TLS 走到 Server hello 后断 |
| 代理 `172.18.0.1:10809` | ❌ CONNECT 返 200，但隧道内明文 HTTP 返 **502**、TLS 被断 | **代理本身坏了** |
| `github.com:22`（SSH） | ✅ 可达 | `ssh -T` 返回 `Permission denied (publickey)` = 已到 GitHub，只差密钥 |

★ 因此当时的结论是"唯一可推的通道是 SSH，需登记公钥"。
**代理修好后走 HTTPS 一次成功** —— 也就是说根因是**代理**，不是 GitHub 也不是代码。

★ 期间**没有**采用"关闭 TLS 校验"这类绕过手段（那会把推送降级为可被中间人读取）。
诊断信息来自实测命令，不是推断。

## 四、换环境后的自检命令

```bash
# 三条都应是 200（走代理）
curl -sS -m 20 -o /dev/null -w '%{http_code}\n' https://github.com
curl -sS -m 20 -o /dev/null -w '%{http_code}\n' https://api.github.com
gh auth status                       # 期望 "Logged in to github.com account WUHINS"

# 推送与验收
git push -u origin main
git status -sb                       # 期望 "## main...origin/main"（无 ahead/behind）
git ls-remote origin refs/heads/main # 期望与 git rev-parse HEAD 一致
```

**排障顺序**（本次有效的顺序）：先分别验证
`api.github.com`（API 面）→ `github.com`（HTTPS 面）→ 代理 → SSH。
四者中任一不通，都能立刻定位到层次，而不是在 git 层反复重试。
