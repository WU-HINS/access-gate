/**
 * 表达式编辑器：三视图状态机（M3-8 / M3-9）—— docs/04 §1.2.6、docs/06 §9。
 *
 * | 视图 | 面向 | 用法 |
 * |---|---|---|
 * | YAML | 人 | 手写、Git 管理、Code Review |
 * | JSON | 程序 | API 传输、SDK 构造 |
 * | Graph | 图形编辑器 | 拖拽、大策略的全局把握 |
 *
 * ★ 验收标准（docs/07 M3-8/M3-9）：**「切换后发布，行为一致」**（M6-10 已从策略层验证过），
 *   而编辑器这一层的验收是更具体的两条：
 *
 * 1. **切换视图不改变语义**——三种视图是同一个 AST 的投影；
 * 2. **编辑任一面板，其它面板同步**——这是「不漂移」的可操作含义。
 *
 * ★ 本模块最重要的一条设计：**以 AST 为单一事实来源，文本只是它的投影**。
 *
 *   反例（常见的编辑器实现）：把「当前文本框的内容」当作状态。
 *   于是「在 YAML 面板改了内容但没切回 JSON 面板」时，两个面板**不一致**——
 *   而用户看到的是「我明明改了，怎么发布出去的还是旧的」。
 *   正确做法：每次编辑都**立即解析回 AST**（失败则拒绝并保留旧 AST），
 *   其它面板从 AST 重新渲染。这样**任何时刻三个面板都一致**。
 *
 * ★ 第二条：**图形编辑操作在 Graph 上做，但立即回到 AST**。
 *   若把图当状态（拖拽位置也参与语义），就会出现「只挪了节点位置却改了判定逻辑」
 *   这类荒谬结果。因此位置/布局**永远不进 AST**（M3-6 的保真规则已确立这一点）。
 */

import {
  formatAs,
  fromGraph,
  parseInFormat,
  specHash,
  toGraph,
  type ExprGraph,
  type ExpressionFormat,
} from './expr-forms.ts';
import type { Expression } from './expr.ts';

// ─────────────────────────── 状态 ───────────────────────────

export interface EditorState {
  /** ★ 单一事实来源 */
  ast: Expression;
  /** 当前激活的视图 */
  view: ExpressionFormat;
  /** 各视图的文本缓存（从 AST 渲染；编辑时同步刷新） */
  texts: Record<ExpressionFormat, string>;
  /** AST 的语义指纹（用于「是否有未保存改动」的判定） */
  hash: string;
  /** 最近一次编辑是否成功（失败时 AST 不变） */
  lastEditOk: boolean;
  /** 最近一次编辑的错误（解析失败时给出） */
  lastError?: { message: string; view: ExpressionFormat };
  /** 累计编辑次数（供 UI 展示「已修改」） */
  revision: number;
}

export class EditorError extends Error {
  override readonly name = 'EditorError';
  readonly view: ExpressionFormat;
  constructor(view: ExpressionFormat, message: string) {
    super(`${view} 视图内容无效：${message}`);
    this.view = view;
  }
}

/** 从 AST 渲染三个视图的文本（**唯一**的渲染入口）。 */
function renderAll(ast: Expression): Record<ExpressionFormat, string> {
  return {
    yaml: formatAs(ast, 'yaml'),
    json: formatAs(ast, 'json'),
    graph: formatAs(ast, 'graph'),
  };
}

/** 创建编辑器状态。 */
export function createEditorState(ast: Expression, view: ExpressionFormat = 'yaml'): EditorState {
  return { ast, view, texts: renderAll(ast), hash: specHash(ast), lastEditOk: true, revision: 0 };
}

// ─────────────────────────── 视图切换（M3-8 / M3-9） ───────────────────────────

/**
 * 切换视图。
 *
 * ★ 切换**只改 `view`**，并在切换时用 AST 重新渲染目标视图——
 *   这样「在上一个视图里的手工格式（缩进、注释位置）会丢失」，
 *   但**语义永远不会因切换而变化**。这是刻意的取舍：
 *   宁可丢掉格式，也不能让「切一下视图」改变判定逻辑。
 */
export function switchView(state: EditorState, view: ExpressionFormat): EditorState {
  return { ...state, view, texts: renderAll(state.ast) };
}

/** 取当前视图的文本（供 UI 渲染文本框）。 */
export function textOf(state: EditorState, view?: ExpressionFormat): string {
  return state.texts[view ?? state.view];
}

// ─────────────────────────── 文本编辑 ───────────────────────────

/**
 * 应用一次文本编辑（**立即解析回 AST**）。
 *
 * ★ 三条语义：
 *   1. **解析失败 → AST 不变**，只记录错误（用户继续编辑，不必回退）；
 *      ★ 若失败时把文本写进状态而 AST 不动，两个面板就会不一致——
 *        因此失败时**文本也不写入状态**（保持「状态永远自洽」）。
 *   2. 解析成功 → 更新 AST 并**重新渲染所有视图**（其它面板同步）；
 *   3. 每次成功编辑**递增 revision**（供「有未保存改动」判定）。
 */
export function applyTextEdit(state: EditorState, text: string, view: ExpressionFormat = state.view): EditorState {
  let parsed: Expression;
  try {
    parsed = parseInFormat(text, view);
    // ★ 解析成功**不等于**AST 合法：`parseInFormat` 可能接受「数组元素不是对象」
    //   这类结构，而它在**渲染**时才抛错。若不在这里校验，状态里就会存一个
    //   「渲染即抛错」的 AST——后续每次切视图都会炸，而用户以为自己保存成功了。
    //   做法：解析后立即渲染一次三视图（渲染通过才认为这次编辑有效）。
    renderAll(parsed);
  } catch (error) {
    return {
      ...state,
      lastEditOk: false,
      lastError: { view, message: error instanceof Error ? error.message : String(error) },
    };
  }
  return {
    ast: parsed,
    view,
    texts: renderAll(parsed),
    hash: specHash(parsed),
    lastEditOk: true,
    revision: state.revision + 1,
  };
}

// ─────────────────────────── 图形编辑（M3-9） ───────────────────────────

/** 图上的可编辑操作（**位置不参与**，只改结构）。 */
export type GraphEdit =
  | { op: 'addChild'; parentId: string; child: Expression; order?: number }
  | { op: 'removeNode'; nodeId: string }
  | { op: 'moveNode'; nodeId: string; newOrder: number }
  | { op: 'replaceNode'; nodeId: string; next: Expression };

export type GraphEditResult =
  | { ok: true; state: EditorState; graph: ExprGraph }
  | { ok: false; message: string };

/**
 * 在图上执行一次结构编辑，并**立即回到 AST**。
 *
 * ★ 实现方式刻意选择「**回到 AST 再重建图**」而不是「直接改图的数据结构」：
 *   - 图里包含布局（`position`）、节点 id 等**非语义**信息；
 *   - 若直接在图上改，就必须保证「改动后图仍能无损转回 AST」，
 *     而这是**每个操作各自要维护的不变量**（容易漏）。
 *   回到 AST 重建则**只需一次转换**，正确性由 M3-6 的往返保真保证。
 */
export function applyGraphEdit(state: EditorState, edit: GraphEdit): GraphEditResult {
  const graph = toGraph(state.ast);

  // ① 定位父节点与其子边（按 order 排序，保持顺序语义）
  const childrenOf = (parentId: string): { nodeId: string; order: number }[] =>
    graph.edges.filter((edge) => edge.from === parentId).sort((a, b) => a.order - b.order).map((edge) => ({ nodeId: edge.to, order: edge.order }));

  try {
    switch (edit.op) {
      case 'addChild': {
        const parent = graph.nodes.find((node) => node.id === edit.parentId);
        if (parent === undefined) return { ok: false, message: `父节点 '${edit.parentId}' 不存在` };
        const newId = `added${graph.nodes.length + 1}`;
        const childGraph = toGraph(edit.child);
        // 把子表达式的图整体并入（重命名其内部 id 避免冲突）
        const prefix = `${newId}_`;
        for (const node of childGraph.nodes) {
          graph.nodes.push({ ...node, id: `${prefix}${node.id}` });
        }
        for (const edge of childGraph.edges) {
          graph.edges.push({ ...edge, from: `${prefix}${edge.from}`, to: `${prefix}${edge.to}` });
        }
        const existing = childrenOf(edit.parentId);
        const order = edit.order ?? existing.length;
        graph.edges.push({ from: edit.parentId, to: `${prefix}${childGraph.root}`, order });
        break;
      }
      case 'removeNode': {
        if (edit.nodeId === graph.root) return { ok: false, message: '不能删除根节点（请用 replaceNode 换成 other 表达式）' };
        const parentEdge = graph.edges.find((edge) => edge.to === edit.nodeId);
        if (parentEdge === undefined) return { ok: false, message: `节点 '${edit.nodeId}' 没有父边（不是可达节点）` };
        // 删除该节点及其整棵子树
        const doomed = new Set<string>([edit.nodeId]);
        const collect = (id: string): void => {
          for (const edge of graph.edges) {
            if (edge.from === id && !doomed.has(edge.to)) {
              doomed.add(edge.to);
              collect(edge.to);
            }
          }
        };
        collect(edit.nodeId);
        graph.nodes = graph.nodes.filter((node) => !doomed.has(node.id));
        graph.edges = graph.edges.filter((edge) => !doomed.has(edge.from) && !doomed.has(edge.to));
        break;
      }
      case 'moveNode': {
        const parentEdge = graph.edges.find((edge) => edge.to === edit.nodeId);
        if (parentEdge === undefined) return { ok: false, message: `节点 '${edit.nodeId}' 没有父边` };
        const siblings = childrenOf(parentEdge.from);
        if (edit.newOrder < 0 || edit.newOrder >= siblings.length) {
          return { ok: false, message: `新位置 ${edit.newOrder} 超出范围（0..${siblings.length - 1}）` };
        }
        // 重新编号：把该节点抽出来插到目标位置
        const others = siblings.filter((entry) => entry.nodeId !== edit.nodeId);
        const reordered = [...others.slice(0, edit.newOrder), { nodeId: edit.nodeId, order: -1 }, ...others.slice(edit.newOrder)];
        for (const [index, entry] of reordered.entries()) {
          const edge = graph.edges.find((candidate) => candidate.to === entry.nodeId && candidate.from === parentEdge.from);
          if (edge !== undefined) edge.order = index;
        }
        break;
      }
      case 'replaceNode': {
        const target = graph.nodes.find((node) => node.id === edit.nodeId);
        if (target === undefined) return { ok: false, message: `节点 '${edit.nodeId}' 不存在` };
        const replacement = toGraph(edit.next);
        if (edit.nodeId === graph.root) {
          // 替换根：直接用新图
          const state2 = applyTextEdit(state, formatAs(edit.next, 'json'), 'json');
          return { ok: true, state: state2, graph: toGraph(state2.ast) };
        }
        const parentEdge = graph.edges.find((edge) => edge.to === edit.nodeId);
        if (parentEdge === undefined) return { ok: false, message: `节点 '${edit.nodeId}' 没有父边` };
        const prefix = `repl${graph.nodes.length}_`;
        for (const node of replacement.nodes) graph.nodes.push({ ...node, id: `${prefix}${node.id}` });
        for (const edge of replacement.edges) graph.edges.push({ ...edge, from: `${prefix}${edge.from}`, to: `${prefix}${edge.to}` });
        // 断开旧子树
        const doomed = new Set<string>([edit.nodeId]);
        const collect = (id: string): void => {
          for (const edge of graph.edges) {
            if (edge.from === id && !doomed.has(edge.to)) {
              doomed.add(edge.to);
              collect(edge.to);
            }
          }
        };
        collect(edit.nodeId);
        graph.nodes = graph.nodes.filter((node) => !doomed.has(node.id));
        graph.edges = graph.edges.filter((edge) => !doomed.has(edge.from) && !doomed.has(edge.to));
        graph.edges.push({ from: parentEdge.from, to: `${prefix}${replacement.root}`, order: parentEdge.order });
        break;
      }
      default: {
        const exhaustive: never = edit;
        return { ok: false, message: `未知的图编辑操作：${JSON.stringify(exhaustive)}` };
      }
    }

    // ② ★ 回到 AST（结构正确性由 M3-6 的往返保真保证）
    const ast = fromGraph(graph);
    const next = applyTextEdit(state, formatAs(ast, 'json'), 'json');
    return { ok: true, state: next, graph: toGraph(next.ast) };
  } catch (error) {
    // 编辑导致图不合法（如把 all 的子节点全删了）→ 明确拒绝，状态不变
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// ─────────────────────────── 未保存改动与发布 ───────────────────────────

/** 是否有未保存改动（与「上次保存的指纹」比对）。 */
export function hasUnsavedChanges(state: EditorState, savedHash: string): boolean {
  return state.hash !== savedHash;
}

/**
 * 准备发布（走编辑器 → 发布这条链路的收口）。
 *
 * ★ 发布前**再比对一次指纹**：不是「重建文本」，而是**用 AST 的权威内容**。
 *   若直接把当前视图的文本（可能是用户正在输入、格式未整理的）交给后端，
 *   就会出现「编辑器所见」与「实际发布」不一致。
 */
export function preparePublish(state: EditorState): { ast: Expression; hash: string; canonicalJson: string } {
  return { ast: state.ast, hash: state.hash, canonicalJson: formatAs(state.ast, 'json') };
}
