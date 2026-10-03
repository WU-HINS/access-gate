/**
 * 内置插件 `email-domain`（M1-6，channel）—— **零外部依赖**。
 *
 * 为什么先做它（docs/09 §562）：**先用零依赖插件验证契约，再接外部系统**——
 * 契约问题会在最容易调试的时候暴露。它同时是 M1 验收场景（edu 邮箱策略）的判定输入。
 *
 * 产出事实（命名空间 `email`）：
 *   - `email.domain`       邮箱域名（小写）
 *   - `email.is_edu`       是否命中 edu 类规则
 *   - `email.matched_rule` 命中的规则（`deny:*.edu.cn` / `allow:...` / `none`）
 *   - `email.verified`     邮箱是否已验证（来自 `requireVerified` 与用户事实）
 *
 * ★ 匹配优先级（docs/09 §5.1 + 02 §1「先 deny 后 allow」）：
 *   1. **deny 永远优先**：命中任一 deny → 直接判定不允许（即使也在 allow 里）。
 *      这是安全语义——白名单写宽了不该让黑名单失效。
 *   2. allow 内部按 `priority` 升序（数字小优先），再按规则声明顺序稳定排序。
 *   3. 全部未命中 → 不产出 allow 事实（由策略的 `$onMissing` 决定，默认 fail_closed）。
 */

export interface EmailDomainConfig {
  /** 允许的域名规则（支持 `*.edu.cn` 通配、`@corp.com` 后缀、`/regex/` 正则） */
  allowDomains?: readonly string[];
  /** 禁止的域名规则（同上；**优先于 allow**） */
  denyDomains?: readonly string[];
  /** 是否要求邮箱已验证（true 时未验证一律不产出 is_edu=true） */
  requireVerified?: boolean;
  /** allow 规则优先级：数字小优先（缺省按声明顺序） */
  priority?: Record<string, number>;
}

export interface EmailDomainInput {
  email: string | null | undefined;
  emailVerified: boolean;
  config: EmailDomainConfig;
}

export interface EmailDomainFacts {
  domain: string;
  is_edu: boolean;
  matched_rule: string;
  verified: boolean;
}

export class EmailDomainError extends Error {
  override readonly name = 'EmailDomainError';
}

/** edu 类域名判定：`.edu`、`.edu.cn`、`.ac.uk`、`.edu.hk` 等教育域后缀。 */
const EDU_SUFFIXES = ['.edu', '.edu.cn', '.ac.uk', '.edu.hk', '.edu.tw', '.edu.au', '.ac.jp', '.edu.sg'];

/** 从邮箱取出域名（小写）；非法邮箱返回 null。 */
export function extractDomain(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  // ★ 本地部分也要校验：只查域名会放行 'a b@x.com' 这类非法邮箱，
  //   而下游事实会被当成「有效邮箱但未命中白名单」→ 误判为明确拒绝而非 missing。
  //   这里只做**宽松的形状校验**（不做 RFC 全量，避免把合法但罕见的地址误杀）。
  if (!/^[a-z0-9._%+-]+$/.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  // 域名形状：至少一个点，标签只含字母数字与连字符，TLD 至少 2 个字母
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)) {
    return null;
  }
  return domain;
}

export function isEduDomain(domain: string): boolean {
  return EDU_SUFFIXES.some((suffix) => domain === suffix.slice(1) || domain.endsWith(suffix));
}

type RuleKind = 'suffix' | 'glob' | 'regex' | 'exact';

interface CompiledRule {
  raw: string;
  kind: RuleKind;
  test: (domain: string) => boolean;
}

/**
 * 编译一条域名规则。
 *
 * 支持的写法：
 *   - `*.edu.cn`     → 通配（任意子域，**不含**裸 `edu.cn`）
 *   - `**@corp.com`  → 与通配等价（历史写法，docs/03 的 glob 示例）
 *   - `@corp.com`    → 后缀匹配（含 `corp.com` 本身）
 *   - `/^.*\.edu$/`  → 正则（**必须显式加斜杠**，避免把普通域名误当正则）
 *   - `example.com`  → 精确域名
 */
export function compileRule(raw: string): CompiledRule {
  const rule = raw.trim().toLowerCase();
  if (rule.length === 0) throw new EmailDomainError('域名规则不能为空');

  if (rule.startsWith('/') && rule.endsWith('/') && rule.length > 2) {
    const source = rule.slice(1, -1);
    let regex: RegExp;
    try {
      regex = new RegExp(source);
    } catch (error) {
      throw new EmailDomainError(`非法正则规则 '${raw}'：${error instanceof Error ? error.message : String(error)}`);
    }
    return { raw, kind: 'regex', test: (domain) => regex.test(domain) };
  }
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return { raw, kind: 'glob', test: (domain) => domain === base || domain.endsWith(`.${base}`) };
  }
  if (rule.startsWith('**@')) {
    const base = rule.slice(3);
    return { raw, kind: 'glob', test: (domain) => domain === base || domain.endsWith(`.${base}`) };
  }
  if (rule.startsWith('@')) {
    const base = rule.slice(1);
    return { raw, kind: 'suffix', test: (domain) => domain === base || domain.endsWith(`.${base}`) };
  }
  return { raw, kind: 'exact', test: (domain) => domain === rule };
}

/**
 * 求值：返回事实（不含命名空间；命名空间由宿主事实管线添加）。
 *
 * 返回 `null` 表示**无法判定**（邮箱缺失/非法）——调用方应按 `missing` 处理，
 * 而不是当成 `is_edu=false`。这个区分很重要：`missing` 走 `$onMissing`（默认 fail_closed，
 * 不升级也不降级），而 `is_edu=false` 会导致**已授予的资格被收回**。
 */
export function evaluateEmailDomain(input: EmailDomainInput): EmailDomainFacts | null {
  const domain = extractDomain(input.email);
  if (domain === null) return null;

  const deny = (input.config.denyDomains ?? []).map(compileRule);
  const allow = (input.config.allowDomains ?? []).map(compileRule);

  // 1) deny 永远优先
  for (const rule of deny) {
    if (rule.test(domain)) {
      return { domain, is_edu: false, matched_rule: `deny:${rule.raw}`, verified: input.emailVerified };
    }
  }

  // 2) allow：按 priority 升序（未配置的按声明顺序排后）
  const priority = input.config.priority ?? {};
  const ordered = allow
    .map((rule, index) => ({ rule, index, weight: priority[rule.raw] ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.weight === b.weight ? a.index - b.index : a.weight - b.weight));

  for (const { rule } of ordered) {
    if (!rule.test(domain)) continue;
    const verifiedOk = input.config.requireVerified === true ? input.emailVerified : true;
    return {
      domain,
      // requireVerified 且未验证 → 命中规则但不给 edu 资格（让策略能区分「域名对但没验证」）
      is_edu: isEduDomain(domain) && verifiedOk,
      matched_rule: `allow:${rule.raw}`,
      verified: input.emailVerified,
    };
  }

  // 3) 未命中任何 allow：域名本身是 edu 也不给资格（白名单未声明即不允许）
  return { domain, is_edu: false, matched_rule: 'none', verified: input.emailVerified };
}

/** 内置插件的 manifest（用于安装与静态校验；与 `src/plugin/manifest.ts` 的契约一致）。 */
export const EMAIL_DOMAIN_MANIFEST = {
  apiVersion: 'gate.plugin/v1',
  kind: 'channel',
  id: 'email',
  name: '邮箱域名',
  version: '1.0.0',
  description: '零外部依赖：按域名白/黑名单判定邮箱资格（支持通配、后缀、正则）',
  author: 'official',
  license: 'MIT',
  runtime: 'declarative',
  capabilities: { binding: 'none', refresh: false, revoke: false, quickCheck: true },
  permissions: [],
  factTtl: '30d',
  configSchema: {
    type: 'object',
    properties: {
      allowDomains: { type: 'array', items: { type: 'string' }, title: '允许的域名规则' },
      denyDomains: { type: 'array', items: { type: 'string' }, title: '禁止的域名规则（优先于允许）' },
      requireVerified: { type: 'boolean', default: true, title: '是否要求邮箱已验证' },
    },
    required: ['allowDomains'],
  },
  factSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', title: '邮箱域名' },
      is_edu: { type: 'boolean', title: '是否命中教育域资格' },
      matched_rule: { type: 'string', title: '命中的规则' },
      verified: { type: 'boolean', title: '邮箱是否已验证' },
    },
    required: ['domain', 'matched_rule'],
  },
  /**
   * ★ 本插件**不发起任何网络请求**（零外部依赖），因此显式声明 `local: true`：
   *   求值是纯函数（`evaluateEmailDomain`），由宿主直接调用。
   *   契约层支持 local 形态，避免为了满足「declarative 必须有 collect」而编造一个假 URL——
   *   那会让「本插件不出站」这一事实在契约层消失。
   */
  local: true,
} as const;
