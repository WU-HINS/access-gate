/**
 * 邮箱准入规则（`ag_email_rules`）—— 补齐 `docs/08 §5` 声明但**零读写**的表。
 *
 * ★★ 它为什么不能由插件的 `allowDomains` 代替（两者**方向相反**）：
 *   · 插件的 `allowDomains` 是**采集事实**——回答"这个邮箱属于哪个域"，供**策略判定**用；
 *   · 本表是**注册准入闸门**——回答"这个邮箱**能不能注册**"，在**身份建立之前**生效。
 *   用采集事实做准入，意味着**先建号、再判定**：不该进来的人已经进来了。
 *
 * ★★ 判定顺序（安全默认，逐条说明理由）：
 *   ① 按 `priority` 升序（数字小优先，与 `ag_policies` 的语义一致）；
 *   ② **第一个命中的规则决定结果**——不做"deny 全局覆盖 allow"，
 *      因为**显式优先级本身就是管理员的表达手段**（想拒绝就把 deny 的 priority 调小）；
 *   ③ 无命中时：**只要存在 enabled 的 allow 规则 → 拒绝**（白名单模式）；
 *      否则 → **允许**（未配置闸门不影响既有行为）。
 *   ★ ③ 是安全默认的关键：配置了白名单却让未命中者通过，等于白名单失效。
 */

export type EmailListType = 'allow' | 'deny';
export type EmailMatchType = 'exact' | 'suffix' | 'glob' | 'regex';

export interface EmailRule {
  id: string;
  listType: EmailListType;
  matchType: EmailMatchType;
  pattern: string;
  /** 数字小优先 */
  priority: number;
  note?: string;
  enabled: boolean;
  createdAt: Date;
}

export interface EmailAdmission {
  allowed: boolean;
  /** 人类可读的判定依据（直接展示给用户/管理员） */
  reason: string;
  /** 命中的规则（未命中时为空） */
  matchedBy?: EmailRule;
}

/** 把 glob（`*` / `?`）转成正则；其余字符**转义**（避免 `.` 被当成通配）。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * 单条规则的匹配。
 *
 * ★ `regex` 的非法模式**视为不命中**（而不是抛错）：规则是管理员手写的，
 *   一条写坏的正则不该让整个准入判定 500——它只会"这条不生效"，
 *   而"没生效"在结果里能被看见（`reason` 会说明未命中任何规则）。
 */
export function matchesEmailRule(rule: EmailRule, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const pattern = rule.pattern.trim().toLowerCase();
  switch (rule.matchType) {
    case 'exact':
      return normalized === pattern;
    case 'suffix': {
      // ★ 后缀匹配针对**域名部分**，而不是整个邮箱做 `endsWith`：
      //   `@edu.cn` 应匹配 `x@stu.edu.cn`——按整串比较会漏掉它（测试抓到的真 bug）。
      // ★ 且必须按**标签边界**比较：`edu.cn` 不该匹配 `notedu.cn`（否则是个安全洞）。
      const at = normalized.lastIndexOf('@');
      const domain = at < 0 ? normalized : normalized.slice(at + 1);
      const suffix = pattern.startsWith('@') ? pattern.slice(1) : pattern;
      return domain === suffix || domain.endsWith(`.${suffix}`);
    }
    case 'glob':
      try {
        return globToRegExp(pattern).test(normalized);
      } catch {
        return false;
      }
    case 'regex':
      try {
        // ★ 用原始 pattern（`i` 标志已表达"忽略大小写"）
        return new RegExp(rule.pattern, 'i').test(email.trim());
      } catch {
        return false;
      }
  }
}

export function decideEmailAdmission(
  rules: readonly EmailRule[],
  email: string,
): EmailAdmission {
  const active = rules
    .filter((rule) => rule.enabled)
    .slice()
    .sort((a, b) => a.priority - b.priority);

  for (const rule of active) {
    if (!matchesEmailRule(rule, email)) continue;
    return rule.listType === 'allow'
      ? {
          allowed: true,
          reason: `命中允许规则（${rule.matchType}:${rule.pattern}）`,
          matchedBy: rule,
        }
      : {
          allowed: false,
          reason: `命中拒绝规则（${rule.matchType}:${rule.pattern}）`,
          matchedBy: rule,
        };
  }

  const hasAllowRule = active.some((rule) => rule.listType === 'allow');
  return hasAllowRule
    ? {
        allowed: false,
        reason: '未命中任何允许规则——已配置白名单时，未命中即拒绝',
      }
    : {
        allowed: true,
        reason: '未配置白名单规则——默认允许（未启用准入闸门）',
      };
}

// ─────────────────────────── 存储契约 ───────────────────────────

export interface EmailRuleStore {
  /** 列出本站点的全部规则（含 disabled——管理端要能看到并重新启用） */
  list(): Promise<readonly EmailRule[]>;
  /** 新增或更新（按 `id` 覆盖） */
  put(rule: EmailRule): Promise<void>;
  remove(id: string): Promise<void>;
}

export class InMemoryEmailRuleStore implements EmailRuleStore {
  readonly #rows = new Map<string, EmailRule>();

  async list(): Promise<readonly EmailRule[]> {
    return [...this.#rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  async put(rule: EmailRule): Promise<void> {
    this.#rows.set(rule.id, { ...rule });
  }

  async remove(id: string): Promise<void> {
    this.#rows.delete(id);
  }
}
