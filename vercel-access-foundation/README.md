# Vercel Access foundation

Local-only authorization conformance code for the proposed user-owned Vercel
Access topology. This package is **not a BB plugin, ingress, tunnel, or cloud
implementation**. It has no cloud clients, deployment scripts, credentials,
or configurable upstream. Nothing here connects to the daily BB server.

## Verify

Requires Node 22.18 or newer (native TypeScript execution).

```sh
cd vercel-access-foundation
npm ci
npm run typecheck
npm test
npm run build
```

`src/sdk-contract.ts` compiles against released public Plugin SDK 0.6.59,
the SDK reported by the installed BB 0.46.1 app. It checks type availability,
not runtime activation or authorization. No SDK implementation is vendored.

## Reuse boundaries

- `authorization.ts`: Ed25519 signed, exact-request-bound **probe-only** claims,
  strict claim parsing, short lifetime, generation/host/grant binding, forbidden
  authority-header rejection, and bounded single-process replay detection
- `grants.ts`: pure state transitions for **one acquisition epoch**, suitable for
  exercising crash recovery by serializing state; no persistence, cross-process
  locking, token issuance, automatic repair, or provider registration
- `local-chain.test.ts`: real ephemeral loopback HTTP listeners for a synthetic
  gateway → relay → harmless fixture chain; deliberately **not** an outbound
  tunnel, WebSocket implementation, BB server, or Vercel transport simulation

The fixture permits only an empty-body `GET /v0/probe`. Core BB paths, owner
scopes, browser credentials, and general proxying are rejected. Tests generate
keys/tokens in memory. Machine tokens cannot access relay/fixture origins
without a valid gateway signature. Independent verifier instances model the
relay and connector boundary, but not distributed replay storage or recovery.
The local client uses `node:http`: browser-oriented `fetch` adds Fetch Metadata
headers, which this machine-only probe intentionally rejects.

Do not relax the probe allowlist into arbitrary loopback forwarding. Phase 1
may reuse the invariants and tests around a real outbound transport to the
same harmless fixture. Live BB forwarding is blocked on a supported,
provider-neutral authenticated-ingress SDK contract. Production parsing,
stream framing, bounded queues, backpressure, reconnect, durable revocation,
core principal enforcement, and Vercel behavior all need separate verification.

See [the Phase 0 report](../docs/vercel-access-phase0.md) for evidence, proposed
protocol, exact route boundaries, and Phase 1 acceptance gates.
