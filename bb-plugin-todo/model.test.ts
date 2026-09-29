import test from "node:test";
import assert from "node:assert/strict";
import { emptyState, replayCall, replayCalls } from "./model.ts";

test("Pi batch creates a cycle atomically; updates, tombstones and rollover keep monotonic IDs", () => {
  let state = replayCalls([{ action: "batch", operations: [
    { action: "create", subject: "One", status: "in_progress" },
    { action: "create", subject: "Two" },
  ] }]);
  assert.deepEqual(state.tasks.map(t => t.status), ["in_progress", "pending"]);
  state = replayCall(state, { action: "update", id: 1, status: "completed" });
  state = replayCall(state, { action: "delete", id: 2 });
  assert.deepEqual(state.tasks.map(t => t.status), ["completed", "deleted"]);
  state = replayCall(state, { action: "batch", operations: [
    { action: "create", subject: "Next" }, { action: "create", subject: "Later" },
  ] });
  assert.deepEqual(state.tasks.map(t => t.id), [3, 4]);
  assert.equal(state.nextId, 5);
});

test("invalid batch rolls back; queries and impossible transitions do not mutate", () => {
  const before = replayCalls([{ action: "batch", operations: [
    { action: "create", subject: "First" }, { action: "create", subject: "Second" },
  ] }]);
  assert.strictEqual(replayCall(before, { action: "batch", operations: [
    { action: "create", subject: "Second" }, { action: "update", id: 99, status: "completed" },
  ] }), before);
  assert.strictEqual(replayCall(before, { action: "list" }), before);
  const completed = replayCall(before, { action: "update", id: 1, status: "completed" });
  assert.strictEqual(replayCall(completed, { action: "update", id: 1, status: "pending" }), completed);
});

test("retains hierarchy/dependencies only when call args emit them", () => {
  let state = replayCalls([{ action: "batch", operations: [
    { action: "create", subject: "Parent" }, { action: "create", subject: "Sibling" },
  ] }]);
  state = replayCall(state, { action: "create", subject: "Child", parentId: 1, blockedBy: [1] });
  assert.equal(state.tasks[2]?.parentId, 1);
  assert.deepEqual(state.tasks[2]?.blockedBy, [1]);
  state = replayCall(state, { action: "update", id: 3, removeBlockedBy: [1], parentId: null });
  assert.equal(state.tasks[2]?.parentId, undefined);
  assert.deepEqual(state.tasks[2]?.blockedBy, []);
  assert.equal(state.tasks[0]?.parentId, undefined);
});
