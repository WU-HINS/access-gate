/**
 * 指标（M6-1）—— Prometheus 文本格式，**零依赖**。
 *
 * 为什么自己实现而不引入 prom-client：
 *   M0 只需要 counter/gauge/histogram 三种类型与 `/metrics` 输出；这三者在 Prometheus
 *   文本协议里是**极简**的（几十行）。引入客户端库会把「指标可用」变成依赖可用性问题，
 *   而运维最需要的是「容器一起来就有 /metrics」。
 *
 * ★ 两条设计约束：
 *   1. **标签基数必须可控**：任何以 `userId` / `externalId` 为标签的指标都会在多租户下爆炸。
 *      因此本模块的 API 不阻止传标签，但注释明确禁止把主体 id 放进标签（用聚合维度代替）。
 *   2. **指标不得包含敏感信息**：标签值会被抓走并长期存储——密钥/邮箱不应进去。
 */

export type Labels = Readonly<Record<string, string | number | boolean>>;

const TYPE_PREFIX = '# TYPE';
const HELP_PREFIX = '# HELP';

/**
 * ★★ 标签**白名单**（`docs/05 §7.1.1`）。
 *
 * 为什么必须**强制**而不是靠上面的注释：
 * 一个有 bug（或恶意）的插件把 `userId` 放进 label，就能让时序数据库**基数爆炸**，
 * 拖垮全平台监控，并**连带摧毁诊断能力本身**（出事时最需要的东西）。
 * 注释挡不住这件事——**只有会抛错的检查能挡住**。
 *
 * ★ 允许的维度都是**有界**的：作用域（站点/插件/实例）或枚举（结论/状态/动作）。
 *   新增维度必须显式加进这里——刻意不提供「任意标签」的逃生口。
 */
const ALLOWED_LABELS: ReadonlySet<string> = new Set([
  // 作用域维度
  'siteId',
  'pluginId',
  'instanceKey',
  // 语义维度（有界枚举）
  'kind',
  'outcome',
  'status',
  'action',
  'errorKind',
  'decision',
  'reason',
  'result',
  'from',
  'to',
  'method',
  'provider',
  'policy',
  'model',
  'op',
  'trigger',
]);

/** 明确**禁止**的无界标签（单独列出，好给出比"不在白名单"更有用的报错）。 */
const FORBIDDEN_LABELS: ReadonlySet<string> = new Set([
  'userId',
  'subjectId',
  'externalId',
  'email',
  'traceId',
  'sessionId',
  'kid',
  'ip',
]);

function assertLabelsAllowed(labels: Labels): void {
  for (const key of Object.keys(labels)) {
    if (FORBIDDEN_LABELS.has(key)) {
      throw new Error(
        `指标标签 '${key}' 被禁止：它取**无界值**（每个主体一个）→ 时序基数爆炸（docs/05 §7.1.1）。` +
          '请改用聚合维度（siteId / pluginId / outcome / status …）。',
      );
    }
    if (!ALLOWED_LABELS.has(key)) {
      throw new Error(
        `指标标签 '${key}' 不在白名单内（docs/05 §7.1.1）。` +
          `允许：${[...ALLOWED_LABELS].sort().join(' / ')}。新增维度请显式加进白名单。`,
      );
    }
  }
}

/** 标签序列化：键排序保证同一组标签产生同一行（否则 Prometheus 会当成不同时间序列）。 */
function renderLabels(labels: Labels | undefined, extra?: Labels): string {
  const merged = { ...(labels ?? {}), ...(extra ?? {}) };
  assertLabelsAllowed(merged);
  const keys = Object.keys(merged).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((key) => `${key}="${escapeLabelValue(String(merged[key]))}"`);
  return `{${parts.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 安全的指标名（Prometheus 规范：`[a-zA-Z_:][a-zA-Z0-9_:]*`）。 */
function assertMetricName(name: string): void {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
    throw new Error(`非法指标名 '${name}'：必须匹配 [a-zA-Z_:][a-zA-Z0-9_:]*`);
  }
}

// ─────────────────────────── Counter ───────────────────────────

export class Counter {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, number>();

  constructor(name: string, help: string) {
    assertMetricName(name);
    this.name = name;
    this.help = help;
  }

  inc(labels?: Labels, amount = 1): void {
    if (amount < 0) throw new Error(`counter 不能减少（${this.name}）`);
    const key = renderLabels(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  value(labels?: Labels): number {
    return this.values.get(renderLabels(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`${HELP_PREFIX} ${this.name} ${this.help}`, `${TYPE_PREFIX} ${this.name} counter`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labelText, value] of [...this.values.entries()].sort()) {
        lines.push(`${this.name}${labelText} ${value}`);
      }
    }
    return lines;
  }
}

// ─────────────────────────── Gauge ───────────────────────────

export class Gauge {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, number>();
  private readonly renderers = new Map<string, () => number>();

  constructor(name: string, help: string) {
    assertMetricName(name);
    this.name = name;
    this.help = help;
  }

  set(value: number, labels?: Labels): void {
    this.values.set(renderLabels(labels), value);
  }

  inc(labels?: Labels, amount = 1): void {
    const key = renderLabels(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  dec(labels?: Labels, amount = 1): void {
    this.inc(labels, -amount);
  }

  /**
   * 注册一个**回调**指标（抓取时求值）。
   *
   * 为什么需要：像「队列深度」「库连接数」这类值只在抓取时才有意义，
   * 主动 set 需要额外的定时任务，反而更容易忘记更新而变成陈旧值。
   */
  callback(labels: Labels, fn: () => number): void {
    this.renderers.set(renderLabels(labels), fn);
  }

  value(labels?: Labels): number {
    return this.values.get(renderLabels(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`${HELP_PREFIX} ${this.name} ${this.help}`, `${TYPE_PREFIX} ${this.name} gauge`];
    const merged = new Map<string, string>([...this.values.entries()].map(([k, v]) => [k, String(v)] as const));
    for (const [key, fn] of this.renderers) {
      try {
        merged.set(key, String(fn()));
      } catch {
        // 指标回调失败不得影响抓取（否则一个坏指标会让整个 /metrics 挂掉）
        merged.set(key, 'NaN');
      }
    }
    if (merged.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labelText, value] of [...merged.entries()].sort()) {
        lines.push(`${this.name}${labelText} ${value}`);
      }
    }
    return lines;
  }
}

// ─────────────────────────── Histogram ───────────────────────────

export const DEFAULT_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: readonly number[];
  private readonly counts = new Map<string, { buckets: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, buckets: readonly number[] = DEFAULT_BUCKETS) {
    assertMetricName(name);
    this.name = name;
    this.help = help;
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(seconds: number, labels?: Labels): void {
    const key = renderLabels(labels);
    let entry = this.counts.get(key);
    if (entry === undefined) {
      entry = { buckets: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.counts.set(key, entry);
    }
    entry.sum += seconds;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (seconds <= this.buckets[i]!) entry.buckets[i] = (entry.buckets[i] ?? 0) + 1;
    }
  }

  count(labels?: Labels): number {
    return this.counts.get(renderLabels(labels))?.count ?? 0;
  }

  render(): string[] {
    const lines = [`${HELP_PREFIX} ${this.name} ${this.help}`, `${TYPE_PREFIX} ${this.name} histogram`];
    if (this.counts.size === 0) {
      for (const bound of this.buckets) lines.push(`${this.name}_bucket{le="${bound}"} 0`);
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
      return lines;
    }
    for (const [labelText, entry] of [...this.counts.entries()].sort()) {
      const inner = labelText === '' ? '' : labelText.slice(1, -1);
      for (let i = 0; i < this.buckets.length; i += 1) {
        const labels = `{${inner === '' ? '' : `${inner},`}le="${this.buckets[i]}"}`;
        lines.push(`${this.name}_bucket${labels} ${entry.buckets[i] ?? 0}`);
      }
      lines.push(`${this.name}_bucket{${inner === '' ? '' : `${inner},`}le="+Inf"} ${entry.count}`);
      lines.push(`${this.name}_sum${labelText} ${entry.sum}`);
      lines.push(`${this.name}_count${labelText} ${entry.count}`);
    }
    return lines;
  }
}

// ─────────────────────────── Registry ───────────────────────────

export class MetricsRegistry {
  private readonly collectors: { render(): string[] }[] = [];
  private readonly byName = new Map<string, Counter | Gauge | Histogram>();

  counter(name: string, help: string): Counter {
    const existing = this.byName.get(name);
    if (existing !== undefined) {
      if (!(existing instanceof Counter)) throw new Error(`指标 ${name} 已存在且类型不同`);
      return existing;
    }
    const collector = new Counter(name, help);
    this.collectors.push(collector);
    this.byName.set(name, collector);
    return collector;
  }

  gauge(name: string, help: string): Gauge {
    const existing = this.byName.get(name);
    if (existing !== undefined) {
      if (!(existing instanceof Gauge)) throw new Error(`指标 ${name} 已存在且类型不同`);
      return existing;
    }
    const collector = new Gauge(name, help);
    this.collectors.push(collector);
    this.byName.set(name, collector);
    return collector;
  }

  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    const existing = this.byName.get(name);
    if (existing !== undefined) {
      if (!(existing instanceof Histogram)) throw new Error(`指标 ${name} 已存在且类型不同`);
      return existing;
    }
    const collector = new Histogram(name, help, buckets);
    this.collectors.push(collector);
    this.byName.set(name, collector);
    return collector;
  }

  /** 渲染为 Prometheus 文本格式（`text/plain; version=0.0.4`）。 */
  render(): string {
    const lines: string[] = [];
    for (const collector of this.collectors) lines.push(...collector.render());
    return `${lines.join('\n')}\n`;
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }
}

// ─────────────────────────── 应用指标集 ───────────────────────────

/**
 * access-gate 的标准指标集（命名前缀 `gate_`，见 `docs/05 §766`）。
 *
 * ★ 标签禁忌：**不要把 `userId` / `externalId` / `email` 放进标签**——
 *   多租户下基数会爆炸（10 万用户 × 每次巡检 = 时间序列灾难），而且它们是敏感信息。
 *   需要按主体排查时用日志/审计，不要用指标。
 */
export interface AppMetrics {
  registry: MetricsRegistry;
  factAgeSeconds: Gauge;
  patrolDuration: Histogram;
  patrolRuns: Counter;
  patrolSubjects: Counter;
  patrolStateTransitions: Counter;
  patrolIndeterminate: Counter;
  actionsTotal: Counter;
  actionDuration: Histogram;
  actionSkipped: Counter;
  actionVerifyFailed: Counter;
  httpRequests: Counter;
  httpDuration: Histogram;
  httpInFlight: Gauge;
  pluginFactWrites: Counter;
  pluginFactQuotaExceeded: Counter;
  permissionDenied: Counter;
}

export function createAppMetrics(registry = new MetricsRegistry()): AppMetrics {
  return {
    registry,
    factAgeSeconds: registry.gauge('gate_plugin_fact_age_seconds', '事实新鲜度（按插件维度）'),
    patrolDuration: registry.histogram('gate_patrol_duration_seconds', '单轮巡检耗时'),
    patrolRuns: registry.counter('gate_patrol_runs_total', '巡检轮次（按结果）'),
    patrolSubjects: registry.counter('gate_patrol_subjects_total', '巡检处理的主体×策略数（按结论）'),
    patrolStateTransitions: registry.counter('gate_patrol_state_transitions_total', '生命周期状态迁移次数（按迁移方向）'),
    patrolIndeterminate: registry.counter('gate_patrol_indeterminate_total', '不可判定次数（渠道故障等）'),
    actionsTotal: registry.counter('gate_actions_total', '动作执行次数（按动作与结果）'),
    actionDuration: registry.histogram('gate_action_duration_seconds', '单个动作耗时'),
    actionSkipped: registry.counter('gate_action_skipped_total', '动作跳过次数（按原因）'),
    actionVerifyFailed: registry.counter('gate_action_verify_failed_total', '动作回读未达成目标状态的次数'),
    httpRequests: registry.counter('gate_http_requests_total', 'HTTP 请求数（按方法/路由/状态码）'),
    httpDuration: registry.histogram('gate_http_request_duration_seconds', 'HTTP 请求耗时'),
    httpInFlight: registry.gauge('gate_http_in_flight', '正在处理的请求数'),
    pluginFactWrites: registry.counter('gate_plugin_fact_writes_total', '插件事实写入数'),
    pluginFactQuotaExceeded: registry.counter('gate_plugin_fact_quota_exceeded_total', '插件事实配额超限次数'),
    permissionDenied: registry.counter('gate_permission_denied_total', '权限拒绝次数（按插件）'),
  };
}
