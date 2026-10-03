/**
 * OIDC 双向联邦（M5-6）—— docs/06 §6、docs/03 §1.18、docs/08 §430。
 *
 * ```
 *   inbound  （external:*）  项目是 IdP，平台是 RP —— 用户用**项目账号登录平台**
 *   outbound （platform:*）  平台是 IdP，项目是 RP —— 用户用平台账号登录项目
 * ```
 *
 * ★ 验收标准（docs/07 M5-6）：**「用户可用项目账号登录平台」**——即 inbound 联邦登录。
 *
 * 两个方向**注册在同一张表**里（`ag_oidc_providers`），各有**永不变的唯一标识符 `ref`**。
 *
 * ★ 三条必须严格的地方：
 *
 * 1. **最小暴露（`exposedClaims`）**——只有声明的 claim 能被表达式读取
 *    （`identity:oidc@<ref>.<claim>`），其余 claim **既不落库也不可见**。
 *    ★ 关键在「不落库」三个字：若先全量存下来、只是查询时过滤，
 *    那么一次「查询忘了加过滤」就是**全量身份信息泄露**（邮箱、姓名、群组……）。
 *    因此过滤必须发生在**写入之前**。
 *
 * 2. **`ref` 不可变**——它是表达式里写死的引用（`identity:oidc@github.<claim>`）。
 *    若允许改名，所有引用它的策略会**静默失效**（引用不到 → 判定为 indeterminate），
 *    而用户看到的是「资格莫名其妙没了」。
 *
 * 3. **站点不得新增 `platform:*` 的 ref**（docs/08 §430）——`platform:developer` /
 *    `platform:enduser` 是**平台保留**的两个链路标识，站点只能注册 `external:*`。
 *    否则一个站点就能伪造「平台链路」，绕过 M7-3/M7-4 的准入策略。
 */

import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── 类型 ───────────────────────────

export type OidcDirection = 'inbound' | 'outbound';

export interface OidcProviderRegistration {
  /** ★ 永不变的唯一标识符（`external:*` 或 `platform:*`） */
  ref: string;
  direction: OidcDirection;
  /** 展示名（给用户看：「用 GitHub 登录」） */
  displayName: string;
  issuer: string;
  clientId: string;
  /** 客户端密钥的**引用**（宿主托管，不落这张表——与插件密钥同一原则） */
  clientSecretRef: string;
  scopes: readonly string[];
  /**
   * ★ 允许被表达式读取的 claim 白名单。
   *   未在此列出的 claim **既不落库也不可见**。
   */
  exposedClaims: readonly string[];
  /** 是否允许用该凭证**登录平台自身**（outbound 凭证的额外用途） */
  allowPlatformLogin: boolean;
  status: 'active' | 'disabled';
  createdAt: Date;
}

export interface FederationIssue {
  code:
    | 'bad_ref_format'
    | 'platform_ref_reserved'
    | 'platform_ref_immutable'
    | 'ref_changed'
    | 'insecure_issuer'
    | 'missing_scope'
    | 'claim_not_declared'
    | 'login_not_allowed'
    | 'provider_disabled';
  message: string;
  severity: 'error' | 'warning';
}

// ─────────────────────────── 校验 ───────────────────────────

/** 平台保留的 ref（站点不得注册，也不得改名）。 */
export const RESERVED_PLATFORM_REFS: readonly string[] = ['platform:developer', 'platform:enduser'];

export function isPlatformRef(ref: string): boolean {
  return ref.startsWith('platform:');
}

export function isExternalRef(ref: string): boolean {
  return ref.startsWith('external:');
}

/**
 * 校验一次 OIDC 注册（**发布期**调用）。
 *
 * ★ `actor: 'platform' | 'site'` 决定了权限：
 *   站点管理员只能注册 `external:*`——若允许它注册 `platform:*`，
 *   站点就能伪造平台链路，绕过 M7-3/M7-4 的准入策略（那两条链路的隔离就白做了）。
 */
export function validateRegistration(
  input: Partial<OidcProviderRegistration>,
  context: { actor: 'platform' | 'site'; existingRefs?: readonly string[] },
): FederationIssue[] {
  const issues: FederationIssue[] = [];
  const push = (code: FederationIssue['code'], message: string): void => void issues.push({ code, message, severity: 'error' });

  const ref = input.ref ?? '';
  if (!isPlatformRef(ref) && !isExternalRef(ref)) {
    push('bad_ref_format', `ref '${ref}' 格式非法：必须以 'external:' 或 'platform:' 开头（后者为平台保留）`);
  }
  // ★ 站点不得注册平台保留的 ref
  if (context.actor === 'site' && isPlatformRef(ref)) {
    push(
      'platform_ref_reserved',
      `站点不得注册 '${ref}'：'platform:*' 是**平台保留**的链路标识（${RESERVED_PLATFORM_REFS.join(' / ')}）。` +
        `若允许站点注册，它就能伪造平台链路，绕过准入策略（M7-3/M7-4 的隔离将失效）`,
    );
  }
  // 重复注册
  if (context.existingRefs?.includes(ref) === true) {
    push('ref_changed', `ref '${ref}' 已存在——ref 永不变，如需修改请改该注册的其它字段`);
  }
  // issuer 必须 https（本地开发除外）
  const issuer = input.issuer ?? '';
  if (issuer.length > 0 && !issuer.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(issuer)) {
    push('insecure_issuer', `issuer '${issuer}' 必须使用 https（http 的 IdP 可被中间人替换令牌签发方）`);
  }
  // 必须有 openid scope（否则拿不到 id_token，也就不是 OIDC）
  if (input.scopes !== undefined && !input.scopes.includes('openid')) {
    push('missing_scope', `scopes 必须包含 'openid'（否则响应里没有 id_token，不构成 OIDC 登录）`);
  }
  // exposedClaims 必须是显式清单（空数组是合法的「什么都不暴露」）
  if (input.exposedClaims === undefined) {
    issues.push({ code: 'claim_not_declared', message: 'exposedClaims 必须显式声明（可以是空数组表示不暴露任何 claim）', severity: 'warning' });
  }
  return issues;
}

/** 校验一次 ref 修改（**ref 本身不可变**）。 */
export function validateRefChange(currentRef: string, nextRef: string): FederationIssue[] {
  if (currentRef === nextRef) return [];
  return [
    {
      code: isPlatformRef(currentRef) ? 'platform_ref_immutable' : 'ref_changed',
      message:
        `不得修改 ref（'${currentRef}' → '${nextRef}'）：ref 是**表达式里写死的引用**` +
        `（如 identity:oidc@${currentRef}.email）。改名会让所有引用它的策略**静默失效**` +
        `（引用不到 → 判定为 indeterminate），而用户看到的是「资格莫名其妙没了」`,
      severity: 'error',
    },
  ];
}

// ─────────────────────────── ★ 最小暴露 ───────────────────────────

export interface ClaimProjection {
  /** 只含**已声明**的 claim（这就是会被持久化的全部内容） */
  projected: Record<string, unknown>;
  /** 被丢弃的 claim 名（**只记名字，不记值**） */
  dropped: string[];
  /** 表达式可读的路径（`identity:oidc@<ref>.<claim>`） */
  addressable: string[];
}

/**
 * 把 IdP 返回的 claims 投影到 `exposedClaims` 白名单。
 *
 * ★★ 这是本模块**最重要**的函数：它是「最小暴露」的执行点。
 *
 *   文档要求「只有 `exposedClaims` 里声明的 claim 能被表达式读取，
 *   其余 claim **既不落库也不可见**」。
 *   因此**调用方必须把 `projected` 作为持久化对象**——
 *   而不是把原始 claims 存下来、查询时再过滤。
 *   后者只要有一次「查询忘了加过滤」，就是全量身份信息泄露
 *   （邮箱、姓名、群组、甚至 IdP 特有的敏感字段）。
 *
 * ★ `dropped` 只记**名字**：排障时要知道「我们丢了哪些 claim」，
 *   但**不能把值写进日志**——那等于换了个地方泄露。
 */
export function projectExposedClaims(rawClaims: Record<string, unknown>, exposedClaims: readonly string[]): ClaimProjection {
  const allowed = new Set(exposedClaims);
  const projected: Record<string, unknown> = {};
  const dropped: string[] = [];
  const addressable: string[] = [];

  for (const [name, value] of Object.entries(rawClaims)) {
    if (allowed.has(name)) {
      projected[name] = value;
      addressable.push(name);
    } else {
      // 只记名字，不记值
      dropped.push(name);
    }
  }
  return { projected, dropped: dropped.sort(), addressable: addressable.sort() };
}

/** 表达式里的可读路径（`identity:oidc@<ref>.<claim>`）。 */
export function claimAddressOf(ref: string, claim: string): string {
  return `identity:oidc@${ref}.${claim}`;
}

/** 判定某 claim 是否可被表达式读取（未声明 → 不可读，且**不存在**）。 */
export function isClaimAddressable(ref: string, claim: string, registration: Pick<OidcProviderRegistration, 'exposedClaims'>): boolean {
  void ref;
  return registration.exposedClaims.includes(claim);
}

// ─────────────────────────── 联邦登录 ───────────────────────────

export interface FederatedLoginInput {
  registration: OidcProviderRegistration;
  /** IdP 返回的 subject（`sub`） */
  subject: string;
  /** IdP 返回的全部 claims（**投影前的原始值**） */
  rawClaims: Record<string, unknown>;
  /** 该次登录希望进入的平台链路 */
  targetRef: string;
  emailVerified: boolean;
}

export type FederatedLoginResult =
  | {
      ok: true;
      /** 该联邦身份在平台内的稳定标识（`<ref>:<sub>`） */
      federatedId: string;
      provider: string;
      /** ★ 只有已声明的 claim（会被持久化的全部内容） */
      claims: Record<string, unknown>;
      /** 被丢弃的 claim 名（用于审计与排障） */
      droppedClaims: string[];
      /** 进入哪条平台链路（由调用方交给 flows.ts 的准入判定） */
      targetRef: string;
    }
  | { ok: false; code: FederationIssue['code'] | 'subject_missing'; message: string };

/**
 * 处理一次联邦登录（inbound）。
 *
 * ★ 与 `flows.ts` 的分工：本函数只负责**把外部身份变成平台的候选身份**，
 *   **不决定准入**——「该不该让他进来」由 `flows.ts` 的
 *   `platform:developer`（必须已入驻）/ `platform:enduser`（自动建号）判定。
 *   这样「身份来源」与「准入策略」解耦：新增一个 IdP 不影响准入规则。
 */
export function resolveFederatedLogin(input: FederatedLoginInput, logger?: Logger): FederatedLoginResult {
  const { registration } = input;
  if (registration.status !== 'active') {
    return { ok: false, code: 'provider_disabled', message: `OIDC 注册 '${registration.ref}' 已停用，无法用于登录` };
  }
  if (registration.direction !== 'inbound') {
    return {
      ok: false,
      code: 'login_not_allowed',
      message: `'${registration.ref}' 是 outbound 注册（平台作为 IdP），不能用于「用项目账号登录平台」`,
    };
  }
  if (input.subject.trim().length === 0) {
    return { ok: false, code: 'subject_missing', message: 'IdP 未返回 sub（subject），无法建立稳定身份' };
  }

  // ★ 最小暴露：先投影，再返回（调用方持久化的是 `claims`）
  const projection = projectExposedClaims(input.rawClaims, registration.exposedClaims);
  if (projection.dropped.length > 0) {
    // ★ 只记名字，不记值
    logger?.info('联邦登录：部分 claim 未被暴露（已丢弃）', { ref: registration.ref, dropped: projection.dropped });
  }

  return {
    ok: true,
    // ★ 用 `ref:sub` 而不是裸 `sub`：不同 IdP 的 sub 可能撞车（都是数字 id 很常见）
    federatedId: `${registration.ref}:${input.subject}`,
    provider: registration.ref,
    claims: projection.projected,
    droppedClaims: projection.dropped,
    targetRef: input.targetRef,
  };
}

// ─────────────────────────── 发现文档 ───────────────────────────

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  subject_types_supported: string[];
  scopes_supported: string[];
  id_token_signing_alg_values_supported: string[];
  code_challenge_methods_supported: string[];
}

/**
 * 生成 outbound 的发现文档（平台作为 IdP）。
 *
 * ★ `code_challenge_methods_supported` 必须包含 `S256` 且**不含 `plain`**：
 *   文档要求「PKCE 必需」——允许 `plain` 等于允许不加密的 challenge，
 *   而 `plain` 的 challenge 与 verifier 相同，一旦泄露就失去意义。
 */
export function buildDiscoveryDocument(issuer: string, signingAlgorithms: readonly string[]): DiscoveryDocument {
  const base = issuer.replace(/\/+$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    jwks_uri: `${base}/oauth/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    scopes_supported: ['openid', 'profile', 'email'],
    id_token_signing_alg_values_supported: [...signingAlgorithms],
    code_challenge_methods_supported: ['S256'],
  };
}

/**
 * 校验远端发现文档（inbound 注册时的 `discover` 调用）。
 *
 * ★ 三条检查：
 *   1. **issuer 必须与文档自称一致**（防「发现文档来自 A、issuer 写 B」的混淆攻击）；
 *   2. **必须支持 `code` 授权类型**（隐式流已被废弃，且无法安全持有令牌）；
 *   3. **签名算法必须在我们接受的集合内**（`none` 一律拒绝）。
 */
export function validateDiscoveryDocument(
  document: Partial<DiscoveryDocument>,
  input: { expectedIssuer: string; allowedAlgorithms: readonly string[] },
): FederationIssue[] {
  const issues: FederationIssue[] = [];
  const push = (code: FederationIssue['code'], message: string): void => void issues.push({ code, message, severity: 'error' });

  if (document.issuer !== input.expectedIssuer) {
    push(
      'insecure_issuer',
      `发现文档的 issuer '${document.issuer ?? '(缺失)'}' 与注册时填写的 '${input.expectedIssuer}' 不一致——` +
        `这可能是「发现文档来自 A、issuer 写 B」的混淆攻击，必须拒绝`,
    );
  }
  if (document.response_types_supported !== undefined && !document.response_types_supported.includes('code')) {
    push('missing_scope', '远端不支持 code 授权类型（隐式流无法安全持有令牌）');
  }
  const algorithms = document.id_token_signing_alg_values_supported ?? [];
  if (algorithms.includes('none')) push('bad_ref_format', `远端支持 'none' 签名算法——未签名的 id_token 不可接受`);
  const usable = algorithms.filter((algorithm) => input.allowedAlgorithms.includes(algorithm));
  if (algorithms.length > 0 && usable.length === 0) {
    push('bad_ref_format', `远端支持的签名算法（${algorithms.join(', ')}）与平台接受集合（${input.allowedAlgorithms.join(', ')}）无交集`);
  }
  return issues;
}
