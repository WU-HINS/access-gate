/**
 * 插件存储分级（M4-4）—— docs/03 §1.9、§1.18。
 *
 * | 来源 | 权威副本在哪 | 说明 |
 * |---|---|---|
 * | `builtin` | **构建产物**（随主程序发布） | 无 DB 时仍可用 |
 * | `db` | **数据库**（`ag_plugin_packages`） | 外置插件包体的权威存储 |
 * | `runtime` | **只是缓存**（`plugins/runtime/`） | 解包后的工作副本，**可随时清空** |
 *
 * ★ 验收标准（docs/07 M4-4 原文）：
 *   **「清空 `runtime/` 后重启能自动恢复」** + **「内置插件在无 DB 时仍可用」**。
 *
 *   这两条决定了本模块的核心不变量：**`runtime/` 绝不能是唯一副本**。
 *   一旦把「解包后的文件」当成权威，就会出现「删掉缓存即永久丢失插件」——
 *   而缓存被清空是**运维常规操作**（换机器、清盘、容器重建）。
 *
 * ★ 因此解析顺序是「**权威优先，缓存兜底**」：
 *   先看 DB（外置）或构建产物（内置），再看 runtime 缓存是否命中且一致。
 *   缓存不一致（指纹变了）时必须**重新解包**，而不是继续用旧文件。
 */

import { createHash } from 'node:crypto';

import type { Logger } from '../kernel/logger.ts';

// ─────────────────────────── 类型 ───────────────────────────

export type PluginSourceKind = 'builtin' | 'db' | 'runtime';

/** 插件包体的一个候选副本。 */
export interface PluginPackageCopy {
  kind: PluginSourceKind;
  /** 包体内容（内存表示；真实实现里是文件路径或 DB 的 bytea） */
  content: string;
  /** 内容指纹（sha256）——用于判断缓存是否过期 */
  fingerprint: string;
}

export interface PluginPackageRecord {
  pluginId: string;
  version: string;
  /** 内置副本（随构建产物发布）；**无 DB 时这是唯一可用来源** */
  builtin?: PluginPackageCopy;
  /** DB 副本（外置插件的权威存储） */
  db?: PluginPackageCopy;
  /** runtime 缓存副本（**可能不存在**：清空缓存后就是这种状态） */
  runtime?: PluginPackageCopy;
}

export interface LoadPlan {
  pluginId: string;
  /** 实际采用的来源 */
  source: PluginSourceKind;
  fingerprint: string;
  /** 是否需要重新解包到 runtime 缓存 */
  needsMaterialize: boolean;
  /** 是否需要清理过期的 runtime 缓存 */
  needsInvalidate: boolean;
  reason: string;
}

export class PluginPackageError extends Error {
  override readonly name = 'PluginPackageError';
  readonly pluginId: string;
  constructor(pluginId: string, message: string) {
    super(message);
    this.pluginId = pluginId;
  }
}

/** 计算包体指纹（**只此一处**，保证「存」与「比」用同一算法）。 */
export function fingerprintOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}

// ─────────────────────────── 解析 ───────────────────────────

/**
 * 解析某插件应从哪个来源加载。
 *
 * 判定顺序刻意的（**权威优先**）：
 *   ① `db` 存在 → 用 DB（外置插件的权威副本），并按指纹决定是否刷新 runtime 缓存；
 *   ② 否则 `builtin` 存在 → 用构建产物（**无 DB 也能工作**）；
 *   ③ 否则若只有 `runtime` → 用缓存但**标记为「权威缺失」**（不静默接受）；
 *   ④ 全都没有 → 报错（含可操作的提示）。
 */
export function planPluginLoad(record: PluginPackageRecord, logger?: Logger): LoadPlan {
  const runtimeFingerprint = record.runtime?.fingerprint;
  const matchesCache = (authoritative: PluginPackageCopy | undefined): boolean =>
    authoritative !== undefined && runtimeFingerprint !== undefined && runtimeFingerprint === authoritative.fingerprint;

  // ① DB 优先（外置插件）
  if (record.db !== undefined) {
    const cached = matchesCache(record.db);
    return {
      pluginId: record.pluginId,
      source: 'db',
      fingerprint: record.db.fingerprint,
      needsMaterialize: !cached,
      needsInvalidate: runtimeFingerprint !== undefined && !cached,
      reason: cached
        ? 'DB 权威副本与 runtime 缓存指纹一致，直接使用缓存'
        : 'DB 权威副本与缓存不一致（或缓存缺失），需重新解包到 runtime/',
    };
  }

  // ② 内置（无 DB 时仍可用）
  if (record.builtin !== undefined) {
    const cached = matchesCache(record.builtin);
    return {
      pluginId: record.pluginId,
      source: 'builtin',
      fingerprint: record.builtin.fingerprint,
      needsMaterialize: !cached,
      needsInvalidate: runtimeFingerprint !== undefined && !cached,
      reason: cached
        ? '内置副本与 runtime 缓存指纹一致（无 DB 也可用）'
        : '使用内置副本（无 DB 也可用），并刷新 runtime 缓存',
    };
  }

  // ③ 只剩缓存：不静默接受
  if (record.runtime !== undefined) {
    logger?.warn('插件只有 runtime 缓存、权威副本缺失', { pluginId: record.pluginId });
    return {
      pluginId: record.pluginId,
      source: 'runtime',
      fingerprint: record.runtime.fingerprint,
      needsMaterialize: false,
      needsInvalidate: false,
      reason:
        '★ 只有 runtime 缓存，权威副本（DB / 构建产物）缺失——' +
        '缓存**可能已被篡改或过期**，请尽快恢复权威来源',
    };
  }

  throw new PluginPackageError(
    record.pluginId,
    `插件 '${record.pluginId}' 在任何来源都找不到包体（builtin / db / runtime 均为空）——` +
      `请检查它是否已安装，或重新上传插件包`,
  );
}

// ─────────────────────────── runtime 缓存恢复 ───────────────────────────

/** 文件系统抽象（便于测试，也避免本模块直接依赖真实 IO）。 */
export interface RuntimeCache {
  read(pluginId: string): Promise<string | undefined>;
  write(pluginId: string, content: string): Promise<void>;
  remove(pluginId: string): Promise<void>;
  list(): Promise<string[]>;
}

export class InMemoryRuntimeCache implements RuntimeCache {
  private readonly files = new Map<string, string>();
  async read(pluginId: string): Promise<string | undefined> {
    return this.files.get(pluginId);
  }
  async write(pluginId: string, content: string): Promise<void> {
    this.files.set(pluginId, content);
  }
  async remove(pluginId: string): Promise<void> {
    this.files.delete(pluginId);
  }
  async list(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
}

export interface RestoreResult {
  restored: string[];
  invalidated: string[];
  unchanged: string[];
  /** 只有缓存、权威缺失的插件（需人工介入） */
  orphans: string[];
}

/**
 * **重建 runtime 缓存**（M4-4 的核心能力）。
 *
 * ★ 这正是「清空 `runtime/` 后重启能自动恢复」的实现：
 *   从权威来源（DB / 构建产物）重新解包，并清理不再需要的缓存。
 *
 * ★ 同时清理**孤儿缓存**：runtime 里有、但权威来源里已不存在的插件——
 *   它们可能是被卸载插件的残留。若不清，这些文件会一直被执行（**卸载不生效**）。
 *   （本函数只报告孤儿而不自动删除：删文件是不可逆操作，应由运维确认。）
 */
export async function restoreRuntimeCache(
  records: readonly PluginPackageRecord[],
  cache: RuntimeCache,
  logger?: Logger,
): Promise<RestoreResult> {
  const restored: string[] = [];
  const invalidated: string[] = [];
  const unchanged: string[] = [];

  for (const record of records) {
    // ★ 缓存内容必须**由本函数自己读**，而不是要求调用方塞进 `record.runtime`：
    //   缓存是**外部状态**（文件系统），把它当成入参会让「缓存里有什么」
    //   取决于调用方是否记得去读——而漏读的表现是「每次都重新解包」
    //   （功能正常、性能白费），很难发现。
    const cached = await cache.read(record.pluginId);
    const withCache: PluginPackageRecord =
      cached === undefined
        ? record
        : { ...record, runtime: { kind: 'runtime', content: cached, fingerprint: fingerprintOf(cached) } };
    const plan = planPluginLoad(withCache, logger);
    if (plan.needsInvalidate) {
      await cache.remove(record.pluginId);
      invalidated.push(record.pluginId);
    }
    if (plan.needsMaterialize) {
      const authoritative = record.db ?? record.builtin;
      if (authoritative === undefined) continue; // 只有缓存的情况上面已处理
      await cache.write(record.pluginId, authoritative.content);
      restored.push(record.pluginId);
      logger?.info('插件已解包到 runtime 缓存', { pluginId: record.pluginId, source: plan.source });
    } else {
      unchanged.push(record.pluginId);
    }
  }

  // 孤儿检测：runtime 里有、但不在权威清单里
  const known = new Set(records.filter((record) => record.db !== undefined || record.builtin !== undefined).map((record) => record.pluginId));
  const orphans = (await cache.list()).filter((pluginId) => !known.has(pluginId));
  if (orphans.length > 0) {
    logger?.warn('runtime 缓存中存在无权威来源的插件（可能是卸载残留）', { orphans });
  }

  return { restored, invalidated, unchanged, orphans };
}

/**
 * 无 DB 时的可用性检查（M4-4 第二条验收标准）。
 *
 * ★ 「内置插件在无 DB 时仍可用」不是自然成立的——
 *   若实现里「先查 DB 拿插件清单」，无 DB 时就会**一个插件都加载不出来**，
 *   包括随主程序发布的内置插件。因此可用性判定必须**只看构建产物**。
 */
export function availableWithoutDatabase(records: readonly PluginPackageRecord[]): string[] {
  return records
    .filter((record) => record.builtin !== undefined)
    .map((record) => record.pluginId)
    .sort();
}
