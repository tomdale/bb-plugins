import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks } from "../src/ui/markdown-blocks.ts";

describe("parseMarkdownBlocks", () => {
  it("lets a list interrupt a paragraph without a blank line", () => {
    expect(parseMarkdownBlocks("Three things:\n- one\n- two\n\nDone.")).toEqual([
      { kind: "paragraph", text: "Three things:" },
      { kind: "list", ordered: false, start: 1, items: ["one", "two"] },
      { kind: "paragraph", text: "Done." },
    ]);
  });

  it("starts a list after a bold heading line", () => {
    const blocks = parseMarkdownBlocks("**Part 1**\n- a\n- b\n**Part 2**\n- c");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "list", "paragraph", "list"]);
  });

  it("keeps fenced code verbatim, including blank lines and list-like text", () => {
    expect(parseMarkdownBlocks("Run:\n```sh\ngit reset\n\n- not a list\n```\nAfter.")).toEqual([
      { kind: "paragraph", text: "Run:" },
      { kind: "code", language: "sh", text: "git reset\n\n- not a list" },
      { kind: "paragraph", text: "After." },
    ]);
  });

  it("closes an unterminated fence at the end of the text", () => {
    expect(parseMarkdownBlocks("```js\nconst a = 1;")).toEqual([{ kind: "code", language: "js", text: "const a = 1;" }]);
  });

  it("separates numbered lists from bullets and joins indented continuations", () => {
    expect(parseMarkdownBlocks("1. first\n   still first\n2. second\n- bullet")).toEqual([
      { kind: "list", ordered: true, start: 1, items: ["first still first", "second"] },
      { kind: "list", ordered: false, start: 1, items: ["bullet"] },
    ]);
  });

  it("reads headings and soft-wrapped paragraphs", () => {
    expect(parseMarkdownBlocks("## Title\n\nline one\nline two")).toEqual([
      { kind: "heading", text: "Title" },
      { kind: "paragraph", text: "line one line two" },
    ]);
  });
});

describe("tables", () => {
  it("reads a pipe table with escaped pipes", () => {
    expect(parseMarkdownBlocks("Compared:\n| Input | Old |\n|---|:--:|\n| a \\| b | c |\n| d | e |\n\nAfter.")).toEqual([
      { kind: "paragraph", text: "Compared:" },
      { kind: "table", header: ["Input", "Old"], rows: [["a | b", "c"], ["d", "e"]] },
      { kind: "paragraph", text: "After." },
    ]);
  });

  it("does not mistake a lone pipe line for a table", () => {
    expect(parseMarkdownBlocks("| not a table |")).toEqual([{ kind: "paragraph", text: "| not a table |" }]);
  });
});

describe("loose lists", () => {
  it("keeps numbering across blank lines between items", () => {
    expect(parseMarkdownBlocks("1. **Validate**\n\n2. **Define**\n\n3. Ship\n\nDone")).toEqual([
      { kind: "list", ordered: true, start: 1, items: ["**Validate**", "**Define**", "Ship"] },
      { kind: "paragraph", text: "Done" },
    ]);
  });

  it("starts at the number the list starts at", () => {
    expect(parseMarkdownBlocks("3. three\n4. four")).toEqual([{ kind: "list", ordered: true, start: 3, items: ["three", "four"] }]);
  });
});
