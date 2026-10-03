/**
 * ★★ **站点准入闸门**（`ag_email_rules`）—— **所有能改会话作用域的路径都必须过它**。
 *
 * ★★ 为什么抽成一个共享函数（而不是各路由各写一遍）：
 *   本会话核实出**有两条**路径能改 `activeSiteId`：
 *   · `POST /api/me/site`（`sessions.switchSite`）
 *   · `POST /api/me/selection`（`sessions.setActiveScope`，**前端门户实际走的那条**）
 *   ★ 我第一版只堵了前者 —— 于是"闸门"被后者**完全绕过**。
 *     这类"堵了一条、漏了另一条"正是本仓库反复吃亏的形态，
 *     所以闸门必须是**一个函数**，且每一处作用域变更都调用它。
 *
 * ★ 语义：
 *   · 未装配检查（`undefined`）= 不启用闸门（等价于"该站点没有配置任何规则"）；
 *   · 会话里**没有邮箱** → 无从判定 → 放行（判定依据不存在）；
 *   · 被拒 → **403 + 原因**（原因必须能排障：是"命中拒绝规则"还是"未命中白名单"）。
 *
 * ★ 为什么闸门在**路由层**而不是会话层：`ag_email_rules` 是**站点级业务规则**，
 *   而 `src/auth/` 是核心（不该知道具体业务表）。分层上，路由层正是"把业务规则
 *   施加到会话变更上"的位置。
 */

import { decideEmailAdmission, type EmailRule } from '../core/email-rules.ts';

export type SiteAdmissionCheck = (input: {
  siteId: string;
  email: string;
}) => Promise<{ allowed: boolean; reason: string }>;

/**
 * ★★ 从「按站点取规则」构造闸门检查——**两处路由装配共用同一份实现**。
 *
 * ★ 为什么不各自内联一份：`createAppRoutes` 与 `createConsoleRoutes` 都要注入它，
 *   两份实现迟早漂移；而这是**准入判定**，漂移的后果是"同一个邮箱在一个入口能进、
 *   在另一个入口被拒"——比没有闸门更难排查。
 */
export function makeSiteAdmissionCheck(input: {
  /** 按站点列出规则（真实模式是 `DbEmailRuleStore`） */
  listRules: (siteId: string) => Promise<readonly EmailRule[]>;
  /**
   * ★★ **站点是否存在**——不存在时**拒绝**。
   *
   * ★ 为什么必须有它：`decideEmailAdmission([], email)` 在**没有规则**时**默认允许**
   *   （那是"未启用闸门"的正确语义）。但如果站点**根本不存在**，`listRules` 同样返回空数组
   *   → 于是 `?site=<随便一个 uuid>` 会被**放过**。
   *   这两件事必须分开：**没有规则 = 允许**；**站点不存在 = 拒绝**。
   */
  siteExists?: (siteId: string) => Promise<boolean>;
}): SiteAdmissionCheck {
  return async ({ siteId, email }) => {
    if (input.siteExists !== undefined && !(await input.siteExists(siteId))) {
      return { allowed: false, reason: `站点不存在或不可用（${siteId}）` };
    }
    const decision = decideEmailAdmission(await input.listRules(siteId), email);
    return { allowed: decision.allowed, reason: decision.reason };
  };
}

export type SiteAdmissionResult =
  | { ok: true }
  | { ok: false; status: 403; body: { error: string } };

export async function guardSiteAdmission(input: {
  /** 未提供 = 不启用闸门 */
  check: SiteAdmissionCheck | undefined;
  /** 会话里的邮箱；`null` = 无从判定 → 放行 */
  email: string | null;
  /** **目标**站点（不是默认站点、也不是当前站点） */
  siteId: string;
}): Promise<SiteAdmissionResult> {
  if (input.check === undefined || input.email === null) return { ok: true };
  const decision = await input.check({ siteId: input.siteId, email: input.email });
  if (decision.allowed) return { ok: true };
  return {
    ok: false,
    status: 403,
    body: { error: `无法进入该站点：${decision.reason}` },
  };
}
