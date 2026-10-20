import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentInput, applyAgentCall, renderPlan } from "./agent.ts";
import { emptyState, setStatus, type State } from "./model.ts";

const call = (state: State, args: Record<string, unknown>) => applyAgentCall(state, agentInput.parse(args));
const plan = (...subjects: string[]) => call(emptyState(), { tasks: subjects }).state;
const statuses = (state: State) => state.tasks.map(task => task.status);

test("tasks declares a plan whose first task starts", () => {
  const { state, message, changed } = call(emptyState(), { tasks: ["Inspect", "Fix", "Verify"] });
  assert.deepEqual(state.tasks.map(task => [task.id, task.subject, task.status]), [[1, "Inspect", "in_progress"], [2, "Fix", "pending"], [3, "Verify", "pending"]]);
  assert.equal(message, "Plan 0/3 done\n▶ 1 Inspect\n○ 2 Fix\n○ 3 Verify");
  assert.equal(changed, true);
});

test("tasks replaces an existing plan and restarts ids", () => {
  const state = call(plan("A", "B"), { tasks: ["C"] }).state;
  assert.deepEqual(state.tasks.map(task => [task.id, task.subject]), [[1, "C"]]);
});

test("done completes a task and starts the next pending one", () => {
  const first = call(plan("A", "B", "C"), { done: [1] });
  assert.deepEqual(statuses(first.state), ["completed", "in_progress", "pending"]);
  assert.equal(first.message, "Plan 1/3 done\n✓ 1 A\n▶ 2 B\n○ 3 C");
  assert.deepEqual(statuses(call(first.state, { done: [2, 3] }).state), ["completed", "completed", "completed"]);
});

test("done leaves a task that is still in progress as the current one", () => {
  const state = call(plan("A", "B", "C"), { start: [2] }).state;
  assert.deepEqual(statuses(state), ["in_progress", "in_progress", "pending"]);
  assert.deepEqual(statuses(call(state, { done: [1] }).state), ["completed", "in_progress", "pending"]);
});

test("an explicit start in the same call suppresses the automatic one", () => {
  assert.deepEqual(statuses(call(plan("A", "B", "C"), { done: [1], start: [3] }).state), ["completed", "pending", "in_progress"]);
});

test("start resumes pending work and reports completed tasks", () => {
  let state = plan("A", "B");
  state = call(state, { done: [1] }).state;
  const reply = call(state, { start: [1] });
  assert.match(reply.message, /^#1 is already completed\n/);
  assert.equal(reply.changed, false);
  const paused = setStatus(state, 2, "pending");
  assert.deepEqual(statuses(call(paused, { start: [2] }).state), ["completed", "in_progress"]);
});

test("add appends tasks and starts one when nothing is in progress", () => {
  const appended = call(plan("A", "B"), { add: ["C"] });
  assert.deepEqual(appended.state.tasks.map(task => [task.id, task.status]), [[1, "in_progress"], [2, "pending"], [3, "pending"]]);
  const finished = call(call(plan("A"), { done: [1] }).state, { add: ["B"] });
  assert.deepEqual(statuses(finished.state), ["completed", "in_progress"]);
  assert.deepEqual(statuses(call(emptyState(), { add: ["A", "B"] }).state), ["in_progress", "pending"]);
});

test("unknown and repeated ids are reported while the rest applies", () => {
  const reply = call(plan("A", "B"), { done: [1, 1, 7], start: [8] });
  assert.deepEqual(statuses(reply.state), ["completed", "in_progress"]);
  assert.match(reply.message, /^No task #7, #8\nPlan 1\/2 done/);
});

test("an empty call reads the plan without changing it", () => {
  const state = plan("A");
  const reply = call(state, {});
  assert.equal(reply.changed, false);
  assert.equal(reply.state, state);
  assert.equal(call(emptyState(), {}).message, "No tasks");
});

test("blank values are absent and bare items become lists", () => {
  const parsed = (args: Record<string, unknown>) => JSON.parse(JSON.stringify(agentInput.parse(args)));
  assert.deepEqual(parsed({ tasks: "", add: [], under: [], done: null, start: {} }), {});
  assert.deepEqual(parsed({ tasks: [" A ", "", "  "], done: 2, start: ["3"] }), { tasks: ["A"], done: [2], start: [3] });
});

test("unknown fields and invalid ids are rejected", () => {
  assert.throws(() => agentInput.parse({ action: "update", id: 1 }), /Unrecognized keys/);
  assert.throws(() => agentInput.parse({ done: [0] }));
  assert.throws(() => agentInput.parse({ tasks: [{ subject: "A" }] }));
});

test("add with under creates subtasks that render beneath their parent", () => {
  const reply = call(plan("Inspect", "Build", "Verify"), { start: [2], add: ["Parser", "Tests"], under: [2] });
  assert.deepEqual(reply.state.tasks.map(task => [task.id, task.parentId]), [[1, undefined], [2, undefined], [3, undefined], [4, 2], [5, 2]]);
  assert.equal(reply.message, "Plan 0/5 done\n▶ 1 Inspect\n▶ 2 Build\n  ○ 4 Parser\n  ○ 5 Tests\n○ 3 Verify");
});

test("subtasks start in order, then the parent completes, then the next root task starts", () => {
  let state = call(plan("Build", "Verify"), { add: ["Parser", "Tests"], under: [1] }).state;
  assert.deepEqual(statuses(state), ["in_progress", "pending", "in_progress", "pending"]);
  state = call(state, { done: [3] }).state;
  assert.deepEqual(statuses(state), ["in_progress", "pending", "completed", "in_progress"]);
  state = call(state, { done: [4] }).state;
  assert.deepEqual(statuses(state), ["in_progress", "pending", "completed", "completed"]);
  state = call(state, { done: [1] }).state;
  assert.deepEqual(statuses(state), ["completed", "in_progress", "completed", "completed"]);
});

test("an unknown under skips the add and is reported", () => {
  const state = plan("A");
  const reply = call(state, { add: ["B"], under: [9] });
  assert.equal(reply.changed, false);
  assert.match(reply.message, /^No task #9\nPlan 0\/1 done/);
  assert.equal(call(state, { under: [1] }).message.split("\n")[0], "under applies to add");
});

test("a blank under is absent, a bare id is accepted, and two parents are rejected", () => {
  const parents = (under: unknown) => call(plan("A"), { add: ["B"], under }).state.tasks.map(task => task.parentId);
  assert.deepEqual(parents([]), [undefined, undefined]);
  assert.deepEqual(parents(""), [undefined, undefined]);
  assert.deepEqual(parents(1), [undefined, 1]);
  assert.throws(() => agentInput.parse({ add: ["B"], under: [1, 2] }));
  assert.throws(() => agentInput.parse({ add: ["B"], under: [0] }));
});
