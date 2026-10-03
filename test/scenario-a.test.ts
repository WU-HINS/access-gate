/**
 * `docs/07 §5` **场景 A** 关键链路验收 —— 真实 HTTP 下游 + 真实动作插件 + 真实签到。
 *
 * ★ 为什么需要这一条：场景 A 的 8 个步骤此前**分散**在多个测试里，
 *   没有任何一条命令把「写回下游」与「发额度」串起来跑过。
 *   而 `writeBackAttributes`（写回）与 `add_quota`（发额度）**在本轮才第一次被接线**
 *   （此前 `newapi-actions.ts` 零生产引用、`set_group` 只写进程内 Map）。
 *
 * ★★ 8 步的**覆盖分工**（明确边界，避免"看起来全绿"）：
 *
 * | 步骤（07 §5） | 覆盖位置 |
 * |---|---|
 * | ① 配置 provider（`config.scope: site`） | ✅ **本文件**（真实 transport → 假上游 HTTP） |
 * | ② 配置策略（edu 分支 + `checkin:grant`） | `test/policy.test.ts` · `test/patrol.test.ts` |
 * | ③ 用户登录 + 邮箱验证 | `test/auth.test.ts` · `test/oidc-*.test.ts` |
 * | ④ 评估后下游分组变为 `basic` | ✅ **本文件**（真实 `PUT /api/user/`） |
 * | ⑤ 用户侧「我的资格」显示 | `test/eligibility.test.ts` |
 * | ⑥ 签到成功、额度经 `add_quota` 到账 | ✅ **本文件**（真实 `POST /api/user/manage`） |
 * | ⑦ 重复巡检 10 次无额外写回 | ✅ **本文件**（数下游收到的 PUT 次数）＋ `test/patrol.test.ts`（状态机层） |
 * | ⑧ 邮箱改 `gmail.com` → 宽限期后回退 | ✅ **本文件**（回退写回）＋ `test/lifecycle.test.ts`（宽限期计时） |
 *
 * ★ 断言全部落在**下游可观测的事实**上（下游收到的请求、下游里存的字段），
 *   而不是"函数被调用了"——这是本仓库对「生产判据」的一贯要求。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  createNewApiProvider,
  type ProviderTransport,
} from '../src/plugin/builtin/newapi-provider.ts';
import { registerNewapiActions } from '../src/plugin/builtin/newapi-actions.ts';
import { createNewApiDownstreamApi } from '../src/plugin/builtin/newapi-downstream.ts';
import { ActionRegistry, idempotencyKeyOf, type ActionStep } from '../src/core/action-executor.ts';
import { InMemoryCheckinEntitlementStore, InMemoryCheckinRecordStore } from '../src/core/checkin.ts';
import { CheckinService, type CheckinConfig } from '../src/core/checkin-service.ts';

const SITE = '11111111-1111-1111-1111-111111111111';
const USER = '33333333-3333-3333-3333-333333333333';
const POLICY = '44444444-4444-4444-4444-444444444444';
const EXTERNAL_ID = '42';
const NOW = new Date('2026-09-26T02:00:00Z');

// ─────────────────────────── 假上游（真实 HTTP，不是假 transport） ───────────────────────────

interface FakeUser {
  id: number;
  username: string;
  display_name: string;
  email: string;
  group: string;
  status: number;
  role: number;
  oidc_id: string;
  quota: number;
  used_quota: number;
  request_count: number;
  remark: string;
  /** ★ 故意放一个敏感字段：用来证明写回**绝不回填**它（否则是不可逆损坏） */
  password: string;
  access_token: string;
}

interface Upstream {
  baseUrl: string;
  users: Map<number, FakeUser>;
  /** 下游真实收到的请求（用于数「写了几次」） */
  received: { method: string; path: string; body: Record<string, unknown> }[];
  writes: () => { method: string; path: string; body: Record<string, unknown> }[];
  close: () => Promise<void>;
}

async function startFakeNewApi(): Promise<Upstream> {
  const users = new Map<number, FakeUser>([
    [
      42,
      {
        id: 42,
        username: 'alice',
        display_name: 'Alice',
        email: 'alice@tsinghua.edu.cn',
        group: 'default',
        status: 1,
        role: 1,
        oidc_id: '01J8XK-SUB',
        quota: 0,
        used_quota: 0,
        request_count: 0,
        remark: '管理员备注（不得被平台覆盖）',
        password: 'HASH-SHOULD-NEVER-BE-WRITTEN-BACK',
        access_token: 'PAT-SHOULD-NEVER-BE-WRITTEN-BACK',
      },
    ],
  ]);
  const received: Upstream['received'] = [];

  const readBody = async (req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length === 0) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(req);
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // 只把**写**请求记入 received 的判定集（读请求单独记，避免污染"写了几次"的计数）
      if (req.method === 'PUT' || req.method === 'POST') {
        received.push({ method: req.method, path: url.pathname, body });
      }

      // 列表（provider.listSubjects 用）
      if (req.method === 'GET' && url.pathname === '/api/user/') {
        const items = [...users.values()];
        send(200, { success: true, data: { items, total: items.length } });
        return;
      }

      // 单点（writeBackAttributes 的「先 GET」用）
      const single = /^\/api\/user\/(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && single !== null) {
        const user = users.get(Number(single[1]));
        if (user === undefined) {
          send(404, { success: false, message: 'user not found' });
          return;
        }
        send(200, { success: true, data: user });
        return;
      }

      // 整体替换（writeBackAttributes 的 PUT）
      if (req.method === 'PUT' && url.pathname === '/api/user/') {
        const id = Number(body['id']);
        const user = users.get(id);
        if (user === undefined) {
          send(404, { success: false, message: 'user not found' });
          return;
        }
        // 下游语义：**整体替换**（缺字段即被清空）——这正是「必须回填」的原因
        user.username = String(body['username'] ?? '');
        user.display_name = String(body['display_name'] ?? '');
        user.remark = String(body['remark'] ?? '');
        user.group = String(body['group'] ?? '');
        send(200, { success: true, data: user });
        return;
      }

      // 管理类动作（add_quota / disable / enable）
      if (req.method === 'POST' && url.pathname === '/api/user/manage') {
        const user = users.get(Number(body['id']));
        if (user === undefined) {
          send(404, { success: false, message: 'user not found' });
          return;
        }
        const action = String(body['action']);
        if (action === 'add_quota') {
          user.quota += Number(body['value'] ?? 0);
        } else if (action === 'disable') {
          user.status = 2;
        } else if (action === 'enable') {
          user.status = 1;
        }
        send(200, { success: true, data: { id: user.id, action, quota: user.quota } });
        return;
      }

      send(404, { success: false, message: `未实现：${req.method} ${url.pathname}` });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('假上游未能监听端口');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    users,
    received,
    writes: () => received.filter((r) => r.method === 'PUT' || r.method === 'POST'),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

// ─────────────────────────── 生产装配（与 tools/serve.ts 同一条路径） ───────────────────────────

function makeTransport(): ProviderTransport {
  return {
    async request(request) {
      const response = await fetch(request.url, {
        method: request.method,
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(5_000),
      });
      const text = await response.text();
      let data: unknown = null;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = null;
      }
      return { status: response.status, data, text };
    },
  };
}

const CHECKIN_CONFIG: CheckinConfig = {
  requireScope: 'daily',
  timezone: 'Asia/Shanghai',
  reward: { min: 1000, max: 5000, cap: 20000, streakBonus: [{ days: 7, multiplier: 1.5 }] },
};

test('★ docs/07 §5 场景 A：真实 HTTP 下游 + 真实动作插件 + 真实签到（第 ④⑥⑦⑧ 步）', async (t) => {
  const upstream = await startFakeNewApi();
  t.after(async () => {
    await upstream.close();
  });

  // ① 配置 provider（真实 transport → 假上游 HTTP；与 serve.ts 同一份 providerDeps）
  const providerDeps = { transport: makeTransport(), pat: 'pat-admin', config: { baseUrl: upstream.baseUrl } };
  const provider = createNewApiProvider(providerDeps);

  // ★ 生产装配：`DownstreamApi` 来自 `src/plugin/builtin/newapi-downstream.ts`
  //   （**不是**测试里手写的等价物——那正是本仓库记过的「装置与实现不一致」陷阱）
  const api = createNewApiDownstreamApi({
    providerDeps,
    getSubject: async (externalId) => {
      const subject = await provider.getSubject(externalId);
      return subject === null ? null : { attributes: subject.attributes };
    },
  });

  const registry = new ActionRegistry();
  const registered = registerNewapiActions(registry, {
    setGroup: { api, externalIdOf: () => EXTERNAL_ID },
    manage: { api, externalIdOf: () => EXTERNAL_ID },
  });
  assert.deepEqual(registered.slice().sort(), [
    'newapi-add-quota:add_quota',
    'newapi-set-group:set_group',
    'newapi-set-status:set_status',
  ]);

  const step = (action: string, params: Record<string, unknown>, actionSeq: number): ActionStep => ({
    action,
    params,
    idempotencyKey: idempotencyKeyOf({ siteId: SITE, userId: USER, policyId: POLICY, actionSeq, action }),
  });

  const execute = async (plan: ActionStep) => {
    const handler = registry.get(plan.action);
    assert.ok(handler !== undefined, `动作 ${plan.action} 未注册`);
    return handler.execute({
      siteId: SITE,
      userId: USER,
      policyId: POLICY,
      actionSeq: 1,
      idempotencyKey: plan.idempotencyKey,
      params: plan.params,
      attempt: 1,
    });
  };

  // ── ④ 评估通过 → 写回下游：group 由 default 变 basic ──
  const grant = await execute(step('newapi-set-group:set_group', { group: 'basic' }, 1));
  assert.equal(grant.status, 'succeeded');
  assert.equal(upstream.users.get(42)!.group, 'basic', '下游分组必须真的变成 basic');

  // ★ 硬约束的端到端证据：写回的请求体里**不得**出现 password / access_token
  const putWrites = upstream.writes().filter((w) => w.method === 'PUT');
  assert.equal(putWrites.length, 1, '写回应恰好一次 PUT');
  assert.equal(putWrites[0]!.body['password'], undefined, '★ 绝不回填 password');
  assert.equal(putWrites[0]!.body['access_token'], undefined, '★ 绝不回填 access_token');
  // 回填：username / display_name / remark 不得被清空（下游 PUT 是整体替换）
  assert.equal(upstream.users.get(42)!.username, 'alice');
  assert.equal(upstream.users.get(42)!.display_name, 'Alice');
  assert.equal(upstream.users.get(42)!.remark, '管理员备注（不得被平台覆盖）');

  // ── ⑦ 重复巡检 10 次：值不变 → **不得**再产生写回（无额外会话吊销） ──
  for (let i = 0; i < 9; i += 1) {
    const again = await execute(step('newapi-set-group:set_group', { group: 'basic' }, 1));
    assert.equal(again.status, 'skipped');
    assert.equal(again.reason, 'no_change');
  }
  assert.equal(
    upstream.writes().filter((w) => w.method === 'PUT').length,
    1,
    '★ 重复巡检 10 次，下游只应收到 1 次写回',
  );

  // ── ⑥ 签到：三步顺序 → 额度经真实 `POST /api/user/manage` 到账 ──
  const entitlements = new InMemoryCheckinEntitlementStore();
  const records = new InMemoryCheckinRecordStore();
  const checkinService = new CheckinService({
    entitlements,
    records,
    grantQuota: async ({ amount, idempotencyKey }) => {
      const handler = registry.get('newapi-add-quota:add_quota');
      assert.ok(handler !== undefined);
      const result = await handler.execute({
        siteId: SITE,
        userId: USER,
        policyId: '',
        actionSeq: 0,
        idempotencyKey, // 含逻辑日（见 CheckinService 文件头）
        params: { value: amount },
        attempt: 1,
      });
      if (result.status !== 'succeeded') throw new Error(`add_quota 未成功：${result.status}`);
      return {};
    },
    config: CHECKIN_CONFIG,
    now: () => NOW,
  });

  // 未取得资格 → 不发额度（第 ③⑤ 步的资格前提）
  const denied = await checkinService.checkin({ siteId: SITE, userId: USER });
  assert.equal(denied.ok, false);
  assert.equal(upstream.writes().filter((w) => w.method === 'POST').length, 0);

  // 策略授予资格（`checkin:grant` 的产物）
  await entitlements.grant({ siteId: SITE, userId: USER, scope: 'daily', sourcePolicyId: POLICY });

  const first = await checkinService.checkin({ siteId: SITE, userId: USER });
  assert.equal(first.ok, true);
  assert.equal(first.ok === true && first.alreadyCheckedIn, false);
  const quotaAfterFirst = upstream.users.get(42)!.quota;
  assert.ok(quotaAfterFirst > 0, '额度必须真的到账（经真实 manage 请求）');

  const manageWrites = upstream.writes().filter((w) => w.path === '/api/user/manage');
  assert.equal(manageWrites.length, 1);
  assert.equal(manageWrites[0]!.body['action'], 'add_quota');

  // 同日第二次：幂等成功，且**不再发额度**
  const second = await checkinService.checkin({ siteId: SITE, userId: USER });
  assert.equal(second.ok === true && second.alreadyCheckedIn, true);
  assert.equal(upstream.users.get(42)!.quota, quotaAfterFirst, '★ 同日不得发第二次额度');
  assert.equal(upstream.writes().filter((w) => w.path === '/api/user/manage').length, 1);

  // ── ⑧ 不再满足 → 回退（宽限期后执行 onUnsatisfied 的写回） ──
  const restore = await execute(step('newapi-set-group:set_group', { group: 'default' }, 2));
  assert.equal(restore.status, 'succeeded');
  assert.equal(upstream.users.get(42)!.group, 'default', '不满足后必须回退到 default');
  assert.equal(upstream.writes().filter((w) => w.method === 'PUT').length, 2);

  // 回退时同样不得带敏感字段（第二次写回的独立证据）
  const lastPut = upstream.writes().filter((w) => w.method === 'PUT').at(-1)!;
  assert.equal(lastPut.body['password'], undefined);
  assert.equal(lastPut.body['access_token'], undefined);
});
