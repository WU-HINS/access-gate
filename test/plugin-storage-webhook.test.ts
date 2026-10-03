/**
 * 插件存储分级（M4-4）与 declarative webhook（M4-7）验收。
 *
 * 两条验收标准（docs/07 原文）：
 *   - M4-4：**「清空 `runtime/` 后重启能自动恢复」** + 「内置插件在无 DB 时仍可用」
 *   - M4-7：**「纯 YAML 插件可接收外部推送并产出 fact」**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  availableWithoutDatabase,
  fingerprintOf,
  InMemoryRuntimeCache,
  planPluginLoad,
  PluginPackageError,
  restoreRuntimeCache,
  type PluginPackageRecord,
} from '../src/plugin/storage-tiers.ts';
import {
  canRegisterEndpoint,
  declarativeWebhooksOf,
  lookupPath,
  receiveDeclarativeWebhook,
  RUNTIME_ENDPOINT_CAPABILITY,
  validateDeclarativeWebhook,
  type DeclarativeWebhookSpec,
} from '../src/plugin/declarative-webhook.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

// ═══════════════════════════ M4-4 存储分级 ═══════════════════════════

const BUILTIN_CONTENT = 'builtin:checkin:v1';
const DB_CONTENT = 'db:community-plugin:v2';

function recordOf(overrides: Partial<PluginPackageRecord> = {}): PluginPackageRecord {
  return { pluginId: 'p', version: '1.0.0', ...overrides };
}

test('★ M4-4：`runtime/` 只是缓存 —— **清空后能从 DB 自动恢复**', async () => {
  const cache = new InMemoryRuntimeCache();
  const records: PluginPackageRecord[] = [
    recordOf({
      pluginId: 'community',
      db: { kind: 'db', content: DB_CONTENT, fingerprint: fingerprintOf(DB_CONTENT) },
    }),
  ];

  // 模拟「清空前」：缓存已有正确内容
  await cache.write('community', DB_CONTENT);
  const before = await restoreRuntimeCache(records, cache);
  assert.deepEqual(before.unchanged, ['community'], '缓存一致时不做多余解包');

  // ★ 清空 runtime（运维常规操作：换机器 / 清盘 / 容器重建）
  await cache.remove('community');
  assert.equal(await cache.read('community'), undefined);

  const after = await restoreRuntimeCache(records, cache);
  assert.deepEqual(after.restored, ['community'], '★ 清空后应自动从 DB 恢复');
  assert.equal(await cache.read('community'), DB_CONTENT, '内容与权威副本一致');
});

test('★ M4-4：**内置插件在无 DB 时仍可用**（可用性判定只看构建产物）', () => {
  const records: PluginPackageRecord[] = [
    recordOf({ pluginId: 'checkin', builtin: { kind: 'builtin', content: BUILTIN_CONTENT, fingerprint: fingerprintOf(BUILTIN_CONTENT) } }),
    recordOf({ pluginId: 'community', db: { kind: 'db', content: DB_CONTENT, fingerprint: fingerprintOf(DB_CONTENT) } }),
  ];
  // 无 DB 时可用的是**内置的那些**
  assert.deepEqual(availableWithoutDatabase(records), ['checkin'], '★ 外置插件（只有 db）在无 DB 时不可用，内置的仍可用');

  // 且加载计划确实走 builtin
  const plan = planPluginLoad(records[0]!);
  assert.equal(plan.source, 'builtin');
  assert.match(plan.reason, /无 DB 也可用/);
});

test('★ M4-4：缓存指纹不一致 → **重新解包**（不继续用旧文件）', async () => {
  const cache = new InMemoryRuntimeCache();
  const newContent = `${DB_CONTENT}:updated`;
  const records: PluginPackageRecord[] = [
    recordOf({ pluginId: 'community', db: { kind: 'db', content: newContent, fingerprint: fingerprintOf(newContent) } }),
  ];
  // 缓存里是**旧版本**的内容
  await cache.write('community', DB_CONTENT);

  const plan = planPluginLoad({ ...records[0]!, runtime: { kind: 'runtime', content: DB_CONTENT, fingerprint: fingerprintOf(DB_CONTENT) } });
  assert.equal(plan.needsMaterialize, true);
  assert.equal(plan.needsInvalidate, true, '过期缓存要先清理');

  const result = await restoreRuntimeCache(records, cache);
  assert.deepEqual(result.invalidated, ['community']);
  assert.deepEqual(result.restored, ['community']);
  assert.equal(await cache.read('community'), newContent, '★ 必须是新内容');
});

test('★ M4-4：**孤儿缓存**被检出（卸载残留不清会「卸载不生效」）', async () => {
  const cache = new InMemoryRuntimeCache();
  await cache.write('uninstalled-plugin', 'stale');
  await cache.write('checkin', BUILTIN_CONTENT);
  const records: PluginPackageRecord[] = [
    recordOf({ pluginId: 'checkin', builtin: { kind: 'builtin', content: BUILTIN_CONTENT, fingerprint: fingerprintOf(BUILTIN_CONTENT) } }),
  ];
  const result = await restoreRuntimeCache(records, cache);
  assert.deepEqual(result.orphans, ['uninstalled-plugin'], '★ 只有缓存、无权威来源的插件应被报告');
  assert.ok((await cache.list()).includes('uninstalled-plugin'), '不自动删文件（不可逆操作应由运维确认）');
});

test('★ M4-4：只有 runtime 缓存、权威缺失 → **告警**（不静默接受）', () => {
  const { sink, records: logs } = collectingSink();
  const plan = planPluginLoad(
    { pluginId: 'mystery', version: '1.0.0', runtime: { kind: 'runtime', content: 'x', fingerprint: fingerprintOf('x') } },
    createLogger({ level: 'debug', sink }),
  );
  assert.equal(plan.source, 'runtime');
  assert.match(plan.reason, /权威副本（DB \/ 构建产物）缺失/);
  assert.ok(logs.some((entry) => entry.level === 'warn'), '★ 必须告警');
});

test('M4-4：任何来源都没有 → 明确报错（含可操作提示）', () => {
  assert.throws(
    () => planPluginLoad({ pluginId: 'ghost', version: '1.0.0' }),
    (error: unknown) => {
      assert.ok(error instanceof PluginPackageError);
      assert.equal(error.pluginId, 'ghost');
      assert.match(error.message, /重新上传插件包/);
      return true;
    },
  );
});

// ═══════════════════════════ M4-7 declarative webhook ═══════════════════════════

const COMMUNITY_WEBHOOK: DeclarativeWebhookSpec = {
  path: '/api/plugins/community/webhook/community',
  method: 'POST',
  auth: 'hmac',
  hmac: { header: 'X-Signature-256', algo: 'sha256', secretRef: 'community.webhook_secret' },
  kind: 'webhook',
  onReceive: {
    subject: { by: 'body.user.email', fallback: 'reject' },
    facts: {
      namespace: 'community',
      extract: [
        { path: '$.data.level', as: 'level' },
        { path: '$.data.joined_at', as: 'joined_at' },
      ],
    },
    then: ['emitFacts', 'triggerEvaluation'],
  },
};

test('★ M4-7：**纯声明**驱动 —— 接收外部推送并产出 fact（无任何代码）', () => {
  const result = receiveDeclarativeWebhook({
    spec: COMMUNITY_WEBHOOK,
    body: { user: { email: 'alice@example.com' }, data: { level: 12, joined_at: '2024-01-01T00:00:00Z' } },
    headers: { 'x-signature-256': 'sha256=...' },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.subjectRef, 'alice@example.com', '按声明定位主体');
    assert.equal(result.namespace, 'community');
    assert.deepEqual(result.facts, { level: 12, joined_at: '2024-01-01T00:00:00Z' }, '★ 按声明提取事实');
    assert.deepEqual(result.then, ['emitFacts', 'triggerEvaluation']);
    assert.deepEqual(result.warnings, []);
  }
});

test('★ M4-7：`fallback: reject` **不猜测归属**（定位不到主体即拒绝）', () => {
  const result = receiveDeclarativeWebhook({ spec: COMMUNITY_WEBHOOK, body: { data: { level: 1 } }, headers: {} });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'subject_not_found');
    assert.match(result.message, /fallback=reject/);
    assert.match(result.message, /不猜测归属/);
  }
  // fallback=skip 时也返回失败，但措辞不同（调用方可据此决定是否 200）
  const skipSpec: DeclarativeWebhookSpec = {
    ...COMMUNITY_WEBHOOK,
    onReceive: { ...COMMUNITY_WEBHOOK.onReceive, subject: { by: 'body.user.email', fallback: 'skip' } },
  };
  const skipped = receiveDeclarativeWebhook({ spec: skipSpec, body: {}, headers: {} });
  assert.equal(skipped.ok, false);
  if (!skipped.ok) assert.match(skipped.message, /fallback=skip/);
});

test('★ M4-7：提取路径的**三种情况可区分**（存在 / 字段缺失 / 父级缺失）', () => {
  // ① 存在
  assert.deepEqual(lookupPath({ a: { b: 1 } }, '$.a.b'), { found: true, value: 1 });
  // ② 字段缺失（父级在）
  assert.deepEqual(lookupPath({ a: {} }, '$.a.b'), { found: false, reason: 'missing' });
  // ③ 父级缺失（上游改了结构）
  assert.deepEqual(lookupPath({}, '$.a.b'), { found: false, reason: 'parent_missing' });
  // `body.` 前缀与 `$.` 等价
  assert.deepEqual(lookupPath({ user: { email: 'x' } }, 'body.user.email'), { found: true, value: 'x' });
});

test('★ M4-7：父级缺失 → **告警**（上游改格式不能被当成正常波动）', () => {
  const { sink, records: logs } = collectingSink();
  const result = receiveDeclarativeWebhook(
    { spec: COMMUNITY_WEBHOOK, body: { user: { email: 'a@b.c' } }, headers: {} },
    createLogger({ level: 'debug', sink }),
  );
  assert.equal(result.ok, true, '主体定位成功，请求仍被接受');
  if (result.ok) {
    assert.equal(result.facts['level'], undefined, '未产出的字段不写入（与「产出 undefined」可区分）');
    assert.equal(result.warnings.length, 2, '两个提取规则的父级都缺失');
    assert.match(result.warnings[0]!, /父级结构不存在（上游可能改了格式）/);
  }
  assert.ok(logs.some((entry) => entry.level === 'warn' && /父级缺失/.test(entry.message)));
});

test('★ M4-7：declarative **只允许 `kind: webhook`**（没有代码就没东西可执行）', () => {
  const bad = validateDeclarativeWebhook({ ...COMMUNITY_WEBHOOK, kind: undefined as never });
  assert.ok(bad.some((issue) => issue.code === 'wrong_kind'));
  assert.match(bad.find((issue) => issue.code === 'wrong_kind')!.message, /只支持 kind='webhook'/);
  assert.match(bad.find((issue) => issue.code === 'wrong_kind')!.message, /没有东西可执行/);

  // 能力矩阵
  assert.deepEqual(RUNTIME_ENDPOINT_CAPABILITY['declarative'], { arbitraryEndpoints: false, webhookOnly: true });
  assert.deepEqual(RUNTIME_ENDPOINT_CAPABILITY['process'], { arbitraryEndpoints: true, webhookOnly: false });
  const denied = canRegisterEndpoint('declarative', { kind: 'http' });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.message, /只能注册 kind='webhook'/);
  assert.equal(canRegisterEndpoint('declarative', { kind: 'webhook' }).ok, true);
  assert.equal(canRegisterEndpoint('process', { kind: 'http' }).ok, true);
  assert.equal(canRegisterEndpoint('unknown-runtime', { kind: 'webhook' }).ok, false);
});

test('M4-7：声明的完整校验（缺项各自报错）', () => {
  assert.ok(validateDeclarativeWebhook({ kind: 'webhook' }).some((issue) => issue.code === 'missing_path'));
  assert.ok(validateDeclarativeWebhook({ kind: 'webhook', path: '/x' }).some((issue) => issue.code === 'missing_method'));
  assert.ok(
    validateDeclarativeWebhook({ kind: 'webhook', path: '/x', method: 'POST', auth: 'hmac' }).some((issue) => issue.code === 'hmac_config_missing'),
  );
  // 完整声明无问题
  assert.deepEqual(validateDeclarativeWebhook(COMMUNITY_WEBHOOK), []);

  // 提取路径必须以 $ 开头
  const badPath = validateDeclarativeWebhook({
    ...COMMUNITY_WEBHOOK,
    onReceive: { ...COMMUNITY_WEBHOOK.onReceive, facts: { namespace: 'n', extract: [{ path: 'data.level', as: 'level' }] } },
  });
  assert.ok(badPath.some((issue) => issue.code === 'bad_extract_path'));

  // 空 extract 被拒（接收后什么也不产出）
  const emptyExtract = validateDeclarativeWebhook({
    ...COMMUNITY_WEBHOOK,
    onReceive: { ...COMMUNITY_WEBHOOK.onReceive, facts: { namespace: 'n', extract: [] } },
  });
  assert.ok(emptyExtract.some((issue) => issue.code === 'empty_extract'));
});

test('M4-7：从 manifest 里筛出 webhook 声明（只挑 kind=webhook）', () => {
  const manifest = {
    endpoints: [
      { path: '/a', method: 'GET', auth: 'session', kind: 'http' },
      COMMUNITY_WEBHOOK,
      { path: '/b', method: 'POST', auth: 'none' },
    ],
  };
  const webhooks = declarativeWebhooksOf(manifest);
  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0]!.path, COMMUNITY_WEBHOOK.path);
  assert.deepEqual(declarativeWebhooksOf({}), []);
});

test('M4-7：主体定位支持 `$.` 写法（两种前缀等价）', () => {
  const spec: DeclarativeWebhookSpec = {
    ...COMMUNITY_WEBHOOK,
    onReceive: { ...COMMUNITY_WEBHOOK.onReceive, subject: { by: '$.user.email', fallback: 'reject' } },
  };
  const result = receiveDeclarativeWebhook({ spec, body: { user: { email: 'bob@example.com' } }, headers: {} });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.subjectRef, 'bob@example.com');
});
