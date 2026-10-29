# Vercel Access local transport foundation

A **local-only, fixture-only** outbound WebSocket transport and authorization
conformance package. It is not a BB plugin, server-access provider, authenticated
BB ingress, cloud deployment, or secure BB replacement. There is no BB, LAN,
arbitrary URL, TCP, filesystem, or external-service destination option.

## Verify

Requires Node 22.18 or newer and npm. Tests compile TypeScript before execution.

```sh
cd vercel-access-foundation
npm ci
npm run typecheck
npm test
npm run build
```

Tests generate Ed25519 keys and grant tokens in memory. Persistence tests use
private temporary directories, delete them afterward, and never use real
credentials. All network listeners bind ephemeral `127.0.0.1` ports. Tests use
`node:http`, not browser-oriented `fetch`, to avoid adding Fetch Metadata headers
that this machine-only fixture rejects. `ws` is the standard WebSocket transport;
compression is disabled and payload, fragmentation and chunk limits are set.

## Components and boundaries

```text
synthetic machine HTTP/WS -> Gateway -> dedicated Relay <- outbound Connector
                                                               |
                                                        SyntheticFixture
```

- `transport/gateway.ts`: local HTTP/WS gateway, access-token authentication,
  exact Host/target validation, signed stream creation and client backpressure
- `transport/relay.ts`: independent relay listener and dedicated rendezvous;
  challenge/proof role authentication, current generation/connector fencing,
  bounded stream routing, direct-origin denial
- `transport/connector.ts`: initiates an actual outbound WebSocket; fresh epoch
  on reconnect, bounded jittered retries, no request replay
- `transport/fixture.ts`: fixed, socket-free synthetic destination; **no listener
  or configurable upstream** exists to expose directly or replace with BB
- `transport/protocol.ts`, `ledger.ts`, `wire.ts`, `session.ts`: strict versioned
  signed framing, ordered per-direction credit, caps, cancellation and heartbeat
- `transport/authority.ts`, `persistence.ts`: serialized local grant controller,
  journaled intents/tombstones, acquisition epochs and atomic private-file writes

Each gateway owns its own relay connection. Gateways never dial the connector,
communicate with each other, or use Function-local shared memory to rendezvous.
Only the dedicated relay holds routing state. Tests instantiate independent
relay/connector authorization copies; laptop-local denial remains authoritative
when the gateway/relay copies are stale. Components are library classes with
explicit lifecycle methods, not a deployed daemon or CLI.

### Permitted synthetic routes

| Method | Exact target | Behavior |
| --- | --- | --- |
| GET | `/v0/probe` | Fixed synthetic text; empty request body |
| GET | `/v1/fixture/bytes` | 512 KiB of fixed binary data in credited chunks |
| GET | `/v1/fixture/hold` | Hold response open for cancellation/revoke tests |
| POST | `/v1/fixture/echo` | Stage a bounded request, then echo binary chunks |
| POST | `/v1/fixture/mutate` | Increment an in-memory synthetic counter after complete request |
| GET upgrade | `/v1/fixture/ws` | Text/binary echo with `fixture.v1` subprotocol |

No query strings, encoded aliases, redirects, absolute targets, extra methods,
BB routes or destination selectors are permitted. POST requires Content-Length.
HTTP response metadata is fixed to status 200, octet-stream and no-store; it is
not a general HTTP-header forwarding implementation. `Authorization` is neither
interpreted nor forwarded to the fixture. `x-fixture-access` is the distinct
machine credential. Trusted BB headers, cookies, Origin and forwarded/browser
headers are rejected, not promoted into authority.

## Version 1 stream contract

This protocol does **not** reuse `signProbe` for bodies. A relay-signed fresh
challenge is answered with a role-specific Ed25519 proof bound to installation,
relay generation and a fresh client connection epoch. Ready binds that proof
to the current connector epoch. Connector/control and gateway signing keys are
separate from each other, the relay key, and machine access tokens.

Every stream frame is independently Ed25519-signed by its originating endpoint;
the relay preserves that envelope. Relay and laptop independently validate it.
Open binds installation/relay/generation, both endpoint epochs, unique stream ID,
grant/host/acquisition epoch, `transport:probe` scope, exact method/target/mode,
15-second assertion lifetime, declared length and `signed-ordered-v1` body mode.
Data signatures bind the same stream and epochs, sequence number, bytes and
binary/text flag. End binds byte count and WebSocket close code/reason. There
is no unsigned-body mode or implicit body-hash assumption.

For HTTP the complete received byte count must equal the signed declared length.
The echo fixture stages at most 1 MiB before responding; mutate executes only
after a valid end. This is bounded staging, **not** a claim of incremental
non-idempotent upstream execution. WebSocket messages are limited to one 16 KiB
data frame; text is validated as UTF-8. Both directions transport close codes
and reasons. Cancellation releases credits, producers and maps; terminal
stream tombstones discard late signed frames without recreating stream state.

### Resource bounds

| Resource | Bound |
| --- | --- |
| Wire message / signed open | 64 KiB / 8 KiB |
| Data chunk / WebSocket message | 16 KiB |
| Inbound queued frames / socket send buffer admission | 1 MiB per connection |
| Active streams | 16 per endpoint session and globally at relay |
| Body/response or cumulative WebSocket data | 1 MiB per direction per stream |
| Unacknowledged data | One chunk per direction per stream |
| Replay tombstones | 4096 per connection epoch; exhaustion fails closed |
| Local grant history / journal file | 512 records / 1 MiB; no silent tombstone eviction |
| Accepted sockets | 32 per listener; 16 client WebSockets per gateway |
| Handshake/open TTL | 15 seconds |
| Heartbeat / missing-pong timeout | 15 / 45 seconds |
| Connector reconnect delay | Jittered 1–30 seconds, abortable |

Credits return only after downstream consumption: HTTP drain or WebSocket send
callback at the gateway, bounded staging at the HTTP fixture, and consumed echo
at the WS fixture. A callback means accepted by the local socket, not remote
application receipt. Kernel/library buffers are additional to application caps;
these are not whole-process RSS guarantees. The relay has no application body
buffer. HTTP staging and fixed fixture response buffers are separately bounded
by active stream and byte caps.

## Recovery model and remaining gates

The local controller saves pending grant identity **and generated credential**
before invoking issuance; an idempotent adapter must return the same credential
within that epoch. It records revoke intent before remote cleanup, denies
locally and closes active sessions. This implementation uses coarse session
closure on revoke/expiry, so sibling streams may also disconnect. Stream-local
cancellation does not close siblings. Repair retains the tombstone and creates
a new acquisition epoch. Release explicitly requires the caller's epoch even
when grant ID is null, preventing a delayed old release from revoking a repair.
This is **not** a direct implementation of the SDK release callback.

`FilePersistence` and `FileFenceStorage` use mode-0600 atomic replacement and
file/directory fsync. One serialized local controller owns each store; no
multi-process locking, distributed CAS, key vault, cloud discovery or remote
revocation replication is supplied. Relay boot/generation and connector epoch
are saved before readiness. New authorized connector registration fences the
old socket and its streams. A holder of the still-current control signing key
can register anew; production control-key rotation and stale-process admission
require a separate reviewed controller. Restart changes connection epochs, so
old signed stream traffic cannot be replayed after replay-cache loss.

The connector reconnect loop establishes only a new transport session. It
never reissues HTTP or WS opens or mutations, including an uncertain response
after a committed synthetic mutation. The fixture counter survives reconnects
of one Connector instance only; no durable application exactly-once guarantee
is implied. Lease renewal, multi-instance controller safety and production
credential provisioning/rotation are not implemented.

Phase 0 `authorization.ts` remains empty-GET-only and `grants.ts` still models
one epoch; their original negative tests remain unchanged. `sdk-contract.ts`
only compiles public SDK 0.6.59 types; transport runtime imports no BB SDK.

See the [Phase 1 evidence report](../docs/vercel-access-phase1.md) and complete
[Phase 0 scope and gates](../docs/vercel-access-phase0.md). WSS, Vercel gateway
routing, vendor maximum duration and all cloud behavior are **NOT EXECUTED**.
Live BB traffic remains blocked on a released, supported, tested machine
principal ingress. Owner/browser access and native previews remain separate
security surfaces. Do not turn this fixed fixture into a loopback BB proxy.
