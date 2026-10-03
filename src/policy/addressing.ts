/**
 * 统一寻址与绑定解析（M3-3）—— docs/04 §1.2.7。
 *
 * ```
 *   <root> ":" <pluginId> [ "@" <instanceKey> ] [ "#" <siteSlug> ] "." <path>
 *   root := "subject" | "fact" | "identity" | "me"
 * ```
 *
 * ★ 为什么必须有统一寻址（文档原话的意思）：`fact.<ns>.<path>` 这类写法
 *   既没有「**实例**」维度（一个插件可接多个 bot / 多个站点），
 *   也无法表达「**用户在某个下游系统里是谁**」（那需要绑定解析）。
 *
 * ★ 三条硬规则（写错必须**拒绝发布**，而不是求值期静默取到 null）：
 *
 * 1. `@instanceKey` 是否必需由插件的 `instances.mode` 决定：
 *    - `singleton`：**不得**带 `@`（带了 → 拒绝）；
 *    - `multi`：**必须**带 `@`（不带 → 拒绝）。
 *    静默取到 null 会让「配错了」表现成「事实缺失」→ 判为 `indeterminate`，
 *    真正的配置错误被藏起来，非常难排查。
 *
 * 2. `#siteSlug` 是**跨站点引用**，默认禁止；只有平台级 admin 策略可用。
 *
 * 3. 路径支持数组下标与通配：`fact:github.orgs[0]`、`fact:github.repos[*].stars`。
 *
 * ★ 兼容旧写法：`fact.email.domain`（点号）与 `user.status` 仍可解析，
 *   但会被**归一化**为统一结构（`user` → `me`），并标记 `syntax: 'legacy'`
 *   供发布时给出「建议改写成新写法」的提示。
 */

// ─────────────────────────── 类型 ───────────────────────────

export type AddressRoot = 'subject' | 'fact' | 'identity' | 'me' | 'binding';

export interface Address {
  root: AddressRoot;
  /** `me` 之外的 root 需要 pluginId */
  pluginId?: string;
  instanceKey?: string;
  /** 跨站点引用（默认禁止） */
  siteSlug?: string;
  /** 路径段（已拆分数组下标：`repos[*].stars` → ['repos','*','stars']） */
  path: string[];
  /** 原始文本 */
  raw: string;
  /** 语法形态：带冒号为 qualified，旧点号写法为 legacy */
  syntax: 'qualified' | 'legacy';
}

export interface PluginAddressing {
  /** `singleton`：全站唯一配置；`multi`：可有多个实例 */
  mode: 'singleton' | 'multi';
  /** 该插件已知的实例 key（可选；提供后可校验 `@key` 是否存在） */
  instanceKeys?: readonly string[];
}

export type AddressingRegistry = Readonly<Record<string, PluginAddressing>>;

export class AddressSyntaxError extends Error {
  override readonly name = 'AddressSyntaxError';
  readonly raw: string;
  constructor(raw: string, message: string) {
    super(`寻址 '${raw}' 语法错误：${message}`);
    this.raw = raw;
  }
}

export interface AddressIssue {
  raw: string;
  code: 'unknown_plugin' | 'instance_required' | 'instance_forbidden' | 'unknown_instance' | 'cross_site_forbidden' | 'empty_path' | 'legacy_syntax';
  message: string;
  severity: 'error' | 'warning';
}

// ─────────────────────────── 解析 ───────────────────────────

const ROOTS = new Set<string>(['subject', 'fact', 'identity', 'me', 'binding']);

/**
 * 解析寻址表达式。
 *
 * 支持的形态：
 * ```
 *   fact:github.total_stars              # 新写法（推荐）
 *   fact:webhook@orders.event_count      # 带实例
 *   fact:github#site-b.total_stars       # 跨站点
 *   identity:oidc@external.proj-a.sub
 *   me.tags                              # me 无 pluginId
 *   fact.email.domain                    # 旧写法（兼容，标记 legacy）
 *   user.status                          # 旧写法 → 归一为 me.status
 * ```
 */
export function parseAddress(raw: string): Address {
  const text = raw.trim();
  if (text.length === 0) throw new AddressSyntaxError(raw, '不能为空');

  const colonIndex = text.indexOf(':');

  // ── 带冒号：qualified 形态 ──
  if (colonIndex >= 0) {
    const root = text.slice(0, colonIndex);
    if (!ROOTS.has(root)) {
      throw new AddressSyntaxError(raw, `未知的 root '${root}'（可用：subject / fact / identity / me / binding）`);
    }
    const rest = text.slice(colonIndex + 1);

    // me：`me.tags` 或 `me:...`（后者也接受，但通常不需要 pluginId）
    const { scope, tail } = splitScope(rest, raw);
    const dotIndex = tail.indexOf('.');
    if (dotIndex < 0) {
      if (tail.length === 0) throw new AddressSyntaxError(raw, '缺少路径（`<root>:<pluginId>.<path>`）');
      throw new AddressSyntaxError(raw, `缺少 '.' 分隔的路径（实际：'${tail}'）`);
    }
    const pluginId = tail.slice(0, dotIndex);
    const pathText = tail.slice(dotIndex + 1);
    if (pluginId.length === 0) throw new AddressSyntaxError(raw, '缺少 pluginId');
    if (pathText.length === 0) throw new AddressSyntaxError(raw, '缺少路径');

    const address: Address = { root: root as AddressRoot, pluginId, path: parsePath(pathText, raw), raw: text, syntax: 'qualified' };
    if (scope.instanceKey !== undefined) address.instanceKey = scope.instanceKey;
    if (scope.siteSlug !== undefined) address.siteSlug = scope.siteSlug;
    return address;
  }

  // ── 不带冒号：legacy 点号写法 ──
  const firstDot = text.indexOf('.');
  if (firstDot < 0) throw new AddressSyntaxError(raw, '缺少路径（应形如 `fact.email.domain` 或 `fact:email.domain`）');
  const head = text.slice(0, firstDot);
  const rest = text.slice(firstDot + 1);
  if (rest.length === 0) throw new AddressSyntaxError(raw, '缺少路径');

  // `user` 是旧写法的平台用户属性 → 归一为 `me`（这才是 legacy）
  if (head === 'user') {
    return { root: 'me', path: parsePath(rest, raw), raw: text, syntax: 'legacy' };
  }
  if (!ROOTS.has(head)) {
    throw new AddressSyntaxError(raw, `未知的 root '${head}'（可用：fact / user / binding / subject / identity / me）`);
  }

  // ★ `me.tags` 与 `binding.<pluginId>.<field>` 是**文档给出的规范写法**
  //   （它们本来就不需要冒号，因为 root 后直接跟路径），因此不判 legacy。
  //   只有 `fact.x.y` / `subject.x.y` / `identity.x.y` 这类有「限定写法」对应的才提示改写。
  if (head === 'me') {
    return { root: 'me', path: parsePath(rest, raw), raw: text, syntax: 'qualified' };
  }
  if (head === 'binding') {
    const secondDot = rest.indexOf('.');
    if (secondDot < 0) throw new AddressSyntaxError(raw, '缺少路径（`binding.<pluginId>.<field>`）');
    return {
      root: 'binding',
      pluginId: rest.slice(0, secondDot),
      path: parsePath(rest.slice(secondDot + 1), raw),
      raw: text,
      syntax: 'qualified',
    };
  }
  const secondDot = rest.indexOf('.');
  if (secondDot < 0) throw new AddressSyntaxError(raw, `缺少路径（\`${head}.<pluginId>.<path>\`）`);
  const pluginId = rest.slice(0, secondDot);
  const pathText = rest.slice(secondDot + 1);
  if (pathText.length === 0) throw new AddressSyntaxError(raw, '缺少路径');
  return { root: head as AddressRoot, pluginId, path: parsePath(pathText, raw), raw: text, syntax: 'legacy' };
}

/** 拆出 `@instanceKey` 与 `#siteSlug`（顺序固定：先 @ 后 #）。 */
function splitScope(text: string, raw: string): { scope: { instanceKey?: string; siteSlug?: string }; tail: string } {
  let remaining = text;
  const scope: { instanceKey?: string; siteSlug?: string } = {};

  const atIndex = remaining.indexOf('@');
  if (atIndex >= 0) {
    const afterAt = remaining.slice(atIndex + 1);
    // ★ instanceKey 到**最近的** `.` 或 `#` 为止——否则会把路径一起吃进实例名
    //   （`identity:oidc@external.proj-a.sub` 的实例是 `external`，路径是 `proj-a.sub`）
    const dotInAfter = afterAt.indexOf('.');
    const hashInAfter = afterAt.indexOf('#');
    let end = afterAt.length;
    if (dotInAfter >= 0) end = Math.min(end, dotInAfter);
    if (hashInAfter >= 0) end = Math.min(end, hashInAfter);
    const instanceKey = afterAt.slice(0, end);
    if (instanceKey.length === 0) throw new AddressSyntaxError(raw, '`@` 后缺少 instanceKey');
    scope.instanceKey = instanceKey;
    remaining = remaining.slice(0, atIndex) + afterAt.slice(end);
  }

  const hashIndex = remaining.indexOf('#');
  if (hashIndex >= 0) {
    const afterHash = remaining.slice(hashIndex + 1);
    const dotInAfter = afterHash.indexOf('.');
    const siteSlug = dotInAfter >= 0 ? afterHash.slice(0, dotInAfter) : afterHash;
    if (siteSlug.length === 0) throw new AddressSyntaxError(raw, '`#` 后缺少 siteSlug');
    scope.siteSlug = siteSlug;
    remaining = remaining.slice(0, hashIndex) + (dotInAfter >= 0 ? afterHash.slice(dotInAfter) : '');
  }

  return { scope, tail: remaining };
}

/**
 * 拆路径段，含数组下标与通配。
 *
 * `orgs[0]` → ['orgs','0']；`repos[*].stars` → ['repos','*','stars']。
 */
export function parsePath(text: string, raw = text): string[] {
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '.') {
      // 连续的 '.'（如 `a..b`）是明确的输入错误。
      // ★ 判据是「前一个字符也是 '.'」，而不是「current 为空」——
      //   因为 `repos[*].stars` 在 `]` 之后 current 本来就是空的（那是合法的）。
      if (text[i - 1] === '.' || i === 0 || i === text.length - 1) {
        throw new AddressSyntaxError(raw, "路径中出现空的段（连续的 '.' 或首尾的 '.'）");
      }
      // `[*]` 之后 current 本来就是空的——只有非空段才 push
      if (current.length > 0) segments.push(current);
      current = '';
      continue;
    }
    if (char === '[') {
      if (current.length > 0) {
        segments.push(current);
        current = '';
      }
      const close = text.indexOf(']', i);
      if (close < 0) throw new AddressSyntaxError(raw, `'[' 没有匹配的 ']'`);
      const index = text.slice(i + 1, close).trim();
      if (index.length === 0) throw new AddressSyntaxError(raw, '空的下标 `[]`');
      segments.push(index);
      i = close;
      continue;
    }
    if (char === ']') throw new AddressSyntaxError(raw, `多余的 ']'`);
    current += char;
  }
  if (current.length > 0) segments.push(current);
  if (segments.length === 0) throw new AddressSyntaxError(raw, '路径为空');
  return segments;
}

/** 归一化回**规范文本**（qualified 形态），用于展示与去重。 */
export function formatAddress(address: Address): string {
  const scope = `${address.instanceKey === undefined ? '' : `@${address.instanceKey}`}${address.siteSlug === undefined ? '' : `#${address.siteSlug}`}`;
  const path = formatPath(address.path);
  if (address.root === 'me') return `me.${path}`;
  return `${address.root}:${address.pluginId}${scope}.${path}`;
}

/** 路径段还原为文本（数字下标用 `[n]`，通配用 `[*]`）。 */
export function formatPath(path: readonly string[]): string {
  let out = '';
  for (const segment of path) {
    if (/^\d+$/.test(segment) || segment === '*') {
      out += `[${segment}]`;
    } else {
      out += out.length === 0 ? segment : `.${segment}`;
    }
  }
  return out;
}

// ─────────────────────────── 校验 ───────────────────────────

/**
 * 校验寻址是否合法（**发布期**调用）。
 *
 * 返回全部问题而不是抛第一个——「修一个报一个」在策略编辑里体验极差。
 */
export function validateAddress(
  address: Address,
  registry: AddressingRegistry,
  options: { currentSiteSlug?: string; allowCrossSite?: boolean } = {},
): AddressIssue[] {
  const issues: AddressIssue[] = [];

  if (address.root === 'me') {
    if (address.path.length === 0) issues.push({ raw: address.raw, code: 'empty_path', message: '`me` 必须带路径（如 me.tags）', severity: 'error' });
  } else {
    const pluginId = address.pluginId;
    if (pluginId === undefined) {
      issues.push({ raw: address.raw, code: 'empty_path', message: `${address.root} 必须带 pluginId`, severity: 'error' });
    } else {
      const declared = registry[pluginId];
      if (declared === undefined) {
        issues.push({
          raw: address.raw,
          code: 'unknown_plugin',
          message: `插件 '${pluginId}' 未安装或未在寻址表中声明（已声明：${Object.keys(registry).sort().join(', ') || '（无）'}）`,
          severity: 'error',
        });
      } else if (declared.mode === 'singleton') {
        // ★ singleton 带 @ → 拒绝（否则会静默取到 null，配置错误被藏成「事实缺失」）
        if (address.instanceKey !== undefined) {
          issues.push({
            raw: address.raw,
            code: 'instance_forbidden',
            message: `插件 '${pluginId}' 声明为 singleton，不得带 @instanceKey（实际带了 '@${address.instanceKey}'）`,
            severity: 'error',
          });
        }
      } else {
        // ★ multi 不带 @ → 拒绝
        if (address.instanceKey === undefined) {
          issues.push({
            raw: address.raw,
            code: 'instance_required',
            message: `插件 '${pluginId}' 声明为 multi，必须带 @instanceKey（如 ${address.root}:${pluginId}@orders.${formatPath(address.path)}）`,
            severity: 'error',
          });
        } else if (declared.instanceKeys !== undefined && !declared.instanceKeys.includes(address.instanceKey)) {
          issues.push({
            raw: address.raw,
            code: 'unknown_instance',
            message: `插件 '${pluginId}' 没有实例 '${address.instanceKey}'（已知：${[...declared.instanceKeys].sort().join(', ') || '（无）'}）`,
            severity: 'error',
          });
        }
      }
    }
  }

  // 跨站点引用
  if (address.siteSlug !== undefined) {
    if (options.allowCrossSite !== true) {
      issues.push({
        raw: address.raw,
        code: 'cross_site_forbidden',
        message: `跨站点引用 '#${address.siteSlug}' 仅平台级 admin 策略可用（当前策略不允许）`,
        severity: 'error',
      });
    }
  }

  // 旧写法：允许但提示改写
  if (address.syntax === 'legacy') {
    issues.push({
      raw: address.raw,
      code: 'legacy_syntax',
      message: `建议改写为限定写法 '${formatAddress(address)}'（旧点号写法将不再支持 @实例 与 #跨站点）`,
      severity: 'warning',
    });
  }

  return issues;
}

// ─────────────────────────── 绑定解析 ───────────────────────────

/** 绑定记录（`ag_plugin_bindings` 的最小视图） */
export interface BindingRecord {
  pluginId: string;
  instanceKey: string;
  externalId: string;
  status: 'active' | 'revoked' | 'pending';
}

export interface BindingResolver {
  /** 按 (平台用户, 插件, 实例) 查绑定 */
  find(userId: string, pluginId: string, instanceKey: string): Promise<BindingRecord | undefined>;
  /**
   * 自动解析（绑定缺失时按插件声明的 `binding.keys` 尝试）。
   *
   * 返回 undefined 表示解析不到——那会让该操作数为 `missing`，交由 `$onMissing` 决定。
   */
  autoResolve?(userId: string, pluginId: string, instanceKey: string): Promise<BindingRecord | undefined>;
}

export type BindingResolution =
  | { status: 'resolved'; externalId: string; source: 'binding' | 'auto'; binding: BindingRecord }
  | { status: 'missing'; reason: 'no_binding' | 'revoked' }
  | { status: 'not_applicable'; reason: 'root_does_not_need_binding' };

/**
 * 绑定解析：`subject:newapi.group` 里的**主体是谁**（docs/04 §1.2.7.2）。
 *
 * ```
 *   ① 当前评估上下文有一个【平台用户】
 *   ② 查绑定 (平台用户, plugin, instance)
 *        ├─ 命中   → 得到 externalId
 *        └─ 未命中 → 按插件声明的 binding.keys 尝试【自动解析】
 *   ③ 用 externalId 读下游主体属性
 *   ④ 任一步失败 → missing（交由 $onMissing 决定）
 * ```
 *
 * ★ 只有 `subject` / `binding` root 需要绑定解析；`fact` 是插件采集的证据（按站点/实例存），
 *   `me` 是平台用户自身，`identity` 是身份标识——它们都不需要「下游是谁」这一步。
 */
export async function resolveBinding(options: {
  address: Address;
  userId: string;
  resolver: BindingResolver;
}): Promise<BindingResolution> {
  const { address, userId, resolver } = options;
  if (address.root !== 'subject' && address.root !== 'binding') {
    return { status: 'not_applicable', reason: 'root_does_not_need_binding' };
  }
  const pluginId = address.pluginId;
  const instanceKey = address.instanceKey ?? 'default';
  if (pluginId === undefined) return { status: 'missing', reason: 'no_binding' };

  const direct = await resolver.find(userId, pluginId, instanceKey);
  if (direct !== undefined) {
    // ★ 已撤销的绑定**不能**支撑取值（否则「解绑后仍能读到下游属性」= 因果断裂）
    if (direct.status === 'revoked') return { status: 'missing', reason: 'revoked' };
    return { status: 'resolved', externalId: direct.externalId, source: 'binding', binding: direct };
  }

  const auto = await resolver.autoResolve?.(userId, pluginId, instanceKey);
  if (auto !== undefined && auto.status !== 'revoked') {
    return { status: 'resolved', externalId: auto.externalId, source: 'auto', binding: auto };
  }

  return { status: 'missing', reason: 'no_binding' };
}

/** 批量校验：给定策略里出现的全部寻址文本，返回按文本分组的问题。 */
export function validateAddresses(
  rawAddresses: readonly string[],
  registry: AddressingRegistry,
  options: { currentSiteSlug?: string; allowCrossSite?: boolean } = {},
): { byAddress: Map<string, AddressIssue[]>; errors: number; warnings: number } {
  const byAddress = new Map<string, AddressIssue[]>();
  let errors = 0;
  let warnings = 0;
  for (const raw of rawAddresses) {
    let issues: AddressIssue[];
    try {
      issues = validateAddress(parseAddress(raw), registry, options);
    } catch (error) {
      issues = [{ raw, code: 'empty_path', message: error instanceof Error ? error.message : String(error), severity: 'error' }];
    }
    if (issues.length > 0) byAddress.set(raw, issues);
    for (const issue of issues) {
      if (issue.severity === 'error') errors += 1;
      else warnings += 1;
    }
  }
  return { byAddress, errors, warnings };
}
