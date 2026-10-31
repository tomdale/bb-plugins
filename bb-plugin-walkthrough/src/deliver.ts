// The boundary where a stored walkthrough becomes what the pane receives. The
// store already backfills the fields older rows lack; this narrows the types so
// the pane can read them without guarding, and fills them again for any row
// that reached here by another path.
import { computeCoverage } from "./coverage.ts";
import { intentCopy, scrubNoteIds } from "./model.ts";
import {
  defaultIntent,
  type Block,
  type DeliveredNote,
  type DeliveredPart,
  type DeliveredWalkthrough,
  type Note,
  type Part,
  type Walkthrough,
  type WalkthroughView,
} from "./schemas.ts";

type DeliveredBlock = DeliveredPart["blocks"][number];

function deliverBlock(block: Block): DeliveredBlock {
  if (block.kind !== "code") return block;
  return { ...block, view: block.view ?? "diff", snapshot: block.snapshot ?? null, snapshotError: block.snapshotError ?? null };
}

function deliverPart(part: Part): DeliveredPart {
  return { ...part, blocks: part.blocks.map(deliverBlock), staleFiles: part.staleFiles ?? [] };
}

export function deliverWalkthrough(walkthrough: Walkthrough): DeliveredWalkthrough {
  return {
    ...walkthrough,
    intent: walkthrough.intent ?? defaultIntent(walkthrough.mode),
    parts: walkthrough.parts.map(deliverPart),
    wrapUp: walkthrough.wrapUp && deliverPart(walkthrough.wrapUp),
  };
}

export function deliverNote(note: Note): DeliveredNote {
  return { ...note, includeInReview: note.includeInReview ?? note.kind === "comment", proposedResolution: note.proposedResolution ?? null };
}

/** The worker's prose, with any internal note id it wrote replaced by the name the pane gives the note. */
function scrubPart(part: DeliveredPart, notes: Note[]): DeliveredPart {
  const scrub = (text: string) => scrubNoteIds(text, notes);
  return {
    ...part,
    summary: scrub(part.summary),
    message: part.message === null ? null : scrub(part.message),
    blocks: part.blocks.map((block) => (block.kind === "prose" ? { ...block, text: scrub(block.text) } : block)),
    discussion: part.discussion.map((exchange) => ({ ...exchange, answer: scrub(exchange.answer) })),
  };
}

export function deliverView(view: { walkthrough: Walkthrough; notes: Note[]; reviewDraft: WalkthroughView["reviewDraft"] }): WalkthroughView {
  const delivered = deliverWalkthrough(view.walkthrough);
  const walkthrough: DeliveredWalkthrough = {
    ...delivered,
    message: delivered.message === null ? null : scrubNoteIds(delivered.message, view.notes),
    introduction: scrubNoteIds(delivered.introduction, view.notes),
    parts: delivered.parts.map((part) => scrubPart(part, view.notes)),
    wrapUp: delivered.wrapUp && scrubPart(delivered.wrapUp, view.notes),
  };
  return {
    walkthrough,
    notes: view.notes.map((note) => {
      const delivered = deliverNote(note);
      return {
        ...delivered,
        resolution: delivered.resolution == null ? null : scrubNoteIds(delivered.resolution, view.notes),
        proposedResolution: delivered.proposedResolution == null ? null : scrubNoteIds(delivered.proposedResolution, view.notes),
      };
    }),
    coverage: computeCoverage(view.walkthrough, view.walkthrough.changeSet),
    copy: intentCopy(walkthrough),
    reviewDraft: view.reviewDraft,
  };
}
