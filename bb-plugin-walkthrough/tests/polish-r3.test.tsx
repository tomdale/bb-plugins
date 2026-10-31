// @vitest-environment jsdom
// Round three of the visual pass: figures sized by their content, one focus
// language shown only to the keyboard, the motion and contrast tokens, and the
// small markup hooks the stylesheet relies on.
import { fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineCode } from "../src/ui/inline.tsx";
import { trackInputModality } from "../src/ui/modality.ts";
import { mountPage, mounted, pagedView, part, stubWidth, viewOf, walkthrough } from "./helpers.tsx";

const css = readFileSync("app.css", "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
const rule = (selector: string): string => {
  const found = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/gu))
    .filter((match) => match[1]!.split(",").some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]!);
  if (found.length === 0) throw new Error(`no rule for ${selector}`);
  return found.join(" ");
};

beforeEach(() => {
  stubWidth(1440);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
});

const patch = (lines: string[], start = 1, header = `@@ -${start},${lines.length} +${start},${lines.length} @@`) =>
  ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", header, ...lines, ""].join("\n");
const block = (snapshot: unknown, notes: Array<{ line: number; text: string }> = []) => ({ kind: "code" as const, caption: "Caption", path: "src/a.ts", startLine: 1, endLine: 4, notes, snapshot, snapshotError: null });
const wt = (b: Record<string, unknown>) => viewOf(walkthrough({ parts: [part("Part", { blocks: [b] })] }));
const mixed = { change: patch([" one", "+two", "-three", " four"]), after: null, before: null, baseSha: "a", headSha: "b", capturedAt: 1 };
const added = { change: patch(["+one", "+two", "+three"], 1, "@@ -0,0 +1,3 @@"), after: null, before: null, baseSha: "a", headSha: "b", capturedAt: 1 };
const long = "A long note that wraps over many lines of the margin and so runs well past the short code it annotates, far below the figure's bottom rule.";

describe("figures sized by their content", () => {
  it("lets long margin notes hang past the figure instead of stretching it", async () => {
    const slot = await mountPage("wt_1", wt(block(mixed, [{ line: 1, text: long }, { line: 2, text: long }])));
    const figure = await slot.findByRole("figure");
    expect(figure.querySelector<HTMLElement>(".wt-fig")!.style.minHeight).toBe("");
    expect(Number.parseInt(figure.style.getPropertyValue("--wt-hang"), 10)).toBeGreaterThan(0);
    expect(figure.getAttribute("data-hang")).toBe("true");
    expect(rule(".wt-figure[data-hang] + .wt-figure")).toContain("var(--wt-hang)");
  });

  it("hangs nothing for notes that fit beside their code", async () => {
    const slot = await mountPage("wt_1", wt(block(mixed, [{ line: 1, text: "Short." }])));
    expect(Array.from((await slot.findAllByRole("figure")).map((figure) => figure.getAttribute("data-hang")))).toEqual([null]);
  });

  it("shrinks an empty figure to a sentence, and drops the marker gutter where there are no markers", () => {
    expect(rule(".wt-figure:has(.wt-fig-empty)")).toContain("max-width: calc(var(--wt-measure) + 30px)");
    expect(css).toMatch(/\.wt-figure:not\(:has\(\.wt-mk\), \.wt-skel-figure\) \.wt-row \{ padding-left: var\(--wt-fig-l\)/u);
  });

  it("tints lines in a layer under the scroller and leaves a whole-file addition untinted", async () => {
    const slot = await mountPage("wt_1", wt(block(added)));
    const tints = (await slot.findByRole("figure")).querySelector(".wt-tints")!;
    expect(Array.from(tints.querySelectorAll("i")).map((tint) => tint.className)).toEqual(["wt-add", "wt-add", "wt-add"]);
    expect(tints.closest(".wt-codebox")!.querySelector(".wt-code")).not.toBeNull();
    expect(tints.compareDocumentPosition(tints.closest(".wt-codebox")!.querySelector(".wt-code")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(css).toMatch(/\.wt-tints:where\(:not\(:has\(\.wt-del, i:not\(\.wt-add\)\)\)\) \.wt-add \{ background: none; \}/u);
    expect(rule(".wt-tints .wt-add")).toContain("inset 2px 0 0");
  });

  it("marks mixed changes with a tinted strip per row", async () => {
    const slot = await mountPage("wt_1", wt(block(mixed)));
    expect(Array.from((await slot.findByRole("figure")).querySelectorAll(".wt-tints i")).map((tint) => tint.className)).toEqual(["wt-ctx", "wt-add", "wt-del", "wt-ctx"]);
  });
});

describe("focus", () => {
  it("is one soft accent halo, shown to the keyboard and not to a pointer-opened surface", () => {
    expect(rule(".wt :focus-visible")).toContain("outline: 3px solid var(--wt-ring)");
    expect(css).not.toContain("#b88a00");
    expect(css).toMatch(/html\[data-wt-pointer\] :is\(\.wt, \.wt-portal\) :focus-visible:not\(input, textarea, \[contenteditable\]\) \{ outline: none; \}/u);
    expect(rule(".wt textarea:focus-visible")).toContain("box-shadow: inset 0 0 0 2px var(--wt-ring)");
    expect(css).toMatch(/\.dark \.wt,\s*\.dark \.wt-portal \{[^}]*color-scheme: dark/u);
  });

  it("records pointer and keyboard use on the document", () => {
    trackInputModality();
    const root = document.documentElement;
    document.dispatchEvent(new Event("pointerdown"));
    expect(root.hasAttribute("data-wt-pointer")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    expect(root.hasAttribute("data-wt-pointer")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(root.hasAttribute("data-wt-pointer")).toBe(false);
  });
});

describe("selected chip, destructive actions and the dark accent", () => {
  it("keeps the selected Concerns chip readable on hover", () => {
    expect(rule('.wt-chip[data-selected="true"]:hover:not(:disabled)')).toContain("color: var(--wt-yt)");
  });
  it("paints destructive actions red in both modes", () => {
    expect(css).toMatch(/--wt-danger: #ff3b30/u);
    expect(css).toMatch(/--wt-danger: #ff453a/u);
    expect(rule(".wt-btn-danger")).toContain("background: var(--wt-danger)");
  });
  it("lets one yellow thing speak per dark screen", () => {
    expect(rule(".dark .wt:has(.wt-sheet[data-open]) .wt-pager .wt-btn-primary")).toContain("background: var(--wt-fill)");
    expect(rule(".dark .wt-ref")).toContain("transparent 84%");
    expect(rule(".dark .wt .wt-it-proposal")).toContain("inset 2px 0 0 var(--wt-y)");
  });
});

describe("pages and sheet geometry", () => {
  it("sets the index and the starter on the same centered 760px sheet at the reading measure", () => {
    expect(css).toMatch(/\.wt:has\(\.wt-index, \.wt-start-page\) \{ --wt-sheet-w: 760px; \}/u);
    expect(css).toMatch(/\.wt-continue, \.wt-detected, \.wt-start-form \{ max-width: var\(--wt-measure\); \}/u);
    expect(css).not.toMatch(/\.wt-index \{ max-width/u);
  });
  it("insets the sheet 10px on every side and shrinks it when empty", () => {
    expect(rule(".wt-sheet")).toMatch(/top: 66px/u);
    expect(rule(".wt-sheet")).toMatch(/bottom: calc\(var\(--wt-pager-h, 12px\) \+ 20px\)/u);
    expect(rule(".wt-sheet:not(:has(.wt-it))")).toContain("bottom: auto");
  });
  it("fits the pager at 390px", () => {
    expect(css).toMatch(/\.wt-pager-row:has\(\.wt-next\) \.wt-finished \{ display: none; \}/u);
    expect(css).toMatch(/@container wt \(max-width: 420px\) \{\s*\.wt \.wt-next-title \{ display: none; \}/u);
  });
});

describe("motion, contrast and transparency", () => {
  it("defines the motion tokens and no ad-hoc durations", () => {
    for (const token of ["--wt-dur-1: 120ms", "--wt-dur-2: 220ms", "--wt-dur-3: 350ms", "--wt-pulse: 1.6s"]) expect(css).toContain(token);
    const outsideTokens = css.replace(/--wt-(?:dur-\d|pulse):[^;]*;/gu, "");
    const timed = Array.from(outsideTokens.matchAll(/(?:transition|animation)(?:-duration)?:[^;]*;/gu)).map((match) => match[0]);
    expect(timed.length).toBeGreaterThan(10);
    for (const declaration of timed) expect(declaration, declaration).not.toMatch(/(?<![\w.-])(?!0s)\d*\.?\d+(?:ms|s)\b(?! linear)/u);
  });
  it("has higher-contrast values and lets reduced transparency win over every glass surface", () => {
    expect(css).toMatch(/@media \(prefers-contrast: more\)[\s\S]*--wt-hair[\s\S]*--wt-mute[\s\S]*--wt-ring/u);
    const block = /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/u.exec(css)![1]!;
    for (const surface of [".wt-glass", ".wt-flag.wt-glass", ".wt-sheet"]) expect(block).toContain(surface);
  });
});

describe("inline code in previews", () => {
  it("sets backticked spans as code and leaves the rest as text", () => {
    const { container } = render(<InlineCode text="Use `fetch` then `retry` twice" />);
    expect(Array.from(container.querySelectorAll("code.wt-inline-code")).map((code) => code.textContent)).toEqual(["fetch", "retry"]);
    expect(container.textContent).toBe("Use fetch then retry twice");
  });
});

describe("moments", () => {
  it("turns the page in the direction of travel and restarts the turn each time", async () => {
    const paged = pagedView(walkthrough({ parts: [part("One"), part("Two"), part("Three")] }));
    const slot = await mountPage("wt_1", paged.rpc);
    const page = () => slot.container.querySelector(".wt-page")!.getAttribute("data-turn");
    expect(page()).toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: /Next: Two/u }));
    await paged.changed(slot);
    await slot.findByText("Two prose.");
    expect(page()).toBe("next-a");
    fireEvent.click(await slot.findByRole("button", { name: /Next: Three/u }));
    await paged.changed(slot);
    await slot.findByText("Three prose.");
    expect(page()).toBe("next-b");
    fireEvent.click(await slot.findByRole("button", { name: /Previous: Two/u }));
    await paged.changed(slot);
    await slot.findByText("Two prose.");
    expect(page()).toBe("prev-a");
  });

  it("animates transform and opacity only, from the arrived state, and not under reduced motion", () => {
    for (const name of ["wt-turn-next-a", "wt-turn-next-b", "wt-turn-prev-a", "wt-turn-prev-b", "wt-settle"]) {
      const body = new RegExp(`@keyframes ${name} \\{([^@]*?)\\}\\s*(?=\\.|@|$)`, "u").exec(css)?.[1] ?? "";
      expect(body, name).toMatch(/transform/u);
      expect(body, name).not.toMatch(/\b(?:top|left|width|height|margin)\b/u);
    }
    expect(css).toMatch(/\.wt-page\[data-turn\] > :not\(\.wt-flag\) \{[^}]*animation-fill-mode: backwards/u);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.wt \*:not\(\.wt-code\)[^}]*animation: none !important/u);
    expect(css).toMatch(/\.wt-m-own, \.wt-prose-flag \{ animation: wt-settle/u);
  });
});
