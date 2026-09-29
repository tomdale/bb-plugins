import test from "node:test";
import assert from "node:assert/strict";
import { apply, initialState, type State } from "./model.ts";

function create(state: State, subject: string, extras: Parameters<typeof apply>[1] = { action: "create" }) {
  return apply(state, { action: "create", subject, ...extras }).state;
}

test("hierarchy and dependency IDs survive mutations and filter without flattening", () => {
  let state = create(initialState(), "Parent");
  state = create(state, "Prerequisite", { action: "create", parentId: 1 });
  state = create(state, "Child", { action: "create", parentId: 1, blockedBy: [2] });
  assert.deepEqual(state.tasks[2]?.blockedBy, [2]);
  assert.equal(state.tasks[2]?.parentId, 1);
  assert.throws(() => apply(state, { action: "update", id: 3, status: "in_progress" }), /unfinished dependencies/);
  state = apply(state, { action: "update", id: 2, status: "completed" }).state;
  state = apply(state, { action: "update", id: 3, status: "in_progress", activeForm: "working" }).state;
  assert.equal(state.tasks[2]?.activeForm, "working");
  assert.deepEqual(apply(state, { action: "list" }).result, [state.tasks[0], state.tasks[2]]);
  state = apply(state, { action: "delete", id: 1 }).state;
  assert.equal(state.tasks[2]?.parentId, 1);
  assert.equal(state.tasks[0]?.status, "deleted");
  assert.equal((apply(state, { action: "list", includeDeleted: true }).result as unknown[]).length, 3);
});

test("status transitions, one active task and tombstones", () => {
  let state = create(initialState(), "One", { action: "create", status: "in_progress" });
  assert.throws(() => create(state, "Two", { action: "create", status: "in_progress" }), /one task/);
  state = create(state, "Two");
  assert.throws(() => apply(state, { action: "update", id: 2, status: "in_progress" }), /one task/);
  state = apply(state, { action: "update", id: 1, status: "pending" }).state;
  state = apply(state, { action: "update", id: 2, status: "completed" }).state;
  assert.throws(() => apply(state, { action: "update", id: 2, status: "pending" }), /Illegal transition/);
  state = apply(state, { action: "delete", id: 2 }).state;
  assert.throws(() => apply(state, { action: "update", id: 2, status: "completed" }), /Illegal transition/);
  assert.throws(() => apply(state, { action: "delete", id: 2 }), /already deleted/);
});

test("reject graph cycles, invalid references, and invalid re-parenting without mutating input", () => {
  let state = create(initialState(), "A");
  state = create(state, "B", { action: "create", parentId: 1, blockedBy: [1] });
  const snapshot = JSON.stringify(state);
  assert.throws(() => apply(state, { action: "update", id: 1, parentId: 2 }), /Cycle/);
  assert.throws(() => apply(state, { action: "update", id: 1, addBlockedBy: [2] }), /Cycle/);
  assert.throws(() => apply(state, { action: "update", id: 2, addBlockedBy: [99] }), /Unknown dependency/);
  assert.throws(() => create(state, "C", { action: "create", parentId: 99 }), /Parent/);
  assert.equal(JSON.stringify(state), snapshot);
  state = apply(state, { action: "update", id: 2, parentId: null, removeBlockedBy: [1] }).state;
  assert.equal(state.tasks[1]?.parentId, undefined);
  assert.deepEqual(state.tasks[1]?.blockedBy, []);
});

test("cannot add unfinished blockers to an active or completed task", () => {
  let state = create(initialState(), "Active", { action: "create", status: "in_progress" });
  state = create(state, "Blocker");
  assert.throws(() => apply(state, { action: "update", id: 1, addBlockedBy: [2] }), /unfinished dependencies/);
  state = apply(state, { action: "update", id: 1, status: "completed" }).state;
  assert.throws(() => apply(state, { action: "update", id: 1, addBlockedBy: [2] }), /unfinished dependencies/);
});

test("reopening a prerequisite does not rewrite dependent history", () => {
  let state = create(initialState(), "Prerequisite");
  state = create(state, "Dependent", { action: "create", blockedBy: [1] });
  state = apply(state, { action: "update", id: 1, status: "completed" }).state;
  state = apply(state, { action: "update", id: 2, status: "completed" }).state;
  state = apply(state, { action: "delete", id: 1 }).state;
  assert.equal(state.tasks[1]?.status, "completed");
});

test("metadata merges, null deletes, and no-op updates reject", () => {
  let state = create(initialState(), "A", { action: "create", metadata: { a: 1 } });
  state = apply(state, { action: "update", id: 1, metadata: { a: null, b: "ok" } }).state;
  assert.deepEqual(state.tasks[0]?.metadata, { b: "ok" });
  assert.throws(() => apply(state, { action: "update", id: 1 }), /mutable field/);
});
