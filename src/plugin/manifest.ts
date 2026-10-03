/**
 * 插件 manifest 契约与校验（M1-4）—— docs/03 §1.4。
 *
 * ★ 为什么校验必须严格且**拒绝未知枚举值**：
 *   manifest 是**外部输入**（第三方插件上传）。若宿主对未知 `runtime` 静默降级为
 *   `in-process`，就等于把任意代码放进主进程——这是最严重的一类缺陷。
 *   因此本模块的默认行为是**拒绝**：不认识就报错，不猜、不降级。
 *
 * 依赖取舍：docs/03 原文用 YAML + JSON Schema。本项目**不引入 YAML 解析器与 Zod**：
 *   - manifest 在宿主内部以**已解析的对象**形式流转（YAML→对象由安装入口负责）；
 *   - schema 校验用手写校验器（字段少、规则明确），并把 JSON Schema **原样保留**给前端表单使用。
 *   这样插件契约不绑定任何第三方库，也便于把同一份校验逻辑复用到插件沙箱里。
 */

export type PluginKind = 'channel' | 'enricher' | 'action' | 'identity' | 'provider' | 'feature';
export type PluginRuntime = 'declarative' | 'process' | 'container' | 'in-process';
export type BindingCapability = 'none' | 'oauth2' | 'manual' | 'webhook' | 'scheduled';
export type ConfigScope = 'developer' | 'site';

/** JSON Schema 子集（保留原样传给前端渲染表单；宿主只用到其中少量字段做校验）。 */
export interface JsonSchemaSubset {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: readonly unknown[];
  format?: string;
  items?: JsonSchemaSubset;
  properties?: Record<string, JsonSchemaSubset>;
  required?: readonly string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

export interface PluginCapabilities {
  binding: BindingCapability;
  refresh: boolean;
  revoke: boolean;
  quickCheck: boolean;
}

export interface CollectRequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** 超时（毫秒）；缺省由宿主统一上限兜底 */
  timeoutMs?: number;
}

export interface ExtractRule {
  /** JSONPath 子集：`$.a.b`、`$.a[*].b`、`$.a[0].b` */
  path: string;
  /** 事实字段名（最终会加上 `<pluginId>.` 命名空间前缀） */
  as: string;
  /** 聚合/转换：sum | count | min | max | avg | first | last | length | string */
  transform?: 'sum' | 'count' | 'min' | 'max' | 'avg' | 'first' | 'last' | 'length' | 'string';
}

export interface DeriveRule {
  as: string;
  /** 受限表达式：仅允许白名单函数与四则运算（见 expr-lite.ts） */
  expr: string;
}

export interface CollectSpec {
  request: CollectRequestSpec;
  extract: readonly ExtractRule[];
  derive?: readonly DeriveRule[];
}

export interface PluginManifest {
  apiVersion: string;
  kind: PluginKind;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;

  runtime: PluginRuntime;
  /** runtime !== declarative 时必需 */
  entry?: string;
  digest?: string;
  signature?: string;

  engines?: { gate?: string };

  capabilities?: Partial<PluginCapabilities>;

  permissions?: readonly string[];

  configSchema?: JsonSchemaSubset;
  factSchema?: JsonSchemaSubset;

  /** runtime: declarative 时的采集声明 */
  collect?: CollectSpec;

  /** 配置作用域（provider 仅允许 site，见 docs/03 §1.19.3） */
  config?: { scope?: ConfigScope };
  /** 实例模式：singleton 只是 instanceKey='default' 的特例 */
  instances?: { mode?: 'singleton' | 'multi' };

  /** 事实有效期（如 '24h'） */
  factTtl?: string;

  /**
   * ★ 本地求值插件（`local: true`）：**不发起任何网络请求**，由宿主调用其纯函数求值。
   *
   * 为什么需要它：`email-domain` / `invite-code` 这类 channel 的判定完全在本地完成
   * （docs/09 §562 明确「零外部依赖，用来验证插件契约」）。
   * 若不支持 local，就只能给它们编一个假的 `collect.request.url`——那是伪造，
   * 会让「插件不做网络请求」这一事实在契约层消失，审计与出站白名单都会失真。
   */
  local?: boolean;
}

// ─────────────────────────── 校验 ───────────────────────────

export interface ManifestIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError';
  readonly issues: readonly ManifestIssue[];
  constructor(issues: readonly ManifestIssue[]) {
    super(
      `插件 manifest 校验失败（${issues.filter((i) => i.severity === 'error').length} 个错误）：\n` +
        issues
          .filter((i) => i.severity === 'error')
          .map((i) => `  - ${i.path}: ${i.message}`)
          .join('\n'),
    );
    this.issues = issues;
  }
}

const SUPPORTED_API_VERSIONS = new Set(['gate.plugin/v1']);
const KINDS = new Set<PluginKind>(['channel', 'enricher', 'action', 'identity', 'provider', 'feature']);
const RUNTIMES = new Set<PluginRuntime>(['declarative', 'process', 'container', 'in-process']);
const BINDINGS = new Set<BindingCapability>(['none', 'oauth2', 'manual', 'webhook', 'scheduled']);
const TRANSFORMS = new Set(['sum', 'count', 'min', 'max', 'avg', 'first', 'last', 'length', 'string']);

/** 插件 id：小写字母数字与连字符，且必须以字母开头（同时用作事实命名空间） */
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** 权限格式：`<area>:<action>:<target>`（target 可含冒号，如 secrets:read:github.token） */
const PERMISSION = /^[a-z]+:[a-z]+:.+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验 manifest（返回全部问题；`validateManifest` 会在有 error 时抛出）。 */
export function checkManifest(input: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const error = (path: string, message: string): void => void issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string): void => void issues.push({ path, message, severity: 'warning' });

  if (!isPlainObject(input)) {
    error('$', 'manifest 必须是一个对象');
    return issues;
  }
  const m = input;

  // apiVersion
  if (typeof m['apiVersion'] !== 'string') error('apiVersion', '必需字段，字符串');
  else if (!SUPPORTED_API_VERSIONS.has(m['apiVersion'])) {
    error('apiVersion', `不支持的契约版本 ${m['apiVersion']}（宿主支持：${[...SUPPORTED_API_VERSIONS].join(', ')}）`);
  }

  // kind
  if (typeof m['kind'] !== 'string') error('kind', '必需字段，字符串');
  else if (!KINDS.has(m['kind'] as PluginKind)) {
    // ★ 拒绝未知值而不是忽略：静默忽略会让插件以「未声明能力」的形态被安装
    error('kind', `未知 kind '${m['kind']}'（允许：${[...KINDS].join(' | ')}）`);
  }

  // id
  if (typeof m['id'] !== 'string') error('id', '必需字段，字符串（同时作为事实命名空间）');
  else if (!PLUGIN_ID.test(m['id'])) {
    error('id', `非法插件 id '${m['id']}'：必须匹配 ${PLUGIN_ID.source}（小写字母开头，只含小写字母/数字/连字符）`);
  }

  for (const field of ['name', 'version'] as const) {
    if (typeof m[field] !== 'string' || m[field].length === 0) error(field, '必需字段，非空字符串');
  }
  if (typeof m['version'] === 'string' && !SEMVER.test(m['version'])) {
    warn('version', `'${m['version']}' 不是标准 semver，可能影响升级判定`);
  }

  // runtime
  if (typeof m['runtime'] !== 'string') error('runtime', '必需字段，字符串');
  else if (!RUNTIMES.has(m['runtime'] as PluginRuntime)) {
    error('runtime', `未知 runtime '${m['runtime']}'（允许：${[...RUNTIMES].join(' | ')}）。不猜、不降级。`);
  }
  const runtime = m['runtime'] as PluginRuntime | undefined;

  // entry
  if (runtime !== undefined && runtime !== 'declarative') {
    if (typeof m['entry'] !== 'string' || m['entry'].length === 0) {
      error('entry', `runtime='${runtime}' 时必需（可执行入口）`);
    }
  } else if (m['entry'] !== undefined) {
    warn('entry', 'runtime=declarative 时 entry 不会被使用');
  }

  // capabilities.binding
  const capabilities = m['capabilities'];
  if (capabilities !== undefined) {
    if (!isPlainObject(capabilities)) error('capabilities', '必须是对象');
    else {
      const binding = capabilities['binding'];
      if (binding !== undefined && !BINDINGS.has(binding as BindingCapability)) {
        error('capabilities.binding', `未知取值 '${String(binding)}'（允许：${[...BINDINGS].join(' | ')}）`);
      }
    }
  }

  // permissions
  const permissions = m['permissions'];
  if (permissions !== undefined) {
    if (!Array.isArray(permissions)) error('permissions', '必须是数组');
    else {
      permissions.forEach((permission, index) => {
        if (typeof permission !== 'string') {
          error(`permissions[${index}]`, '必须是字符串');
          return;
        }
        if (!PERMISSION.test(permission)) {
          error(`permissions[${index}]`, `非法权限格式 '${permission}'：应为 <area>:<action>:<target>`);
        }
      });
    }
  }

  // engines.gate
  const engines = m['engines'];
  if (engines !== undefined && !isPlainObject(engines)) error('engines', '必须是对象');

  // 类型与运行形态的交叉约束
  if (m['kind'] === 'identity' && runtime === 'declarative') {
    error('runtime', "kind='identity' 不允许 declarative（它需要真正的协议交互，docs/03 §1.3）");
  }
  if (m['kind'] === 'provider' && runtime === 'declarative') {
    error('runtime', "kind='provider' 不允许 declarative（主体目录需要真实 API 交互与分页）");
  }
  if (m['kind'] === 'provider' && m['config'] !== undefined && isPlainObject(m['config'])) {
    const scope = (m['config'] as Record<string, unknown>)['scope'];
    if (scope !== undefined && scope !== 'site') {
      error('config.scope', "kind='provider' 的配置作用域只能是 'site'（主体是站点级的，docs/03 §1.19.3）");
    }
  }

  // local 插件：不要求 collect，但也不允许声明 collect（避免两种来源并存导致语义歧义）
  const isLocal = m['local'] === true;
  if (m['local'] !== undefined && typeof m['local'] !== 'boolean') error('local', '必须是布尔值');
  if (isLocal && m['collect'] !== undefined) {
    error('collect', "local:true 的插件不得声明 collect（本地求值不做网络请求；两者并存会让事实来源歧义）");
  }
  // declarative 必须有 collect（local 除外）
  if (runtime === 'declarative' && !isLocal && m['collect'] === undefined) {
    error('collect', "runtime='declarative' 且非 local 时必须声明 collect（否则插件什么也不做）");
  }
  if (m['collect'] !== undefined) issues.push(...checkCollect(m['collect']));

  // factSchema 必需（策略编辑器靠它做补全与静态校验）
  if (m['factSchema'] === undefined) {
    if (m['kind'] !== 'action' && m['kind'] !== 'feature') {
      warn('factSchema', '建议声明 factSchema：策略编辑器据此做路径补全与静态校验');
    }
  } else {
    issues.push(...checkFactSchema(m['factSchema']));
  }

  return issues;
}

function checkCollect(collect: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const error = (path: string, message: string): void => void issues.push({ path, message, severity: 'error' });
  if (!isPlainObject(collect)) {
    error('collect', '必须是对象');
    return issues;
  }
  const request = collect['request'];
  if (!isPlainObject(request)) {
    error('collect.request', '必需，且必须是对象');
  } else {
    const method = request['method'];
    if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
      error('collect.request.method', `非法 HTTP 方法 '${String(method)}'`);
    }
    const url = request['url'];
    if (typeof url !== 'string' || url.length === 0) error('collect.request.url', '必需，非空字符串');
    else if (!/^https?:\/\//.test(url)) error('collect.request.url', '必须是 http(s) 绝对 URL');
  }

  const extract = collect['extract'];
  if (!Array.isArray(extract) || extract.length === 0) {
    error('collect.extract', '必需，且至少一条规则（否则采集不到任何事实）');
  } else {
    extract.forEach((rule, index) => {
      if (!isPlainObject(rule)) {
        error(`collect.extract[${index}]`, '必须是对象');
        return;
      }
      if (typeof rule['path'] !== 'string' || rule['path'].length === 0) {
        error(`collect.extract[${index}].path`, '必需，非空字符串');
      }
      if (typeof rule['as'] !== 'string' || rule['as'].length === 0) {
        error(`collect.extract[${index}].as`, '必需，非空字符串');
      }
      const transform = rule['transform'];
      if (transform !== undefined && !TRANSFORMS.has(String(transform))) {
        error(`collect.extract[${index}].transform`, `未知 transform '${String(transform)}'（允许：${[...TRANSFORMS].join(' | ')}）`);
      }
    });
  }

  const derive = collect['derive'];
  if (derive !== undefined) {
    if (!Array.isArray(derive)) error('collect.derive', '必须是数组');
    else {
      derive.forEach((rule, index) => {
        if (!isPlainObject(rule)) {
          error(`collect.derive[${index}]`, '必须是对象');
          return;
        }
        if (typeof rule['as'] !== 'string' || rule['as'].length === 0) error(`collect.derive[${index}].as`, '必需');
        if (typeof rule['expr'] !== 'string' || rule['expr'].length === 0) error(`collect.derive[${index}].expr`, '必需');
      });
    }
  }
  return issues;
}

function checkFactSchema(schema: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const error = (path: string, message: string): void => void issues.push({ path, message, severity: 'error' });
  if (!isPlainObject(schema)) {
    error('factSchema', '必须是对象');
    return issues;
  }
  if (schema['type'] !== 'object') error('factSchema.type', "必须是 'object'（事实是一组键值）");
  const properties = schema['properties'];
  if (!isPlainObject(properties)) {
    error('factSchema.properties', '必需，且必须是对象');
    return issues;
  }
  for (const [key, value] of Object.entries(properties)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      error(`factSchema.properties.${key}`, '字段名必须是小写 snake_case（表达式路径要用它）');
    }
    if (!isPlainObject(value)) error(`factSchema.properties.${key}`, '必须是对象');
    else if (typeof value['type'] !== 'string') error(`factSchema.properties.${key}.type`, '必需');
  }
  return issues;
}

/** 校验并在有 error 时抛出（warning 不阻塞）。 */
export function validateManifest(input: unknown): PluginManifest {
  const issues = checkManifest(input);
  if (issues.some((i) => i.severity === 'error')) throw new ManifestValidationError(issues);
  return input as unknown as PluginManifest;
}

/** 配置默认值合并（宿主在读取插件配置时应用）。 */
export function applyConfigDefaults(schema: JsonSchemaSubset | undefined, provided: Record<string, unknown>): Record<string, unknown> {
  if (schema?.properties === undefined) return { ...provided };
  const out: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = provided[key];
    if (value === undefined) {
      if (property.default !== undefined) out[key] = property.default;
    } else {
      out[key] = value;
    }
  }
  // 保留 schema 未声明但用户提供的键？→ 不保留：未知键是配置漂移，应被显式拒绝
  return out;
}
