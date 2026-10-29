import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { openBridge } from "./bridge.ts";
import { AdmissionLeases } from "./grants.ts";
import { ACCESS_HEADER, TESTED_CORE } from "./policy.ts";
import { startConnector } from "./tunnel.ts";
import { randomUUID } from "node:crypto";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Enable local bridge prototype", default: false, description: "Requires reload. No Vercel resources are provisioned. Restart invalidates admission leases; existing-worker reconfiguration is not implemented." },
    port: { type: "number", label: "Loopback bridge port", default: 38991 },
    serverUrl: { type: "string", label: "Machine-facing bridge URL", default: "", description: "The dedicated relay's reverse-listener origin, or the isolated local bridge URL. Never the unrestricted BB origin." },
    transport: { type: "select", label: "Transport", options: ["loopback-test", "ssh-ws"], default: "loopback-test" },
    relayFingerprint: { type: "string", label: "Pinned relay SSH SHA-256 fingerprint (hex)", default: "" },
    relayUrl: { type: "string", label: "Dedicated WSS control origin", default: "" },
    connectorPrivateKey: { type: "string", label: "Dedicated connector SSH private key", secret: true },
    reversePort: { type: "number", label: "Dedicated relay reverse-listener port", default: 38992 },
  });
  const config = await settings.get();
  if (!config.enabled) return;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("Invalid bridge port");
  const external = new URL(config.serverUrl);
  if (external.username || external.password || external.pathname !== "/" || external.search || external.hash ||
      (external.protocol !== "https:" && !(external.protocol === "http:" && external.hostname === "127.0.0.1"))) throw new Error("Expected an HTTPS tunnel origin or isolated loopback test URL");
  if (config.transport === "loopback-test" && external.origin !== `http://127.0.0.1:${config.port}`) throw new Error("Loopback test URL must name the exact bridge listener");
  if (config.transport === "ssh-ws" && !config.connectorPrivateKey) throw new Error("Dedicated connector SSH key required");
  if (!bb.experimental_serverAccess?.register || !bb.experimental_serverAccess?.recheck || !bb.background?.service || !bb.server) throw new Error("Required public BB APIs unavailable");
  const leases = new AdmissionLeases();
  let bridge: Awaited<ReturnType<typeof openBridge>> | undefined;
  let connector: Awaited<ReturnType<typeof startConnector>> | undefined;
  let ready = false;
  let invalidated = false;
  const stop = async () => {
    ready = false;
    await connector?.close();
    connector = undefined;
    await bridge?.close();
    bridge = undefined;
    bb.experimental_serverAccess.recheck();
  };
  settings.onChange(async () => { invalidated = true; leases.clear(); await stop(); });
  bb.onDispose(stop);
  bb.experimental_serverAccess.register({
    id: "machine-bridge", displayName: "Vercel Access local prototype",
    description: "Machine-only network admission. Native BB credentials determine host authority. No owner or preview access.",
    availability: () => ready
      ? { status: "available", serverUrl: external.origin }
      : { status: "unavailable", message: "Local prototype not ready; verify the tested BB release and reload. Cloud connectivity is not validated." },
    async acquire({ key, hostId, signal }) {
      if (!ready) return { status: "failed", message: "Machine bridge unavailable" };
      const grant = leases.acquire(key, hostId, signal);
      return { id: grant.id, serverUrl: external.origin, headers: { [ACCESS_HEADER]: grant.token } };
    },
    async release({ key, hostId, grantId }) { leases.release(key, hostId, grantId); },
  });
  bb.background.service("machine-bridge", {
    async start(signal) {
      if (invalidated || signal.aborted) return;
      try {
        bridge = await openBridge({ baseUrl: bb.server.loopbackBaseUrl, leases, port: config.port });
        if (config.transport === "ssh-ws") {
          connector = await startConnector({
            relayUrl: config.relayUrl, privateKey: config.connectorPrivateKey!, hostFingerprint: config.relayFingerprint,
            bridgePort: config.port, reversePort: config.reversePort, signal,
          });
          // Readiness means this specific external origin reaches the checked
          // native machine surface, not merely that a child process spawned.
          const probeKey = randomUUID();
          const probe = leases.acquire(probeKey, "readiness", signal);
          try {
            let reached = false;
            for (let attempt = 0; attempt < 20 && !signal.aborted && !invalidated && connector.running(); attempt++) {
              try {
                const response = await fetch(new URL("/install/version", external), {
                  headers: { [ACCESS_HEADER]: probe.token }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
                });
                const chunks: Uint8Array[] = [];
                let size = 0;
                if (!response.body) throw new Error("Empty readiness response");
                for await (const chunk of response.body) {
                  size += chunk.length;
                  if (size > 4096) throw new Error("Oversized readiness response");
                  chunks.push(chunk);
                }
                if (response.ok) {
                  const value = JSON.parse(Buffer.concat(chunks).toString());
                  if (value.version === TESTED_CORE.version && value.protocolVersion === TESTED_CORE.protocolVersion) { reached = true; break; }
                }
              } catch { signal.throwIfAborted(); }
              await new Promise(resolve => setTimeout(resolve, 250));
            }
            if (!reached) throw new Error("Dedicated relay machine path not ready");
          } finally { leases.release(probeKey, "readiness", probe.id); }
        }
        if (invalidated || signal.aborted) return;
        ready = true;
        bb.experimental_serverAccess.recheck();
        await new Promise<void>(resolve => {
          const abort = () => resolve();
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) resolve();
          connector?.exited.then(() => { signal.removeEventListener("abort", abort); resolve(); });
        });
        if (!signal.aborted && !invalidated) throw new Error("Connector disconnected; retrying the same pinned relay");
      } finally { await stop(); }
    },
  });
}
