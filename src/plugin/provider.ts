/**
 * provider 插件契约（M1-1）—— **让核心与具体下游系统彻底解耦**（docs/03 §1.16）。
 *
 * 核心只认识 `ExternalSubject`（主体）：`externalId` + 属性袋 `attributes`。
 * 「new-api 的 group」「Discord 的 roles」「K8s 的 namespace」在核心眼里**都只是属性袋里的键**，
 * 核心不解释其含义。这是 D5（通用信任引擎）在类型层的体现。
 *
 * ★ 关于 `subjectSchema`：docs/03 原文写的是 ZodType。本项目**不引入 Zod**（减少依赖，
 *   且 schema 要能跨插件边界序列化传给宿主做静态校验）。因此这里用 **JSON Schema 子集**
 *   表达同一件事，并保留 `watch` 标记——对账器的指纹只对 `watch: true` 的字段计算。
 */

export interface SubjectPropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  description?: string;
  /**
   * ★ 是否参与**对账指纹**。
   *   true  → 该字段变化会让指纹变化，从而触发 `subject.attributes_changed` 与策略重评估；
   *   false → 只是展示/排障信息（如 `raw`、`last_login`），变化不触发下游动作。
   *
   * 缺省 false：**显式声明才参与指纹**——避免把噪声字段（时间戳、请求计数）算进去，
   * 否则每轮对账都会误报「属性变更」，把策略重评估打成风暴。
   */
  watch?: boolean;
  nullable?: boolean;
}

export interface SubjectSchema {
  type: 'object';
  properties: Record<string, SubjectPropertySchema>;
  required?: readonly string[];
}

/** 通用主体模型——一切下游系统的统一投影。 */
export interface ExternalSubject {
  /** 下游系统的主键（new-api 的 users.id / Discord 的 user id / K8s 的 subject name） */
  externalId: string;
  displayName?: string;
  email?: string;
  /** 属性袋：核心不解释其含义 */
  attributes: Record<string, unknown>;
  /** 原始对象（**必须脱敏后**），仅用于排障展示 */
  raw?: unknown;
}

export interface SubjectPage {
  subjects: readonly ExternalSubject[];
  /** 下一页游标；null 表示已到末页 */
  nextCursor: string | null;
}

/** provider 声明/实测的能力（docs/05 §4.4）。 */
export interface ProviderCapabilities {
  /** 是否支持分页列举 */
  list: boolean;
  /** 是否支持按身份键查询（身份对齐快路径） */
  findByIdentity: boolean;
  /** 是否支持按主键取单个主体 */
  get: boolean;
  /** 是否支持真增量游标（`since` 类过滤）。false 时对账走「首页探测」降级路径 */
  cursor: boolean;
  /** 是否支持写属性 */
  update: boolean;
  /** 是否支持创建主体 */
  create: boolean;
}

export interface ProviderIdentityKey {
  /** 键名，如 `oidc_id` / `email` / `provider_user_id` */
  key: string;
  /** 是否要求该键在下游唯一（唯一键才能用作对齐依据） */
  unique: boolean;
}

/**
 * provider 插件接口（docs/03 §1.16.2）。
 *
 * 实现方（如 `newapi-provider`）只在**自己内部**认识具体系统的 API 形状；
 * 核心只调这四个方法，因此核心代码里不会出现任何具体系统名（CI 第 7 项可机械检查）。
 */
export interface ProviderPlugin {
  /** provider 标识（`newapi` / `discord` / `minecraft` …）。核心只把它当字符串 */
  readonly id: string;

  /** 列出主体（供通用对账器分页拉取） */
  listSubjects(cursor: string | null, limit: number): Promise<SubjectPage>;

  /** 按下游系统主键取主体 */
  getSubject(externalId: string): Promise<ExternalSubject | null>;

  /** 按身份键查主体（如 oidc_id / email）—— 用于身份对齐的快路径 */
  findSubject?(by: { key: string; value: string }): Promise<ExternalSubject | null>;

  /** 主体属性 schema：供表达式路径补全、静态校验与**指纹字段选择** */
  readonly subjectSchema: SubjectSchema;

  /** 声明能力：决定对账走快路径还是降级路径 */
  readonly capabilities: ProviderCapabilities;

  /** 可用于身份对齐的键（下游声明，宿主持久化到 ag_provider_sync_state.capabilities） */
  readonly identityKeys?: readonly ProviderIdentityKey[];
}

// ─────────────────────────── 指纹 ───────────────────────────

/** 从 subjectSchema 取出参与指纹的字段（`watch: true`），按字段名排序保证稳定。 */
export function watchedFields(schema: SubjectSchema): string[] {
  return Object.entries(schema.properties)
    .filter(([, property]) => property.watch === true)
    .map(([name]) => name)
    .sort();
}

/** 稳定序列化：对象键排序，数组保序，`undefined` 归一为 null（避免 JSON 丢键）。 */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * 计算对账指纹。
 *
 * 形式：`hash(provider + externalId + 关注属性集合)`（docs/05 §4.1）。
 * 使用 FNV-1a 64 位（`node:crypto` 之外的无依赖选择；这里用 node:crypto 的 sha256 更稳妥，
 * 但为了在插件沙箱里也能跑，改成同步的 FNV-1a 足够抗碰撞用于**变更检测**，
 * 且不用于安全用途——安全场景的哈希另有其处）。
 */
export function subjectFingerprint(
  providerId: string,
  subject: ExternalSubject,
  watch: readonly string[],
): string {
  const watched: Record<string, unknown> = {};
  for (const field of watch) {
    watched[field] = subject.attributes[field] ?? null;
  }
  const payload = `${providerId}\u0000${subject.externalId}\u0000${stableStringify(watched)}`;
  return `fnv1a64:${fnv1a64(payload)}`;
}

/** FNV-1a 64 位（十六进制）。仅用于变更检测，不用于安全用途。 */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

// ─────────────────────────── 能力探测 ───────────────────────────

export interface CapabilityProbeResult {
  declared: ProviderCapabilities;
  actual: Partial<ProviderCapabilities>;
  /** 声明与实测不一致的键（**必须显式告警**，不得静默降级） */
  mismatches: string[];
}

/**
 * 能力探测（docs/05 §4.4）：宿主在启动时与每个全量周期执行。
 *
 * 为什么重要：`new-api` 升级后接口可能变化——若只信声明，对账会走错路径并**静默少数据**。
 * 探测方式必须是「真实调用一次」而不是「读 manifest」。
 */
export async function probeProvider(provider: PluginProbeTarget): Promise<CapabilityProbeResult> {
  const actual: Partial<ProviderCapabilities> = {};
  const mismatches: string[] = [];
  const declared = provider.capabilities;

  // list：真实拉一页（limit=1）看是否可用
  try {
    const page = await provider.listSubjects(null, 1);
    actual.list = Array.isArray(page.subjects);
  } catch {
    actual.list = false;
  }
  if (declared.list !== actual.list) mismatches.push('list');

  // findByIdentity：真实调用一次（用 identityKeys 的第一个键 + 空值不可行，故只做「方法存在性 + 不抛错」判断）
  if (declared.findByIdentity) {
    actual.findByIdentity = typeof provider.findSubject === 'function';
    if (!actual.findByIdentity) mismatches.push('findByIdentity');
  } else {
    actual.findByIdentity = false;
  }

  // cursor：只看是否真的返回了 nextCursor（首页通常有；没有则说明不支持真增量）
  try {
    const page = await provider.listSubjects(null, 1);
    actual.cursor = page.nextCursor !== null;
  } catch {
    actual.cursor = false;
  }
  if (declared.cursor && actual.cursor === false) mismatches.push('cursor');

  return { declared, actual, mismatches };
}

export interface PluginProbeTarget {
  listSubjects(cursor: string | null, limit: number): Promise<SubjectPage>;
  findSubject?: (by: { key: string; value: string }) => Promise<ExternalSubject | null>;
  capabilities: ProviderCapabilities;
}
