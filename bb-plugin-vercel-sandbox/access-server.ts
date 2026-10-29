import { randomUUID } from "node:crypto";
import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ACCESS_PLUGIN, ACCESS_PROVIDER, setupKeySchema } from "./access-contract.js";

const relaySchema = z.object({
  key: setupKeySchema, phase: z.string().max(32), expiresAt: z.number().finite().nullable(),
});
const restoreSchema = z.object({ previous: z.string().nullable() }).strict();
const restoreKey = "vercel-access/default-restore";
const pendingKey = "vercel-access/enable-key";
const ownedRelaySchema = relaySchema.extend({ computeEnded: z.boolean(), metadataDeleted: z.boolean() });
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
        message: ready ? (selected ? "Ready for new machines through the local BB app." : "Relay ready. Enable it to use it for new machines.")
          : expired ? "Relay expired. Enable it to finish cleanup and start a new relay."
          : failed ? `Relay unavailable at ${failed.stage}. Enable it again to resume setup, or disable it to clean up.`
          : "Enable the relay to connect new machines to this BB app." };
    } catch {
      return { ...base, available: false, ready: false, key: null, phase: null, expiresAt: null,
        message: "Vercel Access is unavailable. Enable relay will try to start the companion plugin; it must be installed and compatible." };
    }
  };
  const observed = async (method: "setup.prepare" | "setup.inspect" | "setup.stop", input: JsonValue) => {
    const view = await call(method, input, relaySchema.nullable());
    if (view) await bb.storage.kv.set("vercel-access/observation", view);
    return status();
  };
  const connect = async (key: string) => {
    const settings = await bb.sdk.plugins.getSettings({ pluginId: ACCESS_PLUGIN });
    const unfinished = await bb.storage.kv.get<string>("vercel-access/connect-key");
    if (settings.values.enabled === true && unfinished !== key) return;
    if (settings.values.enabled !== true) await call("setup.apply", { key }, relaySchema);
    await bb.storage.kv.set("vercel-access/connect-key", key);
    if (settings.values.enabled !== true) await bb.sdk.plugins.updateSettings({ pluginId: ACCESS_PLUGIN, values: { enabled: true } });
    await bb.sdk.plugins.reload({ pluginId: ACCESS_PLUGIN });
    await bb.storage.kv.delete("vercel-access/connect-key");
  };
  const enable = async () => {
    let current = await status();
    if (!current.available) {
      await bb.sdk.plugins.enable({ pluginId: ACCESS_PLUGIN });
      current = await status();
      if (!current.available) throw new Error("Enable a compatible Vercel Access plugin first.");
    }
    const originalDefault = current.defaultProvider;
    if (!current.ready) {
      const pending = await bb.storage.kv.get<unknown>(pendingKey);
      let key = pending === undefined ? current.key : setupKeySchema.parse(pending);
      let relay = null;
      if (key) {
        const view = await call("setup.inspect", { key }, ownedRelaySchema.nullable());
        relay = view;
        if (view && (view.phase === "removed" || view.computeEnded || (view.expiresAt !== null && view.expiresAt <= Date.now()))) {
          const removed = await call("setup.stop", { key }, ownedRelaySchema);
          if (removed.phase !== "removed" || !removed.computeEnded || !removed.metadataDeleted) throw new Error("Previous relay cleanup is still running. Try again shortly.");
          key = null;
          relay = null;
        }
      }
      key ??= randomUUID();
      // Keep the chosen key before provisioning so a lost reply resumes this relay.
      await bb.storage.kv.set(pendingKey, key);
      const view = relay?.phase === "ready" ? relay : await call("setup.prepare", { key, approveAllocation: true, image: "vercel/sandbox/node:24" }, relaySchema);
      await bb.storage.kv.set("vercel-access/observation", view);
      await connect(key);
      for (let attempt = 0; attempt < 40; attempt++) {
        current = await status();
        if (current.ready) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!current.ready) throw new Error("The relay is still connecting. Try enabling again to resume the same setup.");
    }
    const config = await bb.sdk.system.config();
    if (config.generalSettings.defaultMachineAccess !== originalDefault) throw new Error("The machine connection changed elsewhere. Try enabling again to use the relay.");
    if (originalDefault !== ACCESS_PROVIDER) {
      await bb.storage.kv.set(restoreKey, { previous: originalDefault });
      await bb.sdk.system.updateGeneralSettings({ ...config.generalSettings, defaultMachineAccess: ACCESS_PROVIDER });
    }
    await bb.storage.kv.delete(pendingKey);
    await bb.storage.kv.delete("vercel-access/connect-key");
    return status();
  };
  const disable = async () => {
    const current = await status();
    const pending = await bb.storage.kv.get<unknown>(pendingKey);
    const observation = await bb.storage.kv.get<unknown>("vercel-access/observation");
    const key = pending === undefined ? current.key ?? (observation === undefined ? null : relaySchema.parse(observation).key) : setupKeySchema.parse(pending);
    try {
      await bb.sdk.plugins.updateSettings({ pluginId: ACCESS_PLUGIN, values: { enabled: false } });
      await bb.sdk.plugins.reload({ pluginId: ACCESS_PLUGIN });
    } finally {
      const config = await bb.sdk.system.config();
      const saved = await restoration();
      if (config.generalSettings.defaultMachineAccess === ACCESS_PROVIDER) {
        await bb.sdk.system.updateGeneralSettings({ ...config.generalSettings, defaultMachineAccess: saved ? saved.previous : "direct" });
      }
      await bb.storage.kv.delete(restoreKey);
    }
    // Restore the local connection even when the authentication machine cannot clean up.
    if (key) await observed("setup.stop", { key });
    await bb.storage.kv.delete(pendingKey);
    return status();
  };
  return {
    "access.status": status,
    "access.enable": () => serial(enable),
    "access.disable": () => serial(disable),
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
