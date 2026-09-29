import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { callFromEvent, snapshotForThread } from "./snapshot.ts";

test("only successful completed Pi todo events replay", () => {
  const item = (status: string, result: unknown, args: unknown, tool = "todo") => ({
    seq: 1, type: "item/completed", data: { item: { type: "toolCall", status, result, tool, arguments: args } },
  });
  assert.deepEqual(callFromEvent(item("completed", "Created #1", { action: "create", subject: "OK" })), { action: "create", subject: "OK" });
  assert.equal(callFromEvent(item("failed", "Created #1", { action: "create", subject: "No" })), null);
  assert.equal(callFromEvent(item("completed", "Error: failed", { action: "create", subject: "No" })), null);
  assert.equal(callFromEvent(item("completed", "Created", { action: "create" }, "bb_todo")), null);
});

test("paginates in sequence and keeps separate thread snapshots via public SDK", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  const events = Array.from({ length: 501 }, (_, i) => ({
    id: `ev${i}`, seq: i + 1, type: "item/completed" as const, threadId: "thread-a", scope: { kind: "thread" as const }, createdAt: i,
    data: { item: { type: "toolCall", tool: "todo", status: "completed", id: `c${i}`, arguments: i === 0 ? { action: "batch", operations: [{ action: "create", subject: "Start" }, { action: "create", subject: "Next" }] } : { action: "create", subject: `Task ${i}` }, result: "Created" } },
  }));
  harness.sdk.stub("threads.events.list", async (args: { threadId: string; afterSeq?: string; limit?: string }) => {
    const limit = Math.min(Number(args.limit ?? 100), 100);
    return args.threadId === "thread-a" ? events.filter(e => e.seq > Number(args.afterSeq ?? 0)).slice(0, limit) : [];
  });
  await plugin(bb);
  try {
    const a = await harness.behavior.callRpc("snapshot", { threadId: "thread-a" });
    assert.equal(a.tasks.length, 502);
    assert.equal(a.nextId, 503);
    assert.deepEqual((await harness.behavior.callRpc("snapshot", { threadId: "thread-b" })).tasks, []);
    assert.ok(harness.inspection.sdk.callsTo("threads.events.list").length >= 6);
    assert.equal((await snapshotForThread(bb, "thread-b")).tasks.length, 0);
    assert.deepEqual([...harness.registrations.agentTools.keys()], []);
  } finally { await harness.lifecycle.dispose(); }
});

test("timeline errors propagate rather than displaying a misleading partial list", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  harness.sdk.stub("threads.events.list", async () => { throw new Error("timeline unavailable"); });
  await plugin(bb);
  try { await assert.rejects(harness.behavior.callRpc("snapshot", { threadId: "thread-a" }), /timeline unavailable/); }
  finally { await harness.lifecycle.dispose(); }
});
