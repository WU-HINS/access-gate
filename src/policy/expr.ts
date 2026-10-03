/**
 * 表达式引擎最小版（M1-8）—— `gate/expr/v1`（docs/04 §1.2）。
 *
 * 判定语言只有一套求值逻辑：`all / any / not / none` + 比较叶子。
 * `atLeast / atMost / exactly / score` 是**语法糖**，会被展开成纯布尔结构（docs/04 §1.2.1）。
 *
 * ★ 三态求值（M1 最小版的核心）：
 *   求值结果是 `true | false | indeterminate`，不是布尔。
 *   `indeterminate` 表示「关键事实缺失或渠道故障，**无法判定**」——
 *   它必须与 `false` 分开，否则一次下游抖动会被当成「不满足」，
 *   从而**错误收回已授予的资格**（docs/05 §144 的 H1 原则）。
 *
 * ★ 短路语义与三态的交互（这是最容易写错的地方）：
 *   - `all`：任一 false → false（短路）；全 true → true；否则（有 indeterminate）→ indeterminate
 *   - `any`：任一 true → true（短路）；全 false → false；否则 → indeterminate
 *   - `not`：true↔false，indeterminate 保持 indeterminate（**不可**把 indeterminate 取反成 true）
 */

import { parseDuration } from '../kernel/duration.ts';

// ─────────────────────────── 状态与结果树 ───────────────────────────

export type Truth = 'true' | 'false' | 'indeterminate';

export interface OperandRef {
  kind: 'fact' | 'user' | 'binding' | 'subject' | 'identity' | 'literal';
  /** 原始路径（如 `fact.qq.level`）；字面量为 `literal` */
  path: string;
  /** fact 的命名空间（渠道自动推断用） */
  namespace?: string;
}

export interface ExplainNode {
  /** 节点类型：all / any / not / none / atLeast / atMost / exactly / score / cmp */
  kind: string;
  /** `$label` 元数据（UI 展示文案） */
  label?: string;
  state: Truth;
  /** 比较叶子的操作符（如 `gt`） */
  op?: string;
  operand?: OperandRef;
  /** 实际值（脱敏后的展示值） */
  actual?: unknown;
  /** 期望值（比较右值） */
  expected?: unknown;
  /** 一句话原因（用户侧展示「差在哪」） */
  reason: string;
  /** 缺失的事实路径（indeterminate 时用于「差哪一项」提示与 $onMissing 归因） */
  missing?: readonly string[];
  /**
   * ★ `docs/10 P5` ②：该叶子所依据事实的**采集时间**（ISO 串）。
   *
   * 为什么必须出现在结果树里：策略可能同时引用「1 小时前采的 star 数」与
   * 「3 天前采的账号年龄」，判定基于**半新半旧**的组合——而在此之前，
   * 每个事实**都有** `collectedAt`（存在库里），**但判定时不看它、结果树里也看不到它**，
   * 于是「半新半旧」既无法被识别、也无法配置容忍度（③`$maxSkew` 的前提就是它）。
   */
  collectedAt?: string;
  /**
   * ★ `docs/10 P5` ③：该节点声明了 `$maxSkew` 且**实际时跨超限**时的记录。
   *   出现它即意味着该节点被判为 `indeterminate`（不用"半新半旧"的数据下结论）。
   */
  maxSkew?: { declared: string; skewMs: number };
  children?: readonly ExplainNode[];
}

// ─────────────────────────── 表达式类型 ───────────────────────────

export type ComparisonOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'subset_of'
  | 'superset_of'
  | 'intersects'
  | 'matches'
  | 'regex'
  | 'prefix'
  | 'suffix'
  | 'exists'
  | 'not_exists'
  | 'is_null'
  | 'is_empty'
  | 'before'
  | 'after'
  | 'within_days'
  | 'divisible_by';

export const COMPARISON_OPS: readonly ComparisonOp[] = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between',
  'in', 'not_in', 'contains', 'not_contains', 'subset_of', 'superset_of', 'intersects',
  'matches', 'regex', 'prefix', 'suffix',
  'exists', 'not_exists', 'is_null', 'is_empty',
  'before', 'after', 'within_days',
  'divisible_by',
];

/** 保留属性（`$` 前缀），不参与求值语义 */
export interface ReservedProps {
  $label?: string;
  $required?: boolean;
  $onMissing?: 'fail_closed' | 'fail_open';
  /**
   * ★ `docs/10 P5` ③：**时间敏感的组合**可声明最大时跨（如 `1h`）。
   *   子树里各事实的采集时间跨度超过它 → 该节点判 `indeterminate`。
   */
  $maxSkew?: string;
  $note?: string;
}

export interface ComparisonNode extends ReservedProps {
  /** 单一操作符键；值为 `{ <operandPath>: <expected> }` */
  [op: string]: unknown;
}

export interface LogicNode extends ReservedProps {
  all?: readonly Expression[];
  any?: readonly Expression[];
  not?: Expression;
  none?: readonly Expression[];
  atLeast?: { n: number; of: readonly Expression[] };
  atMost?: { n: number; of: readonly Expression[] };
  exactly?: { n: number; of: readonly Expression[] };
  score?: { threshold: number; of: readonly { weight: number; expr: Expression }[] };
  always?: boolean;
  never?: boolean;
}

export type Expression = LogicNode | ComparisonNode;

// ─────────────────────────── 操作数取值 ───────────────────────────

export interface EvaluationContext {
  /**
   * `fact.<ns>.<path>` 的取值。
   *
   * ★ 必须区分两种「没有值」，否则语义会被混淆：
   *   - 返回 `undefined` = **该事实从未被采集**（渠道故障 / 尚未采集 / 已过期）
   *     → 默认判 `indeterminate`（H1：不降级）；
   *   - 返回 `null` = **采集过，但下游明确没有这个值**（如「用户没有绑定 QQ」）
   *     → 是一个**已确定的答案**，`exists` 判 false、`is_null` 判 true。
   *   把两者混为一谈会让「渠道挂了」与「确实没有」得到同一个结论。
   */
  facts: (namespace: string, path: string) => unknown;
  /** `user.<field>` */
  user: Record<string, unknown>;
  /** `binding.<pluginId>.<field>` */
  bindings?: Record<string, Record<string, unknown>>;
  /**
   * ★★ **跨系统寻址的取值**（`subject:<provider>.<attr>`，`docs/04 §1.2.7.2`）。
   *
   * ★ 为什么是"预先解析好的映射"而不是一个异步函数：
   *   **求值是同步的**，而「查绑定 → 读下游主体属性」是异步的。
   *   因此与 `facts` 同构——值在**快照阶段**解析好，求值时只做同步取值。
   * ★ 键形如 `group`（策略绑定的 provider）或 `newapi.group`（显式 provider）。
   * ★ `undefined` 的语义与 `facts` 一致：**取不到**（未绑定 / 渠道故障 / 无该属性）
   *   → 交 `$onMissing` 决定，而不是判 `false`。
   */
  subject?: Record<string, unknown>;
  /**
   * ★★ **身份域断言**（`identity:oidc@<ref>.<claim>`，`docs/04 §1.2.7.3` / `docs/03:1120`）。
   *
   * ★ 语义（文档原话）：它提供该用户在**某个 OIDC 唯一标识符**下的身份信息，
   *   **不依赖任何具体下游系统**。典型用法是 `identity:oidc@platform:gate.email_verified`。
   * ★ 与 `subject` 同构：**预先解析好的映射** —— 求值是同步的，而"查身份记录"是异步的。
   * ★ 值只包含**声明开放（`exposedClaims`）**的 claim
   *   （`docs/03`：其余 claim **既不落库也不可见**）；
   *   `undefined` = **取不到**（没有该身份 / claim 未开放 / 从未登录过该提供方）
   *   → 交 `$onMissing` 决定，而不是判 `false`（H1：不降级）。
   * ★ 键是**完整地址**（`identity:oidc@<ref>.<claim>`，由 `claimAddressOf` 构造）——
   *   与策略里书写的字符串**逐字一致**，避免再引入一套"短名→地址"的映射（那是分叉的温床）。
   */
  identity?: Record<string, unknown>;
  /** 时间基准（`before/after/within_days` 用；测试可注入） */
  now?: Date;
  /**
   * 未知事实的处理：`indeterminate`（默认，H1 原则）或 `false`（严格模式）。
   * 默认必须是 indeterminate——把缺失当 false 会造成误收回。
   */
  missingPolicy?: 'indeterminate' | 'false';
  /**
   * ★ `docs/10 P5` ②：按**完整事实路径**（如 `fact.email.domain`）取采集时间。
   *
   * 未提供时行为与从前完全一致（`ExplainNode.collectedAt` 不出现）——
   * 因此这是一个**向后兼容的可选增强**：装配层（`eligibility` / `patrol` / 试算）
   * 有快照就注入，没有（如手工构造的试算事实）就不注入。
   */
  factCollectedAt?: (fullPath: string) => Date | undefined;
}

/** 解析操作数路径。 */
export function parseOperand(raw: string): OperandRef {
  const path = raw.trim();
  // ★ `subject:` / `subject.` —— **跨系统寻址**（`docs/04 §1.2.7.2`）：
  //   它回答「**用户在某个下游系统里是谁**」。
  //   ★ 必须放在下面的 `firstDot` 切分**之前**：`subject:newapi.group` 的第一个点
  //     在 `newapi` 与 `group` 之间，按通用切分会把 head 认成 `subject:newapi`。
  if (path.startsWith('subject:')) {
    return { kind: 'subject', path: `subject.${path.slice('subject:'.length)}` };
  }
  // ★★ `fact:` / `me:` 的**限定写法**同样必须识别（`docs/04 §1.2.7` 的 root 集合
  //    就是 `subject | fact | identity | me`）—— 否则它们会**掉进下面的 `literal`**：
  //      `fact:email.domain` 被当成**字符串字面量**，
  //      于是 `{ eq: { 'fact:email.domain': 'x' } }` **永远为 false，且不报缺失**。
  //    ★ 后果不是"少个功能"，而是「**用文档推荐写法写的策略静默失效**」：
  //      渠道故障时本该 `indeterminate`（不推进状态），却成了"不满足"（可能**误收回权限**）。
  //    ★ 与 `subject:` 一致地**归一为点号形式** —— 下游 `resolveOperand` 按
  //      `fact.<ns>.<path>` 的位置切片取值，不归一会切出错值。
  if (path.startsWith('fact:')) {
    const rest = path.slice('fact:'.length);
    return { kind: 'fact', path: `fact.${rest}`, namespace: rest.split('.')[0] ?? rest };
  }
  if (path.startsWith('me:')) {
    return { kind: 'user', path: `user.${path.slice('me:'.length)}` };
  }
  // ★★ `identity:oidc@<ref>.<claim>`（`docs/04 §1.2.7.3`）—— 与 `subject:` 同一处埋的坑：
  //    不识别它就会掉进 `literal`，**变成一个永远为假的字符串比较**。
  //    ★ 必须放在通用点号切分**之前**：第一个点出现在 `<ref>` 与 `<claim>` 之间
  //      （而 `<ref>` 自身含 `:`，如 `platform:gate`）。
  //    ★ `path` 保持**原样**：键就是表达式里写的那个完整地址。
  if (path.startsWith('identity:')) {
    return { kind: 'identity', path };
  }
  const firstDot = path.indexOf('.');
  if (firstDot < 0) return { kind: 'literal', path };
  const head = path.slice(0, firstDot);
  const rest = path.slice(firstDot + 1);
  if (head === 'fact') {
    const nsEnd = rest.indexOf('.');
    if (nsEnd < 0) return { kind: 'fact', path, namespace: rest };
    return { kind: 'fact', path, namespace: rest.slice(0, nsEnd) };
  }
  if (head === 'user') return { kind: 'user', path };
  // ★ `me.` 是**统一寻址的规范写法**（docs/04 §1.2.7：root := subject|fact|identity|me）。
  //   求值器必须与寻址层对齐——否则 `me.email_verified` 在寻址层合法、
  //   在求值层取不到值（判为 false），这种「两层不一致」极难排查。
  //   这里归一为内部的 `user.` 形式（求值上下文里平台用户仍叫 user）。
  if (head === 'me') return { kind: 'user', path: `user.${rest}` };
  if (head === 'binding') return { kind: 'binding', path };
  if (head === 'subject') return { kind: 'subject', path };
  return { kind: 'literal', path };
}

/** 路径取值：支持 `a.b`、`a[0]`、`a[*]`（后者返回数组）。 */
/**
 * 路径取值：支持 `a.b`、`a[0]`、`a[*]`。
 *
 * ★ `a[*].c` 必须**投影后续段**（返回 `[1, 2]` 而不是 undefined 或整个数组）。
 *   docs/04 §1.2.3 明确把 `fact.github.repos[*].stars` 列为支持的写法；
 *   早期实现只在 `[*]` 处展开数组、不把后面的段作用到每个元素上，
 *   结果是「文档说支持的路径取不到值」——而策略作者会以为是事实没采到。
 *
 * 语义：`[*]` 之后路径在**数组元素上并行推进**；最终若走过通配符则返回数组，
 * 否则返回标量。
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (path.length === 0) return root;
  const segments = path.split('.');
  let current: unknown = root;
  /** 当前是否已因 `[*]` 展开成数组——若是，后续段要投影到每个元素上 */
  let wildcardProjection = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    // 已经处于「通配展开后的数组」：把剩余整段路径作用到每个元素，收集结果
    if (Array.isArray(current) && wildcardProjection) {
      const rest = segments.slice(index).join('.');
      return current.map((item) => resolvePath(item, rest)).flat();
    }
    if (current === null || current === undefined) return undefined;

    const bracket = /^([A-Za-z0-9_-]*)((?:\[\d+\]|\[\*\])*)$/.exec(segment);
    if (bracket === null) return undefined;
    const key = bracket[1] ?? '';
    if (key.length > 0) {
      if (Array.isArray(current)) {
        const numeric = Number(key);
        current = Number.isInteger(numeric) ? current[numeric] : undefined;
      } else if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[key];
      } else return undefined;
    }

    for (const accessor of (bracket[2] ?? '').matchAll(/\[(\d+|\*)\]/g)) {
      const token = accessor[1]!;
      if (token === '*') {
        if (Array.isArray(current)) {
          wildcardProjection = true;
          // 保持为数组，下一轮由上面的投影分支处理剩余段
        } else if (current !== null && typeof current === 'object') {
          current = Object.values(current as Record<string, unknown>);
          wildcardProjection = true;
        } else return undefined;
      } else if (Array.isArray(current)) {
        current = current[Number(token)];
      } else return undefined;
    }
  }
  return current;
}

interface Resolved {
  value: unknown;
  present: boolean;
}

function resolveOperand(ref: OperandRef, context: EvaluationContext): Resolved {
  if (ref.kind === 'literal') return { value: ref.path, present: true };
  if (ref.kind === 'user') {
    const field = ref.path.slice('user.'.length);
    const value = resolvePath(context.user, field);
    return { value, present: value !== undefined };
  }
  if (ref.kind === 'binding') {
    const parts = ref.path.slice('binding.'.length).split('.');
    const pluginId = parts[0] ?? '';
    const rest = parts.slice(1).join('.');
    const binding = context.bindings?.[pluginId];
    if (binding === undefined) return { value: undefined, present: false };
    const value = resolvePath(binding, rest);
    return { value, present: value !== undefined };
  }
  if (ref.kind === 'subject') {
    // ★ 与 `fact.*` 同构的三态：`undefined` = **取不到**（未绑定 / 渠道故障 / 无该属性）
    //   → 交 `$onMissing` 决定，而不是判 `false`（否则一次渠道抖动会误收回资格）。
    const key = ref.path.slice('subject.'.length);
    const value = context.subject?.[key];
    return { value, present: value !== undefined };
  }
  // ★★ `identity:oidc@<ref>.<claim>`（`docs/04 §1.2.7.3`）——与 `subject` 同构的**三态**：
  //    `undefined` = 取不到（没有该身份 / claim 未开放 / 从未在该提供方登录过）
  //    → 交 `$onMissing` 决定（默认 indeterminate），**不得判 false**（H1：不降级）。
  //    ★ 键就是表达式里书写的**完整地址**（与 `claimAddressOf` 的产出逐字一致）。
  if (ref.kind === 'identity') {
    const value = context.identity?.[ref.path];
    return { value, present: value !== undefined };
  }
  // fact：★ undefined = 从未采集（缺失）；null = 采集过且明确为空（已确定）
  const namespace = ref.namespace ?? '';
  const rest = ref.path.slice(`fact.${namespace}`.length + 1);
  const value = context.facts(namespace, rest);
  return { value, present: value !== undefined };
}

// ─────────────────────────── 比较 ───────────────────────────

export class ExpressionEngineError extends Error {
  override readonly name = 'ExpressionEngineError';
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (value instanceof Date) return value.getTime();
  return undefined;
}

function toTime(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number' || typeof a === 'boolean' || typeof b === 'boolean') {
    const na = toNumber(a);
    const nb = toNumber(b);
    return na !== undefined && nb !== undefined && na === nb;
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => looseEqual(item, b[i]));
  return false;
}

/**
 * glob 匹配（`*.edu.cn`），大小写不敏感。
 *
 * ★ 口径统一：`*.edu.cn` **同时命中裸域与子域**（`edu.cn` 与 `tsinghua.edu.cn`）。
 *   直觉上 `*` 至少匹配一个字符（所以 `*.edu` 不命中 `edu`），但域名规则里
 *   「允许 *.edu.cn」几乎总是指「这个域及其子域」——`builtin/email-domain` 的规则编译
 *   就是这个口径。两处口径不一致会让「策略里能配、插件里判不出」这类问题极难排查。
 */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escaped}$`, 'i');
  if (regex.test(value)) return true;
  // `**@corp.com`（docs/03 的 glob 写法）：语义 = corp.com 及其子域
  const atPattern = /^\*\*@(.+)$/.exec(pattern);
  if (atPattern !== null) {
    const base = atPattern[1]!.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^(?:.*\\.)?${base}$`, 'i').test(value);
  }
  // 裸域补充：pattern 形如 `*.base` 时，也允许 `base` 本身
  const starDot = /^\*\.(.+)$/.exec(pattern);
  if (starDot !== null) return new RegExp(`^${starDot[1]!.replace(/[.+^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(value);
  return false;
}

/** 单个比较的求值（不含三态判定）。 */
function compare(op: ComparisonOp, actual: unknown, expected: unknown, now: Date): boolean {
  switch (op) {
    case 'eq':
      return looseEqual(actual, expected);
    case 'ne':
      return !looseEqual(actual, expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === undefined || b === undefined) {
        const ta = toTime(actual);
        const tb = toTime(expected);
        if (ta === undefined || tb === undefined) return false;
        return op === 'gt' ? ta > tb : op === 'gte' ? ta >= tb : op === 'lt' ? ta < tb : ta <= tb;
      }
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const a = toNumber(actual);
      const lo = toNumber(expected[0]);
      const hi = toNumber(expected[1]);
      if (a === undefined || lo === undefined || hi === undefined) return false;
      return a >= lo && a <= hi;
    }
    case 'in':
      // ★ 语义：`in` 只在**标量**与集合之间判定「包含于」。左值是数组时它表达不了
      //   「任一元素命中」——那应当用 `intersects`（文档操作符表里两者并列）。
      //   早期实现把数组左值按「任一匹配」处理，导致 `in` 与 `intersects` 无法区分，
      //   策略作者会把两者当同义词用，出问题极难定位。
      if (Array.isArray(actual)) return false;
      return asArray(expected).some((item) => looseEqual(actual, item));
    case 'not_in':
      return !asArray(expected).some((item) => looseEqual(actual, item));
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected));
      return asArray(actual).some((item) => looseEqual(item, expected));
    case 'not_contains':
      if (typeof actual === 'string') return !actual.includes(String(expected));
      return !asArray(actual).some((item) => looseEqual(item, expected));
    case 'subset_of':
      return asArray(actual).every((item) => asArray(expected).some((e) => looseEqual(item, e)));
    case 'superset_of':
      return asArray(expected).every((item) => asArray(actual).some((a) => looseEqual(a, item)));
    case 'intersects':
      return asArray(actual).some((item) => asArray(expected).some((e) => looseEqual(item, e)));
    case 'matches':
      return asArray(expected).some((pattern) => globMatch(String(pattern), String(actual)));
    case 'regex': {
      try {
        return new RegExp(String(expected)).test(String(actual));
      } catch {
        return false;
      }
    }
    case 'prefix':
      return String(actual).startsWith(String(expected));
    case 'suffix':
      return String(actual).endsWith(String(expected));
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    case 'is_null':
      return actual === null || actual === undefined;
    case 'is_empty': {
      if (actual === null || actual === undefined) return true;
      if (typeof actual === 'string') return actual.length === 0;
      if (Array.isArray(actual)) return actual.length === 0;
      if (typeof actual === 'object') return Object.keys(actual as object).length === 0;
      return false;
    }
    case 'before': {
      const a = toTime(actual);
      const b = toTime(expected);
      return a !== undefined && b !== undefined && a < b;
    }
    case 'after': {
      const a = toTime(actual);
      const b = toTime(expected);
      return a !== undefined && b !== undefined && a > b;
    }
    case 'within_days': {
      const a = toTime(actual);
      const days = toNumber(expected);
      if (a === undefined || days === undefined) return false;
      return now.getTime() - a <= days * 86_400_000;
    }
    case 'divisible_by': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      return a !== undefined && b !== undefined && b !== 0 && a % b === 0;
    }
    default:
      throw new ExpressionEngineError(`未知操作符 '${op satisfies never}'`);
  }
}

// ─────────────────────────── 求值 ───────────────────────────

const RESERVED_KEYS = new Set(['$label', '$required', '$onMissing', '$note', '$maxSkew']);

export interface EvaluateOptions {
  context: EvaluationContext;
  /** 嵌套深度上限（docs/04 §1.1：工程上限 32 层） */
  maxDepth?: number;
}

export function evaluateExpression(expression: Expression, options: EvaluateOptions): ExplainNode {
  return evaluateNode(expression, options.context, 0, options.maxDepth ?? 32);
}

function missingState(context: EvaluationContext): Truth {
  return (context.missingPolicy ?? 'indeterminate') === 'false' ? 'false' : 'indeterminate';
}

/**
 * ★★ `docs/10 P5` ③：**时间偏斜判定**（`$maxSkew`）。
 *
 * 为什么需要它：策略可能同时引用「1 小时前采的 star 数」与「3 天前采的账号年龄」——
 * 判定基于**半新半旧**的组合，而**每一条事实单独看都是新鲜的**。
 *
 * ★ 超限时判 `indeterminate` 而**不是** `false`：按 H1「降级的证据要求高于升级」，
 *   用不确定的数据下结论既可能误升级、也可能误降级；宁可保持原状态，
 *   并把「为什么」写进结果树（用户/管理员能看到"这条依据是多久前采的"）。
 */
function applyMaxSkew(expression: Expression, node: ExplainNode): ExplainNode {
  const declared = (expression as ReservedProps).$maxSkew;
  if (declared === undefined) return node;
  const times = collectCollectedAtMs(node);
  if (times.length < 2) return node; // 少于两个事实 → 不存在「半新半旧」
  const skewMs = Math.max(...times) - Math.min(...times);
  const maxSkewMs = parseDuration(declared, -1);
  if (maxSkewMs <= 0) {
    throw new ExpressionEngineError(`$maxSkew '${declared}' 无法解析（应为 30m / 1h / 2d 之类）`);
  }
  if (skewMs <= maxSkewMs) return node;
  return {
    ...node,
    state: 'indeterminate',
    reason:
      `${node.reason}；但依据的事实时跨 ${formatDuration(skewMs)}，` +
      `超过声明的 $maxSkew ${declared} → 判 indeterminate（不用半新半旧的数据下结论）`,
    maxSkew: { declared, skewMs },
  };
}

/** 从结果子树收集所有叶子的采集时间（毫秒）。 */
export function collectCollectedAtMs(node: ExplainNode): number[] {
  const out: number[] = [];
  const visit = (current: ExplainNode): void => {
    if (current.collectedAt !== undefined) {
      const parsed = new Date(current.collectedAt).getTime();
      if (!Number.isNaN(parsed)) out.push(parsed);
    }
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return out;
}

function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return `${(ms / 86_400_000).toFixed(1)}d`;
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${ms}ms`;
}

/**
 * 求值入口：**每个节点**在返回前都经过 `$maxSkew` 判定。
 *
 * ★ 用「包装 + 内部函数」而不是在每个 `return` 处插代码——
 *   后者会漏掉任何一个分支，而**漏掉的那个分支恰好就是"不会判 indeterminate"的那条**。
 * ★ 内部递归仍调用本函数（函数声明提升），因此**所有层级**都被覆盖。
 */
function evaluateNode(
  expression: Expression,
  context: EvaluationContext,
  depth: number,
  maxDepth: number,
): ExplainNode {
  return applyMaxSkew(expression, evaluateNodeInner(expression, context, depth, maxDepth));
}

/** 原求值逻辑（重命名以便在每个节点出口统一应用 `$maxSkew`）。 */
function evaluateNodeInner(expression: Expression, context: EvaluationContext, depth: number, maxDepth: number): ExplainNode {
  if (depth > maxDepth) {
    throw new ExpressionEngineError(`表达式嵌套超过上限 ${maxDepth} 层`);
  }
  const reserved = expression as ReservedProps;
  const label = reserved.$label;

  // ── 常量节点 ──
  if (typeof (expression as LogicNode).always === 'boolean') {
    const value = (expression as LogicNode).always === true;
    return { kind: 'always', state: value ? 'true' : 'false', reason: value ? '无条件通过' : '条件恒假', ...(label === undefined ? {} : { label }) };
  }
  if (typeof (expression as LogicNode).never === 'boolean') {
    const value = (expression as LogicNode).never === true;
    return { kind: 'never', state: value ? 'false' : 'true', reason: value ? '永不通过' : '条件恒真', ...(label === undefined ? {} : { label }) };
  }

  // ── 逻辑节点 ──
  const logic = expression as LogicNode;
  if (Array.isArray(logic.all)) return combineAnd(logic.all, context, depth, maxDepth, 'all', label);
  if (Array.isArray(logic.any)) return combineOr(logic.any, context, depth, maxDepth, 'any', label);
  if (Array.isArray(logic.none)) {
    const inner = combineOr(logic.none, context, depth, maxDepth, 'none', undefined);
    return negate(inner, 'none', label);
  }
  if (logic.not !== undefined) {
    const inner = evaluateNode(logic.not, context, depth + 1, maxDepth);
    return negate(inner, 'not', label);
  }
  if (logic.atLeast !== undefined) {
    const { n, of } = logic.atLeast;
    const children = of.map((child) => evaluateNode(child, context, depth + 1, maxDepth));
    return countNode('atLeast', children, (t, f) => t >= n, n, of.length, label, '至少');
  }
  if (logic.atMost !== undefined) {
    const { n, of } = logic.atMost;
    const children = of.map((child) => evaluateNode(child, context, depth + 1, maxDepth));
    return countNode('atMost', children, (t) => t <= n, n, of.length, label, '至多');
  }
  if (logic.exactly !== undefined) {
    const { n, of } = logic.exactly;
    const children = of.map((child) => evaluateNode(child, context, depth + 1, maxDepth));
    return countNode('exactly', children, (t) => t === n, n, of.length, label, '恰好');
  }
  if (logic.score !== undefined) {
    const { threshold, of } = logic.score;
    let total = 0;
    let indeterminate = false;
    const children: ExplainNode[] = [];
    for (const item of of) {
      const node = evaluateNode(item.expr, context, depth + 1, maxDepth);
      children.push(node);
      if (node.state === 'indeterminate') {
        indeterminate = true;
        continue;
      }
      if (node.state === 'true') total += item.weight;
    }
    const state: Truth = indeterminate ? 'indeterminate' : total >= threshold ? 'true' : 'false';
    return {
      kind: 'score',
      state,
      reason:
        state === 'indeterminate'
          ? `加权分无法确定（部分条件不可判定）`
          : `加权分 ${total} ${total >= threshold ? '≥' : '<'} 阈值 ${threshold}`,
      actual: total,
      expected: threshold,
      children,
      ...(label === undefined ? {} : { label }),
    };
  }

  // ── 比较叶子 ──
  const opKey = Object.keys(expression).find((key) => !RESERVED_KEYS.has(key));
  if (opKey === undefined) {
    throw new ExpressionEngineError(`表达式节点既不是逻辑节点也不是比较节点：${JSON.stringify(expression)}`);
  }
  const op = opKey as ComparisonOp;
  if (!COMPARISON_OPS.includes(op)) {
    throw new ExpressionEngineError(`未知操作符 '${opKey}'（允许：${COMPARISON_OPS.join(', ')}）`);
  }
  const payload = (expression as Record<string, unknown>)[opKey];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ExpressionEngineError(`比较节点 '${opKey}' 的值必须是 { <操作数>: <期望值> } 形式`);
  }
  const entries = Object.entries(payload as Record<string, unknown>).filter(([key]) => !RESERVED_KEYS.has(key));
  if (entries.length !== 1) {
    throw new ExpressionEngineError(
      `比较节点 '${opKey}' 只允许一个操作数键，实际 ${entries.length} 个（要「同时满足」请放进 all）`,
    );
  }
  const [operandPath, expected] = entries[0]!;
  const ref = parseOperand(operandPath);
  const resolved = resolveOperand(ref, context);

  // `exists / not_exists / is_null / is_empty` 对「缺失」本身有明确语义，不判 indeterminate
  // ★ 只有 exists / not_exists 对「从未采集」有确定语义（它们问的就是「有没有」）。
  //   is_null / is_empty 问的是「值是什么」——没采集到值时**无从回答**，必须判 indeterminate，
  //   否则「渠道故障」会被当成「该字段为空」，进而错误地满足/不满足策略。
  const tolerantOfMissing: readonly ComparisonOp[] = ['exists', 'not_exists'];
  // ★ P5 ②：把采集时间带进结果树。**缺失/过期的事实也要带**——
  //   「这条依据是 3 天前采的、已经过期」正是最需要被看见的情况。
  const collectedAt = context.factCollectedAt?.(operandPath);
  const collectedAtField =
    collectedAt === undefined ? {} : { collectedAt: collectedAt.toISOString() };
  if (!resolved.present && !tolerantOfMissing.includes(op)) {
    const state = missingState(context);
    return {
      kind: 'cmp',
      op,
      operand: ref,
      state,
      reason:
        state === 'indeterminate'
          ? `事实 '${operandPath}' 缺失，无法判定（按 indeterminate 处理，不降级）`
          : `事实 '${operandPath}' 缺失，按 false 处理`,
      missing: [operandPath],
      expected,
      ...collectedAtField,
      ...(label === undefined ? {} : { label }),
    };
  }

  const passed = compare(op, resolved.value, expected, context.now ?? new Date());
  return {
    kind: 'cmp',
    op,
    operand: ref,
    state: passed ? 'true' : 'false',
    reason: passed
      ? `满足：${operandPath} ${op} ${JSON.stringify(expected)}`
      : `不满足：${operandPath} 实际 ${JSON.stringify(resolved.value)}，期望 ${op} ${JSON.stringify(expected)}`,
    actual: resolved.value,
    expected,
    ...collectedAtField,
    ...(label === undefined ? {} : { label }),
  };
}

function combineAnd(
  children: readonly Expression[],
  context: EvaluationContext,
  depth: number,
  maxDepth: number,
  kind: string,
  label: string | undefined,
): ExplainNode {
  const nodes: ExplainNode[] = [];
  for (const child of children) {
    const node = evaluateNode(child, context, depth + 1, maxDepth);
    nodes.push(node);
    if (node.state === 'false') {
      // 短路：遇 false 即停（与 docs/04 §1.2.1 一致）
      return {
        kind,
        state: 'false',
        reason: '存在不满足的条件',
        children: nodes,
        ...(label === undefined ? {} : { label }),
      };
    }
  }
  const indeterminate = nodes.filter((n) => n.state === 'indeterminate');
  if (indeterminate.length > 0) {
    return {
      kind,
      state: 'indeterminate',
      reason: `${indeterminate.length} 个条件不可判定`,
      missing: [...new Set(indeterminate.flatMap((n) => n.missing ?? []))],
      children: nodes,
      ...(label === undefined ? {} : { label }),
    };
  }
  return { kind, state: 'true', reason: '全部条件满足', children: nodes, ...(label === undefined ? {} : { label }) };
}

function combineOr(
  children: readonly Expression[],
  context: EvaluationContext,
  depth: number,
  maxDepth: number,
  kind: string,
  label: string | undefined,
): ExplainNode {
  const nodes: ExplainNode[] = [];
  for (const child of children) {
    const node = evaluateNode(child, context, depth + 1, maxDepth);
    nodes.push(node);
    if (node.state === 'true') {
      return { kind, state: 'true', reason: '存在满足的条件', children: nodes, ...(label === undefined ? {} : { label }) };
    }
  }
  const indeterminate = nodes.filter((n) => n.state === 'indeterminate');
  if (indeterminate.length > 0) {
    return {
      kind,
      state: 'indeterminate',
      reason: `${indeterminate.length} 个条件不可判定（其余均不满足）`,
      missing: [...new Set(indeterminate.flatMap((n) => n.missing ?? []))],
      children: nodes,
      ...(label === undefined ? {} : { label }),
    };
  }
  return { kind, state: 'false', reason: '全部条件不满足', children: nodes, ...(label === undefined ? {} : { label }) };
}

function negate(inner: ExplainNode, kind: string, label: string | undefined): ExplainNode {
  // ★ indeterminate 取反后仍是 indeterminate：把「不知道」取反成「知道」是逻辑错误
  const state: Truth = inner.state === 'indeterminate' ? 'indeterminate' : inner.state === 'true' ? 'false' : 'true';
  return {
    kind,
    state,
    reason: state === 'indeterminate' ? '被取反的条件不可判定' : `取反：${inner.reason}`,
    children: [inner],
    ...(inner.missing === undefined ? {} : { missing: inner.missing }),
    ...(label === undefined ? {} : { label }),
  };
}

function countNode(
  kind: string,
  children: readonly ExplainNode[],
  predicate: (trues: number, falses: number) => boolean,
  n: number,
  total: number,
  label: string | undefined,
  prefix: string,
): ExplainNode {
  const trues = children.filter((c) => c.state === 'true').length;
  const falses = children.filter((c) => c.state === 'false').length;
  const indeterminate = children.length - trues - falses;
  const satisfied = predicate(trues, falses);
  // 三态：已能满足 → true；已不可能满足 → false；否则 indeterminate
  const impossible = kind === 'atLeast' ? trues + indeterminate < n : kind === 'atMost' ? falses > n : false;
  const state: Truth = satisfied ? 'true' : indeterminate > 0 && !impossible ? 'indeterminate' : 'false';
  return {
    kind,
    state,
    reason: `${prefix} ${n} 项（共 ${total} 项，已满足 ${trues} 项${indeterminate > 0 ? `，${indeterminate} 项不可判定` : ''}）`,
    actual: trues,
    expected: n,
    children,
    ...(state === 'indeterminate'
      ? { missing: [...new Set(children.flatMap((c) => c.missing ?? []))] }
      : {}),
    ...(label === undefined ? {} : { label }),
  };
}

// ─────────────────────────── 静态校验 ───────────────────────────

/**
 * 静态校验（M1-9 的发布前门禁）。
 *
 * 覆盖 docs/04 §1.2.1 明确要求「发布时拒绝」的边界：
 *   - `all: []` / `any: []` → 拒绝（否则一次编辑失误清空条件会让**全站主体立即满足**）
 *   - `atLeast.n = 0` → 拒绝；`atLeast.n > of.length` → 拒绝
 *   - 比较节点多个操作数键 → 拒绝
 *   - 未知操作符 → 拒绝
 *   - 嵌套超过 32 层 → 拒绝
 */
export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateExpressionTree(expression: unknown, options: { maxDepth?: number; path?: string } = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxDepth = options.maxDepth ?? 32;

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth) {
      issues.push({ path, message: `嵌套超过上限 ${maxDepth} 层` });
      return;
    }
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      issues.push({ path, message: '表达式节点必须是对象' });
      return;
    }
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => !RESERVED_KEYS.has(k));
    if (keys.length === 0) {
      issues.push({ path, message: '空节点（请显式写 always: true 或 never: true）' });
      return;
    }

    if (keys.includes('always') || keys.includes('never')) {
      const key = keys.includes('always') ? 'always' : 'never';
      if (typeof record[key] !== 'boolean') issues.push({ path, message: `${key} 必须是布尔值` });
      if (keys.length > 1) issues.push({ path, message: `${key} 不能与其它键共存` });
      return;
    }

    for (const logicKey of ['all', 'any', 'none'] as const) {
      if (record[logicKey] === undefined) continue;
      const value = record[logicKey];
      if (!Array.isArray(value)) {
        issues.push({ path, message: `${logicKey} 必须是数组` });
        continue;
      }
      if (value.length === 0) {
        issues.push({
          path,
          message:
            `${logicKey}: [] 被拒绝——` +
            (logicKey === 'all'
              ? 'all: [] 数学上恒真，会让全站主体立即满足（无条件请显式写 always: true）'
              : 'any: [] 恒假（无条件请显式写 never: true）'),
        });
        continue;
      }
      value.forEach((child, index) => walk(child, `${path}.${logicKey}[${index}]`, depth + 1));
    }

    if (record['not'] !== undefined) walk(record['not'], `${path}.not`, depth + 1);

    for (const countKey of ['atLeast', 'atMost', 'exactly'] as const) {
      const value = record[countKey];
      if (value === undefined) continue;
      if (value === null || typeof value !== 'object') {
        issues.push({ path, message: `${countKey} 必须是 { n, of } 形式` });
        continue;
      }
      const spec = value as { n?: unknown; of?: unknown };
      if (typeof spec.n !== 'number' || !Number.isInteger(spec.n) || spec.n < 0) {
        issues.push({ path, message: `${countKey}.n 必须是非负整数` });
      }
      if (!Array.isArray(spec.of) || spec.of.length === 0) {
        issues.push({ path, message: `${countKey}.of 必须是非空数组` });
        continue;
      }
      if (typeof spec.n === 'number') {
        if (countKey === 'atLeast' && spec.n === 0) {
          issues.push({ path, message: 'atLeast.n = 0 恒真 → 拒绝（无意义，几乎必然是配置错误）' });
        }
        if (countKey === 'atLeast' && spec.n > spec.of.length) {
          issues.push({ path, message: `atLeast.n = ${spec.n} 大于条件数 ${spec.of.length} → 恒假，拒绝` });
        }
        if (countKey === 'exactly' && spec.n > spec.of.length) {
          issues.push({ path, message: `exactly.n = ${spec.n} 大于条件数 ${spec.of.length} → 恒假，拒绝` });
        }
      }
      (spec.of as unknown[]).forEach((child, index) => walk(child, `${path}.${countKey}.of[${index}]`, depth + 1));
    }

    if (record['score'] !== undefined) {
      const value = record['score'];
      if (value === null || typeof value !== 'object') {
        issues.push({ path, message: 'score 必须是 { threshold, of } 形式' });
      } else {
        const spec = value as { threshold?: unknown; of?: unknown };
        if (typeof spec.threshold !== 'number') issues.push({ path, message: 'score.threshold 必须是数字' });
        if (!Array.isArray(spec.of) || spec.of.length === 0) {
          issues.push({ path, message: 'score.of 必须是非空数组' });
        } else {
          let totalWeight = 0;
          (spec.of as { weight?: unknown; expr?: unknown }[]).forEach((item, index) => {
            if (typeof item.weight !== 'number') issues.push({ path, message: `score.of[${index}].weight 必须是数字` });
            else totalWeight += item.weight;
            if (item.expr === undefined) issues.push({ path, message: `score.of[${index}].expr 缺失` });
            else walk(item.expr, `${path}.score.of[${index}].expr`, depth + 1);
          });
          if (spec.threshold === 0 && totalWeight === 0) {
            issues.push({ path, message: 'score.threshold = 0 且权重全为 0 → 除零/无意义，拒绝' });
          }
        }
      }
    }

    // 比较叶子
    const opKeys = keys.filter((key) => COMPARISON_OPS.includes(key as ComparisonOp));
    const unknownKeys = keys.filter(
      (key) => !COMPARISON_OPS.includes(key as ComparisonOp) && !['all', 'any', 'none', 'not', 'atLeast', 'atMost', 'exactly', 'score'].includes(key),
    );
    for (const key of unknownKeys) {
      issues.push({ path, message: `未知操作符或键 '${key}'（允许：${COMPARISON_OPS.join(', ')} 以及 all/any/not/none/atLeast/atMost/exactly/score）` });
    }
    if (opKeys.length > 1) {
      issues.push({ path, message: `比较节点只允许一个操作符键，实际 ${opKeys.length} 个（要「同时满足」请放进 all）` });
    }
    if (opKeys.length === 1) {
      const op = opKeys[0]!;
      const payload = record[op];
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        issues.push({ path: `${path}.${op}`, message: '比较节点的值必须是 { <操作数>: <期望值> } 形式' });
      } else {
        const operands = Object.entries(payload as Record<string, unknown>).filter(([k]) => !RESERVED_KEYS.has(k));
        if (operands.length !== 1) {
          issues.push({ path: `${path}.${op}`, message: `比较节点只允许一个操作数键，实际 ${operands.length} 个` });
        } else {
          const [operandPath, expected] = operands[0]!;
          if (!/^(fact|user|binding)\.[A-Za-z0-9_.\[\]*-]+$/.test(operandPath)) {
            issues.push({
              path: `${path}.${op}`,
              message: `操作数 '${operandPath}' 非法：必须以 fact./user./binding. 开头（路径只含字母数字与 . _ - [ ] *）`,
            });
          }
          if (op === 'between' && (!Array.isArray(expected) || expected.length !== 2)) {
            issues.push({ path: `${path}.${op}.${operandPath}`, message: 'between 的期望值必须是 [下界, 上界]' });
          }
          if (['in', 'not_in', 'matches', 'subset_of', 'superset_of', 'intersects'].includes(op) && !Array.isArray(expected)) {
            issues.push({ path: `${path}.${op}.${operandPath}`, message: `${op} 的期望值必须是数组` });
          }
        }
      }
    }
  };

  walk(expression, options.path ?? '$', 0);
  return issues;
}

// ─────────────────────────── 结果树辅助 ───────────────────────────

/** 收集结果树里所有不可判定的叶子（用于「差哪一项」与 `$onMissing` 归因）。 */
export function collectIndeterminate(node: ExplainNode): ExplainNode[] {
  const out: ExplainNode[] = [];
  const walk = (current: ExplainNode): void => {
    if (current.state === 'indeterminate' && (current.children === undefined || current.children.length === 0)) out.push(current);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

/** 收集所有**不满足**的叶子（用户侧「差在哪、差多少」）。 */
export function collectFailures(node: ExplainNode): ExplainNode[] {
  const out: ExplainNode[] = [];
  const walk = (current: ExplainNode): void => {
    if (current.state === 'false' && (current.children === undefined || current.children.length === 0)) out.push(current);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return out;
}
