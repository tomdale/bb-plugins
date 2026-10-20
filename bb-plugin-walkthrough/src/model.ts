// Pure walkthrough logic shared by the server and the pane: labels, the
// notes Markdown mirror, and text handed to the worker agent.
import type { Location, Mode, Note, NoteKind, Part, Walkthrough, WalkthroughStatus } from "./schemas.ts";

export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  question: "Question",
  todo: "Todo",
  comment: "Comment",
  note: "Note",
};

/** Section order of the notes file and the pane's notes list. */
export const NOTE_SECTIONS: ReadonlyArray<{ kind: NoteKind; title: string }> = [
  { kind: "question", title: "Questions" },
  { kind: "comment", title: "Comments" },
  { kind: "todo", title: "Todos" },
  { kind: "note", title: "Notes" },
];

export function noteKindsFor(mode: Mode): NoteKind[] {
  return mode === "pr" ? ["question", "comment", "todo", "note"] : ["question", "todo", "note"];
}

/** The SHA of git's empty tree: the base of a walkthrough of a repository's first commit. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * A base ref as a reader should see it. Full SHAs are abbreviated, the empty
 * tree reads as "start of history", and a ref the worker annotated
 * ("c884aad (PR base on main)") keeps only its leading token.
 */
export function shortRef(ref: string): string {
  const token = ref.trim().split(/\s+/u)[0] ?? "";
  if (token.toLowerCase() === EMPTY_TREE_SHA) return "start of history";
  return /^[0-9a-f]{12,40}$/iu.test(token) ? token.slice(0, 8) : token;
}

/** What a walkthrough's changes are measured against, in the words of the header subtitle. */
export function comparedWith(walkthrough: Pick<Walkthrough, "baseRef">): string {
  const base = shortRef(walkthrough.baseRef);
  return base === "start of history" ? "everything since the start of history" : `compared with ${base}`;
}

// ---------------------------------------------------------------------------
// Walkthrough lists
// ---------------------------------------------------------------------------

export function statusLabel(status: WalkthroughStatus): string {
  switch (status) {
    case "planning":
      return "Getting ready";
    case "reading":
      return "In progress";
    case "wrapping-up":
      return "Wrapping up";
    case "done":
      return "Finished";
    case "failed":
      return "Stopped";
  }
}

/** A short absolute time: "14:05" today, "Yesterday", "Mar 5", or "Mar 5, 2025" in another year. */
export function formatStarted(timestamp: number, now: number = Date.now()): string {
  const when = new Date(timestamp);
  const today = new Date(now);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(when)) / 86_400_000);
  if (days === 0) return when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  const sameYear = when.getFullYear() === today.getFullYear();
  return when.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

export interface SummaryFacts {
  status: WalkthroughStatus;
  partCount: number;
  currentPart: number | null;
  createdAt: number;
}

/** A list row's title: the request stands in until the worker has titled the walkthrough. */
export function summaryTitle(summary: { title: string; request: string }): string {
  return summary.title === "Walkthrough" ? summary.request || summary.title : summary.title;
}

/** "In progress · Part 2 of 6 · Mar 5": enough to tell same-titled walkthroughs apart. */
export function summaryDetail(summary: SummaryFacts, now: number = Date.now()): string {
  const settled = summary.status === "done" || summary.status === "failed";
  let progress: string | null = null;
  if (summary.partCount > 0) {
    if (settled) progress = summary.partCount === 1 ? "1 part" : `${summary.partCount} parts`;
    else progress = summary.currentPart === null ? "Introduction" : `Part ${summary.currentPart + 1} of ${summary.partCount}`;
  }
  return [statusLabel(summary.status), progress, formatStarted(summary.createdAt, now)].filter((part) => part !== null).join(" · ");
}

export function formatLocation(location: Location | null | undefined): string | null {
  if (!location) return null;
  const { path, startLine, endLine } = location;
  if (startLine === undefined) return path;
  if (endLine === undefined || endLine === startLine) return `${path}:${startLine}`;
  return `${path}:${startLine}-${endLine}`;
}

export function partLabel(walkthrough: Walkthrough, index: number | null): string | null {
  if (index === null) return null;
  const part = walkthrough.parts[index];
  return part ? part.title : null;
}

/** "Choosing whose key pays · server.ts:10-30", or null when neither is known. */
export function noteLocus(walkthrough: Walkthrough, note: Note): string | null {
  const parts = [partLabel(walkthrough, note.groupIndex), formatLocation(note.location)];
  const present = parts.filter((part): part is string => part !== null);
  return present.length === 0 ? null : present.join(" · ");
}

// ---------------------------------------------------------------------------
// Dotted commands typed into a question box
// ---------------------------------------------------------------------------

export type CommandIntent =
  | { kind: "record"; noteKind: NoteKind; text: string }
  | { kind: "incomplete"; noteKind: NoteKind }
  | { kind: "text"; text: string };

const RECORD_COMMANDS: Record<string, NoteKind> = {
  ".question": "question",
  ".todo": "todo",
  ".comment": "comment",
  ".note": "note",
};

/** `.todo rename it` records a note; anything else is a question for the worker. */
export function parseCommand(input: string): CommandIntent {
  const text = input.trim();
  const match = /^(\.[a-z]+)(?:\s+([\s\S]*))?$/u.exec(text);
  const noteKind = match ? RECORD_COMMANDS[match[1]!] : undefined;
  if (!match || noteKind === undefined) return { kind: "text", text };
  const rest = (match[2] ?? "").trim();
  return rest === "" ? { kind: "incomplete", noteKind } : { kind: "record", noteKind, text: rest };
}

// ---------------------------------------------------------------------------
// Notes file mirror
// ---------------------------------------------------------------------------

function bullet(walkthrough: Walkthrough, note: Note, prefix: string | null): string {
  const locus = noteLocus(walkthrough, note);
  const label = [prefix, locus].filter(Boolean).join(" · ");
  const head = label === "" ? "" : `[${label}] `;
  const lines = [`- ${head}${note.text.replace(/\n+/gu, " ")} (${note.id})`];
  if (note.quote) lines.push(`  > ${note.quote.replace(/\n+/gu, " ").slice(0, 400)}`);
  if (note.resolution) lines.push(`  ${note.kind === "todo" ? "Outcome" : "Answer"}: ${note.resolution.replace(/\n+/gu, " ")}`);
  return lines.join("\n");
}

/** The `.agent/review-notes/<id>.md` mirror: nonempty sections only. */
export function renderNotesMarkdown(walkthrough: Walkthrough, notes: Note[]): string {
  const out = ["# Review Notes", ""];
  const scope = walkthrough.mode === "pr" ? "PR review" : "Local review";
  out.push(`${walkthrough.title} (${scope}; base \`${shortRef(walkthrough.baseRef)}\`).`, "");
  for (const section of NOTE_SECTIONS) {
    const items = notes.filter((note) => note.kind === section.kind && note.status === "open");
    if (items.length === 0) continue;
    out.push(`## ${section.title}`, "", ...items.map((note) => bullet(walkthrough, note, null)), "");
  }
  const resolved = notes.filter((note) => note.status === "resolved");
  if (resolved.length > 0) {
    out.push("## Resolved / Answered", "", ...resolved.map((note) => bullet(walkthrough, note, NOTE_KIND_LABEL[note.kind])), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Text for the worker
// ---------------------------------------------------------------------------

export function describeNoteForAgent(walkthrough: Walkthrough, note: Note): string {
  const locus = noteLocus(walkthrough, note);
  const parts = [`${note.id} ${NOTE_KIND_LABEL[note.kind].toLowerCase()}`];
  if (note.status === "resolved") parts.push("resolved");
  const head = `${parts.join(", ")}${locus ? ` [${locus}]` : ""}`;
  const lines = [`- ${head}: ${JSON.stringify(note.text)}`];
  if (note.quote) lines.push(`  quoted: ${JSON.stringify(note.quote.slice(0, 400))}`);
  if (note.resolution) lines.push(`  outcome: ${JSON.stringify(note.resolution)}`);
  return lines.join("\n");
}

export function describeNotesForAgent(walkthrough: Walkthrough, notes: Note[]): string {
  if (notes.length === 0) return "No notes recorded.";
  const ordered = [
    ...NOTE_SECTIONS.flatMap((section) => notes.filter((note) => note.kind === section.kind && note.status === "open")),
    ...notes.filter((note) => note.status === "resolved"),
  ];
  return ordered.map((note) => describeNoteForAgent(walkthrough, note)).join("\n");
}

export function describeOutline(walkthrough: Walkthrough): string {
  return walkthrough.parts
    .map((part, index) => `${index + 1}. ${JSON.stringify(part.title)} (${part.status}) ${part.summary}`)
    .join("\n");
}

/** Plain-text digest of a written part, so the worker can refer back to it. */
export function describePartForAgent(part: Part): string {
  return part.blocks
    .map((block) => (block.kind === "prose" ? block.text : `[code: ${block.path}:${block.startLine}-${block.endLine} "${block.caption}"]`))
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Code excerpts
// ---------------------------------------------------------------------------

export type ExcerptView = "change" | "after" | "before";

/** Lines of a unified patch that are code (context, added, removed), with file headers and hunk markers left out. */
function patchLines(patch: string): Array<{ marker: " " | "+" | "-"; text: string }> {
  const lines: Array<{ marker: " " | "+" | "-"; text: string }> = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && (line[0] === " " || line[0] === "+" || line[0] === "-")) lines.push({ marker: line[0] as " " | "+" | "-", text: line.slice(1) });
  }
  return lines;
}

/** Whether a patch adds or removes anything, rather than only showing unchanged context. */
export function hasChangedLines(patch: string): boolean {
  return patchLines(patch).some((line) => line.marker !== " ");
}

/**
 * The view an excerpt opens in. The change view of code that did not change is
 * only collapsed context, so an excerpt for reading code opens as "after".
 */
export function defaultExcerptView(excerpt: { change: string | null; after: string | null }): ExcerptView {
  if (excerpt.change && hasChangedLines(excerpt.change)) return "change";
  return excerpt.after ? "after" : "change";
}

/** The text to copy for a view: its new side, old side, or (for the change view) the diff's code lines with markers. */
export function excerptCode(patch: string, view: ExcerptView): string {
  const lines = patchLines(patch);
  const pick = (keep: string) => lines.filter((line) => keep.includes(line.marker)).map((line) => line.text);
  if (view === "after") return pick(" +").join("\n");
  if (view === "before") return pick(" -").join("\n");
  return lines.map((line) => `${line.marker}${line.text}`).join("\n");
}
