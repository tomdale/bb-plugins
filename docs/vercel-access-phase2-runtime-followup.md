# Phase 2 runtime review follow-up

This follow-up to `df906b6` closes locally reproduced compatibility/lifecycle findings. The [Phase 2 security boundary](vercel-access-phase2.md) is unchanged: installation-level per-acquisition admission, authoritative native BB credentials, exact machine dispatch, fixed local targets, and no owner/browser/preview routes. It is a new review checkpoint, **not acceptance or cloud authorization**.

## Finding dispositions

| Finding | Implementation and regression evidence |
| --- | --- |
| Admitted async HTTP disconnects at 15 seconds | Shared HTTP surfaces explicitly call `socket.setTimeout(0)` **after** complete body/admission validation. Node HTTP can destroy an idle socket even when a socket callback does nothing. Header/incomplete reception remains bounded; an explicit 15-second body timer prevents slow staging from dispatching native effects. Ordinary direct and SSH responses complete after both 18.5 and 125 seconds |
| Reserved built-in host artifact gets 403 | The single safe plugin-ID segment permits interior hyphen runs, including `bb--storage-retention`; method, path separators, percent aliases and lowercase 64-hex digest constraints are unchanged. Installed core's enabled built-in artifact has native/direct and bridge 200 parity, **242,309 identical bytes**, in both transport modes. Missing native auth still returns 401; encoded aliases return 403 |
| Relay termination leaves connector apparently running | WS close/error, stream EOF/close/error, and SSH end/close/error converge on idempotent cleanup. Every terminal path settles the connector exit promise, even if ssh2 never emits its own close event. The actual standalone relay CLI exits 0 on SIGTERM while idle and with an active forwarded socket; the connector reports stopped and closes local sockets without caller-initiated connector cleanup |
| Cold build inherits package npm policy | The declared `npm run build` invokes the public BB builder from a new temporary HOME/XDG/npm/config/BB-data context, outside the package directory. `.npmrc` still omits ssh2's optional native acceleration and install scripts. BB's separate toolchain can install its platform binaries without those flags or a daily cache. A cold declared-script regression deliberately supplies omit/ignore flags and still produces SDK 0.6.59 / BB 0.46.1 metadata |
| Pending dials/channel opens can outlive bounded accounting | `channels.ts` reserves a slot before dialing or requesting a channel. Local literal-bridge dials have a five-second deadline. Pending relay SSH opens have a ten-second deadline; late/stale completions are destroyed. All error/throw/disposal paths release accounting. Deterministic deadline/race tests and an actual authenticated peer withholding open acknowledgements verify retirement and fresh-session admission |
| SSH verification may return an Error | The existing signed-proof guard accepts only literal `true` and catches thrown errors. Pinned ssh2's [public runtime contract](https://github.com/mscdex/ssh2/blob/844f1edfc41589737671f96a4f4e76afdf46abd4/README.md#utilities) permits `false` or `Error` on verification failure, despite the installed `@types/ssh2` declaration saying `boolean`. True/false/returned-Error/thrown-Error regressions and normal signed SSH authentication pass |

A canceled TCP consumer does not erase an outstanding ssh2-owned open: its bounded reservation persists until the library reply or ten-second deadline. A timeout retires that SSH session, because the public pending-open API supplies no cancellable channel handle. This bounds peer-owned state instead of allowing repeated early closes to create uncounted opens. That transport fault can interrupt siblings; ordinary cancellation/revocation of **established** channels remains stream-local and is exercised alongside a surviving request and connector.

Native operations receive no replacement response-idle or total-operation timer. Reception, connection establishment and pending channel opens are separate phases with separate bounds.

## Executed lifetime evidence

Node 24.22.1, real HTTP sockets and standard ssh2/WS transport, harmless synthetic native-style handler. These tests prove transport lifetime, not execution of an actual BB tool or Vercel ingress.

| Handler delay | Direct response | SSH/adapter response | Other observations |
| --- | --- | --- | --- |
| 18,500 ms | 18,567 ms, 200 | 18,508 ms, 200 | Incomplete bodies stopped at 15,056 / 15,002 ms before native dispatch |
| 125,000 ms | 125,065 ms, 200 | 125,008 ms, 200 | Incomplete bodies stopped at 15,053 / 15,001 ms; independent cancellation/revoke stopped their native producers while the sibling request and connector survived |

`npm test` includes the >15-second direct/SSH regressions. `npm run test:slow` runs the separately observed >120-second experiment and takes about 125 seconds. Neither conclusion rests on the earlier 6.5-second test or merely on removal of a source-level timer.

## Verification and scope

| Command | Result |
| --- | --- |
| `npm ci`, `npm run typecheck` | PASS |
| `npm test` | PASS; 86 tests, including pending-operation, peer-loss and both-path lifetime cases |
| `npm run test:core` | PASS; five installed-core/native-daemon scenarios, with new real built-in artifact parity in direct and SSH modes |
| `npm run test:slow` | PASS; three tests including two observed 125-second responses |
| `npm run test:build` | PASS; two tests: cold HOME/data/context with deliberately inherited omit/ignore flags, and SDK-free minimal production-source standalone launch |
| `npm run build` | PASS; observed a fresh toolchain download, not a warm-cache-only build |
| `bb plugin types --check`, public SDK import scan, `npm audit` | PASS; SDK pin/host 0.6.59, no private imports, zero vulnerabilities |
| Repository activation smoke with empty temporary HOME/XDG/data | PASS; plugin running, disabled by default |

All subprocess configuration, keys, accounts and data are synthetic/temporary. The standalone shutdown smoke exercises the relay's intended public adapter bind against a harmless fixed backend; installed BB core listeners remain loopback-only. No live BB activation, core/SDK edit, agent execution, vendor credentials, cloud allocation/deployment, push or integration is part of this follow-up.

The pinned standalone relay command is `node relay-main.ts /private/relay-config.json` from its package directory under Node 24.22.1. A production-only minimal copy starts and exits normally with neither `@get-bb/plugin-sdk` nor `server.ts` present, without BB's SDK runtime shim. The current entrypoint guard requires canonical absolute paths, so noncanonical symlink-prefixed absolute aliases are unsupported; use the documented relative invocation. Vendor deployment-bundle assembly and prepare/inspect/stop RPC remain separate work, with their required boundaries and exact URL setup in the [README](../bb-plugin-vercel-access/README.md#relay-source-artifact-not-a-deployment).

Initial public bootstrap and actual released foreground daemon evidence remain distinct from unexecuted installer-shell/OS-service behavior. The daemon test uses the installed app dependency tree; independent worker-tarball hydration/startup remains a separate gate. Durable worker admission/reconfiguration and ordinary reconnect/repair recovery remain unsupported. Vercel networking/TLS, provisioning, vendor duration/headers, resource costs and cleanup remain approval-gated and unproven. A fresh independent review must inspect the revised runtime, particularly `channels.ts`, terminal-event cleanup, shared HTTP staging and the isolated build launcher, before integration or deployment.
