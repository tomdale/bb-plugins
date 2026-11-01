// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_CHANNEL, type StreamPayload } from "../src/schemas.ts";
import { LAG_MS } from "../src/ui/pace.ts";
import { hiddenFrom } from "../src/ui/stream.ts";
import { mountPage, mounted, part, stubWidth, walkthrough } from "./helpers.tsx";

let reduced = false;
beforeEach(() => {
  stubWidth(480);
  reduced = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const payload = (seq: number, text: string, extra: Partial<StreamPayload> = {}): StreamPayload => ({ walkthroughId: "wt_1", requestKind: "write", place: 0, seq, text, state: "streaming", ...extra });
const writing = () =>
  walkthrough({ parts: [part("Schema", { status: "writing", blocks: [], suggestions: [] })], currentPart: 0, inFlight: { request: { kind: "write", part: 0 }, sentAt: 10, afterSeq: 5 } });
const LUMP = `${"A sentence of the introduction that is long enough to count. ".repeat(12)}END`;

async function mountWriting(snapshot: unknown = null) {
  const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: writing(), notes: [] } }), streamSnapshot: () => ({ snapshot }) });
  await slot.findByRole("status", { name: "Writing this part…" });
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  return slot;
}
const shownLength = (slot: Awaited<ReturnType<typeof mountPage>>) => (slot.container.querySelector(".wt-page")!.textContent ?? "").split("A sentence").length - 1;

describe("the pane when the provider delivers text as one lump", () => {
  it("writes the lump out over about LAG_MS, always a prefix of the received text, and shows all of it at the end", async () => {
    const slot = await mountWriting();
    await act(() => slot.emitRealtime(STREAM_CHANNEL, payload(6, LUMP)));
    const seen: number[] = [shownLength(slot)];
    for (let elapsed = 0; elapsed < LAG_MS + 200; elapsed += 100) {
      await act(async () => void vi.advanceTimersByTime(100));
      seen.push(shownLength(slot));
    }
    expect(seen[0]).toBeLessThan(2);
    expect(seen.every((count, index) => index === 0 || count >= seen[index - 1]!)).toBe(true);
    expect(seen.some((count) => count > 2 && count < 12)).toBe(true);
    expect(slot.container.querySelector(".wt-page")!.textContent).toContain("END");
    expect(slot.container.querySelector(".wt-streaming")).not.toBeNull();
  });

  it("shows ordinary small steps at once", async () => {
    const slot = await mountWriting();
    await act(() => slot.emitRealtime(STREAM_CHANNEL, payload(6, "A sentence of ten words, give or take.")));
    expect(slot.container.querySelector(".wt-page")!.textContent).toContain("take.");
  });

  it("shows a lump at once for a reader who asked for reduced motion", async () => {
    reduced = true;
    const slot = await mountWriting();
    await act(() => slot.emitRealtime(STREAM_CHANNEL, payload(6, LUMP)));
    expect(slot.container.querySelector(".wt-page")!.textContent).toContain("END");
  });

  it("shows text that already existed when the pane opened, and a finished request, at once", async () => {
    const joined = await mountWriting(payload(7, LUMP));
    await act(async () => void (await Promise.resolve()));
    expect(joined.container.querySelector(".wt-page")!.textContent).toContain("END");

    const slot = await mountWriting();
    await act(() => slot.emitRealtime(STREAM_CHANNEL, payload(6, LUMP)));
    expect(slot.container.querySelector(".wt-page")!.textContent).not.toContain("END");
    await act(() => slot.emitRealtime(STREAM_CHANNEL, payload(6, LUMP, { state: "done" })));
    expect(slot.container.querySelector(".wt-page")!.textContent).toContain("END");
  });
});

describe("hiddenFrom", () => {
  it("is where part 1 starts in the plan turn, and never for other requests", () => {
    const text = "Intro.\n\n```walkthrough\npart: 1\n```\n\nPart one.";
    expect(hiddenFrom(payload(1, text, { requestKind: "plan" }))).toBe(text.indexOf("```walkthrough"));
    expect(hiddenFrom(payload(1, "Intro only.", { requestKind: "plan" }))).toBe(Number.POSITIVE_INFINITY);
    expect(hiddenFrom(payload(1, text))).toBe(Number.POSITIVE_INFINITY);
  });
});
