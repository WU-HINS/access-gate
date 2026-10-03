/**
 * ★★ **管理端端点的"可达性"**（防"实现了但调不到"这一类缺陷）。
 *
 * 背景（本会话查出的真实结构错误）：`admin/api.ts` 里有一处
 * `if (plugins !== undefined) {`（**没有** `path.startsWith` 条件），一直闭到很后面，
 * 把 `oidc/signing-keys`、`policy-assignments/cross-site` 等**与插件无关**的端点
 * 一起吞进了插件守卫 —— 于是它们**只在装配了 `plugins` 时才可达**。
 *
 * ★ 为什么既有测试没发现：那些测试**特意传了 `plugins`**（为了让被测端点能跑），
 *   于是测试的构造**掩盖了路由的结构错误**。CI 的「路由一致性」项也发现不了：
 *   它检查的是"挂载了吗"，不是"能到达吗"。
 *
 * ★★ 本文件同时**记录**本文件里**两种并存**的路由约定（它们各自的测试已经断言）：
 *   ① **未装配则不挂载 → 404**：`verify/clients` · `verify/assertions` · `oidc/providers` · `users` · `settings`
 *      —— 由各自测试明确断言（"未启用 X 存储时**不挂载**（404，而不是返回空列表）"）；
 *   ② **进入端点后显式 501**：`oidc/signing-keys` · `policy-assignments/cross-site` · `rollouts` 等
 *      —— "显式不可用，而不是静默"。
 *   ★ 这不是本文件的发明，而是**既有实现里就有的分歧**，这里把它写下来以免再被误改。
 *   ★ 本测试断言：**除①的清单之外**，所有已挂载端点都必须可达（非 404）——
 *     被吞进插件守卫的那两个端点不在①里，所以本测试能抓住那个结构错误。
 */

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminHandler, type AuditEntry } from '../src/admin/api.ts';

const routesSource = readFileSync(new URL('../src/http/routes.ts', import.meta.url), 'utf8');

/** 从挂载清单派生：只取**不含路径参数**的（含 `:id` 的需要真实取值才能匹配） */
const MOUNTS = [...routesSource.matchAll(/mount\('(GET|POST|PUT|DELETE|PATCH)',\s*'(\/api\/admin\/[^']*)'\)/g)]
  .map((match) => ({ method: match[1]!, path: match[2]! }))
  .filter((mount) => !mount.path.includes(':'));

/**
 * 约定①：**未装配则不挂载（404）** —— 这些前缀在最小 deps 下**应当** 404。
 * ★ 每一条都由对应测试断言过；改动它们会破坏那条既有断言。
 */
const NOT_MOUNTED_WHEN_UNCONFIGURED: readonly string[] = [
  '/api/admin/verify/clients',
  '/api/admin/verify/assertions',
  '/api/admin/oidc/providers',
  '/api/admin/users',
  '/api/admin/settings',
];

const isDepGated = (path: string): boolean =>
  NOT_MOUNTED_WHEN_UNCONFIGURED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/** **最小 deps**：只给结构上必需的两项，刻意**不给** `plugins` / `signingKeys` / `subjects` 等 */
function minimalHandler() {
  return createAdminHandler({
    csrfSecret: 'reachability-test',
    audit: {
      async record(_entry: AuditEntry) {
        /* 不关心 */
      },
      async list() {
        return [];
      },
    },
  } as never);
}

const SESSION = {
  userId: 'probe-user',
  username: 'probe',
  activeSiteId: 'probe-site',
  activeDeveloperId: null,
  realm: 'developer',
  role: 'admin',
};

const probe = async (method: string, path: string): Promise<number> => {
  const response = await minimalHandler()({
    method,
    path,
    session: SESSION,
    query: {},
    body: {},
  } as never);
  return response.status ?? 200;
};

test('★ 挂载清单非空（否则下面的断言会"恒真通过"）', () => {
  assert.ok(MOUNTS.length >= 20, `派生的端点太少（${MOUNTS.length}）——派生逻辑可能失效了`);
  assert.ok(
    MOUNTS.some((m) => !isDepGated(m.path)),
    '若所有端点都被归入"按设计不挂载"，本测试就没有区分力了',
  );
});

for (const mount of MOUNTS) {
  test(`★ 可达：${mount.method} ${mount.path}`, async () => {
    const status = await probe(mount.method, mount.path);
    if (isDepGated(mount.path)) {
      assert.equal(
        status,
        404,
        `★ ${mount.path} 属于「未装配则不挂载」那一类（约定①），最小 deps 下应当是 404`,
      );
      return;
    }
    assert.notEqual(
      status,
      404,
      `★ ${mount.method} ${mount.path} 落到了「未知端点」兜底 —— 它被**别的段的守卫**吞掉了` +
        `（典型成因：某个 \`if (dep !== undefined) {\` 漏了 \`path.startsWith(...)\` 条件；` +
        `本会话的 \`plugins\` 守卫就是这个毛病）`,
    );
  });
}

test('★ 对照组：**不存在**的路径仍是 404（证明"非 404"这条断言有区分力）', async () => {
  assert.equal(await probe('GET', '/api/admin/definitely-not-a-route'), 404);
});
