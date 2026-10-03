/**
 * ★ P0-3：邮箱准入规则（`ag_email_rules`）—— 此前**零读写**。
 *
 * ★ 本文件要证明的核心是**两个安全默认**（写错了会静默放行）：
 *   ① **配置了白名单（存在 allow 规则）却未命中 → 拒绝**——否则白名单等于没配；
 *   ② **完全没配规则 → 允许**——否则启用本功能会让所有人都注册不了。
 * ★ 另外证明：**非法正则只让那一条不生效**，不让整个准入判定炸掉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  decideEmailAdmission,
  InMemoryEmailRuleStore,
  matchesEmailRule,
  type EmailRule,
} from '../src/core/email-rules.ts';
import { createDb } from '../src/db/pool.ts';
import { DbEmailRuleStore } from '../src/db/email-rule-adapter.ts';

const T0 = new Date('2026-09-26T00:00:00Z');

const ruleOf = (over: Partial<EmailRule> = {}): EmailRule => ({
  id: randomUUID(),
  listType: 'allow',
  matchType: 'suffix',
  pattern: 'example.com',
  priority: 100,
  enabled: true,
  createdAt: T0,
  ...over,
});

// ─────────────────────────── 判定 ───────────────────────────

test('四种匹配类型都生效（exact / suffix / glob / regex）', () => {
  assert.equal(matchesEmailRule(ruleOf({ matchType: 'exact', pattern: 'a@b.com' }), 'A@B.com'), true);
  assert.equal(matchesEmailRule(ruleOf({ matchType: 'suffix', pattern: '@edu.cn' }), 'x@stu.edu.cn'), true);
  assert.equal(matchesEmailRule(ruleOf({ matchType: 'glob', pattern: '*@*.edu.cn' }), 'a@b.edu.cn'), true);
  assert.equal(matchesEmailRule(ruleOf({ matchType: 'regex', pattern: '^[a-z]+@corp\\.com$' }), 'abc@corp.com'), true);
});

test('★ glob 里的 `.` 被**转义**（不是通配符）', () => {
  const rule = ruleOf({ matchType: 'glob', pattern: '*.edu.cn' });
  assert.equal(matchesEmailRule(rule, 'a@b.edu.cn'), true);
  assert.equal(matchesEmailRule(rule, 'a@b.eduXcn'), false, '★ `.` 必须当字面量，否则会放过别的域名');
});

test('★ 非法正则**只让那一条不生效**，不抛错', () => {
  const broken = ruleOf({ matchType: 'regex', pattern: '([unclosed' });
  assert.doesNotThrow(() => matchesEmailRule(broken, 'a@b.com'));
  assert.equal(matchesEmailRule(broken, 'a@b.com'), false);
  // 坏规则不命中 → 落到默认判定（这里还有一条 allow，所以拒绝）
  const decision = decideEmailAdmission([broken, ruleOf({ pattern: 'ok.com' })], 'a@b.com');
  assert.equal(decision.allowed, false);
});

test('allow 命中 → 允许；deny 命中 → 拒绝', () => {
  const allow = ruleOf({ listType: 'allow', pattern: 'good.com' });
  assert.equal(decideEmailAdmission([allow], 'a@good.com').allowed, true);

  const deny = ruleOf({ listType: 'deny', pattern: 'bad.com' });
  const mixed = decideEmailAdmission([allow, deny], 'a@bad.com');
  assert.equal(mixed.allowed, false);
  assert.match(mixed.reason, /命中拒绝规则/);
});

test('★ `priority` 决定顺序：小者先命中即定论（显式优先级就是表达手段）', () => {
  const denyFirst = ruleOf({ listType: 'deny', matchType: 'glob', pattern: '*', priority: 10 });
  const allowLater = ruleOf({ listType: 'allow', matchType: 'glob', pattern: '*', priority: 100 });
  assert.equal(
    decideEmailAdmission([allowLater, denyFirst], 'a@b.com').allowed,
    false,
    '★ priority=10 的 deny 先命中 → 拒绝（尽管 priority=100 的 allow 也命中）',
  );

  const allowFirst = ruleOf({ listType: 'allow', matchType: 'glob', pattern: '*', priority: 10 });
  const denyLater = ruleOf({ listType: 'deny', matchType: 'glob', pattern: '*', priority: 100 });
  assert.equal(decideEmailAdmission([denyLater, allowFirst], 'a@b.com').allowed, true);
});

test('★★ 安全默认 ①：**存在 allow 规则但未命中 → 拒绝**（白名单模式）', () => {
  const decision = decideEmailAdmission([ruleOf({ pattern: 'corp.com' })], 'someone@gmail.com');
  assert.equal(decision.allowed, false, '★ 配了白名单却放行未命中者 = 白名单失效');
  assert.match(decision.reason, /未命中任何允许规则/);
});

test('★★ 安全默认 ②：**完全没配规则 → 允许**（不启用闸门不影响既有行为）', () => {
  const decision = decideEmailAdmission([], 'anyone@anywhere.com');
  assert.equal(decision.allowed, true);
  assert.match(decision.reason, /未配置白名单规则/);
});

test('disabled 的规则被忽略（deny 也如此）', () => {
  const disabledDeny = ruleOf({ listType: 'deny', matchType: 'glob', pattern: '*', enabled: false });
  assert.equal(decideEmailAdmission([disabledDeny], 'a@b.com').allowed, true);
});

// ─────────────────────────── 内存存储 ───────────────────────────

test('内存 store：put / list（按 priority 排序）/ remove', async () => {
  const store = new InMemoryEmailRuleStore();
  await store.put(ruleOf({ id: 'r2', priority: 200 }));
  await store.put(ruleOf({ id: 'r1', priority: 10 }));
  assert.deepEqual((await store.list()).map((r) => r.id), ['r1', 'r2']);
  await store.remove('r1');
  assert.deepEqual((await store.list()).map((r) => r.id), ['r2']);
});

// ─────────────────────────── PG 存储 ───────────────────────────

const SITE = '11111111-1111-1111-1111-111111111111';
const OTHER_SITE = '22222222-2222-2222-2222-222222222222';

async function createTable(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
  await db.exec(`
    CREATE TABLE ag_email_rules (
      site_id uuid NOT NULL,
      id uuid PRIMARY KEY,
      list_type varchar(16) NOT NULL,
      match_type varchar(16) NOT NULL,
      pattern varchar(255) NOT NULL,
      priority integer NOT NULL DEFAULT 100,
      note varchar(255) NULL,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (site_id, match_type, pattern)
    );
  `);
}

test('★ PG store：put → list（`createdAt` 往返为 Date）→ remove', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const store = new DbEmailRuleStore(db, SITE);
  const rule = ruleOf({ id: randomUUID(), note: '公司邮箱白名单' });
  await store.put(rule);

  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.pattern, 'example.com');
  assert.equal(rows[0]!.note, '公司邮箱白名单');
  assert.equal(rows[0]!.createdAt instanceof Date, true, '★ 日期必须还原为 Date');
  assert.equal(rows[0]!.enabled, true);

  // 幂等更新（同 id 覆盖）
  await store.put({ ...rule, priority: 5, enabled: false });
  const updated = await store.list();
  assert.equal(updated.length, 1, '★ 同 id 不该堆两条');
  assert.equal(updated[0]!.priority, 5);
  assert.equal(updated[0]!.enabled, false);

  await store.remove(rule.id);
  assert.deepEqual(await store.list(), []);
});

test('★ PG store：站点隔离（另一个站点看不到、也删不掉本站点的规则）', async (t) => {
  const db = await createDb();
  t.after(async () => {
    await db.close();
  });
  await createTable(db);

  const siteA = new DbEmailRuleStore(db, SITE);
  const siteB = new DbEmailRuleStore(db, OTHER_SITE);
  const rule = ruleOf({ id: randomUUID() });
  await siteA.put(rule);

  assert.deepEqual(await siteB.list(), [], '★ 站点 B 不得看到站点 A 的准入规则');
  await siteB.remove(rule.id); // 跨站点删除必须是**做不到**的
  assert.equal((await siteA.list()).length, 1, '★ 站点 B 的 remove 不该删掉站点 A 的规则');
});
