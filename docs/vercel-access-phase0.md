# Vercel Access: Phase 0 foundation and gates

## Decision

**Phase 0 is complete; the overall Vercel Access implementation is not.**

| Area | Result | Meaning |
| --- | --- | --- |
| Local synthetic authorization and grant reducer | **PASS** | Executed tests exercise only the package described below |
| Released public SDK surface | **PASS** for declared grant/lifecycle/host APIs | Types compile against installed-host SDK 0.6.59; source/declarations checked separately |
| Plugin-only forwarding of real BB machine or owner traffic | **BLOCKED** | No supported provider-neutral authenticated ingress; do not forward to `loopbackBaseUrl` |
| Phase 1 independent outbound transport to a harmless fixture | **CONDITIONAL** | May proceed without that SDK change, retaining probe-only scope and local-only authorization |
| Vercel gateway → sandbox relay → laptop topology | **CONDITIONAL / NOT EXECUTED** | Public documentation supports investigation, not proof of end-to-end behavior |
| Cloud allocations, deployment, cost, real enrollment/browser/preview flows | **BLOCKED pending explicit approval** | None were attempted |

The proposed topology keeps BB and its database on the user's computer:

```text
machine/browser -> stable user-owned Vercel gateway -> dedicated relay sandbox
                                                        ^
                                                        | outbound WSS
                                                laptop connector/plugin
                                                        |
                                               authenticated BB ingress
                                               [SDK BLOCKER; not loopback]

worker preview -> authenticated gateway/share boundary -> worker preview origin
                  (must not route preview bytes through the laptop)
```

There is no hosted BB account, Connect credential, Connect gate, or hosted BB
service in this proposed access path. A Vercel account/infrastructure is still
required. Browser access is a later, separately authorized security surface.

## Evidence and version boundaries

Investigation observed BB **0.46.1**. `bb plugin types --check` on the existing
Vercel plugin reports host SDK **0.6.59**, versus its committed pin **0.6.54**.
That check also reports existing dependency-placement drift; this phase does
not modify the Vercel plugin or refresh its dependencies.

The foundation pins public [SDK 0.6.59](https://www.npmjs.com/package/@get-bb/plugin-sdk/v/0.6.59).
The registry's current release was
[0.6.94](https://www.npmjs.com/package/@get-bb/plugin-sdk/v/0.6.94), whose packed
public declarations were inspected separately. Neither provides a supported
provider-neutral authenticated-ingress contract. The newer declarations expose
`internal_DO_NOT_USE_openTunnelIngress`, explicitly reserved for BB's Connect
plugins. Its presence is **not** permission or public support.

The local BB checkout HEAD was `dc6a4f625e`; its cached `upstream/main` was
`24a5b76866621c2e093787219c7e605bcb0cefc1`. To avoid confusing those with latest
upstream, GitHub's main ref was resolved read-only to
[`bec24f2f8d6da1877863dfa9155cf3867ea1ab18`](https://github.com/get-bb/bb/commit/bec24f2f8d6da1877863dfa9155cf3867ea1ab18).
The relevant files at that immutable commit were read through `gh api`.
That source declares SDK 0.6.98; it is not the installed or registry release.
No BB source, branch, settings, or running-server state was modified.

### BB contract evidence

- [Backend contract](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/packages/plugin-sdk/src/backend-contract.ts):
  `ServerAccessGrant` is `{ id, serverUrl, headers? }`;
  `experimental_serverAccess.register` provides `availability`, keyed
  `acquire({ key, hostId, signal })`, and
  `release({ key, hostId, grantId: string | null })`. This is reachability and
  provider-managed access metadata, **not a core authenticated request context**.
- [Core access lifecycle](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/services/machines/server-access.ts):
  provider selection is saved before acquisition; grant shape and URLs are
  validated, the returned grant ID must remain stable, and availability has a
  five-second status-check bound. Repair releases and reacquires with the same
  acquisition key. Removal without the provider installed can skip release
  with a warning: remote expiry and explicit recovery are necessary.
- [Daemon credential proxy](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/host-daemon/src/machine-auth-proxy.ts):
  access headers are overlaid on HTTP and WebSocket requests. Preserve the
  separate BB `Authorization` credential; do not use it for the access token.
  The proxy's browser/authority checks protect its own local endpoint, not a
  new remote BB ingress.
- [Request context](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/request-context.ts),
  [host enrollment](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/internal/hosts.ts), and
  [browser guard](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/browser-request-guard.ts):
  core distinguishes trusted socket address and gate metadata. Loopback-only
  enrollment-key minting depends on the former. Origin/Host/JSON checks are
  browser request protections, not remote owner authentication. Installed
  0.46.1 source maps confirm the same distinction; its request context does not
  yet have the latest ingress WeakSet marker.
- [Connect ingress](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/services/connect-next/tunnel-ingress.ts):
  a private listener verifies Connect gate assertions bound to method, exact
  target, and audience, strips incoming gate headers, marks requests as remote,
  and derives core identity from verified claims. This explains the needed
  boundary; copying that implementation or invoking its internal SDK hook is
  not an external-plugin workaround.
- Public lifecycle APIs include factory registration, `background.service`
  with cancellation, `onDispose`, `onInstall`, private plugin storage, and
  `serverAccess.recheck`. `onDispose` is process cleanup, not proof of durable
  cloud revocation, nor a reliable crash/uninstall notification.
- Typed host support is public: `hosts.experimental_client`,
  `experimental_defineHostEntry`, typed RPC/signal contracts, cancellation, and
  host entry disposal. It does not provide an unbounded duplex tunnel stream.
  Existing `bb-plugin-vercel-sandbox/host.ts` accumulates exec output before
  returning; `host-contract.ts` caps the output string at 131072 characters
  (not a streaming byte budget). It is not the
  tunnel data path.
- `hosts.ensureSharedPortTunnel` and `declareSharedPorts` use the daemon's
  trusted Connect identity/destination. Plugins cannot supply another gate
  label, issuer, or enrollment credential. Standalone provider-owned preview
  links/controls can be plugin-owned; native unified port sharing needs a
  provider-neutral preview contract. Do not fabricate a Connect machine ID.

### Why there is no approved plugin-only BB machine MVP

A machine access token must never imply owner authority. A plugin-created
proxy connecting to the ordinary BB listener is seen as localhost, not as a
remote machine principal. Stripping untrusted gate headers does not repair
that trusted-localhost classification. Adding trusted gate headers is not an
approved substitute. Even a gateway's correct authentication does not cause
BB to check that the access grant host matches the daemon credential host.

Native daemon endpoints already have meaningful BB authentication. That does
**not** mean all loopback paths are safe to expose. A hand-maintained subset
could be investigated separately, but is not accepted here as a supported
core authorization boundary. This phase has no real BB proxy or allowlist
adapter. Live forwarding remains a hard block; transport work against the
harmless fixture does not depend on resolving it.

## Minimum BB traffic and authorization boundary

[Core route definitions](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/packages/host-daemon-contract/src/session.ts)
and [server wiring](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/server.ts)
are the source of truth. A supported machine ingress should cover this
versioned minimum, not `/internal/*` or arbitrary `/api/v1/*`:

| Endpoint | Existing core protection | Required new ingress enforcement |
| --- | --- | --- |
| `GET /install.sh`, `GET /install.ps1` | `X-BB-Enrollment` resolves enrolled/reconnect bootstrap; behavior differs for missing credentials | `machine:bootstrap` plus host-bound bootstrap credential resolution; never expose credential-bearing installer through a public cache |
| `GET /install/version`, `GET /install/bb-app.tgz` | Version/artifact serving | Explicit artifact policy, bounded streaming, no credential leakage; static serving alone is not a principal blocker |
| `POST /internal/hosts/enroll` | Enrollment bearer verified against payload host ID | Access host ID must also equal the reserved/enrolling BB host; never assign Connect identity |
| `POST /internal/session/open` | Daemon host bearer; core session ownership | `machine:runtime`, access host ID equals verified daemon host |
| `GET /internal/ws?sessionId=…` | Daemon bearer, daemon subprotocol, host/session match | Same host binding on upgrade and session lifetime; protocol preserved |
| `POST /internal/session/events`, `/internal/session/tool-call`, `/internal/session/interactive-request`, `/internal/session/interactive-request/interrupt` | Daemon authentication and per-operation/session checks | Same runtime principal/host binding; retain all existing core checks |
| `GET /internal/session/project-attachment-content` | Daemon-authenticated content serving | Same runtime scope and core session ownership |
| `GET /internal/skills/tree/:hash`, `/internal/plugins/:pluginId/host/:digest` | Daemon bearer middleware | Same runtime principal; bounded artifact streaming |
| `GET /internal/skills/tree/:hash/content` | Present in latest source, not an assumption about installed 0.46.1 | Version-negotiated runtime route only after release support |

The credentialed bootstrap/runtime rows lack a **supported public ingress**
that can carry and enforce their remote machine principal. They are blocked
for this implementation despite their native bearer checks. The table is a
minimum protocol inventory, not permission to turn on forwarding. Installer
redirects, archive delivery, plugin artifacts, skill content, and reconnect
must be tested against the exact target release before a live MVP.

**Always deny to machine credentials:** `POST /internal/hosts/enroll-key`
(local enrollment-key minting), host create/delete/reconnect/admin APIs,
settings, plugin RPC/CLI, project/thread management, browser `/ws`, terminal
WebSockets, server-move routes, and all unlisted paths/methods. An authenticated
machine must not gain these by selecting a URL or a header. Owner access is
out of scope until a separately reviewed owner-session/CSRF/origin contract
exists. The synthetic harness rejects **all** BB paths, including the table.

## Smallest proposed SDK approval

This is a proposal, not an available API. Approve a separate BB-core/SDK
workstream to design and release a machine-only ingress with a shape like:

```ts
bb.server.experimental_openAuthenticatedIngress({
  async verify({ method, pathAndQuery, headers, signal }) {
    // Verify the provider assertion and its revocation/generation state.
    // No trusted identity is taken from caller-supplied BB headers.
    return null; // or { kind: "machine", hostId, grantId,
                 //      scopes: ["machine:bootstrap", "machine:runtime"] }
  },
}); // -> { baseUrl, close() }
```

The exact spelling is not required; these behaviors are:

1. A separate private listener, never ordinary trusted loopback. Verification
   happens before every HTTP request and WebSocket upgrade; timeout, exception,
   missing identity, or plugin disposal denies. Core owns principal attachment
   out-of-band, strips/ignores all untrusted authority headers, and never treats
   these connections as local-owner traffic. No owner/session principal in the
   initial API.
2. Core owns a versioned machine route/method policy. It enforces bootstrap vs
   runtime scopes and matches access `hostId` to enrollment/daemon/session
   credentials, including credential-bearing installers. The original BB
   bearer remains mandatory. A scoped transport token alone cannot enroll,
   establish a session, or invoke an owner operation.
3. Verification and stream cancellation are bound to plugin/ingress lifecycle.
   Close invalidates ingress handles and active HTTP/WS streams. Grant revoke
   needs a supported way to close active streams for that grant, not just reject
   the next handshake. Surface errors and capability/version detection without
   private imports or Connect-specific claims.

The minimum approval is for **this boundary and enforcement**, not for exposing
Connect's private method unchanged. Owner browser ingress and provider-neutral
native preview sharing are separate extensions, not prerequisites for Phase
1's harmless transport. No upstream request or BB modification was made.

## Proposed transport protocol, version 0

**Design, not validated cloud behavior.** Phase 1 should implement the small
probe subset first, without a BB upstream option.

### Roles and credentials

- Installation identity: random stable `installationId`, stored privately on
  the laptop; not a BB Connect server/machine ID.
- Relay identity: stable logical `relayId`, actual provider sandbox ID, and
  monotonically increasing `generation`. Hostname is a locator, not identity.
- Machine access: individually random, revocable grant token; gateway stores
  its digest and bound `hostId`, scopes, expiry, and grant ID. Return the token
  in a dedicated access header through `ServerAccessGrant.headers`; preserve
  BB `Authorization`. Never use query tokens or URL userinfo.
- Gateway signer: installation-scoped signing key, with separately provisioned
  public verifier on relay and connector. The local foundation uses Ed25519.
  Production key storage, rotation, and distribution are not implemented.
- Connector/control: a separate role-specific credential bound to installation,
  relay generation, and the laptop connector. A machine credential cannot
  register/replace the connector, allocate compute, or update relay discovery.
- Browser owner: separate future session credential, never a machine token.
  No browser login flow or owner route is implemented here.

### Rendezvous and stream framing

The laptop makes an outbound TLS WebSocket connection to the **dedicated
sandbox relay**, not a randomly selected Function instance. Gateway requests
resolve a durable current relay record and connect to that relay. Gateway
Functions need no in-memory rendezvous with each other. Reject stale
installation/relay/generation at relay and connector, even if a stale URL
remains reachable. A control-plane CAS/fencing operation must prevent two
connectors from accepting the same generation.

Proposed frames: `hello`, `ready`, `open`, `data`, `end`, `cancel`, `ping`,
`pong`, `goaway`. `hello` authenticates protocol/role/generation; `ready`
completes fresh challenge proof before streams are accepted. `open` binds a
unique stream ID to the signed method, exact origin-form path/query, grant,
BB host, scope, and deadline. `data` is ordered binary payload; `end` carries
HTTP completion or WebSocket close, not implicit request replay. Responses
are bound to stream ID and connection generation. Use raw request targets;
reject ambiguous encodings, absolute URLs, hop-by-hop headers, and redirects
that could change origin. No generic TCP destination or URL is accepted.

Initial limits to implement/test: 64 KiB maximum frame, 1 MiB maximum queued
bytes per connection, 16 concurrent streams, 8 KiB assertion, 15-second open
assertion TTL, 15-second heartbeat, 45-second peer timeout, bounded jittered
reconnect (1–30 seconds). Close/goaway rather than accumulating unbounded
memory. These stream/heartbeat limits are **proposed**, not implemented in
this phase. The probe verifier implements the assertion bound/TTL and a
4096-entry single-process replay cap; on exhaustion it fails closed.

The foundation signs only empty-body `GET /v0/probe`, with strict fields for
installation/relay/generation, host/grant, scope, target/method, body digest,
issued/expiry time, and nonce. Relay and fixture independently verify.
Production request signing must bind stream/connection identity and support
bounded streamed bodies without buffering everything to calculate a digest;
that wire format remains a Phase 1 design gate. Do not reinterpret the probe
assertion as authorization for arbitrary streamed BB traffic.

## Grant lifecycle and recovery

Core acquisition key and BB `hostId` are opaque stable inputs. Keep one private
mapping from `(key, hostId)` to a current acquisition epoch and a tombstone
history. Never publish tokens in machine inputs/resources, progress, CLI
output, or shared metadata.

```text
absent -> pending [persist revocation identity before issuing anything]
pending -> active [credential installed, relay/connector generation ready]
pending/active -> revoking [local deny and stream closure first]
revoking -> revoked [idempotent remote revoke; retain tombstone]
```

- Retry acquire within an epoch returns the same grant ID and credential;
  abortion before return still leaves enough state for `release(..., null)`.
  Availability is read-only and never acquires/provisions access.
- Record revoke intent durably before remote cleanup. Deny at connector even
  if the relay/gateway is unreachable; queue remote reconciliation. Expiry is
  necessary because core cannot always call the provider on removal. Proposed
  default: a 24-hour provider-side access lease, renewed by the authenticated
  local control service only for still-active grants. Lease renewal does not
  change the credential returned to the daemon. Fail closed after missed
  renewal; an explicitly revoked epoch cannot renew. This lease protocol is
  not implemented by the reducer, and `ServerAccessGrant` has no native token
  rotation/refresh callback. Credential replacement therefore requires the
  supported repair flow, not an assumption that daemons receive new headers.
- Startup/reload reconstructs current grants and pending revocations before
  reporting available. Services and handles stop on disposal; do not globally
  revoke every persistent machine merely because a plugin reloads.
- Core repair releases then acquires **the same key**, with the previous core
  grant ID cleared. A production adapter must archive the revoked epoch and
  explicitly create the next one, serializing acquire/release/repair so a late
  null-ID release cannot revoke a new epoch. The pure reducer intentionally
  models only one epoch; it is not a full `serverAccess` adapter or durable DB.
- Relay replacement uses a higher generation and fresh connector credential.
  Durably commit/fence the current generation before declaring ready. On
  sandbox loss, reconcile provider IDs/idempotency tags and stop orphaned
  relays; do not silently allocate on every request. Preserve grant IDs/BB
  machine identities through relay relocation.
- Laptop sleep, Function timeout/deploy, relay interruption, and control-store
  outage close affected streams. Reconnect with a new handshake and replay
  window; never blindly replay non-idempotent operations. BB daemon recovery
  reopens its authenticated session through its own protocol. Availability
  recheck reports degraded/unavailable while disconnected.
- Durable relay discovery, CAS/fencing, revoke propagation, multi-instance
  replay protection, time skew policy, and cloud cleanup are unimplemented.
  An in-memory nonce cache is not restart-safe; a new connection epoch or
  equivalent fencing must invalidate old assertions before reaccepting traffic.

## Vercel evidence versus assumptions

Current public docs were fetched directly for these checks:

- [Daemons limits](https://vercel.com/docs/daemons/limits): inbound HTTP/TCP,
  persistent local storage, and service-binding/rewrite targets are unsupported.
  Continuous execution does not make Daemons an ingress/rendezvous service.
- [Function WebSockets](https://vercel.com/docs/functions/websockets): a socket
  is pinned to one instance, can close at maximum duration, and distinct/new
  sockets need not reach the same instance. Never depend on Function-local
  memory to pair laptop and machine connections.
- [Sandbox concepts](https://vercel.com/docs/sandbox/concepts): exposed ports
  have public URLs; WebSockets can be interrupted while the sandbox runs.
  Authenticate the relay application itself, including on its direct public
  origin. Provider deployment protection alone is not the grant boundary.
- [Sandbox SDK changelog](https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/CHANGELOG.md):
  3.7.0 adds writable command stdin; 3.6.1 fixes split-UTF-8 log recovery.
  Neither validates an end-to-end tunnel. Existing toolbelt pins 3.5.1 and its
  buffered host RPC still prevents using that RPC as a live stream.
- [Drives](https://vercel.com/docs/sandbox/concepts/drives) document persistent
  sandbox working storage. A drive is not proof of atomic discovery/fencing,
  a Function-shared data store, or justification to upload BB's database.

Not established locally: sandbox exposed-port streaming behavior, Function
WebSocket routing for the chosen gateway framework, headers/upgrade fidelity,
maximum duration under the user's plan, costs, sleep/recovery timing,
provider protection interactions, or whether a durable relay discovery store
is available without additional paid services. Those require an approved,
bounded cloud experiment. No production-support claim follows from this report.

## Privacy and security invariants

1. BB database, filesystem, agent credentials, transcripts, and provider login
   files remain local; none is copied to a sandbox, drive, gateway, or report.
   This does not claim encrypted application payloads are invisible to cloud
   compute: TLS termination/gateway/relay may see traffic unless a separately
   designed end-to-end encryption layer is added.
2. No hosted BB identity/service dependency; never substitute fake Connect IDs,
   private packages, internal SDK hooks, or synthetic trusted gate headers.
3. Anonymous traffic, wrong scope/host/installation/generation, forged authority
   headers, expired/revoked grants, and direct-origin bypass fail closed.
4. Separate machine access credentials from BB daemon/enrollment credentials,
   connector control credentials, gateway signing keys, owner sessions, and
   Vercel API authorization. A token grants only its role's explicit actions.
5. No public cache of credential-bearing responses; no credential/payload
   logging. Log bounded diagnostic IDs/statuses, not live requests or URLs
   containing bootstrap/session material. Secrets use server-only storage;
   cloud signing/control credentials never reach worker inputs or the browser.
6. Revocation closes active streams as well as future handshakes. Laptop
   authorization is authoritative during remote revoke propagation failures.
7. Browser owner access requires its own authentication, logout/revocation,
   CSRF and Origin review. Preview shares require separate scoped policy and
   must serve worker-origin traffic without laptop transit. Neither is inferred
   from a successful machine probe.

## Executed verification and artifacts

All changes are in Workforest task `vercel-access-phase0`, branch
`tomdale/vercel-access-phase0`, based on
`e249c9b47ee8ecee08d8baf5f8ff0441b3178a76`:

```text
/Users/tomdale/Code/Repos/toolbelt/_tasks/main/vercel-access-phase0
```

Executed with Node v25.9.0 and npm 11.10.0, from `vercel-access-foundation/`:

| Command | Result |
| --- | --- |
| `npm ci` | PASS; committed lockfile, 11 packages installed, zero audit findings |
| `npm run typecheck` | PASS against public SDK 0.6.59 |
| `npm test` | PASS; 10 tests, including actual loopback HTTP chain |
| `npm run build` | PASS; TypeScript emits ignored `dist/` |

Tests cover valid probe, anonymous/malformed/foreign signer/oversized input,
forged gate/forwarded/browser headers, wrong role/host/grant/relay/generation,
exact-target/body/lifetime binding, replay, expiry/revocation, acquire identity,
serialized recovery, null-grant-ID release, and denial of BB paths/direct
relay/fixture access with only a machine token. They do not run core auth.

The first network-test run failed because Node `fetch` added browser Fetch
Metadata headers that the machine-only policy rejects. The test now uses
bounded `node:http` requests; the policy was not weakened. All final commands
above pass. npm prints an existing `tokenHelper` configuration warning; no
user config was changed. Inspecting the newer 0.6.94 tarball needed a one-off
`NPM_CONFIG_MIN_RELEASE_AGE=0` because it was newer than local package-age
policy; the foundation stays pinned to 0.6.59.

The scoped self-review against the task base covered behavior, authorization/
secrets, tests, readability, documentation, and change scope. It found no
remaining blocking issue within the local-only package; it is not an
independent security review or approval of production ingress.

Durable artifacts are this report, [the reusable package](../vercel-access-foundation/README.md),
and [the SDK wishlist](bb-sdk-wishlist.md). Investigation snapshots stay in
thread storage, not this public repository. No transcripts/live requests,
credentials, cloud resources, plugin installations, or daily-app reloads were
created. This package is not a BB plugin, so plugin activation smoke is not
applicable. The fresh task retains the committed `scripts/bb-plugin-smoke`;
the canonical checkout has someone else's deletion of that file, untouched.
Parent must resolve any integration/live-smoke conflict without treating this
phase as authorization to restore it.

## Exact Phase 1 acceptance gates and handoff

Phase 1 owns an independent real transport to a harmless fixture, **not live
BB forwarding**. Parent owns integration, approvals, deployment, push, and
cleanup. Reuse `authorization.ts`, `grants.ts`, and their negative cases as
probe-only building blocks; do not reuse the HTTP chain as a transport.

1. **Local transport:** laptop connector initiates an actual outbound connection
   to a local relay fixture. Gateway and relay run independently; no direct
   relay-to-laptop dial or trusted localhost BB upstream is possible. Only the
   synthetic probe destination can be selected. Demonstrate byte streaming,
   HTTP and WebSocket framing/cancel, backpressure and enforced queue/frame/
   stream limits with automated tests.
2. **Identity/auth:** negative tests traverse the real transport for anonymous,
   forged authority headers/assertions, machine vs connector/owner scope,
   wrong host/grant/installation, stale generation, wrong target/method, replay,
   and direct relay/fixture-origin access. Validate empty/streamed body binding
   and request-parser ambiguity before expanding beyond the fixed probe.
3. **Recovery/revoke:** test disconnect at every acquisition/release boundary,
   restart with persisted intent, same-key repair/new epoch, active-stream
   revocation, stale connector fencing, expired credentials, relay replacement,
   sleep-like reconnect, and refusal of non-idempotent automatic replay.
4. **Evidence:** rerun `npm ci`, typecheck, tests, build; record exact outcomes
   and remaining simulated/cloud boundaries. No plugin install or global
   settings/access mutation is needed for this phase.
5. **Cloud gate:** only after parent obtains explicit allocation/deployment/
   spend approval, run a bounded real Vercel experiment. Record actual sandbox
   exposed-port WebSocket/HTTP behavior, Function instance independence and
   max-duration reconnect, direct-origin denial, durable discovery/fencing,
   loss/cleanup, cost/limits, and absence of laptop transit for worker previews.
   Until then, mark cloud behavior CONDITIONAL/NOT EXECUTED.
6. **BB integration gate:** require a released, tested provider-neutral ingress
   satisfying the minimal contract above and exact-release enrollment/session/
   installer/owner-denial conformance. Parent's separate SDK workstream owns
   this. Never enable the BB upstream as a temporary loopback workaround.

Phase 1 local transport may pass with gates 1–4 complete and gates 5–6 explicitly
closed; it must not be described as a usable or production-supported BB access
replacement. Browser access and native preview-provider integration need their
own later acceptance gates.
