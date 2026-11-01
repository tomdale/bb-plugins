import { createFakePluginHost, type ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { remoteVercelClient, ALLOCATION_LOOKUP_TIMEOUT_MS, ALLOCATION_LOOKUP_TIMEOUT_MESSAGE } from "./remote-client.js";
import { hostContract } from "./host-contract.js";
import { resourceSchema } from "./allocations.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const connection = { hostId: "host_auth", accountId: "user_test", teamId: "team_test", projectId: "prj_test", directory: null };
const resource = resourceSchema.parse({ version: 1, owner: "11111111-1111-4111-8111-111111111111", generation: "22222222-2222-4222-8222-222222222222", key: "lookup-test", sandboxName: `bb-${"a".repeat(48)}`, sessionId: null, expiresAt: null, inputs: { vcpus: 1, timeoutMinutes: 5 }, teamId: connection.teamId, projectId: connection.projectId, connection });
function setup(driver: (call: ExperimentalFakeHostRpcCall) => unknown | Promise<unknown>) {
  const t = createFakePluginHost({ pluginId: "environment-vercel-sandbox", experimental_callHostRpc: driver });
  disposals.push(() => t.harness.lifecycle.dispose());
  const hostClient = t.bb.hosts.experimental_client({ contract: hostContract });
  const call = vi.spyOn(hostClient, "call");
  vi.spyOn(t.bb.hosts, "experimental_client").mockReturnValue(hostClient as never);
  return { ...t, call, client: remoteVercelClient(t.bb).forResource(connection, resource) };
}
it("allows a 45-second read and gives the host RPC the same 60-second budget", async () => {
  vi.useFakeTimers();
  let requestSignal: AbortSignal | undefined;
  const t = setup(({ signal }) => new Promise((resolve, reject) => {
    requestSignal = signal;
    const timer = setTimeout(() => resolve({ ok: true, value: null }), 45_000);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  const pending = t.client.get(resource.sandboxName, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(requestSignal?.aborted).toBe(false);
  expect(t.call.mock.calls[0]?.[2]?.timeoutMs).toBe(ALLOCATION_LOOKUP_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(await pending).toBeNull();
  expect(t.harness.experimental_hostRpcCalls.map(call => call.method)).toEqual(["get"]);
});
it("reports the lookup deadline specifically and dispatches no create or bootstrap", async () => {
  vi.useFakeTimers();
  const t = setup(({ signal }) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("raw-private-error")), { once: true });
  }));
  const pending = expect(t.client.get(resource.sandboxName, new AbortController().signal)).rejects.toThrow(ALLOCATION_LOOKUP_TIMEOUT_MESSAGE);
  await vi.advanceTimersByTimeAsync(ALLOCATION_LOOKUP_TIMEOUT_MS);
  await pending;
  expect(t.harness.experimental_hostRpcCalls.map(call => call.method)).toEqual(["get"]);
});
it("keeps caller cancellation distinct from the lookup timeout", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  const t = setup(({ signal }) => new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const pending = expect(t.client.get(resource.sandboxName, controller.signal)).rejects.toBe(reason);
  controller.abort(reason);
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
it("does not dispatch a lookup for an already-cancelled caller", async () => {
  const t = setup(() => { throw new Error("must not dispatch"); });
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  await expect(t.client.get(resource.sandboxName, controller.signal)).rejects.toBe(reason);
  expect(t.harness.experimental_hostRpcCalls).toHaveLength(0);
});
it("preserves non-timeout safe host failures", async () => {
  const t = setup(() => ({ ok: false, message: "The connected Vercel account changed." }));
  await expect(t.client.get(resource.sandboxName, new AbortController().signal)).rejects.toThrow("The connected Vercel account changed.");
});
