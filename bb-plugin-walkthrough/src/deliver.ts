// The boundary where a stored walkthrough becomes what the pane receives. The
// store already backfills the fields older rows lack; this narrows the types so
// the pane can read them without guarding, and fills them again for any row
// that reached here by another path.
import { computeCoverage } from "./coverage.ts";
import { displayPath, repoPathFromPatch, repoRootOf, workspaceRelativePath } from "./files.ts";
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

/**
 * The path inside its repository that a code block names. The worker may write
 * a machine path (and for code outside the thread's workspace, always does), so
 * the saved name wins, then the one the snapshot's own patch header carries,
 * then the workspace-relative form.
 */
export function blockDisplayPath(block: Pick<Extract<Block, { kind: "code" }>, "path" | "displayPath" | "snapshot">, workspacePath: string | null, repoRoots: readonly string[] = []): string {
  return (
    block.displayPath ||
    repoPathFromPatch(block.snapshot?.after ?? block.snapshot?.change ?? block.snapshot?.before) ||
    workspaceRelativePath(block.path, workspacePath) ||
    displayPath(block.path, { workspacePath, repoRoots })
  );
}

function deliverBlock(block: Block, workspacePath: string | null, repoRoots: readonly string[]): DeliveredBlock {
  if (block.kind !== "code") return block;
  return { ...block, view: block.view ?? "diff", snapshot: block.snapshot ?? null, snapshotError: block.snapshotError ?? null, displayPath: blockDisplayPath(block, workspacePath, repoRoots) };
}

function deliverPart(part: Part, workspacePath: string | null, repoRoots: readonly string[]): DeliveredPart {
  return { ...part, blocks: part.blocks.map((block) => deliverBlock(block, workspacePath, repoRoots)), staleFiles: part.staleFiles ?? [] };
}

/** The directories the figures' files were read from, found by cutting each block's repository path off its machine path. */
function repoRootsOf(walkthrough: Walkthrough): string[] {
  const roots = new Set<string>();
  for (const part of [...walkthrough.parts, ...(walkthrough.wrapUp ? [walkthrough.wrapUp] : [])]) {
    for (const block of part.blocks) {
      if (block.kind !== "code") continue;
      const relative = block.displayPath || repoPathFromPatch(block.snapshot?.after ?? block.snapshot?.change ?? block.snapshot?.before);
      const root = relative ? repoRootOf(block.path, relative) : null;
      if (root) roots.add(root);
    }
  }
  return [...roots];
}

export function deliverWalkthrough(walkthrough: Walkthrough): DeliveredWalkthrough {
  const repoRoots = repoRootsOf(walkthrough);
  return {
    ...walkthrough,
    intent: walkthrough.intent ?? defaultIntent(walkthrough.mode),
    parts: walkthrough.parts.map((part) => deliverPart(part, walkthrough.workspacePath, repoRoots)),
    wrapUp: walkthrough.wrapUp && deliverPart(walkthrough.wrapUp, walkthrough.workspacePath, repoRoots),
    repoRoots,
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
