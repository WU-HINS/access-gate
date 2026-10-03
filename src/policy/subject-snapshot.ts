/**
 * `subject:*` 的**快照解析**（`docs/04 §1.2.7.2` 跨系统寻址）。
 *
 * ★★ 这一层为什么必须存在（本文件是 P0-1 的"另一半"）：
 *   求值器是**同步**的，而「查绑定 → 读下游主体属性」是**异步**的。
 *   在补上它之前：`parseOperand` 与求值器都不认 `subject:*`，
 *   而 `resolveBinding()`（`policy/addressing.ts`）**没有任何生产调用方**——
 *   于是 `docs/04 §1.2.7` 与 `03 §1.16.3` 声明的「表达式里统一写 `subject.group`」
 *   **写不出来**，跨系统策略（"渠道 A 的分组 与 渠道 B 的角色联合判定"）无法表达。
 *
 * ★ 与 `fact:*` 的**同构**设计：值在快照阶段解析成一张映射，求值只做同步取值。
 *   三态语义也保持一致：**解析失败 = 键不存在**（`undefined`）→ 交 `$onMissing` 决定，
 *   而不是判 `false`（否则一次渠道抖动会被当成"不满足"，按 H1 属于误降级）。
 */

import type { BindingResolver } from './addressing.ts';

export interface SubjectKeyFailure {
  key: string;
  reason: string;
}

export interface SubjectSnapshot {
  /** 解析成功的取值（键形如 `group` 与 `<provider>.<attr>`） */
  values: Record<string, unknown>;
  /** 解析失败的键与原因——用于「差哪一项」提示与排障 */
  failures: readonly SubjectKeyFailure[];
}

export interface SubjectSnapshotInput {
  /** 平台用户（绑定的主体） */
  userId: string;
  /** 策略里用到的 subject 键（`group` 或 `<provider>.<attr>`） */
  keys: readonly string[];
  /**
   * 默认 provider（策略声明的那一个）。
   * ★ 未提供时，只有带显式前缀的键（`<provider>.<attr>`）能解析——
   *   裸键（`group`）会**明确失败**并给出原因，而不是静默取不到值。
   */
  defaultProviderId?: string;
  /** 绑定解析器（真实模式注入 `DbPluginBindingStore`） */
  resolver: BindingResolver;
  /** 按 `externalId` 读下游主体属性 */
  readSubject: (input: {
    providerId: string;
    externalId: string;
  }) => Promise<Record<string, unknown> | undefined>;
  /** 实例键（多实例插件用）；缺省 `default` */
  instanceKey?: string;
}

export async function collectSubjectSnapshot(input: SubjectSnapshotInput): Promise<SubjectSnapshot> {
  const values: Record<string, unknown> = {};
  const failures: SubjectKeyFailure[] = [];
  const instanceKey = input.instanceKey ?? 'default';

  for (const key of input.keys) {
    // 键形如 `group`（用策略的默认 provider）或 `<provider>.<attr>`（显式 provider）
    const dot = key.indexOf('.');
    const explicitProvider = dot < 0 ? undefined : key.slice(0, dot);
    const attr = dot < 0 ? key : key.slice(dot + 1);
    const providerId = explicitProvider ?? input.defaultProviderId;

    if (providerId === undefined) {
      failures.push({
        key,
        reason: '无法确定 provider：策略未声明默认 provider，键里也没有显式前缀（应写 `<provider>.<attr>`）',
      });
      continue;
    }

    const binding = await input.resolver.find(input.userId, providerId, instanceKey);
    if (binding === undefined) {
      failures.push({ key, reason: `用户未绑定 provider '${providerId}'` });
      continue;
    }
    if (binding.status !== 'active') {
      // ★ 撤销/待定的绑定**不能**用来取值——但要与"未绑定"区分开（排障需要）
      failures.push({ key, reason: `绑定 '${providerId}' 的状态是 '${binding.status}'，不可用于取值` });
      continue;
    }

    const attributes = await input.readSubject({ providerId, externalId: binding.externalId });
    if (attributes === undefined) {
      failures.push({ key, reason: `读取 provider '${providerId}' 的主体属性失败` });
      continue;
    }

    const value = attributes[attr];
    if (value === undefined) {
      failures.push({ key, reason: `provider '${providerId}' 的主体没有属性 '${attr}'` });
      continue;
    }

    values[key] = value;
    // ★ 同时登记**裸键**：让 `subject.group` 与 `subject:<provider>.<attr>` 都能取到同一个值
    //   （前者是"策略绑定 provider"时的常用写法，后者是显式写法）。
    if (values[attr] === undefined) values[attr] = value;
  }

  return { values, failures };
}

/**
 * 从表达式里收集所有 `subject:*` 键（快照阶段据此决定要解析什么）。
 *
 * ★ 与 `collectFactRefs` 同一手法（递归遍历、跳过 `$` 保留属性），
 *   但专门认 `subject.` / `subject:` 前缀——两者不能共用，因为语义不同
 *   （`fact.*` 由采集器提供，`subject.*` 由**绑定 + 下游读**提供）。
 */
export function collectSubjectKeys(expression: unknown, out = new Set<string>()): Set<string> {
  if (expression === null || typeof expression !== 'object') return out;
  if (Array.isArray(expression)) {
    for (const item of expression) collectSubjectKeys(item, out);
    return out;
  }
  const record = expression as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('$')) continue;
    // 比较节点的形态：{ op: { <operandPath>: expected } }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      const looksLikeOperandMap = entries.some(([k]) => /^(fact|user|binding|subject|me)[.:]/.test(k));
      if (looksLikeOperandMap) {
        for (const [operand] of entries) {
          if (operand.startsWith('subject.')) out.add(operand.slice('subject.'.length));
          else if (operand.startsWith('subject:')) out.add(operand.slice('subject:'.length));
        }
        continue;
      }
    }
    collectSubjectKeys(value, out);
  }
  return out;
}
