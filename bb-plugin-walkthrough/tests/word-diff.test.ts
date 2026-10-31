import { describe, expect, it } from "vitest";
import { parsePatchRows } from "../src/ui/patch-lines.ts";
import { rowEmphasis, wordDiff } from "../src/ui/word-diff.ts";

const slice = (text: string, ranges: Array<[number, number]>) => ranges.map(([start, end]) => text.slice(start, end));

describe("word-level emphasis", () => {
  it("marks the words that changed between a removed line and its replacement", () => {
    const removed = "  const delay = baseDelayMs * attempt;";
    const added = "  const delay = baseDelayMs * 2 ** attempt + jitter();";
    const diff = wordDiff(removed, added)!;
    expect(diff.removed).toEqual([]);
    expect(slice(added, diff.added)).toEqual(["2 **", "+ jitter()"]);
  });

  it("marks both sides when a word is swapped", () => {
    const removed = "if (response.status < 400) return response;";
    const added = "if (response.status < 500) return response;";
    const diff = wordDiff(removed, added)!;
    expect(slice(removed, diff.removed)).toEqual(["400"]);
    expect(slice(added, diff.added)).toEqual(["500"]);
  });

  it("does not mark lines that are different statements, where every word would light up", () => {
    expect(wordDiff("return response;", "let lastError: unknown;")).toBeNull();
    expect(wordDiff("same", "same")).toBeNull();
  });

  it("copes with long lines without comparing them word for word", () => {
    const long = Array.from({ length: 200 }, (_, index) => `w${index}`).join(" ");
    const changed = long.replace("w100", "w100x");
    const diff = wordDiff(long, changed)!;
    expect(slice(changed, diff.added)).toEqual(["w100x"]);
  });

  it("pairs a run of removed lines with the run of added lines that follows, line by line", () => {
    const rows = parsePatchRows(
      ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,4 +1,4 @@", " keep", "-const a = 1;", "-const b = 2;", "+const a = 10;", "+const b = 20;", " tail", ""].join("\n"),
    );
    const marked = rowEmphasis(rows);
    expect([...marked.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(slice(rows[3]!.text, marked.get(3)!)).toEqual(["10"]);
    expect(slice(rows[2]!.text, marked.get(2)!)).toEqual(["2"]);
  });

  it("leaves a block with nothing to pair against unmarked", () => {
    const rows = parsePatchRows(["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,3 @@", " keep", "+brand new", "+lines", ""].join("\n"));
    expect(rowEmphasis(rows).size).toBe(0);
  });
});
