// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flagGlyphs, shortPath } from "../src/ui/fields.ts";
import { ellipsize, findQuote, snapRangeToWords } from "../src/ui/highlight.ts";
import { stripReplyWrapper } from "../src/ui/reply.ts";

describe("stripReplyWrapper", () => {
  const complete = ':::reply{state="complete" kind="answer"}\nIt truncates here.\n\nSee `cap()`.\n:::';
  it("removes a complete wrapper", () => {
    expect(stripReplyWrapper(complete)).toBe("It truncates here.\n\nSee `cap()`.");
  });
  it("leaves text without a wrapper alone", () => {
    expect(stripReplyWrapper("Plain answer.\n\n::: not a wrapper")).toBe("Plain answer.\n\n::: not a wrapper");
    expect(stripReplyWrapper("")).toBe("");
    expect(stripReplyWrapper("a: b")).toBe("a: b");
  });
  it("shows nothing while the opener is still being written", () => {
    for (const partial of [":", "::", ":::", ":::r", ":::reply", ':::reply{state="rev', ':::reply{state="review" kind="answer"}']) expect(stripReplyWrapper(partial)).toBe("");
  });
  it("shows the body while streaming, without a closing fence being typed", () => {
    expect(stripReplyWrapper(':::reply{state="complete"}\nIt trunc')).toBe("It trunc");
    expect(stripReplyWrapper(':::reply{state="complete"}\nIt truncates.\n:')).toBe("It truncates.");
    expect(stripReplyWrapper(':::reply{state="complete"}\nIt truncates.\n::')).toBe("It truncates.");
    expect(stripReplyWrapper(':::reply{state="complete"}\nIt truncates.\n:::')).toBe("It truncates.");
  });
  it("never lets protocol through at any prefix of a streamed answer", () => {
    for (let end = 0; end <= complete.length; end += 1) {
      const shown = stripReplyWrapper(complete.slice(0, end));
      expect(shown).not.toMatch(/:::|reply\{/u);
      expect(complete.includes(shown.trimEnd())).toBe(true);
    }
  });
  it("handles a longer fence and a wrapper nested inside another", () => {
    expect(stripReplyWrapper('::::reply{state="complete"}\nBody with a fence:\n:::\ninner\n:::\n::::')).toBe("Body with a fence:\n:::\ninner\n:::");
    expect(stripReplyWrapper(':::reply{state="review"}\n::::reply{state="complete"}\nDeep.\n::::\n:::')).toBe("Deep.");
  });
  it("keeps leading whitespace out of the way and a fenced ::: line in the body", () => {
    expect(stripReplyWrapper(`\n\n${complete}`)).toBe("It truncates here.\n\nSee `cap()`.");
    expect(stripReplyWrapper(':::reply{state="complete"}\nA\n:::\nB\n:::')).toBe("A\n:::\nB");
  });
});

describe("flag markers", () => {
  it("letters the reader's flags in the order they were made and ignores the agent's notes", () => {
    const glyphs = flagGlyphs([
      { id: "n2", author: "user", createdAt: 20 },
      { id: "n1", author: "agent", createdAt: 10 },
      { id: "n3", author: "user", createdAt: 5 },
    ]);
    expect([...glyphs]).toEqual([["n3", "a"], ["n2", "b"]]);
  });
  it("continues past z", () => {
    const notes = Array.from({ length: 28 }, (_, index) => ({ id: `n${index + 1}`, author: "user", createdAt: index }));
    const glyphs = flagGlyphs(notes);
    expect([glyphs.get("n1"), glyphs.get("n26"), glyphs.get("n27"), glyphs.get("n28")]).toEqual(["a", "z", "aa", "ab"]);
  });
  it("shortens a path to its last two segments", () => {
    expect(shortPath("bb-plugin-walkthrough/src/ui/Reader.tsx")).toBe("ui/Reader.tsx");
    expect(shortPath("Cargo.toml")).toBe("Cargo.toml");
  });
});

describe("ellipsize", () => {
  it("cuts on a word boundary", () => {
    expect(ellipsize("it can instantiate the client and res.text(body) afterwards", 24)).toBe("it can instantiate the…");
    expect(ellipsize("short enough", 40)).toBe("short enough");
  });
  it("keeps a cut that already lands on a boundary and flattens whitespace", () => {
    expect(ellipsize("one two\n\nthree four", 7)).toBe("one two…");
  });
  it("cuts one very long token where it falls", () => {
    expect(ellipsize("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("snapping a selection to words", () => {
  const setup = (html: string) => {
    document.body.innerHTML = `<div id="root">${html}</div>`;
    return document.getElementById("root")!;
  };
  it("grows both edges to whole words", () => {
    const root = setup("<p>The truncation happens early.</p>");
    const text = root.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6); // "trun|cation"
    range.setEnd(text, 20); // "hap|pens"
    snapRangeToWords(range);
    expect(range.toString()).toBe("truncation happens");
  });
  it("leaves edges that are already on boundaries", () => {
    const root = setup("<p>one two three</p>");
    const text = root.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 7);
    snapRangeToWords(range);
    expect(range.toString()).toBe("two");
  });
  it("finds a quote across inline elements and paragraphs", () => {
    const root = setup("<div class='p'><p>The cap <code>truncates</code> the key.</p><p>Then it returns.</p></div>");
    const range = findQuote([root], "truncates the key.\n\nThen it")!;
    expect(range.toString()).toBe("truncates the key.Then it");
    expect(findQuote([root], "not here")).toBeNull();
    expect(findQuote([root], "ab")).toBeNull();
  });
});
