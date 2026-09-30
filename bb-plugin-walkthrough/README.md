# bb-plugin-walkthrough

A reading view for understanding a code change. From any BB thread, click
**Walkthrough** in the thread header (or ask the agent to walk you through
something) and a pane opens beside the thread. A helper agent, forked from
the thread so it knows the conversation, explains the change part by part in
plain prose with real code excerpts. The original thread keeps working while
you read.

## Using it

- **Start:** the header button opens a starter with suggestions ("The changes
  on this branch", "This PR, for review", "The code we've been talking about",
  "The changes you just made") or your own words. Asking the thread's agent
  to walk you through something opens the same pane.
- **Read:** an introduction, then one part at a time: prose with short code
  excerpts (switch between change, after, and before), margin notes, and a
  contents list when the pane is wide. Maximize the pane for full-width
  reading. The next part is written while you read the current one.
- **Ask:** every part ends with a conversation. Suggested questions get you
  started; ask anything in your own words. `.todo …` or `.question …` in the
  box saves a note instead.
- **Note:** select any text or code and choose **Leave a note**, or use the
  Notes drawer. Notes can point at a file and line range, and are mirrored to
  `.agent/review-notes.md` in the workspace.
- **Wrap up:** the helper answers recorded questions, reports what is still
  open, and offers follow-ups. In PR reviews it drafts a review on request;
  the Review drawer previews it and **Post…** asks the helper to submit it.
  Nothing reaches GitHub without that explicit step.
- **Hand off:** **Send open notes to my thread** posts the open todos and
  questions to your thread's own agent.

## How it works

The plugin owns the walkthrough state (SQLite) and drives a hidden fork of
the user's thread one request at a time: plan, write a part, answer a
question, wrap up. The worker delivers content only through its tools
(`walkthrough_plan`, `walkthrough_write_part`, `walkthrough_wrap_up`,
`walkthrough_note`, `walkthrough_review`, `walkthrough_status`); answers are
its final message, streamed into the pane. Ordinary threads get one tool,
`walkthrough_open`. The worker is archived with the thread, or when the user
clicks Done.

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
