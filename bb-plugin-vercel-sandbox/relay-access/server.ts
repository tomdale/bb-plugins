import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { openBridge } from "./bridge.ts";
import { AdmissionLeases } from "./grants.ts";
import { ACCESS_HEADER } from "./policy.ts";
import { startConnector } from "./tunnel.ts";
import { registerSetup } from "./setup.ts";
import { DiagnosticStore } from "./diagnostics.ts";
import { probeVersion } from "./readiness.ts";
import { relaySettings, type RelayConfig } from "./config.ts";

export const RELAY_PROVIDER = "vercel-sandbox-relay";

export async function createRelayAccess(bb: BbPluginApi) {
  const settings = relaySettings(bb);
  const diagnostics = new DiagnosticStore();
  const supported = typeof bb.experimental_serverAccess?.register === "function" && typeof bb.experimental_serverAccess?.recheck === "function" && typeof bb.background?.service === "function" && !!bb.server;
  const leases = new AdmissionLeases();
  let bridge: Awaited<ReturnType<typeof openBridge>> | undefined;
  let connector: Awaited<ReturnType<typeof startConnector>> | undefined;
  let ready = false;
  let origin = "";
  let cycle: AbortController | undefined;
  let wake = () => {};
  let closing: Promise<void> | undefined;
  const stop = () => {
    if (closing) return closing;
    ready = false;
    cycle?.abort();
    const previousConnector = connector, previousBridge = bridge;
    connector = undefined;
    bridge = undefined;
    closing = (async () => {
      try { await previousConnector?.close(); await previousBridge?.close(); }
      finally { closing = undefined; if (supported) bb.experimental_serverAccess.recheck(); }
    })();
    return closing;
  };
  settings.onChange(async () => {
    diagnostics.record("readiness", "closed", "cancelled");
    leases.clear();
    await stop();
    wake();
  });
  const setup = registerSetup(bb, {
    diagnostics: () => diagnostics.snapshot(),
    config: settings.get,
    saveKey: async key => settings.experimental_set({ preparedConnectorPrivateKey: key }),
    apply: async (view, key) => settings.experimental_set({
      enabled: false, transport: "ssh-ws", serverUrl: view.origin!, relayUrl: view.origin!.replace(/^https:/, "wss:"),
      relayFingerprint: view.fingerprint, connectorPrivateKey: key, reversePort: 38992,
    }),
    disable: async () => settings.experimental_set({ enabled: false }),
  });
  bb.onDispose(async () => { diagnostics.record("readiness", "closed", "disposed"); leases.clear(); await stop(); wake(); });
  try { if (!(await settings.get()).enabled) diagnostics.record("readiness", "closed", "disabled"); }
  catch { diagnostics.record("readiness", "failed", "invalid-config"); }

  const run = async (config: RelayConfig, signal: AbortSignal) => {
    const external = new URL(config.serverUrl);
    if (external.username || external.password || external.pathname !== "/" || external.search || external.hash ||
        (external.protocol !== "https:" && !(external.protocol === "http:" && external.hostname === "127.0.0.1"))) throw new Error("Expected an HTTPS relay origin or isolated loopback test URL");
    if (config.transport === "loopback-test" && external.origin !== `http://127.0.0.1:${config.port}`) throw new Error("Loopback test URL must name the exact bridge listener");
    if (config.transport === "ssh-ws" && !config.connectorPrivateKey) throw new Error("Dedicated connector SSH key required");
    origin = external.origin;
    diagnostics.begin();
    diagnostics.record("readiness", "pending");
    diagnostics.record("local-core", "pending");
    try {
      try { bridge = await openBridge({ baseUrl: bb.server.loopbackBaseUrl, leases, port: config.port }); }
      catch { diagnostics.record("local-core", "failed", "core-check-failed"); throw new Error("Local machine surface not verified"); }
      diagnostics.record("local-core", "verified");
      if (config.transport === "ssh-ws") {
        connector = await startConnector({ relayUrl: config.relayUrl, privateKey: config.connectorPrivateKey!, hostFingerprint: config.relayFingerprint,
          bridgePort: config.port, reversePort: config.reversePort, signal, diagnostics: diagnostics.record });
        const probeKey = randomUUID();
        const probe = leases.acquire(probeKey, "readiness", signal);
        try {
          let reached = false;
          for (let attempt = 0; attempt < 20 && !signal.aborted && connector.running(); attempt++) {
            if (await probeVersion({ origin: external, token: probe.token, signal, attempt: attempt + 1, diagnostics: diagnostics.record })) { reached = true; break; }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          if (!reached) { diagnostics.record("readiness", "failed", "probe-exhausted"); throw new Error("Relay machine path not ready"); }
        } finally { leases.release(probeKey, "readiness", probe.id); }
      }
      if (signal.aborted) return;
      ready = true;
      diagnostics.record("readiness", "verified");
      bb.experimental_serverAccess.recheck();
      await new Promise<void>(resolve => {
        const abort = () => resolve();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) resolve();
        connector?.exited.then(() => { signal.removeEventListener("abort", abort); resolve(); });
      });
      if (!signal.aborted) { diagnostics.record("readiness", "failed", "transport-lost"); throw new Error("Relay disconnected"); }
    } catch {
      if (signal.aborted) diagnostics.record("readiness", "closed", "cancelled");
      else if (diagnostics.snapshot().stages.find(item => item.stage === "readiness")?.state === "pending") diagnostics.record("readiness", "failed", "transport-lost");
      if (!signal.aborted) throw new Error("Sandbox relay unavailable; inspect relay status");
    } finally { await stop(); }
  };

  if (supported) {
    bb.experimental_serverAccess.register({
      id: RELAY_PROVIDER, displayName: "Vercel Sandbox relay",
      description: "Connect new machines to the local BB app through your Vercel sandbox relay.",
      availability: () => ready ? { status: "available", serverUrl: origin } : { status: "unavailable", message: "Enable Sandbox relay in Vercel Sandbox settings." },
      async acquire({ key, hostId, signal }) {
        if (!ready) return { status: "failed", message: "Sandbox relay unavailable" };
        const grant = leases.acquire(key, hostId, signal);
        return { id: grant.id, serverUrl: origin, headers: { [ACCESS_HEADER]: grant.token } };
      },
      async release({ key, hostId, grantId }) { leases.release(key, hostId, grantId); },
    });
    bb.background.service("sandbox-relay", {
      async start(signal) {
        while (!signal.aborted) {
          const config = await settings.get();
          if (!config.enabled) {
            diagnostics.record("readiness", "closed", "disabled");
            await new Promise<void>(resolve => {
              const done = () => { signal.removeEventListener("abort", done); resolve(); };
              wake = done;
              signal.addEventListener("abort", done, { once: true });
              settings.get().then(value => { if (value.enabled || signal.aborted) done(); }, done);
            });
            continue;
          }
          cycle = new AbortController();
          await run(config, AbortSignal.any([signal, cycle.signal]));
        }
      },
    });
  }
  return {
    setup, settings, supported,
    async enable() { if (!supported) throw new Error("This BB release does not support sandbox relays"); await settings.experimental_set({ enabled: true }); },
    async disable() { await settings.experimental_set({ enabled: false }); await stop(); },
  };
}
