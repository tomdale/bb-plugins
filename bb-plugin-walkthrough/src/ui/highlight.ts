// Prose selections become notes anchored to a quote. This file finds a saved
// quote again in the rendered page and snaps a fresh selection to whole words,
// so a note never starts or ends mid-word.

const WORD = /[\p{L}\p{N}_]/u;
const BLOCK = "p, li, td, th, h1, h2, h3, h4, blockquote, pre, figcaption";

/** Widens a range so neither edge falls inside a word. Edges that are not in text nodes are left alone. */
export function snapRangeToWords(range: Range): Range {
  const { startContainer: start, startOffset, endContainer: end, endOffset } = range;
  if (start.nodeType === Node.TEXT_NODE) {
    const text = start.textContent ?? "";
    let at = startOffset;
    while (at > 0 && WORD.test(text[at - 1]!) && WORD.test(text[at] ?? "")) at -= 1;
    range.setStart(start, at);
  }
  if (end.nodeType === Node.TEXT_NODE) {
    const text = end.textContent ?? "";
    let at = endOffset;
    while (at < text.length && WORD.test(text[at]!) && WORD.test(text[at - 1] ?? "")) at += 1;
    range.setEnd(end, at);
  }
  return range;
}

/** Cuts text to at most `max` characters at a word boundary, with an ellipsis; short text is returned whole. */
export function ellipsize(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const atBoundary = flat[max] === " ";
  const space = cut.lastIndexOf(" ");
  // A single token longer than the limit has no boundary to cut at, so it is cut where it falls.
  const head = atBoundary || space <= 0 ? cut : cut.slice(0, space);
  return `${head.replace(/[\s,;:.\-–—(]+$/u, "")}…`;
}

interface Spot {
  node: Text;
  offset: number;
}

/** The text under `roots` with whitespace collapsed, and where each character came from. */
function flatten(roots: Element[]): { text: string; spots: Spot[] } {
  let text = "";
  const spots: Spot[] = [];
  let lastBlock: Element | null = null;
  let last: Spot | null = null;
  const push = (char: string, spot: Spot) => {
    text += char;
    spots.push(spot);
  };
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const block = node.parentElement?.closest(BLOCK) ?? null;
      // Separate blocks with a space, as a selection's text does.
      if (last !== null && block !== lastBlock && !text.endsWith(" ")) push(" ", { node, offset: 0 });
      lastBlock = block;
      const value = node.data;
      for (let offset = 0; offset < value.length; offset += 1) {
        const char = value[offset]!;
        const space = /\s/u.test(char);
        if (space && (text === "" || text.endsWith(" "))) continue;
        last = { node, offset };
        push(space ? " " : char, last);
      }
    }
  }
  return { text, spots };
}

/** The range holding `quote` (whitespace-insensitive) in the first of `roots` that has it, or null. */
export function findQuote(roots: Element[], quote: string): Range | null {
  const needle = quote.replace(/\s+/gu, " ").trim();
  if (needle.length < 3 || roots.length === 0) return null;
  const { text, spots } = flatten(roots);
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const first = spots[at]!;
  const last = spots[at + needle.length - 1]!;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/** Escapes a value for use inside a quoted attribute selector. */
export function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/gu, "\\$&");
}
