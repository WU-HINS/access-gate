/**
 * ★★ **动作参数里的寻址**（`docs/04 §1.5` / `§1.2.7.3`）。
 *
 * 文档原话：「注意 `actions` 里的 `subject: "subject:newapi"` —— **动作的目标也用同一套寻址**，
 * 避免『判定一套、动作另一套』的割裂。」
 *
 * ★ 本文件钉住的是**接线**（`resolveActionTargets` 早已实现，但此前零外部引用）：
 *   ① 寻址串必须被换成**具体 `externalId`** 才交给 handler；
 *   ② ★★ 解析不出来时**不能执行** —— 把 `'subject:newapi'` 这个**字符串**交给下游，
 *      下游要么看不懂、要么当普通值写进去（= **改错目标**）。失败并留下原因，比猜安全；
 *   ③ 普通参数（`{ group: 'contributor' }`）**不得**被误判成寻址。
 *
 * ★★ **本文件还固化了一条文档↔实现不一致的结论**（见最后一个测试）：
 *   文档的**字面示例** `subject: "subject:newapi"` **没有路径**，而寻址语法**要求路径**
 *   （`addressing.ts` 的 `validateAddress` 把空路径判为 `empty_path` **error**）。
 *   同一处文档的注释写着该值应是 `{用户ID}（解析后的主体引用）`——
 *   而**动作目标实际上来自计划主体**（`externalIdOf(context) ?? context.userId`），
 *   并不是从 `params['subject']` 读出来的。所以：
 *     · 原则（动作目标用同一套寻址）= **已实现**（`ActionExecutor` 解析 `TARGET_PARAM_KEYS`）；
 *     · 字面示例 = **写错了**，合法写法必须带路径（如 `subject:newapi.group`）。
 *   本文件把两者**都**钉住：合法写法能解析、文档字面写法**大声失败**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActionExecutor,
  ActionRegistry,
  DEFAULT_RETRY,
  InMemoryActionLogStore,
  type ActionContext,
  type ActionResult,
} from '../src/core/action-executor.ts';
import { resolveActionTargets } from '../src/policy/action-addressing.ts';
import type { BindingResolver } from '../src/policy/addressing.ts';

/** 记录 handler **实际收到**的参数——本文件的断言对象 */
function spyHandler(seen: Record<string, unknown>[]) {
  return {
    async execute(context: ActionContext): Promise<ActionResult> {
      seen.push({ ...context.params });
      return { status: 'succeeded' };
    },
  };
}

const bindingRecord = (
  externalId: string,
  status: 'active' | 'revoked' | 'pending' = 'active',
) => ({ userId: 'user-1', pluginId: 'newapi', instanceKey: 'default', externalId, status });

function resolverOf(record: ReturnType<typeof bindingRecord> | undefined): BindingResolver {
  return { find: async () => record };
}

function makeExecutor(options: { handler: unknown; bindings?: BindingResolver }) {
  const registry = new ActionRegistry();
  registry.register('checkin:grant', options.handler as never);
  return new ActionExecutor({
    registry,
    log: new InMemoryActionLogStore(),
    retry: DEFAULT_RETRY,
    sleep: async () => undefined,
    now: () => new Date('2025-06-01T00:00:00Z'),
    ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
  });
}

async function run(
  executor: ActionExecutor,
  params: Record<string, unknown>,
): Promise<{ status: string; error?: string }> {
  const plan = executor.buildPlan({
    siteId: 'site-1',
    userId: 'user-1',
    policyId: 'policy-1',
    actionSeq: 7,
    actions: [{ action: 'checkin:grant', params }],
  });
  const outcome = await executor.execute(plan);
  const step = outcome.steps[0]!;
  return { status: step.status, ...(step.reason === undefined ? {} : { error: step.reason }) };
}

// ─────────────────────── ① 寻址被解析 ───────────────────────

test('★★ 寻址参数 → handler 收到的是**具体 externalId**（不是寻址串）', async () => {
  const seen: Record<string, unknown>[] = [];
  const executor = makeExecutor({
    handler: spyHandler(seen),
    bindings: resolverOf(bindingRecord('ext-42')),
  });

  const result = await run(executor, { target: 'subject:newapi.group' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(
    seen[0],
    { target: 'ext-42' },
    '★ 交给 handler 的必须是下游认识的具体 id，而不是寻址串本身',
  );
});

test('★ 寻址参数与普通参数**共存**时各自正确', async () => {
  const seen: Record<string, unknown>[] = [];
  const executor = makeExecutor({
    handler: spyHandler(seen),
    bindings: resolverOf(bindingRecord('ext-42')),
  });

  await run(executor, { subject: 'subject:newapi.group', group: 'vip', retries: 2 });
  assert.deepEqual(seen[0], { subject: 'ext-42', group: 'vip', retries: 2 });
});

test('★ 显式实例键（`subject:newapi@tenant-b.group`）影响绑定查找', async () => {
  const seen: Record<string, unknown>[] = [];
  let asked: { pluginId: string; instanceKey: string } | undefined;
  const executor = makeExecutor({
    handler: spyHandler(seen),
    bindings: {
      find: async (_userId, pluginId, instanceKey) => {
        asked = { pluginId, instanceKey };
        return bindingRecord('ext-tenant-b');
      },
    },
  });

  await run(executor, { target: 'subject:newapi@tenant-b.group' });
  assert.deepEqual(asked, { pluginId: 'newapi', instanceKey: 'tenant-b' });
  assert.equal(seen[0]!['target'], 'ext-tenant-b');
});

// ─────────────────────── ② 解析不出来 → 不执行 ───────────────────────

test('★★★ 未装配绑定解析器 → 动作**失败**，且 handler **一次都没被调用**', async () => {
  const seen: Record<string, unknown>[] = [];
  const executor = makeExecutor({ handler: spyHandler(seen) }); // 没有 bindings

  const result = await run(executor, { target: 'subject:newapi.group' });
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /未装配绑定解析器/);
  assert.deepEqual(
    seen,
    [],
    '★★ 绝不能把寻址串原样交给下游——那等于让下游去猜目标（可能改错对象）',
  );
});

test('★★★ 绑定不存在 → 失败（不降级成"原样传字符串"）', async () => {
  const seen: Record<string, unknown>[] = [];
  const executor = makeExecutor({
    handler: spyHandler(seen),
    bindings: resolverOf(undefined),
  });

  const result = await run(executor, { target: 'subject:newapi.group' });
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /no_binding/);
  assert.deepEqual(seen, []);
});

test('★★ **已撤销的绑定**不能支撑动作（与求值侧的因果纪律一致）', async () => {
  const seen: Record<string, unknown>[] = [];
  const executor = makeExecutor({
    handler: spyHandler(seen),
    bindings: resolverOf(bindingRecord('ext-42', 'revoked')),
  });

  const result = await run(executor, { target: 'subject:newapi.group' });
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /revoked/);
  assert.deepEqual(seen, []);
});

// ─────────────────────── ③ 不误判 ───────────────────────

test('★ 普通参数**不得**被误判成寻址（`{ group: "contributor" }` 原样传递）', async () => {
  const seen: Record<string, unknown>[] = [];
  // 故意**不装配** bindings：若这里被误判，动作会失败
  const executor = makeExecutor({ handler: spyHandler(seen) });

  const result = await run(executor, { group: 'contributor' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(seen[0], { group: 'contributor' });
});

test('★ 非目标字段名里的寻址串也**不**被解析（保守识别）', async () => {
  const seen: Record<string, unknown>[] = [];
  const executor = makeExecutor({ handler: spyHandler(seen) });

  // `note` 不在 `TARGET_PARAM_KEYS` 里 → 原样保留，且不因缺 bindings 而失败
  const result = await run(executor, { note: 'subject:newapi.group' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(seen[0], { note: 'subject:newapi.group' });
});

// ─────────────────────── ④ 文档字面示例（固化不一致结论）───────────────────────

test('★★★ 文档的字面示例 `subject: "subject:newapi"`（**无路径**）→ **大声失败**，绝不透传', async () => {
  const seen: Record<string, unknown>[] = [];
  const executor = makeExecutor({
    handler: spyHandler(seen),
    // 即使装配了 bindings 也必须失败：**语法**就不合法，与绑定存不存在无关
    bindings: resolverOf(bindingRecord('ext-42')),
  });

  // ① 解析层：无路径被明确报为语法错误（`validateAddress` 也把空路径判为 error）
  const parsed = resolveActionTargets({ subject: 'subject:newapi' });
  assert.equal(parsed.targets.length, 0, '★ 无路径的地址**不是**合法寻址');
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0]!, /缺少 '\.' 分隔的路径/);
  assert.deepEqual(parsed.plainParams, { subject: 'subject:newapi' }, '★ 原值保留，不篡改');

  // ② 执行层：失败 + handler 未被调用（**不允许**把 'subject:newapi' 这个字符串发给下游）
  const result = await run(executor, { subject: 'subject:newapi' });
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /缺少 '\.' 分隔的路径/);
  assert.deepEqual(seen, []);

  // ③ 对照：带路径的合法写法能解析（说明上面的失败**只**因为语法，而非能力缺失）
  assert.equal(resolveActionTargets({ subject: 'subject:newapi.group' }).targets.length, 1);
});
