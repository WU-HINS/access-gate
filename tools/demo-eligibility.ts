#!/usr/bin/env node
/**
 * tools/demo-eligibility.ts —— M1「第一个可演示价值」的可复跑演示。
 *
 * 用法：
 *   node --experimental-strip-types tools/demo-eligibility.ts alice@tsinghua.edu.cn
 *   node --experimental-strip-types tools/demo-eligibility.ts alice@gmail.com
 *   node --experimental-strip-types tools/demo-eligibility.ts alice@tsinghua.edu.cn --checked-in
 *
 * 它做什么：把四层真正串起来跑一遍，并把「我的资格」渲染成**用户可读**的文本：
 *   ① `email-domain` 内置插件求值（零外部依赖）→ ② FactPipeline 落库（带 TTL）
 *   → ③ 策略求值（三态 + 结果树）→ ④ 资格视图
 *
 * 为什么值得单独做一个 demo：M1 的验收标准是**用户能看到「差哪一项」**。
 * 单测能证明字段正确，但只有真正渲染一次，才能看出「这句话对人是否可读」——
 * 这正是 docs/07 把 M1 定义为「垂直切片」而不是「若干模块」的原因。
 */

import { EMAIL_DOMAIN_MANIFEST, evaluateEmailDomain } from '../src/plugin/builtin/email-domain.ts';
import { FactPipeline, InMemoryFactStore } from '../src/plugin/host-api.ts';
import { validateManifest } from '../src/plugin/manifest.ts';
import { validatePolicy, type PluginRegistry, type PolicyDocument } from '../src/policy/model.ts';
import { collectFactSnapshot, evaluateEligibility } from '../src/policy/eligibility.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const EMAIL_CONFIG = {
  allowDomains: ['*.edu.cn', '*.edu', '*.ac.uk'],
  denyDomains: ['*.evil.com'],
  requireVerified: true,
};

/** 「教育邮箱解锁签到」——与 docs/07 §5 场景 A 一致 */
const EDU_POLICY: PolicyDocument = {
  code: 'edu-unlock-checkin',
  name: '教育邮箱解锁签到',
  version: 3,
  priority: 10,
  spec: {
    match: { eq: { 'user.status': 'active' } },
    requirements: {
      expression: {
        all: [
          { $label: '教育邮箱', matches: { 'fact.email.domain': ['*.edu.cn', '*.edu', '*.ac.uk'] } },
          { $label: '邮箱已验证', eq: { 'fact.email.verified': true } },
        ],
      },
    },
    actions: {
      onSatisfied: [{ action: 'checkin:grant', params: { scope: 'daily' } }],
      onUnsatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'default' } }],
    },
  },
};

/** 「每日签到」——问的就是「有没有签到」 */
const CHECKIN_POLICY: PolicyDocument = {
  code: 'daily-checkin',
  name: '每日签到',
  version: 1,
  priority: 20,
  spec: {
    missingPolicy: 'false',
    requirements: { expression: { $label: '尚未解锁签到', exists: { 'fact.checkin.last_date': true } } },
    actions: { onSatisfied: [{ action: 'checkin:grant' }] },
  },
};

/** 「GitHub 贡献者」——依赖尚未接入的插件，用于演示 indeterminate 的展示 */
const GITHUB_POLICY: PolicyDocument = {
  code: 'github-contributor',
  name: 'GitHub 贡献者',
  version: 1,
  priority: 30,
  spec: {
    requirements: {
      expression: { $label: 'GitHub 总 star 数 ≥ 100', gte: { 'fact.github.total_stars': 100 } },
    },
    actions: { onSatisfied: [{ action: 'newapi-set-group:set_group', params: { group: 'vip2' } }] },
  },
};

/** `checkin` 内置插件（local 求值）：产出签到事实 */
const CHECKIN_MANIFEST = validateManifest({
  apiVersion: 'gate.plugin/v1',
  kind: 'channel',
  id: 'checkin',
  name: '每日签到',
  version: '1.0.0',
  runtime: 'declarative',
  local: true,
  factTtl: '1d',
  factSchema: {
    type: 'object',
    properties: { last_date: { type: 'string', title: '最近签到日期' } },
    required: ['last_date'],
  },
});

function registry(): PluginRegistry {
  return {
    installedPlugins: () => ['email', 'checkin', 'github'],
    knownFactKeys: () => [
      'fact.email.domain',
      'fact.email.is_edu',
      'fact.email.matched_rule',
      'fact.email.verified',
      'fact.checkin.last_date',
      'fact.github.total_stars',
    ],
    knownActions: () => ['newapi-set-group:set_group', 'checkin:grant'],
  };
}

const ICON: Record<string, string> = { true: '✅', false: '❌', indeterminate: '❓' };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((a) => a.includes('@')) ?? 'alice@tsinghua.edu.cn';
  const checkedIn = args.includes('--checked-in');
  const now = new Date();

  console.log('═'.repeat(72));
  console.log('access-gate · 我的资格（M1 垂直切片演示）');
  console.log('═'.repeat(72));
  console.log(`主体    : alice（${email}）`);
  console.log(`时间基准: ${now.toISOString()}`);
  console.log('');

  // ── ① 采集：email-domain 插件（零外部依赖，纯本地求值）──
  // ★★ **主体 id 必须与下游一致**（下面 `collectFactSnapshot(..., 'alice', ...)` 与
  //    `store.get('alice', ...)` 用的都是 `alice`）。
  //    此前这里写的是 `'demo-user'` —— 事实写进 `demo-user` 的空间、却从 `alice` 的空间读，
  //    于是**快照恒为 0 个事实**，演示里每条策略都显示「待确认」，
  //    M1 的核心验收（"用户能看到差哪一项" + 已达成的那条）**实际上看不到**。
  //    ★ 这类"读写主体不一致"在真实链路上同样静默：不报错，只是永远取不到值。
  const SUBJECT = 'alice';
  const manifest = validateManifest(EMAIL_DOMAIN_MANIFEST);
  const store = new InMemoryFactStore();
  const pipeline = new FactPipeline({ store, manifest, userId: SUBJECT });
  const facts = evaluateEmailDomain({ email, emailVerified: true, config: EMAIL_CONFIG });
  if (facts === null) {
    console.log(`⚠️  邮箱 '${email}' 形状非法，无法采集事实（按 missing 处理）`);
    return;
  }
  await pipeline.emit({ ...facts }, now);
  console.log(`① 采集    : email-domain 插件 → domain=${facts.domain} matched=${facts.matched_rule}`);

  // 签到事实：用 --checked-in 模拟已签到（★ 必须走 checkin 自己的管线——
  // 事实管线按 manifest 的 factSchema 校验，用 email 的管线写签到事实会被正确拒绝）
  const checkinPipeline = new FactPipeline({ store, manifest: CHECKIN_MANIFEST, userId: SUBJECT });
  if (checkedIn) {
    await checkinPipeline.emit({ last_date: now.toISOString().slice(0, 10) }, now);
    console.log('            + checkin 插件 → 已签到');
  } else {
    console.log('            + checkin 插件 → 无签到记录（未采集）');
  }

  // ── ② 快照 ──
  const collection = await collectFactSnapshot(
    store,
    [{ pluginId: 'email', fields: ['domain', 'is_edu', 'matched_rule', 'verified'], ttl: '30d' }],
    now,
    // ★ 参数顺序：`(store, sources, now, userId, logger?)`——主体必填在前
    SUBJECT,
    silentLogger,
  );
  const values = { ...collection.snapshot.values };
  if (checkedIn) {
    const record = await store.get(SUBJECT, 'checkin', 'last_date');
    if (record !== undefined) values['fact.checkin.last_date'] = record.value;
  }
  console.log(`② 快照    : ${Object.keys(values).length} 个事实可用${collection.expired.length > 0 ? `，${collection.expired.length} 个已过期` : ''}`);

  // ── ③ 发布前校验 ──
  const policies = [EDU_POLICY, CHECKIN_POLICY, GITHUB_POLICY];
  let allValid = true;
  for (const policy of policies) {
    const result = validatePolicy(policy, registry());
    if (result.issues.length > 0) {
      allValid = false;
      console.log(`③ 校验    : ❌ 策略 '${policy.code}' 有 ${result.issues.length} 个问题`);
      for (const issue of result.issues) console.log(`             - ${issue.path}: ${issue.message}`);
    }
  }
  if (allValid) console.log('③ 校验    : ✅ 3 条策略通过发布前门禁（引用的事实与动作均已声明）');

  // ── ④ 求值 + 渲染 ──
  const report = evaluateEligibility({
    policies,
    user: { status: 'active', email_verified: true, username: 'alice' },
    facts: { values, collectedAt: collection.snapshot.collectedAt },
    now,
  });

  console.log('');
  console.log('─'.repeat(72));
  console.log('我的资格');
  console.log('─'.repeat(72));
  for (const result of report.results) {
    const decision = result.evaluation.decision;
    const badge =
      decision === 'satisfied' ? '已达成' : decision === 'unsatisfied' ? '未达成' : decision === 'indeterminate' ? '待确认' : decision === 'not_applicable' ? '不适用' : '异常';
    console.log(`\n【${result.name ?? result.code}】${badge}`);
    if (result.evaluation.decision === 'not_applicable') {
      console.log('  （本策略不适用于该主体）');
      continue;
    }
    for (const item of result.view.items) {
      const icon = ICON[item.state] ?? '•';
      const detail =
        item.state === 'false' && item.actual !== undefined
          ? `（当前 ${JSON.stringify(item.actual)}，需要 ${JSON.stringify(item.expected)}）`
          : item.state === 'indeterminate'
            ? '（关键事实缺失，请稍后重试或完成绑定）'
            : '';
      console.log(`  ${icon} ${item.label}${detail}`);
    }
    if (result.evaluation.actions.length > 0) {
      console.log(`  → 将执行：${result.evaluation.actions.map((a) => a.action).join(', ')}`);
    } else if (result.evaluation.decision === 'indeterminate') {
      console.log('  → 不执行任何动作（无法判定时不推进状态）');
    }
  }

  console.log('');
  console.log('─'.repeat(72));
  console.log(`进度：${report.progress.satisfied} / ${report.progress.total} 条策略已达成`);
  if (report.todos.length > 0) {
    console.log(`待完成：${report.todos.join('；')}`);
  }
  console.log('─'.repeat(72));
  console.log('');
  console.log(`提示：换邮箱试试 → node --experimental-strip-types tools/demo-eligibility.ts alice@gmail.com`);
  console.log(`      模拟已签到 → node --experimental-strip-types tools/demo-eligibility.ts ${email} --checked-in`);
}

await main();
