// Small derivations over the delivered walkthrough: which pages exist, how a
// part reads, which questions to suggest. The wire types guarantee the fields
// the redesign added, so nothing here guards for their absence.
import { isOutdated } from "../staleness.ts";
import type { DeliveredCodeBlock, DeliveredPart as Part, DeliveredWalkthrough as Walkthrough, Exchange } from "../schemas.ts";

export type PartState = "ready" | "writing" | "pending" | "failed" | "stale";

export interface Snapshot {
  change: string | null;
  after: string | null;
  before: string | null;
}

/** The excerpt text saved with the block, or null when none was captured (or every side is empty). */
export function savedExcerpt(block: DeliveredCodeBlock): Snapshot | null {
  const { snapshot } = block;
  if (!snapshot) return null;
  const side = (value: string | null) => (value === "" ? null : value);
  const result = { change: side(snapshot.change), after: side(snapshot.after), before: side(snapshot.before) };
  return result.change || result.after || result.before ? result : null;
}

/** Questions shown above the pager: the latest finished answer's follow-ups when it has some, else the part's own. */
export function suggestionsFor(part: Part): string[] {
  const asked = new Set(part.discussion.map((exchange) => exchange.question));
  const latest: Exchange | undefined = part.discussion[part.discussion.length - 1];
  const fromAnswer = latest?.status === "done" ? latest.suggestions : undefined;
  const source = fromAnswer && fromAnswer.length > 0 ? fromAnswer : part.suggestions;
  return source.filter((question) => typeof question === "string" && question.trim() !== "" && !asked.has(question)).slice(0, 3);
}

/**
 * Whether the code a ready part cites has changed since it was written. When the
 * part says which cited files changed (`staleFiles`), only those count, so an
 * unrelated edit elsewhere in the change does not mark it; older parts fall back
 * to the whole-change fingerprint.
 */
export function isStale(walkthrough: Walkthrough, part: Part): boolean {
  const { staleFiles } = part as Part & { staleFiles?: string[] };
  if (Array.isArray(staleFiles)) return walkthrough.status !== "done" && part.status === "ready" && staleFiles.length > 0;
  return isOutdated(walkthrough, part);
}

export function partState(walkthrough: Walkthrough, part: Part): PartState {
  if (isStale(walkthrough, part)) return "stale";
  return part.status;
}

export const PART_STATE_LABEL: Record<PartState, string> = {
  ready: "Ready",
  writing: "Writing",
  pending: "Not started",
  failed: "Failed",
  stale: "Out of date",
};

/** A page of the reader: the introduction, one part, or the wrap-up. */
export type PageId = { kind: "intro" } | { kind: "part"; index: number } | { kind: "wrap-up" };

/** Position of a page among all pages (introduction first, wrap-up last). */
export function pagePosition(page: PageId, partCount: number): number {
  return page.kind === "intro" ? 0 : page.kind === "part" ? page.index + 1 : partCount + 1;
}

export function pageAt(position: number, partCount: number): PageId {
  if (position <= 0) return { kind: "intro" };
  if (position > partCount) return { kind: "wrap-up" };
  return { kind: "part", index: position - 1 };
}

/** "model.ts" from "src/service/model.ts". */
export function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * The marker each reader flag wears. The agent's margin notes are numbered; a
 * reader's flags are lettered (a, b, … z, aa, …) in the order they were made, so
 * the two sequences never renumber or collide.
 */
export function flagGlyphs(notes: Array<{ id: string; author: string; createdAt: number }>): Map<string, string> {
  const own = notes.filter((note) => note.author === "user").sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return new Map(own.map((note, index) => [note.id, letters(index)]));
}

function letters(index: number): string {
  let rest = index;
  let out = "";
  do {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return out;
}

/** The last two segments of a path ("src/model.ts"), enough to tell same-named files apart. */
export function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}
