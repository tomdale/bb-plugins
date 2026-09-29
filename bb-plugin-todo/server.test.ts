import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("RPC, tool, CLI share per-thread durable structured state", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  await plugin(bb);
  try {
    const created = await harness.behavior.callRpc("todos_mutate", { threadId: "t1", input: { action: "create", subject: "Parent" } });
    assert.equal(created.nextId, 2);
    await harness.behavior.callRpc("todos_mutate", { threadId: "t1", input: { action: "create", subject: "Child", parentId: 1, blockedBy: [1] } });
    const list = await harness.behavior.callRpc("todos_list", { threadId: "t1" });
    assert.equal(list.tasks[1].parentId, 1);
    assert.deepEqual(list.tasks[1].blockedBy, [1]);
    assert.deepEqual((await harness.behavior.callRpc("todos_list", { threadId: "t2" })).tasks, []);
    const command = await harness.behavior.runCli(["run", JSON.stringify({ action: "get", id: 2 }), "--thread", "t1"]);
    assert.equal(command.exitCode, 0);
    assert.equal(JSON.parse(command.stdout!).result.parentId, 1);
    assert.equal((await harness.behavior.callRpc("todos_list", { threadId: "t1" })).tasks.length, 2);
  } finally { await harness.lifecycle.dispose(); }
});
