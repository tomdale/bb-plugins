// @vitest-environment jsdom
// Review-state clarity: the label, the muted look, the review count and the
// Review draft tab all follow the same included comments.
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergedReviewDraft } from "../src/model.ts";
import { mountPage, mounted, note, part, stubWidth, walkthrough } from "./helpers.tsx";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.unstubAllGlobals();
});

const pr = () => walkthrough({ mode: "pr", intent: "review", pr: { number: 2, url: "https://github.com/o/r/pull/2", title: "T" }, parts: [part("Schema")] });
const comment = (id: string, text: string, line: number, extra: Record<string, unknown> = {}) => note({ id, kind: "comment", text, location: { path: "src/a.ts", startLine: line }, createdAt: line, ...extra });

describe("an excluded comment", () => {
  it("says so, recedes, and leaves the count and the Review draft tab in step with the checkbox", async () => {
    stubWidth(480);
    const w = pr();
    let notes = [comment("n1", "First", 3), comment("n2", "Second", 5)];
    const rpc = {
      get: () => ({ view: { walkthrough: w, notes, reviewDraft: mergedReviewDraft(w, notes) } }),
      updateNote: (input: { noteId: string; includeInReview: boolean }) => {
        notes = notes.map((candidate) => (candidate.id === input.noteId ? { ...candidate, includeInReview: input.includeInReview } : candidate));
        return { ok: true };
      },
    };
    const slot = await mountPage("wt_1", rpc);
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    const item = (id: string) => slot.container.querySelector<HTMLElement>(`[data-note-id="${id}"]`)!;
    const state = () => ({
      label: item("n2").querySelector(".wt-include")!.textContent,
      muted: item("n2").classList.contains("wt-it-excluded"),
      count: slot.getByTestId("wt-review-count").textContent,
      tab: slot.getByRole("tab", { name: /Review draft/u }).textContent,
    });
    expect(state()).toEqual({ label: "In review", muted: false, count: "2 in the review", tab: "Review draft · 2" });

    fireEvent.click(item("n2").querySelector('[role="checkbox"]')!);
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "updateNote")?.input).toMatchObject({ noteId: "n2", includeInReview: false }));
    await slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "changed" });
    await waitFor(() => expect(state().label).toBe("Not in review"));
    expect(state()).toEqual({ label: "Not in review", muted: true, count: "1 in the review", tab: "Review draft · 1" });
    expect(item("n1").classList.contains("wt-it-excluded")).toBe(false);
  });
});

describe("Save notes", () => {
  for (const intent of ["review", "own-change", "understand"] as const) {
    it(`is offered in a ${intent} wrap-up and saves the open notes`, async () => {
      stubWidth(480);
      const w = walkthrough({ status: "wrapping-up", intent, mode: intent === "review" ? "pr" : "local", pr: intent === "review" ? { number: 2, url: "https://github.com/o/r/pull/2", title: "T" } : null, currentPart: 0, parts: [part("Schema")], wrapUp: part("W", { blocks: [{ kind: "prose", text: "Done here." }] }) });
      const notes = [note({ id: "n1", kind: "note", text: "Remember this" })];
      const slot = await mountPage("wt_1", {
        get: () => ({ view: { walkthrough: w, notes, reviewDraft: mergedReviewDraft(w, notes) } }),
        saveNotes: () => ({ threadId: "thr_1", path: "walkthrough-notes/x.md", absolutePath: "/s/walkthrough-notes/x.md", notes: 1 }),
      });
      await slot.findByText("Done here.");
      const button = slot.getByRole("button", { name: "Save notes" }) as HTMLButtonElement;
      expect(button.closest(".wt-pager")).not.toBeNull();
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "saveNotes")).toBe(true));
      await waitFor(() => expect(slot.getByRole("button", { name: "Saved" })).toBeTruthy());
    });
  }
});

describe("the narrow pager", () => {
  it("shows the next part's name whole or not at all, and never cuts it with an ellipsis", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/ui/ux.css", import.meta.url), "utf8");
    const rule = (selector: string) => css.split("\n").find((line) => line.startsWith(selector))!;
    // The label wraps onto a line it clips, so a name that does not fit beside "Next" is hidden entirely.
    expect(rule(".wt .wt-next-label {")).toMatch(/flex-wrap: wrap/u);
    expect(rule(".wt .wt-next-label {")).toMatch(/overflow: hidden/u);
    expect(rule(".wt .wt-next-title {")).not.toMatch(/text-overflow/u);
    expect(rule(".wt .wt-next-title {")).toMatch(/white-space: nowrap/u);
  });
});
