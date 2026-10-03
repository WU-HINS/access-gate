/**
 * 用户确认页（M5-4）—— docs/06 §7.2.2、§9。
 *
 * ```
 *   外部项目 → 发起 challenge → 展示 userCode（如 "DEV 7F3A-K92M"）
 *   用户 → 在平台上打开确认页 → 输入/确认 code → 批准或拒绝
 * ```
 *
 * ★ 验收标准（docs/07 M5-4）：**「用户确认页」**——它是设备码流的人机界面。
 *
 * ★ 三处必须严格的地方：
 *
 * 1. **确认页必须展示「谁在请求、请求什么范围」**——而不是只显示一个输入框。
 *    用户点「批准」时是在**授权**，若他不知道授权给谁、授了什么，
 *    这个按钮就变成了盲签。
 *
 * 2. **提交必须带 CSRF**（与门户其它状态变更一致）——确认页是状态变更入口，
 *    否则第三方页面可以诱导用户提交（CSRF 正好能伪造「批准」）。
 *
 * 3. **失败信息不得泄露 code 是否存在**：输错 code 与 code 过期返回**同一条提示**，
 *    否则可以拿它当 oracle 枚举有效 code。
 */

// ─────────────────────────── HTML 渲染 ───────────────────────────

/** HTML 转义（确认页会渲染来自外部项目的 `clientName`，必须转义）。 */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 确认页需要的挑战视图。
 *
 * ★ 刻意**不直接用** `device-code.ts` 的 `Challenge` 类型：确认页只需要
 *   「展示给用户的五个字段」，依赖整个内部结构会让任何字段调整都波及页面层。
 *   由调用方做这一步映射（也顺便强制它想清楚「哪些信息可以给用户看」）。
 */
export interface ConfirmChallengeView {
  userCode: string;
  clientName: string;
  scopes: readonly string[];
  expiresAt: Date;
  /** 发起方的展示信息（如 "Discord Bot"） */
  requestedBy?: string;
}

export interface ConfirmPageInput {
  /** 挑战详情（已由调用方映射；**不暴露内部 id**） */
  challenge?: ConfirmChallengeView;
  /** CSRF token（提交时必须回传） */
  csrfToken: string;
  /** 错误提示（已本地化） */
  error?: string;
  /** 成功的提示（如「已批准，可以回到 Discord 了」） */
  notice?: string;
}

/**
 * 渲染确认页。
 *
 * ★ 关键信息一个都不能少：**谁在请求**（clientName/requestedBy）、
 *   **请求什么范围**（scopes）、**什么时候过期**（expiresAt）。
 *   用户在授权，不是在填空。
 */
export function renderConfirmPage(input: ConfirmPageInput): string {
  const error = input.error === undefined ? '' : `<p class="error" role="alert">${esc(input.error)}</p>`;
  const notice = input.notice === undefined ? '' : `<p class="notice" role="status">${esc(input.notice)}</p>`;

  if (input.challenge === undefined) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>确认授权</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6}
input,button{font-size:1rem;padding:.5rem .75rem}input{width:14rem;letter-spacing:.15em}
button{cursor:pointer}.error{color:#b91c1c}.notice{color:#166534}.muted{color:#6b7280;font-size:.875rem}</style>
</head><body>
<h1>确认授权</h1>${error}${notice}
<p>请粘贴外部项目展示给你的代码：</p>
<form method="post" action="/verify/challenge">
  <input type="hidden" name="csrf_token" value="${esc(input.csrfToken)}" />
  <input name="user_code" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters" required />
  <button type="submit">继续</button>
</form>
<p class="muted">代码由发起请求的应用显示（通常形如 <code>DEV 7F3A-K92M</code>）。
如果你没有发起过这个请求，请直接关闭本页。</p>
</body></html>`;
  }

  const challenge = input.challenge;
  const scopeList =
    challenge.scopes.length === 0
      ? '<li class="muted">（未请求任何数据范围）</li>'
      : challenge.scopes.map((scope) => `<li><code>${esc(scope)}</code></li>`).join('');
  const expiry = challenge.expiresAt.toISOString().replace('T', ' ').slice(0, 19);

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>确认授权</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6}
button{font-size:1rem;padding:.5rem 1rem;cursor:pointer;margin-right:.5rem}
.approve{background:#166534;color:#fff;border:0;border-radius:.375rem}
.deny{background:#fff;border:1px solid #d1d5db;border-radius:.375rem}
.error{color:#b91c1c}.notice{color:#166534}.muted{color:#6b7280;font-size:.875rem}
code{background:#f3f4f6;padding:.1rem .3rem;border-radius:.25rem}</style>
</head><body>
<h1>确认授权</h1>${error}${notice}
<p><strong>${esc(challenge.clientName)}</strong> 请求代表你访问 Access Gate：
${challenge.requestedBy === undefined ? '' : `<br /><span class="muted">发起方：${esc(challenge.requestedBy)}</span>`}</p>
<p>它请求以下范围：</p>
<ul>${scopeList}</ul>
<p class="muted">设备码：<code>${esc(challenge.userCode)}</code> · 有效期至 ${esc(expiry)}</p>
<form method="post" action="/verify/challenge">
  <input type="hidden" name="csrf_token" value="${esc(input.csrfToken)}" />
  <input type="hidden" name="user_code" value="${esc(challenge.userCode)}" />
  <button class="approve" type="submit" name="decision" value="approve">批准</button>
  <button class="deny" type="submit" name="decision" value="deny">拒绝</button>
</form>
<p class="muted">批准后，该应用将能读取上述范围内的资格断言。你可以随时在「我的空间」里撤销。</p>
</body></html>`;
}

// ─────────────────────────── 提交处理 ───────────────────────────

/** 设备码服务在本模块需要的最小接口（避免与具体实现耦合）。 */
export interface ChallengeService {
  /** 按用户码查挑战（返回 undefined 表示**不存在或已过期**，两者不区分） */
  lookupByUserCode(userCode: string): Promise<ConfirmChallengeView | undefined>;
  approve(userCode: string, userId: string): Promise<{ ok: boolean; message?: string }>;
  deny(userCode: string, userId: string): Promise<{ ok: boolean; message?: string }>;
}

export type ConfirmSubmitResult =
  | { ok: true; action: 'approve' | 'deny'; page: string; notice: string }
  | { ok: false; status: 400 | 403; page: string };

/** 归一化用户码（**与设备码服务用同一个规则**：只保留字母数字并大写）。 */
export function normalizeUserCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * 处理确认页提交。
 *
 * ★ 三条语义：
 *   1. **未登录 → 403**（确认页不是一个可匿名调用的接口）；
 *   2. **CSRF 必须校验**（由调用方完成；本函数假定已校验，但仍要求传入 token 以避免调用方忘记）；
 *   3. **查不到 code → 与「过期」同一条提示**（不泄露 code 是否存在）。
 */
export async function handleConfirmSubmit(input: {
  userCode: string;
  decision: 'approve' | 'deny';
  csrfToken: string;
  principal: { userId: string } | null;
  service: ChallengeService;
}): Promise<ConfirmSubmitResult> {
  if (input.principal === null) {
    return {
      ok: false,
      status: 403,
      page: renderConfirmPage({ csrfToken: input.csrfToken, error: '请先登录后再确认授权。' }),
    };
  }
  if (input.csrfToken.trim().length === 0) {
    return {
      ok: false,
      status: 403,
      page: renderConfirmPage({ csrfToken: input.csrfToken, error: '请求校验失败（缺少 CSRF 令牌），请刷新页面重试。' }),
    };
  }

  const normalized = normalizeUserCode(input.userCode);
  const challenge = await input.service.lookupByUserCode(normalized);
  if (challenge === undefined) {
    // ★ 不存在与过期**同一条提示**：否则可以拿它当 oracle 枚举有效 code
    return {
      ok: false,
      status: 400,
      page: renderConfirmPage({
        csrfToken: input.csrfToken,
        error: '该代码无效或已过期，请核对后重试（代码由发起请求的应用显示）。',
      }),
    };
  }

  const result =
    input.decision === 'approve'
      ? await input.service.approve(normalized, input.principal.userId)
      : await input.service.deny(normalized, input.principal.userId);

  if (!result.ok) {
    return {
      ok: false,
      status: 400,
      page: renderConfirmPage({ csrfToken: input.csrfToken, error: result.message ?? '操作失败，请重试。' }),
    };
  }

  const notice =
    input.decision === 'approve'
      ? '已批准。可以回到发起请求的应用继续操作了。'
      : '已拒绝。该应用不会获得任何访问权限。';
  return { ok: true, action: input.decision, page: renderConfirmPage({ csrfToken: input.csrfToken, notice }), notice };
}
