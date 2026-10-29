import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export default function legacyMigration(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Legacy relay enabled", default: false },
    port: { type: "number", label: "Legacy loopback port", default: 38991 },
    serverUrl: { type: "string", label: "Legacy machine origin", default: "" },
    transport: { type: "select", label: "Legacy transport", options: ["loopback-test", "ssh-ws"], default: "loopback-test" },
    relayFingerprint: { type: "string", label: "Legacy relay pin", default: "" },
    relayUrl: { type: "string", label: "Legacy relay origin", default: "" },
    connectorPrivateKey: { type: "string", label: "Legacy connector identity", secret: true },
    preparedConnectorPrivateKey: { type: "string", label: "Legacy pending identity", secret: true },
    reversePort: { type: "number", label: "Legacy reverse port", default: 38992 },
  });
  bb.cli.register(defineCli({ name: "vercel-access", summary: "Move retired Vercel Access data into Vercel Sandbox", commands: {
    migrate: cliCommand({ summary: "Move private relay setup and cleanup receipts server-to-server without cloud operations", async run() {
      try {
        if (!await bb.storage.kv.get("sandbox-relay-migrated")) {
          const keys = (await bb.storage.kv.list("relay-setup")).sort();
          if (keys.length > 128) throw new Error("Too many retained records");
          const records = await Promise.all(keys.map(async key => ({ key, value: await bb.storage.kv.get(key) })));
          await bb.sdk.plugins.callRpc({ pluginId: "environment-vercel-sandbox", method: "access.importLegacy",
            input: JSON.parse(JSON.stringify({ config: await settings.get(), records })),
            outputSchema: z.object({ imported: z.literal(true) }).strict() });
          await bb.storage.kv.set("sandbox-relay-migrated", true);
        }
        await settings.experimental_set({ enabled: false });
        return { exitCode: 0, stdout: JSON.stringify({ migrated: true }) };
      } catch { throw new PluginCliError("Relay migration was not confirmed. Keep Vercel Access installed and retry; private values are not emitted."); }
    } }),
  } }));
}
