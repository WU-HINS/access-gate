/**
 * 静态守卫的验收：证明它能检出「事务外查询」与「裸 SQL」，且**不误杀**参数化写法。
 *
 * ★ 反例与正例成对出现——只证明「能检出」不足以说明扫描器有用（恒真的扫描器也能检出一切）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanSource } from '../src/db/guard.ts';

test('检出：事务外的驱动查询', () => {
  const source = [
    `import { db } from './x.ts';`,
    ``,
    `export async function loadSubjects() {`,
    `  const rows = await db.query('SELECT * FROM ag_external_subjects');`,
    `  return rows;`,
    `}`,
  ].join('\n');

  const found = scanSource(source, 'src/core/subjects.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, 'outside-transaction');
  assert.equal(found[0]!.line, 4, `期望定位到第 4 行，实际 ${found[0]!.line}`);
});

test('不误杀：同一查询放进 withTransaction 之后', () => {
  const source = [
    `export async function loadSubjects(db) {`,
    `  return db.transaction(async (tx) => {`,
    `    const rows = await db.query('SELECT * FROM ag_external_subjects');`,
    `    return rows;`,
    `  });`,
    `}`,
  ].join('\n');

  const found = scanSource(source, 'src/core/subjects.ts');
  assert.deepEqual(found, []);
});

test('检出：模板字面量里拼接 SQL 关键字', () => {
  const source = [
    `export function findUser(id: string) {`,
    `  return \`SELECT * FROM ag_users WHERE id = '\${id}'\`;`,
    `}`,
  ].join('\n');

  const found = scanSource(source, 'src/core/users.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, 'raw-sql');
});

test('不误杀：参数化占位符（无插值）与纯字符串', () => {
  const source = [
    `export const FIND_USER = 'SELECT * FROM ag_users WHERE id = $1';`,
    `export const LABEL = 'ag_users';`,
    `export const WITH_VALUE = \`前缀-\${1}\`;`,
  ].join('\n');

  const found = scanSource(source, 'src/core/users.ts');
  assert.deepEqual(found, []);
});

test('白名单：驱动层与测试目录内的直接查询不报错', () => {
  const source = `export async function raw(sql: string) { return pglite.query(sql); }`;
  assert.deepEqual(scanSource(source, 'src/db/pool.ts'), []);
  assert.deepEqual(scanSource(source, 'test/whatever.test.ts'), []);
});

test('不误杀：非驱动同名方法（数组/正则的 exec、map 等）不触发事务外告警', () => {
  const source = [
    `export function pick(list: string[]) {`,
    `  const m = /x/.exec('x');`,
    `  return list.map((s) => s.toUpperCase());`,
    `}`,
  ].join('\n');
  const found = scanSource(source, 'src/core/pick.ts');
  assert.deepEqual(found.filter((v) => v.rule === 'outside-transaction'), []);
});
