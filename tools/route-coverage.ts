/**
 * 路由一致性检查：**实现了的路由是否都被挂载**？
 *
 * ★ 为什么需要它：本会话**四次**发现「实现存在但未接线」——
 *   1. `flows.ts` 的两条链路隔离未接到 OIDC 回调；
 *   2. `/oauth/*` 端点完全没实现；
 *   3. `/api/verify/v1/*` 与 OAuth 路由未挂载；
 *   4. **`simulate` / `policies/:code/versions` / `policies/:code/rollback` 未挂载**
 *      （其中 `rollback` 是目标点名的 M6-2 核心能力）。
 *
 *   第 4 次的根因很机械：`src/http/routes.ts` 用**手工清单**挂载 admin 路由，
 *   而 `src/admin/api.ts` 里的路由是**另一份清单**——两份清单会漂移。
 *
 * ★ 本工具把这类漂移变成**秒级可查的静态检查**（不需要启动 PG）：
 *   从 `admin/api.ts` 提取「实现的路由」，从 `routes.ts` 提取「挂载的清单」，
 *   逐一比对，报告**实现了但没挂载**的路由。
 *
 * ★ 它不能替代 `tools/path-probe.ts`：
 *   - 本工具是**静态**的（只看源码），秒级，可进常规 CI；
 *   - `path-probe` 是**动态**的（真实 PG 下真的请求每个端点），
 *     能发现静态分析看不到的问题（如事务边界、运行期错误）。
 *   两者互补：静态检查保证「接线不漏」，动态探针保证「跑起来不炸」。
 *
 * 用法：
 *   node --experimental-strip-types tools/route-coverage.ts
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface ImplementedRoute {
  method: string | '*';
  /** 归一化后的路径模式（正则里的 `([^/]+)` 转成 `:param`） */
  path: string;
  /** 原始形式（用于报告） */
  raw: string;
  source: string;
}

/**
 * 从 `admin/api.ts` 提取实现的路由。
 *
 * 两种写法都要覆盖：
 *   - 字符串比较：`path === '/api/admin/policies'`
 *   - 正则匹配：`/^\/api\/admin\/policies\/([^/]+)\/versions$/.exec(path)`
 *
 * ★ 早期只扫字符串形式 → **漏掉全部带参数的路由**（那正是漏挂载的三条）。
 */
function extractImplementedRoutes(source: string): ImplementedRoute[] {
  const routes: ImplementedRoute[] = [];
  const lines = source.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    // ① 字符串路径：`path === '/api/admin/xxx'`
    for (const match of line.matchAll(/path === '(\/api\/[^']+)'/g)) {
      routes.push({ method: '*', path: match[1]!, raw: match[1]!, source: `第 ${index + 1} 行` });
    }
    // ② 正则路径：`/^\/api\/admin\/...$/.exec(path)`
    //   ★ 早期这里写成了 `/\/\^…/`（要求 `/` 后跟转义的 `\^`），而源码里是 `/^…`——
    //     于是**一条正则路由都没提取到**，检查因此**完全抓不到那三条**（publish/versions/rollback）。
    //     这本身是「检查工具有 bug」的第 5 次出现：它输出「✅ 全部已挂载」，
    //     而实际能力是「漏掉了一整类路由」——**假成功比假失败更危险**。
    const regexMatch = /\/\^([^$]*?)\$\/\.exec\(path\)/.exec(line);
    if (regexMatch !== null) {
      const raw = regexMatch[1]!;
      // 把正则里的 `([^/]+)` 归一化成 `:param`
      let normalized = raw.replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, ':param').replace(/\(\[\^\/\]\*\)/g, ':param');
      // ★ 可选组：`grants(?:/(.+))?` 表示**两种**路径（带后缀与不带）。
      //   只取一种会**误报**「实现了但未挂载」（本会话第 7 次「检查工具自身有 bug」）。
      //   这里展开成「带可选部分」与「不带」两条，分别参与比对。
      const optional = /^(.*?)\(\?:\/([^)]*)\)\?$/.exec(normalized);
      // ★ 展开交替组：`(enable|disable)` 是**两条**路径，不是一个叫 `(enable|disable)` 的段。
      //   不展开会**误报**「实现了但未挂载」（本会话第 6 次「检查工具自身有 bug」）。
      if (optional !== null) {
        const suffix = optional[2]!.replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, ':param').replace(/\.\+/g, ':param');
        for (const path of [normalized, `${optional[1]!}${suffix}`]) {
          routes.push({ method: '*', path, raw, source: `第 ${index + 1} 行（正则·可选组）` });
        }
        continue;
      }
      const alternatives = /^\(([^)]+\|[^)]+)\)$/.exec(normalized.split('/').pop() ?? '');
      if (alternatives !== null) {
        for (const option of alternatives[1]!.split('|')) {
          routes.push({
            method: '*',
            path: [...normalized.split('/').slice(0, -1), option].join('/'),
            raw,
            source: `第 ${index + 1} 行（正则·交替组）`,
          });
        }
      } else {
        routes.push({ method: '*', path: normalized, raw, source: `第 ${index + 1} 行（正则）` });
      }
    }
  }
  return routes;
}

/** 从 `routes.ts` 提取挂载清单：`mount('METHOD', 'path')`。 */
function extractMountedRoutes(source: string): { method: string; path: string }[] {
  const mounted: { method: string; path: string }[] = [];
  for (const match of source.matchAll(/mount\('([A-Z]+)',\s*'([^']+)'\)/g)) {
    mounted.push({ method: match[1]!, path: match[2]! });
  }
  return mounted;
}

/** 路径模式匹配（支持 `:param` 通配一段）。 */
function pathMatches(pattern: string, actual: string): boolean {
  const patternParts = pattern.split('/');
  const actualParts = actual.split('/');
  if (patternParts.length !== actualParts.length) return false;
  return patternParts.every((part, index) => part.startsWith(':') || part === actualParts[index]);
}

async function main(): Promise<void> {
  process.stdout.write('\n【路由一致性检查（静态）】\n\n');

  const adminSource = await readFile(path.join(ROOT, 'src', 'admin', 'api.ts'), 'utf8');
  const routesSource = await readFile(path.join(ROOT, 'src', 'http', 'routes.ts'), 'utf8');

  const implemented = extractImplementedRoutes(adminSource);
  const mounted = extractMountedRoutes(routesSource);

  process.stdout.write(`admin/api.ts 中实现的路由：${implemented.length} 条\n`);
  process.stdout.write(`routes.ts 中挂载的路由：${mounted.length} 条\n\n`);

  // 逐条检查：实现的路由是否有对应挂载
  const unmounted: ImplementedRoute[] = [];
  for (const route of implemented) {
    const found = mounted.some((entry) => pathMatches(route.path, entry.path) || pathMatches(entry.path, route.path));
    if (!found) unmounted.push(route);
    process.stdout.write(`${found ? '✅' : '❌'} ${route.path.padEnd(48)} ${route.source}\n`);
  }

  // ★ 反向检查：挂载了但实现里找不到（可能是拼写错误，或实现已被删除）
  const orphanMounted: { method: string; path: string }[] = [];
  for (const entry of mounted) {
    const found = implemented.some((route) => pathMatches(route.path, entry.path) || pathMatches(entry.path, route.path));
    if (!found) orphanMounted.push(entry);
  }

  process.stdout.write(`\n${'='.repeat(72)}\n`);
  process.stdout.write(`实现但**未挂载**：${unmounted.length} 条\n`);
  for (const route of unmounted) {
    process.stdout.write(`  ❌ ${route.path}（${route.source}）—— 用户请求会得到 404\n`);
  }
  if (orphanMounted.length > 0) {
    process.stdout.write(`\n挂载但实现里找不到：${orphanMounted.length} 条（可能是拼写错误或实现已删除）\n`);
    for (const entry of orphanMounted) process.stdout.write(`  ⚠️  ${entry.method} ${entry.path}\n`);
  }

  const ok = unmounted.length === 0;
  process.stdout.write(
    `\n结论：${ok ? '✅ 全部实现的路由都已挂载' : `❌ ${unmounted.length} 条实现了但未挂载（「实现存在但用户调不到」）`}\n`,
  );
  process.stdout.write(
    `\n★ 本检查是**静态**的（秒级）。运行期问题（事务边界、异常）由\n` +
      `  tools/path-probe.ts 在真实 PG 下动态覆盖。两者互补。\n`,
  );
  if (!ok) process.exitCode = 1;
}

await main();
