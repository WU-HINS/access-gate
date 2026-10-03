/**
 * 表声明装载器：优先装载**真实声明** `src/schema/tables/index.ts` 的 `allTables`；
 * 该文件尚未就绪时回落到 `fixtures.ts`（并显式标注 `FIXTURE`）。
 *
 * 为什么用「非字面量动态 import」：真实声明由并行工作流产出，可能在 `tsc --noEmit` 时**还不存在**；
 * 字面量 `import('../tables/index.ts')` 会让 tsc 直接报 TS2307。这里用运行时拼出的路径，
 * 让编译器不静态解析它，同时在运行时做结构校验（`allTables` 必须是 `TableDecl[]`）。
 */

import type { TableDecl } from '../dsl.ts';
import type { NormalizedTable } from '../ir.ts';
import { normalizeTables } from '../normalize.ts';
import { fixtureTables, FIXTURE_TABLE_NAMES } from './fixtures.ts';

export type TablesSource = 'real' | 'fixture';

export interface LoadedTables {
  source: TablesSource;
  /** 真实声明路径（报告里打印用） */
  entry: string;
  tables: NormalizedTable[];
  /** 真实声明未就绪时的原因（source === 'fixture' 时必填） */
  fallbackReason?: string;
  warnings: string[];
}

export const REAL_TABLES_ENTRY = 'src/schema/tables/index.ts';

/** 运行时拼出模块说明符，避免 tsc 在真实声明缺失时静态报错。 */
function realTablesSpecifier(): string {
  const spec: string = ['..', 'tables', 'index.ts'].join('/');
  return spec;
}

function looksLikeTableDecl(value: unknown): value is TableDecl {
  if (typeof value !== 'object' || value === null) return false;
  const decl = value as Partial<TableDecl>;
  return typeof decl.name === 'string' && Array.isArray(decl.columns);
}

export interface LoadOptions {
  /** true：真实声明缺失时直接抛错（db:generate / db:migrate 的严格模式用） */
  requireReal?: boolean;
}

export async function loadTables(options: LoadOptions = {}): Promise<LoadedTables> {
  const entry = REAL_TABLES_ENTRY;
  let fallbackReason: string | undefined;
  try {
    const mod = (await import(realTablesSpecifier())) as { allTables?: unknown; default?: unknown };
    const raw = mod.allTables ?? mod.default;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`${entry} 未导出非空的 allTables: TableDecl[]`);
    }
    const decls = raw.filter(looksLikeTableDecl);
    if (decls.length !== raw.length) {
      throw new Error(`${entry} 的 allTables 含 ${raw.length - decls.length} 个非法 TableDecl`);
    }
    return {
      source: 'real',
      entry,
      tables: normalizeTables(decls),
      warnings: [],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options.requireReal) {
      throw new Error(`真实声明 ${entry} 未就绪：${reason}`);
    }
    fallbackReason = reason;
  }

  return {
    source: 'fixture',
    entry,
    tables: normalizeTables(fixtureTables),
    fallbackReason,
    warnings: [
      `真实声明 ${entry} 未就绪（${fallbackReason}）`,
      `本次结论基于 ${FIXTURE_TABLE_NAMES.length} 张夹具表：${FIXTURE_TABLE_NAMES.join(', ')}`,
      '夹具表不是验收对象——真实声明就绪后必须重跑。',
    ],
  };
}

/** 打印装载来源（工具统一入口，保证「不静默使用夹具」）。 */
export function describeSource(loaded: LoadedTables): string {
  return loaded.source === 'real'
    ? `真实声明 ${loaded.entry}（${loaded.tables.length} 张表）`
    : `FIXTURE ${loaded.tables.length} 张夹具表（真实声明 ${loaded.entry} 未就绪）`;
}
