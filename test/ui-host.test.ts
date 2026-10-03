/**
 * UI 贡献宿主验收（M4-8）—— docs/03 §1.17。
 *
 * 验收标准：**插件注册 nav/page/slot 不改前端代码**。
 * 前端只做一件事：拉 `GET /api/ui/manifest` 并按 `type` 渲染。
 *
 * 本文件的断言重点：
 *   - **★ 逐条审批**：未批准的贡献**不出现**在 manifest 里，
 *     而不是「出现但标记为未批准」——那等于把「是否展示」交给不可信的前端；
 *   - **权限校验**：没有 `ui:contribute:nav` 就不得声明 nav；
 *   - **冲突检测**：两个插件不得占同一 `type+key`，同一插件内也不得重复；
 *   - **audience 过滤**：不把 admin 入口暴露给普通用户；
 *   - **排序稳定**：同 order 时按 pluginId+key，保证多次请求结果一致。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryUiContributionStore,
  parseUiContributions,
  UiContributionError,
  UiContributionHost,
  uiContributionPermissionsOf,
} from '../src/plugin/ui-host.ts';
import type { PluginManifest } from '../src/plugin/manifest.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const NOW = new Date('2025-06-01T00:00:00Z');

function manifestOf(id: string, ui: Record<string, unknown>, permissions: string[] = ['ui:contribute:nav,page,slot']): PluginManifest {
  return { apiVersion: 'gate.plugin/v1', kind: 'feature', id, name: id, version: '1.0.0', runtime: 'process', permissions, ui } as unknown as PluginManifest;
}

const CHECKIN_UI = {
  nav: [{ id: 'checkin', label: '每日签到', icon: 'gift', path: '/checkin', audience: 'user', order: 20 }],
  pages: [{ path: '/checkin', title: '每日签到', audience: 'user', layout: 'standard', blocks: [{ type: 'stats', columns: 3 }] }],
  slot: [{ name: 'user.profile.after_stats', audience: 'user' }],
};

function makeHost(): { host: UiContributionHost; store: InMemoryUiContributionStore } {
  const store = new InMemoryUiContributionStore();
  const host = new UiContributionHost({ store, logger: silentLogger, now: () => NOW });
  return { host, store };
}

// ─────────────────────────── 权限解析 ───────────────────────────

test('M4-8：解析 `ui:contribute:nav,page,slot` 形式的权限声明', () => {
  assert.deepEqual([...uiContributionPermissionsOf(manifestOf('a', {}, ['ui:contribute:nav,page,slot']))].sort(), ['nav', 'page', 'slot']);
  assert.deepEqual([...uiContributionPermissionsOf(manifestOf('a', {}, ['ui:contribute:nav']))], ['nav']);
  // 无关权限被忽略
  assert.deepEqual([...uiContributionPermissionsOf(manifestOf('a', {}, ['route:register:/x', 'llm:invoke']))], []);
  // 空格容忍
  assert.deepEqual([...uiContributionPermissionsOf(manifestOf('a', {}, ['ui:contribute:nav, page']))].sort(), ['nav', 'page']);
});

// ─────────────────────────── 解析与校验 ───────────────────────────

test('M4-8：从 manifest.ui 提取 nav/page/slot 三类贡献', () => {
  const { contributions, issues } = parseUiContributions(manifestOf('checkin', CHECKIN_UI), { now: NOW });
  assert.equal(issues.length, 0);
  assert.deepEqual(
    contributions.map((entry) => `${entry.type}:${entry.key}`).sort(),
    ['nav:checkin', 'page:/checkin', 'slot:user.profile.after_stats'],
  );
  // ★ 新贡献默认**未批准**
  assert.ok(contributions.every((entry) => entry.approvedBy === null && entry.approvedAt === null));
  assert.ok(contributions.every((entry) => entry.enabled));
});

test('M4-8：缺少对应权限 → 拒绝并说明缺哪个', () => {
  const { issues } = parseUiContributions(manifestOf('x', CHECKIN_UI, ['ui:contribute:nav']), { now: NOW });
  const errors = issues.filter((issue) => issue.code === 'missing_permission');
  assert.equal(errors.length, 2, 'page 与 slot 都缺权限');
  assert.ok(errors.every((issue) => /ui:contribute:(page|slot)/.test(issue.message)));
});

test('M4-8：audience 非法 / key 缺失 → 明确报错', () => {
  const bad = manifestOf('bad', {
    nav: [{ id: 'a', label: 'x', audience: 'everyone' }],
    pages: [{ title: '没有 path', audience: 'user' }],
  });
  const { issues } = parseUiContributions(bad, { now: NOW });
  assert.ok(issues.some((issue) => issue.code === 'invalid_audience'));
  assert.ok(issues.some((issue) => issue.code === 'missing_key'));
});

test('M4-8：renderMode=custom 需要额外权限（自定义渲染会执行插件的前端代码）', () => {
  const custom = manifestOf('x', { nav: [{ id: 'a', label: 'x', audience: 'user', renderMode: 'custom' }] });
  const { issues } = parseUiContributions(custom, { now: NOW });
  assert.ok(issues.some((issue) => issue.code === 'custom_render_not_allowed'));

  const withPermission = manifestOf('x', { nav: [{ id: 'a', label: 'x', audience: 'user', renderMode: 'custom' }] }, [
    'ui:contribute:nav',
    'ui:render:custom',
  ]);
  assert.equal(parseUiContributions(withPermission, { now: NOW }).issues.length, 0);
});

test('M4-8：无 ui 声明的插件 → 零贡献零问题（向后兼容）', () => {
  const { contributions, issues } = parseUiContributions(manifestOf('plain', {}, []), { now: NOW });
  assert.deepEqual(contributions, []);
  assert.deepEqual(issues, []);
});

// ─────────────────────────── ★ 逐条审批 ───────────────────────────

test('★ M4-8：未批准的贡献**不出现**在 manifest（而不是出现但标记未批准）', async () => {
  const { host } = makeHost();
  await host.register(manifestOf('checkin', CHECKIN_UI));

  const manifest = await host.manifest();
  assert.deepEqual(manifest.nav, [], '★ 未批准 → 前端完全看不到');
  assert.deepEqual(manifest.pages, []);
  assert.deepEqual(manifest.slots, []);
  assert.equal(manifest.pendingApproval, 3, '待审批数应可见（管理端提示）');

  // 逐条批准 nav
  await host.approve('checkin', 'nav', 'checkin', 'admin-1');
  const after = await host.manifest();
  assert.equal(after.nav.length, 1, '批准后出现');
  assert.equal(after.pages.length, 0, '★ 其它条目仍不可见（逐条审批）');
  assert.equal(after.pendingApproval, 2);
  assert.equal(after.nav[0]!['label'], '每日签到');
  assert.equal(after.nav[0]!['pluginId'], 'checkin', '注入来源插件（前端可能需要区分）');
});

test('M4-8：批准不存在的贡献 → 报错（不静默）', async () => {
  const { host } = makeHost();
  await host.register(manifestOf('checkin', CHECKIN_UI));
  await assert.rejects(host.approve('checkin', 'nav', 'ghost', 'admin-1'), UiContributionError);
});

test('M4-8：pending 列出待审批项；未注册任何贡献时为空', async () => {
  const { host } = makeHost();
  assert.deepEqual(await host.pending(), []);
  await host.register(manifestOf('checkin', CHECKIN_UI));
  const pending = await host.pending();
  assert.equal(pending.length, 3);
  assert.ok(pending.every((entry) => entry.approvedBy === null));
});

// ─────────────────────────── 冲突检测 ───────────────────────────

test('★ M4-8：两个插件占同一 type+key → 拒绝（否则「谁生效」取决于加载顺序）', async () => {
  const { host } = makeHost();
  const first = await host.register(manifestOf('plugin-a', { nav: [{ id: 'shared', label: 'A', audience: 'user' }] }));
  assert.equal(first.ok, true);

  const second = await host.register(manifestOf('plugin-b', { nav: [{ id: 'shared', label: 'B', audience: 'user' }] }));
  assert.equal(second.ok, false);
  if (!second.ok) {
    const conflict = second.issues.find((issue) => issue.code === 'key_conflict');
    assert.ok(conflict !== undefined);
    assert.match(conflict.message, /已被插件 'plugin-a' 占用/);
  }
  // 第一个插件的贡献不受影响
  assert.equal((await host.all()).length, 1);
});

test('★ M4-8：同一插件内重复声明同一 key → 拒绝', async () => {
  const { host } = makeHost();
  const result = await host.register(
    manifestOf('dup', {
      nav: [
        { id: 'same', label: '第一次', audience: 'user' },
        { id: 'same', label: '第二次', audience: 'user' },
      ],
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((issue) => /重复声明/.test(issue.message)));
});

test('★ M4-8：注册被拒时**整体不注册**（避免「可用贡献取决于声明顺序」）', async () => {
  const { host } = makeHost();
  const result = await host.register(
    manifestOf('mixed', {
      nav: [{ id: 'good', label: '合法', audience: 'user' }],
      pages: [{ title: '缺 path', audience: 'user' }],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal((await host.all()).length, 0, '连合法的 nav 也不应注册');
});

// ─────────────────────────── audience 与开关 ───────────────────────────

test('★ M4-8：audience 过滤 —— 不把 admin 入口暴露给普通用户', async () => {
  const { host } = makeHost();
  await host.register(
    manifestOf('ops', {
      nav: [
        { id: 'user-entry', label: '用户入口', audience: 'user', order: 10 },
        { id: 'admin-panel', label: '运维面板', audience: 'admin', order: 20 },
      ],
    }),
  );
  await host.approve('ops', 'nav', 'user-entry', 'admin-1');
  await host.approve('ops', 'nav', 'admin-panel', 'admin-1');

  const forUser = await host.manifest({ audience: 'user' });
  assert.deepEqual(forUser.nav.map((entry) => entry['id']), ['user-entry'], '★ 普通用户看不到 admin 入口');

  const forAdmin = await host.manifest({ audience: 'admin' });
  assert.deepEqual(forAdmin.nav.map((entry) => entry['id']), ['admin-panel']);

  const all = await host.manifest();
  assert.equal(all.nav.length, 2, '不传 audience 则不过滤（管理端预览用）');
});

test('M4-8：setEnabled 可临时下线某条贡献（不改变审批状态）', async () => {
  const { host } = makeHost();
  await host.register(manifestOf('checkin', CHECKIN_UI));
  await host.approve('checkin', 'nav', 'checkin', 'admin-1');
  assert.equal((await host.manifest()).nav.length, 1);

  await host.setEnabled('checkin', 'nav', 'checkin', false);
  assert.equal((await host.manifest()).nav.length, 0, '禁用后不可见');
  // ★ 审批状态不变：重新启用无需再次审批
  const entry = (await host.all()).find((item) => item.type === 'nav')!;
  assert.equal(entry.approvedBy, 'admin-1', '禁用不改变审批状态');
  assert.equal(entry.enabled, false);

  await host.setEnabled('checkin', 'nav', 'checkin', true);
  assert.equal((await host.manifest()).nav.length, 1, '重新启用即恢复可见');
});

// ─────────────────────────── 排序 ───────────────────────────

test('★ M4-8：nav 按 order 排序，且同 order 时排序**稳定**（多次请求结果一致）', async () => {
  const { host } = makeHost();
  await host.register(
    manifestOf('plugin-b', {
      nav: [
        { id: 'b-late', label: 'B 靠后', audience: 'user', order: 30 },
        { id: 'b-same', label: 'B 同序', audience: 'user', order: 10 },
      ],
    }),
  );
  await host.register(
    manifestOf('plugin-a', {
      nav: [{ id: 'a-same', label: 'A 同序', audience: 'user', order: 10 }],
    }),
  );
  for (const [pluginId, key] of [
    ['plugin-a', 'a-same'],
    ['plugin-b', 'b-late'],
    ['plugin-b', 'b-same'],
  ] as const) {
    await host.approve(pluginId, 'nav', key, 'admin-1');
  }

  const ids = (await host.manifest()).nav.map((entry) => entry['id']);
  assert.deepEqual(ids, ['a-same', 'b-same', 'b-late'], 'order 10 的两个按 pluginId 稳定排序，30 的在后');

  // 多次请求结果一致（稳定性）
  const again = (await host.manifest()).nav.map((entry) => entry['id']);
  assert.deepEqual(again, ids);
});

test('M4-8：未声明 order 的 nav 排在有 order 的之后（缺省 100）', async () => {
  const { host } = makeHost();
  await host.register(
    manifestOf('p', {
      nav: [
        { id: 'no-order', label: '无 order', audience: 'user' },
        { id: 'ordered', label: '有 order', audience: 'user', order: 5 },
      ],
    }),
  );
  await host.approve('p', 'nav', 'no-order', 'admin-1');
  await host.approve('p', 'nav', 'ordered', 'admin-1');
  assert.deepEqual((await host.manifest()).nav.map((entry) => entry['id']), ['ordered', 'no-order']);
});

// ─────────────────────────── 卸载 ───────────────────────────

test('M4-8：卸载插件 → 其贡献全部移除（不留残影）', async () => {
  const { host } = makeHost();
  await host.register(manifestOf('checkin', CHECKIN_UI));
  await host.approve('checkin', 'nav', 'checkin', 'admin-1');
  assert.equal((await host.manifest()).nav.length, 1);

  const removed = await host.unregister('checkin');
  assert.equal(removed, 3);
  assert.equal((await host.all()).length, 0);
  assert.equal((await host.manifest()).nav.length, 0);
});

test('M4-8：manifest 无贡献时返回空结构（前端无需特判 null）', async () => {
  const { host } = makeHost();
  const manifest = await host.manifest();
  assert.deepEqual(manifest.nav, []);
  assert.deepEqual(manifest.pages, []);
  assert.deepEqual(manifest.slots, []);
  assert.equal(manifest.pendingApproval, 0);
  assert.equal(manifest.generatedAt, NOW.toISOString());
});

test('M4-8：page 的 spec 原样透出（前端按 layout/blocks 渲染，不需改代码）', async () => {
  const { host } = makeHost();
  await host.register(manifestOf('checkin', CHECKIN_UI));
  await host.approve('checkin', 'page', '/checkin', 'admin-1');
  const page = (await host.manifest()).pages[0]!;
  assert.equal(page['title'], '每日签到');
  assert.equal(page['layout'], 'standard');
  assert.deepEqual(page['blocks'], [{ type: 'stats', columns: 3 }], '★ 声明原文透出——前端按数据渲染');
  assert.equal(page['pluginId'], 'checkin');
});
