# BB Plugin SDK wishlist

Enhancements to BB's Plugin SDK that toolbelt plugins would use, each with the
use case that needs it, what the plugin does without it, and a possible API.
This is private tracking: nothing here has been requested from the BB team.

Add an entry when an SDK limit shapes a design. Each entry states the observed
BB and SDK versions, so later entries can be rechecked against newer releases.
Set **Status** to _filed_ with a link once a request goes upstream.

## Bound repeated failing tool calls within an active turn

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** Workstreams must stop a turn that repeats a failing tool call,
  including provider-side argument validation failures. Turn-end recap
  correction budgets do not apply while a turn remains active.
- **Limit:** the SDK exposes no per-tool failure hook or conditional stop for a
  specific turn. `experimental_thread.events` coalesces notifications once per
  second; `threads.stop` targets a thread rather than an expected turn ID.
- **Workaround:** read incremental event history for enrolled active threads,
  count five consecutive same-tool/same-error failures, verify the latest turn
  and active status, suppress recap corrections, then stop the thread. This is
  observe-and-stop protection, not an atomic veto: extra calls can run during
  notification and stop delivery, and a turn can change after the final check.
- **Possible API:** a tool-result hook covering validation failures with a
  terminate decision, or `threads.stop({ threadId, expectedTurnId })` plus
  uncoalesced failure notifications.

## Plugins render rows for the tools they register

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** Workstreams' `WorkstreamsRecap` tool records how a turn ended
  (complete or ready for review, a goal, the latest results, a review check,
  links). The recap card above the composer goes away when the conversation
  continues. The tool's timeline row is the natural place to keep the recap in
  the thread, as a one-line summary such as "◇ Review · Porting handoffs into
  Workstreams".
- **Limit:** `presentation.label` is static per tool, and
  `experimental_timelineRenderer({ kind: "tool" })` only covers tool items of
  providers the plugin registered. The app resolves a tool row's renderer by
  the thread's provider plugin (`{ kind: "tool", providerPluginId }` in
  `workspace-checkout-display-*.js`), so the plugin that registered the tool is
  never consulted.
- **Workaround:** the row is titled "Recap" with a tint, and the tool's output is
  the recap as Markdown, shown only when the row is expanded.
- **Possible API:** match `kind: "tool"` renderers to the plugin that registered
  the called tool (passing `toolName`), or let a tool result set its row's
  title, for example `{ content, presentation: { title } }`.

## Refresh a running session's tools

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** Workstreams changed `WorkstreamsRecap`'s `review` parameter
  from one string to a list of steps. Existing threads keep calling the tool
  with the schema their session was built with.
- **Limit:** `bb.agents.configure` selections, `registerTool` schemas, and
  instructions apply only when a provider session is next constructed (thread
  start, or resume after a daemon restart, environment switch, or provider
  restart). No SDK or CLI call rebuilds a thread's session or tells it that a
  plugin's tools changed. One Pi session kept the string `review` schema
  through several plugin reloads and sent a list as a JSON-encoded string.
- **Workaround:** BB validates every call against the current schema, so the
  current schema also accepts the earlier shapes (a single string or a
  JSON-encoded list for `review`). Reminders go only to sessions
  known to have the tool.
- **Possible API:** `bb.agents.refreshSessions({ threadIds })` or a
  registration flag that rebuilds affected sessions' tool sets at their next
  turn boundary, or a `tools.changed` signal that providers apply between
  turns.

## A hook before a turn completes

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** Workstreams asks each agent to end its turn with a recap or a
  question card. When a turn ends with neither, the plugin wants the agent to
  continue before the turn is shown as finished.
- **Limit:** completion is only observable (`thread.idle`, `turn/completed`).
  The turn's final reply is already visible, and the thread already shows as
  idle, before the plugin can respond.
- **Workaround:** an agent-only reminder starts a new turn, bounded per turn
  and guarded by an epoch and token checked in `message.dispatch`, so fresh
  user input overtakes it.
- **Possible API:** a `turn.completing` hook that can return
  `{ action: "continue", input }` once or a bounded number of times, before the
  turn is marked complete.

## Turn and pending-state facts for question forms

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** a turn that ends with an open question card ends properly, so
  Workstreams must not remind it. The card often comes from Workstreams' own
  `AskUserQuestion` tool, which opens `bb.ui.requestInput`.
- **Limit:** a plugin form opened from a detached tool call reaches
  `interaction.pending` with `turnId: null`. `threads.get` has no
  `hasPendingInteraction` (only `threads.list` items do), and no event reports
  that an interaction was resolved or cancelled.
- **Workaround:** a pending question with no turn is attributed to the latest
  `turn/started` event.
- **Possible API:** stamp forms opened from a tool call with that call's turn;
  add `hasPendingInteraction` to `ThreadResponse`; add an
  `interaction.resolved` event.

## Thread visibility in `configure`

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** Workstreams gives the recap tool to every user-facing thread,
  and leaves hidden worker threads without it.
- **Limit:** `PluginAgentConfigurationContext` has no `visibility` or
  `sectionId`, and `configure` is synchronous, so it can't fetch them.
- **Workaround:** every thread except side chats gets the tool. Hidden threads
  are excluded only from reminders, and Workstreams reads roles from its own
  SQLite snapshot of threads it has seen.
- **Possible API:** add `thread.visibility` and `thread.sectionId` to the
  configuration context.

## Events for section, title, and parent changes

- **Status:** not filed
- **Observed:** BB 0.44 and Plugin SDK 0.5.29 (Workstreams spike), still true
  in SDK 0.6.5
- **Use case:** Workstreams mirrors native sections as workstreams, respects
  titles the user sets, and nests threads under their parents.
- **Limit:** no event fires for section moves, section create, rename, or
  delete, title changes, or reparenting, including
  `experimental_thread.events`.
- **Workaround:** a reconciler polls `threads.list` and `threadSections.list`
  every 60 seconds and on page focus, then diffs against plugin state.
- **Possible API:** `thread.updated` with the changed fields, and
  `section.created`, `section.updated`, and `section.deleted` events.

## Plugins call the user's AI service and model catalog

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** Workstreams makes short, frequent model calls of its own:
  summarizing each thread after a turn, suggesting a home for a new-thread
  draft while the user types (about 1 s budget), and proposing a workstream map
  (structured JSON, 5–15 s). The user wants to choose those models with BB's
  own UI, from any model their machine can reach.
- **Limit:** AI services run one way: a plugin registers a service with
  `bb.experimental_aiServices.register`, and BB calls it for its own tasks
  (`thread-title`, `commit-message`, `voice`) with BB's prompts, a 5-second
  limit, and one-line cleanup. `bb.sdk.system.testAiService` takes only a task.
  No API sends a plugin's prompt to the selected service. Separately,
  `experimental_ProviderModelPicker` lists only a provider's scoped catalog
  (Pi's `enabledModels`, 14 models here) with no way to supply a wider list,
  and running a picked model means spawning a hidden worker thread (about 6 s
  per call, against about 1.2 s for a direct completion).
- **Workaround:** a `bb.host` entry calls AI Gateway directly with the key Pi
  already has, for gateway models; other picks run in hidden worker threads.
- **Possible API:** `bb.sdk.ai.complete({ prompt, model?: ProviderModelPickerValue,
  maxTokens, signal })` that runs one tool-free completion through the chosen
  provider without a thread, plus a picker `catalog: "all"` (or a `models`
  prop) for providers whose scoped list is a subset of what they can reach.
