/**
 * 内置插件 `newapi-provider`（M1-3）—— 第一个真实 provider。
 *
 * ★ 这个文件**允许**出现具体系统名（`docs/03 §781` 原话：「核心代码 grep newapi / new-api → 0 命中
 *   （**只允许出现在插件包、文档、测试夹具中**）」）。它是**插件包**，承担与具体系统对话的全部责任；
 *   核心只通过 `ProviderPlugin` 接口认识它。CI 的系统名扫描因此排除 `src/plugin/builtin/**`，
 *   同时**仍然**检查 `src/` 其余部分——这条边界是机械可检查的，不是口头约定。
 *
 * 实现依据（`docs/09 §2`，均为对下游源码的实测结论）：
 * | 事项 | 结论 |
 * |---|---|
 * | 列主体 | `GET /api/user/?p=&page_size=&sort_by=id&sort_order=asc`（LIMIT/OFFSET 分页，**无 sinceId** → 走降级路径） |
 * | 按身份键检索 | **不支持**（`SearchUsers` 的 LIKE 只覆盖 id/username/email/display_name）→ `findByIdentity: false` |
 * | 属性 | `id/username/display_name/email/group/status/role/oidc_id/quota/used_quota/request_count` 全进属性袋 |
 * | 脱敏 | 必须剔除 `access_token` / `password`（raw 只用于排障） |
 * | 改属性 | `PUT /api/user/` 是 read-modify-write，**缺字段会被覆盖**，且**绝不能带 password** |
 */

import type {
  ExternalSubject,
  ProviderCapabilities,
  ProviderIdentityKey,
  ProviderPlugin,
  SubjectPage,
  SubjectSchema,
} from '../provider.ts';

// ─────────────────────────── 配置与传输 ───────────────────────────

export interface NewApiProviderConfig {
  /** 下游实例地址，如 `https://gate.example.com`（**每个站点一份**，docs/09 §2.1 的 config.scope: site） */
  baseUrl: string;
  /** 分页大小；下游上限 100（docs/09 §2.1 的 maximum: 100） */
  pageSize?: number;
  /** 每页之间的退避（毫秒）——避免对下游造成压力（docs/09 §2.5 默认 50ms） */
  pageDelayMs?: number;
  /** 单次请求超时 */
  timeoutMs?: number;
}

/** 出站请求（由宿主注入；插件**不直接**持有 PAT 之外的网络能力） */
export interface ProviderTransport {
  request(request: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<{ status: number; data: unknown; text: string }>;
}

export class NewApiProviderError extends Error {
  override readonly name = 'NewApiProviderError';
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** 下游用户的原始形状（只声明我们读的字段） */
interface RawNewApiUser {
  id?: number | string;
  username?: string;
  display_name?: string;
  email?: string;
  group?: string;
  status?: number;
  role?: number;
  quota?: number;
  used_quota?: number;
  request_count?: number;
  aff_code?: string;
  oidc_id?: string;
  remark?: string;
  access_token?: string;
  password?: string;
  [key: string]: unknown;
}

/** 参与指纹计算的字段（docs/09 §2.1 的 `provider.watch`） */
export const WATCH_FIELDS: readonly string[] = ['username', 'display_name', 'email', 'group', 'status', 'role', 'oidc_id'];

/**
 * 主体属性契约的**字段定义**（docs/09 §2.1 的 `subjectSchema`）。
 *
 * ⚠ **不要直接用它建指纹**：这里的 `watch` 尚未按 `WATCH_FIELDS` 打标，
 *   `watchedFields()` 会返回空数组 → 指纹退化成只含 (provider, externalId)，
 *   **任何属性变化都不会被检出**。消费方请用 `SUBJECT_SCHEMA`（已打标）。
 */
const SUBJECT_SCHEMA_FIELDS: SubjectSchema = {
  type: 'object',
  properties: {
    username: { type: 'string' },
    display_name: { type: 'string' },
    email: { type: 'string' },
    group: { type: 'string', description: '用户分组（决定可用模型与计费倍率）' },
    status: { type: 'integer', description: '1=启用 2=禁用' },
    role: { type: 'integer' },
    quota: { type: 'integer', description: '剩余额度' },
    used_quota: { type: 'integer', description: '已用额度' },
    request_count: { type: 'integer' },
    aff_code: { type: 'string' },
    oidc_id: { type: 'string', description: 'OIDC 主体标识（模式 1 对齐键）' },
  },
};

/**
 * ★ `watch` 标记的**唯一来源**是 `WATCH_FIELDS`（docs/09 §2.1 的 `provider.watch`）。
 *   若在 schema 里再抄一份，两处清单必然漂移——而漂移的后果是
 *   「下游改了分组却不触发重评估」或「无关字段变化把重评估打成风暴」。
 */
function schemaWithWatch(): SubjectSchema {
  const properties: SubjectSchema['properties'] = {};
  for (const [name, property] of Object.entries(SUBJECT_SCHEMA_FIELDS.properties)) {
    properties[name] = { ...property, watch: WATCH_FIELDS.includes(name) };
  }
  return { type: 'object', properties };
}

/**
 * 主体属性契约（**已按 `WATCH_FIELDS` 打标**）—— 这是唯一应当交给对账器/策略编辑器的版本。
 *
 * 之所以把它作为 `export`：`watchedFields()` 只认 schema 里的 `watch: true`，
 * 传未打标的版本会静默得到空指纹集合（变更检测失效）。契约上只暴露「正确的那一个」，
 * 比同时暴露两个再由调用方挑选更安全。
 */
export const SUBJECT_SCHEMA: SubjectSchema = schemaWithWatch();

/** 绑定键（docs/09 §2.1 的 `binding.keys`） */
export const IDENTITY_KEYS: readonly ProviderIdentityKey[] = [
  { key: 'oidc_id', unique: true },
  { key: 'email', unique: true },
];

/** manifest（与 `src/plugin/manifest.ts` 的契约一致） */
export const NEWAPI_PROVIDER_MANIFEST = {
  apiVersion: 'gate.plugin/v1',
  kind: 'provider',
  id: 'newapi-provider',
  name: 'new-api 主体目录',
  version: '1.0.0',
  description: '列出下游用户目录、读取属性、写回分组与额度（第一个官方 provider）',
  author: 'official',
  license: 'MIT',
  runtime: 'process',
  entry: './plugin.mjs',
  config: { scope: 'site', instances: { mode: 'singleton' } },
  permissions: ['secrets:read:newapi.pat', 'http:egress:api.example.com', 'storage:write:self'],
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', title: 'new-api 地址' },
      patRef: { type: 'string', default: 'newapi.pat', title: '管理员 PAT 的密钥名' },
      pageSize: { type: 'integer', default: 100, maximum: 100, title: '对账分页大小' },
    },
    required: ['baseUrl'],
  },
  subjectSchema: schemaWithWatch(),
  provider: {
    capabilities: { list: true, findByIdentity: false, get: true, cursor: false, update: true, create: true },
    watch: WATCH_FIELDS,
    identityKeys: IDENTITY_KEYS,
  },
} as const;

// ─────────────────────────── 脱敏 ───────────────────────────

/** 绝不允许进入 `raw` / 日志的字段（docs/09 §2.2）。 */
const SENSITIVE_FIELDS = new Set(['access_token', 'password', 'token', 'secret', 'refresh_token']);

/**
 * 脱敏后的原始对象（仅用于排障展示）。
 *
 * ★ 必须**显式剔除**而不是依赖日志层脱敏：`raw` 会被持久化到 `ag_external_subjects.raw`，
 *   一旦写进去就落库了——日志脱敏救不了入库的明文。
 */
export function redactUser(raw: RawNewApiUser): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = SENSITIVE_FIELDS.has(key) ? '[REDACTED]' : value;
  }
  return out;
}

/** 下游用户 → 通用主体（**核心只认识这个形状**）。 */
export function toExternalSubject(raw: RawNewApiUser): ExternalSubject {
  const externalId = raw.id === undefined || raw.id === null ? '' : String(raw.id);
  if (externalId.length === 0) {
    throw new NewApiProviderError('下游用户缺少 id，无法作为主体主键');
  }
  const attributes: Record<string, unknown> = {
    username: raw.username ?? null,
    display_name: raw.display_name ?? null,
    email: raw.email ?? null,
    group: raw.group ?? null,
    status: raw.status ?? null,
    role: raw.role ?? null,
    quota: raw.quota ?? null,
    used_quota: raw.used_quota ?? null,
    request_count: raw.request_count ?? null,
    aff_code: raw.aff_code ?? null,
    oidc_id: raw.oidc_id ?? null,
  };
  const subject: ExternalSubject = { externalId, attributes, raw: redactUser(raw) };
  if (typeof raw.username === 'string' && raw.username.length > 0) subject.displayName = raw.username;
  if (typeof raw.display_name === 'string' && raw.display_name.length > 0) subject.displayName = raw.display_name;
  if (typeof raw.email === 'string' && raw.email.length > 0) subject.email = raw.email;
  return subject;
}

// ─────────────────────────── provider 实现 ───────────────────────────

export interface NewApiProviderDeps {
  transport: ProviderTransport;
  /** 管理员 PAT（由宿主从密钥托管取出后注入；插件不自行读环境变量） */
  pat: string;
  config: NewApiProviderConfig;
  /** 退避实现（测试可注入空实现） */
  sleep?: (ms: number) => Promise<void>;
}

interface PaginatedResponse<T> {
  data?: T[];
  total?: number;
  success?: boolean;
  message?: string;
}

/**
 * 创建 provider 实例。
 *
 * ★ `findSubject` 的诚实处理（docs/09 §2.4）：下游**不支持**按 `oidc_id` 检索，
 *   因此这里**不**声称能按身份键查——而是在调用时返回 `null` 并附上原因，
 *   同时把 `capabilities.findByIdentity` 保持为 `false`，让对账器走「本地镜像建索引」的正道。
 *   与其伪造一个永远查不到的方法，不如让能力声明与真实行为一致。
 */
export function createNewApiProvider(deps: NewApiProviderDeps): ProviderPlugin & { probeCapabilities(): Promise<ProviderCapabilities> } {
  const { transport, pat, config } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pageSize = Math.min(config.pageSize ?? 100, 100);
  const base = config.baseUrl.replace(/\/+$/, '');
  const authHeaders = { Authorization: `Bearer ${pat}`, Accept: 'application/json' };

  async function getJson<T>(path: string): Promise<T> {
    const response = await transport.request({
      method: 'GET',
      url: `${base}${path}`,
      headers: authHeaders,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new NewApiProviderError(
        `下游返回 ${response.status}：GET ${path}${response.status === 401 ? '（PAT 无效或权限不足）' : ''}`,
        response.status,
      );
    }
    return response.data as T;
  }

  const capabilities: ProviderCapabilities = {
    list: true,
    // ★ 下游不支持按 oidc_id 检索（SearchUsers 的 LIKE 只覆盖 id/username/email/display_name）
    findByIdentity: false,
    get: true,
    // ★ LIMIT/OFFSET 分页，没有 sinceId 过滤 → 对账走「首页探测」降级路径
    cursor: false,
    update: true,
    create: true,
  };

  const plugin: ProviderPlugin & { probeCapabilities(): Promise<ProviderCapabilities> } = {
    id: 'newapi-provider',
    subjectSchema: schemaWithWatch(),
    capabilities,
    identityKeys: IDENTITY_KEYS,

    /**
     * 列主体：LIMIT/OFFSET 分页，**按 id 升序**（docs/09 §2.3）。
     *
     * 为什么必须 `sort_by=id&sort_order=asc`：降级增量路径依赖「首页按主键序」才能
     * 「遇到已知 id 即停」。排序不固定时该路径会失效并退化成全量扫描。
     */
    async listSubjects(cursor: string | null, limit: number): Promise<SubjectPage> {
      const requested = Math.min(limit, pageSize);
      // 游标语义：下游只有页码，因此游标就是页码（字符串）
      const page = cursor === null || cursor.length === 0 ? 1 : Number(cursor);
      if (!Number.isInteger(page) || page < 1) {
        throw new NewApiProviderError(`非法游标 '${String(cursor)}'（本 provider 的游标是页码）`);
      }
      const payload = await getJson<PaginatedResponse<RawNewApiUser>>(
        `/api/user/?p=${page}&page_size=${requested}&sort_by=id&sort_order=asc`,
      );
      if (payload.success === false) {
        throw new NewApiProviderError(`下游返回失败：${payload.message ?? '未知原因'}`);
      }
      const rows = Array.isArray(payload.data) ? payload.data : [];
      const total = typeof payload.total === 'number' ? payload.total : undefined;

      const nextCursor = rows.length < requested || (total !== undefined && page * requested >= total) ? null : String(page + 1);
      if (nextCursor !== null && config.pageDelayMs !== 0) {
        // 分页间退避：避免对下游造成压力（同一 provider 串行，docs/09 §2.5）
        await sleep(config.pageDelayMs ?? 50);
      }
      return { subjects: rows.map(toExternalSubject), nextCursor };
    },

    /** 按下游主键取主体：`GET /api/user/:id`（docs/09 §2.3 的 getSubject） */
    async getSubject(externalId: string): Promise<ExternalSubject | null> {
      try {
        const payload = await getJson<{ data?: RawNewApiUser } & RawNewApiUser>(`/api/user/${encodeURIComponent(externalId)}`);
        const row = (payload.data ?? payload) as RawNewApiUser;
        if (row.id === undefined || row.id === null) return null;
        return toExternalSubject(row);
      } catch (error) {
        if (error instanceof NewApiProviderError && error.status === 404) return null;
        throw error;
      }
    },

    /**
     * 按身份键查主体：**明确返回 null 并说明原因**。
     *
     * 这是一个「诚实的空实现」：下游确实不支持，与其伪造，不如让调用方立刻知道
     * 应当走本地镜像索引（`docs/09 §2.4`）。
     */
    async findSubject({ key }: { key: string; value: string }): Promise<ExternalSubject | null> {
      void key;
      return null;
    },

    /**
     * 能力探测（宿主启动时与每个全量周期执行，docs/05 §4.4）。
     *
     * 为什么必须**真实调用**而不是返回常量：下游升级后接口可能变化
     * （例如分页参数改名、鉴权方式变化），声明与实测不一致必须被发现。
     * 探测本身不抛错——返回实测结果，由宿主比对并告警。
     */
    async probeCapabilities(): Promise<ProviderCapabilities> {
      const actual: ProviderCapabilities = { ...capabilities, list: false, cursor: false };
      try {
        const payload = await getJson<PaginatedResponse<RawNewApiUser>>('/api/user/?p=1&page_size=1&sort_by=id&sort_order=asc');
        actual.list = Array.isArray(payload.data);
        // 实测是否有「下一页」线索 → 判断分页能力是否真的可用
        const rows = Array.isArray(payload.data) ? payload.data : [];
        const total = typeof payload.total === 'number' ? payload.total : undefined;
        actual.cursor = total !== undefined || rows.length > 0;
      } catch {
        actual.list = false;
      }
      return actual;
    },
  };

  return plugin;
}

// ─────────────────────────── 写回（M2 用，此处先提供最小实现） ───────────────────────────

/**
 * 写回分组：**read-modify-write**（docs/09 §2.4）。
 *
 * ★ 三条不可妥协的约束：
 *   1. 必须先 `GET` 再 `PUT`——下游的 `PUT /api/user/` 是整体替换，**缺字段会被覆盖**；
 *   2. **绝不能带 `password`**——带上会把用户密码清空/改掉（docs/09 §2.4 的实测结论）；
 *   3. 回填 `username` / `display_name` / `remark`，否则它们会被清空。
 *
 * ⚠ 本函数**尚未接入动作执行器**（M2-2）；它在这里是为了让「不能带 password」这条
 *   硬约束与它的回归测试在同一个提交里落地——这类约束一旦漏掉就是不可逆的数据损坏。
 */
export async function writeBackAttributes(
  deps: NewApiProviderDeps,
  externalId: string,
  changes: { group?: string; remark?: string },
): Promise<void> {
  const { transport, pat, config } = deps;
  const base = config.baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${pat}`, Accept: 'application/json', 'Content-Type': 'application/json' };

  const current = await transport.request({ method: 'GET', url: `${base}/api/user/${encodeURIComponent(externalId)}`, headers });
  if (current.status < 200 || current.status >= 300) {
    throw new NewApiProviderError(`写回前读取失败（${current.status}）`, current.status);
  }
  const payload = current.data as { data?: RawNewApiUser } & RawNewApiUser;
  const raw = (payload.data ?? payload) as RawNewApiUser;

  // ★ 显式构造白名单字段，**不用对象展开**——展开会把 access_token/password 一并带回去
  const body: Record<string, unknown> = {
    id: raw.id,
    username: raw.username ?? '',
    display_name: raw.display_name ?? '',
    remark: changes.remark ?? raw.remark ?? '',
    group: changes.group ?? raw.group ?? '',
  };

  const response = await transport.request({
    method: 'PUT',
    url: `${base}/api/user/`,
    headers,
    body,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new NewApiProviderError(`写回失败（${response.status}）`, response.status);
  }
}
