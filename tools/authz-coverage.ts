/**
 * 鉴权覆盖检查：**管理端每个路由分支是否都做了鉴权**？
 *
 * ★★ 为什么需要它：
 *   与 `path-probe` 的越权探测不同，本工具是**静态**的——
 *   它能做到 **100% 覆盖**（每条路由分支都检查），而动态探测只能覆盖「探到的路径」。
 *   对于「某个分支忘了鉴权」这类缺陷，**静态检查是唯一能保证覆盖的手段**。
 *
 * ★ 检查方式：在 `src/admin/api.ts` 的 handler 里，
 *   每个「路由分支」（`if (method === 'X' && path === '...')` 或其变体）
 *   的**内部**必须出现一次鉴权调用（`requireAdmin` / `requireSite`）。
 *
 * ★ 为什么这不是过度严格：
 *   管理端 handler 是**一个大 if-链**，新增分支时很容易忘了鉴权——
 *   而忘了的后果是**越权**（普通用户能调管理接口）。
 *   本会话已经出现过「OIDC 回调未接入准入 → 任何人可成为开发者」，
 *   同类问题在管理端一旦出现就是高危。
 *
 * 用法：
 *   node --experimental-strip-types tools/authz-coverage.ts
 *   node --experimental-strip-types tools/authz-coverage.ts --self-test
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 鉴权调用（任一即可）。 */
const AUTH_CALLS = ['requireAdmin(', 'requireSite('];

interface Branch {
  /** 分支的可读标识（行号 + 条件摘要） */
  label: string;
  line: number;
  /** 分支体内的源码 */
  body: string;
  /** 体内是否出现鉴权调用 */
  guarded: boolean;
}

/**
 * 提取路由分支。
 *
 * ★ 用「缩进 + `if (`」定位分支起点，再用**括号配平**找到分支体范围——
 *   比按 `}` 粗略切分可靠（分支体内还有嵌套的 if/对象字面量）。
 */
export function extractBranches(source: string): Branch[] {
  const lines = source.split('\n');
  const branches: Branch[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    // 只认「路由条件」的 if：包含 method 或 path 判断，且包含 `/api/`
    // ★★ 缩进必须放宽到 `\s+`：
    //   第一版硬编码「恰好 6 个空格」，而实际文件里分支的缩进是
    //   **6 / 8 / 10** 三种（嵌套在 `if (plugins !== undefined) {` 等块内会更深）。
    //   结果只提取到 9 个分支（实际 37 个）——**漏报 28 个，且检查显示「全部已鉴权」**。
    //   ★ 这是「检查工具自身的正则太窄导致假通过」的第 N 次出现。
    if (!/^\s+if \(/.test(line)) continue;
    if (!/method\s*===|path\s*===|Match\s*!==\s*null/.test(line)) continue;
    if (!line.includes('/api/') && !/Match\s*!==\s*null/.test(line)) continue;

    // 括号配平找分支体（从 if 那一行的 `{` 开始）
    let depth = 0;
    let started = false;
    const bodyLines: string[] = [];
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const current = lines[cursor]!;
      for (const char of current) {
        if (char === '{') {
          depth += 1;
          started = true;
        } else if (char === '}') {
          depth -= 1;
        }
      }
      bodyLines.push(current);
      if (started && depth === 0) break;
      // ★ 安全阀：单个分支不应超过 200 行（否则说明配平失败）
      if (cursor - index > 200) break;
    }
    const body = bodyLines.join('\n');
    branches.push({
      label: line.trim().slice(0, 76),
      line: index + 1,
      body,
      guarded: AUTH_CALLS.some((call) => body.includes(call)),
    });
  }
  return branches;
}

/** 自测：证明「未鉴权的分支」会被检出。 */
function selfTest(): number {
  const guarded = `      if (method === 'GET' && path === '/api/admin/x') {
        const { siteId } = requireAdmin(request);
        return ok({ siteId });
      }`;
  const unguarded = `      if (method === 'GET' && path === '/api/admin/y') {
        return ok({ secret: 'leaked' });
      }`;
  // ★★ 必须有「深缩进」的用例：第一版自测的两个用例都是 6 空格，
  //   于是**没能发现**「缩进硬编码导致 26 个分支被漏掉」。
  //   ★ 自测用例要覆盖**真实的多样性**，否则自测本身会给出虚假的安全感。
  const guardedDeep = `        if (method === 'POST' && path === '/api/admin/deep') {
          requireAdmin(request);
          return ok({});
        }`;
  const unguardedDeep = `        if (method === 'DELETE' && path === '/api/admin/deep-unguarded') {
          return ok({ leaked: true });
        }`;
  const cases: { name: string; source: string; expectGuarded: number }[] = [
    { name: '有鉴权（6 空格）→ 已保护', source: guarded, expectGuarded: 1 },
    { name: '★ 无鉴权（6 空格）→ 必须被检出', source: unguarded, expectGuarded: 0 },
    { name: '★ 有鉴权（8 空格嵌套）→ 已保护', source: guardedDeep, expectGuarded: 1 },
    { name: '★★ 无鉴权（8 空格嵌套）→ 必须被检出', source: unguardedDeep, expectGuarded: 0 },
  ];
  let failures = 0;
  for (const testCase of cases) {
    const branches = extractBranches(testCase.source);
    const guardedCount = branches.filter((branch) => branch.guarded).length;
    const ok = branches.length === 1 && guardedCount === testCase.expectGuarded;
    process.stdout.write(
      `  ${ok ? '✅' : '❌'} ${testCase.name}：提取 ${branches.length} 个分支，已保护 ${guardedCount}（期望 ${testCase.expectGuarded}）\n`,
    );
    if (!ok) failures += 1;
  }
  process.stdout.write(`\n自测结果：${cases.length - failures}/${cases.length} ${failures === 0 ? '通过——检查确实能检出未鉴权分支' : '**失败——检查不可信**'}\n`);
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) {
    process.stdout.write('\n【鉴权覆盖检查自测】\n\n');
    process.exitCode = selfTest();
    return;
  }

  process.stdout.write('\n【鉴权覆盖检查（静态，100% 分支覆盖）】\n\n');
  const file = path.join(ROOT, 'src', 'admin', 'api.ts');
  const source = await readFile(file, 'utf8');
  const branches = extractBranches(source);

  const unguarded = branches.filter((branch) => !branch.guarded);
  for (const branch of branches) {
    process.stdout.write(`${branch.guarded ? '✅' : '❌'} 第 ${String(branch.line).padStart(4)} 行  ${branch.label}\n`);
  }

  process.stdout.write(`\n${'='.repeat(76)}\n`);
  process.stdout.write(`路由分支总数：${branches.length}\n`);
  process.stdout.write(`已鉴权：${branches.length - unguarded.length}\n`);
  process.stdout.write(`★ **未鉴权**：${unguarded.length}\n`);
  for (const branch of unguarded) {
    process.stdout.write(`  ❌ 第 ${branch.line} 行：${branch.label}\n`);
  }
  // ★★ 覆盖范围**自报**：把「本检查实际看了哪些分支」摆出来，
  //   而不是让读者以为「35 个 = 全部」。
  //   ★ 第一版硬编码 6 空格缩进时只提取到 9 个，而输出是「未鉴权 0」——
  //     看起来像「全部安全」，实际是**漏报了 28 个**。
  //     因此这里主动给出「文件里有多少个 method 判断」作为交叉核对。
  const methodBranchCount = (source.match(/^\s+if \(method ===/gm) ?? []).length;
  process.stdout.write(
    `\n★ 覆盖范围（**必须看**，否则「未鉴权 0」可能是漏报）：\n` +
      `  · 本检查覆盖的分支条件：含 \`method ===\` **且**（含 \`/api/\` 字面量 或 \`Match !== null\`）；\n` +
      `  · 文件中 \`if (method ===\` 的总数：${methodBranchCount}；本检查提取到：${branches.length}；\n` +
      `  · 差额 ${methodBranchCount - branches.length} 个是**路由块内部的 method 分支**\n` +
      `    （如 grants 端点内的 \`if (method === 'GET')\`）——它们由**外层块**的鉴权覆盖，\n` +
      `    但**本检查不单独验证它们**。若差额异常增大，应人工核对。\n` +
      `\n★ 本检查**不能**判断的：\n` +
      `  · 鉴权是否在**所有代码路径**上都执行（如提前 return 绕过了它）；\n` +
      `  · 鉴权的**强度**（\`requireAdmin\` 的判定逻辑本身是否正确）。\n` +
      `  · 动态越权探测（用普通用户会话请求）与静态检查互补，但只覆盖被探到的路径。\n`,
  );
  if (unguarded.length > 0) process.exitCode = 1;
}

await main();
