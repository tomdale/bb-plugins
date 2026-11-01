// @vitest-environment jsdom
// Figures and the panel: the header on one line with a repository path and a
// separate line range, a fold that ends on a whole line, a visible cue for a
// line that runs past the edge, and the classes that collapse the margin.
import { fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAMP_ROWS, clampedRows, lineRange, numberDigits, ROW_HEIGHT } from "../src/ui/Figure.tsx";
import { NARROW_BELOW } from "../src/ui/Reader.tsx";
import { parsePatchRows } from "../src/ui/patch-lines.ts";
import { OpenMargin } from "../src/ui/Marginalia.tsx";
import { mountPage, mounted, note, part, stubWidth, viewOf, walkthrough } from "./helpers.tsx";

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//gu, "");
const appCss = strip(readFileSync("app.css", "utf8"));
const figureCss = strip(readFileSync("src/ui/figure.css", "utf8"));
const OTHER_REPO = "/Users/tomdale/Code/Repos/bb-plugin-workstreams/main";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
});

const lines = (count: number, start = 1) => Array.from({ length: count }, (_, index) => ` const line${start + index} = ${start + index};`);
const patch = (rows: string[], start = 1) => ["--- a/src/server/quick.ts", "+++ b/src/server/quick.ts", `@@ -${start},${rows.length} +${start},${rows.length} @@`, ...rows, ""].join("\n");
const code = (count: number, extra: Record<string, unknown> = {}) => ({
  kind: "code" as const,
  caption: "A caption",
  path: `${OTHER_REPO}/src/server/quick.ts`,
  startLine: 107,
  endLine: 107 + count - 1,
  notes: [],
  view: "code" as const,
  snapshot: { change: null, after: patch(lines(count), 107), before: null, baseSha: null, headSha: null, capturedAt: 1 },
  snapshotError: null,
  displayPath: "src/server/quick.ts",
  ...extra,
});
const page = (block: Record<string, unknown>, overrides: Record<string, unknown> = {}) => viewOf(walkthrough({ workspacePath: "/Users/tomdale/Code/tomdaleOS", parts: [part("Part", { blocks: [block] })], ...overrides }));

describe("the figure header", () => {
  it("names the file inside its repository, with the line range as its own quiet element", async () => {
    stubWidth(480);
    const slot = await mountPage("wt_1", page(code(21)));
    const header = (await slot.findByRole("figure")).querySelector(".wt-fh")!;
    expect(header.querySelector(".wt-fh-dir")!.textContent).toBe("src/server/");
    expect(header.querySelector(".wt-fh-name")!.textContent).toBe("quick.ts");
    expect(header.querySelector(".wt-fh-lines")!.textContent).toBe("107\u2013127");
    expect(header.querySelector(".wt-fh-loc")!.textContent).not.toContain("/Users/");
    expect(header.querySelector(".wt-fh-loc")!.textContent).not.toContain("107");
  });

  it("falls back to a repository-relative name for a figure that arrives with only the worker's machine path", async () => {
    stubWidth(480);
    const slot = await mountPage("wt_1", page(code(5, { displayPath: `${OTHER_REPO}/src/server/quick.ts` }), { workspacePath: OTHER_REPO }));
    const header = (await slot.findByRole("figure")).querySelector(".wt-fh")!;
    expect(`${header.querySelector(".wt-fh-dir")!.textContent}${header.querySelector(".wt-fh-name")!.textContent}`).toBe("src/server/quick.ts");
  });

  it("holds the copy buttons in the header row, with their labels, and shows one line as one number", async () => {
    stubWidth(480);
    const slot = await mountPage("wt_1", page(code(1)));
    const header = (await slot.findByRole("figure")).querySelector(".wt-fh")!;
    expect(Array.from(header.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"))).toEqual(["Copy the path", "Copy the code"]);
    expect(header.querySelector(".wt-fh-lines")!.textContent).toBe("107");
    expect(lineRange({ startLine: 5, endLine: 9 })).toBe("5\u20139");
  });

  it("never wraps the header onto a second row, and lets only the directory give way", () => {
    expect(appCss).not.toMatch(/\.wt-fh \{[^}]*flex-wrap: wrap/u);
    expect(figureCss).toMatch(/\.wt \.wt-fh \{ flex-wrap: nowrap;/u);
    expect(figureCss).toMatch(/\.wt \.wt-fh > :not\(\.wt-fh-where\) \{ flex: none; \}/u);
    expect(figureCss).toMatch(/\.wt \.wt-fh-dir \{[^}]*overflow: hidden; text-overflow: ellipsis/u);
    expect(figureCss).toMatch(/\.wt \.wt-fh-name \{ flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis/u);
  });
});

describe("a folded figure", () => {
  it("folds on a whole line and puts its Show all row below the code, not over it", async () => {
    stubWidth(480);
    const slot = await mountPage("wt_1", page(code(45)));
    const figure = await slot.findByRole("figure");
    const rows = figure.querySelector<HTMLElement>(".wt-code-rows")!;
    expect(rows.style.maxHeight).toBe(`${CLAMP_ROWS * ROW_HEIGHT}px`);
    expect(rows.style.overflow).toBe("hidden");
    const more = figure.querySelector(".wt-more")!;
    expect(more.textContent).toContain("Show all 45 lines");
    expect(more.closest(".wt-code")).toBeNull();
    expect(more.previousElementSibling!.classList.contains("wt-scrollwrap")).toBe(true);
    // The scroller itself carries no clip, so a long line can still scroll sideways while the figure is folded.
    expect(figure.querySelector<HTMLElement>(".wt-code")!.style.overflow).toBe("");
    expect(figure.querySelector<HTMLElement>(".wt-code")!.style.maxHeight).toBe("");
    fireEvent.click(more);
    expect(figure.querySelector(".wt-more")).toBeNull();
    expect(figure.querySelector<HTMLElement>(".wt-code-rows")!.style.maxHeight).toBe("");
  });

  it("is a whole number of lines, and stretches only as far as the last note needs", () => {
    expect(ROW_HEIGHT).toBe(19);
    expect(clampedRows(30, -1)).toBeNull();
    expect(clampedRows(31, -1)).toBe(CLAMP_ROWS);
    expect(clampedRows(80, 40)).toBe(42);
    expect(clampedRows(41, 40)).toBeNull();
  });

  it("gives the fold row its own height in the flow, with no overlay on the last line", () => {
    expect(figureCss).toMatch(/\.wt \.wt-more \{[^}]*position: static;[^}]*height: 30px/u);
    expect(appCss).toMatch(/\.wt-row \{[^}]*height: var\(--wt-row-h\)/u);
    expect(appCss).toMatch(/--wt-row-h: 19px/u);
  });
});

describe("a line longer than the figure", () => {
  it("shows a fade and a thin scroll bar where there is more, and neither where there is not", async () => {
    stubWidth(480);
    const sizes = new Map<string, number>([["scrollWidth", 1600], ["clientWidth", 400]]);
    const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("wt-code") ? sizes.get("scrollWidth")! : 0;
    });
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("wt-code") ? sizes.get("clientWidth")! : 0;
    });
    try {
      const slot = await mountPage("wt_1", page(code(8)));
      const figure = await slot.findByRole("figure");
      const scroller = figure.querySelector<HTMLElement>(".wt-code")!;
      await vi.waitFor(() => expect(scroller.dataset.moreRight).toBe("true"));
      expect(scroller.dataset.moreLeft).toBeUndefined();
      const thumb = figure.querySelector<HTMLElement>(".wt-hbar i")!;
      expect(thumb.style.width).toBe("25%");
      scroller.scrollLeft = 1200;
      fireEvent.scroll(scroller);
      await vi.waitFor(() => expect(scroller.dataset.moreRight).toBeUndefined());
      expect(scroller.dataset.moreLeft).toBe("true");
      expect(figure.querySelector<HTMLElement>(".wt-hbar i")!.style.left).toBe("75%");
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });

  it("draws neither for code that fits", async () => {
    stubWidth(480);
    const slot = await mountPage("wt_1", page(code(8)));
    const figure = await slot.findByRole("figure");
    expect(figure.querySelector(".wt-hbar")).toBeNull();
    expect(figure.querySelector<HTMLElement>(".wt-code")!.dataset.moreRight).toBeUndefined();
  });

  it("scrolls sideways, fades by the cue's attributes, and hides the native bar the cue replaces", () => {
    expect(appCss).toMatch(/\.wt-code \{[^}]*overflow-x: auto/u);
    expect(figureCss).toMatch(/\.wt \.wt-code\[data-more-left\], \.wt \.wt-code\[data-more-right\] \{[^}]*mask-image: linear-gradient/u);
    expect(figureCss).toMatch(/\.wt \.wt-code \{[^}]*scrollbar-width: none/u);
  });

  it("keeps the keyboard line cursor working in a folded, scrollable figure", async () => {
    stubWidth(480);
    const slot = await mountPage("wt_1", page(code(45)));
    const scroller = (await slot.findByRole("figure")).querySelector<HTMLElement>(".wt-code")!;
    scroller.focus();
    fireEvent.keyDown(scroller, { key: "ArrowDown" });
    fireEvent.keyDown(scroller, { key: "ArrowDown" });
    expect(scroller.querySelector("[data-cursor]")!.getAttribute("data-line")).toBe("108");
    expect(scroller.querySelector("[role=status]")!.textContent).toBe("Line 108. Press C to flag it.");
  });
});

describe("the number column", () => {
  it("is as wide as the widest line number needs", () => {
    expect(numberDigits(parsePatchRows(patch(lines(3, 5), 5)))).toBe(2);
    expect(numberDigits(parsePatchRows(patch(lines(3, 998), 998)))).toBe(4);
  });

  it("sets the column from the figure's own digits", async () => {
    stubWidth(480);
    const slot = await mountPage("wt_1", page(code(3)));
    expect((await slot.findByRole("figure")).querySelector<HTMLElement>(".wt-codebox")!.style.getPropertyValue("--wt-digits")).toBe("3");
    expect(figureCss).toMatch(/\.wt \.wt-row b \{ width: calc\(var\(--wt-digits, 3\) \* 1ch \+ 6px\); \}/u);
  });
});

describe("the panel layout", () => {
  it.each([390, 480, 540, NARROW_BELOW - 1])("marks a reader %ipx wide as narrow", async (width) => {
    stubWidth(width);
    const slot = await mountPage("wt_1", page(code(5)));
    await slot.findByRole("figure");
    expect(slot.container.querySelector(".wt")!.hasAttribute("data-narrow")).toBe(true);
  });

  it.each([NARROW_BELOW, 900, 1440])("does not mark a reader %ipx wide as narrow", async (width) => {
    stubWidth(width);
    const slot = await mountPage("wt_1", page(code(5)));
    await slot.findByRole("figure");
    expect(slot.container.querySelector(".wt")!.hasAttribute("data-narrow")).toBe(false);
  });

  it("collapses the ruled margin to a 24px edge that holds the part number, and frees the width to the figure", () => {
    expect(figureCss).toMatch(/\.wt\[data-narrow\] \.wt-page \{[^}]*padding: 24px 14px 52px 40px;[^}]*transparent 23px, var\(--wt-rule\) 23px, var\(--wt-rule\) 24px/u);
    expect(figureCss).toMatch(/\.wt\[data-narrow\] \.wt-pn \{ left: 0; width: 23px;/u);
    expect(figureCss).toMatch(/\.wt\[data-narrow\] \.wt-figure \{[^}]*margin-inline: -16px -14px; max-width: none;/u);
    expect(figureCss).toMatch(/\.wt\[data-narrow\] \.wt-row \{ gap: 12px; padding-left: var\(--wt-fig-l\); \}/u);
  });

  it("makes the page marks the picker at panel width and keeps the title on one line", async () => {
    stubWidth(390);
    const slot = await mountPage("wt_1", viewOf(walkthrough({ currentPart: 0, parts: [part("A"), part("B")] })));
    const chip = await slot.findByRole("button", { name: /^Parts/u });
    expect(chip.querySelector(".wt-dots")).not.toBeNull();
    expect(chip.textContent).toBe("Part 1 of 2");
    // The words are a wide-window detail; the marks carry position at every width.
    expect(appCss).toMatch(/\.wt-chip-n \{ display: none;/u);
    expect(appCss).toMatch(/@container wt \(min-width: 560px\) \{ \.wt-chip-n \{ display: inline; \} \}/u);
    expect(figureCss).not.toMatch(/\.wt\[data-narrow\] \.wt-dots \{ display: none; \}/u);
    expect(figureCss).toMatch(/\.wt\[data-narrow\] \.wt-title \{ flex: 1 1 auto; min-width: 0; \}/u);
  });

  it("sets a figure's notes compactly at panel width: smaller italic, one hairline, the marker on the first line", () => {
    expect(figureCss).toMatch(/\.wt\[data-narrow\] \.wt-mn \{[^}]*font-size: 13\.5px; line-height: 1\.38/u);
    expect(figureCss).toMatch(/\.wt \.wt-notes-stack \{ border-top: 0\.5px solid var\(--wt-hair\);/u);
    expect(figureCss).toMatch(/\.wt\[data-narrow\] \.wt-mn > \.wt-m-inline \{ top: 1\.5px; \}/u);
  });

  it("keeps a caption with its own figure: tight above its block, a full gap after the one before", () => {
    expect(figureCss).toMatch(/\.wt \.wt-figure \{ margin-block: 28px; \}/u);
    expect(figureCss).toMatch(/\.wt \.wt-cap \{ padding-bottom: 6px;/u);
    expect(figureCss).toMatch(/\.wt \.wt-fig \{[^}]*background: var\(--wt-fig-fill\)/u);
  });

  it("wraps unbreakable prose instead of widening the page", () => {
    expect(figureCss).toMatch(/\.wt \.wt-page :is\([^)]*\.wt-inline-code[^)]*\) \{ overflow-wrap: anywhere; \}/u);
  });
});

describe("other places that name a file", () => {
  it("names a flagged line's file inside its repository in the wrap-up margin", () => {
    const flagged = note({ location: { path: `${OTHER_REPO}/src/server/quick.ts`, startLine: 109 } });
    const files = { environmentId: "env_1", hostId: "host_1", workspacePath: "/Users/tomdale/Code/tomdaleOS", repoRoots: [OTHER_REPO] };
    const { container } = render(<OpenMargin files={files} notes={[flagged]} glyphs={new Map()} onJump={() => {}} onMore={() => {}} />);
    expect(container.querySelector(".wt-aside-loc")!.textContent).toBe("src/server/quick.ts:109");
  });
});
