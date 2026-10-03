/**
 * ★★ P1-5：跨站点灰度分配端点 —— `src/core/cross-site.ts` 的**第一个真实消费方**。
 *
 * ★ 这条链路的每一环都是必要的：
 *   ① `listCrossSite()` 的 SQL **不带 `site_id` 条件**（跨站点的本义）；
 *   ② 因此它**必须**先经过 `evaluateCrossSite()` 判定——否则"绕过站点隔离"
 *      就只是"随手写一句不带 site_id 的 SQL"；
 *   ③ 判定被拒 → **403**（客户端问题），而不是 500（服务端故障）；
 *   ④ 放行 → **写审计**（谁、何时、因为什么、范围多大）。
 *
 * ★ 本文件要证明的就是 ①②③④ 都在代码里成立。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler } from '../src/admin/api.ts';
import { InMemorySubjectStore } from '../src/plugin/subjects.ts';
import { InMemoryIdentityStore } from '../src/core/identity.ts';
import { InMemoryPluginStore } from '../src/plugin/registry-store.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import type { AuditEntry } from '../src/admin/api.ts';
import type { PolicyAssignment } from '../src/core/policy-assignments.ts';

/**
 * ★ `role` 刻意**不写成字面量**：下面要构造 `developer` 角色的会话来验证 403——
 *   若这里用 `as const`，那个构造会被 TS 拒绝（而这正是我们**想**测的情形）。
 */
const ADMIN_SESSION: {
  userId: string;
  username: string;
  activeSiteId: string;
  realm: 'developer';
  role: 'admin' | 'developer';
} = {
  userId: 'admin-1',
  username: 'admin',
  activeSiteId: '11111111-1111-1111-1111-111111111111',
  realm: 'developer',
  role: 'admin',
};

const ASSIGNMENT: PolicyAssignment = {
  id: '22222222-2222-2222-2222-222222222222',
  policyId: '33333333-3333-3333-3333-333333333333',
  targetType: 'cohort',
  targetRef: 'beta',
  rolloutPercent: 10,
  enabled: true,
  createdAt: new Date('2026-09-26T00:00:00Z'),
};

function makeHandler(extra: Record<string, unknown> = {}) {
  const audits: AuditEntry[] = [];
  const handler = createAdminHandler({
    ...extra,
    subjects: new InMemorySubjectStore(),
    identities: new InMemoryIdentityStore(),
    policies: {
      list: async () => [],
      get: async () => undefined,
      versions: async () => [],
    } as never,
    audit: {
      async record(entry: AuditEntry) {
        audits.push(entry);
      },
      // ★ `AuditSink` 现在还有 `list`（审计查询）—— 本文件只关心写入，故返回空
      async list() {
        return [];
      },
    },
    registry: { installedPlugins: () => [], knownFactKeys: () => [], knownActions: () => [] },
    providerForSite: () => undefined,
    plugins: new InMemoryPluginStore(),
    logger: silentLogger,
  });
  return { handler, audits };
}

const call = (
  handler: ReturnType<typeof makeHandler>['handler'],
  session = ADMIN_SESSION,
): Promise<{ status: number; body: Record<string, unknown> }> =>
  handler({
    method: 'GET',
    path: '/api/admin/policy-assignments/cross-site',
    session,
  } as never) as never;

test('★ 未装配 `policyAssignmentsCrossSite` → **501**（显式不可用）', async () => {
  const { handler } = makeHandler();
  const response = await call(handler);
  assert.equal(response.status, 501);
});

test('★★ admin → 200，`scope=all`，且**写了审计**（那条查询不带 site_id，必须留痕）', async () => {
  const { handler, audits } = makeHandler({
    policyAssignmentsCrossSite: async () => [ASSIGNMENT],
  });
  const response = await call(handler);

  assert.equal(response.status, 200);
  assert.equal(response.body['scope'], 'all');
  const assignments = response.body['assignments'] as Record<string, unknown>[];
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0]!['targetType'], 'cohort');
  assert.equal(assignments[0]!['targetRef'], 'beta', '未指定 targetRef 时应显式为 null，而不是缺字段');
  assert.equal(assignments[0]!['rolloutPercent'], 10);

  const crossSiteAudits = audits.filter((entry) => entry.action === 'cross_site.query');
  assert.equal(crossSiteAudits.length, 1, '★ 跨站点查询必须留痕');
  assert.equal(crossSiteAudits[0]!.actorId, 'admin-1');
  assert.equal(
    (crossSiteAudits[0]!.after as Record<string, unknown>)['scope'],
    'all',
  );
  assert.equal((crossSiteAudits[0]!.after as Record<string, unknown>)['count'], 1);
});

test('★★ 非 admin（`developer` 且未给出名下站点）→ **403**，而不是 500 或空列表', async () => {
  const { handler, audits } = makeHandler({
    policyAssignmentsCrossSite: async () => [ASSIGNMENT],
  });
  const response = await call(handler, { ...ADMIN_SESSION, role: 'developer' });

  assert.equal(response.status, 403, '★ "你没权限"是客户端问题，不是服务端故障');
  assert.match(JSON.stringify(response.body), /跨站点访问被拒|名下站点清单/);
  assert.deepEqual(
    audits.filter((entry) => entry.action === 'cross_site.query'),
    [],
    '★ 被拒时不该留下"查询已放行"的审计',
  );
});

test('★ 被拒时**不返回数据**（不静默过滤成空列表）', async () => {
  const { handler } = makeHandler({
    policyAssignmentsCrossSite: async () => [ASSIGNMENT],
  });
  const response = await call(handler, { ...ADMIN_SESSION, role: 'developer' });
  assert.equal(response.status, 403);
  assert.equal('assignments' in response.body, false, '★ 越权时连字段都不该出现');
});
