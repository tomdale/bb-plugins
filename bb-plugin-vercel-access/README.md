# Vercel Access machine bridge prototype

**Disabled by default. Locally tested against released BB 0.46.1 / SDK 0.6.59 / daemon protocol 244. Not approved for daily-server activation or cloud deployment.**

This plugin provides a deliberately narrow machine-only connection path without BB/SDK modifications, private APIs, Connect identities, hosted BB services, or copying a BB database. The [Phase 2 decision record](../docs/vercel-access-phase2.md) describes the security boundary and remaining gates.

```text
native worker HTTP/WS -> dedicated relay's fixed HTTP/WS adapter
                                      |
                           private reverse TCP listener
                                      |
                          authenticated SSH over WS
                                      ^
                       outbound laptop SSH client
                                      |
                     fixed loopback machine-only bridge
                                      |
                   public bb.server.loopbackBaseUrl
                                      |
                       BB native machine authentication
```

The relay's one public HTTP listener handles `/machine-connector` upgrades for SSH control and the explicitly allowed machine HTTP/WS routes. Its reverse listener is loopback-only. Public Host and a short, explicit list of platform forwarding headers are checked/discarded at the adapter; Host is rebuilt for the laptop bridge. The laptop never trusts those headers as identity. Unknown platform headers fail closed until independently reviewed. Real Vercel header behavior is untested.

## Security contract

- `x-vercel-access` is **installation-level network admission**, not native host authority. Acquire/release correlate grants with a core key/host, but admission A plus a valid native credential B authenticates as **B**, not A. Revoking admission A does not ban native host A from using another valid admission credential. Use core native credential revocation for native host authority.
- Native `Authorization` is opaque and mandatory wherever BB requires it. The plugin does not verify, mint, store, or emulate BB daemon/enrollment credentials. Core verifies enrollment host binding, daemon keys, session host ownership, and its native daemon protocol.
- The laptop bridge checks the exact raw method/target/upgrade before dispatch. It never forwards owner APIs, browser `/ws`, terminals, enrollment-key minting, server-move HTTP routes, previews, cookies, Origin, caller gate identity, arbitrary targets, or unlisted methods/routes. Core still sees loopback; the plugin allowlist, **not** a fabricated core principal, is the owner-isolation boundary.
- Generic installers are allowed. `X-BB-Enrollment` lookup is denied, including credentialed installer/reconnect commands. Initial managed bootstrap supplies the core-issued private JSON through the public machine executor's stdin. The fixture tests this public helper; a separate test runs the actual released foreground daemon.
- Native machine authority includes the rich daemon WS protocol and installation-wide machine-readable skill/plugin artifacts. This is not per-thread artifact confidentiality or a restricted agent execution sandbox.
- SSH host-key pinning is mandatory, with a dedicated connector private key and relay-authorized public key. The pin must come from trusted provisioning, never public TOFU. Machine admission credentials cannot authenticate SSH control. No SSH shell, exec, client-selected relay destination, agent, X11, Unix, UDP, or SOCKS feature is enabled.
- The SSH client independently rechecks its one registered reverse tuple. Every accepted channel dials a literal `127.0.0.1:<bridge port>` from local configuration. Relay-provided destination/source metadata cannot choose a laptop/LAN socket. Compromised-relay tests use harmless canary listeners and enforce the 16-channel bound before dialing.
- The relay can observe and alter application payloads and steal native credentials passing through it. SSH terminates there; Vercel TLS termination is also a trust boundary. A malicious relay still cannot select arbitrary local services or dispatch owner routes, but confidentiality from cloud compute is **not** claimed.

## Permitted native surface

| Method | Target |
| --- | --- |
| GET | `/install.sh`, `/install.ps1`, `/install/version`, `/install/bb-app.tgz` |
| POST | `/internal/hosts/enroll` |
| POST | `/internal/session/open`, `/internal/session/events`, `/internal/session/tool-call`, `/internal/session/interactive-request`, `/internal/session/interactive-request/interrupt` |
| GET upgrade only | `/internal/ws?sessionId=<bounded opaque ID>`, only `bb-host-daemon.v1` |
| GET | `/internal/session/project-attachment-content` with exactly the four canonical native query fields |
| GET | `/internal/skills/tree/<64 lowercase hex>` |
| GET | `/internal/plugins/<safe lowercase alphanumeric/hyphen ID>/host/<64 lowercase hex>`, including reserved `bb--` IDs |

No path normalization precedes admission. Encoded path aliases, backslashes, fragments, absolute targets, extra query selectors, duplicate headers, Transfer-Encoding, Expect, CONNECT, and HTTP/1.0 are denied. POST JSON requires a canonical Content-Length and complete bounded staging before any native side effect. Each hop reconstructs its own native headers. Only Node's specific default fetch metadata and the normal WS compression offer are accepted/discarded; compression is not negotiated. Conditional archive ETags/304 survive; redirects are not followed or returned as usable destinations.

## Bounds and lifecycle

- 32 TCP connections and 16 active machine HTTP/WS operations per surface; four SSH-control sockets and 16 forwarded channels
- 16 KiB HTTP headers, 8 KiB target/header values, 1 MiB staged request or WS message, 256 MiB cumulative HTTP response
- WS fragmentation/chunk caps, 1 MiB outgoing admission bound, stream/socket backpressure; these are not whole-process RSS guarantees
- Five-second local/core TCP establishment and SSH authentication/registration deadlines, ten-second pending SSH-channel-open deadlines, 10-second HTTP header and 15-second request-body deadlines
- Native asynchronous operations have **no bridge response-idle or total-operation deadline** after admitted body validation. Both HTTP surfaces explicitly disable incoming socket inactivity timing only then; incomplete bodies remain bounded. Operations end on native completion, consumer cancellation, transport revoke/expiry, or disposal. Their concurrency and buffers remain bounded
- SSH keepalive detects missing replies with a 15-second interval / three-miss budget. Peer WS closure, SSH termination and stream EOF/close immediately enter idempotent connector cleanup and settle its exit promise. The BB background service retries the same pinned relay without replaying application requests or provisioning replacements
- At most 256 random admission leases, each at most 24 hours. Acquire is idempotent within this plugin factory's lifetime; release closes matching live sockets. A null-ID release conservatively revokes the matching current acquisition. Delayed explicit old IDs cannot revoke a replacement

`channels.ts` reserves accounting before local dialing or SSH channel-open requests and rejects late completions after timeout/disposal. A canceled consumer cannot erase an unresolved ssh2-owned open: its reservation remains bounded until reply/deadline. A stalled channel open retires the SSH session to release otherwise uncancellable library state; that transport fault can interrupt siblings. Ordinary cancellation/revocation of established channels remains stream-local, verified while a sibling request and connector survive beyond 120 seconds.

Leases are intentionally **process/factory-lifetime only**. Transient connector retries within the same factory retain credentials; plugin reload, disable/settings changes, or server restart invalidates them. Existing-worker header reconfiguration, durable grant storage, renewal, and relay URL replacement are not implemented. Core's enrolled bootstrap branch does not automatically deliver replacement headers, and credentialed installer reconnect is denied here. **Do not advertise ordinary access repair as recovery.** This prototype supports fresh bootstrap and bounded sessions; practical persistent-worker recovery remains a local implementation gate, not a reason to change core.

## Verify without touching the daily app

Requires a supported BB 0.46.1 installation and Node 24 for the exercised native test environment (`.prototools` pins 24.22.1).

```sh
npm ci
npm run typecheck
npm test
npm run test:core
npm run build
npm run test:build
npm audit
bb plugin types --check
```

`.npmrc` omits optional native acceleration and install scripts so ssh2 uses its supported JavaScript/Node-crypto path and BB can bundle it. SDK test peers are dev-only. The declared `build` script invokes the public BB builder from a fresh temporary HOME/XDG/npm/config/data context, outside the package directory. Neither package npm flags nor daily BB data host BB's separate toolchain installation, whose esbuild executable is an optional dependency. `test:build` verifies this with a cold HOME/data directory and deliberately inherited omit/ignore flags; no warm cache or user configuration change is required.

`npm test` includes simultaneous direct/SSH 18.5-second response regressions, stalled-body deadlines and independent grant cancellation/revoke. `npm run test:slow` repeats that native-style timing fixture with an observed 125-second response; it takes about 125 seconds and is separate from installed-core authentication evidence. `peer-loss.test.ts` launches the actual standalone relay CLI with private synthetic files and its intended public adapter bind, against a harmless fixed backend, then verifies idle/active SIGTERM and connector exit without caller-initiated close. No real BB server or user data is exposed by that relay fixture.

`test:core` starts real throwaway core processes, installs only task plugins there, explicitly selects `machine-bridge` only there, and deletes their data. All core, CLI, and worker subprocesses receive temporary HOME/XDG/npm state and an environment allowlist without account credentials or daily BB identity. Native daemon execution uses the released `bb-app host-daemon` foreground command, a separate process group, temporary workspace/data, and no auto-update, supervision, OS service, global CLI installation, or agent turn. Tests generate all admission/enrollment/SSH credentials synthetically.

Default test entrypoints target the installed macOS Personal app. `BB_TEST_SERVER_JS` and `BB_TEST_DAEMON_JS` can select equivalent released server / `bb-app` launcher files. Do not point tests at a running server's URL or data directory. `integration/fixture` is a throwaway synthetic machine executor, not a distributable plugin.

The repository activation smoke is also required, with an empty temporary HOME/XDG, Node from this package's selected toolchain, `BB_SMOKE_SERVER_JS` selecting the released entrypoint, and no inherited BB variables. Run it from the temporary directory so this package's npm flags do not affect BB's throwaway toolchain installation. Use the task's committed smoke-script copy; running verification does not require modifying any canonical checkout files.

## Relay source artifact; not a deployment

`relay-main.ts` can start the relay after **separate** provisioning/deployment approval. It allocates nothing and contains no Vercel SDK or login flow:

```sh
node relay-main.ts /private/relay-config.json
```

The bounded JSON configuration has exactly `publicAuthority`, `port`, `reversePort`, `bridgePort`, `hostKeyFile`, and `authorizedKeyFile`. The relay host key is a bounded mode-0600 file; connector authorization is a dedicated public-key file. Use one exposed adapter port, a private reverse port, and the exact laptop bridge port. Provision the host fingerprint through a trusted control path. Never include Vercel OAuth/API credentials in laptop settings, worker bootstrap, tunnel traffic, or source artifacts.

Plugin settings remain disabled until explicitly configured/reloaded. `loopback-test` requires the exact local bridge URL. `ssh-ws` requires an explicit relay origin, host fingerprint, dedicated secret connector key, fixed private reverse port, and machine-facing adapter origin; availability starts only after an authenticated transport readiness probe. These are test/prototype controls, not authorization to enable daily access. Vercel allocation, bounded auth-machine provisioning RPC, TLS/WSS, plan behavior, cleanup, durable recovery, browser access, and preview sharing remain separate gates.
