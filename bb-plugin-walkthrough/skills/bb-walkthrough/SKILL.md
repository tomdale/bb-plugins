---
name: bb-walkthrough
description: "Open BB's Walkthrough pane only for an explicit walkthrough, guided tour, or step-by-step guided reading of code. Answer ordinary questions, explanations, investigations, and reviews in chat by default. Explicit walkthroughs can cover PRs, branches, changes, or existing code with no diff; use this pane in BB rather than tdx-walkthrough."
---

Answer in chat by default. In BB, call walkthrough_open only when the user explicitly requests a walkthrough, guided tour, or step-by-step guided reading of code: "walk me through this PR", "give me a walkthrough of what you changed", "walk me through how the queue works", or "give me a tour of this package". For those explicit requests, use this pane rather than tdx-walkthrough. An explicit walkthrough can cover a PR, branch, recent changes, or existing code with no diff.

Ordinary questions, explanations, investigations, reviews, and code changes belong in chat. Examples: "where are these values coming from?", "explain how auth works", "how does this work end to end?", "let's review title/goal generation", and "review this PR". Judge the requested format, not the words explain or review, the topic's breadth, or how many parts an answer might need. When the format is ambiguous, answer in chat.

For an explicit walkthrough request, pass the user's own words as request, unparaphrased and without added paths. A helper agent forked from this thread reads the code, plans and writes the walkthrough in the pane (one part ahead of the reader, shown as soon as the first part is ready), decides whether it is a review, a check of the user's own change, or an explanation of how code works, answers the user's questions, and keeps their notes. Let the helper prepare and narrate the walkthrough.

After the call, tell the user in one short line that the Walkthrough pane is open beside the thread and fills in as the helper writes each part (if the tool says the pane does not open on its own, tell them where to open it), then carry on with anything else they asked. Notes the user sends back from the walkthrough arrive later as an ordinary message in this thread; treat them like any other request. Posting or submitting review feedback to GitHub always needs a separate, explicit request from the user; the pane's Post action is one.
