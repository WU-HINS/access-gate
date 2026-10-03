/**
 * 动作目标复用统一寻址（M3-5）—— docs/04 §1.5、docs/03 §1.16。
 *
 * 动作的参数里也可能指向「某个具体对象」：
 * ```yaml
 * actions:
 *   onSatisfied:
 *     - action: newapi:set_group
 *       params:
 *         target: "subject:newapi@prod.group"   # ← 与表达式里同一个寻址语法
 *         group: contributor
 * ```
 *
 * ★ 验收标准（docs/07 M3-5）：**「动作目标复用寻址」**——
 *   即动作参数里的目标**必须走与表达式完全相同的解析器**，而不是各写一套字符串拼接。
 *
 * ★ 为什么必须复用（而不是「动作参数自己约定个格式」）：
 *   1. **两套语法迟早分叉**：表达式支持 `@实例`、`#跨站点`、`me.`/`user.` 前缀，
 *      若动作参数另有一套，就会出现「表达式里能写、动作里不能写」这类不一致；
 *   2. **校验要一致**：表达式在发布期会校验「引用的插件是否存在」，
 *      动作目标同样需要——两套实现意味着**两处校验规则**，漏一处就是一个运行时错误；
 *   3. **权限边界一致**：`#跨站点` 在表达式里受站点作用域约束，动作里也必须受同样约束。
 *
 * ★ 本模块**不重新实现解析**，而是把 `addressing.ts` 的解析结果映射到「动作参数」这个场景。
 */

import { parseAddress, type Address } from './addressing.ts';

// ─────────────────────────── 类型 ───────────────────────────

/** 动作参数里被识别为「寻址目标」的字段名（约定俗成的几个）。 */
export const TARGET_PARAM_KEYS: readonly string[] = ['target', 'subject', 'scope', 'to'];

export interface ActionTarget {
  /** 参数里的哪个字段 */
  key: string;
  /** 原始字符串 */
  raw: string;
  /** 解析结果（与表达式共用同一个解析器） */
  parsed: Address;
}

export interface ActionAddressingResult {
  /** 参数里识别出的全部寻址目标 */
  targets: readonly ActionTarget[];
  /** 非寻址参数（原样保留） */
  plainParams: Record<string, unknown>;
  /** 校验问题（发布期拒绝） */
  issues: readonly string[];
}

// ─────────────────────────── 解析 ───────────────────────────

/**
 * 从动作参数里抽出寻址目标并解析。
 *
 * ★ 识别规则刻意**保守**：只有「字段名在约定集合里」且「值看起来是寻址串」才当作目标。
 *   否则一个普通参数（如 `group: "contributor"`）被误判成寻址串，
 *   会在发布期报出莫名其妙的错误。
 *
 * 「看起来是寻址串」的判据：以 `subject:` / `fact:` / `action:` / `plugin:` 等
 * **已知前缀**开头，或包含 `@` / `#` 修饰符。
 */
export function resolveActionTargets(params: Record<string, unknown>): ActionAddressingResult {
  const targets: ActionTarget[] = [];
  const plainParams: Record<string, unknown> = {};
  const issues: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    const isTargetKey = TARGET_PARAM_KEYS.includes(key);
    const looksLikeAddress = typeof value === 'string' && looksAddressLike(value);
    if (!isTargetKey || !looksLikeAddress) {
      plainParams[key] = value;
      continue;
    }
    try {
      const parsed = parseAddress(value);
      targets.push({ key, raw: value, parsed });
    } catch (error) {
      issues.push(`动作参数 '${key}' 的寻址目标 '${value}' 无法解析：${error instanceof Error ? error.message : String(error)}`);
      plainParams[key] = value;
    }
  }

  return { targets, plainParams, issues };
}

/** 值看起来像寻址串吗（用于保守识别）。 */
export function looksAddressLike(value: string): boolean {
  return /^(subject|fact|action|plugin|user|me):/.test(value) || value.includes('@') || value.includes('#');
}

// ─────────────────────────── 站点作用域校验 ───────────────────────────

/**
 * ★ 用**判别联合**而不是「可选字段」：失败时 `message` 一定存在，
 *   调用方不必再判 `undefined`（否则每处都要写 `?? '未知错误'`，
 *   而那恰好会把「漏写原因」掩盖成一句通用文案）。
 */
export type TargetScopeCheck =
  | { ok: true }
  | { ok: false; reason: 'cross_site_denied' | 'instance_unknown'; message: string };

/**
 * 校验动作目标是否落在**当前站点作用域**内。
 *
 * ★ 与表达式层共用同一条规则：`#跨站点` 引用必须被显式允许，
 *   否则就是一次**跨租户写操作**——而写比读更危险（它会真的改到别的站点的数据）。
 */
export function checkTargetScope(
  target: ActionTarget,
  context: { siteId: string; allowCrossSite: boolean; knownInstances?: readonly string[] },
): TargetScopeCheck {
  // ★ 跨站点判定用**解析结果**（`siteSlug`），而不是自己找 `#` 字符：
  //   这正是「复用寻址」的含义——两套实现迟早分叉（比如将来 `#` 换成别的写法）。
  const raw = target.raw;
  const isCrossSite = target.parsed.siteSlug !== undefined;
  if (isCrossSite && !context.allowCrossSite) {
    return {
      ok: false,
      reason: 'cross_site_denied',
      message:
        `动作目标 '${raw}' 引用了**其它站点**，但当前动作不允许跨站点写操作` +
        `（写操作比读更危险：它会真的改到别的站点的数据）。如确需跨站点，请显式开启`,
    };
  }
  // `@实例` 必须是已知实例（同样取自解析结果）
  const instance = target.parsed.instanceKey;
  if (instance !== undefined && context.knownInstances !== undefined && !context.knownInstances.includes(instance)) {
    return {
      ok: false,
      reason: 'instance_unknown',
      message: `动作目标 '${raw}' 引用了未知实例 '@${instance}'（已知：${context.knownInstances.join(', ') || '无'}）`,
    };
  }
  return { ok: true };
}

/**
 * 动作参数中寻址目标的**人类可读描述**（供确认对话框与审计）。
 *
 * ★ 审计里记「对谁做了什么」比记原始参数串更有用——
 *   排障时读的是「把 alice 加进了 prod 实例的 contributor 组」，
 *   而不是 `subject:newapi@prod.group=contributor`。
 */
export function describeActionTarget(target: ActionTarget): string {
  const parsed = target.parsed;
  const parts: string[] = [`目标 ${target.raw}`];
  parts.push(`类型 ${parsed.root}`);
  if (parsed.pluginId !== undefined) parts.push(`插件 ${parsed.pluginId}`);
  if (parsed.instanceKey !== undefined) parts.push(`实例 ${parsed.instanceKey}`);
  if (parsed.siteSlug !== undefined) parts.push(`★ 跨站点（${parsed.siteSlug}）`);
  if (parsed.path.length > 0) parts.push(`路径 ${parsed.path.join('.')}`);
  return parts.join(' · ');
}
