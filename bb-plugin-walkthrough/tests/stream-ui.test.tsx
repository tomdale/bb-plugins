// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_CHANNEL, type StreamPayload } from "../src/schemas.ts";
import { applyPayload, streamedView } from "../src/ui/stream.ts";
import { mountPage, mounted, part, stubWidth, walkthrough } from "./helpers.tsx";

beforeEach(() => {
  stubWidth(480);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
});

const payload = (seq: number, text: string, extra: Partial<StreamPayload> = {}): StreamPayload => ({ walkthroughId: "wt_1", requestKind: "write", place: 0, seq, text, state: "streaming", ...extra });
const PARTIAL_HEADER = "```walkthrough\npath: src/a.ts\nlines: 3-";
const FIGURE_HEADER = "```walkthrough\npath: src/a.ts\nlines: 3-9\nview: code\n";
const writing = (extra: Record<string, unknown> = {}) =>
  walkthrough({
    parts: [part("Schema", { status: "writing", blocks: [], suggestions: [] })],
    currentPart: 0,
    inFlight: { request: { kind: "write", part: 0 }, sentAt: 10, afterSeq: 5 },
    ...extra,
  });

describe("applying payloads", () => {
  it("ignores duplicates and older payloads, and lets a terminal payload settle its own seq", () => {
    let state = applyPayload({}, payload(10, "ten"));
    expect(applyPayload(state, payload(10, "ten"))).toBe(state);
    expect(applyPayload(state, payload(8, "eight"))).toBe(state);
    state = applyPayload(state, payload(12, "twelve"));
    expect(state["write:0"]!.text).toBe("twelve");
    state = applyPayload(state, payload(12, "twelve", { state: "done" }));
    expect(state["write:0"]!.state).toBe("done");
    expect(applyPayload(state, payload(12, "twelve"))).toBe(state);
  });

  it("splits the plan turn at the part marker and shows suggestions only once they close", () => {
    const text = "Intro words.\n\n```walkthrough\npart: 1\n```\n\nPart one.\n\n```walkthrough\nsuggestions:\n- One?\n";
    const open = streamedView(payload(1, text, { requestKind: "plan" }));
    expect(open.intro).toBe("Intro words.");
    expect(open.blocks).toMatchObject([{ kind: "prose", text: "Part one." }]);
    expect(open.suggestions).toBeNull();
    expect(streamedView(payload(2, `${text}\`\`\`\n`, { requestKind: "plan" })).suggestions).toEqual(["One?"]);
  });
});

const flush = () => act(async () => void (await Promise.resolve()));

describe("the pane while a part streams", () => {
  it("shows prose as it arrives, a figure when its header closes, suggestions when they close, and hands off to the saved part in the same nodes", async () => {
    let current = writing();
    const excerpt = vi.fn(() => ({ outcome: "unavailable", message: "gone" }));
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: current, notes: [] } }), streamSnapshot: () => ({ snapshot: null }), excerpt });
    await slot.findByRole("status", { name: "Writing this part…" });
    const emit = (value: StreamPayload) => act(() => slot.emitRealtime(STREAM_CHANNEL, value));
    const page = () => slot.container.querySelector(".wt-page")!;

    await emit(payload(6, "The schema "));
    expect(page().textContent).toContain("The schema");
    const prose = page().querySelector("p:not(.wt-subject):not(.wt-muted)") as HTMLElement;
    expect(prose.closest(".wt-streaming")).not.toBeNull();

    // A header whose lines value is still arriving does not make a figure; a complete one does.
    await emit(payload(7, `The schema is small.\n\n${PARTIAL_HEADER}`));
    expect(slot.container.querySelector("figure")).toBeNull();
    await emit(payload(8, `The schema is small.\n\n${FIGURE_HEADER}caption: The table`));
    const figure = slot.container.querySelector("figure")!;
    expect(figure.dataset.codePath).toBe("src/a.ts");
    expect(figure.dataset.streaming).toBe("true");
    expect(excerpt).toHaveBeenCalledWith(expect.objectContaining({ path: "src/a.ts", startLine: 3, endLine: 9 }));
    expect(slot.container.textContent).toContain("The table");

    // An older payload arriving late changes nothing, and neither does a duplicate.
    await emit(payload(6, "stale text"));
    await emit(payload(8, `The schema is small.\n\n${FIGURE_HEADER}caption: The table`));
    expect(slot.container.textContent).not.toContain("stale text");

    // Suggestions show locked once their fence closes.
    const full = `The schema is small.\n\n${FIGURE_HEADER}caption: The table\n\`\`\`\n\n\`\`\`walkthrough\nsuggestions:\n- Why a table?\n- Who reads it?\n\`\`\`\n`;
    await emit(payload(9, full.slice(0, -4)));
    expect(slot.queryByRole("button", { name: "Why a table?" })).toBeNull();
    await emit(payload(10, full));
    const suggestion = slot.getByRole("button", { name: "Why a table?" }) as HTMLButtonElement;
    expect(suggestion.disabled).toBe(true);

    // The saved part replaces the stream: the same figure and paragraph elements remain, and the stream no longer matters.
    const savedProse = "The schema is small.";
    current = writing({
      parts: [part("Schema", { status: "ready", suggestions: ["Why a table?"], blocks: [{ kind: "prose", text: savedProse }, { kind: "code", caption: "The table", path: "src/a.ts", startLine: 3, endLine: 9, notes: [], view: "code", snapshot: null, snapshotError: null }] })],
      inFlight: null,
    });
    await emit(payload(10, full, { state: "done" }));
    await act(() => slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "changed" }));
    await slot.findByRole("button", { name: "Why a table?" }).then((button) => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(slot.container.querySelector("figure")).toBe(figure);
    expect(figure.dataset.streaming).toBeUndefined();
    expect(prose.isConnected).toBe(true);
    expect(page().querySelector(".wt-streaming")).toBeNull();
    expect(slot.queryByRole("status", { name: "Writing this part…" })).toBeNull();
  });

  it("joins mid-stream with a snapshot, and ignores a snapshot older than a payload that already arrived", async () => {
    let release: (value: unknown) => void = () => undefined;
    const snapshot = new Promise((resolve) => (release = resolve));
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: writing(), notes: [] } }), streamSnapshot: () => snapshot });
    await slot.findByRole("status", { name: "Writing this part…" });
    await act(() => slot.emitRealtime(STREAM_CHANNEL, payload(9, "Newer words")));
    release({ snapshot: payload(7, "Older words") });
    await flush();
    expect(slot.container.textContent).toContain("Newer words");
    expect(slot.container.textContent).not.toContain("Older words");

    const joined = await mountPage("wt_1", { get: () => ({ view: { walkthrough: writing(), notes: [] } }), streamSnapshot: () => ({ snapshot: payload(7, "Caught up") }) });
    await joined.findByText("Caught up");
  });

  it("does not show a previous request's text, other walkthroughs, failed streams, or anything after unmount", async () => {
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: writing(), notes: [] } }), streamSnapshot: () => ({ snapshot: null }) });
    await slot.findByRole("status", { name: "Writing this part…" });
    const emit = (value: StreamPayload) => act(() => slot.emitRealtime(STREAM_CHANNEL, value));
    await emit(payload(5, "Before the retry"));
    await emit(payload(20, "Someone else's", { walkthroughId: "wt_other" }));
    await emit({ nonsense: true } as never);
    expect(slot.container.textContent).not.toContain("Before the retry");
    expect(slot.container.textContent).not.toContain("Someone else's");
    await emit(payload(21, "Gave up", { state: "failed" }));
    expect(slot.container.textContent).not.toContain("Gave up");
    slot.unmount();
    mounted.splice(mounted.indexOf(slot as never), 1);
    await expect(slot.emitRealtime(STREAM_CHANNEL, payload(30, "After"))).resolves.not.toThrow();
  });
});

describe("the plan turn", () => {
  it("shows the introduction on the introduction page while the plan is written", async () => {
    const planning = walkthrough({ status: "planning", parts: [], currentPart: null, title: "Walkthrough", inFlight: { request: { kind: "plan" }, sentAt: 3, afterSeq: 0 } });
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: planning, notes: [] } }), streamSnapshot: () => ({ snapshot: null }) });
    await slot.findByRole("status", { name: /Reading the change/u });
    await act(() => slot.emitRealtime(STREAM_CHANNEL, payload(4, "This branch adds a cap.", { requestKind: "plan" })));
    await slot.findByText("This branch adds a cap.");
    expect(slot.container.querySelector(".wt-streaming")).not.toBeNull();
    expect(slot.queryByRole("status", { name: /Reading the change/u })).toBeNull();
  });
});

describe("answers in the margin thread", () => {
  it("streams the answer from the channel and leaves the same node when it is saved", async () => {
    const exchange = (answer: string, status: string) => ({ id: "e1", question: "Why?", answer, status, askedAt: 1 });
    let current = walkthrough({
      parts: [part("Schema", { discussion: [exchange("", "answering")] })],
      inFlight: { request: { kind: "ask", place: 0, exchangeId: "e1" }, sentAt: 5, afterSeq: 5 },
    });
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: current, notes: [] } }), streamSnapshot: () => ({ snapshot: null }) });
    await slot.findByText("Thinking…");
    const emit = (value: StreamPayload) => act(() => slot.emitRealtime(STREAM_CHANNEL, value));
    await emit(payload(6, "Because the cap", { requestKind: "ask" }));
    const answer = slot.container.querySelector(".wt-a")!;
    expect(answer.className).toContain("wt-streaming");
    await emit(payload(7, "Because the cap truncates.", { requestKind: "ask" }));
    expect(slot.container.querySelector(".wt-a")!.textContent).toContain("truncates.");
    expect(slot.container.querySelector(".wt-a")).toBe(answer);
    current = walkthrough({ parts: [part("Schema", { discussion: [exchange("Because the cap truncates.", "done")] })], inFlight: null });
    await act(() => slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "changed" }));
    await vi.waitFor(() => expect(slot.container.querySelector(".wt-a")!.className).not.toContain("wt-streaming"));
    expect(slot.container.querySelector(".wt-a")).toBe(answer);
  });
});

describe("reduced motion", () => {
  it("stops every streaming animation through the stylesheet's reduced-motion rule", () => {
    const css = readFileSync("app.css", "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.wt \*(?::not\([^)]*\))?, \.wt \*::before, \.wt \*::after \{ animation: none !important/u);
    expect(css).toContain(".wt-figure[data-streaming]");
  });
});
