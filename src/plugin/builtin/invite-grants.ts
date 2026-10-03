/**
 * 邀请码授予的事实（`ag_invite_codes.grantsFacts` → 事实库）—— L-1 的另一半。
 *
 * ★★ 为什么需要一个 manifest（而不是把 `grantsFacts` 直接写库）：
 *   `FactPipeline.emit()` **要求 manifest 声明 `factSchema`**——它的理由是
 *   "策略编辑器据此做路径补全与静态校验"（`docs/10`）。
 *   因此"邀请码授予"必须**声明它能授予哪些字段**，不能是任意 jsonb。
 *
 * ★★ 这顺带带来一条真实的安全性质：**邀请码不能授予未声明的字段**。
 *   否则拿到"创建邀请码"权限的人，可以借邀请码往事实库写入任意字段——
 *   绕过 `factSchema` 的全部校验，而那是事实层的**唯一入口约束**。
 *   （有测试直接验证这一点：未声明字段的授予会被拒绝。）
 *
 * ★ `invite_code_id` 存的是**邀请码记录的 id**，不是码本身：
 *   码是凭据，把它复制进事实表会让"凭据出现在非凭据位置"，扩大泄露面。
 */

/** 邀请码授予的 manifest（`namespace = invite`，即事实路径为 `fact.invite.<字段>`） */
export const INVITE_GRANTS_MANIFEST = {
  apiVersion: 'gate.plugin/v1',
  kind: 'channel',
  id: 'invite-grants',
  name: '邀请码授予',
  version: '1.0.0',
  description: '把邀请码声明的授予项转成事实（**只允许 factSchema 里声明的字段**）',
  author: 'official',
  license: 'MIT',
  runtime: 'declarative',
  /**
   * ★ `local: true`：本插件**不做网络请求**——它只是把邀请码声明的授予项转成事实。
   *   ★ 契约要求"`declarative` 必须有 `collect`（否则插件什么也不做）"，
   *     而 `local: true` 正是那个例外：**本地求值**，没有采集地址可写。
   *     （与 `email-domain` 同一形态——那里的注释也说了"不要为了满足规则编造一个假 URL"。）
   */
  local: true,
  capabilities: { binding: 'none', refresh: false, revoke: false, quickCheck: true },
  permissions: [],
  /** ★ 授予的事实应长期有效（10 年）：邀请码带来的身份归属不会自己过期 */
  factTtl: '3650d',
  factSchema: {
    type: 'object',
    properties: {
      cohort: { type: 'string', title: '加入的群组' },
      tier: { type: 'string', title: '初始层级' },
      invited: { type: 'boolean', title: '是否为邀请入驻' },
      invite_code_id: { type: 'string', title: '邀请码记录 id（**不是码本身**——码是凭据）' },
    },
  },
} as const;

/**
 * 把邀请码的 `grantsFacts` 整理成可提交的事实。
 *
 * ★ **不在本函数里做 schema 校验**：校验由 `FactPipeline.emit()` 统一做
 *   （它是事实层的唯一入口）——在这里再写一遍只会产生**两套口径**。
 * ★ 本函数只做一件事：**剔除 `undefined`**（JSON 里的 undefined 会在序列化时消失，
 *   让"显式传了 undefined"与"没传"变得无法区分）。
 */
export function buildInviteFacts(input: {
  grantsFacts: Record<string, unknown>;
  inviteCodeId: string;
}): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.grantsFacts)) {
    if (value === undefined) continue;
    facts[key] = value;
  }
  // ★ 记录来源（码的 id，不是码）——排障时能回答"这条 cohort 是谁给的"
  facts['invite_code_id'] = input.inviteCodeId;
  return facts;
}
