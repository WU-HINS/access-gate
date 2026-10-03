/**
 * 插件包的**本地运行时缓存**（D9：本地仅作**可丢弃**缓存，权威在数据库）。
 *
 * ★★ 为什么必须有它（D9 的原话）：
 * > **采纳**：内置随主程序构建产物（不进 DB）；**外置落数据库**（`ag_plugin_packages.blob`）；
 * > 本地仅作**可丢弃的运行时缓存**，**启动按 digest 拉回**。
 *
 * 而在此之前只实现了前半句（包体落库）——**没有任何代码把包体拉回本地**，
 * 于是"**容器重建后插件仍可用**"这件事并没有被实现。
 *
 * ★★ 三条纪律（顺序即安全性）：
 *   ① **本地缓存不可信**：即使命中也要**重算 digest** 比对
 *      （本地文件可能被篡改、损坏，或上次写入到一半）；
 *   ② digest 不匹配 → **丢弃并拉回**（缓存本来就是可丢弃的，不该因此让服务起不来）；
 *   ③ **权威存储的包体 digest 不符 → 抛错**——那是"投毒"或"存储损坏"，
 *      绝不能静默写进本地缓存（否则错误会被固化下来）。
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { digestOf } from '../kernel/digest.ts';
import type { PluginPackageStore } from '../db/plugin-package-adapter.ts';

export interface EnsurePackageResult {
  /** 本地文件路径 */
  path: string;
  /** `true` = 直接命中本地缓存；`false` = 刚从权威存储拉回 */
  fromCache: boolean;
}

export interface PluginPackageCache {
  /**
   * 确保本地有该版本的包体（本地命中即用；否则按 digest 从权威存储拉回并校验）。
   */
  ensure(input: { pluginId: string; version: string; digest: string }): Promise<EnsurePackageResult>;
  /** 本地缓存里的文件（相对路径，排障用） */
  listLocal(): Promise<readonly string[]>;
}

export interface PackageCacheOptions {
  /** 缓存根目录（如 `plugins/runtime`）——**可丢弃**，删掉只会导致下次拉回 */
  dir: string;
  /** 权威存储（数据库） */
  store: PluginPackageStore;
}

export class FileSystemPackageCache implements PluginPackageCache {
  readonly #dir: string;
  readonly #store: PluginPackageStore;

  constructor(options: PackageCacheOptions) {
    this.#dir = options.dir;
    this.#store = options.store;
  }

  #fileOf(pluginId: string, version: string): string {
    return path.join(this.#dir, pluginId, `${version}.gatespkg`);
  }

  async ensure(input: {
    pluginId: string;
    version: string;
    digest: string;
  }): Promise<EnsurePackageResult> {
    const file = this.#fileOf(input.pluginId, input.version);

    // ① 本地已有 → **仍然重算 digest**（本地缓存不可信）
    if (existsSync(file)) {
      const bytes = await readFile(file);
      if (digestOf(bytes) === input.digest) {
        return { path: file, fromCache: true };
      }
      // ② 不匹配 → 丢弃（缓存可丢弃，不该因此让服务起不来），继续走拉回
      await rm(file, { force: true });
    }

    // ③ 从权威存储拉回
    const record = await this.#store.get({ pluginId: input.pluginId, version: input.version });
    if (record?.blob === undefined) {
      throw new Error(
        `包体不在权威存储中：${input.pluginId}@${input.version}——无法拉回本地缓存` +
          '（外置插件的权威副本应在数据库里，见 docs/03 §1.19.4）',
      );
    }
    const actual = digestOf(record.blob);
    if (actual !== input.digest) {
      // ★ 绝不静默使用：这是"投毒"或"存储损坏"，写进本地会把错误固化下来
      throw new Error(
        `权威存储的包体 digest 与期望不符（期望 ${input.digest}，实际 ${actual}）——拒绝写入本地缓存`,
      );
    }

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record.blob);
    return { path: file, fromCache: false };
  }

  async listLocal(): Promise<readonly string[]> {
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // 目录不存在 = 缓存为空（不是错误）
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(full);
        else out.push(path.relative(this.#dir, full));
      }
    };
    await visit(this.#dir);
    return out.sort();
  }
}
