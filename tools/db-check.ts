/**
 * `npm run db:check` —— 两阶段：
 *   (a) **门禁**：`src/schema/gate/scope.ts` 的 `checkScopeRules`（R1–R6）。模块缺失 → 打印 SKIP 并**非零退出**
 *       （绝不静默跳过）；任一 `severity:'error'` → 打印违规报告并退出 1。
 *   (b) **漂移检测**：把 DDL 真跑到内存库 → 从 information_schema / pg_catalog 读回 → 与 IR 对比。
 *       有差异 → 打印 DriftFinding 列表并退出 1；无差异 → `db:check OK` 退出 0。
 *
 * 用法：
 *   npm run db:check
 *   npm run db:check -- --drift-demo <column-type|drop-column|add-column|drop-index>
 *   npm run db:check -- --no-gate --json
 *
 * 退出码：0 通过 · 1 门禁违规/漂移检出 · 2 门禁模块缺失（SKIP）· 3 漂移检测失效（demo 未被检出）
 */

import path from 'node:path';
import process from 'node:process';
import { compileSchema, collectEnumTypes } from '../src/schema/compile/ddl.ts';
import { describeSource, loadTables } from '../src/schema/compile/load-tables.ts';
import {
  DRIFT_DEMO_KINDS,
  applySchema,
  diffSchema,
  execRaw,
  formatFindings,
  introspect,
  openDatabase,
  planDriftDemo,
  type DriftDemoKind,
} from '../src/schema/compile/drift.ts';
import type { NormalizedTable, ScopeViolation } from '../src/schema/ir.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

// ───────────────────────────── 参数 ─────────────────────────────

interface Args {
  driftDemo?: DriftDemoKind;
  noGate: boolean;
  json: boolean;
  requireReal: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { noGate: false, json: false, requireReal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--drift-demo') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`--drift-demo 需要取值：${DRIFT_DEMO_KINDS.join('|')}`);
      if (!(DRIFT_DEMO_KINDS as readonly string[]).includes(value)) {
        throw new Error(`未知 drift-demo 类型：${value}（可选：${DRIFT_DEMO_KINDS.join('|')}）`);
      }
      args.driftDemo = value as DriftDemoKind;
      i += 1;
    } else if (arg !== undefined && arg.startsWith('--drift-demo=')) {
      const value = arg.slice('--drift-demo='.length);
      if (!(DRIFT_DEMO_KINDS as readonly string[]).includes(value)) {
        throw new Error(`未知 drift-demo 类型：${value}（可选：${DRIFT_DEMO_KINDS.join('|')}）`);
      }
      args.driftDemo = value as DriftDemoKind;
    } else if (arg === '--no-gate') {
      args.noGate = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--require-real') {
      args.requireReal = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return args;
}

// ───────────────────────────── (a) 门禁 ─────────────────────────────

interface GateModule {
  checkScopeRules: (tables: readonly NormalizedTable[], exemptions: unknown) => ScopeViolation[];
  hasErrors?: (violations: readonly ScopeViolation[]) => boolean;
  formatViolations?: (violations: readonly ScopeViolation[]) => string;
}

/** 运行时拼说明符：`gate/scope.ts` 由并行工作流产出，可能在 tsc 时还不存在。 */
function gateSpecifier(file: string): string {
  const spec: string = ['..', 'src', 'schema', 'gate', file].join('/');
  return spec;
}

async function loadGate(): Promise<{ ok: true; gate: GateModule; exemptions: unknown } | { ok: false; reason: string }> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(gateSpecifier('scope.ts'))) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      reason: `src/schema/gate/scope.ts 不可装载：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const check = mod.checkScopeRules;
  if (typeof check !== 'function') {
    return { ok: false, reason: 'src/schema/gate/scope.ts 未导出 checkScopeRules' };
  }
  let exemptions: unknown;
  try {
    const ex = (await import(gateSpecifier('exemptions.ts'))) as Record<string, unknown>;
    exemptions = ex.PLATFORM_EXEMPTIONS;
    if (exemptions === undefined) {
      console.warn('WARN: src/schema/gate/exemptions.ts 未导出 PLATFORM_EXEMPTIONS，按空豁免表运行');
    }
  } catch {
    console.warn('WARN: src/schema/gate/exemptions.ts 不存在，按空豁免表运行（R3 可能误报）');
  }
  return {
    ok: true,
    gate: {
      checkScopeRules: check as GateModule['checkScopeRules'],
      ...(typeof mod.hasErrors === 'function'
        ? { hasErrors: mod.hasErrors as GateModule['hasErrors'] }
        : {}),
      ...(typeof mod.formatViolations === 'function'
        ? { formatViolations: mod.formatViolations as GateModule['formatViolations'] }
        : {}),
    },
    exemptions,
  };
}

async function runGate(tables: readonly NormalizedTable[], json: boolean): Promise<number> {
  console.log('── 阶段 (a) 作用域门禁 ─────────────────────────────────');
  const loaded = await loadGate();
  if (!loaded.ok) {
    console.error(`SKIP: ${loaded.reason}`);
    console.error('SKIP: 门禁未执行 —— 按契约「绝不静默跳过」，以非零退出码 2 结束。');
    return 2;
  }
  const violations = loaded.gate.checkScopeRules(tables, loaded.exemptions);
  if (!Array.isArray(violations)) {
    console.error('SKIP: checkScopeRules 未返回数组');
    return 2;
  }
  const errors = violations.filter((v) => v.severity === 'error');
  const warns = violations.filter((v) => v.severity !== 'error');
  // R4 判据优先用门禁模块自己的 hasErrors（口径由契约方持有），缺失时按 severity 兜底。
  const gateSaysError =
    loaded.gate.hasErrors === undefined ? errors.length > 0 : loaded.gate.hasErrors(violations);

  if (json) {
    console.log(JSON.stringify({ phase: 'gate', violations }, null, 2));
  } else if (violations.length === 0) {
    console.log(`PASS: 门禁 0 违规（检查 ${tables.length} 张表）`);
  } else if (loaded.gate.formatViolations !== undefined) {
    console.log(loaded.gate.formatViolations(violations));
  } else {
    for (const v of violations) {
      console.log(`  [${v.severity.toUpperCase()}] ${v.rule} ${v.tableName} — ${v.detail}`);
      console.log(`        建议：${v.suggestion}`);
    }
  }

  if (gateSaysError) {
    console.error(`FAIL: 门禁发现 ${errors.length} 条 error（warn ${warns.length} 条）→ R4：db:check 必须非零退出`);
    return 1;
  }
  console.log(`PASS: 门禁无 error（warn ${warns.length} 条）`);
  return 0;
}

// ───────────────────────────── (b) 漂移检测 ─────────────────────────────

async function runDrift(
  tables: readonly NormalizedTable[],
  args: Args,
): Promise<number> {
  console.log('── 阶段 (b) 结构漂移检测 ───────────────────────────────');
  const compiled = compileSchema(tables);
  const db = await openDatabase();
  try {
    await applySchema(db, compiled);
    const baseline = diffSchema(tables, await introspect(db));
    console.log(
      `  基线：DDL 真跑 ${compiled.plan.length} 条语句（表 ${compiled.tables.length} · 枚举 ${collectEnumTypes(tables).size} · 索引 ${compiled.indexes.length}），` +
        `漂移发现 ${baseline.length} 条`,
    );
    if (baseline.length > 0) {
      console.error('FAIL: 编译器产物与 PG 回读结构不一致（基线漂移，说明编译器或比较口径有缺陷）');
      console.error(formatFindings(baseline));
      return 1;
    }

    if (args.driftDemo === undefined) {
      console.log('db:check OK —— 表/列/类型/可空/长度/默认值/主键/索引/枚举全部一致，0 条漂移');
      return 0;
    }

    const demo = planDriftDemo(args.driftDemo, tables);
    console.log('');
    console.log(`  drift-demo(${demo.kind})：${demo.description}`);
    console.log(`  人为破坏 DDL：${demo.sql}`);
    await execRaw(db, demo.sql);

    const findings = diffSchema(tables, await introspect(db));
    if (args.json) console.log(JSON.stringify({ phase: 'drift', demo: demo.kind, findings }, null, 2));
    else console.log(formatFindings(findings));

    const kinds = new Set(findings.map((f) => f.kind));
    const hit = demo.expectKinds.filter((k) => kinds.has(k));
    console.log('');
    console.log(`  检出 ${findings.length} 条漂移；期望 kind=${demo.expectKinds.join(',')}，命中 kind=${hit.join(',') || '<无>'}`);
    if (findings.length === 0 || hit.length !== demo.expectKinds.length) {
      console.error(`FAIL: drift-demo(${demo.kind}) 未被检出 —— 漂移检测失效（恒真/恒假）`);
      return 3;
    }
    console.log(`PASS: drift-demo(${demo.kind}) 被检出（退出码 1，与非漂移场景可区分）`);
    return 1;
  } finally {
    await db.close();
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

function mergeExit(gate: number, drift: number): number {
  const rank = (code: number): number => (code === 3 ? 4 : code === 1 ? 3 : code === 2 ? 2 : 1);
  return rank(gate) >= rank(drift) ? gate : drift;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadTables({ requireReal: args.requireReal });
  for (const warning of loaded.warnings) console.warn(`WARN: ${warning}`);

  console.log('db:check 开始');
  console.log(`  来源: ${describeSource(loaded)}`);
  console.log(`  模式: ${args.driftDemo === undefined ? '常规' : `drift-demo ${args.driftDemo}`}${args.noGate ? ' · 跳过门禁' : ''}`);
  console.log('');

  const gateCode = args.noGate ? 0 : await runGate(loaded.tables, args.json);
  console.log('');
  const driftCode = await runDrift(loaded.tables, args);

  const code = mergeExit(gateCode, driftCode);
  console.log('');
  console.log(`db:check 汇总：门禁=${gateCode} 漂移=${driftCode} → 退出码 ${code}`);
  if (loaded.source === 'fixture') {
    console.warn('WARN: 真实声明尚未就绪——本次结论基于夹具表，不是 M0 验收对象。');
  }
  return code;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 3;
}
