import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const relayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1024).max(65535).default(38991),
  serverUrl: z.string().max(300).default(""),
  transport: z.enum(["loopback-test", "ssh-ws"]).default("loopback-test"),
  relayFingerprint: z.string().max(64).default(""),
  relayUrl: z.string().max(300).default(""),
  connectorPrivateKey: z.string().max(16384).optional(),
  preparedConnectorPrivateKey: z.string().max(16384).optional(),
  reversePort: z.number().int().min(1024).max(65535).default(38992),
}).strict();
export type RelayConfig = z.infer<typeof relayConfigSchema>;

export function relaySettings(bb: BbPluginApi) {
  const stored = bb.settings.define({
    relayIdentity: { type: "string", label: "Relay identity", secret: true, description: "Managed automatically by Sandbox relay. Do not edit." },
  });
  const get = async () => {
    try {
      const { relayIdentity } = await stored.get();
      return relayConfigSchema.parse(relayIdentity ? JSON.parse(relayIdentity) : {});
    } catch { throw new Error("Managed relay configuration is invalid"); }
  };
  return {
    get,
    experimental_set: async (values: Partial<RelayConfig>) => {
      const next = relayConfigSchema.parse({ ...await get(), ...values });
      await stored.experimental_set({ relayIdentity: JSON.stringify(next) });
    },
    onChange: (handler: () => Promise<void>) => stored.onChange(handler),
  };
}
