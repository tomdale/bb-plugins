// Narrows a single-file unified patch to the hunks that touch a line range,
// so a chat directive can show just the change a group's narration discusses.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

export interface FilteredPatch {
  patch: string;
  /** True when at least one hunk was dropped. */
  filtered: boolean;
}

/**
 * Keeps hunks whose new-side span intersects [startLine, endLine]. A range
 * that matches no hunk returns the whole patch unfiltered, because showing
 * the full change beats showing nothing when the agent's line numbers drift.
 */
export function filterPatchToRange(patch: string, startLine: number, endLine: number): FilteredPatch {
  const lines = patch.split("\n");
  const header: string[] = [];
  const hunks: Array<{ start: number; end: number; lines: string[] }> = [];
  for (const line of lines) {
    const match = HUNK_HEADER.exec(line);
    if (match !== null) {
      const start = Number(match[3]);
      const count = match[4] === undefined ? 1 : Number(match[4]);
      hunks.push({ start, end: start + Math.max(count, 1) - 1, lines: [line] });
    } else if (hunks.length === 0) {
      header.push(line);
    } else {
      hunks[hunks.length - 1]!.lines.push(line);
    }
  }
  const low = Math.min(startLine, endLine);
  const high = Math.max(startLine, endLine);
  const kept = hunks.filter((hunk) => hunk.start <= high && hunk.end >= low);
  if (kept.length === 0 || kept.length === hunks.length) return { patch, filtered: false };
  const body = [...header, ...kept.flatMap((hunk) => hunk.lines)].join("\n");
  return { patch: body.endsWith("\n") ? body : `${body}\n`, filtered: true };
}
