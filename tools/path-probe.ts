/**
 * 路径覆盖探针（生产落地：事务边界的**系统性**排查）
 *
 * ★ 为什么需要它：本会话已**四次**撞到「事务外查询」
 *   （`Scheduler` · `Patrol` 的 subject 处理 · `SessionService` · 巡检的
 *   `#buildPatrol` 与分页取数）。每次都是「碰巧在某个路径上发现」。
 *
 *   而根因是同一个：**任何由外部注入的回调都可能落在事务外**，
 *   而 `Db.query` 有 `assertInTransaction` 断言。
 *   与其逐个碰运气，不如**一次性把主要路径都跑一遍**，看哪些会炸。
 *
 * ★ 方法：真实 PG + `--mode=real` 启动 → 用引导令牌换会话 →
 *   依次请求所有主要端点 → 对每个响应记录状态码，
 *   并从服务端日志里抓 `TransactionRequiredError`（那是「事务外查询」的特征串）。
 *
 * ★ 它能发现的：**当前注册的路由**在真实 PG 下是否会因事务边界而失败。
 *   它不能发现的：定时任务路径（那由 `tools/patrol-liveness.ts` 覆盖）。
 *
 * 用法：
 *   node --experimental-strip-types tools/path-probe.ts
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRealPostgres } from './pg-real.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8895;
const BASE = `http://127.0.0.1:${PORT}`;

/** 探针清单：路径 + 期望（`ok` = 2xx/3xx；`auth` = 401/403 也算「路径正常」）。 */
interface Probe {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** 未登录时的期望状态（用于区分「路由不存在」与「需要登录」） */
  expect: 'ok' | 'auth';
  note: string;
  /**
   * ★★ **契约检查**：断言响应体里关键字段的存在与类型。
   *
   * 为什么需要：本会话多次出现「**返回 200 但内容是错的**」——
   *   · 插件列表硬编码（与数据库无关）；
   *   · `total` 语义从「精确总数」变成「至少这么多」；
   *   · 内存实现与 PG 实现的 id 形态不一致。
   *   这些**都不会**产生非 2xx 状态码，只验状态码的探针**看不见**它们。
   *
   * 路径用点号表示（如 `users`、`plugin.status`、`capabilities.siteUiVisible`）。
   */
  contract?: readonly { path: string; type: 'array' | 'string' | 'number' | 'boolean' | 'object' | 'null' }[];
  /**
   * 响应体格式（默认 `json`）。
   *
   * ★ 为什么需要这个字段：加「非法 JSON 也算违约」后，`/metrics` 立刻被判违约——
   *   但 Prometheus 指标**本来就是文本格式**，是**我的检查太严格**，
   *   不是产品缺陷。★ 又一次印证：扩大检查范围会先抓到检查者自己。
   */
  bodyFormat?: 'json' | 'text';
  /**
   * 该端点的成功响应**允许**含完整密钥。
   *
   * ★ 只有「创建/轮换密钥」这类端点才应设置它——密钥**只在那一刻返回一次**，
   *   这是设计意图，不是泄露。
   *   ★ 若不设此标志，「正向验证密钥确实返回」与「扫描泄露」会互相矛盾：
   *     前者要求响应含 `secret`，后者把它判为泄露（我确实撞上了这个矛盾）。
   */
  allowsSecret?: boolean;
}

/**
 * ★★ 自动推导的探针（**从路由表生成，避免手工清单漂移**）。
 *
 * 为什么需要：R30 的探针清单是**手工维护**的——我在 R22–R30 写了 6 个管理端点，
 * 却忘了把它们加进清单，于是那 6 条路径**从未被动态验证**，
 * 而它们当时**全部返回 500**（嵌套事务）。手工清单的盲区就是这么来的。
 *
 * 规则：从 `src/http/routes.ts` 与 `src/admin/api.ts` 提取已挂载的路由，
 * 把 `:param` 替换成探针用的具体值，生成「只验状态码」的探针。
 * 期望值统一为 `ok`（2xx/3xx/4xx 都算「路由存在」——我们只想知道**有没有 5xx**）。
 */
async function deriveProbes(): Promise<Probe[]> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const routesSource = await readFile(path.join(root, 'src', 'http', 'routes.ts'), 'utf8');

  /** 参数占位值：这些是**探测用**的具体值，不要求真实存在。 */
  const placeholder = (name: string): string => {
    if (name === 'id' || name === 'eid' || name === 'uid' || name === 'tid') return 'probe-id';
    if (name === 'ref') return 'platform%3Aenduser';
    if (name === 'code') return 'edu';
    if (name === 'permission') return 'llm:invoke';
    if (name === 'scope') return 'backend';
    return 'probe';
  };

  const probes: Probe[] = [];
  for (const match of routesSource.matchAll(/mount\('([A-Z]+)',\s*'([^']+)'\)/g)) {
    const [, method, template] = match;
    // ★ 只探 GET/POST（PUT/DELETE 有副作用；GET 无副作用，POST 在本探针里都带空 body）
    if (method !== 'GET' && method !== 'POST') continue;
    const concrete = template!.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_all, name: string) => placeholder(name));
    probes.push({
      path: concrete,
      ...(method === 'POST' ? { method: 'POST' as const, body: {} } : {}),
      expect: 'ok',
      note: `自动推导（路由表 ${method} ${template}）`,
    });
  }
  return probes;
}

const PROBES: Probe[] = [
  { path: '/healthz', expect: 'ok', note: '健康检查' },
  { path: '/healthz/ready', expect: 'ok', note: '就绪探测（会查迁移记录与作业状态）' },
  { path: '/healthz/live', expect: 'ok', note: '存活探测' },
  // ★ Prometheus 文本格式，不是 JSON——显式标注，避免被「必须合法 JSON」误判
  { path: '/metrics', expect: 'ok', note: '指标（Prometheus 文本格式）', bodyFormat: 'text' },
  { path: '/.well-known/openid-configuration', expect: 'ok', note: 'OIDC 发现文档' },
  { path: '/oauth/jwks.json', expect: 'ok', note: 'OIDC 公钥集' },
  { path: '/api/verify/v1/jwks', expect: 'ok', note: '协同验证公钥集' },
  { path: '/api/me', expect: 'auth', note: '当前主体 + CSRF' },
  { path: '/auth/oidc/platform%3Adeveloper/start', expect: 'auth', note: '★ docs/06 §6.0 声明的联邦登录入口（此前未实现）' },
  { path: '/api/me/eligibility', expect: 'ok', note: '★ 我的资格（用户侧视图，走策略与事实）' },
  { path: '/api/me/selection/developers', expect: 'ok', note: '两级选择：第一级' },
  { path: '/api/console/sections/admin.plugins/access', expect: 'ok', note: '分区准入探针' },
  { path: '/api/admin/subjects', expect: 'ok', note: '管理端：主体列表' },
  { path: '/api/admin/policies', expect: 'ok', note: '管理端：策略列表' },
  { path: '/api/admin/policies/edu/versions', expect: 'ok', note: '管理端：策略版本历史（此前**未挂载**，返回 404）' },
  { path: '/api/admin/simulate', method: 'POST', body: { subject: {} }, expect: 'ok', note: '管理端：试算（此前**未挂载**）' },
  { path: '/api/admin/policies/edu/rollback', method: 'POST', body: { version: 1 }, expect: 'ok', note: '★ 管理端：回滚（此前**未挂载**——M6-2 的核心能力）' },
  // ★★ R30 新增：这些端点在 R22–R28 写过，但 `serve.ts` **没注入依赖** →
  //   真实服务里全部 404。加进探针后，这类「忘了接线」会被自动发现。
  {
    path: '/api/admin/users',
    expect: 'ok',
    note: '用户管理：列表',
    contract: [
      { path: 'users', type: 'array' },
      // ★ `hasMore` 是 R26 引入的字段——若它消失，说明分页语义被改回去了
      { path: 'hasMore', type: 'boolean' },
      { path: 'totalIsExact', type: 'boolean' },
    ],
  },
  {
    // ★★ 验证「密钥只在创建时返回一次」的**完整闭环**：
    //   ① 创建响应**必须含** `secret`（否则调用方拿不到密钥，功能不可用）；
    //   ② 创建响应**必须含** `warning`（提醒只显示一次）；
    //   ③ 随后请求**列表**，断言**不含**密钥（由 `scanSensitive` 的 value 形态扫描覆盖）。
    //   ★ 只验 ③ 是不够的——如果创建时也不返回密钥，功能其实是坏的，
    //     而「没有泄露」的检查会**照样通过**。这是「反向检查通过 ≠ 正向功能可用」。
    path: '/api/admin/verify/clients',
    method: 'POST',
    body: { name: '探针创建的调用方', scopes: ['assert:read'] },
    expect: 'ok',
    // ★★ 正向验证「密钥确实返回一次」：
    //   ① 契约要求 `secret` 与 `warning` 存在（否则功能其实是坏的）；
    //   ② `allowsSecret` 让泄露扫描**豁免本端点**（返回密钥是设计意图）；
    //   ③ 紧随其后的**列表**探针（无豁免）断言密钥不在列表里。
    //   ★ 只验 ③ 不够：若创建时也不返回密钥，功能是坏的，而「无泄露」照样通过。
    //   ★ 修正一处我自己的误判：最初这里得到 403，我归因于「会话非 admin」，
    //     实际是**缺 CSRF token**（错误信息里写得很清楚）。取到 token 后返回 200。
    note: '★ 协同验证：创建调用方（正向验证密钥返回 + 豁免泄露扫描）',
    allowsSecret: true,
    contract: [
      { path: 'client.clientId', type: 'string' },
      { path: 'secret', type: 'string' },
      { path: 'warning', type: 'string' },
    ],
  },
  {
    path: '/api/admin/verify/clients',
    expect: 'ok',
    note: '协同验证：调用方列表',
    contract: [
      { path: 'clients', type: 'array' },
      { path: 'inactive', type: 'array' },
    ],
  },
  {
    path: '/api/admin/verify/assertions',
    expect: 'ok',
    note: '协同验证：断言流水',
    contract: [
      { path: 'assertions', type: 'array' },
      { path: 'hasMore', type: 'boolean' },
    ],
  },
  {
    path: '/api/admin/plugins',
    expect: 'ok',
    note: '插件列表（★ 契约：必须是数组 + 危险状态告警字段）',
    contract: [
      { path: 'plugins', type: 'array' },
      { path: 'untrustedEnabled', type: 'array' },
    ],
  },
  { path: '/api/admin/plugins/demo/grants', expect: 'ok', note: '插件：权限授予（插件不存在时 404，无契约）' },
  { path: '/api/admin/plugins/demo/endpoints', expect: 'ok', note: '插件：端点清单' },
  { path: '/api/admin/plugins/demo/config', expect: 'ok', note: '插件：配置' },
  {
    path: '/api/admin/settings/platform',
    expect: 'ok',
    note: '平台设置（★ 契约：模式 + 能力矩阵 + 锁定状态）',
    contract: [
      { path: 'mode', type: 'string' },
      { path: 'capabilities', type: 'object' },
      { path: 'lockedByEnv', type: 'boolean' },
    ],
  },
  {
    path: '/api/console/sections',
    expect: 'ok',
    note: '控制台导航（★ 契约：分区是数组）',
    contract: [{ path: 'sections', type: 'array' }],
  },
  {
    // ★ 真实字段是 `nav`/`pages`/`slots`（我最初猜成 `contributions`——
    //   错误的契约**意外地**暴露了该端点的静默降级，见 console-routes.ts 的说明）
    path: '/api/ui/manifest',
    expect: 'ok',
    note: 'UI 贡献清单（契约：nav/pages/slots 数组 + hostAvailable 标志）',
    contract: [
      { path: 'nav', type: 'array' },
      { path: 'pages', type: 'array' },
      { path: 'slots', type: 'array' },
      // ★ 契约要求「宿主是否接入」必须**显式可判**——
      //   这样「配置缺失」就不会伪装成「没有贡献」
      { path: 'hostAvailable', type: 'boolean' },
    ],
  },
];

interface ProbeResult {
  probe: Probe;
  status: number;
  /** 响应体里是否含事务错误特征串 */
  transactionalError: boolean;
  detail: string;
  /** ★ 契约违约（响应 2xx 但结构不符合期望） */
  contractViolations: string[];
}

/**
 * 响应检查（**纯函数**，便于 `--self-test` 直接验证）。
 *
 * 两类检查：
 *   · **2xx**：契约（关键字段存在且类型正确）——抓「200 但内容错」；
 *   · **4xx**：错误结构（必须有非空字符串 `error`）——抓「错误被通用处理器吞掉」。
 */
function checkResponse(probe: Probe, status: number, text: string): string[] {
  const violations: string[] = [];
  if (text.length === 0) return violations;
  // ★ 声明为文本格式的端点（如 Prometheus `/metrics`）不做 JSON 契约检查
  if (probe.bodyFormat === 'text') return violations;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // 2xx 的非法 JSON 说明契约无从校验；4xx 的非法 JSON 让调用方无法解析错误
    if (status >= 200 && status < 300) violations.push('响应不是合法 JSON');
    else if (status >= 400 && status < 500) violations.push('4xx 响应不是合法 JSON（调用方无法解析错误）');
    return violations;
  }
  if (typeof parsed !== 'object' || parsed === null) return violations;

  // ① 2xx：契约
  if (status >= 200 && status < 300 && probe.contract !== undefined) {
    for (const clause of probe.contract) {
      let cursor: unknown = parsed;
      for (const segment of clause.path.split('.')) {
        cursor = typeof cursor === 'object' && cursor !== null ? (cursor as Record<string, unknown>)[segment] : undefined;
      }
      const actualType = cursor === null ? 'null' : Array.isArray(cursor) ? 'array' : typeof cursor;
      if (actualType !== clause.type) {
        violations.push(`契约违约：\`${clause.path}\` 期望 ${clause.type}，实际 ${actualType}`);
      }
    }
  }

  // ② 4xx：错误结构必须可操作
  if (status >= 400 && status < 500) {
    const errorField = (parsed as Record<string, unknown>)['error'];
    if (typeof errorField !== 'string' || errorField.length === 0) {
      violations.push(`4xx 响应缺少非空字符串 \`error\` 字段（实际 ${JSON.stringify(parsed).slice(0, 80)}）——调用方拿不到可操作信息`);
    }
  }
  return violations;
}

/**
 * 敏感字段扫描（**纯函数**，同样有自测）。
 *
 * ★★ 为什么需要：本会话有几处设计是「**密钥只在创建时返回一次、之后任何接口都取不到**」
 *   （协同验证调用方密钥、`ag_secrets` 的加密存储）。
 *   这些设计**只能靠「扫描响应里没有密钥」来验证**——
 *   看代码注释不足以证明，因为一个 `...record` 展开就可能把哈希带出去。
 *
 * ★ 扫描两类：
 *   ① **敏感字段名**（`secretHash` / `password` / `ciphertext` / `authTag` / `codeVerifier` …）
 *      —— 出现在 JSON 的 **key** 位置；
 *   ② **密钥形态的字符串**（`vc_` 前缀 + 长随机串）——出现在 **value** 位置。
 *
 * ★ 刻意**不报** `secretPrefix`：它只含前 10 个字符，是**刻意设计用于识别**的字段
 *   （见 `client-admin.ts` 的说明）。误报会让人去「消数字」而不是修问题。
 */
const SENSITIVE_KEYS = [
  'secretHash',
  'secret_hash',
  'password',
  'passwordHash',
  'password_hash',
  'ciphertext',
  'authTag',
  'auth_tag',
  'codeVerifier',
  'code_verifier',
  'masterKey',
  'privateKey',
  'sessionToken',
];

export function scanSensitive(status: number, text: string, allowSecret = false): string[] {
  // 只扫成功响应的**主体**（错误响应里提到字段名是解释性的，不是泄露）
  if (status < 200 || status >= 300 || text.length === 0) return [];
  const findings: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // 非 JSON（如 /metrics 文本）：只做形态扫描
    parsed = undefined;
  }

  if (parsed !== undefined) {
    // ① key 名扫描（递归）
    const walk = (node: unknown, trail: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${trail}[${index}]`));
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (SENSITIVE_KEYS.includes(key)) {
          findings.push(`响应含敏感字段 \`${trail}${trail.length > 0 ? '.' : ''}${key}\` —— 该字段不应出现在任何接口响应里`);
        }
        walk(value, `${trail}${trail.length > 0 ? '.' : ''}${key}`);
      }
    };
    walk(parsed, '');
  }

  // ② value 形态扫描：`vc_` + 长随机串（调用方密钥）；★ 不报 `secretPrefix`（只有 10 字符）
  //   ★ 创建/轮换端点**豁免**——那里返回密钥是设计意图（`allowsSecret`）。
  if (!allowSecret) {
    for (const match of text.matchAll(/"(vc_[A-Za-z0-9_-]{25,})"/g)) {
      findings.push(`响应含疑似完整密钥（前缀 vc_，长度 ${match[1]!.length}）——密钥只应在创建响应里出现一次`);
    }
  }
  return findings;
}

/**
 * 自测：**证明检查函数不是恒真**。
 *
 * ★ 为什么必须有：我第一次尝试自测时，改的是一条**没被探到**的路径，
 *   于是「检查没报错」被我误读为「检查正常」——**自测本身需要被验证**。
 *   这里直接对纯函数喂入「应当被检出」的输入，断言它确实检出。
 */
function selfTest(): number {
  const probe: Probe = {
    path: '/x',
    expect: 'ok',
    note: 'selftest',
    contract: [{ path: 'items', type: 'array' }],
  };
  const cases: { name: string; status: number; text: string; shouldDetect: boolean }[] = [
    // ① 契约违约（2xx 但字段缺失）
    { name: '2xx 缺字段', status: 200, text: '{"other":1}', shouldDetect: true },
    // ② 契约违约（类型错）
    { name: '2xx 字段类型错', status: 200, text: '{"items":"不是数组"}', shouldDetect: true },
    // ③ 4xx 缺 error 字段
    { name: '4xx 缺 error', status: 400, text: '{"hint":"没有 error 字段"}', shouldDetect: true },
    // ④ 4xx error 是空串
    { name: '4xx error 为空串', status: 404, text: '{"error":""}', shouldDetect: true },
    // ⑤ 4xx 不是 JSON
    { name: '4xx 非 JSON', status: 400, text: 'plain text', shouldDetect: true },
    // ⑥ 正常：2xx 契约满足
    { name: '2xx 契约满足', status: 200, text: '{"items":[]}', shouldDetect: false },
    // ⑦ 正常：4xx 带 error
    { name: '4xx 带 error', status: 403, text: '{"error":"无权限"}', shouldDetect: false },
    // ⑧ 正常：5xx 不做这两类检查（它有自己的路径）
    { name: '5xx 不检查', status: 500, text: '{"whatever":1}', shouldDetect: false },
  ];
  let failures = 0;
  for (const testCase of cases) {
    const detected = checkResponse(probe, testCase.status, testCase.text).length > 0;
    const ok = detected === testCase.shouldDetect;
    process.stdout.write(`  ${ok ? '✅' : '❌'} ${testCase.name}：${detected ? '检出' : '未检出'}（期望${testCase.shouldDetect ? '检出' : '不检出'}）\n`);
    if (!ok) failures += 1;
  }
  // ★ 敏感字段扫描的自测
  const sensitiveCases: { name: string; status: number; text: string; shouldDetect: boolean }[] = [
    { name: '成功响应含 secretHash', status: 200, text: '{"client":{"secretHash":"abc"}}', shouldDetect: true },
    { name: '成功响应含 password', status: 200, text: '{"user":{"password":"x"}}', shouldDetect: true },
    { name: '成功响应含嵌套 ciphertext', status: 200, text: '{"a":{"b":{"ciphertext":"x"}}}', shouldDetect: true },
    { name: '成功响应含完整 vc_ 密钥', status: 200, text: `{"secret":"vc_${'a'.repeat(40)}"}`, shouldDetect: true },
    { name: '★ secretPrefix 不算泄露（刻意设计）', status: 200, text: '{"client":{"secretPrefix":"vc_abcdef"}}', shouldDetect: false },
    { name: '错误响应提到字段名不算泄露', status: 400, text: '{"error":"secretHash 不该被传"}', shouldDetect: false },
    { name: '正常响应', status: 200, text: '{"users":[],"hasMore":false}', shouldDetect: false },
  ];
  for (const testCase of sensitiveCases) {
    const detected = scanSensitive(testCase.status, testCase.text).length > 0;
    const ok = detected === testCase.shouldDetect;
    process.stdout.write(`  ${ok ? '✅' : '❌'} [敏感字段] ${testCase.name}：${detected ? '检出' : '未检出'}（期望${testCase.shouldDetect ? '检出' : '不检出'}）\n`);
    if (!ok) failures += 1;
  }
  const total = cases.length + sensitiveCases.length;

  process.stdout.write(`\n自测结果：${total - failures}/${total} ${failures === 0 ? '通过——检查函数确实能检出问题' : '**失败——检查函数不可信**'}\n`);
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  // ★ 自测模式：不需要 PG，直接验证检查函数（证明它不是恒真）
  if (process.argv.includes('--self-test')) {
    process.stdout.write('\n【探针检查函数自测】\n\n');
    process.exitCode = selfTest();
    return;
  }

  process.stdout.write('\n【路径覆盖探针（真实 PG）】\n\n');

  const instance = await startRealPostgres({ fresh: true });
  let child: ChildProcess | undefined;
  try {
    const migrate = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.join(ROOT, 'tools', 'db-migrate.ts'), `--database-url=${instance.url}`],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (migrate.status !== 0) throw new Error(`迁移失败：${(migrate.stderr ?? '').slice(-400)}`);

    child = spawn(
      process.execPath,
      ['--experimental-strip-types', path.join(ROOT, 'tools', 'serve.ts'), '--mode=real', `--port=${PORT}`, '--log-level=info'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          AG_MODE: 'real',
          AG_DATABASE_URL: instance.url,
          AG_PUBLIC_URL: BASE,
          AG_OIDC_ISSUER: 'https://idp.invalid',
          AG_OIDC_CLIENT_ID: 'probe',
          AG_OIDC_REDIRECT_URI: `${BASE}/api/auth/callback`,
          AG_SECURE_COOKIES: '1',
          // ★ 真实模式必需：调用方密钥要加密存入 `ag_secrets`
          AG_MASTER_KEY: '0'.repeat(64),
          AG_ALLOW_DEMO: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', () => {
      /* 只看 stdout 的结构化日志 */
    });

    // 等 ready
    const deadline = Date.now() + 40_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        ready = (await fetch(`${BASE}/healthz/ready`, { signal: AbortSignal.timeout(2000) })).status === 200;
      } catch {
        /* 未就绪 */
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('40s 内未就绪');

    // 换会话 cookie
    const tokenMatch = /\/api\/auth\/bootstrap\?token=([A-Za-z0-9_-]+)/.exec(stdout);
    let cookie = '';
    if (tokenMatch !== null) {
      const login = await fetch(`${BASE}${tokenMatch[0]}`, { redirect: 'manual' });
      cookie = (login.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
    }
    process.stdout.write(`会话 cookie：${cookie.length > 0 ? `${cookie.length} 字节` : '（未取到，将只测匿名路径）'}\n`);

    // ★★★ 取 CSRF token：**不取它，所有写操作都会 403**
    //   （我最初把 403 误判为「会话不是 admin」，实际是 CSRF 保护在正常工作。
    //   ★ 这正是「看到 403 就归因于权限」的想当然——错误信息里写得很清楚。）
    let csrfToken = '';
    if (cookie.length > 0) {
      try {
        const me = await fetch(`${BASE}/api/me`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
        const meBody = (await me.json()) as { csrfToken?: string };
        csrfToken = meBody.csrfToken ?? '';
      } catch {
        /* 取不到则退化为只测读操作 */
      }
    }
    process.stdout.write(`CSRF token：${csrfToken.length > 0 ? '已获取' : '（未取到，写操作会被 403 拒绝）'}\n\n`);

    // ★★ 手工清单（带说明与期望）+ 自动推导（只验「无 5xx」）
    //   ★ 先检查手工清单**内部**是否有重复——我加契约时就重复加过一次
    //     `/api/ui/manifest`，而当时的去重逻辑只对比「手工 vs 自动」，漏掉了这种。
    const seenManual = new Map<string, number>();
    for (const probe of PROBES) {
      const key = `${probe.method ?? 'GET'} ${probe.path}`;
      seenManual.set(key, (seenManual.get(key) ?? 0) + 1);
    }
    const duplicated = [...seenManual.entries()].filter(([, count]) => count > 1);
    if (duplicated.length > 0) {
      process.stdout.write(`⚠️  手工探针清单里有重复：${duplicated.map(([key]) => key).join(', ')}\n\n`);
    }

    const autoProbes = await deriveProbes();
    const manualPaths = new Set(PROBES.map((probe) => `${probe.method ?? 'GET'} ${probe.path}`));
    const allProbes: Probe[] = [
      ...PROBES,
      // 去重：手工清单里已有的不再自动加（保留更精确的期望与说明）
      ...autoProbes.filter((probe) => !manualPaths.has(`${probe.method ?? 'GET'} ${probe.path}`)),
    ];
    process.stdout.write(`探针来源：手工 ${PROBES.length} 条 + 自动推导 ${allProbes.length - PROBES.length} 条\n\n`);

    // ══════════ ★★★ 写操作副作用验证（写后读一致）══════════
    //
    //   ★ 为什么需要：仅验「写操作返回 2xx」是不够的——
    //     一个接口可能返回 200 却什么都没写（或写到别处）。
    //     本会话已有多次「接口存在但内容不对」的教训（插件列表硬编码、
    //     `/api/ui/manifest` 静默返回空清单）。
    //   ★ 因此这里做**跨请求**验证：写一次 → 读一次 → 断言新数据出现。
    let sideEffectLine = '（跳过：无 CSRF token 或写探针未成功）';
    if (csrfToken.length > 0 && cookie.length > 0) {
      const name = `探针副作用验证-${Date.now()}`;
      const post = await fetch(`${BASE}/api/admin/verify/clients`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken, connection: 'close' },
        body: JSON.stringify({ name, scopes: ['assert:read'] }),
        signal: AbortSignal.timeout(10_000),
      });
      const created = (await post.json()) as { client?: { clientId?: string }; secret?: string };
      const clientId = created.client?.clientId ?? '';
      // ★ 读回：列表里必须能找到它（**这才是「写成功了」的证据**）
      const list = await fetch(`${BASE}/api/admin/verify/clients`, {
        headers: { cookie, connection: 'close' },
        signal: AbortSignal.timeout(10_000),
      });
      const listText = await list.text();
      const appeared = clientId.length > 0 && listText.includes(clientId);

      // ★★★ 不止「出现」，还要「**值正确**」：
      //   上一轮我只断言「新数据出现」——那能抓到「没写入」，但抓不到「写入了错的值」
      //   （如 name 被截断、scopes 被忽略、status 写成了别的）。
      //   这里把 POST 的入参与本条记录在列表里的**字段值**逐项比对。
      const listBody = (() => {
        try {
          return JSON.parse(listText) as { clients?: { clientId: string; name: string; scopes: string[]; status: string }[] };
        } catch {
          return { clients: undefined };
        }
      })();
      const found = listBody.clients?.find((entry) => entry.clientId === clientId);
      // ★ 每项给「正面 / 负面」两个标签——只写正面标签会让失败行读起来自相矛盾
      //   （我第一次自测时输出「❌ 字段值不正确：name 与入参一致（…）」，读起来像在说「一致」）。
      const valueChecks: { positive: string; negative: string; ok: boolean; detail: string }[] = [];
      if (found !== undefined) {
        valueChecks.push({
          positive: 'name 与入参一致',
          negative: 'name 与入参**不一致**',
          ok: found.name === name,
          detail: `入参 '${name}' vs 读回 '${found.name}'`,
        });
        valueChecks.push({
          positive: 'scopes 与入参一致',
          negative: 'scopes 与入参**不一致**',
          ok: Array.isArray(found.scopes) && found.scopes.length === 1 && found.scopes[0] === 'assert:read',
          detail: `入参 ['assert:read'] vs 读回 ${JSON.stringify(found.scopes)}`,
        });
        valueChecks.push({
          positive: 'status 为 active',
          negative: 'status **不是** active',
          ok: found.status === 'active',
          detail: `读回 '${found.status}'`,
        });
      }
      const valueFailures = valueChecks.filter((check) => !check.ok);
      const valueLine =
        found === undefined
          ? '（未取到该记录，无法校验字段值）'
          : valueFailures.length === 0
            ? `✅ 字段值正确：${valueChecks.map((check) => check.positive).join(' · ')}`
            : `❌ **字段值不正确**：${valueFailures.map((check) => `${check.negative}（${check.detail}）`).join('；')}`;

      sideEffectLine = appeared
        ? `✅ 写后读一致：创建的调用方（${clientId}）出现在列表里\n       ${valueLine}`
        : `❌ **写后读不一致**：POST 返回 ${post.status}，但 ${clientId || '（未返回 clientId）'} 未出现在列表里`;
      // ★ 同时断言：列表里**不含**刚创建的密钥（正向写过之后的反向验证）
      if (appeared && created.secret !== undefined && listText.includes(created.secret)) {
        sideEffectLine += '\n        ❌ 且**列表泄露了刚创建的密钥**';
      }
    }
    process.stdout.write(`\n【写操作副作用验证】\n${sideEffectLine}\n`);

    // 逐个探针
    const results: ProbeResult[] = [];
    for (const probe of allProbes) {
      const logLengthBefore = stdout.length;
      let status = 0;
      let text = '';
      try {
        const response = await fetch(`${BASE}${probe.path}`, {
          method: probe.method ?? 'GET',
          headers: {
            ...(cookie.length > 0 ? { cookie } : {}),
            ...(probe.body === undefined ? {} : { 'content-type': 'application/json' }),
            // ★ 写操作必须带 CSRF token，否则 403（服务端的保护是正确的）
            ...(csrfToken.length > 0 ? { 'x-csrf-token': csrfToken } : {}),
            connection: 'close',
          },
          ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        status = response.status;
        text = await response.text();
      } catch (error) {
        status = -1;
        text = error instanceof Error ? error.message : String(error);
      }
      // 该请求期间新增的日志里是否含事务错误
      const newLog = stdout.slice(logLengthBefore);
      // ★ 检测串必须同时覆盖**英文类名**与**中文错误信息**。
      //   早期只找 `TransactionRequiredError`，而服务端日志里是
      //   「拒绝在事务外执行 query」——于是**漏检**，把两个 500 漏报成「无事务错误」。
      //   （这是本会话第四次「检查工具自身有 bug 而误报/漏报」。）
      const TRANSACTIONAL_MARKERS = ['TransactionRequiredError', '拒绝在事务外执行 query'];
      const transactionalError = TRANSACTIONAL_MARKERS.some((marker) => newLog.includes(marker) || text.includes(marker));
      const detail = transactionalError
        ? `★ ${newLog.split('\n').find((line) => line.includes('TransactionRequiredError'))?.slice(0, 160) ?? text.slice(0, 160)}`
        : text.slice(0, 90).replace(/\s+/g, ' ');
      // ★ 5xx 时把服务端日志里的错误也带出来（否则只有状态码，无法定位）
      const errorLine = status >= 500 && !transactionalError
        ? newLog.split('\n').filter((line) => line.includes('"level":"error"')).slice(-1)[0] ?? ''
        : '';
      const contractViolations = [
        ...checkResponse(probe, status, text),
        ...scanSensitive(status, text, probe.allowsSecret === true),
      ];
      const finalDetail = errorLine.length > 0 ? `★ ${errorLine.slice(0, 240)}` : detail;
      results.push({ probe, status, transactionalError, detail: finalDetail, contractViolations });
      const violated = contractViolations.length > 0;
      process.stdout.write(
        `${transactionalError || violated ? '❌' : '  '} ${String(status).padStart(3)}  ${probe.path.padEnd(46)} ${probe.note}\n` +
          (transactionalError || status >= 500 || status === 403 ? `        ${finalDetail}\n` : '') +
          (violated ? contractViolations.map((entry) => `        ${entry}\n`).join('') : ''),
      );
    }

    // ── 判定 ──
    const transactional = results.filter((result) => result.transactionalError);
    const violated = results.filter((result) => result.contractViolations.length > 0);
    const notFound = results.filter((result) => result.status === 404);
    const serverErrors = results.filter((result) => result.status >= 500 && !result.transactionalError);

    process.stdout.write(`\n${'='.repeat(72)}\n`);
    process.stdout.write(`探针总数：${results.length}\n`);
    process.stdout.write(`✅ 无事务错误：${results.length - transactional.length}\n`);
    process.stdout.write(
      `✅ 契约符合（含错误结构）：${results.length - violated.length}${violated.length > 0 ? `（违约 ${violated.length}）` : ''}\n`,
    );
    if (transactional.length > 0) {
      process.stdout.write(`❌ **事务外查询**（${transactional.length} 条路径）：\n`);
      for (const result of transactional) process.stdout.write(`   - ${result.probe.path}（${result.probe.note}）\n`);
    }
    if (notFound.length > 0) {
      process.stdout.write(`⚠️  404（路由未挂载或路径写错）：${notFound.map((result) => result.probe.path).join(', ')}\n`);
    }
    if (serverErrors.length > 0) {
      process.stdout.write(`⚠️  5xx（非事务原因）：${serverErrors.map((result) => `${result.probe.path}=${result.status}`).join(', ')}\n`);
    }
    process.stdout.write(
      `\n★ 覆盖限制（**必须与结论一起读**）：\n` +
        `  · 写操作**已带 CSRF token**（此前缺 token 导致全部 403，被我误判为权限问题）——\n` +
        `    但仍只验证「状态码 + 契约」，**不验证业务副作用**（如数据真的写入了）。\n` +
        `  · 写操作的正向行为由单元测试覆盖（如 \`test/verify-client-admin.test.ts\`\n` +
        `    直接调 handler 并断言 \`secret\` 与 \`warning\` 存在）。\n` +
        `  · 定时任务路径由 \`tools/patrol-liveness.ts\` 覆盖。\n` +
        `  · 未被这些工具覆盖的路径仍可能存在同类问题。\n`,
    );
    if (transactional.length > 0 || violated.length > 0) process.exitCode = 1;
  } finally {
    if (child !== undefined) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await instance.stop();
  }
}

await main();
