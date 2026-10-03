/**
 * 控制台能力模型验收（M7-6 / M7-7）—— docs/06 §9、docs/07 M7-6/M7-7。
 *
 * 两个验收标准：
 *   - **M7-6**：「需求清单中 admin 的每一项设置**均可用**」→ 用 `auditM7_6Coverage()` 机器核对；
 *   - **M7-7**：「开发者**无法安装插件、无法新增 OIDC**」→ **否定式**要求，
 *     必须验证「能力集里确实没有」+「动作判定确实 403」，
 *     而不是「UI 上没有按钮」（UI 隐藏挡不住直接调 API）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_CAPABILITY,
  allowedActions,
  assertCanAccess,
  assertCanPerform,
  auditM7_6Coverage,
  capabilitiesFor,
  CONSOLE_SECTIONS,
  hasCapability,
  M7_6_REQUIRED_ITEMS,
  M7_7_FORBIDDEN_ACTIONS,
  M7_7_FORBIDDEN_CAPABILITIES,
  visibleSections,
  type ConsolePrincipal,
} from '../src/admin/console.ts';

const admin: ConsolePrincipal = { userId: 'a1', realm: 'developer', role: 'admin', activeDeveloperId: 'd1', activeSiteId: 's1' };
const developer: ConsolePrincipal = { userId: 'd1', realm: 'developer', role: 'developer', activeDeveloperId: 'd1', activeSiteId: 's1' };
const enduser: ConsolePrincipal = { userId: 'u1', realm: 'enduser', role: 'user' };
/** ★ 域与角色冲突的构造：enduser 域但 role 被写成 admin */
const suspicious: ConsolePrincipal = { userId: 'x1', realm: 'enduser', role: 'admin' };

// ─────────────────────────── ★ M7-7 否定式边界 ───────────────────────────

test('★ M7-7：开发者**无法访问「插件安装」**分区（403，不是 UI 隐藏）', () => {
  const access = assertCanAccess(developer, 'admin.plugins');
  assert.equal(access.ok, false);
  if (!access.ok) {
    assert.equal(access.status, 403);
    assert.equal(access.reason, 'missing_capability');
    assert.ok(access.missing?.includes('plugin:install'));
  }
  // 管理员可以
  assert.equal(assertCanAccess(admin, 'admin.plugins').ok, true);
});

test('★ M7-7：开发者**无法访问「OIDC 注册」**分区（403）', () => {
  const access = assertCanAccess(developer, 'admin.oidc');
  assert.equal(access.ok, false);
  if (!access.ok) {
    assert.equal(access.status, 403);
    assert.ok(access.missing?.includes('oidc:manage'));
  }
  assert.equal(assertCanAccess(admin, 'admin.oidc').ok, true);
});

test('★ M7-7：开发者**能力集里确实没有**安装插件与 OIDC 管理能力', () => {
  const capabilities = capabilitiesFor(developer);
  for (const forbidden of M7_7_FORBIDDEN_CAPABILITIES) {
    assert.equal(capabilities.has(forbidden), false, `★ 开发者不得持有能力 '${forbidden}'`);
  }
  // 管理员持有（形成对照，证明检查不是恒假）
  const adminCapabilities = capabilitiesFor(admin);
  for (const forbidden of M7_7_FORBIDDEN_CAPABILITIES) {
    assert.equal(adminCapabilities.has(forbidden), true);
  }
});

test('★ M7-7：开发者执行**动作**也被拒（install_plugin / create_oidc_provider）', () => {
  for (const action of M7_7_FORBIDDEN_ACTIONS) {
    const result = assertCanPerform(developer, action);
    assert.equal(result.ok, false, `★ 开发者不得执行 '${action}'`);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.match(result.message, /缺少能力/);
    }
    // 管理员可以
    assert.equal(assertCanPerform(admin, action).ok, true);
  }
});

test('★ M7-7：`allowedActions` 对开发者**不含**被禁动作（前端置灰与接口判定同源）', () => {
  const actions = allowedActions(developer);
  for (const forbidden of M7_7_FORBIDDEN_ACTIONS) {
    assert.equal(actions.includes(forbidden), false, `allowedActions 不得包含 '${forbidden}'`);
  }
  // 但开发者可以做本站点的事
  assert.ok(actions.includes('publish_policy'));
  assert.ok(actions.includes('rollback_policy'));
  assert.ok(actions.includes('configure_plugin'), '开发者可**配置**插件（只是不能安装）');
});

test('M7-7：开发者控制台的五个分区都可访问（本站点策略/插件配置/主体/动作/审计）', () => {
  const sections = visibleSections(developer, 'developer').map((section) => section.id);
  assert.deepEqual(sections.sort(), ['dev.actions', 'dev.audit', 'dev.plugin-config', 'dev.policies', 'dev.subjects']);
  // ★ 但管理控制台的分区一个都看不到
  assert.deepEqual(visibleSections(developer, 'admin'), []);
});

// ─────────────────────────── M7-6 完整性 ───────────────────────────

test('★ M7-6：路线图的每一项设置都有对应分区（机器核对，不靠人读文档）', () => {
  const { covered, missing } = auditM7_6Coverage();
  assert.deepEqual(missing, [], `★ 缺少设置项：${missing.join(', ')}`);
  assert.equal(covered.length, M7_6_REQUIRED_ITEMS.length);
  // 清单本身要与路线图原文一致
  assert.deepEqual([...M7_6_REQUIRED_ITEMS].sort(), ['OIDC 注册', 'SMTP', '开发者', '插件安装', '普通用户', '全局审计', '站点', '网络', '邀请码'].sort());
});

test('M7-6：管理员可访问全部管理分区', () => {
  const sections = visibleSections(admin, 'admin').map((section) => section.id);
  const expected = CONSOLE_SECTIONS.filter((section) => section.console === 'admin').map((section) => section.id);
  assert.deepEqual(sections.sort(), expected.sort(), '管理员应能访问全部分区');
  assert.equal(sections.length, 10);
});

test('M7-6：管理员也能使用开发者控制台（超集关系）', () => {
  const developerSections = visibleSections(admin, 'developer').map((section) => section.id);
  assert.equal(developerSections.length, 5, '管理员是开发者的超集');
});

// ─────────────────────────── 普通用户与域边界 ───────────────────────────

test('★：普通用户不可进控制台，且**不透露分区是否存在**', () => {
  const known = assertCanAccess(enduser, 'admin.plugins');
  const unknown = assertCanAccess(enduser, 'admin.nonexistent');
  assert.equal(known.ok, false);
  assert.equal(unknown.ok, false);
  if (!known.ok && !unknown.ok) {
    assert.equal(known.reason, 'no_console_access');
    assert.equal(unknown.reason, 'no_console_access', '★ 普通用户不应能从错误信息区分「分区存在」与「不存在」');
    assert.equal(known.message, unknown.message);
  }
  assert.deepEqual(visibleSections(enduser), [], '普通用户没有可访问分区');
});

test('★：**身份域优先于角色** —— enduser 域即使 role=admin 也无控制台权限', () => {
  // 这是刻意设计：域是会话建立时确定的更强边界，
  // 若只看 role，一个「被错误赋权」的普通用户就能进管理控制台。
  assert.equal(capabilitiesFor(suspicious).size, 0);
  assert.equal(assertCanAccess(suspicious, 'admin.overview').ok, false);
  assert.equal(assertCanPerform(suspicious, 'install_plugin').ok, false);
});

// ─────────────────────────── 路由与一致性 ───────────────────────────

test('M7-6/M7-7：未知分区 → 404（与权限 403 区分：那是路由错误不是权限问题）', () => {
  const result = assertCanAccess(admin, 'admin.ghost');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 404);
    assert.equal(result.reason, 'unknown_section');
  }
});

test('★：导航所见与接口所判**必然一致**（visibleSections 逐个调用 assertCanAccess）', () => {
  for (const principal of [admin, developer, enduser, suspicious]) {
    for (const section of CONSOLE_SECTIONS) {
      const inNav = visibleSections(principal).some((entry) => entry.id === section.id);
      const allowed = assertCanAccess(principal, section.id).ok;
      assert.equal(inNav, allowed, `${principal.role} 对 ${section.id} 的导航与判定不一致`);
    }
  }
});

test('M7-6/M7-7：动作表是声明式的（每个动作都能追溯到唯一能力）', () => {
  const actions = Object.keys(ACTION_CAPABILITY);
  assert.ok(actions.length >= 14);
  // 每个动作的能力都必须是「真实存在的能力名」（防拼写错误导致永远 403/永远放行）
  const knownCapabilities = new Set([...capabilitiesFor(admin)]);
  for (const [action, capability] of Object.entries(ACTION_CAPABILITY)) {
    assert.ok(knownCapabilities.has(capability), `动作 '${action}' 引用了未知能力 '${capability}'`);
  }
});

test('M7-7：`hasCapability` 与能力集一致（供端点快速判定）', () => {
  assert.equal(hasCapability(developer, 'policy:write:own'), true);
  assert.equal(hasCapability(developer, 'plugin:install'), false);
  assert.equal(hasCapability(admin, 'plugin:install'), true);
  assert.equal(hasCapability(enduser, 'policy:write:own'), false);
});
