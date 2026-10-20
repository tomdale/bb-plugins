# bb-plugin-walkthrough

A reading view for understanding a code change. From any BB thread, open
**Walkthrough** from the thread panel launcher or ask the agent to walk you
through something, and a pane opens beside the thread. A helper agent, forked
from the thread so it knows the conversation, explains the change part by part in
plain prose with real code excerpts. The original thread keeps working while
you read.

## Using it

- **Start:** the thread panel launcher opens a starter with suggestions ("The
  changes on this branch", "This PR, for review", "The code we've been talking
  about", "The changes you just made") or your own words. Asking the thread's
  agent to walk you through something opens the same pane.
- **Read:** an introduction, then one part at a time: prose with short code
  excerpts (switch between change, after, and before), margin notes, and a
  contents list when the pane is wide. Maximize the pane for full-width
  reading. The next part is written while you read the current one.
- **Full page:** the expand button in the pane header opens the walkthrough as
  a page of the BB window, without the thread beside it; **Thread** in its
  header returns. The **Walkthroughs** sidebar entry lists recent walkthroughs
  from every thread and opens any of them as the same page.
- **Ask:** every part ends with a conversation. Suggested questions get you
  started; ask anything in your own words. `.todo …` or `.question …` in the
  box saves a note instead.
- **Note:** select any text or code and choose **Leave a note**, or use the
  Notes drawer. Notes can point at a file and line range, and are mirrored to
  `.agent/review-notes/<walkthrough id>.md` in the workspace (the folder ignores itself in Git).
- **Wrap up:** the helper answers recorded questions, reports what is still
  open, and offers follow-ups. In PR reviews it drafts a review on request;
  the Review drawer previews it and **Post…** asks the helper to submit it.
  Nothing reaches GitHub without that explicit step.
- **Hand off:** **Send open notes to my thread** posts the open todos and
  questions, with their parts, quotes, and files, to your thread's own agent.
  The helper never edits your code; it records a todo instead.
- **Staying current:** your thread keeps working while the walkthrough is
  written. The helper is told what you said there, and a part written against
  code that has since changed is marked out of date with a one-click rewrite.
- **PRs:** excerpts of a PR walkthrough are read from the PR's head commit, not
  from whatever the checkout holds, so a merged PR or another branch still shows
  the PR's own code.

## How it works

The plugin owns the walkthrough state (SQLite) and drives a hidden fork of
the user's thread one request at a time: plan, write a part, answer a
question, wrap up. The worker delivers content only through its tools
(`walkthrough_plan`, `walkthrough_write_part`, `walkthrough_wrap_up`,
`walkthrough_note`, `walkthrough_review`, `walkthrough_status`); answers are
its final message, streamed into the pane. Ordinary threads get one tool,
`walkthrough_open`. The worker is archived with the thread, or when the user
clicks Done.

The pane is also registered as a nav panel (`/plugins/<pluginId>/walkthroughs/<walkthroughId>`),
which is the full page.

Excerpts inside the thread's workspace use BB's environment diff APIs. Absolute
paths in another checkout use a read-only host entry that resolves the file's
Git repository and compares against the walkthrough's base there. Local mode
includes working-tree edits; committed mode reads HEAD. File and line links open
BB's preview using workspace-relative paths or an explicit host target, so a
walkthrough can explain code outside the conversation's working directory.

## Settings

`autoOpenPanel` (default on): open the pane when an agent starts a
walkthrough.

## Development

```sh
npm install
npm test          # vitest: model and fake-host orchestration
npm run typecheck
bb plugin build
bb plugin install .   # path install; then `bb plugin dev` for live reload
```
