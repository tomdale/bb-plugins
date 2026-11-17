# Subagents for BB

A native BB plugin inspired by [pi-subagent-in-memory](https://github.com/ross-jill-ws/pi-subagent-in-memory). Agents start independent background workers; users inspect live status summaries, execution specs, and read-only transcripts, or detach a subagent into a child thread of its parent thread.

## Agent tools

- `subagent_create({ task, title?, model?, reasoningLevel?, timeout? })` returns a run ID immediately. It inherits the calling thread's provider, model, reasoning level, service tier and permissions; `model` selects another model of that provider and `reasoningLevel` selects another level that model supports. A worker on another model keeps the inherited level when that model supports it and otherwise starts at the model's default. Completion delivers bounded output to the caller.
- `subagent_status({ id? })` reads status and up to 16,000 characters of output, or lists up to 100 owned runs.
- `subagent_kill({ id?, reason? })` stops a background worker and preserves partial output. Without an ID it lists owned runs. Agents cannot kill detached sessions, themselves, peers, or ancestors.
- `subagent_resume({ id, message?, timeout? })` continues a settled worker (completed, failed, timed out, or killed) in its existing session with a fresh time budget. `message` steers it with new instructions; without one it continues where it left off, except that a completed worker needs a message. The caller gets a completion report again. Runs that are still working, detached sessions, and runs the caller does not own are refused, as is a resume that would exceed the concurrency limit.

Tools advertise their behavior through schemas; the plugin adds no system instructions or automatically loaded skills.

## Subagents pane and detachment

Open **Subagents** from the thread header or the side panel's Actions list. The pane opens on the thread's subagent list — **Active** subtrees first, followed by **Inactive** subtrees — with parent → child hierarchy shown as nested tree rails rather than numeric depth labels. Each subagent displays its title, age, a one-sentence current-status summary (refreshed whenever the subagent emits a new reply or every 30 seconds from a summarized excerpt of its latest output), and its provider, model, and thinking level.

Selecting a subagent opens its detail view with clickable parent and child links, status summary, execution specs, error alert (when failed, stopped, or timed out), and live composer-free transcript.

**Detach subagent** converts the worker into a visible child thread of its parent thread (`parentThreadId: ownerThreadId`), disables its background subagent timeout, notifies the calling agent, and navigates to the child thread.

The thread header shows an outline button — "Subagents · 2 running" — while any background subagent the thread owns is working, and hides itself when nothing is active. A sidebar glyph on the original thread's row — a shimmering Bot icon while its workers run — is visible from anywhere in the sidebar.

The pane shows up to 100 runs, including nested workers in the original thread. Original-thread interruption leaves workers running under their own timeout. When a run settles, the plugin stops and archives its worker. A timed-out or killed worker keeps its session, so it can be resumed. Pending completion/detachment notifications are persisted and retried after reload; delivery is at-least-once across crashes.

## Execution and limits

Workers are **hidden BB threads**, not in-process Pi sessions. They consume normal BB concurrency slots and provider runtimes. They reuse the original environment, create no additional worktrees, and share files; coordinate concurrent edits. Hidden visibility and the read-only panel are UI organization, not access-control boundaries.

Settings: maximum nesting depth (default 2, range 1–10), maximum concurrent background runs per original thread (4, 1–32), and default timeout in seconds (1800, 0 for unlimited, maximum 86400). Timeouts are checked every five seconds. Existing runs keep their deadline; depth and capacity changes apply to subsequent creates.

### Timeouts

A timeout marks when a worker must start wrapping up; the plugin stops it only after a grace period. The grace period is 10% of the timeout, between 30 and 600 seconds.

1. Before the deadline, a worker whose timeout is long enough gets time-check messages: at 8, 4, and 2 grace periods before the deadline, each only when it falls in the second half of the budget. A 60-second run gets none, a 30-minute run gets two, and a 24-hour run gets three. Each message says the worker must keep working and asks for more than the last: highest-value work first, then favor finishing what is in progress, then take on only what fits in the time left. A worker that took a time check as an order to stop would end its turn and settle as completed, so the messages say they are not a stop request.
2. At the deadline the worker is steered to stop starting new work, leave files consistent, and begin its reply with COMPLETE or INCOMPLETE, followed by what is done and what remains. The run shows as **Wrapping up**.
3. If the worker goes idle in the grace period, its first line decides the outcome: COMPLETE settles the run as `completed`; INCOMPLETE, or no clear verdict, settles it as `timed-out` with the report as its output. If the worker does not go idle, the plugin stops it when the grace period ends and the run is `timed-out`. A worker that goes idle on its own at the deadline counts as completed.

The owner's notification for a failed, timed-out, or killed run names `subagent_resume`. Resuming unarchives the worker thread, sends the continue message (plus any steering), and starts a new timeout schedule. The pane shows how many times a run was resumed.

The core lifecycle owner is the original thread; its archive/delete lifecycle can stop workers, unlike ordinary interruption.

## Development and installation

From this package: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. Run `scripts/bb-plugin-smoke <plugin-path>` from the repository root for isolated activation. Install a built canonical copy with `bb plugin install <canonical>/bb-plugin-subagents --yes`.

Inspired by the MIT-licensed reference package; this implementation uses BB's public Plugin SDK and native provider sessions.
