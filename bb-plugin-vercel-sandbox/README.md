# Vercel Sandbox

Run BB threads on disposable Vercel Sandbox machines. Install it from this directory (`bb plugin install <toolbelt>/bb-plugin-vercel-sandbox --yes` after `npm ci && npm run build`), connect its CLI login and linked project, and select **Vercel Sandbox** when creating a thread. The plugin registers machine provider `vercel-sandbox` and an environment composition with `project-checkout`.

## Configure and launch

Choose a persistent enrolled BB machine to own Vercel authentication. Install `vc` 58.3.0 or later on that machine. Using the same operating-system user as its BB daemon, run `vc login` and approve the CLI OAuth browser/device flow, then run `vc link --cwd /absolute/directory` to select an existing Vercel team project. Connect that host and directory in plugin settings or with `bb vercel-sandbox account connect --host HOST --directory /absolute/directory --json`. The host extension pins CLI API requests to `https://api.vercel.com`, removes forced-TTY and agent-detection environment inputs, and refuses authentication on machines containing `/opt/.devin` because the supported CLI treats that filesystem marker as an agent and may start device login. Choose another persistent authentication machine in that case. Login and project selection are explicit user actions; inspection, installation, launch, and cleanup never start login or linking.

The server persists a secret-free connection. Its host extension uses fixed, noninteractive `vc api` requests to inspect `/v2/user` and issue project OIDC tokens through `/v1/projects/PROJECT/token?source=vercel-oidc-refresh&teamId=TEAM`. It reads only the linked `.vercel/project.json` metadata; the CLI owns its OAuth credentials and refresh. Captured token stdout stays in the host process. The plugin checks the current OAuth identity before and after issuance and checks OIDC `owner_id`, `project_id`, and expiry against the pinned scope. Project OIDC tokens identify a team/project, so the CLI user identity is verified separately. Credentials are not copied to the BB server or cloud sandbox.

SDK 3.5.1 executes compute operations on that authentication machine. A private transport supplies the validated OIDC token while the SDK receives an opaque credential marker, preventing SDK JWT inference or automatic refresh from rebinding scope. Expiring credentials refresh through the same CLI path before a request; a changed account or project blocks it. The standalone `sandbox` CLI 2.0.3 uses SDK 1.3.2 session commands and can implicitly login; it cannot preserve BB's named sandbox tags, generations, stop proof, and mutation retry suppression. `vc` owns authentication and linking; the typed SDK owns this durable compute lifecycle.

Settings `defaultVcpus` and `defaultTimeoutMinutes` default to 2 and 30. Editing defaults affects future allocations; recovery keeps the recorded allocation settings.

The server must be reachable from the sandbox. Configure core machine server access in Settings → Machines. BB owns daemon installation, private enrollment, credentials, work draining, checkout cloning, and `.bb-env-setup.sh`. Agent authentication uses BB's ordinary machine environment and provider configuration. A sandbox image's installed CLIs do not supply agent account credentials.

```sh
bb vercel-sandbox account connect --host HOST --directory /absolute/directory --json
bb vercel-sandbox account inspect --json
bb vercel-sandbox launch options --json
bb machine create --provider vercel-sandbox --inputs '{"vcpus":2,"timeoutMinutes":30}' --json
bb thread spawn --project PROJECT --environment-provider vercel-sandbox --machine-inputs '{"vcpus":2,"timeoutMinutes":30}' --prompt 'Work on the project'
bb vercel-sandbox machine inspect HOST --json
bb machine show HOST --json
bb machine remove HOST --yes
```

Use `bb machine list --all` to include disposable machines. `account inspect` proves authenticated sandbox listing; allocation permissions, spend capacity, image availability, and plan entitlements are checked by Vercel at launch. Diagnostics allocate no compute; account inspection may refresh OAuth/OIDC through the CLI. Resource defaults are also available through core plugin settings SDK and CLI.

Launch inputs accept `null` or a strict object with optional integer `vcpus` (1 or an even count up to 32) and `timeoutMinutes` (5–1440). Unknown fields are rejected. Memory is 2048 MiB per vCPU. Vercel plan limits apply: SDK 3.5.1 documents Hobby limits of 4 vCPUs and 45 minutes, Pro limits of 8 vCPUs and 24 hours, and Enterprise limits of 32 vCPUs and 24 hours. BB validates the provider maxima; it does not infer the account's plan.

## Files and lifetime

Compute uses `persistent:false` and `vercel/sandbox/universal:latest`. Files and running processes are disposable. Save important changes to Git before expiry or removal. This provider offers creation and removal; it has no suspension, restoration, idle pause, or automatic lifetime extension. Core retires an unused composed machine after its last live thread is archived. Standalone machines remain recorded until explicitly removed, even after vendor compute expires.

The current universal image's source declares Node 24, npm, pnpm, Git, GitHub CLI, curl, Python, and Claude, Codex, Pi, and OpenCode CLIs. `latest` is mutable: this source describes expected tooling, not proof of the deployed image's contents. Core bootstrap invokes Node before downloading the installer; the installer requires Node 22.19 or newer and does not install Node. The image source's Node 24 meets that requirement. Core's installer can start the daemon without systemd. Bootstrap errors remain visible and trigger cleanup. The repository setup hook installs project-specific dependencies; core machine CLI controls can inspect or install agent CLIs when needed.

Diagnostics use SDK `expiresAt`: a running session's vendor `startedAt` (or `createdAt`) plus vendor session timeout, with vendor sandbox `expiresAt` as the SDK fallback. An unavailable timestamp is `null`; BB does not substitute a deadline based on its own request time. Expiry does not imply that BB has removed the recorded machine.

## Durable allocation and cleanup

A server-local UUID in plugin KV storage and the core creation key determine a hashed sandbox name. The plugin saves secret-free allocation intent before submitting a request, records vendor ownership tags, and awaits the core machine-resource checkpoint before enrollment. Recovery reads the original named allocation, verifies team/project scope and ownership, and keeps the same session. A stopped, expired, missing, or replaced session is never silently rebuilt. After confirmed removal, a deliberate core launch may reuse the creation key; the old session identity protects replacement compute from stale cleanup.

Mutations are submitted once through the SDK transport. A lost response, abort, rate limit, or server error leaves submission uncertain; BB reads the durable name to recover an accepted allocation. When the outcome remains unknown, cleanup stays failed and retries rather than declaring absence from one lookup or allocating replacement compute. An allocation that never becomes visible can require operator investigation. Preserve the machine record and original CLI connection until cleanup resolves; `bb machine retry-cleanup HOST` retries removal immediately. HTTP status alone does not prove a submission had no side effects; create errors retain recovery intent.

Removal verifies tags, allocation generation, and session identity. It persists stop intent before requesting termination, records an acknowledged stop separately, and reads fresh vendor session state. Only an observed `stopped` state becomes durable stop confirmation before named metadata deletion. Each attempt performs bounded, abortable requests; pending termination or failed observation remains retryable. Confirmed stop survives reload and a lost deletion response. Operations on the same creation key are serialized, and allocation generations fence stale cleanup from replacement compute.

Vendor metadata deletion schedules asynchronous pruning. Named and direct-session lookups can return 404 while compute is still running, so a missing allocation without prior stop confirmation stays unresolved. Diagnostics retain the recorded session ID and vendor expiry; elapsed time is informational and does not complete cleanup. Keep the BB machine record and original scope, inspect that session in the Vercel dashboard or contact Vercel support to investigate, and use `bb machine retry-cleanup HOST` when observations recover. BB cannot verify termination of compute hidden by deleted metadata; it retains the durable tombstone rather than claiming removal. Each allocation pins its original authentication machine, directory, CLI user, team, and project. Reconnect changes future launches; existing retries, inspection, and cleanup use the original connection. Restore that machine's original login/project link when they change. OAuth and OIDC token rotation within that identity/scope is supported. Plugin reload and reinstall retain the allocation namespace and recorded connections in core KV; retained identity does not guarantee vendor compute survives. Deleting BB's database or plugin KV loses this identity and requires operator investigation.

Recorded allocations without a CLI connection retain their original team/project but have no historical user identity. Ordinary connect leaves them unbound. `account inspect` reports `legacyAllocations` for matching records; `account connect --adopt-legacy-allocations --expected-account ACCOUNT --expected-team TEAM --expected-project PROJECT --expected-count COUNT` (with the same host/directory) explicitly authorizes the currently verified account once for those records. This consent does not prove which user created them. Supply the IDs and positive count displayed by the preceding inspection. Fresh CLI identity and linked scope must match this consent. Migration locks the candidate keys in order and revalidates the entire generation/count set before writing, checks cancellation before each binding and before the default update, fills absent bindings, and never changes bound records. A failed batch reports its confirmed durable count, leaves the default connection unchanged, and requires reinspection before retrying. A resource without a binding and without its allocation intent remains blocked for investigation. Stored manual configuration is not read or removed by the plugin; production secret removal is an operator migration step.

Bootstrap stdin is uploaded to a unique 0600 temporary file, opened and unlinked before command execution, and cleaned up on failure where reachable. Exec uses the existing session directly, without SDK automatic resume, a vendor-enforced command timeout, bounded streaming output, and an abort signal. Cancellation attempts SIGKILL when a command receipt exists. An interrupted submission may lack a process receipt; successful remote termination is then unverified, and durable machine removal remains the cleanup path. Closing a CLI/SDK follower stops following; core machine removal cancels the durable creation operation.

## Typed RPC

`rpc.ts` exports `vercelRpcContract`. SDK callers use `sdk.plugins.callRpc` with plugin ID `environment-vercel-sandbox`, the relevant output schema, and explicit inputs:

| Method            | Input                                                                | Output                                                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch.options`  | `{}`                                                                 | Image, default inputs, allowed vCPU choices and provider duration limits, memory per vCPU                                                                                                                                   |
| `account.inspect` | `{}`                                                                 | `available`, sanitized `message`, nullable connection host/directory/account/team/project and display-only `accountName` username, `legacyAllocations` matching unbound count/scope, `adoptedAllocations` (0 on inspection) |
| `account.connect` | `{hostId,directory,adoptLegacyAllocations?,expectedLegacyIdentity?}` | Same sanitized connection result; adoption defaults false; `expectedLegacyIdentity:{accountId,teamId,projectId,count}` is required for adoption and null otherwise; returns confirmed binding count                         |
| `machine.inspect` | `{hostId}`                                                           | Summary, fresh session state and `computeEnded` proof, recorded identity and nullable vendor expiry, resource size/image, team/project                                                                                      |

`computeEnded` is true only when a fresh, owned direct-session observation reports `stopped`. Missing metadata, failed/aborted vendor states, passed expiry, and metadata deletion acknowledgement do not establish that proof.

`bb vercel-sandbox account connect --host HOST --directory PATH [--json]` and the explicit adoption command above, `launch options`, `account inspect`, and `machine inspect HOST` expose the same results with `--json`. Core `hosts.experimental_create`, `hosts.delete`, and `threads.spawn` provide launch/removal parity. Use `bb plugin rpc inspect environment-vercel-sandbox` to inspect the registered schemas.

## Vendor evidence and verification

The dependency is pinned to [`@vercel/sandbox` 3.5.1](https://www.npmjs.com/package/@vercel/sandbox/v/3.5.1), Apache-2.0. Its [published artifact](https://registry.npmjs.org/@vercel/sandbox/-/sandbox-3.5.1.tgz) supplies the actual SDK types, image selector, named allocation, `persistent:false`, exec timeout, and expiry contracts. The artifact README states the plan/resource limits. [Vendor SDK reference](https://vercel.com/docs/vercel-sandbox/sdk-reference).

Expected tooling is documented by the [universal image Dockerfile](https://github.com/vercel/sandbox/blob/6fc8e16fd606beab8f99546482f11cc40c3e5a8e/images/universal/Dockerfile). Runtime inspection of this moving image and a full live enrollment/checkout/agent turn remain unverified. The community cloud-sandbox repository has no declared license; this implementation does not copy its code. `components/` and `lib/` are copied from BB's MIT-licensed `packages/shared-ui` (with the plugin icon wrapper from `packages/plugin-registry/flavors`), because toolbelt plugins build against the published SDK rather than BB's workspace packages.

```sh
npm ci
npm run typecheck && npm test && npm run build
../scripts/bb-plugin-smoke .
```

Tests run the real vendor SDK against mocked HTTP transport through the host-entry and server plugin harnesses, with fake CLI identity/issuance and subprocess boundary tests. They allocate no paid compute and require no vendor credentials.
