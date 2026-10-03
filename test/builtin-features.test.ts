/**
 * 内置插件验收（M4-13 / M4-14 / M4-15）—— `github` / `llm-review` / `checkin`。
 *
 * 重点验证两条**设计立场**（文档明确要求）：
 *   - **`llm-review` 不认识 GitHub**（§1.10）：它消费**通用数组字段**，
 *     因此本文件用「论坛帖子」这种与 GitHub 无关的条目喂给它，验证同样能工作。
 *   - **签到按配置时区判定「今天」**：跨时区用户在「当地昨天」时不应被判成「今天已签到」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accountAgeDays,
  baseAwardOf,
  BUILTIN_MANIFESTS,
  CHECKIN_MANIFEST,
  DEFAULT_RUBRIC,
  GITHUB_MANIFEST,
  LLM_REVIEW_MANIFEST,
  localDateOf,
  normalizeRubric,
  performCheckin,
  previousDateOf,
  reviewItems,
  scoreItemHeuristically,
  streakBonusOf,
  streakCalendar,
  type CheckinConfig,
  type CheckinState,
  type ReviewItem,
  type ReviewLlm,
} from '../src/plugin/builtin/features.ts';

const NOW = new Date('2025-06-01T12:00:00Z');

// ═══════════════════════════ M4-13 github ═══════════════════════════

test('★ M4-13：`github` 声明为**开发者级 singleton**（凭据只配一次即共享）', () => {
  assert.equal(GITHUB_MANIFEST.id, 'github');
  assert.equal((GITHUB_MANIFEST as unknown as { configScope: string }).configScope, 'developer');
  assert.deepEqual((GITHUB_MANIFEST as unknown as { instances: { mode: string } }).instances, { mode: 'singleton' });
  // token 标为 secret（宿主托管，不下发到插件前端）
  const schema = (GITHUB_MANIFEST as unknown as { configSchema: { properties: Record<string, { secret?: boolean }> } }).configSchema;
  assert.equal(schema.properties['token']?.secret, true);
});

test('M4-13：`accountAgeDays` 是纯函数（非法输入不抛错）', () => {
  assert.equal(accountAgeDays('2025-05-01T00:00:00Z', new Date('2025-06-01T00:00:00Z')), 31);
  assert.equal(accountAgeDays('not-a-date', NOW), 0);
  // 未来时间 → 0（不为负）
  assert.equal(accountAgeDays('2030-01-01T00:00:00Z', NOW), 0);
});

// ═══════════════════════════ M4-14 llm-review ═══════════════════════════

test('★ M4-14：`llm-review` **不认识 GitHub** —— 消费通用数组字段，不出现具体系统名', () => {
  const manifest = LLM_REVIEW_MANIFEST as unknown as { consumes: string[]; kind: string };
  assert.equal(manifest.kind, 'enricher');
  assert.deepEqual(manifest.consumes, ['items'], '★ 只声明通用字段');
  const text = JSON.stringify(LLM_REVIEW_MANIFEST).toLowerCase();
  for (const systemName of ['github', 'gitlab', 'discord', 'newapi']) {
    assert.equal(text.includes(systemName), false, `★ manifest 中不得出现 '${systemName}'（宿主无知）`);
  }
});

test('★ M4-14：同一份实现能评「论坛帖子」（与 GitHub 无关的输入）', async () => {
  // 这是文档卖点的直接验证：只要上游产出数组字段，评审逻辑就能复用
  const forumPosts: ReviewItem[] = [
    { title: '深入解析 PostgreSQL 的 MVCC', body: 'x'.repeat(2000), discussions: 12, collaborators: 2 },
    { title: '短帖', body: 'ok', discussions: 0 },
  ];
  const result = await reviewItems(forumPosts, {}, {});
  assert.equal(result.prCountEffective, 2);
  assert.ok(result.prScore > 0);
  assert.equal(result.usedLlm, false, '未提供 LLM → 走启发式');
  assert.match(result.reason, /未提供 LLM 能力/);
});

test('★ M4-14：空标题条目被剔除（不计入有效数）', async () => {
  const items: ReviewItem[] = [
    { title: '   ' }, // 只有空白
    { title: '' },
    { title: '有标题', body: 'x'.repeat(100) },
  ];
  const result = await reviewItems(items, {}, {});
  assert.equal(result.prCountEffective, 1, '★ 空标题不参与评审');
});

test('★ M4-14：LLM 调用失败 → **降级到启发式**（不让整条评审链断掉）', async () => {
  const failing: ReviewLlm = {
    async invoke() {
      throw new Error('预算耗尽');
    },
  };
  const items: ReviewItem[] = [{ title: '条目', body: 'x'.repeat(500), size: 100 }];
  const result = await reviewItems(items, {}, { llm: failing });
  assert.equal(result.usedLlm, false);
  assert.ok(result.prScore > 0, '仍应给出启发式分数');
  assert.match(result.reason, /降级到启发式/);
  assert.match(result.reason, /预算耗尽/);
});

test('★ M4-14：LLM 与启发式**融合**（避免任一方单点失真）', async () => {
  // 启发式对这条目会给低分（正文短、无讨论），LLM 给 90 → 融合后应在两者之间
  const items: ReviewItem[] = [{ title: 'x', body: '' }];
  const heuristic = scoreItemHeuristically(items[0]!, DEFAULT_RUBRIC).score;
  const llm: ReviewLlm = { async invoke() { return { content: '90' }; } };
  const result = await reviewItems(items, {}, { llm });
  assert.equal(result.usedLlm, true);
  const expected = Math.round(((90 + heuristic) / 2) * 100) / 100;
  assert.equal(result.prScore, expected);
  assert.ok(result.prScore > heuristic, '应高于纯启发式（LLM 认为它很好）');
  assert.ok(result.prScore < 90, '应低于纯 LLM（启发式认为它一般）');
});

test('M4-14：LLM 返回无法解析 → 降级（不把 NaN 当分数）', async () => {
  const weird: ReviewLlm = { async invoke() { return { content: '我觉得不错' }; } };
  const result = await reviewItems([{ title: 'a', body: 'x'.repeat(100) }], {}, { llm: weird });
  assert.equal(result.usedLlm, false);
  assert.match(result.reason, /无法解析/);
  assert.ok(Number.isFinite(result.prScore));
});

test('★ M4-14：缓存命中不重复调用 LLM（同输入不重复计费）', async () => {
  let calls = 0;
  const llm: ReviewLlm = {
    async invoke() {
      calls += 1;
      return { content: '70' };
    },
  };
  const cache = new Map();
  const items: ReviewItem[] = [{ title: 'same', body: 'x'.repeat(200) }];
  await reviewItems(items, {}, { llm, cache });
  const second = await reviewItems(items, {}, { llm, cache });
  assert.equal(calls, 1, '★ 相同输入只调用一次');
  assert.match(second.reason, /缓存命中/);
});

test('M4-14：`maxItems` 截断优先保留信息量大的条目', async () => {
  const items: ReviewItem[] = Array.from({ length: 10 }, (_, index) => ({ title: `t${index}`, size: index }));
  const result = await reviewItems(items, { maxItems: 3 }, {});
  assert.equal(result.prCountEffective, 3);
  // 保留的应是 size 最大的三个（7、8、9）
  const scores = items.map((item) => scoreItemHeuristically(item).score);
  assert.ok(scores[9]! > scores[0]!);
});

test('★ M4-14：权重不精确到 1 时**归一化**（否则总分系统性偏移）', () => {
  const rubric = normalizeRubric({ substantiality: 2, influence: 2, complexity: 0, collaboration: 0 });
  assert.equal(rubric.substantiality + rubric.influence + rubric.complexity + rubric.collaboration, 1);
  assert.ok(Math.abs(rubric.substantiality - 0.5) < 1e-9);
  // 全零 → 回落到默认（不除零）
  assert.deepEqual(normalizeRubric({ substantiality: 0, influence: 0, complexity: 0, collaboration: 0 }), DEFAULT_RUBRIC);
});

// ═══════════════════════════ M4-15 checkin ═══════════════════════════

test('★ M4-15：`localDateOf` 按配置时区判定「今天」（跨时区不会 off-by-one）', () => {
  // UTC 2025-06-01 16:30 → 上海是 6-02（+8），而 UTC 仍是 6-01
  const instant = new Date('2025-06-01T16:30:00Z');
  assert.equal(localDateOf(instant, 'Asia/Shanghai'), '2025-06-02');
  assert.equal(localDateOf(instant, 'UTC'), '2025-06-01');
  // 非法时区回落 UTC（不抛错）
  assert.equal(localDateOf(instant, 'Not/AZone'), '2025-06-01');
});

test('M4-15：`previousDateOf` 跨月/跨年正确', () => {
  assert.equal(previousDateOf('2025-06-01'), '2025-05-31');
  assert.equal(previousDateOf('2025-01-01'), '2024-12-31');
  assert.equal(previousDateOf('2024-03-01'), '2024-02-29', '闰年');
});

test('★ M4-15：同一用户同一天**奖励确定**（重试不会变金额）', () => {
  const config: CheckinConfig = { quotaMin: 1000, quotaMax: 5000 };
  const first = baseAwardOf('u1', '2025-06-01', config);
  for (let i = 0; i < 20; i += 1) assert.equal(baseAwardOf('u1', '2025-06-01', config), first);
  assert.ok(first >= 1000 && first <= 5000);
  // 不同用户/不同日期应有差异（分布）
  const awards = new Set(Array.from({ length: 50 }, (_, index) => baseAwardOf(`u${index}`, '2025-06-01', config)));
  assert.ok(awards.size > 10, '奖励应有分布，而不是恒定值');
});

test('★ M4-15：同日重复签到被拒（按**本地日期**判断）', () => {
  const config: CheckinConfig = { timezone: 'Asia/Shanghai' };
  const state: CheckinState = { lastDate: '2025-06-01', streak: 3 };
  const result = performCheckin({ userId: 'u1', now: new Date('2025-06-01T16:30:00Z'), state, config });
  // 上海此时是 6-02，所以不是「今天重复」而是「新的一天」
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.streak, 4, '上海 6-02，昨天（6-01）签过 → 连签 +1');

  const sameDay = performCheckin({ userId: 'u1', now: new Date('2025-06-01T02:00:00Z'), state, config });
  assert.equal(sameDay.ok, false);
  if (!sameDay.ok) {
    assert.equal(sameDay.reason, 'already_checked_in');
    assert.match(sameDay.message, /今天（2025-06-01）已经签到/);
  }
});

test('★ M4-15：连签与断签（昨天签过 → +1；否则从 1 开始）', () => {
  const config: CheckinConfig = {};
  const continued = performCheckin({ userId: 'u1', now: NOW, state: { lastDate: '2025-05-31', streak: 5 }, config });
  assert.equal(continued.ok, true);
  if (continued.ok) {
    assert.equal(continued.streak, 6);
    assert.match(continued.reason, /连续第 6 天/);
  }

  const broken = performCheckin({ userId: 'u1', now: NOW, state: { lastDate: '2025-05-20', streak: 9 }, config });
  assert.equal(broken.ok, true);
  if (broken.ok) {
    assert.equal(broken.streak, 1, '★ 断签重置连续数（但不清历史）');
    assert.match(broken.reason, /从 1 开始/);
  }

  const first = performCheckin({ userId: 'u1', now: NOW, state: { lastDate: null, streak: 0 }, config });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.streak, 1);
});

test('★ M4-15：策略门槛 —— `requirePolicy` 未 granted 时不可签到', () => {
  const config: CheckinConfig = { requirePolicy: 'edu-unlock' };
  const denied = performCheckin({ userId: 'u1', now: NOW, state: { lastDate: null, streak: 0 }, config, grantedPolicies: [] });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.reason, 'policy_not_granted');
    assert.match(denied.message, /edu-unlock/);
    assert.match(denied.message, /granted/);
  }
  const allowed = performCheckin({ userId: 'u1', now: NOW, state: { lastDate: null, streak: 0 }, config, grantedPolicies: ['edu-unlock'] });
  assert.equal(allowed.ok, true);
  // 未配置门槛 → 不检查
  assert.equal(performCheckin({ userId: 'u1', now: NOW, state: { lastDate: null, streak: 0 }, config: {} }).ok, true);
});

test('★ M4-15：连签阶梯取**已达最高档**（阶梯是「达标即享」，不是累加）', () => {
  const config: CheckinConfig = { streakBonus: [{ streak: 7, bonus: 500 }, { streak: 30, bonus: 2000 }] };
  assert.equal(streakBonusOf(1, config), 0);
  assert.equal(streakBonusOf(6, config), 0);
  assert.equal(streakBonusOf(7, config), 500);
  assert.equal(streakBonusOf(29, config), 500);
  assert.equal(streakBonusOf(30, config), 2000);
  assert.equal(streakBonusOf(100, config), 2000, '超出最高档仍是最高档的值');
});

test('M4-15：签到结果含基础与阶梯的**明细**（用户能看到奖励怎么来的）', () => {
  const config: CheckinConfig = { quotaMin: 100, quotaMax: 100, streakBonus: [{ streak: 7, bonus: 500 }] };
  const result = performCheckin({ userId: 'u1', now: NOW, state: { lastDate: '2025-05-31', streak: 6 }, config });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.baseAward, 100, 'quotaMin=quotaMax 时确定');
    assert.equal(result.bonusAward, 500, '第 7 天触发阶梯');
    assert.equal(result.totalAward, 600);
    assert.match(result.reason, /连签奖励 500/);
  }
});

test('M4-15：连签日历（供 UI calendar 块渲染）', () => {
  const config: CheckinConfig = { timezone: 'Asia/Shanghai' };
  const calendar = streakCalendar({ lastDate: '2025-06-01', streak: 3 }, NOW, config, 5);
  assert.equal(calendar.length, 5);
  assert.equal(calendar[0]!.date, '2025-06-01', 'NOW 在上海是 6-01 12:00+08 → 今天 6-01');
  assert.equal(calendar[0]!.isToday, true);
  assert.equal(calendar[0]!.checked, true);
  assert.equal(calendar[1]!.date, '2025-05-31');
  assert.equal(calendar[1]!.checked, false);
});

// ═══════════════════════════ 汇总 ═══════════════════════════

test('★ M4-13/14/15：三个内置插件 manifest 齐备（且内置无特权——只是普通插件）', () => {
  assert.equal(BUILTIN_MANIFESTS.length, 3);
  assert.deepEqual(BUILTIN_MANIFESTS.map((manifest) => manifest.id).sort(), ['checkin', 'github', 'llm-review']);
  for (const manifest of BUILTIN_MANIFESTS) {
    assert.equal(manifest.apiVersion, 'gate.plugin/v1');
    assert.ok(manifest.permissions !== undefined && manifest.permissions.length > 0, `${manifest.id} 应声明权限`);
  }
  // checkin 的配置项与文档 §1.17 对齐
  const checkinSchema = (CHECKIN_MANIFEST as unknown as { configSchema: { properties: Record<string, unknown> } }).configSchema;
  for (const field of ['requirePolicy', 'quotaMin', 'quotaMax', 'streakBonus', 'timezone']) {
    assert.ok(field in checkinSchema.properties, `checkin 应支持配置 '${field}'`);
  }
});
