import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { relayConfigSchema } from "./config.ts";
import { recordSchema } from "./setup.ts";
import type { createRelayAccess } from "./server.ts";

export const legacyImportContract = defineRpcContract({
  "access.importLegacy": {
    input: z.object({
      config: relayConfigSchema,
      records: z.array(z.object({ key: z.string().regex(/^relay-setup(?:-history\/[a-z0-9][a-z0-9-]{0,63})?$/), value: recordSchema }).strict()).max(128),
    }).strict(),
    output: z.object({ imported: z.literal(true) }).strict(),
  },
});

export function registerLegacyImport(bb: BbPluginApi, relay: Awaited<ReturnType<typeof createRelayAccess>>, serialize: <T>(run: () => Promise<T>) => Promise<T> = run => run()) {
  bb.rpc.register(legacyImportContract, {
    "access.importLegacy": input => serialize(async () => {
      const { config, records } = input;
      const digest = createHash("sha256").update(JSON.stringify({ config, records })).digest("hex");
      const imported = await bb.storage.kv.get<string>("relay-legacy-imported");
      const importing = await bb.storage.kv.get<string>("relay-legacy-importing");
      if (imported === digest) return { imported: true as const };
      if (imported || (importing && importing !== digest) || (await relay.settings.get()).enabled || (!importing && await bb.storage.kv.get("relay-setup"))) throw new Error("Relay setup already exists; migration will not overwrite it.");
      await bb.storage.kv.set("relay-legacy-importing", digest);
      await relay.settings.experimental_set({ ...config, enabled: false });
      for (const record of records) await bb.storage.kv.set(record.key, record.value);
      const native = await bb.sdk.system.config();
      if (native.generalSettings.defaultMachineAccess === "machine-bridge") {
        const saved = z.object({ previous: z.string().nullable() }).safeParse(await bb.storage.kv.get("vercel-access/default-restore"));
        const previous = saved.success ? saved.data.previous : null;
        await bb.sdk.system.updateGeneralSettings({ ...native.generalSettings, defaultMachineAccess: previous && previous !== "machine-bridge" ? previous : "direct" });
        await bb.storage.kv.delete("vercel-access/default-restore");
      }
      await bb.storage.kv.set("relay-legacy-imported", digest);
      await bb.storage.kv.delete("relay-legacy-importing");
      return { imported: true as const };
    }),
  });
}
