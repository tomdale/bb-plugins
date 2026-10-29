import type { BbPluginApi, ServerAccessProviderDeclaration } from "@get-bb/plugin-sdk";

export const sdkSurface = (bb: BbPluginApi) => ({
  registerAccess: bb.experimental_serverAccess.register,
  recheckAccess: bb.experimental_serverAccess.recheck,
  registerService: bb.background.service,
  onDispose: bb.onDispose,
  loopbackBaseUrl: () => bb.server.loopbackBaseUrl,
  typedHostClient: bb.hosts.experimental_client,
  sharedPortIdentity: bb.hosts.ensureSharedPortTunnel,
  declareSharedPorts: bb.hosts.declareSharedPorts,
});

export const probeProviderContract = {
  id: "vercel-access-probe",
  displayName: "Vercel Access probe",
  description: "Contract fixture only; never registered in a running BB server",
  availability: () => ({ status: "setup-required", message: "Local conformance fixture only" }),
  acquire: async ({ key, hostId, signal }) => {
    signal.throwIfAborted();
    return { id: `${key}:${hostId}`, serverUrl: "https://gateway.example.invalid", headers: { "x-va-token": "synthetic-only" } };
  },
  release: async ({ key, hostId, grantId }) => {
    void [key, hostId, grantId];
  },
} satisfies ServerAccessProviderDeclaration;
