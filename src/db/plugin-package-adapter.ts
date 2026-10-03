/**
 * 外置插件**包体**的权威存储（`ag_plugin_packages`）—— 补齐 `docs/03 §1.19.4` / D9 的决策。
 *
 * ★★ D9 的原话：
 * > **否决**：把文件系统作为插件包的**持久层**。
 * > **理由**：**文件系统不保证持久化**——容器重建、Pod 漂移、多实例无共享卷都会丢。
 * > **采纳**：内置随主程序构建产物（不进 DB）；**外置落数据库**（`ag_plugin_packages.blob`）；
 * > 本地仅作**可丢弃的运行时缓存**，启动按 digest 拉回。
 *
 * ★ 而在此之前该表**零读写**（`tools/table-coverage.ts` 可复现）：
 *   「外置插件」这条路只有本地文件，等于把 D9 明确否决的方案当了实现。
 *
 * ★ 两条来自 `docs/02 §4` 的硬约束，本文件直接落实：
 *   ① **查元数据不要 `SELECT *`**——`blob` 可能很大（含 `node_modules` 的 process 插件可达数十 MB），
 *      所以 `list()` **不返回包体**（列名显式列出）；
 *   ② **digest 是完整性的唯一依据**：安装、启动、执行前都要校验，
 *      因此 `put()` 自己算 digest（不接受调用方声称的值），`verify()` 重新计算比对。
 */

import { digestOf } from '../kernel/digest.ts';

// ★ 实现已移到**零依赖**模块 `src/kernel/digest.ts`（`src/plugin/package-cache.ts` 也要用它，
//   而插件层不该依赖数据访问层）。这里 re-export，既有 import 不受影响。
export { digestOf };

import type { Db } from './pool.ts';
import { reuseOrBeginTransaction } from './tx.ts';

export interface PluginPackageMeta {
  pluginId: string;
  version: string;
  /** 内容摘要（SHA-256，`sha256:<hex>`） */
  digest: string;
  sizeBytes: number;
  storageKind: 'db' | 'objectstore';
  /** `storageKind === 'objectstore'` 时的对象 key */
  objectKey?: string;
  /** 可选：发布者签名 */
  signature?: string;
  createdAt: Date;
}

export interface PluginPackageRecord extends PluginPackageMeta {
  /** `storageKind === 'db'` 时的包体；**元数据查询不返回它** */
  blob?: Buffer;
}

export interface PluginPackageStore {
  /**
   * 存包（**幂等**：同 `(pluginId, version)` 覆盖）。
   * ★ `digest` 由本方法**自己计算**——不接受调用方声称的值（否则完整性校验形同虚设）。
   */
  put(input: {
    pluginId: string;
    version: string;
    bytes: Buffer;
    signature?: string;
  }): Promise<PluginPackageMeta>;
  /** 取包体（本地运行时缓存缺失时按 digest 拉回） */
  get(input: { pluginId: string; version: string }): Promise<PluginPackageRecord | undefined>;
  /** 列元数据（**不含包体**——见文件头约束 ①） */
  list(): Promise<readonly PluginPackageMeta[]>;
  /** 重新计算并比对 digest（安装 / 启动 / 执行前的校验点） */
  verify(input: { pluginId: string; version: string; digest: string }): Promise<boolean>;
  /** 删除某插件的旧版本，只保留最新 `keep` 个（`keepVersions` 默认 3） */
  prune(input: { pluginId: string; keep: number }): Promise<readonly string[]>;
}

// `digestOf` 的实现见 `src/kernel/digest.ts`（文件头已 re-export）。

interface PackageRow extends Record<string, unknown> {
  plugin_id: string;
  version: string;
  digest: string;
  size_bytes: string | number;
  storage_kind: 'db' | 'objectstore';
  object_key: string | null;
  signature: string | null;
  created_at: Date | string;
}

function rowToMeta(row: PackageRow): PluginPackageMeta {
  return {
    pluginId: row.plugin_id,
    version: row.version,
    digest: row.digest,
    sizeBytes: Number(row.size_bytes),
    storageKind: row.storage_kind,
    ...(row.object_key === null ? {} : { objectKey: row.object_key }),
    ...(row.signature === null ? {} : { signature: row.signature }),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

export class DbPluginPackageStore implements PluginPackageStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(input: {
    pluginId: string;
    version: string;
    bytes: Buffer;
    signature?: string;
  }): Promise<PluginPackageMeta> {
    const digest = digestOf(input.bytes);
    const createdAt = new Date();
    await reuseOrBeginTransaction(this.#db, async () => {
      await this.#db.query(
        `INSERT INTO ag_plugin_packages
           (plugin_id, version, digest, size_bytes, storage_kind, blob, signature, created_at)
         VALUES ($1, $2, $3, $4, 'db', $5, $6, $7)
         ON CONFLICT (plugin_id, version) DO UPDATE
           SET digest = EXCLUDED.digest,
               size_bytes = EXCLUDED.size_bytes,
               blob = EXCLUDED.blob,
               signature = EXCLUDED.signature,
               created_at = EXCLUDED.created_at`,
        [
          input.pluginId,
          input.version,
          digest,
          input.bytes.byteLength,
          input.bytes,
          input.signature ?? null,
          createdAt,
        ],
      );
    });
    return {
      pluginId: input.pluginId,
      version: input.version,
      digest,
      sizeBytes: input.bytes.byteLength,
      storageKind: 'db',
      ...(input.signature === undefined ? {} : { signature: input.signature }),
      createdAt,
    };
  }

  async get(input: { pluginId: string; version: string }): Promise<PluginPackageRecord | undefined> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<PackageRow & { blob: Buffer | null }>(
        `SELECT plugin_id, version, digest, size_bytes, storage_kind, object_key, signature, created_at, blob
           FROM ag_plugin_packages
          WHERE plugin_id = $1 AND version = $2
          LIMIT 1`,
        [input.pluginId, input.version],
      ),
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { ...rowToMeta(row), ...(row.blob === null ? {} : { blob: row.blob }) };
  }

  /**
   * ★ 元数据列表：**刻意不选 `blob`**（`docs/02 §4` 的警告——
   *   一个含 `node_modules` 的 process 插件包可达数十 MB，
   *   `SELECT *` 会把它们全拉进内存）。
   */
  async list(): Promise<readonly PluginPackageMeta[]> {
    const rows = await reuseOrBeginTransaction(this.#db, async () =>
      this.#db.query<PackageRow>(
        `SELECT plugin_id, version, digest, size_bytes, storage_kind, object_key, signature, created_at
           FROM ag_plugin_packages
          ORDER BY plugin_id, created_at`,
        [],
      ),
    );
    return rows.map(rowToMeta);
  }

  async verify(input: { pluginId: string; version: string; digest: string }): Promise<boolean> {
    const record = await this.get({ pluginId: input.pluginId, version: input.version });
    if (record?.blob === undefined) return false;
    // ★ 重新计算，而不是信任库里的 `digest` 列——后者只证明"存的时候是什么"
    return digestOf(record.blob) === input.digest;
  }

  /**
   * 保留最新 `keep` 个版本（按 `created_at` 倒序），删除其余。
   *
   * ★ 与策略版本清理（`planVersionPurge`）的区别：插件包**没有"被状态引用"的问题**——
   *   运行时用的是已解包到本地缓存的副本，删掉包体不影响正在运行的实例；
   *   而**被引用的策略版本**必须保护（那是可复现性的前提）。两者规则不同，不要互相套用。
   */
  async prune(input: { pluginId: string; keep: number }): Promise<readonly string[]> {
    return reuseOrBeginTransaction(this.#db, async () => {
      const rows = await this.#db.query<{ version: string }>(
        `SELECT version FROM ag_plugin_packages
          WHERE plugin_id = $1
          ORDER BY created_at DESC`,
        [input.pluginId],
      );
      const toDelete = rows.slice(Math.max(0, input.keep)).map((row) => row.version);
      if (toDelete.length === 0) return [];
      await this.#db.query(
        `DELETE FROM ag_plugin_packages WHERE plugin_id = $1 AND version = ANY($2::text[])`,
        [input.pluginId, toDelete],
      );
      return toDelete;
    });
  }
}
