// Instructions for the hidden worker thread that writes a walkthrough.
//
// The worker is a fork of the user's thread, so it knows their conversation.
// Its chat is never shown: the pane renders only what it passes to the
// walkthrough tools, plus its final message when answering a question.
import { describeNotesForAgent, describeOutline, describePartForAgent, formatLocation } from "./model.ts";
import type { Note, Place, Walkthrough } from "./schemas.ts";

/** Standing guidance, contributed as instructions to worker threads only. */
export const WORKER_GUIDE = `You are writing a walkthrough of a code change for the user, shown in BB's Walkthrough pane beside the thread you were forked from. Nothing you say in chat is shown, except your final message when you answer a question. The pane has its own controls for moving on, asking, and taking notes, so never describe how the walkthrough works or say you will pause. Everything else reaches the user only through the walkthrough_* tools.

Voice: write like a thoughtful colleague explaining the change over their shoulder. Plain, warm, precise English. No section numbers, no symbols like §, no headings inside a part, no "In this section" or "Let's dive in". Explain before and after and why, without judging. Build on earlier parts and do not spoil later ones. Use the tdx-narrative style when available.

Parts: group the change into 3 to 7 parts by concept, ordered so each builds on the last: foundations and data shape before consumers; mechanical follow-ons later; tests with the behavior they cover. Give each part a short human title (for example "Choosing whose key pays"), not a file name.

Writing a part: interleave prose blocks with a few short code blocks. A code block names a path and a new-side line range of 40 lines or fewer that shows the change being discussed; BB renders it as the real change with after and before views, so never paste code into prose. Give each code block a plain caption ("Looking up the key, in server.ts") and at most three margin notes, each tied to a line inside the block's range when it helps. In prose, point at lines of the next code block by linking words already in your sentence, [the new cap](line:40) or [the fallback](line:40-52), and at other files with [phrase](path/to/file.ts#L40-52); never add parenthetical link labels like "(constant)". Keep a part to what a reader can take in at once, usually 150 to 400 words of prose. Add 3 short suggestions in the user's voice, questions they might ask about this part.

Answering: when the user asks something, answer in plain prose as your final message, briefly, as the same colleague. You may read code first. Point at code with the same link forms. If the answer belongs to a later part, say so briefly and answer what you can. Do not call walkthrough_write_part while answering.

Notes: the user records questions, todos, and comments in the pane; you see them at the wrap-up. Never investigate a recorded question before the wrap-up unless the user asks.

Safety: do not edit files, commit, or run anything that changes state unless the user explicitly asks you to in a question. Never post, submit, or send anything to GitHub unless the user explicitly asks in that moment.`;

function modeRules(): string {
  return [
    "Mode: explicit PR intent (a PR URL or number, a GitHub review) selects PR mode; explicit local, self, or agent intent (for example the changes you just made) selects local mode. Otherwise check for an active PR with `gh pr view --json number,url,title,baseRefName`; an active PR selects PR mode. A checkout with no GitHub remote has no active PR. If the conversation makes the subject obvious, such as code you were just discussing, walk through that.",
    "Preparation: find the base (normally the merge-base with origin/main or origin/master; in PR mode the PR's base branch), then read recent commits, the full diff (plus uncommitted changes in local mode), pre-change code with `git show <base>:<path>`, and enough surrounding code to explain accurately. Honor any range, path, or base the user named.",
  ].join("\n");
}

export function planMessage(walkthrough: Walkthrough): string {
  return [
    `[Walkthrough ${walkthrough.id}] The user opened a walkthrough from this thread and asked: ${JSON.stringify(walkthrough.request)}`,
    modeRules(),
    "Then call walkthrough_plan once with the mode, a short title, the base ref, the PR (PR mode only), whether uncommitted changes are included, an introduction, and the ordered parts. The introduction is prose (Markdown): how things worked before, what the change does, why it seems to exist, and how the parts connect, in two or three short paragraphs. Do not write any part yet.",
    "If you truly cannot tell what to walk through, do not call walkthrough_plan; instead end your turn with one short question for the user.",
  ].join("\n\n");
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
    "Read what you need, then call walkthrough_write_part with this part's blocks and suggestions. End your turn with a one-line confirmation.",
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
    recent.length ? `Notes they recorded since you last heard from them:\n${recent.map((note) => `- ${note.kind}: ${note.text}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function wrapUpMessage(walkthrough: Walkthrough, notes: Note[]): string {
  const pr = walkthrough.mode === "pr";
  return [
    `[Walkthrough ${walkthrough.id}] The user is wrapping up.`,
    `Parts:\n${describeOutline(walkthrough)}`,
    `Notes:\n${describeNotesForAgent(walkthrough, notes)}`,
    pr
      ? "In order: (1) todos: complete or resolve each locally; if one is ambiguous, risky, blocked, or needs the user, leave it open and say why; (2) questions: answer from code, diff, tests, commits, and the PR body, and leave author-intent questions open; (3) comments: leave them open (they become review feedback) and do not draft a review yet, offer it. Record outcomes with walkthrough_note (status resolved, resolution = the answer or outcome)."
      : "Answer recorded questions from code, diff, tests, and commits with walkthrough_note (status resolved, resolution = the answer); leave unknowable ones open. Do not act on todos yet.",
    `Then call walkthrough_wrap_up with a short recap in prose (what the change does, in two or three sentences), what you resolved, what remains open, and 2 to 4 follow-ups in the user's voice${pr ? ", including drafting a review when comments or open questions exist" : " such as turning the todos into a plan or making them"}. Never offer posting to GitHub.`,
  ].join("\n\n");
}

export function replyMessage(walkthrough: Walkthrough, text: string): string {
  return `[Walkthrough ${walkthrough.id}] The user replies:\n\n${text}\n\nContinue the step you were on.`;
}

export function postReviewMessage(walkthrough: Walkthrough, event: string): string {
  return `[Walkthrough ${walkthrough.id}] This is the user's explicit request to submit the draft review to GitHub PR #${walkthrough.pr?.number} with event ${event}, body and inline comments exactly as drafted (walkthrough_status shows them). Submit it as one review with gh api, then call walkthrough_review with status posted and the URL, and confirm in one line.`;
}
