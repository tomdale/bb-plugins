# Roadmap

## Vercel Sandbox and Vercel Access

The goal is remote development in user-owned Vercel Sandboxes while the local BB app remains the source of truth. A relay sandbox carries authenticated machine traffic over an outbound SSH-over-WebSocket tunnel from the laptop; a separate worker sandbox runs the checkout and BB daemon.

This roadmap records outstanding work, not permission to implement every item or allocate cloud resources. Reliability, previews, and browser access are separate scopes. Use released public plugin APIs; BB-core and SDK source changes are outside this plan.

### Established baseline

The minimal vertical slice is complete: a real fresh Vercel worker ran a BB thread through the relay into the existing local BB app, created a proof file, and the local app independently read it through its native remote file API. The proof used BB 0.46.1 and manual setup/CLI thread creation. Its relay and worker were removed afterward.

Implemented foundations include native enrollment and daemon authentication, restricted machine-only routing, installation-scoped revocable admission, pinned SSH host identity, a fixed laptop forwarding target, original-account provisioning and cleanup safeguards, standalone relay artifact integrity, and bounded stage diagnostics. Managed-image tag/digest normalization is handled. The relay discards bounded Vercel ingress metadata rather than forwarding or trusting it as identity; the local bridge remains strict.

These foundations do not establish production durability or prove every failure mode in the cloud.

### BB 0.48.0 delivery and remaining UI acceptance

The relay is integrated into Vercel Sandbox; the retired Access plugin is not required. Native compatibility, local deployment, and a bounded live CLI/RPC thread test are verified. Full UI-only thread creation remains a separate acceptance check.

- [x] Validate native route, authentication, protocol, and readiness behavior on BB 0.48.0, including skill-manifest and skill-content synchronization.
- [x] Integrate one-click Enable/Disable, readiness, and troubleshooting into the existing Vercel Sandbox UI using public plugin APIs and BB-style components.
- [x] Provision only from an explicit owner action. Enable needs no separate consent checkbox; render, settings reads, availability checks, polling, and reconnect never allocate compute.
- [ ] Complete acceptance of readiness-failure gating and actionable setup/cleanup behavior. Enable can report still connecting shortly before readiness succeeds; a removed relay is currently summarized as stopped.
- [x] Select the relay for new machines through the public global-default contract and restore the previous connection on Disable. BB 0.48 has no per-launch selector; the UI explains the global effect.
- [x] Test UI/RPC contracts, denial behavior, redaction, compatibility, and local activation; inspect the rendered UI in BB. Generated identity is private backend state, not an editable setting.
- [x] Integrate, build, deploy from canonical, push, and confirm Vercel Sandbox runs without the standalone Access plugin.
- [x] Verify a real Pi turn through a fresh Vercel worker using CLI/RPC thread creation, independently read its proof through the native remote file API, verify a clean repository, and confirm worker/relay termination and metadata removal. The bounded test used one 1-vCPU/five-minute worker and one 1-vCPU/ten-minute relay; metadata cleanup needed one retry.
- [ ] Verify the complete settings-to-New-thread workflow through the actual UI, including readiness/selection feedback and owned-resource teardown.

Keep this slice small: no previews, remote browser access, durable admission system, or general platform redesign is required for UI delivery. Existing proof budgets are consumed; local tests and mocked provisioning do not authorize another live allocation.

### Deferred reliability and lifecycle work

#### Durable admission

- [ ] Persist valid admission grants across ordinary plugin/server restarts using private storage, acquisition epochs, expiry handling, revoke tombstones, and startup reconciliation.
- [ ] Verify that restart preserves valid existing-worker access while revoked or expired grants and active channels remain denied.

Current grants have process/factory lifetime. Do not replace them with a permanent shared secret as a shortcut.

#### Existing-worker recovery

- [ ] Implement an explicit owner-controlled recovery procedure using public APIs/execution facilities for replacement access headers or a changed relay URL.
- [ ] Test grant rotation and relay replacement while preserving worker identity and workspace, without silent worker recreation or data loss.

The already-enrolled bootstrap path starts the daemon but does not automatically deliver replacement headers. Persisting a grant alone does not solve every recovery case.

#### Relay operation beyond a short session

- [ ] Define supported outcomes for relay expiry, laptop sleep/wake, network loss, authentication changes, and interrupted setup.
- [ ] Support explicit health checks, trusted identity rotation, controlled replacement, and original-account cleanup, coordinated with worker reconfiguration.
- [ ] Make lifetime limits, resource costs, cancellation, and uncertain cleanup visible. Do not allocate replacement compute from an uncontrolled reconnect loop.

### Deferred validation and hardening

- [ ] Test real-cloud transient disconnection and reconnection without replaying writes or allocating replacement compute.
- [ ] Extend cloud validation of missing/invalid admission, native-auth denial, owner-route rejection, revocation, and cancellation. Local coverage and the successful proof do not substitute for each cloud check.
- [ ] Exercise representative binary HTTP and WebSocket traffic through the real endpoint beyond the demonstrated worker/file workflow.
- [ ] Cover restart/reload, sleep/wake, expiry, malformed stored state, interrupted provisioning/submission, authentication changes, and cleanup retries in integrated tests.
- [ ] Verify bounded resources, diagnostic rate/size limits, secret redaction, and source-to-relay artifact integrity as the implementation evolves.
- [ ] Verify teardown independently of connectivity: confirm owned compute has stopped and metadata is removed, or explicitly report uncertainty. TTL expiry is not cleanup evidence.

Any cloud test requires a fresh explicit maximum resource count, size, runtime, and teardown plan. Preserve the fixed local forwarding target, native BB credential checks, owner-route exclusion, and separation of network admission from identity.

### Optional capabilities, separate from machine access

#### Authenticated development-server previews

- [ ] Share only explicitly registered worker-local ports through a worker-origin gateway.
- [ ] Support HTTP, redirects/cookies, HMR WebSockets, isolated application origins, listing, and revocation.
- [ ] Keep preview traffic off the laptop and preview credentials separate from machine and owner credentials.
- [ ] Verify a representative development app with HMR and deny unauthenticated access through direct sandbox URLs.

#### Remote owner/browser access

- [ ] Design optional owner authentication and installation/project pairing separately from the restricted machine bridge.
- [ ] Validate cookie policy, Origin/CSRF defenses, login/logout, session revocation, and device pairing if included.
- [ ] Verify that machine and preview credentials cannot invoke owner operations.

Neither capability is necessary to create remote threads from the local BB UI. Do not widen the machine bridge into a whole-server proxy to implement them.

### Documentation and release readiness

- [ ] Document supported BB versions, account setup, cost controls, relay lifetime, recovery, uninstall, and known limitations.
- [ ] Explain the trust boundaries, what the relay/Vercel can observe, and which credentials authorize machine, preview, and owner operations.
- [ ] Provide an end-to-end operating and recovery guide that a reader unfamiliar with the implementation can follow.
- [ ] Match every reliability/security guarantee to executable evidence and distinguish local tests, live cloud proof, deployment, and resource cleanup.

Package verification, canonical deployment, push, and task cleanup remain delivery requirements for each accepted change, not a reason to postpone the minimal UI slice until all deferred features exist.
