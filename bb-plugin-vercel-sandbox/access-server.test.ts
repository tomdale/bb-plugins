import { defineRpcContract, type JsonValue } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { accessHandlers } from "./access-server.js";
import { accessMethods } from "./access-contract.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
function setup() {
  let defaultProvider: string | null = "direct";
  let ready = false;
  let missing = false;
  let enabled = false;
  let losePrepare = false;
  let expiresAt = Date.now() + 600_000;
  let key: string | null = null;
  const calls: { method: string; input: unknown }[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "environment-vercel-sandbox" });
  disposals.push(() => harness.lifecycle.dispose());
  harness.sdk.stub("system.config", () => ({
    generalSettings: { defaultMachineAccess: defaultProvider, machineServerUrl: "https://private.invalid", managedBranchPrefix: "custom/" },
    serverAccess: { defaultProviderId: defaultProvider ?? "machine-bridge", providers: [{ id: "machine-bridge", availability: { status: ready ? "available" : "unavailable" } }] },
  }));
  harness.sdk.stub("system.updateGeneralSettings", (input: unknown) => {
    const value = input as { defaultMachineAccess: string | null; machineServerUrl: string };
    expect(value.machineServerUrl).toBe("https://private.invalid");
    defaultProvider = value.defaultMachineAccess;
    return value;
  });
  harness.sdk.stub("plugins.callRpc", (input: unknown) => {
    const request = input as { method: string; input: { key?: string }; outputSchema: { parse: (value: unknown) => unknown } };
    calls.push(request);
    if (missing) throw new Error("secret-token must not escape");
    const view = { key, phase: "ready", expiresAt, computeEnded: false, metadataDeleted: false, connectorPrivateKey: "PRIVATE SECRET" };
    let value: unknown;
    switch (request.method) {
      case "setup.current": value = { key }; break;
      case "setup.status": value = { stages: [{ stage: "readiness", state: ready ? "verified" : "closed" }] }; break;
      case "setup.prepare": key = request.input.key!; if (losePrepare) throw new Error("lost reply"); expiresAt = Date.now() + 600_000; value = { ...view, key, expiresAt }; break;
      case "setup.stop": ready = false; enabled = false; value = { ...view, phase: "removed", computeEnded: true, metadataDeleted: true }; break;
      default: value = view;
    }
    return request.outputSchema.parse(value);
  });
  harness.sdk.stub("plugins.getSettings", () => ({ values: { enabled } }));
  harness.sdk.stub("plugins.enable", () => { missing = false; return {}; });
  harness.sdk.stub("plugins.updateSettings", (input: unknown) => { enabled = (input as { values: { enabled: boolean } }).values.enabled; return {}; });
  harness.sdk.stub("plugins.reload", () => { ready = enabled; return {}; });
  bb.rpc.register(defineRpcContract(accessMethods), accessHandlers(bb));
  return { harness, calls, setLostReply: (value: boolean) => { losePrepare = value; }, expire: () => { expiresAt = Date.now() - 1; }, setReady: () => { ready = true; }, setMissing: () => { missing = true; },
    changeDefault: (value: string | null) => { defaultProvider = value; },
    rpc: (method: keyof typeof accessMethods, input: JsonValue = {}) => harness.behavior.callRpc(method, input) };
}

it("one enable sets up, connects and selects the relay without separate consent fields", async () => {
  const t = setup();
  expect(await t.rpc("access.enable")).toMatchObject({ ready: true, selected: true, canRestore: true });
  expect(t.calls.filter(c => c.method === "setup.prepare")).toHaveLength(1);
  expect(await t.rpc("access.enable")).toMatchObject({ ready: true, selected: true });
  expect(t.harness.sdk.callsTo("plugins.reload")).toHaveLength(1);
  expect(t.calls.filter(c => c.method === "setup.prepare")).toHaveLength(1);
  expect(await t.rpc("access.disable")).toMatchObject({ ready: false, selected: false, defaultProvider: "direct", phase: "removed" });
});

it("selects an already-ready relay without allocating or reloading it", async () => {
  const t = setup();
  t.setReady();
  expect(await t.rpc("access.enable")).toMatchObject({ ready: true, selected: true });
  expect(t.calls.some(c => c.method === "setup.prepare")).toBe(false);
  expect(t.harness.sdk.callsTo("plugins.reload")).toHaveLength(0);
});

it("does not select an unready relay and retries the existing connection without reloading", async () => {
  vi.useFakeTimers();
  const t = setup();
  t.harness.sdk.stub("plugins.reload", () => ({}));
  const failed = expect(t.rpc("access.enable")).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(11_000);
  await failed;
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings")).toHaveLength(0);
  t.setReady();
  await t.rpc("access.enable");
  expect(t.harness.sdk.callsTo("plugins.reload")).toHaveLength(1);
  vi.useRealTimers();
});

it("enables the companion and restores Automatic without a separate settings detour", async () => {
  const t = setup();
  t.setMissing();
  t.changeDefault(null);
  expect(await t.rpc("access.enable")).toMatchObject({ ready: true, selected: true });
  expect(t.harness.sdk.callsTo("plugins.enable")).toHaveLength(1);
  expect(await t.rpc("access.disable")).toMatchObject({ defaultProvider: null });
});

it("retains the same key after a lost preparation reply", async () => {
  const t = setup();
  t.setLostReply(true);
  await expect(t.rpc("access.enable")).rejects.toThrow();
  const first = t.calls.find(c => c.method === "setup.prepare")?.input;
  t.setLostReply(false);
  expect(await t.rpc("access.enable")).toMatchObject({ ready: true, selected: true });
  expect(t.calls.find(c => c.method === "setup.inspect")?.input).toMatchObject({ key: (first as { key: string }).key });
});

it("replaces an expired relay only after confirmed cleanup", async () => {
  const t = setup();
  await t.rpc("access.enable");
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 700_000);
  expect(await t.rpc("access.enable")).toMatchObject({ ready: true, selected: true });
  const methods = t.calls.map(c => c.method);
  expect(methods.lastIndexOf("setup.stop")).toBeLessThan(methods.lastIndexOf("setup.prepare"));
  expect(t.calls.filter(c => c.method === "setup.prepare")).toHaveLength(2);
});

it("restores the previous default even when the companion reload fails during disable", async () => {
  const t = setup();
  await t.rpc("access.enable");
  t.harness.sdk.stub("plugins.reload", () => { throw new Error("reload failed"); });
  await expect(t.rpc("access.disable")).rejects.toThrow();
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings").at(-1)).toMatchObject([{ defaultMachineAccess: "direct" }]);
});

it("disable restores access even when cloud cleanup fails, without overwriting another selection", async () => {
  const t = setup();
  await t.rpc("access.enable");
  t.harness.sdk.stub("plugins.callRpc", () => { throw new Error("offline"); });
  await expect(t.rpc("access.disable")).rejects.toThrow();
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings").at(-1)).toMatchObject([{ defaultMachineAccess: "direct" }]);
  t.changeDefault("elsewhere");
  await expect(t.rpc("access.disable")).rejects.toThrow();
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings")).toHaveLength(2);
});

it("status never allocates, reloads or changes defaults and redacts failures", async () => {
  const t = setup();
  expect(await t.rpc("access.status")).toMatchObject({ available: true, ready: false, selected: false });
  expect(t.calls.map(c => c.method)).toEqual(["setup.current", "setup.status"]);
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings")).toHaveLength(0);
  expect(t.harness.sdk.callsTo("plugins.reload")).toHaveLength(0);
  t.setMissing();
  const reply = await t.rpc("access.status");
  expect(reply).toMatchObject({ available: false, ready: false });
  expect(JSON.stringify(reply)).not.toContain("secret-token");
});

it("requires allocation consent, retains the setup key, and exposes only safe fields", async () => {
  const t = setup();
  await expect(t.rpc("access.prepare", { key: "ui-test" })).rejects.toThrow();
  expect(t.calls).toHaveLength(0);
  const result = await t.rpc("access.prepare", { key: "ui-test", approveAllocation: true });
  expect(result).toMatchObject({ key: "ui-test", phase: "ready" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE SECRET");
  expect(t.calls.find(c => c.method === "setup.prepare")?.input).toEqual({ key: "ui-test", approveAllocation: true, image: "vercel/sandbox/node:24" });
  expect(await t.rpc("access.status")).toMatchObject({ phase: "ready" });
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings")).toHaveLength(0);
  expect(t.harness.sdk.callsTo("plugins.reload")).toHaveLength(0);
});

it("activates only through checked apply and scoped Access reload; stop never allocates", async () => {
  const t = setup();
  await t.rpc("access.prepare", { key: "ui-test", approveAllocation: true });
  expect(await t.rpc("access.activate", { key: "ui-test" })).toMatchObject({ ready: true, selected: false });
  expect(t.harness.sdk.callsTo("plugins.reload")).toEqual([[{ pluginId: "vercel-access" }]]);
  t.calls.length = 0;
  expect(await t.rpc("access.stop", { key: "ui-test" })).toMatchObject({ ready: false, phase: "removed" });
  expect(t.calls.map(c => c.method)).not.toContain("setup.prepare");
});

it("refuses activation with an automatic default before applying or reloading", async () => {
  const t = setup();
  t.changeDefault(null);
  await expect(t.rpc("access.activate", { key: "ui-test" })).rejects.toThrow();
  expect(t.calls).toHaveLength(0);
  expect(t.harness.sdk.callsTo("plugins.reload")).toHaveLength(0);
});

it("a recorded expired relay cannot be ready even with stale provider availability", async () => {
  const t = setup();
  await t.rpc("access.prepare", { key: "ui-test", approveAllocation: true });
  t.setReady();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 700_000);
  expect(await t.rpc("access.status")).toMatchObject({ ready: false, message: "Relay expired. Enable it to finish cleanup and start a new relay." });
});

it("requires readiness and expected-default consent; restores only its own selection", async () => {
  const t = setup();
  await expect(t.rpc("access.select", { expectedDefault: "direct", approveDefaultChange: true })).rejects.toThrow();
  t.setReady();
  await expect(t.rpc("access.select", { expectedDefault: "stale", approveDefaultChange: true })).rejects.toThrow();
  await expect(t.rpc("access.select", { expectedDefault: "direct" })).rejects.toThrow();
  expect(await t.rpc("access.select", { expectedDefault: "direct", approveDefaultChange: true })).toMatchObject({ selected: true, canRestore: true });
  expect(await t.rpc("access.restore")).toMatchObject({ selected: false, defaultProvider: "direct", canRestore: false });
  await t.rpc("access.select", { expectedDefault: "direct", approveDefaultChange: true });
  t.changeDefault("another-provider");
  await expect(t.rpc("access.restore")).rejects.toThrow();
  expect(await t.rpc("access.status")).toMatchObject({ defaultProvider: "another-provider" });
});
