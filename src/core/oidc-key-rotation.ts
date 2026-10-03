/**
 * OIDC 签名密钥轮换（`docs/05 §8.4.1`）—— 「**先发布、后使用**」的四步流程。
 *
 * ★★ 为什么必须有这个模块：文档自己写明了两种**错法**及其后果——
 *
 * | 错法 | 后果 |
 * |---|---|
 * | 「先升后降」（先置新 active，再降旧） | 撞部分唯一索引 `uq_ag_oidc_keys_active_alg`（每种算法**至多一个** active） |
 * | 「拆两条语句」（不在同一事务） | **零 active 窗口** → **全站登录中断** |
 *
 * 而在此之前，`ag_oidc_signing_keys` 表在 `src/` 里**零引用**：
 * 轮换只能手工改库 —— 而手工恰恰是最容易犯上面两种错的场景。
 * 所以本模块的价值不是「多一个功能」，而是**给一个高危操作提供唯一正确的通道**。
 *
 * ★ 判定与执行**分离**，这是可测与可恢复的前提：
 *   · `nextRotationStep()` 是**纯函数**（密钥集合 + 当前时间 → 下一步动作），可穷举单测；
 *   · `applyRotationStep()` 只执行**一步**；
 *   · 跨时间的「等待下游 JWKS 缓存过期」由**调度器反复调用**表达，
 *     而不是让某个函数 `sleep` 30 分钟（那样既不可测，进程重启后也无从恢复）。
 */

export type SigningKeyStatus = 'active' | 'standby' | 'retiring' | 'retired';

/** 与 `ag_oidc_signing_keys` 的列一一对应（`docs/02 §7.4`） */
export interface SigningKeyRecord {
  kid: string;
  /** 签名算法（`ES256` / `RS256` / `EdDSA` …） */
  alg: string;
  status: SigningKeyStatus;
  /** 何时被置为 active（用于「该不该发起下一次轮换」） */
  activatedAt: Date | null;
  retiredFromSigningAt: Date | null;
  /** 移出 JWKS 的最早时间（`standby` 恒为 `null` = 永久发布） */
  removeAfter: Date | null;
  createdAt: Date;
}

export interface RotationOptions {
  /** 当前签发算法（`oidc.signing.activeAlg`） */
  activeAlg: string;
  /** 下游 JWKS 缓存 TTL；等待窗口 = **TTL × 6**（文档默认 30 分钟） */
  jwksCacheTtlMs: number;
  /** 旧公钥在 JWKS 中保留的最短时长（必须 ≥ token 最长有效期） */
  retireAfterMs: number;
  /** 主动轮换周期（`oidc.signing.rotateEvery`）；`undefined` = 不自动发起 */
  rotateEveryMs?: number;
}

export type RotationStep =
  | { action: 'none'; reason: string }
  | { action: 'publish_standby'; alg: string; reason: string }
  | { action: 'wait'; kid: string; until: Date; reason: string }
  | { action: 'activate'; activeKid: string; retiringKid: string | null; reason: string }
  | { action: 'retire'; kid: string; reason: string };

/**
 * 决定**下一步**该做什么（纯函数）。
 *
 * ★ 优先级刻意这样排（任何一条都不能省）：
 *   1. **没有 active** → 必须立刻补上（`standby` 顶上，或先发布一个）——
 *      这是「零 active 窗口」的兜底：即使有人手工把库改坏了，下一步也是先恢复可用性；
 *   2. **有 standby** → 等够「下游缓存过期」才切换（**先发布、后使用**的本质）；
 *   3. **有到期的 retiring** → 移出 JWKS；
 *   4. 否则不动（轮换的**发起**是另一件事，见 `needsNewStandby`）。
 */
export function nextRotationStep(input: {
  keys: readonly SigningKeyRecord[];
  options: RotationOptions;
  now: Date;
}): RotationStep {
  const { keys, options, now } = input;
  const active = keys.find((key) => key.status === 'active' && key.alg === options.activeAlg);
  const standby = keys.find((key) => key.status === 'standby' && key.alg === options.activeAlg);

  // ① 零 active：先恢复可用性（**不许**让系统停在没有 active 的状态）
  if (active === undefined) {
    if (standby !== undefined) {
      return {
        action: 'activate',
        activeKid: standby.kid,
        retiringKid: null,
        reason: '当前无 active 密钥——立即启用 standby，避免零 active 窗口导致登录中断',
      };
    }
    return {
      action: 'publish_standby',
      alg: options.activeAlg,
      reason: '既无 active 也无 standby——必须先发布一个（不能直接签发）',
    };
  }

  // ② 有 standby：等「下游 JWKS 缓存过期」再切换（先发布、后使用）
  if (standby !== undefined) {
    const readyAt = new Date(standby.createdAt.getTime() + options.jwksCacheTtlMs * 6);
    if (now.getTime() < readyAt.getTime()) {
      return {
        action: 'wait',
        kid: standby.kid,
        until: readyAt,
        reason: `等待下游 JWKS 缓存过期（≥ TTL × 6）后才切换 active——否则下游按未知 kid 验签失败`,
      };
    }
    return {
      action: 'activate',
      activeKid: standby.kid,
      retiringKid: active.kid,
      reason: 'standby 已过等待期——同事务切换（先降旧为 retiring，再升新为 active）',
    };
  }

  // ③ retiring 到期 → 移出 JWKS（此时已签发未过期的 token 都已过期）
  const retiring = keys.find(
    (key) =>
      key.status === 'retiring' &&
      key.removeAfter !== null &&
      key.removeAfter.getTime() <= now.getTime(),
  );
  if (retiring !== undefined) {
    return { action: 'retire', kid: retiring.kid, reason: 'retiring 已超过保留期（≥ token 最长有效期）' };
  }

  return { action: 'none', reason: '当前无需轮换动作' };
}

/**
 * 是否该**发起**下一次轮换（发布新的 standby）。
 *
 * ★ 与 `nextRotationStep` 分开：前者答「现在该不该生成新密钥」（周期性），
 *   后者答「已经生成的密钥该走到哪一步」（每次调度都要问）。
 *   混在一起会让「等待期」与「轮换周期」互相干扰。
 */
export function needsNewStandby(input: {
  keys: readonly SigningKeyRecord[];
  options: RotationOptions;
  now: Date;
}): boolean {
  const { keys, options, now } = input;
  if (options.rotateEveryMs === undefined) return false;
  // 已有 standby 在途 → 不再生成（否则会堆出一串 standby）
  if (keys.some((key) => key.status === 'standby' && key.alg === options.activeAlg)) return false;
  const active = keys.find((key) => key.status === 'active' && key.alg === options.activeAlg);
  if (active === undefined) return true;
  const anchor = active.activatedAt ?? active.createdAt;
  return now.getTime() - anchor.getTime() >= options.rotateEveryMs;
}

// ─────────────────────────── 存储契约与执行 ───────────────────────────

export interface OidcSigningKeyStore {
  list(): Promise<readonly SigningKeyRecord[]>;
  /** 生成新密钥并以 `standby` 落库（**不签发**） */
  createStandby(input: { alg: string; now: Date }): Promise<SigningKeyRecord>;
  /**
   * ★★ **唯一允许的切换方式**：同一事务内**先降后升**。
   *
   * 为什么签名里没有「只升不降」这种选项：那种调用要么撞唯一索引，
   * 要么制造零 active 窗口——两者都是文档点名的错法。
   * 把它做成**接口上唯一的路**，错误就无处表达。
   */
  activateAtomically(input: {
    retiringKid: string | null;
    activeKid: string;
    now: Date;
    /** 旧密钥移出 JWKS 的最早时间 = now + retireAfterMs */
    removeAfter: Date;
  }): Promise<void>;
  /** `retiring` → `retired`（移出 JWKS） */
  retire(input: { kid: string; now: Date }): Promise<void>;
}

export interface ApplyStepResult {
  applied: boolean;
  detail: string;
}

/** 执行**一步**轮换动作（`wait` / `none` 不产生副作用，返回 `applied: false`）。 */
export async function applyRotationStep(input: {
  store: OidcSigningKeyStore;
  step: RotationStep;
  now: Date;
  retireAfterMs: number;
}): Promise<ApplyStepResult> {
  const { store, step, now } = input;
  switch (step.action) {
    case 'none':
    case 'wait':
      return { applied: false, detail: step.reason };

    case 'publish_standby': {
      const created = await store.createStandby({ alg: step.alg, now });
      return { applied: true, detail: `已发布 standby 密钥 ${created.kid}（不签发，仅进 JWKS）` };
    }

    case 'activate': {
      await store.activateAtomically({
        retiringKid: step.retiringKid,
        activeKid: step.activeKid,
        now,
        removeAfter: new Date(now.getTime() + input.retireAfterMs),
      });
      return {
        applied: true,
        detail:
          `已同事务切换：active=${step.activeKid}` +
          (step.retiringKid === null ? '' : ` · retiring=${step.retiringKid}`),
      };
    }

    case 'retire': {
      await store.retire({ kid: step.kid, now });
      return { applied: true, detail: `已将 ${step.kid} 移出 JWKS（status=retired）` };
    }
  }
}

// ─────────────────────────── 内存实现（测试与单站点开发） ───────────────────────────

export class InMemoryOidcSigningKeyStore implements OidcSigningKeyStore {
  readonly #keys: SigningKeyRecord[] = [];
  #counter = 0;

  /** 便于测试断言：当前所有密钥 */
  get keys(): readonly SigningKeyRecord[] {
    return this.#keys.map((key) => ({ ...key }));
  }

  async list(): Promise<readonly SigningKeyRecord[]> {
    return this.#keys.map((key) => ({ ...key }));
  }

  async createStandby(input: { alg: string; now: Date }): Promise<SigningKeyRecord> {
    this.#counter += 1;
    const record: SigningKeyRecord = {
      kid: `${input.alg.toLowerCase()}-${String(this.#counter).padStart(3, '0')}`,
      alg: input.alg,
      status: 'standby',
      activatedAt: null,
      retiredFromSigningAt: null,
      removeAfter: null,
      createdAt: input.now,
    };
    this.#keys.push(record);
    return { ...record };
  }

  async activateAtomically(input: {
    retiringKid: string | null;
    activeKid: string;
    now: Date;
    removeAfter: Date;
  }): Promise<void> {
    // ★ 顺序与 PG 实现**必须一致**：先降后升（否则 PG 下会撞唯一索引；
    //   内存实现虽然不会撞，但也要保持同一语义，否则测试与生产行为分叉）
    if (input.retiringKid !== null) {
      const retiring = this.#keys.find((key) => key.kid === input.retiringKid);
      if (retiring === undefined) throw new Error(`未知密钥 ${input.retiringKid}`);
      retiring.status = 'retiring';
      retiring.retiredFromSigningAt = input.now;
      retiring.removeAfter = input.removeAfter;
    }
    const next = this.#keys.find((key) => key.kid === input.activeKid);
    if (next === undefined) throw new Error(`未知密钥 ${input.activeKid}`);
    next.status = 'active';
    next.activatedAt = input.now;
    next.removeAfter = null;
  }

  async retire(input: { kid: string; now: Date }): Promise<void> {
    const found = this.#keys.find((key) => key.kid === input.kid);
    if (found === undefined) throw new Error(`未知密钥 ${input.kid}`);
    found.status = 'retired';
  }
}
