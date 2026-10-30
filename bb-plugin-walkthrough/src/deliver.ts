// The boundary where a stored walkthrough becomes what the pane receives. The
// store already backfills the fields older rows lack; this narrows the types so
// the pane can read them without guarding, and fills them again for any row
// that reached here by another path.
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
  return { ...part, blocks: part.blocks.map(deliverBlock) };
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
  return { ...note, includeInReview: note.includeInReview ?? note.kind === "comment" };
}

export function deliverView(view: { walkthrough: Walkthrough; notes: Note[]; reviewDraft: WalkthroughView["reviewDraft"] }): WalkthroughView {
  return { walkthrough: deliverWalkthrough(view.walkthrough), notes: view.notes.map(deliverNote), reviewDraft: view.reviewDraft };
}
