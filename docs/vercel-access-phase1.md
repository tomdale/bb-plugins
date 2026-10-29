# Vercel Access Phase 1: local outbound fixture transport

## Result and gates

**Implemented and locally exercised; not a deployable or secure BB replacement.**

| Boundary | Evidence / status |
| --- | --- |
| Independent outbound connector, dedicated relay, gateway | Actual loopback WebSockets and HTTP; PASS locally |
| Signed role/stream/body binding and negative cases | Relay and laptop independently reject; PASS locally |
| Bounded streaming, concurrency, cancellation, HTTP/WS | Binary fidelity, credit barriers, cap exhaustion and cleanup; PASS locally |
| Local persisted grant/revoke/fencing and recovery | Explicit fault boundaries, private files and deterministic clocks; PASS locally |
| Multi-process/cloud discovery, CAS and credential lifecycle | NOT IMPLEMENTED; single local serialized controller only |
| WSS, cloud gateway routing and vendor maximum duration | **NOT EXECUTED** |
| Real BB machine or owner traffic | **BLOCKED**; no real BB destination exists |
| Browser owner access, native preview-provider sharing | Out of scope; separate authorization contracts required |

No cloud allocation, deployment, login, live plugin/settings change, server move,
BB source change, upstream request or daily-app reload was performed. No BB,
LAN or arbitrary external destination option exists. Phase 0's complete scope
and hard gates remain in [the Phase 0 report](vercel-access-phase0.md).

## Implementation and signed body semantics

The [package README](../vercel-access-foundation/README.md) documents exact
permitted routes, limits and component ownership. The transport uses maintained
`ws` 8.22.0 and Node Ed25519 signatures, not a custom cryptographic primitive.
The topology is actual gateway → relay ← outbound connector. Each gateway
connects independently to the dedicated relay; no gateway dials the laptop or
pairs unrelated Function sockets through shared process memory. Local tests
run the separable components in one Node test process with real sockets;
independent OS-process behavior is not established.

A version-1 relay challenge/role proof/ready exchange binds installation, relay,
generation, fresh connection epoch and current connector epoch. Separate keys
serve gateway, connector/control and relay roles; a machine token cannot sign
control messages. The gateway authenticates the dedicated machine access header.
Relay and connector independently enforce signed opens and every signed data,
credit, start, end and cancellation frame. Relay preserves the original signed
envelope rather than creating a trusted-origin header.

Open binds both endpoint epochs and unique stream ID, grant/host/acquisition
epoch, `transport:probe` scope, exact method/target/mode, assertion lifetime,
body mode and declared length. `signed-ordered-v1` means **every chunk is
signed with its exact bytes, sequence and stream binding**; end binds count and
close metadata. HTTP requires the complete count to equal the declared length.
This does not reuse Phase 0's empty-GET `signProbe` or claim that an empty digest
authenticates streamed POST. Mutation executes only after valid completion.
The synthetic echo stages a capped body before replying; it does not model
incremental arbitrary-upstream side effects.

The socket-free fixture accepts only `/v0/probe` and the narrowly named synthetic
bytes/hold/echo/mutate/ws endpoints listed in the README. It cannot accept a
machine token directly or dial a destination. All BB and owner paths remain
denied, including credentialed machine paths from the Phase 0 inventory. No
trusted BB headers are accepted or emitted; native BB Authorization is neither
interpreted nor forwarded. Probe authority is not native machine/owner authority.

HTTP request/response bytes travel as credited chunks; client HTTP drain and WS
send callbacks control credit return. WebSocket upgrade preserves the fixed
`fixture.v1` protocol, text/binary flag and close code/reason in both directions.
Frames are 64 KiB maximum, data 16 KiB, each connection queue 1 MiB, each direction
1 MiB per stream, with 16 active streams and one unacknowledged chunk per direction.
Replay/tombstone storage caps at 4096 and fails closed. Socket admission and WS
fragment/chunk counts are capped. These bound application state, not total RSS
or kernel buffers. HTTP fixture staging can consume up to 16 MiB across streams,
plus separately bounded output and transport buffers.

Terminal cleanup rejects and removes pending credits, settles producers, and
releases stream maps. Bounded tombstones discard late signed frames without
reopening streams or failing siblings. This is essential: a cancelled consumer
must not leave its response producer suspended outside the active-stream budget.

## Local recovery model

The new `Authority` is distinct from Phase 0's one-epoch reducer. It serializes
acquire/release/recover, persists pending identity and generated credential
before issuance, retries within one epoch with stable identity, saves revoke
intent before remote cleanup, and retains revoked tombstones. Explicit caller
acquisition epoch fences delayed null-grant-ID release across same-key repair.
This additional caller context is **not provided automatically by the BB SDK**;
this package is not a serverAccess adapter.

`FilePersistence` and `FileFenceStorage` perform mode-0600 atomic replacement,
file/directory fsync and size checks. Reconstructed controllers replay pending
issuance/idempotent revoke, and recover before becoming available. Relay boot,
generation and connector epoch are committed before readiness. Registration
fences the old connector and closes its active streams. New connection epochs
invalidate old stream assertions after replay-cache loss. Lease expiry and
laptop-local revoke close active HTTP and WS even with stale remote replicas.
Revoke/expiry conservatively close the whole session, including sibling streams;
stream-local cancellation preserves siblings.

These are **one-writer local adapters**. There is no multi-process lock, cloud
CAS, durable distributed replay cache, key vault, lease-renewal service, remote
authorization replication or production credential provisioning/rotation. A
holder of the still-current connector control key can register a fresh session;
stronger stale-process admission requires a reviewed production controller and
key rotation. File-backed generation persistence is not distributed fencing.

Heartbeat uses WS ping/pong at 15 seconds with a 45-second missing-pong timeout;
handshake expiry is independently 15 seconds. Reconnect is abortable with bounded
1–30-second jitter. Reconnect reestablishes only transport, never reissues opens
or mutations. Tests cover both partial POST interruption and uncertain response
after a committed synthetic mutation. That proves absence of automatic replay,
not durable exactly-once business semantics. The harmless counter is in memory.

## Executed verification

Task created from canonical HEAD with `wf task new --force`, then fast-forwarded
to dependency `7738fcaa80eedd71ac232643e111885a6f8c0bd6` on the Phase 1 branch:

```text
Task:   /Users/tomdale/Code/Repos/toolbelt/_tasks/main/vercel-access-phase1
Branch: tomdale/vercel-access-phase1
Base:   7738fcaa80eedd71ac232643e111885a6f8c0bd6
```

The canonical checkout's unrelated deletion of `scripts/bb-plugin-smoke` was left
untouched. Parent owns final integration, deployment, push and task cleanup.
This independent package is not a BB plugin, so plugin activation smoke does not
apply and must not be substituted with a live task-path installation.

Executed from `vercel-access-foundation/`, Node v25.9.0 and npm 11.10.0:

| Command | Result |
| --- | --- |
| `npm ci` | PASS; lockfile install, zero audit findings |
| `npm run typecheck` | PASS |
| `npm test` | PASS; 82 tests including 10 unchanged Phase 0 tests |
| `npm run build` | PASS |
| `npm audit` | PASS; zero vulnerabilities |
| `git diff --check` and scoped secret/diff review | PASS; generated credentials only, no live/private material |

The first selected older `ws` release had published advisories; it was replaced
with pinned 8.22.0 before verification. `@types/ws` 8.18.2 exposes the fragment and
buffered-chunk caps used here. npm prints the existing user `tokenHelper` warning;
no user configuration was changed. Tests compile to ignored `dist/` before Node
runs them; source-level parameter properties require TypeScript compilation.

### Evidence exercised

- Binary POST echo, 512 KiB streamed response, concurrent independent gateways,
  text/binary WS echo, exact client→fixture and fixture→client close metadata
- Anonymous/wrong machine tokens, forged BB/browser/forwarded headers, Host,
  method/target ambiguity, control-vs-gateway signer, identity/generation,
  host/grant/acquisition epoch, expiry/lifetime, scope and direct relay origin
- Independent laptop rejection with relay forwarding checks deliberately
  bypassed, including foreign authority signatures, BB paths and replay
- Malformed/oversized frames, fragments, data chunks, body substitution,
  truncated POST, declared length, sequence, role/direction and replay exhaustion
- Actual 16-stream admission exhaustion, 1 MiB receive-queue exhaustion behind
  an explicit barrier, one-chunk credit stall and resume with exact response bytes
- Incremental first HTTP bytes while the producer awaits credit; 17 successive
  ACK-withheld cancellations settle credits/producers/maps, with sibling grant
  probes succeeding on the same session
- Six acquisition/release interruption boundaries, serialized recovery, failed
  save preventing issuance, pending expiry, same-key repair, delayed null-ID
  release, remote-revoke outage and private-file reconstruction/fencing
- Active HTTP/WS local revoke and expiry, stale connector replacement, stale
  relay generation/origin, missing pong, handshake deadline and explicit
  reconnect scheduling without partial or committed mutation replay

Faults use generated in-memory keys, private temporary files, explicit promise
barriers and injected clocks/schedulers. Replay-capacity saturation is seeded
at its boundary; queue and active-stream exhaustion traverse real components.
Tests close listeners/sockets and stop timers; completion requires no forced
process exit. No real application credentials or user data are fixture payloads.

Independent checkpoint reviews were arranged by the parent. One found retained
credit waiters on cancellation; centralized terminal cleanup and the 17-cycle
regression address it. Checkpoint review is not a release/security approval;
parent must reconcile its full findings against the final commit.

## Phase 2 reuse and blocked evidence

Reuse the separable connection/ledger/session components, explicit fixture route
boundary, signed body contract, local journal interfaces and negative/fault test
patterns. Keep original probe verifier and one-epoch reducer semantics intact.
Do not reuse the local fence as cloud CAS, in-memory replicas as revoke
propagation, plaintext local ws as WSS evidence, fixture mutation as application
exactly-once, or gateway token authentication as native BB authority.

A later approved cloud experiment must establish WSS, actual gateway-to-sandbox
routing/upgrade/header fidelity, Function independence and vendor max duration,
provider plan limits/cost, cloud discovery/fencing, key management, cleanup and
preview traffic that never transits the laptop. **All remain NOT EXECUTED.**

Real BB integration additionally requires a released, supported and tested
provider-neutral machine ingress, exact-release conformance and enforced
host/scope/native credential binding. No private SDK hook, private BB import,
synthetic trusted header, fake Connect identity or ordinary loopback forwarding
is an acceptable substitute. No new SDK evidence or proposal changes were made
in this phase; the parent/SDK workstream retains those responsibilities.
