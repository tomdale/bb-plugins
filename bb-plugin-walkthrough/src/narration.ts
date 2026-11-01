// A conservative backstop for helper narration that reached content despite
// the protocol (stream-markup.ts keeps it out at the source: content starts at
// the start marker and ends with the suggestions fence). It removes only whole
// paragraphs at the edges of a text: a short meta line before the content
// ("Now let me set up the walkthrough plan.", "Let me read the code first.",
// "I'll walk through ...") or a short confirmation after it ("Done, part 3
// committed.", "I've written part 2."). Prose in the middle is never touched,
// and neither is an edge paragraph that does not match: "First, the key is
// read from the header." and "Done reading, the loop exits." stay.
//
// One place serves saving (stream-commit.ts), delivery (deliver.ts), the live
// preview (ui/stream.ts) and the repair script (repair-narration.ts), so what
// a reader sees while a part streams is what is saved and later delivered.

/** Longest paragraph that can be narration; anything longer is explanation. */
const MAX_NARRATION = 320;

const LEADING = [
  // "Now let me ...", "Let me read ...", "Okay, let me ..."
  /^(?:(?:now|ok(?:ay)?|alright|right|so|first|next)[,.]?\s+)?let me\b/iu,
  // "I'll walk through ...", "Now I'll set up ...", "I will start by ..."
  /^(?:(?:now|ok(?:ay)?|alright|so|first|next)[,.]?\s+)?i(?:'ll|\u2019ll| will| am going to|'m going to|\u2019m going to)\s+(?:now\s+|first\s+|start\s+by\s+|begin\s+by\s+)?(?:walk|set up|start|read|look|write|trace|begin|check|take|explain|go through|dig|open|put together|plan|explore|find|figure|review|cover|show)\b/iu,
  // "First, I need to read ...", "First I'll ..."
  /^first,?\s+(?:i need to|i'll|i\u2019ll|i will|i'm going to|i\u2019m going to|i should)\b/iu,
];

const TRAILING = [
  // "Now let me set up the walkthrough plan." closing a message that is about to call a tool. ("I'll ..." after content is a legitimate roadmap sentence.)
  LEADING[0]!,
  // "Done.", "Done, part 3 committed.", "Committed.", "All set."
  /^(?:done|committed|finished|all set|all done)\b[\s.,!:\u2014-]*(?:part\s+\d+\s+[^.!\n]{0,60})?[.!]?$/iu,
  // "I've written part 2.", "I have committed the part."
  /^i(?:'ve|\u2019ve| have)\s+(?:now\s+)?(?:written|committed|saved|added|put|finished|submitted|set up)\b/iu,
  // "Part 3 is on the page.", "Part 1 is in the pane — ..."
  /^part\s+\d+\s+(?:is|was|has been)\s+(?:now\s+)?(?:on the page|in the pane|committed|written|saved|done|ready)\b/iu,
];

function narrationAt(paragraph: string, patterns: RegExp[]): boolean {
  const text = paragraph.trim();
  if (text === "" || text.length > MAX_NARRATION) return false;
  return patterns.some((pattern) => pattern.test(text));
}

/** A paragraph that is one narration line, or several of them. */
function isNarration(paragraph: string, patterns: RegExp[]): boolean {
  const lines = paragraph.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 0 && lines.every((line) => narrationAt(line, patterns)) && paragraph.trim().length <= MAX_NARRATION * 2;
}

export interface ProseEdges {
  /** Strip narration before the content. Off for a block that is not the first of its text. */
  leading: boolean;
  /** Strip narration after the content. Off for a block that is not the last of its text. */
  trailing: boolean;
}

const BOTH: ProseEdges = { leading: true, trailing: true };

/** The text without narration paragraphs at the enabled edges, and the paragraphs removed. */
function split(text: string, edges: ProseEdges): { kept: string; removed: string[] } {
  const paragraphs = text.replace(/\r\n?/gu, "\n").split(/\n{2,}/u);
  let start = 0;
  let end = paragraphs.length;
  if (edges.leading) while (start < end && isNarration(paragraphs[start]!, LEADING)) start += 1;
  if (edges.trailing) while (end > start && isNarration(paragraphs[end - 1]!, TRAILING)) end -= 1;
  if (start === 0 && end === paragraphs.length) return { kept: text, removed: [] };
  return { kept: paragraphs.slice(start, end).join("\n\n").trim(), removed: [...paragraphs.slice(0, start), ...paragraphs.slice(end)].map((paragraph) => paragraph.trim()) };
}

/** The text without narration paragraphs at the enabled edges. Idempotent. */
export function stripNarration(text: string, edges: ProseEdges = BOTH): string {
  return split(text, edges).kept;
}

/** stripNarration, also returning each paragraph it removed. */
export function removeNarration(text: string): { text: string; removed: string[] } {
  const { kept, removed } = split(text, BOTH);
  return { text: kept, removed };
}

interface ProseLike {
  kind: string;
  text?: string;
}

/**
 * Applies the edge rules to the first and last prose blocks of a part when no
 * other kind of block lies before (after) them, and drops blocks it empties.
 * A prose block that is not at an edge of the part keeps its text. Also returns
 * each paragraph removed.
 */
export function removeNarrationFromBlocks<T extends ProseLike>(blocks: readonly T[]): { blocks: T[]; removed: string[] } {
  const result = [...blocks];
  const removed: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const side of ["leading", "trailing"] as const) {
      const index = side === "leading" ? 0 : result.length - 1;
      const block = result[index];
      if (block === undefined || block.kind !== "prose" || typeof block.text !== "string") continue;
      const found = split(block.text, { leading: side === "leading", trailing: side === "trailing" });
      if (found.removed.length === 0) continue;
      changed = true;
      removed.push(...found.removed);
      if (found.kept === "") result.splice(index, 1);
      else result[index] = { ...block, text: found.kept };
    }
  }
  return removed.length === 0 ? { blocks: [...blocks], removed } : { blocks: result, removed };
}

/** removeNarrationFromBlocks without the report. */
export function stripNarrationFromBlocks<T extends ProseLike>(blocks: readonly T[]): T[] {
  return removeNarrationFromBlocks(blocks).blocks;
}
