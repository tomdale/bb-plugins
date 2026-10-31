// @vitest-environment jsdom
// Syntax colour in the reading page's figures: tokens reach the rows of every
// view, compose with the word diff, and change nothing a reader selects, copies
// or hears.
import { act, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { excerptCode } from "../src/model.ts";
import { highlightForFigure } from "../src/syntax/tokenizer.ts";
import { STREAM_CHANNEL, type StreamPayload } from "../src/schemas.ts";
import { forgetTokens } from "../src/ui/syntax.ts";
import { mountPage, mounted, part, stubWidth, viewOf, walkthrough } from "./helpers.tsx";

const css = readFileSync("app.css", "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");

beforeEach(() => {
  forgetTokens();
  stubWidth(480);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
});

const patch = (path: string, lines: string[]) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -3,${lines.length} +3,${lines.length} @@`, ...lines, ""].join("\n");
const DIFF = [" const a = 1;", "-const delay = base * attempt; /* x", "-y */", "+const delay = base * 2 ** attempt + jitter();", " // done"];
const sides = (path: string) => ({
  change: patch(path, DIFF),
  after: patch(path, DIFF.filter((line) => !line.startsWith("-")).map((line) => (line.startsWith("+") ? ` ${line.slice(1)}` : line))),
  before: patch(path, DIFF.filter((line) => !line.startsWith("+")).map((line) => (line.startsWith("-") ? ` ${line.slice(1)}` : line))),
  baseSha: "a1b2c3d",
  headSha: "e4f5a6b",
  capturedAt: 1,
});
const figure = (path = "src/a.ts", over: Record<string, unknown> = {}) => ({ kind: "code" as const, caption: "c", path, startLine: 3, endLine: 7, notes: [], snapshot: sides(path), view: "diff" as const, ...over });
const open = (block: ReturnType<typeof figure>, rpc: Record<string, unknown> = {}) =>
  mountPage("wt_1", { ...viewOf(walkthrough({ parts: [part("A", { blocks: [block] })] })), highlight: (input: { path: string; texts: string[] }) => highlightForFigure(input.path, input.texts), ...rpc });
const rowsOf = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(".wt-code-rows > .wt-row:not(.wt-gap)"));
const roles = (row: Element) => Array.from(row.querySelectorAll(".wt-tk")).map((token) => [token.textContent, token.className.replace("wt-tk wt-tk-", "")]);

describe("tokens in the rows", () => {
  it("shows the rows plain first, then colours them without changing their text or structure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const highlight = vi.fn(async (input: { path: string; texts: string[] }) => (await gate, highlightForFigure(input.path, input.texts)));
    const slot = await open(figure(), { highlight });
    await slot.findByText("// done");
    const container = slot.container;
    const fig = container.querySelector<HTMLElement>("figure[data-code-path]")!;
    const plain = { text: container.querySelector(".wt-code")!.textContent, rows: rowsOf(container).map((row) => [row.className, row.childElementCount, row.querySelector(".wt-text")!.textContent]) };
    expect(container.querySelector(".wt-tk")).toBeNull();
    expect(fig.dataset.language).toBe("typescript");
    expect(fig.dataset.highlighted).toBeUndefined();

    await act(async () => release());
    await vi.waitFor(() => expect(container.querySelector(".wt-tk")).not.toBeNull());
    expect(fig.dataset.highlighted).toBe("true");
    expect(container.querySelector(".wt-code")!.textContent).toBe(plain.text);
    expect(rowsOf(container).map((row) => [row.className, row.childElementCount, row.querySelector(".wt-text")!.textContent])).toEqual(plain.rows);
  });

  it("colours the diff from the right side: removed lines from the old text, added and context lines from the new", async () => {
    const highlight = vi.fn((input: { path: string; texts: string[] }) => highlightForFigure(input.path, input.texts));
    const slot = await open(figure(), { highlight });
    await vi.waitFor(() => expect(slot.container.querySelector(".wt-tk")).not.toBeNull());
    expect(highlight).toHaveBeenCalledTimes(1);
    expect(highlight.mock.calls[0]![0].texts).toEqual(["const a = 1;\nconst delay = base * 2 ** attempt + jitter();\n// done", "const a = 1;\nconst delay = base * attempt; /* x\ny */\n// done"]);
    const rows = rowsOf(slot.container);
    // `y */` closes a block comment that opens on the removed line above it; the new text has no such comment.
    expect(roles(rows[2]!)).toEqual([["y */", "comment"]]);
    expect(roles(rows[0]!)).toContainEqual(["const", "keyword"]);
    expect(roles(rows[4]!)).toEqual([["// done", "comment"]]);
    // The sign and the screen-reader label are not part of any token.
    expect(rows[3]!.querySelector(".wt-sr")!.textContent).toBe("Added: ");
    expect(rows[3]!.querySelector(".wt-tk .wt-sr")).toBeNull();
  });

  it("colours the After and Before views too, each read from its own text", async () => {
    const highlight = vi.fn((input: { path: string; texts: string[] }) => highlightForFigure(input.path, input.texts));
    const slot = await open(figure(), { highlight });
    await vi.waitFor(() => expect(slot.container.querySelector(".wt-tk")).not.toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "After" }));
    await vi.waitFor(() => expect(highlight).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(rowsOf(slot.container).every((row) => row.querySelector(".wt-tk"))).toBe(true));
    expect(roles(rowsOf(slot.container)[1]!)).toContainEqual(["2", "number"]);
    fireEvent.click(slot.getByRole("button", { name: "Before" }));
    await vi.waitFor(() => expect(highlight).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(roles(rowsOf(slot.container)[2]!)).toEqual([["y */", "comment"]]));
    // Back to Diff: remembered, so no new request.
    fireEvent.click(slot.getByRole("button", { name: "Diff" }));
    await vi.waitFor(() => expect(rowsOf(slot.container)).toHaveLength(5));
    expect(highlight).toHaveBeenCalledTimes(3);
  });

  it("colours a code figure (understand mode) from the one text it has", async () => {
    const lines = [" fn main() {", "     let n = 42;", " }"];
    const block = figure("src/main.rs", { view: "code", snapshot: { change: null, after: patch("src/main.rs", lines), before: null, baseSha: null, headSha: "e4f5a6b", capturedAt: 1 } });
    const highlight = vi.fn((input: { path: string; texts: string[] }) => highlightForFigure(input.path, input.texts));
    const slot = await open(block, { highlight });
    await vi.waitFor(() => expect(roles(rowsOf(slot.container)[1]!)).toContainEqual(["42", "number"]));
    expect(highlight.mock.calls[0]![0].texts).toEqual(["fn main() {\n    let n = 42;\n}"]);
  });

  it("colours a figure whose code came from the excerpt RPC, not a saved snapshot", async () => {
    const sidesOf = sides("src/a.ts");
    const excerpt = vi.fn(() => ({ outcome: "available", path: "src/a.ts", change: sidesOf.change, after: sidesOf.after, before: sidesOf.before }));
    const slot = await open(figure("src/a.ts", { snapshot: null }), { excerpt });
    await vi.waitFor(() => expect(slot.container.querySelector(".wt-tk")).not.toBeNull());
    expect(excerpt).toHaveBeenCalled();
  });

  it("leaves a file with no grammar plain and never asks the server", async () => {
    const highlight = vi.fn();
    const slot = await open(figure("data/table.xyz"), { highlight });
    await slot.findByText("// done");
    await act(async () => void (await Promise.resolve()));
    expect(highlight).not.toHaveBeenCalled();
    expect(slot.container.querySelector(".wt-tk")).toBeNull();
    expect(slot.container.querySelector<HTMLElement>("figure[data-code-path]")!.dataset.language).toBeUndefined();
  });

  it("stays plain when the server cannot tokenize, without any error on the page", async () => {
    const slot = await open(figure(), { highlight: () => Promise.reject(new Error("down")) });
    await slot.findByText("// done");
    await act(async () => void (await Promise.resolve()));
    expect(slot.container.querySelector(".wt-tk")).toBeNull();
    expect(slot.container.querySelector("[role='alert']")).toBeNull();
  });

  it("does not colour a figure that is still being written, and colours it once the part is saved", async () => {
    const sidesOf = sides("src/a.ts");
    const highlight = vi.fn((input: { path: string; texts: string[] }) => highlightForFigure(input.path, input.texts));
    const excerpt = () => ({ outcome: "available", path: "src/a.ts", change: sidesOf.change, after: sidesOf.after, before: sidesOf.before });
    const writing = (parts: unknown[], inFlight: unknown) => walkthrough({ parts, currentPart: 0, inFlight });
    let current = writing([part("A", { status: "writing", blocks: [], suggestions: [] })], { request: { kind: "write", part: 0 }, sentAt: 10, afterSeq: 5 });
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: current, notes: [] } }), streamSnapshot: () => ({ snapshot: null }), excerpt, highlight });
    await slot.findByRole("status", { name: "Writing this part…" });
    const emit = (value: StreamPayload) => act(() => slot.emitRealtime(STREAM_CHANNEL, value));
    const text = "The loop.\n\n```walkthrough\npath: src/a.ts\nlines: 3-7\nview: diff\ncaption: The loop";
    await emit({ walkthroughId: "wt_1", requestKind: "write", place: 0, seq: 8, text, state: "streaming" });
    const fig = await vi.waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("figure[data-code-path]");
      expect(found?.querySelector(".wt-row")).toBeTruthy();
      return found!;
    });
    await act(async () => void (await Promise.resolve()));
    expect(fig.dataset.streaming).toBe("true");
    expect(highlight).not.toHaveBeenCalled();
    expect(fig.querySelector(".wt-tk")).toBeNull();

    current = writing([part("A", { status: "ready", blocks: [{ kind: "code", caption: "The loop", path: "src/a.ts", startLine: 3, endLine: 7, notes: [], view: "diff", snapshot: null, snapshotError: null }] })], null);
    await emit({ walkthroughId: "wt_1", requestKind: "write", place: 0, seq: 8, text, state: "done" });
    await act(() => slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "changed" }));
    await vi.waitFor(() => expect(slot.container.querySelector("figure .wt-tk")).not.toBeNull());
    expect(slot.container.querySelector<HTMLElement>("figure")!.dataset.streaming).toBeUndefined();
    expect(highlight).toHaveBeenCalled();
  });
});

const ruleList = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)).map((match) => ({ selectors: match[1]!.split(",").map((selector) => selector.trim()), body: match[2]! }));

describe("tokens with the rest of the figure", () => {
  it("lets the word diff mark words over the colour, with the same marked text", async () => {
    const slot = await open(figure());
    await vi.waitFor(() => expect(slot.container.querySelector(".wt-tk")).not.toBeNull());
    const marks = Array.from(slot.container.querySelectorAll(".wt-add mark.wt-w"));
    expect(marks.length).toBeGreaterThan(0);
    // The marked words keep their colour: tokens sit inside the mark, whole or cut at its edge.
    expect(marks.some((mark) => mark.querySelector(".wt-tk"))).toBe(true);
    const row = slot.container.querySelector(".wt-add .wt-text")!;
    expect(row.textContent).toBe("Added: const delay = base * 2 ** attempt + jitter();");
  });

  it("copies the plain code, and the gutter and signs stay outside the text a selection holds", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const slot = await open(figure());
    await vi.waitFor(() => expect(slot.container.querySelector(".wt-tk")).not.toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "Copy the code" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toBe(excerptCode(sides("src/a.ts").change, "change"));
    expect(copied).toContain("+const delay = base * 2 ** attempt + jitter();");
    expect(copied).not.toMatch(/<|wt-tk/u);
    // Tokens live in the code column only: no gutter element contains one, and a sign is a pseudo-element.
    expect(slot.container.querySelectorAll(".wt-row b .wt-tk")).toHaveLength(0);
    expect(css).toMatch(/\.wt-add \.wt-text::before[^{]*\{[^}]*content: "\+"/u);
    const unselectable = ruleList.find((rule) => rule.selectors.includes(".wt-row .wt-sr"))!;
    expect(unselectable.selectors).toContain(".wt-row b");
    expect(unselectable.body).toContain("user-select: none");
  });

  it("keeps a row's screen-reader text, flag target and line number", async () => {
    const onlyAfter = figure("src/a.ts", { view: "code" });
    const slot = await open(onlyAfter);
    await vi.waitFor(() => expect(slot.container.querySelector(".wt-tk")).not.toBeNull());
    const row = slot.container.querySelector<HTMLElement>('.wt-row[data-line="3"]')!;
    expect(row.querySelector(".wt-ln")!.getAttribute("aria-label")).toBe("Flag line 3");
    expect(row.querySelector(".wt-text")!.textContent).toBe("const a = 1;");
  });
});

describe("what the colour may change", () => {
  it("is a colour and, for a heading, a weight: no metric a row's width or height depends on", () => {
    const tokenRules = ruleList.filter((rule) => rule.selectors.some((selector) => /\.wt-tk\b/u.test(selector)));
    expect(tokenRules.length).toBeGreaterThanOrEqual(9);
    const allowed = new Set(["color", "font-weight"]);
    for (const rule of tokenRules) {
      for (const declaration of rule.body.split(";").map((part) => part.trim()).filter(Boolean)) {
        const property = declaration.split(":")[0]!.trim();
        expect(allowed.has(property) || property.startsWith("--"), `${rule.selectors.join(",")} sets ${property}`).toBe(true);
      }
    }
    // Weight is only on the heading, and rows stay a fixed height whatever they hold.
    expect(tokenRules.filter((rule) => rule.body.includes("font-weight")).flatMap((rule) => rule.selectors)).toEqual([".wt-tk-heading"]);
    expect(ruleList.find((rule) => rule.selectors.includes(".wt-row"))!.body).toContain("height: var(--wt-row-h)");
  });
});
