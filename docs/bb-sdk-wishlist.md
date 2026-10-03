# BB Plugin SDK wishlist

Enhancements to BB's Plugin SDK that toolbelt plugins would use, each with the
use case that needs it, what the plugin does without it, and a possible API.
This is private tracking: nothing here has been requested from the BB team.

Add an entry when an SDK limit shapes a design. Each entry states the observed
BB and SDK versions, so later entries can be rechecked against newer releases.
Set **Status** to _filed_ with a link once a request goes upstream.

## Replace or resize the recent-thread list on a phone's Home screen

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.9
- **Use case:** Workstreams puts Up Next and the user's threads grouped by
  workstream on the phone Home screen, in place of BB's flat Recent list, and
  wants that content to use the whole scroll area under the top controls.
- **Limit:** `homepageSection` renders after the native list inside
  `RootComposeCompactHome`'s scroll viewport, under a host heading taken from
  the registration's `title`. No slot replaces or hides the list, and BB sets the
  viewport's `top` inline (the larger of 56px and the region height minus the
  composer height minus 5.5 rows), rewriting it in a `ResizeObserver`, so only a
  band about 354px tall above the composer scrolls; the space above is blank. A
  60px spacer offsets the content, and newer builds also bottom-justify it (a
  `min-h-full flex-col justify-end` wrapper). A section cannot omit the host
  heading, and wide windows still mount it.
- **Workaround:** the section finds out where it mounted and, inside the compact
  viewport, a stylesheet scoped by `:has([data-ws-home="takeover"])` hides
  `[data-root-compose-mobile-recents]` and the offset spacer, overrides the inline
  `top` with `!important`, top-aligns the content, and hides the section's heading.
  Where the viewport isn't found the section renders below BB's list. This
  depends on the `data-testid` values and the list's data attribute, and on
  `:has()`.
- **Possible API:** a slot that supplies the home list (`homeThreadList`, as
  `threadList` does for the sidebar) so BB hosts the scroll area and composer
  spacing itself; or `homepageSection` options for placement (`replace-recents`,
  `top`, `bottom`), an optional host heading (`title: null`), and per-layout
  rendering (`layouts: ["compact"]`) so a section can skip wide windows without a
  hidden mount.

## Contribute pickers to the New thread composer's picker row

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.9
- **Use case:** Workstreams adds a Workstream picker and a Product or feature
  picker beside BB's project, environment, branch and permission pickers.
- **Limit:** there is no slot in that row. The plugin finds the project chip's
  parent (`[data-promptbox-project-control]`) and inserts an anchor into it, so
  its chips cannot take part in BB's overflow rules (full and compact labels,
  the `promptbox-shell` container breakpoints). BB's own chips are `shrink-0` or
  squeeze only to their icons, so whatever the plugin's chip cannot give up is
  painted over a neighbor. On a 390px phone BB's row is already full with a
  project selected: its chips need about 263 of the row's 271px.
- **Workaround:** on wide screens the chips shrink first (a higher shrink factor
  than BB's, ellipsized labels, an icon-wide floor). On phones the row is left
  to BB and one route chip takes a line of its own in the New thread banner,
  opening a two-tab sheet.
- **Possible API:** a composer picker contribution (id, label, compact label,
  icon, value, options, selection handler) that BB renders in its own row and
  budgets with its own compact rules, so a plugin picker gets the same
  placement, labels and touch sizing as a built-in one.

## Plugin utility classes on content portaled into host DOM

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.9
- **Use case:** a plugin component portals into a host element (the picker row),
  and styles itself with Tailwind classes.
- **Limit:** the build scopes every plugin utility to plugin roots
  (`:where([data-bb-plugin=<id>], [data-bb-plugin-root]:not([data-bb-plugin]))`),
  so a utility BB's own stylesheet doesn't also define silently does nothing on
  portaled content. Nothing says so.
- **Workaround:** the anchor element is marked `data-bb-plugin-root` and
  `data-bb-plugin`, which makes the content a plugin root.
- **Possible API:** a portal helper that returns a scoped host element, or
  scoping utilities by a class prefix instead of ancestry.

## Copied UI primitives drift from the running BB

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.9
- **Use case:** plugin pickers and dialogs should look and behave like BB's.
- **Limit:** `components/ui/*` in a plugin are copies of BB's shadcn wrappers
  (`bb plugin` registry), so they pin one BB release's behavior. For example,
  the copied `responsive-overlay.tsx` lacks the bottom safe-area padding BB
  0.44.0's own drawer has, so a plugin's sheet sits under the home indicator
  until it adds the padding itself.
- **Workaround:** `.ws-route-sheet` pads its bottom by
  `env(safe-area-inset-bottom)`.
- **Possible API:** export the primitives (Popover, Dialog, Drawer, Command)
  from the SDK so a plugin always renders the running BB's version.

## Unknown icon names draw a lightning bolt

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.9
- **Use case:** a plugin names an icon for a Catalog product or feature.
- **Limit:** `Icon` takes any string. A name outside BB's registry (`Tag` is not
  in 0.44.0's) draws BB's lightning-bolt fallback with no warning, in the build,
  in tests, or at runtime. The identity chip, its list and two other surfaces
  drew bolts until the icon was declared.
- **Workaround:** declare the icon in `bb.branding.experimental_icons` and use
  its namespaced name; a test checks that each declared icon ships a themable
  SVG under the name the UI uses.
- **Possible API:** a development warning for an unregistered name, or
  `isIconName()` so a plugin can check.

## Select newly registered projects after catalog propagation

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.9
- **Use case:** register a Workforest checkout and select it in the composer
  without asking the user to repeat the selection.
- **Limit:** the composer reconciles project IDs against its sidebar navigation
  catalog; a successful `projects.create` can precede that catalog's realtime
  update, so `composer.setSelection` can return the previous or personal project.
- **Workaround:** retry a returned project mismatch up to six times with 400 ms
  pauses, preserving the complete requested selection. Thrown host errors remain
  immediate failures; exhausted retries keep the picker open.
- **Possible API:** a project-catalog synchronization barrier, or selection that
  resolves a requested project from the server before catalog reconciliation.

## Repository scopes within multi-repository environments

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.9
- **Use case:** coordinate a Workforest workspace while inspecting Git changes
  and PRs in its member repositories.
- **Limit:** environment metadata exposes one branch and Git-repository identity;
  the SDK provides no repository-context selector for native Git surfaces.
  `ComposerSelection.environment` also ignores provider inputs, so a checkout
  shortcut cannot directly seed the provider's input form.
- **Workaround:** workspace-root coordinator threads delegate to ordinary
  repository-scoped child threads, using Workforest task worktrees for isolation.
  A plugin-owned composer picker selects existing roots or member checkouts and
  registers projects automatically. Workspace roots retain filesystem context;
  native Git integration remains in repository threads.
- **Possible API:** environment repository inventory with explicit Git operation
  targets, and a composer selection contract that can seed provider inputs.

## Render delivered plugin tool results inline

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** show an answered question as readable Q&A in the generated
  “Delivered AskUserQuestion result” message instead of transport JSON
- **Limit:** `GeneratedConversationMessage` renders its body with
  `MarkdownPreview` directly, bypassing plugin message directives. The form
  timeline renderer covers the original form, not the detached result delivery
- **Workaround:** an app overlay observes mounted transcript rows, validates the
  exact question-result envelope, and portals a Q&A component beside the retained
  host content. Scoped CSS hides only that transport body. Unmount restores the
  original body; malformed or unrelated content is left untouched. This depends
  on host DOM structure and can briefly show raw text during mount
- **Possible API:** a renderer for generated system messages matched by
  `systemMessageKind` and originating plugin/tool, with typed retained payloads
  and a host-owned fallback

## Mount plugin content in the native thread conversation

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.9
- **Use case:** Workstreams wants to render a sticky thread goal as part of the native conversation, moving with its scroll position and reading active-thread data. Todo wants its list beside the live turn, sticking within the turn's extent as it scrolls: in a side gutter when the thread is wide, and inline with the turn when narrow, instead of in a composer banner.
- **Limit:** plugin slots include app overlays, thread-header actions, composer banners, and timeline renderers, but no scoped slot within the thread's message scroller. App overlays have no thread id or pane element prop.
- **Workaround:** a trusted app content script or React overlay locates host DOM by selectors and portals content into it. This depends on private markup, needs explicit split-pane safeguards, and can race pane remounts or scroll restoration. Todo measures `[data-message-column]` and `[data-scroll-footer]` and portals a fixed-position lane into the document body when the left gutter fits, vertically centered in the scroll area; below that width it stays a composer banner, because inline placement within the turn needs a host slot. The lane cannot follow a turn's top while scrolling: script repositions a fixed element after the compositor has scrolled the content, so it swims against the text, and the windowed timeline exposes no marker for the live turn.
- **Possible API:** a `threadContentHeader` slot rendered inside the message viewport with `threadId`, pane identity, scroll position/direction, and a host-managed sticky region. Todo would also use a slot that attaches to the active turn and exposes a right-gutter region beside it that collapses inline when the viewport is narrow.

## Preserve pending user questions across plugin reloads

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** a user should be able to finish answering a Workstreams question
  while another thread builds and reloads the plugin, without losing the card,
  partial input, or the agent's waiting tool call
- **Limit:** `plugin-runtime.ts` unload calls
  `pendingInteractions.interruptPluginInteractions(id)`, marking interactions
  `plugin-disposed`. Detached tool results are dropped. `ui.requestInput` offers
  neither a durable request ID nor a way for a new plugin generation to adopt
  the request and its waiter. The server log confirms questions dropped at
  exactly the reload timestamp. Removing the abort signal cannot prevent
  plugin-owned interaction disposal
- **Workaround:** Workstreams records unanswered questions in its own SQLite
  database before requesting native input. The composer restores orphaned cards
  after reload, retains partial input in per-tab session storage, and delivers
  recovered answers through `threads.send` as ordinary user messages. Recap
  enforcement stands aside while the durable question remains unresolved. Native
  waiting status and original tool-call continuity are not preserved; the
  frontend disappears briefly while its bundle reloads. Recovered delivery
  claims the record before sending to prevent concurrent-tab duplicates, but the
  SDK offers no idempotency key: a crash or ambiguous network failure during
  send cannot guarantee exactly-once delivery. This is recovery, not transparent
  native interaction persistence
- **Possible API:** `ui.requestInput({ durableKey, ... })` with
  `ui.adoptInput({ durableKey, describeSubmission })` on reload; retain the
  interaction, renderer state, expiry policy, and detached provider tool waiter
  across compatible generations. Distinguish reload from disable/uninstall,
  expose durable terminal results, and support idempotent answer delivery

## Provide projects and add items to the composer project menu

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** provide Workforest worktrees and workspaces as discoverable
  projects in the composer's native project menu, or add a “From Workforest…”
  action that opens a checkout picker and registers a project only when selected.
- **Limit:** the native `ProjectSelector` accepts existing projects and one
  core-owned create action. `ComposerCustomization` has no project-picker
  contribution surface.
- **Workaround:** Workforest adds a labeled new-thread composer `+` menu item. Its searchable popup creates or reuses an exact machine/path project,
  then calls `composer.setSelection` without navigating or submitting. It cannot
  sit inside or beside the native project menu through a dedicated SDK slot.
- **Possible API:** project source registrations with asynchronous discovery and
  resolve-to-project callbacks, rendered as host-owned menu groups; additive
  project-menu actions with labels, icons, and callbacks that can create/reuse
  and select a project while preserving the current draft.

## Preserve named fields in root-union tool schemas

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** Workstreams validates complete, review, and continuing recaps
  with different required fields using a Zod discriminated union.
- **Limit:** a root union can reach a Pi agent as an empty parameter object,
  although the server retains the union and rejects empty calls. Annotating
  the root as `type: "object"` does not ensure its variant properties remain
  visible to the model.
- **Workaround:** register a concrete object with all named fields and their
  state-specific descriptions, then parse the discriminated union before
  accepting the recap. Provider schemas expose the fields while server-side
  validation retains the state-specific contract.
- **Possible API:** preserve object-union fields across provider conversion,
  or reject registrations that a provider would expose with no parameters.

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
  the thread as a compact state, goal, and results card.
- **Limit:** `presentation.label` is static per tool, and
  `experimental_timelineRenderer({ kind: "tool" })` only covers tool items of
  providers the plugin registered. The app resolves a tool row's renderer by
  the thread's provider plugin (`{ kind: "tool", providerPluginId }` in
  `PluginTimelineRendererBody.tsx`), so the plugin that registered an injected
  tool is never consulted. Workstreams injects `WorkstreamsRecap` into threads
  owned by multiple provider plugins, so a provider-scoped renderer cannot own
  its timeline row.
- **Workaround:** the recap stays as Markdown in the generic tool output and is
  readable only after expanding the row. A BB-core tool-name special case would
  couple the host UI to a third-party plugin and is not a suitable plugin
  workaround.
- **Possible API:** let a timeline renderer register for a specific tool name
  or tool owner independent of the thread's provider, passing the call's
  arguments and output. Alternatively, let a tool result provide a validated
  row presentation and structured renderable payload; the host should keep
  ownership and fallback behavior explicit.

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
- **Possible API:** `bb.sdk.ai.complete({ prompt, model?:
ProviderModelPickerValue, maxTokens, signal })` that runs one tool-free completion
  through the chosen provider without a thread, plus a picker `catalog: "all"`
  (or a `models`
  prop) for providers whose scoped list is a subset of what they can reach.

## Choose where the open thread goes after archive

- **Status:** not filed
- **Observed:** BB 0.44.0; `PluginSidebarThreadActions.archive` returns `void`
  in Plugin SDK 0.6.5 and 0.6.15
- **Use case:** Workstreams' header Archive button should leave the user on the
  next waiting thread, as the recap card's Archive does (Up Next first, then the
  next row in the workstream), so clearing a queue takes one click per thread.
- **Limit:** `archive` hands the work to BB's flow and returns nothing. A
  plugin can't tell whether the archive happened, because the user can cancel
  the child-thread confirmation, and BB sends a viewer of the archived thread to
  the new-thread screen with no way to name another destination.
- **Workaround:** the header button accepts BB's destination. The recap card's
  Archive archives through the server (`threads.archive`) and calls `open`
  itself, which skips BB's confirmation dialog and Undo toast.
- **Possible API:** `archive` returns a promise of `{ archivedThreadIds }`, or
  null when the user cancels, and accepts an option naming the thread to open
  afterward, so BB keeps the dialog, toast, and pane handling.
