// Repairs a stored walkthrough that kept helper narration as content (see
// narration.ts for what counts). Pure: takes the stored record and returns the
// repaired record with one entry per piece of text it changed. Running it on
// its own output changes nothing, so a repair can be repeated safely.
import { removeNarration, removeNarrationFromBlocks } from "./narration.ts";

interface StoredBlock {
  kind: string;
  text?: string;
}
interface StoredPart {
  blocks: StoredBlock[];
}
/** The fields of a stored walkthrough the repair reads; every other field is carried through untouched. */
export interface RepairableWalkthrough {
  introduction: string;
  parts: StoredPart[];
}

export interface NarrationChange {
  /** "introduction" or "part N" (1-based). */
  where: string;
  /** The narration paragraph removed. */
  removed: string;
}

export interface Repair<T extends RepairableWalkthrough> {
  walkthrough: T;
  changes: NarrationChange[];
}

export function repairNarration<T extends RepairableWalkthrough>(walkthrough: T): Repair<T> {
  const changes: NarrationChange[] = [];
  const intro = removeNarration(walkthrough.introduction);
  for (const removed of intro.removed) changes.push({ where: "introduction", removed });
  const parts = walkthrough.parts.map((part, index) => {
    const { blocks, removed } = removeNarrationFromBlocks(part.blocks);
    if (removed.length === 0) return part;
    for (const text of removed) changes.push({ where: `part ${index + 1}`, removed: text });
    return { ...part, blocks };
  });
  if (changes.length === 0) return { walkthrough, changes };
  return { walkthrough: { ...walkthrough, introduction: intro.text, parts }, changes };
}
