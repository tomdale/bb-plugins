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
