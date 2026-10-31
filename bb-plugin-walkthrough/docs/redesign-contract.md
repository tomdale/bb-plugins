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

## Polish requests

### From UX (open)
The pane builds against these shapes and degrades when they are absent.

- `view.coverage`: `{ files: Array<{ path: string; covered: boolean }> } | null`. Every file the reviewed change touches, and whether at least one figure shows lines of it. `null` or absent hides the coverage strip. The introduction and wrap-up list covered and not-covered files.
- `part.staleFiles?: string[]`: on a delivered part, the files that part cites which changed after it was written (empty when none did). When the field is present the "out of date" notice and picker status appear only if it is non-empty; when absent the pane falls back to the whole-change fingerprint.
- `handOff` accepts optional `message: string`: the text sent to the thread in place of the generated one. "Ask the thread to apply it" prefills the generated text, lets the reader edit it, and sends the edit only when it differs from the generated text.
- `detectTarget` `uncommitted` target gains optional `staged: number` (files with staged changes, counted within `files`). The starter reads "5 files, 3 staged" and re-polls while it is open, so detection must be cheap to repeat.
- A snapshot `headSha`/`baseSha` is read as the revision a figure was captured at. In PR mode `walkthrough.pr.url` is the base for "Open on GitHub" (`<pr url>/files`; there is no per-file permalink without the repo slug, so the figure links to the PR's blob for `headSha` when `pr.url` parses as `https://github.com/<owner>/<repo>/pull/<n>`).
- SDK limit (for `docs/bb-sdk-wishlist.md`): a thread panel tab cannot change its own `params` or be replaced. The starter therefore renders the new walkthrough inside its own tab; a reload of that tab shows the starter again, with the walkthrough listed under Earlier walkthroughs.
