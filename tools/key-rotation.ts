#!/usr/bin/env node
/**
 * tools/key-rotation.ts —— 密钥轮换（M6-5）。
 *
 * 两件事必须一起做，否则「轮换」是假的：
 *   1. **主密钥轮换**（`AG_MASTER_KEY`）：`ag_secrets` / `ag_oidc_signing_keys` 的
 *      `keyVersion` / `masterKeyVersion` 必须逐条递增，且**旧版本仍能解密**（否则轮换即数据丢失）；
 *   2. **OIDC 签名密钥轮换**：新密钥先进 `standby`（发布到 JWKS 但不签发），
 *      观察期满再切 `active`，旧密钥转 `retiring` 继续发布供已签发 token 验签。
 *      这就是 `docs/02 §7.4` 的状态机，**不能跳过 standby**——
 *      直接换 active 会让「已签发但未过期」的 token 全部验签失败。
 *
 * ★ 本工具是**演练模式**（`--dry-run` 默认开启）：它打印将要执行的步骤与影响面，
 *   不真的改数据。要执行必须显式 `--apply`。密钥操作不可逆，默认安全。
 *
 * 用法：
 *   node --experimental-strip-types tools/key-rotation.ts --plan
 *   node --experimental-strip-types tools/key-rotation.ts --plan --apply --database <url>
 */

export type SigningKeyStatus = 'active' | 'standby' | 'retiring' | 'retired';

export interface SigningKeyRecord {
  kid: string;
  alg: string;
  status: SigningKeyStatus;
  masterKeyVersion: number;
}

export interface RotationStep {
  order: number;
  action: string;
  detail: string;
  /** 该步骤是否可逆 */
  reversible: boolean;
}

export interface RotationPlan {
  /** 新增的 standby 密钥（用于下一个算法槽位） */
  addKeys: { alg: string; status: SigningKeyStatus; masterKeyVersion: number }[];
  /** 状态迁移 */
  transitions: { kid: string; from: SigningKeyStatus; to: SigningKeyStatus; reason: string }[];
  /** 主密钥版本递增影响的行数（按表） */
  masterKeyBump: { table: string; rows: number }[];
  steps: RotationStep[];
  warnings: string[];
}

/**
 * 生成轮换计划（**纯函数**，可单测）。
 *
 * @param keys 当前密钥集合
 * @param algs 需要保持 active 的算法（缺省 ES256 + RS256 并存，见 docs/07 Q9）
 * @param counts 各表待递增主密钥版本的行数
 */
export function planRotation(options: {
  keys: readonly SigningKeyRecord[];
  algs?: readonly string[];
  counts?: Record<string, number>;
  newMasterKeyVersion: number;
}): RotationPlan {
  const algs = options.algs ?? ['ES256', 'RS256'];
  const steps: RotationStep[] = [];
  const warnings: string[] = [];
  const addKeys: RotationPlan['addKeys'] = [];
  const transitions: RotationPlan['transitions'] = [];
  let order = 0;

  // ① 每个算法槽位必须有一个 active（缺了就等于该算法不可签发）
  for (const alg of algs) {
    const active = options.keys.filter((k) => k.alg === alg && k.status === 'active');
    if (active.length === 0) {
      const standby = options.keys.find((k) => k.alg === alg && k.status === 'standby');
      if (standby !== undefined) {
        // 有 standby → 提升为 active（这是正常的轮换后半程）
        transitions.push({ kid: standby.kid, from: 'standby', to: 'active', reason: `${alg} 无 active，提升 standby` });
        order += 1;
        steps.push({ order, action: 'promote', detail: `standby ${standby.kid} → active`, reversible: true });
      } else {
        addKeys.push({ alg, status: 'standby', masterKeyVersion: options.newMasterKeyVersion });
        order += 1;
        steps.push({
          order,
          action: 'add-standby',
          detail: `新增 ${alg} standby 密钥（**必须先 standby 观察，不能直接 active**）`,
          reversible: true,
        });
        warnings.push(`${alg} 无任何可用密钥：新增的 standby 需观察一个发版周期后再提升为 active`);
      }
      continue;
    }
    if (active.length > 1) {
      // 一个算法最多一个 active（部分唯一索引强制），多了说明数据被手工改过
      warnings.push(`${alg} 有 ${active.length} 个 active 密钥——与 uq_ag_oidc_keys_active_alg 冲突，需人工裁决`);
    }
    // 有 active：把更早的 standby 视为「多余」，保持不动（避免误删仍在发布的密钥）
    const standbyCount = options.keys.filter((k) => k.alg === alg && k.status === 'standby').length;
    if (standbyCount === 0) {
      addKeys.push({ alg, status: 'standby', masterKeyVersion: options.newMasterKeyVersion });
      order += 1;
      steps.push({
        order,
        action: 'add-standby',
        detail: `为 ${alg} 预备下一个 standby（轮换时无缝提升）`,
        reversible: true,
      });
    }
  }

  // ② 主密钥版本递增：旧版本必须仍可解密
  const masterKeyBump = Object.entries(options.counts ?? {}).map(([table, rows]) => ({ table, rows }));
  for (const bump of masterKeyBump) {
    order += 1;
    steps.push({
      order,
      action: 'bump-master-key-version',
      detail: `${bump.table}：${bump.rows} 行的 keyVersion/masterKeyVersion 递增到 ${options.newMasterKeyVersion}`,
      reversible: false,
    });
  }
  if (masterKeyBump.length > 0) {
    warnings.push(
      '★ 递增主密钥版本后，**旧版本必须仍能被解密**（按版本查密钥）。' +
        '若实现只支持单一主密钥，轮换会立刻导致全部密文不可读——这不是「安全」，是数据丢失。',
    );
  }

  // ③ retiring：已过期的 retiring 才能 retire
  for (const key of options.keys.filter((k) => k.status === 'retiring')) {
    order += 1;
    steps.push({
      order,
      action: 'hold',
      detail: `retiring ${key.kid} 保持发布（等已签发 token 全部过期后才可 retire）`,
      reversible: true,
    });
  }

  return { addKeys, transitions, masterKeyBump, steps, warnings };
}

// ─────────────────────────── CLI ───────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const databaseUrl = (() => {
    const index = args.indexOf('--database');
    return index >= 0 ? args[index + 1] : process.env['AG_DATABASE_URL'];
  })();
  const apply = args.includes('--apply');

  if (databaseUrl === undefined) {
    // 无库时打印**计划模板**并说明如何真跑——不假装成功
    const demo = planRotation({
      keys: [
        { kid: 'k-es256-1', alg: 'ES256', status: 'active', masterKeyVersion: 1 },
        { kid: 'k-rs256-1', alg: 'RS256', status: 'active', masterKeyVersion: 1 },
      ],
      counts: { ag_secrets: 12, ag_oidc_signing_keys: 3 },
      newMasterKeyVersion: 2,
    });
    process.stdout.write('未提供 --database，输出**示例计划**（不执行任何写操作）：\n\n');
    for (const step of demo.steps) process.stdout.write(`  ${step.order}. [${step.action}] ${step.detail}\n`);
    for (const warning of demo.warnings) process.stdout.write(`  ⚠️  ${warning}\n`);
    process.stdout.write('\n用法：--database <url> [--apply]（不加 --apply 只打印计划）\n');
    process.exitCode = 2;
    return;
  }

  const { Client } = (await import('pg')) as unknown as typeof import('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const keys = await client.query<{ kid: string; alg: string; status: string; master_key_version: number }>(
      'SELECT kid, alg, status, master_key_version FROM ag_oidc_signing_keys',
    );
    const counts: Record<string, number> = {};
    for (const table of ['ag_secrets', 'ag_oidc_signing_keys']) {
      const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      counts[table] = Number(result.rows[0]?.n ?? 0);
    }

    const plan = planRotation({
      keys: keys.rows.map((row) => ({
        kid: row.kid,
        alg: row.alg,
        status: row.status as SigningKeyStatus,
        masterKeyVersion: row.master_key_version,
      })),
      counts,
      newMasterKeyVersion: 2,
    });

    process.stdout.write(`轮换计划（${apply ? '将执行' : '仅打印'}）：\n`);
    for (const step of plan.steps) process.stdout.write(`  ${step.order}. [${step.action}] ${step.detail}\n`);
    for (const warning of plan.warnings) process.stdout.write(`  ⚠️  ${warning}\n`);

    if (!apply) {
      process.stdout.write('\n未加 --apply，未做任何修改。\n');
      return;
    }
    // 真正的 apply 需要「按版本取主密钥」的实现（当前 M0 阶段未接入 KMS）。
    process.stdout.write('\n⚠️  apply 需要按 keyVersion 取主密钥的实现（M6 未接入 KMS）——已拒绝执行，避免造成不可逆的数据不可读。\n');
    process.exitCode = 3;
  } finally {
    await client.end();
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('key-rotation.ts')) {
  await main();
}
