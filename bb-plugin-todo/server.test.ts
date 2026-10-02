import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("native todo tool persists per-thread state and publishes changes", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  await plugin(bb);
  const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("todo", args);
  const created = await call({
    action: "set",
    tasks: [
      { id: 1, subject: "Research" },
      { id: 2, subject: "Implement", blockedBy: [1] },
    ],
  });
  assert.match(JSON.stringify(created), /Set plan with 2 tasks/);
  const listed = await call({ action: "list" });
  assert.match(JSON.stringify(listed), /blockedBy/);
  const snapshot = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.equal(snapshot.tasks.length, 2);
  assert.deepEqual(snapshot.tasks[1]?.blockedBy, [1]);
  assert.equal(harness.realtimeSignals.length, 1);
  await harness.behavior.callAgentTool("todo", { action: "update", id: 1, status: "in_progress" });
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thread-test" }), lastAssistantText: null });
  const settled = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.equal(settled.tasks[0]?.status, "pending");
  assert.equal(harness.realtimeSignals.length, 3);
  await harness.lifecycle.dispose();
});

for (const event of ["thread.idle", "thread.failed", "thread.archived"] as const) {
  test(`${event} resets all unfinished active tasks and preserves other threads and fields`, async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
    await plugin(bb);
    const mutate = (threadId: string, change: Record<string, unknown>) => harness.behavior.callRpc("mutate", { threadId, change });
    for (const threadId of ["ended", "other"]) {
      for (const subject of ["First", "Second", "Done", "Deleted"]) await mutate(threadId, { action: "create", subject });
      for (const id of [1, 2]) await mutate(threadId, { action: "update", id, status: "in_progress", activeForm: "Working", owner: "agent" });
      await mutate(threadId, { action: "update", id: 3, status: "completed" });
      await mutate(threadId, { action: "delete", id: 4 });
    }
    const payload = { thread: makeThreadResponse({ id: "ended" }), lastAssistantText: null, error: "Failed" };
    await harness.behavior.emitThreadEvent(event, payload);
    const settled = await harness.behavior.callRpc("snapshot", { threadId: "ended" });
    assert.deepEqual(settled.tasks.map(task => task.status), ["pending", "pending", "completed", "deleted"]);
    assert.equal(settled.tasks[0]?.activeForm, "Working");
    assert.equal(settled.tasks[0]?.owner, "agent");
    assert.equal(settled.nextId, 5);
    const other = await harness.behavior.callRpc("snapshot", { threadId: "other" });
    assert.deepEqual(other.tasks.map(task => task.status), ["in_progress", "in_progress", "completed", "deleted"]);
    const signals = harness.realtimeSignals.length;
    await harness.behavior.emitThreadEvent(event, payload);
    assert.equal(harness.realtimeSignals.length, signals);
    assert.deepEqual(await harness.behavior.callRpc("snapshot", { threadId: "ended" }), settled);
    await harness.lifecycle.dispose();
  });
}

test("declaratively sets plan, manages updates, and archives completed plans", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  await plugin(bb);
  const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("todo", args);

  // Set initial plan
  const setRes = await call({
    action: "set",
    tasks: [
      { id: 1, subject: "Plan feature", status: "completed" },
      { id: 2, subject: "Build feature", status: "in_progress", activeForm: "Building" },
      { id: 3, subject: "Test feature", blockedBy: [2] },
    ],
  });
  assert.match(JSON.stringify(setRes), /Set plan with 3 tasks/);

  // In-turn update
  await call({ action: "update", id: 2, status: "completed" });
  await call({ action: "update", id: 3, status: "in_progress", activeForm: "Testing" });
  await call({ action: "update", id: 3, status: "completed" });

  const snapshot = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.equal(snapshot.tasks.every(t => t.status === "completed"), true);

  // archiveCompleted archives the plan and clears the active list
  const archiveRes = await harness.behavior.callRpc("archiveCompleted", { threadId: "thread-test" });
  assert.equal(archiveRes.archived, true);
  const afterArchive = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.deepEqual(afterArchive.tasks, []);

  // Set fresh plan starts with local IDs 1, 2
  await call({
    action: "set",
    tasks: [
      { subject: "Next goal step 1" },
      { subject: "Next goal step 2" },
    ],
  });
  const freshSnapshot = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.deepEqual(freshSnapshot.tasks.map(t => t.id), [1, 2]);

  // Calling set with a new plan when completed tasks exist auto-archives the old completed plan
  await call({ action: "update", id: 1, status: "completed" });
  await call({
    action: "set",
    tasks: [{ subject: "Third goal" }],
  });
  const thirdSnapshot = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.deepEqual(thirdSnapshot.tasks.map(t => t.subject), ["Third goal"]);

  // listArchives returns the archived plans
  const archives = await harness.behavior.callRpc("listArchives", { threadId: "thread-test" });
  assert.equal(archives.archives.length, 2);
  assert.equal(archives.archives[0]?.tasks.length, 2); // The second plan with "Next goal step 1"
  assert.equal(archives.archives[1]?.tasks.length, 3); // The first 3-step plan

  await harness.lifecycle.dispose();
});

test("rejects invalid dependency references without changing persisted state", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  await plugin(bb);
  const rejected = await harness.behavior.callAgentTool("todo", {
    action: "set",
    tasks: [{ id: 1, subject: "Blocked", blockedBy: [99] }],
  });
  assert.equal(typeof rejected, "object");
  assert.equal((rejected as { isError?: boolean }).isError, true);
  const snapshot = await harness.behavior.callRpc("snapshot", { threadId: "thread-test" });
  assert.deepEqual(snapshot, emptySnapshot);
  await harness.lifecycle.dispose();
});

const emptySnapshot = { tasks: [], nextId: 1 };
