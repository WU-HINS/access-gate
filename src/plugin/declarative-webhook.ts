/**
 * declarative webhook 端点（M4-7）—— docs/03 §1.13.4。
 *
 * ```
 *   endpoints:
 *     - path: /webhook/community
 *       method: POST
 *       auth: hmac
 *       hmac: { header: X-Signature-256, algo: sha256, secretRef: community.webhook_secret }
 *       kind: webhook                     # ← declarative 只支持这一种
 *       onReceive:
 *         subject:
 *           by: body.user.email           # 如何定位平台用户
 *           fallback: reject
 *         facts:
 *           namespace: community
 *           extract:
 *             - { path: "$.data.level", as: level }
 *         then: [emitFacts, triggerEvaluation]
 * ```
 *
 * ★ 验收标准（docs/07 M4-7 原文）：**「纯 YAML 插件可接收外部推送并产出 fact」**。
 *   因此本模块的一切行为都必须由**声明**驱动，不能有任何「内置知识」——
 *   宿主只知道「接收 → 校验 → 提取 → 写事实 / 触发评估」这五步。
 *
 * ★ 三处必须严格的地方：
 *
 * 1. **declarative 只允许 `kind: webhook`**（§1.13.4 的支持矩阵）：
 *    `declarative` 插件**没有代码**，宿主无法执行任意 handler。
 *    若允许它注册普通端点，那个端点被调用时**没有东西可以执行**——
 *    表现为「端点存在但永远 500」，而部署者会以为是插件坏了。
 *
 * 2. **`fallback: reject` 是安全默认**：定位不到平台用户时必须拒绝，
 *    而不是「默默丢弃」或「落到某个默认主体」——后者会把外部数据写到错误的人名下。
 *
 * 3. **提取失败要区分「字段不存在」与「字段存在但为空」**：
 *    前者说明上游改格式了（需要告警），后者是合法数据（如用户没填个人主页）。
 *    混为一谈会让「上游改格式」被当成正常波动而长期不被发现。
 */

import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── 类型 ───────────────────────────

export interface WebhookExtractRule {
  /** JSONPath 风格路径：`$.data.level` 或 `body.user.email` */
  path: string;
  /** 写入事实时的字段名 */
  as: string;
}

export interface DeclarativeWebhookSpec {
  path: string;
  method: string;
  auth: 'none' | 'hmac' | 'pluginToken' | 'session' | 'admin';
  hmac?: { header: string; algo: 'sha256'; secretRef: string };
  /** ★ declarative 只支持这一种 */
  kind: 'webhook';
  onReceive: {
    subject: {
      /** 从请求里定位平台用户（`body.user.email` / `$.data.user_id`） */
      by: string;
      /** 定位不到时的行为 */
      fallback: 'reject' | 'skip';
    };
    facts: {
      namespace: string;
      extract: readonly WebhookExtractRule[];
    };
    /** 接收后要执行的动作 */
    then?: readonly ('emitFacts' | 'triggerEvaluation')[];
  };
}

export interface WebhookValidationIssue {
  path: string;
  code: 'wrong_kind' | 'missing_path' | 'missing_method' | 'hmac_config_missing' | 'missing_subject_by' | 'bad_extract_path' | 'missing_namespace' | 'empty_extract';
  message: string;
  severity: 'error' | 'warning';
}

/**
 * 校验 declarative webhook 声明（**发布期**调用）。
 *
 * ★ 与端点宿主的校验互补：那一层管「路径安全与冲突」，
 *   这一层管「declarative 特有的能力边界」（如只允许 webhook）。
 */
export function validateDeclarativeWebhook(spec: Partial<DeclarativeWebhookSpec>): WebhookValidationIssue[] {
  const issues: WebhookValidationIssue[] = [];
  const at = { path: String(spec.path ?? '') };
  const error = (code: WebhookValidationIssue['code'], message: string): void => void issues.push({ ...at, code, message, severity: 'error' });

  // ① declarative 只支持 webhook
  if (spec.kind !== 'webhook') {
    error(
      'wrong_kind',
      `declarative 插件只支持 kind='webhook'（实际 '${String(spec.kind)}'）——` +
        `declarative 没有代码，普通端点被调用时**没有东西可执行**；需要自定义逻辑请改用 process 运行时`,
    );
  }
  if (spec.path === undefined || String(spec.path).length === 0) error('missing_path', '缺少 path');
  if (spec.method === undefined || String(spec.method).length === 0) error('missing_method', '缺少 method');
  if (spec.auth === 'hmac' && spec.hmac === undefined) {
    error('hmac_config_missing', 'auth=hmac 必须提供 hmac 配置（header / algo / secretRef）');
  }
  const onReceive = spec.onReceive;
  if (onReceive === undefined) {
    error('missing_subject_by', '缺少 onReceive（declarative webhook 必须声明如何定位主体与提取事实）');
    return issues;
  }
  if (typeof onReceive.subject?.by !== 'string' || onReceive.subject.by.length === 0) {
    error('missing_subject_by', '缺少 onReceive.subject.by（如何从请求定位平台用户）');
  }
  if (typeof onReceive.facts?.namespace !== 'string' || onReceive.facts.namespace.length === 0) {
    error('missing_namespace', '缺少 onReceive.facts.namespace（事实写到哪个命名空间）');
  }
  const extract = onReceive.facts?.extract ?? [];
  if (extract.length === 0) {
    error('empty_extract', 'onReceive.facts.extract 不能为空（否则这个 webhook 接收后什么也不产出）');
  }
  for (const rule of extract) {
    if (typeof rule.path !== 'string' || !rule.path.startsWith('$')) {
      error('bad_extract_path', `提取路径必须以 '$' 开头（JSONPath 风格），实际 '${String(rule.path)}'`);
    }
    if (typeof rule.as !== 'string' || rule.as.length === 0) {
      error('bad_extract_path', `提取规则缺少 as（写入事实时的字段名）`);
    }
  }
  return issues;
}

// ─────────────────────────── 路径求值 ───────────────────────────

export type PathLookup =
  | { found: true; value: unknown }
  | { found: false; reason: 'missing' | 'parent_missing' };

/**
 * 按路径取值。
 *
 * ★ 返回值刻意区分三种情况：
 *   - `found: true, value: undefined` → 字段**存在但值为 undefined**（合法数据）
 *   - `found: false, reason: 'missing'` → 父级存在但**没有这个字段**
 *   - `found: false, reason: 'parent_missing'` → **父级就不存在**（上游改了结构）
 *
 *   后两者对运维的含义完全不同：`parent_missing` 几乎总是「上游改格式了」，
 *   需要告警；而 `missing` 可能是正常的可选字段。
 */
export function lookupPath(root: unknown, path: string): PathLookup {
  // 允许 `body.` / `$.` 两种前缀（文档里两种写法都出现过）
  const normalized = path.replace(/^\$\.?/, '').replace(/^body\./, '');
  if (normalized.length === 0) return { found: true, value: root };

  const segments = normalized.split('.').filter((segment) => segment.length > 0);
  let current: unknown = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (current === null || current === undefined || typeof current !== 'object') {
      // 中途遇到非对象 → 结构不符（等价于「父级缺失」）
      return { found: false, reason: 'parent_missing' };
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) {
      // ★ 区分「**中间**段缺失」与「**末**段缺失」：
      //   - 中间段缺失（如 `$.data.level` 里没有 `data`）→ 上游**改了结构**，必须告警；
      //   - 末段缺失（`data` 在但没 `level`）→ 可能是本来就有的可选字段。
      //   混为一谈会让「上游改格式」被当成正常波动而长期不被发现。
      return { found: false, reason: index === segments.length - 1 ? 'missing' : 'parent_missing' };
    }
    current = record[segment];
  }
  return { found: true, value: current };
}

// ─────────────────────────── 接收与提取 ───────────────────────────

export interface WebhookReceiveInput {
  spec: DeclarativeWebhookSpec;
  /** 已解析的请求体 */
  body: unknown;
  headers: Record<string, string | undefined>;
}

export type WebhookReceiveResult =
  | {
      ok: true;
      /** 定位到的平台用户标识（`by` 路径取到的值） */
      subjectRef: string;
      namespace: string;
      /** 提取出的事实（字段名 → 值） */
      facts: Record<string, unknown>;
      /** 需要执行的动作 */
      then: readonly ('emitFacts' | 'triggerEvaluation')[];
      /** 提取过程中发现的问题（**不影响主流程，但需要告警**） */
      warnings: string[];
    }
  | { ok: false; reason: 'subject_not_found' | 'subject_invalid'; message: string };

/**
 * 执行 declarative webhook 的「接收 → 定位主体 → 提取」三步。
 *
 * ★ 宿主只做这五件事（接收/校验/提取/写事实/触发评估）——
 *   业务判断全部在**策略**里，而不是在这里。这是「宿主无知」在 webhook 上的体现：
 *   插件说「这个字段叫 level」，宿主就写一个叫 level 的事实，
 *   至于「level ≥ 10 算不算达标」由策略决定。
 */
export function receiveDeclarativeWebhook(input: WebhookReceiveInput, logger?: Logger): WebhookReceiveResult {
  const { spec, body } = input;

  // ① 定位主体
  const subjectLookup = lookupPath(body, spec.onReceive.subject.by);
  const subjectRef = subjectLookup.found ? subjectLookup.value : undefined;
  if (!subjectLookup.found || subjectRef === undefined || subjectRef === null || String(subjectRef).length === 0) {
    const detail = subjectLookup.found ? '取到的值为空' : subjectLookup.reason === 'parent_missing' ? '父级结构不存在（上游可能改了格式）' : '字段不存在';
    if (spec.onReceive.subject.fallback === 'skip') {
      return { ok: false, reason: 'subject_not_found', message: `按 '${spec.onReceive.subject.by}' 未定位到主体（${detail}），fallback=skip` };
    }
    // ★ fallback=reject 是安全默认：绝不「落到某个默认主体」
    return {
      ok: false,
      reason: 'subject_not_found',
      message: `按 '${spec.onReceive.subject.by}' 未定位到主体（${detail}）——fallback=reject，已拒绝该请求（不猜测归属）`,
    };
  }

  // ② 提取事实
  const facts: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const rule of spec.onReceive.facts.extract) {
    const result = lookupPath(body, rule.path);
    if (result.found) {
      facts[rule.as] = result.value;
      continue;
    }
    if (result.reason === 'parent_missing') {
      // ★ 父级缺失几乎总是「上游改格式了」——必须告警而不是静默跳过
      warnings.push(`提取路径 '${rule.path}' 的父级结构不存在（上游可能改了格式），字段 '${rule.as}' 未产出`);
      logger?.warn('declarative webhook 提取路径的父级缺失', { path: spec.path, rule: rule.path, field: rule.as });
    } else {
      warnings.push(`提取路径 '${rule.path}' 的字段不存在，字段 '${rule.as}' 未产出`);
    }
    // 不写入 undefined：让「未产出」与「产出 undefined」在事实层可区分
  }

  return {
    ok: true,
    subjectRef: String(subjectRef),
    namespace: spec.onReceive.facts.namespace,
    facts,
    then: spec.onReceive.then ?? ['emitFacts'],
    warnings,
  };
}

/** 从 manifest 里筛出 declarative webhook 声明（`kind === 'webhook'`）。 */
export function declarativeWebhooksOf(manifest: { endpoints?: unknown }): DeclarativeWebhookSpec[] {
  const endpoints = Array.isArray(manifest.endpoints) ? (manifest.endpoints as Partial<DeclarativeWebhookSpec>[]) : [];
  return endpoints.filter((endpoint) => endpoint.kind === 'webhook') as DeclarativeWebhookSpec[];
}

/**
 * `declarative` 与其它运行时的端点能力矩阵（docs/03 §1.13.4）。
 *
 * ★ 做成数据而不是散落的 if：新增运行时（如 `container`）时，
 *   只需在这里加一行，而不是去找「哪里判断了 declarative」。
 */
export const RUNTIME_ENDPOINT_CAPABILITY: Record<string, { arbitraryEndpoints: boolean; webhookOnly: boolean }> = {
  declarative: { arbitraryEndpoints: false, webhookOnly: true },
  process: { arbitraryEndpoints: true, webhookOnly: false },
  container: { arbitraryEndpoints: true, webhookOnly: false },
  'in-process': { arbitraryEndpoints: true, webhookOnly: false },
};

/** 判定某运行时能否注册给定端点（declarative 只能是 webhook）。 */
export function canRegisterEndpoint(runtime: string, endpoint: { kind?: string }): { ok: true } | { ok: false; message: string } {
  const capability = RUNTIME_ENDPOINT_CAPABILITY[runtime];
  if (capability === undefined) return { ok: false, message: `未知运行时 '${runtime}'` };
  if (capability.webhookOnly && endpoint.kind !== 'webhook') {
    return {
      ok: false,
      message: `运行时 '${runtime}' 没有代码，只能注册 kind='webhook' 的端点（声明式的「接收→提取→写事实」）；需要自定义逻辑请改用 process`,
    };
  }
  return { ok: true };
}
