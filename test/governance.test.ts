/**
 * 插件治理验收（M4-2 / M4-3 / M4-5 / M4-10 / M4-11）。
 *
 * 每项都对应 docs/07 的一句**验收标准**，本文件逐条锁定：
 *   - M4-2：未授权调用被拒**并记 `denied`**
 *   - M4-3：开发者级凭据**只配一次**即被所有站点共享
 *   - M4-5：未勾选后端信任 → `enable` **被拒**
 *   - M4-10：跨插件读数据**被拒并记审计**
 *   - M4-11：插件可互调；**成环被拒**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeActionInvoke,
  authorizeProxyRequest,
  canEnable,
  enablePlugin,
  logDenied,
  newPluginTrust,
  PluginCallChain,
  PluginPermissionSet,
  resolveConfigKey,
  setTrust,
  type ApprovedEndpoint,
  type PluginPermission,
} from '../src/plugin/governance.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

// ─────────────────────────── M4-2 权限 ───────────────────────────

test('★ M4-2：声明 ≠ 授予 —— 未批准的权限被拒，且原因可区分', () => {
  const permissions = new PluginPermissionSet({ declared: ['llm:invoke', 'http:egress'] });

  // 已声明但未授予
  const notGranted = permissions.check('llm:invoke');
  assert.equal(notGranted.allowed, false);
  assert.equal(notGranted.reason, 'not_granted');
  assert.match(notGranted.message!, /尚未被管理员批准/);

  // 根本没声明
  const notDeclared = permissions.check('storage:write:self');
  assert.equal(notDeclared.allowed, false);
  assert.equal(notDeclared.reason, 'not_declared');
  assert.match(notDeclared.message!, /未在 manifest 中声明/);

  // 授予后通过
  permissions.grant(['llm:invoke']);
  assert.equal(permissions.check('llm:invoke').allowed, true);
  // 其它仍未授予
  assert.equal(permissions.check('http:egress').allowed, false);
});

test('★ M4-2：**不得授予未声明的权限**（否则「声明」这一步形同虚设）', () => {
  const permissions = new PluginPermissionSet({ declared: ['llm:invoke'] });
  assert.throws(() => permissions.grant(['http:egress']), /不得授予未声明的权限/);
});

test('★ M4-2：未授权调用**记 `denied`**（安全事件用 warn 级别，不淹没在 info 里）', () => {
  const { sink, records } = collectingSink();
  const logger = createLogger({ level: 'debug', sink });
  const permissions = new PluginPermissionSet({ declared: ['llm:invoke'] });
  const decision = permissions.check('llm:invoke');
  assert.equal(decision.allowed, false);

  logDenied(logger, {
    pluginId: 'evil',
    permission: 'llm:invoke',
    reason: 'not_granted',
    operation: 'llm.invoke',
    at: NOW,
  });

  const denied = records.find((record) => record.message === '插件权限拒绝');
  assert.ok(denied !== undefined, '★ 必须留下 denied 记录');
  assert.equal(denied.level, 'warn');
  assert.equal(denied.fields?.['decision'], 'denied');
  assert.equal(denied.fields?.['pluginId'], 'evil');
});

test('M4-2：权限可撤销；快照区分已授予与待批准', () => {
  const permissions = new PluginPermissionSet({ declared: ['llm:invoke', 'http:egress', 'cache:read:self'] });
  permissions.grant(['llm:invoke', 'cache:read:self']);
  assert.deepEqual(permissions.grantedList(), ['cache:read:self', 'llm:invoke']);
  const snapshot = permissions.snapshot();
  assert.deepEqual([...snapshot.granted].sort(), ['cache:read:self', 'llm:invoke']);
  assert.deepEqual(snapshot.pending, ['http:egress'], '声明了但未批准的要能列出');

  permissions.revoke(['llm:invoke']);
  assert.equal(permissions.check('llm:invoke').allowed, false);
});

// ─────────────────────────── M4-5 信任分级 ───────────────────────────

test('★ M4-5：未签名插件**默认不可信**，未勾选后端信任 → enable 被拒', () => {
  const trust = newPluginTrust({ pluginId: 'local-thing', signed: false });
  assert.equal(trust.backendTrusted, false);
  assert.equal(trust.frontendTrusted, false);

  const decision = canEnable(trust);
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, 'backend_untrusted');
    assert.match(decision.message, /后端信任/);
  }
  const result = enablePlugin(trust);
  assert.equal(result.trust.enabled, false, '★ 未信任不得启用');
});

test('★ M4-5：后端信任与前端信任**分别确认**（风险面不同）', () => {
  let trust = newPluginTrust({ pluginId: 'p', signed: false });
  // 只确认前端 → 仍不能启用（后端未确认）
  trust = setTrust(trust, { scope: 'frontend', trusted: true, by: 'admin', at: NOW });
  assert.equal(trust.frontendTrusted, true);
  assert.equal(trust.backendTrusted, false);
  assert.equal(canEnable(trust).ok, false, '★ 前端信任不能代替后端信任');

  // 再确认后端 → 可启用
  trust = setTrust(trust, { scope: 'backend', trusted: true, by: 'admin', at: NOW });
  assert.equal(canEnable(trust).ok, true);
  const enabled = enablePlugin(trust);
  assert.equal(enabled.trust.enabled, true);
  assert.equal(enabled.trust.backendTrustedBy, 'admin');
  assert.equal(enabled.trust.backendTrustedAt?.toISOString(), NOW.toISOString());
});

test('★ M4-5：已签名插件默认可信；信任**可撤销**（撤销后端信任一并停用）', () => {
  const signed = newPluginTrust({ pluginId: 'official', signed: true });
  assert.equal(signed.backendTrusted, true);
  assert.equal(existing(signed), 'signature');

  // 启用后撤销后端信任 → 必须停用
  const enabled = enablePlugin(signed).trust;
  assert.equal(enabled.enabled, true);
  const revoked = setTrust(enabled, { scope: 'backend', trusted: false, by: 'admin', at: NOW });
  assert.equal(revoked.backendTrusted, false);
  assert.equal(revoked.enabled, false, '★ 撤销后端信任必须一并停用（不让不可信插件继续跑）');
  assert.equal(revoked.backendTrustedBy, null);
});

function existing(trust: { backendTrustedBy: string | null }): string | null {
  return trust.backendTrustedBy;
}

// ─────────────────────────── M4-3 配置作用域 ───────────────────────────

test('★ M4-3：开发者级配置**只配一次即被所有站点共享**（键里不含 siteId）', () => {
  const declared = { scope: 'developer', instances: { mode: 'singleton' } } as const;
  const siteA = resolveConfigKey({ pluginId: 'newapi', developerId: 'dev-1', siteId: 'site-a' }, declared);
  const siteB = resolveConfigKey({ pluginId: 'newapi', developerId: 'dev-1', siteId: 'site-b' }, declared);

  assert.equal(siteA.ok, true);
  assert.equal(siteB.ok, true);
  if (siteA.ok && siteB.ok) {
    assert.equal(siteA.configKey, siteB.configKey, '★ 不同站点解析到同一个配置键（凭据共享）');
    assert.equal(siteA.sharedAcrossSites, true);
    assert.match(siteA.note, /凭据只配一次/);
    assert.equal(siteA.configKey.includes('site-a'), false, '★ 键里不得含 siteId');
  }
});

test('M4-3：站点级配置各自一份；singleton/multi 的实例规则', () => {
  const siteScoped = { scope: 'site', instances: { mode: 'singleton' } } as const;
  const a = resolveConfigKey({ pluginId: 'p', developerId: 'd', siteId: 'site-a' }, siteScoped);
  const b = resolveConfigKey({ pluginId: 'p', developerId: 'd', siteId: 'site-b' }, siteScoped);
  if (a.ok && b.ok) {
    assert.notEqual(a.configKey, b.configKey, '站点级配置各站点独立');
    assert.equal(a.sharedAcrossSites, false);
  }

  // multi 必须带实例
  const multi = { scope: 'site', instances: { mode: 'multi' } } as const;
  const missing = resolveConfigKey({ pluginId: 'p', developerId: 'd', siteId: 's' }, multi);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'instance_required');
  const withInstance = resolveConfigKey({ pluginId: 'p', developerId: 'd', siteId: 's', instanceKey: 'orders' }, multi);
  assert.equal(withInstance.ok, true);

  // singleton 不得带实例
  const forbidden = resolveConfigKey({ pluginId: 'p', developerId: 'd', siteId: 's', instanceKey: 'x' }, siteScoped);
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.reason, 'instance_forbidden');
});

// ─────────────────────────── M4-10 UI 数据代理 ───────────────────────────

test('★ M4-10：跨插件读数据**被拒**（插件前端不得读别的插件的数据）', () => {
  const approved: ApprovedEndpoint[] = [
    { pluginId: 'checkin', method: 'GET', path: '/api/plugins/checkin/status' },
    { pluginId: 'newapi', method: 'GET', path: '/api/plugins/newapi/users' },
  ];
  const decision = authorizeProxyRequest(
    { requestingPluginId: 'checkin', targetPluginId: 'newapi', method: 'GET', path: '/api/plugins/newapi/users' },
    approved,
  );
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, 'cross_plugin');
    assert.match(decision.message, /跨插件读数据/);
  }
});

test('★ M4-10：只能访问**本插件已批准**的端点（路径/方法都要匹配）', () => {
  const approved: ApprovedEndpoint[] = [{ pluginId: 'checkin', method: 'GET', path: '/api/plugins/checkin/status' }];

  const ok = authorizeProxyRequest({ requestingPluginId: 'checkin', targetPluginId: 'checkin', method: 'get', path: '/api/plugins/checkin/status' }, approved);
  assert.equal(ok.ok, true, '方法大小写不敏感');

  const wrongPath = authorizeProxyRequest({ requestingPluginId: 'checkin', targetPluginId: 'checkin', method: 'GET', path: '/api/plugins/checkin/secret' }, approved);
  assert.equal(wrongPath.ok, false);
  if (!wrongPath.ok) assert.equal(wrongPath.reason, 'not_approved');

  const wrongMethod = authorizeProxyRequest({ requestingPluginId: 'checkin', targetPluginId: 'checkin', method: 'DELETE', path: '/api/plugins/checkin/status' }, approved);
  assert.equal(wrongMethod.ok, false, '方法不匹配也要拒');
});

test('M4-10：前端信任被撤销 → 其页面数据请求被拒', () => {
  const trust = newPluginTrust({ pluginId: 'checkin', signed: false });
  const withBackend = enablePlugin(setTrust(trust, { scope: 'backend', trusted: true, by: 'a', at: NOW })).trust;
  const revokedFrontend = setTrust(withBackend, { scope: 'frontend', trusted: false, by: 'a', at: NOW });
  const decision = authorizeProxyRequest(
    { requestingPluginId: 'checkin', targetPluginId: 'checkin', method: 'GET', path: '/x' },
    [{ pluginId: 'checkin', method: 'GET', path: '/x' }],
    revokedFrontend,
  );
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, 'plugin_untrusted');
});

// ─────────────────────────── M4-11 插件间调用 ───────────────────────────

test('★ M4-11：签到插件**能**调用 newapi-add-quota:add_quota（有权限时）', () => {
  const permissions = new PluginPermissionSet({ declared: ['action:invoke'], granted: ['action:invoke'] });
  const chain = new PluginCallChain(['checkin'], 3);
  const decision = authorizeActionInvoke({
    chain,
    permissions,
    action: 'newapi-add-quota:add_quota',
    knownActions: ['newapi-add-quota:add_quota', 'checkin:grant'],
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.deepEqual(decision.chain.stack, ['checkin', 'newapi-add-quota']);
    assert.equal(decision.chain.depth, 2);
  }
});

test('★ M4-11：缺少 `action:invoke` 权限 → 拒（且错误信息指出是权限问题）', () => {
  const permissions = new PluginPermissionSet({ declared: ['llm:invoke'], granted: [] });
  const decision = authorizeActionInvoke({
    chain: new PluginCallChain(['checkin'], 3),
    permissions,
    action: 'newapi-add-quota:add_quota',
    knownActions: ['newapi-add-quota:add_quota'],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, 'not_granted');
    assert.match(decision.message, /action:invoke/);
  }
});

test('★ M4-11：**成环被拒** —— A→B→A 必须被识别（环让调用永不返回）', () => {
  const permissions = new PluginPermissionSet({ declared: ['action:invoke'], granted: ['action:invoke'] });
  let chain = new PluginCallChain(['plugin-a'], 5);
  const first = authorizeActionInvoke({ chain, permissions, action: 'plugin-b:do', knownActions: ['plugin-b:do'] });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  chain = first.chain;

  // B → A：成环
  const cycle = authorizeActionInvoke({ chain, permissions, action: 'plugin-a:do', knownActions: ['plugin-a:do'] });
  assert.equal(cycle.ok, false, '★ 成环必须被拒');
  if (!cycle.ok) {
    assert.equal(cycle.reason, 'cycle');
    assert.match(cycle.message, /调用环/);
    assert.match(cycle.message, /plugin-a → plugin-b → plugin-a/, '错误信息要画出环路径');
  }
});

test('★ M4-11：**深度上限**被强制（长链会耗尽资源且难排障）', () => {
  const permissions = new PluginPermissionSet({ declared: ['action:invoke'], granted: ['action:invoke'] });
  let chain = new PluginCallChain(['p0'], 3);
  // p0 → p1 → p2 → p3（深度 4 时超限）
  for (const [index, target] of ['p1', 'p2', 'p3'].entries()) {
    const decision = authorizeActionInvoke({ chain, permissions, action: `${target}:do`, knownActions: ['p1:do', 'p2:do', 'p3:do'] });
    if (index < 2) {
      assert.equal(decision.ok, true, `第 ${index + 1} 次调用应通过`);
      if (decision.ok) chain = decision.chain;
    } else {
      assert.equal(decision.ok, false, '★ 深度超限必须被拒');
      if (!decision.ok) {
        assert.equal(decision.reason, 'depth_exceeded');
        assert.match(decision.message, /深度上限 3/);
      }
    }
  }
});

test('M4-11：未知动作被区分出来（「未授权」与「不存在」不是一回事）', () => {
  const permissions = new PluginPermissionSet({ declared: ['action:invoke'], granted: ['action:invoke'] });
  const decision = authorizeActionInvoke({
    chain: new PluginCallChain(['a'], 3),
    permissions,
    action: 'ghost:do',
    knownActions: ['checkin:grant'],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, 'target_unknown');
    assert.match(decision.message, /未注册/);
  }
});

test('M4-11：调用链是**不可变**的（每次进入返回新链，不污染兄弟分支）', () => {
  const root = new PluginCallChain(['root'], 5);
  const branchA = root.enter('a');
  const branchB = root.enter('b');
  assert.equal(root.stack.length, 1, '原链不被修改');
  if (branchA.ok && branchB.ok) {
    assert.deepEqual(branchA.chain.stack, ['root', 'a']);
    assert.deepEqual(branchB.chain.stack, ['root', 'b'], '★ 兄弟分支互不影响');
  }
  // 同级重复进入同一目标不算环（那是「调用两次」，不是环）
  const twice = root.enter('a');
  assert.equal(twice.ok, true);
});
