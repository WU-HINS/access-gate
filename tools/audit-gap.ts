#!/usr/bin/env node
/**
 * tools/audit-gap.ts —— 机器化缺口审计。
 *
 * 为什么需要它：项目有 8 个里程碑、数十项任务，靠人读文档判断「做到哪了」必然出错
 * （本仓库已经出现过「报告声称已实现、代码里其实什么都没有」的情况）。
 * 本工具把「路线图任务清单」与「真实代码资产」做**可复跑的对照**，
 * 产出机器可验证的完成度，而不是叙述性判断。
 *
 * 判据分三档（刻意保守）：
 *   ✅ done        —— 声明的证据路径存在，且（若给了 probe）探针命令返回 0
 *   🟡 partial     —— 部分证据存在
 *   ⛔ todo        —— 证据不存在
 *
 * 用法：
 *   node --experimental-strip-types tools/audit-gap.ts            # 人类可读
 *   node --experimental-strip-types tools/audit-gap.ts --json     # 机器可读
 *   node --experimental-strip-types tools/audit-gap.ts --milestone M0
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROADMAP = path.join(ROOT, 'docs', '07-实施路线图.md');

// ─────────────────────────── 任务清单（从路线图 §3 摘录） ───────────────────────────

interface TaskProbe {
  id: string;
  /** 任务标题（与路线图 §3 的表格一致） */
  title: string;
  /** 存在的证据路径（全部存在才算 evidence 齐全） */
  evidence: string[];
  /** 可选的探针命令：返回 0 视为通过 */
  probe?: { file: string; args: string[] };
  /** 探针之外的说明 */
  note?: string;
}

/**
 * ⚠ 本清单**手工摘录自** `docs/07-实施路线图.md §3`。
 * 摘录本身会有漂移风险——因此工具会核对路线图里的任务编号集合，缺失/多余都会报警。
 */
const TASKS: TaskProbe[] = [
  // ── M0 地基 ──
  { id: 'M0-1', title: '后端工程初始化', evidence: ['package.json', 'tsconfig.json'] },
  { id: 'M0-2', title: 'Schema 声明层', evidence: ['src/schema/dsl.ts', 'src/schema/normalize.ts'] },
  { id: 'M0-3', title: '查询 AST 构建器', evidence: ['src/query/ast.ts', 'src/query/compile.ts'], probe: { file: 'test/query.test.ts', args: [] } },
  { id: 'M0-4', title: 'PG SQL 编译器', evidence: ['src/schema/compile/ddl.ts'] },
  { id: 'M0-5', title: '站点作用域：注入 + 抛错', evidence: ['src/db/scope.ts'], probe: { file: 'test/scope.test.ts', args: [] } },
  { id: 'M0-6', title: '驱动与连接', evidence: ['src/db/pool.ts', 'src/db/tx.ts'] },
  { id: 'M0-7', title: '迁移与 drift 检测', evidence: ['tools/db-migrate.ts', 'tools/db-check.ts', 'migrations/0001_init.sql'] },
  {
    id: 'M0-8',
    title: '内核服务（日志/DI/事件总线/调度器/咨询锁）',
    evidence: ['src/kernel/logger.ts', 'src/kernel/di.ts', 'src/kernel/events.ts', 'src/kernel/scheduler.ts', 'src/db/advisory-lock.ts'],
    probe: { file: 'test/kernel.test.ts', args: [] },
  },
  {
    id: 'M0-9',
    title: '认证与会话骨架（会话 + OIDC PKCE + HTTP 服务器）',
    evidence: ['src/auth/session.ts', 'src/auth/oidc.ts', 'src/http/server.ts', 'src/http/routes.ts'],
    probe: { file: 'test/auth.test.ts', args: [] },
  },
  {
    id: 'M0-10',
    title: '前端工程（零构建单页门户 + 可运行服务入口）',
    evidence: ['web/portal.ts', 'tools/serve.ts'],
    probe: { file: 'test/portal.test.ts', args: [] },
    note: '用零构建 SPA 而非 Vite/React：避免把「前端工具链可用」变成落地前置条件；后端契约已定，替换渲染层即可',
  },
  { id: 'M0-11a', title: '单一事务入口约束', evidence: ['src/db/guard.ts', 'src/db/tx.ts'] },
  { id: 'M0-11', title: 'CI 门禁', evidence: ['tools/ci-gate.ts'] },

  // ── M1 第一个切片 ──
  {
    id: 'M1-1',
    title: 'provider 插件接口 + ag_external_subjects',
    evidence: ['src/plugin/provider.ts', 'src/plugin/subjects.ts'],
    probe: { file: 'test/reconciler-db.test.ts', args: [] },
  },
  {
    id: 'M1-2',
    title: '通用对账器',
    evidence: ['src/core/reconciler.ts'],
    probe: { file: 'test/reconciler.test.ts', args: [] },
  },
  {
    id: 'M1-3',
    title: 'newapi-provider 插件（第一个真实 provider）',
    evidence: ['src/plugin/builtin/newapi-provider.ts'],
    probe: { file: 'test/newapi-provider.test.ts', args: [] },
    note: '插件包（src/plugin/builtin/**）按 docs/03 §781 允许出现具体系统名；CI 第 7 项对其排除，src 其余部分仍须为 0',
  },
  {
    id: 'M1-4',
    title: '插件宿主最小版（manifest 校验 / declarative 解释器 / 事实管线）',
    evidence: [
      'src/plugin/manifest.ts',
      'src/plugin/declarative.ts',
      'src/plugin/expr-lite.ts',
      'src/plugin/declarative-runner.ts',
      'src/plugin/host-api.ts',
    ],
    probe: { file: 'test/plugin-host.test.ts', args: [] },
  },
  {
    id: 'M1-5',
    title: '宿主 API 最小版（secrets/http/cache/storage）',
    evidence: ['src/plugin/host-api.ts'],
    probe: { file: 'test/plugin-host.test.ts', args: [] },
  },
  {
    id: 'M1-6',
    title: '内置插件 email-domain',
    evidence: ['src/plugin/builtin/email-domain.ts'],
    probe: { file: 'test/email-domain.test.ts', args: [] },
  },
  {
    id: 'M1-7',
    title: '身份对齐（四路径解析器 + OIDC 声明校验）',
    evidence: ['src/core/identity.ts'],
    probe: { file: 'test/identity.test.ts', args: [] },
    note: 'OIDC 的**签名验证**属 identity 插件（M4）；本轮交付声明层校验（iss/aud/exp）+ 对齐解析器',
  },
  {
    id: 'M1-8',
    title: '表达式引擎最小版',
    evidence: ['src/policy/expr.ts'],
    probe: { file: 'test/expr.test.ts', args: [] },
  },
  {
    id: 'M1-9',
    title: '策略最小模型 + 静态校验',
    evidence: ['src/policy/model.ts'],
    probe: { file: 'test/policy.test.ts', args: [] },
  },
  {
    id: 'M1-10',
    title: '用户门户「我的资格」（无头视图 + 可复跑演示）',
    evidence: ['src/policy/evaluator.ts', 'src/policy/eligibility.ts', 'tools/demo-eligibility.ts'],
    probe: { file: 'test/eligibility.test.ts', args: [] },
    note: '前端工程（M0-10）未建，故先交付无头资格视图与 CLI 演示；Web 页面待 M0-10',
  },
  {
    id: 'M1-11',
    title: '管理端最小（主体列表 / 手工绑定 / 策略编辑与发布 / 试算）',
    evidence: ['src/admin/api.ts'],
    probe: { file: 'test/admin.test.ts', args: [] },
    note: '交付框架无关的 HTTP 处理器（鉴权+作用域+校验+审计）；Web 页面待 M0-10 前端工程',
  },

  // ── M2 闭环 ──
  {
    id: 'M2-1',
    title: '动作执行器（幂等键 + Plan→Execute→Verify）',
    evidence: ['src/core/action-executor.ts'],
    probe: { file: 'test/action-executor.test.ts', args: [] },
  },
  {
    id: 'M2-5',
    title: '生命周期状态机（H1/H2 不变量）',
    evidence: ['src/core/lifecycle.ts'],
    probe: { file: 'test/lifecycle.test.ts', args: [] },
  },
  {
    id: 'M2-7',
    title: '策略版本化 + 发布/回滚（回滚是指针操作，不改写历史）',
    evidence: ['src/admin/api.ts', 'src/db/adapters.ts'],
    probe: { file: 'test/simulate.test.ts', args: [] },
    note: '版本历史 + publish + rollback + latestDraft；内存与 PG 两实现语义一致',
  },
  {
    id: 'M2-8',
    title: '试算影响面（复用真实迁移函数；高危影响单独列出）',
    evidence: ['src/policy/simulate.ts'],
    probe: { file: 'test/simulate.test.ts', args: [] },
  },

  // ── M3 表达力完整 ──
  {
    id: 'M3-1',
    title: '有序分支求值器（if/else-if/else；短路 + H1 不落 else）',
    evidence: ['src/policy/branches.ts'],
    probe: { file: 'test/branches.test.ts', args: [] },
    note: '形态 A 规整为单分支；indeterminate 不落 else；短路可断言',
  },
  {
    id: 'M3-3',
    title: '统一寻址与绑定解析（@实例 / #跨站点 / 数组下标）',
    evidence: ['src/policy/addressing.ts'],
    probe: { file: 'test/addressing.test.ts', args: [] },
    note: 'singleton 带 @ 拒绝；multi 不带 @ 拒绝；已撤销绑定不得支撑取值',
  },
  {
    id: 'M3-6',
    title: '@gate/expr 三形态转换（YAML/JSON/Graph；往返保真）',
    evidence: ['src/policy/expr-forms.ts'],
    probe: { file: 'test/expr-forms.test.ts', args: [] },
    note: 'property-based 200 例三向往返；布局不参与语义；specHash 只对规范 AST',
  },

  // ── M4 插件平台化 ──
  {
    id: 'M4-1',
    title: 'process 运行时（stdio JSON-RPC + 崩溃隔离 + 退避重启 + 超时杀）',
    evidence: ['src/plugin/process-runtime.ts'],
    probe: { file: 'test/process-runtime.test.ts', args: [] },
    note: '崩溃不影响宿主；在途请求被显式拒绝；连续失败达上限停止重启；插件经宿主出网',
  },
  {
    id: 'M4-6',
    title: '插件端点宿主（冲突检测 + 五种鉴权 + 三维限流 + 审计 + OpenAPI）',
    evidence: ['src/plugin/endpoints.ts'],
    probe: { file: 'test/endpoints.test.ts', args: [] },
    note: '注册端点不改主程序、不重启；编码穿越/保留路径/宿主路由冲突均拒绝',
  },
  { id: 'M4-8', title: 'UI 贡献宿主', evidence: ['src/plugin/ui-host.ts'] },
  {
    id: 'M4-12',
    title: 'LLM 网关（预算硬闸 + 原子预留 + 缓存 + 限流 + 成本统计）',
    evidence: ['src/plugin/llm-gateway.ts'],
    probe: { file: 'test/llm-gateway.test.ts', args: [] },
    note: '并发不超额（预留在同一同步执行内完成）；上游失败释放预留；缓存跨插件共享',
  },

  // ── M5 跨项目协同 ──
  {
    id: 'M5-1',
    title: '协同验证协议（HMAC + 时间戳 + nonce 防重放）',
    evidence: ['src/verify/hmac.ts', 'src/http/verify-routes.ts'],
    probe: { file: 'test/verify.test.ts', args: [] },
    note: '签名错误/过期/重放均被拒；常量时间比较；bodyHash 用原始字节',
  },
  {
    id: 'M5-2',
    title: '设备码流（发起 → 确认 → 轮询 → 撤销）',
    evidence: ['src/verify/device-code.ts', 'src/http/verify-routes.ts'],
    probe: { file: 'test/verify-routes.test.ts', args: [] },
    note: 'userCode 排除易混字符；服务端强制轮询限速；断言交付有次数上限',
  },
  {
    id: 'M5-3',
    title: '断言签名（ES256 JWS + JWKS 离线复核）',
    evidence: ['src/verify/jws.ts', 'src/http/verify-routes.ts'],
    probe: { file: 'test/verify.test.ts', args: [] },
    note: '篡改/alg:none/未知 kid 均被拒；retiring 密钥仍发布以保证已签发断言可验签',
  },

  // ── M6/M7 ──
  {
    id: 'M2-6',
    title: '巡检调度（评估→迁移→计划→执行→回读 闭环 + 接入调度器）',
    evidence: ['src/core/patrol.ts', 'src/core/patrol-service.ts', 'tools/serve.ts'],
    probe: { file: 'test/patrol-service.test.ts', args: [] },
    note: '已接入 tools/serve.ts：注册为调度任务、进程内单飞、状态供 readiness 判定',
  },
  {
    id: 'M6-1',
    title: 'Prometheus 指标（/metrics）+ 健康检查',
    evidence: ['src/kernel/metrics.ts', 'src/kernel/health.ts'],
    probe: { file: 'test/ops.test.ts', args: [] },
    note: 'Grafana 面板模板待补；指标与健康端点已就绪',
  },
  {
    id: 'M6-7',
    title: 'Docker Compose 一键部署 + 优雅启停',
    evidence: ['docker-compose.yml', 'Dockerfile', 'src/kernel/health.ts'],
    probe: { file: 'test/ops.test.ts', args: [] },
  },
  {
    id: 'M7-1',
    title: '开发者与站点模型（standalone 零配置可用）',
    evidence: ['src/core/sites.ts'],
    probe: { file: 'test/sites.test.ts', args: [] },
    note: '一对多（开发者→站点）；slug 安全校验；停用拒绝服务；开发者停用级联拒绝其站点',
  },
  // ── 路线图其余任务（本轮从 docs/07 全量纳入，使审计反映**真实**完成度）──
  // ★ 审计清单此前只是路线图的子集（41/90），「清单清零」并不等于「设计全部完成」。
  //   纳入后 done 数才可被独立验证，缺口也不再隐藏。
  { id: 'M2-10', title: '审计与动作流水', evidence: ['src/admin/api.ts', 'src/db/adapters.ts'], note: '审计与动作流水（audit sink + actions_log 适配器）' },
  { id: 'M2-11', title: '★ 端到端验收', evidence: ['test/patrol.test.ts'], note: '端到端验收（重复巡检 10 次仅 1 次写回）' },
  {
    id: 'M2-2',
    title: '`newapi-set-group`（read-modify-write + 敏感字段剔除 + 用户级互斥）',
    evidence: ['src/plugin/builtin/newapi-actions.ts'],
    probe: { file: 'test/newapi-actions.test.ts', args: [] },
    note: '值不变跳过 / 最小间隔防抖 / 回填全部既有属性但绝不带 password',
  },
  {
    id: 'M2-3',
    title: '`newapi-add-quota` / `newapi-set-status`（累加语义 + 状态幂等）',
    evidence: ['src/plugin/builtin/newapi-actions.ts'],
    probe: { file: 'test/newapi-actions.test.ts', args: [] },
    note: 'add_quota 不做值比对（幂等键在宿主）；set_status 值不变跳过；4xx 不重试 5xx 重试',
  },
  { id: 'M2-4', title: '失败重试与补偿', evidence: ['src/core/action-executor.ts'], note: '失败重试与补偿（退避序列 + 阻断 + 补偿）' },
  { id: 'M2-9', title: '影响面预估', evidence: ['src/policy/simulate.ts'], note: '影响面预估（simulate + compareVersions）' },
  {
    id: 'M3-10',
    title: '分流 `match` + 灰度 `rollout`（同一用户结果稳定）',
    evidence: ['src/policy/rollout.ts'],
    probe: { file: 'test/rollout.test.ts', args: [] },
    note: 'sha256 确定性分桶（非取模，避免连续 id 集中）；换 rolloutId 重新分桶',
  },
  {
    id: 'M3-11',
    title: '阶梯 `tier` / `requiresTier` / `collision` 合并语义',
    evidence: ['src/policy/planning.ts'],
    probe: { file: 'test/planning.test.ts', args: [] },
    note: '未达标「不参与判定」（非「不满足」）；平手按 code 稳定排序',
  },
  {
    id: 'M3-12',
    title: '渠道自动推断（不写 channel；enricher 递归展开 + 拓扑序）',
    evidence: ['src/policy/planning.ts'],
    probe: { file: 'test/planning.test.ts', args: [] },
    note: '未安装/未启用/环/命名空间冲突均在发布期拒绝',
  },
  {
    id: 'M3-13',
    title: '`explain` 模式完整化（逐项 + 缺口 + 依赖插件）',
    evidence: ['src/policy/planning.ts'],
    probe: { file: 'test/planning.test.ts', args: [] },
    note: '区分 false 与 indeterminate 的措辞；indeterminate 明确「无需操作」',
  },
  {
    id: 'M3-2',
    title: '完整逻辑操作符（all/any/not/none/atLeast/atMost/exactly/score）',
    evidence: ['src/policy/expr.ts'],
    probe: { file: 'test/expr.test.ts', args: [] },
    note: '计数式与加权分是 any/all 的语法糖，引擎只有一套求值逻辑',
  },
  {
    id: 'M3-4',
    title: '绑定解析（Binding Resolution）',
    evidence: ['src/policy/addressing.ts'],
    probe: { file: 'test/addressing.test.ts', args: [] },
    note: '命中→resolved / 未命中→自动解析 / 已撤销绑定不得支撑取值',
  },
  {
    id: 'M3-5',
    title: '动作目标复用统一寻址',
    evidence: ['src/policy/action-addressing.ts'],
    probe: { file: 'test/action-addressing-confirm.test.ts', args: [] },
    note: '与表达式共用解析器；跨站点写操作需显式允许；未知实例被拒',
  },
  {
    id: 'M3-7',
    title: '规范 AST 与语义去重（specHash 只对规范 AST 计算）',
    evidence: ['src/policy/expr-forms.ts'],
    probe: { file: 'test/expr-forms.test.ts', args: [] },
    note: '同一逻辑用 YAML 与图形编辑得到相同 hash（换编辑器不产生无意义 draft）',
  },
  {
    id: 'M3-8',
    title: '表达式编辑器：YAML + JSON 双视图（同步不漂移）',
    evidence: ['src/policy/editor.ts'],
    probe: { file: 'test/editor.test.ts', args: [] },
    note: 'AST 为单一事实来源；编辑任一面板其它面板同步；解析失败不污染状态',
  },
  {
    id: 'M3-9',
    title: '表达式编辑器：图形视图（结构编辑立即回到 AST）',
    evidence: ['src/policy/editor.ts'],
    probe: { file: 'test/editor.test.ts', args: [] },
    note: '布局不参与语义；removeNode 删整棵子树；不能删根节点',
  },
  {
    id: 'M4-10',
    title: 'UI 数据代理（只能访问本插件已批准端点）',
    evidence: ['src/plugin/governance.ts'],
    probe: { file: 'test/governance.test.ts', args: [] },
    note: '跨插件读数据被拒；方法/路径都要匹配',
  },
  {
    id: 'M4-11',
    title: '插件间调用（action:invoke + 深度限制 + 成环检测）',
    evidence: ['src/plugin/governance.ts'],
    probe: { file: 'test/governance.test.ts', args: [] },
    note: '签到插件可调 newapi-add-quota:add_quota；A→B→A 成环被拒',
  },
  {
    id: 'M4-13',
    title: '内置插件 `github`（开发者级 singleton，凭据共享）',
    evidence: ['src/plugin/builtin/features.ts'],
    probe: { file: 'test/builtin-features.test.ts', args: [] },
    note: 'token 标 secret；账号年龄纯函数',
  },
  {
    id: 'M4-14',
    title: '内置插件 `llm-review`（**不认识任何具体系统**）',
    evidence: ['src/plugin/builtin/features.ts'],
    probe: { file: 'test/builtin-features.test.ts', args: [] },
    note: '消费通用数组字段；LLM 失败降级启发式；缓存不重复计费',
  },
  {
    id: 'M4-15',
    title: '内置插件 `checkin`（时区 + 连签阶梯 + 策略门槛）',
    evidence: ['src/plugin/builtin/features.ts'],
    probe: { file: 'test/builtin-features.test.ts', args: [] },
    note: '按配置时区判今天；奖励确定性（重试不变金额）',
  },
  {
    id: 'M4-16',
    title: '`bot-bridge` 参考实现（标准协议 + 插件适配）',
    evidence: ['src/plugin/builtin/bot-bridge.ts'],
    probe: { file: 'test/bot-bridge.test.ts', args: [] },
    note: '协议委托给 core（插件不重造 challenge）；userCode 与 pollToken 分离；推送含时间戳签名防重放',
  },
  {
    id: 'M4-17',
    title: '验收：宿主无知（删掉内置插件核心仍能工作）',
    evidence: ['test/host-agnostic.test.ts'],
    probe: { file: 'test/host-agnostic.test.ts', args: [] },
    note: '静态：核心库零 import 内置插件；运行时：空注册表下求值/迁移/动作仍可用',
  },
  {
    id: 'M4-2',
    title: '权限模型完整（声明≠授予 + 运行期校验 + 拒绝审计）',
    evidence: ['src/plugin/governance.ts'],
    probe: { file: 'test/governance.test.ts', args: [] },
    note: '未授权调用被拒并记 denied（warn 级）；不得授予未声明的权限',
  },
  {
    id: 'M4-3',
    title: '配置作用域与实例模式（developer/site + singleton/multi）',
    evidence: ['src/plugin/governance.ts'],
    probe: { file: 'test/governance.test.ts', args: [] },
    note: '开发者级配置键不含 siteId → 凭据只配一次即被所有站点共享',
  },
  {
    id: 'M4-4',
    title: '插件存储分级（内置/DB/runtime 缓存）',
    evidence: ['src/plugin/storage-tiers.ts'],
    probe: { file: 'test/plugin-storage-webhook.test.ts', args: [] },
    note: '清空 runtime 后自动恢复；无 DB 时内置插件仍可用；孤儿缓存被检出',
  },
  {
    id: 'M4-5',
    title: '信任分级（后端/前端分别确认，可撤销）',
    evidence: ['src/plugin/governance.ts'],
    probe: { file: 'test/governance.test.ts', args: [] },
    note: '未勾选后端信任 → enable 被拒；撤销后端信任一并停用',
  },
  {
    id: 'M4-7',
    title: 'declarative webhook 端点（零代码：接收→校验→提取→写事实）',
    evidence: ['src/plugin/declarative-webhook.ts'],
    probe: { file: 'test/plugin-storage-webhook.test.ts', args: [] },
    note: '只允许 kind=webhook；fallback=reject 不猜测归属；父级缺失告警',
  },
  {
    id: 'M4-9',
    title: '三个 UI 渲染器（Declarative / RemoteModule / Iframe）',
    evidence: ['src/plugin/renderers.ts'],
    probe: { file: 'test/renderers.test.ts', args: [] },
    note: '插件渲染异常不白屏（降级卡）；样式不污染宿主（Shadow DOM / sandbox 无 allow-same-origin）',
  },
  {
    id: 'M5-4',
    title: '用户确认页（设备码流的人机界面）',
    evidence: ['src/verify/confirm-page.ts'],
    probe: { file: 'test/action-addressing-confirm.test.ts', args: [] },
    note: '展示「谁在请求+请求什么范围」；CSRF 强制；不泄露 code 是否存在',
  },
  {
    id: 'M5-5',
    title: '官方薄 SDK（签名 + 验签响应 + 轮询节奏 + 回调验签）',
    evidence: ['src/verify/sdk.ts'],
    probe: { file: 'test/sdk.test.ts', args: [] },
    note: '以受签名保护的 JWS 内容为权威（外层字段不可信）；无签名不静默跳过；轮询遵守服务端 interval',
  },
  {
    id: 'M5-6',
    title: 'OIDC 双向联邦（inbound 联邦登录 + 最小暴露 exposedClaims）',
    evidence: ['src/auth/federation.ts'],
    probe: { file: 'test/federation.test.ts', args: [] },
    note: '未声明的 claim 既不落库也不可见（过滤在写入前）；ref 不可变；站点不得注册 platform:*',
  },
  {
    id: 'M6-10',
    title: '三形态编辑器端到端（切换后发布，**行为一致**）',
    evidence: ['src/policy/authoring.ts'],
    probe: { file: 'test/authoring.test.ts', args: [] },
    note: '一路走到判定（不只比 AST）；切形态 hash 不变；换编辑器不产生新版本',
  },
  {
    id: 'M6-2',
    title: '回滚：单条 / 按主体 / 按策略批量（回滚 = 切版本 + 重新求值）',
    evidence: ['src/core/rollback.ts', 'src/admin/api.ts'],
    probe: { file: 'test/rollback.test.ts', args: [] },
    note: '单条指针回滚已由 admin API 提供；按主体/批量复用 Patrol；分批 + 失败不中断 + 幂等',
  },
  {
    id: 'M6-3',
    title: '灰度发布与一键熔断（稳定分桶 + 止血优先）',
    evidence: ['src/policy/rollout.ts'],
    probe: { file: 'test/rollout.test.ts', args: [] },
    note: '熔断连白名单一起回滚；幂等保留首次熔断者；受影响清单按站点分组；自动熔断有最小样本量保护',
  },
  {
    id: 'M6-4',
    title: '压测：全量评估吞吐 + 管理读 QPS（如实测量，不估算）',
    evidence: ['src/kernel/bench.ts', 'tools/bench.ts'],
    probe: { file: 'test/bench.test.ts', args: [] },
    note: '分位从原始样本线性插值；失败样本计入错误率但不计入分位；达标判定给出具体差距',
  },
  { id: 'M6-5', title: 'M6-5（标题待从 docs/07 补齐）', evidence: ['tools/key-rotation.ts'], note: '密钥轮换计划（standby 优先 + 拒绝不安全 apply）' },
  { id: 'M6-6', title: 'M6-6（标题待从 docs/07 补齐）', evidence: ['tools/backup-restore.ts'], note: '备份恢复演练（逐表行数比对，真实跑通）' },
  { id: 'M6-8', title: 'M6-8（标题待从 docs/07 补齐）', evidence: ['tools/security-audit.ts'], note: '安全自查清单（越权/SSRF/注入/密钥/会话，CI 第 9 项）' },
  {
    id: 'M6-9',
    title: '架构验收：核心系统无关（CI 第 7 项，含 --self-test 防恒真）',
    evidence: ['tools/ci-gate.ts'],
    note: '扫描 src/**（插件包除外）具体系统名 = 0；--self-test 证明该检查不是恒真',
  },
  {
    id: 'M7-10',
    title: '平台模式作为设置项（standalone ⇄ saas，含数据影响提示）',
    evidence: ['src/app/platform-mode.ts'],
    probe: { file: 'test/tenancy.test.ts', args: [] },
    note: '切换只改一个设置值 → 无需迁移/重启；降级不删数据且完全可逆',
  },
  {
    id: 'M7-2',
    title: '邀请入驻（一次性码 + TTL≤1h + 邮箱匹配 + 原子核销）',
    evidence: ['src/core/invitations.ts'],
    probe: { file: 'test/invitations.test.ts', args: [] },
    note: '只存 code_hash；TTL 服务端硬夹；并发核销只有一个成功；未入驻不得登录',
  },
  {
    id: 'M7-3',
    title: '开发者 OIDC 登录（必须已入驻 + 强制邮箱验证）',
    evidence: ['src/auth/flows.ts'],
    probe: { file: 'test/flows.test.ts', args: [] },
    note: '未入驻即拒绝；不自动建号',
  },
  {
    id: 'M7-4',
    title: '普通用户 OIDC 登录（首次自动建号 + 可选域名白名单）',
    evidence: ['src/auth/flows.ts'],
    probe: { file: 'test/flows.test.ts', args: [] },
    note: '与开发者链路用**不同 identity 命名空间**，共用即权限提升',
  },
  {
    id: 'M7-5',
    title: '用户两级选择（先开发者 → 再站点，含归属校验）',
    evidence: ['src/core/site-selection.ts'],
    probe: { file: 'test/site-selection.test.ts', args: [] },
    note: '跨开发者选择被拒（站点是隔离边界）；会话存内部 uuid 而非 slug；standalone 免选择',
  },
  {
    id: 'M7-6',
    title: 'admin 控制台（10 分区，需求清单机器核对）',
    evidence: ['src/admin/console.ts'],
    probe: { file: 'test/console.test.ts', args: [] },
    note: 'auditM7_6Coverage() 核对路线图每一项设置均有分区',
  },
  {
    id: 'M7-7',
    title: '开发者控制台（5 分区；**不可安装插件、不可新增 OIDC**）',
    evidence: ['src/admin/console.ts'],
    probe: { file: 'test/console.test.ts', args: [] },
    note: '否定式要求由能力缺失强制，而非 UI 隐藏',
  },
  {
    id: 'M7-8',
    title: '强制邮箱绑定（未验证不得入驻）',
    evidence: ['src/core/invitations.ts'],
    probe: { file: 'test/invitations.test.ts', args: [] },
    note: '校验失败不得消耗邀请码额度',
  },
  {
    id: 'M7-9',
    title: '全局审计与可见性（realm + developerId + siteId）',
    evidence: ['src/admin/audit-scope.ts'],
    probe: { file: 'test/tenancy.test.ts', args: [] },
    note: 'admin 全部；developer 仅名下；enduser 域只看自己（域优先于角色）',
  },

];

// ─────────────────────────── 审计逻辑 ───────────────────────────

type Status = 'done' | 'partial' | 'todo';

interface TaskResult {
  id: string;
  title: string;
  status: Status;
  present: string[];
  missing: string[];
  probeResult?: string;
}

function probePasses(probe: { file: string; args: string[] }): boolean {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', '--test', probe.file, ...probe.args], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 120_000,
    });
    return true;
  } catch {
    return false;
  }
}

function auditTask(task: TaskProbe): TaskResult {
  const present: string[] = [];
  const missing: string[] = [];
  for (const rel of task.evidence) {
    if (existsSync(path.join(ROOT, rel))) present.push(rel);
    else missing.push(rel);
  }
  let status: Status = missing.length === 0 ? 'done' : present.length > 0 ? 'partial' : 'todo';
  let probeResult: string | undefined;
  if (task.probe !== undefined && status === 'done') {
    const ok = probePasses(task.probe);
    probeResult = ok ? `探针 ${task.probe.file} PASS` : `探针 ${task.probe.file} FAIL`;
    if (!ok) status = 'partial';
  }
  return { id: task.id, title: task.title, status, present, missing, ...(probeResult === undefined ? {} : { probeResult }) };
}

/** 核对路线图里的任务编号集合与本地清单是否一致（防摘录漂移）。 */
function auditChecklistFreshness(): string[] {
  const warnings: string[] = [];
  if (!existsSync(ROADMAP)) return ['⚠ docs/07-实施路线图.md 不存在，无法核对任务清单新鲜度'];
  const doc = readFileSync(ROADMAP, 'utf8');
  const inDoc = new Set([...doc.matchAll(/\|\s*\*{0,2}(M\d+-\d+a?)\*{0,2}\s*\|/g)].map((m) => m[1]!));
  const local = new Set(TASKS.map((t) => t.id));
  const notAudited = [...inDoc].filter((id) => !local.has(id)).sort();
  const extra = [...local].filter((id) => !inDoc.has(id)).sort();
  if (notAudited.length > 0) {
    warnings.push(`⚠ 路线图有 ${notAudited.length} 项任务未纳入审计清单：${notAudited.join(', ')}`);
  }
  if (extra.length > 0) {
    warnings.push(`⚠ 审计清单有 ${extra.length} 项在路线图中找不到：${extra.join(', ')}`);
  }
  return warnings;
}

const MILESTONE_RE = /^(M\d+)-/;

function main(): void {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const onlyIdx = argv.indexOf('--milestone');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;

  const results = TASKS.map(auditTask);
  const filtered = only === undefined ? results : results.filter((r) => r.id.startsWith(`${only}-`));
  const warnings = auditChecklistFreshness();

  const byStatus = { done: 0, partial: 0, todo: 0 } as Record<Status, number>;
  for (const r of filtered) byStatus[r.status] += 1;

  const byMilestone = new Map<string, { done: number; partial: number; todo: number }>();
  for (const r of filtered) {
    const ms = MILESTONE_RE.exec(r.id)?.[1] ?? '?';
    const bucket = byMilestone.get(ms) ?? { done: 0, partial: 0, todo: 0 };
    bucket[r.status] += 1;
    byMilestone.set(ms, bucket);
  }

  if (asJson) {
    console.log(JSON.stringify({ filtered, warnings, byStatus, milestones: Object.fromEntries(byMilestone) }, null, 2));
    return;
  }

  console.log('═══ access-gate 缺口审计（机器化） ═══');
  console.log(`来源：docs/07-实施路线图.md §3 ｜ 本地审计清单：${TASKS.length} 项`);
  console.log('');
  const icon: Record<Status, string> = { done: '✅', partial: '🟡', todo: '⛔' };
  let currentMs = '';
  for (const r of filtered) {
    const ms = MILESTONE_RE.exec(r.id)?.[1] ?? '?';
    if (ms !== currentMs) {
      currentMs = ms;
      const b = byMilestone.get(ms);
      console.log(`── ${ms}（✅${b?.done ?? 0} 🟡${b?.partial ?? 0} ⛔${b?.todo ?? 0}）──`);
    }
    console.log(`  ${icon[r.status]} ${r.id.padEnd(7)} ${r.title}`);
    if (r.status !== 'done' && r.missing.length > 0) {
      console.log(`      └ 缺失证据：${r.missing.join(', ')}`);
    }
    if (r.probeResult !== undefined) console.log(`      └ ${r.probeResult}`);
  }
  console.log('');
  console.log(`合计：✅ done ${byStatus.done} ｜ 🟡 partial ${byStatus.partial} ｜ ⛔ todo ${byStatus.todo}`);
  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) console.log(w);
  }
}

main();
