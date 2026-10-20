import { test } from "node:test";
import { strict as assert } from "node:assert";
import { addTask, emptyState, newPlan, ordered, setStatus } from "./model.ts";

test("a new plan numbers tasks in order and starts the first", () => {
  const state = newPlan(["A", "B", "C"]);
  assert.deepEqual(state.tasks, [
    { id: 1, subject: "A", status: "in_progress" },
    { id: 2, subject: "B", status: "pending" },
    { id: 3, subject: "C", status: "pending" },
  ]);
  assert.equal(state.nextId, 4);
  assert.deepEqual(newPlan([]), emptyState());
});

test("added tasks take the next id and may name a parent", () => {
  let state = addTask(newPlan(["A"]), "B");
  state = addTask(state, "B1", 2);
  assert.deepEqual(state.tasks.map(task => [task.id, task.parentId]), [[1, undefined], [2, undefined], [3, 2]]);
  assert.equal(state.nextId, 4);
});

test("setStatus changes one task and leaves the original state untouched", () => {
  const before = newPlan(["A", "B"]);
  const after = setStatus(before, 2, "completed");
  assert.deepEqual(after.tasks.map(task => task.status), ["in_progress", "completed"]);
  assert.deepEqual(before.tasks.map(task => task.status), ["in_progress", "pending"]);
});

test("display order puts each task before its subtasks and promotes orphans to roots", () => {
  const tasks = [
    { id: 1, subject: "Root", status: "pending" as const },
    { id: 2, subject: "Second root", status: "pending" as const },
    { id: 3, subject: "Child", status: "pending" as const, parentId: 1 },
    { id: 4, subject: "Grandchild", status: "pending" as const, parentId: 3 },
    { id: 5, subject: "Orphan", status: "pending" as const, parentId: 9 },
  ];
  assert.deepEqual(ordered(tasks).map(task => task.id), [1, 3, 4, 2, 5]);
});
