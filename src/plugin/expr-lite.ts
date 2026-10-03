/**
 * 受限表达式求值器（M1-4 / 为 M1-8 铺路）。
 *
 * ★ 为什么**不用** `eval` / `new Function`：
 *   表达式来自插件 manifest（外部输入）与策略定义（管理员输入）。
 *   用 `eval` 等于把「配置格式」变成「任意代码执行」——即使在沙箱里也不该这么设计。
 *   因此这里实现一个真正的词法分析 + 递归下降解析器，函数走**白名单**。
 *
 * 支持（刻意保持最小）：
 *   - 字面量：数字、单/双引号字符串、true/false/null
 *   - 标识符：从上下文取值（点分路径，如 `created_at`、`subject.group`）
 *   - 运算符：`+ - * / %`、`== != < <= > >=`、`&& || !`、括号
 *   - 函数白名单：now / days_between / seconds_between / len / lower / upper / coalesce /
 *     num / str / bool / min / max / abs / floor / ceil / round / contains / starts_with / ends_with
 *
 * 不支持：赋值、成员调用、属性访问到函数、正则、循环、条件语句。
 */

export class ExpressionError extends Error {
  override readonly name = 'ExpressionError';
  readonly position: number | undefined;
  constructor(message: string, position?: number) {
    super(position === undefined ? message : `${message}（位置 ${position}）`);
    this.position = position;
  }
}

// ─────────────────────────── 词法 ───────────────────────────

type TokenType = 'number' | 'string' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

const OPERATORS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!'];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j]!)) j += 1;
      const raw = input.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(raw)) throw new ExpressionError(`非法数字字面量 '${raw}'`, i);
      tokens.push({ type: 'number', value: raw, position: i });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < input.length) {
        const c = input[j]!;
        if (c === '\\') {
          const next = input[j + 1];
          if (next === undefined) break;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          j += 1;
          break;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new ExpressionError('字符串字面量未闭合', i);
      tokens.push({ type: 'string', value, position: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j]!)) j += 1;
      tokens.push({ type: 'identifier', value: input.slice(i, j), position: i });
      i = j;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch, position: i });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch, position: i });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch, position: i });
      i += 1;
      continue;
    }
    const operator = OPERATORS.find((op) => input.startsWith(op, i));
    if (operator === undefined) throw new ExpressionError(`无法识别的字符 '${ch}'`, i);
    tokens.push({ type: 'operator', value: operator, position: i });
    i += operator.length;
    continue;
  }
  tokens.push({ type: 'eof', value: '', position: input.length });
  return tokens;
}

// ─────────────────────────── 语法（AST） ───────────────────────────

export type ExprNode =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'ref'; path: string }
  | { kind: 'unary'; op: '!' | '-'; operand: ExprNode }
  | { kind: 'binary'; op: string; left: ExprNode; right: ExprNode }
  | { kind: 'call'; name: string; args: ExprNode[] };

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  private expect(type: TokenType, value?: string): Token {
    const token = this.peek();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      throw new ExpressionError(`期望 ${value ?? type}，实际是 '${token.value || token.type}'`, token.position);
    }
    return this.next();
  }

  parse(): ExprNode {
    const node = this.parseOr();
    if (this.peek().type !== 'eof') {
      throw new ExpressionError(`表达式结尾有多余内容 '${this.peek().value}'`, this.peek().position);
    }
    return node;
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.peek().type === 'operator' && this.peek().value === '||') {
      this.next();
      left = { kind: 'binary', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseEquality();
    while (this.peek().type === 'operator' && this.peek().value === '&&') {
      this.next();
      left = { kind: 'binary', op: '&&', left, right: this.parseEquality() };
    }
    return left;
  }

  private parseEquality(): ExprNode {
    let left = this.parseComparison();
    while (this.peek().type === 'operator' && ['==', '!=', '===', '!=='].includes(this.peek().value)) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): ExprNode {
    let left = this.parseAdditive();
    while (this.peek().type === 'operator' && ['<', '<=', '>', '>='].includes(this.peek().value)) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    while (this.peek().type === 'operator' && ['+', '-'].includes(this.peek().value)) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary();
    while (this.peek().type === 'operator' && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    const token = this.peek();
    if (token.type === 'operator' && (token.value === '!' || token.value === '-')) {
      this.next();
      return { kind: 'unary', op: token.value as '!' | '-', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();
    if (token.type === 'number') {
      this.next();
      return { kind: 'literal', value: Number(token.value) };
    }
    if (token.type === 'string') {
      this.next();
      return { kind: 'literal', value: token.value };
    }
    if (token.type === 'lparen') {
      this.next();
      const node = this.parseOr();
      this.expect('rparen');
      return node;
    }
    if (token.type === 'identifier') {
      this.next();
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      if (this.peek().type === 'lparen') {
        this.next();
        const args: ExprNode[] = [];
        if (this.peek().type !== 'rparen') {
          args.push(this.parseOr());
          while (this.peek().type === 'comma') {
            this.next();
            args.push(this.parseOr());
          }
        }
        this.expect('rparen');
        return { kind: 'call', name: token.value, args };
      }
      return { kind: 'ref', path: token.value };
    }
    throw new ExpressionError(`无法解析的表达式片段 '${token.value || token.type}'`, token.position);
  }
}

/** 解析表达式为 AST（可用于静态校验：发布策略前检查函数是否存在）。 */
export function parseExpression(source: string): ExprNode {
  if (source.trim().length === 0) throw new ExpressionError('表达式为空');
  return new Parser(tokenize(source)).parse();
}

// ─────────────────────────── 求值 ───────────────────────────

export interface ExpressionContext {
  /** 变量表；名称可含点分路径（`subject.group`） */
  [name: string]: unknown;
}

type FunctionImpl = (args: unknown[]) => unknown;

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  if (value instanceof Date) return value.getTime();
  return Number.NaN;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/**
 * 函数白名单。
 *
 * ★ `now` 由**调用方**通过上下文注入（`__now`），而不是在这里读系统时钟——
 *   否则表达式求值会不可测（测试无法固定时间），也会让「历史评估可复现」失效。
 */
export const FUNCTIONS: Record<string, { arity: [number, number]; fn: FunctionImpl }> = {
  now: { arity: [0, 0], fn: () => new Date() },
  days_between: { arity: [2, 2], fn: ([a, b]) => (toMillis(b) - toMillis(a)) / 86_400_000 },
  seconds_between: { arity: [2, 2], fn: ([a, b]) => (toMillis(b) - toMillis(a)) / 1_000 },
  len: { arity: [1, 1], fn: ([v]) => (typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : 0) },
  lower: { arity: [1, 1], fn: ([v]) => String(v ?? '').toLowerCase() },
  upper: { arity: [1, 1], fn: ([v]) => String(v ?? '').toUpperCase() },
  coalesce: { arity: [1, 8], fn: (args) => args.find((a) => a !== null && a !== undefined && a !== '') ?? null },
  num: { arity: [1, 1], fn: ([v]) => toNumber(v) },
  str: { arity: [1, 1], fn: ([v]) => (v === null || v === undefined ? '' : String(v)) },
  bool: { arity: [1, 1], fn: ([v]) => Boolean(v) },
  min: { arity: [1, 8], fn: (args) => Math.min(...args.map(toNumber)) },
  max: { arity: [1, 8], fn: (args) => Math.max(...args.map(toNumber)) },
  abs: { arity: [1, 1], fn: ([v]) => Math.abs(toNumber(v)) },
  floor: { arity: [1, 1], fn: ([v]) => Math.floor(toNumber(v)) },
  ceil: { arity: [1, 1], fn: ([v]) => Math.ceil(toNumber(v)) },
  round: { arity: [1, 1], fn: ([v]) => Math.round(toNumber(v)) },
  contains: { arity: [2, 2], fn: ([haystack, needle]) => String(haystack ?? '').includes(String(needle ?? '')) },
  starts_with: { arity: [2, 2], fn: ([haystack, needle]) => String(haystack ?? '').startsWith(String(needle ?? '')) },
  ends_with: { arity: [2, 2], fn: ([haystack, needle]) => String(haystack ?? '').endsWith(String(needle ?? '')) },
};

export interface EvaluateOptions {
  /** 允许的函数名集合（默认全部白名单）。静态校验时可传更小集合 */
  functions?: Record<string, { arity: [number, number]; fn: FunctionImpl }>;
  /** 是否要求所有 ref 都能解析（默认 false：缺失 → undefined，交由调用方决定语义） */
  strictRefs?: boolean;
}

export function evaluate(node: ExprNode, context: ExpressionContext, options: EvaluateOptions = {}): unknown {
  const table = options.functions ?? FUNCTIONS;
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'ref': {
      // `now` 作为函数名时已由 call 分支处理；作为 ref 时读上下文注入值
      if (node.path === 'now') {
        const injected = context['__now'];
        return injected instanceof Date ? injected : context['now'];
      }
      if (Object.prototype.hasOwnProperty.call(context, node.path)) return context[node.path];
      // 允许用点分路径直接引用嵌套对象：先按整串匹配，失败再按首段展开
      const [head, ...rest] = node.path.split('.');
      if (head !== undefined && Object.prototype.hasOwnProperty.call(context, head)) {
        let current: unknown = context[head];
        for (const segment of rest) {
          if (current === null || current === undefined || typeof current !== 'object') return undefined;
          current = (current as Record<string, unknown>)[segment];
        }
        return current;
      }
      if (options.strictRefs === true) throw new ExpressionError(`未定义的引用 '${node.path}'`);
      return undefined;
    }
    case 'unary': {
      const operand = evaluate(node.operand, context, options);
      return node.op === '!' ? !truthy(operand) : -toNumber(operand);
    }
    case 'binary': {
      // 短路语义
      if (node.op === '&&') {
        const left = evaluate(node.left, context, options);
        return truthy(left) ? truthy(evaluate(node.right, context, options)) : false;
      }
      if (node.op === '||') {
        const left = evaluate(node.left, context, options);
        return truthy(left) ? true : truthy(evaluate(node.right, context, options));
      }
      const left = evaluate(node.left, context, options);
      const right = evaluate(node.right, context, options);
      switch (node.op) {
        case '+':
          if (typeof left === 'string' || typeof right === 'string') return `${left ?? ''}${right ?? ''}`;
          return toNumber(left) + toNumber(right);
        case '-':
          return toNumber(left) - toNumber(right);
        case '*':
          return toNumber(left) * toNumber(right);
        case '/':
          return toNumber(left) / toNumber(right);
        case '%':
          return toNumber(left) % toNumber(right);
        case '==':
        case '===':
          return looseEqual(left, right);
        case '!=':
        case '!==':
          return !looseEqual(left, right);
        case '<':
          return toNumber(left) < toNumber(right);
        case '<=':
          return toNumber(left) <= toNumber(right);
        case '>':
          return toNumber(left) > toNumber(right);
        case '>=':
          return toNumber(left) >= toNumber(right);
        default:
          throw new ExpressionError(`未知运算符 '${node.op}'`);
      }
    }
    case 'call': {
      const impl = table[node.name];
      if (impl === undefined) {
        throw new ExpressionError(
          `函数 '${node.name}' 不在白名单内（允许：${Object.keys(table).sort().join(', ')}）`,
        );
      }
      const [min, max] = impl.arity;
      if (node.args.length < min || node.args.length > max) {
        throw new ExpressionError(`函数 '${node.name}' 需要 ${min === max ? min : `${min}~${max}`} 个参数，实际 ${node.args.length} 个`);
      }
      const args = node.args.map((arg) => evaluate(arg, context, options));
      // now() 用注入的时间基准，保证可测与可复现
      if (node.name === 'now') {
        const injected = context['__now'];
        if (injected instanceof Date) return injected;
      }
      return impl.fn(args);
    }
  }
}

function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 宽松相等：数字与数字串可比（`quota >= '40'` 这种写法在配置里很常见）。 */
function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = toNumber(a);
    const nb = toNumber(b);
    return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
  }
  return false;
}

/** 便捷入口：解析 + 求值。 */
export function evalExpression(source: string, context: ExpressionContext, options?: EvaluateOptions): unknown {
  return evaluate(parseExpression(source), context, options);
}

/** 静态校验：只检查语法与函数名/参数个数，不求值。 */
export function validateExpression(source: string, functions: Record<string, { arity: [number, number] }> = FUNCTIONS): string[] {
  const errors: string[] = [];
  let ast: ExprNode;
  try {
    ast = parseExpression(source);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const walk = (node: ExprNode): void => {
    switch (node.kind) {
      case 'literal':
      case 'ref':
        return;
      case 'unary':
        walk(node.operand);
        return;
      case 'binary':
        walk(node.left);
        walk(node.right);
        return;
      case 'call': {
        const impl = functions[node.name];
        if (impl === undefined) {
          errors.push(`函数 '${node.name}' 不在白名单内`);
        } else {
          const [min, max] = impl.arity;
          if (node.args.length < min || node.args.length > max) {
            errors.push(`函数 '${node.name}' 参数个数应为 ${min === max ? min : `${min}~${max}`}，实际 ${node.args.length}`);
          }
        }
        node.args.forEach(walk);
        return;
      }
    }
  };
  walk(ast);
  return errors;
}
