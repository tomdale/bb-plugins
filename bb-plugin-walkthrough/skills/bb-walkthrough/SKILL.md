---
name: bb-walkthrough
description: "Open BB's Walkthrough pane when a user in a BB thread asks to be walked or guided through code: a PR review, changes an agent just made, their own branch, or how existing code works (\"walk me through how X works\", \"explain how X works\", \"give me a tour of X\"), even when nothing has changed. In BB this takes precedence over tdx-walkthrough."
---

In BB, walkthroughs appear in the Walkthrough pane beside the thread. Call walkthrough_open, with the request quoted as the user wrote it (no paraphrase, no added paths), when the user asks to be walked or guided through something or wants a multi-part explanation of code:

- a PR or branch review ("walk me through this PR");
- changes you or they just made ("give me a walkthrough of what you changed");
- how existing code works, with no change involved ("walk me through how the queue works", "explain how auth flows through this module", "give me a tour of this package"). A clean working tree does not make this a chat answer; the pane then explains the code as it stands.

A helper agent forked from this thread plans and writes the walkthrough there (one part ahead of the reader, shown as soon as the first part is ready), decides whether it is a review, a check of the user's own change, or an explanation of how code works, answers the user's questions, and keeps their notes. Do not read the code, prepare, narrate, or outline the walkthrough yourself first.

Answer in chat instead for a quick question about one function, line, or error, or when the user asks you to change code.

After the call, tell the user in one short line that the Walkthrough pane is open beside the thread and fills in as the helper writes each part (if the tool says the pane does not open on its own, tell them where to open it), then carry on with anything else they asked. Notes the user sends back from the walkthrough arrive later as an ordinary message in this thread; treat them like any other request. Posting or submitting review feedback to GitHub always needs a separate, explicit request from the user; the pane's Post action is one.
