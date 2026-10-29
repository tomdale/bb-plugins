import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ACCESS_PLUGIN, ACCESS_PROVIDER, setupKeySchema } from "./access-contract.js";

const relaySchema = z.object({
  key: setupKeySchema, phase: z.string().max(32), expiresAt: z.number().finite().nullable(),
});
const restoreSchema = z.object({ previous: z.string().nullable() }).strict();
const restoreKey = "vercel-access/default-restore";
const failure = "Vercel Access did not confirm this action. Check that the plugin is enabled and compatible, then inspect the saved tunnel or stop it. Do not prepare a replacement after an uncertain reply.";

export function accessHandlers(bb: BbPluginApi) {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>) => {
    const result = tail.catch(() => {}).then(run);
    tail = result;
    return result;
  };
  const call = async <T>(method: string, input: JsonValue, outputSchema: z.ZodType<T>): Promise<T> => {
    try { return await bb.sdk.plugins.callRpc({ pluginId: ACCESS_PLUGIN, method, input, outputSchema }); }
    catch { throw new Error(failure); }
  };
  const restoration = async () => {
    const value = await bb.storage.kv.get<unknown>(restoreKey);
    return value === undefined ? null : restoreSchema.parse(value);
  };
  const status = async () => {
    const config = await bb.sdk.system.config();
    const defaultProvider = config.generalSettings.defaultMachineAccess;
    const selected = config.serverAccess.defaultProviderId === ACCESS_PROVIDER;
    const provider = config.serverAccess.providers.find(p => p.id === ACCESS_PROVIDER);
    const saved = await restoration();
    const base = { selected, defaultProvider, canRestore: saved !== null && selected };
    try {
      const { key } = await call("setup.current", {}, z.object({ key: setupKeySchema.nullable() }));
      const snapshot = await call("setup.status", {}, z.object({ stages: z.array(z.object({
        stage: z.enum(["local-core", "tls", "wss", "ssh-host", "ssh-auth", "reverse", "version-probe", "readiness"]),
        state: z.enum(["not-started", "pending", "verified", "failed", "closed"]),
      })) }));
      const value = await bb.storage.kv.get<unknown>("vercel-access/observation");
      const observation = value === undefined ? null : relaySchema.parse(value);
      const view = observation?.key === key ? observation : null;
      const expired = view?.expiresAt != null && view.expiresAt <= Date.now();
      const ready = !expired && provider?.availability?.status === "available" && snapshot.stages.some(s => s.stage === "readiness" && s.state === "verified");
      const failed = snapshot.stages.find(s => s.state === "failed");
      return { ...base, available: true, ready, key, phase: view?.phase ?? null, expiresAt: view?.expiresAt ?? null,
        message: ready ? (selected ? "Ready for new machines through the local BB app." : "Tunnel ready. Select it for new machines before creating a Vercel thread.")
          : expired ? "Relay lifetime ended. Stop its saved setup to confirm cleanup before preparing another tunnel."
          : failed ? `Tunnel unavailable at ${failed.stage}. Inspect the tunnel and check Vercel Access status; do not launch a worker.`
          : "Tunnel not ready. Prepare or inspect a tunnel, then connect it. Check readiness again before creating a thread." };
    } catch {
      return { ...base, available: false, ready: false, key: null, phase: null, expiresAt: null,
        message: "Enable a compatible Vercel Access plugin, then check again. Reading this page does not allocate compute." };
    }
  };
  const observed = async (method: "setup.prepare" | "setup.inspect" | "setup.stop", input: JsonValue) => {
    const view = await call(method, input, relaySchema.nullable());
    if (view) await bb.storage.kv.set("vercel-access/observation", view);
    return status();
  };
  return {
    "access.status": status,
    "access.prepare": ({ key, approveAllocation }: { key: string; approveAllocation: true }) => serial(() => observed("setup.prepare", { key, approveAllocation, image: "vercel/sandbox/node:24" })),
    "access.inspect": ({ key }: { key: string }) => serial(() => observed("setup.inspect", { key })),
    "access.stop": ({ key }: { key: string }) => serial(() => observed("setup.stop", { key })),
    "access.activate": ({ key }: { key: string }) => serial(async () => {
      const config = await bb.sdk.system.config();
      if (config.generalSettings.defaultMachineAccess === null) throw new Error("Choose an explicit connection in Machines settings before connecting a tunnel; Automatic may select it for unrelated launches.");
      // Apply checks the owned relay, pinned identity, bounded lifetime and image.
      // Only this explicit action reloads Access; never reload after launching a worker.
      await call("setup.apply", { key }, relaySchema);
      await bb.sdk.plugins.updateSettings({ pluginId: ACCESS_PLUGIN, values: { enabled: true } });
      await bb.sdk.plugins.reload({ pluginId: ACCESS_PLUGIN });
      return status();
    }),
    "access.select": ({ expectedDefault }: { expectedDefault: string | null; approveDefaultChange: true }) => serial(async () => {
      const current = await status();
      if (!current.ready || current.defaultProvider !== expectedDefault) throw new Error("Readiness or the machine default changed. Check again before selecting the tunnel.");
      if (!current.selected) {
        const config = await bb.sdk.system.config();
        if (config.generalSettings.defaultMachineAccess !== expectedDefault) throw new Error("The machine default changed. Check again; no settings were overwritten.");
        await bb.storage.kv.set(restoreKey, { previous: current.defaultProvider });
        await bb.sdk.system.updateGeneralSettings({ ...config.generalSettings, defaultMachineAccess: ACCESS_PROVIDER });
      }
      return status();
    }),
    "access.restore": () => serial(async () => {
      const saved = await restoration();
      const config = await bb.sdk.system.config();
      if (!saved || config.generalSettings.defaultMachineAccess !== ACCESS_PROVIDER) throw new Error("The default changed elsewhere. No settings were overwritten; choose the connection in Machines settings.");
      await bb.sdk.system.updateGeneralSettings({ ...config.generalSettings, defaultMachineAccess: saved.previous });
      await bb.storage.kv.delete(restoreKey);
      return status();
    }),
  };
}
