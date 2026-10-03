/**
 * 三个 UI 渲染器验收（M4-9）。
 *
 * 验收标准（docs/07 原文）：**「插件渲染异常不白屏；样式不污染宿主」**。
 *
 * 因此本文件的断言集中在两处：
 *   ① **降级**：任何失败路径都必须产出「一张说明卡」而不是空串；
 *   ② **隔离**：Shadow DOM / `sandbox` 属性 / 转义 —— 都是**架构级**保障，
 *      而不是「请插件遵守」的约定。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptBridgeMessage,
  contentFingerprint,
  escapeHtml,
  loadRemoteModule,
  renderByMode,
  renderDeclarative,
  renderFallbackCard,
  renderMarkdownSafe,
  renderPluginIframe,
  renderTemplate,
  type Block,
} from '../src/plugin/renderers.ts';

const POLICY = { cspAllowlist: ['https://plugins.example.com'] };

// ═══════════════════════════ DeclarativeRenderer ═══════════════════════════

test('★ M4-9：所有插值都被 **HTML 转义**（XSS 载荷不原样输出）', () => {
  const blocks: Block[] = [
    { type: 'stats', items: [{ label: '<script>alert(1)</script>', value: '"><img onerror=x>' }] },
    { type: 'table', columns: ['<b>列</b>'], rows: [['<i>值</i>']] },
    { type: 'action', label: '<svg onload=alert(1)>', method: 'GET', url: '/x?a=1&b=2' },
    { type: 'section', title: '<script>', blocks: [{ type: 'markdown', text: 'safe' }] },
  ];
  const html = renderDeclarative(blocks, 'p');
  for (const payload of ['<script>alert(1)</script>', '<img onerror=x>', '<svg onload=alert(1)>', '<i>值</i>']) {
    assert.equal(html.includes(payload), false, `★ 不得原样输出：${payload}`);
  }
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;b=2/, 'URL 里的 & 也要转义');
});

test('★ M4-9：**模板插值转义** —— 用户昵称含脚本时不能在别人页面上执行', () => {
  const html = renderTemplate('你好 {userName}，你有 {count} 条消息', {
    userName: '<img src=x onerror=alert(document.cookie)>',
    count: 3,
  });
  assert.equal(html.includes('<img src=x'), false, '★ 这是最典型的存储型 XSS 路径');
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /你好 /);
  assert.match(html, /3/);
  // 未提供的变量渲染为空（不留下字面 {name}）
  assert.equal(html.includes('{missing}'), false);
  assert.equal(renderTemplate('{missing}', {}).includes('{missing}'), false);
});

test('★ M4-9：markdown **先转义、再做替换**（顺序不能反）', () => {
  // 输入里的 <b> 必须是**文本**，不能被当成语法
  const html = renderMarkdownSafe('这是 <b>加粗</b> 与 **真加粗**');
  assert.equal(html.includes('<b>加粗</b>'), false, '★ 输入标签被转义成文本');
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /<strong>真加粗<\/strong>/, '白名单语法仍然生效');
  // 行内代码
  assert.match(renderMarkdownSafe('用 `npm test` 跑测试'), /<code>npm test<\/code>/);
});

test('★ M4-9：markdown 链接**只允许 http(s) 与相对路径**（`javascript:` 被拒）', () => {
  const ok = renderMarkdownSafe('[文档](https://example.com/a)');
  assert.match(ok, /href="https:\/\/example\.com\/a"/);
  assert.match(ok, /rel="noopener noreferrer"/);
  assert.match(renderMarkdownSafe('[本地](/docs/a)'), /href="\/docs\/a"/);

  const evil = renderMarkdownSafe('[点我](javascript:alert(1))');
  assert.equal(evil.includes('javascript:'), false, '★ javascript: 必须被拒');
  assert.match(evil, /href="#"/);
});

test('★ M4-9：**单块失败只降级该块**（不白屏，兄弟块正常渲染）', () => {
  // 构造一个会让渲染抛错的块：stats 的 items 不是数组
  const bad = { type: 'stats', items: null } as unknown as Block;
  const blocks: Block[] = [
    { type: 'markdown', text: '前一屏正常内容' },
    bad,
    { type: 'markdown', text: '后一屏也正常' },
  ];
  const html = renderDeclarative(blocks, 'broken-plugin');
  assert.match(html, /前一屏正常内容/, '★ 前面的块不受影响');
  assert.match(html, /后一屏也正常/, '★ 后面的块也不受影响');
  assert.match(html, /ag-fallback/, '★ 坏块降级为说明卡');
  assert.match(html, /「内容块」暂时无法显示/);
  assert.equal(html.trim().length > 0, true, '★ 绝不返回空串（那就是白屏）');
});

test('★ M4-9：降级卡说明「其它内容不受影响」且**不含堆栈**', () => {
  const card = renderFallbackCard({ pluginId: 'checkin', title: '签到状态', detail: '网络超时' });
  assert.match(card, /「签到状态」暂时无法显示/);
  assert.match(card, /其它内容不受影响/);
  assert.match(card, /data-plugin="checkin"/);
  assert.match(card, /role="alert"/, '无障碍：应作为告警被读出');
  assert.equal(card.includes('at Object.'), false, '不含堆栈');
});

test('M4-9：九种块都能渲染（覆盖 docs/06 §10.7.2 的清单）', () => {
  const blocks: Block[] = [
    { type: 'stats', items: [{ label: 'a', value: 1, hint: 'h' }] },
    { type: 'action', label: '签到', method: 'POST', url: '/api/x', confirm: '确定？' },
    { type: 'form', fields: [{ name: 'n', label: '名字', required: true }], submitLabel: '保存' },
    { type: 'table', columns: ['c'], rows: [[1]] },
    { type: 'chart', kind: 'bar', points: [10, 50], label: '近 7 天' },
    { type: 'calendar', days: [{ date: '2025-06-01', checked: true }] },
    { type: 'markdown', text: '**粗**' },
    { type: 'tabs', tabs: [{ label: 'T1', blocks: [{ type: 'markdown', text: 'x' }] }, { label: 'T2', blocks: [] }] },
    { type: 'section', title: 'S', blocks: [{ type: 'markdown', text: 'y' }] },
    { type: 'template', text: '你好 {n}', vars: { n: 'A' } },
  ];
  const html = renderDeclarative(blocks, 'p');
  for (const marker of ['ag-stats', 'ag-action', 'ag-form', 'ag-table', 'ag-chart', 'ag-calendar', 'ag-md', 'ag-tabs', 'ag-section', 'ag-template']) {
    assert.match(html, new RegExp(marker), `缺少 ${marker}`);
  }
  assert.match(html, /data-confirm="确定？"/);
  assert.match(html, /required/, '必填字段带 required');
});

// ═══════════════════════════ RemoteModuleLoader ═══════════════════════════

test('★ M4-9：CSP 白名单**默认拒绝**（不在清单里的来源不加载）', async () => {
  const result = await loadRemoteModule({ pluginId: 'p', url: 'https://evil.example.com/bundle.js', signature: 'sig', fingerprint: 'fp' }, POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'csp_denied');
    assert.match(result.message, /不在 CSP 白名单内/);
    assert.match(result.html, /ag-fallback/, '★ 失败也要有降级卡（不白屏）');
  }
  // 非法 URL 同样被拒
  const bad = await loadRemoteModule({ pluginId: 'p', url: 'not-a-url' }, POLICY);
  assert.equal(bad.ok, false);
});

test('★ M4-9：**未签名默认拒绝**（未签名的远程代码可随时被替换）', async () => {
  const result = await loadRemoteModule({ pluginId: 'p', url: 'https://plugins.example.com/b.js' }, POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'unsigned');
    assert.match(result.message, /未签名/);
  }
});

test('★ M4-9：**有签名但没配验签函数 → 也拒绝**（不能「有签名就当验过了」）', async () => {
  const result = await loadRemoteModule({ pluginId: 'p', url: 'https://plugins.example.com/b.js', signature: 'sig', fingerprint: 'fp' }, POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'bad_signature');
    assert.match(result.message, /不能因为「有签名」就认为「验过了」/);
  }
});

test('★ M4-9：验签失败 → 拒绝；验签通过 → **挂 Shadow DOM**（样式隔离）', async () => {
  const bad = await loadRemoteModule(
    { pluginId: 'p', url: 'https://plugins.example.com/b.js', signature: 'bad', fingerprint: 'fp' },
    { ...POLICY, verify: () => false },
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.message, /可能被篡改/);

  const good = await loadRemoteModule(
    { pluginId: 'p', url: 'https://plugins.example.com/b.js', signature: 'ok', fingerprint: 'fp' },
    { ...POLICY, verify: () => true },
  );
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.shadowRoot, true);
    assert.match(good.html, /shadowrootmode="open"/, '★ Shadow DOM 是「样式不污染宿主」的架构保障');
    assert.match(good.html, /ag-remote-skeleton/, '骨架屏');
    assert.match(good.html, /aria-busy="true"/);
    assert.match(good.csp, /script-src https:\/\/plugins\.example\.com/);
    assert.match(good.csp, /default-src 'none'/, '★ CSP 默认全禁，只开白名单');
  }
});

test('M4-9：本地开发可显式允许未签名（生产应保持默认）', async () => {
  const result = await loadRemoteModule({ pluginId: 'p', url: 'https://plugins.example.com/b.js' }, { ...POLICY, allowUnsigned: true });
  assert.equal(result.ok, true);
});

// ═══════════════════════════ PluginIframe ═══════════════════════════

test('★ M4-9：iframe **不含 `allow-same-origin`**（否则隔离形同虚设）', () => {
  const result = renderPluginIframe({ pluginId: 'p', url: 'https://frame.example.com/app', title: '插件页' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.html, /sandbox="[^"]*allow-scripts/);
  assert.equal(result.html.includes('allow-same-origin'), false, '★ 不能给 same-origin：否则 iframe 脚本能读宿主 cookie/DOM');
  assert.equal(result.html.includes('allow-top-navigation'), false, '不含顶层跳转（防钓鱼）');
  assert.match(result.html, /referrerpolicy="no-referrer"/);
  assert.match(result.html, /loading="lazy"/);
});

test('★ M4-9：iframe 拒绝非 https 的第三方地址（本地开发除外）', () => {
  const insecure = renderPluginIframe({ pluginId: 'p', url: 'http://frame.example.com/app', title: 'x' });
  assert.equal(insecure.ok, false);
  if (!insecure.ok) {
    assert.equal(insecure.reason, 'insecure_url');
    assert.match(insecure.message, /必须使用 https/);
    assert.match(insecure.html, /ag-fallback/);
  }
  // 本地开发地址放行
  assert.equal(renderPluginIframe({ pluginId: 'p', url: 'http://localhost:3000/x', title: 'x' }).ok, true);
  assert.equal(renderPluginIframe({ pluginId: 'p', url: 'http://127.0.0.1:3000/x', title: 'x' }).ok, true);
  // 无法解析
  assert.equal(renderPluginIframe({ pluginId: 'p', url: 'nope', title: 'x' }).ok, false);
});

test('★ M4-9：postMessage 桥 **先查 origin 再查类型**（顺序不能反）', () => {
  const allowed = ['checkin.status', 'checkin.submit'];
  // ① 不在白名单的 origin：即使类型合法也丢弃
  const badOrigin = acceptBridgeMessage({ origin: 'https://evil.example.com', message: { type: 'checkin.status' }, expectedOrigin: 'https://frame.example.com', allowedTypes: allowed });
  assert.equal(badOrigin.ok, false);
  if (!badOrigin.ok) assert.equal(badOrigin.reason, 'bad_origin');
  // ② 白名单 origin 但未知类型
  const unknown = acceptBridgeMessage({ origin: 'https://frame.example.com', message: { type: 'evil.dump' }, expectedOrigin: 'https://frame.example.com', allowedTypes: allowed });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, 'unknown_type');
  // ③ 正常
  const ok = acceptBridgeMessage({ origin: 'https://frame.example.com', message: { type: 'checkin.status' }, expectedOrigin: 'https://frame.example.com', allowedTypes: allowed });
  assert.equal(ok.ok, true);
});

// ═══════════════════════════ 分派与兜底 ═══════════════════════════

test('★ M4-9：按 renderMode 分派到三个渲染器', async () => {
  const declarative = await renderByMode({ pluginId: 'p', renderMode: 'declarative', blocks: [{ type: 'markdown', text: 'hi' }] }, POLICY);
  assert.equal(declarative.ok, true);
  assert.match(declarative.html, /ag-md/);

  const remote = await renderByMode({ pluginId: 'p', renderMode: 'remote', url: 'https://evil.example.com/b.js' }, POLICY);
  assert.equal(remote.ok, false, 'CSP 拒绝');
  assert.match(remote.html, /ag-fallback/);

  const iframe = await renderByMode({ pluginId: 'p', renderMode: 'iframe', url: 'https://frame.example.com/app', title: 'x' }, POLICY);
  assert.equal(iframe.ok, true);
  assert.match(iframe.html, /ag-plugin-frame/);
});

test('★ M4-9：**任何渲染器抛异常都不白屏**（兜底降级卡）', async () => {
  // blocks 传成非数组 → renderDeclarative 内部抛错
  const result = await renderByMode({ pluginId: 'p', renderMode: 'declarative', blocks: null as unknown as Block[] }, POLICY);
  assert.equal(result.ok, false);
  assert.match(result.html, /ag-fallback/, '★ 兜底也要有说明卡');
  assert.match(result.html, /data-plugin="p"/);
  assert.equal(result.html.trim().length > 0, true);
});

test('M4-9：`escapeHtml` 覆盖五个危险字符；`contentFingerprint` 稳定', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(contentFingerprint('abc'), contentFingerprint('abc'));
  assert.notEqual(contentFingerprint('abc'), contentFingerprint('abd'));
});
