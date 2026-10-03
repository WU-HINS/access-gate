/**
 * 静态守卫：把「事务外查询」与「裸 SQL」在 CI 阶段拦下（D17 前置 3 / M0-11a）。
 *
 * 为什么需要静态检查而不只靠运行期：
 *   运行期只在**被执行到**的路径上抛错；而「事务外查询」往往出现在异常分支或新加的工具函数里，
 *   测试覆盖不到。静态扫描可以在合并前就发现它，且不依赖测试用例的完整性。
 *
 * 检出两类问题：
 *   1. `outside-transaction` —— 直接调用驱动查询（`pglite.query` / `.sql` / `pool.query` / `client.query`）
 *      而没有出现在 `withTransaction(...)` 的调用域内；
 *   2. `raw-sql` —— 模板字面量里拼接 SELECT/INSERT/UPDATE/DELETE（参数化字面量不算）。
 *
 * ★ 反例必须能被区分：本模块的自检（`test/guard.test.ts`）用「故意违规」与「合法参数化」两组输入，
 *   证明扫描器不是恒真也不是恒假。
 */

import type { StaticViolation } from '../schema/compile/ci-checks.ts';

/**
 * 驱动查询调用点：**必须带接收者**，即 `x.query(` / `x.sql(` / `pglite.exec(`。
 *
 * ★ 为什么要求接收者：`/re/.exec(s)` 与字符串方法也写作 `.exec(`，
 *   若允许裸 `exec(`，正则会大量误杀（自检里的反例正是为此存在）。
 */
const QUERY_CALL = /\b([\w$]+)\.(?:query|sql|exec)\s*\(/g;

/**
 * `exec` 是**双用途**方法名（`RegExp.prototype.exec` 与驱动 `exec`）。
 * 只在接收者像驱动实例时才把 `.exec(` 当查询；`SYSTEM_NAME.exec(line)` 这类正则调用必须放过。
 * `.query(` / `.sql(` 无此歧义（标准库没有同名方法），一律计入。
 */
const DRIVER_RECEIVERS = /^(?:db|raw|pglite|pg|client|pool|conn|connection|txn|trx|tx)$/i;

/** 事务入口名（出现在同一函数体内即认为该查询处于事务域内）。 */
const TRANSACTION_MARKERS = [/\bwithTransaction\s*\(/, /\bctx\.db\.transaction\s*\(/, /\btransaction\s*\(/];

/** 允许出现裸查询的文件（驱动层自身与测试）。 */
const ALLOWED_FILES = [
  // 驱动层自身（唯一允许直接调用 pglite 的地方）
  /^src\/db\/(tx|pool|advisory-lock)\.ts$/,
  // 迁移/漂移检测的基础设施：它必须能在业务事务之外执行 DDL 并回读 information_schema
  // （这正是它的职责——比对活库结构与 IR 声明），不属于「业务查询绕过作用域」。
  /^src\/schema\/compile\/drift\.ts$/,
  // 查询编译器：AST → 参数化 SQL 的**唯一**合法构造点（标识符来自 AST 且受标识符白名单校验，
  // 值一律走 $n 参数）。把它判为「裸 SQL」等于禁止必要的编译器存在。
  /^src\/query\/compile\.ts$/,
  /^test\//,
  /^tools\//,
];

/**
 * 裸 SQL 判据只针对 **DML**（业务查询）。
 *
 * ★ 为什么不含 DDL：DDL 编译器（`src/schema/compile/ddl.ts`）的职责就是**构造**
 *   `CREATE TABLE` / `CREATE TRIGGER` 语句文本——把 DDL 关键字计入会把编译器本身判成违规。
 *   本规则要拦的是「业务代码里拼 DML 绕过参数化」，不是「编译器生成 DDL」。
 */
const SQL_KEYWORDS = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;

export interface GuardOptions {
  /** 覆盖默认白名单（正则数组，作用于相对路径） */
  allowedFiles?: RegExp[];
}

function isAllowed(file: string, options: GuardOptions): boolean {
  const list = options.allowedFiles ?? ALLOWED_FILES;
  return list.some((re) => re.test(file));
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * 扫描单个文件源码。
 *
 * @param source 文件全文
 * @param file 相对仓库根的路径（用于白名单与报错定位）
 */
export function scanSource(source: string, file: string, options: GuardOptions = {}): StaticViolation[] {
  const out: StaticViolation[] = [];
  if (isAllowed(file, options)) return out;

  const lines = source.split('\n');

  // ── 检查 1：事务外查询 ──
  // 粗粒度但方向正确的判据：同一「顶层声明块」内若出现驱动查询调用，
  // 则该块（或它所在文件）必须出现事务入口标记。
  const blocks = splitTopLevelBlocks(source);
  for (const block of blocks) {
    const queryMatches = [...block.text.matchAll(QUERY_CALL)].filter((m) => {
      const receiver = m[1] ?? '';
      const method = /\.(query|sql|exec)\s*\($/.exec(m[0])?.[1] ?? '';
      if (method === 'exec' && !DRIVER_RECEIVERS.test(receiver)) return false;
      return true;
    });
    if (queryMatches.length === 0) continue;
    const inTx = TRANSACTION_MARKERS.some((re) => re.test(block.text));
    if (inTx) continue;
    const first = queryMatches[0]!;
    const abs = block.start + (first.index ?? 0);
    out.push({
      file,
      line: lineOf(source, abs),
      rule: 'outside-transaction',
      message: '驱动查询出现在 withTransaction 之外（违反单一事务入口，站点作用域注入会被绕过）',
      snippet: (lines[lineOf(source, abs) - 1] ?? '').trim().slice(0, 160),
    });
  }

  // ── 检查 2：裸 SQL（模板字面量插值）──
  for (const match of source.matchAll(/`(?:[^`\\]|\\.)*`/gs)) {
    const body = match[0];
    if (!body.includes('${')) continue;
    if (!SQL_KEYWORDS.test(body)) continue;
    const abs = match.index ?? 0;
    out.push({
      file,
      line: lineOf(source, abs),
      rule: 'raw-sql',
      message: 'SQL 关键字出现在带插值的模板字面量里（应使用参数化占位符 $1/$2）',
      snippet: body.replace(/\s+/g, ' ').slice(0, 160),
    });
  }

  return out;
}

interface SourceBlock {
  text: string;
  start: number;
}

/**
 * 按顶层声明切块（`function` / `export function` / 箭头函数常量 / 方法）。
 * 目的：把「事务入口」与「查询调用」限制在同一逻辑单元内比较，避免跨函数误判。
 */
function splitTopLevelBlocks(source: string): SourceBlock[] {
  const starts: number[] = [];
  const re = /^(?:export\s+)?(?:async\s+)?(?:function\s+[\w$]+|const\s+[\w$]+\s*=\s*(?:async\s*)?\(|class\s+[\w$]+)/gm;
  for (const m of source.matchAll(re)) starts.push(m.index ?? 0);
  if (starts.length === 0) return [{ text: source, start: 0 }];
  const blocks: SourceBlock[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : source.length;
    blocks.push({ text: source.slice(from, to), start: from });
  }
  // 文件头（import / 类型定义）也算一块，便于捕获顶层立即执行的查询
  blocks.push({ text: source.slice(0, starts[0]!), start: 0 });
  return blocks;
}
