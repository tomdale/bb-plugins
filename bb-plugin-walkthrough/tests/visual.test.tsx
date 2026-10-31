// @vitest-environment jsdom
// The reading surface's visual contract: what the stylesheet promises (the
// rules a screenshot would show) and the markup hooks that stylesheet needs.
import { fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPage, mounted, part, stubWidth, viewOf, walkthrough } from "./helpers.tsx";

const css = readFileSync("app.css", "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
/** The declarations of every rule whose selector list names `selector` exactly. */
function rule(selector: string): string {
  const found = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/gu))
    .filter((match) => match[1]!.split(",").some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]!);
  if (found.length === 0) throw new Error(`no rule for ${selector}`);
  return found.join(" ");
}

beforeEach(() => {
  stubWidth(480);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
});

describe("typography", () => {
  it("bundles Newsreader with its optical-size axis and turns optical sizing on", () => {
    const fonts = readFileSync("assets/newsreader.css", "utf8");
    const opsz = readFileSync("node_modules/@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2").subarray(0, 120).toString("base64");
    expect(fonts).toContain(opsz);
    expect(rule(".wt")).toContain("font-optical-sizing: auto");
    expect(readFileSync("scripts/build-fonts-css.mjs", "utf8")).toContain("newsreader-latin-opsz-");
  });

  it("uses proportional figures in prose and tabular ones in lists", () => {
    expect(css).toMatch(/\.wt-prose[^{]*\{[^}]*font-variant-numeric: proportional-nums/u);
    expect(rule(".wt-toc")).toContain("tabular-nums");
    expect(rule(".wt-ledger")).toContain("tabular-nums");
  });

  it("gives prose, contents, ledger, thread, captions and the skeleton one shared measure", () => {
    expect(css).toMatch(/--wt-measure: \d+px/u);
    for (const selector of [".wt-prose > *", ".wt-toc", ".wt-ledger", ".wt-thread", ".wt-earlier", ".wt-skeleton > .wt-skel"]) expect(rule(selector)).toContain("var(--wt-measure)");
  });
});

describe("focus and selection", () => {
  it("rings a focused control without changing its shape", () => {
    const focus = rule(".wt :focus-visible");
    expect(focus).toContain("outline:");
    expect(focus).not.toContain("border-radius");
    expect(rule(".wt ::selection")).toContain("--wt-select");
  });
});

describe("the diff", () => {
  it("marks added and removed lines with a sign and an edge, not colour alone, and calms the dark tints", () => {
    expect(rule(".wt-add")).toContain("inset 2px 0 0");
    expect(rule(".wt-del")).toContain("inset 2px 0 0");
    expect(css).toMatch(/\.wt-add \.wt-text::before[^{]*\{[^}]*\}/u);
    expect(css).toContain('content: "+"');
    const dark = /\.dark \.wt,[^{]*\{([^}]*)\}/u.exec(css)![1]!;
    expect(dark).toMatch(/--wt-add: rgba\(48, 209, 88, 0\.1\)/u);
  });

  it("keeps a flagged line's number: the marker has its own column beside it", async () => {
    const block = { kind: "code" as const, caption: "c", path: "src/a.ts", startLine: 3, endLine: 5, notes: [{ line: 4, text: "Look here" }], snapshot: { change: null, after: ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -3,3 +3,3 @@", " one", " two", " three", ""].join("\n"), before: null, baseSha: null, headSha: null, capturedAt: 1 }, view: "code" as const };
    const slot = await mountPage("wt_1", viewOf(walkthrough({ parts: [part("Schema", { blocks: [block] })] })));
    const row = (await slot.findByLabelText(/Note 1: Look here/u)).closest(".wt-row")!;
    expect(row.querySelector(".wt-mk .wt-m")).not.toBeNull();
    expect(row.querySelector(".wt-ln")?.textContent).toContain("4");
  });
});

describe("the concerns sheet, pager and shared controls", () => {
  it("floats the sheet clear of the top bar, as one glass layer", () => {
    const sheet = rule(".wt-sheet");
    expect(sheet).toMatch(/top: 56px/u);
    expect(sheet).toMatch(/border-radius: 18px/u);
    expect(sheet).not.toMatch(/-20px 0 40px/u);
  });

  it("styles the dialog, menu, tooltip and checkbox in the Notebook language", () => {
    for (const selector of [".wt-portal.wt-dialog", ".wt-portal.wt-menu", ".wt-portal.wt-tip", ".wt-check"]) expect(rule(selector)).toBeTruthy();
    expect(rule(".wt-portal.wt-menu")).toContain("border-radius: 12px");
    expect(rule('.wt-portal.wt-menu [role="menuitem"]')).toContain("border-radius: 8px");
    expect(rule('.wt-check[data-state="checked"]')).toContain("var(--wt-y)");
  });

  it("goes to a compact pager at panel width and fades suggestions that overflow", () => {
    expect(css).toMatch(/@container wt \(max-width: 460px\)[^}]*\.wt-pager-row \{ flex-wrap: wrap; \}/u);
    expect(css).toMatch(/\.wt-suggest \{[^}]*animation-timeline: scroll\(self inline\)/u);
  });

  it("fades the code at an edge a long line runs past", () => {
    expect(css).toMatch(/\.wt-code \{[^}]*animation-timeline: scroll\(self inline\)/u);
    expect(css).toContain("--wt-fade-r");
  });
});

describe("accent discipline", () => {
  it("keeps yellow for markers, highlights, the open Concerns chip and the current position, not for hovers", () => {
    expect(rule(".wt-suggest button:hover:not(:disabled)")).not.toContain("--wt-y");
    expect(rule(".wt-flag > button:hover:not(:disabled)")).not.toContain("--wt-y");
    expect(rule('.wt-chip[aria-expanded="true"]')).not.toContain("--wt-y");
    expect(rule('.wt-chip[data-selected="true"]')).toContain("--wt-y");
  });
});

describe("page chrome", () => {
  it("puts the introduction's subject under its title", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ currentPart: null, introduction: "Hello there." })));
    const heading = (await slot.findByRole("heading", { level: 2 })).closest("header")!;
    expect(heading.nextElementSibling?.className).toContain("wt-subject");
  });

  it("places the selection toolbar above a selection, and below one at the top edge", async () => {
    const rectAt = (top: number) => ({ top, bottom: top + 20, left: 40, right: 80, width: 40, height: 20, x: 40, y: top, toJSON() {} }) as DOMRect;
    for (const [top, above] of [[400, true], [10, false]] as const) {
      const slot = await mountPage("wt_1", viewOf(walkthrough()));
      (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => rectAt(top);
      const paragraph = (await slot.findByText("The schema comes first.")).firstChild!;
      const range = document.createRange();
      range.setStart(paragraph, 4);
      range.setEnd(paragraph, 10);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      fireEvent.mouseUp(paragraph.parentElement!);
      const toolbar = await slot.findByRole("toolbar");
      expect(toolbar.hasAttribute("data-above")).toBe(above);
      slot.unmount();
      mounted.pop();
    }
  });
});
    height.mockRestore();
  });
});

describe("round two: geometry, stacking and focus", () => {
  const codeBlock = (notes: Array<{ line: number; text: string }>) => ({
    kind: "code" as const,
    caption: "c",
    path: "src/a.ts",
    startLine: 3,
    endLine: 7,
    notes,
    snapshot: { change: null, after: ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -3,5 +3,5 @@", " one", " two", " three", " four", " five", ""].join("\n"), before: null, baseSha: null, headSha: null, capturedAt: 1 },
    view: "code" as const,
  });

  it("gives the top bar, page, pager and sheet one inset and one width", () => {
    const width = "min(100% - var(--wt-inset) * 2, var(--wt-sheet-w))";
    for (const selector of [".wt-top", ".wt-scroll", ".wt-pager"]) expect(rule(selector)).toContain(`width: ${width}`);
    // The sheet's right edge is the page's right edge plus its own 10px, at any window width.
    expect(rule(".wt-sheet")).toContain(`right: calc((100% - ${width}) / 2 + 10px)`);
  });

  it("lands a figure's 2px diff edge exactly on the ruled margin", () => {
    // The rule is drawn at 46px of the page; the page's text starts at 62px and the figure's own left inset is 16px.
    expect(rule(".wt-page")).toContain("transparent 46px, var(--wt-rule) 46px, var(--wt-rule) 47px");
    expect(rule(".wt-page")).toContain("padding: 30px 28px 56px 62px");
    expect(rule(".wt-figure")).toContain("margin: 18px -14px 18px -16px");
    expect(rule(".wt-figure")).toContain("--wt-fig-l: 16px");
    expect(rule(".wt-row")).toContain("calc(var(--wt-fig-l) + 28px)");
  });

  it("stacks markers on one line like avatars: the first on top, each beneath the last, with a halo", () => {
    expect(css).not.toContain("nth-child(n + 3)");
    expect(rule(".wt-mk .wt-m + .wt-m")).toContain("margin-left: -4px");
    expect(rule(".wt-mk .wt-m:nth-child(1)")).toContain("z-index: 3");
    expect(rule(".wt-mk .wt-m:has(+ .wt-m)")).toContain("--wt-m-halo");
    expect(rule(".wt-m")).toContain("var(--wt-m-inset");
  });

  it("rings a focused control in a colour that reads as yellow, never yellow on yellow, and never past a track", () => {
    expect(css).toMatch(/--wt-ring: #b88a00/u);
    expect(rule(".wt-chip[data-selected]:focus-visible")).toContain("outline-color: var(--wt-ink)");
    expect(rule(".wt-seg button:focus-visible")).toContain("outline-offset: -2px");
  });

  it("highlights one picker row at a time: hover fills, the current part has a dot, focus is a ring", () => {
    expect(rule(".wt-picker button:hover:not(:disabled)")).toContain("background: var(--wt-fill)");
    expect(css).not.toMatch(/\.wt-picker button\[aria-current="step"\] \{ background/u);
    expect(rule(".wt-picker button:focus-visible")).toContain("inset 0 0 0 1.5px var(--wt-ring)");
    expect(rule(".wt-picker")).toContain("border-radius: 12px");
  });

  it("opens the part picker on the current part, so one row is focused and it is the current one", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ currentPart: 1, parts: [part("Schema"), part("Store"), part("Cache")] })));
    fireEvent.click(await slot.findByRole("button", { name: /^Parts/u }));
    const current = (await slot.findByRole("list", { name: "Parts" })).querySelector('[aria-current="step"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(current));
  });

  it("puts the wrap-up's action on the question's row, and states a finished walkthrough instead of showing a dead field", () => {
    expect(rule(".wt-pager")).toContain("display: grid");
    expect(css).toMatch(/\.wt \.wt-pager \.wt-pager-actions \{ grid-column: 2; grid-row: 3;/u);
    expect(rule(".wt-pager-row")).toContain("grid-row: 3");
  });

  it("draws a skeleton figure from the real figure's own header and rows", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ parts: [part("A", { status: "writing", blocks: [] })] })));
    const figure = (await slot.findByRole("status", { name: /Writing this part/u })).querySelector("figure.wt-figure.wt-skel-figure")!;
    expect(figure.querySelector(".wt-cap")).not.toBeNull();
    expect(figure.querySelector(".wt-fig > .wt-fh")).not.toBeNull();
    expect(figure.querySelectorAll(".wt-code-rows > .wt-row").length).toBeGreaterThanOrEqual(6);
    expect(rule(".wt-skel")).toContain("color-mix(in srgb, var(--wt-ink) 8%, transparent)");
  });

  it("hangs a margin note's marker in an indent, and draws a leader from each note to its line", async () => {
    stubWidth(1300);
    const slot = await mountPage("wt_1", viewOf(walkthrough({ parts: [part("A", { blocks: [codeBlock([{ line: 4, text: "First note, which is long enough to wrap onto a second and third line of the margin." }, { line: 4, text: "Second note on the same line." }])] })] })));
    await slot.findByText(/Second note/u);
    const notes = Array.from(slot.container.querySelectorAll(".wt-mn"));
    expect(notes).toHaveLength(2);
    expect(notes[0]!.firstElementChild!.getAttribute("class")).toContain("wt-leader");
    const paths = notes.map((note) => note.querySelector(".wt-leader path")!.getAttribute("d")!);
    expect(paths[0]).toBe("M0 .5 H18");
    expect(paths[1]).toMatch(/^M0 \.5 H5 Q9 \.5 9 4\.5 V/u);
    expect(rule(".wt-mn")).toContain("padding-left: 22px");
    expect(rule(".wt-mn > .wt-m-inline")).toContain("position: absolute");
  });

  it("keeps the concerns sheet nearly opaque, so a tinted diff beneath it does not blotch", () => {
    expect(rule(".wt-sheet")).toContain("var(--wt-glass-solid) 92%");
    expect(rule(".wt-sheet")).toContain("blur(40px) saturate(1.1)");
  });

  it("gives the figure header its own line up to 540px, and clips a long path at its start", () => {
    expect(css).toMatch(/@container wt \(max-width: 540px\) \{\s*\.wt-fh \{ flex-wrap: wrap/u);
    expect(rule(".wt-fh-loc")).toContain("direction: rtl");
