// Block-level Markdown for walkthrough prose: paragraphs, headings, bullet and
// numbered lists, and fenced code. The helper writes these in free text
// (answers, wrap-ups), so a list may directly follow a lead-in line and a
// fence may appear anywhere; both must survive without blank-line discipline.

export type MarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/u;
const BULLET = /^\s*[-*+]\s+(.*)$/u;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const TABLE_RULE = /^\s*\|?(\s*:?-{2,}:?\s*\|)+(\s*:?-{2,}:?\s*)?\|?\s*$/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u;

/** Cells of one `| a | b |` row; `\|` stays a literal pipe. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim().replace(/\\\|/gu, "|"));
}

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n?/gu, "\n").trim().split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const marker = fence[1]!;
      const body: string[] = [];
      index++;
      while (index < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`, "u").test(lines[index]!)) {
        body.push(lines[index]!);
        index++;
      }
      blocks.push({ kind: "code", language: fence[2] || null, text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      // Blank lines between items are one loose list, not several.
      const following = lines.slice(index + 1).find((candidate) => candidate.trim() !== "");
      const continues = list && following !== undefined && (list.ordered ? NUMBERED : BULLET).test(following);
      if (!continues) flushList();
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "")) {
      flushParagraph();
      flushList();
      const rows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && TABLE_ROW.test(lines[cursor]!)) rows.push(tableCells(lines[cursor++]!));
      blocks.push({ kind: "table", header: tableCells(line), rows });
      index = cursor - 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", text: heading[1]! });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push((numbered ? numbered[2] : bullet![1])!);
      continue;
    }
    // An indented line right after a list item continues that item.
    if (list && /^\s+\S/u.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
