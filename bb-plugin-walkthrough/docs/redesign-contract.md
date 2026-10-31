# Redesign build contract

Source of truth for the visual design: `docs/redesign-spec.md` and the interactive `docs/notebook-mockup.html` (open it in a browser; match it closely). Two workstreams edit the same package in parallel; stay inside your ownership.

## Ownership
- **UI** owns `app.tsx`, `src/ui/**`, `components/**`, styles, fonts/assets, `tests/*.test.tsx`.
- **Backend** owns `server.ts`, `host.ts`, `src/*.ts` (not `src/ui`), `skills/`, `tests/*.test.ts`, `src/rpc.ts`, `src/schemas.ts`.
- Do not edit the other's files. If you need a change there, add it to the "Requests" list at the bottom of this file and continue with a reasonable assumption.

## Schema additions (Backend adds; UI may rely on them being optional with these defaults)
- `codeBlock.view`: `"diff" | "code"`, default `"diff"`. The agent picks; `code` shows current source only (no Diff/After/Before switch), `diff` shows the switch.
- `codeBlock.snapshot`: `{ change: string|null, after: string|null, before: string|null, baseSha: string|null, headSha: string|null, capturedAt: number } | null`. Excerpt text is saved when the part is written; the UI renders from the snapshot first and never shows raw git errors. `null` for walkthroughs that predate it (fall back to the existing `excerpt` RPC, and on failure show one muted line, "This code is no longer on disk").
- `partSchema.suggestions` already exists: 2-3 agent-written questions per part, shown above the pager input; refreshed from the latest answer when the worker supplies new ones (`exchange.suggestions?: string[]`).
- `walkthrough.intent`: `"review" | "own-change" | "understand"`, default derived from `mode` (`pr` -> review, `local` -> own-change). Drives the wrap-up primary action.
- `walkthrough.pacing`: parts are written one ahead of the reader; `part.status` already has pending/writing/ready/failed.
- Notes: `kind` keeps `question|todo|comment|note` (UI labels "Ask" for question). Add `includeInReview: boolean` (default `false`; comments default `true`). The review draft's inline comments are derived from included comments plus anything the worker drafted.
- The `.agent/review-notes/` mirror is removed (setting, RPC `setNotesFileEnabled`, and UI).

## Pane behavior
Per `docs/redesign-spec.md`. UI states: skeleton before part 1; part picker statuses; reduced motion and reduced transparency honored; light and dark follow BB's mode (read BB's theme tokens or `prefers-color-scheme` as the SDK allows).

## Requests
(append below)

## Backend API
Implemented by Backend. Everything below is optional on the wire for old data; the store backfills it, so the pane always receives populated values.

### Data (`src/schemas.ts`)
- `codeBlock.view`: `"diff" | "code"`, always present on delivered blocks (default `"diff"`). The worker sets it per block in `walkthrough_write_part`.
- `codeBlock.snapshot`: `{ change, after, before, baseSha, headSha, capturedAt } | null`, captured when the part is committed. `null` for walkthroughs that predate snapshots, or when capture failed.
- `codeBlock.snapshotError`: `string | null`. A short, reader-safe reason `snapshot` is null (for example "This code isn't in the reviewed revisions."). Never raw git output. Absent/null when there is no failure (or for old rows: show "This code is no longer on disk" after the `excerpt` RPC also fails).
- `walkthrough.intent`: `"review" | "own-change" | "understand"`, always present on delivered walkthroughs; set by the planner, default `pr` -> `review`, `local` -> `own-change`. Before planning (state `planning`) it is the mode default.
- `walkthrough.notesFile`: retired; delivered only for old rows. Do not read it.
- `note.includeInReview`: `boolean`, always present on delivered notes (comments default `true`, other kinds `false`).
- `exchange.suggestions?: string[]`: follow-ups the worker set while answering. Show the latest exchange's suggestions when present, else `part.suggestions`.
- `part.status`: while part 1 is being written in the plan turn it is `writing`; parts after the reader's next one stay `pending` until the reader opens or asks.

### RPC
- `get` -> `view` now also carries `reviewDraft`: `{ body, event, comments, status, url, updatedAt } | null`. In PR mode it is the worker's draft merged with open comment notes that have `includeInReview` and a location; each such comment carries `noteId`. `null` outside PR mode or when there is neither a draft nor an included comment. Prefer it over `walkthrough.review` for the Review drawer. Worker-drafted comments have no `noteId`.
- `addNote` accepts optional `includeInReview` (defaults per kind).
- `updateNote` accepts optional `includeInReview`. Changing `kind` away from or to `comment` resets the default for the new kind unless `includeInReview` is also sent.
- `excerpt` is unchanged except that its `unavailable.message` is now a short reader-safe string.
- `requestReviewPost` now works when the merged draft exists, even if the worker has not saved a draft of its own.
- Removed: `setNotesFileEnabled`, and the `.agent/review-notes` file writing.
- Unchanged: `list`, `recent`, `start`, `openPart`, `ask`, `reply`, `retry`, `wrapUp`, `close`, `handOff`, `deleteNote`, `diff`.

### Agent tools (for reference)
- `walkthrough_plan` accepts optional `intent`; its instructions ask the worker to call `walkthrough_write_part` for part 1 in the same turn.
- `walkthrough_write_part` blocks accept optional `view` on code blocks; `snapshot` is rejected (the plugin captures it). The result names code blocks it could not read.
- New `walkthrough_suggest { suggestions: string[] }`: refreshes `exchange.suggestions` for the answer in flight; errors outside an answer.
- Instructions are split per tool (`WORKER_GUIDE` plus each tool's `instructions`); `tests/redesign.test.ts` checks every one is under 4,096 characters.

### From UI (open)
- `addNote` and `updateNote` should accept `includeInReview?: boolean`. The UI sends it only from the Include in review checkbox (`updateNote`), and relies on the contract default for comments (`true`) and everything else (`false`). Until the schema accepts it, the checkbox's write fails with the strict-schema error toast.
- `requestReviewPost` should work from included comments when there is no worker-drafted review (`walkthrough.review === null`). The wrap-up's Post review and the Review draft tab enable the button from included comments alone and show them in the confirmation dialog.
- Understand intent has no real "Save notes" action yet: the UI copies the open notes as Markdown to the clipboard. A `saveNotes` RPC (or a documented place the notes persist) would let the button do more than copy.
- A part saved with `status: "writing"` may carry `blocks`, and an exchange's `answer` may grow while `status: "answering"`; the UI renders both. Live text arrives through the stream (see Streaming API); the saved fields stay authoritative.
- Starter detection uses only the SDK's `experimental_useSidebarThreadPullRequest` (PR number, title, state). A `detectTarget` RPC returning the branch name, base, changed-file count and whether the tree is dirty would let the starter say "12 files on tomdale/x, compared with main" instead of the generic "Changes on this branch".

## Streaming API

While a plan, part write, or answer is in flight, the plugin follows the worker's message text and publishes it so the pane can show it as it is written. The text is a hidden preview; the committed walkthrough (`get`) is authoritative, and a part that is `ready` never reads from the stream.

### Channel and payload
Realtime channel `walkthrough-stream` (`STREAM_CHANNEL`). Payload (`StreamPayload`, `streamPayloadSchema` in `src/schemas.ts`):

```ts
{
  walkthroughId: string,
  requestKind: "plan" | "write" | "ask",
  place: number | "wrap-up",   // part index; 0 for the plan turn (introduction + part 1)
  seq: number,                 // highest worker event consumed; never decreases per walkthrough
  text: string,                // the whole message so far (at most 200,000 characters), not a delta
  state: "streaming" | "done" | "failed" | "cancelled"
}
```
- `state` carries what a `final` flag would: `streaming` is a live payload; `done`, `failed` and `cancelled` are the one terminal publish, which follows the last live one. A terminal payload may repeat the last live `seq`.
- A client keeps the latest payload per `(requestKind, place)` and replaces it when `seq` is higher, or when it equals the held `seq` and the new state is terminal. Duplicates and older payloads are ignored. Realtime signals are not replayed, so a client refetches `streamSnapshot` after a reconnect.
- Cadence: the tail polls about every 120 ms (up to 300 ms while the worker is quiet) and publishes at most every 60 ms per walkthrough, so a delta reaches the channel within about 150 ms. It stops when nothing is in flight. `ask` streams the latest message (the answer); `plan` and `write` stream the message that holds ` ```walkthrough ` fences. A request that ends without text publishes nothing.
- `failed` and `cancelled` payloads are never previewed; the pane shows the committed failure instead.

### RPC `streamSnapshot({ walkthroughId })`
Returns `{ snapshot: StreamPayload | null }`: the in-flight request's text so far, read from the stored events, with `state: "streaming"`. `null` when nothing streamable is in flight (including wrap-up). The pane calls it on opening, when a new request starts, and after a realtime reconnect.

### Markup
Parsed by `parseStreamMarkup` in `src/stream-markup.ts` (pure, total, incremental: every block of a prefix's parse is a prefix of the same-index block of the longer text's parse). Prose is Markdown. Figures and markers are fences whose language is `walkthrough`; the first key decides the kind.

````
The cap bounds the key before it is looked up.

```walkthrough
path: src/server.ts
lines: 40-52
view: diff
caption: Looking up the key, in server.ts
note 42: Truncates here.
```

```walkthrough
suggestions:
- What if the cap truncates mid-word?
- Who calls the helper?
```
````
- Figure keys: `path`, `lines` (`40-52` or `40`), `view` (`diff` or `code`), `caption`, `note <line>: text` (up to 8). `path`, `lines` and `view` count once their line ends with a newline; `caption` and note text show as they stream. A figure is shown when `path` and `lines` are known.
- A ` ```walkthrough ` fence with `part: <n>` (and optional `title:`) marks where part `n` begins in the plan turn: text before it is the introduction, text after it is part 1.
- A final fence with `suggestions:` lists one question per line. Suggestions show when their fence closes; the message is `complete` then.
- Other fenced code, including code that mentions `walkthrough`, is prose. A partial fence opener at the end of the text is withheld rather than shown as prose.
- The markup is identical to what `experimental_codeFenceRenderer` would receive in a newer SDK.

### What the pane does
`useStreams` (`src/ui/hooks.ts`) follows the channel and `streamSnapshot`; `src/ui/stream.ts` folds payloads, picks the ones that may be previewed, and turns markup into the same block shapes committed parts use.
- A payload is previewed only for the request in flight and only when its `seq` is above that request's `afterSeq`; a retry never shows its predecessor's text. Once a request ends normally, its `done` payload stays until the committed result arrives.
- The plan turn's introduction shows on the introduction page while the walkthrough is planning; part 1's markup shows on part 1.
- Prose appears as it arrives. The open prose block and an open figure carry a subtle pulsing dot (`wt-streaming`, `data-streaming`), which reduced motion removes. A figure appears when its header is complete and renders from the `excerpt` RPC until the saved snapshot exists. Suggestions appear above the pager, disabled, when their block closes.
- An answer streams into its exchange in the margin thread; the exchange's `status` and saved `answer` take over when it settles.
- Streamed and committed content render through the same components with the same keys, so when `get` returns the ready part the elements stay in place and only their content settles.

## Backend API: polish pass

Everything here is additive and optional on stored data; the store and `deliverView` backfill it, so old walkthroughs and notes load unchanged.

### The view (`get`)
`view` now also carries:

```ts
{
  coverage: {
    changed: number,            // every changed file, excluded ones included
    files: Array<{
      path: string,
      status: "added" | "modified" | "deleted" | "renamed",
      additions: number | null, // null for binary files
      deletions: number | null,
      covered: boolean,         // a committed figure or a written part's location cites it (a rename's old path counts)
      excluded: "lockfile" | "generated" | "binary" | null, // listed, but not counted against coverage
      plannedIn: number | null  // 0-based part still to be written that is planned to cite it
    }>,
    covered: string[],          // paths cited
    uncovered: string[],        // paths nothing cites yet, excluding lockfiles/generated/binary
    notShown: string[],         // the excluded files nothing cites, listed so the reader knows they were skipped
    truncated: boolean,         // more files changed than were listed (2,000)
    capturedAt: number
  } | null,                     // null until the changed files are known, and without a workspace
  copy: { subtitle: string, skeleton: string, introduction: string }
}
```
- `coverage` is computed in `src/coverage.ts` from `walkthrough.changeSet` (the host's `changedFiles`: committed, staged, unstaged and untracked work against the base, renames detected, or the PR's base..head) and the figures of ready parts and the wrap-up. Lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, ...) and generated files (`dist/`, `*.min.js`, `*.snap`, `*.generated.*`, `*.pb.go`, ...) are matched by name and path. The change set is refreshed when the thread's agent finishes a turn, when the reader opens a part, and after planning; a PR's is read once.
- `copy` depends on the walkthrough's intent: `understand` reads "How this code works today" / "Reading the code and deciding how to explain it…" / "Overview"; own-change and review keep the "compared with <base>" wording. Before planning the copy is neutral ("Getting ready"), because the intent is only the mode's default until the worker chooses. Use `copy` instead of building change-review strings; the pane's own "Reading the change…" and "compared with HEAD" strings should go.
- `walkthrough.timing?: Record<string, number>`: milliseconds after `createdAt` for `forked`, `workerReady`, `planSent`, `firstText`, `planned`, `part1Ready`. Measurements only.

### Staleness is per part
`part.staleFiles: string[]` is always present on delivered parts: the files the part cites (its figures' paths and its locations) whose working-tree contents changed after the part was written; empty when none did. (This is the brief's `part.stale`, as a list of changed paths.) A part records a content hash of each cited file when it is written (`part.citedHashes`) and the server compares them with the files as they are on thread idle and when a part opens; work in unrelated files leaves a part alone. Parts written before this, and PR walkthroughs (pinned to the head commit), are never marked. The old whole-change `codeFingerprint` and `isOutdated` still exist for rows without hashes; the pane should show "out of date" when `staleFiles` is non-empty and name the files.

### Figures always show code
- Code is read by the host first (`readCode` in `host.ts`), then BB's diff APIs as a fallback. The host reads git directly, so a staged-only file, a new or untracked file, a rename (shown as a deletion and an addition of its two paths), a deletion, and an unchanged file all have a snapshot. An understand walkthrough's figures (baseRef `HEAD`, `view: "code"`) snapshot the current lines of the working tree (or the PR head) with `snapshot.change` null, never "no changes against HEAD".
- Snapshot lines longer than 2,000 characters are cut with a visible marker; line counts never change. Binary files and files over 1 MB have `snapshot: null` and a reader-safe `snapshotError`.
- A write whose figures failed for a passing reason (a timeout, an unreadable file) is retried once within the write. A figure still without code is repaired when the walkthrough next looks at the workspace (thread idle, part opened), unless the failure is permanent (binary, too large).
- "Has no changes against X" no longer reaches the reader; the fallback says "has no changes to show".

### Target detection (`detectTarget`)
The `uncommitted` target counts staged, unstaged and untracked work together, read from the host's git, with BB's environment status as the fallback:
`{ kind: "uncommitted", files, additions, deletions, staged?, unstaged?, untracked? }`. `files` is the number of changed files (a file with both staged and unstaged edits counts once); `staged`, `unstaged` and `untracked` count files in each state and are absent when only BB's status answered. It is cheap to repeat (two git calls).
The plan request tells the helper what the working tree holds (counts, up to 20 files with status and `+/-`, and how to read staged and untracked work), read while the fork is provisioning so it never delays the request.

### Notes: the helper proposes, the reader resolves
- `note.proposedResolution: string | null` (always present on delivered notes). The helper can never resolve a note. `walkthrough_note` takes `proposedResolution`; if the helper sends `status: "resolved"` or a `resolution`, the plugin keeps the text as a proposal and the note stays open. The wrap-up instructions say so. A review draft's `coveredNotes` also become proposals (`"Included in the draft PR review."`); while such a proposal is pending, its comment is not derived into the draft a second time.
- RPC `acceptResolution({ walkthroughId, noteId })` resolves the note with the proposal as its `resolution`. RPC `dismissResolution({ walkthroughId, noteId })` clears the proposal. Both return the note. `acceptResolution` errors when there is no proposal. A reader's own edit to a note's text, kind or status clears a pending proposal.
- UI: show the proposal on the note ("Suggested: ...") with Accept and Dismiss; the wrap-up ledger counts a note with a proposal as open.

### Answer text
The `:::reply{...}` ... `:::` wrapper the helper may inherit from its thread is removed on the server: stored answers, `exchange.answer`, the streamed `ask` text and `streamSnapshot` never carry it, including while the opener is half-written (text shows nothing until the opener line is complete, then only the content). The helper is told not to write one. `src/reply-wrapper.ts`; the pane's own stripper is now redundant but harmless.

### Hand-off to the thread
- `prepareHandOff({ walkthroughId })` -> `{ draft: { message: string, noteIds: string[] } | null }`. Sends nothing. `message` is the text "send open items" and "ask the thread to apply it" would send (the intro depends on the intent); `noteIds` are the notes it covers. Null when no unsent todo or question is waiting.
- `handOff({ walkthroughId, message?, noteIds? })` -> `{ sent }`. The only call that sends to the user's thread. The pane calls it only from an explicit Send in an editable field, with the text shown (edited or not) and the prepared `noteIds`; the notes it covers are marked sent. Without `message` it sends the prepared text, so no pane control may call it that way before the reader has seen the text.

### Host entry (`host.ts`)
`changedFiles({ path, baseRef, headRef?, includeUncommitted })` and `fileHashes({ path, paths })` join `readCode`. The first returns `{ files: [{ path, oldPath, status, additions, deletions, binary, origins }], staged, unstaged, untracked, truncated, branch }`, where `origins` is any of `committed | staged | unstaged | untracked`.

### Agent tools
- `walkthrough_open`: its description, instructions and the `bb-walkthrough` skill name explain-the-code requests ("walk me through how X works", no diff needed) and tell the agent to call it instead of answering in chat. The result says whether the pane is open beside the thread now (when `autoOpenPanel` is on) or where to open it (when it is off).
- `walkthrough_plan.introduction` and `walkthrough_write_part.blocks` / `suggestions` are optional: left out, the plugin reads them from the helper's finished streamed message (`src/stream-commit.ts`), so the helper says each part once. A tool call that cannot find its message waits up to 2 s, then tells the helper to pass the content itself. Passing blocks still works.
- Understand intent: the plan and write instructions ask for `view: "code"` excerpts of the code as it stands and ban change-review words.
- `walkthrough_note` takes `proposedResolution` (see Notes).

## First paint and pacing (investigation)

Reports: 20-28 s to the first words and part 1 only at 50-130 s on the tool-initiated path; whole-part arrival with one provider and chunks with another; one failed first write with unreadable figures.

What the code and a recorded real worker thread show (thread `thr_kvaezpexxh`, a spawned worker on a PR review, read with `bb thread log`; the redesign-era workers are gone, so this is the pre-redesign flow):
- The provider emits one `item/agentMessage/delta` per message, at the end of the message (6 deltas for 6 messages in the log): no incremental text. "Chunked" arrival comes only from providers that stream deltas. The tail adds 0.1-0.3 s on top of when BB stores the event (`scripts/measure-stream.ts` on the real deltas: first block 104 ms after the delta, publish delay median 106 ms, p95 270 ms).
- Tool-call arguments arrive complete at `item/started`; generating them is invisible. In the log, the plan call's 2.8 KB of arguments took 9.5 s to generate and a 2.1 KB part write 8.3 s, at about 280 characters per second.
- Before any text, the worker spent about 4.3 s starting, then 26 s over seven tool steps (reading skill files, a todo list, `gh`, `git`); the model's per-step latency was 4-9 s. The old worker guide told it to "use the tdx-narrative style when available", which made it open skill files.
- The old protocol made the worker write the introduction and part 1 as a message, then again as the `walkthrough_plan` introduction, then again as `walkthrough_write_part` blocks: about 2,600 + 700 + 2,100 characters, about 20 s of generation, where one saying would do.
- Streamed markup does reach the pane before the commit on this path, but only if the worker writes the message before the tool calls, and on a whole-message provider "reach" means the whole message at once, 5 to 13 s ahead of the commit.
- `walkthrough_open` (tool) and the starter both call `service.start`: the same fork, the same plan request, the same tail. The one difference is the thread: a tool call runs inside the user's turn, so the fork happens while that thread is active, which the starter's idle thread never does. The code cannot say what BB's fork of a running thread contains or how long it takes to go idle (`waitUntilReady` allows up to 30 s); `walkthrough.timing` (`forked`, `workerReady`, `planSent`) now records it for the next real run. Starter runs in the reports reached part 1 in 26 s, tool runs in 130 s, but they differed in request and diff size too.

Changes: the worker opens with a one- or two-sentence message before reading (first words at about 5 s instead of 30-40 s); it no longer reads skill files or keeps a todo list; it says each thing once and the plugin commits from the message (`blocks`, `introduction` and `suggestions` optional); the working-tree summary is read while the fork provisions; figures that failed for a passing reason are retried and later repaired.

Measured on a fake worker (`tests/first-paint.test.ts`: the real service, tail and tools on a virtual clock, stage durations taken from the recorded thread; `FIRST_PAINT_REPORT=<file>` writes the table). Seconds after the request:

| worker protocol / provider | first words | plan committed | part 1 committed |
| --- | --- | --- | --- |
| before: says it twice / whole message | 39.5 | 40.6 | 47.3 |
| after: says it once / whole message | 5.0 | 41.0 | 41.2 |
| before: says it twice / chunked | 30.8 | 40.6 | 47.3 |
| after: says it once / chunked | 4.7 | 41.0 | 41.2 |

Not measured on a real model: whether the worker follows the new order (opening message first, no repeated content), the real time to fork a running thread, real provider chunking, or the 4.3 s start and 26 s read, which are one recorded PR review. The table measures the protocol, not a model; a reading step that takes longer moves every row by the same amount.

## Polish requests

### From UX (answered by Backend; see "Backend API: polish pass")
The pane builds against these shapes and degrades when they are absent.
- Answered: `view.coverage` has `files[].path` and `covered` plus the covered/uncovered/notShown lists; `part.staleFiles` is always present; `handOff` takes `message` and `noteIds` (with `prepareHandOff` for the default text); `detectTarget` reports `staged`, `unstaged` and `untracked`.

- `view.coverage`: `{ files: Array<{ path: string; covered: boolean }> } | null`. Every file the reviewed change touches, and whether at least one figure shows lines of it. `null` or absent hides the coverage strip. The introduction and wrap-up list covered and not-covered files.
- `part.staleFiles?: string[]`: on a delivered part, the files that part cites which changed after it was written (empty when none did). When the field is present the "out of date" notice and picker status appear only if it is non-empty; when absent the pane falls back to the whole-change fingerprint.
- `handOff` accepts optional `message: string`: the text sent to the thread in place of the generated one. "Ask the thread to apply it" prefills the generated text, lets the reader edit it, and sends the edit only when it differs from the generated text.
- `detectTarget` `uncommitted` target gains optional `staged: number` (files with staged changes, counted within `files`). The starter reads "5 files, 3 staged" and re-polls while it is open, so detection must be cheap to repeat.
- A snapshot `headSha`/`baseSha` is read as the revision a figure was captured at. In PR mode `walkthrough.pr.url` is the base for "Open on GitHub" (`<pr url>/files`; there is no per-file permalink without the repo slug, so the figure links to the PR's blob for `headSha` when `pr.url` parses as `https://github.com/<owner>/<repo>/pull/<n>`).
- SDK limit (for `docs/bb-sdk-wishlist.md`): a thread panel tab cannot change its own `params` or be replaced. The starter therefore renders the new walkthrough inside its own tab; a reload of that tab shows the starter again, with the walkthrough listed under Earlier walkthroughs.
