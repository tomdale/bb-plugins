// Streamed-part markup: what the worker writes as its assistant message
// before it commits a part with a tool call, and the parser that turns the
// text received so far into page blocks.
//
// Prose is Markdown. A figure is a fenced block whose language is
// `walkthrough`, with `key: value` lines and `note <line>: text` lines:
//
//     ```walkthrough
//     path: src/server.ts
//     lines: 40-52
//     view: diff
//     caption: Looking up the key, in server.ts
//     note 42: Truncates here.
//     ```
//
// Two more fence kinds share the language: `part: <n>` (with an optional
// `title:`) marks where a part begins in a turn that streams the introduction
// and part 1 together, and a final `suggestions:` fence lists one follow-up
// question per line. The text is hidden chat, never persisted: the committed
// tool call is what the reader keeps. The markup is kept identical to what
// BB's `experimental_codeFenceRenderer` would receive, so a newer SDK can
// render it in the thread itself.
//
// parseStreamMarkup is pure and total. It accepts the whole text so far,
// truncated at any character or complete garbage, never throws, and is
// monotonic: for any prefix P of T, every block of parse(P) is a prefix of
// the same-index block of parse(T) (text and figure fields only grow, lists
// only append). Monotonic output lets a client re-render each snapshot
// without flicker. Fields whose value would change under truncation (path,
// lines, view) appear only once their line is newline-terminated; caption and
// note text show as they stream.

export type StreamView = "diff" | "code";

export interface StreamProse {
  kind: "prose";
  text: string;
  open: boolean;
}
export interface StreamFigure {
  kind: "figure";
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  view: StreamView | null;
  caption: string;
  notes: Array<{ line: number; text: string }>;
  open: boolean;
}
export interface StreamPart {
  kind: "part";
  number: number | null;
  title: string;
  open: boolean;
}
export interface StreamSuggestions {
  kind: "suggestions";
  items: string[];
  open: boolean;
}
export type StreamBlock = StreamProse | StreamFigure | StreamPart | StreamSuggestions;

export interface ParsedStream {
  /** Only the last block can be open: still receiving text. */
  blocks: StreamBlock[];
  /** True once the closing suggestions fence arrived: the message is finished. */
  complete: boolean;
}

export const MAX_STREAM_BLOCKS = 80;
const MAX_NOTES = 8;
const MAX_SUGGESTIONS = 6;
const MAX_PATH = 1024;
const MAX_CAPTION = 300;
const MAX_NOTE = 600;
const MAX_SUGGESTION = 200;

const OPENER = /^ {0,3}(`{3,})[ \t]*([^`\s]*)[ \t]*$/u;
const KEY_LINE = /^([A-Za-z][A-Za-z-]*)[ \t]*:[ \t]?(.*)$/u;
const NOTE_LINE = /^note[ \t]+(\d{1,8})[ \t]*:[ \t]?(.*)$/iu;
const BULLET = /^[ \t]*(?:[-*\u2022]|\d{1,2}[.)])[ \t]+/u;
const FIGURE_KEYS = new Set(["path", "lines", "view", "caption"]);

/** True when the text contains a walkthrough fence, even a partial opener. */
export function hasStreamMarkup(text: string): boolean {
  return text.includes("```walkthrough");
}

/** A partial last line that might still become a fence opener is withheld from prose. */
function mightBecomeOpener(line: string): boolean {
  const match = /^ {0,3}(`+)(.*)$/u.exec(line);
  if (match === null) return false;
  const ticks = match[1]!.length;
  const rest = match[2]!.trim().toLowerCase();
  if (ticks < 3) return rest === "";
  return "walkthrough".startsWith(rest) || rest.startsWith("walkthrough");
}

function isCloser(line: string, ticks: number): boolean {
  const trimmed = line.trim();
  return trimmed.length >= ticks && /^`+$/u.test(trimmed);
}

function cleanPath(value: string): string {
  return value.trim().replace(/^[`'"]+|[`'"]+$/gu, "").slice(0, MAX_PATH);
}

function parseLines(value: string): { start: number; end: number } | null {
  const match = /^(\d{1,8})(?:[ \t]*[-\u2013:][ \t]*(\d{1,8}))?$/u.exec(value.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1) return null;
  return { start, end: end < start ? start : end };
}

type Fence =
  | { type: "undecided"; ticks: number }
  | { type: "figure"; ticks: number; block: StreamFigure }
  | { type: "part"; ticks: number; block: StreamPart }
  | { type: "suggestions"; ticks: number; block: StreamSuggestions };

/** Parses the text received so far. See the module comment for the contract. */
export function parseStreamMarkup(input: string): ParsedStream {
  const text = typeof input === "string" ? input.replace(/\r\n?/gu, "\n") : "";
  const lines = text.split("\n");
  const partial = lines.pop() ?? "";
  const blocks: StreamBlock[] = [];

  let prose: string[] | null = null;
  let proseFence: number | null = null;
  let fence: Fence | null = null;

  const flushProse = (): void => {
    if (prose === null) return;
    const body = prose.join("\n").trimEnd();
    prose = null;
    if (body !== "" && blocks.length < MAX_STREAM_BLOCKS) blocks.push({ kind: "prose", text: body, open: false });
  };

  const decide = (line: string, ticks: number): Fence | null => {
    const note = NOTE_LINE.exec(line);
    const key = note ? "note" : (KEY_LINE.exec(line)?.[1]?.toLowerCase() ?? "");
    if (key === "note" || FIGURE_KEYS.has(key)) {
      flushProse();
      const block: StreamFigure = { kind: "figure", path: null, startLine: null, endLine: null, view: null, caption: "", notes: [], open: true };
      if (blocks.length < MAX_STREAM_BLOCKS) blocks.push(block);
      return { type: "figure", ticks, block };
    }
    if (key === "part" || key === "title") {
      const block: StreamPart = { kind: "part", number: null, title: "", open: true };
      if (blocks.length < MAX_STREAM_BLOCKS) blocks.push(block);
      return { type: "part", ticks, block };
    }
    if (key === "suggestions") {
      const block: StreamSuggestions = { kind: "suggestions", items: [], open: true };
      if (blocks.length < MAX_STREAM_BLOCKS) blocks.push(block);
      return { type: "suggestions", ticks, block };
    }
    return null;
  };

  const applyFigure = (block: StreamFigure, line: string, terminated: boolean): void => {
    const note = NOTE_LINE.exec(line);
    if (note) {
      const number = Number(note[1]);
      const noteText = note[2]!.trim().slice(0, MAX_NOTE);
      if (block.notes.length < MAX_NOTES) block.notes.push({ line: number, text: noteText });
      return;
    }
    const pair = KEY_LINE.exec(line);
    if (pair === null) return;
    const key = pair[1]!.toLowerCase();
    const value = pair[2]!;
    if (key === "caption") block.caption = value.trim().slice(0, MAX_CAPTION);
    else if (!terminated) return;
    else if (key === "path") block.path = cleanPath(value) || null;
    else if (key === "lines") {
      const range = parseLines(value);
      if (range) {
        block.startLine = range.start;
        block.endLine = range.end;
      }
    } else if (key === "view") {
      const view = value.trim().toLowerCase();
      if (view === "diff" || view === "code") block.view = view;
    }
  };

  const applyPart = (block: StreamPart, line: string, terminated: boolean): void => {
    const pair = KEY_LINE.exec(line);
    if (pair === null) return;
    const key = pair[1]!.toLowerCase();
    if (key === "title") block.title = pair[2]!.trim().slice(0, MAX_CAPTION);
    else if (key === "part" && terminated) {
      const number = /^\d{1,3}$/u.exec(pair[2]!.trim());
      if (number) block.number = Number(number[0]);
    }
  };

  const applySuggestion = (block: StreamSuggestions, line: string, terminated: boolean): void => {
    if (!terminated || block.items.length >= MAX_SUGGESTIONS) return;
    if (/^suggestions[ \t]*:/iu.test(line.trim())) return;
    const item = line.replace(BULLET, "").trim().slice(0, MAX_SUGGESTION);
    if (item !== "") block.items.push(item);
  };

  const consume = (line: string, terminated: boolean): void => {
    if (fence !== null) {
      if (isCloser(line, fence.ticks)) {
        if (fence.type !== "undecided") fence.block.open = false;
        fence = null;
        return;
      }
      if (line.trim() === "") return;
      if (fence.type === "undecided") {
        if (!terminated) return;
        const decided = decide(line.trim(), fence.ticks);
        if (decided === null) return;
        fence = decided;
        consume(line, terminated);
        return;
      }
      const trimmed = line.trim();
      if (fence.type === "figure") applyFigure(fence.block, trimmed, terminated);
      else if (fence.type === "part") applyPart(fence.block, trimmed, terminated);
      else applySuggestion(fence.block, trimmed, terminated);
      return;
    }
    if (proseFence !== null) {
      prose!.push(line);
      if (isCloser(line, proseFence)) proseFence = null;
      return;
    }
    if (terminated) {
      const opener = OPENER.exec(line);
      if (opener) {
        const info = opener[2]!.toLowerCase();
        if (info === "walkthrough") {
          flushProse();
          fence = { type: "undecided", ticks: opener[1]!.length };
          return;
        }
        prose ??= [];
        prose.push(line);
        proseFence = opener[1]!.length;
        return;
      }
    } else if (mightBecomeOpener(line)) {
      return;
    }
    if (prose === null) {
      if (line.trim() === "") return;
      prose = [];
    }
    prose.push(line);
  };

  for (const line of lines) consume(line, true);
  if (partial !== "") consume(partial, false);
  flushProse();

  const last = blocks.at(-1);
  if (last) {
    // A fence keeps the open flag its closer set; prose at the end can still grow.
    if (last.kind === "prose") last.open = true;
  }
  for (let index = 0; index < blocks.length - 1; index += 1) blocks[index]!.open = false;
  const complete = last !== undefined && last.kind === "suggestions" && !last.open && last.items.length > 0;
  return { blocks, complete };
}
