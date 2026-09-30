// Pure walkthrough logic: state transitions, command parsing, the notes
// Markdown mirror, and text the agent receives. Nothing here touches BB, so
// the server and the frontend share it and tests exercise it directly.
import type {
  Group,
  Location,
  Mode,
  Note,
  NoteKind,
  PauseResponse,
  PauseStage,
  Walkthrough,
} from "./schemas.ts";

export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  question: "Question",
  todo: "Todo",
  comment: "Comment",
  note: "Note",
};

/** Section order of the notes file and the panel's Notes view. */
export const NOTE_SECTIONS: ReadonlyArray<{ kind: NoteKind; title: string }> = [
  { kind: "question", title: "Questions" },
  { kind: "comment", title: "Comments" },
  { kind: "todo", title: "Todos" },
  { kind: "note", title: "Notes" },
];

/** Kinds offered as primary record buttons; the rest sit behind "More". */
export function primaryNoteKinds(mode: Mode): NoteKind[] {
  return mode === "pr" ? ["question", "comment", "todo"] : ["question", "todo"];
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

export function groupLabel(walkthrough: Walkthrough, index: number | null): string | null {
  if (index === null) return null;
  const group = walkthrough.groups[index];
  return group ? `Group ${index + 1}: ${group.title}` : `Group ${index + 1}`;
}

/** "Group 2: Storage · src/store.ts:10-30", or null when neither is known. */
export function noteLocus(walkthrough: Walkthrough, note: Note): string | null {
  const parts = [groupLabel(walkthrough, note.groupIndex), formatLocation(note.location)];
  const present = parts.filter((part): part is string => part !== null);
  return present.length === 0 ? null : present.join(" · ");
}

// ---------------------------------------------------------------------------
// Dotted commands
// ---------------------------------------------------------------------------

export type CommandIntent =
  | { kind: "navigate"; action: "next" | "finish" }
  | { kind: "notes" }
  | { kind: "record"; noteKind: NoteKind; text: string }
  | { kind: "incomplete"; noteKind: NoteKind }
  | { kind: "text"; text: string };

const RECORD_COMMANDS: Record<string, NoteKind> = {
  ".question": "question",
  ".todo": "todo",
  ".comment": "comment",
  ".note": "note",
};

/**
 * Interprets text typed into the pause form. The canonical dotted commands
 * keep working there; anything else is a question for the agent.
 */
export function parseCommand(input: string): CommandIntent {
  const text = input.trim();
  const match = /^(\.[a-z]+)(?:\s+([\s\S]*))?$/u.exec(text);
  if (match === null) return { kind: "text", text };
  const command = match[1]!;
  const rest = (match[2] ?? "").trim();
  if (command === ".next" && rest === "") return { kind: "navigate", action: "next" };
  if (command === ".finish" && rest === "") return { kind: "navigate", action: "finish" };
  if (command === ".notes" && rest === "") return { kind: "notes" };
  const noteKind = RECORD_COMMANDS[command];
  if (noteKind !== undefined) {
    return rest === "" ? { kind: "incomplete", noteKind } : { kind: "record", noteKind, text: rest };
  }
  return { kind: "text", text };
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export function pauseStage(walkthrough: Walkthrough): PauseStage | null {
  switch (walkthrough.status) {
    case "overview":
      return "overview";
    case "reviewing":
      return "group";
    case "finishing":
      return "finish";
    case "finished":
      return null;
  }
}

export function nextGroupIndex(walkthrough: Walkthrough): number | null {
  const start = walkthrough.currentGroup === null ? 0 : walkthrough.currentGroup + 1;
  for (let index = start; index < walkthrough.groups.length; index += 1) {
    if (walkthrough.groups[index]!.status === "pending") return index;
  }
  return null;
}

function withGroupStatus(groups: Group[], index: number, status: Group["status"]): Group[] {
  return groups.map((group, candidate) => (candidate === index ? { ...group, status } : group));
}

/** Moves to the next pending group, or into finishing when none remain. */
export function advance(walkthrough: Walkthrough, now: number): Walkthrough {
  let groups = walkthrough.groups;
  if (walkthrough.currentGroup !== null) groups = withGroupStatus(groups, walkthrough.currentGroup, "done");
  const next = nextGroupIndex(walkthrough);
  if (next === null) return enterFinishing({ ...walkthrough, groups }, now);
  groups = withGroupStatus(groups, next, "current");
  return { ...walkthrough, groups, currentGroup: next, status: "reviewing", updatedAt: now };
}

/** Closes the review loop: the current group counts as covered, the rest as skipped. */
export function enterFinishing(walkthrough: Walkthrough, now: number): Walkthrough {
  const groups = walkthrough.groups.map((group): Group => {
    if (group.status === "current") return { ...group, status: "done" };
    if (group.status === "pending") return { ...group, status: "skipped" };
    return group;
  });
  return { ...walkthrough, groups, currentGroup: null, status: "finishing", updatedAt: now };
}

export function complete(walkthrough: Walkthrough, now: number): Walkthrough {
  const finishing = walkthrough.status === "finishing" ? walkthrough : enterFinishing(walkthrough, now);
  return { ...finishing, status: "finished", updatedAt: now };
}

export function applyPauseResponse(walkthrough: Walkthrough, response: PauseResponse, now: number): Walkthrough {
  switch (response.action) {
    case "next":
      return walkthrough.status === "finishing" ? walkthrough : advance(walkthrough, now);
    case "finish":
      return walkthrough.status === "finishing" ? walkthrough : enterFinishing(walkthrough, now);
    case "complete":
      return complete(walkthrough, now);
    case "ask":
      return walkthrough;
  }
}

/**
 * Replaces the groups that have not been presented yet. Presented groups
 * (done, skipped, or current) keep their position and status.
 */
export function reviseOutline(
  walkthrough: Walkthrough,
  upcoming: Array<Pick<Group, "title" | "summary" | "locations">>,
  now: number,
): Walkthrough {
  const presented = walkthrough.groups.filter((group) => group.status !== "pending");
  const groups: Group[] = [...presented, ...upcoming.map((group): Group => ({ ...group, status: "pending" }))];
  return { ...walkthrough, groups, updatedAt: now };
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
    out.push(
      "## Resolved / Answered",
      "",
      ...resolved.map((note) => bullet(walkthrough, note, NOTE_KIND_LABEL[note.kind])),
      "",
    );
  }
  return `${out.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Agent-facing text
// ---------------------------------------------------------------------------

export function describeNoteForAgent(walkthrough: Walkthrough, note: Note): string {
  const locus = noteLocus(walkthrough, note);
  const parts = [`${note.id} ${NOTE_KIND_LABEL[note.kind].toLowerCase()}`];
  if (note.status === "resolved") parts.push("resolved");
  if (note.author === "agent") parts.push("recorded by you");
  const head = `${parts.join(", ")}${locus ? ` [${locus}]` : ""}`;
  const lines = [`- ${head}: ${JSON.stringify(note.text)}`];
  if (note.quote) lines.push(`  quoted: ${JSON.stringify(note.quote.slice(0, 400))}`);
  if (note.resolution) lines.push(`  answer: ${JSON.stringify(note.resolution)}`);
  return lines.join("\n");
}

export function describeNotesForAgent(walkthrough: Walkthrough, notes: Note[]): string {
  if (notes.length === 0) return "No notes recorded.";
  const ordered = [
    ...NOTE_SECTIONS.flatMap((section) =>
      notes.filter((note) => note.kind === section.kind && note.status === "open"),
    ),
    ...notes.filter((note) => note.status === "resolved"),
  ];
  return ordered.map((note) => describeNoteForAgent(walkthrough, note)).join("\n");
}

export function describeProgress(walkthrough: Walkthrough): string {
  const total = walkthrough.groups.length;
  switch (walkthrough.status) {
    case "overview":
      return `overview (outline of ${total} groups shown; group 1 not started)`;
    case "reviewing": {
      const index = walkthrough.currentGroup ?? 0;
      return `reviewing group ${index + 1} of ${total} (${JSON.stringify(walkthrough.groups[index]?.title ?? "")})`;
    }
    case "finishing":
      return "finishing (recap and follow-up)";
    case "finished":
      return "finished";
  }
}

export function describeOutline(walkthrough: Walkthrough): string {
  return walkthrough.groups
    .map((group, index) => `${index + 1}. [${group.status}] ${group.title}`)
    .join("\n");
}

/** Short procedure reminder for the finish phase; the skill holds the full rules. */
export function finishProcedure(mode: Mode): string {
  if (mode === "pr") {
    return [
      "Finish procedure (PR mode). Do the note work first, then pause, then write the recap as your final message:",
      "1. Todos: complete or resolve each locally; stop and ask when one is ambiguous, risky, blocked, or needs input. Resolve completed todos with walkthrough_note (status resolved, resolution = outcome); leave blocked ones open.",
      "2. Questions: answer from code, diff, tests, commits, and the PR body; resolve answered ones with walkthrough_note; leave author-intent or unavailable facts open.",
      "3. Call walkthrough_pause with follow-up offers as suggestions; offer the draft review there when comments or open questions exist. Build it with walkthrough_review only after the user accepts. Never post or submit anything without a separate explicit request.",
      "4. Final message: a brief recap of the sequence, what you resolved, and what remains open.",
    ].join("\n");
  }
  return [
    "Finish procedure (local mode). Do the note work first, then pause, then write the recap as your final message:",
    "1. Resolve recorded questions from code, diff, tests, and commits with walkthrough_note (status resolved, resolution = the answer); leave unknowable questions open. Do not act on todos yet.",
    "2. Call walkthrough_pause with follow-up offers as suggestions: remaining-question investigation and todo edits or a plan. Never offer a GitHub review solely because notes exist.",
    "3. Final message: a brief recap of the sequence, the answers, and what remains open.",
  ].join("\n");
}
