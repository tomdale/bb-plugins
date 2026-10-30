# bb-plugin-walkthrough

A reading view for understanding a code change. From any BB thread, open
**Walkthrough** from the thread panel launcher or ask the agent to walk you
through something, and a pane opens beside the thread. A helper agent, forked
from the thread so it knows the conversation, explains the change part by part
in plain prose with real code excerpts. The original thread keeps working while
you read.

## The page

The pane is a notebook page, not a dashboard. One part is on screen at a time;
there is no rail and no contents list.

- **Page:** a serif column with the part number in a ruled left margin. Code
  figures break out of the column. Notes hang in the right margin as
  marginalia on a wide window and stack under the figure at panel width
  (about 480px).
- **Top bar:** the title, a part picker ("3 of 5", with each part's status:
  ready, writing, not started), the **Concerns** toggle with its count, and an
  overflow menu (full page, finish, back to thread).
- **Pager:** **Previous**, **Next: <part name>**, a question box scoped to the
  current part (or to the text you selected), and two or three suggested
  questions the helper wrote with the part.
- **Concerns sheet:** everything you flagged, in one list: note, todo,
  comment, ask. It slides over the page from the right (full width in the
  narrow pane) and never reflows it. **Esc** closes it.
- **Figures:** the helper picks per figure. A **diff** figure has a Diff /
  After / Before switch; a **code** figure shows the current source with no
  switch. The excerpt text and the base and head commits are saved when the part
  is written, so a figure still shows after the code moves on, and never shows a
  raw git error; a missing workspace gives one muted line.

## Using it

- **Start:** when an agent calls `walkthrough_open` the walkthrough starts at
  once. Opening the pane by hand shows a starter that says what a manual start
  covers, with one button and an optional focus line, above your earlier
  walkthroughs:
  - **PR #12 · Add the thing**, for an open pull request on the thread's branch;
  - **Uncommitted changes · 4 files, +120 −30**; or
  - **Branch changes · 4 files, +120 −30**, committed work against its merge
    base.
- **Read:** Previous and Next move through the introduction, the parts, and the
  wrap-up. The helper writes one part ahead of you and waits; opening the next
  part (or asking about it) brings the one after.
- **Ask:** type in the pager box, or select text and choose **Ask** to scope the
  question to it. The answer streams into a margin thread under that part, and
  the suggestions refresh from it.
- **Flag:** select text or lines of code and choose **Note**, **Todo**,
  **Comment** (PR reviews), or **Ask**. Each flag is anchored to its part and
  line. In the Concerns sheet, tick **Include in review** to add a comment to
  the review draft.
- **Wrap up:** the last part is a ledger (open items, questions answered, parts
  skipped) with one primary action chosen by what you are doing:
  - *Reviewing a PR:* **Post review** shows exactly what will be posted and
    waits for confirmation, then asks the helper to submit it, publicly, as your
    `gh` account. Nothing reaches GitHub without that step.
  - *Your own or an agent's change:* **Send open items to thread** posts the
    open todos and questions to your thread's agent.
  - *Understanding only:* **Save notes** writes your open notes as a Markdown
    file and shows where it went; **Ask the thread to apply it** sends the todos
    and questions.
- **Save notes:** the file goes to `walkthrough-notes/<title>-<id>.md` in the
  walkthrough thread's own storage, which is outside your repository, so it never
  appears as untracked work. The same file is replaced each time. Nothing else is
  written to your workspace; there is no notes mirror.
- **Full page:** the overflow menu opens the walkthrough as a page of the BB
  window; the **Walkthroughs** sidebar entry lists recent walkthroughs from
  every thread.
- **Finish:** **Finish walkthrough** stops the helper (you can still read it
  afterwards) and asks first unless every part is written.
- **Staying current:** your thread keeps working while the walkthrough is
  written. The helper is told what you said there, and a part written against
  code that has since changed is marked out of date with a one-click rewrite.
- **PRs:** excerpts of a PR walkthrough come from the PR's head commit, not from
  the checkout, so a merged PR or another branch still shows the PR's own code.

## How it works

The plugin owns the walkthrough state (SQLite) and drives a hidden fork of the
user's thread one request at a time: plan (the plan turn also writes part 1),
write a part, answer a question, wrap up. The worker delivers content through
its tools (`walkthrough_plan`, `walkthrough_write_part`, `walkthrough_suggest`,
`walkthrough_wrap_up`, `walkthrough_note`, `walkthrough_review`,
`walkthrough_status`); ordinary threads get one tool, `walkthrough_open`.

**Streaming.** Before committing a part the worker writes it as text with
```` ```walkthrough ```` fences. The plugin tails the worker's
`item/agentMessage/delta` events in a background service every 100-200ms and
publishes the message so far on the `walkthrough-stream` realtime channel;
`streamSnapshot` serves a client that joins mid-stream. `src/stream-markup.ts`
parses the fences incrementally, so a part can reach the page before the worker
commits it. See `docs/redesign-spec.md` for the markup and the timing budget.

**What the pane receives.** `get` returns a view whose fields are all populated:
`src/deliver.ts` fills `intent`, each code block's `view`, `snapshot` and
`snapshotError`, and each note's `includeInReview`, so the pane reads them
directly. `reviewDraft` is the worker's draft merged with the open comments you
included; the Concerns sheet and **Post review** read it instead of assembling
their own.

**Intent.** The planner sets `intent` (`review`, `own-change`, `understand`),
which defaults from the mode. It decides which primary action the wrap-up offers.

**Code.** Excerpts inside the thread's workspace use BB's environment diff APIs.
Absolute paths in another checkout use a read-only host entry that resolves the
file's Git repository and compares against the walkthrough's base there. File and
line links open BB's preview using workspace-relative paths or an explicit host
target.

**Target detection.** `detectTarget` reads the thread's environment through the
SDK (`environments.pullRequest` and `environments.status`) and answers with the
PR, the uncommitted change counts, or the committed branch change counts; it
answers null when the thread has no workspace or nothing has changed.

## Settings

`autoOpenPanel` (default on): open the pane when an agent starts a walkthrough.

## Development

```sh
npm install
npm test          # vitest: model, fake-host orchestration, and the pane
npm run typecheck
npm run build     # bb plugin build
bb plugin install .   # path install; then `bb plugin dev` for live reload
```

`scripts/bb-plugin-smoke .` (from the repository root) activates the built
plugin in a throwaway BB. To look at the real pane, boot a throwaway server with
`NODE_ENV=production` (so it serves the web app), install the build, seed a
walkthrough through `WalkthroughStore`, and open
`/plugins/walkthrough/walkthroughs/<id>` with headless browser automation.
