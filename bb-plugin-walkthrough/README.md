# bb-plugin-walkthrough

Walk through a changeset one conceptual group at a time inside a BB thread.
The agent groups the diff by concept, explains each group, and pauses; BB
renders the pause, the notes, the diffs, and the PR review draft as native UI.

The workflow is the `tdx-walkthrough` skill's workflow (Overview → Review →
Finish, local or PR mode), carried by the bundled `bb-walkthrough` skill and
the plugin's agent tools.

## Start

Open a thread in the checkout you want to review and ask, for example:

- "Guide me through this PR for review."
- "Walk me through the changes you just made."

The composer's **+** menu also has **Start a walkthrough**.

## Surfaces

| Surface | What it does |
| --- | --- |
| Pause controls | Replace the composer at every pause: continue to the next group, finish early, ask a question (or pick a suggested one), and record a question, todo, comment (PR mode), or note against the current group or one of its files. Typing `.next`, `.finish`, `.notes`, or `.todo <text>` there works too. |
| Walkthrough panel | Thread side panel with the outline and per-file diffs against the base, the notes list (add, edit, resolve, reopen, delete), the notes-file toggle, and the PR review draft with a Post action. Opens when a walkthrough starts. |
| Header chip | Shows progress and open notes; opens the panel. |
| Chat directives | `::walkthrough-outline` renders the live outline; `::walkthrough-diff{path="…" lines="a-b"}` renders the real hunk for a file range. |
| Message action | **Add to walkthrough notes** turns a selected passage of an agent message into a quoted note. |
| Command palette | **Walkthrough: open panel for this thread**. |

Notes live in the plugin's SQLite database and are mirrored to
`<session-root>/.agent/review-notes.md` on the thread's host once the first
note exists.

## Agent tools

`walkthrough_start`, `walkthrough_pause`, `walkthrough_advance`,
`walkthrough_update_outline`, `walkthrough_note`, `walkthrough_status`, and
`walkthrough_review`. `walkthrough_pause` opens the pause controls with
`bb.ui.requestInput`; the user's choice returns as its result and resumes the
agent. The plugin applies every state transition itself, so the panel and the
notes file always match what the agent sees. Nothing is ever posted to
GitHub without an explicit user request.

## Settings

`autoOpenPanel` (default on): open the Walkthrough panel when a walkthrough
starts.

## Development

```sh
npm install
npm test          # vitest: model, fake-host server, pause form
npm run typecheck
bb plugin build
bb plugin install .   # path install; then `bb plugin dev` for live reload
```
