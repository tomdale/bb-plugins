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
