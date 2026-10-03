/**
 * 容器化前置检查（生产落地第 2 项的**可执行部分**）。
 *
 * ★ 诚实性说明：本脚本**不能**替代 `docker build` / `docker compose up`——
 *   它只做**静态验证**。之所以存在，是因为：
 *
 *   1. 当前环境**没有 Docker**（未安装、daemon 不可用、无 podman），
 *      容器化无法真实执行；假装「跑通了」比不跑更糟。
 *   2. 从未被构建过的 Dockerfile **几乎必然腐烂**——本脚本已抓到两处真实问题
 *      （`package-lock.json` 未 COPY、`.dockerignore` 缺失）。
 *   3. 静态检查可在 CI 里常驻，防止 Dockerfile 再次腐烂。
 *
 * ★ 它能验证的：
 *   - Dockerfile 的每条 `COPY` 源**是否存在**（不存在的源会让 build 直接失败）；
 *   - 是否 COPY 了 lock 文件并使用 `npm ci`（**可复现构建**的前提）；
 *   - `.dockerignore` 是否存在（否则整个工作目录含 node_modules 会被送进构建上下文）；
 *   - `CMD` 的参数是否被 `tools/serve.ts` 真正接受（参数名写错会让容器起来即退出）；
 *   - compose 的服务依赖、健康检查、卷声明是否齐备。
 *
 * ★ 它**不能**验证的（因此第 2 项在有无 Docker 的环境里状态不同）：
 *   镜像能否构建成功、容器能否启动、健康检查能否通过、
 *   **数据卷在容器重建后是否真的保留数据**——这些必须真实执行。
 *
 * 用法：
 *   node --experimental-strip-types tools/docker-preflight.ts
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** 无法在本环境验证的项（与「失败」区分开） */
  unverifiable?: boolean;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string, unverifiable = false): void {
  checks.push({ name, ok, detail, ...(unverifiable ? { unverifiable: true } : {}) });
  const mark = unverifiable ? '⚠️ ' : ok ? '✅' : '❌';
  process.stdout.write(`${mark} ${name}\n     ${detail}\n`);
}

/** 解析 Dockerfile 里所有 `COPY src... dest` 的源（跳过多阶段标志）。 */
function copySources(dockerfile: string): { sources: string[]; usesCi: boolean; copiesLock: boolean } {
  const sources: string[] = [];
  let usesCi = false;
  let copiesLock = false;
  for (const rawLine of dockerfile.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    if (/\bnpm\s+ci\b/.test(line)) usesCi = true;
    if (!/^COPY\s/.test(line)) continue;
    const parts = line
      .replace(/^COPY\s+/, '')
      .split(/\s+/)
      .filter((part) => !part.startsWith('--'));
    // 最后一个是目标，其余是源
    const sourceParts = parts.slice(0, -1);
    for (const source of sourceParts) {
      const clean = source.replace(/^\.\//, '');
      sources.push(clean);
      if (clean.includes('package-lock.json')) copiesLock = true;
    }
  }
  return { sources, usesCi, copiesLock };
}

async function main(): Promise<void> {
  process.stdout.write('\n【容器化前置检查（静态）】\n\n');

  // ── Dockerfile ──
  const dockerfile = await readFile(path.join(ROOT, 'Dockerfile'), 'utf8');
  const { sources, usesCi, copiesLock } = copySources(dockerfile);

  // ① 每条 COPY 源是否存在（不存在的源会让 build 直接失败）
  const missing: string[] = [];
  for (const source of sources) {
    try {
      await stat(path.join(ROOT, source));
    } catch {
      missing.push(source);
    }
  }
  record(
    '① Dockerfile 的 COPY 源全部存在',
    missing.length === 0,
    missing.length === 0 ? `检查了 ${sources.length} 个源：${[...new Set(sources)].join(', ')}` : `缺失：${missing.join(', ')}（build 会直接失败）`,
  );

  // ② 可复现构建：必须 COPY lock 文件且用 npm ci
  record(
    '② 可复现构建（COPY lock + `npm ci`）',
    usesCi && copiesLock,
    usesCi && copiesLock
      ? 'COPY 了 package-lock.json 且使用 `npm ci`'
      : `usesCi=${usesCi} copiesLock=${copiesLock}——用 \`npm install\` 会**重新解析**传递依赖，同一份 package.json 在不同时间可能装到不同版本`,
  );

  // ③ .dockerignore 存在
  try {
    const ignore = await readFile(path.join(ROOT, '.dockerignore'), 'utf8');
    const hasNodeModules = /^node_modules$/m.test(ignore);
    record(
      '③ `.dockerignore` 存在且排除 node_modules',
      hasNodeModules,
      hasNodeModules ? '已排除 node_modules（否则每次 build 都要把数百 MB 送给 daemon）' : '.dockerignore 存在但未排除 node_modules',
    );
  } catch {
    record('③ `.dockerignore` 存在', false, '缺失——整个工作目录（含 node_modules / .git / .env）都会进入构建上下文');
  }

  // ④ CMD 的参数是否被 serve.ts 接受
  const cmdMatch = /CMD\s+\[([^\]]+)\]/.exec(dockerfile);
  const cmdArgs = cmdMatch === null ? [] : [...cmdMatch[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  // ★ 只取**脚本文件之后**的参数：`node --experimental-strip-types tools/serve.ts --demo=false`
  //   里前两个 flag 属于 node 本身，不是 serve.ts 的选项。
  //   （这个检查脚本最初把 `--experimental-strip-types` 当成 serve.ts 的 flag 而误报。）
  const scriptIndex = cmdArgs.findIndex((arg) => arg.endsWith('.ts'));
  const scriptArgs = scriptIndex === -1 ? [] : cmdArgs.slice(scriptIndex + 1);
  const flags = scriptArgs.filter((arg) => arg.startsWith('--'));
  const serveSource = await readFile(path.join(ROOT, 'tools', 'serve.ts'), 'utf8');
  const unknownFlags = flags.filter((flag) => {
    const name = flag.split('=')[0]!.replace(/^--/, '');
    // parseArgs 的选项名形如 `'log-level': {` 或 `port: {`
    return !new RegExp(`['"]?${name.replace(/[-]/g, '\\-')}['"]?\\s*:`).test(serveSource);
  });
  record(
    '④ CMD 的参数被 `serve.ts` 接受',
    unknownFlags.length === 0,
    unknownFlags.length === 0
      ? `CMD = ${cmdArgs.join(' ')}；其中 flag：${flags.join(', ') || '（无）'} 均在 serve.ts 的 parseArgs 中声明`
      : `未知 flag：${unknownFlags.join(', ')}——容器会起来即退出（parseArgs 抛错）`,
  );

  // ⑤ compose 的关键声明
  const compose = await readFile(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  const composeChecks: { name: string; ok: boolean; detail: string }[] = [
    {
      name: 'depends_on 带 condition: service_healthy',
      ok: /condition:\s*service_healthy/.test(compose),
      detail: '仅保证启动顺序不保证就绪；带 condition 才能真正等到 DB 健康',
    },
    { name: 'db 有 healthcheck', ok: /pg_isready/.test(compose), detail: '用 pg_isready 处理「服务器正在启动中」的中间态' },
    { name: 'app 的 healthcheck 用 readiness', ok: /healthz\/ready/.test(compose), detail: '容器「活着」不代表「能服务」' },
    { name: 'db 数据卷已声明', ok: /ag-db-data:\/var\/lib\/postgresql\/data/.test(compose), detail: '卷是「容器重建后数据仍在」的前提' },
    { name: 'stop_grace_period 已设置', ok: /stop_grace_period/.test(compose), detail: '必须 > 应用的优雅关闭总超时，否则会被 SIGKILL' },
    { name: 'db 端口只绑回环', ok: /127\.0\.0\.1:5432:5432/.test(compose), detail: '生产不应把数据库暴露到公网' },
  ];
  for (const check of composeChecks) record(`⑤ compose：${check.name}`, check.ok, check.detail);

  // ★★★ ⑥ **运行时要求 vs 部署配置**的一致性检查。
  //
  //   为什么需要：R31 我给真实模式加了「必须有 AG_MASTER_KEY」的强制要求，
  //   却**忘了同步 docker-compose.yml** → `docker compose up` 会**启动即失败**。
  //   ★ 本文件的其他检查**都发现不了它**——它们只查 compose 自身的静态正确性，
  //     不查「compose 与运行时代码的要求是否一致」。
  //   这是「静态检查通过 ≠ 部署能起来」的典型：静态 10/10 而 compose up 必失败。
  {
    const composePath = path.join(ROOT, 'docker-compose.yml');
    if (existsSync(composePath)) {
      const compose = readFileSync(composePath, 'utf8');
      const serveSource = readFileSync(path.join(ROOT, 'tools', 'serve.ts'), 'utf8');
      // 提取「真实模式**强制要求**」的变量。
      //
      // ★★ 演进过程（三轮，每轮都是自测逼出来的）：
      //   ① 「`process.env['AG_X']` 之后 300 字符内有 `throw`」→ 一个都没匹配到
      //      （实际代码里两者隔十几行）→ 检查**恒真**；
      //   ② 放宽到 2000 字符 → 匹配到了，但**误报** `AG_PLATFORM_MODE`
      //      （它是**可选**的：设置则标记 locked_by_env，不设置用默认）；
      //   ③ **变量追踪**：先找 `const X = process.env['AG_Y']`，
      //      再要求 `X` 在某处参与 `=== undefined` 判断且附近有 `throw`——
      //      这与「这个变量缺失会导致启动失败」的语义一致。
      const required = new Set<string>();
      for (const match of serveSource.matchAll(/(?:const|let)\s+(\w+)\s*=\s*process\.env\['(AG_[A-Z_]+)'\]/g)) {
        const variable = match[1]!;
        const envName = match[2]!;
        const tail = serveSource.slice(match.index, match.index + 2000);
        // ★ 必须出现「该变量 === undefined」的判断（这才是「缺失即失败」的语义）
        if (!new RegExp(`${variable}\\s*===\\s*undefined`).test(tail)) continue;
        if (!tail.includes('throw new Error(')) continue;
        required.add(envName);
      }
      if (required.size === 0) {
        // ★ 检查自身不可信时必须报出来，而不是「0 个必需变量 → 通过」
        record('⑥ 部署一致性：compose 声明了真实模式强制要求的环境变量', false, '★ 检查自身失效：未能从 serve.ts 提取到任何必需变量——请修正提取逻辑');
      } else {
        const missing = [...required].filter((name) => !compose.includes(name));
        record(
          '⑥ 部署一致性：compose 声明了真实模式强制要求的环境变量',
          missing.length === 0,
          missing.length === 0
            ? `${required.size} 个必需变量都已声明（${[...required].join(', ')}）`
            : `★ 缺少：${missing.join(', ')} —— \`docker compose up\` 会启动即失败`,
        );
      }
    }
  }

  // ── 不可验证项（如实标注） ──
  process.stdout.write('\n');
  for (const name of [
    'docker build 成功',
    'docker compose up 启动',
    '容器健康检查通过',
    '优雅启停（SIGTERM 被正确处理）',
    '★ 数据卷在容器重建后仍保留数据',
  ]) {
    record(name, false, '本环境无 Docker（未安装 / daemon 不可用 / 无 podman）——必须真实执行，不能由静态检查替代', true);
  }

  const failed = checks.filter((check) => !check.ok && check.unverifiable !== true);
  const unverifiable = checks.filter((check) => check.unverifiable === true);
  process.stdout.write(`${'='.repeat(64)}\n`);
  process.stdout.write(`静态检查：${checks.length - failed.length - unverifiable.length}/${checks.length - unverifiable.length} 通过\n`);
  process.stdout.write(`无法在本环境验证：${unverifiable.length} 项（见上，均为容器化真实执行）\n`);
  if (failed.length > 0) {
    process.stdout.write(`未通过：\n${failed.map((check) => `  - ${check.name}：${check.detail}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

await main();
