# Workforest for BB

Workforest checkouts and BB agents, connected without duplicating worktrees.

## UI

- **Composer project shortcut:** in an expanded new-thread composer, click the
  branch icon in the prompt toolbar (**Workforest project**) to search existing
  worktrees and workspace roots on a connected
  machine. Selecting a checkout creates or reuses its BB project by exact
  machine and path, then selects that project and checkout in the composer.
  The draft is preserved; no checkout or thread is created. Workforest still
  owns checkout deletion.
- **Workforest sidebar page:** compact repository/workspace groups with
  five-change previews, expand/collapse, search across member repositories and
  paths, type and needs-attention filters, and recency/name sorting. The
  overview uses the full width; selecting a checkout opens its detail column
  with branch divergence, dirty file counts, integration and setup status.
  Update times reflect Workforest metadata, not Git commits or agent activity.
- **Create checkout:** one or more `owner/repository` names, or a Workforest
  template (including variants). Uses the machine's configured branch naming and
  setup hooks.
- **Task lanes:** create an isolated lane from a clean parent's committed HEAD,
  optionally running setup.
- **BB threads:** start a thread in a workspace root, repository, or task lane.
  Select an existing project on that machine or create/reuse a project for the
  exact checkout. Uses the project's default execution settings.
- **Thread header and panel:** recognize Workforest ownership by machine and
  path, with direct access to repository and task state. The homepage also links
  into Workforest.
- **Setup operations:** inspect recorded logs and retry failed setup.
  Long-running operations stay on the host with a worker lease, with bounded
  recent results in the UI.
- **Cleanup safety:** run Workforest's dry-run checks and review blockers.
  Deletion is deliberately left to `wf delete` after stopping agents; the plugin
  never force-deletes or archives unrelated BB threads.

## Requirements

- BB 0.44+ with Plugin SDK 0.6.5+.
- Workforest on the PATH of each selected BB machine, supporting
  `wf list/status/template list/delete --json` and `wf task new`.
- An enrolled, connected BB machine. The plugin never runs a remote machine's
  command on the BB server instead.

## Install locally

```sh
npm install --include=dev
bb plugin build
bb plugin install . --yes
```

Open **Workforest** in BB's sidebar. To develop against a running BB, use
`bb plugin dev`. Path installs refer to this checkout; retain it while
installed.

```sh
npm run typecheck
npm test
npm run build
bb plugin types --check
```

## CLI

Read-only, bounded output. Resolve machine IDs with `bb machine list`.

```sh
bb workforest list <host-id>
bb workforest status <host-id> <group/name>
```

## Ownership and safety

Workforest owns Git worktrees, workspace metadata, setup, branch policy, and
integration checks. BB sees existing checkouts as attached environments and
newly-created checkouts as provider-owned environments. BB owns thread creation;
Workforest remains the authority for checkout lifecycle and deletion.

All CLI execution uses argv arrays with `shell: false`; selectors, names, source
forms, and operation kinds are validated. Task directories come from fresh
Workforest metadata, not browser-supplied paths. Commands have time/output
limits and process-group cancellation on plugin disposal. Normal read calls
expire after 24 seconds; mutations run for up to 15 minutes. Workforest's
independent background initializers may continue after its initiating CLI exits.
Refresh status before retrying an interrupted operation.

Polling runs only while UI consumers are mounted (inventory/detail 10s,
operations 3s, thread links 30s); effects discard late results and reconnects
refresh data. Recent operation history is in-memory and can disappear after
host-worker eviction/reload. Durable state stays in Workforest. Failed host
operations are shown explicitly, without converting failure into an empty
successful inventory.

Cleanup preview is not a BB-agent activity check. Workforest's clean/integrated
checks do not prove that no agent still uses a checkout. Stop relevant agents
before invoking deletion yourself.

## Current limits

- No force-delete, automatic cleanup, thread migration, PR review creation,
  template editing, or cache repair UI.
- Thread launch uses project defaults; change provider/model/permissions in BB's
  project/thread controls. The host's native new-thread composer cannot preserve
  an explicit unmanaged checkout path, so this plugin uses an explicit-path
  launch form instead.
- Linked threads are checked among the first 100 visible sidebar threads on the
  selected machine; archived/hidden threads are not enumerated. Branch names
  alone never establish a link.
- Logs show the last 24,000 characters and may contain sensitive output from
  user-authored setup scripts. They are never uploaded by this plugin.
- No remote-machine install or permission escalation. Install `wf` on each
  machine yourself.
