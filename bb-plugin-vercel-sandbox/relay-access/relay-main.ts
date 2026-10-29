import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { openRelayAdapter } from "./bridge.ts";
import { openTunnelRelay } from "./tunnel.ts";
import { relayDiagnosticFile } from "./relay-diagnostics.ts";

interface RelayConfig {
  publicAuthority: string; port: number; reversePort: number; bridgePort: number;
  hostKeyFile: string; authorizedKeyFile: string;
}

/** Starts source artifacts only; provisioning and Vercel authentication are external. */
export async function runRelay(config: RelayConfig) {
  const secret = await stat(config.hostKeyFile);
  if (!secret.isFile() || secret.size > 32768 || (secret.mode & 0o077) !== 0) throw new Error("Relay host key must be a private bounded file");
  const publicKey = await stat(config.authorizedKeyFile);
  if (!publicKey.isFile() || publicKey.size > 32768) throw new Error("Invalid connector public key file");
  const diagnosis = relayDiagnosticFile(config.hostKeyFile);
  const tunnel = await openTunnelRelay({
    hostKey: await readFile(config.hostKeyFile, "utf8"), authorizedKey: await readFile(config.authorizedKeyFile, "utf8"),
    reversePort: config.reversePort, publicAuthority: config.publicAuthority, diagnostics: diagnosis.diagnostics,
  });
  try {
    const adapter = await openRelayAdapter({
      reversePort: config.reversePort, bridgePort: config.bridgePort, publicAuthority: config.publicAuthority,
      port: config.port, bind: "0.0.0.0", connector: tunnel, diagnostics: diagnosis.diagnostics,
    });
    return { async close() { await adapter.close(); await tunnel.close(); await diagnosis.flush(); } };
  } catch (error) { await tunnel.close(); await diagnosis.flush(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const path = process.argv[2];
    if (!path) throw new Error("Configuration file required");
    const info = await stat(path);
    if (!info.isFile() || info.size > 8192) throw new Error("Invalid relay configuration");
    const config = JSON.parse(await readFile(path, "utf8"));
    const keys = ["publicAuthority", "port", "reversePort", "bridgePort", "hostKeyFile", "authorizedKeyFile"];
    if (!config || typeof config !== "object" || Object.keys(config).length !== keys.length || keys.some(key => !(key in config))) throw new Error("Invalid relay configuration");
    if (typeof config.publicAuthority !== "string" || typeof config.hostKeyFile !== "string" || typeof config.authorizedKeyFile !== "string" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("Invalid relay configuration");
    const relay = await runRelay(config);
    const stop = () => { void relay.close().then(() => { process.exitCode = 0; }); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    process.stdout.write("Machine relay ready\n");
  } catch {
    process.stderr.write("Machine relay could not start\n");
    process.exitCode = 1;
  }
}
