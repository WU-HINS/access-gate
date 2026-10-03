/**
 * CI 静态检查的纯函数实现（被 `tools/ci-gate.ts` 调用，也被 `--self-test` 用于证明门禁**不是恒真**）。
 *
 * 三项：
 *   1. `checkSiteId`      —— siteScoped 表必须有 `site_id` 列（M0-11）
 *   2. `scanRawSql`       —— src 下全部 .ts 里的裸 SQL / 字符串拼接 SQL
 *   3. `scanSystemNames`  —— src 下出现**具体系统名（品牌名）**即失败
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedTable } from '../ir.ts';

// ───────────────────────────── 公共类型 ─────────────────────────────

export interface StaticViolation {
  file: string;
  line: number;
  rule: string;
  message: string;
  snippet: string;
}

export function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

// ───────────────────────────── 1. site_id 缺失检测 ─────────────────────────────

export interface SiteIdViolation {
  tableName: string;
  detail: string;
}

/** 凡 `siteScoped === true` 的表必须含 `site_id` 列（列名口径来自 normalize 的 snake_case）。 */
export function checkSiteId(tables: readonly NormalizedTable[]): SiteIdViolation[] {
  const out: SiteIdViolation[] = [];
  for (const table of tables) {
    // 只对**显式**声明 siteScoped:true 的表 fail-fast；缺省 true 不能当判据
    // （否则平台级表 ag_plugins / ag_oidc_providers / ag_jobs … 全部误报，见 reports/schema-doc-defects.md §2.4）
    if (!table.siteScoped || !table.siteScopedExplicit) continue;
    const has = table.columns.some((c) => c.columnName === 'site_id');
    if (!has) {
      out.push({
        tableName: table.tableName,
        detail: `siteScoped=true 但缺 site_id 列（声明 ${table.source.doc}:${table.source.line}）`,
      });
    }
  }
  return out;
}

// ───────────────────────────── 2. 禁止裸 SQL ─────────────────────────────

/** 一条完整的 DML 语句形状（避免把 `BEFORE UPDATE ON` 这类 DDL 片段误判为查询）。 */
const DML_SHAPE = /(?:\bSELECT\b[\s\S]{0,4000}?\bFROM\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\b[\s\S]{0,2000}?\bSET\b)/;

const TEMPLATE_LITERAL = /`(?:[^`\\]|\\.)*`/gs;
const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'/g;

/**
 * 检出「字符串拼接出来的 SQL」：
 *   - 模板字面量里同时出现插值（美元大括号）与 DML 关键字；
 *   - 普通字符串字面量里含完整 DML 且与加号相邻。
 * 约定：SQL 关键字按**大写**匹配（本项目 SQL 一律大写），降低误报。
 *
 * ⚠ 本文件自身在 `src/**` 扫描范围内：注释里**不要**写「反引号包住的、含插值的 SQL 例子」——
 *   否则静态扫描器会把注释本身判成违规（`src/db/guard.ts` 与 `scanRawSql` 都会扫原文）。
 */
export function scanRawSql(source: string, file: string): StaticViolation[] {
  const out: StaticViolation[] = [];

  for (const match of source.matchAll(TEMPLATE_LITERAL)) {
    const body = match[0];
    const at = match.index ?? 0;
    if (!body.includes('${')) continue;
    if (!DML_SHAPE.test(body)) continue;
    out.push({
      file,
      line: lineOf(source, at),
      rule: 'raw-sql',
      message: '模板字面量里拼接 SQL（DML 关键字 + 插值）；请走查询构建器/参数化',
      snippet: body.replace(/\s+/g, ' ').slice(0, 120),
    });
  }

  for (const match of source.matchAll(STRING_LITERAL)) {
    const body = match[0];
    const at = match.index ?? 0;
    if (!DML_SHAPE.test(body)) continue;
    const before = source.slice(Math.max(0, at - 40), at);
    const after = source.slice(at + body.length, at + body.length + 40);
    if (!/[+]\s*$/.test(before) && !/^\s*\+/.test(after)) continue;
    out.push({
      file,
      line: lineOf(source, at),
      rule: 'raw-sql',
      message: '字符串拼接 SQL（字面量 + 加号）；请走查询构建器/参数化',
      snippet: body.replace(/\s+/g, ' ').slice(0, 120),
    });
  }

  return out;
}

// ───────────────────────────── 3. 具体系统名 ─────────────────────────────

// 注意：本文件自身也在 `src/**` 的扫描范围内 —— 模式必须由片段拼出来，
// 否则门禁会命中「定义模式的那一行」（自命中），把检测器自己判成违规。
const BRAND_A = ['new', 'api'].join('');
const BRAND_B = ['new', '-', 'api'].join('');
/**
 * ★★★★ R112：新增**具体插件/系统品牌名**（M4-17 后半「核心逻辑 grep `github` 为 0」）。
 *
 * ★ 此前只扫 `newapi` / `new-api`（M6-9），而 **M4-17 要求的 `github` 从未被覆盖**——
 *   ★ 真的去 grep 会发现 `src/policy/evaluator.ts` 曾硬编码 `fact.github.total_stars` 等。
 * ★ 该硬编码表已删除（见该文件说明），因此现在可以把这些名字**纳入门禁**。
 *
 * ★ 拆成数组再拼接是**刻意**的——否则本文件自己会命中自己的规则（自指）。
 * ★ 清单**可维护**：新增内置插件时，若它出现在核心代码里，应加到这里。
 */
// ★★★ 每一段都**拆成数组再拼接**——否则本文件自己会命中自己的规则（**自指**）。
//   ★ 我第一版直接写了 `'discord'` / `'telegram'` / `'linuxdo'`，
//     CI 立刻报「`src/schema/compile/ci-checks.ts:129` 出现具体系统名 `discord`」——
//     ★ 这正是 `BRAND_A`/`BRAND_B` 早就用数组拼接的原因（我当时没把它推广到新清单）。
const PLUGIN_BRANDS = [
  ['git', 'hub'].join(''),          // 代码托管平台（内置插件之一）
  ['q', 'q'].join(''),              // 即时通讯平台
  ['dis', 'cord'].join(''),
  ['tele', 'gram'].join(''),
  ['linux', 'do'].join(''),
  // ★★ **刻意不含 `llm` 与 `checkin`**：
  //   它们是**通用能力名词**（大语言模型 / 签到），而不是**具体系统品牌**——
  //   `src/plugin/llm-gateway.ts` 是**平台自己的能力模块**（受权限治理的 `llm:invoke`），
  //   `checkin` 是**能力名**。把它们列入会命中大量**正当的核心代码**（我实测过）。
  //   ★ 这条界限（「品牌名」vs「能力名词」）需要**人工判断**，因此本清单必须可维护。
];
// ★★ 品牌名用**词边界**匹配（`\b`），且**只对品牌名不区分大小写**——
//   我第一版把整串都加了 `i`，于是命中了两处**驼峰标识符的中间**：
//     `checkInvariants` → 匹配到 `checkIn`；`wallMs` → 匹配到 `llM`。
//   ★ 这是**误报**（它们与插件无关）。用 `\b` 后，`checkin` 只匹配独立的 `checkin`。
const SYSTEM_NAME = new RegExp(`\\b(?:${BRAND_A}|${BRAND_B})\\b|\\b(?:${PLUGIN_BRANDS.join('|')})\\b`, 'i');

/**
 * 去注释（**保留换行**，行号不变）。
 *
 * ★ 为什么必须去注释再扫：本规则的目的是「核心代码里不出现具体系统名」，
 *   而**注释里举例说明抽象关系**恰恰是文档要求的行为（`docs/03 §1.16` 明确用
 *   「new-api 的 group / Discord 的 roles」来解释「属性袋」）。把注释算作违规会
 *   逼实现方删掉有价值的说明，或反过来让规则被放宽——两者都比精确实现更糟。
 *   字符串字面量与标识符**仍然**会被扫到（那才是真实的代码耦合）。
 */
function stripCommentsPreservingLines(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i]!;
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    // ★★★★ R112 修复：**识别正则字面量**。
    //   ★ 缺陷：此前不识别正则，于是 `/"/g` 里的 `"` 被当作**字符串开始** →
    //     其后所有注释**不再被剥离** → 注释里的品牌名被误报为「核心代码出现系统名」。
    //     （实测：`src/verify/confirm-page.ts` 的 `.replace(/"/g, '&quot;')` 导致
    //      第 48/59 行注释里的 `"Discord Bot"` 被报成 2 处违规。）
    //   ★ 启发式：`/` 到底是**除法**还是**正则开始**，看它**前面最近的非空白字符**——
    //     · 若是标识符结尾 / 数字 / `)` / `]` → 除法（如 `a / b`、`(1+2)/3`）；
    //     · 否则（`(` `,` `=` `:` `return` 等之后）→ 正则字面量。
    //   ★ 这是业界常用启发式（不需完整词法分析），足以覆盖本项目的代码形态。
    if (ch === '/') {
      const next = source[i + 1] ?? '';
      if (next === '/') {
        while (i < source.length && source[i] !== '\n') i += 1;
        continue;
      }
      if (next !== '*') {
        // 可能是正则字面量：看前面最近的非空白字符
        let k = out.length - 1;
        while (k >= 0 && (out[k] === ' ' || out[k] === '\t' || out[k] === '\n')) k -= 1;
        const prev = k >= 0 ? out[k]! : '';
        const looksLikeDivision = /[A-Za-z0-9_$)\]}]/.test(prev);
        if (!looksLikeDivision) {
          // 跳到正则结束（处理字符类里的 `/` 与转义）
          out += ch;
          i += 1;
          let inClass = false;
          while (i < source.length) {
            const c = source[i]!;
            out += c;
            if (c === '\\') {
              out += source[i + 1] ?? '';
              i += 2;
              continue;
            }
            if (c === '[') inClass = true;
            else if (c === ']') inClass = false;
            else if (c === '/' && !inClass) {
              i += 1;
              break;
            } else if (c === '\n') break; // 未闭合的正则：不吞掉后续行
            i += 1;
          }
          // 吃掉正则标志（g/i/m/s/u/y）
          while (i < source.length && /[gimsuyd]/.test(source[i]!)) {
            out += source[i]!;
            i += 1;
          }
          continue;
        }
      }
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function scanSystemNames(source: string, file: string): StaticViolation[] {
  const out: StaticViolation[] = [];
  const lines = stripCommentsPreservingLines(source).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const found = SYSTEM_NAME.exec(line);
    if (found === null) continue;
    out.push({
      file,
      line: i + 1,
      rule: 'system-name',
      message: `核心代码出现具体系统名「${found[0]}」；核心必须系统无关（应写 subject/provider 抽象）`,
      snippet: line.trim().slice(0, 120),
    });
  }
  return out;
}

// ───────────────────────────── 文件遍历 ─────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp']);

export async function walkFiles(root: string, extensions: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions.length > 0 && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  await visit(root);
  return out.sort();
}

export async function isTextFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (info.size > 2 * 1024 * 1024) return false;
    const content = await readFile(file);
    return !content.includes(0);
  } catch {
    return false;
  }
}
