import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { chmodSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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
  bb.settings.define({});
  const listeners: (() => Promise<void>)[] = [];
  let initialized: Promise<void> | undefined;
  let db: ReturnType<BbPluginApi["storage"]["database"]>;
  const protect = () => {
    if (db.memory) return;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { chmodSync(`${db.name}${suffix}`, 0o600); }
      catch (error) { if (!suffix || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    }
  };
  const read = () => db.prepare("SELECT config FROM private_relay_config WHERE id = 1").get() as { config: string } | undefined;
  const write = (config: RelayConfig) => {
    db.prepare("INSERT INTO private_relay_config (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config").run(JSON.stringify(config));
    protect();
  };
  const initialize = () => initialized ??= (async () => {
    db = bb.storage.database();
    protect();
    bb.storage.migrate(db, ["CREATE TABLE IF NOT EXISTS private_relay_config (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL)"]);
    protect();
    if (read()) return;
    const dataDir = bb.server?.experimental_dataDir;
    if (typeof dataDir !== "string") return;
    // Read the former BB-managed secret only when upgrading an existing profile.
    // New state lives exclusively in the private plugin database, never settings or KV.
    const legacy = join(dataDir, "plugins", bb.pluginId, "secrets", "relayIdentity");
    try {
      const info = await stat(legacy);
      if (!info.isFile() || info.size > 65536 || (info.mode & 0o077)) throw new Error("Invalid legacy identity");
      write(relayConfigSchema.parse(JSON.parse(await readFile(legacy, "utf8"))));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  })().catch(error => { initialized = undefined; throw error; });
  const get = async () => {
    try {
      await initialize();
      const stored = read();
      return relayConfigSchema.parse(stored ? JSON.parse(stored.config) : {});
    } catch { throw new Error("Private relay configuration could not be read. No replacement was created."); }
  };
  return {
    get,
    experimental_set: async (values: Partial<RelayConfig>) => {
      const previous = await get();
      const next = relayConfigSchema.parse({ ...previous, ...values });
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      try { write(next); }
      catch { throw new Error("Private relay configuration could not be saved. Retry before creating a worker."); }
      for (const handler of listeners) await handler();
    },
    onChange: (handler: () => Promise<void>) => { listeners.push(handler); },
  };
}
