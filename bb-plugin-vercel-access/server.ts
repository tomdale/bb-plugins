import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { openBridge } from "./bridge.ts";
import { AdmissionLeases } from "./grants.ts";
import { ACCESS_HEADER } from "./policy.ts";
import { startConnector } from "./tunnel.ts";
import { randomUUID } from "node:crypto";
import { registerSetup } from "./setup.ts";
import { DiagnosticStore } from "./diagnostics.ts";
import { probeVersion } from "./readiness.ts";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Enable local bridge prototype", default: false, description: "Requires reload. No Vercel resources are provisioned. Restart invalidates admission leases; existing-worker reconfiguration is not implemented." },
    port: { type: "number", label: "Loopback bridge port", default: 38991 },
    serverUrl: { type: "string", label: "Machine-facing bridge URL", default: "", description: "The dedicated relay's reverse-listener origin, or the isolated local bridge URL. Never the unrestricted BB origin." },
    transport: { type: "select", label: "Transport", options: ["loopback-test", "ssh-ws"], default: "loopback-test" },
    relayFingerprint: { type: "string", label: "Pinned relay SSH SHA-256 fingerprint (hex)", default: "" },
    relayUrl: { type: "string", label: "Dedicated WSS control origin", default: "" },
    connectorPrivateKey: { type: "string", label: "Dedicated connector SSH private key", secret: true },
    preparedConnectorPrivateKey: { type: "string", label: "Private pending relay setup identity", secret: true },
    reversePort: { type: "number", label: "Dedicated relay reverse-listener port", default: 38992 },
  });
  const diagnostics = new DiagnosticStore();
  registerSetup(bb, {
    diagnostics: () => diagnostics.snapshot(),
    config: () => settings.get(),
    saveKey: async key => { await settings.experimental_set({ preparedConnectorPrivateKey: key }); },
    apply: async (view, key) => { await settings.experimental_set({
      enabled: false, transport: "ssh-ws", serverUrl: view.origin!, relayUrl: view.origin!.replace(/^https:/, "wss:"),
      relayFingerprint: view.fingerprint, connectorPrivateKey: key, reversePort: 38992,
    }); },
    disable: async () => { await settings.experimental_set({ enabled: false }); },
  });
  const config = await settings.get();
  if (!config.enabled) { diagnostics.record("readiness", "closed", "disabled"); return; }
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
  settings.onChange(async () => { invalidated = true; leases.clear(); diagnostics.record("readiness", "closed", "cancelled"); await stop(); });
  bb.onDispose(async () => { diagnostics.record("readiness", "closed", "disposed"); await stop(); });
  bb.experimental_serverAccess.register({
    id: "machine-bridge", displayName: "Vercel Access local prototype",
    description: "Machine-only network admission. Native BB credentials determine host authority. No owner or preview access.",
    availability: () => ready
      ? { status: "available", serverUrl: external.origin }
      : { status: "unavailable", message: (() => { const failure = diagnostics.snapshot().firstFailure; return failure ? `Machine bridge unavailable: ${failure.stage}/${failure.reason}` : "Machine bridge unavailable; inspect local setup status"; })() },
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
      diagnostics.begin();
      diagnostics.record("readiness", "pending");
      diagnostics.record("local-core", "pending");
      try {
        try { bridge = await openBridge({ baseUrl: bb.server.loopbackBaseUrl, leases, port: config.port }); }
        catch { diagnostics.record("local-core", "failed", "core-check-failed"); throw new Error("Local machine surface not verified"); }
        diagnostics.record("local-core", "verified");
        if (config.transport === "ssh-ws") {
          connector = await startConnector({
            relayUrl: config.relayUrl, privateKey: config.connectorPrivateKey!, hostFingerprint: config.relayFingerprint,
            bridgePort: config.port, reversePort: config.reversePort, signal, diagnostics: diagnostics.record,
          });
          // Readiness means this specific external origin reaches the checked
          // native machine surface, not merely that a child process spawned.
          const probeKey = randomUUID();
          const probe = leases.acquire(probeKey, "readiness", signal);
          try {
            let reached = false;
            for (let attempt = 0; attempt < 20 && !signal.aborted && !invalidated && connector.running(); attempt++) {
              if (await probeVersion({ origin: external, token: probe.token, signal, attempt: attempt + 1, diagnostics: diagnostics.record })) { reached = true; break; }
              await new Promise(resolve => setTimeout(resolve, 250));
            }
            if (!reached) { diagnostics.record("readiness", "failed", "probe-exhausted"); throw new Error("Dedicated relay machine path not ready"); }
          } finally { leases.release(probeKey, "readiness", probe.id); }
        }
        if (invalidated || signal.aborted) return;
        ready = true;
        diagnostics.record("readiness", "verified");
        bb.experimental_serverAccess.recheck();
        await new Promise<void>(resolve => {
          const abort = () => resolve();
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) resolve();
          connector?.exited.then(() => { signal.removeEventListener("abort", abort); resolve(); });
        });
        if (!signal.aborted && !invalidated) { diagnostics.record("readiness", "failed", "transport-lost"); throw new Error("Connector disconnected; retrying the same pinned relay"); }
      } catch {
        if (signal.aborted || invalidated) diagnostics.record("readiness", "closed", "cancelled");
        else if (diagnostics.snapshot().stages.find(item => item.stage === "readiness")?.state === "pending") diagnostics.record("readiness", "failed", "transport-lost");
        throw new Error("Machine bridge unavailable; inspect bounded setup status");
      } finally { await stop(); }
    },
  });
}
