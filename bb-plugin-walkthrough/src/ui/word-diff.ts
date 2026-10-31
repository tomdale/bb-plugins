// Word-level emphasis inside a diff: where a removed line and the added line
// that replaces it differ, the changed words are marked, so the eye lands on
// what changed rather than rereading both lines. Pure functions over the rows
// the figure already has; nothing here touches the patch or what is copied.
import type { PatchRow } from "./patch-lines.ts";

/** Character ranges `[start, end)` of a line that differ from its counterpart. */
export type Emphasis = Array<[start: number, end: number]>;

const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\s\p{L}\p{N}_$]/gu;
/** Lines this far apart in size are compared by their shared start and end only: the table below is quadratic. */
const MAX_TOKENS = 60;
/** Below this share of matching characters the two lines are different statements, and marking every word would only be noise. */
const MIN_SIMILARITY = 0.5;

const tokens = (text: string): string[] => text.match(TOKEN) ?? [];
const weight = (token: string): number => (/^\s+$/u.test(token) ? 0 : token.length);

/** Which tokens of `a` and of `b` are part of their longest common subsequence. */
function commonTokens(a: string[], b: string[]): { a: boolean[]; b: boolean[] } {
  const keptA = a.map(() => false);
  const keptB = b.map(() => false);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  for (let index = 0; index < head; index += 1) keptA[index] = keptB[index] = true;
  for (let index = 1; index <= tail; index += 1) {
    keptA[a.length - index] = true;
    keptB[b.length - index] = true;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 || midB.length === 0 || midA.length > MAX_TOKENS || midB.length > MAX_TOKENS) return { a: keptA, b: keptB };
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  const table = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      keptA[head + i] = keptB[head + j] = true;
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return { a: keptA, b: keptB };
}

/** The changed stretches of one side as character ranges; whitespace-only stretches are not worth marking. */
function ranges(parts: string[], kept: boolean[]): Emphasis {
  const found: Emphasis = [];
  let offset = 0;
  let open: number | null = null;
  parts.forEach((part, index) => {
    if (!kept[index]) open ??= offset;
    else if (open !== null) {
      found.push([open, offset]);
      open = null;
    }
    offset += part.length;
  });
  if (open !== null) found.push([open, offset]);
  const text = parts.join("");
  return found.map(([start, end]): [number, number] => {
    let from = start;
    let to = end;
    while (from < to && /\s/u.test(text[from]!)) from += 1;
    while (to > from && /\s/u.test(text[to - 1]!)) to -= 1;
    return [from, to];
  }).filter(([start, end]) => end > start);
}

/** The words that differ between a removed line and its replacement, or null when they are not recognisably the same line. */
export function wordDiff(removed: string, added: string): { removed: Emphasis; added: Emphasis } | null {
  const a = tokens(removed);
  const b = tokens(added);
  const kept = commonTokens(a, b);
  const total = a.reduce((sum, token) => sum + weight(token), 0) + b.reduce((sum, token) => sum + weight(token), 0);
  const shared = a.reduce((sum, token, index) => sum + (kept.a[index] ? weight(token) : 0), 0) + b.reduce((sum, token, index) => sum + (kept.b[index] ? weight(token) : 0), 0);
  if (total === 0 || shared / total < MIN_SIMILARITY) return null;
  const removedRanges = ranges(a, kept.a);
  const addedRanges = ranges(b, kept.b);
  return removedRanges.length === 0 && addedRanges.length === 0 ? null : { removed: removedRanges, added: addedRanges };
}

/**
 * Emphasis by row index. A run of removed lines followed by a run of added ones
 * is paired line by line (the first removed with the first added, and so on),
 * the way a reader reads a replaced block.
 */
export function rowEmphasis(rows: PatchRow[]): Map<number, Emphasis> {
  const marked = new Map<number, Emphasis>();
  let index = 0;
  while (index < rows.length) {
    if (rows[index]!.kind !== "del") {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (index < rows.length && rows[index]!.kind === "del") index += 1;
    const addedStart = index;
    while (index < rows.length && rows[index]!.kind === "add") index += 1;
    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let offset = 0; offset < pairs; offset += 1) {
      const diff = wordDiff(rows[removedStart + offset]!.text, rows[addedStart + offset]!.text);
      if (!diff) continue;
      if (diff.removed.length > 0) marked.set(removedStart + offset, diff.removed);
      if (diff.added.length > 0) marked.set(addedStart + offset, diff.added);
    }
  }
  return marked;
}
