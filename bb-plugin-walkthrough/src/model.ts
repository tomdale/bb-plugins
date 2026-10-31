// Pure walkthrough logic shared by the server and the pane: labels, the
// review draft derivation, and text handed to the worker agent.
import { EMPTY_TREE_SHA } from "./empty-tree.ts";
import type { DerivedReviewComment, Intent, IntentCopy, Location, Mode, Note, NoteKind, Part, ReviewDraft, Walkthrough, WalkthroughStatus } from "./schemas.ts";

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

/**
 * The words that depend on why the reader is here. Before planning the intent
 * is only the mode's default, so the copy stays neutral until the worker has
 * chosen; an explanation of how code works never reads as a review of changes.
 */
export function intentCopy(walkthrough: Pick<Walkthrough, "intent" | "mode" | "baseRef" | "status">): IntentCopy {
  if (walkthrough.status === "planning") {
    return { subtitle: "Getting ready", skeleton: "Reading the code and deciding how to explain it\u2026", introduction: "Introduction" };
  }
  switch (intentOf(walkthrough)) {
    case "understand":
      return { subtitle: "How this code works today", skeleton: "Reading the code and deciding how to explain it\u2026", introduction: "Overview" };
    case "review":
      return { subtitle: `Changes ${comparedWith(walkthrough)}`, skeleton: "Reading the pull request and deciding how to explain it\u2026", introduction: "Introduction" };
    case "own-change":
      return { subtitle: `Your changes ${comparedWith(walkthrough)}`, skeleton: "Reading your changes and deciding how to explain them\u2026", introduction: "Introduction" };
  }
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
// Where a new note is anchored
// ---------------------------------------------------------------------------

/** What a selection hands the notes form: the quote, where it was read, and the excerpt it sits in. */
export interface NoteDraft {
  quote: string;
  groupIndex: number | null;
  /** The code excerpt the selection was made in, when it was made in one. */
  location?: Location | null;
  sequence: number;
}

/** The part of a note's anchor that outlives typing: which part, file, and quote it will be saved against. */
export interface NoteTarget {
  groupIndex: number | null;
  location: Location | null;
  quote: string | null;
}

/** A note written from scratch belongs to the part on screen and to no file or quote. */
export function blankTarget(currentPart: number | null): NoteTarget {
  return { groupIndex: currentPart, location: null, quote: null };
}

/** A note started from a selection is anchored to exactly what the selection implies, and nothing left over from an earlier note. */
export function targetFromDraft(draft: NoteDraft): NoteTarget {
  return { groupIndex: draft.groupIndex, location: draft.location ?? null, quote: draft.quote };
}

/**
 * The files and ranges a note can point at: the current part's code excerpts
 * first, then the other files it touches, then `keep` (an anchor already chosen).
 */
export function locationChoices(walkthrough: Walkthrough, groupIndex: number | null, keep: Location | null = null): Location[] {
  const part = groupIndex === null ? undefined : walkthrough.parts[groupIndex];
  const excerpts = (part?.blocks ?? []).flatMap((block) => (block.kind === "code" ? [{ path: block.path, startLine: block.startLine, endLine: block.endLine }] : []));
  const seen = new Set<string>();
  return [...excerpts, ...(part?.locations ?? []), ...(keep ? [keep] : [])].filter((location) => {
    const key = formatLocation(location) ?? location.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The lines text for a location: "12", "12-40", or "" for a whole file. */
export function linesText(location: Location | null): string {
  if (!location || location.startLine === undefined) return "";
  return location.endLine !== undefined && location.endLine !== location.startLine ? `${location.startLine}-${location.endLine}` : `${location.startLine}`;
}

/** Applies typed lines ("12", "12-40", or empty for the whole file) to a chosen file; text that is not a range keeps the choice's own range. */
export function noteLocation(choice: Location | null, lines: string): Location | null {
  if (!choice) return null;
  if (lines.trim() === "") return { path: choice.path };
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/u.exec(lines);
  if (!match) return choice;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  return { path: choice.path, startLine: Math.min(start, end), ...(start === end ? {} : { endLine: Math.max(start, end) }) };
}

/**
 * Where to put the "Leave a note" button, relative to the page it floats in.
 * The host's code viewer can render in a shadow root, where a selection's
 * bounding rect comes back empty, so an empty rect falls back to the pointer.
 */
export function noteButtonPosition(
  rect: { top: number; bottom: number; left: number; right: number; width: number; height: number },
  pointer: { x: number; y: number },
  page: { top: number; left: number },
): { top: number; left: number } {
  const empty = rect.width === 0 && rect.height === 0;
  return empty
    ? { top: pointer.y - page.top + 12, left: Math.max(0, pointer.x - page.left) }
    : { top: rect.bottom - page.top + 6, left: Math.max(0, rect.left - page.left) };
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
// Review draft
// ---------------------------------------------------------------------------

/** The resolution a note gets when the worker folds it into its own drafted comment. */
export const COVERED_RESOLUTION = "Included in the draft PR review.";

/** A walkthrough's intent, for rows that predate it. */
export function intentOf(walkthrough: Pick<Walkthrough, "intent" | "mode">): Intent {
  return walkthrough.intent ?? (walkthrough.mode === "pr" ? "review" : "own-change");
}

/**
 * Inline comments from the notes the reader marked for the review: open comment
 * notes with a file and line. A note the worker folded into its own drafted
 * comment is resolved, so it never appears twice.
 */
export function deriveReviewComments(notes: Note[]): DerivedReviewComment[] {
  const comments: DerivedReviewComment[] = [];
  for (const note of notes) {
    const included = note.includeInReview ?? note.kind === "comment";
    const location = note.location;
    if (note.kind !== "comment" || !included || note.status !== "open" || !location) continue;
    // The helper folded this one into its own drafted comment and proposed closing it; it must not appear twice meanwhile.
    if (note.proposedResolution === COVERED_RESOLUTION) continue;
    const line = location.endLine ?? location.startLine;
    if (line === undefined) continue;
    const startLine = location.startLine !== undefined && location.startLine < line ? location.startLine : undefined;
    comments.push({ path: location.path, line, ...(startLine === undefined ? {} : { startLine }), side: "RIGHT", body: note.text.slice(0, 20_000), noteId: note.id });
  }
  return comments;
}

/**
 * The review the pane shows and the worker posts: the worker's drafted
 * comments plus those derived from included notes. Null outside PR mode, or
 * when there is neither a draft nor an included comment. A posted review is
 * returned as it was posted.
 */
export function mergedReviewDraft(walkthrough: Walkthrough, notes: Note[]): MergedReviewDraft | null {
  if (walkthrough.mode !== "pr") return null;
  const review = walkthrough.review;
  if (review?.status === "posted") return review;
  const derived = deriveReviewComments(notes);
  if (review === null && derived.length === 0) return null;
  const base: ReviewDraft = review ?? { body: "", event: "COMMENT", comments: [], status: "draft", url: null, updatedAt: walkthrough.updatedAt };
  const key = (comment: { path: string; line: number; body: string }) => `${comment.path}\0${comment.line}\0${comment.body.trim()}`;
  const seen = new Set(base.comments.map(key));
  return { ...base, comments: [...base.comments, ...derived.filter((comment) => !seen.has(key(comment)))].slice(0, 400) };
}

export type MergedReviewDraft = Omit<ReviewDraft, "comments"> & { comments: DerivedReviewComment[] };

// ---------------------------------------------------------------------------
// Text for the worker
// ---------------------------------------------------------------------------

/**
 * The letter the reader sees beside each of their own notes (a, b, … z, aa):
 * the same sequence the pane draws, so text sent to the thread or shown in
 * the wrap-up can say "your note (a)" instead of an internal id.
 */
export function noteMarkers(notes: Array<{ id: string; author: string; createdAt: number }>): Map<string, string> {
  const own = notes.filter((note) => note.author === "user").sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return new Map(own.map((note, index) => [note.id, markerLetters(index)]));
}

function markerLetters(index: number): string {
  let rest = index;
  let out = "";
  do {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return out;
}

/** How a reader-facing sentence names a note: "your todo (b)"; the helper's own notes have no marker. */
function noteMention(note: Pick<Note, "kind" | "author">, marker: string | undefined): string {
  const kind = NOTE_KIND_LABEL[note.kind].toLowerCase();
  return note.author === "user" && marker ? `your ${kind} (${marker})` : `the helper's ${kind}`;
}

/**
 * Replaces internal note ids ("n2") in text a reader will see with how the pane
 * names the note. The worker is told never to write ids; this is the net for
 * when it does. Only ids of real notes are touched.
 */
export function scrubNoteIds(text: string, notes: Note[]): string {
  if (!/\bn\d+\b/u.test(text)) return text;
  const markers = noteMarkers(notes);
  const byId = new Map(notes.map((note) => [note.id, note]));
  return text.replace(/\bn\d+\b/gu, (id) => {
    const note = byId.get(id);
    return note ? noteMention(note, markers.get(id)) : id;
  });
}

/** One note for the worker: its id (the tools take it) and the marker the reader sees. */
export function describeNoteForAgent(walkthrough: Walkthrough, note: Note, markers: Map<string, string> = new Map()): string {
  const locus = noteLocus(walkthrough, note);
  const marker = markers.get(note.id);
  const parts = [`${note.id}${marker ? ` (reader's marker: ${marker})` : ""} ${NOTE_KIND_LABEL[note.kind].toLowerCase()}`];
  if (note.status === "resolved") parts.push("resolved");
  const head = `${parts.join(", ")}${locus ? ` [${locus}]` : ""}`;
  const lines = [`- ${head}: ${JSON.stringify(note.text)}`];
  if (note.quote) lines.push(`  quoted: ${JSON.stringify(note.quote.slice(0, 400))}`);
  if (note.resolution) lines.push(`  outcome: ${JSON.stringify(note.resolution)}`);
  if (note.status === "open" && note.proposedResolution) lines.push(`  proposed outcome (awaiting the reader): ${JSON.stringify(note.proposedResolution)}`);
  return lines.join("\n");
}

/** One note as the reader's own thread receives it: named the way the reader sees it, never by an internal id. */
export function describeNoteForThread(walkthrough: Walkthrough, note: Note, markers: Map<string, string>): string {
  const locus = noteLocus(walkthrough, note);
  const lines = [`- ${noteMention(note, markers.get(note.id))}${locus ? ` [${locus}]` : ""}: ${JSON.stringify(note.text)}`];
  if (note.quote) lines.push(`  quoted: ${JSON.stringify(note.quote.slice(0, 400))}`);
  return lines.join("\n");
}

export function describeNotesForAgent(walkthrough: Walkthrough, notes: Note[]): string {
  if (notes.length === 0) return "No notes recorded.";
  const ordered = [
    ...NOTE_SECTIONS.flatMap((section) => notes.filter((note) => note.kind === section.kind && note.status === "open")),
    ...notes.filter((note) => note.status === "resolved"),
  ];
  const markers = noteMarkers(notes);
  return ordered.map((note) => describeNoteForAgent(walkthrough, note, markers)).join("\n");
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

/** The thread tab's title: "Walkthrough" until the walkthrough has a name of its own, then "Walkthrough: <name>". */
export function tabTitle(title: string): string {
  return title === "Walkthrough" || title.trim() === "" ? "Walkthrough" : `Walkthrough: ${title}`;
}
