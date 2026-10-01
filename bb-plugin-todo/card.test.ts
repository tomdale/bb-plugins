import test from "node:test";
import assert from "node:assert/strict";
import { autoExpanded, buildCardView, currentLabel, rowIcon, rowState, tasksForRunState } from "./card.ts";
import type { Task } from "./model.ts";

const task = (id: number, status: Task["status"], extra: Partial<Task> = {}): Task => ({ id, subject: `Task ${id}`, status, ...extra });

test("flat task lists preserve explicit order without ids", () => {
  const view = buildCardView([task(1, "completed"), task(2, "pending"), task(3, "in_progress"), task(4, "deleted"), task(5, "pending")]);
  assert.deepEqual(view.rows.map(row => [row.task.id, row.depth]), [[1, 0], [2, 0], [3, 0], [5, 0]]);
  assert.equal(view.total, 4);
  assert.equal(view.completed, 1);
  assert.equal(view.showIds, false);
  assert.equal(currentLabel(view), "Task 3");
});

test("header prefers activeForm and drops the current task once everything is complete", () => {
  assert.equal(currentLabel(buildCardView([task(1, "in_progress", { activeForm: "Porting styles" }), task(2, "pending")])), "Porting styles");
  const done = buildCardView([task(1, "completed"), task(2, "completed"), task(3, "deleted")]);
  assert.equal(done.allComplete, true);
  assert.equal(currentLabel(done), null);
});

test("nests parent tasks and promotes orphans without inventing structure", () => {
  const view = buildCardView([
    task(1, "pending"), task(2, "completed", { parentId: 1 }), task(3, "in_progress", { parentId: 1 }),
    task(4, "pending", { parentId: 3 }), task(5, "pending", { parentId: 9 }), task(6, "pending", { parentId: 7 }), task(7, "deleted"),
  ]);
  assert.deepEqual(view.rows.map(row => [row.task.id, row.depth]), [[1, 0], [2, 1], [3, 1], [4, 2], [5, 0], [6, 0]]);
});

test("keeps parent cycles visible", () => {
  const view = buildCardView([task(1, "pending", { parentId: 2 }), task(2, "pending", { parentId: 1 })]);
  assert.deepEqual(view.rows.map(row => [row.task.id, row.depth]), [[1, 0], [2, 1]]);
});

test("labels only unfinished, visible blockers on pending tasks and shows ids for them", () => {
  const view = buildCardView([
    task(1, "completed"), task(2, "in_progress"), task(3, "deleted"),
    task(4, "pending", { blockedBy: [1, 2, 3, 99, 4] }), task(5, "in_progress", { blockedBy: [2] }),
  ]);
  assert.deepEqual(view.rows.find(row => row.task.id === 4)?.blockers, [2]);
  assert.deepEqual(view.rows.find(row => row.task.id === 5)?.blockers, []);
  assert.equal(view.showIds, true);
  assert.equal(buildCardView([task(1, "completed"), task(2, "pending", { blockedBy: [1] })]).showIds, false);
});

test("maps row state to the circle-family status icons", () => {
  const view = buildCardView([task(1, "in_progress"), task(2, "pending"), task(3, "completed"), task(4, "pending", { blockedBy: [2] })]);
  assert.deepEqual(view.rows.map(rowState), ["active", "pending", "completed", "blocked"]);
  assert.deepEqual(view.rows.map(rowIcon), ["Spinner", "Circle", "CircleCheck", "Lock"]);
});

test("treats an idle snapshot's in-progress task as pending, but preserves it while running", () => {
  const snapshot = [task(1, "in_progress"), task(2, "pending")];
  const idle = buildCardView(tasksForRunState(snapshot, false));
  assert.equal(idle.current, undefined);
  assert.equal(idle.rows[0]?.task.status, "pending");
  assert.equal(rowIcon(idle.rows[0]!), "Circle");

  const running = buildCardView(tasksForRunState(snapshot, true));
  assert.equal(running.current?.id, 1);
  assert.equal(rowIcon(running.rows[0]!), "Spinner");
});

test("collapsed previews show every active task, or next two pending, or completed when all complete", () => {
  const tasks = [task(1, "completed"), task(2, "pending"), task(3, "in_progress", { parentId: 2 }), task(4, "in_progress"), task(5, "in_progress"), task(6, "pending"), task(7, "pending"), task(8, "deleted")];
  const active = buildCardView(tasks);
  assert.deepEqual(active.collapsedRows.map(row => [row.task.id, row.depth]), [[3, 0], [4, 0], [5, 0]]);
  const idle = buildCardView(tasksForRunState(tasks, false));
  assert.deepEqual(idle.collapsedRows.map(row => row.task.id), [2, 3]);

  const completed = buildCardView([task(1, "completed"), task(2, "completed"), task(3, "completed"), task(4, "deleted")]);
  assert.deepEqual(completed.collapsedRows.map(row => row.task.id), [1, 2]);

  const singleCompleted = buildCardView([task(1, "completed"), task(2, "deleted")]);
  assert.deepEqual(singleCompleted.collapsedRows.map(row => row.task.id), [1]);

  assert.deepEqual(buildCardView([]).collapsedRows, []);
});

test("opens automatically only while running with a task in progress", () => {
  const working = buildCardView([task(1, "in_progress"), task(2, "pending")]);
  assert.equal(autoExpanded(working, true), true);
  assert.equal(autoExpanded(working, false), false);
  assert.equal(autoExpanded(buildCardView([task(1, "pending"), task(2, "pending")]), true), false);
  assert.equal(autoExpanded(buildCardView([task(1, "completed"), task(2, "completed")]), true), false);
});
