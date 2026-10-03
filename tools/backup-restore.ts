#!/usr/bin/env node
/**
 * tools/backup-restore.ts —— 备份 / 恢复**演练**（M6-6）。
 *
 * ★ 为什么叫「演练」而不是「备份脚本」：
 *   从未恢复过的备份等于没有备份。本项目已有多次「声称已修但没落地」的教训
 *   （docs/HANDOFF.md §6.2），因此这里把
 *   **「备份 → 恢复到新库 → 逐表行数比对」做成一条可复跑的命令**：跑通才算数。
 *
 * ★ 为什么不用 `pg_dump` / `psql`：
 *   `embedded-postgres` 只提供**服务器**二进制（initdb / pg_ctl / postgres），
 *   没有客户端工具；而生产环境未必在 PATH 里有 pg_dump。
 *   这里实现**逻辑备份**（逐表 `COPY ... TO STDOUT` + 元数据 JSON），
 *   只依赖 `pg` 客户端——与生产驱动同一套代码路径。
 *
 * 用法：
 *   node --experimental-strip-types tools/backup-restore.ts \
 *     --source postgres://accessgate@127.0.0.1:55432/accessgate \
 *     --target postgres://accessgate@127.0.0.1:55432/accessgate_restore \
 *     --dir /tmp/ag-backup
 *
 * 未提供连接串时**跳过**（不假装成功），并打印如何跑。
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Client } from 'pg';

export interface BackupManifest {
  createdAt: string;
  source: string;
  /** 每张表的行数（恢复后据此比对） */
  tables: { name: string; columns: string[]; rows: number }[];
}

export interface DrillResult {
  ok: boolean;
  backedUpTables: number;
  restoredTables: number;
  rowsExpected: number;
  rowsActual: number;
  mismatches: { table: string; expected: number; actual: number }[];
  detail: string;
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const { Client: PgClient } = (await import('pg')) as unknown as typeof import('pg');
  const client = new PgClient({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** 列出备份范围内的表（`ag_` 前缀，按名排序保证稳定）。 */
export async function listTables(connectionString: string): Promise<string[]> {
  return withClient(connectionString, async (client) => {
    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ag\\_%' ORDER BY table_name",
    );
    return result.rows.map((row) => row.table_name);
  });
}

/**
 * 逻辑备份：逐表 `COPY ... TO STDOUT` 落成 TSV 文件，并写 manifest.json。
 *
 * ★ 为什么用 `COPY` 而不是 `SELECT` + 自己序列化：
 *   `COPY` 是 PG 原生的**二进制安全**导出（正确处理 NULL、转义、bytea），
 *   自己序列化时最容易在 NULL 与空串之间出错——那样恢复出来的数据是「看起来对」的。
 */
export async function backup(options: { source: string; dir: string }): Promise<BackupManifest> {
  mkdirSync(options.dir, { recursive: true });
  const tables = await listTables(options.source);
  const manifest: BackupManifest = { createdAt: new Date().toISOString(), source: options.source, tables: [] };

  await withClient(options.source, async (client) => {
    for (const table of tables) {
      const columnsResult = await client.query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
        ['public', table],
      );
      const columns = columnsResult.rows.map((row) => row.column_name);
      const copyResult = await client.query<{ data: string }>(
        `COPY (SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${table}") TO STDOUT`,
      );
      // pg 的 COPY TO STDOUT 结果在 rows[0].data（多行拼接）
      const data = copyResult.rows.map((row) => row.data).join('');
      writeFileSync(join(options.dir, `${table}.tsv`), data, 'utf8');
      const countResult = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
      manifest.tables.push({ name: table, columns, rows: Number(countResult.rows[0]?.n ?? 0) });
    }
  });

  writeFileSync(join(options.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/** 恢复：逐表 `COPY ... FROM STDIN`。目标表必须已存在（先跑迁移）。 */
export async function restore(options: { target: string; dir: string }): Promise<number> {
  const manifest = JSON.parse(readFileSync(join(options.dir, 'manifest.json'), 'utf8')) as BackupManifest;
  let restored = 0;
  await withClient(options.target, async (client) => {
    await client.query('BEGIN');
    try {
      for (const table of manifest.tables) {
        const file = join(options.dir, `${table.name}.tsv`);
        if (!statSync(file).size) continue; // 空表跳过（COPY FROM 空文件会报错）
        const data = readFileSync(file, 'utf8');
        await client.query(`COPY "${table.name}" (${table.columns.map((c) => `"${c}"`).join(', ')}) FROM STDIN`, [data]);
        restored += 1;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return restored;
}

/** 逐表行数比对（演练的**判据**）。 */
export async function compare(manifest: BackupManifest, target: string): Promise<{ mismatches: DrillResult['mismatches']; total: number }> {
  return withClient(target, async (client) => {
    const mismatches: DrillResult['mismatches'] = [];
    let total = 0;
    for (const table of manifest.tables) {
      const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table.name}"`);
      const actual = Number(result.rows[0]?.n ?? 0);
      total += actual;
      if (actual !== table.rows) mismatches.push({ table: table.name, expected: table.rows, actual });
    }
    return { mismatches, total };
  });
}

/** 完整演练：备份 → 恢复 → 比对。 */
export async function drill(options: { source: string; target: string; dir: string }): Promise<DrillResult> {
  const manifest = await backup({ source: options.source, dir: options.dir });
  const restoredTables = await restore({ target: options.target, dir: options.dir });
  const { mismatches, total } = await compare(manifest, options.target);
  const expected = manifest.tables.reduce((sum, t) => sum + t.rows, 0);
  return {
    ok: mismatches.length === 0,
    backedUpTables: manifest.tables.length,
    restoredTables,
    rowsExpected: expected,
    rowsActual: total,
    mismatches,
    detail:
      mismatches.length === 0
        ? `备份 ${manifest.tables.length} 张表 / ${expected} 行 → 恢复到 ${options.target} → 逐表行数一致`
        : `恢复到 ${options.target} 后有 ${mismatches.length} 张表行数不一致`,
  };
}

// ─────────────────────────── CLI ───────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const source = get('--source');
  const target = get('--target');
  const dir = get('--dir') ?? '/tmp/ag-backup';

  if (source === undefined || target === undefined) {
    process.stdout.write(
      '备份/恢复演练未执行（缺少 --source / --target）。\n' +
        '  用法：node --experimental-strip-types tools/backup-restore.ts \\\n' +
        '          --source postgres://user@host:port/db --target postgres://user@host:port/db_restore --dir /tmp/ag-backup\n' +
        '  提示：真实 PG 可用 `node tools/pg-real.ts start` 拉起（其二进制不含 pg_dump，本工具不依赖它）。\n',
    );
    process.exitCode = 2;
    return;
  }

  const result = await drill({ source, target, dir });
  process.stdout.write(`${result.ok ? '✅' : '❌'} ${result.detail}\n`);
  if (result.mismatches.length > 0) {
    for (const mismatch of result.mismatches) {
      process.stdout.write(`   ${mismatch.table}: 期望 ${mismatch.expected} 行，实际 ${mismatch.actual} 行\n`);
    }
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('backup-restore.ts')) {
  await main();
}
