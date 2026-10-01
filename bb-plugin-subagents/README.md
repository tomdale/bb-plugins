# Subagents for BB

A native BB plugin inspired by [pi-subagent-in-memory](https://github.com/ross-jill-ws/pi-subagent-in-memory). Agents start independent background workers; users inspect live transcripts, take control of the same session, and hand results back.

## Agent tools

- `subagent_create({ task, title?, model?, timeout? })` returns a run ID immediately. It inherits the calling thread's provider, reasoning, service tier and permissions; `model` selects another model of that provider. Completion delivers bounded output to the caller.
- `subagent_status({ id? })` reads status and up to 16,000 characters of output, or lists up to 100 owned runs.
- `subagent_kill({ id?, reason? })` stops a background worker and preserves partial output. Without an ID it lists owned runs. Agents cannot kill user-controlled sessions, themselves, peers, or ancestors.

Tools advertise their behavior through schemas; the plugin adds no system instructions or automatically loaded skills.

## User control

Open **Subagents** from the thread header or the side panel's Actions list. Select a run to view its live, composer-free transcript. **Take control** reveals the worker as a normal thread and notifies the calling agent. Its background timeout is disabled while the user controls it; automatic completion handoffs pause.

In that thread, **Return control** stops ongoing work, reads the latest output, hides and archives the worker, notifies the caller, and navigates back. Completed runs can be promoted again; the transcript and native provider session remain intact.

The panel shows the latest 100 runs, including nested workers in the original thread. Original-thread interruption leaves workers running under their own timeout. Hidden worker runtimes are stopped and archived on completion or failure. Pending completion/control notifications are persisted and retried after reload; delivery is at-least-once across crashes.

## Execution and limits

Workers are **hidden BB threads**, not in-process Pi sessions. They consume normal BB concurrency slots and provider runtimes. They reuse the original environment, create no additional worktrees, and share files; coordinate concurrent edits. Hidden visibility and the read-only panel are UI organization, not access-control boundaries.

Settings: maximum nesting depth (default 2, range 1–10), maximum concurrent background runs per original thread (4, 1–32), and default timeout in seconds (1800, 0 for unlimited, maximum 86400). Timeouts are checked every five seconds. Existing runs keep their deadline; depth and capacity changes apply to subsequent creates. The core lifecycle owner is the original thread; its archive/delete lifecycle can stop workers, unlike ordinary interruption.

## Development and installation

From this package: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. Run `scripts/bb-plugin-smoke <plugin-path>` from toolbelt for isolated activation. Install a built canonical copy with `bb plugin install <canonical>/bb-plugin-subagents --yes`.

Inspired by the MIT-licensed reference package; this implementation uses BB's public Plugin SDK and native provider sessions.
