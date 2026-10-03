/**
 * declarative 插件解释器（M1-4）—— 模板 + JSONPath 子集 + 受限表达式。
 *
 * 为什么要有这三件事（docs/03 §1.3 的策略：能用 declarative 解决的绝不写代码）：
 *   - **模板**：把密钥/绑定值注入请求（`{{ secrets.github.token }}`）——
 *     密钥**只以占位符形式**出现，插件代码永远拿不到明文；
 *   - **JSONPath 子集**：从任意下游响应里取值（`$.data.user.repositories.nodes[*].stargazerCount`）；
 *   - **受限表达式**：算派生事实（`days_between(created_at, now())`）。
 *
 * ★ 安全边界：这三者都是**外部输入驱动的求值**，因此：
 *   - 表达式**不用 eval / new Function**，而是自建词法+语法分析器，函数走白名单；
 *   - JSONPath 只支持取值，不支持函数与过滤表达式（避免变成图灵完备的查询语言）；
 *   - 模板占位符只允许点分路径，且**渲染结果不会回写进日志**（由调用方脱敏）。
 */

// ─────────────────────────── 模板 ───────────────────────────

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
}

/** 把 `a.b.0` 这样的点分路径在对象上求值；找不到返回 undefined。 */
export function getByPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (segment.length === 0) continue;
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;

export interface TemplateScope {
  secrets?: Record<string, string | undefined>;
  binding?: Record<string, unknown>;
  config?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  /** 采集上下文（如 now()）——由调用方提供，避免模板里读到宿主内部状态 */
  context?: Record<string, unknown>;
}

/**
 * 渲染模板字符串。
 *
 * `strict = true`（默认）时，占位符解析不到值即抛错——**这是刻意的**：
 * 静默渲染成空串会把「密钥配置错了」变成「请求发出去了但被 401」，
 * 排障成本高得多。需要可选值请显式用 `{{ default ... }}`（暂不支持，保持简单）。
 */
export function renderTemplate(template: string, scope: TemplateScope, strict = true): string {
  return template.replace(PLACEHOLDER, (_match, rawPath: string) => {
    const path = rawPath;
    const [namespace, ...rest] = path.split('.');
    const subpath = rest.join('.');
    let value: unknown;
    switch (namespace) {
      case 'secrets':
        value = scope.secrets?.[subpath];
        break;
      case 'binding':
        value = getByPath(scope.binding, subpath);
        break;
      case 'config':
        value = getByPath(scope.config, subpath);
        break;
      case 'env':
        value = scope.env?.[subpath];
        break;
      case 'context':
        value = getByPath(scope.context, subpath);
        break;
      default:
        if (strict) throw new TemplateError(`未知的占位符命名空间 '${namespace}'（允许：secrets/binding/config/env/context）`);
        return '';
    }
    if (value === undefined) {
      if (strict) throw new TemplateError(`占位符 {{ ${path} }} 解析不到值（当前值：undefined）`);
      return '';
    }
    if (value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/** 深度渲染：对对象/数组的每个字符串叶子做模板渲染（用于 headers / body）。 */
export function renderDeep(value: unknown, scope: TemplateScope, strict = true): unknown {
  if (typeof value === 'string') {
    // 整串就是一个占位符且解析结果是对象 → 保留原始类型（避免 JSON 里出现字符串化的对象）
    const single = /^\{\{\s*([a-z][a-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)\s*\}\}$/.exec(value);
    if (single !== null) {
      const path = single[1]!;
      const [namespace, ...rest] = path.split('.');
      const subpath = rest.join('.');
      const raw =
        namespace === 'secrets'
          ? scope.secrets?.[subpath]
          : namespace === 'binding'
            ? getByPath(scope.binding, subpath)
            : namespace === 'config'
              ? getByPath(scope.config, subpath)
              : namespace === 'env'
                ? scope.env?.[subpath]
                : namespace === 'context'
                  ? getByPath(scope.context, subpath)
                  : undefined;
      if (raw !== undefined && raw !== null && typeof raw === 'object') return raw;
    }
    return renderTemplate(value, scope, strict);
  }
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, scope, strict));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderDeep(item, scope, strict);
    }
    return out;
  }
  return value;
}

// ─────────────────────────── JSONPath 子集 ───────────────────────────

export class JsonPathError extends Error {
  override readonly name = 'JsonPathError';
}

interface PathStep {
  kind: 'key' | 'index' | 'wildcard';
  value?: string | number;
}

/**
 * 解析 JSONPath 子集。
 *
 * 支持：`$`、`$.a.b`、`$.a[*].b`、`$.a[0].b`、`$.a[0][1]`
 * **不支持**：函数、过滤表达式 `[?(...)]`、递归下降 `..`、脚本表达式。
 * 不支持的一律报错——静默当成「取不到值」会让插件作者以为路径写对了。
 */
export function parseJsonPath(path: string): PathStep[] {
  if (!path.startsWith('$')) throw new JsonPathError(`JSONPath 必须以 $ 开头：'${path}'`);
  const steps: PathStep[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i]!;
    if (ch === '.') {
      i += 1;
      if (path[i] === '.') throw new JsonPathError(`不支持递归下降 '..'（${path}）`);
      let j = i;
      while (j < path.length && /[A-Za-z0-9_-]/.test(path[j]!)) j += 1;
      if (j === i) throw new JsonPathError(`'.' 后缺少属性名：'${path}'`);
      steps.push({ kind: 'key', value: path.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '[') {
      const close = path.indexOf(']', i);
      if (close < 0) throw new JsonPathError(`'[' 未闭合：'${path}'`);
      const inner = path.slice(i + 1, close).trim();
      if (inner === '*') steps.push({ kind: 'wildcard' });
      else if (/^\d+$/.test(inner)) steps.push({ kind: 'index', value: Number(inner) });
      else if (/^['"][^'"]+['"]$/.test(inner)) steps.push({ kind: 'key', value: inner.slice(1, -1) });
      else {
        throw new JsonPathError(
          `不支持的方括号语法 '[${inner}]'（只支持 [*]、[0]、['key']；过滤表达式与函数不在子集内）`,
        );
      }
      i = close + 1;
      continue;
    }
    throw new JsonPathError(`JSONPath 中出现意外字符 '${ch}'：'${path}'`);
  }
  return steps;
}

/** 求值：返回**匹配值的数组**（wildcard 可能匹配多个）。 */
export function evaluateJsonPath(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const step of parseJsonPath(path)) {
    const next: unknown[] = [];
    for (const node of current) {
      if (step.kind === 'wildcard') {
        if (Array.isArray(node)) next.push(...node);
        else if (node !== null && typeof node === 'object') next.push(...Object.values(node as Record<string, unknown>));
        continue;
      }
      if (node === null || node === undefined) continue;
      if (step.kind === 'index') {
        if (Array.isArray(node)) {
          const item = node[step.value as number];
          if (item !== undefined) next.push(item);
        }
        continue;
      }
      if (typeof node === 'object' && !Array.isArray(node)) {
        const item = (node as Record<string, unknown>)[step.value as string];
        if (item !== undefined) next.push(item);
      }
    }
    current = next;
  }
  return current;
}

/** 按 transform 聚合 JSONPath 的匹配结果（docs/03 §1.4 的 `transform`）。 */
export function applyTransform(matches: readonly unknown[], transform: string | undefined): unknown {
  const numeric = (): number[] => matches.map((m) => Number(m)).filter((n) => Number.isFinite(n));
  switch (transform) {
    case undefined:
      // 无 transform：`as` 直接取第一个匹配（保持与「标量路径」直觉一致）
      return matches.length === 0 ? undefined : matches[0];
    case 'first':
      return matches.length === 0 ? undefined : matches[0];
    case 'last':
      return matches.length === 0 ? undefined : matches[matches.length - 1];
    case 'count':
    case 'length':
      return matches.length;
    case 'sum': {
      const values = numeric();
      return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0);
    }
    case 'min': {
      const values = numeric();
      return values.length === 0 ? undefined : Math.min(...values);
    }
    case 'max': {
      const values = numeric();
      return values.length === 0 ? undefined : Math.max(...values);
    }
    case 'avg': {
      const values = numeric();
      return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
    }
    case 'string':
      return matches.length === 0 ? undefined : String(matches[0]);
    default:
      throw new JsonPathError(`未知 transform '${transform}'`);
  }
}
