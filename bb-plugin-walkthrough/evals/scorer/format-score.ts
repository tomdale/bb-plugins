// Format scoring for a helper's streamed message: the shape the reader sees
// once the plugin commits it as a part.
//
// The scorer reads the message as the model wrote it, with its own small
// checks rather than src/stream-markup.ts: a message the parser tolerates (a
// heading inside a part, a code link instead of a figure) must still show up
// here as a defect, so the suite cannot inherit the parser's leniency. The
// offline checks grade recorded messages with it, and the live runner grades
// what a model actually wrote on a real walkthrough.
import { START_MARKER } from "../../src/stream-markup.ts";

export interface ScoredCodeFence {
  /** The `path:` value, or null when the fence names none. */
  path: string | null;
  /** The `lines:` value verbatim, or null when the fence names none. */
  lines: string | null;
}

export interface FormatScore {
  /** A line holding exactly the start marker, where content begins. */
  markerLine: boolean;
  /** A ```walkthrough fence holding `part: <n>` for the part asked for. */
  partFence: boolean;
  codeFences: ScoredCodeFence[];
  /** At least one code fence, and every code fence naming both a path and a line range. */
  codeFencesWithPathAndLines: boolean;
  /** A fence holding the follow-up questions. */
  suggestionsFence: boolean;
  suggestions: string[];
  /** Short ids for the things the guide forbids, in the order found. */
  findings: string[];
  /** Every check passed and nothing forbidden appeared. */
  ok: boolean;
}

const FENCE_OPENER = /^ {0,3}(`{3,})[ \t]*([^`\s]*)[ \t]*$/u;
const KEY_LINE = /^([A-Za-z][A-Za-z-]*)[ \t]*:[ \t]?(.*)$/u;
const MARKER_LINE = /^[ \t]*<!--[ \t]*walkthrough:start[ \t]*-->[ \t]*$/u;
const HEADING_LINE = /^ {0,3}#{1,6}[ \t]+\S/u;
const REPLY_WRAPPER = /^ {0,3}:{3,}[ \t]*reply\b/iu;
const REPLY_FENCE = /^ {0,3}`{3,}[ \t]*reply\b/iu;
/** A Markdown link whose target is a file and line ("src/retry.ts:28"): the guide's forms are [phrase](line:40) and [phrase](path/to/file.ts#L40-52). */
const CODE_LINK = /\]\((?!line:)[^)\s#]+:\d+(?:-\d+)?\)/u;

interface Fence {
  info: string;
  body: string[];
}

function fences(lines: string[]): Fence[] {
  const found: Fence[] = [];
  let open: { info: string; ticks: number; body: string[] } | null = null;
  for (const line of lines) {
    if (open === null) {
      const opener = FENCE_OPENER.exec(line);
      if (opener) open = { info: opener[2]!.toLowerCase(), ticks: opener[1]!.length, body: [] };
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length >= open.ticks && /^`+$/u.test(trimmed)) {
      found.push({ info: open.info, body: open.body });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  // An unclosed fence is still content: the message was cut off mid-block.
  if (open !== null) found.push({ info: open.info, body: open.body });
  return found;
}

/**
 * Scores one message. `part` is the part the message was asked to hold, so a
 * write turn for part 3 is scored against `part: 3`; the plan turn holds the
 * introduction and part 1.
 */
export function scoreFormat(text: string, options: { part?: number } = {}): FormatScore {
  const part = options.part ?? 1;
  const normalized = (typeof text === "string" ? text : "").replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const markerAt = lines.findIndex((line) => MARKER_LINE.test(line));
  // Content is the text after the marker; a message without one is scored whole so its defects still show.
  const content = markerAt < 0 ? lines : lines.slice(markerAt + 1);

  const findings: string[] = [];
  const codeFences: ScoredCodeFence[] = [];
  let partFence = false;
  let suggestionsFence = false;
  let suggestions: string[] = [];

  for (const fence of fences(content)) {
    if (fence.info !== "walkthrough") continue;
    const keys = fence.body.map((line) => KEY_LINE.exec(line.trim())).filter((match): match is RegExpExecArray => match !== null);
    const named = (name: string) => keys.find((match) => match[1]!.toLowerCase() === name)?.[2]?.trim() ?? null;
    if (named("part") === String(part)) partFence = true;
    if (keys.some((match) => match[1]!.toLowerCase() === "suggestions")) {
      suggestionsFence = true;
      suggestions = fence.body
        .map((line) => line.replace(/^[ \t]*(?:[-*\u2022]|\d{1,2}[.)])[ \t]+/u, "").trim())
        .filter((line) => line !== "" && !/^suggestions[ \t]*:/iu.test(line));
    }
    if (named("path") !== null || named("lines") !== null) codeFences.push({ path: named("path"), lines: named("lines") });
  }

  for (const line of content) {
    if (HEADING_LINE.test(line) && !findings.includes("heading")) findings.push("heading");
    if (CODE_LINK.test(line) && !findings.includes("code-link")) findings.push("code-link");
  }
  if (lines.some((line) => REPLY_WRAPPER.test(line) || REPLY_FENCE.test(line))) findings.push("reply-wrapper");

  const codeFencesWithPathAndLines = codeFences.length > 0 && codeFences.every((fence) => fence.path !== null && fence.lines !== null);
  const markerLine = markerAt >= 0;
  return {
    markerLine,
    partFence,
    codeFences,
    codeFencesWithPathAndLines,
    suggestionsFence,
    suggestions,
    findings,
    ok: markerLine && partFence && codeFencesWithPathAndLines && suggestionsFence && findings.length === 0,
  };
}

/** The marker the scorer looks for, so a report can show what a passing message starts with. */
export const FORMAT_SCORE_MARKER = START_MARKER;
