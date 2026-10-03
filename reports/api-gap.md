# 接口面缺口清单（自动生成）

> 由 `node --experimental-strip-types tools/api-coverage.ts --write-report` 生成。
> **不要手工编辑**——本文件是工具输出；分类规则在 `tools/api-coverage.ts` 的 `classify()` 里。

## 总体

| 项 | 值 |
|---|---|
| 文档声明端点（docs/06） | 126 |
| 源码注册路由 | 95 |
| 未匹配 | 71 |
| 覆盖率 | 43.7% |

★ **「未匹配」不等于「缺陷」**：docs/06 含完整设计稿的成分，需要人工判断。
本清单的价值在于**把差距量化并分优先级**，而不是制造一个「必须消掉的数字」。

### P0 · 生产阻塞（21 条）

缺了它，平台的**核心卖点无法被运营**（插件装不了、OIDC 配不了、协同调用方管不了）。

| 方法 | 路径 | 归类依据 |
|---|---|---|
| GET | `/admin/plugins/:id/ui` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| POST | `/admin/plugins/:id/ui/:uid/approve` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| POST | `/admin/plugins/:id/ui/:uid/toggle` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| POST | `/admin/plugins/:id/restart` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| GET | `/admin/plugins/:id/invocations` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| POST | `/admin/plugins/:id/test` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| GET | `/admin/plugins/:id/logs` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| POST | `/admin/plugins/:id/rollback` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| GET | `/admin/plugins/:id/tokens` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| DELETE | `/admin/plugins/:id/tokens/:tid` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| GET | `/admin/plugins/:id/tokens` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| POST | `/admin/plugins/:id/tokens` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| DELETE | `/admin/plugins/:id/tokens/:tid` | 插件平台的运营入口（安装/授权/信任/端点/日志） |
| GET | `/admin/oidc/providers` | OIDC 注册管理（联邦登录的前置） |
| POST | `/admin/oidc/providers` | OIDC 注册管理（联邦登录的前置） |
| PUT | `/admin/oidc/providers/:ref` | OIDC 注册管理（联邦登录的前置） |
| POST | `/admin/oidc/providers/:ref/discover` | OIDC 注册管理（联邦登录的前置） |
| POST | `/admin/oidc/providers/:ref/test` | OIDC 注册管理（联邦登录的前置） |
| GET | `/admin/settings` | 平台设置（含平台模式切换，M7-10） |
| POST | `/admin/settings/:key/reset` | 平台设置（含平台模式切换，M7-10） |
| POST | `/admin/settings/newapi/test` | 平台设置（含平台模式切换，M7-10） |

### P1 · 重要但非阻塞（35 条）

用户自助与日常运维。缺了会让运营**必须直接连数据库**。

| 方法 | 路径 | 归类依据 |
|---|---|---|
| GET | `/admin/users/:id/raw` | 用户管理（排障与客服必需） |
| POST | `/admin/users/:id/link` | 用户管理（排障与客服必需） |
| POST | `/admin/users/:id/unlink` | 用户管理（排障与客服必需） |
| POST | `/admin/users/:id/recheck` | 用户管理（排障与客服必需） |
| POST | `/admin/users/:id/rollback` | 用户管理（排障与客服必需） |
| POST | `/admin/users/:id/tags` | 用户管理（排障与客服必需） |
| GET | `/admin/users/export` | 用户管理（排障与客服必需） |
| GET | `/me/identities` | 用户自助（身份绑定/签到/资格/对齐） |
| POST | `/me/identities/github/start` | 用户自助（身份绑定/签到/资格/对齐） |
| GET | `/me/identities/github/callback` | 用户自助（身份绑定/签到/资格/对齐） |
| DELETE | `/me/identities/:provider` | 用户自助（身份绑定/签到/资格/对齐） |
| GET | `/admin/providers` | 运维可观测（任务/动作/同步/渠道） |
| POST | `/admin/providers/:id/sync` | 运维可观测（任务/动作/同步/渠道） |
| GET | `/admin/providers/:id/subjects` | 运维可观测（任务/动作/同步/渠道） |
| PUT | `/admin/providers/:id/drift-policy` | 运维可观测（任务/动作/同步/渠道） |
| POST | `/me/alignment/confirm` | 用户自助（身份绑定/签到/资格/对齐） |
| POST | `/me/alignment/request-review` | 用户自助（身份绑定/签到/资格/对齐） |
| GET | `/me/alignment/guidance` | 用户自助（身份绑定/签到/资格/对齐） |
| GET | `/me/checkin/status` | 用户自助（身份绑定/签到/资格/对齐） |
| POST | `/me/checkin` | 用户自助（身份绑定/签到/资格/对齐） |
| GET | `/me/checkin/history` | 用户自助（身份绑定/签到/资格/对齐） |
| GET | `/admin/sync/state` | 运维可观测（任务/动作/同步/渠道） |
| POST | `/admin/sync/full` | 运维可观测（任务/动作/同步/渠道） |
| POST | `/admin/sync/resolve-drift` | 运维可观测（任务/动作/同步/渠道） |
| GET | `/me/policies` | 用户自助（身份绑定/签到/资格/对齐） |
| POST | `/me/policies/:code/recheck` | 用户自助（身份绑定/签到/资格/对齐） |
| GET | `/admin/jobs` | 运维可观测（任务/动作/同步/渠道） |
| POST | `/admin/jobs/:key/run` | 运维可观测（任务/动作/同步/渠道） |
| GET | `/admin/actions` | 运维可观测（任务/动作/同步/渠道） |
| POST | `/admin/actions/:id/retry` | 运维可观测（任务/动作/同步/渠道） |
| POST | `/auth/register` | 账号自助（注册/邮箱验证/改密） |
| POST | `/auth/email/verify` | 账号自助（注册/邮箱验证/改密） |
| POST | `/auth/password/reset` | 账号自助（注册/邮箱验证/改密） |
| GET | `/me/actions` | 用户自助（身份绑定/签到/资格/对齐） |
| GET | `/admin/audit` | 审计查询（排障与追责） |

### P2 · 需人工确认（15 条）

可能是设计稿的目标形态，也可能确属本期范围。**需要产品判断**，不应盲目补齐。

| 方法 | 路径 | 归类依据 |
|---|---|---|
| GET | `/admin/policies/:code` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| PUT | `/admin/policies/:code` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| POST | `/admin/policies/:code/validate` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| POST | `/admin/policies/:code/simulate` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| POST | `/admin/policies/:code/preview-impact` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| GET | `/admin/policies/:code/expression?format=yaml\|json\|graph` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| PUT | `/admin/policies/:code/expression?format=...` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| POST | `/admin/policies/:code/expression/convert` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| POST | `/admin/policies/:code/expression/validate` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| GET | `/admin/policies/:code/expression/schema` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| GET | `/auth/oidc/start` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| GET | `/auth/oidc/callback` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| GET | `/auth/providers` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| GET | `/auth/session` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |
| GET | `/api/plugins/_endpoints` | 需人工确认是否属于本期范围（可能是设计稿的目标形态） |

## 建议的补齐顺序

1. **P0 的 `/admin/plugins`**（13 条）——
   它是「插件平台」从「有实现」到「能被运营」的分界线；
2. **P0 的 `/admin/oidc` + `/admin/settings`**——联邦登录与平台模式的前置；
3. **P1 的 `/me/*`**——用户自助，直接影响终端用户体验；
4. P2 需与产品确认后再决定。

★ 每补一批，都应更新本文件（重跑工具）并在 `reports/M0-acceptance.md` 记录真实运行证据。
