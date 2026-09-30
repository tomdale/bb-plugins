// Narrows a single-file unified patch to a new-side line range, so a chat
// directive or panel diff shows just the change a narration discusses.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

export interface FilteredPatch {
  patch: string;
  /** True when hunks or lines outside the range were dropped. */
  filtered: boolean;
}

interface Hunk {
  oldStart: number;
  newStart: number;
  suffix: string;
  lines: string[];
}

function parse(patch: string): { header: string[]; hunks: Hunk[] } {
  const header: string[] = [];
  const hunks: Hunk[] = [];
  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (match !== null) {
      hunks.push({ oldStart: Number(match[1]), newStart: Number(match[3]), suffix: match[5] ?? "", lines: [] });
    } else if (hunks.length === 0) {
      header.push(line);
    } else if (line !== "" || hunks.length > 0) {
      hunks[hunks.length - 1]!.lines.push(line);
    }
  }
  // A trailing newline in the patch leaves one empty line in the last hunk.
  const last = hunks[hunks.length - 1];
  if (last && last.lines[last.lines.length - 1] === "") last.lines.pop();
  return { header, hunks };
}

/**
 * Cuts one hunk down to the lines whose new-side position falls in
 * [low, high]. Removed lines count at the new-side position they precede.
 * Returns null when nothing in the hunk is in range.
 */
function sliceHunk(hunk: Hunk, low: number, high: number): { hunk: string[]; trimmed: boolean } | null {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const kept: string[] = [];
  let firstOld: number | null = null;
  let firstNew: number | null = null;
  let oldCount = 0;
  let newCount = 0;
  let dropped = false;
  for (const line of hunk.lines) {
    const marker = line[0];
    const inRange = newLine >= low && newLine <= high;
    if (marker === "\\") {
      if (kept.length > 0) kept.push(line);
      continue;
    }
    if (inRange) {
      if (firstOld === null) {
        firstOld = oldLine;
        firstNew = newLine;
      }
      kept.push(line);
      if (marker !== "+") oldCount += 1;
      if (marker !== "-") newCount += 1;
    } else {
      dropped = true;
    }
    if (marker !== "+") oldLine += 1;
    if (marker !== "-") newLine += 1;
  }
  if (kept.length === 0 || firstOld === null || firstNew === null) return null;
  // Unified diff headers use start 0 for an empty side (an added or deleted file).
  const oldStart = oldCount === 0 ? Math.max(firstOld - 1, 0) : firstOld;
  const newStart = newCount === 0 ? Math.max(firstNew - 1, 0) : firstNew;
  return {
    hunk: [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk.suffix}`, ...kept],
    trimmed: dropped,
  };
}

/**
 * Keeps the parts of the patch whose new-side lines intersect
 * [startLine, endLine]. A range that matches nothing returns the whole
 * patch unfiltered, because showing the full change beats showing nothing
 * when the agent's line numbers drift.
 */
export function filterPatchToRange(patch: string, startLine: number, endLine: number): FilteredPatch {
  const low = Math.min(startLine, endLine);
  const high = Math.max(startLine, endLine);
  const { header, hunks } = parse(patch);
  const sliced = hunks.map((hunk) => sliceHunk(hunk, low, high));
  const kept = sliced.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (kept.length === 0) return { patch, filtered: false };
  const filtered = kept.length !== hunks.length || kept.some((entry) => entry.trimmed);
  if (!filtered) return { patch, filtered: false };
  return { patch: `${[...header, ...kept.flatMap((entry) => entry.hunk)].join("\n")}\n`, filtered: true };
}
