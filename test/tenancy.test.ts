/**
 * 平台模式（M7-10）与审计可见性（M7-9）验收。
 *
 * 两条验收标准（docs/07 原文）：
 *   - M7-10：**「切换无需重启、无需迁移；降级不删数据」**
 *   - M7-9：**「admin 可见全部；开发者仅见名下站点」**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyModeSwitch,
  capabilitiesOf,
  defaultPlatformSettings,
  isModeReadPerRequest,
  ModeSwitchError,
  planModeSwitch,
  type PlatformStats,
} from '../src/app/platform-mode.ts';
import {
  AUDIT_VISIBILITY_RULES,
  auditQueryFilterOf,
  auditVisibilityIsConsistent,
  auditVisibilityOf,
  canSeeAudit,
  filterVisibleAudit,
  type AuditRecordScope,
  type AuditViewer,
} from '../src/admin/audit-scope.ts';
import { collectingSink, createLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');
const STATS: PlatformStats = { developers: 4, sites: 7, subjects: 1200, extraSites: 6 };

// ═══════════════════════════ M7-10 平台模式 ═══════════════════════════

test('★ M7-10：切换**只改一个设置值**（不碰业务数据 → 无需迁移、不删数据）', () => {
  const settings = defaultPlatformSettings('standalone');
  const { settings: next, plan } = applyModeSwitch(settings, { to: 'saas', by: 'admin-1', at: NOW });

  assert.equal(next.mode, 'saas');
  assert.equal(next.modeChangedBy, 'admin-1');
  assert.equal(next.modeChangedAt?.toISOString(), NOW.toISOString());
  // ★ 关键：原设置的其它字段一字未动（没有「顺手清理」）
  assert.equal(next.initial, settings.initial);
  assert.equal(plan.reversible, true, '★ 明确声明可逆');
  assert.equal(plan.dataLoss, false, '★ 明确声明不丢数据');
  assert.equal(plan.noop, false);
});

test('★ M7-10：**降级绝不删数据** —— saas → standalone 完全可逆', () => {
  let settings = defaultPlatformSettings('standalone');
  settings = applyModeSwitch(settings, { to: 'saas', by: 'admin', at: NOW }).settings;
  const plan = planModeSwitch({ from: 'saas', to: 'standalone', stats: STATS });

  assert.equal(plan.dataLoss, false);
  assert.equal(plan.reversible, true);
  // 影响面提示必须说明「数据仍在，只是不显示」
  const hideImpact = plan.impacts.find((impact) => /隐藏站点/.test(impact.description));
  assert.ok(hideImpact !== undefined);
  assert.match(hideImpact.description, /4 个开发者、7 个站点将\*\*不再显示\*\*/);
  assert.match(hideImpact.description, /其中 6 个非默认站点/);
  assert.equal(hideImpact.dataVisibility, true, '涉及可见性变化的要重点标注');

  // 提示文案明确打消「会不会丢数据」的顾虑
  assert.match(plan.prompt, /不会删除任何数据/);
  assert.match(plan.prompt, /随时可切回 saas/);
  assert.match(plan.prompt, /无需重启、无需迁移/);

  // 切回 saas 后一切照旧
  const back = applyModeSwitch(settings, { to: 'standalone', by: 'admin', at: NOW }).settings;
  const forth = applyModeSwitch(back, { to: 'saas', by: 'admin', at: NOW }).settings;
  assert.equal(forth.mode, 'saas');
});

test('★ M7-10：**无需重启** —— 能力每次查设置（切换即时生效）', () => {
  const settings = defaultPlatformSettings('standalone');
  assert.equal(capabilitiesOf(settings.mode).siteUiVisible, false);
  // 切换后**立刻**生效（同一进程内，无需重启）
  const next = applyModeSwitch(settings, { to: 'saas', by: 'admin', at: NOW }).settings;
  assert.equal(capabilitiesOf(next.mode).siteUiVisible, true, '★ 切换即时生效');
  assert.equal(capabilitiesOf(next.mode).onboardingOpen, true);

  // 动态读取的形态判据（防止有人把模式缓存到模块级常量）
  assert.equal(isModeReadPerRequest({ mode: () => next.mode }), true);
});

test('M7-10：两种模式的能力矩阵（standalone 只是「隐藏 UI + 关入口」）', () => {
  const standalone = capabilitiesOf('standalone');
  const saas = capabilitiesOf('saas');
  assert.deepEqual(standalone, {
    siteUiVisible: false,
    onboardingOpen: false,
    multiSiteAllowed: false,
    developerConsoleVisible: false,
    auditScopedByDeveloper: false,
  });
  assert.equal(saas.siteUiVisible, true);
  assert.equal(saas.onboardingOpen, true);
  assert.equal(saas.auditScopedByDeveloper, true);
});

test('M7-10：同模式切换 → noop（不写设置、不记审计）', () => {
  const settings = defaultPlatformSettings('saas');
  const { settings: next, plan } = applyModeSwitch(settings, { to: 'saas', by: 'admin', at: NOW });
  assert.equal(plan.noop, true);
  assert.equal(next, settings, '同一对象（未产生新设置）');
  assert.match(plan.prompt, /当前已是 saas 模式，无需切换/);
  assert.deepEqual(plan.impacts, []);
});

test('M7-10：未知模式 → 明确报错（不静默接受）', () => {
  const settings = defaultPlatformSettings('standalone');
  assert.throws(
    () => applyModeSwitch(settings, { to: 'hybrid' as never, by: 'admin', at: NOW }),
    (error: unknown) => {
      assert.ok(error instanceof ModeSwitchError);
      assert.equal(error.code, 'unknown_mode');
      assert.match(error.message, /可用：standalone \/ saas/);
      return true;
    },
  );
});

test('M7-10：切换写审计（模式变更必须留痕）', () => {
  const { sink, records } = collectingSink();
  const settings = defaultPlatformSettings('standalone');
  applyModeSwitch(settings, { to: 'saas', by: 'admin-1', at: NOW }, createLogger({ level: 'debug', sink }));
  const entry = records.find((record) => record.message === '平台模式已切换');
  assert.ok(entry !== undefined);
  assert.equal(entry.fields?.['from'], 'standalone');
  assert.equal(entry.fields?.['to'], 'saas');
  assert.equal(entry.fields?.['reversible'], true);
});

// ═══════════════════════════ M7-9 审计可见性 ═══════════════════════════

const admin: AuditViewer = { userId: 'a1', realm: 'developer', role: 'admin', developerId: 'dev-1', activeSiteId: 'site-a' };
const developer: AuditViewer = { userId: 'd1', realm: 'developer', role: 'developer', developerId: 'dev-1', activeSiteId: 'site-a' };
const otherDeveloper: AuditViewer = { userId: 'd2', realm: 'developer', role: 'developer', developerId: 'dev-2' };
const enduser: AuditViewer = { userId: 'u1', realm: 'enduser', role: 'user' };
/** 域与角色冲突：enduser 域但 role 被写成 admin */
const suspicious: AuditViewer = { userId: 'x1', realm: 'enduser', role: 'admin' };

const ownSiteRecord: AuditRecordScope = { siteId: 'site-a', developerId: 'dev-1', realm: 'developer', actorId: 'someone' };
const otherSiteRecord: AuditRecordScope = { siteId: 'site-b', developerId: 'dev-2', realm: 'developer', actorId: 'someone-else' };
const platformRecord: AuditRecordScope = { siteId: null, developerId: null, realm: 'developer', actorId: 'admin-1' };
const ownUserRecord: AuditRecordScope = { siteId: 'site-a', developerId: 'dev-1', realm: 'enduser', actorId: 'u1' };
const otherUserRecord: AuditRecordScope = { siteId: 'site-a', developerId: 'dev-1', realm: 'enduser', actorId: 'u2' };

test('★ M7-9：**admin 可见全部**（含平台级记录与其他开发者的记录）', () => {
  for (const record of [ownSiteRecord, otherSiteRecord, platformRecord, otherUserRecord]) {
    assert.equal(canSeeAudit(admin, record), true, `admin 应可见 site=${record.siteId ?? 'null'}`);
  }
  const visibility = auditVisibilityOf(admin, otherSiteRecord);
  assert.equal(visibility.visible, true);
  if (visibility.visible) assert.equal(visibility.reason, 'admin_all');
});

test('★ M7-9：**developer 仅见名下站点**（跨开发者不可见）', () => {
  assert.equal(canSeeAudit(developer, ownSiteRecord), true);
  const denied = auditVisibilityOf(developer, otherSiteRecord);
  assert.equal(denied.visible, false);
  if (!denied.visible) assert.equal(denied.reason, 'cross_developer');
  // 另一个开发者也看不到 dev-1 的记录
  assert.equal(canSeeAudit(otherDeveloper, ownSiteRecord), false);
});

test('★ M7-9：**平台级记录对普通开发者不可见**（它们不属于任何单一开发者）', () => {
  const visibility = auditVisibilityOf(developer, platformRecord);
  assert.equal(visibility.visible, false);
  if (!visibility.visible) assert.equal(visibility.reason, 'cross_realm');
  // 但 admin 可见
  assert.equal(canSeeAudit(admin, platformRecord), true);
});

test('★ M7-9：**enduser 域仅见自己**（域优先于角色）', () => {
  assert.equal(canSeeAudit(enduser, ownUserRecord), true);
  assert.equal(canSeeAudit(enduser, otherUserRecord), false);
  // ★ 冲突身份：enduser 域 + role=admin → 仍只能看**自己产生的**记录
  const suspiciousOwnRecord: AuditRecordScope = { siteId: 'site-a', developerId: 'dev-1', realm: 'enduser', actorId: 'x1' };
  assert.equal(canSeeAudit(suspicious, suspiciousOwnRecord), true, '自己的记录可见');
  assert.equal(canSeeAudit(suspicious, otherUserRecord), false, '★ 域是更强的边界（role=admin 也不能越域）');
  assert.equal(canSeeAudit(suspicious, ownSiteRecord), false, '普通用户看不到站点级审计（actorId 不是他）');
});

test('★ M7-9：过滤一批记录（用**同一套判定**，避免列表/详情不一致）', () => {
  const records = [ownSiteRecord, otherSiteRecord, platformRecord, ownUserRecord];
  assert.equal(filterVisibleAudit(admin, records).length, 4);
  // ★ ownSiteRecord 与 ownUserRecord **都属于 dev-1**（同一开发者的站点），因此 developer 可见 2 条
  assert.equal(filterVisibleAudit(developer, records).length, 2);
  assert.deepEqual(
    filterVisibleAudit(developer, records).map((record) => record.actorId),
    ['someone', 'u1'],
  );
  // ★ enduser 只看**自己产生的**记录：ownUserRecord 的 actorId 正是 'u1'
  assert.deepEqual(filterVisibleAudit(enduser, records).map((record) => record.actorId), ['u1']);
  // 另一个普通用户的记录不可见
  assert.equal(filterVisibleAudit(enduser, [otherUserRecord]).length, 0);
});

test('★ M7-9：查询条件按角色生成（SQL 层就限住范围）', () => {
  const adminFilter = auditQueryFilterOf(admin);
  assert.equal(adminFilter.siteIds, 'all');
  assert.equal(adminFilter.actorId, null);
  assert.match(adminFilter.description, /全部审计（admin）/);

  const devFilter = auditQueryFilterOf(developer, { siteIdsOfDeveloper: ['site-a', 'site-c'] });
  assert.deepEqual(devFilter.siteIds, ['site-a', 'site-c']);
  assert.equal(devFilter.developerId, 'dev-1');
  assert.match(devFilter.description, /名下的 2 个站点/);

  const userFilter = auditQueryFilterOf(enduser);
  assert.equal(userFilter.actorId, 'u1', '★ 普通用户按 actorId 限定（用户是平台级的，跨站点）');
  assert.equal(userFilter.realm, 'enduser');
});

test('★ M7-9：列表与详情的一致性自检（防「列表过滤、详情不过滤」）', () => {
  const records = [ownSiteRecord, otherSiteRecord, platformRecord];
  const ok = auditVisibilityIsConsistent(developer, records);
  assert.equal(ok.consistent, true);
  assert.deepEqual(ok.problems, []);
  assert.equal(auditVisibilityIsConsistent(admin, records).consistent, true);
});

test('M7-9：规则声明可被机器核对（规则条数与内容）', () => {
  assert.equal(AUDIT_VISIBILITY_RULES.length, 4);
  const ids = AUDIT_VISIBILITY_RULES.map((rule) => rule.id).sort();
  assert.deepEqual(ids, ['admin-all', 'detail-parity', 'developer-own-sites', 'enduser-own-records']);
});
