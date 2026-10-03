/**
 * 时长解析（`30m` / `1h` / `2d` / `500ms`）—— **零依赖**模块。
 *
 * ★ 为什么单独一个文件：它同时被
 *   · `plugin/host-api.ts`（插件事实 TTL、`manifest.factTtl`）与
 *   · `policy/expr.ts`（`$maxSkew` 时间偏斜阈值）
 *   使用，而后者是**零依赖**的求值器——若直接从 host-api 取，
 *   会把「表达式引擎」与「插件宿主」耦合起来（并且有循环依赖的风险）。
 *
 * ★ 非法输入返回 `fallbackMs`（调用方据此判断「解析失败」）：
 *   例如 `$maxSkew` 传 `-1` 作 fallback，就能把"无法解析"识别为配置错误。
 */
export function parseDuration(input: string | number | undefined, fallbackMs: number): number {
  if (input === undefined) return fallbackMs;
  if (typeof input === 'number') return input;
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(input.trim());
  if (match === null) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const multiplier =
    unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * multiplier;
}
