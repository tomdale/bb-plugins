# Subagents for BB

A native BB plugin inspired by [pi-subagent-in-memory](https://github.com/ross-jill-ws/pi-subagent-in-memory). Agents start independent background workers; users inspect live status summaries, execution specs, and read-only transcripts, or detach a subagent into a child thread of its parent thread.

## Agent tools

- `subagent_create({ task, title?, model?, timeout? })` returns a run ID immediately. It inherits the calling thread's provider, reasoning, service tier and permissions; `model` selects another model of that provider. Completion delivers bounded output to the caller.
- `subagent_status({ id? })` reads status and up to 16,000 characters of output, or lists up to 100 owned runs.
- `subagent_kill({ id?, reason? })` stops a background worker and preserves partial output. Without an ID it lists owned runs. Agents cannot kill detached sessions, themselves, peers, or ancestors.

Tools advertise their behavior through schemas; the plugin adds no system instructions or automatically loaded skills.

## Subagents pane and detachment

Open **Subagents** from the thread header or the side panel's Actions list. The pane opens on the thread's subagent list — **Active** subtrees first, followed by **Inactive** subtrees — with parent → child hierarchy shown as nested tree rails rather than numeric depth labels. Each subagent displays its title, age, a one-sentence current-status summary (refreshed whenever the subagent emits a new reply or every 30 seconds from a summarized excerpt of its latest output), and its provider, model, and thinking level.

Selecting a subagent opens its detail view with clickable parent and child links, status summary, execution specs, error alert (when failed, stopped, or timed out), and live composer-free transcript.

**Detach subagent** converts the worker into a visible child thread of its parent thread (`parentThreadId: ownerThreadId`), disables its background subagent timeout, notifies the calling agent, and navigates to the child thread.

The thread header shows an outline button — "Subagents · 2 running" — while any background subagent the thread owns is working, and hides itself when nothing is active. A sidebar glyph on the original thread's row — a shimmering Bot icon while its workers run — is visible from anywhere in the sidebar.

The pane shows up to 100 runs, including nested workers in the original thread. Original-thread interruption leaves workers running under their own timeout. Hidden worker runtimes are stopped and archived on completion or failure. Pending completion/detachment notifications are persisted and retried after reload; delivery is at-least-once across crashes.

## Execution and limits

Workers are **hidden BB threads**, not in-process Pi sessions. They consume normal BB concurrency slots and provider runtimes. They reuse the original environment, create no additional worktrees, and share files; coordinate concurrent edits. Hidden visibility and the read-only panel are UI organization, not access-control boundaries.

Settings: maximum nesting depth (default 2, range 1–10), maximum concurrent background runs per original thread (4, 1–32), and default timeout in seconds (1800, 0 for unlimited, maximum 86400). Timeouts are checked every five seconds. Existing runs keep their deadline; depth and capacity changes apply to subsequent creates. The core lifecycle owner is the original thread; its archive/delete lifecycle can stop workers, unlike ordinary interruption.

## Development and installation

From this package: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. Run `scripts/bb-plugin-smoke <plugin-path>` from the repository root for isolated activation. Install a built canonical copy with `bb plugin install <canonical>/bb-plugin-subagents --yes`.

Inspired by the MIT-licensed reference package; this implementation uses BB's public Plugin SDK and native provider sessions.
