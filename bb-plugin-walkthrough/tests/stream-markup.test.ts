import { describe, expect, it } from "vitest";
import { parseStreamMarkup, type StreamBlock } from "../src/stream-markup.ts";

export const SAMPLE = [
  "Before this change the key was read once. Now [the cap](line:42) bounds it.",
  "",
  "Second paragraph with `inline code` and a list:",
  "",
  "- one",
  "- two",
  "",
  "```ts",
  "const x = 1; // plain code fences stay prose",
  "```",
  "",
  "```walkthrough",
  "path: src/server.ts",
  "lines: 40-52",
  "view: diff",
  "caption: Looking up the key, in server.ts",
  "note 42: Truncates here.",
  "note 45: Falls back to the shared key.",
  "```",
  "",
  "After the figure, more prose.",
  "",
  "```walkthrough",
  "path: src/key.ts",
  "lines: 7",
  "view: code",
  "caption: The helper",
  "```",
  "",
  "```walkthrough",
  "suggestions:",
  "- What if the cap truncates mid-word?",
  "- Who calls the helper?",
  "```",
  "",
].join("\n");

/** Every block of `before` is a prefix-extension of the block at the same index of `after`. */
function extendedBy(before: StreamBlock[], after: StreamBlock[]): string | null {
  if (after.length < before.length) return `blocks shrank ${before.length} -> ${after.length}`;
  for (const [index, a] of before.entries()) {
    const b = after[index]!;
    if (a.kind !== b.kind) return `block ${index} changed kind ${a.kind} -> ${b.kind}`;
    if (a.kind === "prose" && b.kind === "prose" && !b.text.startsWith(a.text)) return `prose ${index} not a prefix`;
    if (a.kind === "figure" && b.kind === "figure") {
      if (a.path !== null && a.path !== b.path) return "path changed";
      if (a.startLine !== null && (a.startLine !== b.startLine || a.endLine !== b.endLine)) return "lines changed";
      if (a.view !== null && a.view !== b.view) return "view changed";
      if (!b.caption.startsWith(a.caption)) return "caption not a prefix";
      if (b.notes.length < a.notes.length) return "notes shrank";
      for (const [n, note] of a.notes.entries()) {
        if (note.line !== b.notes[n]!.line || !b.notes[n]!.text.startsWith(note.text)) return "note changed";
      }
    }
    if (a.kind === "suggestions" && b.kind === "suggestions") {
      if (b.items.length < a.items.length) return "suggestions shrank";
      for (const [n, item] of a.items.entries()) if (!b.items[n]!.startsWith(item)) return "suggestion changed";
    }
    if (a.kind === "part" && b.kind === "part" && a.number !== null && a.number !== b.number) return "part number changed";
  }
  return null;
}

function assertMonotonicOverPrefixes(text: string, step = 1): void {
  let previous: StreamBlock[] = [];
  for (let end = 0; end <= text.length; end += step) {
    const { blocks } = parseStreamMarkup(text.slice(0, end));
    const problem = extendedBy(previous, blocks);
    if (problem !== null) throw new Error(`${problem} at prefix ${end}: ${JSON.stringify(text.slice(Math.max(0, end - 40), end))}`);
    // Only the last block may be open.
    for (const block of blocks.slice(0, -1)) expect(block.open).toBe(false);
    previous = blocks;
  }
}

describe("parseStreamMarkup", () => {
  it("parses prose, figures, a part marker and suggestions", () => {
    const { blocks, complete } = parseStreamMarkup(SAMPLE);
    expect(complete).toBe(true);
    expect(blocks.map((block) => block.kind)).toEqual(["prose", "figure", "prose", "figure", "suggestions"]);
    const [prose, figure, , second, suggestions] = blocks as [any, any, any, any, any];
    expect(prose.text).toContain("```ts");
    expect(figure).toMatchObject({ path: "src/server.ts", startLine: 40, endLine: 52, view: "diff", caption: "Looking up the key, in server.ts", open: false });
    expect(figure.notes).toEqual([
      { line: 42, text: "Truncates here." },
      { line: 45, text: "Falls back to the shared key." },
    ]);
    expect(second).toMatchObject({ startLine: 7, endLine: 7, view: "code" });
    expect(suggestions.items).toEqual(["What if the cap truncates mid-word?", "Who calls the helper?"]);
  });

  it("reads a part marker between the introduction and part 1", () => {
    const { blocks } = parseStreamMarkup("Intro.\n\n```walkthrough\npart: 1\ntitle: Small requests\n```\n\nBody.");
    expect(blocks.map((block) => block.kind)).toEqual(["prose", "part", "prose"]);
    expect(blocks[1]).toMatchObject({ number: 1, title: "Small requests", open: false });
    expect(blocks[2]).toMatchObject({ open: true });
  });

  it("never throws and only grows over every prefix of the sample", () => {
    assertMonotonicOverPrefixes(SAMPLE);
    assertMonotonicOverPrefixes(SAMPLE.replace(/\n/gu, "\r\n"));
  });

  it("is monotonic for streams that arrive in word-sized chunks of prose and figures", () => {
    const text = `${SAMPLE}${SAMPLE.replace("src/server.ts", "src/other.ts")}`;
    assertMonotonicOverPrefixes(text);
  });

  it("holds back a partial fence opener instead of showing it as prose", () => {
    for (const partial of ["`", "``", "```", "```walk", "```walkthrough"]) {
      const { blocks } = parseStreamMarkup(`Hello world\n\n${partial}`);
      expect(blocks).toEqual([{ kind: "prose", text: "Hello world", open: true }]);
    }
    expect(parseStreamMarkup("Use `code").blocks[0]).toMatchObject({ text: "Use `code" });
  });

  it("shows caption and note text as they stream but waits for the newline on path, lines and view", () => {
    const head = "```walkthrough\npath: src/a.ts\nlines: 4";
    expect(parseStreamMarkup(head).blocks[0]).toMatchObject({ path: "src/a.ts", startLine: null });
    expect(parseStreamMarkup(`${head}0-50\nview: di`).blocks[0]).toMatchObject({ startLine: 40, endLine: 50, view: null });
    expect(parseStreamMarkup(`${head}0\ncaption: Look`).blocks[0]).toMatchObject({ caption: "Look", open: true });
    expect(parseStreamMarkup(`${head}0\nnote 41: Tru`).blocks[0]).toMatchObject({ notes: [{ line: 41, text: "Tru" }] });
  });

  it("treats other fenced code in prose as prose, even one that mentions walkthrough", () => {
    const { blocks } = parseStreamMarkup("Example:\n\n````md\n```walkthrough\npath: a\n```\n````\n\nDone.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "prose" });
  });

  it("ignores unknown keys, bad values, and unterminated fences", () => {
    const { blocks, complete } = parseStreamMarkup("```walkthrough\nbogus: 1\nwhat\nlines nope\n");
    expect(complete).toBe(false);
    expect(blocks).toEqual([]);
    const figure = parseStreamMarkup("```walkthrough\ncaption: c\npath: ``x.ts``\nlines: nope\nview: sideways\n").blocks[0];
    expect(figure).toMatchObject({ path: "x.ts", startLine: null, view: null, open: true });
  });

  it("is total on garbage", () => {
    const pieces = ["```", "walkthrough", "\n", "path:", "lines: 1-", "note 3:", "suggestions:", "- ", "`", "````", "\r", "\u0000", "🙂", "part: ", "caption", " ", "view: diff", "x"];
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let run = 0; run < 300; run += 1) {
      let text = "";
      for (let n = 0; n < 40; n += 1) text += pieces[Math.floor(random() * pieces.length)];
      for (let end = 0; end <= text.length; end += 1) parseStreamMarkup(text.slice(0, end));
    }
    for (const bad of [undefined, null, 5, {}] as unknown[]) expect(parseStreamMarkup(bad as string)).toEqual({ blocks: [], complete: false });
    expect(parseStreamMarkup("")).toEqual({ blocks: [], complete: false });
  });

  it("caps block count and per-field sizes", () => {
    const many = Array.from({ length: 200 }, (_, index) => `\`\`\`walkthrough\npath: f${index}.ts\n\`\`\`\n`).join("");
    expect(parseStreamMarkup(many).blocks.length).toBeLessThanOrEqual(80);
    const long = parseStreamMarkup(`\`\`\`walkthrough\ncaption: ${"x".repeat(5000)}\n`).blocks[0] as any;
    expect(long.caption.length).toBeLessThanOrEqual(300);
  });

  it("is not complete until the suggestions fence closes", () => {
    const open = "```walkthrough\nsuggestions:\n- One?\n- Two?";
    expect(parseStreamMarkup(open)).toMatchObject({ complete: false });
    expect(parseStreamMarkup(`${open}\n\`\`\``).complete).toBe(true);
  });
});

describe("the worker's instructions", () => {
  it("contain an example that the parser reads as intended, in both tools that carry it", async () => {
    const { PLAN_INSTRUCTIONS, WRITE_PART_INSTRUCTIONS } = await import("../src/worker.ts");
    for (const instructions of [PLAN_INSTRUCTIONS, WRITE_PART_INSTRUCTIONS]) {
      expect(instructions.length).toBeLessThan(4096);
      const example = instructions.slice(instructions.indexOf("Example:\n\n") + "Example:\n\n".length);
      const { blocks, complete } = parseStreamMarkup(example);
      expect(complete).toBe(true);
      expect(blocks.map((block) => block.kind)).toEqual(["prose", "figure", "suggestions"]);
      expect(blocks[1]).toMatchObject({ path: "src/upload.ts", startLine: 38, endLine: 52, view: "diff", notes: [{ line: 42, text: "The old loop never stopped." }] });
      expect((blocks[2] as { items: string[] }).items).toHaveLength(2);
    }
  });
});
