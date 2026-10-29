import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import ssh2 from "ssh2";
import { z } from "zod";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerSetup, relayViewSchema } from "./setup.ts";

type View = z.infer<typeof relayViewSchema>;
function fixture() {
  const views = new Map<string, View>();
  const requests: { method: string; key: string }[] = [];
  let privateKey: string | undefined;
  let enabled = false, offline = false, saves = 0, disables = 0;
  const applications: { key: string; matchingPrivateKey: boolean }[] = [];
  let transform = (_method: string, view: View): View => view;
  const host = createFakePluginHost({ pluginId: "vercel-access", sdk: { plugins: { callRpc: async input => {
    const { key } = input.input as { key: string };
    requests.push({ method: input.method, key });
    if (offline) throw new Error("synthetic-host-offline");
    if (!views.has(key)) views.set(key, {
      key, generation: randomUUID(), name: `bb-relay-${createHash("sha256").update(key).digest("hex").slice(0, 48)}`,
      hostId: "host_auth", accountId: "account_synthetic", teamId: "team_synthetic", projectId: "prj_synthetic",
      phase: "ready", sessionId: `session-${key}`, commandId: `cmd-${key}`, origin: `https://${key}.vercel.run`,
      fingerprint: "a".repeat(64), artifactSha256: "b".repeat(64), expiresAt: Date.now() + 600_000,
      computeEnded: false, metadataDeleted: false, observedStatus: "command-pending-or-running",
      image: "vercel/sandbox/node:24", nodeVersion: "v24.22.1", vcpus: 1, persistent: false, timeoutMs: 600_000,
    });
    const view = views.get(key)!;
    if (input.method === "relay.stop") Object.assign(view, { phase: "removed", computeEnded: true, metadataDeleted: true, observedStatus: "stopped" });
    return transform(input.method, { ...view });
  } } } });
  registerSetup(host.bb, {
    config: async () => ({ enabled, port: 38991, preparedConnectorPrivateKey: privateKey }),
    saveKey: async key => { privateKey = key; saves++; },
    disable: async () => { enabled = false; disables++; },
    apply: async (view, key) => { applications.push({ key: view.key, matchingPrivateKey: key === privateKey }); },
  });
  return { ...host, requests, applications, views,
    prepare: (key: string) => host.harness.behavior.callRpc("setup.prepare", { key, approveAllocation: true }),
    call: (method: string, key: string) => host.harness.behavior.callRpc(`setup.${method}`, { key }),
    transform: (fn: typeof transform) => { transform = fn; },
    get privateKey() { return privateKey; }, set privateKey(key: string | undefined) { privateKey = key; },
    get enabled() { return enabled; }, set enabled(value: boolean) { enabled = value; },
    get offline() { return offline; }, set offline(value: boolean) { offline = value; },
    get saves() { return saves; }, get disables() { return disables; },
  };
}

test("historical cleanup leaves replacement enabled; matching offline stop revokes locally — fake RPC", async () => {
  const t = fixture();
  try {
    await t.prepare("relay-a"); await t.call("stop", "relay-a");
    await t.prepare("relay-b"); await t.call("apply", "relay-b"); t.enabled = true;
    const disables = t.disables;
    await t.call("stop", "relay-a");
    assert.equal(t.enabled, true); assert.equal(t.disables, disables);
    assert.deepEqual(t.requests.at(-1), { method: "relay.stop", key: "relay-a" });
    t.offline = true;
    await assert.rejects(t.call("stop", "relay-b"), error => !String(error).includes("synthetic-host-offline"));
    assert.equal(t.enabled, false); assert.equal(t.disables, disables + 1);
    assert.deepEqual(t.requests.at(-1), { method: "relay.stop", key: "relay-b" });
  } finally { await t.harness.lifecycle.dispose(); }
});

test("apply rejects malformed/different pending private identities before inspect or settings writes — fake RPC", async () => {
  const t = fixture();
  try {
    await t.prepare("relay-a"); const original = t.privateKey;
    for (const replacement of ["synthetic-invalid-private-key", ssh2.utils.generateKeyPairSync("ed25519").private]) {
      t.privateKey = replacement;
      const before = { requests: t.requests.length, saves: t.saves, applications: t.applications.length };
      await assert.rejects(t.call("apply", "relay-a"), error => !String(error).includes(replacement));
      assert.deepEqual({ requests: t.requests.length, saves: t.saves, applications: t.applications.length }, before);
    }
    t.privateKey = original;
    await t.call("apply", "relay-a");
    assert.deepEqual(t.applications, [{ key: "relay-a", matchingPrivateKey: true }]);
    assert.equal(t.harness.logEntries.length, 0);
  } finally { await t.harness.lifecycle.dispose(); }
});

test("wrong-key prepared/ready/removed replies cannot apply or authorize replacement — fake RPC", async () => {
  const t = fixture();
  try {
    t.transform((_method, view) => ({ ...view, key: "relay-other" }));
    await assert.rejects(t.prepare("relay-a"));
    assert.equal((await t.bb.storage.kv.get<{ receipt: unknown }>("relay-setup"))!.receipt, null);
    t.transform((_method, view) => view); await t.prepare("relay-a");
    t.transform((_method, view) => ({ ...view, key: "relay-other", phase: "removed", computeEnded: true, metadataDeleted: true }));
    await assert.rejects(t.call("apply", "relay-a"));
    await assert.rejects(t.call("stop", "relay-a"));
    const saves = t.saves;
    await assert.rejects(t.prepare("relay-b"));
    assert.equal(t.saves, saves);
    assert.equal((await t.bb.storage.kv.get<{ key: string }>("relay-setup"))!.key, "relay-a");
    assert.equal(t.applications.length, 0);
  } finally { await t.harness.lifecycle.dispose(); }
});

test("unknown receipt fields may become known once but cannot later disappear — fake RPC", async () => {
  const t = fixture();
  try {
    t.transform((_method, view) => ({ ...view, origin: null, sessionId: null, commandId: null }));
    await t.prepare("relay-a");
    assert.equal((await t.bb.storage.kv.get<{ receipt: { origin: string | null } }>("relay-setup"))!.receipt.origin, null);
    t.transform((_method, view) => view);
    await t.call("apply", "relay-a");
    const receipt = (await t.bb.storage.kv.get<{ receipt: unknown }>("relay-setup"))!.receipt;
    t.transform((_method, view) => ({ ...view, origin: null }));
    await assert.rejects(t.call("apply", "relay-a"));
    assert.deepEqual((await t.bb.storage.kv.get<{ receipt: unknown }>("relay-setup"))!.receipt, receipt);
    assert.equal(t.applications.length, 1);
  } finally { await t.harness.lifecycle.dispose(); }
});

test("first access receipt pins generation, connection, origin, session and public identities — fake RPC", async () => {
  const t = fixture();
  try {
    await t.prepare("relay-a");
    const receipt = (await t.bb.storage.kv.get<{ receipt: unknown }>("relay-setup"))!.receipt;
    const changes: Partial<View>[] = [
      { generation: randomUUID() }, { name: `bb-relay-${"c".repeat(48)}` }, { hostId: "host_other" },
      { accountId: "account_other" }, { teamId: "team_other" }, { projectId: "prj_other" },
      { fingerprint: "c".repeat(64) }, { artifactSha256: "c".repeat(64) }, { origin: "https://other.vercel.run" },
      { sessionId: "session_other" }, { commandId: "cmd_other" }, { sessionId: null }, { origin: null },
    ];
    for (const change of changes) {
      t.transform((_method, view) => ({ ...view, ...change }));
      await assert.rejects(t.call("apply", "relay-a"));
      assert.deepEqual((await t.bb.storage.kv.get<{ receipt: unknown }>("relay-setup"))!.receipt, receipt);
      assert.equal(t.applications.length, 0);
    }
    t.transform((_method, view) => view);
    await t.call("apply", "relay-a");
    assert.equal(t.applications.length, 1);
  } finally { await t.harness.lifecycle.dispose(); }
});
