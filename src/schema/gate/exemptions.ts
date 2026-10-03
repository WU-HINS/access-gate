/**
 * R3 豁免清单：**平台级表（既无 site_id 也无 owner_scope）的逐表理由**。
 *
 * 权威来源：`docs/02-数据模型.md` §1「★ CI 门禁（派生规则，非人工白名单）」（第 21 行）
 * 原文列出的 8 张表：
 *   ag_users（平台身份锚点）· ag_sessions（会话横跨站点，靠 activeSiteId 运行期约束）·
 *   ag_plugins（插件目录，平台级）· ag_oidc_providers / ag_oidc_signing_keys（平台级 IdP）·
 *   ag_platform_settings · ag_developers / ag_dev_invitations（开发者域，按 ownerScope 隔离）
 *
 * 纪律：清单**只增不改**由人工签署；`reason` 必须逐表书写、不得复制粘贴同一句，
 * 且 `trim()` 后非空——空理由的表在门禁里等同「不在清单中」（R3 error）。
 *
 * ⚠️ 已知文档缺陷（详见 `reports/gate-evidence.md` §4）：
 *   `ag_dev_invitations` 在 §1 清单中，但其声明（02 行 282）有 **可空** 的 `siteId`，
 *   因此命中的是 R1（site_id 可空 + 唯一键首列 codeHash ≠ site_id），R3 豁免根本不会被触发。
 */

import type { PlatformExemption } from './types.ts';

/** 权威清单：表名 → 逐表理由（理由非空才算豁免）。 */
export const PLATFORM_EXEMPTIONS: readonly PlatformExemption[] = [
  {
    tableName: 'ag_users',
    reason:
      '平台身份锚点：id 就是 OIDC sub（永不变更），同一用户在全部站点间是同一个主体，' +
      '表上不存在站点维度归属；站点内的可见性由策略层（ag_policy_assignments）决定，不能下沉成列。',
  },
  {
    tableName: 'ag_oauth_clients',
    reason:
      '第三方应用在本平台的**注册信息**（client_id / 允许的回调地址 / scopes）——' +
      '它是「本平台作为 IdP」的配置，**不属于任何站点**：同一个第三方应用可能被多个站点复用，' +
      '且授权端点 `/oauth/authorize` 在**用户选定站点之前**就可能被访问。' +
      '若强行加 site_id，同一应用要为每个站点重复注册，且回调地址校验会被站点维度割裂。',
  },
  {
    tableName: 'ag_oauth_codes',
    reason:
      '授权码是**一次协议流程中的临时凭证**（`/oauth/authorize` → `/oauth/token`），' +
      '它的归属是「一次授权」，而不是任何站点——与 `ag_sessions` / `ag_oidc_login_transactions` 同理。' +
      '★ 它必须**跨请求、跨实例**可用（多实例下授权码在 A 实例签发、在 B 实例兑换），' +
      '因此不能带站点维度。',
  },
  {
    tableName: 'ag_oauth_refresh_tokens',
    reason:
      '刷新令牌代表「第三方应用在**用户授权**下持续访问」——归属是 (客户端, 用户)，' +
      '而用户是**平台级**主体（`ag_users.id`，跨站点同一人），因此不能带 site_id。' +
      '★ 若加 site_id，同一用户在不同站点会被视为不同授权主体，**撤销授权会漏掉其它站点**。',
  },
  {
    tableName: 'ag_verify_nonces',
    reason:
      'nonce 防重放的记录不属于任何站点：它标识的是「某个**调用方**在某个时间窗口内用过某个 nonce」，' +
      '而调用方（ag_verify_clients）本身是平台级的（协同验证是跨站点的机器对机器协议）。' +
      '若强行加 site_id，同一调用方在不同站点会被视为不同主体，**防重放窗口就被绕过了**。',
  },
  {
    tableName: 'ag_oidc_login_transactions',
    reason:
      '登录事务横跨站点：用户**登录时尚未选定站点**（两级选择发生在登录之后），' +
      '因此本表不能带 site_id。state/PKCE verifier 的归属是「一次登录尝试」，' +
      '而不是任何站点——与 ag_sessions 同理。' +
      '★ 本表是 R56 架构缺口（登录状态只有内存实现）的修复：' +
      '持久化后，重启与多实例部署下登录仍可用。',
  },
  {
    tableName: 'ag_sessions',
    reason:
      '会话横跨站点：一条会话可先后访问多个站点，作用域由运行期注入的 active_site_id 承载' +
      '（02 行 133 三列），把 site_id 固化到行上会让会话在切换站点时失效。',
  },
  {
    tableName: 'ag_plugins',
    reason:
      '插件目录是平台级注册表：插件包由平台安装、验签与版本管理，不属于任何站点；' +
      '站点维度的启用与参数在下游 ag_plugin_instances / ag_plugin_grants 中承载。',
  },
  {
    tableName: 'ag_oidc_providers',
    reason:
      '平台级 IdP 配置：issuer / client / 回调地址由平台与对接方签约维护，一份配置服务全部站点；' +
      '按站点拆分会让「平台作为 IdP」的信任锚失去单点性。',
  },
  {
    tableName: 'ag_oidc_signing_keys',
    reason:
      '平台级签名密钥材料：JWKS 对全部站点共用同一密钥集，按站点拆分会导致 token 无法跨站点校验，' +
      '并使密钥轮换碎片化（AG_MASTER_KEY 版本化只对单实例有意义）。',
  },
  {
    tableName: 'ag_platform_settings',
    reason:
      '平台运行参数（SAAS_MODE / 会话策略 / SMTP / 网络开关）作用于整个部署实例，无站点维度；' +
      '站点级覆盖属于 ag_sites 自身的列与配置，不应落在全局 KV 表上。',
  },
  {
    tableName: 'ag_developers',
    reason:
      '开发者是站点的上游所有者：同一开发者在多个站点间共享同一身份，本表按 id / username 全局唯一；' +
      '站点化会把 SI 主体错误降级为「某站点的成员」，并破坏 08 §5 的开发者入驻模型。',
  },
  {
    tableName: 'ag_plugin_configs',
    reason:
      '配置版本历史：本表是 ag_plugin_instances 的不可变快照，归属由父实例决定——' +
      '而实例既可能是 developer 级、也可能是 site 级，故本表不能自带 site_id。' +
      '（02 §1 豁免清单已逐表签署同一理由；跨作用域表的 R5 约束在父表上由 CHECK 保证。）',
  },
  {
    tableName: 'ag_plugin_packages',
    reason:
      '外置插件包体的权威存储：包体是平台级分发物（安装、验签、版本清理都是平台动作），' +
      '与站点无关；站点级差异体现在 ag_plugin_instances 的配置，而不是包体。',
  },
  {
    tableName: 'ag_quota_counters',
    reason:
      '配额计数（`docs/05 §6.4` QuotaGuard）：限流与预算是**跨实例**的资源——' +
      '进程内计数会让多实例部署下的实际配额 = 单实例配额 × 实例数（本会话记录的 L-13），' +
      '所以必须落库并由**一条条件更新**原子预占。' +
      '★ 键由守卫保证与归属同构（`quota:{ownerScope}:{ownerId}:{pluginId}:{instanceKey}:{resource}`），' +
      '本表**只存键与窗口、不解释键的内容**（谁归属谁由守卫决定），避免"键的语义"分裂成两处。' +
      '★ **平台级**：LLM 凭据与预算属于平台，且插件宿主没有站点上下文' +
      '（`HostApi` 里不存在 siteId）——加 site_id 只会造出一个恒为默认值的列。',
  },

];

/** 便捷查询：返回非空理由；未豁免或理由为空 → `undefined`。 */
export function findExemption(
  tableName: string,
  exemptions: readonly PlatformExemption[] = PLATFORM_EXEMPTIONS,
): PlatformExemption | undefined {
  const found = exemptions.find((entry) => entry !== undefined && entry.tableName === tableName);
  if (found === undefined) return undefined;
  if (typeof found.reason !== 'string' || found.reason.trim().length === 0) return undefined;
  return found;
}
