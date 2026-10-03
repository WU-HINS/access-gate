/**
 * 宿主内置的三个 UI 渲染器（M4-9）—— docs/03 §1.17.5、docs/06 §10.7.2。
 *
 * | 渲染器 | 输入 | 关键保障 |
 * |---|---|---|
 * | `DeclarativeRenderer` | 块树 | 只用宿主组件；**禁用 `dangerouslySetInnerHTML`**；插值转义；markdown 走 DOMPurify |
 * | `RemoteModuleLoader` | ESM bundle URL | 校验**签名与 CSP 白名单**；挂 **Shadow DOM** 隔离样式；错误边界 + 骨架屏 |
 * | `PluginIframe` | 页面 URL | **独立 origin + `sandbox`**；postMessage 桥做鉴权透传；不用时卸载 |
 *
 * ★ 验收标准（docs/07 M4-9 原文）：**「插件渲染异常不白屏；样式不污染宿主」**。
 *
 * 这两条决定了本模块的形态：
 *
 * 1. **不白屏** —— 每个渲染器都必须有**错误边界**，且降级结果是「一张说明卡」
 *    而不是空白。插件是第三方代码，它抛异常是**常态而非意外**；
 *    用户看到空白页时无法区分「没有内容」与「插件坏了」。
 *
 * 2. **样式不污染** —— 这是**架构约束**而不是编码规范：
 *    远程模块必须挂 Shadow DOM（样式作用域天然隔离），
 *    iframe 必须 `sandbox`（连脚本执行都要受限）。
 *    靠「要求插件用前缀」是**约定**，约定一定会被违反。
 *
 * ★ 本模块是**零构建**的：渲染结果是 HTML 片段（与 `web/portal.ts` 同一风格），
 *   因此可以在测试里直接断言「转义了没」「有没有降级卡」。
 *   真实前端（React 版）的实现应与此处的**契约**一致：
 *   同样的判定顺序、同样的降级行为。
 */

import { createHash } from 'node:crypto';

// ═══════════════════════════ 公共 ═══════════════════════════

/** HTML 转义（**所有**插值都必须经过它）。 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 降级卡：渲染失败时的统一展示。
 *
 * ★ 含**插件名与错误摘要**，但不含堆栈（堆栈给用户看没有意义，且可能泄露路径）。
 *   错误详情走日志，卡片只说明「哪个插件坏了 + 其它内容不受影响」。
 */
export function renderFallbackCard(input: { pluginId: string; title: string; detail?: string }): string {
  const detail = input.detail === undefined ? '' : `<p class="ag-fallback-detail">${escapeHtml(input.detail)}</p>`;
  return (
    `<div class="ag-fallback" role="alert" data-plugin="${escapeHtml(input.pluginId)}">` +
    `<p class="ag-fallback-title">「${escapeHtml(input.title)}」暂时无法显示</p>` +
    `<p class="ag-fallback-note">该插件的这部分内容加载失败，**其它内容不受影响**。</p>` +
    detail +
    `</div>`
  );
}

// ═══════════════════════════ ① DeclarativeRenderer ═══════════════════════════

/** 声明式块（docs/06 §10.7.2 的九种）。 */
export type Block =
  | { type: 'stats'; items: { label: string; value: unknown; hint?: string }[] }
  | { type: 'action'; label: string; method: string; url: string; confirm?: string }
  | { type: 'form'; fields: { name: string; label: string; type?: string; required?: boolean }[]; submitLabel?: string; method?: string; url?: string }
  | { type: 'table'; columns: string[]; rows: unknown[][] }
  | { type: 'chart'; kind: 'line' | 'bar'; points: number[]; label?: string }
  | { type: 'calendar'; days: { date: string; checked: boolean }[] }
  | { type: 'markdown'; text: string }
  | { type: 'tabs'; tabs: { label: string; blocks: Block[] }[] }
  | { type: 'section'; title?: string; blocks: Block[] }
  | { type: 'template'; text: string; vars: Record<string, unknown> };

/**
 * ★ **极简但严格**的 markdown 渲染（docs 要求走 DOMPurify）。
 *
 * 零构建环境下不引入第三方库，因此这里**只支持一组白名单语法**
 * （粗体、行内代码、链接），且：
 *   - **先转义，再做替换**——顺序不能反（先替换会让 `<b>` 之类的输入被当成语法）；
 *   - 链接只允许 `http(s):` 与相对路径（`javascript:` 一律拒绝）。
 *
 * ★ 这个实现比 DOMPurify 弱得多，因此**明确标注**：生产前端应使用 DOMPurify；
 *   此处的价值是把「转义在前、白名单在后」这条顺序固定下来，供前端实现对齐。
 */
export function renderMarkdownSafe(text: string): string {
  // ① 先整体转义（此后文本里不可能有真实标签）
  let html = escapeHtml(text);
  // ② 再按白名单做替换（替换出的标签是**我们自己写的**，因此安全）
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, (_match, label: string, href: string) => {
    const safe = /^(https?:\/\/|\/)/.test(href) ? href : '#';
    return `<a href="${safe}" rel="noopener noreferrer">${label}</a>`;
  });
  return `<div class="ag-md">${html}</div>`;
}

/**
 * 模板插值渲染（**所有变量都转义**）。
 *
 * ★ `template` 块是最容易被滥用的：插件写 `{userName}` 时若不转义，
 *   一个昵称为 `<img onerror=...>` 的用户就能在**别人**的页面上执行脚本。
 *   因此这里是**整条链路上唯一**的插值入口，且转义不可关闭。
 */
export function renderTemplate(text: string, vars: Record<string, unknown>): string {
  const rendered = text.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value === undefined ? '' : escapeHtml(value);
  });
  return `<div class="ag-template">${rendered}</div>`;
}

/** 渲染块树。任何单块失败**只降级该块**，不影响兄弟块。 */
export function renderDeclarative(blocks: readonly Block[], pluginId: string): string {
  return blocks.map((block) => renderBlock(block, pluginId)).join('');
}

function renderBlock(block: Block, pluginId: string): string {
  try {
    switch (block.type) {
      case 'stats':
        return (
          `<div class="ag-stats">` +
          block.items
            .map(
              (item) =>
                `<div class="ag-stat"><span class="ag-stat-value">${escapeHtml(item.value)}</span>` +
                `<span class="ag-stat-label">${escapeHtml(item.label)}</span>` +
                (item.hint === undefined ? '' : `<span class="ag-stat-hint">${escapeHtml(item.hint)}</span>`) +
                `</div>`,
            )
            .join('') +
          `</div>`
        );
      case 'action':
        return (
          `<button class="ag-action" type="button" data-method="${escapeHtml(block.method)}" data-url="${escapeHtml(block.url)}"` +
          (block.confirm === undefined ? '' : ` data-confirm="${escapeHtml(block.confirm)}"`) +
          `>${escapeHtml(block.label)}</button>`
        );
      case 'form':
        return (
          `<form class="ag-form" method="${escapeHtml(block.method ?? 'POST')}" action="${escapeHtml(block.url ?? '#')}">` +
          block.fields
            .map(
              (field) =>
                `<label>${escapeHtml(field.label)}` +
                `<input name="${escapeHtml(field.name)}" type="${escapeHtml(field.type ?? 'text')}"` +
                (field.required === true ? ' required' : '') +
                ` /></label>`,
            )
            .join('') +
          `<button type="submit">${escapeHtml(block.submitLabel ?? '提交')}</button></form>`
        );
      case 'table':
        return (
          `<table class="ag-table"><thead><tr>` +
          block.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('') +
          `</tr></thead><tbody>` +
          block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('') +
          `</tbody></table>`
        );
      case 'chart':
        // 零构建下用 CSS 柱状图表达；真实前端应换成图表库
        return (
          `<div class="ag-chart" data-kind="${escapeHtml(block.kind)}">` +
          (block.label === undefined ? '' : `<span class="ag-chart-label">${escapeHtml(block.label)}</span>`) +
          block.points.map((point) => `<span class="ag-bar" style="height:${Math.max(0, Math.min(100, Number(point) || 0))}%"></span>`).join('') +
          `</div>`
        );
      case 'calendar':
        return (
          `<div class="ag-calendar">` +
          block.days.map((day) => `<span class="ag-day${day.checked ? ' checked' : ''}" data-date="${escapeHtml(day.date)}"></span>`).join('') +
          `</div>`
        );
      case 'markdown':
        return renderMarkdownSafe(block.text);
      case 'template':
        return renderTemplate(block.text, block.vars);
      case 'tabs':
        return (
          `<div class="ag-tabs">` +
          block.tabs
            .map((tab, index) => `<section class="ag-tab" data-tab="${escapeHtml(tab.label)}"${index === 0 ? '' : ' hidden'}>${renderDeclarative(tab.blocks, pluginId)}</section>`)
            .join('') +
          `</div>`
        );
      case 'section':
        return (
          `<section class="ag-section">` +
          (block.title === undefined ? '' : `<h3>${escapeHtml(block.title)}</h3>`) +
          renderDeclarative(block.blocks, pluginId) +
          `</section>`
        );
      default: {
        const exhaustive: never = block;
        void exhaustive;
        return '';
      }
    }
  } catch (error) {
    // ★ 单块失败只降级该块（不白屏）
    return renderFallbackCard({ pluginId, title: '内容块', detail: error instanceof Error ? error.message : String(error) });
  }
}

// ═══════════════════════════ ② RemoteModuleLoader ═══════════════════════════

export interface RemoteModuleRequest {
  pluginId: string;
  /** ESM bundle URL */
  url: string;
  /** 分发方签名（对 bundle 内容的签名；未签名则拒绝加载） */
  signature?: string;
  /** bundle 内容指纹（用于验签与缓存键） */
  fingerprint?: string;
}

export interface RemoteModulePolicy {
  /** CSP 白名单（**默认拒绝**：不在白名单里就不加载） */
  cspAllowlist: readonly string[];
  /** 验签函数（由调用方注入：公钥与算法由部署决定） */
  verify?: (input: { url: string; fingerprint: string; signature: string }) => boolean | Promise<boolean>;
  /** 是否允许未签名的本地插件（生产应为 false） */
  allowUnsigned?: boolean;
}

export type RemoteLoadResult =
  | { ok: true; html: string; shadowRoot: true; csp: string }
  | { ok: false; reason: 'csp_denied' | 'unsigned' | 'bad_signature'; html: string; message: string };

/**
 * 加载远程模块。
 *
 * ★ 三条严格之处：
 *   1. **CSP 白名单默认拒绝**（不在清单里的域名一律不加载）；
 *   2. **未签名默认拒绝**（`allowUnsigned` 只给本地开发用）；
 *   3. **挂 Shadow DOM**——这是「样式不污染宿主」在架构上的保障，
 *      与「要求插件用前缀」这种约定完全不同（约定一定会被违反）。
 *
 * 失败时返回**骨架屏/降级卡**而不是空字符串：用户必须能区分
 * 「这里本来就没内容」与「插件被安全策略拦住了」。
 */
export async function loadRemoteModule(request: RemoteModuleRequest, policy: RemoteModulePolicy): Promise<RemoteLoadResult> {
  const origin = originOf(request.url);
  if (origin === undefined || !policy.cspAllowlist.includes(origin)) {
    return {
      ok: false,
      reason: 'csp_denied',
      html: renderFallbackCard({ pluginId: request.pluginId, title: '远程模块', detail: `来源 '${origin ?? request.url}' 不在 CSP 白名单内` }),
      message: `远程模块来源 '${origin ?? request.url}' 不在 CSP 白名单内（当前白名单：${policy.cspAllowlist.join(', ') || '空'}）`,
    };
  }
  const signature = request.signature;
  const fingerprint = request.fingerprint ?? '';
  if (signature === undefined || signature.length === 0) {
    if (policy.allowUnsigned !== true) {
      return {
        ok: false,
        reason: 'unsigned',
        html: renderFallbackCard({ pluginId: request.pluginId, title: '远程模块', detail: '该模块未签名，已被拒绝加载' }),
        message: '远程模块未签名——未签名的远程代码可以随时被替换，因此默认拒绝加载（本地开发可用 allowUnsigned）',
      };
    }
  } else if (policy.verify !== undefined) {
    const verified = await policy.verify({ url: request.url, fingerprint, signature });
    if (!verified) {
      return {
        ok: false,
        reason: 'bad_signature',
        html: renderFallbackCard({ pluginId: request.pluginId, title: '远程模块', detail: '签名校验未通过' }),
        message: '远程模块签名校验未通过——模块可能被篡改，已拒绝加载',
      };
    }
  } else if (policy.allowUnsigned !== true) {
    // 有签名但没提供验签函数：同样拒绝（不能「有签名就当验过了」）
    return {
      ok: false,
      reason: 'bad_signature',
      html: renderFallbackCard({ pluginId: request.pluginId, title: '远程模块', detail: '无法验签' }),
      message: '提供了签名但宿主没有配置验签函数——不能因为「有签名」就认为「验过了」',
    };
  }

  // 成功：骨架屏 + Shadow DOM 挂载点
  const csp = `default-src 'none'; script-src ${origin}; style-src ${origin} 'unsafe-inline'; connect-src ${origin}`;
  return {
    ok: true,
    shadowRoot: true,
    csp,
    html:
      `<div class="ag-remote" data-plugin="${escapeHtml(request.pluginId)}" data-src="${escapeHtml(request.url)}">` +
      `<template shadowrootmode="open"><div class="ag-remote-skeleton" aria-busy="true">加载中…</div></template>` +
      `</div>`,
  };
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

// ═══════════════════════════ ③ PluginIframe ═══════════════════════════

export interface IframeRequest {
  pluginId: string;
  /** 页面 URL（必须是 https 或本地开发地址） */
  url: string;
  title: string;
  /** 需要透传给 iframe 的能力（**默认空**：最小权限） */
  allow?: readonly ('clipboard-write' | 'fullscreen')[];
}

export type IframeResult = { ok: true; html: string } | { ok: false; reason: 'insecure_url'; html: string; message: string };

/**
 * 渲染 iframe 容器（**最重的隔离**）。
 *
 * ★ `sandbox` 的取值是刻意的：
 *   - **不含 `allow-same-origin`**——否则 iframe 里的脚本能读宿主的 cookie/DOM，
 *     隔离等于没有；
 *   - 含 `allow-scripts`（插件页面需要跑起来）与 `allow-forms`（表单）；
 *   - 不含 `allow-top-navigation`（防钓鱼跳转）。
 *
 * ★ 独立 origin：即使 `src` 是同域，也应通过独立子域提供——
 *   但那是部署侧的事；本模块确保**不主动放宽** sandbox。
 */
export function renderPluginIframe(request: IframeRequest): IframeResult {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return {
      ok: false,
      reason: 'insecure_url',
      html: renderFallbackCard({ pluginId: request.pluginId, title: request.title, detail: 'URL 无法解析' }),
      message: `iframe URL '${request.url}' 无法解析`,
    };
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocal) {
    return {
      ok: false,
      reason: 'insecure_url',
      html: renderFallbackCard({ pluginId: request.pluginId, title: request.title, detail: '插件页面必须使用 https' }),
      message: '插件页面必须使用 https（非 https 的第三方页面可被中间人替换内容）；本地开发地址除外',
    };
  }

  const permissions = (request.allow ?? []).map((entry) => `allow="${entry}"`).join(' ');
  return {
    ok: true,
    html:
      `<iframe class="ag-plugin-frame" data-plugin="${escapeHtml(request.pluginId)}" title="${escapeHtml(request.title)}" ` +
      `src="${escapeHtml(request.url)}" ` +
      // ★ 不含 allow-same-origin（否则隔离形同虚设）
      `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" ` +
      `referrerpolicy="no-referrer" loading="lazy" ${permissions}></iframe>`,
  };
}

/** iframe 的 postMessage 鉴权透传（**只接受白名单消息类型**）。 */
export interface BridgeMessage {
  type: string;
  payload?: unknown;
}

export type BridgeResult = { ok: true; type: string } | { ok: false; reason: 'unknown_type' | 'bad_origin'; message: string };

/**
 * 校验来自 iframe 的 postMessage。
 *
 * ★ 两条必须做的检查（**顺序不能反**）：
 *   1. **先看 origin**——来自非白名单 origin 的消息直接丢弃，连类型都不解析
 *      （否则「未知类型」的日志会被攻击者刷屏）；
 *   2. **再看类型白名单**——宿主只响应自己认识的消息。
 */
export function acceptBridgeMessage(
  input: { origin: string; message: BridgeMessage; expectedOrigin: string; allowedTypes: readonly string[] },
): BridgeResult {
  if (input.origin !== input.expectedOrigin) {
    return { ok: false, reason: 'bad_origin', message: `消息来自非白名单 origin '${input.origin}'（期望 '${input.expectedOrigin}'），已丢弃` };
  }
  if (!input.allowedTypes.includes(input.message.type)) {
    return { ok: false, reason: 'unknown_type', message: `未知的消息类型 '${input.message.type}'（宿主只响应白名单内的类型）` };
  }
  return { ok: true, type: input.message.type };
}

/** 按渲染模式分派到三个渲染器（docs/06 §10.7.1 的 ③）。 */
export async function renderByMode(
  contribution: { pluginId: string; renderMode: 'declarative' | 'remote' | 'iframe'; blocks?: readonly Block[]; url?: string; title?: string; signature?: string; fingerprint?: string },
  policy: RemoteModulePolicy,
): Promise<{ ok: boolean; html: string }> {
  try {
    if (contribution.renderMode === 'declarative') {
      // ★ `blocks` 缺失/非数组时不能只返回空串——那就是白屏。
      //   「插件声明了页面却没有任何内容块」是异常状态，必须让用户看见原因。
      const blocks = contribution.blocks;
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return {
          ok: false,
          html: renderFallbackCard({
            pluginId: contribution.pluginId,
            title: contribution.title ?? '插件内容',
            detail: '该插件贡献未提供任何内容块（blocks 为空或格式不正确）',
          }),
        };
      }
      return { ok: true, html: renderDeclarative(blocks, contribution.pluginId) };
    }
    if (contribution.renderMode === 'remote') {
      const result = await loadRemoteModule(
        { pluginId: contribution.pluginId, url: contribution.url ?? '', ...(contribution.signature === undefined ? {} : { signature: contribution.signature }), ...(contribution.fingerprint === undefined ? {} : { fingerprint: contribution.fingerprint }) },
        policy,
      );
      return { ok: result.ok, html: result.html };
    }
    const result = renderPluginIframe({ pluginId: contribution.pluginId, url: contribution.url ?? '', title: contribution.title ?? contribution.pluginId });
    return { ok: result.ok, html: result.html };
  } catch (error) {
    // ★ 兜底：任何渲染器抛异常都不白屏
    return {
      ok: false,
      html: renderFallbackCard({ pluginId: contribution.pluginId, title: contribution.title ?? '插件内容', detail: error instanceof Error ? error.message : String(error) }),
    };
  }
}

/** 内容指纹（供签名校验与缓存键；与插件包同一算法）。 */
export function contentFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
