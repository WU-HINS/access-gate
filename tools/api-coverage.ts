// 
// 接口面覆盖率：**文档声明的端点 vs 实际实现的路由**
//
// ★ 为什么需要它：R2 轮发现 docs/06 清清楚楚声明了 /oauth/* 的端点表，
//   而当时**一个都没实现**——`audit-gap.ts` 却把 M5-6 标为 done（因为它找到了
//   `src/auth/federation.ts`）。**任务清单的粒度比接口面粗**，于是
//   「任务 done」与「接口可用」之间有一道缝。
//
// ★ 本工具量化那道缝：从 `docs/06-接口与界面.md` 提取声明的端点，
//   从源码提取实际注册的路由，报告**覆盖率与缺失清单**。
//
// ★★ 关于「缺失」的诚实解读（重要）：
//   文档里的 126 个端点**不全是「必须实现」的**——
//   其中有些是完整设计稿（描述目标形态），有些已在别处等价实现。
//   因此本工具**不把缺失直接判为失败**，而是给出：
//     ① 覆盖率（当前约 22%）；
//     ② 缺失清单（按前缀分组，便于判断哪些是真正该补的）；
//     ③ 明确声明「缺失 ≠ 缺陷」，需要人工判断。
//
//   ★ 把「未实现」如实列出来，比让它藏在「任务完成」的印象后面更有价值。
//
// 用法：
//   node --experimental-strip-types tools/api-coverage.ts
//   node --experimental-strip-types tools/api-coverage.ts --json   # 机器可读

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Endpoint {
  method: string;
  path: string;
}

// 从文档的表格里提取端点：形如 | `GET` | `/oauth/authorize` | ... 的行
function extractDocumented(markdown: string): Endpoint[] {
  const found: Endpoint[] = [];
  for (const match of markdown.matchAll(/^\|\s*`(GET|POST|PUT|DELETE|PATCH)`\s*\|\s*`(\/[^`]*)`/gm)) {
    found.push({ method: match[1]!, path: match[2]! });
  }
  return found;
}

// 把路径归一化：去掉查询串，`:param` / `([^/]+)` 统一成 `:p`。
function normalizePath(raw: string): string {
  return raw
    .split('?')[0]!
    .replace(/\(\[\^\/\]\+\)/g, ':p')
    .replace(/\(\[\^\/\]\*\)/g, ':p')
    // ★ 刻意写成 `{0,}` 而不是 `*`：量词 `*` 紧跟斜杠会形成注释结束符，
    //   从而**提前结束文件开头的块注释**（经典陷阱，本轮真实踩到两次——
    //   第二次是在「解释这个陷阱」的注释里又写出了那个符号组合）。
    .replace(/:[A-Za-z_][A-Za-z0-9_]{0,}/g, ':p')
    .replace(/\/+$/, '') || '/';
}

// 从 src 下所有文件里提取注册的路由（`path: '...'` 与 `mount('METHOD', '...')`）。
async function extractImplemented(): Promise<{ endpoints: Endpoint[]; files: string[] }> {
  const endpoints: Endpoint[] = [];
  const files: string[] = [];
  const dirs = [path.join(ROOT, 'src', 'http'), path.join(ROOT, 'src', 'admin')];
  for (const dir of dirs) {
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith('.ts')) continue;
      const file = path.join(dir, entry);
      const source = await readFile(file, 'utf8');
      files.push(path.relative(ROOT, file));
      // ① Route 定义：`{ method: 'GET', path: '/x', ... }`（顺序可能相反）
      for (const match of source.matchAll(/method:\s*'([A-Z]+)'[\s\S]{0,80}?path:\s*'([^']+)'/g)) {
        endpoints.push({ method: match[1]!, path: normalizePath(match[2]!) });
      }
      for (const match of source.matchAll(/path:\s*'([^']+)'[\s\S]{0,80}?method:\s*'([A-Z]+)'/g)) {
        endpoints.push({ method: match[2]!, path: normalizePath(match[1]!) });
      }
      // ② admin 的 mount('GET', '/x')
      for (const match of source.matchAll(/mount\('([A-Z]+)',\s*'([^']+)'\)/g)) {
        endpoints.push({ method: match[1]!, path: normalizePath(match[2]!) });
      }
      // ③ admin handler 内的字符串比较：`path === '/api/admin/x'`（方法在同一行）
      for (const match of source.matchAll(/method === '([A-Z]+)' && path === '([^']+)'/g)) {
        endpoints.push({ method: match[1]!, path: normalizePath(match[2]!) });
      }
    }
  }
  return { endpoints, files: [...new Set(files)].sort() };
}

// 
// 文档路径 → 实际路径的映射。
//
// ★ 文档写的是**设计期路径**（如 `/oauth/authorize`），
//   而路由表里是**挂载后的实际路径**（如 `/oauth/authorize` 相同，
//   但 admin 的是 `/api/admin/...`）。这里只做「去掉 `/api` 前缀」这一种归一，
//   其余差异如实报为「未匹配」——**宁可多报也不能漏报**。
function variants(documented: string): string[] {
  const out = new Set<string>([documented]);
  if (documented.startsWith('/api/')) out.add(documented.slice('/api'.length));
  else out.add(`/api${documented}`);
  return [...out];
}

/**
 * 缺口分类（**人工判断的规则，写在这里以便复核**）。
 *
 * ★ 为什么需要分类：106 条未匹配**不能一视同仁**——
 *   有些是生产系统缺了就转不动的（如插件安装/授权），
 *   有些是自助功能，有些可能只是设计稿的目标形态。
 *   「全都要补」等于没有优先级。
 */
function classify(endpoint: Endpoint): { priority: 'P0' | 'P1' | 'P2'; reason: string } {
  const p = endpoint.path;
  // P0：核心运营能力——缺了它，平台的卖点（插件平台）无法被运营
  if (/^\/admin\/plugins(\/|$)/.test(p)) return { priority: 'P0', reason: '插件平台的运营入口（安装/授权/信任/端点/日志）' };
  if (/^\/admin\/oidc(\/|$)/.test(p)) return { priority: 'P0', reason: 'OIDC 注册管理（联邦登录的前置）' };
  if (/^\/admin\/verify(\/|$)/.test(p)) return { priority: 'P0', reason: '协同验证调用方管理（M5 的运营面）' };
  if (/^\/admin\/settings(\/|$)/.test(p)) return { priority: 'P0', reason: '平台设置（含平台模式切换，M7-10）' };
  // P1：用户自助与日常运维
  if (/^\/me\//.test(p)) return { priority: 'P1', reason: '用户自助（身份绑定/签到/资格/对齐）' };
  if (/^\/admin\/users(\/|$)/.test(p)) return { priority: 'P1', reason: '用户管理（排障与客服必需）' };
  if (/^\/admin\/audit(\/|$)/.test(p)) return { priority: 'P1', reason: '审计查询（排障与追责）' };
  if (/^\/admin\/(jobs|actions|sync|providers)(\/|$)/.test(p)) return { priority: 'P1', reason: '运维可观测（任务/动作/同步/渠道）' };
  if (/^\/auth\/(register|email|password)/.test(p)) return { priority: 'P1', reason: '账号自助（注册/邮箱验证/改密）' };
  // P2：其余（可能是设计稿的目标形态，需人工确认）
  return { priority: 'P2', reason: '需人工确认是否属于本期范围（可能是设计稿的目标形态）' };
}

/** 生成缺口清单文档（可交付物）。 */
async function writeReport(groups: [string, Endpoint[]][], documented: number, implemented: number): Promise<void> {
  const all = groups.flatMap(([, list]) => list);
  const byPriority = { P0: [] as Endpoint[], P1: [] as Endpoint[], P2: [] as Endpoint[] };
  for (const endpoint of all) byPriority[classify(endpoint).priority].push(endpoint);

  const section = (title: string, list: Endpoint[], note: string): string =>
    `\n### ${title}（${list.length} 条）\n\n${note}\n\n` +
    '| 方法 | 路径 | 归类依据 |\n|---|---|---|\n' +
    list
      .map((endpoint) => `| ${endpoint.method} | \`${endpoint.path}\` | ${classify(endpoint).reason} |`)
      .join('\n') +
    '\n';

  const coverage = ((documented - all.length) / documented) * 100;
  const content =
    `# 接口面缺口清单（自动生成）\n\n` +
    `> 由 \`node --experimental-strip-types tools/api-coverage.ts --write-report\` 生成。\n` +
    `> **不要手工编辑**——本文件是工具输出；分类规则在 \`tools/api-coverage.ts\` 的 \`classify()\` 里。\n\n` +
    `## 总体\n\n` +
    `| 项 | 值 |\n|---|---|\n` +
    `| 文档声明端点（docs/06） | ${documented} |\n` +
    `| 源码注册路由 | ${implemented} |\n` +
    `| 未匹配 | ${all.length} |\n` +
    `| 覆盖率 | ${coverage.toFixed(1)}% |\n\n` +
    `★ **「未匹配」不等于「缺陷」**：docs/06 含完整设计稿的成分，需要人工判断。\n` +
    `本清单的价值在于**把差距量化并分优先级**，而不是制造一个「必须消掉的数字」。\n` +
    section('P0 · 生产阻塞', byPriority.P0, '缺了它，平台的**核心卖点无法被运营**（插件装不了、OIDC 配不了、协同调用方管不了）。') +
    section('P1 · 重要但非阻塞', byPriority.P1, '用户自助与日常运维。缺了会让运营**必须直接连数据库**。') +
    section('P2 · 需人工确认', byPriority.P2, '可能是设计稿的目标形态，也可能确属本期范围。**需要产品判断**，不应盲目补齐。') +
    `\n## 建议的补齐顺序\n\n` +
    `1. **P0 的 \`/admin/plugins\`**（${byPriority.P0.filter((e) => e.path.startsWith('/admin/plugins')).length} 条）——\n` +
    `   它是「插件平台」从「有实现」到「能被运营」的分界线；\n` +
    `2. **P0 的 \`/admin/oidc\` + \`/admin/settings\`**——联邦登录与平台模式的前置；\n` +
    `3. **P1 的 \`/me/*\`**——用户自助，直接影响终端用户体验；\n` +
    `4. P2 需与产品确认后再决定。\n\n` +
    `★ 每补一批，都应更新本文件（重跑工具）并在 \`reports/M0-acceptance.md\` 记录真实运行证据。\n`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(ROOT, 'reports', 'api-gap.md'), content, 'utf8');
  process.stdout.write(`\n已写入 reports/api-gap.md（P0 ${byPriority.P0.length} · P1 ${byPriority.P1.length} · P2 ${byPriority.P2.length}）\n`);
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const writeReportFlag = process.argv.includes('--write-report');
  const markdown = await readFile(path.join(ROOT, 'docs', '06-接口与界面.md'), 'utf8');
  const documented = extractDocumented(markdown);
  const { endpoints: implemented, files } = await extractImplemented();

  const implementedSet = new Set(implemented.map((entry) => `${entry.method} ${entry.path}`));
  const implementedPaths = new Set(implemented.map((entry) => entry.path));

  const missing: Endpoint[] = [];
  for (const endpoint of documented) {
    const hit = variants(endpoint.path).some((variant) => {
      const normalized = normalizePath(variant);
      return implementedSet.has(`${endpoint.method} ${normalized}`) || implementedPaths.has(normalized);
    });
    if (!hit) missing.push(endpoint);
  }

  const coverage = documented.length === 0 ? 0 : ((documented.length - missing.length) / documented.length) * 100;

  // 按前缀分组（便于判断「哪些是被整块漏掉的」）
  const groups = new Map<string, Endpoint[]>();
  for (const endpoint of missing) {
    const segments = endpoint.path.split('/').filter((segment) => segment.length > 0);
    const key = `/${segments.slice(0, segments.length >= 2 ? 2 : 1).join('/')}`;
    const list = groups.get(key) ?? [];
    list.push(endpoint);
    groups.set(key, list);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          documentedCount: documented.length,
          implementedCount: implemented.length,
          missingCount: missing.length,
          coveragePercent: Math.round(coverage * 10) / 10,
          groups: sortedGroups.map(([prefix, list]) => ({ prefix, count: list.length, endpoints: list.map((entry) => `${entry.method} ${entry.path}`) })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write('\n【接口面覆盖率：文档声明 vs 实际实现】\n\n');
  process.stdout.write(`文档声明端点（docs/06-接口与界面.md）：${documented.length} 条\n`);
  process.stdout.write(`源码注册路由（${files.length} 个文件）：${implemented.length} 条\n`);
  process.stdout.write(`覆盖率：${coverage.toFixed(1)}%（未匹配 ${missing.length} 条）\n\n`);

  process.stdout.write('未匹配的端点按前缀分组（前 20 组）：\n');
  for (const [prefix, list] of sortedGroups.slice(0, 20)) {
    process.stdout.write(`  ${prefix.padEnd(34)} ${String(list.length).padStart(3)} 条   例：${list[0]!.method} ${list[0]!.path}\n`);
  }

  process.stdout.write(
    `\n${'='.repeat(76)}\n` +
      `★ 诚实解读（重要）：\n` +
      `  · 本工具的「未匹配」**不等于缺陷**——docs/06 的 126 条里有完整设计稿的成分，\n` +
      `    需要人工判断哪些是「必须实现的管理接口」，哪些是「目标形态描述」。\n` +
      `  · 但它量化了一件事：**任务清单（M0–M7）的粒度比接口面粗**。\n` +
      `    一个「done」的任务可能对应十几条未实现的接口（如 M4-2「权限模型完整」）。\n` +
      `  · 因此「路线图 90/90」与「接口面可用」是**两个不同的结论**——\n` +
      `    这正是 R2 轮 /oauth/* 全部未实现却标记 done 的原因。\n`,
  );
  if (writeReportFlag) await writeReport(sortedGroups, documented.length, implemented.length);

  // ★ 刻意**不以非零退出**：本工具的结论需要人工判断，不适合作为 CI 门禁。
  //   （作为门禁会逼着人去「消数字」，而不是去判断哪些接口真的该补。）
}

await main();
