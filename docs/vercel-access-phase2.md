# Vercel Access Phase 2: plugin-only native machine boundary

## Decision and status

**A new core principal API is not required for this narrower machine-only connection path.** The implementation is a disabled-by-default [plugin prototype](../bb-plugin-vercel-access/README.md), using released public SDK 0.6.59 and existing BB 0.46.1 machine authentication. It has locally exercised real native enrollment/session traffic over an actual outbound standard SSH-over-WebSocket transport.

This supersedes the project-wide impossibility interpretation of Phase 0/1's core-principal proposal. Those reports tested a different architecture and the foundation remains fixture-only. The old [SDK contract](vercel-access-sdk-contract.md) is a rejected implementation direction, not a dependency or authorization. No BB/SDK source changes, private APIs, fabricated gate/Connect identities, hosted BB services, or upstream requests are part of Phase 2.

The [runtime review follow-up](vercel-access-phase2-runtime-followup.md) records the current pending-operation bounds, >15-second and observed >120-second HTTP evidence, released built-in artifact parity, peer-loss cleanup and cold-build isolation.

**Not a cloud-ready machine MVP.** Persistent admission/reconfiguration, real Vercel provisioning/network behavior, and independent final review remain gates. The parent owns integration, approval, deployment, push, and cleanup. No daily activation or cloud allocation/deployment/login/spend occurred.

## Alternatives considered

| Candidate | Evidence and disposition |
| --- | --- |
| Exact machine HTTP/WS bridge plus native BB credentials | **Selected.** Public `server.loopbackBaseUrl` explicitly supports plugin tunnels. Released core authenticates enrollment and daemon routes. Exact dispatch isolation can exclude all owner/local-only handlers without injecting a new core identity. Real-core tests, not transport success alone, exercise this boundary |
| Per-host transport-to-native credential binding | Not required for the selected contract. Bootstrap stdin could provide initial trusted host/credential correlation, but a second credential/session lifecycle would need separate crash/reconnect review. No native-auth database or speculative principal binding is implemented |
| Standard SSH over WS, locally confined reverse channels | **Selected transport.** Pinned `ssh2` 1.17.0 plus `ws` 8.22.0. Both upstream library bookkeeping and local glue restrict forwarded channels; local `net.connect` always targets the one literal bridge port. Hostile-relay canary and concurrency tests verify local confinement |
| Standard wstunnel reverse forwarding | **Rejected after pinned source inspection.** [Reverse client](https://github.com/erebe/wstunnel/blob/v11.1.0/wstunnel/src/tunnel/client/client.rs) reads a relay response cookie as a destination; [TCP connector](https://github.com/erebe/wstunnel/blob/v11.1.0/wstunnel/src/tunnel/upstream_connectors/tcp.rs) lets that override its local configured host/port. Server restriction files and TLS authentication do not confine a compromised relay. No wstunnel connector is shipped |
| OpenSSH/socket/network enclave | A fixed OpenSSH reverse forward is plausible, but adds executable/sshd deployment requirements. The supported ssh2 stream/socket APIs provide standard SSH with an explicit tested local destination boundary, without a host-global sshd or general network enclave |
| Separate BB coordinator in a sandbox | Not selected. It adds another authority/database and unsolved user-state synchronization without reducing this machine-route bridge's trust requirements. No BB state is copied or synchronized |
| Native Vercel SDK/exec as byte transport | Bounded authenticated management RPC is suitable for future prepare/inspect/stop operations, not sustained byte tunneling. Existing host RPC buffers results. Public exposed-port WS is a cloud hypothesis, not established by SDK exec availability |
| Expanding Phase 1 bespoke framing | Not selected. Its fixed fixture and 92-test baseline stay separate. Standard SSH supplies mature authenticated framing, flow control and channel lifetime; Phase 2 adds only confinement and exact native dispatch |

The pinned ssh2 implementation also [stores successful reverse registrations](https://github.com/mscdex/ssh2/blob/844f1edfc41589737671f96a4f4e76afdf46abd4/lib/client.js#L1334-L1366) and [rejects unregistered channel tuples and unrelated channel types](https://github.com/mscdex/ssh2/blob/844f1edfc41589737671f96a4f4e76afdf46abd4/lib/client.js#L1978-L2027). The plugin rechecks the tuple and hardcodes the local destination independently; this library evidence does not replace the malicious-peer tests.

## Exact trust boundary

```text
worker -> dedicated relay HTTP/WS adapter -> private relay reverse listener
                                                   |
                                       authenticated SSH over WS
                                                   ^ outbound
                                       laptop connector -> machine bridge
                                                                  |
                                                      BB native machine routes
```

**Core owns application authentication.** Enrollment checks the bearer and payload host; daemon HTTP verifies the native host key; session open checks the native authenticated host; WS checks native bearer, protocol and session ownership. Session events/attachment operations check native session ownership. Native key revocation still rejects new traffic. These are existing core behaviors, exercised against released binaries. Machine artifacts and the rich native daemon WS remain native machine authority, not owner authority or per-thread artifact secrecy.

**The plugin owns network admission and dispatch isolation.** A random 24-hour `x-vercel-access` lease is required at the laptop bridge. It is installation-level admission, not proof that the native host matches its acquisition metadata. Admission A with valid native key B acts as B; tests deliberately prove this. Revoking A cannot ban host A from borrowing B's admission. Native host revocation must remain native core policy. This explicit relaxation removes a speculative property; it does not pretend to preserve cross-credential host equality.

Core sees a loopback socket. Therefore the exact raw path/method/upgrade allowlist is a security boundary, not just a convenience router. Owner APIs, browser/terminal WS, enrollment-key minting, all server-move HTTP routes, credentialed installer lookup/reconnect, cookies, Origin and caller authority headers are denied before any upstream request. No broad `/internal/*`, `/api/*`, whole-server proxy, destination parameter, private context injection, or Connect gate metadata exists.

The relay adapter pins public authority, removes only explicitly reviewed platform metadata, and rebuilds Host for the bridge. The bridge rebuilds Host for core and forwards only selected native headers, retaining opaque native Authorization while removing admission/control/authority metadata. Duplicate headers, request smuggling ambiguities, noncanonical path aliases, malformed framing, absolute targets and unlisted upgrades fail closed. POSTs are completely staged within a cap before native dispatch. Native WS authentication completes before a downstream 101. Conditional archive 304 is supported without following redirects. See the README for the complete route list and bounds.

**A compromised relay cannot choose a local destination.** SSH incoming channel tuples must match the registered loopback reverse listener, concurrency is checked before dialing, and local `net.connect` uses only the actual bridge port supplied locally. Remote origin/destination metadata never selects a local socket. Disposal destroys local sockets; new SSH sessions have separate state. Public control upgrades need SSH authentication with a dedicated client key and a trusted provisioned host-key pin; admission tokens alone cannot register a connector. Signature verification accepts only literal `true`, rejecting false, returned errors, and thrown errors. Unauthenticated control lifetime and socket counts are bounded.

The relay remains trusted for **payload confidentiality**: it can see/modify native traffic and steal credentials transiting it. SSH ends there; neither encryption from cloud compute nor origin authentication by a hosted BB service is claimed. Even a malicious authenticated relay remains confined to the machine bridge, whose allowlist and native credentials still exclude owner behavior. Vercel API/OAuth credentials must stay on the existing auth machine; future provisioning may return only bounded relay metadata/public pins and distinct connector material.

## Local evidence

Environment: BB **0.46.1**, public SDK **0.6.59**, protocol **244**, Node **24.22.1**. Exact release/protocol conformance is checked at bridge startup; untested versions refuse rather than fall back to a private API. No daily credentials or user database were used.

| Verification | Result |
| --- | --- |
| `npm ci`, `npm run typecheck`, `npm run build` | PASS |
| `npm test` | PASS; 86 tests |
| `npm run test:slow` | PASS; both paths complete observed 125-second responses |
| `npm run test:build` | PASS; cold isolated build and SDK-free minimal standalone relay launch |
| `npm run test:core` | PASS; five real-core scenarios |
| `bb plugin types --check` | PASS; pin and installed SDK both 0.6.59 |
| Throwaway repository activation smoke | PASS; plugin running, disabled by default |
| `npm audit` | PASS; zero vulnerabilities |
| Public SDK scanner | PASS; no private dependencies/import violations |
| Unchanged foundation scripts / tests | PASS; 92 fixture-only baseline tests |

The package's npm configuration excludes optional native acceleration/install scripts so ssh2 bundles through BB's public plugin builder using its supported JavaScript/Node-crypto path. Test-only SDK peers are dev dependencies. The declared build launcher and isolated test CLI run outside the package directory with sanitized temporary HOME/XDG/npm/BB-data contexts so these flags do not break BB's own esbuild installation. The build regression verifies a cold toolchain, not just a warm cache. Existing user npm configuration is unchanged.

Executed evidence includes:

- Separate throwaway released core processes with wholly temporary HOME/XDG/npm/data, no inherited account environment, and harmless synthetic workspaces
- Initial generic installer and real packaged archive download with SHA-256 verification and native `If-None-Match`/304 behavior; enabled `bb--storage-retention` host-artifact parity (200 / identical 242,309 bytes), with native-auth and encoded-alias denial preserved
- Native enrollment, default Node fetch session open, default `ws` compression offer without negotiated compression, events, native daemon WS heartbeat, wrong-host key/session/attachment/WS denial, and native revoked-key rejection on new requests
- Those native checks both directly through the bridge and through the outbound SSH/WS relay; the public machine bootstrap helper also completes in both modes with an isolated synthetic executor and explicitly selected test provider
- **Actual released `bb-app host-daemon` foreground process** enrolling and connecting over the SSH/WS chain, then disconnecting on transport revoke; temporary HOME/XDG/data, no auto-update, OS service, supervision, CLI installation, or agent execution
- Zero native dispatch for owner/local-only/unlisted/ambiguous routes and forged headers; direct-origin and wrong-role denial; malformed/truncated HTTP framing; oversize WS messages; canonical raw query checks
- Hostile SSH relay attempts against harmless canary sockets, registered-tuple/source substitution, wrong pin/key, and the 16-channel bound enforced before dialing; disposal closes the confined local sockets. Malformed/oversize unauthenticated control traffic, the four-socket admission cap and pre-aborted connector also fail closed
- Cancellation stops the native HTTP producer; transport release/expiry closes active WS; legal client/native close metadata survives. Both direct/SSH responses complete after 18.5 and 125 seconds, incomplete bodies remain bounded near 15 seconds with no native dispatch, and independent revoke/cancel preserves a sibling response and connector
- No synthetic enrollment, admission, native or SSH credential in the exercised diagnostic/redacted-settings surfaces

The standalone relay also starts from a minimal production-only source package with the SDK and plugin-server entry absent; the [README](../bb-plugin-vercel-access/README.md#relay-source-artifact-not-a-deployment) pins the launch command, exact control/data URLs and separate management/packaging responsibilities. This does not turn the plugin-server build into a relay deployment bundle or implement vendor provisioning RPC.

The actual installer shell and OS-service lifecycle are **not executed**. The released daemon test loads the installed app's dependencies; it does not prove an extracted worker tarball is self-contained or independently hydrated. Public bootstrap uses a synthetic executor; the separate real daemon test is not evidence of installer execution. Local relay/connector components use real sockets; most share the test process. Core, the released daemon and the standalone-relay SIGTERM smokes also use separate OS processes. The shutdown smoke uses the relay's intended public bind with only synthetic keys and a harmless fixed backend; no real BB server or user data is exposed by it. Local WS/SSH success is not Vercel WSS/TLS or vendor ingress evidence.

## Lifecycle and intentional limits

Leases are bounded, random, process/factory-lifetime state. Release/expiry denies new requests and closes matching active sockets. Null-ID release conservatively revokes its matching acquisition; stale explicit grant IDs do not revoke a replacement. Transient connector retries retain leases within the same factory and reuse the same pinned relay/origin. Application requests are not replayed; the native daemon reconnects using its protocol.

Plugin/server restart or settings changes invalidate old admission credentials. Existing-worker header reconfiguration and durable lease/renewal are unimplemented. Core's enrolled bootstrap branch only starts its installed worker and does not automatically deliver new headers; the credentialed reconnect installer is deliberately denied. **Ordinary access repair is not proven recovery.** This is fresh-bootstrap/bounded-session connectivity, not a persistent-worker service. Durable plugin-owned leases or a supported demonstrated worker reconfiguration procedure are a subsequent local gate; no core change is prescribed.

## Review disposition and remaining gates

Parent-arranged checkpoint reviews found and prompted fixes for native fetch/ws metadata, archive conditional requests, explicit isolated default-provider selection, WS close fidelity, inherited HOME/XDG, exact-true signature verification, and overly short async-operation timeouts. The [runtime follow-up](vercel-access-phase2-runtime-followup.md) additionally closes the residual incoming 15-second timeout, reserved built-in ID grammar, standalone peer-loss settlement, cold-build policy leak and pending-open lifetime findings with focused evidence. Checkpoint review is not final approval of subsequent changes; the parent owns a fresh final diff review, especially SSH control lifetime/confinement and relay parser behavior.

Before any real use:

1. **Local product gate:** independently review the final code, preserve supported version refusal, and implement/test durable admission plus existing-worker reconfiguration/expiry recovery before claiming persistent-machine readiness. Full installer/service behavior remains a distinct verification item
2. **Approval gate:** obtain explicit bounded Vercel allocation/deployment/spend approval. Source artifact `relay-main.ts` is written but not deployed. Keep provisioning on the authenticated vendor machine via bounded prepare/inspect/stop RPC; never move Vercel credentials to the laptop connector
3. **Cloud gate:** approved isolated synthetic BB/worker only; prove one exposed adapter port and reserved control WS path, TLS/WSS/binary/upgrade/header fidelity, direct-origin denial, exact platform metadata, interruption/reconnect and duration limits, plan/cost bounds, pin/key provisioning and cleanup. Relay replacement/URL change, durability and operational recovery require explicit evidence. Do not infer them from this local prototype

Preview work may proceed as a **separate worker-origin scoped share adapter** once its own authorization/lifecycle contract is reviewed. It must not add preview routes to this bridge or route preview bytes through the laptop. Browser/owner access is also separate; neither follows from native machine traffic succeeding.
