/**
 * 用户门户「我的资格」+ 管理端最小界面（M0-10 + M1-10 + M1-11 的可视化落地面）。
 *
 * ★ 为什么是**零构建**的单个 HTML（而不是 Vite + React）：
 *   本项目的立项目标是「能落地」——一条命令启动就看到东西。
 *   引入 Vite/React/Tailwind 会把「前端工具链是否可用」变成落地的**前置条件**，
 *   而 M0 阶段真正需要验证的是**判定链与文案渲染**，不是构建流程。
 *   因此这里用原生 fetch + 模板字符串渲染，`node tools/serve.ts` 即可打开。
 *   （若后续要上 Vite/React，替换本文件的渲染层即可——后端契约已经定好。）
 *
 * 页面结构：
 *   ① 「我的资格」——进度 + 逐策略逐项的 ✅/❌/❓（用户视角）
 *   ② 「管理端」——登录后可见（主体列表 / 策略列表 / 试算）
 */

export interface PortalOptions {
  demo: boolean;
  appName?: string;
}

export function renderPortalHtml(options: PortalOptions): string {
  const appName = options.appName ?? 'access-gate';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${appName} · 我的资格</title>
<style>
  :root {
    --bg: #0b0f19; --panel: #121826; --panel-2: #1a2133; --border: #263049;
    --fg: #e6ebf5; --muted: #8b97b0; --accent: #4f8cff; --ok: #34d399; --bad: #f87171; --unknown: #fbbf24;
    --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font); line-height: 1.6; }
  a { color: var(--accent); }
  header { border-bottom: 1px solid var(--border); padding: 14px 20px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header .brand { font-weight: 650; letter-spacing: .2px; }
  header .spacer { flex: 1; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 20px 64px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 17px; }
  .muted { color: var(--muted); font-size: 13px; }
  .row { display: flex; align-items: center; gap: 10px; }
  .pill { border: 1px solid var(--border); background: var(--panel-2); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
  .item { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-top: 1px dashed #1f2739; }
  .item:first-of-type { border-top: none; }
  .ic { width: 20px; text-align: center; flex: 0 0 20px; }
  .detail { color: var(--muted); font-size: 12.5px; }
  .bar { height: 8px; background: var(--panel-2); border-radius: 999px; overflow: hidden; margin: 8px 0 4px; }
  .bar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--ok)); }
  button, .btn { background: var(--panel-2); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 13px; text-decoration: none; display: inline-block; }
  button:hover, .btn:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #04102b; font-weight: 600; }
  code { background: #0e1421; border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #1f2739; }
  th { color: var(--muted); font-weight: 500; }
  .toast { position: fixed; right: 16px; bottom: 16px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 13px; display: none; max-width: 420px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<header>
  <span class="brand">${appName}</span>
  <span class="pill" id="mode-pill">${options.demo ? 'DEMO' : '接入模式'}</span>
  <span class="spacer"></span>
  <span class="muted" id="who">未登录</span>
  <button id="login-btn">演示登录</button>
  <button id="logout-btn" class="hidden">登出</button>
</header>

<div class="wrap">
  <div class="card" id="login-card">
    <h2>登录</h2>
    <p class="muted">
      用哪个身份进入？
      ${options.demo ? '演示模式使用内置假 IdP，不需要外部服务。' : '正式模式将跳转 OIDC 授权（PKCE）。'}
    </p>
    <div class="row" style="flex-wrap:wrap">
      <a class="btn primary" href="/api/auth/demo-login?email=alice@tsinghua.edu.cn">alice@tsinghua.edu.cn（教育邮箱）</a>
      <a class="btn" href="/api/auth/demo-login?email=bob@gmail.com">bob@gmail.com</a>
      <a class="btn" href="/api/auth/demo-login?email=admin@example.com&realm=developer">管理员</a>
    </div>
  </div>

  <!-- 两级选择：先选开发者 → 再选站点（M7-5）。
       ★ 只在「需要选择」时显示：单站点部署下这两级会退化为无选择，卡片始终隐藏。 -->
  <div class="card hidden" id="selection-card">
    <h2>选择工作站点</h2>
    <p class="muted">你可以在多个开发者/站点之间切换；选择后一切操作都在该站点的数据范围内。</p>
    <div class="row" style="flex-wrap:wrap;gap:10px;margin-top:10px">
      <label class="muted" for="developer-select">开发者</label>
      <select id="developer-select"></select>
      <label class="muted" for="site-select">站点</label>
      <select id="site-select"></select>
      <button class="primary" id="selection-submit">进入</button>
    </div>
    <div class="detail" id="selection-status" style="margin-top:8px"></div>
  </div>

  <div class="card hidden" id="eligibility-card">
    <h2>我的资格</h2>
    <div class="muted" id="progress-text"></div>
    <div class="bar"><i id="progress-bar" style="width:0%"></i></div>
    <div id="todos" class="detail"></div>
  </div>

  <div id="results"></div>

  <div class="card hidden" id="admin-card">
    <h2>管理端</h2>
    <p class="muted">仅 developer 域可见。写操作自动带上 CSRF token。</p>
    <div class="row">
      <button data-admin="subjects">主体列表</button>
      <button data-admin="policies">策略列表</button>
      <button data-admin="evaluate">试算</button>
    </div>
    <div id="admin-output" style="margin-top:14px"></div>
  </div>

  <p class="muted">
    后端契约：<code>GET /api/me</code> · <code>GET /api/me/eligibility</code> · <code>GET /healthz</code>
    · 管理端 <code>/api/admin/*</code>（需登录 + CSRF）
  </p>
</div>

<div class="toast" id="toast"></div>

<script>
(function () {
  'use strict';
  var state = { me: null };

  function $(id) { return document.getElementById(id); }
  function toast(msg) {
    var el = $('toast'); el.textContent = msg; el.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(function () { el.style.display = 'none'; }, 4000);
  }
  function icon(state) { return state === 'true' ? '✅' : state === 'false' ? '❌' : '❓'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function decisionBadge(d) {
    var map = { satisfied: ['已达成', 'var(--ok)'], unsatisfied: ['未达成', 'var(--bad)'],
                indeterminate: ['待确认', 'var(--unknown)'], not_applicable: ['不适用', 'var(--muted)'],
                error: ['异常', 'var(--bad)'] };
    var pair = map[d] || ['未知', 'var(--muted)'];
    return '<span class="pill" style="color:' + pair[1] + ';border-color:' + pair[1] + '">' + pair[0] + '</span>';
  }

  async function api(path, options) {
    var res = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    return { status: res.status, data: data };
  }

  // ── 两级选择（M7-5）──
  // 第一级：可选开发者；第二级：该开发者下的站点。选择结果写入会话作用域。
  async function loadSelection() {
    var res = await api('/api/me/selection/developers');
    if (res.status !== 200) { $('selection-card').classList.add('hidden'); return; }
    var data = res.data || {};
    var developers = data.developers || [];
    // 只有一个开发者且只有一个站点 → 不需要让用户选（standalone 免选择）
    var totalSites = developers.reduce(function (sum, d) { return sum + (d.siteCount || 0); }, 0);
    if (developers.length <= 1 && totalSites <= 1) {
      $('selection-card').classList.add('hidden');
      return;
    }
    $('selection-card').classList.remove('hidden');
    var devSelect = $('developer-select');
    devSelect.innerHTML = developers.map(function (d) {
      return '<option value="' + esc(d.developerId) + '">' + esc(d.displayName) + '（' + d.siteCount + ' 个站点）</option>';
    }).join('');
    if (data.current && data.current.developerId) devSelect.value = data.current.developerId;
    await loadSiteOptions();
    if (data.current && data.current.siteId) {
      $('selection-status').textContent = '当前站点：' + String(data.current.siteId).slice(0, 8) + '…';
    }
  }

  async function loadSiteOptions() {
    var developerId = $('developer-select').value;
    if (!developerId) { $('site-select').innerHTML = ''; return; }
    var res = await api('/api/me/selection/sites/' + encodeURIComponent(developerId));
    var sites = (res.status === 200 && res.data && res.data.sites) ? res.data.sites : [];
    $('site-select').innerHTML = sites.map(function (s) {
      return '<option value="' + esc(s.siteId) + '"' + (s.selected ? ' selected' : '') + '>' + esc(s.nickname) + '</option>';
    }).join('');
    if (sites.length === 0) $('selection-status').textContent = '该开发者名下没有可用站点';
  }

  async function submitSelection() {
    var developerId = $('developer-select').value;
    var siteId = $('site-select').value;
    if (!developerId || !siteId) { toast('请先选择开发者与站点'); return; }
    var selectedDeveloper = null;
    Array.prototype.forEach.call($('developer-select').options, function (option) {
      if (option.value === developerId) selectedDeveloper = option.textContent;
    });
    void selectedDeveloper;
    // ★ 状态变更必须带 CSRF token（服务端强制）
    var res = await api('/api/me/selection', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': state.me.csrfToken },
      body: JSON.stringify({ developerId: developerId, siteId: siteId })
    });
    if (res.status !== 200) {
      toast('选择失败：' + ((res.data && res.data.error) || res.status));
      return;
    }
    toast('已进入站点：' + ((res.data && res.data.site && res.data.site.nickname) || siteId));
    await loadMe(); // 重新加载会话与资格（作用域已变）
  }

  /** 控制台导航：按能力派生（前端只渲染服务端返回的分区，不自行判断权限）。 */
  async function loadConsoleNav() {
    var res = await api('/api/console/sections');
    if (res.status !== 200 || !res.data || !res.data.sections) return [];
    return res.data.sections;
  }

  async function loadMe() {
    var res = await api('/api/me');
    if (res.status !== 200) {
      state.me = null;
      $('who').textContent = '未登录';
      $('login-btn').classList.remove('hidden');
      $('logout-btn').classList.add('hidden');
      $('login-card').classList.remove('hidden');
      $('eligibility-card').classList.add('hidden');
      $('admin-card').classList.add('hidden');
      $('results').innerHTML = '';
      return;
    }
    state.me = res.data;
    var p = res.data.principal;
    $('who').textContent = p.username + ' · ' + p.realm + (p.activeSiteId ? ' · ' + p.activeSiteId.slice(0, 8) : '');
    $('login-btn').classList.add('hidden');
    $('logout-btn').classList.remove('hidden');
    $('login-card').classList.add('hidden');
    $('eligibility-card').classList.remove('hidden');
    if (p.realm === 'developer') $('admin-card').classList.remove('hidden');
    await loadSelection();
    await loadEligibility();
  }

  async function loadEligibility() {
    var res = await api('/api/me/eligibility');
    if (res.status !== 200) {
      $('progress-text').textContent = '无法获取资格：' + (res.data && res.data.error ? res.data.error : res.status);
      $('results').innerHTML = '';
      return;
    }
    var report = res.data;
    var total = report.progress.total || 0;
    var done = report.progress.satisfied || 0;
    $('progress-text').textContent = '进度：' + done + ' / ' + total + ' 条策略已达成';
    $('progress-bar').style.width = (total > 0 ? Math.round((done / total) * 100) : 0) + '%';
    $('todos').textContent = (report.todos && report.todos.length) ? '待完成：' + report.todos.join('；') : '';

    var html = '';
    (report.results || []).forEach(function (r) {
      html += '<div class="card"><h2>' + esc(r.name || r.code) + ' ' + decisionBadge(r.decision) + '</h2>';
      if (r.decision === 'not_applicable') {
        html += '<div class="muted">本策略不适用于该主体</div></div>';
        return;
      }
      (r.items || []).forEach(function (item) {
        var detail = '';
        if (item.state === 'false' && item.actual !== undefined) {
          detail = '（当前 ' + esc(JSON.stringify(item.actual)) + '，需要 ' + esc(JSON.stringify(item.expected)) + '）';
        } else if (item.state === 'indeterminate') {
          detail = '（关键事实缺失，请稍后重试或完成绑定）';
        }
        html += '<div class="item"><span class="ic">' + icon(item.state) + '</span><span>' + esc(item.label) +
                '<div class="detail">' + esc(detail) + '</div></span></div>';
      });
      if (r.actions && r.actions.length) {
        html += '<div class="detail" style="margin-top:8px">→ 将执行：' + esc(r.actions.map(function (a) { return a.action; }).join(', ')) + '</div>';
      } else if (r.decision === 'indeterminate') {
        html += '<div class="detail" style="margin-top:8px">→ 不执行任何动作（无法判定时不推进状态）</div>';
      }
      html += '</div>';
    });
    $('results').innerHTML = html;
  }

  async function adminAction(kind) {
    var out = $('admin-output');
    out.innerHTML = '<span class="muted">加载中…</span>';
    var res;
    if (kind === 'subjects') {
      res = await api('/api/admin/subjects');
    } else if (kind === 'policies') {
      res = await api('/api/admin/policies');
    } else {
      res = await api('/api/admin/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': state.me.csrfToken },
        body: JSON.stringify({ user: { status: 'active', email_verified: true }, facts: { 'fact.email.domain': 'tsinghua.edu.cn', 'fact.email.verified': true } })
      });
    }
    if (res.status !== 200) {
      out.innerHTML = '<span style="color:var(--bad)">' + esc((res.data && res.data.error) || ('HTTP ' + res.status)) + '</span>';
      return;
    }
    if (kind === 'subjects') {
      var rows = (res.data.subjects || []).map(function (s) {
        return '<tr><td>' + esc(s.externalId) + '</td><td>' + esc(s.displayName || '') + '</td><td>' + esc(s.email || '') +
               '</td><td><code>' + esc(JSON.stringify(s.watched)) + '</code></td></tr>';
      }).join('');
      out.innerHTML = '<div class="muted">共 ' + res.data.total + ' 个主体（provider: ' + esc(res.data.provider) + '）</div>' +
        '<table><thead><tr><th>externalId</th><th>显示名</th><th>邮箱</th><th>关注属性</th></tr></thead><tbody>' + rows + '</tbody></table>';
    } else if (kind === 'policies') {
      var prows = (res.data.policies || []).map(function (p) {
        return '<tr><td>' + esc(p.code) + '</td><td>' + esc(p.name || '') + '</td><td>' + esc(p.version == null ? '草稿' : 'v' + p.version) +
               '</td><td>' + (p.enabled === false ? '停用' : '启用') + '</td></tr>';
      }).join('');
      out.innerHTML = '<table><thead><tr><th>code</th><th>名称</th><th>版本</th><th>状态</th></tr></thead><tbody>' + prows + '</tbody></table>';
    } else {
      out.innerHTML = '<pre class="detail" style="white-space:pre-wrap">' + esc(JSON.stringify(res.data, null, 2)) + '</pre>';
    }
  }

  $('developer-select').addEventListener('change', function () { void loadSiteOptions(); });
  $('selection-submit').addEventListener('click', function () { void submitSelection(); });
  $('login-btn').addEventListener('click', function () {
    window.location.href = '/api/auth/demo-login?email=alice@tsinghua.edu.cn';
  });
  $('logout-btn').addEventListener('click', async function () {
    await api('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': state.me.csrfToken } });
    location.reload();
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-admin]'), function (btn) {
    btn.addEventListener('click', function () { adminAction(btn.getAttribute('data-admin')); });
  });

  loadMe();
})();
</script>
</body>
</html>`;
}
