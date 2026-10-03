#!/usr/bin/env node
/**
 * tools/security-audit.ts —— **可执行**的安全自查清单（M6-8）。
 *
 * ★ 为什么把自查做成脚本而不是一份 Markdown 清单：
 *   清单会被读一次然后腐烂。本项目已经有 20 个 ADR 与 15 份文档，
 *   再加一份「安全自查表」只会变成第 16 份没人维护的文档。
 *   做成脚本后，每一项都有**可复跑的断言**，CI 里能拦住回退。
 *
 * 覆盖（对应 docs/07 M6-8 的清单）：
 *   ① 越权：站点作用域注入是否覆盖所有站点表（复用 R1–R6 门禁）
 *   ② SSRF：出站白名单、内网地址拒绝、协议限制
 *   ③ 注入：裸 SQL 扫描 + 参数化断言
 *   ④ 密钥：日志脱敏、Cookie 属性、CSRF、验签算法白名单
 *   ⑤ 会话：token 只存哈希、失效可区分
 *
 * 用法：`node --experimental-strip-types tools/security-audit.ts`（非零退出 = 有高危项）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkScopeRules } from '../src/schema/gate/scope.ts';
import { normalizeTables } from '../src/schema/normalize.ts';
import { allTables } from '../src/schema/tables/index.ts';
import { isSensitiveKey, redact } from '../src/kernel/logger.ts';
import { buildSetCookie, SESSION_COOKIE } from '../src/auth/session.ts';
import { assertOidcConfigUsable, OidcError } from '../src/auth/oidc.ts';
import { permissionSetOf } from '../src/plugin/host-api.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { scanRawSql } from '../src/schema/compile/ci-checks.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Severity = 'high' | 'medium' | 'info';
interface Finding {
  area: string;
  check: string;
  severity: Severity;
  ok: boolean;
  detail: string;
}

const findings: Finding[] = [];
const record = (finding: Finding): void => void findings.push(finding);

// ─────────────────────────── ① 越权：站点作用域 ───────────────────────────

const tables = normalizeTables(allTables);
const violations = checkScopeRules(tables);
const errors = violations.filter((v) => v.severity === 'error');
record({
  area: '越权',
  check: '所有站点表都有可执行的隔离约束（R1–R6 派生门禁）',
  severity: 'high',
  ok: errors.length === 0,
  detail: errors.length === 0 ? `${tables.length} 张表全部通过` : `${errors.length} 条违规：${errors.map((v) => `${v.tableName}(${v.rule})`).join(', ')}`,
});

// 站点表的唯一键必须含 site_id（否则跨站点静默污染）
const missingSiteKey = tables.filter(
  (t) =>
    t.columns.some((c) => c.columnName === 'site_id') &&
    t.indexes.some((i) => i.unique && i.columns[0] !== 'site_id') &&
    !t.dualScoped,
);
record({
  area: '越权',
  check: '站点表唯一键以 site_id 开头（防跨站点静默覆盖）',
  severity: 'high',
  ok: missingSiteKey.length === 0,
  detail: missingSiteKey.length === 0 ? '全部合规' : missingSiteKey.map((t) => t.tableName).join(', '),
});

// ─────────────────────────── ② SSRF ───────────────────────────

const egressManifest = validateManifest({
  apiVersion: 'gate.plugin/v1',
  kind: 'channel',
  id: 'ssrf-probe',
  name: 'SSRF 探针',
  version: '1.0.0',
  runtime: 'declarative',
  permissions: ['http:egress:api.example.com'],
  collect: { request: { method: 'GET', url: 'https://api.example.com/x' }, extract: [{ path: '$.a', as: 'a' }] },
  factSchema: { type: 'object', properties: { a: { type: 'string' } } },
});
const permissions = permissionSetOf(egressManifest);
const ssrfCases: [string, boolean][] = [
  ['api.example.com', true],
  ['uploads.api.example.com', true],
  ['evil.com', false],
  ['api.example.com.evil.com', false],
  ['127.0.0.1', false],
  ['169.254.169.254', false], // 云元数据地址
  ['localhost', false],
];
const ssrfFailures = ssrfCases.filter(([host, expected]) => permissions.canEgress(host) !== expected);
record({
  area: 'SSRF',
  check: '出站白名单：只允许声明域名及其子域，拒绝内网/元数据地址',
  severity: 'high',
  ok: ssrfFailures.length === 0,
  detail: ssrfFailures.length === 0 ? `${ssrfCases.length} 个用例全部符合预期` : `不符合：${ssrfFailures.map(([h]) => h).join(', ')}`,
});

// 协议限制（在 HostApi.request 内，用源码断言其存在）
const hostApiSource = readFileSync(join(ROOT, 'src/plugin/host-api.ts'), 'utf8');
record({
  area: 'SSRF',
  check: '出站只允许 http(s) 协议（拒绝 file:// / gopher:// 等）',
  severity: 'high',
  ok: /url\.protocol !== 'https:' && url\.protocol !== 'http:'/.test(hostApiSource),
  detail: '在 HostApi.request 内显式校验协议',
});
record({
  area: 'SSRF',
  check: '出站响应体有体积上限（防插件拉爆宿主内存）',
  severity: 'medium',
  ok: /maxResponseBytes/.test(hostApiSource),
  detail: 'maxResponseBytes 上限检查',
});

// ─────────────────────────── ③ 注入 ───────────────────────────

const srcFiles = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.ts'));
const sqlBuilders = new Set(['src/schema/compile/ddl.ts', 'src/schema/compile/drift.ts', 'src/query/compile.ts']);
const rawSqlHits = srcFiles
  .map((file) => relative(ROOT, file))
  .filter((rel) => !sqlBuilders.has(rel))
  .flatMap((rel) => scanRawSql(readFileSync(join(ROOT, rel), 'utf8'), rel));
record({
  area: '注入',
  check: '业务代码无裸 SQL 拼接（值一律走 $n 参数）',
  severity: 'high',
  ok: rawSqlHits.length === 0,
  detail: rawSqlHits.length === 0 ? `扫描 ${srcFiles.length} 个文件，0 命中` : rawSqlHits.map((h) => `${h.file}:${h.line}`).join(', '),
});

// ─────────────────────────── ④ 密钥与会话 ───────────────────────────

const secretProbe = {
  password: 'p',
  clientSecret: 's',
  accessToken: 't',
  authorization: 'a',
  privateKey: 'k',
  ciphertext: 'c',
  masterKey: 'm',
  apiKey: 'x',
  pluginId: 'safe',
};
const redacted = redact(secretProbe) as Record<string, unknown>;
const leaked = Object.entries(redacted).filter(([k, v]) => isSensitiveKey(k) && v !== '[REDACTED]');
record({
  area: '密钥',
  check: '日志写入前统一脱敏（含 privateKey/ciphertext/masterKey）',
  severity: 'high',
  ok: leaked.length === 0,
  detail: leaked.length === 0 ? `${Object.keys(secretProbe).length} 个字段全部按预期处理` : `泄漏：${leaked.map(([k]) => k).join(', ')}`,
});

const cookie = buildSetCookie(SESSION_COOKIE, 'tok', { secure: true });
record({
  area: '会话',
  check: '会话 Cookie 具备 HttpOnly + SameSite + Secure（生产）',
  severity: 'high',
  ok: /HttpOnly/.test(cookie) && /SameSite=/.test(cookie) && /Secure/.test(cookie),
  detail: cookie.replace(/tok/, '***'),
});

const sessionSource = readFileSync(join(ROOT, 'src/auth/session.ts'), 'utf8');
record({
  area: '会话',
  check: '会话 token 只存哈希（明文不入库）',
  severity: 'high',
  ok: /tokenHash/.test(sessionSource) && /createHash\('sha256'\)/.test(sessionSource),
  detail: 'tokenHash + sha256',
});
record({
  area: '会话',
  check: 'CSRF 采用双提交校验且用常量时间比较',
  severity: 'medium',
  ok: /verifyCsrf/.test(sessionSource) && /timingSafeEqual/.test(sessionSource),
  detail: 'verifyCsrf + timingSafeEqual',
});

// 验签算法白名单
let algorithmGuardOk = false;
try {
  assertOidcConfigUsable({
    issuer: 'https://idp.example',
    clientId: 'c',
    redirectUri: 'https://x/cb',
    allowedAlgorithms: ['none'],
  });
} catch (error) {
  algorithmGuardOk = error instanceof OidcError;
}
record({
  area: '密钥',
  check: 'OIDC 拒绝 none / HS* 签名算法（否则验签形同虚设）',
  severity: 'high',
  ok: algorithmGuardOk,
  detail: 'assertOidcConfigUsable 拒绝不安全算法',
});

// 密钥不落明文：检查 OIDC 私钥列是密文列
const keyTable = tables.find((t) => t.tableName === 'ag_oidc_signing_keys');
record({
  area: '密钥',
  check: 'OIDC 私钥以密文 + IV + authTag 存储（不落明文）',
  severity: 'high',
  ok:
    keyTable !== undefined &&
    ['private_ciphertext', 'private_iv', 'private_auth_tag'].every((c) => keyTable.columns.some((col) => col.columnName === c)),
  detail: 'private_ciphertext / private_iv / private_auth_tag',
});

// ─────────────────────────── 汇总 ───────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const high = findings.filter((f) => f.severity === 'high' && !f.ok);
const medium = findings.filter((f) => f.severity === 'medium' && !f.ok);

process.stdout.write('═══ access-gate 安全自查（可执行清单）═══\n\n');
for (const area of ['越权', 'SSRF', '注入', '密钥', '会话']) {
  const group = findings.filter((f) => f.area === area);
  if (group.length === 0) continue;
  process.stdout.write(`【${area}】\n`);
  for (const finding of group) {
    process.stdout.write(`  ${finding.ok ? '✅' : finding.severity === 'high' ? '❌' : '⚠️'} ${finding.check}\n`);
    process.stdout.write(`      ${finding.detail}\n`);
  }
  process.stdout.write('\n');
}
process.stdout.write(`结论：${findings.length} 项检查，高危未通过 ${high.length} 项，中危未通过 ${medium.length} 项\n`);

if (high.length > 0) process.exit(1);
