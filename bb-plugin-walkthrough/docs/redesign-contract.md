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
- A part streamed with `status: "writing"` may carry `blocks` as they arrive: the UI renders those blocks and a skeleton for the rest, and an exchange's `answer` that grows while `status: "answering"` renders incrementally. Without partial blocks the UI shows a layout skeleton until the part is `ready`.
- Starter detection uses only the SDK's `experimental_useSidebarThreadPullRequest` (PR number, title, state). A `detectTarget` RPC returning the branch name, base, changed-file count and whether the tree is dirty would let the starter say "12 files on tomdale/x, compared with main" instead of the generic "Changes on this branch".
