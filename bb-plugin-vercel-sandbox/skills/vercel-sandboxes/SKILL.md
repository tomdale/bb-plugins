---
name: vercel-sandboxes
description: Configure, launch, inspect, and remove disposable BB machines on Vercel Sandbox.
---

# Vercel Sandbox machines

Install the plugin from `~/Code/Repos/toolbelt/main/bb-plugin-vercel-sandbox`. Choose a persistent
enrolled BB machine to own Vercel authentication. On that machine, install Vercel
CLI 58.3.0 or later, run `vc login` and approve its OAuth browser/device flow as
the machine's daemon user. In the plugin's Settings connection form, choose that
machine, select a team and project from its Vercel account, then connect. For CLI
setup, use `bb vercel-sandbox account connect --host HOST --team TEAM_ID --project
PROJECT_ID --json`. Login and project selection require explicit user action;
installation, inspection, launch, and cleanup never start login.

`vc` manages OAuth access-token refresh and issues project OIDC tokens through
noninteractive API requests. The plugin's host extension consumes tokens privately
and runs pinned Sandbox SDK 3.5.1 operations on that machine. Vercel credentials stay on the authentication machine; BB server state and sandbox
bootstrap receive allocation identities, not Vercel credentials. Keep agent runtime
credentials in core machine environment settings. Core machine server access must
let the sandbox reach the BB server.

Run `bb vercel-sandbox account inspect --json` to check the connected machine's
CLI account, selected project, OIDC scope/expiry, and authenticated listing without
compute. Inspection may refresh authentication. Successful listing does not prove
allocation permission or plan capacity. `bb vercel-sandbox launch options --json`
reads image, resource limits, and launch defaults without vendor allocation.

Each allocation pins its original authentication machine, CLI account, team, and
project. Connect affects future launches; retries and cleanup use the recorded
connection. Restore its original CLI login if it changes. Directory-backed
connections created with `--directory PATH` also pin that folder's Vercel project
link. To set one up, run `vc link --cwd PATH` on the authentication machine, then
connect with `bb vercel-sandbox account connect --host HOST --directory PATH`.
Preserve the folder and link for allocations using those connections.
Allocations recorded without CLI identity require explicit migration consent:
inspect the matching unbound count, verify you have authority for their recorded
team/project, then connect the same host and scope with `--adopt-legacy-allocations
--expected-account ACCOUNT --expected-team TEAM --expected-project PROJECT
--expected-count COUNT`, using the inspected IDs and positive count. This authorizes the
currently verified CLI account once; historical account identity is unavailable.
Ordinary connect leaves these allocations unbound. Confirmed bindings persist and
cannot be reassigned by reconnect. An interrupted migration reports its confirmed
count; reinspect before retrying. Missing-intent unbound resources require operator
investigation. Allocation namespace, generation, session identity, and stop proof
remain durable across reload and reinstall through plugin KV storage.

Create a standalone machine with `bb machine create --provider vercel-sandbox
--inputs '{"vcpus":2,"timeoutMinutes":30}' --json`. Create a thread with
`bb thread spawn --project PROJECT --environment-provider vercel-sandbox
--machine-inputs '{"vcpus":2,"timeoutMinutes":30}' --prompt 'TASK'`.
Machine inputs are a strict object with optional whole `vcpus` (1 or an even count
up to 32) and `timeoutMinutes` (5–1440), or null for defaults. Set defaults with
`bb vercel-sandbox launch defaults [--vcpus N] [--timeout-minutes M]` (initially 2
vCPUs and 30 minutes); `bb vercel-sandbox launch options --json` shows the effective
defaults, capped at the connected team's `plan` when it is known. Memory is 2048 MiB
per vCPU. Vercel plan caps apply: Hobby 4 CPUs / 45 minutes, Pro 8 CPUs / 24 hours,
Enterprise 32 CPUs / 24 hours, per pinned SDK 3.5.1 documentation.

BB installs and enrolls the daemon; the project-checkout composition clones the
project and runs its owned-path setup hook. The mutable universal image supplies
expected Node and coding tools; agent authentication uses BB's normal provider
and machine configuration. Project dependencies belong in `.bb-env-setup.sh`.
Read the plugin README for tooling provenance and operating constraints.

Inspect with `bb vercel-sandbox machine inspect HOST --json` and
`bb machine show HOST --json`. Include disposable machines with
`bb machine list --all`. Vendor timestamps determine expiry; null means the SDK
has no timestamp. Save important files to Git before expiry or removal.
Compute is disposable and has a fixed lifetime; this provider supports creation
and removal. Archiving the last live composed thread retires its machine.
Remove explicitly with `bb machine remove HOST --yes`.

A missing, stopped, or replaced session fails recovery rather than replacing lost
files. An uncertain submission stays pending cleanup until the owned named
allocation is visible. Cleanup records stop intent, acknowledged stop, and observed
stopped state separately; durable stop confirmation precedes metadata deletion.
Missing names or sessions cannot prove compute termination because vendor pruning
is asynchronous. Diagnostics retain the known session ID and vendor expiry; elapsed
time does not resolve cleanup. Inspect the recorded session in Vercel or contact
Vercel support when metadata is missing, retaining the BB record and original
connection. Use `bb machine retry-cleanup HOST` after fixing authentication or
connectivity. Deleting plugin KV or BB's database loses allocation identity and
requires operator investigation.

CLI commands have typed RPC equivalents in `vercelRpcContract` (`rpc.ts`):
`account.inspect` and `launch.options` take `{}`, `machine.inspect` takes `{hostId}`,
`account.teams` takes `{hostId}` and `account.projects` takes `{hostId,teamId}`;
both return `{choices:[{id,name}]}` through the authentication machine's CLI.
`account.connect` takes
`{hostId,teamId,projectId,adoptLegacyAllocations?,expectedLegacyIdentity?}`.
For directory-backed connections, supply `directory` in place of `teamId` and
`projectId`. Direct-ID connections return `directory:null`. Adoption defaults
to false. Adoption requires `expectedLegacyIdentity:{accountId,teamId,projectId,count}`
from inspection; ordinary connect uses null. Inspect/connect return sanitized
connection IDs, nullable display-only `accountName` username, availability,
unbound matching allocation count, and confirmed adoption count. Call
`sdk.plugins.callRpc` with plugin ID `environment-vercel-sandbox` and the matching
output schema. Core SDK launches use
`hosts.experimental_create({machineProviderId:"vercel-sandbox",inputs})` or
`threads.spawn` with composed `environmentProviderId:"vercel-sandbox"` and explicit
`machine:{type:"new",machineProviderId:"vercel-sandbox",inputs}`. Core removal is
`hosts.delete({hostId})`; inspect lifecycle completion because cleanup failure can
remain retryable after that request succeeds.
