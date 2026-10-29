import { defineRpcContract, type JsonValue } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { accessHandlers } from "./access-server.js";
import { accessMethods, ACCESS_PROVIDER } from "./access-contract.js";
import type { createRelayAccess } from "./relay-access/server.ts";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
function setup() {
  let defaultProvider: string | null = "direct";
  let ready = false, enabled = false, missing = false, losePrepare = false;
  let expiresAt = Date.now() + 600_000;
  let key: string | null = null;
  const calls: { method: string; input: unknown }[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "environment-vercel-sandbox" });
  disposals.push(() => harness.lifecycle.dispose());
  harness.sdk.stub("system.config", () => ({
    generalSettings: { defaultMachineAccess: defaultProvider, machineServerUrl: "https://private.invalid", managedBranchPrefix: "custom/" },
    serverAccess: { defaultProviderId: defaultProvider ?? "direct", providers: [{ id: ACCESS_PROVIDER, availability: { status: ready ? "available" : "unavailable" } }] },
  }));
  harness.sdk.stub("system.updateGeneralSettings", (input: unknown) => {
    const value = input as { defaultMachineAccess: string | null; machineServerUrl: string };
    expect(value.machineServerUrl).toBe("https://private.invalid");
    defaultProvider = value.defaultMachineAccess;
    return value;
  });
  const driver = (method: string, input?: { key?: string }) => {
    calls.push({ method, input });
    if (missing) throw new Error("secret-token must not escape");
    const view = { key, phase: "ready", expiresAt, computeEnded: false, metadataDeleted: false, connectorPrivateKey: "PRIVATE SECRET" };
    switch (method) {
      case "setup.current": return { key };
      case "setup.status": return { stages: [{ stage: "readiness", state: ready ? "verified" : "closed" }] };
      case "setup.prepare": key = input!.key!; if (losePrepare) throw new Error("lost reply"); expiresAt = Date.now() + 600_000; return { ...view, key, expiresAt };
      case "setup.stop": ready = false; enabled = false; return { ...view, phase: "removed", computeEnded: true, metadataDeleted: true };
      default: return view;
    }
  };
  const enable = vi.fn(async () => { enabled = true; ready = true; });
  const disable = vi.fn(async () => { enabled = false; ready = false; });
  const relay = {
    supported: true, settings: { get: async () => ({ enabled }) }, enable, disable,
    setup: Object.fromEntries(["current", "status", "prepare", "inspect", "apply", "stop"].map(name => [`setup.${name}`, (input: { key?: string }) => driver(`setup.${name}`, input)])),
  } as unknown as Awaited<ReturnType<typeof createRelayAccess>>;
  bb.rpc.register(defineRpcContract(accessMethods), accessHandlers(bb, relay));
  return { harness, relay, enable, disable, calls, setLostReply: (value: boolean) => { losePrepare = value; }, setReady: () => { ready = true; }, setMissing: () => { missing = true; },
    changeDefault: (value: string | null) => { defaultProvider = value; },
    rpc: (method: keyof typeof accessMethods, input: JsonValue = {}) => harness.behavior.callRpc(method, input) };
}

it("one enable provisions, connects and selects within the same plugin without plugin-management calls", async () => {
  const t = setup();
  expect(await t.rpc("access.enable")).toMatchObject({ ready: true, selected: true, canRestore: true });
  await t.rpc("access.enable");
  expect(t.enable).toHaveBeenCalledTimes(1);
  expect(t.calls.filter(c => c.method === "setup.prepare")).toHaveLength(1);
  expect(await t.rpc("access.disable")).toMatchObject({ ready: false, selected: false, defaultProvider: "direct", phase: "removed" });
  for (const method of ["plugins.callRpc", "plugins.reload", "plugins.enable", "plugins.updateSettings"]) expect(t.harness.sdk.callsTo(method)).toHaveLength(0);
});
it("serializes migration with enable so a partial import cannot race provisioning", async () => {
  const t = setup();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.relay.settings.experimental_set = async () => { entered(); await blocked; };
  const importing = t.harness.behavior.callRpc("access.importLegacy", { config: {}, records: [] });
  await started;
  const enabling = t.rpc("access.enable");
  await Promise.resolve();
  expect(t.calls.some(c => c.method === "setup.prepare")).toBe(false);
  release();
  await importing;
  expect(await enabling).toMatchObject({ ready: true, selected: true });
});

it("selects an already-ready relay without allocating or restarting it", async () => {
  const t = setup(); t.setReady();
  expect(await t.rpc("access.enable")).toMatchObject({ ready: true, selected: true });
  expect(t.calls.some(c => c.method === "setup.prepare")).toBe(false);
  expect(t.enable).not.toHaveBeenCalled();
});
it("does not select an unready relay and retries the existing connection without restarting", async () => {
  vi.useFakeTimers(); const t = setup();
  t.enable.mockImplementation(async () => {});
  const failed = expect(t.rpc("access.enable")).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(11_000); await failed;
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings")).toHaveLength(0);
  t.setReady(); await t.rpc("access.enable");
  expect(t.enable).toHaveBeenCalledTimes(1);
});
it("restores a usable Direct connection instead of auto-selecting the disabled integrated provider", async () => {
  const t = setup(); t.changeDefault(null);
  await t.rpc("access.enable");
  expect(await t.rpc("access.disable")).toMatchObject({ defaultProvider: "direct", selected: false });
});
it("retains the same key after a lost preparation reply", async () => {
  const t = setup(); t.setLostReply(true);
  await expect(t.rpc("access.enable")).rejects.toThrow();
  const first = t.calls.find(c => c.method === "setup.prepare")!.input as { key: string };
  t.setLostReply(false); await t.rpc("access.enable");
  expect(t.calls.find(c => c.method === "setup.inspect")!.input).toMatchObject({ key: first.key });
});
it("replaces expired compute only after confirmed cleanup", async () => {
  const t = setup(); await t.rpc("access.enable");
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 700_000);
  expect(await t.rpc("access.enable")).toMatchObject({ ready: true, selected: true });
  const methods = t.calls.map(c => c.method);
  expect(methods.lastIndexOf("setup.stop")).toBeLessThan(methods.lastIndexOf("setup.prepare"));
});
it("restores the default even when local disable fails", async () => {
  const t = setup(); await t.rpc("access.enable");
  t.disable.mockRejectedValue(new Error("stop failed"));
  await expect(t.rpc("access.disable")).rejects.toThrow();
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings").at(-1)).toMatchObject([{ defaultMachineAccess: "direct" }]);
});
it("restores the default before uncertain cloud cleanup and preserves an externally changed selection", async () => {
  const t = setup(); await t.rpc("access.enable");
  t.relay.setup["setup.stop"] = async () => { throw new Error("offline"); };
  await expect(t.rpc("access.disable")).rejects.toThrow();
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings").at(-1)).toMatchObject([{ defaultMachineAccess: "direct" }]);
  t.changeDefault("elsewhere"); await expect(t.rpc("access.disable")).rejects.toThrow();
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings")).toHaveLength(2);
});
it("status is local, read-only and redacts failures", async () => {
  const t = setup();
  expect(await t.rpc("access.status")).toMatchObject({ available: true, ready: false, selected: false });
  expect(t.calls.map(c => c.method)).toEqual(["setup.current", "setup.status"]);
  expect(t.harness.sdk.callsTo("system.updateGeneralSettings")).toHaveLength(0);
  t.setMissing(); const reply = await t.rpc("access.status");
  expect(reply).toMatchObject({ available: false, ready: false });
  expect(JSON.stringify(reply)).not.toContain("secret-token");
});
it("keeps legacy prepare validation and strips private values", async () => {
  const t = setup();
  await expect(t.rpc("access.prepare", { key: "ui-test" })).rejects.toThrow();
  expect(t.calls).toHaveLength(0);
  const result = await t.rpc("access.prepare", { key: "ui-test", approveAllocation: true });
  expect(result).toMatchObject({ key: "ui-test", phase: "ready" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE SECRET");
});
it("activates checked setup in-process and never reloads worker management", async () => {
  const t = setup(); await t.rpc("access.prepare", { key: "ui-test", approveAllocation: true });
  expect(await t.rpc("access.activate", { key: "ui-test" })).toMatchObject({ ready: true, selected: false });
  expect(t.enable).toHaveBeenCalledTimes(1);
  expect(t.harness.sdk.callsTo("plugins.reload")).toHaveLength(0);
});
it("preserves guarded explicit selection/restoration for existing RPC callers", async () => {
  const t = setup();
  await expect(t.rpc("access.select", { expectedDefault: "direct", approveDefaultChange: true })).rejects.toThrow();
  t.setReady();
  await expect(t.rpc("access.select", { expectedDefault: "stale", approveDefaultChange: true })).rejects.toThrow();
  await t.rpc("access.select", { expectedDefault: "direct", approveDefaultChange: true });
  expect(await t.rpc("access.restore")).toMatchObject({ selected: false, defaultProvider: "direct" });
});
