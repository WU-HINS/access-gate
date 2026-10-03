/**
 * `npm run db:migrate` —— 把全部 DDL **真跑到空库**（PGlite，默认进程内内存实例）。
 *
 * 用法：
 *   npm run db:migrate                       # 内存实例（默认，避免大量磁盘 IO）
 *   npm run db:migrate -- --data-dir .tmp/pg # 持久化到目录（可选）
 *   npm run db:migrate -- --require-real     # 真实声明未就绪时直接失败
 *
 * 失败时打印：语句序号、归属表、原始 PG 报错、完整语句文本。
 */

import path from 'node:path';
import process from 'node:process';
import { compileSchema, collectEnumTypes } from '../src/schema/compile/ddl.ts';
import { describeSource, loadTables } from '../src/schema/compile/load-tables.ts';
import { DdlApplyError, applySchema, listLiveTables, MIGRATIONS_TABLE, openDatabase, type DdlTarget } from '../src/schema/compile/drift.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

interface Args {
  dataDir?: string;
  /** ★ 外部 PostgreSQL 连接串（生产用；与 --data-dir 互斥） */
  databaseUrl?: string;
  requireReal: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { requireReal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--data-dir 需要一个路径参数');
      args.dataDir = path.resolve(ROOT, value);
      i += 1;
    } else if (arg === '--require-real') {
      args.requireReal = true;
    } else if (arg !== undefined && arg.startsWith('--data-dir=')) {
      args.dataDir = path.resolve(ROOT, arg.slice('--data-dir='.length));
    } else if (arg === '--database-url') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--database-url 需要一个连接串参数');
      args.databaseUrl = value;
      i += 1;
    } else if (arg !== undefined && arg.startsWith('--database-url=')) {
      args.databaseUrl = arg.slice('--database-url='.length);
    } else {
      throw new Error(`未知参数：${String(arg)}`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadTables({ requireReal: args.requireReal });
  for (const warning of loaded.warnings) console.warn(`WARN: ${warning}`);
  const source = describeSource(loaded);

  const compiled = compileSchema(loaded.tables);
  const enumCount = collectEnumTypes(loaded.tables).size;
  const started = Date.now();

  console.log('db:migrate 开始');
  console.log(`  来源    : ${source}`);
  console.log(`  实例    : ${args.dataDir === undefined ? '内存（进程内，PGlite）' : args.dataDir}`);
  console.log(`  待执行  : ${compiled.plan.length} 条语句（表 ${compiled.tables.length} · 枚举 ${enumCount} · 索引 ${compiled.indexes.length}）`);

  // ★ 两条路径：外部 PostgreSQL（生产）或 PGlite（开发/CI）。
  let db: DdlTarget;
  let close: () => Promise<void>;
  if (args.databaseUrl !== undefined) {
    const { Client } = (await import('pg')) as unknown as typeof import('pg');
    const client = new Client({ connectionString: args.databaseUrl });
    await client.connect();
    db = {
      async exec(sql: string) {
        await client.query(sql);
      },
      async query<T>(sql: string, params?: unknown[]) {
        return (await client.query(sql, params as never)) as unknown as { rows: T[] };
      },
    };
    close = async () => {
      await client.end();
    };
    console.log(`  实例    : 外部 PostgreSQL（连接串已隐藏）`);
  } else {
    const pglite = await openDatabase(args.dataDir === undefined ? {} : { dataDir: args.dataDir });
    db = pglite as unknown as DdlTarget;
    close = async () => {
      await pglite.close();
    };
  }

  // ★ 迁移锁状态：**声明在 try 之外**，因为 `finally` 需要它——
  //   ★ 我第一版声明在 try 内，`finally` 立刻报 `Cannot find name 'lockHeld'`。
  let lockHeld = false;
  try {
    // ★★★★ R119 修复（`docs/10:194` 的修正项）：
    //   > **修正**：迁移前抢 `pg_advisory_lock('migrate')`；未抢到者**等待轮询**迁移完成，
    //   > 而非各自执行。
    //
    //   ★ 此前**完全没有并发保护**：两个实例同时启动 → 都读到 `ag_migrations` 里
    //     「未应用」→ **都执行 DDL** → 并发 DDL 冲突（建表/建索引撞车）。
    //   ★ 注意：**幂等检查本身是对的**（先读 `ag_migrations` 再决定是否执行），
    //     但它**只在「单实例」下成立**——并发时两个实例会同时通过那道检查。
    //
    //   ★ 修法：**在「读 `ag_migrations`」之前拿锁**，于是：
    //     · 抢到者：读 → 未应用 → 执行 → 记录 → 释放；
    //     · 未抢到者：**阻塞等待** → 拿到锁后**重读** → 已应用 → 跳过（正是文档要的语义）。
    //   ★ 用 `pg_advisory_lock`（**阻塞式**）而不是 `pg_try_advisory_lock` + 自旋：
    //     阻塞式由数据库排队，代码更简单，也不会因自旋间隔设置不当而空转。
    //   ★ 锁 key 用 `hashtext('ag-migrate')`——与 `src/db/advisory-lock.ts` 同一手法。
    //     ⚠ 只对**外部 PostgreSQL** 加锁：PGlite 是**进程内单实例**，没有并发可竞争。
    if (args.databaseUrl !== undefined) {
      await db.query('SELECT pg_advisory_lock(hashtext($1))', ['ag-migrate']);
      lockHeld = true;
      console.log('  迁移锁  : 已获取 pg_advisory_lock(ag-migrate)');
    }

    // ★ 迁移元数据表：这是 `serve.ts --mode=real` 启动检查读取的表。
    //   此前**没有任何代码创建它**——于是真实模式永远起不来
    //   （报「数据库中没有迁移记录」），这是一个真实的生产阻塞项。
    await db.exec(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (` +
        `name text PRIMARY KEY, ` +
        `applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const already = await db.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
    const appliedNames = new Set(already.rows.map((row) => row.name));
    const migrationName = '0001_init';
    if (appliedNames.has(migrationName)) {
      console.log(`  迁移记录: ${migrationName} 已应用——本次为幂等重跑，跳过 DDL`);
    }

    const applied = appliedNames.has(migrationName) ? 0 : await applySchema(db, compiled);
    const tables = await listLiveTables(db);
    const elapsed = Date.now() - started;

    console.log('');
    console.log(`db:migrate OK —— 实际创建 ${tables.length} 张表，执行 ${applied} 条语句，耗时 ${elapsed}ms`);
    console.log('  实际表名（按字母序）：');
    for (const name of tables) console.log(`    - ${name}`);

    const declared = loaded.tables.map((t) => t.tableName).sort();
    // ★ 系统表不参与一致性检查：`ag_migrations` 是迁移元数据，不属于业务 schema。
    //   若把它算成 extra，每次迁移都会报「多 1 张表」。
    const SYSTEM_TABLES = new Set([MIGRATIONS_TABLE]);
    const businessTables = tables.filter((name) => !SYSTEM_TABLES.has(name));
    const missing = declared.filter((name) => !businessTables.includes(name));
    const extra = businessTables.filter((name) => !declared.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      console.error(`FAIL: 活库表集合与 IR 不一致（缺 ${missing.length} / 多 ${extra.length}）`);
      if (missing.length > 0) console.error(`  缺: ${missing.join(', ')}`);
      if (extra.length > 0) console.error(`  多: ${extra.join(', ')}`);
      return 1;
    }
    console.log(`  一致性  : IR 声明 ${declared.length} 张 == 活库 ${businessTables.length} 张 ✅（另有系统表 ${SYSTEM_TABLES.size} 张）`);

    if (applied > 0) {
      await db.exec(`INSERT INTO ${MIGRATIONS_TABLE}(name) VALUES ('${migrationName}') ON CONFLICT (name) DO NOTHING`);
      console.log(`  迁移记录: 已写入 ${MIGRATIONS_TABLE}('${migrationName}')`);
    }

    if (loaded.source === 'fixture') {
      console.warn('WARN: 真实声明尚未就绪——本次真跑基于夹具表，不是 M0 验收对象。');
    }
    return 0;
  } catch (error) {
    if (error instanceof DdlApplyError) {
      const { failure } = error;
      console.error('');
      console.error(`FAIL: 第 ${failure.index + 1}/${failure.total} 条语句执行失败`);
      console.error(`  语句类型 : ${failure.statement.kind}`);
      console.error(`  归属表   : ${failure.statement.table ?? '<无>'}`);
      if (failure.statement.enumName !== undefined) {
        console.error(`  枚举类型 : ${failure.statement.enumName}`);
      }
      console.error(`  PG 原始报错: ${failure.pgMessage}`);
      console.error('  语句文本 :');
      console.error(failure.statement.sql.split('\n').map((l) => `    | ${l}`).join('\n'));
      return 1;
    }
    throw error;
  } finally {
    // ★★★ R119：释放迁移锁（在关连接**之前**）——
    //   连接一关锁会随会话自动释放，但**显式释放**让「锁的生命周期」在代码里可见，
    //   也让日志能确认（而不是依赖「连接断开时数据库会清理」这一隐含行为）。
    if (lockHeld) {
      try {
        await db.query('SELECT pg_advisory_unlock_all()');
      } catch {
        // 连接已断时忽略：锁会随会话结束自动释放
      }
    }
    // ★ 用分支时确定的 close（PGlite 与 pg.Client 的关闭方式不同）
    await close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
