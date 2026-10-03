/**
 * `docs/10 P5` ③：**时间偏斜判定**（`$maxSkew`）。
 *
 * ★ 它修的是什么（文档原话）：
 * > 策略同时引用 `fact:github.total_stars`（1 小时前）与 `fact:github.account_age_days`（3 天前）
 * > → 判定基于「**半新半旧**」的组合。
 *
 * ★ 本文件要证明的核心事实：**超限时判 `indeterminate`，不是 `false`**。
 *   若判 false，就会按 H1 明确反对的方向——用"不确定"的数据去**降级**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectCollectedAtMs,
  evaluateExpression,
  type EvaluationContext,
  type Expression,
} from '../src/policy/expr.ts';

const T0 = new Date('2026-09-26T00:00:00Z');
const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000);

/** 两个事实：star 数（1 小时前）与账号年龄（3 天前） */
function contextWith(starCollectedAt: Date, ageCollectedAt: Date): EvaluationContext {
  const values: Record<string, unknown> = {
    'fact.github.total_stars': 212,
    'fact.github.account_age_days': 400,
  };
  return {
    facts: (namespace, path) => values[`fact.${namespace}.${path}`],
    user: {},
    factCollectedAt: (fullPath) =>
      ({ 'fact.github.total_stars': starCollectedAt, 'fact.github.account_age_days': ageCollectedAt })[
        fullPath
      ],
  };
}

const PAIR: Expression = {
  all: [
    { gte: { 'fact.github.total_stars': 100 } },
    { gte: { 'fact.github.account_age_days': 365 } },
  ],
};

const withSkew = (maxSkew: string): Expression =>
  ({ ...(PAIR as object), $maxSkew: maxSkew }) as unknown as Expression;

test('未声明 `$maxSkew` → 行为不变（对照组）', () => {
  const node = evaluateExpression(PAIR, { context: contextWith(hoursAgo(1), hoursAgo(72)) });
  assert.equal(node.state, 'true');
  assert.equal(node.maxSkew, undefined);
});

test('声明 `$maxSkew: 1h` 且时跨 30 分钟 → 正常判定（不受影响）', () => {
  const node = evaluateExpression(withSkew('1h'), { context: contextWith(hoursAgo(1), hoursAgo(1.5)) });
  assert.equal(node.state, 'true');
  assert.equal(node.maxSkew, undefined);
});

test('★ 声明 `$maxSkew: 1h` 且时跨 3 天 → 判 **indeterminate**（不是 false），并把原因写进结果树', () => {
  const node = evaluateExpression(withSkew('1h'), { context: contextWith(hoursAgo(1), hoursAgo(72)) });
  assert.equal(node.state, 'indeterminate', '★ 绝不能用半新半旧的数据下结论');
  assert.deepEqual(node.maxSkew, { declared: '1h', skewMs: 71 * 3_600_000 });
  assert.match(node.reason, /时跨 3\.0d/);
  assert.match(node.reason, /\$maxSkew 1h/);
  assert.match(node.reason, /indeterminate/);
});

test('恰好等于阈值 → 允许（`>` 而非 `>=`）', () => {
  const node = evaluateExpression(withSkew('2h'), { context: contextWith(hoursAgo(0), hoursAgo(2)) });
  assert.equal(node.state, 'true');
  // 超过 1ms → 拒绝
  const over = evaluateExpression(withSkew('2h'), {
    context: contextWith(hoursAgo(0), new Date(hoursAgo(2).getTime() - 1)),
  });
  assert.equal(over.state, 'indeterminate');
});

test('只有一个事实 → 不存在跨度，不受影响', () => {
  const single: Expression = {
    all: [{ gte: { 'fact.github.total_stars': 100 } }],
    $maxSkew: '1m',
  } as unknown as Expression;
  const node = evaluateExpression(single, { context: contextWith(hoursAgo(100), hoursAgo(100)) });
  assert.equal(node.state, 'true');
});

test('★ `$maxSkew` 无法解析 → 抛错（配置错误要响亮，不能静默不限制）', () => {
  assert.throws(
    () => evaluateExpression(withSkew('一小时'), { context: contextWith(hoursAgo(1), hoursAgo(72)) }),
    /无法解析/,
  );
});

test('★ 嵌套：内层节点自己的 `$maxSkew` 同样生效（每个层级都被覆盖）', () => {
  const nested: Expression = {
    all: [
      {
        all: [
          { gte: { 'fact.github.total_stars': 100 } },
          { gte: { 'fact.github.account_age_days': 365 } },
        ],
        $maxSkew: '1h',
      },
      { eq: { 'user.status': 'active' } },
    ],
  } as unknown as Expression;
  const node = evaluateExpression(nested, {
    context: { ...contextWith(hoursAgo(1), hoursAgo(72)), user: { status: 'active' } },
  });
  // 内层被判 indeterminate → 按三值真值表向上传播
  assert.equal(node.state, 'indeterminate');
  const inner = node.children?.[0];
  assert.equal(inner?.state, 'indeterminate');
  assert.deepEqual(inner?.maxSkew, { declared: '1h', skewMs: 71 * 3_600_000 });
});

test('collectCollectedAtMs：从子树收集全部叶子时间（缺 collectedAt 的叶子被跳过）', () => {
  const node = evaluateExpression(PAIR, { context: contextWith(hoursAgo(1), hoursAgo(72)) });
  const times = collectCollectedAtMs(node);
  assert.equal(times.length, 2);
  assert.equal(Math.max(...times) - Math.min(...times), 71 * 3_600_000);

  // 未提供 factCollectedAt → 收集为空（不误判）
  const bare = evaluateExpression(PAIR, {
    context: { facts: () => 1, user: {} },
  });
  assert.deepEqual(collectCollectedAtMs(bare), []);
});
