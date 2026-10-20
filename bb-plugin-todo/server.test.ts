import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("native todo tool persists per-thread state and publishes changes", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  await plugin(bb);
  const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("todo", args);
  const created = await call({ tasks: ["Research", "Implement"] });
  assert.equal(created, "Plan 0/2 done\n▶ 1 Research\n○ 2 Implement");
  const snapshot = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.deepEqual(snapshot.tasks.map(t => [t.id, t.subject, t.status]), [[1, "Research", "in_progress"], [2, "Implement", "pending"]]);
  assert.equal(harness.realtimeSignals.length, 1);
  assert.equal(await call({}), created);
  assert.equal(harness.realtimeSignals.length, 1);
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thread-test" }), lastAssistantText: null });
  const settled = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.equal(settled.tasks[0]?.status, "pending");
  assert.equal(harness.realtimeSignals.length, 2);
  await harness.lifecycle.dispose();
});

for (const event of ["thread.idle", "thread.failed", "thread.archived"] as const) {
  test(`${event} resets all unfinished active tasks and preserves other threads`, async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
    await plugin(bb);
    for (const threadId of ["ended", "other"]) {
      const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("todo", args, { threadId });
      await call({ tasks: ["First", "Second", "Done"] });
      await call({ start: [2], done: [3] });
    }
    const payload = { thread: makeThreadResponse({ id: "ended" }), lastAssistantText: null, error: "Failed" };
    await harness.behavior.emitThreadEvent(event, payload);
    const settled = await harness.behavior.callRpc("snapshot", { threadId: "ended" });
    assert.deepEqual(settled.tasks.map(task => task.status), ["pending", "pending", "completed"]);
    assert.equal(settled.nextId, 4);
    const other = await harness.behavior.callRpc("snapshot", { threadId: "other" });
    assert.deepEqual(other.tasks.map(task => task.status), ["in_progress", "in_progress", "completed"]);
    const signals = harness.realtimeSignals.length;
    await harness.behavior.emitThreadEvent(event, payload);
    assert.equal(harness.realtimeSignals.length, signals);
    assert.deepEqual(await harness.behavior.callRpc("snapshot", { threadId: "ended" }), settled);
    await harness.lifecycle.dispose();
  });
}

test("declares, completes, and archives plans through the todo tool", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  await plugin(bb);
  const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("todo", args);
  const snapshot = () => harness.behavior.callRpc("snapshot", { threadId: "thread-test" });

  await call({ tasks: ["Plan feature", "Build feature", "Test feature"] });
  await call({ done: [1] });
  await call({ done: [2, 3] });
  assert.equal((await snapshot()).tasks.every(t => t.status === "completed"), true);

  // archiveCompleted archives the plan and clears the active list
  const archiveRes = await harness.behavior.callRpc("archiveCompleted", { threadId: "thread-test" });
  assert.equal(archiveRes.archived, true);
  assert.deepEqual((await snapshot()).tasks, []);

  // A fresh plan starts with ids 1, 2
  await call({ tasks: ["Next goal step 1", "Next goal step 2"] });
  assert.deepEqual((await snapshot()).tasks.map(t => t.id), [1, 2]);

  // Replacing a plan that has completed work archives it
  await call({ done: [1] });
  await call({ tasks: ["Third goal"] });
  assert.deepEqual((await snapshot()).tasks.map(t => t.subject), ["Third goal"]);

  const archivedPlans = () => (bb.storage.database()
    .prepare("SELECT plan_json FROM todo_plan_archives WHERE thread_id = ? ORDER BY id").all("thread-test") as Array<{ plan_json: string }>)
    .map(row => (JSON.parse(row.plan_json) as unknown[]).length);
  assert.deepEqual(archivedPlans(), [3, 2]); // The first 3-step plan, then the plan with "Next goal step 1"

  // Replacing a plan with no completed work does not archive it
  await call({ tasks: ["Fourth goal"] });
  assert.deepEqual(archivedPlans(), [3, 2]);
  await harness.lifecycle.dispose();
});

test("blank fields and unknown ids leave the plan intact", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  await plugin(bb);
  const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("todo", args);
  await call({ tasks: ["One", "Two"] });
  const signals = harness.realtimeSignals.length;
  const reply = await call({ tasks: [], add: "", done: [9], start: null });
  assert.equal(reply, "No task #9\nPlan 0/2 done\n▶ 1 One\n○ 2 Two");
  assert.equal(harness.realtimeSignals.length, signals);
  await assert.rejects(() => call({ action: "update", id: 1, status: "completed" }), /Unrecognized keys/);
  assert.equal((await harness.behavior.callRpc("snapshot", { threadId: "thread-test" })).tasks[0]?.status, "in_progress");
  await harness.lifecycle.dispose();
});

test("reads plans saved with deleted tasks and fields the agent tool no longer sets", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  await plugin(bb);
  const legacy = {
    tasks: [
      { id: 1, subject: "Kept", status: "completed", description: "notes", activeForm: "Keeping", owner: "assistant", metadata: {}, blockedBy: [] },
      { id: 2, subject: "Removed", status: "deleted" },
      { id: 3, subject: "Child", status: "pending", parentId: 1 },
    ],
    nextId: 4,
  };
  bb.storage.database().prepare("INSERT INTO todo_threads(thread_id, state_json) VALUES (?, ?)").run("thread-test", JSON.stringify(legacy));
  const snapshot = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.deepEqual(snapshot, { tasks: [{ id: 1, subject: "Kept", status: "completed" }, { id: 3, subject: "Child", status: "pending", parentId: 1 }], nextId: 4 });
  assert.equal(await harness.behavior.callAgentTool("todo", { add: ["Next"] }), "Plan 1/3 done\n✓ 1 Kept\n  ▶ 3 Child\n○ 4 Next");
  await harness.lifecycle.dispose();
});

