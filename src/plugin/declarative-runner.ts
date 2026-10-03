/**
 * declarative 插件执行器（M1-4）：按 manifest.collect 完成「请求 → 提取 → 派生 → 落事实」。
 *
 * ★ 密钥不出宿主：模板里只出现 `{{ secrets.x }}` 占位符，明文只在**请求头构造的那一瞬**
 *   由宿主填入，插件代码（含 declarative 解释器本身）都拿不到它。
 */

import type { Logger } from '../kernel/logger.ts';
import type { HostApi, HttpResponse } from './host-api.ts';
import type { CollectSpec, PluginManifest } from './manifest.ts';
import { applyTransform, evaluateJsonPath, renderDeep } from './declarative.ts';
import { evalExpression, parseExpression, validateExpression } from './expr-lite.ts';

export class DeclarativeError extends Error {
  override readonly name = 'DeclarativeError';
}

export interface CollectContext {
  /** 绑定信息（`binding.externalName` 等） */
  binding?: Record<string, unknown>;
  /** 插件配置（已合并默认值） */
  config?: Record<string, unknown>;
  /** 时间基准（测试可注入；同时供 now() 使用） */
  now?: Date;
}

export interface CollectResult {
  /** 裸字段名 → 值（**未加命名空间**；写入由 FactPipeline 负责加前缀） */
  facts: Record<string, unknown>;
  /** 本次出站请求的响应状态（便于把 401/403 与 5xx 区分归因） */
  status: number;
  /** 逐条提取的命中情况（排障用：哪个路径没取到值） */
  extracted: { path: string; as: string; matched: number }[];
}

/** 静态校验 collect 规格（安装时执行；函数白名单、JSONPath 语法都在这里拦住）。 */
export function validateCollectSpec(spec: CollectSpec): string[] {
  const errors: string[] = [];
  for (const rule of spec.extract) {
    try {
      evaluateJsonPath({}, rule.path);
    } catch (error) {
      errors.push(`extract.path '${rule.path}'：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const rule of spec.derive ?? []) {
    for (const message of validateExpression(rule.expr)) {
      errors.push(`derive '${rule.as}'：${message}`);
    }
  }
  return errors;
}

/** 执行一次 declarative 采集。 */
export async function runCollect(
  manifest: PluginManifest,
  host: HostApi,
  context: CollectContext = {},
  logger?: Logger,
): Promise<CollectResult> {
  const spec = manifest.collect;
  if (spec === undefined) throw new DeclarativeError(`插件 '${manifest.id}' 是 declarative 但未声明 collect`);
  if (manifest.runtime !== 'declarative') {
    throw new DeclarativeError(`插件 '${manifest.id}' 的 runtime 是 '${manifest.runtime}'，不能用 declarative 执行器`);
  }

  const now = context.now ?? new Date();
  // ★ 只有 manifest 声明过的密钥才可能被模板引用；未声明的会在 renderTemplate 时因
  //   scope.secrets 里没有该键而**抛错**（strict），不会静默渲染成空串。
  const declaredSecretNames = (manifest.permissions ?? [])
    .filter((p) => p.startsWith('secrets:read:'))
    .map((p) => p.slice('secrets:read:'.length));
  const secrets: Record<string, string | undefined> = {};
  for (const name of declaredSecretNames) {
    secrets[name] = await host.getSecret(name);
  }

  const scope = {
    secrets,
    binding: context.binding ?? {},
    config: context.config ?? {},
    context: { now: now.toISOString() },
  };

  const url = renderDeep(spec.request.url, scope) as string;
  const headers = (spec.request.headers === undefined ? {} : renderDeep(spec.request.headers, scope)) as Record<string, string>;
  const body = spec.request.body === undefined ? undefined : renderDeep(spec.request.body, scope);

  const response: HttpResponse = await host.request({
    method: spec.request.method,
    url,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(spec.request.timeoutMs === undefined ? {} : { timeoutMs: spec.request.timeoutMs }),
  });

  // 4xx/5xx 不在这里抛错：由调用方按「渠道故障 vs 主体问题」归因（D20）
  if (response.status >= 400) {
    logger?.warn('declarative 采集收到非 2xx', { pluginId: manifest.id, status: response.status, host: new URL(url).hostname });
  }

  const facts: Record<string, unknown> = {};
  const extracted: CollectResult['extracted'] = [];
  for (const rule of spec.extract) {
    const matches = evaluateJsonPath(response.data, rule.path);
    extracted.push({ path: rule.path, as: rule.as, matched: matches.length });
    const value = applyTransform(matches, rule.transform);
    if (value !== undefined) facts[rule.as] = value;
    else logger?.debug('declarative 提取未命中', { pluginId: manifest.id, path: rule.path, as: rule.as });
  }

  for (const rule of spec.derive ?? []) {
    // 派生表达式只允许引用已提取的事实 + now()——避免它去读宿主内部状态
    const evalContext: Record<string, unknown> = { ...facts, __now: now };
    const value = evalExpression(rule.expr, evalContext, { strictRefs: false });
    if (value !== undefined) facts[rule.as] = value;
  }

  return { facts, status: response.status, extracted };
}

/** 只做静态校验（安装/启用时调用，不发起任何网络请求）。 */
export function validateDeclarativePlugin(manifest: PluginManifest): string[] {
  if (manifest.runtime !== 'declarative') return [];
  if (manifest.collect === undefined) return ['runtime=declarative 但未声明 collect'];
  const errors = validateCollectSpec(manifest.collect);
  // 额外检查：模板里引用的 secrets 必须在 permissions 中声明
  const templateText = JSON.stringify(manifest.collect);
  for (const match of templateText.matchAll(/\{\{\s*secrets\.([A-Za-z0-9_.-]+)\s*\}\}/g)) {
    const name = match[1]!;
    const declared = (manifest.permissions ?? []).includes(`secrets:read:${name}`);
    if (!declared) errors.push(`模板引用了 secrets.${name}，但 permissions 未声明 'secrets:read:${name}'`);
  }
  // derive 表达式必须能解析
  for (const rule of manifest.collect.derive ?? []) {
    try {
      parseExpression(rule.expr);
    } catch (error) {
      errors.push(`derive '${rule.as}' 表达式无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}
