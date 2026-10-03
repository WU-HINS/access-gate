/**
 * 显式跨站点访问（`docs/08 §7` 的**第三条硬规则**）。
 *
 * > **三条硬规则**：业务代码不得手写 `site_id`；无作用域的查询抛错（不是返回空）；
 * > **`crossSite()` 按角色收敛并审计**。
 *
 * ★ 前两条**已实现**（`src/query/compile.ts` 的行内 `site_id` 校验 + `ScopeRequiredError`），
 *   第三条在此之前**完全不存在**（`grep crossSite src/` → 0）。
 *
 * ★★ 为什么必须有它（`reports/architecture-gaps.md` R115 的原话）：
 * > 目前**没有任何「显式跨站点访问」的能力**：
 * > 「开发者控制台要列出自己名下所有站点」「管理员要跨站点统计」这类**正当需求
 * > 没有受控通道**——只能绕过作用域（而绕过作用域本身是 fail-closed 的，所以做不到）。
 * > 即：**要么做不到，要么有人会去关掉作用域检查**——而后者正是这条规则要防的。
 *
 * ★ 查询层其实**已经有** `scope: 'bypass'` + 强制 `bypassReason`（见 `src/query/compile.ts`），
 *   但**全项目零使用**：因为它没有回答「**谁**可以绕过、绕过**哪些**站点」——
 *   而一个不检查角色的旁路，等于把「关掉作用域检查」做成了合法 API。
 *   本文件补上的正是那个缺失的判定：**角色收敛 + 显式理由 + 审计留痕**。
 */

export type CrossSiteRealm = 'developer' | 'enduser';
export type CrossSiteRole = 'admin' | 'developer' | 'user';

export interface CrossSiteActor {
  realm: CrossSiteRealm;
  role: CrossSiteRole;
  /** `realm === 'developer'` 时该开发者 id */
  developerId: string | null;
  /** 操作者（写进审计） */
  actorId: string;
}

export interface CrossSiteRequest {
  /**
   * ★ **必填**：为什么需要跨站点访问。
   * 空理由直接拒绝——「显式声明」的全部意义就在这里（写进审计，事后可回答"当时为什么"）。
   */
  reason: string;
  /** 想要访问的站点；不传 = 请求全部（`developer` 会被收敛到名下） */
  siteIds?: readonly string[];
}

export interface CrossSiteAudit {
  action: 'cross_site.query';
  actorId: string;
  reason: string;
  /** 实际放行的站点范围 */
  siteIds: readonly string[];
  scope: 'all' | 'owned';
}

export type CrossSiteDecision =
  | { allowed: true; scope: 'all' | 'owned'; siteIds: readonly string[]; audit: CrossSiteAudit }
  | { allowed: false; reason: string };

/**
 * 判定一次跨站点访问。
 *
 * ★★ 关键取舍：`developer` 请求了**非名下站点**时**拒绝**，而不是静默过滤掉。
 *   静默过滤会让调用方把「无权访问」误读为「该站点没有数据」——
 *   这与 `docs/01 §5.5` 记的「RLS 防漏不防错」是同一类问题：
 *   **权限不足必须响亮，数据为空才是沉默的**。
 */
export function evaluateCrossSite(input: {
  actor: CrossSiteActor;
  request: CrossSiteRequest;
  /** 该开发者名下的站点 id（`realm === 'developer'` 时必填） */
  ownedSiteIds?: readonly string[];
}): CrossSiteDecision {
  const { actor, request } = input;

  // ① 必须显式声明理由
  if (request.reason.trim().length === 0) {
    return { allowed: false, reason: '跨站点访问必须显式提供 reason（不允许无理由绕过站点隔离）' };
  }

  // ② 终端用户没有任何跨站点场景
  if (actor.realm === 'enduser' || actor.role === 'user') {
    return { allowed: false, reason: '终端用户不得跨站点访问（站点之间互不可见）' };
  }

  // ③ admin：全部站点
  if (actor.role === 'admin') {
    const siteIds = request.siteIds ?? [];
    return {
      allowed: true,
      scope: 'all',
      siteIds,
      audit: {
        action: 'cross_site.query',
        actorId: actor.actorId,
        reason: request.reason,
        siteIds,
        scope: 'all',
      },
    };
  }

  // ④ developer：**仅自己名下的站点**
  const owned = input.ownedSiteIds;
  if (owned === undefined) {
    return {
      allowed: false,
      reason: 'developer 跨站点访问需要提供其名下站点清单（缺少则无法收敛范围，拒绝而不是放行）',
    };
  }
  if (request.siteIds === undefined) {
    // 请求「全部」→ 收敛为「名下全部」（这是正当需求：开发者控制台列出自己的站点）
    return {
      allowed: true,
      scope: 'owned',
      siteIds: [...owned],
      audit: {
        action: 'cross_site.query',
        actorId: actor.actorId,
        reason: request.reason,
        siteIds: [...owned],
        scope: 'owned',
      },
    };
  }
  const outside = request.siteIds.filter((siteId) => !owned.includes(siteId));
  if (outside.length > 0) {
    // ★ 拒绝而不是静默过滤：让「越权」响亮，而不是伪装成「没有数据」
    return {
      allowed: false,
      reason: `请求的站点不在该开发者名下：${outside.join(', ')}（跨站点访问只能收敛到名下站点）`,
    };
  }
  return {
    allowed: true,
    scope: 'owned',
    siteIds: [...request.siteIds],
    audit: {
      action: 'cross_site.query',
      actorId: actor.actorId,
      reason: request.reason,
      siteIds: [...request.siteIds],
      scope: 'owned',
    },
  };
}

/**
 * 把判定结论转成查询编译器接受的选项。
 *
 * ★ 只有 `allowed` 的判定才能转出 `scope: 'bypass'`——**这是本模块存在的意义**：
 *   它让「绕过站点隔离」成为**必须经过判定**的动作，而不是随手传一个字符串。
 */
export function crossSiteCompileOptions(decision: CrossSiteDecision):
  | { scope: 'bypass'; bypassReason: string }
  | { error: string } {
  if (!decision.allowed) return { error: decision.reason };
  return {
    scope: 'bypass',
    bypassReason: `cross_site(${decision.scope}): ${decision.audit.reason}`,
  };
}

/** 抛错版本（用于「要么放行、要么中断」的调用点）。 */
export class CrossSiteDeniedError extends Error {
  constructor(reason: string) {
    super(`跨站点访问被拒：${reason}`);
    this.name = 'CrossSiteDeniedError';
  }
}

export function assertCrossSiteAllowed(decision: CrossSiteDecision): CrossSiteAudit {
  if (!decision.allowed) throw new CrossSiteDeniedError(decision.reason);
  return decision.audit;
}
