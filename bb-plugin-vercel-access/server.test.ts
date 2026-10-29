import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("retired plugin only migrates server-side values, emits a flag and can be retried without cloud operations", async () => {
  const calls: unknown[] = [];
  const t = createFakePluginHost({ pluginId: "vercel-access", settings: { enabled: true, preparedConnectorPrivateKey: "synthetic-private-value" }, sdk: { plugins: { callRpc: async input => { calls.push(input); return { imported: true }; } } } });
  try {
    await t.bb.storage.kv.set("relay-setup", { key: "synthetic" });
    await plugin(t.bb);
    assert.equal(t.harness.registrations.serverAccessProviders.size, 0);
    assert.equal(t.harness.registrations.services.length, 0);
    const migrated = await t.harness.behavior.runCli(["migrate"]);
    assert.equal(migrated.exitCode, 0);
    assert.equal(migrated.stdout, '{"migrated":true}');
    assert.ok(!migrated.stdout.includes("synthetic-private-value"));
    assert.equal(calls.length, 1);
    assert.equal(t.harness.experimental_hostRpcCalls.length, 0);
    assert.equal((await t.harness.behavior.runCli(["migrate"])).exitCode, 0);
    assert.equal(calls.length, 1);
  } finally { await t.harness.lifecycle.dispose(); }
});

test("a failed migration retains intent and never emits private exception details", async () => {
  const t = createFakePluginHost({ pluginId: "vercel-access", sdk: { plugins: { callRpc: async () => { throw new Error("synthetic-private-value"); } } } });
  try {
    await plugin(t.bb);
    const reply = await t.harness.behavior.runCli(["migrate"]);
    assert.notEqual(reply.exitCode, 0);
    assert.ok(!JSON.stringify(reply).includes("synthetic-private-value"));
    assert.equal(await t.bb.storage.kv.get("sandbox-relay-migrated"), undefined);
  } finally { await t.harness.lifecycle.dispose(); }
});
