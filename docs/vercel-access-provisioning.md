# Bounded relay provisioning

This page describes the explicit relay setup contract for the experimental Vercel Access plugin. Read **Ownership and recovery** before retrying a failed preparation. Integrators can use the typed contracts linked under **Interfaces**. The [native machine boundary](vercel-access-phase2.md) remains unchanged.

**Local implementation evidence only.** Vendor allocation, TLS/WSS ingress, runtime behavior and cost require a separately approved cloud experiment after independent review. Installing these packages does not allocate compute or enable access. This is not persistent-machine recovery or Phase 2 product acceptance.

## Ownership and recovery

A relay is provider-owned helper compute with its own filesystem and intent namespace. It is not an enrolled BB machine, environment or user worker. Worker create/remove behavior and launch defaults are unchanged.

Preparation freezes the existing Vercel Sandbox connection: authentication host, account, linked directory or explicit scope, team and project. Subsequent inspection and cleanup use that connection even if the default connection changes. The original host validates its current CLI login against the pinned account. These operations do not start login or fall back to another account.

The BB server records the immutable setup identity before host submission. That durable insertion consumes the one permission to initialize a private host journal. Only that first dispatch carries `initialize: true`; retained retries carry `false`, including after a server restart or lost first reply. If the first host delivery never happens, the intent stays unresolved rather than granting another initialization. The original authentication host separately records the resource intent in its plugin-scoped persistent directory. Host journal files are mode 0600, bounded, fsynced and replaced atomically; their directory is mode 0700. The intended writer is one plugin host worker. These journals do not provide distributed coordination for multiple independently running authentication daemons sharing a directory.

The identity includes an owner namespace, stable setup key and generation. The vendor name and tags distinguish relays from workers. Every host reply is checked against that key, generation, derived name and original authentication host/account/team/project before its URL, pin or cleanup fields can be returned. The server and access plugin durably retain the first public receipt. A known fingerprint, artifact digest, generation, session, origin or command cannot change or disappear; unknown nullable identifiers may become known once. A surviving receipt without its original server intent blocks reinitialization. The host records submission before creation and launch intent before submitting the detached command. Restarting the host worker preserves those records.

| Observation | Safe next action |
| --- | --- |
| Create reply lost, exact owned name found | Inspect; repeating prepare can finish the same resource |
| Submitted name missing | Retain intent; inspect or stop. Prepare refuses another allocation |
| Private host journal missing for a retained server intent | Fail unresolved; do not regenerate a pin, initialize state, allocate or certify cleanup. Preserve the server intent and original connection for investigation |
| Detached launch reply lost | Retain the `launching` intent. Prepare refuses another launch; inspect or stop |
| Name or session missing without stop proof | Retain intent. Missing metadata is not proof that compute ended |
| Session or ownership tags differ | Refuse access and cleanup; investigate the original allocation |
| Image, compute size, timeout or origin differs | Refuse use; inspect and stop the original owned session explicitly |
| Stop/delete reply lost | Inspect and repeat stop against the same original resource |
| `removed` with both cleanup proofs | The same key remains a tombstone. Explicitly use a new setup key for another session |

Stop first observes the original session, requests termination when needed, and requires the session to be observed stopped before deleting named metadata. The never-submitted shortcut requires both no observed sandbox and no recorded session; a `prepared` phase label alone cannot certify cleanup. A later retry can use that durable stop proof after vendor metadata disappears. The host clears its saved relay private host key after confirmed deletion. The disposable sandbox filesystem, including relay config and key files, is removed with the owned allocation. Uncertain records remain available for investigation. An unavailable authentication machine blocks vendor cleanup; stop still revokes local access for the matching current setup. Retrying historical cleanup does not disable a replacement setup.

Cancellation or a timeout can leave accepted vendor work. Host calls receive cancellation signals, and state transitions retain the resource identity rather than claiming rollback. Cross-plugin owner RPC is request/response; cancelling its caller is not a guaranteed vendor cancellation or cleanup confirmation. Calls are bounded by the server's operation deadline, and cleanup is a separate explicit operation.

## Artifact and credential boundary

The relay uses exactly one exposed adapter port, 1 vCPU and a ten-minute sandbox lifetime. It runs on the official [`vercel/sandbox/node:24` managed image](https://vercel.com/docs/sandbox/concepts/images). Released vendor SDK 3.5.1 lists `node:24` as a managed image. This image is maintained by Vercel and receives nightly updates; it is **not an immutable base-image claim**. Preparation records the requested image and reads a bounded private runtime-version file, requiring Node 24 before launch. No custom image, registry build or push is involved.

The relay JavaScript and its dependencies are immutable within a build. `npm ci` verifies the committed dependency lockfile. The pinned `esbuild-wasm` builder creates a standalone Node ESM artifact, including third-party notices. `npm run check:relay` in `bb-plugin-vercel-access` compares the committed artifact with current source and lockfile. The artifact records hashes for bundler-discovered local inputs (including `channels.ts`) and related grant/build/package configuration. The host verifies its SHA-256 before upload; a fixed remote launcher verifies the uploaded bytes again before importing `runRelay`. No cloud-side package install, curl-to-shell or external tunnel binary is used.

Vercel CLI/OIDC credentials stay on the original authentication host. The access plugin generates a dedicated connector private key and stores it through a secret BB setting. Only its public authorization key reaches the authentication host and relay. The authentication host generates the relay SSH host key and returns its public fingerprint through the authenticated host RPC. The connector does not learn a pin from the public relay endpoint.

Private config and key values travel through private files and authenticated setup calls, never argv, URLs, logs or resource metadata. The fixed command argv contains only code, generated file paths and a public artifact digest. Vendor command logs are not fetched. Returned metadata is schema-bounded and includes resource/session/command identity, origin, expiry, public fingerprint, observed image/vCPUs/persistence/session timeout, observed Node version, status and cleanup proofs. It excludes raw configuration and vendor or connector private credentials.

## Interfaces

The normal owner entry is the access plugin's [typed setup RPC](../bb-plugin-vercel-access/setup.ts) or `bb vercel-access relay` CLI. All CLI results are bounded public JSON; failures emit a fixed sanitized message and nonzero status.

| Operation | Effect |
| --- | --- |
| `relay prepare --key <stable-key> --confirm-cost` / `setup.prepare` | Explicitly authorize one bounded allocation using the connected account. RPC requires `approveAllocation: true`; no implicit confirmation |
| `relay inspect --key <key>` / `setup.inspect` | Observe retained intent and current command/session status; no create, resume or launch |
| `relay apply --key <key>` / `setup.apply` | Verify the private key matches the retained public authorization key, then inspect and bind the receipt before copying trusted setup into **disabled** settings. Enabling and reload remain explicit |
| `relay stop --key <key>` / `setup.stop` | Disable matching current local access, then stop/delete the original owned relay. Historical cleanup leaves replacement access enabled. Does not remove a user worker |

Preparation does not select a default machine-access provider or change worker defaults. Apply does not enable the plugin or reload it. A `ready` provisioning phase means the detached command submission was recorded; it does not establish transport or native machine readiness. Once explicitly enabled/reloaded, the existing connector must authenticate and pass a through-origin native version probe before access becomes available. Availability, native acquire, probes and same-origin reconnect never provision anything.

A stopped setup key cannot allocate a replacement. Preparing a new key requires the active setup's confirmed stop/delete proof. Public historical intent is retained; uncertain setup cannot be replaced automatically. The sandbox plugin retains at most 16 relay intents per server namespace. A namespace-wide admission lock serializes count-and-insert across distinct keys and is released before remote provisioning.

Lower-level integration uses the Vercel Sandbox plugin's [server contract](../bb-plugin-vercel-sandbox/relay-contract.ts) and [host contract](../bb-plugin-vercel-sandbox/host-contract.ts). Server `relay.prepare/inspect/stop` routes immutable identities to host `relayPrepare/relayInspect/relayStop`. Host `relayPrepare` additionally requires the first-dispatch `initialize` decision; a private driver must durably consume it before calling and must not repeat it for a retained identity. The host implementation accepts no arbitrary command, filesystem path or vendor authentication token. The original connection is never taken from the server's newly selected account during cleanup.

For an approved isolated test, the released public host-entry harness can invoke `createVercelHostEntry` on the original authentication machine with a private persistent `experimental_paths.dataDir`. Keep the synthetic BB process's HOME/XDG/environment separate from that authentication context. The harness is a local integration driver, not a claim of enrolled helper compute. Direct `createVercelClient.create` alone omits durable intent and cleanup proof and is not the complete lifecycle interface.

## Local verification and remaining gates

The local tests label fake vendor evidence explicitly. They cover pre-submit persistence, stable retries, lost create/launch/stop/delete replies, absent-session uncertainty, original-account refusal, ownership changes, no observation allocation, private-key separation, managed-image selection, bounded output and local artifact corruption. Public BB server and host harnesses exercise schema validation and lifecycle wiring. A separate subprocess starts the exact standalone artifact with no BB or installed npm packages and rejects owner-route HTTP. These tests execute no vendor network methods against Vercel.

The existing real-core native/SSH tests and throwaway activation smokes remain required. The artifact subprocess is a local Node test, not evidence of the managed cloud image, provider headers, domain stability, TLS, WSS or actual spend/teardown.

Admission remains process-lifetime state. Relay replacement, plugin restart, expiry and existing-worker header/origin reconfiguration are not repaired by these setup operations. Ordinary native access repair does not reconfigure an enrolled daemon. The cloud gate must validate actual HTTP/WSS behavior and cleanup under its separate approval; persistent admission and demonstrated worker reconfiguration remain separate product gates.
