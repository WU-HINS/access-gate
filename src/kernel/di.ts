/**
 * 轻量依赖注入容器（M0-8）。
 *
 * 取舍：**不引入 inversify/tsyringe**。本项目的依赖关系是「少量单例 + 明确的生命周期」，
 * 用一个类型化注册表即可；引入注解式 DI 会带来装饰器与反射依赖，与「插件运行期装配」（D1）
 * 的简单性目标冲突。
 *
 * 关键能力：
 *   - **按 token 注册与解析**，类型由泛型参数约束（`resolve<Db>()`）；
 *   - **生命周期**：singleton（默认，惰性初始化 + 缓存）/ transient（每次新建）；
 *   - **close() 逆序释放**：满足「先起后停」的资源释放顺序（调度器→事件总线→DB 池）。
 */

export type Token<T> = symbol & { readonly __type?: T };

export function createToken<T>(name: string): Token<T> {
  return Symbol.for(`access-gate.di.${name}`) as Token<T>;
}

export class DiError extends Error {
  override readonly name = 'DiError';
}

interface SingletonEntry {
  kind: 'singleton';
  value?: unknown;
  factory: (container: Container) => unknown;
  instantiated: boolean;
}

interface TransientEntry {
  kind: 'transient';
  factory: (container: Container) => unknown;
}

type Entry = SingletonEntry | TransientEntry;

export type Disposable = { close(): Promise<void> | void };

export class Container {
  private readonly entries = new Map<Token<unknown>, Entry>();
  private readonly disposables: Disposable[] = [];
  private closing = false;

  /** 注册单例（惰性：第一次 resolve 时才调用 factory） */
  singleton<T>(token: Token<T>, factory: (container: Container) => T): this {
    this.entries.set(token as Token<unknown>, { kind: 'singleton', factory, instantiated: false });
    return this;
  }

  /** 注册即时值（已构造好的实例） */
  value<T>(token: Token<T>, instance: T): this {
    this.entries.set(token as Token<unknown>, {
      kind: 'singleton',
      factory: () => instance,
      instantiated: true,
      value: instance,
    });
    return this;
  }

  transient<T>(token: Token<T>, factory: (container: Container) => T): this {
    this.entries.set(token as Token<unknown>, { kind: 'transient', factory });
    return this;
  }

  has<T>(token: Token<T>): boolean {
    return this.entries.has(token as Token<unknown>);
  }

  resolve<T>(token: Token<T>): T {
    if (this.closing) throw new DiError(`容器正在关闭，拒绝解析 ${String(token)}`);
    const entry = this.entries.get(token as Token<unknown>);
    if (entry === undefined) {
      throw new DiError(
        `未注册的依赖 ${String(token)}。请检查装配顺序（内核装配见 createKernel），` +
          `或确认该模块是否属于本里程碑。`,
      );
    }
    if (entry.kind === 'transient') return entry.factory(this) as T;
    if (!entry.instantiated) {
      entry.value = entry.factory(this);
      entry.instantiated = true;
    }
    return entry.value as T;
  }

  /** 注册需要在关闭时释放的资源（按注册的逆序释放）。 */
  registerDisposable(disposable: Disposable): void {
    this.disposables.push(disposable);
  }

  /** 逆序释放：后注册的先关闭（先起后停）。 */
  async close(): Promise<void> {
    this.closing = true;
    const errors: unknown[] = [];
    for (const disposable of [...this.disposables].reverse()) {
      try {
        await disposable.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.disposables.length = 0;
    this.entries.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, `容器关闭时有 ${errors.length} 个资源释放失败`);
    }
  }
}
