# GitHub 推送接入说明（仓库已建，推送待一步授权）

> 本文件记录**当前真实状态**与**唯一剩余的手工步骤**。在此之前的所有步骤都已由我完成并实测。

## 一、已完成（实测过的）

| 项 | 状态 |
|---|---|
| 远程仓库 | ✅ **已创建**：`https://github.com/WU-HINS/access-gate`（**private**） |
| 本地 git | ✅ `git init -b main`，`.gitignore` 就位 |
| 初始提交 | ✅ `846697e` —— **397 文件 / 138,112 行 / 5.9M** |
| 远程配置 | ✅ `origin` = `git@github.com:WU-HINS/access-gate.git`（**SSH**） |
| 推送密钥 | ✅ 已生成 ed25519（**无口令**，专用于本机推送），存放于 **`.secrets/`**（已 gitignore，**不会入库**） |
| git 身份 | ✅ 已配置（`HINS <hins@hinswu.top>`，来自环境既有配置） |

`.gitignore` 的两条关键排除：
- `node_modules/` —— 由 `npm ci` 重建；
- **`new-api/`** —— 它是**自带 `.git` 的独立仓库**（约 102M，被对接的上游项目），入库会连带它的历史并让本仓库膨胀百兆。

## 二、为什么推送还没成功（网络实测结论）

| 通道 | 结果 |
|---|---|
| `api.github.com:443` 直连 | ✅ **可用**（`gh repo create` 就是走它成功的） |
| `github.com:443` 直连（HTTPS 推送） | ❌ TLS 握手被中断 |
| 代理 `172.18.0.1:10809` | ❌ **不可用**：CONNECT 返 200，但隧道内明文 HTTP 返 **502**、TLS 握手被断开 |
| `github.com:22`（SSH） | ✅ **可达**（`ssh -T git@github.com` 返回 `Permission denied (publickey)` = 已到 GitHub，只差密钥） |
| `ssh.github.com:443` | ✅ 可达（备用通道） |

**结论**：本机唯一能推送的通道是 **SSH**，而 SSH 需要**这个公钥已登记到账号**。

## 三、唯一剩余的一步（二选一，都需要你）

### 选项 A（最快，约 30 秒，无需命令行）

把下面这行公钥粘贴到 **GitHub → Settings → SSH and GPG keys → New SSH key**：

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIAp4iiUSoTgbW2+r4IMJl5JXIhurxmtnW3vt3HokMIJ access-gate-unattended@2be263ab2915
```

### 选项 B（我来自动登记，需你交互一次）

当前 token 的 scopes 是 `gist, read:org, repo, workflow, write:packages` —— **缺 `admin:public_key`**，所以 API 登记密钥被拒（`HTTP 404: Not Found`）。你执行：

```bash
gh auth refresh -h github.com -s admin:public_key
```

完成后告诉我，我就能用 `gh ssh-key add` 自动登记并推送。

## 四、授权后我会执行的（或你自己执行）

```bash
cd "/workspace/newapi 429"
git push -u origin main          # core.sshCommand 已指向 .secrets/ 下的密钥
git remote -v && git log --oneline -1
```

**验收判据**：`git push` 输出 `main -> main` 且 `git status -sb` 显示 `## main...origin/main`。

## 五、安全提醒（建议你处理）

- 该私钥**无口令**且位于 `.secrets/`（已 gitignore，但仍在工作区内）。它只用于本机推送。
- 用完后建议**换绑到 `~/.ssh/` 并加口令**，或直接吊销：
  - 吊销：`gh ssh-key delete <key-id>`（或 GitHub → Settings → SSH keys）
  - 本地删除：`rm -rf .secrets/`
- 我**没有**、也不会为了让 HTTPS 通而关闭 TLS 校验（那会把推送降级为可被中间人读取）——这是本机网络环境的限制，不是代码问题。

## 六、复现诊断（若换环境后想重跑）

```bash
curl -sS -m 12 -o /dev/null -w '%{http_code}\n' https://api.github.com          # 期望 200
curl -sS -m 12 -o /dev/null -w '%{http_code}\n' https://github.com              # 本机期望失败
ssh -o ConnectTimeout=10 -T git@github.com                                      # 期望 "Permission denied (publickey)"
env -u HTTPS_PROXY -u HTTP_PROXY gh auth status                                  # 绕开代理后 token 有效
```
