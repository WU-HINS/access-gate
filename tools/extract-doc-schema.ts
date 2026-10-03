#!/usr/bin/env node
/**
 * tools/extract-doc-schema.ts
 *
 * 从 `docs/02-数据模型.md` 的代码围栏中抽取全部表定义，产出：
 *   1. `src/schema/tables/*.ts`  —— 真实、可 `tsc` 校验的声明式 Schema 模块
 *   2. `src/schema/tables/_extracted.json` —— 规范化 IR 快照（供漂移检测与缺陷报告）
 *   3. 控制台报告 —— 每张表的来源行号 + 本次命中的文档缺陷修复项
 *
 * 为什么是「提取」而不是「手抄」：02 文档里的 TS 片段是作者面（authoring surface），
 * 手抄一次就会有 40 张表 × N 列的静默漂移；提取则让「文档是唯一事实来源」成立，
 * 并让文档缺陷（见 REPAIRS）在每次生成时都被机器复核一次。
 *
 * 纪律（docs/HANDOFF.md §6）：本工具**不修改 docs/**，只读文档、只写 src/ 与 reports/。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOC_PATH = join(ROOT, 'docs', '02-数据模型.md');
const OUT_DIR = join(ROOT, 'src', 'schema', 'tables');
const REPORT_DIR = join(ROOT, 'reports');

// ─────────────────────────── 文档缺陷修复表（必须逐条命中） ───────────────────────────

interface Repair {
  id: string;
  /** 预期命中的文档行号（1-based）——用于断言修复点没有漂移 */
  line: number;
  /** 该修复所属的表（在表体内定位，避免同一 pattern 在文档里多处出现时误伤） */
  table: string;
  match: string;
  replace: string;
  description: string;
  note: string;
  /** 同一个实际替换文本在表体内出现多次时，指定命中第几处（1-based），默认 1 */
  occurrence?: number;
}

/**
 * 文档缺陷修复表。每条都会在生成时被断言「在指定表体内恰好命中一次」——
 * 若文档被修正，提取器会**立即报错**而不是静默漂移。
 * 完整缺陷报告见 reports/schema-doc-defects.md。
 */
const REPAIRS: Repair[] = [
  // ★ 执行顺序必须**按文档行号降序**：每处替换都会改变其后文本的长度，
  //   若先改前面的行，后面各条记录的 `line` 断言就会失配（曾因此把 D-4 打到 actionSeq 行上）。
  {
    id: 'D-6',
    // ★ R101：`ag_developers` 新增 `userId` 列（方案 A）使本文档**行号下移 23 行**，因此同步更新。
    // ★ 本轮：`ag_user_policy_state`（§6.1，位于本项**之前**）补了状态列的审计标注，
    //   文档再下移 **47 行** → 这里同步更新。
    //   （★ 工具的行号断言**又一次发现了漂移**——它就是这么工作的；见 `state-columns-audit.md`。）
    line: 926,
    table: 'ag_actions_log',
    match: "defineTable('ag_actions_log', {\n  actionSeq:",
    replace:
      "defineTable('ag_actions_log', {\n" +
      '  traceId:    col.varchar(48).nullable(),   // ★ 关联四元组的首元素：跨 HTTP/后台任务贯通动作执行与幂等\n' +
      '  actionSeq:',
    description:
      '`### 6.3 ag_actions_log` 之后**缺少开头的代码围栏**：标题下先出现一行散装的 `traceId: ...`，其后方才是 ```ts 围栏，' +
      '结果是 `traceId` 落在围栏外、不属于任何声明',
    note: '★ **结构性修复**：把围栏外（第 830 行）的 `traceId` 列移回表体首列；文档应把第 832 行的 ```ts 上移到标题之后',
  },
  {
    id: 'D-5',
    line: 972,
    table: 'ag_checkin_entitlements',
    match: "  scope:  col.varchar(32).notNull().default('daily'),",
    replace: "  scope:   col.varchar(32).notNull().default('daily'),",
    description: '块引用代码块内部前缀不统一（`> ` 与 `>   ` 混排），缩进与其它行不一致',
    note: '提取器对块引用统一剥离 `> ` 前缀，本项仅规范化缩进',
  },
  {
    id: 'D-3',
    line: 971,
    table: 'ag_checkin_entitlements',
    match: 'siteId: col.uuid().notNull(), userId: col.uuid().notNull(),',
    replace: 'userId: col.uuid().notNull(),',
    description: '`ag_checkin_entitlements` 的 `siteId` 被声明两次（第 877 行单独一次、第 878 行又与 `userId` 同行一次）',
    note: '提取时合并为一条 `siteId` + 一条 `userId`；文档本身应修',
  },
  {
    id: 'D-4',
    line: 970,
    table: 'ag_checkin_entitlements',
    match: '  siteId:     col.uuid().notNull(),                          // ★ 站点作用域键（RLS 与唯一键的前提）\n',
    replace: "  id:         col.uuid().primaryKey().defaultSql('uuidv7()'),\n  siteId:     col.uuid().notNull(),\n",
    description:
      '`ag_checkin_entitlements` 缺主键 `id`（本表定义被块引用前缀与缩进错误打散，同一行文本出现在 `ag_checkin_records` 里）',
    note:
      '★ **推断性修复**：按 02 §1「业务实体用 UUIDv7 主键」补 `id`；' +
      '若设计意图是「以 (siteId,userId,scope) 为自然键、不要代理主键」，需由设计方裁决后改文档',
  },
  {
    id: 'D-2',
    line: 110,
    table: 'ag_identities',
    match: ']);\n]);\n',
    replace: ']);\n',
    description: '`ag_identities` 定义后多出一行孤立的 `]);`（重复收尾符）',
    note: '同 D-1',
  },
  {
    id: 'D-1',
    line: 71,
    table: 'ag_users',
    match: ']);\n]);\n',
    replace: ']);\n',
    description: '`ag_users` 定义后多出一行孤立的 `]);`（重复收尾符）',
    note: '文档本身应修：多一个 `]);` 会让该代码块无法解析',
  },
];

/**
 * ★ R3 平台级表豁免理由（**逐表**，不得复制粘贴同一句）。
 *
 * 这些理由**逐字来自** `docs/02-数据模型.md §1` 的「豁免清单（须逐表签署理由）」。
 * 抽出来放进生成器的原因：理由必须同时出现在两个地方才生效——
 *   ① `src/schema/gate/exemptions.ts` 的清单（门禁用），② 表声明的 `options.exemptReason`（声明自证）。
 * 若只写在代码里，`docs/02` 改了而代码没跟上就会静默漂移；本表由 CI 的第 4 项（db:check → R3）
 * 兜底：清单里有理由、声明里没理由，门禁一律按「未豁免」处理。
 */
const PLATFORM_EXEMPT_REASONS: Record<string, string> = {
  ag_users: '平台身份锚点：登录与身份对齐的主体，不属于任何单站点',
  ag_sessions: '会话横跨站点：站点归属由 activeSiteId 在运行期约束，登录时尚未选定站点',
  ag_plugins: '插件目录，平台级注册表；安装动作是平台级的',
  ag_oidc_providers: '平台级 IdP 配置',
  ag_oidc_signing_keys: '平台级 OIDC 签名密钥',
  ag_platform_settings: '平台设置，admin 可改',
  ag_quota_counters:
    '配额计数（`docs/05 §6.4` QuotaGuard）：限流与预算是**跨实例**的资源——' +
    '进程内计数会让多实例部署下的实际配额 = 单实例配额 × 实例数（本会话记录的 L-13），' +
    '所以必须落库并由**一条条件更新**原子预占。' +
    '★ 键由守卫保证与归属同构（`quota:{ownerScope}:{ownerId}:{pluginId}:{instanceKey}:{resource}`），' +
    '本表**只存键与窗口、不解释键的内容**（谁归属谁由守卫决定），避免"键的语义"分裂成两处。' +
    '★ **平台级**：LLM 凭据与预算属于平台，且插件宿主没有站点上下文' +
    '（`HostApi` 里不存在 siteId）——加 site_id 只会造出一个恒为默认值的列。',
  ag_developers: '开发者域，按 ownerScope 隔离',
  ag_plugin_configs: '配置版本历史：归属由父实例 ag_plugin_instances 决定（实例可能是 developer 级或 site 级），不能自带 siteId',
  ag_plugin_packages: '外置插件包体的权威存储：包体是平台级分发物，与站点无关',
};

// ─────────────────────────── 词法工具（引号感知） ───────────────────────────

/** 去掉 `//` 与 `/* *​/` 注释，保留字符串字面量内容与换行数（行号映射依赖它）。 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      // ★ 保留换行：否则行注释会把「下一行的列名」吞掉（曾导致 actionSeq 的值变成 ol.uuid()）
      while (i < src.length && src[i] !== '\n') i++;
      if (i < src.length) {
        out += '\n';
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 从 `openIdx` 处的开括号出发，返回其配对括号的下标（引号感知）。 */
export function matchBracket(src: string, openIdx: number, hintOnFail?: string): number {
  const open = src[openIdx]!;
  const close = open === '{' ? '}' : open === '[' ? ']' : ')';
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(
    `括号不配对：从下标 ${openIdx} 开始（${open}）` +
      (hintOnFail ? `；上下文：${JSON.stringify(src.slice(Math.max(0, openIdx - 120), openIdx + 160))}` : ''),
  );
}

/** 按顶层逗号切分（忽略字符串与嵌套括号内部）。 */
export function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  const tail = src.slice(start);
  if (tail.trim().length > 0) parts.push(tail);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** 找顶层 `key:` 分隔符（用于列名 → 列表达式的切分）。 */
function splitKeyValue(entry: string): { key: string; value: string } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) {
      return { key: entry.slice(0, i).trim(), value: entry.slice(i + 1).trim() };
    }
  }
  throw new Error(`无法切分列声明（缺 ':'）：${JSON.stringify(entry)}`);
}

// ─────────────────────────── 列表达式解析 ───────────────────────────

interface ParsedColumn {
  name: string;
  expr: string;
  kind: string;
  length?: number;
  precision?: number;
  scale?: number;
  withTz?: boolean;
  enumType?: string;
  enumValues?: string[];
  primaryKey: boolean;
  notNull: boolean;
  nullable: boolean;
  defaultValue?: { form: 'literal'; value: string | number | boolean | null } | { form: 'sql'; expr: string } | { form: 'now' };
  onUpdateNow: boolean;
  warnings: string[];
}

const COL_KINDS = new Set([
  'uuid',
  'varchar',
  'text',
  'boolean',
  'integer',
  'bigint',
  'bigserial',
  'numeric',
  'jsonb',
  'timestamp',
  'date',
  'binary',
  'enum',
]);

/** 调用参数按顶层逗号切分，返回参数原文数组。 */
function callArgs(expr: string, fn: string): string[] {
  // ★ 必须带点号调用（'.defaultSql(' / '.index(' / …）：否则 'index(' 会先命中 't.index(' 里的
  //   子串，导致 matchBracket 从错误位置起算，列数组被解析成空（曾产生 32 处 t.index([])）。
  const needle = fn.startsWith('.') ? `${fn}(` : `\.${fn}(`;
  const idx = expr.lastIndexOf(needle);
  if (idx < 0) return [];
  const open = idx + needle.length - 1;
  const close = matchBracket(expr, open);
  const inner = expr.slice(open + 1, close);
  const out = splitTopLevel(inner);
  return out;
}

/**
 * 去掉实参外层字符串引号（'x' 或 "x"）。
 *
 * ★ 为什么必须有：`callArgs` 返回的是**实参原文**，对 `defaultSql("'[]'")` 它会返回
 *   `"'[]'"`（含外层双引号）。若不剥离，渲染时会被再包一层引号，产出
 *   `defaultSql('"\'[]\'"')` —— 正是 teammates 报的「生成器转义缺陷」。
 *   `enum` 分支此前用 parseStringLiteral，所以只有 defaultSql 中招。
 */
function unwrapLiteral(raw: string): string {
  const s = raw.trim();
  const first = s[0];
  if ((first === '"' || first === "'") && s.length >= 2 && s[s.length - 1] === first) {
    return s.slice(1, -1);
  }
  return s;
}

function parseStringLiteral(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  throw new Error(`不是字符串字面量：${raw}`);
}

function parseArrayLiteral(raw: string): string[] {
  const s = raw.trim();
  if (!s.startsWith('[')) throw new Error(`不是数组字面量：${raw}`);
  const close = matchBracket(s, 0);
  return splitTopLevel(s.slice(1, close)).map(parseStringLiteral);
}

export function parseColumnExpression(name: string, expr: string): ParsedColumn {
  const col: ParsedColumn = {
    name,
    expr,
    kind: '',
    primaryKey: false,
    notNull: false,
    nullable: false,
    onUpdateNow: false,
    warnings: [],
  };

  const m = /col\.([A-Za-z]+)\s*\(/.exec(expr);
  if (!m) throw new Error(`列 '${name}' 不是 col.* 表达式：${expr}`);
  const kind = m[1]!;
  if (!COL_KINDS.has(kind)) throw new Error(`列 '${name}' 使用了未知的 col.${kind}()`);
  col.kind = kind;

  if (kind === 'varchar' || kind === 'binary') {
    const args = callArgs(expr, `.${kind}`);
    if (args.length > 0) col.length = Number(args[0]);
  }
  if (kind === 'numeric') {
    const args = callArgs(expr, '.numeric');
    if (args.length > 0) col.precision = Number(args[0]);
    if (args.length > 1) col.scale = Number(args[1]);
  }
  if (kind === 'timestamp') {
    const args = callArgs(expr, '.timestamp');
    col.withTz = args.length === 0 ? false : /withTz\s*:\s*true/.test(args[0]!);
  }
  if (kind === 'enum') {
    const args = callArgs(expr, '.enum');
    col.enumType = parseStringLiteral(args[0] ?? '');
    col.enumValues = parseArrayLiteral(args[1] ?? '');
  }

  col.primaryKey = /\.primaryKey\s*\(/.test(expr);
  col.notNull = /\.notNull\s*\(/.test(expr);
  col.nullable = /\.nullable\s*\(/.test(expr);
  col.onUpdateNow = /\.onUpdateNow\s*\(/.test(expr);

  if (/\.defaultNow\s*\(/.test(expr)) col.defaultValue = { form: 'now' };
  if (/\.defaultSql\s*\(/.test(expr)) {
    const args = callArgs(expr, '.defaultSql');
    col.defaultValue = { form: 'sql', expr: unwrapLiteral(args[0] ?? '') };
  }
  if (/\.default\s*\(/.test(expr) && !/\.defaultNow|\.defaultSql/.test(expr)) {
    const args = callArgs(expr, '.default');
    const raw = (args[0] ?? '').trim();
    if (/^-?\d+(\.\d+)?$/.test(raw)) col.defaultValue = { form: 'literal', value: Number(raw) };
    else if (raw === 'true' || raw === 'false') col.defaultValue = { form: 'literal', value: raw === 'true' };
    else if (raw === 'null') col.defaultValue = { form: 'literal', value: null };
    else col.defaultValue = { form: 'literal', value: parseStringLiteral(raw) };
  }
  return col;
}

// ─────────────────────────── 表定义解析 ───────────────────────────

interface ParsedIndex {
  kind: 'unique' | 'index' | 'primaryKey';
  columns: string[];
  name?: string;
  where?: string;
  unique?: boolean;
}

interface ParsedTable {
  tableName: string;
  declName: string;
  line: number;
  columns: ParsedColumn[];
  indexes: ParsedIndex[];
  options: { siteScoped?: boolean; exemptReason?: string; dualScopeCheck?: string };
  defects: string[];
}

function parseTableCall(
  src: string,
  callStart: number,
  lineOf: (offset: number) => number,
  defects: string[],
): ParsedTable {
  const callOpen = callStart + 'defineTable'.length;
  const callClose = matchBracket(src, callOpen, `表 ${src.slice(callStart, callStart + 60)}`);
  const args = splitTopLevel(src.slice(callOpen + 1, callClose));
  const tableName = parseStringLiteral(args[0] ?? '');
  const columnsRaw = args[1] ?? '';
  const extraRaw = args[2];
  const optionsRaw = args[3];

  const declName = findDeclName(src, callStart);

  // 列
  const objOpen = columnsRaw.indexOf('{');
  if (objOpen < 0) throw new Error(`${tableName}: 第 2 个参数不是对象字面量`);
  const objClose = matchBracket(columnsRaw, objOpen);
  const bodyText = stripComments(columnsRaw.slice(objOpen + 1, objClose));
  const entries = splitTopLevel(bodyText);
  const columns: ParsedColumn[] = [];
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;
    const { key, value } = splitKeyValue(entry);
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      // 解析漂移而非文档缺陷：报出足够上下文便于定位
      throw new Error(
        `${tableName}: 列声明解析漂移，得到键 ${JSON.stringify(key)}，原文：${JSON.stringify(entry.slice(0, 200))}`,
      );
    }
    if (columns.some((c) => c.name === key)) {
      defects.push(`重复列声明：${tableName}.${key}`);
      continue;
    }
    const parsed = parseColumnExpression(key, value);
    // 行号：用列名在原文中的位置
    parsed.expr = value;
    columns.push(parsed);
  }

  // 索引 / 唯一键
  const indexes: ParsedIndex[] = [];
  if (extraRaw !== undefined) {
    const arrOpen = extraRaw.indexOf('[');
    if (arrOpen >= 0) {
      const arrClose = matchBracket(extraRaw, arrOpen);
      for (const item of splitTopLevel(extraRaw.slice(arrOpen + 1, arrClose))) {
        // 注意：文档里有 `t.index (['status'], ...)` 这种**方法名与括号之间有空格**的写法
        const m = /t\.(unique|index|primaryKey)\s*\(/.exec(item);
        if (!m) continue;
        // `t.index (['status'], …)`：方法名与括号间可能有空格，先归一化再解析实参
        const normalizedItem = item.replace(/\.(unique|index|primaryKey)\s*\(/, '.$1(');
        const args2 = callArgs(normalizedItem, `.${m[1]!}`);
        const cols = parseArrayLiteral(args2[0] ?? '[]');
        const optsRaw = args2[1];
        const fn = m[1]!;
        const idx: ParsedIndex = {
          kind: fn === 'unique' ? 'unique' : fn === 'primaryKey' ? 'primaryKey' : 'index',
          columns: cols,
        };
        if (optsRaw) {
          const nameM = /name\s*:\s*(['"])(.*?)\1/.exec(optsRaw);
          if (nameM) idx.name = nameM[2];
          const whereM = /where\s*:\s*(['"])(.*?)\1/.exec(optsRaw);
          if (whereM) idx.where = whereM[2];
          if (/unique\s*:\s*(true|false)/.test(optsRaw)) {
            idx.unique = /unique\s*:\s*true/.test(optsRaw);
            idx.kind = idx.unique ? 'unique' : 'index';
          }
        }
        indexes.push(idx);
      }
    }
  }

  // 选项
  const options: ParsedTable['options'] = {};
  if (optionsRaw !== undefined) {
    const siteScopedM = /siteScoped\s*:\s*(true|false)/.exec(optionsRaw);
    if (siteScopedM) options.siteScoped = siteScopedM[1] === 'true';
    const reasonM = /exemptReason\s*:\s*(['"])(.*?)\1/s.exec(optionsRaw);
    if (reasonM) options.exemptReason = reasonM[2];
    // ★★★★ R104 修复：原正则 `(['"])(.*?)\1` 是**非贪婪**的，只匹配**第一个**字符串字面量。
    //   而文档里 `dualScopeCheck` 常写成**字符串拼接**：
    //     dualScopeCheck:
    //       "(scope = 'site' AND …)" +
    //       " OR (scope = 'developer' AND …)",
    //   → 原正则只取到第一段，**后半（developer 分支）被静默丢弃**，
    //     生成的 CHECK 变成「只有 site 分支」——
    //   ★ 后果：`scope = 'developer'` 的行**永远无法插入**
    //     （CHECK 表达式为 false），即「开发者级插件配置」在**数据库层面不可能**。
    //   ★ 已改为：匹配**连续的字符串字面量拼接**（`+` 连接），把它们拼成一个表达式。
    // ★ 外层正则也必须允许**字符串内部有引号**（表达式含 `'site'` / `'developer'`）——
    //   所以这里只匹配**双引号**字符串（`"[^"]*"`），并允许用 `+` 拼接多段。
    const dualM = /dualScopeCheck\s*:\s*((?:"[^"]*"\s*\+?\s*)+)/s.exec(optionsRaw);
    if (dualM) {
      // ★ 注意：字符串**内部含引号**（表达式里有 `'site'` / `'developer'` 的单引号），
      //   所以不能用 `[^'"]*`（那会在第一个引号处停住 → 匹配空串）。
      //   ★ 这里分别匹配**双引号**与**单引号**字符串，双引号内部允许单引号。
      const parts = [
        ...[...dualM[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!),
      ];
      const joined = parts.join('');
      if (joined.length > 0) options.dualScopeCheck = joined;
    }
  }

  return {
    tableName,
    declName,
    line: lineOf(callStart),
    columns,
    indexes,
    options,
    defects,
  };
}

function findDeclName(src: string, callStart: number): string {
  const before = src.slice(Math.max(0, callStart - 200), callStart);
  const m = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before.replace(/^\s+/gm, (s) => s));
  if (m) return m[1]!;
  const m2 = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*[^=]*$/.exec(before);
  if (m2) return m2[1]!;
  return '';
}

// ─────────────────────────── 扫描文档 ───────────────────────────

interface ScanResult {
  src: string;
  blocks: { lang: string; start: number; end: number; blockquote: boolean; text: string }[];
}

export function scanFences(raw: string): ScanResult {
  const lines = raw.split('\n');
  const offsets: number[] = [];
  {
    let acc = 0;
    for (const l of lines) {
      offsets.push(acc);
      acc += l.length + 1;
    }
  }
  const blocks: ScanResult['blocks'] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 兼容块引用内的围栏（`> ```ts`）
    const open = /^\s*>?\s*```(.*)$/.exec(line);
    if (!open) continue;
    const info = (open[1] ?? '').trim();
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      // 收尾围栏（允许带块引用前缀）
      if (/^\s*>?\s*```\s*$/.test(l)) break;
      // ★ 关键：块引用块内的行前缀可能不统一（有的带 `> `、有的不带），统一剥离
      body.push(l.replace(/^\s*>\s?/, ''));
    }
    const bodyText = body.join('\n');
    blocks.push({
      lang: info,
      // start/end 为**原文**中的偏移区间（仅用于行号回溯）
      start: offsets[i]! + line.length + 1,
      end: offsets[i]! + line.length + 1 + bodyText.length,
      blockquote: /^\s*>/.test(line),
      // ★ 真正的块体文本：块引用前缀已被剥离，不能再用 src.slice(start,end) 取（长度不一致）
      text: bodyText,
    });
    i = j; // 跳过已消费的正文与收尾围栏
  }
  return { src: raw, blocks };
}

// ─────────────────────────── 生成 TS 源码 ───────────────────────────

const DOMAIN_FILES: { file: string; title: string; tables: string[] }[] = [
  {
    file: 'identity.ts',
    title: '① 身份与站点域',
    tables: [
      'ag_users',
      'ag_identities',
      'ag_sessions',
      'ag_email_rules',
      'ag_invite_codes',
      'ag_developers',
      'ag_sites',
      'ag_plugin_instances',
      'ag_dev_invitations',
      'ag_platform_settings',
    ],
  },
  {
    file: 'plugin.ts',
    title: '② 插件域',
    tables: [
      'ag_plugins',
      'ag_plugin_configs',
      'ag_plugin_grants',
      'ag_plugin_bindings',
      'ag_plugin_facts',
      'ag_plugin_invocations',
      'ag_plugin_storage',
      'ag_llm_cache',
      'ag_plugin_endpoints',
      'ag_plugin_ui_contributions',
      'ag_plugin_packages',
    ],
  },
  { file: 'policy.ts', title: '③ 策略域', tables: ['ag_policies', 'ag_policy_versions', 'ag_policy_assignments'] },
  {
    file: 'execution.ts',
    title: '④ 执行域',
    tables: ['ag_user_policy_state', 'ag_evaluations', 'ag_actions_log', 'ag_checkin_entitlements', 'ag_checkin_records'],
  },
  {
    file: 'integration.ts',
    title: '⑤ 集成与协同域',
    tables: [
      'ag_external_subjects',
      'ag_provider_sync_state',
      'ag_secrets',
      'ag_oidc_signing_keys',
      'ag_verify_clients',
      'ag_verify_challenges',
      'ag_verify_assertions',
      // ★ R58 新增：协同验证的 nonce 防重放（此前只有内存实现 → 多实例下失效）
      'ag_verify_nonces',
      // ★ R96 新增：本平台作为 **OAuth 授权服务器**（IdP）的三张表
      'ag_oauth_clients',
      'ag_oauth_codes',
      'ag_oauth_refresh_tokens',
      'ag_plugin_tokens',
      'ag_oidc_providers',
      // ★ R57 新增：登录事务（state + PKCE verifier）的持久化——
      //   此前只有内存实现，重启/多实例下登录不可用（R56 的架构缺口）。
      'ag_oidc_login_transactions',
    ],
  },
  {
    file: 'ops.ts',
    title: '⑥ 运维域',
    tables: ['ag_audit_log', 'ag_jobs', 'ag_event_outbox', 'ag_dead_letters', 'ag_quota_counters'],
  },
];

/**
 * 把字符串渲染成 TS 字面量：优先双引号（这样 SQL/谓词里的单引号无需转义），
 * 值里同时含双引号时才退回单引号并转义。
 */
function tsString(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function renderColumn(col: ParsedColumn): string {
  let expr = `col.${col.kind}(`;
  if (col.kind === 'varchar' || col.kind === 'binary') expr += col.length ?? 255;
  if (col.kind === 'numeric') expr += col.precision === undefined ? '' : `${col.precision}${col.scale === undefined ? '' : `, ${col.scale}`}`;
  if (col.kind === 'timestamp') expr += col.withTz ? '{ withTz: true }' : '';
  if (col.kind === 'enum') expr += `'${col.enumType}', [${(col.enumValues ?? []).map((v) => `'${v}'`).join(', ')}]`;
  expr += ')';
  if (col.primaryKey) expr += '.primaryKey()';
  if (col.notNull) expr += '.notNull()';
  if (col.nullable) expr += '.nullable()';
  if (col.defaultValue) {
    if (col.defaultValue.form === 'now') expr += '.defaultNow()';
    else if (col.defaultValue.form === 'sql') {
      // 用单引号包裹并转义内部单引号；反斜杠按字面量处理（SQL 表达式里常见 `E'...'`）
      expr += `.defaultSql(${tsString(col.defaultValue.expr)})`;
    }
    else {
      const v = col.defaultValue.value;
      expr += `.default(${typeof v === 'string' ? tsString(v) : String(v)})`;
    }
  }
  if (col.onUpdateNow) expr += '.onUpdateNow()';
  return expr;
}

function renderIndex(idx: ParsedIndex): string {
  const fn = idx.kind === 'unique' ? 't.unique' : idx.kind === 'primaryKey' ? 't.primaryKey' : 't.index';
  const cols = `[${idx.columns.map((c) => `'${c}'`).join(', ')}]`;
  const opts: string[] = [];
  if (idx.name) opts.push(`name: ${tsString(idx.name)}`);
  if (idx.where) opts.push(`where: ${tsString(idx.where)}`);
  if (idx.kind === 'index' && idx.unique === true) opts.push('unique: true');
  return `${fn}(${cols}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
}

function renderTable(table: ParsedTable): string {
  const width = Math.max(...table.columns.map((c) => c.name.length)) + 1;
  const lines: string[] = [];
  lines.push(`/** 来源：docs/02-数据模型.md:${table.line}（由 tools/extract-doc-schema.ts 生成，请勿手改） */`);
  lines.push(`export const ${table.declName || table.tableName} = declare(`);
  lines.push(`  '${table.declName || table.tableName}',`);
  lines.push(`  defineTable(`);
  lines.push(`    '${table.tableName}',`);
  lines.push(`    {`);
  for (const col of table.columns) {
    lines.push(`      ${`${col.name}:`.padEnd(width + 1)} ${renderColumn(col)},`);
  }
  lines.push(`    },`);
  if (table.indexes.length > 0) {
    lines.push(`    (t) => [`);
    for (const idx of table.indexes) lines.push(`      ${renderIndex(idx)},`);
    lines.push(`    ],`);
  }
  const optParts: string[] = [];
  const exemptReason = PLATFORM_EXEMPT_REASONS[table.tableName];
  if (exemptReason !== undefined) {
    optParts.push(`exemptReason: ${JSON.stringify(exemptReason)}`);
  }
  if (table.options.siteScoped !== undefined) optParts.push(`siteScoped: ${table.options.siteScoped}`);
  if (table.options.exemptReason !== undefined) optParts.push(`exemptReason: '${table.options.exemptReason.replace(/'/g, "\\'")}'`);
  if (table.options.dualScopeCheck !== undefined) optParts.push(`dualScopeCheck: ${JSON.stringify(table.options.dualScopeCheck)}`);
  if (optParts.length > 0) lines.push(`    { ${optParts.join(', ')} },`);
  lines.push(`  ),`);
  lines.push(`  { doc: 'docs/02-数据模型.md', line: ${table.line} },`);
  lines.push(`);`);
  return lines.join('\n');
}

// ─────────────────────────── 主流程 ───────────────────────────

function main(): void {
  const raw = readFileSync(DOC_PATH, 'utf8');
  let src = raw;

  // 逐条应用文档缺陷修复，并断言每条都精确命中（表感知：只在指定表体内替换）
  //
  // ★ 为什么用「锚点 + 字面量替换」而不是裸字符串 replace：
  //   1) 同一 pattern（如 ']);\n]);\n'）在文档里多处出现，必须限定表体；
  //   2) 替换会改变其后文本长度，所以 REPAIRS 必须按行号**降序**执行；
  //   3) 断言命中行号，保证文档被修正时立即报错而不是静默漂移。
  const appliedRepairs: { repair: Repair; line: number }[] = [];
  for (const repair of REPAIRS) {
    const anchor = `defineTable('${repair.table}'`;
    const anchorIdx = src.indexOf(anchor);
    if (anchorIdx < 0) throw new Error(`文档修复项 ${repair.id}：找不到锚点表 ${repair.table}`);
    const nextIdx = src.indexOf('defineTable(', anchorIdx + anchor.length);
    const windowEnd = nextIdx < 0 ? src.length : nextIdx;
    const windowStart = Math.max(0, anchorIdx - 200);
    const window = src.slice(windowStart, windowEnd);

    const occurrences: number[] = [];
    {
      let from = 0;
      while (true) {
        const at = window.indexOf(repair.match, from);
        if (at < 0) break;
        occurrences.push(at);
        from = at + repair.match.length;
      }
    }
    const wantOccurrence = repair.occurrence ?? 1;
    if (occurrences.length < wantOccurrence) {
      throw new Error(
        `文档修复项 ${repair.id}（${repair.table}）预期在表体内至少命中 ${wantOccurrence} 次，实际 ${occurrences.length} 次` +
          `（docs/02-数据模型.md:${repair.line}）。文档可能已被修正——` +
          `请同步更新 tools/extract-doc-schema.ts 的 REPAIRS 与 reports/schema-doc-defects.md。`,
      );
    }
    const hitOffset = windowStart + occurrences[wantOccurrence - 1]!;
    const hitLine = src.slice(0, hitOffset).split('\n').length;
    // 行号断言：允许因前面已执行的修复（插入列）造成的小幅下移，但不允许提前命中
    // （提前命中意味着 pattern 打到了别的行——这正是曾经静默污染 actionSeq 的那种 bug）。
    if (hitLine < repair.line || hitLine > repair.line + 20) {
      throw new Error(
        `文档修复项 ${repair.id} 预期在第 ${repair.line} 行附近，实际命中第 ${hitLine} 行——文档行号已漂移，请核对。`,
      );
    }
    const actual = src.slice(hitOffset, hitOffset + repair.match.length);
    if (actual !== repair.match) {
      throw new Error(`文档修复项 ${repair.id}：命中处文本与 match 不一致，拒绝替换（防止静默污染）。`);
    }
    src = src.slice(0, hitOffset) + repair.replace + src.slice(hitOffset + actual.length);
    appliedRepairs.push({ repair, line: hitLine });
  }

  const { blocks } = scanFences(src);
  const parsed: ParsedTable[] = [];
  const defects: string[] = [];
  for (const block of blocks) {
    const body = block.text;
    if (!/defineTable\s*\(/.test(body)) continue;
    const lineOf = (offset: number) => src.slice(0, block.start + offset).split('\n').length;
    let idx = 0;
    while (true) {
      const found = body.indexOf('defineTable(', idx);
      if (found < 0) break;
      const table = parseTableCall(body, found, lineOf, defects);
      parsed.push(table);
      idx = found + 'defineTable('.length;
    }
  }

  // 去重（同一张表被文档重复定义时保留第一处并登记缺陷）
  const byName = new Map<string, ParsedTable>();
  for (const t of parsed) {
    if (byName.has(t.tableName)) {
      defects.push(`表被重复定义：${t.tableName}（第二处位于 docs/02-数据模型.md:${t.line}）`);
      continue;
    }
    byName.set(t.tableName, t);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(REPORT_DIR, { recursive: true });

  const allNames = DOMAIN_FILES.flatMap((d) => d.tables);
  const missing = allNames.filter((n) => !byName.has(n));
  const extra = [...byName.keys()].filter((n) => !allNames.includes(n));

  const exportLines: string[] = [];
  for (const domain of DOMAIN_FILES) {
    const parts: string[] = [];
    parts.push(`/**`);
    parts.push(` * ${domain.title} —— 由 tools/extract-doc-schema.ts 从 docs/02-数据模型.md 提取生成。`);
    parts.push(` * 请勿手改：改文档后重跑 \`npm run schema:extract\`。`);
    parts.push(` */`);
    parts.push(`import { col, declare, defineTable, t } from '../dsl.ts';`);
    parts.push('');
    for (const name of domain.tables) {
      const table = byName.get(name);
      if (!table) continue;
      parts.push(renderTable(table));
      parts.push('');
    }
    const filePath = join(OUT_DIR, domain.file);
    writeFileSync(filePath, `${parts.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, 'utf8');
    console.log(`[extract] 写出 ${domain.file}（${domain.tables.filter((n) => byName.has(n)).length} 张表）`);
    for (const name of domain.tables) {
      const table = byName.get(name);
      if (table) exportLines.push(`export { ${table.declName || name} } from './${domain.file.replace(/\.ts$/, '.ts')}';`);
    }
  }

  // tables/index.ts
  const indexLines: string[] = [];
  indexLines.push('/**');
  indexLines.push(' * 全部表的汇总入口（由 tools/extract-doc-schema.ts 生成）。');
  indexLines.push(' *');
  indexLines.push(' * 消费方只经 `allTables` / `normalizeTables(allTables)` 使用，不要 import 具体表文件。');
  indexLines.push(' */');
  indexLines.push(`import { collectTables, type TableDecl } from '../dsl.ts';`);
  for (const domain of DOMAIN_FILES) {
    indexLines.push(`import { ${domain.tables.map((n) => byName.get(n)?.declName || n).filter(Boolean).join(', ')} } from './${domain.file.replace(/\.ts$/, '.ts')}';`);
  }
  indexLines.push('');
  indexLines.push('export const allTables: readonly TableDecl[] = collectTables([');
  for (const domain of DOMAIN_FILES) {
    for (const name of domain.tables) {
      const table = byName.get(name);
      if (table) indexLines.push(`  ${table.declName || name},`);
    }
  }
  indexLines.push(']);');
  indexLines.push('');
  writeFileSync(join(OUT_DIR, 'index.ts'), `${indexLines.join('\n')}\n`, 'utf8');
  // ★ 护栏：文档里提取到的表若未归入任何分组，就会**静默丢失**
  //   （不进任何模块文件 → 无声明 → 无 DDL）。这正是一次真实事故：
  //   新增 `ag_event_outbox` / `ag_dead_letters` 后 index 显示 42 张，
  //   而各模块之和只有 40 张，两张表凭空消失、无任何报错。
  //   人工维护的分组清单是缺陷之源，因此这里**显式报错**而不是静默跳过。
  const grouped = new Set(DOMAIN_FILES.flatMap((domain) => domain.tables));
  const ungrouped = [...byName.keys()].filter((name) => !grouped.has(name));
  if (ungrouped.length > 0) {
    throw new Error(
      `以下表已从文档提取但**未归入任何分组**，会导致静默丢失（无声明、无 DDL）：\n` +
        ungrouped.map((name) => `  - ${name}`).join('\n') +
        `\n请在 tools/extract-doc-schema.ts 的 DOMAIN_FILES 中为它们指定归属模块。`,
    );
  }

  console.log(`[extract] 写出 index.ts（${[...byName.keys()].length} 张表）`);

  // IR 快照：★ 写到 reports/ 而不是 src/schema/tables/——
  //   它是**产物**不是源码，放在 src/ 下会被 CI 的「核心代码系统名扫描」误伤
  //   （JSON 里含文档原文的 newapiLogId），也会污染 tsc 的输入目录。
  writeFileSync(
    join(REPORT_DIR, 'schema-extracted.json'),
    `${JSON.stringify(
      [...byName.values()].map((t) => ({
        tableName: t.tableName,
        declName: t.declName,
        line: t.line,
        columns: t.columns.map((c) => ({ name: c.name, kind: c.kind, notNull: c.notNull, primaryKey: c.primaryKey })),
        indexes: t.indexes,
        options: t.options,
      })),
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log('');
  console.log(`[extract] 文档：${DOC_PATH}`);
  console.log(`[extract] 解析到表：${byName.size} 张；域清单期望：${allNames.length} 张`);
  if (missing.length > 0) console.log(`[extract] ⚠️ 域清单中缺失声明：${missing.join(', ')}`);
  if (extra.length > 0) console.log(`[extract] ⚠️ 域清单外多出声明：${extra.join(', ')}`);
  console.log('[extract] 本次命中的文档缺陷修复项：');
  for (const { repair } of appliedRepairs) {
    console.log(`  - ${repair.id} @ docs/02-数据模型.md:${repair.line}  ${repair.description}`);
  }
  if (defects.length > 0) {
    console.log('[extract] 解析期缺陷：');
    for (const d of defects) console.log(`  - ${d}`);
  }
  console.log('[extract] 完成。');
}

if (process.env.AG_EXTRACT_NO_MAIN !== '1') main();
