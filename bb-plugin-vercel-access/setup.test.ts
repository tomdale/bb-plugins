import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { TESTED_CORE } from "./policy.ts";

const image = "vercel/sandbox/node:24";
const resolvedImage = `vercel/sandbox/node@sha256:${"a".repeat(64)}`;
function fixture() {
  let loseReply = false;
  const requests: { method: string; input: unknown }[] = [];
  const generation = randomUUID();
  const view = { key: "synthetic-relay", generation, name: `bb-relay-${"a".repeat(48)}`, hostId: "host_auth", accountId: "account_synthetic",
    teamId: "team_synthetic", projectId: "prj_synthetic", phase: "ready", sessionId: "session_synthetic", commandId: "cmd_synthetic",
    origin: "https://synthetic-relay.vercel.run", fingerprint: "a".repeat(64), expiresAt: Date.now() + 600_000,
    computeEnded: false, metadataDeleted: false, observedStatus: "command-pending-or-running", artifactSha256: "b".repeat(64), requestedImage: image, image: resolvedImage, resolvedImage, nodeVersion: "v24.22.1", vcpus: 1, persistent: false, timeoutMs: 600_000 };
  const host = createFakePluginHost({ pluginId: "vercel-access", sdk: { plugins: { callRpc: async (input) => {
    assert.equal(input.pluginId, "environment-vercel-sandbox");
    requests.push({ method: input.method, input: input.input });
    if (loseReply) throw new Error("synthetic-secret");
    if (input.method === "relay.stop") return { ...view, phase: "removed", computeEnded: true, metadataDeleted: true };
    return view;
  } } } });
  let readSettings: () => Promise<Record<string, unknown>> = async () => ({});
  const define = host.bb.settings.define;
  host.bb.settings.define = descriptors => {
    const handle = define(descriptors);
    readSettings = () => handle.get();
    return handle;
  };
  return { ...host, requests, view, readSettings: () => readSettings(), get loseReply() { return loseReply; }, set loseReply(v: boolean) { loseReply = v; } };
}

test("owner setup requires cost confirmation, keeps dedicated private key server-side, applies trusted pin disabled — fake cloud", async () => {
  const t = fixture();
  try {
    await plugin(t.bb);
    assert.equal(t.requests.length, 0);
    const local = await t.harness.behavior.callRpc("setup.status", {}) as { stages: { stage: string; reason: string }[] };
    assert.equal(local.stages.find(item => item.stage === "readiness")!.reason, "disabled");
    const statusCli = await t.harness.behavior.runCli(["relay", "status"]);
    assert.equal(statusCli.exitCode, 0);
    assert.ok(!statusCli.stdout.includes("PRIVATE KEY"));
    assert.equal(t.requests.length, 0);
    assert.equal(t.harness.registrations.serverAccessProviders.size, 0);
    await assert.rejects(t.harness.behavior.callRpc("setup.prepare", { key: "synthetic-relay", image }));
    assert.equal(t.requests.length, 0);
    const prepared = await t.harness.behavior.callRpc("setup.prepare", { key: "synthetic-relay", image, approveAllocation: true });
    assert.equal(t.requests.length, 1);
    const record = t.requests[0]!.input as { key: string; authorizedKey: string };
    assert.match(record.authorizedKey, /^ssh-ed25519 /);
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE KEY|Bearer|OAuth/);
    assert.doesNotMatch(JSON.stringify(prepared), /PRIVATE KEY|authorizedKey|synthetic-secret/);
    const persisted = await t.bb.storage.kv.get("relay-setup");
    assert.doesNotMatch(JSON.stringify(persisted), /PRIVATE KEY/);
    await t.harness.behavior.callRpc("setup.apply", { key: "synthetic-relay" });
    const saved = await t.readSettings();
    assert.equal(saved.enabled, false);
    assert.equal(saved.serverUrl, t.view.origin);
    assert.equal(saved.relayUrl, "wss://synthetic-relay.vercel.run");
    assert.equal(saved.relayFingerprint, t.view.fingerprint);
    assert.equal(t.harness.registrations.settingsDescriptors.preparedConnectorPrivateKey!.type, "string");
    assert.equal("secret" in t.harness.registrations.settingsDescriptors.preparedConnectorPrivateKey!, true);
    assert.equal(t.requests.some(r => r.method !== "relay.prepare" && r.method !== "relay.inspect"), false);
  } finally { await t.harness.lifecycle.dispose(); }
});

test("lost prepare replies retain the identical public authorization identity across plugin reload — fake cloud", async () => {
  const t = fixture();
  try {
    await plugin(t.bb); t.loseReply = true;
    await assert.rejects(t.harness.behavior.callRpc("setup.prepare", { key: "synthetic-relay", image, approveAllocation: true }), error => !String(error).includes("synthetic-secret"));
    t.loseReply = false;
    const next = await t.harness.lifecycle.reload(plugin);
    await next.harness.behavior.callRpc("setup.prepare", { key: "synthetic-relay", image, approveAllocation: true });
    assert.deepEqual(t.requests[0]!.input, t.requests[1]!.input);
    await assert.rejects(next.harness.behavior.callRpc("setup.prepare", { key: "replacement", image, approveAllocation: true }));
    assert.equal(t.requests.length, 3);
    assert.equal(t.requests[2]!.method, "relay.inspect");
    const stopped = await next.harness.behavior.callRpc("setup.stop", { key: "synthetic-relay" });
    assert.equal((stopped as { phase: string }).phase, "removed");
  } finally { await t.harness.lifecycle.dispose(); }
});

test("owner CLI does not accept private setup data or silently approve allocation — fake cloud", async () => {
  const t = fixture();
  try {
    await plugin(t.bb);
    const rejected = await t.harness.behavior.runCli(["relay", "prepare", "--key", "synthetic-relay"]);
    assert.notEqual(rejected.exitCode, 0); assert.equal(t.requests.length, 0);
    const result = await t.harness.behavior.runCli(["relay", "prepare", "--key", "synthetic-relay", "--confirm-cost"]);
    assert.equal(result.exitCode, 0); assert.equal(t.requests.length, 1);
    assert.doesNotMatch(result.stdout, /PRIVATE KEY|authorizedKey/);
    assert.equal((await t.harness.behavior.runCli(["relay", "prepare", "--key", "synthetic-relay", "--image", "latest", "--confirm-cost"])).exitCode === 0, false);
  } finally { await t.harness.lifecycle.dispose(); }
});


test("availability, native acquire/release and readiness do not call provisioning", async () => {
  const core = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(TESTED_CORE)); });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const coreUrl = `http://127.0.0.1:${(core.address() as { port: number }).port}`;
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const t = createFakePluginHost({ pluginId: "vercel-access", loopbackBaseUrl: coreUrl,
    settings: { enabled: true, port, serverUrl: `http://127.0.0.1:${port}` } });
  try {
    await plugin(t.bb);
    const provider = t.harness.registrations.serverAccessProviders.get("machine-bridge")!;
    assert.equal((await provider.availability()).status, "unavailable");
    const service = t.harness.behavior.runService("machine-bridge");
    for (let i = 0; i < 100 && (await provider.availability()).status !== "available"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await provider.availability()).status, "available");
    const grant = await provider.acquire({ key: "synthetic-worker", hostId: "host_synthetic", signal: new AbortController().signal });
    assert.ok("id" in grant);
    await provider.release({ key: "synthetic-worker", hostId: "host_synthetic", grantId: grant.id });
    assert.equal(t.harness.inspection.sdk.callsTo("plugins.callRpc").length, 0);
    assert.equal(t.harness.experimental_hostRpcCalls.length, 0);
    service.controller.abort(); await service.done;
  } finally { await t.harness.lifecycle.dispose(); await new Promise<void>(resolve => core.close(() => resolve())); }
});
