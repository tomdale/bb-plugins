import test from "node:test";
import assert from "node:assert/strict";
import { buildCardView, collapsedSummary, rowIcon, rowState, tasksForRunState } from "./card.ts";
import type { Task } from "./model.ts";

const task = (id: number, status: Task["status"], extra: Partial<Task> = {}): Task => ({ id, subject: `Task ${id}`, status, ...extra });

test("flat task lists preserve explicit order", () => {
  const view = buildCardView([task(1, "completed"), task(2, "pending"), task(3, "in_progress"), task(4, "pending")]);
  assert.deepEqual(view.rows.map(row => [row.task.id, row.depth]), [[1, 0], [2, 0], [3, 0], [4, 0]]);
  assert.equal(view.total, 4);
  assert.equal(view.completed, 1);
  assert.equal(view.allComplete, false);
  assert.deepEqual(view.collapsedRows.map(row => row.task.id), [3]);
});

test("nests parent tasks and promotes orphans without inventing structure", () => {
  const view = buildCardView([
    task(1, "pending"), task(2, "completed", { parentId: 1 }), task(3, "in_progress", { parentId: 1 }),
    task(4, "pending", { parentId: 3 }), task(5, "pending", { parentId: 9 }),
  ]);
  assert.deepEqual(view.rows.map(row => [row.task.id, row.depth]), [[1, 0], [2, 1], [3, 1], [4, 2], [5, 0]]);
  assert.deepEqual(view.roots.map(node => node.row.task.id), [1, 5]);
  assert.deepEqual(view.roots[0]!.children.map(node => node.row.task.id), [2, 3]);
  assert.deepEqual(view.roots[0]!.children[1]!.children.map(node => node.row.task.id), [4]);
});

test("collapsed rows list in-progress tasks flat, whatever their depth", () => {
  const view = buildCardView([task(1, "in_progress"), task(2, "in_progress", { parentId: 1 }), task(3, "pending")]);
  assert.deepEqual(view.collapsedRows.map(row => [row.task.id, row.depth]), [[1, 0], [2, 0]]);
});

test("summarizes progress and detects a finished plan", () => {
  const partial = buildCardView([task(1, "completed"), task(2, "pending")]);
  assert.equal(collapsedSummary(partial), "1 of 2 todos done");
  const done = buildCardView([task(1, "completed"), task(2, "completed")]);
  assert.equal(done.allComplete, true);
  assert.equal(collapsedSummary(done), "2 todos complete");
  assert.equal(buildCardView([]).allComplete, false);
});

test("an idle thread shows in-progress tasks as pending", () => {
  const tasks = [task(1, "in_progress"), task(2, "completed")];
  assert.deepEqual(tasksForRunState(tasks, true).map(t => t.status), ["in_progress", "completed"]);
  assert.deepEqual(tasksForRunState(tasks, false).map(t => t.status), ["pending", "completed"]);
});

test("row state and icon follow the task status", () => {
  const row = (status: Task["status"]) => ({ task: task(1, status), depth: 0 });
  assert.deepEqual(["pending", "in_progress", "completed"].map(status => rowState(row(status as Task["status"]))), ["pending", "active", "completed"]);
  assert.deepEqual(["pending", "in_progress", "completed"].map(status => rowIcon(row(status as Task["status"]))), ["Circle", "Spinner", "CircleCheck"]);
});
