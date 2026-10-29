import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { relayIdentitySchema, relaySetupSchema } from "./relay-contract.js";
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
    if (raw === undefined) return null;
    const identity = relayIdentitySchema.parse(raw);
    if (identity.owner !== options.owner || identity.key !== key) throw new SafeError("Relay intent belongs to another namespace.");
    return identity;
  };
  const invoke = <T>(key: string, fn: () => Promise<T>) => options.run(`relay/${key}`, fn).catch(error => {
    throw new SafeError(safeMessage(error));
  });
  return {
    "relay.prepare": async (input: { key: string; authorizedKey: string; bridgePort: number; image: string }) => invoke(input.key, async () => {
      const setup = relaySetupSchema.parse(input);
      let identity = await stored(input.key);
      if (identity && (identity.authorizedKey !== setup.authorizedKey || identity.bridgePort !== setup.bridgePort || identity.image !== setup.image)) throw new SafeError("Relay key already has different setup. Inspect or stop the original intent.");
      if (!identity) {
        if ((await bb.storage.kv.list("relay-intents/")).length >= 16) throw new SafeError("Relay intent limit reached; retain records and investigate before preparing more relays.");
        identity = { ...setup, owner: options.owner, generation: randomUUID(), connection: await options.connection() };
        await bb.storage.kv.set(`relay-intents/${input.key}`, identity);
      }
      return remote.relay("relayPrepare", identity, options.signal());
    }),
    "relay.inspect": async ({ key }: { key: string }) => invoke(key, async () => {
      const identity = await stored(key);
      return identity ? remote.relay("relayInspect", identity, options.signal()) : null;
    }),
    "relay.stop": async ({ key }: { key: string }) => invoke(key, async () => {
      const identity = await stored(key);
      return identity ? remote.relay("relayStop", identity, options.signal()) : null;
    }),
  };
}
