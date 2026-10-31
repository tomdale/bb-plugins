// Naming the files a walkthrough's figures show: relative to the repository
// each was read from, never as a machine path. Pure, so the server (delivery,
// coverage) and the pane share one answer.
import { displayPath, repoPathFromPatch, repoRootOf, workspaceRelativePath } from "./files.ts";
import type { Block, Walkthrough } from "./schemas.ts";

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

/** The directories the figures' files were read from, found by cutting each block's repository path off its machine path. */
export function repoRootsOf(walkthrough: Pick<Walkthrough, "parts" | "wrapUp">): string[] {
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

