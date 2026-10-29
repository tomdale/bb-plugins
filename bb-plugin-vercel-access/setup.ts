import { cliCommand, defineCli, defineRpcContract, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import ssh2 from "ssh2";
import { z } from "zod";

const keySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const inputSchema = z.object({ key: keySchema }).strict();
const imageSchema = z.literal("vercel/sandbox/node:24").default("vercel/sandbox/node:24");
// This is the public, secret-free contract owned by the Vercel Sandbox plugin.
export const relayViewSchema = z.object({
  key: keySchema, generation: z.string().uuid(), name: z.string().regex(/^bb-relay-[a-f0-9]{48}$/),
  hostId: z.string().min(1).max(200), accountId: z.string().min(1).max(200),
  teamId: z.string().max(200), projectId: z.string().max(200),
  phase: z.enum(["prepared", "submitted", "allocated", "launching", "ready", "stopping", "deleting", "removed"]),
  sessionId: z.string().min(1).max(200).nullable(), commandId: z.string().min(1).max(200).nullable(),
  origin: z.string().url().max(300).nullable(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().finite().nullable(), computeEnded: z.boolean(), metadataDeleted: z.boolean(),
  observedStatus: z.string().max(32), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  image: z.string().max(300), vcpus: z.number().int().min(1).max(32).nullable(), persistent: z.boolean().nullable(),
  timeoutMs: z.number().int().positive().max(86_400_000).nullable(), nodeVersion: z.string().regex(/^v24\.[0-9]+\.[0-9]+$/).max(32).nullable(),
}).strict();
type View = z.infer<typeof relayViewSchema>;
const receiptSchema = relayViewSchema.pick({
  key: true, generation: true, name: true, hostId: true, accountId: true, teamId: true, projectId: true,
  fingerprint: true, artifactSha256: true, sessionId: true, origin: true, commandId: true,
});
type Receipt = z.infer<typeof receiptSchema>;
const recordSchema = z.object({ key: keySchema, image: imageSchema, authorizedKey: z.string().max(128), bridgePort: z.number().int().min(1024).max(65535), receipt: receiptSchema.nullable().default(null) }).strict();
type SetupRecord = z.infer<typeof recordSchema>;
function assertPrivateIdentity(privateKey: string | undefined, authorizedKey: string): asserts privateKey is string {
  if (!privateKey) throw new Error("Private connector identity is unavailable");
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error || Array.isArray(parsed) || `ssh-ed25519 ${parsed.getPublicSSH().toString("base64")}` !== authorizedKey) throw new Error("Connector identity changed");
}
export const setupContract = defineRpcContract({
  "setup.prepare": { input: inputSchema.extend({ approveAllocation: z.literal(true), image: imageSchema }).strict(), output: relayViewSchema },
  "setup.inspect": { input: inputSchema, output: relayViewSchema.nullable() },
  "setup.stop": { input: inputSchema, output: relayViewSchema.nullable() },
  "setup.apply": { input: inputSchema, output: relayViewSchema },
});

/** Registers only explicit owner operations; observation and native acquire never call these. */
export function registerSetup(bb: BbPluginApi, options: {
  config: () => Promise<{ enabled: boolean; port: number; preparedConnectorPrivateKey?: string }>;
  saveKey: (key: string) => Promise<void>;
  apply: (view: View, key: string) => Promise<void>;
  disable: () => Promise<void>;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>) => {
    const result = tail.catch(() => {}).then(fn);
    tail = result;
    return result.catch(() => { throw new Error("Relay setup was not confirmed. Inspect or stop the recorded key on its original authentication machine; no automatic replacement is attempted."); });
  };
  const activeRecord = async () => {
    const value = await bb.storage.kv.get<unknown>("relay-setup");
    return value === undefined ? null : recordSchema.parse(value);
  };
  const getRecord = async (key: string) => {
    const active = await activeRecord();
    if (active?.key === key) return active;
    const value = await bb.storage.kv.get<unknown>(`relay-setup-history/${key}`);
    if (value === undefined) return null;
    const record = recordSchema.parse(value);
    if (record.key !== key) throw new Error("Retained relay key does not match its record");
    return record;
  };
  const observe = async (record: SetupRecord, method: "relay.prepare" | "relay.inspect" | "relay.stop") => {
    const { receipt: previous, ...setup } = record;
    const view = await bb.sdk.plugins.callRpc({ pluginId: "environment-vercel-sandbox", method,
      input: method === "relay.prepare" ? setup : { key: record.key }, outputSchema: relayViewSchema.nullable() });
    if (!view) {
      if (previous) throw new Error("Previously observed relay identity is unavailable");
      return null;
    }
    if (view.key !== record.key) throw new Error("Relay reply does not match the requested setup key");
    const receipt = receiptSchema.parse(Object.fromEntries(Object.keys(receiptSchema.shape).map(key => [key, view[key as keyof View]])));
    if (previous) for (const key of Object.keys(previous) as (keyof Receipt)[]) {
      if (previous[key] !== null && previous[key] !== receipt[key]) throw new Error("Relay reply changed its recorded public identity");
    }
    const active = await activeRecord();
    const storageKey = active?.key === record.key ? "relay-setup" : `relay-setup-history/${record.key}`;
    await bb.storage.kv.set(storageKey, { ...record, receipt });
    return view;
  };
  const prepare = (key: string, image: string) => serialized(async () => {
    const config = await options.config();
    if (config.enabled) throw new Error("Disable the current bridge before preparing setup");
    let record = await activeRecord();
    if (record && record.key !== key) {
      const previous = await observe(record, "relay.inspect");
      if (previous?.phase !== "removed" || !previous.computeEnded || !previous.metadataDeleted) throw new Error("Previous relay cleanup is unresolved");
      if (await getRecord(key)) throw new Error("A retained setup key cannot be reused");
      const retained = await activeRecord();
      if (!retained || retained.key !== record.key) throw new Error("Active relay setup changed");
      await bb.storage.kv.set(`relay-setup-history/${record.key}`, retained);
      record = null;
    }
    if (record && record.image !== image) throw new Error("Restore the original relay image");
    let privateKey = config.preparedConnectorPrivateKey;
    if (!record) {
      const pair = ssh2.utils.generateKeyPairSync("ed25519");
      privateKey = pair.private;
      await options.saveKey(privateKey);
      record = recordSchema.parse({ key, image, authorizedKey: pair.public, bridgePort: config.port });
      await bb.storage.kv.set("relay-setup", record);
    }
    assertPrivateIdentity(privateKey, record.authorizedKey);
    const view = await observe(record, "relay.prepare");
    if (!view) throw new Error("Relay preparation returned no identity");
    return view;
  });
  const handlers = {
    "setup.prepare": ({ key, image }: { key: string; image: string; approveAllocation: true }) => prepare(key, image),
    "setup.inspect": ({ key }: { key: string }) => serialized(async () => {
      const record = await getRecord(key);
      return record ? observe(record, "relay.inspect") : null;
    }),
    "setup.stop": ({ key }: { key: string }) => serialized(async () => {
      const record = await getRecord(key);
      if (!record) return null;
      // Revoke the matching current setup even while its auth host is offline.
      // Historical cleanup must not invalidate a replacement's live leases.
      if ((await activeRecord())?.key === key) await options.disable();
      return observe(record, "relay.stop");
    }),
    "setup.apply": ({ key }: { key: string }) => serialized(async () => {
      const record = await activeRecord();
      const config = await options.config();
      if (!record || record.key !== key || config.enabled || !config.preparedConnectorPrivateKey || config.port !== record.bridgePort) throw new Error("Disable the bridge and restore its private setup identity and port");
      assertPrivateIdentity(config.preparedConnectorPrivateKey, record.authorizedKey);
      const view = await observe(record, "relay.inspect");
      if (!view || !view.nodeVersion || view.phase !== "ready" || view.vcpus !== 1 || view.persistent !== false || view.timeoutMs !== 600_000 || view.image !== "vercel/sandbox/node:24" || !view.origin || !view.sessionId || view.computeEnded || !view.expiresAt || view.expiresAt <= Date.now() || view.observedStatus !== "command-pending-or-running") throw new Error("Relay is not provisioned");
      await options.apply(view, config.preparedConnectorPrivateKey);
      return view;
    }),
  };
  bb.rpc.register(setupContract, handlers);
  const cli = <T>(run: () => Promise<T>) => run().then(value => ({ exitCode: 0, stdout: JSON.stringify(value) })).catch(() => { throw new PluginCliError("Relay setup was not confirmed; inspect or stop the retained setup key. No private setup values are emitted."); });
  bb.cli.register(defineCli({ name: "vercel-access", summary: "Explicit bounded relay setup; never allocates during machine acquisition", commands: {
    "relay prepare": cliCommand({ summary: "Allocate at most one 1-vCPU, ten-minute relay in the connected account", options: {
      key: { type: "string", required: true, description: "Stable setup key; reuse it after an uncertain reply" },
      "confirm-cost": { type: "boolean", description: "Explicitly approve this bounded allocation" },
    }, run(input) { return cli(() => handlers["setup.prepare"](setupContract["setup.prepare"].input.parse({ key: input.options.key, approveAllocation: input.options["confirm-cost"] }))); } }),
    "relay inspect": cliCommand({ summary: "Observe the original relay intent without allocation or resume", options: { key: { type: "string", required: true, description: "Recorded setup key" } }, run(input) { return cli(() => handlers["setup.inspect"](inputSchema.parse({ key: input.options.key }))); } }),
    "relay stop": cliCommand({ summary: "Disable local access and stop/delete only the originally owned relay", options: { key: { type: "string", required: true, description: "Recorded setup key" } }, run(input) { return cli(() => handlers["setup.stop"](inputSchema.parse({ key: input.options.key }))); } }),
    "relay apply": cliCommand({ summary: "Copy trusted relay setup into disabled settings; enabling/reload remain explicit", options: { key: { type: "string", required: true, description: "Recorded setup key" } }, run(input) { return cli(() => handlers["setup.apply"](inputSchema.parse({ key: input.options.key }))); } }),
  } }));
}
