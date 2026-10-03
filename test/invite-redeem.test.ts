/**
 * ★★ L-1：邀请码核销路径（`POST /api/me/redeem-invite`）。
 *
 * ★ 本文件分三层验证，因为这三层各自会以不同方式出错：
 *   ① `buildInviteFacts`——把 `grantsFacts` 整理成可提交的事实；
 *   ② **`factSchema` 约束**——★ 邀请码**不能授予未声明的字段**，
 *      否则拿到"创建邀请码"权限的人可以借它往事实库写任意字段；
 *   ③ **路由 handler**——业务结论必须用 `200 + ok:false`（"码已用完"是可预期结论，
 *      不是协议错误），且「已核销但授予失败」必须与「核销失败」**区分**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildInviteFacts, INVITE_GRANTS_MANIFEST } from '../src/plugin/builtin/invite-grants.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { validateFacts } from '../src/plugin/host-api.ts';
import { createAppRoutes } from '../src/http/routes.ts';

// ─────────────────────── ① buildInviteFacts ───────────────────────

test('buildInviteFacts：剔除 `undefined`，并补上 `invite_code_id`', () => {
  const facts = buildInviteFacts({
    grantsFacts: { cohort: 'beta', tier: undefined, invited: true },
    inviteCodeId: 'inv-123',
  });
  assert.deepEqual(facts, { cohort: 'beta', invited: true, invite_code_id: 'inv-123' });
  assert.equal('tier' in facts, false, '★ `undefined` 必须剔除——否则它与"没传"无法区分');
});

test('★ buildInviteFacts：即使 `grantsFacts` 为空，也带上来源 id（排障能回答"谁给的"）', () => {
  assert.deepEqual(buildInviteFacts({ grantsFacts: {}, inviteCodeId: 'inv-1' }), {
    invite_code_id: 'inv-1',
  });
});

// ─────────────────────── ② factSchema 约束 ───────────────────────

test('manifest 本身合法（能被 `validateManifest` 接受）', () => {
  const manifest = validateManifest(INVITE_GRANTS_MANIFEST);
  assert.equal(manifest.id, 'invite-grants');
  // ★ `local: true` 是"declarative 必须有 collect"的例外：本插件本地求值、不发网络请求
  assert.equal(manifest.local, true);
});

test('★★ 越权：**未声明字段**的授予被 `factSchema` 拒绝（这是事实层的唯一入口约束）', () => {
  const manifest = validateManifest(INVITE_GRANTS_MANIFEST);
  const issues = validateFacts(manifest.factSchema, { cohort: 'beta', admin: true });
  assert.ok(issues.length > 0, '★ 未声明字段必须被拒——否则邀请码成了"写任意事实"的后门');
  assert.match(issues.join(' '), /admin/);
});

test('★ 声明过的字段通过（含 `invite_code_id`）', () => {
  const manifest = validateManifest(INVITE_GRANTS_MANIFEST);
  assert.deepEqual(
    validateFacts(manifest.factSchema, {
      cohort: 'beta',
      tier: 'vip1',
      invited: true,
      invite_code_id: 'inv-1',
    }),
    [],
  );
});

test('★ 字段名不得含 `.`（命名空间由宿主添加）', () => {
  const manifest = validateManifest(INVITE_GRANTS_MANIFEST);
  const issues = validateFacts(manifest.factSchema, { 'invite.cohort': 'beta' });
  assert.ok(issues.length > 0);
});

// ─────────────────────── ③ 路由 handler ───────────────────────

const SITE = '11111111-1111-1111-1111-111111111111';

function makeRoutes(inviteRedeem?: unknown) {
  return createAppRoutes({
    admin: async () => ({ status: 404, body: {} }),
    csrfSecret: 'test-secret',
    defaultSiteId: SITE,
    ...(inviteRedeem === undefined ? {} : { inviteRedeem }),
  } as never);
}

async function callRedeem(routes: ReturnType<typeof makeRoutes>, body: unknown, principal: unknown = { userId: 'u1' }) {
  const route = routes.find((candidate) => candidate.path === '/api/me/redeem-invite');
  assert.ok(route !== undefined, '路由必须已挂载（否则用户会拿到 404）');
  return route.handler({
    method: 'POST',
    path: '/api/me/redeem-invite',
    query: {},
    body,
    principal,
    session: null,
    siteId: SITE,
  } as never);
}

test('★ 未装配 → **501**（显式不可用，而不是 404）', async () => {
  const response = (await callRedeem(makeRoutes(), { code: 'X' })) as { status: number };
  assert.equal(response.status, 501);
});

test('未登录 → 401；缺 `code` → 400', async () => {
  const routes = makeRoutes(async () => ({ ok: true }));
  const anonymous = (await callRedeem(routes, { code: 'X' }, null)) as { status: number };
  assert.equal(anonymous.status, 401);

  const missing = (await callRedeem(routes, {})) as { status: number; body: { error: string } };
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /缺少 code/);

  const blank = (await callRedeem(routes, { code: '   ' })) as { status: number };
  assert.equal(blank.status, 400, '★ 只有空白字符也算缺失');
});

test('核销成功 → 200 + `ok:true` + 授予的事实', async () => {
  const routes = makeRoutes(async () => ({ ok: true, granted: { cohort: 'beta' } }));
  const response = (await callRedeem(routes, { code: ' BETA-1 ' })) as {
    status: number;
    body: { ok: boolean; granted: Record<string, unknown> };
  };
  // ★ 成功时 handler **不写 status**（由 HTTP 层补 200）——
  //   这本身就是"不是协议错误"的表达（与下面"码用尽"同样不写 4xx）
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.granted, { cohort: 'beta' });
});

test('★★ 码用尽 → **200 + `ok:false`**（可预期结论，不是协议错误）', async () => {
  const routes = makeRoutes(async () => ({
    ok: false,
    reason: 'exhausted',
    message: '邀请码已被用完',
  }));
  const response = (await callRedeem(routes, { code: 'USED' })) as {
    status: number;
    body: { ok: boolean; reason: string; message: string };
  };
  // ★ 没有 4xx：业务结论由 HTTP 层补 200
  assert.equal(response.body.ok, false);
  assert.equal(response.body.reason, 'exhausted');
  assert.match(response.body.message, /已被用完/);
});

test('★★★ 「已核销但授予失败」必须与「核销失败」**区分**（`ok:true` + `grantedPending`）', async () => {
  const routes = makeRoutes(async () => ({
    ok: true,
    granted: { cohort: 'beta' },
    grantedPending: true,
    message: '邀请码已核销，但权益发放失败，请带着该记录联系管理员重试',
  }));
  const response = (await callRedeem(routes, { code: 'BETA' })) as {
    status: number;
    body: { ok: boolean; grantedPending?: boolean; reason?: string };
  };
  assert.equal(response.body.ok, true, '★ 核销**已生效**——说成 ok:false 会让用户反复重试');
  assert.equal(response.body.grantedPending, true);
  assert.equal('reason' in response.body, false, '★ 这不是"核销失败"，不该带失败原因');
});

test('`code` 会被 trim 后传递（用户复制粘贴常带空格）', async () => {
  let received = '';
  const routes = makeRoutes(async (input: { code: string }) => {
    received = input.code;
    return { ok: true };
  });
  await callRedeem(routes, { code: '  ABC-123  ' });
  assert.equal(received, 'ABC-123');
});
