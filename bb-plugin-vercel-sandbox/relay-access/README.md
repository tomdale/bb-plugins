# Integrated sandbox relay

Vercel Sandbox owns the relay's local transport, setup records, private identity and server-access provider (`vercel-sandbox-relay`). No companion plugin is required. The [package guide](../README.md#local-bb-tunnel) describes Enable relay and Disable relay.

`server.ts` registers an in-process background service that waits while disabled and connects the fixed machine bridge when enabled. Settings changes stop its current connection and revoke admission leases; normal transport retries retain leases. Enabling and disabling never reload the Sandbox plugin or its worker-management handlers. Server restart or plugin reload invalidates admission and cannot repair existing workers.

`config.ts` stores connector material in the SDK's secret `relayIdentity` setting, backed by a mode-0600 file and omitted from frontend settings values. The visible field is managed automatically. `setup.ts` owns retained prepare/inspect/apply/stop identities and requires confirmed cleanup before a replacement. Vendor credentials, worker allocation, relay ownership and cloud lifecycle remain in the parent package's original authentication-host implementation. Existing ownership tags, admission-header names and stored KV prefixes are retained so historical receipts still identify their original resources.

## Machine-only boundary

- The bridge accepts only exact native installer, enrollment, session, artifact and daemon WebSocket routes. Owner APIs, browser access, previews, cookies, gate claims, enrollment-key minting and arbitrary destinations are denied before loopback dispatch.
- Native BB authorization stays opaque. BB verifies enrollment credentials, host/session ownership and daemon protocol. Transport admission is installation-level access, not a new native principal or a claim that admission host A must equal native host B.
- The SSH connector pins the owned relay's host key and reverse tuple. Every admitted channel dials the fixed literal `127.0.0.1` bridge port. No shell, exec, agent forwarding, SOCKS or caller-selected network destination is enabled.
- Bounded Vercel ingress metadata is discarded at the public relay. It never becomes native authority; the local bridge remains strict.
- Readiness requires released BB **0.48.0 / protocol 258** locally and through the relay. Untested releases fail closed for relay access without disabling unrelated Sandbox account or worker-management operations.
- The relay can observe payloads and native credentials passing through it. Confidentiality from the user's cloud relay or Vercel TLS termination is not claimed.

The detailed boundary and route inventory are in [the design record](../../docs/vercel-access-phase2.md). Relay lifetime is fixed at one vCPU and ten minutes; durable admission, existing-worker recovery, owner/browser ingress and previews are not implemented.

## Build and verification

Run from the Vercel Sandbox package:

```sh
npm ci
npm run typecheck
npm test
npm run build:relay
npm run check:relay
npm run build
npm run test:core
```

`build-relay.mjs` generates the pinned standard ssh2 runtime and standalone relay artifact, including dependency licenses and source/lockfile digests. Optional native SSH acceleration is disabled in the generated runtime so BB can compile the plugin from source on install/reload. It uses Node crypto, not a different SSH implementation. Package installation disables lifecycle scripts; `npm test` explicitly rebuilds its native SQLite test peer. The BB builder installs its own toolchain under temporary HOME/XDG/npm/data directories.

The ordinary suite includes transport, deny-boundary, cancellation, secret-redaction and lifecycle tests. `test:core` starts released BB and a native daemon in temporary data directories and exercises the integrated plugin without Vercel Access installed. All identities are synthetic; no test allocates cloud compute or uses the daily app's account state.

Existing installations use the [retired migration helper](../../bb-plugin-vercel-access/README.md) once to move private settings and retained receipts server-to-server, then uninstall it. Migration starts no transport and performs no cloud operation.
