/**
 * `newapi-set-group` / `newapi-add-quota` / `newapi-set-status` 动作插件（M2-2 / M2-3）
 * —— docs/05 §3.2、docs/03 §1.9。
 *
 * ★ 这三个动作都是「把信任等级投射到下游」，但写回方式不同：
 *
 * | 动作 | 下游调用 | 幂等策略 |
 * |---|---|---|
 * | `set_group` | `PUT /api/user/`（**read-modify-write**） | 目标值 + 当前值比对 |
 * | `add_quota` | `POST /api/user/manage {action:'add_quota'}` | **按 §3.0.1 冻结公式**（`actionSeq`，不含日期桶） |
 * | `set_status` | `POST /api/user/manage {action:'disable'|'enable'}` | 状态比对 |
 *
 * ★ `set_group` 的三条硬约束（都来自文档里的真实事故推演）：
 *
 * 1. **read-modify-write 必须回填全部既有属性**——`PUT /api/user/` 是**整体替换**语义，
 *    只传 `{group}` 会把用户名、备注等**清空**。
 * 2. **★ 绝不能带 `password`**——回填时若把下游返回的 password 字段原样写回，
 *    轻则覆盖用户密码，重则把哈希写成了明文。这条是文档明确警告的，这里用
 *    **字段黑名单**在出口处强制剔除（而不是依赖调用方自觉）。
 * 3. **用户级互斥**——并发 read-modify-write 会互相覆盖（A 读到旧值、B 读到旧值，
 *    各自写回，后写的赢）。必须按用户加锁。
 */

import type { ActionContext, ActionResult, ActionHandler } from '../../core/action-executor.ts';
import type { PluginManifest } from '../manifest.ts';

// ─────────────────────────── 下游读写接口 ───────────────────────────

/**
 * 下游系统的读写接口。
 *
 * ★ 刻意只声明这两个方法（而不是依赖完整的 `ProviderPlugin`）：
 *   动作插件只需要「读一个主体」「整体写回一个主体」，
 *   依赖面越小，越容易在不同 provider 之间复用。
 */
export interface DownstreamApi {
  /** 读完整主体（返回的 `attributes` 是**下游看到的全部字段**） */
  get(externalId: string): Promise<{ attributes: Record<string, unknown> } | null>;
  /** 整体写回（`PUT` 语义：传入什么就是什么） */
  put(externalId: string, attributes: Record<string, unknown>): Promise<void>;
  /** 管理类动作（`add_quota` / `disable` / `enable`） */
  manage?(externalId: string, action: string, value?: unknown): Promise<void>;
}

/** 用户级互斥（避免并发 read-modify-write 互相覆盖） */
export interface UserLock {
  withLock<T>(userId: string, fn: () => Promise<T>): Promise<T>;
}

/** 一个**不做互斥**的默认锁（单进程、串行场景）。 */
export const NO_LOCK: UserLock = {
  withLock: <T>(_userId: string, fn: () => Promise<T>): Promise<T> => fn(),
};

// ─────────────────────────── ★ 敏感字段黑名单 ───────────────────────────

/**
 * **绝不回填**的字段（下游返回时也必须剔除）。
 *
 * ★ 为什么用黑名单而不是白名单：
 *   下游系统的字段会随版本增加，白名单会**静默丢掉新字段**（表现为「用户资料莫名丢失」）；
 *   黑名单则在「下游新增普通字段」时行为正确，只有「新增敏感字段」时需要维护。
 *   两害相权，黑名单的失效模式更温和——而敏感字段数量天然有限且变化慢。
 *
 * ★ 为什么必须在**出口强制剔除**而不是「调用方注意」：
 *   这是「一次疏忽就泄露/破坏用户凭据」的场景，不能依赖约定。
 */
export const NEVER_WRITE_BACK_FIELDS: readonly string[] = [
  'password',
  'password_hash',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'secret',
  'api_key',
  'apiKey',
  'private_key',
  'privateKey',
  'totp_secret',
  'mfa_secret',
];

/** 剔除敏感字段（不修改入参）。 */
export function stripSensitiveFields(attributes: Record<string, unknown>): {
  safe: Record<string, unknown>;
  stripped: string[];
} {
  const safe: Record<string, unknown> = {};
  const stripped: string[] = [];
  const blocked = new Set(NEVER_WRITE_BACK_FIELDS.map((field) => field.toLowerCase()));
  for (const [key, value] of Object.entries(attributes)) {
    if (blocked.has(key.toLowerCase())) {
      stripped.push(key);
      continue;
    }
    safe[key] = value;
  }
  return { safe, stripped };
}

// ─────────────────────────── 插件 manifest ───────────────────────────

export const NEWAPI_SET_GROUP_MANIFEST: PluginManifest = {
  apiVersion: 'gate.plugin/v1',
  kind: 'action',
  id: 'newapi-set-group',
  name: 'newapi 分组设置',
  version: '1.0.0',
  runtime: 'declarative',
  // 动作插件需要出站权限；具体域名由部署配置，这里声明能力
  permissions: ['http:egress:*', 'subject:write:newapi-provider'],
  // 本地插件标记：不需要外部网络即可加载（宿主启动不依赖它在线）
  local: true,
  actions: [
    {
      name: 'set_group',
      description: '把主体的分组设为指定值（read-modify-write，回填全部既有属性）',
      paramsSchema: {
        type: 'object',
        properties: { group: { type: 'string' } },
        required: ['group'],
      },
    },
  ],
} as unknown as PluginManifest;

export const NEWAPI_MANAGE_MANIFEST: PluginManifest = {
  apiVersion: 'gate.plugin/v1',
  kind: 'action',
  id: 'newapi-add-quota',
  name: 'newapi 额度与状态管理',
  version: '1.0.0',
  runtime: 'declarative',
  permissions: ['http:egress:*', 'subject:manage:newapi-provider'],
  local: true,
  actions: [
    {
      name: 'add_quota',
      description: '增加/扣减额度（幂等由宿主的 actionSeq 保障，**不含日期桶**）',
      paramsSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
    },
    {
      name: 'set_status',
      description: '启用或禁用主体（值不变则跳过）',
      paramsSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
      },
    },
  ],
} as unknown as PluginManifest;

// ─────────────────────────── set_group ───────────────────────────

export interface SetGroupOptions {
  api: DownstreamApi;
  /** 当前状态的分组（用于「值不变跳过」）；缺省读下游 */
  currentGroup?: (userId: string) => string | undefined;
  /** 记录变更时间（最小间隔防抖用） */
  lastChangeAt?: (userId: string) => Date | undefined;
  minChangeIntervalMs?: number;
  lock?: UserLock;
  /** 主体 id 解析（默认用 context.userId） */
  externalIdOf?: (context: ActionContext) => string;
  onChanged?: (userId: string, at: Date) => void;
  now?: () => Date;
}

/**
 * `set_group` 动作。
 *
 * 幂等三重保障：值不变跳过 → 最小间隔 → 用户级互斥。
 * 安全的最后一环：**出口剔除敏感字段**。
 */
export function createSetGroupAction(options: SetGroupOptions): ActionHandler {
  const now = options.now ?? (() => new Date());
  const lock = options.lock ?? NO_LOCK;
  const externalIdOf = options.externalIdOf ?? ((context) => context.userId);

  return {
    async execute(context: ActionContext): Promise<ActionResult> {
      const target = String(context.params['group'] ?? '');
      if (target.length === 0) {
        // 配置错误重试无意义
        return { status: 'failed', reason: '缺少 group 参数（配置错误，不重试）', retryable: false };
      }
      const externalId = externalIdOf(context);

      // ① 便宜检查：本地已知的当前值
      const known = options.currentGroup?.(context.userId);
      if (known !== undefined && known === target) return { status: 'skipped', reason: 'no_change' };

      // ② 最小变更间隔（改分组会踢用户下线，必须防抖）
      const interval = options.minChangeIntervalMs;
      if (interval !== undefined && interval > 0) {
        const last = options.lastChangeAt?.(context.userId);
        if (last !== undefined && now().getTime() - last.getTime() < interval) {
          return { status: 'skipped', reason: 'rate_limited' };
        }
      }

      // ③ 用户级互斥 + read-modify-write
      return lock.withLock(context.userId, async () => {
        const fresh = await options.api.get(externalId);
        if (fresh === null) {
          // 目标未绑定：不是失败，不计入失败率（docs/02 的 blocked_unbound）
          return { status: 'blocked_unbound', reason: '下游主体不存在（尚未绑定）' };
        }
        const currentGroup = String(fresh.attributes['group'] ?? '');
        if (currentGroup === target) {
          // 拿到锁后重新比对：另一轮可能已改好（幂等）
          return { status: 'skipped', reason: 'no_change' };
        }

        // ★ read-modify-write：回填全部既有属性，但**剔除敏感字段**
        const { safe, stripped } = stripSensitiveFields(fresh.attributes);
        await options.api.put(externalId, { ...safe, group: target });
        options.onChanged?.(context.userId, now());

        return {
          status: 'succeeded',
          ...(stripped.length === 0 ? {} : { detail: { strippedSensitiveFields: stripped } }),
        };
      });
    },

    async verify(context: ActionContext) {
      const target = String(context.params['group'] ?? '');
      const fresh = await options.api.get(externalIdOf(context));
      return {
        verified: fresh !== null && String(fresh.attributes['group'] ?? '') === target,
        actual: fresh?.attributes['group'] ?? null,
        expected: target,
      };
    },
  };
}

// ─────────────────────────── add_quota ───────────────────────────

export interface ManageOptions {
  api: DownstreamApi;
  lock?: UserLock;
  externalIdOf?: (context: ActionContext) => string;
}

/**
 * `add_quota` 动作。
 *
 * ★ **不做「值不变跳过」**：加额度是**累加**语义，重复执行会重复加。
 *   幂等完全依赖宿主的 `actionSeq` 幂等键（docs/05 §3.0.1 的冻结公式，
 *   **不含日期桶**——沿用含日期的写法会与冻结公式冲突）。
 */
export function createAddQuotaAction(options: ManageOptions): ActionHandler {
  const lock = options.lock ?? NO_LOCK;
  const externalIdOf = options.externalIdOf ?? ((context) => context.userId);
  return {
    async execute(context: ActionContext): Promise<ActionResult> {
      const raw = context.params['value'];
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value) || value === 0) {
        return { status: 'failed', reason: `value 必须是非零有限数字（实际 ${String(raw)}）——配置错误，不重试`, retryable: false };
      }
      if (options.api.manage === undefined) {
        return { status: 'failed', reason: '下游未提供 manage 能力', retryable: false };
      }
      const externalId = externalIdOf(context);
      // 同用户串行：避免并发管理动作交错
      return lock.withLock(context.userId, async () => {
        try {
          await options.api.manage!(externalId, 'add_quota', value);
          return { status: 'succeeded', detail: { value } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // 4xx（参数/权限错）不重试；5xx/网络错可重试
          const retryable = !/\b4\d\d\b/.test(message);
          return { status: 'failed', reason: message, retryable };
        }
      });
    },
  };
}

// ─────────────────────────── set_status ───────────────────────────

/**
 * `set_status` 动作。
 *
 * ★ 与 `add_quota` 相反，这里是**幂等**的（目标状态明确）：
 *   值不变则跳过——避免无谓的下游调用与审计噪音。
 */
export function createSetStatusAction(options: ManageOptions): ActionHandler {
  const lock = options.lock ?? NO_LOCK;
  const externalIdOf = options.externalIdOf ?? ((context) => context.userId);
  return {
    async execute(context: ActionContext): Promise<ActionResult> {
      const desired = context.params['enabled'];
      if (typeof desired !== 'boolean') {
        return { status: 'failed', reason: `enabled 必须是布尔值（实际 ${String(desired)}）——配置错误，不重试`, retryable: false };
      }
      if (options.api.manage === undefined) {
        return { status: 'failed', reason: '下游未提供 manage 能力', retryable: false };
      }
      const externalId = externalIdOf(context);
      return lock.withLock(context.userId, async () => {
        const fresh = await options.api.get(externalId);
        if (fresh === null) return { status: 'blocked_unbound', reason: '下游主体不存在（尚未绑定）' };

        // 下游用 status==1 表示启用（与会话里的映射一致）
        const currentEnabled = Number(fresh.attributes['status'] ?? 1) === 1;
        if (currentEnabled === desired) return { status: 'skipped', reason: 'no_change' };

        try {
          await options.api.manage!(externalId, desired ? 'enable' : 'disable');
          return { status: 'succeeded' };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { status: 'failed', reason: message, retryable: !/\b4\d\d\b/.test(message) };
        }
      });
    },
    async verify(context: ActionContext) {
      const desired = context.params['enabled'] === true;
      const fresh = await options.api.get(externalIdOf(context));
      const actual = fresh === null ? null : Number(fresh.attributes['status'] ?? 1) === 1;
      return { verified: actual === desired, actual, expected: desired };
    },
  };
}

/** 一次性注册三个动作到给定的注册表。 */
export function registerNewapiActions(
  registry: { register(action: string, handler: ActionHandler): void },
  options: { setGroup: SetGroupOptions; manage: ManageOptions },
): string[] {
  registry.register('newapi-set-group:set_group', createSetGroupAction(options.setGroup));
  registry.register('newapi-add-quota:add_quota', createAddQuotaAction(options.manage));
  registry.register('newapi-set-status:set_status', createSetStatusAction(options.manage));
  return ['newapi-set-group:set_group', 'newapi-add-quota:add_quota', 'newapi-set-status:set_status'];
}
