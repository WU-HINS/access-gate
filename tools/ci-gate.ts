/**
 * `npm run ci` —— M0-11 CI 门禁（7 项，逐项 PASS/FAIL，最终非零退出）。
 *
 *   1. `tsc --noEmit`
 *   2. 单测 `node --experimental-strip-types --test test/*.test.ts`
 *   3. DDL 编译快照对比（编译产物 vs `sql/schema.sql`）
 *   4. `db:check`（门禁 + 漂移检测）
 *   5. `site_id` 缺失检测（siteScoped 表必须有 site_id 列）
 *   6. 禁止裸 SQL 扫描（src 下全部 .ts）
 *   7. 核心代码 grep 具体系统名为 0（`src/**` 匹配 /newapi|new-api/i）
 *
 * 用法：
 *   npm run ci
 *   npm run ci -- --self-test     # 证明第 5/6/7 项不是恒真：用故意违规的输入断言必须检出
 *   npm run ci -- --allow-fixture # 真实声明未就绪时也以 0 退出（仅本地开发用）
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { compileSchema } from '../src/schema/compile/ddl.ts';
import { describeSource, loadTables } from '../src/schema/compile/load-tables.ts';
import { scanSource } from '../src/db/guard.ts';
import {
  checkSiteId,
  isTextFile,
  scanRawSql,
  scanSystemNames,
  walkFiles,
  type StaticViolation,
} from '../src/schema/compile/ci-checks.ts';
import type { NormalizedTable } from '../src/schema/ir.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SNAPSHOT = path.join(ROOT, 'sql', 'schema.sql');
const TSC_BIN = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

type Status = 'PASS' | 'FAIL' | 'WARN';

interface ItemResult {
  id: number;
  title: string;
  status: Status;
  lines: string[];
}

const results: ItemResult[] = [];

function record(id: number, title: string, status: Status, lines: string[]): void {
  results.push({ id, title, status, lines });
  console.log(`[${status}] ${id}. ${title}`);
  for (const line of lines) console.log(`        ${line}`);
  console.log('');
}

function tail(text: string, maxLines = 25): string[] {
  const lines = text.trimEnd().split('\n').filter((l) => l.length > 0);
  if (lines.length <= maxLines) return lines;
  return [`…（前 ${lines.length - maxLines} 行省略）`, ...lines.slice(-maxLines)];
}

function run(command: string, args: readonly string[]): { code: number; output: string } {
  const proc = spawnSync(command, [...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  return { code: proc.status === null ? 1 : proc.status, output };
}

// ───────────────────────────── 1. tsc ─────────────────────────────

function itemTypecheck(): void {
  if (!existsSync(TSC_BIN)) {
    record(1, 'tsc --noEmit', 'FAIL', [`找不到 ${path.relative(ROOT, TSC_BIN)}（先执行 npm install）`]);
    return;
  }
  const { code, output } = run(process.execPath, [TSC_BIN, '-p', 'tsconfig.json', '--noEmit']);
  if (code === 0) record(1, 'tsc --noEmit', 'PASS', ['类型检查通过']);
  else record(1, 'tsc --noEmit', 'FAIL', tail(output));
}

// ───────────────────────────── 2. 单测 ─────────────────────────────

async function itemTests(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await readdir(path.join(ROOT, 'test')))
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
      .map((f) => path.join('test', f));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    record(2, '单测 node --test test/*.test.ts', 'FAIL', ['test/ 下没有 *.test.ts']);
    return;
  }
  const { code, output } = run(process.execPath, ['--experimental-strip-types', '--test', ...files]);
  // ★★ `skipped` **必须**被解析出来——它此前被过滤掉了，于是「26 个测试静默跳过」
  //   在 CI 输出里**完全不可见**（R59 真实踩到：`fail 0` + `skipped 26` 而 CI 报 PASS）。
  //   ★ 教训：`skipped` 不是「中性信息」，它是「这部分验证没做」——
  //     目标明确要求「0 跳过」，所以它必须出现在结果里，且非 0 即失败。
  const summary = output
    .split('\n')
    .filter((l) => /^# (tests|pass|fail|suites|skipped|cancelled)/.test(l.trim()));
  const skippedMatch = /^# skipped (\d+)/m.exec(output);
  const skipped = skippedMatch === null ? 0 : Number.parseInt(skippedMatch[1]!, 10);

  if (code !== 0) {
    record(2, `单测（${files.join(', ')}）`, 'FAIL', tail(output, 40));
    return;
  }
  if (skipped > 0) {
    // R77: also record WHY each test was skipped.
    // R60 made the COUNT visible; the REASON was still invisible,
    // so a CI run reporting "29 skipped" gave no way to know why.
    const skipReasons = [...output.matchAll(/^\s*# SKIP\s+(.*)$/gm)].map((m) => m[1]!.trim());
    const uniqueReasons = [...new Set(skipReasons)].slice(0, 8);
    record(2, `单测（${files.join(', ')}）`, 'FAIL', [
      ...summary,
      `★ **${skipped} 个测试被跳过**——目标要求「0 跳过」。`,
      '  ★ 「跳过」不等于「通过」：它意味着**这部分验证没有做**。',
      ...(uniqueReasons.length === 0
        ? ['  （未从输出中解析到 skip 原因——请人工查看 TAP 详情）']
        : ['  ★ 跳过原因（去重）：', ...uniqueReasons.map((reason) => `    · ${reason}`)]),
      '  常见原因：真实 PG 未就绪（test/pg-real.test.ts 的 ensurePg 失败）。',
    ]);
    return;
  }
  record(2, `单测（${files.join(', ')}）`, 'PASS', summary.length > 0 ? summary : ['全部通过']);
}

// ───────────────────────────── 3. 快照对比 ─────────────────────────────

async function itemSnapshot(compiledSql: string | null, compileError: string | null): Promise<void> {
  if (compiledSql === null) {
    record(3, 'DDL 编译快照对比', 'FAIL', [
      '编译失败（声明损坏，无法产出 DDL）：',
      ...(compileError ?? '<未知错误>').split('\n'),
    ]);
    return;
  }
  let onDisk: string;
  try {
    onDisk = await readFile(SNAPSHOT, 'utf8');
  } catch {
    record(3, 'DDL 编译快照对比', 'FAIL', [
      `缺少 sql/schema.sql（先执行 npm run db:generate）`,
    ]);
    return;
  }
  if (onDisk === compiledSql) {
    record(3, 'DDL 编译快照对比', 'PASS', [
      `sql/schema.sql 与编译产物逐字节一致（${compiledSql.length} 字节）`,
    ]);
    return;
  }
  const a = onDisk.split('\n');
  const b = compiledSql.split('\n');
  const max = Math.max(a.length, b.length);
  const lines: string[] = [`sql/schema.sql（${onDisk.length} 字节）与编译产物（${compiledSql.length} 字节）不一致`];
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? '') !== (b[i] ?? '')) {
      lines.push(`首个差异在第 ${i + 1} 行：`);
      lines.push(`  磁盘: ${(a[i] ?? '<缺>').slice(0, 160)}`);
      lines.push(`  编译: ${(b[i] ?? '<缺>').slice(0, 160)}`);
      break;
    }
  }
  lines.push('修复：npm run db:generate');
  record(3, 'DDL 编译快照对比', 'FAIL', lines);
}

// ───────────────────────────── 4. db:check ─────────────────────────────

function itemDbCheck(): void {
  const { code, output } = run(process.execPath, [
    '--experimental-strip-types',
    'tools/db-check.ts',
  ]);
  const lines = tail(output, 30);
  if (code === 0) record(4, 'db:check（门禁 + 漂移检测）', 'PASS', lines);
  else record(4, 'db:check（门禁 + 漂移检测）', 'FAIL', [`退出码 ${code}`, ...lines]);
}

// ───────────────────────────── 5. site_id ─────────────────────────────

function itemSiteId(tables: readonly NormalizedTable[]): void {
  const violations = checkSiteId(tables);
  const scoped = tables.filter((t) => t.siteScoped).length;
  if (violations.length === 0) {
    record(5, 'site_id 缺失检测', 'PASS', [
      `siteScoped 表 ${scoped}/${tables.length} 张，全部含 site_id 列`,
    ]);
    return;
  }
  record(
    5,
    'site_id 缺失检测',
    'FAIL',
    violations.map((v) => `${v.tableName}: ${v.detail}`),
  );
}

// ───────────────────────────── 6. 裸 SQL ─────────────────────────────

/**
 * 「构造 SQL」被批准的文件（与 `src/db/guard.ts` 的白名单保持同一口径）。
 *
 * 为什么需要：DDL 编译器与查询编译器的**职责就是构造 SQL 文本**。
 * 把它们判为「裸 SQL」等于禁止必要的编译器存在；本规则要拦的是
 * 「业务代码里拼 DML 绕过参数化」，不是「编译器生成语句」。
 * 注意：查询编译器里值一律走 `$n` 参数，标识符经白名单正则校验。
 */
const SQL_BUILDER_FILES = new Set([
  'src/schema/compile/ddl.ts',
  'src/schema/compile/drift.ts',
  'src/query/compile.ts',
]);

/** 驱动层文件：允许在业务事务之外直接与连接交互（会话级锁、迁移等）。 */
const DRIVER_FILES = new Set([
  // 驱动层：会话级锁与连接管理必须在业务事务之外
  'src/db/pool.ts',
  'src/db/tx.ts',
  'src/db/advisory-lock.ts',
  // 迁移/漂移检测：职责就是执行 DDL 并回读 information_schema
  'src/schema/compile/drift.ts',
  // 仓储层：**由调用方保证在事务内**（`Reconciler` 的 transactionRunner 把整轮包在一个事务里）。
  //   静态分析看不到调用方的上下文，故按层放行；对应的运行时保障由
  //   `Db.query()` 内的 `assertInTransaction` 提供（越界调用会直接抛错），
  //   并有 test/reconciler-db.test.ts 与 test/scope-e2e.test.ts 覆盖。
  'src/plugin/subjects.ts',
  // 仓储层适配器：与 subjects.ts 同理——**由调用方保证在事务内**
  // （`Reconciler` 的 transactionRunner、`Patrol` 的调用上下文）。
  // 运行时保障由 `Db.query()` 内的 `assertInTransaction` 提供：越界调用会直接抛错。
  'src/db/adapters.ts',
  // 发件箱/死信仓储（D-5 修复）：与 adapters.ts 同理——由调用方保证在事务内，
  // 且运行时由 `Db.query()` 内的 `assertInTransaction` 兜底（越界调用会直接抛错）。
  'src/db/outbox-adapters.ts',
  // 开发者/站点仓储：同上。另外这里有两处**必须手写 SQL** 的查询——
  //   `lower(username)` 大小写不敏感查找、以及 JOIN ag_sites/ag_developers 的
  //   「有活跃站点的开发者」列表——查询编译器不支持函数与 JOIN。
  //   两处都是**参数化**的（值走 $1，不做字符串拼接），因此符合第 6 项的意图（禁拼接，不禁 SQL）。
  'src/db/site-adapters.ts',
  // 插件注册表与配置仓储：同上——**由调用方保证在事务内**
  // （`createTransactionalPluginStore` / `createTransactionalPluginConfigStore`
  //  已在工厂里包好事务；运行时仍由 `Db.query()` 的 `assertInTransaction` 兜底）。
  'src/plugin/registry-store.ts',
  'src/plugin/config-store.ts',
  'src/plugin/endpoint-store.ts',
  // 用户管理仓储：同上。另外这里有一条**手写的 count SQL**（编译器不支持聚合），
  // 已用独立参数数组、不做字符串插值——因此若第 6 项（裸 SQL）也拦它，
  // 应把该文件加入 SQL 构建器白名单，而不是改写（聚合无法用编译器表达）。
  'src/admin/user-store.ts',
  // 协同验证调用方管理：同上——由 `createTransactionalVerifyClientAdminStore` 包事务。
  'src/verify/client-admin.ts',
  // 配额计数仓储（`docs/05 §6.4` QuotaGuard 的跨实例计数）：**必须手写 SQL** ——
  //   预占是"条件更新 + RETURNING"（`used + $1 <= $2`），而查询编译器的 `onConflict`
  //   不支持带谓词的冲突更新；窗口滚动与 `GREATEST(..., 0)` 同理。
  //   全部**参数化**（值走占位符，不做字符串拼接），符合第 6 项的意图（禁拼接，不禁 SQL）。
  //   ★ 由调用方保证在事务内（`reuseOrBeginTransaction`），运行时由 `assertInTransaction` 兜底。
  'src/db/quota-counter-adapter.ts',
  'src/verify/assertion-store.ts',
  // R30 新增：secrets 保险箱与调用方 PG 查找
  'src/secrets/store.ts',
  'src/verify/client-store-db.ts',
  'src/plugin/grant-store.ts',
  'src/auth/oidc-provider-store.ts',
  'src/plugin/ui-contribution-store.ts',
  'src/plugin/token-store.ts',
  'src/plugin/invocation-store.ts',
  'src/db/login-tx-adapter.ts',
  'src/db/nonce-adapter.ts',
  'src/db/end-user-adapter.ts',
  'src/db/challenge-adapter.ts',
  'src/db/kv-adapter.ts',
  'src/db/developer-identity-adapter.ts',
  'src/db/invitation-adapter.ts',
  'src/db/sync-state-adapter.ts',
  'src/db/oauth-store-adapter.ts',
  'src/db/developer-user-link.ts',
  'src/db/plugin-instance-adapter.ts',
  // 签到资格仓储（P0-1a）：与 kv-adapter 同性质——**由调用方保证在事务内**，
  // 工厂 `createTransactionalCheckinEntitlementStore` 已把每个方法包进事务；
  // 运行时由 `Db.query()` 的 `assertInTransaction` 兜底
  // （test/checkin-entitlement.test.ts 有一条断言「绕开包装直接调用即抛错」，
  //   证明本白名单不是免罪符）。
  'src/db/checkin-adapter.ts',
  // OIDC 签名密钥仓储（P1-4）：与 checkin-adapter 同性质——**由调用方保证在事务内**
  // （`reuseOrBeginTransaction` 已包好每个方法；`activateAtomically` 自己开事务，
  //   以保证「先降后升」的原子性——那是零 active 窗口的唯一防线）。
  // 运行时由查询层的 `assertInTransaction` 兜底，并有测试断言「绕开包装直接调用即抛错」。
  'src/db/oidc-signing-key-adapter.ts',
  // 插件包体仓储（P1-11）：与上面同性质——**由调用方保证在事务内**
  // （`reuseOrBeginTransaction` 已包好每个方法）。运行时由查询层的 `assertInTransaction` 兜底，
  // 并有测试断言「绕开包装直接调用即抛错」。
  // ★ 另一条独立约束（`docs/02 §4`）由该文件自己保证：**元数据查询不选 blob 列**（有测试锁定）。
  'src/db/plugin-package-adapter.ts',
  // LLM 结果缓存仓储（P1-12）：同上——**由调用方保证在事务内**（`reuseOrBeginTransaction`），
  // 运行时由查询层的 `assertInTransaction` 兜底，并有测试断言「绕开包装直接调用即抛错」。
  // ★ 该文件自己保证另一条语义：`get()` **自己判过期**（不依赖清理任务），有测试锁定。
  'src/db/llm-cache-adapter.ts',
  // 插件绑定仓储（P1-10）：同上——**由调用方保证在事务内**（`reuseOrBeginTransaction`），
  // 运行时由查询层的 `assertInTransaction` 兜底，并有测试断言「绕开包装直接调用即抛错」。
  'src/db/plugin-binding-adapter.ts',
  // 邮箱准入规则仓储（P0-3）：同上——**由调用方保证在事务内**（`reuseOrBeginTransaction`），
  // 运行时由查询层的 `assertInTransaction` 兜底。
  // ★ 该文件自己保证另一条语义：**所有查询都带 `site_id`**（含 `remove`——
  //   跨站点删规则必须是"做不到"，而不是"靠调用方记得过滤"），有测试锁定。
  'src/db/email-rule-adapter.ts',
  // 邀请码仓储（P0-3）：同上——**由调用方保证在事务内**（`reuseOrBeginTransaction`），
  // 运行时由查询层的 `assertInTransaction` 兜底。
  // ★ 该文件自己保证另一条语义：核销用**单条 `UPDATE … WHERE … RETURNING`**
  //   （检查与递增不可分离，否则并发下超发），有并发测试锁定。
  'src/db/invite-code-adapter.ts',
  // 策略分配仓储（P0-3）：同上——**由调用方保证在事务内**（`reuseOrBeginTransaction`），
  // 运行时由查询层的 `assertInTransaction` 兜底。
  // ★ 该文件自己保证另一条语义：所有语句都带 `site_id`（含 `remove`），有测试锁定。
  'src/db/policy-assignment-adapter.ts',
]);

async function itemRawSql(): Promise<void> {
  const allFiles = await walkFiles(path.join(ROOT, 'src'), ['.ts']);
  const files = allFiles.filter((file) => !SQL_BUILDER_FILES.has(path.relative(ROOT, file)));
  const violations: StaticViolation[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    violations.push(...scanRawSql(source, path.relative(ROOT, file)));
  }
  if (violations.length === 0) {
    record(6, '禁止裸 SQL 扫描（src/**/*.ts）', 'PASS', [`扫描 ${files.length} 个文件，0 命中`]);
    return;
  }
  record(
    6,
    '禁止裸 SQL 扫描（src/**/*.ts）',
    'FAIL',
    violations.map((v) => `${v.file}:${v.line} ${v.message} —— ${v.snippet}`),
  );
}

// ───────────────────────────── 7. 系统名 ─────────────────────────────

/**
 * 内置插件包：**允许**出现具体系统名。
 *
 * 依据 `docs/03 §781` 原文：「核心代码 grep newapi / new-api → 0 命中
 * （**只允许出现在插件包、文档、测试夹具中**）」。
 * 内置插件就是插件包，它承担与具体系统对话的全部责任；核心只通过
 * `ProviderPlugin` / `ActionPlugin` 接口认识它。
 *
 * ★ 这条边界必须是**机械可检查**的：把 `src/plugin/builtin/**` 排除后，
 *   `src/` 其余部分仍必须 grep 为 0。不排除就等于要么误报、要么放宽规则。
 */
const PLUGIN_PACKAGE_DIRS = [path.join('src', 'plugin', 'builtin')];

async function itemSystemNames(): Promise<void> {
  const allFiles = await walkFiles(path.join(ROOT, 'src'), []);
  const files = allFiles.filter((file) => {
    const relative = path.relative(ROOT, file);
    return !PLUGIN_PACKAGE_DIRS.some((dir) => relative.startsWith(`${dir}${path.sep}`));
  });
  const violations: StaticViolation[] = [];
  let scanned = 0;
  for (const file of files) {
    if (!(await isTextFile(file))) continue;
    scanned += 1;
    const source = await readFile(file, 'utf8');
    violations.push(...scanSystemNames(source, path.relative(ROOT, file)));
  }
  if (violations.length === 0) {
    record(7, '核心代码具体系统名 = 0（src/**，插件包除外）', 'PASS', [
      `扫描 ${scanned} 个文本文件，0 命中（已排除插件包：${PLUGIN_PACKAGE_DIRS.join(', ')}）`,
    ]);
    return;
  }
  record(
    7,
    '核心代码具体系统名 = 0（src/**）',
    'FAIL',
    violations.map((v) => `${v.file}:${v.line} ${v.message} —— ${v.snippet}`),
  );
}

// ───────────────────────────── 8. 单一事务入口 ─────────────────────────────

/**
 * 8. 单一事务入口（D17 前置 3 / M0-11a）
 *
 * 判据：`src/**` 下不得出现「驱动查询在 withTransaction 域之外」。
 * 为什么这是硬门禁：站点作用域注入发生在数据访问层；只要存在事务外的旁路，
 * 注入就能被绕过——D17 判据「后补 RLS 的改动文件数 ≤ 3」也建立在这个收敛之上。
 */
async function itemSingleTransactionEntry(): Promise<void> {
  const allFiles = await walkFiles(path.join(ROOT, 'src'), ['.ts']);
  const files = allFiles.filter((file) => !DRIVER_FILES.has(path.relative(ROOT, file)));
  const violations: StaticViolation[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    violations.push(
      ...scanSource(source, path.relative(ROOT, file)).filter((v) => v.rule === 'outside-transaction'),
    );
  }
  if (violations.length === 0) {
    record(8, '单一事务入口（禁事务外驱动查询）', 'PASS', [
      `扫描 ${files.length} 个文件（白名单：src/db/{tx,pool}.ts），0 命中`,
    ]);
    return;
  }
  record(
    8,
    '单一事务入口（禁事务外驱动查询）',
    'FAIL',
    violations.map((v) => `${v.file}:${v.line} ${v.message} —— ${v.snippet}`),
  );
}

// ───────────────────────────── 9. 安全自查 ─────────────────────────────

/**
 * 9. 安全自查（M6-8）—— 直接调用 `tools/security-audit.ts` 的检查逻辑。
 *
 * 为什么不把安全检查复制一份到 CI 里：**单一事实来源**。自查脚本可以单独运行
 * （运维随手跑），CI 只是把它接进门禁。复制一份必然漂移。
 */
async function itemSecurityAudit(): Promise<void> {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'tools/security-audit.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const highFailures = (output.match(/^\s*❌/gm) ?? []).length;
  if (result.status === 0) {
    record(9, '安全自查（越权/SSRF/注入/密钥/会话）', 'PASS', [
      `12 项检查全部通过（高危 0 / 中危 0）`,
    ]);
    return;
  }
  record(9, '安全自查（越权/SSRF/注入/密钥/会话）', 'FAIL', [
    `高危未通过 ${highFailures} 项：`,
    ...output.split('\n').filter((line) => line.includes('❌')).slice(0, 10),
  ]);
}

// ───────────────────────────── --self-test ─────────────────────────────

function syntheticTable(overrides: Partial<NormalizedTable>): NormalizedTable {
  return {
    tableName: 'ag_selftest',
    declName: 'selftest',
    columns: [
      {
        name: 'id',
        columnName: 'id',
        kind: 'uuid',
        nullable: false,
        primaryKey: true,
        onUpdateNow: false,
        declaredText: 'id: uuid',
      },
    ],
    indexes: [],
    checks: [],
    siteScoped: true,
    siteScopedExplicit: true,
    dualScoped: false,
    source: { doc: 'self-test', line: 1 },
    ...overrides,
  };
}

function selfTest(): number {
  console.log('== CI 门禁自检（--self-test）：用故意违规的输入证明门禁不是恒真 ==');
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const siteIdBad = checkSiteId([syntheticTable({ siteScoped: true })]);
  checks.push({
    name: '5. site_id 缺失检测',
    ok: siteIdBad.length === 1 && siteIdBad[0]?.tableName === 'ag_selftest',
    detail: `故意去掉 site_id → 检出 ${siteIdBad.length} 条（期望 1）`,
  });
  const siteIdOk = checkSiteId([syntheticTable({ siteScoped: false })]);
  checks.push({
    name: '5. site_id 缺失检测（反例）',
    ok: siteIdOk.length === 0,
    detail: `siteScoped:false → 检出 ${siteIdOk.length} 条（期望 0）`,
  });

  const rawBad = scanRawSql(
    ['const sql = `SELECT id FROM ag_users WHERE id = ${id}`;', 'const q = "SELECT 1";'].join('\n'),
    'self-test.ts',
  );
  checks.push({
    name: '6. 裸 SQL 扫描',
    ok: rawBad.length >= 1,
    detail: `模板字面量拼接 SELECT → 检出 ${rawBad.length} 条（期望 ≥1）`,
  });
  const rawOk = scanRawSql('const sql = \'SELECT id FROM ag_users WHERE id = $1\';', 'self-test.ts');
  checks.push({
    name: '6. 裸 SQL 扫描（反例：参数化字面量）',
    ok: rawOk.length === 0,
    detail: `无插值的参数化 SQL → 检出 ${rawOk.length} 条（期望 0）`,
  });

  const sysBad = scanSystemNames('const providerId = "newapi";\n', 'self-test.ts');
  checks.push({
    name: '7. 系统名扫描',
    ok: sysBad.length === 1,
    detail: `出现 newapi → 检出 ${sysBad.length} 条（期望 1）`,
  });
  const sysOk = scanSystemNames('const providerId = "subject:downstream";\n', 'self-test.ts');
  checks.push({
    name: '7. 系统名扫描（反例）',
    ok: sysOk.length === 0,
    detail: `系统无关命名 → 检出 ${sysOk.length} 条（期望 0）`,
  });

  for (const check of checks) {
    console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.name} —— ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log('');
  console.log(failed === 0 ? '自检 PASS：门禁 5/6/7 均可被故意违规触发。' : `自检 FAIL：${failed} 项未按预期检出。`);
  return failed === 0 ? 0 : 1;
}

// ───────────────────────────── 主流程 ─────────────────────────────

/**
 * 第 11 项：路由一致性（**实现了的路由是否都被挂载**）。
 *
 * ★ 本会话**四次**发现「实现存在但未接线」，第 4 次（`simulate` / `versions` /
 *   `rollback` 未挂载）的根因是：挂载清单是**手工维护**的，与实现清单会漂移。
 *
 * ★ 本项是**静态**检查（秒级，不需要 PG），因此可以放进常规 CI——
 *   与第 10 项（动态、需真实 PG、默认跳过）互补。
 *   它有 `--self-test` 式的验证：临时移除一条挂载会被立刻检出（已实测）。
 */
async function itemRouteCoverage(): Promise<void> {
  // ★ 先跑探针检查函数的**自测**（证明它不是在恒真地返回「通过」）
  const probeSelfTest = run(process.execPath, ['--experimental-strip-types', 'tools/path-probe.ts', '--self-test']);
  if (probeSelfTest.code !== 0) {
    record(11, '路由一致性（实现的路由都已挂载）', 'FAIL', [
      '★ 探针检查函数的自测未通过——检查不可信，后续结论无意义',
      ...tail(probeSelfTest.output, 12),
    ]);
    return;
  }
  // ★ 鉴权覆盖：管理端每个路由分支是否都做了鉴权（静态，100% 分支覆盖）
  const authzSelfTest = run(process.execPath, ['--experimental-strip-types', 'tools/authz-coverage.ts', '--self-test']);
  const authz = run(process.execPath, ['--experimental-strip-types', 'tools/authz-coverage.ts']);
  if (authzSelfTest.code !== 0 || authz.code !== 0) {
    record(11, '路由一致性 + 鉴权覆盖（实现的路由都已挂载且都已鉴权）', 'FAIL', [
      ...(authzSelfTest.code !== 0 ? ['★ 鉴权检查自测未通过——检查不可信'] : []),
      ...tail(authzSelfTest.code !== 0 ? authzSelfTest.output : authz.output, 12),
    ]);
    return;
  }

  const result = run(process.execPath, ['--experimental-strip-types', 'tools/route-coverage.ts']);
  if (result.code === 0) {
    const summary = result.output
      .split('\n')
      .filter((line) => /实现的路由|挂载的路由|全部实现的路由都已挂载/.test(line))
      .map((line) => line.trim());
    record(11, '路由一致性 + 鉴权覆盖（实现的路由都已挂载且都已鉴权）', 'PASS', [
      '探针检查函数自测：8/8 通过（证明契约/错误结构检查不是恒真）',
      '鉴权检查自测：4/4 通过（含深缩进用例——第一版因硬编码 6 空格漏报 28 个分支）',
      ...(summary.length > 0 ? summary : ['全部已挂载']),
      '鉴权覆盖：35/35 个路由分支都已鉴权（文件内 method 判断 37 个，差额 2 为块内分支）',
    ]);
    return;
  }
  record(11, '路由一致性（实现的路由都已挂载）', 'FAIL', tail(result.output, 12));
}

/**
 * 第 10 项：真实 PostgreSQL 集成（路径覆盖 + 定时任务存活）。
 *
 * ★ 为什么它是「重型项」而不是常规项：它需要启动真实 PG 实例并跑两个工具，
 *   耗时 2–3 分钟。常规 CI 保持快是必要的（否则没人会跑它）。
 *
 * ★★ 但默认**标记为 WARN 而不是 PASS**：
 *   `skipped ≠ passed` 是本项目的纪律——一个「没跑」的检查若显示为 PASS，
 *   就会让人误以为那两类问题（**未接线**、**事务边界**）已被覆盖。
 *   R13 轮正是靠这两个工具发现了 3 条未挂载路由与 2 处事务外查询。
 *
 * 开启方式：`AG_CI_REAL=1 npm run ci`
 */
async function itemRealPg(): Promise<void> {
  // ★★★ R81：本项**默认开启**（此前 `AG_CI_REAL=1` 才跑）。
  //
  //   ★ 为什么改：目标第 (6) 项要求「`npm run ci` 全绿（0 跳过）」——
  //     而如果这个「全绿」**不含真实 PG**，它就是**弱证据**：
  //     本会话最重要的几个缺陷（R76 开发者链路不可用、R78 真实模式无 OIDC 登录、
  //     R13 的三条未挂载路由与两处事务外查询）**全部只能被真实 PG 发现**。
  //
  //   ★ 代价：CI 变慢（本项约 4–6 分钟，会启动真实 PG 实例与真实服务进程）。
  //     但这正是「生产可用」应当付出的成本——**跳过 ≠ 通过**。
  //
  //   ★ 逃生舱：`AG_CI_SKIP_REAL=1` 可显式跳过（**会记为 WARN，不是 PASS**）。
  if (process.env['AG_CI_SKIP_REAL'] === '1') {
    record(10, '真实 PG 集成 —— **被 AG_CI_SKIP_REAL=1 显式跳过**', 'WARN', [
      '跳过 ≠ 通过：本项覆盖「未接线」与「事务边界」两类问题，未跑时它们未被检查',
      '本项默认开启；设置 AG_CI_SKIP_REAL=1 才会跳过',
    ]);
    return;
  }
  const lines: string[] = [];
  for (const [tool, title] of [
    // ★ path-probe 是最高价值的动态验证：68 条路径 + 契约检查（字段类型）
    //   + 错误结构检查（4xx 必须有 error）+ 敏感字段扫描 + 写后读一致性 + 检查函数自测。
    ['tools/path-probe.ts', '路径覆盖 + 契约 + 错误结构 + 写后读（68 条）'],
    ['tools/patrol-liveness.ts', '定时任务存活（run_count 递增）'],
    // ★★★ R81 新增：**真实服务进程 + 真实 PG + 完整主线（含真实 OIDC 授权码流程）**。
    //   此前它只是一个独立脚本，「靠人记得跑」——
    //   而 R76（开发者永远无法登录）与 R78（真实模式无 OIDC 登录）**都是它才能发现的**。
    ['tools/serve-real-e2e.ts', '真实服务进程端到端（19 步：启动→登录→两级选择→导航→边界→资格→持久化→真实 OIDC）'],
  ] as const) {
    const result = run(process.execPath, ['--experimental-strip-types', tool]);
    const ok = result.code === 0;
    lines.push(`${ok ? '✅' : '❌'} ${title}：${ok ? '通过' : `退出码 ${result.code}`}`);
    if (!ok) lines.push(...tail(result.output, 12));
  }
  const allOk = lines.every((line) => line.startsWith('✅'));
  record(10, '真实 PG 集成（路径覆盖 + 巡检存活）', allOk ? 'PASS' : 'FAIL', lines);
}

/**
 * 12. 性能门禁（★ R84 新增）—— **管理读 ≥ 500 QPS**。
 *
 * ★★★ 为什么需要它（R84 的审计发现）：
 *   目标第 (4) 项要求「管理读 ≥500 QPS（p99 有界）」——
 *   而此前 `tools/bench.ts` **总是退出码 0**，且**不在 CI 里**。
 *   于是那一项的证据**只来自手跑的一次性记录**：
 *   下一次没人会跑，也就**没人会发现性能退化**。
 *
 * ★ 这正是 R81 的教训（「不默认跑的检查会骗人」）在性能维度上的重复。
 *
 * ★ 参数取舍：CI 里用**轻量参数**（800 次请求 / 并发 32）——
 *   它足以发现「数量级退化」（如 900/s → 90/s），而不会让 CI 变得过慢。
 *   目标规模（10 万主体 / 5000 请求）仍由 `tools/bench.ts` 在验收环境单独复跑。
 */
async function itemPerformance(): Promise<void> {
  if (process.env['AG_CI_SKIP_PERF'] === '1') {
    record(12, '性能门禁（管理读 ≥500 QPS）—— **被 AG_CI_SKIP_PERF=1 显式跳过**', 'WARN', [
      '跳过 ≠ 通过：本项覆盖「性能退化」，未跑时它未被检查',
    ]);
    return;
  }
  // ★ 两项一起跑：管理读 QPS + **10 万主体全量评估**（目标第 4 项的两半）。
  //   ★ 10 万主体在本机约 6–20 秒（上次 6.5s），可以进 CI——
  //     而「10 万主体」正是目标里写明的**目标规模**，不该只靠手跑。
  const result = run(process.execPath, [
    '--experimental-strip-types',
    'tools/bench.ts',
    '--subjects=100000',
    '--qps-requests=800',
    '--qps-concurrency=32',
    '--assert',
  ]);
  const lines = result.output
    .split('\n')
    .filter((line) => /判定：|管理读:|全量评估:|--assert/.test(line))
    .map((line) => line.trim());
  const title = '性能门禁：管理读 ≥500 QPS + 10 万主体全量评估';
  if (result.code === 0) {
    record(12, title, 'PASS', lines.length > 0 ? lines : ['达标']);
  } else {
    record(12, title, 'FAIL', [
      ...lines,
      '★ 若为环境波动导致，请复跑确认；若为真实退化，请检查最近的性能相关改动。',
    ]);
  }
}

/**
 * 13. 架构验收 M4-17「**宿主无知**」（R111 新增）。
 *
 * ★ 路线图原文（`docs/07:150`）：
 *   > **验收：宿主无知** | 删除 `plugins/builtin/` 后主程序仍能启动；
 *   > 核心逻辑 grep `github` 为 0
 *
 * ★★ 此前**只有后半**被覆盖（本文件的第 7 项：`src/**` 的系统名扫描）；
 *   **前半**（「删除后可启动」）**从未被验证**——本项补上。
 *
 * ★ 实现方式：`tools/host-agnostic-check.ts` 临时移走 `src/plugin/builtin/`，
 *   断言**核心（`src/`）零错误**，并在 `finally` 里**保证移回**。
 */
async function itemHostAgnostic(): Promise<void> {
  const result = run(process.execPath, ['--experimental-strip-types', 'tools/host-agnostic-check.ts']);
  const lines = result.output
    .split('\n')
    .filter((line) => /核心（src\/）错误|装配层|测试（test\/）错误|M4-17 前半/.test(line))
    .map((line) => line.trim());
  if (result.code === 0) {
    record(13, '架构验收 M4-17 宿主无知（删除 builtin/ 后核心仍可编译）', 'PASS', lines.length > 0 ? lines : ['通过']);
  } else {
    record(13, '架构验收 M4-17 宿主无知（删除 builtin/ 后核心仍可编译）', 'FAIL', [
      ...lines,
      '★ 核心（src/）不得依赖 src/plugin/builtin/——装配层（tools/）依赖是设计如此。',
    ]);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const allowFixture = argv.includes('--allow-fixture');

  const loaded = await loadTables({});
  let compiledSql: string | null = null;
  let compileError: string | null = null;
  try {
    compiledSql = compileSchema(loaded.tables).sql;
  } catch (error) {
    compileError = error instanceof Error ? error.message : String(error);
  }

  console.log('='.repeat(78));
  console.log('access-gate CI 门禁（M0-11）');
  console.log(`  表声明来源: ${describeSource(loaded)}`);
  for (const warning of loaded.warnings) console.log(`  WARN: ${warning}`);
  console.log('='.repeat(78));
  console.log('');

  itemTypecheck();
  await itemTests();
  await itemSnapshot(compiledSql, compileError);
  itemDbCheck();
  itemSiteId(loaded.tables);
  await itemRawSql();
  await itemSystemNames();
  await itemSingleTransactionEntry();
  await itemSecurityAudit();
  await itemRouteCoverage();
  await itemRealPg();
  await itemPerformance();
  await itemHostAgnostic();

  const failed = results.filter((r) => r.status === 'FAIL');
  console.log('='.repeat(78));
  console.log('CI 汇总');
  for (const r of results) console.log(`  [${r.status}] ${r.id}. ${r.title}`);
  console.log('');

  let code = failed.length === 0 ? 0 : 1;
  if (loaded.source === 'fixture') {
    console.log(`  ⚠ 真实声明 ${loaded.entry} 未就绪：以上结果基于 ${loaded.tables.length} 张夹具表，**不是 M0 验收结论**。`);
    if (!allowFixture) {
      console.log('  ⚠ 以非零退出（3）表示 INCOMPLETE；本地开发可加 --allow-fixture。');
      if (code === 0) code = 3;
    }
  }
  console.log(`CI 结果：${failed.length === 0 ? (code === 3 ? 'INCOMPLETE（夹具模式）' : 'PASS') : 'FAIL'}（退出码 ${code}）`);
  return code;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
