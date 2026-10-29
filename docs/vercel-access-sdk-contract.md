# Machine ingress: SDK contract and core approval plan

**Status: design ready for specific approval; no BB implementation authorized.**
Machine access remains blocked. This proposal adds a provider-neutral, machine-only
security boundary, not a general proxy or a renamed Connect API. Owner browser
access, native previews, and per-machine access selection are separate proposals.

## Decision and evidence

A `ServerAccessGrant` tells a daemon where to connect and which extra headers to
send. It does not authenticate a remote request to BB core. Forwarding to ordinary
`loopbackBaseUrl` can confer local-owner authority. Both the provider access proof
**and the original native BB enrollment/daemon credential** must pass independent
checks, with equal resolved BB host IDs. A transport proof must never mint a native
credential or substitute for it.

Read-only verification resolved public `get-bb/bb` main to
[`bec24f2f8d6da1877863dfa9155cf3867ea1ab18`][revision]. All source links below
are pinned to that revision, not a moving branch. `gh api` also confirmed the
repository is public. The local BB checkout was not changed or used as latest
upstream evidence.

| Evidence | Observation and consequence |
| --- | --- |
| [SDK backend contract][backend] | `ServerAccessGrant = { id, serverUrl, headers? }`; no public neutral principal ingress. `internal_DO_NOT_USE_openTunnelIngress` explicitly reserves its Connect contract; do not call it |
| [Request context][context], [host routes][hosts] | Trusted socket address and gate identity are distinct. Local enrollment-key mint checks loopback; machine identity cannot be recreated by rewriting headers |
| [Private Connect ingress][connect] | An existing private listener verifies gate claims and marks requests remote. Useful architectural evidence only; no import, call, copied Connect identity, or change to that contract is proposed |
| [Native auth][auth], [daemon WebSocket][daemon-ws], [session routes][session] | Daemon verification resolves a BB host; sessions retain their own ownership checks. Access-host equality must be additional, not a replacement |
| [Installer routes][server], [enrollment lookup][enrollments], [reconnect][reconnect] | Credential-bearing installers resolve pending/reconnect identities. Reconnect invokes `serverAccess.repair`; compare hosts before side effects, and avoid revoking the grant carrying the installer response |
| [Access lifecycle][access], [daemon credential proxy][proxy] | Provider selection/grant persistence and outgoing headers already exist. These do not attach a trusted incoming principal. Preserve `Authorization`; use a separate access header |
| [Public test harness][harness] | HTTP auth modes are recorded, not enforced. A fake-host test cannot prove core ingress isolation |

Observed BB is **0.46.1** (`bb --version`). Phase 0 reports host SDK **0.6.59**;
its installed public declarations were independently read here and have no neutral
ingress. Public registry `latest` resolved to **[0.6.94][npm94]**; its public
tarball was downloaded without installation, SHA-512 checked against registry
metadata, and bundled declarations read. It still has only the reserved ingress.
The pinned upstream [manifest][sdk-package] declares **0.6.98**, which is neither
the installed host nor evidence of a usable published feature. No version number
alone satisfies this release dependency.

## Proposed minimal SDK surface

**Names and types below are proposed, not callable APIs.** Publish through
`@get-bb/plugin-sdk` only; external plugins require no private dependencies.
Use one feature descriptor, one open operation, and two lifecycle operations:

```ts
// Proposed optional member of bb.server:
experimental_machineIngress?: {
  readonly contractVersion: 1;
  readonly policyVersions: readonly ["machine-v1"];
  open(options: {
    policyVersion: "machine-v1";
    signal?: AbortSignal; // lifetime, not merely bind cancellation
    verify(input: {
      ingressId: string;
      requestId: string;
      method: string;
      rawTarget: string; // original origin-form path and query, before URL parsing
      upgrade: "websocket" | null;
      assertion: string | null; // one x-bb-ingress-assertion header
      signal: AbortSignal;
    }): Promise<null | {
      kind: "machine";
      hostId: string; // native BB host ID, never a Connect machine ID
      grantId: string;
      epoch: string; // provider acquisition epoch
      generation: string; // provider transport fencing generation
      scopes: readonly ("machine:bootstrap" | "machine:runtime")[];
      validUntil: number; // Unix milliseconds; bounded stream authorization lease
    }>;
  }): Promise<{
    readonly ingressId: string;
    readonly baseUrl: string; // private loopback listener, NOT loopbackBaseUrl
    revoke(binding: { grantId: string; epoch: string; generation: string }): Promise<void>;
    close(): Promise<void>;
  }>;
};
```

No owner/public/session principal union, route registration, arbitrary upstream
URL, Connect audience, body callback, or native credential issuance is included.
The plugin is trusted server code and owns proof verification and current grant
state; core does not prescribe Vercel, JWT, a signer service, or storage format.
Returning a principal is not permission to bypass native auth or expand routes.

### Authorization and request context

1. Core binds a **separate loopback-only listener**, owned by the plugin instance,
   and dispatches into the app without an ordinary loopback HTTP hop. Before
   dispatch, core attaches an immutable machine-ingress context through a private
   request-object association, carried into Hono/upgrade handling out of band.
   This context always suppresses trusted-local address classification. It is
   neither constructed from nor serialized into gate/forwarded headers.
2. Reject duplicate assertion/native credential headers before coalescing. Consume
   `x-bb-ingress-assertion` at ingress. Strip incoming `x-bb-gate-*` and forwarding
   authority metadata; never manufacture gate auth, machine, OAuth, or session
   headers. Drop browser cookies; reject browser Origin/Fetch Metadata for this
   machine-only entry. Only core may set routing Host to its internal app origin;
   this cannot create a local-owner principal. Do not rewrite Origin to pass a
   browser guard. Preserve native `Authorization`, `X-BB-Enrollment`, and daemon
   WebSocket subprotocol through native verification, without logging them.
3. Verify before **every** HTTP request, including keep-alive reuse, and before
   every WebSocket upgrade. The verifier receives only the copied proof and
   request-binding fields, not cookies/native credentials or a mutable request.
   It must authenticate proof audience (`ingressId`), method, exact target,
   upgrade kind, host/grant/epoch/generation, expiry and replay/fencing state.
   An ingress ID is a core-generated lifetime binding, not an enrollment identity.
   The connector publishes the new binding through its authenticated control
   handshake; it cannot reuse proofs from an earlier plugin instance.
4. Core validates the returned shape (nonempty IDs up to 128 UTF-8 bytes,
   recognized nonempty scope set, no extra fields), copies it, enforces policy and
   expiration, and compares `hostId` to the host **resolved from native auth**.
   Enrollment payload host equality alone is insufficient. Session operations
   retain native session/host/operation checks; a same-host grant does not
   authorize another host's session or circumvent session validity.
5. Core checks the current binding again immediately before native side effects
   and stream registration. A concurrent revoke/close wins over an in-flight
   verifier. Provider epoch/generation strings are opaque to core: the verifier
   checks which are current, core matches exact tuples and maintains revoke
   tombstones. These fields are not synthetic Connect identities.

### Policy `machine-v1`

Core owns a versioned, deny-by-default method/route/query policy. Derive it from
the [daemon contract][routes] and enforce it before application dispatch, not
only in plugin forwarding code. No wildcard `/internal/*`, `/api/v1/*`, implicit
HEAD, OPTIONS, method override, or redirect traversal. New native routes do not
silently join an existing policy. A route missing in a target release remains
unsupported even if listed here.

| Exact route shape | Method | Required scope and native checks |
| --- | --- | --- |
| `/install.sh`, `/install.ps1` | GET | Bootstrap; require `X-BB-Enrollment`, resolve valid pending/reconnect credential, compare host before rendering/repair; no credential-free script fallback through this ingress |
| `/install/version`, `/install/bb-app.tgz` | GET | Bootstrap or runtime; explicit **credential-free static-artifact exception**: access proof required, but these existing public bytes have no native principal. Never use these routes to return per-host material |
| `/internal/hosts/enroll` | POST | Bootstrap; native enrollment bearer, resolved reserved host = access host = payload host, before consuming enrollment/issuing daemon key |
| `/internal/session/open` | POST | Runtime; native daemon bearer host = access host, retain native protocol/version checks |
| `/internal/ws?sessionId=…` | GET + WebSocket | Runtime; native daemon bearer, required native daemon subprotocol, valid session whose host = daemon host = access host |
| `/internal/session/events`, `/internal/session/tool-call`, `/internal/session/interactive-request`, `/internal/session/interactive-request/interrupt` | POST | Runtime; native daemon bearer host equality and existing per-session/per-operation checks |
| `/internal/session/project-attachment-content` | GET | Runtime; same daemon and session checks; native query schema |
| `/internal/skills/tree/:hash`, `/internal/skills/tree/:hash/content`, `/internal/plugins/:pluginId/host/:digest` | GET | Runtime; daemon bearer host equality plus native artifact validation. Content route requires target-release support |

For reconnect installers, use the valid pre-issued native reconnect credential
and current idempotent access grant; **do not call implicit `serverAccess.repair`
from a machine-ingress installer request**. Repair would revoke the very stream
carrying replacement headers. Add an expected-host/current-grant mode to the
reconnect helper; keep existing non-ingress behavior separate. Rotation/recovery
from an expired or revoked grant requires explicit owner repair before issuing a
new enrollment command, not an exception allowing an old stream to survive revoke.
Test grant/epoch stability through this retrieval and owner-triggered repair.

The static exception does not weaken native authentication for installers,
enrollment, sessions, or runtime artifacts. The existing [installer][installer]
downloads the public archive using access headers rather than a daemon bearer;
requiring a new native archive credential would expand the bootstrap protocol.
Explicitly approve this narrow exception or leave archive/bootstrap blocked.

**Always deny:** enrollment-key minting, owner host create/delete/reconnect/admin,
settings, plugin RPC/CLI, project/thread management, browser `/ws`, terminal
sockets, server-move, health/app/static UI and every unlisted path/method. Machine
proofs and even a valid native machine credential cannot confer owner authority.

Raw-target policy precedes WHATWG/Hono normalization: accept only origin form;
reject absolute/network-path URLs, fragments, malformed escapes, encoded path
separators/backslashes, dot segments (including encoded variants), repeated path
separators, and noncanonical route parameters. Match path components once;
validate decoded parameter grammar against the native schemas. Use each route's
explicit query schema; reject unknown/duplicate security-sensitive keys, including
multiple session IDs. Query values such as attachment paths may contain legitimate
encodings: validate them using native rules, not a blanket ban on query escapes.
Test the raw listener, URL adapter, router and signature verifier as one boundary.
Reject malformed HTTP framing at the listener; do not buffer/reparse bodies to
make ambiguous requests acceptable. Gateway/relay must preserve the exact target
and reject cross-origin redirects rather than forwarding custom credentials.

### Bounds, WebSockets and lifecycle

Proposed fixed v1 defaults (not measured production limits): **2 seconds** per
verification, **8 KiB** assertion, **16 KiB** aggregate request headers, **32**
pending verifications and **64** active requests/streams per ingress. Native
route body limits still apply. Stream artifacts with backpressure, at most
**1 MiB** additional queued bytes per ingress; overflow cancels rather than
accumulating. Validate these defaults with the exact-release daemon before release.

- `open` resolves only after bind and lifecycle registration. Invalid policy or
  aborted lifetime rejects without a surviving listener. Bind failure leaves no
  handle. Returned operations are confined to that plugin/ingress, not global.
- Bound verifications with a core deadline even if the callback ignores abort;
  discard late results. Client disconnect, revoke, lifetime abort or disposal
  aborts pending work. Check abort both before and after awaited steps. A callback
  that blocks the JS event loop is outside this timeout guarantee; this is a
  trusted-plugin API, not a sandbox for hostile plugin code.
- `validUntil` must be finite, future and at most **60 seconds** ahead. Track HTTP
  streams and upgraded sockets by exact grant/epoch/generation. Expiry closes
  both even if the connection is still active. Fresh connections require fresh
  verification; there is no in-place WS reauthorization in v1. Native daemon
  reconnect behavior must pass the conformance suite; no request/body auto-replay.
- WebSocket upgrade retains immutable access identity **and** resolved native
  daemon/session identity for its lifetime. Messages cannot replace either.
  Strip trusted headers on upgrade just as on HTTP. Enforce native frame limits;
  authenticated transport is not an unbounded duplex SDK primitive.
- `revoke(tuple)` synchronously marks denial before awaiting cleanup, aborts all
  currently pending verifications (their tuples are not yet trusted), closes
  matching active HTTP bodies and WS, then resolves when local
  work/sockets are stopped. Repeat calls are safe. Other grants remain usable.
  Late verifier results for tombstoned tuples cannot resurrect access. Cap
  tombstones at **4096** per handle; on exhaustion close the ingress rather than
  evicting a denial. New ingress IDs prevent reuse after tombstones are discarded.
- `close()` is idempotent: stop accepts, abort verification and handlers, close
  keep-alive/active/upgraded sockets, invalidate the handle. Force-destroy sockets
  within **1 second**; resolve after local shutdown, not after cloud revoke or
  completion/rollback of a native operation already committed. Core disposal and
  server shutdown perform this even without a plugin cleanup hook.
- Successful plugin replacement closes old ingress handles before the replacement
  serves traffic. Failed replacement must preserve the old committed instance
  without leaking a new listener. Startup restores provider deny/revoke intent
  before opening. Reload is not global durable revocation of every machine;
  process crash cannot prove cloud revoke. Provider expiry/reconciliation remain
  required. Do not import persistent core principal contexts into a new instance.

Error contract: malformed input/framing is 400; missing/invalid proof or native
credential is 401; disallowed policy/host/scope is 403; capacity is 429;
verification exception/deadline is generic 503 with no verifier error text.
No WS upgrade occurs on failure. Diagnostics contain bounded reason codes and
request IDs, never credentials, raw query/session values, assertions or bodies.
Handle use after disposal rejects with a documented lifecycle error; revoke/close
on an already closed handle settle safely. Retry only a new authenticated attempt;
never replay a non-idempotent native operation after an ambiguous response.

### Capability and release gate

Check descriptor presence, `contractVersion === 1` and explicit `machine-v1`
support before opening. Absence/unknown versions mean unavailable, **never**
loopback/private-hook fallback. Opening rejects unsupported policy rather than
selecting a weaker one. Core and SDK ship the descriptor, enforcement, tests and
public documentation together; the package's minimum supported BB release is
assigned only after that release exists. Test packed public declarations/runtime
against that actual host, including absent-capability behavior on 0.46.1.
No speculative standalone adapter/API implementation is needed to approve this.

## Desired conformance matrix — not executed core tests

All cases below require a throwaway real-core server with synthetic enrollments,
daemon credentials and sessions, HTTP **and** raw WebSocket upgrade paths. Assert
both response/closure and absence of prohibited state changes. Include a passing
native enrollment, installer, session, HTTP artifact and WS exchange as controls.

| Case | Required outcome and test owner |
| --- | --- |
| Anonymous; access proof alone; native bearer alone | No credentialed route dispatch; missing independent auth fails. Cover direct private-listener requests and keep-alive reuse — core ingress/auth integration |
| Spoofed gate/forwarded/local-owner headers or cookies | Cannot affect principal or trusted address; no owner access on HTTP/WS — context + raw listener integration |
| Owner APIs and local key mint | Denied even with valid machine proof/bearer; no minted keys, hosts, settings or threads — real owner-route regression tests |
| Wrong BB host | Installer pending and reconnect, enrollment and runtime reject before repair/credential consumption/session creation — core auth + bootstrap integration |
| Wrong grant, revoked epoch, stale generation, wrong ingress audience | Provider verifier rejects; replayed/late verified tuple remains denied after core revoke; other grant unaffected — verifier driver + core race tests |
| Cross-session | Valid host-A bearer/proof cannot use host-B or invalid/expired session on upgrade, events, tool calls or attachments — native session integration |
| Installer leakage | Both platforms require matching enrollment identity; no credential-bearing cache/redirect/log output; archive stays credential-free; reconnect retrieval cannot rotate/revoke its response stream — installer + reconnect tests |
| Encoded path/parser ambiguity | Raw and parsed routing cannot disagree; alternate methods, normalization, query duplication and malformed framing denied before handler — raw socket/parser tests |
| Revoked active streams | HTTP upload/download, pending verify and upgraded WS close within bound; raced upgrade cannot survive; unrelated tuple works — core ingress lifecycle integration |
| Verifier null, malformed result, exception, timeout, late success | Fail closed, no unhandled rejection or principal, bounded concurrency/queue memory, no secret error text — ingress unit + real listener |
| Expiry, abort, reload, failed reload, disable/shutdown | No live stale handles/sockets, instance audience replay fails; failed replacement retains only committed instance; startup waits for recovery — plugin runtime + ingress integration |
| Exact native release compatibility | Linux/Windows install, archive integrity, reconnect repair/new epoch, daemon protocol/subprotocol, skill/plugin artifacts and session recovery pass without owner routes — exact-release end-to-end suite |

Phase 0 synthetic package tests exercise proof/reducer/probe behavior only. They
neither mount BB routes nor verify BB credentials. Public fake-host tests may
prove descriptor negotiation, plugin lifecycle calls and recorded revoke/close;
they must label those as simulated, not assert that the fake protects core.
Neither these future tests nor this design establish Vercel cloud conformance.

## Exact change surface requiring approval

Paths below are relative to the pinned **BB** repository, not files to edit in
this toolbelt task. Existing paths were checked against the immutable GitHub tree.
New paths are explicitly marked. No database migration or Connect change is
required for this minimal ingress: runtime associations and native identity
resolution use current state; provider recovery remains provider-owned.

| Area | Files and intended change |
| --- | --- |
| Public SDK | `packages/plugin-sdk/src/backend-contract.ts`: descriptor, types, callback/handle/error contracts; `src/index.ts` already re-exports this file, verify exports without adding a private entrypoint; `packages/plugin-sdk/package.json`: coordinated release version |
| Neutral core implementation (new) | `apps/server/src/services/machines/authenticated-ingress.ts`: listener, bounded verifier, lifecycle/stream registry; `apps/server/src/services/machines/machine-ingress-policy.ts`: explicit `machine-v1` route/method/query policy |
| Context and dispatch | `apps/server/src/request-context.ts`: private out-of-band principal lookup and forced-remote classification; `apps/server/src/server.ts`: construct manager, policy before dispatch, native HTTP/WS host comparison, installer checks; `apps/server/src/start-server.ts`: await manager shutdown alongside current tunnel/WebSocket shutdown |
| Native identities | `apps/server/src/internal/auth.ts`: shared access-host assertion after daemon verification; `apps/server/src/internal/hosts.ts`: enrollment host equality before consume/issue; `apps/server/src/ws/daemon-protocol.ts`: retain verified ingress/native/session binding |
| Bootstrap side effects | `apps/server/src/services/machines/enrollments.ts` and `apps/server/src/services/machines/reconnect.ts`: resolve/check credential host before pending bootstrap use; add machine-ingress current-grant retrieval without implicit repair; guard repeated/raced lookup before commit. `server.ts` installer response handling applies no-store/redaction |
| Plugin lifecycle/dependency wiring | `apps/server/src/services/plugins/plugin-api.ts`, `plugin-service-internal.ts`, `plugin-runtime.ts`: inject neutral manager, tie instance lifetime to handles, await shutdown/atomic replacement semantics; audit `plugin-service.ts` for shutdown propagation |
| Core tests | New `apps/server/test/services/machines/authenticated-ingress.test.ts`, `machine-ingress-policy.test.ts`; extend `apps/server/test/request-context.test.ts`, `machine-auth.test.ts`, `host-join-enroll.test.ts`, `services/machines/runtime-enrollments.test.ts`, `app/install-machine-script.test.ts`, `app/install-machine-windows.test.ts`, `services/plugins/plugin-sdk.test.ts`, `services/plugins/plugin-service.test.ts`; exercise native session handlers and real WS with `test/helpers/daemon-ws.ts` |
| Public harness | `packages/plugin-sdk/src/testing/fake-plugin-host.ts`, `testing/index.ts`, `testing/__tests__/fake-plugin-host.test.ts`: optional capability modes, deterministic verifier/revoke/disposal drivers, explicit non-auth fidelity; `src/__tests__/public-types.test.ts`, `bundled-types.test.ts`, `package-exports.test.ts`: public type/export/packed tests |
| Public docs and inventory | New `docs/machine-ingress.md`: authoritative contract/policy/limits; `docs/api_to_audit.md`: experimental entry; `plugins/plugin-api-docs/src/surfaces.ts`: ingress card/API symbols; its `test/surfaces.test.ts`: inventory coverage; `packages/plugin-sdk/README.md`: release/capability pointer |
| Agent-facing SDK references | `plugins/bb-guide/skills/bb-plugin-authoring/references/backend-foundation.md`, `backend-machines.md`, `backend-api-index.md`, `testing.md`: availability, boundary, symbols and harness limitations. These are future instruction-reference changes and need the repository's independent instruction review when implemented |

Existing native route handlers (`internal/session.ts`, `events.ts`, `tool-calls.ts`,
`interactive-requests.ts`, `skills.ts`, `plugin-host-artifacts.ts`) and
`packages/host-daemon-contract/src/session.ts` are **read/verify dependencies**,
not permission to weaken their auth or add routes. If a handler lacks native
session checks, fix it explicitly with tests before admitting it. Existing
`services/connect-next/tunnel-ingress.ts` and its tests stay unchanged; run them
as regressions to show the new boundary does not alter Connect behavior.

### Ordered minimal implementation after approval

1. Lock the v1 policy, native identity checkpoints, public types and fixed bounds.
   Add failing negative/positive real-core tests before wiring an ingress.
2. Implement neutral listener/context, verifier deadline/cancellation, tuple
   revocation/expiry and shutdown. Wire plugin-instance lifecycle. Prove direct
   loopback access to the private listener cannot confer local-owner authority.
3. Enforce native host equality on enrollment/runtime/WS and **before installer
   side effects**; separate reconnect retrieval from repair on machine ingress.
   Admit only the table's supported exact-release routes;
   retain original credentials and all native checks. Pass the complete matrix.
4. Add public harness/type/packed tests and docs/card/audit inventory. In a future
   approved BB task, run `pnpm install --frozen-lockfile` at its root; run declared
   `typecheck`, `test`, `build` in `apps/server` and `packages/plugin-sdk`, plus
   SDK `build:types`/pack checks and affected Plugin Guide/doc tests. Record actual
   commands/results, including Connect regressions; no pass is claimed here.
5. Ship a coordinated BB/SDK release. Pin toolbelt integration to that public
   release and capability; run exact-release bootstrap/runtime/revoke/disposal
   conformance in an isolated core fixture before any live BB forwarding.

## Subsequent proposals only

- **Per-machine access choice:** current [selection][access] uses the saved host
  provider or global default (otherwise first registered/direct), not an explicit
  create-time per-machine selector. Propose a public create/enrollment option
  persisted before acquisition, discoverable availability UI/CLI, and explicit
  repair/migration semantics. Never switch daily defaults merely to test one
  Vercel machine. This is orthogonal to inbound authentication and is not needed
  to implement/test the ingress boundary.
- **Native preview provider:** `hosts.ensureSharedPortTunnel`/`declareSharedPorts`
  in the [backend contract][backend] use trusted Connect identity. A separate
  provider contract should resolve an owned host/port to a scoped URL, expire and
  revoke shares/streams, advertise availability and define lifecycle. Worker
  preview bytes must go gateway → worker, not through the laptop. A plugin-owned
  URL can be investigated separately; it is not native BB shared-port support.
- **Owner browser ingress:** separate principal/session, login/logout, CSRF/Origin,
  cookie policy and owner-route review. Never add an owner scope to machine-v1.

## Verification performed for this design

Read-only `gh api` resolved main and fetched the pinned source/tree; all 16 linked
source paths exist at that commit and all 18 Markdown reference labels resolve.
The public 0.6.94 tarball matches its registry SHA-512 integrity. No core/harness
conformance test was run: those tests require the unapproved implementation.
This documentation-only task needs no package install, build or plugin smoke.
`git diff --cached --check` passed; the complete document/staged diff was reviewed
for scope, secrets/private material and unsupported claims. Parent receives the
commit and clean-worktree evidence separately. The canonical checkout's unrelated
`scripts/bb-plugin-smoke` deletion remains untouched.

## Approval request and handoff

**Tom's blocking decision:** approve implementing the machine-only public SDK and
BB-core surface above in a separate isolated BB task, including the explicit
static-artifact exception, fixed v1 bounds/60-second stream lease, native-host
checks before bootstrap side effects, reconnect retrieval without implicit repair,
core conformance tests and coordinated release. This is **not** approval for
owner/browser access, preview providers, selection changes, cloud allocation/
deployment, upstream requests, or real traffic.
If the lease conflicts with native daemon recovery, revise the bounded lease
contract and obtain approval before broadening behavior; do not remove expiry.

This toolbelt task contains only this document. No BB files, settings, installed
plugins, Phase 0 files or wishlist entries were edited. Parent owns integration,
push, deploy and task cleanup. Phase 0 owns `docs/bb-sdk-wishlist.md`; suggested
refinement is a link here plus the reconnect/host checks, tuple revoke/expiry and
capability/release gates, not another concurrent wishlist edit. Independent
transport work may continue against its harmless fixture; real BB ingress stays
blocked until approval, implementation, release and exact-release conformance.

[revision]: https://github.com/get-bb/bb/commit/bec24f2f8d6da1877863dfa9155cf3867ea1ab18
[backend]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/packages/plugin-sdk/src/backend-contract.ts
[context]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/request-context.ts
[hosts]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/internal/hosts.ts
[connect]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/services/connect-next/tunnel-ingress.ts
[auth]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/internal/auth.ts
[daemon-ws]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/ws/daemon-protocol.ts
[session]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/internal/session.ts
[server]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/server.ts
[enrollments]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/services/machines/enrollments.ts
[reconnect]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/services/machines/reconnect.ts
[access]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/services/machines/server-access.ts
[proxy]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/host-daemon/src/machine-auth-proxy.ts
[harness]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/packages/plugin-sdk/src/testing/fake-plugin-host.ts
[sdk-package]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/packages/plugin-sdk/package.json
[npm94]: https://www.npmjs.com/package/@get-bb/plugin-sdk/v/0.6.94
[routes]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/packages/host-daemon-contract/src/session.ts
[installer]: https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/assets/install-machine.sh
