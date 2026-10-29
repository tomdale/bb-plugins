import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { relayIdentitySchema, relaySetupSchema, relayReceipt, relayReceiptSchema, type RelayIdentity, type RelayReceipt } from "./relay-contract.js";
import { relayName } from "./relay-identity.js";
import { SafeError, safeMessage } from "./configuration.js";
import type { Connection } from "./auth-contract.js";
import { remoteVercelClient } from "./remote-client.js";

export function relayHandlers(bb: BbPluginApi, options: {
  owner: string; connection: () => Promise<Connection>;
  run: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  signal: () => AbortSignal;
}) {
  const remote = remoteVercelClient(bb);
  const stored = async (key: string) => {
    const raw = await bb.storage.kv.get<unknown>(`relay-intents/${key}`);
    if (raw === undefined) {
      if (await bb.storage.kv.get<unknown>(`relay-receipts/${key}`) !== undefined) throw new SafeError("Relay receipt is retained but its original intent is missing. Refusing reinitialization; retain records for investigation.");
      return null;
    }
    const identity = relayIdentitySchema.parse(raw);
    if (identity.owner !== options.owner || identity.key !== key) throw new SafeError("Relay intent belongs to another namespace.");
    return identity;
  };
  const invoke = <T>(key: string, fn: () => Promise<T>) => options.run(`relay/${key}`, fn).catch(error => {
    throw new SafeError(safeMessage(error));
  });
  const observe = async (method: "relayPrepare" | "relayInspect" | "relayStop", identity: RelayIdentity, initialize = false) => {
    const view = await remote.relay(method, identity, options.signal(), initialize);
    if (view.key !== identity.key || view.generation !== identity.generation || view.name !== relayName(identity) ||
      view.hostId !== identity.connection.hostId || view.accountId !== identity.connection.accountId ||
      view.teamId !== identity.connection.teamId || view.projectId !== identity.connection.projectId)
      throw new SafeError("Relay reply does not match its retained allocation identity and original connection.");
    const receipt = relayReceipt(view);
    const stored = await bb.storage.kv.get<unknown>(`relay-receipts/${identity.key}`);
    if (stored !== undefined) {
      const previous = relayReceiptSchema.parse(stored);
      for (const key of Object.keys(previous) as (keyof RelayReceipt)[]) {
        if (previous[key] !== null && previous[key] !== receipt[key]) throw new SafeError("Relay reply changed a previously recorded public identity. Retain the original intent for investigation.");
      }
    }
    // Persist the first trusted receipt before exposing its endpoint or pin.
    // Null identifiers may become known once; known values cannot be replaced.
    await bb.storage.kv.set(`relay-receipts/${identity.key}`, receipt);
    return view;
  };
  return {
    "relay.prepare": async (input: { key: string; authorizedKey: string; bridgePort: number; image: string }) => invoke(input.key, async () => {
      const setup = relaySetupSchema.parse(input);
      const { identity, initialize } = await options.run("relay-admission", async () => {
        const existing = await stored(input.key);
        if (existing) {
          if (existing.authorizedKey !== setup.authorizedKey || existing.bridgePort !== setup.bridgePort || existing.image !== setup.image) throw new SafeError("Relay key already has different setup. Inspect or stop the original intent.");
          return { identity: existing, initialize: false };
        }
        if ((await bb.storage.kv.list("relay-intents/")).length >= 16) throw new SafeError("Relay intent limit reached; retain records and investigate before preparing more relays.");
        const identity = { ...setup, owner: options.owner, generation: randomUUID(), connection: await options.connection() };
        // Existence consumes the one initialization dispatch, even if this
        // server crashes before the host receives it. Retries cannot recreate
        // a lost private journal or silently rotate the relay host identity.
        await bb.storage.kv.set(`relay-intents/${input.key}`, identity);
        return { identity, initialize: true };
      });
      return observe("relayPrepare", identity, initialize);
    }),
    "relay.inspect": async ({ key }: { key: string }) => invoke(key, async () => {
      const identity = await stored(key);
      return identity ? observe("relayInspect", identity) : null;
    }),
    "relay.stop": async ({ key }: { key: string }) => invoke(key, async () => {
      const identity = await stored(key);
      return identity ? observe("relayStop", identity) : null;
    }),
  };
}
