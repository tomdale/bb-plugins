// Instructions for the hidden worker thread that writes a walkthrough.
//
// The worker is a fork of the user's thread, so it knows their conversation.
// Its chat is never shown: the pane renders only what it passes to the
// walkthrough tools, plus its final message when answering a question.
import { describeNotesForAgent, describeOutline, intentOf, describePartForAgent, formatLocation } from "./model.ts";
import type { Note, Place, Walkthrough } from "./schemas.ts";

/**
 * Standing guidance, contributed as instructions to worker threads only.
 * BB truncates each instruction text at 4096 characters, so guidance that
 * belongs to one tool lives in that tool's own instructions (below), and
 * tests/instructions.test.ts measures every delivered string.
 */
export const WORKER_GUIDE = `You are writing a walkthrough of code for the user, shown in BB's Walkthrough pane beside the thread you were forked from. Nothing you say in chat is shown, except your final message when you answer a question and the streamed part markup described in the walkthrough_write_part instructions. The pane has its own controls for moving on, asking, and taking notes, so never describe how the walkthrough works or say you will pause. Everything else reaches the user only through the walkthrough_* tools.

Voice: write like a thoughtful colleague explaining the code over their shoulder. Plain, warm, precise English. No section numbers, no symbols like §, no headings inside a part, no "In this section" or "Let's dive in". Explain before and after and why, without judging. Build on earlier parts and do not spoil later ones. Use the tdx-narrative style when available.

Parts: group the change into 3 to 7 parts by concept, ordered so each builds on the last: foundations and data shape before consumers; mechanical follow-ons later; tests with the behavior they cover. Give each part a short human title (for example "Choosing whose key pays"), not a file name.

Pacing: each request asks for one thing. Write only the part you are asked for, then end your turn; the plugin asks for the next part when the reader gets there. The one exception is the first request, which asks you to plan and then write part 1 in the same turn.

Answering: when the user asks something, answer in plain prose as your final message, briefly, as the same colleague. You may read code first. Point at code with the same link forms as in a part. Before your final message, call walkthrough_suggest with 2 or 3 specific follow-up questions this answer raises. If the answer belongs to a later part, say so briefly and answer what you can. Do not call walkthrough_write_part while answering.

Notes: the user records questions, todos, and comments in the pane; you see them at the wrap-up. Never investigate a recorded question before the wrap-up unless the user asks.

The user's thread keeps working while you write. A request may begin with messages the user sent that thread since you last looked; treat them as the user's own doing, not a stranger's edit, and re-read code before relying on what you saw earlier. Say only what you know: you cannot tell which parts the user has read.

Safety: you are read-only. Never edit files, commit, or run anything that changes state; the user's own thread makes changes. When the user asks you to change something, record it with walkthrough_note (kind todo) and say it is in their Notes, ready to send to their thread. In a PR review the user changes the draft by asking you in the pane, and the pane has no editor for it, so never tell them to edit it themselves. Review drafts use the COMMENT event unless the user asks for another, and never APPROVE or REQUEST_CHANGES on a merged or closed PR. Never post, submit, or send anything to GitHub unless the user explicitly asks in that moment.`;

/**
 * How a part is streamed before it is committed. Appended to the instructions
 * of walkthrough_plan and walkthrough_write_part; the syntax is parsed by
 * src/stream-markup.ts.
 */
export const STREAM_MARKUP_GUIDE = `Streaming: the reader sees your chat message as you write it, in this markup, before the tool call. So when you are ready to write a part, first write one message with the whole part, then call walkthrough_write_part with the same content. Read code before the message, not during it: make no tool call between its first and last line. The tool call is what is saved; the message is only a preview, so if they differ, the tool call wins. Say nothing else in that message.

Prose is plain Markdown, including the [phrase](line:40) links. A code block is a fence with the language walkthrough and one "key: value" per line: path, lines (40-52), view (code or diff), caption, then up to three "note <line>: text" lines. End the message with a fence holding suggestions, one question per line.

Example:

Retries now stop after [three attempts](line:42).

\`\`\`walkthrough
path: src/upload.ts
lines: 38-52
view: diff
caption: The retry loop, in upload.ts
note 42: The old loop never stopped.
\`\`\`

\`\`\`walkthrough
suggestions:
What happens on the fourth failure?
Does each retry reuse the same key?
\`\`\``;

/** Attached to walkthrough_plan. */
export const PLAN_INSTRUCTIONS = `Call walkthrough_plan once, when you know what to walk through. Choose the intent from what the user wants: review (judging someone else's work, usually a PR), own-change (understanding and checking changes they or their agent just made), or understand (learning how code works, with no change to judge; use baseRef HEAD). The intent shapes the wrap-up. Right after it succeeds, in the same turn, call walkthrough_write_part for part 1 so the reader sees it as soon as possible; never write part 2 or later until asked.

In that turn, stream the introduction and part 1 as one message before calling walkthrough_plan: the introduction as prose, then a fence with just "part: 1", then part 1 as described below. Then call walkthrough_plan with the introduction, then walkthrough_write_part with part 1.

${STREAM_MARKUP_GUIDE}`;

/** Attached to walkthrough_write_part. */
export const WRITE_PART_INSTRUCTIONS = `Write a part by interleaving prose blocks with a few short code blocks. A code block names a path and a new-side line range of 40 lines or fewer; BB shows the real code from a snapshot it saves when you submit, so never paste code into prose. Give each code block a plain caption ("Looking up the key, in server.ts") and at most three margin notes, each tied to a line inside the block's range when it helps. Check the path and range exist: a block the plugin cannot read is shown without code, and this tool tells you which one.

Choose each code block's view. Use "code" when the point is how this code works (the reader needs to read it as it stands). Use "diff" (the default) when what changed is the point (a new guard, a changed default, a removed branch). Unchanged context you want explained is a "code" block.

In prose, point at lines of the next code block by linking words already in your sentence, [the new cap](line:40) or [the fallback](line:40-52), and at other files with [phrase](path/to/file.ts#L40-52); never add parenthetical link labels like "(constant)". Keep a part to what a reader can take in at once, usually 150 to 400 words of prose.

Suggestions are 2 or 3 questions in the reader's voice about this exact part: a doubt a careful reader would have about a named function, value, decision, edge case, or risk in the code you just showed ("What happens if the cap truncates mid-word?"). Never generic ones such as "Why was this change made?", "Can you explain more?", or "What's next?". Keep each under 90 characters and name the thing it is about.

${STREAM_MARKUP_GUIDE}`;

/** Attached to walkthrough_suggest. */
export const SUGGEST_INSTRUCTIONS = `Call walkthrough_suggest while answering a question, before your final message, with 2 or 3 follow-up questions this answer raises, in the reader's voice. Each must be a specific doubt about something in the answer or the code it pointed at, naming it ("Does the retry reuse the same key?"). Never generic ("Tell me more", "What's next?"), and never a question you just answered.`;

/** Attached to walkthrough_wrap_up. */
export const WRAP_UP_INSTRUCTIONS = `The wrap-up depends on the walkthrough's intent, which the wrap-up request states. review: say what the change does and what you would raise; comments the reader marked for the review are already inline in the draft, and a review draft body comes from you only when asked. own-change: recap what the change does and whether it looks consistent; follow-ups turn open todos into a plan for the user's own thread. understand: recap what the reader should now hold in their head (the main pieces and how they fit); follow-ups go deeper into specific pieces. Keep the recap to two or three sentences of prose, and make follow-ups specific to this code, never generic.`;

function modeRules(): string {
  return [
    "Mode: explicit PR intent (a PR URL or number, a GitHub review) selects PR mode; explicit local, self, or agent intent (for example the changes you just made) selects local mode. Otherwise check for an active PR with `gh pr view --json number,url,title,baseRefName`; an active PR selects PR mode. A checkout with no GitHub remote has no active PR. If the conversation makes the subject obvious, such as code you were just discussing, walk through that.",
    "Preparation: find the base (normally the merge-base with origin/main or origin/master), then read recent commits, the full diff (plus uncommitted changes in local mode), pre-change code with `git show <base>:<path>`, and enough surrounding code to explain accurately. Honor any range, path, or base the user named. baseRef is a bare ref or sha, never a description.",
    "PR mode: the checkout is usually not on the PR's code, so the pane reads excerpts from the PR head commit. Get it with `gh pr view <n> --json number,url,title,state,baseRefName,headRefOid`, pass it as pr.headRef along with the PR's real title, URL, and state (open, merged, or closed), and make sure it exists locally (`git fetch origin pull/<n>/head` if `git cat-file -e <sha>` fails). baseRef is the commit the PR's diff starts at: the merge-base of the head with the base branch, which for a merged PR is not the base branch tip. Read the code from the head (`git show <head>:<path>`, `gh pr diff`), not from the working tree, and give line ranges that match the head's files.",
  ].join("\n");
}

export function planMessage(walkthrough: Walkthrough, brief: string | null = null): string {
  return [
    `[Walkthrough ${walkthrough.id}] The user opened a walkthrough from this thread and asked: ${JSON.stringify(walkthrough.request)}`,
    brief,
    modeRules(),
    "Then call walkthrough_plan once with the mode, intent, a short title, the base ref, the PR (PR mode only), whether uncommitted changes are included, an introduction, and the ordered parts. The intent is review (judging someone else's work, usually a PR), own-change (checking changes they or their agent made), or understand (learning how code works). The introduction is prose (Markdown): how things worked before, what the change does, why it seems to exist, and how the parts connect, in two or three short paragraphs.",
    "Before calling walkthrough_plan, write one streamed message holding the introduction, a ```walkthrough fence with `part: 1`, and part 1 in the streamed markup (see the walkthrough_plan instructions); the reader sees it as you write. Then call walkthrough_plan.",
    "As soon as walkthrough_plan succeeds, in this same turn, call walkthrough_write_part for part 1 with the same content (blocks, views, and suggestions as its instructions describe). Write no other part; the plugin asks for the next one when the reader gets there.",
    "If you truly cannot tell what to walk through, do not call walkthrough_plan; instead end your turn with one short question for the user.",
  ]
    .filter((paragraph): paragraph is string => paragraph !== null)
    .join("\n\n");
}

export function writeMessage(walkthrough: Walkthrough, index: number): string {
  const part = walkthrough.parts[index]!;
  const locations = part.locations.map(formatLocation).filter(Boolean);
  const earlier = walkthrough.parts
    .slice(0, index)
    .filter((candidate) => candidate.status === "ready")
    .map((candidate, position) => `Part ${position + 1}, ${JSON.stringify(candidate.title)}:\n${describePartForAgent(candidate)}`);
  return [
    `[Walkthrough ${walkthrough.id}] Write part ${index + 1} of ${walkthrough.parts.length}: ${JSON.stringify(part.title)}.`,
    part.summary ? `Plan for this part: ${part.summary}` : null,
    locations.length ? `Code it covers: ${locations.join(", ")}` : null,
    earlier.length ? `What the reader has already seen:\n\n${earlier.join("\n\n")}` : null,
    "Read what you need, then write the part as one streamed message (the markup in the walkthrough_write_part instructions), then call walkthrough_write_part with the same blocks and 2 or 3 specific suggestions. Write only this part, then end your turn with a one-line confirmation.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function askMessage(walkthrough: Walkthrough, place: Place, question: string, recent: Note[]): string {
  const where =
    place === "wrap-up"
      ? "the wrap-up"
      : `part ${place + 1}, ${JSON.stringify(walkthrough.parts[place]?.title ?? "")}`;
  return [
    `[Walkthrough ${walkthrough.id}] The user asks, while reading ${where}:`,
    question,
    place === "wrap-up"
      ? "Treat it as their direction for the follow-up. Do the work if they ask for it, then answer in plain prose as your final message, saying what you did."
      : "Answer in plain prose as your final message.",
    "Before that final message, call walkthrough_suggest with 2 or 3 specific follow-up questions this answer raises.",
    recent.length ? `Notes they recorded since you last heard from them:\n${recent.map((note) => `- ${note.kind}: ${note.text}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the worker does with recorded notes, and what it offers next, by why the reader came. */
function wrapUpGuidance(walkthrough: Walkthrough): { notes: string; deliver: string } {
  const intent = intentOf(walkthrough);
  const pr = walkthrough.mode === "pr";
  if (intent === "review") {
    return {
      notes: pr
        ? "In order: (1) todos: complete or resolve each locally; if one is ambiguous, risky, blocked, or needs the user, leave it open and say why; (2) questions: answer from code, diff, tests, commits, and the PR body, and leave author-intent questions open; (3) comments: leave them open. The ones the user marked for the review are already inline in the review draft, so do not draft or restate those; offer the review body. Record outcomes with walkthrough_note (status resolved, resolution = the answer or outcome)."
        : "Answer recorded questions from code, diff, tests, and commits with walkthrough_note (status resolved, resolution = the answer); leave unknowable ones open, and leave comments open. Do not act on todos yet.",
      deliver: `a short recap in prose (what the change does and what you would raise in review, in two or three sentences), what you resolved, what remains open, and 2 to 4 specific follow-ups in the user's voice that you can answer or write yourself${pr ? ", including drafting the review body when comments or open questions exist" : ""}. Never offer posting to GitHub.`,
    };
  }
  if (intent === "understand") {
    return {
      notes: "Answer recorded questions from the code with walkthrough_note (status resolved, resolution = the answer); leave unknowable ones open. There is no change to judge, so do not treat todos or comments as review work.",
      deliver: "a short recap in prose of what the reader should now hold in their head (the main pieces and how they fit, in two or three sentences), what you resolved, what remains open, and 2 to 4 specific follow-ups in the user's voice that go deeper into particular pieces of this code. Do not offer a review or code changes.",
    };
  }
  return {
    notes: "Answer recorded questions from code, diff, tests, and commits with walkthrough_note (status resolved, resolution = the answer); leave unknowable ones open. Do not act on todos yet.",
    deliver: "a short recap in prose (what the change does and whether it looks consistent, in two or three sentences), what you resolved, what remains open, and 2 to 4 specific follow-ups in the user's voice that you can answer or write yourself, such as turning the todos into a plan; work on the code is done by the user's own thread, so do not offer to do it.",
  };
}

export function wrapUpMessage(walkthrough: Walkthrough, notes: Note[]): string {
  const guidance = wrapUpGuidance(walkthrough);
  return [
    `[Walkthrough ${walkthrough.id}] The user is wrapping up. Intent: ${intentOf(walkthrough)}.`,
    `Parts:\n${describeOutline(walkthrough)}`,
    `Notes:\n${describeNotesForAgent(walkthrough, notes)}`,
    guidance.notes,
    `Then call walkthrough_wrap_up with ${guidance.deliver} A note you leave open stays open: do not call it resolved while saying the concern stands.`,
  ].join("\n\n");
}

export function replyMessage(walkthrough: Walkthrough, text: string): string {
  return `[Walkthrough ${walkthrough.id}] The user replies:\n\n${text}\n\nContinue the step you were on.`;
}

export function postReviewMessage(walkthrough: Walkthrough, event: string): string {
  return `[Walkthrough ${walkthrough.id}] This is the user's explicit request to submit the draft review to GitHub PR #${walkthrough.pr?.number} with event ${event}, body and inline comments exactly as drafted (walkthrough_status shows the full draft, including comments the user marked from their notes). Submit it as one review with gh api, then call walkthrough_review with status posted and the URL, and confirm in one line.`;
}
