import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createVercelSandboxPlugin } from "./server.js";
import { relayIdentitySchema, type RelayView } from "./relay-contract.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { relayName } from "./relay-identity.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const connection = { hostId: "host_original", accountId: "account_original", teamId: "team_original", projectId: "prj_original", directory: null };
const setup = { key: "synthetic-relay", image: "vercel/sandbox/node:24", authorizedKey: `ssh-ed25519 ${Buffer.alloc(51).toString("base64")}`, bridgePort: 38991 };

it("actual public server harness pins relay intent before host call, survives lost replies/reload and never falls back to new connection — fake cloud", async () => {
  let lost = true;
  const calls: { method: string; hostId: string; input: unknown; initialize?: boolean }[] = [];
  const host = createFakePluginHost({ pluginId: "environment-vercel-sandbox", experimental_callHostRpc: async ({ method, hostId, input }) => {
    const { initialize, ...identity } = relayIdentitySchema.extend({ initialize: z.boolean().optional() }).strict().parse(input);
    calls.push({ method, hostId, input: identity, initialize });
    expect(await live.storage.kv.get(`relay-intents/${setup.key}`)).toEqual(identity);
    if (method === "relayPrepare" && lost) throw new Error("synthetic-secret response lost");
    const view: RelayView = { key: identity.key, generation: identity.generation, name: relayName(identity),
      hostId, accountId: identity.connection.accountId, teamId: identity.connection.teamId, projectId: identity.connection.projectId,
      phase: method === "relayStop" ? "removed" : "submitted", sessionId: null, commandId: null,
      origin: null, fingerprint: "a".repeat(64), expiresAt: null, computeEnded: false, metadataDeleted: false,
      observedStatus: "unobserved", artifactSha256: "b".repeat(64), requestedImage: "vercel/sandbox/node:24", image: `vercel/sandbox/node@sha256:${"a".repeat(64)}`, resolvedImage: `vercel/sandbox/node@sha256:${"a".repeat(64)}`, nodeVersion: null, vcpus: null, persistent: null, timeoutMs: null,
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
  expect(calls.filter(c => c.method === "relayPrepare").map(c => c.initialize)).toEqual([true, false]);
  expect(await next.bb.storage.kv.list("allocations/")).toEqual([]);
});

it("concurrent distinct setup keys admit at most16 intents and release admission before remote work", async () => {
  let dispatches = 0;
  const releases: (() => void)[] = [];
  const host = createFakePluginHost({ pluginId: "environment-vercel-sandbox", experimental_callHostRpc: async () => {
    dispatches++;
    await new Promise<void>(resolve => releases.push(resolve));
    return { ok: false, message: "Synthetic unresolved host submission" };
  } });
  closes.push(() => host.harness.lifecycle.dispose());
  await host.bb.storage.kv.set("cli-connection", connection);
  await createVercelSandboxPlugin()(host.bb);
  const owner = await host.bb.storage.kv.get<string>("owner");
  for (let i = 0; i < 15; i++) await host.bb.storage.kv.set(`relay-intents/retained-${i}`, {
    ...setup, key: `retained-${i}`, owner, generation: randomUUID(), connection,
  });
  const first = host.harness.behavior.callRpc("relay.prepare", { ...setup, key: "new-first" });
  const second = host.harness.behavior.callRpc("relay.prepare", { ...setup, key: "new-second" });
  const settled = Promise.allSettled([first, second]);
  let capacityRejected = false;
  void second.then(() => {}, () => { capacityRejected = true; });
  // A host request remains pending; namespace admission must still finish
  // before that request is released. Always release before test assertions.
  for (let i = 0; i < 50 && !capacityRejected; i++) await new Promise(resolve => setTimeout(resolve, 1));
  const beforeRelease = { dispatches, capacityRejected, count: (await host.bb.storage.kv.list("relay-intents/")).length };
  releases.forEach(release => release());
  expect((await settled).every(result => result.status === "rejected")).toBe(true);
  expect(beforeRelease).toEqual({ dispatches: 1, capacityRejected: true, count: 16 });
  expect(dispatches).toBe(1);
});

it("a crash after durable first dispatch reservation cannot authorize initialization on retry", async () => {
  const flags: boolean[] = [];
  const host = createFakePluginHost({ pluginId: "environment-vercel-sandbox", experimental_callHostRpc: async ({ method, input }) => {
    expect(method).toBe("relayPrepare");
    const request = relayIdentitySchema.extend({ initialize: z.boolean() }).parse(input);
    flags.push(request.initialize);
    throw new Error("Synthetic lost first host delivery");
  } });
  closes.push(() => host.harness.lifecycle.dispose());
  await host.bb.storage.kv.set("cli-connection", connection);
  await createVercelSandboxPlugin()(host.bb);
  await expect(host.harness.behavior.callRpc("relay.prepare", setup)).rejects.toThrow();
  const next = await host.harness.lifecycle.reload(createVercelSandboxPlugin());
  await expect(next.harness.behavior.callRpc("relay.prepare", setup)).rejects.toThrow();
  expect(flags).toEqual([true, false]);
});

it("binds every prepare/inspect/stop reply to original identity and first public receipt — fake host", async () => {
  let change: { [key: string]: unknown } = { sessionId: null, origin: null, commandId: null };
  let hostCalls = 0;
  const host = createFakePluginHost({ pluginId: "environment-vercel-sandbox", experimental_callHostRpc: async ({ method, input }) => {
    hostCalls++;
    const { initialize: _initialize, ...identity } = relayIdentitySchema.extend({ initialize: z.boolean().optional() }).parse(input);
    const view: RelayView = {
      key: identity.key, generation: identity.generation, name: relayName(identity), hostId: identity.connection.hostId,
      accountId: identity.connection.accountId, teamId: identity.connection.teamId, projectId: identity.connection.projectId,
      phase: method === "relayStop" ? "removed" : "ready", sessionId: "session_original", commandId: "cmd_original",
      origin: "https://synthetic-relay.vercel.run", fingerprint: "a".repeat(64), expiresAt: Date.now() + 600_000,
      computeEnded: method === "relayStop", metadataDeleted: method === "relayStop", observedStatus: "running", artifactSha256: "b".repeat(64),
      requestedImage: "vercel/sandbox/node:24", image: `vercel/sandbox/node@sha256:${"a".repeat(64)}`, resolvedImage: `vercel/sandbox/node@sha256:${"a".repeat(64)}`, nodeVersion: "v24.22.1", vcpus: 1, persistent: false, timeoutMs: 600_000,
    };
    return { ok: true, value: { ...view, ...change } };
  } });
  closes.push(() => host.harness.lifecycle.dispose());
  await host.bb.storage.kv.set("cli-connection", connection);
  await createVercelSandboxPlugin()(host.bb);
  await host.harness.behavior.callRpc("relay.prepare", setup);
  expect(await host.bb.storage.kv.get(`relay-receipts/${setup.key}`)).toMatchObject({ sessionId: null, origin: null, commandId: null });
  change = {};
  await host.harness.behavior.callRpc("relay.inspect", { key: setup.key });
  const receipt = await host.bb.storage.kv.get(`relay-receipts/${setup.key}`);
  const mutations: { [key: string]: unknown }[] = [
    { key: "foreign-relay" }, { generation: randomUUID() }, { name: `bb-relay-${"c".repeat(48)}` },
    { hostId: "host_foreign" }, { accountId: "account_foreign" }, { teamId: "team_foreign" }, { projectId: "prj_foreign" },
    { fingerprint: "c".repeat(64) }, { artifactSha256: "c".repeat(64) }, { sessionId: "session_foreign" },
    { origin: "https://foreign-relay.vercel.run" }, { commandId: "cmd_foreign" }, { origin: null }, { sessionId: null }, { commandId: null },
    { requestedImage: "vercel/sandbox/node:22" }, { resolvedImage: `vercel/sandbox/node@sha256:${"b".repeat(64)}` }, { resolvedImage: null },
  ];
  for (const method of ["relay.prepare", "relay.inspect", "relay.stop"]) for (const mutation of mutations) {
    change = mutation;
    await expect(host.harness.behavior.callRpc(method, method === "relay.prepare" ? setup : { key: setup.key })).rejects.toThrow();
    expect(await host.bb.storage.kv.get(`relay-receipts/${setup.key}`)).toEqual(receipt);
  }
  change = { image: `vercel/sandbox/node@sha256:${"b".repeat(64)}` };
  for (const method of ["relay.prepare", "relay.inspect"]) await expect(host.harness.behavior.callRpc(method, method === "relay.prepare" ? setup : { key: setup.key })).rejects.toThrow();
  expect(await host.harness.behavior.callRpc("relay.stop", { key: setup.key })).toMatchObject({ phase: "removed", resolvedImage: `vercel/sandbox/node@sha256:${"a".repeat(64)}` });
  change = {};
  expect(await host.harness.behavior.callRpc("relay.inspect", { key: setup.key })).toMatchObject({ key: setup.key, hostId: connection.hostId });
  const next = await host.harness.lifecycle.reload(createVercelSandboxPlugin());
  change = { fingerprint: "c".repeat(64) };
  await expect(next.harness.behavior.callRpc("relay.inspect", { key: setup.key })).rejects.toThrow();
  expect(await next.bb.storage.kv.get(`relay-receipts/${setup.key}`)).toEqual(receipt);
  await next.bb.storage.kv.delete(`relay-intents/${setup.key}`);
  const before = hostCalls;
  for (const method of ["relay.prepare", "relay.inspect", "relay.stop"]) await expect(next.harness.behavior.callRpc(method, method === "relay.prepare" ? setup : { key: setup.key })).rejects.toThrow();
  expect(hostCalls).toBe(before);
});

it("unknown relay inspect/stop are observational and never initialize an account or call a host", async () => {
  const host = createFakePluginHost({ pluginId: "environment-vercel-sandbox" });
  closes.push(() => host.harness.lifecycle.dispose());
  await createVercelSandboxPlugin()(host.bb);
  expect(await host.harness.behavior.callRpc("relay.inspect", { key: "unknown" })).toBeNull();
  expect(await host.harness.behavior.callRpc("relay.stop", { key: "unknown" })).toBeNull();
  expect(host.harness.experimental_hostRpcCalls).toEqual([]);
});
