import { test } from "node:test";
import { strict as assert } from "node:assert";
import { apply, emptyState, type State } from "./model.ts";
const mutate = (state: State, input: Parameters<typeof apply>[1]) => apply(state, input).state;
test("creates hierarchy and blocking dependencies, then completes in sequence", () => {
  let state = mutate(emptyState(), { action: "create", subject: "Plan" });
  state = mutate(state, { action: "create", subject: "Build", parentId: 1 });
  state = mutate(state, { action: "create", subject: "Verify", parentId: 1, blockedBy: [2] });
  assert.deepEqual(state.tasks[2]?.blockedBy, [2]);
  assert.deepEqual(state.tasks.map(t => t.parentId), [undefined, 1, 1]);
  assert.throws(() => mutate(state, { action: "update", id: 2, addBlockedBy: [3] }), /cycle/);
  assert.throws(() => mutate(state, { action: "update", id: 1, parentId: 3 }), /cycle/);
  state = mutate(state, { action: "update", id: 2, status: "in_progress" });
  state = mutate(state, { action: "update", id: 1, status: "in_progress" });
  assert.deepEqual(state.tasks.filter(task => task.status === "in_progress").map(task => task.id), [1, 2]);
  state = mutate(state, { action: "update", id: 2, status: "completed" });
  assert.equal(state.tasks[1]?.status, "completed");
  assert.throws(() => mutate(state, { action: "update", id: 2, status: "pending" }), /illegal transition/);
  state = mutate(state, { action: "delete", id: 1 });
  assert.equal(state.tasks[1]?.parentId, 1);
  assert.equal(state.tasks[2]?.parentId, 1);
});
test("moves a sibling with its descendants", () => {
  let state = emptyState();
  for (const [subject, parentId] of [["Root", undefined], ["First", 1], ["Child", 2], ["Second", 1]] as const) {
    state = mutate(state, { action: "create", subject, parentId });
  }
  state = mutate(state, { action: "update", id: 4, move: "up" });
  assert.deepEqual(state.tasks.map(task => task.id), [1, 4, 2, 3]);
  state = mutate(state, { action: "update", id: 4, move: "down" });
  assert.deepEqual(state.tasks.map(task => task.id), [1, 2, 3, 4]);
});

test("moves a subtree past interleaved siblings and retains tombstones", () => {
  let state = emptyState();
  state = mutate(state, { action: "create", subject: "Root" });
  state = mutate(state, { action: "create", subject: "First", parentId: 1 });
  state = mutate(state, { action: "create", subject: "Second", parentId: 1 });
  state = mutate(state, { action: "create", subject: "Child of first", parentId: 2 });
  state = mutate(state, { action: "create", subject: "Third", parentId: 1 });
  state = mutate(state, { action: "create", subject: "Old" });
  state = mutate(state, { action: "delete", id: 6 });
  state = mutate(state, { action: "update", id: 2, move: "down" });
  assert.deepEqual(state.tasks.map(task => task.id), [1, 3, 2, 4, 5, 6]);
});

test("metadata merges and clear resets ids", () => {
  let state = mutate(emptyState(), { action: "create", subject: "One", metadata: { a: 1, b: 2 } });
  state = mutate(state, { action: "update", id: 1, metadata: { a: null, b: 3 } });
  assert.deepEqual(state.tasks[0]?.metadata, { b: 3 });
  state = mutate(state, { action: "clear" });
  assert.deepEqual(state, emptyState());
});
