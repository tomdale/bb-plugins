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

export function partState(walkthrough: Walkthrough, part: Part): PartState {
  if (isOutdated(walkthrough, part)) return "stale";
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
