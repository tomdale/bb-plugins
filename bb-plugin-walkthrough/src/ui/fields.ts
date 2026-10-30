// Reads of the fields the redesign added to the wire schema. Each is optional
// on rows and builds that predate it, so the pane reads them here, with the
// contract's defaults, instead of trusting the type to have them.
import { isOutdated } from "../staleness.ts";
import type { CodeBlock, Exchange, Note, Part, Walkthrough } from "../schemas.ts";

export type Intent = "review" | "own-change" | "understand";
export type CodeView = "diff" | "code";
export type PartState = "ready" | "writing" | "pending" | "failed" | "stale";

export interface Snapshot {
  change: string | null;
  after: string | null;
  before: string | null;
}

export function intentOf(walkthrough: Walkthrough): Intent {
  const intent = (walkthrough as { intent?: unknown }).intent;
  if (intent === "review" || intent === "own-change" || intent === "understand") return intent;
  return walkthrough.mode === "pr" ? "review" : "own-change";
}

export function codeViewOf(block: CodeBlock): CodeView {
  return (block as { view?: unknown }).view === "code" ? "code" : "diff";
}

/** The excerpt text saved with the block, or null for blocks that predate snapshots or failed to capture one. */
export function snapshotOf(block: CodeBlock): Snapshot | null {
  const snapshot = (block as { snapshot?: Partial<Snapshot> | null }).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const side = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const result = { change: side(snapshot.change), after: side(snapshot.after), before: side(snapshot.before) };
  return result.change || result.after || result.before ? result : null;
}

/** Whether a note is part of the review draft: comments are by default; anything else only when marked. */
export function includedInReview(note: Note): boolean {
  const flag = (note as { includeInReview?: unknown }).includeInReview;
  return typeof flag === "boolean" ? flag : note.kind === "comment";
}

/** Questions shown above the pager: the latest finished answer's follow-ups when it has some, else the part's own. */
export function suggestionsFor(part: Part): string[] {
  const asked = new Set(part.discussion.map((exchange) => exchange.question));
  const latest: Exchange | undefined = part.discussion[part.discussion.length - 1];
  const fromAnswer = latest?.status === "done" ? ((latest as { suggestions?: unknown }).suggestions as string[] | undefined) : undefined;
  const source = Array.isArray(fromAnswer) && fromAnswer.length > 0 ? fromAnswer : part.suggestions;
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
