# BB Plugin SDK wishlist

Enhancements to BB's Plugin SDK that Tom's plugins would use, each with the
use case that needs it, what the plugin does without it, and a possible API.
This is private tracking: nothing here has been requested from the BB team.

Add an entry when an SDK limit shapes a design. Each entry states the observed
BB and SDK versions, so later entries can be rechecked against newer releases.
Set **Status** to _filed_ with a link once a request goes upstream.

## Server-managed secret fields and runtime provider removal

- **Status:** not filed
- **Observed:** BB 0.48.0 / host SDK 0.6.100; public SDK 0.6.59 contracts
- **Use case:** a built-in Sandbox relay generates its connector key and can be
  enabled/disabled without reloading worker-management handlers
- **Limit and evidence:** `settings.define` has secret storage but no hidden or
  server-managed field presentation; `experimental_serverAccess.register`
  returns void and has no unregister operation. Registering another CLI root in
  the same plugin is also rejected as a duplicate CLI registration
- **Workaround:** one secret setting labelled as managed automatically; one
  persistent provider whose availability follows the in-process service;
  disabling resolves an Automatic selection to Direct so the disabled provider
  cannot be chosen again by core fallback. Relay CLI subcommands join the
  existing `vercel-sandbox` command
- **Possible API:** server-only secret storage or a hidden managed descriptor;
  a provider registration handle with `dispose()` and a configuration recheck

## Optional native dependencies in backend source compilation

- **Status:** not filed
- **Observed:** BB 0.48.0 / host SDK 0.6.100
- **Use case:** bundle standard ssh2's Node-crypto path alongside a frontend
  whose test tooling needs optional prebuilt platform bindings
- **Limit and evidence:** BB compiles backend source again during plugin load.
  A resolvable `cpu-features` package leads to a rejected native `.node` import.
  Dependency exclusion must apply to runtime compilation as well as explicit
  builds; public `bb plugin build` exposes no dependency-exclusion option
- **Workaround:** generate the pinned standard ssh2 runtime with only its optional
  native accelerators disabled and include library licenses; BB and the standalone
  relay both consume that runtime. Transport and native-auth integration tests
  run against the generated code. No BB source changes are required
- **Possible API:** an audited optional-native dependency exclusion in the plugin
  manifest, applied consistently to explicit builds and runtime compilation

## Per-launch machine access selection and conditional settings writes

- **Status:** not filed; not required for the bounded Vercel UI
- **Observed:** released BB 0.48.0 / host SDK 0.6.100; public npm SDK
  0.6.99 and the plugins' 0.6.54/0.6.59 public contracts inspected
- **Use case:** create a fresh Vercel machine through a user-owned relay without
  changing unrelated new-machine launches or overwriting another settings editor
- **Limit and evidence:** machine bootstrap selects the server-access provider
  from `generalSettings.defaultMachineAccess` and retains it on the host;
  public machine/thread creation inputs expose no per-launch access selector.
  `sdk.system.updateGeneralSettings` requires the complete general-settings
  record and has no expected revision, unlike UI preference writes
- **Workaround:** the Sandbox UI requires an explicit global-default action,
  checks the expected current selection, saves the previous value privately,
  and offers restoration only while its own bridge is still selected. It
  preserves the latest other settings and warns against concurrent settings
  edits. Preparing or connecting a relay never changes the default
- **Possible API:** optional `serverAccessProviderId` on machine launch and
  composition selection; partial general-settings patches with expected revision

## Provider-neutral authenticated ingress for user-owned server access

- **Status:** rejected implementation direction; not filed or required for the
  [Phase 2 plugin-only machine boundary](vercel-access-phase2.md)
- **Observed:** installed BB 0.46.1 / host SDK 0.6.59; existing Vercel plugin
  pins 0.6.54; public registry SDK 0.6.94 declarations also inspected. Latest
  source at [bec24f2f8d6](https://github.com/get-bb/bb/commit/bec24f2f8d6da1877863dfa9155cf3867ea1ab18)
  declares 0.6.98, not the installed/released contract
- **Use case:** a local plugin opens an outbound tunnel to a user-owned relay;
  a user-owned gateway authenticates individually scoped/revocable machine
  access without a hosted BB account, while BB/database remain local
- **Limit and evidence:** public `experimental_serverAccess` grants contain
  `{ id, serverUrl, headers? }`, not a trusted core principal. Public
  `server.loopbackBaseUrl` reaches ordinary trusted-localhost APIs. In
  [request context](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/request-context.ts)
  and [host enrollment](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/internal/hosts.ts),
  local enrollment-key minting and remote machine/gate identity are distinct.
  Proxying remote requests into loopback does not preserve that distinction.
  The newer SDK's `internal_DO_NOT_USE_openTunnelIngress` is explicitly
  Connect-only, and its [implementation](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/apps/server/src/services/connect-next/tunnel-ingress.ts)
  verifies Connect assertions and marks requests remote. No supported external
  plugin API attaches a provider-neutral principal or cross-checks an access
  grant's host against the native daemon/enrollment credential. Core removal
  can also skip provider release if the plugin is unavailable: cloud grant
  expiry/startup reconciliation cannot rely solely on lifecycle callbacks.
  Grants have no native credential-refresh callback. Stable provider credentials
  can avoid replacement, but worker reconfiguration after rotation must be
  demonstrated: enrolled bootstrap does not automatically deliver new headers
- **Workaround:** Phase 2's exact native machine route/method/upgrade bridge
  preserves core bearer/session authentication and denies owner/local-only
  dispatch before loopback. Transport credentials provide installation-level
  admission, explicitly not native-host equality. Its local SSH/WS prototype
  requires no core/SDK changes. The original fixed-fixture foundation remains
  separate. No trusted gate headers, internal hooks or Connect IDs are used
- **Historical possible API, not requested or required:** machine-only
  `server.experimental_openAuthenticatedIngress({ verify })` returning a
  private listener/close handle. Verification returns null or a typed
  `{ kind: "machine", hostId, grantId, scopes }` from provider assertions.
  Core owns out-of-band remote principal attachment, a versioned machine-only
  bootstrap/runtime route policy, host equality with enrollment/session/
  daemon credentials, denial of owner/local-only APIs, and HTTP/WS lifecycle
  cancellation including active-stream revocation by grant. Do not simply
  publish the existing Connect-only method unchanged. Owner/browser ingress
  needs separate approval and a session/Origin/CSRF contract
- **Details:** [Phase 0 report and exact endpoint inventory](vercel-access-phase0.md)

## Provider-neutral worker preview sharing

- **Status:** not filed; not required for the independent transport probe
- **Observed:** BB 0.46.1 / SDK 0.6.59; same restriction in public 0.6.94 and
  [latest backend contract](https://github.com/get-bb/bb/blob/bec24f2f8d6da1877863dfa9155cf3867ea1ab18/packages/plugin-sdk/src/backend-contract.ts)
- **Use case:** authenticated Vercel worker previews should go directly from
  a user-owned gateway to the worker, without laptop transit or Connect
- **Limit and evidence:** `hosts.ensureSharedPortTunnel` returns the daemon's
  trusted gate label/baseDomain; `declareSharedPorts` requires trusted machine
  credentials. The plugin cannot select a different credential issuer/gate,
  or register a provider-owned preview transport into native unified sharing
- **Workaround:** plugin-owned preview controls and scoped provider URLs, with
  independent origin authentication/revocation. Do not present these as native
  shared ports or silently fall back through the laptop
- **Possible API:** a preview/share provider registration that resolves typed
  host/port targets to scoped URLs with availability, expiry, revoke, and
  lifecycle signals; core retains target ownership while the provider owns
  transport/authentication. Keep this separate from server-access grants

## Typed host RPC is not a live duplex transport

- **Status:** not filed; no SDK addition needed for the Phase 1 probe
- **Observed:** BB 0.46.1 / SDK 0.6.59; toolbelt Vercel plugin at its committed
  SDK 0.6.54 and Sandbox 3.5.1 pins
- **Use case:** carry a sustained outbound relay tunnel without buffering an
  entire command before delivering its output
- **Limit and evidence:** typed host calls return schema-validated JSON results,
  not a duplex byte-stream lease. Toolbelt's `bb-plugin-vercel-sandbox/host.ts`
  `exec` accumulates output; `host-contract.ts` caps that string at 131072
  characters, not a streaming byte budget.
  Sandbox 3.7 writable stdin does not change this host RPC return contract
- **Workaround:** use an independently managed outbound streaming transport,
  initially to the harmless fixture. Keep host RPC for bounded management
  commands, not tunnel data. It is unnecessary to change the existing Vercel
  plugin or SDK pins for the local foundation
- **Possible API:** only if a concrete host-stream consumer needs it later,
  a cancellable typed byte-stream lease with backpressure, bounded queues,
  lifecycle disposal, and explicit host ownership; no request is made here

## Route inline Markdown file links outside a workspace

- **Status:** not filed
- **Observed:** BB 0.46.1; plugin pins SDK 0.6.5, running app SDK 0.6.59
- **Use case:** a Workstreams recap links to a local backup outside the thread's
  checkout, and the link should open the host file in BB's preview panel.
- **Limit:** `Markdown.experimental_document` accepts workspace and thread-storage
  targets, but no host identity or link resolver. BB's
  `buildMarkdownDocumentLinkRouting` delegates out-of-root paths to the ambient
  timeline handler; a composer card without that handler renders an anchor whose
  activation does not open the file. `experimental_FileLink` supports explicit
  host targets, but `Markdown` does not expose custom anchor rendering.
- **Workaround:** Workstreams captures ordinary clicks on the renderer's `file:`
  anchors and calls `experimental_openFilePreview` with an explicit host target
  for out-of-workspace paths. The Markdown stays intact, including formatting
  across links; workspace links, other URLs, and modified clicks keep the host
  renderer's behavior.
- **Possible API:** an optional `hostId` in `Markdown.experimental_document` that
  resolves absolute paths outside its root, or a typed file-target resolver for
  Markdown anchors.

## Parse Markdown in frontend rendering tests

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5 and 0.6.15
- **Use case:** Workstreams recap tests need to verify that file destinations
  with spaces render as clickable links, including workspace-relative paths.
- **Limit:** the frontend harness's `Markdown` component puts its source in a
  plain text div. It cannot expose invalid Markdown destinations or verify
  anchors and their file routing.
- **Workaround:** rendering tests use `react-markdown`, the parser BB uses,
  and assert anchors alongside the document context passed to the host. Live
  app checks verify that activation opens BB's file preview.
- **Possible API:** a frontend harness option that uses BB's Markdown parser
  and records file navigation through the supplied document context.

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

## Attach plugin data to every submit of a composer

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** Workstreams' New thread banner shows a Product or feature for
  the draft (picked by hand or classified) and needs the server's
  `message.dispatch` hook to file the new thread with it, whichever way the
  user submits.
- **Limit:** `experimental_data` reaches dispatch hooks only through the
  plugin's own `composer.submit(options)`. A plugin cannot add data to a submit
  the user starts: BB's Enter key calls the prompt box's `onSubmit` directly
  (`PromptBoxInternal.tsx` `submitPrompt`), firing no form `submit` event, and
  the composer has no before-submit hook or standing submission data. The
  banner's capture-phase `submit` listener on `form[data-promptbox]` sees only
  send-button clicks, so a manually picked identity was lost on Enter.
- **Workaround:** the banner reports each draft's text and identity to the
  plugin server as they change (`draftIdentity`), and the dispatch hook pairs a
  fresh first message with the reported draft of the same text, waiting up to
  10 seconds for a report that arrives after the dispatch (`ComposedDrafts`).
  Identical drafts in two windows can pair with either thread, and the form
  listener still depends on BB's markup.
- **Possible API:** `composer.setSubmissionData(json | null)`, scoped to the
  calling plugin and cleared with the slot, that BB attaches as
  `experimental_submission` to every submit of that composer; or an
  `onBeforeSubmit(listener)` that may return data for the submit.

## Place composer content below the prompt box

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** New work's suggestion row (Send to a thread) and Debug section
  belong under the composer in BB's New thread view, where Workstreams' former
  New work dialog put them.
- **Limit:** a composer `banner` renders above the prompt box, and no slot
  renders below it.
- **Workaround:** on the New thread view both stay in the banner, above the
  prompt box; only the Product or feature chip is portaled into the picker row
  (see Contribute pickers to the New thread composer's picker row).
- **Possible API:** a banner `placement: "above" | "below"` option, or a
  `composerFooter` slot with the same `useComposer()` scope.

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
  native Git integration remains in repository threads. Walkthrough uses a
  read-only host entry for absolute excerpts outside the conversation's workspace:
  `environments.diffPatch` accepts an environment ID and paths, not a repository
  root, so it cannot compare a different checkout from a coordinator thread.
  The host entry resolves the excerpt's Git root and reads the patch and revisions
  there; absolute file links use explicit host targets.
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

- **Additional use case:** Subagents forwards a worker's final output through
  `threads.send`. Reply blocks in that notification appear literally because
  user/generated messages do not activate `experimental_messageBlock`; the SDK
  contract explicitly restricts it to assistant messages. `Markdown` outside a
  block renderer also has no way to activate registered block renderers.
- **Additional workaround:** Workstreams observes mounted notification rows,
  reads the complete saved delivery, checks its run identity against Subagents'
  `list` RPC, and renders the reply with its existing component. It hides the
  original body only after the replacement mounts and restores it on cleanup
  or a rendering failure. This depends on host row identifiers and DOM markup.

## Keep a timeline card anchored while expanding

- **Status:** not filed
- **Observed:** BB 0.48.0, Plugin SDK 0.6.5
- **Use case:** Workstreams' read-only question card should expand below its
  disclosure without moving the card's top, even at the bottom of a thread.
- **Limit:** the timeline's scroll position keeper pins the conversation to the
  bottom when content grows, but the SDK does not expose its reading-position
  controls to timeline renderers or app overlays. In the running app, opening a
  tall card at the bottom moved its top upward by the card's added height.
- **Workaround:** none supported. Manipulating the host's private scroll element
  and synthesizing user scroll input can detach the bottom pin, but depends on
  implementation details and can interfere with real user scrolling.
- **Possible API:** a scoped timeline scroll controller that can preserve an
  element's top edge across a plugin-driven layout change, including while the
  timeline is bottom-attached, without simulating user input.

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

## Title provenance and conditional title updates

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5
- **Use case:** Workstreams titles a thread with its goal from the opening
  request, seconds after the thread starts, while BB's own generator, the user,
  or an agent may title the same thread at the same moment. It must never
  replace a title it did not write.
- **Limit:** `ThreadResponse` says who wrote a title nowhere, and
  `threads.update` takes no precondition, so a title set between a plugin's
  read and its write is overwritten.
- **Workaround:** the plugin infers ownership from the sequence of titles it
  has seen (a change it did not write locks the title), and re-reads the thread
  inside its serial mutation queue immediately before writing, leaving a window
  of a few milliseconds.
- **Possible API:** `title` provenance on `ThreadResponse` (`generated`,
  `user`, `agent`, or the writing plugin's id), and an `ifTitle` precondition
  on `threads.update` that fails the write when the current title differs.

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
  SDK 0.6.5's `ThreadSpawnArgs` has no output-schema or output-token-budget
  fields, and `threads.output` returns only text. Worker answers therefore use
  post-generation validation instead of constrained generation; their trace
  usage is unavailable rather than reported as zero.
- **Possible API:** `bb.sdk.ai.complete({ prompt, model?:
ProviderModelPickerValue, outputSchema?, maxTokens, signal })` returning text
  and nullable usage/reasoning metadata, that runs one tool-free completion
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

## Add a property row to the thread info tab

- **Status:** not filed
- **Observed:** BB 0.44.0, Plugin SDK 0.6.5 and 0.6.16
- **Use case:** Workstreams gives each thread a Topic setting (Automatic by
  default, with the classifier's current result shown under it, or a topic the
  user picks). It belongs with the thread's other properties in the panel's info
  tab (Parent, Project, Environment, Directory), where users already look for
  and change what a thread is attached to.
- **Limit:** `PluginAppSlots` has no slot for that tab. `threadPanelAction` only
  adds an entry to the panel's new-tab launcher, which opens a separate tab, and
  `experimental_threadHeaderAction` places a control in the thread header.
- **Workaround:** the Topic control is a thread header action (`task-identity`)
  that opens a popover with Automatic and the topic list.
- **Possible API:** a `threadInfoRow` slot (id, label, icon, component receiving
  `{ threadId }`, optional order) that BB renders as a label and value row in
  the info tab, with the value component able to open its own popover the way
  the Parent row's picker does.

## Open a plugin page in a new BB window

- **Status:** not filed
- **Observed:** BB 0.46.1, Plugin SDK 0.5.29; the desktop behavior below is read
  from BB source at `f0898f707a`
- **Use case:** Walkthrough's reading view should open in a BB window of its own,
  so it can sit on a second display beside the thread.
- **Limit:** `useBbNavigate` has no way to open a window. BB's desktop app denies
  every `window.open` from an app window and hands http(s) URLs to
  `shell.openExternal` (`apps/desktop/src/desktop-window-factory.ts`), so the
  link lands in the system browser, and New window always loads the app root. A
  plugin cannot create a BB window at a route. The only plugin-owned route is a
  `navPanel`, which BB lists in the sidebar navigation, visible by default, so a
  page that exists to be shown on its own costs a sidebar row. Split panes can
  be started only by dragging a sidebar row.
- **Workaround:** the pane's expand button navigates the current window to the
  walkthrough's nav panel route, a full page with a Thread button back. The nav
  panel's root lists recent walkthroughs so its sidebar row is not a dead end.
- **Possible API:** `useBbNavigate().openWindow({ pluginId, path, subPath })`
  that opens a BB window (a popup in browsers) at a plugin route, a way to open
  a nav panel in a split pane, and a `navPanel` option to omit its sidebar row.

## Link to a plugin page or thread panel from a list row

- **Status:** not filed
- **Observed:** BB 0.46.1, Plugin SDK 0.5.29
- **Use case:** Walkthrough's sidebar list and "Earlier walkthroughs" starter list
  should be real links, so a row can open in a new tab or copy its address.
- **Limit:** `useBbNavigate` exposes only imperative `toPluginPanel` and
  `openThreadPanel`; the SDK has no function that returns an `href` for a plugin
  nav panel route or a thread panel, and no link component for them.
- **Workaround:** each row is a `<button>` that calls `toPluginPanel` or `openThreadPanel`.
- **Possible API:** `useBbNavigate().hrefForPluginPanel(path, { subPath })`, or a
  `PluginLink` component that renders an anchor and handles modified clicks.

## Stream tool-call arguments, and deliver thread events faster than once a second

- **Status:** not filed
- **Observed:** BB 0.48.0, Plugin SDK 0.5.29 (Walkthrough redesign)
- **Use case:** Walkthrough shows a part on the page word by word while the
  worker writes it, so the first words appear in well under a second and a
  figure appears as soon as its header is complete
- **Limit and evidence:** (1) a tool call's arguments are not exposed until the
  call is complete: the only incremental data are `item/agentMessage/delta`
  events, so the worker must write the part twice, once as chat text and once as
  the `walkthrough_write_part` call. (2) `experimental_thread.events` is
  debounced to about one event per second per thread, too slow to drive text
  that should move every 100-200 ms. (3) `experimental_codeFenceRenderer`, which
  would render the same fenced markup inside a thread, exists only in SDKs newer
  than the pinned 0.5.29
- **Workaround:** the worker writes ```` ```walkthrough ```` fences as a hidden
  chat message before the tool call. A background service uses the debounced
  event only as a wake-up and polls `threads.events.list({ types:
  ["item/agentMessage/delta"] })` every 120 ms (backing off while quiet),
  publishing the text so far on a realtime channel at most every 60 ms. The
  markup stays identical to what the fence renderer would receive
- **Possible API:** partial tool-call argument events (`item/toolCall/delta`
  with the JSON text so far) in `threads.events`; an undebounced or
  configurable-interval subscription to selected event types for a plugin; and
  the code-fence renderer slot backported with feature detection

## Incremental agent-message text from every provider

- **Status:** not filed
- **Observed:** BB 0.48.x, Plugin SDK 0.5.29, a Pi-provider worker thread (`thr_kvaezpexxh`)
- **Use case:** Walkthrough shows a worker's message as it is written, so the first words appear in about a second
- **Limit and evidence:** the thread's event log holds exactly one `item/agentMessage/delta` per message, emitted when the message ends (6 deltas for 6 messages, 65 to 739 characters each). A plugin cannot tell a provider that streams from one that buffers, and on a buffering provider the preview arrives all at once after the whole message has been generated
- **Workaround:** the worker opens with a one- or two-sentence message before reading code, so something real is on screen within seconds whatever the provider does
- **Possible API:** a documented guarantee (or a capability flag per provider) that `item/agentMessage/delta` carries incremental text, and a `threads.events` field for whether the provider streams

## Staged changes and unchanged files in the environment diff APIs

- **Status:** not filed
- **Observed:** BB 0.48.x, Plugin SDK 0.5.29 (Walkthrough UAT: a repository with 11 staged files)
- **Use case:** Walkthrough must show a staged-only change, and the current lines of a file that has no diff (explaining existing code)
- **Limit and evidence:** `environments.diffPatch` and `diffFile` take `uncommitted`, `branch_committed`, `all` and `commit` targets; none names the index, and a file with no changes has no patch or side to read. In the UAT a staged-only change was reported as "No changes found" and a new staged file as "has no changes against HEAD"
- **Workaround:** a read-only host entry runs git itself (`git diff <base>` for the working tree, `git status --porcelain`, `git diff --numstat -M`), and BB's APIs are the fallback
- **Possible API:** a `staged` diff target, `includeUntracked` on `uncommitted`, and a `files.read`-like call that returns a workspace file at a revision (`HEAD`, the index, or the working tree)

## Retitle or replace a thread panel tab from inside it

- **Status:** not filed
- **Observed:** BB 0.48.x, Plugin SDK 0.5.29 (Walkthrough UAT round 2)
- **Use case:** the Walkthrough tab should read "Walkthrough: <title>" once the helper has named the walkthrough, whichever way the tab was opened, and the tab the starter lives in should become the walkthrough's own tab.
- **Limit:** a thread panel component receives `params` but cannot change them, rename its tab, or replace itself; `useBbNavigate().openThreadPanel` can retitle only a tab whose params match, from a component that was itself opened with those params. A tab opened from the + menu has empty params, so the starter renders the walkthrough inside its own tab and that tab stays titled "Walkthrough". The persisted tabs API (`threads.tabs.update`) can write a titled tab, but only for tabs the server adds itself.
- **Workaround:** the thread tool path writes a titled `plugin-panel` tab through `threads.tabs` when a walkthrough starts (so it also exists when no client is viewing the thread) and renames it when the plan arrives; a walkthrough started from the starter keeps the starter's tab, titled "Walkthrough".
- **Possible API:** `useBbNavigate().setThreadPanelTitle(title)` for the calling tab, and an `openThreadPanel({ replaceCurrent: true })` that swaps the calling tab's params.

## A header action that mounts without a thread view, and tab ids that are not derived by hand

- **Status:** not filed
- **Observed:** BB 0.48.x, Plugin SDK 0.5.29 (Walkthrough UAT round 2)
- **Use case:** when an agent tool starts a walkthrough while nobody is viewing the thread (or only another device is), the thread's Walkthrough panel must still lead to it.
- **Limit:** the only code that can open a panel is a component that is mounted in a client viewing the thread, so a walkthrough that began earlier is found only when someone loads the thread. The server can add a tab through `threads.tabs.update`, but the SDK has no helper for a plugin panel tab: its id is `plugin-panel:` + `encodeURIComponent("<pluginId>:<actionId>:<paramsJson>")` + `:none`, copied from what the host writes, and the bundled `tabs` types omit the `plugin-fixed` tabs that every thread carries, so a plugin has to round-trip tabs it cannot type.
- **Workaround:** `src/tabs.ts` reads the thread's tabs, appends or renames the plugin-panel tab with the host's own id, passes the other tabs through untouched, retries on a revision conflict, and never fails the walkthrough if the write is refused. The header action also opens a live walkthrough when a client first views the thread, and the starter shows a Continue card.
- **Possible API:** `threads.tabs.openPluginPanel({ threadId, actionId, params, title })` that is idempotent on the derived id, and bundled types that cover every tab kind the host returns.

## What a worker is doing between two messages

- **Status:** not filed
- **Observed:** BB 0.48.x, Plugin SDK 0.5.29 (Walkthrough UAT round 2: an 11 s silence while the helper read files)
- **Use case:** say honestly that the helper is reading while the page is quiet.
- **Limit and evidence:** `item/started` events carry an `item.type` (`commandExecution`, `reasoning`, `agentMessage`, ...) whose set and fields differ by provider; there is no provider-neutral "the agent read this file" event, so a plugin can count steps but not name files.
- **Workaround:** the tail counts `item/started` events that are not reasoning, messages or this plugin's own tools, and the pane says "Looking through the code · N steps so far". It does not claim a number of files.
- **Possible API:** a normalized `thread.activity` event (`read`, `search`, `run`, with a path when there is one) that is the same on every provider.
