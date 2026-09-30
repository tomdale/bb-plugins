// Pure walkthrough logic shared by the server and the pane: labels, the
// notes Markdown mirror, and text handed to the worker agent.
import type { Location, Mode, Note, NoteKind, Part, Walkthrough } from "./schemas.ts";

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

/** Abbreviates a full commit SHA; branch names and short refs pass through. */
export function shortRef(ref: string): string {
  return /^[0-9a-f]{12,40}$/iu.test(ref) ? ref.slice(0, 8) : ref;
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

/** The `.agent/review-notes.md` mirror: nonempty sections only. */
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
