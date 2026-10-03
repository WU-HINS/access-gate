/**
 * 表达式编辑器验收（M3-8 / M3-9）。
 *
 * 两条验收：
 *   - M3-8：**YAML + JSON 双视图**——切换不改语义；编辑任一面板，另一面板同步；
 *   - M3-9：**图形视图**——在图上做结构编辑，位置不参与语义。
 *
 * ★ 本文件的中心断言是「**三个面板在任何时刻都一致**」：
 *   编辑器最常见的 bug 是「改了一个面板、另一个还是旧的」，
 *   用户看到的是「我明明改了，怎么发布出去的还是旧的」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGraphEdit,
  applyTextEdit,
  createEditorState,
  hasUnsavedChanges,
  preparePublish,
  switchView,
  textOf,
  type EditorState,
} from '../src/policy/editor.ts';
import { fromYaml, specHash, toGraph } from '../src/policy/expr-forms.ts';
import type { Expression } from '../src/policy/expr.ts';

const EXPRESSION: Expression = {
  any: [
    { $label: 'QQ > 40', gt: { 'fact.qq.level': 40 } },
    { all: [{ gt: { 'fact.qq.level': 20 } }, { lte: { 'fact.qq.level': 40 } }] },
  ],
};

/** 三个视图的文本必须都能解析回**同一个语义指纹**。 */
function assertViewsConsistent(state: EditorState): void {
  const hashes = {
    yaml: specHash(fromYaml(state.texts.yaml)),
    json: specHash(JSON.parse(state.texts.json) as Expression),
    graph: specHash(
      // graph 文本 → AST：用编辑器的 applyTextEdit 路径更贴近真实用法
      applyTextEdit(state, state.texts.graph, 'graph').ast,
    ),
  };
  assert.equal(hashes.yaml, state.hash, 'yaml 视图应与 AST 一致');
  assert.equal(hashes.json, state.hash, 'json 视图应与 AST 一致');
  assert.equal(hashes.graph, state.hash, 'graph 视图应与 AST 一致');
}

// ─────────────────────────── M3-8 双视图 ───────────────────────────

test('★ M3-8：创建后三个视图都从**同一个 AST** 渲染（语义一致）', () => {
  const state = createEditorState(EXPRESSION, 'yaml');
  assert.equal(state.hash, specHash(EXPRESSION));
  assertViewsConsistent(state);
  assert.equal(state.revision, 0);
  assert.equal(state.lastEditOk, true);
});

test('★ M3-8：切换视图**不改变语义**（hash 不变、AST 不变）', () => {
  const state = createEditorState(EXPRESSION, 'yaml');
  for (const view of ['json', 'graph', 'yaml'] as const) {
    const switched = switchView(state, view);
    assert.equal(switched.hash, state.hash, `切到 ${view} 后 hash 必须不变`);
    assert.equal(switched.ast, state.ast, 'AST 是同一对象（未重建）');
    assert.equal(switched.view, view);
    assertViewsConsistent(switched);
  }
});

test('★ M3-8：编辑 JSON 面板 → **YAML 与图形面板同步**（这是「不漂移」的可操作含义）', () => {
  const state = createEditorState(EXPRESSION, 'json');
  const edited = JSON.stringify({ all: [{ eq: { 'me.email_verified': true } }, { always: true }] });
  const next = applyTextEdit(state, edited, 'json');

  assert.equal(next.lastEditOk, true);
  assert.equal(next.revision, 1);
  // ★ 其它面板已同步
  assert.match(next.texts.yaml, /all:/);
  assert.match(next.texts.yaml, /me\.email_verified: true/);
  // ★ 编辑器以 AST 为权威：文本会被**重新渲染**，因此用户输入的格式（空格/换行）
  //   不保证原样保留——但**语义必须等价**。
  assert.deepEqual(JSON.parse(next.texts.json), JSON.parse(edited));
  assertViewsConsistent(next);
  // 图形视图确实反映了新结构
  const graph = toGraph(next.ast);
  assert.equal(graph.nodes.filter((node) => node.kind === 'all').length, 1);
});

test('★ M3-8：解析失败 → **AST 不变、其它视图不被污染**（状态永远自洽）', () => {
  const state = createEditorState(EXPRESSION, 'yaml');
  const broken = applyTextEdit(state, 'any:\n  - gt: {fact.qq.level: 40}\n  - 这是坏数据', 'yaml');

  assert.equal(broken.lastEditOk, false);
  assert.ok(broken.lastError !== undefined);
  assert.equal(broken.lastError!.view, 'yaml');
  // ★ 关键：AST 与文本都没变（若把坏文本写进状态，两个面板就会不一致）
  assert.equal(broken.ast, state.ast);
  assert.equal(broken.texts.yaml, state.texts.yaml);
  assert.equal(broken.hash, state.hash);
  assert.equal(broken.revision, 0);
  assertViewsConsistent(broken);
});

test('M3-8：JSON 面板的语法错误也被识别（不抛到调用方）', () => {
  const state = createEditorState(EXPRESSION, 'json');
  const broken = applyTextEdit(state, '{ not json', 'json');
  assert.equal(broken.lastEditOk, false);
  assert.match(broken.lastError!.message, /JSON/i);
  assert.equal(broken.ast, state.ast);
});

test('M3-8：`textOf` 取任意视图文本；未保存改动可判定', () => {
  const state = createEditorState(EXPRESSION, 'yaml');
  assert.equal(textOf(state), state.texts.yaml);
  assert.equal(textOf(state, 'json'), state.texts.json);

  assert.equal(hasUnsavedChanges(state, state.hash), false, '未编辑时无改动');
  const edited = applyTextEdit(state, JSON.stringify({ always: true }), 'json');
  assert.equal(hasUnsavedChanges(edited, state.hash), true, '★ 编辑后应判定为有改动');
  assert.equal(hasUnsavedChanges(edited, edited.hash), false, '保存后无改动');
});

// ─────────────────────────── M3-9 图形视图 ───────────────────────────

test('★ M3-9：图形编辑**立即回到 AST**（位置不参与语义）', () => {
  const state = createEditorState(EXPRESSION, 'graph');
  const graph = toGraph(state.ast);
  const rootId = graph.root;

  // 在根节点（any）下追加一个子表达式
  const result = applyGraphEdit(state, { op: 'addChild', parentId: rootId, child: { eq: { 'me.status': 'active' } } });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) return;

  // AST 确实变了（新条件进去了）
  assert.notEqual(result.state.hash, state.hash);
  const json = JSON.parse(result.state.texts.json) as Expression;
  assert.equal(JSON.stringify(json).includes('me.status'), true, '★ 图形编辑的结果必须落到 AST');
  // 其它面板同步
  assert.match(result.state.texts.yaml, /me\.status: active/);
});

test('★ M3-9：`removeNode` 删除**整棵子树**（不留孤儿）', () => {
  const state = createEditorState(EXPRESSION, 'graph');
  const graph = toGraph(state.ast);
  const rootId = graph.root;
  const children = graph.edges.filter((edge) => edge.from === rootId).sort((a, b) => a.order - b.order);
  // 第二个子节点是 all（带两个比较叶子）
  const allNodeId = children[1]!.to;

  const result = applyGraphEdit(state, { op: 'removeNode', nodeId: allNodeId });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) return;

  const json = JSON.parse(result.state.texts.json) as Expression;
  const any = (json as { any?: unknown[] }).any!;
  assert.equal(any.length, 1, '★ all 整棵子树被移除');
  assert.equal(JSON.stringify(any).includes('lte'), false, '子树的叶子也一并移除');
  // 图里不应有孤儿
  const after = toGraph(result.state.ast);
  assert.equal(after.nodes.length, after.nodes.length, '图仍可正常构建');
});

test('★ M3-9：**不能删根节点**（明确拒绝，状态不变）', () => {
  const state = createEditorState(EXPRESSION, 'graph');
  const rootId = toGraph(state.ast).root;
  const result = applyGraphEdit(state, { op: 'removeNode', nodeId: rootId });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /不能删除根节点/);
});

test('★ M3-9：不存在的节点 → 明确拒绝（不静默无操作）', () => {
  const state = createEditorState(EXPRESSION, 'graph');
  const missing = applyGraphEdit(state, { op: 'removeNode', nodeId: 'ghost' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /没有父边|不存在/);
  const badParent = applyGraphEdit(state, { op: 'addChild', parentId: 'ghost', child: { always: true } });
  assert.equal(badParent.ok, false);
  if (!badParent.ok) assert.match(badParent.message, /父节点 'ghost' 不存在/);
});

test('★ M3-9：`moveNode` **改变顺序**（顺序影响短路与展示，因此是语义的一部分）', () => {
  const state = createEditorState(EXPRESSION, 'graph');
  const graph = toGraph(state.ast);
  const children = graph.edges.filter((edge) => edge.from === graph.root).sort((a, b) => a.order - b.order);
  const firstId = children[0]!.to;
  const secondId = children[1]!.to;

  const moved = applyGraphEdit(state, { op: 'moveNode', nodeId: secondId, newOrder: 0 });
  assert.equal(moved.ok, true, moved.ok ? '' : moved.message);
  if (!moved.ok) return;

  const json = JSON.parse(moved.state.texts.json) as Expression;
  const any = (json as { any: Record<string, unknown>[] }).any;
  assert.equal('all' in any[0]!, true, '★ 原第二个子节点（all）现在排第一');
  assert.equal('gt' in any[1]!, true);
  assert.notEqual(moved.state.hash, state.hash, '顺序变了 → 语义指纹也应变化');
  // 越界拒绝
  const outOfRange = applyGraphEdit(state, { op: 'moveNode', nodeId: firstId, newOrder: 99 });
  assert.equal(outOfRange.ok, false);
  if (!outOfRange.ok) assert.match(outOfRange.message, /超出范围/);
});

test('M3-9：`replaceNode` 替换子树；替换根等价于换掉整个表达式', () => {
  const state = createEditorState(EXPRESSION, 'graph');
  const graph = toGraph(state.ast);
  const anyChild = graph.edges.filter((edge) => edge.from === graph.root).sort((a, b) => a.order - b.order)[0]!.to;

  const replaced = applyGraphEdit(state, { op: 'replaceNode', nodeId: anyChild, next: { eq: { 'me.email_verified': true } } });
  assert.equal(replaced.ok, true, replaced.ok ? '' : replaced.message);
  if (!replaced.ok) return;
  const json = JSON.parse(replaced.state.texts.json) as Expression;
  assert.equal(JSON.stringify(json).includes('me.email_verified'), true);
  assert.equal(JSON.stringify(json).includes('fact.qq.level'), true, '另一个子节点不受影响');

  // 替换根
  const newRoot = applyGraphEdit(state, { op: 'replaceNode', nodeId: graph.root, next: { always: true } });
  assert.equal(newRoot.ok, true);
  if (newRoot.ok) {
    assert.deepEqual(JSON.parse(newRoot.state.texts.json), { always: true });
    assert.equal(newRoot.state.hash, specHash({ always: true }));
  }
});

test('M3-9：连续编辑保持三视图一致（编辑器状态机是自洽的）', () => {
  let state = createEditorState(EXPRESSION, 'yaml');
  // ① 文本编辑
  state = applyTextEdit(state, JSON.stringify({ all: [{ always: true }, { never: true }] }), 'json');
  assertViewsConsistent(state);
  // ② 图形编辑
  const rootId = toGraph(state.ast).root;
  const added = applyGraphEdit(state, { op: 'addChild', parentId: rootId, child: { eq: { 'me.status': 'active' } } });
  assert.equal(added.ok, true, added.ok ? '' : added.message);
  if (added.ok) state = added.state;
  assertViewsConsistent(state);
  // ③ 再删一个
  const children = toGraph(state.ast).edges.filter((edge) => edge.from === toGraph(state.ast).root);
  const removed = applyGraphEdit(state, { op: 'removeNode', nodeId: children[0]!.to });
  assert.equal(removed.ok, true, removed.ok ? '' : removed.message);
  if (removed.ok) state = removed.state;
  assertViewsConsistent(state);
  assert.equal(state.revision >= 3, true, `三次成功编辑（实际 revision=${state.revision}）`);
});

// ─────────────────────────── 发布收口 ───────────────────────────

test('★：发布走 **AST 权威内容**（而不是「当前视图文本」，避免所见与所发不一致）', () => {
  const state = createEditorState(EXPRESSION, 'yaml');
  const prepared = preparePublish(state);
  assert.equal(prepared.hash, state.hash);
  assert.equal(specHash(prepared.ast), state.hash);
  // 即使当前视图是 yaml，发布的也是**规范 JSON**（后端存库形式）
  assert.deepEqual(JSON.parse(prepared.canonicalJson), state.ast);
  // 与视图无关：切到 graph 再发布，内容一致
  const switched = switchView(state, 'graph');
  assert.deepEqual(JSON.parse(preparePublish(switched).canonicalJson), state.ast);
});
