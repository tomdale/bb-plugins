import test from "node:test";
import assert from "node:assert/strict";
import { blockerCandidates, buildEditorView, statusOptions, structuralChange, type EditorNode } from "./editor-model.ts";
import { apply, type State, type Task } from "./model.ts";

const task = (id: number, status: Task["status"], extra: Partial<Task> = {}): Task => ({ id, subject: `Task ${id}`, status, ...extra });
const flatten = (nodes: EditorNode[]): EditorNode[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
const find = (nodes: EditorNode[], id: number) => flatten(nodes).find(node => node.task.id === id)!;

test("nests visible tasks, hides tombstones, and promotes orphans", () => {
  const view = buildEditorView([task(1, "pending"), task(2, "pending", { parentId: 1 }), task(3, "deleted"), task(4, "pending", { parentId: 3 }), task(5, "completed")]);
  assert.deepEqual(view.roots.map(node => node.task.id), [1, 4, 5]);
  assert.deepEqual(view.roots[0]!.children.map(node => [node.task.id, node.depth]), [[2, 1]]);
  assert.deepEqual(view.ordered.map(item => item.id), [1, 2, 4, 5]);
  assert.equal(view.total, 4);
  assert.equal(view.completed, 1);
});

test("offers only the structural moves that apply at each position", () => {
  const view = buildEditorView([task(1, "pending"), task(2, "pending"), task(3, "pending", { parentId: 2 }), task(4, "pending", { parentId: 3 })]);
  const first = find(view.roots, 1), second = find(view.roots, 2), child = find(view.roots, 3), grandchild = find(view.roots, 4);
  assert.deepEqual([first.canMoveUp, first.canMoveDown, first.indentParentId, first.outdentParentId], [false, true, undefined, undefined]);
  assert.deepEqual([second.canMoveUp, second.canMoveDown, second.indentParentId], [true, false, 1]);
  assert.equal(child.outdentParentId, null);
  assert.equal(grandchild.outdentParentId, 2);
  assert.deepEqual(structuralChange(second, "indent"), { action: "update", id: 2, parentId: 1 });
  assert.deepEqual(structuralChange(grandchild, "outdent"), { action: "update", id: 4, parentId: 2 });
  assert.deepEqual(structuralChange(child, "outdent"), { action: "update", id: 3, parentId: null });
  assert.equal(structuralChange(first, "up"), null);
  assert.equal(structuralChange(first, "indent"), null);
});

test("structural changes are accepted by the reducer", () => {
  let state: State = { tasks: [task(1, "pending"), task(2, "pending"), task(3, "pending")], nextId: 4 };
  const run = (id: number, command: "up" | "down" | "indent" | "outdent") => {
    const change = structuralChange(find(buildEditorView(state.tasks).roots, id), command);
    assert.ok(change);
    state = apply(state, change).state;
  };
  run(3, "up");
  assert.deepEqual(buildEditorView(state.tasks).ordered.map(item => item.id), [1, 3, 2]);
  run(3, "indent");
  assert.equal(state.tasks.find(item => item.id === 3)?.parentId, 1);
  run(3, "outdent");
  assert.equal(state.tasks.find(item => item.id === 3)?.parentId, undefined);
});

test("outdents a parent-cycle member to the root instead of onto itself", () => {
  const view = buildEditorView([task(1, "pending", { parentId: 2 }), task(2, "pending", { parentId: 1 })]);
  assert.equal(find(view.roots, 2).outdentParentId, null);
});

test("tracks unfinished blockers and the tasks each one blocks", () => {
  const view = buildEditorView([task(1, "completed"), task(2, "pending"), task(3, "pending", { blockedBy: [1, 2, 9] })]);
  assert.deepEqual(find(view.roots, 3).waitingOn, [2]);
  assert.deepEqual(find(view.roots, 2).blocks, [3]);
  assert.deepEqual(find(view.roots, 1).blocks, [3]);
  assert.deepEqual(blockerCandidates(view.ordered[2]!, view.ordered).map(item => item.id), []);
  assert.deepEqual(blockerCandidates(view.ordered[0]!, view.ordered).map(item => item.id), [2, 3]);
});

test("status options allow concurrent work and keep completion terminal", () => {
  const tasks = [task(1, "in_progress"), task(2, "pending"), task(3, "completed")];
  const disabled = (id: number) => statusOptions(tasks.find(item => item.id === id)!).filter(option => option.disabled).map(option => option.status);
  assert.deepEqual(disabled(1), []);
  assert.deepEqual(disabled(2), []);
  assert.equal(statusOptions(tasks[1]!)[1]!.reason, undefined);
  assert.deepEqual(disabled(3), ["pending", "in_progress"]);
});
