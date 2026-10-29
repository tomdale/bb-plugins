import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import ssh2 from "ssh2";
import { createRelayAccess } from "./relay-access/server.ts";
import { registerLegacyImport } from "./relay-access/legacy-import.ts";
import sandbox from "./server.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
async function setup() {
  const t = createFakePluginHost({ pluginId: "environment-vercel-sandbox" });
  disposals.push(() => t.harness.lifecycle.dispose());
  t.harness.sdk.stub("system.config", () => ({ generalSettings: { defaultMachineAccess: "direct" } }));
  const relay = await createRelayAccess(t.bb);
  registerLegacyImport(t.bb, relay);
  const pair = ssh2.utils.generateKeyPairSync("ed25519");
  const record = { key: "legacy-synthetic", image: "vercel/sandbox/node:24", authorizedKey: pair.public, bridgePort: 38991, receipt: null };
  const input = { config: { enabled: true, preparedConnectorPrivateKey: pair.private }, records: [{ key: "relay-setup", value: record }] };
  return { ...t, relay, input, record, pair };
}
it("imports private identity and receipts without emitting keys, starting transport or touching cloud", async () => {
  const t = await setup();
  expect(await t.harness.behavior.callRpc("access.importLegacy", t.input)).toEqual({ imported: true });
  expect(await t.relay.settings.get()).toMatchObject({ enabled: false, preparedConnectorPrivateKey: t.pair.private });
  expect(await t.bb.storage.kv.get("relay-setup")).toMatchObject(t.record);
  expect(t.harness.registrations.settingsDescriptors.relayIdentity).toMatchObject({ secret: true });
  expect(t.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  expect(t.harness.experimental_hostRpcCalls).toHaveLength(0);
  await t.relay.settings.experimental_set({ enabled: true });
  expect(await t.harness.behavior.callRpc("access.importLegacy", t.input)).toEqual({ imported: true });
  expect((await t.relay.settings.get()).enabled).toBe(true);
  await expect(t.harness.behavior.callRpc("access.importLegacy", { ...t.input, config: { enabled: false } })).rejects.toThrow();
});
it("retains import intent and resumes an interrupted copy without overwriting a different setup", async () => {
  const t = await setup();
  const input = { ...t.input, records: [...t.input.records, { key: "relay-setup-history/legacy-synthetic", value: t.record }] };
  const set = t.bb.storage.kv.set;
  let fail = true;
  t.bb.storage.kv.set = async (key, value) => {
    if (key.startsWith("relay-setup-history/") && fail) { fail = false; throw new Error("interrupted"); }
    return set(key, value);
  };
  await expect(t.harness.behavior.callRpc("access.importLegacy", input)).rejects.toThrow();
  expect(await t.bb.storage.kv.get("relay-legacy-importing")).toBeTruthy();
  expect(await t.harness.behavior.callRpc("access.importLegacy", input)).toEqual({ imported: true });
  expect(await t.bb.storage.kv.get("relay-legacy-importing")).toBeUndefined();
  expect(await t.bb.storage.kv.get("relay-setup-history/legacy-synthetic")).toMatchObject(t.record);
});
it("restores the prior connection when the retired provider was selected", async () => {
  const t = await setup();
  t.harness.sdk.stub("system.config", () => ({ generalSettings: { defaultMachineAccess: "machine-bridge", machineServerUrl: "https://private.invalid" } }));
  t.harness.sdk.stub("system.updateGeneralSettings", () => ({}));
  await t.bb.storage.kv.set("vercel-access/default-restore", { previous: "direct" });
  await t.harness.behavior.callRpc("access.importLegacy", t.input);
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings")).toMatchObject([[{ defaultMachineAccess: "direct", machineServerUrl: "https://private.invalid" }]]);
});

it("keeps Sandbox account and worker management loaded when its managed relay identity is malformed", async () => {
  const t = createFakePluginHost({ pluginId: "environment-vercel-sandbox", settings: { relayIdentity: "invalid-private-config" } });
  disposals.push(() => t.harness.lifecycle.dispose());
  await sandbox(t.bb);
  expect(await t.harness.behavior.callRpc("account.saved", {})).toMatchObject({ hostId: null });
  const status = await t.harness.behavior.callRpc("setup.status", {});
  expect(status).toMatchObject({ firstFailure: { reason: "invalid-config" } });
  expect(JSON.stringify(status)).not.toContain("invalid-private-config");
  expect(t.harness.experimental_hostRpcCalls).toHaveLength(0);
});

it("refuses to replace a setup already owned by the integrated relay", async () => {
  const t = await setup();
  await t.bb.storage.kv.set("relay-setup", t.record);
  await expect(t.harness.behavior.callRpc("access.importLegacy", t.input)).rejects.toThrow();
  expect((await t.relay.settings.get()).preparedConnectorPrivateKey).toBeUndefined();
});
