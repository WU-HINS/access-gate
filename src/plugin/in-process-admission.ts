/**
 * `in-process` 准入闸 —— `docs/03 §1.3 / §1.12.1` 的三个 **AND** 条件。
 *
 * > `docs/03:67`：`in-process` 需要满足**全部**条件：
 * > **包签名验证通过** + **管理员显式确认风险** + **插件在官方信任列表内**
 *
 * ★★ 为什么这条必须单独成文件、且必须是**可判定的函数**：
 *   `in-process` 意味着**插件代码跑在宿主进程里**——`src/plugin/manifest.ts` 自己写道：
 *   「若宿主对未知 `runtime` 静默降级为 `in-process`，就等于**把任意代码放进主进程**」。
 *   而在此之前，`runtime` 只被**存储**与**枚举校验**（合法值 ≠ 被允许）：
 *   一个未签名的第三方插件只要在 manifest 里写 `runtime: 'in-process'`，**没有任何一道门会拦它**。
 *
 * ★ 判定形态刻意做成「**返回全部缺失项**」而不是「返回第一个」：
 *   管理端要一次告诉管理员「还差哪几条」，而不是修一条再撞下一条。
 *
 * ★ 内置插件（`source: 'builtin'`）**豁免显式检查**：它随主程序构建产物发布，
 *   三个条件由**发布流程**保证（构建即签名、官方即列表、发布即确认）。
 *   若对它也要求「运行时管理员逐次确认」，冷启动就会把所有内置插件挡在门外——
 *   那会把一个安全默认变成一次可用性事故。
 */

import type { PluginRuntime } from './manifest.ts';

export type PluginSourceKind = 'builtin' | 'uploaded' | 'url' | 'directory';

export interface InProcessAdmissionInput {
  pluginId: string;
  runtime: PluginRuntime;
  source: PluginSourceKind;
  /** 包内容摘要校验 + 签名验证的结果（`ag_plugins.signature_verified`） */
  signatureVerified: boolean;
  /** 管理员**显式**确认后端代码信任的时间；未确认为 `null` */
  adminApprovedAt: Date | null;
  /** 平台设置的「官方信任列表」（额外放行的插件 id）；内置始终视为官方 */
  officialAllowlist?: readonly string[];
}

export type InProcessDenial = 'not_signed' | 'not_officially_trusted' | 'not_admin_approved';

export class InProcessNotAdmittedError extends Error {
  readonly pluginId: string;
  readonly denials: readonly InProcessDenial[];

  constructor(pluginId: string, denials: readonly InProcessDenial[]) {
    super(
      `插件 '${pluginId}' 声明 runtime='in-process'（代码将运行在宿主进程内），但未满足准入条件：` +
        `${denials.map(describeDenial).join('；')}。` +
        '（docs/03 §1.3：三项条件为 AND，缺一不可。请改用 process/container，或补齐条件后再启用。）',
    );
    this.name = 'InProcessNotAdmittedError';
    this.pluginId = pluginId;
    this.denials = denials;
  }
}

function describeDenial(denial: InProcessDenial): string {
  switch (denial) {
    case 'not_signed':
      return '包签名未验证通过';
    case 'not_officially_trusted':
      return '不在官方信任列表内';
    case 'not_admin_approved':
      return '管理员未显式确认后端代码信任';
  }
}

export interface InProcessAdmissionResult {
  admitted: boolean;
  /** 全部缺失项（顺序固定：签名 → 官方列表 → 管理员确认） */
  denials: readonly InProcessDenial[];
}

/**
 * 评估 `in-process` 准入（**纯函数**：同样的输入永远得到同样的结论，便于与 UI 共用）。
 *
 * 非 `in-process` 的 runtime 一律放行——本闸只管「进主进程」这一件事。
 */
export function evaluateInProcessAdmission(input: InProcessAdmissionInput): InProcessAdmissionResult {
  if (input.runtime !== 'in-process') return { admitted: true, denials: [] };

  // 内置插件：三个条件由发布流程保证（见文件头说明）
  if (input.source === 'builtin') return { admitted: true, denials: [] };

  const denials: InProcessDenial[] = [];
  if (!input.signatureVerified) denials.push('not_signed');

  const allowlist = input.officialAllowlist ?? [];
  if (!allowlist.includes(input.pluginId)) denials.push('not_officially_trusted');

  if (input.adminApprovedAt === null) denials.push('not_admin_approved');

  return { admitted: denials.length === 0, denials };
}

/** 不满足即抛（抛出的错误**列出全部缺失项**，而不是第一条）。 */
export function assertInProcessAdmitted(input: InProcessAdmissionInput): void {
  const result = evaluateInProcessAdmission(input);
  if (!result.admitted) throw new InProcessNotAdmittedError(input.pluginId, result.denials);
}
