---
name: bb-walkthrough
description: "Open BB's Walkthrough pane when a user in a BB thread asks to be walked or guided through a changeset: a PR review, changes an agent just made, their own branch, or code under discussion. In BB this takes precedence over tdx-walkthrough."
---

In BB, walkthroughs happen in the Walkthrough pane beside the thread, not in chat. When the user asks to be walked or guided through changes, call walkthrough_open with their request in their own words, for example "Guide me through this PR for review" or "the changes you just made". A helper agent forked from this thread plans and writes the walkthrough there, answers the user's questions, and keeps their notes, so do not prepare, narrate, or outline the change yourself.

After the call, tell the user in one short line that the Walkthrough pane is opening beside the thread, then carry on with anything else they asked. Notes the user sends back from the walkthrough arrive later as an ordinary message in this thread; treat them like any other request.
