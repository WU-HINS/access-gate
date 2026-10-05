#!/usr/bin/env node
/**
 * tools/pg-real.ts —— 启动一个**真实的多会话 PostgreSQL**（M6/判据 #2 的验证基建）。
 *
 * ★ 为什么必须是真的多会话 PG，而不是 pglite：
 *   本项目有三处**只有在多会话下才成立**的语义，pglite（单连接嵌入式）无法验证：
 *     1. `pg_advisory_lock` 的双实例抢占（同一 key 只有一个会话能拿到锁）；
 *     2. `DbJobStore.tryAcquire` 的条件更新租约（两个并发会话只有一个能取到）；
 *     3. 连接池下 `SET LOCAL` / 事务隔离的真实行为。
 *   「在 pglite 上跑通」不等于「生产可用的并发语义成立」——这正是本文件存在的理由。
 *
 * 实现方式：用 `embedded-postgres` 提供的 PG 18 二进制，但**自己拉起进程**
 *   （而不是用它的 Node API），因为它的 API 拒绝以 root 运行，而本环境没有可登录的非 root 账户；
 *   我们自己通过 `setpriv` 降权到 `appuser` 再启动。
 *
 * 用法（作为模块）：
 *   const pg = await startRealPostgres();      // 启动并等就绪
 *   const url = pg.url;                        // postgres://... 连接串
 *   await pg.stop();
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * ★ 二进制路径必须**不含空格**：本工作区路径含空格（`/workspace/newapi 429`），
 *   而 `LD_LIBRARY_PATH` 以冒号分隔、不接受含空格的路径（会被 shell/加载器切断）。
 *   因此启动前把 PG native 目录复制到一个无空格的临时路径。
 */
const PG_STAGE = process.env['AG_PG_STAGE'] ?? '/tmp/agpg/native';
const PG_NATIVE = PG_STAGE;
const PG_BIN = join(PG_NATIVE, 'bin');
/** PG 二进制依赖同目录下的 .so（libpq 等）——必须显式设置，否则 initdb 报 cannot open shared object */
const PG_ENV: Record<string, string> = {
  LD_LIBRARY_PATH: `${join(PG_NATIVE, 'lib')}${process.env['LD_LIBRARY_PATH'] === undefined ? '' : `:${process.env['LD_LIBRARY_PATH']}`}`,
};
/**
 * 运行 PG 的非 root 用户。
 *
 * ★★ 为什么需要「确保存在」而不只是读一个名字：
 *   PostgreSQL **拒绝以 root 运行**，因此必须降权。
 *   早期实现只写死 `'appuser'` 并假定环境里有这个用户——
 *   而那个**依赖从未被声明**：容器/环境一变（`appuser` 消失）就报
 *   `setpriv: failed to parse reuid: 'appuser'`，**真实 PG 验证整体不可用**。
 *
 *   现在：优先用 `AG_PG_USER`；否则依次尝试 `appuser` / `postgres` / `nobody`；
 *   若都不存在且当前是 root，则**创建** `appuser`（幂等）。
 *   全部失败时抛出**可操作**的错误（说明如何指定 `AG_PG_USER`）。
 */
function resolveRunAsUser(): { name: string; uid: number; gid: number } | undefined {
  // ★★ **不是 root 时必须不降权**（GitHub Actions 上暴露的真实缺陷）：
  //   非 root 进程执行 `setpriv --reuid=…` 会报
  //   `setpriv: setresuid failed: Operation not permitted`（EPERM —— 本来就没有权限改 uid），
  //   于是 `initdb` 直接失败，CI 里表现为「门禁 10 真实 PG 集成」与
  //   「依赖真实 PG 的单测（pg-real / serve-real）」**一起红**。
  //   ★ 这是 CI 与开发机**行为分叉**的典型：开发机常以 root 跑（降权必要），
  //     GitHub runner 以 `runner` 跑（降权既无必要、也无权限）。
  //   ★ 所以判据是**运行时身份**，而不是环境假设。
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!isRoot) {
    // ★ 显式要求了 `AG_PG_USER` 却又不具备改 uid 的权限 —— 这是**配置错误**，
    //   不能静默忽略（否则"我明明指定了 PG 用户，怎么没生效"会变成说不清的现象）。
    const explicit = process.env['AG_PG_USER'];
    if (explicit !== undefined && explicit.trim().length > 0) {
      const uidText = typeof process.getuid === 'function' ? String(process.getuid()) : '未知';
      throw new Error(
        `设置了 AG_PG_USER='${explicit}'，但当前进程**不是 root**（uid=${uidText}），无法降权到该用户（setpriv 需要 root）。` +
          `解决：要么以 root 运行（此时降权才有意义），要么**不要**设 AG_PG_USER（非 root 下直接以当前身份运行 PG 即可）。`,
      );
    }
    // 非 root：PG 不会拒绝当前身份 → 直接以本身份运行（`run()` 对 `user === undefined` 不包 setpriv）
    return undefined;
  }

  const requested = process.env['AG_PG_USER'];
  // ★ 必须用 **uid/gid 数字**而不是用户名/组名：
  //   `setpriv --regid=nobody` 会失败，因为 `nobody` 的主组叫 **nogroup**
  //   （用户与组不同名是常见情况）。用数字则与命名无关。
  const lookup = (name: string): { name: string; uid: number; gid: number } | undefined => {
    const uid = spawnSync('id', ['-u', name], { encoding: 'utf8' });
    const gid = spawnSync('id', ['-g', name], { encoding: 'utf8' });
    if (uid.status !== 0 || gid.status !== 0) return undefined;
    const uidValue = Number.parseInt((uid.stdout ?? '').trim(), 10);
    const gidValue = Number.parseInt((gid.stdout ?? '').trim(), 10);
    if (!Number.isInteger(uidValue) || !Number.isInteger(gidValue)) return undefined;
    return { name, uid: uidValue, gid: gidValue };
  };

  if (requested !== undefined) {
    const found = lookup(requested);
    if (found !== undefined) return found;
    throw new Error(
      `AG_PG_USER='${requested}' 不存在。真实 PG 需要非 root 用户（PG 拒绝以 root 运行）。` +
        `请创建该用户，或设 AG_PG_USER 为一个已存在的非 root 用户。`,
    );
  }

  for (const candidate of ['appuser', 'postgres', 'nobody']) {
    const found = lookup(candidate);
    if (found !== undefined) return found;
  }
  throw new Error(
    '找不到可用的非 root 用户（尝试过 appuser / postgres / nobody）。' +
      '真实 PG 拒绝以 root 运行；请设 AG_PG_USER 指定一个已存在的非 root 用户。',
  );
}

const RUN_AS_USER = resolveRunAsUser();
/** 退出清理只注册一次（同一进程可能多次调用 startRealPostgres） */
let registeredCleanup = false;

export interface RealPostgres {
  url: string;
  port: number;
  dataDir: string;
  socketDir: string;
  /** 执行一条 SQL 并返回结果（用 `pg` 客户端——生产同款驱动） */
  sql<T = Record<string, unknown>>(statement: string, params?: unknown[], database?: string): Promise<T[]>;
  /** 建表（执行给定的 DDL 全文） */
  exec(ddl: string): Promise<void>;
  stop(): Promise<void>;
}

/** 降权目标（用数字，与用户/组命名无关）。 */
type RunAsUser = { name: string; uid: number; gid: number };

function run(command: string, args: string[], options: { user?: RunAsUser; env?: Record<string, string> } = {}): { status: number; stdout: string; stderr: string } {
  // ★ 用 **uid/gid 数字**降权（`options.user` 现在是 `{name, uid, gid}`）
  const argv =
    options.user === undefined
      ? [command, ...args]
      : ['setpriv', `--reuid=${options.user.uid}`, `--regid=${options.user.gid}`, '--clear-groups', command, ...args];
  const result = spawnSync(argv[0]!, argv.slice(1), {
    encoding: 'utf8',
    env: { ...process.env, ...PG_ENV, ...(options.env ?? {}) },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runAsync(command: string, args: string[], options: { user?: RunAsUser } = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // ★ 用 **uid/gid 数字**降权（`options.user` 现在是 `{name, uid, gid}`）
  const argv =
    options.user === undefined
      ? [command, ...args]
      : ['setpriv', `--reuid=${options.user.uid}`, `--regid=${options.user.gid}`, '--clear-groups', command, ...args];
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...PG_ENV } });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} 退出码 ${code}：${stderr.slice(-500)}`));
    });
  });
}

/**
 * 启动（或复用一个已在跑的）真实 PG。
 *
 * ★ **按进程隔离数据目录与端口**：`node --test` 会**并行**跑多个测试文件，
 *   若它们共用同一个数据目录并各自 `fresh:true`，就会互相 `rmSync` 掉对方的
 *   数据目录，表现为 `pg_ctl: directory ... is not a database cluster directory`
 *   ——而且是**间歇性**的（取决于调度顺序），极难排查。
 *   因此默认路径含 `process.pid`，端口按 pid 派生（同一进程内复用同一实例）。
 */
export async function startRealPostgres(options: { port?: number; dataDir?: string; fresh?: boolean } = {}): Promise<RealPostgres> {
  const port = options.port ?? 55432 + (process.pid % 1000);
  const dataDir = options.dataDir ?? `/tmp/ag-pg-real-${process.pid}/data`;
  const socketDir = `/tmp/ag-pg-real-${process.pid}/sock`;

  const bundle = join(ROOT, 'node_modules', '@embedded-postgres', 'linux-x64', 'native');

  // ★★ 启动前自检：`initdb` **必须可执行**。
  //   否则 setpriv 会报 `Permission denied`，而**依赖真实 PG 的测试会静默 skip**——
  //   「26 个 skip、0 个 fail」看起来像绿灯，实际是**真实 PG 验证全部失效**。
  //   ★ 这里主动检查并尝试修复，把「静默跳过」变成「显式可见」。
  const existingInitdb = join(PG_BIN, 'initdb');
  if (existsSync(existingInitdb)) {
    const probe = spawnSync('test', ['-x', existingInitdb], { encoding: 'utf8' });
    if (probe.status !== 0) {
      spawnSync('chmod', ['-R', 'u+x', join(PG_STAGE, 'bin')], { encoding: 'utf8' });
      const recheck = spawnSync('test', ['-x', existingInitdb], { encoding: 'utf8' });
      if (recheck.status !== 0) {
        throw new Error(
          `PG 二进制不可执行：${existingInitdb}（已尝试 chmod 仍失败）。` +
            `★ 若不修复，所有依赖真实 PG 的测试会**静默 skip**——` +
            `「0 fail」不代表「真实 PG 验证通过」。请检查挂载选项或文件权限。`,
        );
      }
    }
  }
  if (!existsSync(join(bundle, 'bin', 'initdb'))) {
    throw new Error(`找不到 PostgreSQL 二进制：${bundle}。请先运行 npm i -D embedded-postgres`);
  }
  // 复制到无空格路径。
  //
  // ★ 必须**原子**：`node --test` 会并行跑多个测试文件（各自独立进程），
  //   它们同时检查/复制同一个共享路径会互相破坏（表现为间歇性的
  //   「initdb 失败 / directory is not a database cluster directory」）。
  //   做法：先复制到 pid 唯一的临时目录，再 `rename`（原子）。
  //   rename 若因目标已存在而失败，说明别的进程已经装好了——直接用它。
  if (!existsSync(join(PG_BIN, 'initdb'))) {
    mkdirSync(dirname(PG_STAGE), { recursive: true });
    const staging = `${PG_STAGE}.tmp-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    // ★ 用 `-a`（archive：保留权限/时间戳/符号链接）而不是 `-r`——
    //   执行位丢失会让 `initdb` 报 `Permission denied`，而**测试只会静默跳过**（skip）。
    //   ★ 本会话真实踩到过：环境切换后 `/tmp/agpg/native/bin/initdb` 变成 `-rw-r--r--`，
    //     26 个真实 PG 测试全部 skip，而 `npm test` 仍显示「fail 0」——
    //     **「跳过」看起来像「通过」**，这正是最危险的失败模式。
    const copy = spawnSync('cp', ['-a', bundle, staging], { encoding: 'utf8' });
    if (copy.status !== 0) throw new Error(`复制 PG 二进制失败：${copy.stderr}`);
    // ★ 兜底：无论复制方式如何，确保 bin 目录可执行
    spawnSync('chmod', ['-R', 'u+x', join(staging, 'bin')], { encoding: 'utf8' });
    try {
      renameSync(staging, PG_STAGE);
    } catch {
      // 竞争失败：另一个进程已装好，丢弃自己的临时副本
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(join(PG_BIN, 'initdb'))) {
        throw new Error(`PG 二进制未能就绪（并发复制失败）：${PG_STAGE}`);
      }
    }
  }
  if (options.fresh === true) rmSync(dirname(dataDir), { recursive: true, force: true });
  mkdirSync(socketDir, { recursive: true, mode: 0o777 });
  mkdirSync('/tmp', { recursive: true });

  // 数据目录必须属于运行 PG 的用户
  //   ★ 只有**降权**场景才需要 chown（root 建目录 → 把属主交给 PG 用户）；
  //     非 root 时目录本就是自己的，chown 既无必要、也无权限。
  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    mkdirSync(dataDir, { recursive: true });
    // ★ 用 uid:gid 数字：把对象直接放进模板串会得到 '[object Object]'（经典 bug）
    if (RUN_AS_USER !== undefined) {
      run('chown', ['-R', `${RUN_AS_USER.uid}:${RUN_AS_USER.gid}`, dirname(dataDir)]);
    }
    const init = run(join(PG_BIN, 'initdb'), ['-D', dataDir, '-U', 'accessgate', '--auth=trust', '--encoding=UTF8'], {
      user: RUN_AS_USER,
    });
    if (init.status !== 0) throw new Error(`initdb 失败：${init.stderr.slice(-500)}`);
  }
  if (RUN_AS_USER !== undefined) {
    run('chown', ['-R', `${RUN_AS_USER.uid}:${RUN_AS_USER.gid}`, dataDir]);
  }

  // 启动（-k 指定 unix socket 目录，避免 /var/run 权限问题）
  await runAsync(
    join(PG_BIN, 'pg_ctl'),
    [
      '-D',
      dataDir,
      '-o',
      `-p ${port} -k ${socketDir} -c listen_addresses=127.0.0.1 -c max_connections=100`,
      '-w',
      '-l',
      `/tmp/ag-pg-real-${process.pid}/pg.log`,
      'start',
    ],
    { user: RUN_AS_USER },
  );

  const url = `postgres://accessgate@127.0.0.1:${port}/accessgate`;

  // ★ 用 `pg` 客户端（生产同款驱动）而不是 psql：embedded-postgres 的 native 目录
  //   并不包含 psql 客户端程序。
  const { Client } = await import('pg');

  const withClient = async <T>(database: string, fn: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> => {
    const client = new Client({ host: '127.0.0.1', port, user: 'accessgate', database, connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };

  const api: RealPostgres = {
    url,
    port,
    dataDir,
    socketDir,
    async sql<T = Record<string, unknown>>(statement: string, params: unknown[] = [], database = 'accessgate'): Promise<T[]> {
      return withClient(database, async (client) => {
        const result = await client.query(statement, params);
        return result.rows as T[];
      });
    },
    async exec(ddl: string): Promise<void> {
      await withClient('accessgate', async (client) => {
        await client.query(ddl);
      });
    },
    async stop(): Promise<void> {
      await runAsync(join(PG_BIN, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { user: RUN_AS_USER });
      // ★ 停库后删除数据目录，避免 62MB/次 的永久残留（见文件末尾 exit 钩子的说明）。
      //   再次调用 startRealPostgres() 时因 PG_VERSION 不存在会自动重新 initdb，行为自洽。
      if (process.env['AG_KEEP_PG'] !== '1') rmSync(dirname(dataDir), { recursive: true, force: true });
    },
  };

  // ★ 注册退出钩子：进程退出时**同步**停掉 PG。
  //
  //   为什么必需：`node --test` 会并行跑多个测试文件，每个文件各起一个 PG 实例；
  //   若不清理，反复运行会累积出**几十上百个** postgres 进程，
  //   最终耗尽内存与进程表——表现为「全量测试莫名超时」。
  //   本轮真实踩到：累积 70 个残留实例导致测试 600 秒超时。
  //   （调试时可设 `AG_KEEP_PG=1` 保留实例。）
  if (process.env['AG_KEEP_PG'] !== '1' && !registeredCleanup) {
    registeredCleanup = true;
    /**
     * 清理（同步，只做「读 postmaster.pid + SIGKILL」）。
     *
     * ★ 用 SIGKILL 而不是 `pg_ctl stop`：pg_ctl 依赖数据目录完整与权限，
     *   在退出阶段可能失败（实测会残留）；直接杀 PID 最可靠
     *   （PG 崩溃恢复能处理 SIGKILL 后的重启）。
     */
    const cleanup = (): void => {
      try {
        const pidFile = join(dataDir, 'postmaster.pid');
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // 已退出
            }
          }
        }
      } catch {
        // 退出阶段不抛错
      }
      // ★ 退出时删除数据目录：此前只杀 postmaster，62MB 数据目录永久残留。
      //   实测 946 次运行累积 46GB，把根分区从 23% 顶到 71%。
      //   （调试时同样受 AG_KEEP_PG=1 保护——本函数只在未设该变量时注册。）
      try {
        rmSync(dirname(dataDir), { recursive: true, force: true });
      } catch {
        // 退出阶段不抛错
      }
    };
    process.once('exit', cleanup);
    // ★★ 必须同时接管 SIGTERM / SIGINT。
    //   `process.on('exit')` **在进程被信号杀死时不会触发** ——
    //   而 `timeout NNN node …` 正是用 SIGTERM 结束进程。
    //   本会话真实踩到：一个 PG 实例因超时被杀而**泄漏了 65 分钟**（9 个进程）。
    //   这里清理后显式退出（退出码沿用惯例：128+信号号）。
    const onSignal = (signal: NodeJS.Signals, code: number): void => {
      cleanup();
      process.exit(code);
    };
    process.once('SIGTERM', () => onSignal('SIGTERM', 143));
    process.once('SIGINT', () => onSignal('SIGINT', 130));
  }

  // 建库（幂等）
  const existing = await withClient('postgres', async (client) => {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = 'accessgate'");
    return result.rowCount ?? 0;
  });
  if (existing === 0) {
    await withClient('postgres', async (client) => {
      await client.query('CREATE DATABASE accessgate');
    });
  }

  return api;
}

/** CLI：`node tools/pg-real.ts start|stop|status`（供 CI 与本地手动使用）。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('pg-real.ts')) {
  const action = process.argv[2] ?? 'start';
  if (action === 'start') {
    const pg = await startRealPostgres({ fresh: process.argv.includes('--fresh') });
    process.stdout.write(`真实 PostgreSQL 已启动\n  URL: ${pg.url}\n  数据目录: ${pg.dataDir}\n`);
  } else if (action === 'stop') {
    const pg = await startRealPostgres({});
    await pg.stop();
    process.stdout.write('已停止\n');
  } else {
    process.stdout.write('用法：node tools/pg-real.ts start [--fresh] | stop\n');
  }
}
