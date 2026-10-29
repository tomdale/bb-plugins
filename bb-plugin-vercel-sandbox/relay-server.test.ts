import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createVercelSandboxPlugin } from "./server.js";
import { relayIdentitySchema, type RelayView } from "./relay-contract.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const connection = { hostId: "host_original", accountId: "account_original", teamId: "team_original", projectId: "prj_original", directory: null };
const setup = { key: "synthetic-relay", image: "vercel/sandbox/node:24", authorizedKey: `ssh-ed25519 ${Buffer.alloc(51).toString("base64")}`, bridgePort: 38991 };

it("actual public server harness pins relay intent before host call, survives lost replies/reload and never falls back to new connection — fake cloud", async () => {
  let lost = true;
  const calls: { method: string; hostId: string; input: unknown }[] = [];
  const host = createFakePluginHost({ pluginId: "environment-vercel-sandbox", experimental_callHostRpc: async ({ method, hostId, input }) => {
    calls.push({ method, hostId, input });
    const identity = relayIdentitySchema.parse(input);
    expect(await live.storage.kv.get(`relay-intents/${setup.key}`)).toEqual(identity);
    if (method === "relayPrepare" && lost) throw new Error("synthetic-secret response lost");
    const view: RelayView = { key: identity.key, generation: identity.generation, name: `bb-relay-${"a".repeat(48)}`,
      hostId, accountId: identity.connection.accountId, teamId: identity.connection.teamId, projectId: identity.connection.projectId,
      phase: method === "relayStop" ? "removed" : "submitted", sessionId: null, commandId: null,
      origin: null, fingerprint: "a".repeat(64), expiresAt: null, computeEnded: false, metadataDeleted: false,
      observedStatus: "unobserved", artifactSha256: "b".repeat(64), image: "vercel/sandbox/node:24", nodeVersion: null, vcpus: null, persistent: null, timeoutMs: null,
    };
    return { ok: true, value: view };
  } });
  let live = host.bb;
  closes.push(() => host.harness.lifecycle.dispose());
  await host.bb.storage.kv.set("cli-connection", connection);
  await createVercelSandboxPlugin()(host.bb);
  expect(calls).toHaveLength(0);
  await expect(host.harness.behavior.callRpc("relay.prepare", setup)).rejects.toThrow();
  const intent = await host.bb.storage.kv.get(`relay-intents/${setup.key}`);
  expect(intent).toMatchObject({ connection });
  await host.bb.storage.kv.set("cli-connection", { ...connection, hostId: "host_new", accountId: "new_account" });
  lost = false;
  const next = await host.harness.lifecycle.reload(createVercelSandboxPlugin());
  live = next.bb;
  const inspected = await next.harness.behavior.callRpc("relay.inspect", { key: setup.key });
  expect(inspected).toMatchObject({ hostId: connection.hostId, accountId: connection.accountId });
  await next.harness.behavior.callRpc("relay.prepare", setup);
  await next.harness.behavior.callRpc("relay.stop", { key: setup.key });
  expect(calls.every(c => c.hostId === connection.hostId)).toBe(true);
  expect(calls.every(c => JSON.stringify(c.input) === JSON.stringify(calls[0]!.input))).toBe(true);
  await expect(next.harness.behavior.callRpc("relay.prepare", { ...setup, bridgePort: 5000 })).rejects.toThrow();
  expect(calls).toHaveLength(4);
  expect(await next.bb.storage.kv.list("allocations/")).toEqual([]);
});

it("unknown relay inspect/stop are observational and never initialize an account or call a host", async () => {
  const host = createFakePluginHost({ pluginId: "environment-vercel-sandbox" });
  closes.push(() => host.harness.lifecycle.dispose());
  await createVercelSandboxPlugin()(host.bb);
  expect(await host.harness.behavior.callRpc("relay.inspect", { key: "unknown" })).toBeNull();
  expect(await host.harness.behavior.callRpc("relay.stop", { key: "unknown" })).toBeNull();
  expect(host.harness.experimental_hostRpcCalls).toEqual([]);
});
