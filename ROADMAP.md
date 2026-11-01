# Roadmap

## Vercel Sandbox and Vercel Access

The goal is remote development in user-owned Vercel Sandboxes while the local BB app remains the source of truth. A relay sandbox carries authenticated machine traffic over an outbound SSH-over-WebSocket tunnel from the laptop; a separate worker sandbox runs the checkout and BB daemon.

This roadmap records outstanding work, not permission to implement every item or allocate cloud resources. Reliability, previews, and browser access are separate scopes. Use released public plugin APIs; BB-core and SDK source changes are outside this plan.

### Established baseline

The minimal vertical slice is complete: a real fresh Vercel worker ran a BB thread through the relay into the existing local BB app, created a proof file, and the local app independently read it through its native remote file API. The proof used BB 0.46.1 and manual setup/CLI thread creation. Its relay and worker were removed afterward.

Implemented foundations include native enrollment and daemon authentication, restricted machine-only routing, installation-scoped revocable admission, pinned SSH host identity, a fixed laptop forwarding target, original-account provisioning and cleanup safeguards, standalone relay artifact integrity, and bounded stage diagnostics. Managed-image tag/digest normalization is handled. The relay discards bounded Vercel ingress metadata rather than forwarding or trusting it as identity; the local bridge remains strict.

These foundations do not establish production durability or prove every failure mode in the cloud.

### Active scope: usable UI on BB 0.48.0

The UI integration is assigned for implementation; the checks below are acceptance criteria, not claims of delivery. The existing Sandbox plugin runs on BB 0.48.0, but Access's exact BB 0.46.1 compatibility requirement prevents it from loading there.

- [ ] Validate native route, authentication, protocol, and readiness behavior on BB 0.48.0; update the compatibility policy based on tests, not only a manifest range change.
- [ ] Integrate explicit relay setup, status/readiness, and stop controls into the existing Vercel Sandbox UI using public plugin APIs and BB-style components.
- [ ] Require clear consent before provisioning relay compute. Never allocate on render, settings reads, availability checks, polling, or implicit reconnect.
- [ ] Prevent worker allocation when relay readiness fails and show actionable setup or cleanup errors without exposing secrets.
- [ ] Route the new worker through Vercel Access without silently changing unrelated machine defaults. Prefer a public per-machine selection contract if available; otherwise make any required default change and restoration explicit.
- [ ] Test UI/RPC contracts, denial behavior, redaction, compatibility, and local activation; inspect the rendered UI in BB.
- [ ] Integrate, build, deploy from the canonical checkout, push, and verify that the installed plugins are compatible and running.
- [ ] With a separately approved resource/runtime budget, verify thread creation through the actual UI and verify owned-resource teardown.

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
