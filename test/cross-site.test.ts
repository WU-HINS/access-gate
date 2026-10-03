/**
 * 显式跨站点访问（`docs/08 §7` 第三条硬规则）—— **按角色收敛 + 显式理由 + 审计留痕**。
 *
 * ★ 本文件要证明的四件事：
 *   ① 没有 `reason` 就不能跨站点（「显式声明」不是形式主义——它要进审计）；
 *   ② `admin` 全部、`developer` **仅名下**、`enduser` **一律拒绝**；
 *   ③ `developer` 请求**非名下站点**时**拒绝而不是静默过滤**——
 *      静默过滤会让「越权」伪装成「没有数据」；
 *   ④ 只有 `allowed` 的判定才能转出 `scope: 'bypass'`——
 *      让「绕过站点隔离」成为**必须经过判定**的动作，而不是随手传一个字符串。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCrossSiteAllowed,
  crossSiteCompileOptions,
  CrossSiteDeniedError,
  evaluateCrossSite,
  type CrossSiteActor,
} from '../src/core/cross-site.ts';

const ADMIN: CrossSiteActor = {
  realm: 'developer',
  role: 'admin',
  developerId: 'dev-admin',
  actorId: 'admin@example.com',
};

const DEVELOPER: CrossSiteActor = {
  realm: 'developer',
  role: 'developer',
  developerId: 'dev-1',
  actorId: 'dev1@example.com',
};

const ENDUSER: CrossSiteActor = {
  realm: 'enduser',
  role: 'user',
  developerId: null,
  actorId: 'user-1',
};

const OWNED = ['site-a1', 'site-a2'];

test('★ 没有 reason → 一律拒绝（连 admin 也不例外）', () => {
  for (const actor of [ADMIN, DEVELOPER]) {
    const decision = evaluateCrossSite({
      actor,
      request: { reason: '   ' },
      ownedSiteIds: OWNED,
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : '', /必须显式提供 reason/);
  }
});

test('★ 终端用户 → 拒绝（站点之间互不可见）', () => {
  const decision = evaluateCrossSite({ actor: ENDUSER, request: { reason: '想看看' } });
  assert.equal(decision.allowed, false);
  assert.match(decision.allowed === false ? decision.reason : '', /终端用户不得跨站点访问/);
});

test('admin + reason → 允许全部，并产出审计条目', () => {
  const decision = evaluateCrossSite({ actor: ADMIN, request: { reason: '平台运维统计' } });
  assert.equal(decision.allowed, true);
  if (!decision.allowed) return;
  assert.equal(decision.scope, 'all');
  assert.deepEqual(decision.audit, {
    action: 'cross_site.query',
    actorId: 'admin@example.com',
    reason: '平台运维统计',
    siteIds: [],
    scope: 'all',
  });
});

test('★ developer 请求「全部」→ 收敛为**名下站点**（这正是「列出自己名下站点」的正当需求）', () => {
  const decision = evaluateCrossSite({
    actor: DEVELOPER,
    request: { reason: '开发者控制台列出我的站点' },
    ownedSiteIds: OWNED,
  });
  assert.equal(decision.allowed, true);
  if (!decision.allowed) return;
  assert.equal(decision.scope, 'owned');
  assert.deepEqual(decision.siteIds, OWNED);
  assert.equal(decision.audit.scope, 'owned');
});

test('developer 请求名下站点 → 允许', () => {
  const decision = evaluateCrossSite({
    actor: DEVELOPER,
    request: { reason: '查看我的两个站点', siteIds: ['site-a1'] },
    ownedSiteIds: OWNED,
  });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.allowed === true ? decision.siteIds : [], ['site-a1']);
});

test('★ developer 请求**非名下**站点 → 拒绝（**不静默过滤**：越权必须响亮）', () => {
  const decision = evaluateCrossSite({
    actor: DEVELOPER,
    request: { reason: '顺手看看别人家的', siteIds: ['site-a1', 'site-b1'] },
    ownedSiteIds: OWNED,
  });
  assert.equal(decision.allowed, false);
  const reason = decision.allowed === false ? decision.reason : '';
  assert.match(reason, /不在该开发者名下：site-b1/);
  // ★ 而不是「悄悄只返回 site-a1」
  assert.doesNotMatch(reason, /site-a1 不在/);
});

test('★ developer 缺名下站点清单 → 拒绝（无法收敛范围时**拒绝**而不是放行）', () => {
  const decision = evaluateCrossSite({
    actor: DEVELOPER,
    request: { reason: '列出我的站点' },
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.allowed === false ? decision.reason : '', /需要提供其名下站点清单/);
});

test('★ 只有 allowed 的判定才能转出 `scope: bypass`', () => {
  const allowed = evaluateCrossSite({ actor: ADMIN, request: { reason: '运维' } });
  const options = crossSiteCompileOptions(allowed);
  assert.deepEqual(options, { scope: 'bypass', bypassReason: 'cross_site(all): 运维' });

  const denied = evaluateCrossSite({ actor: ENDUSER, request: { reason: '试试' } });
  const deniedOptions = crossSiteCompileOptions(denied);
  assert.ok('error' in deniedOptions);
  assert.equal('scope' in deniedOptions, false, '★ 被拒时**绝不**产出 bypass');
});

test('assertCrossSiteAllowed：被拒即抛错（含原因），放行则返回审计条目', () => {
  const denied = evaluateCrossSite({ actor: ENDUSER, request: { reason: '试试' } });
  assert.throws(
    () => assertCrossSiteAllowed(denied),
    (error: unknown) => {
      assert.ok(error instanceof CrossSiteDeniedError);
      assert.match(error.message, /跨站点访问被拒/);
      return true;
    },
  );

  const allowed = evaluateCrossSite({
    actor: DEVELOPER,
    request: { reason: '我的站点' },
    ownedSiteIds: OWNED,
  });
  const audit = assertCrossSiteAllowed(allowed);
  assert.equal(audit.action, 'cross_site.query');
  assert.deepEqual(audit.siteIds, OWNED);
});
