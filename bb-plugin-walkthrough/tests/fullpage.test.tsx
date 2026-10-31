// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { walkthroughIdFromSubPath } from "../src/ui/FullPage.tsx";
import { mountPage, mountPanel, mounted, openMenu, part, stubWidth, viewOf, walkthrough } from "./helpers.tsx";

beforeEach(() => {
  stubWidth(480);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
});

describe("full page", () => {
  it("reads the walkthrough id from the nav panel's sub-path", () => {
    expect(walkthroughIdFromSubPath("")).toBeNull();
    expect(walkthroughIdFromSubPath("wt_1")).toBe("wt_1");
    expect(walkthroughIdFromSubPath("/wt_1/")).toBe("wt_1");
  });

  it("expands the panel's walkthrough into the full page from the overflow menu", async () => {
    const slot = await mountPanel({ walkthroughId: "wt_1" }, viewOf(walkthrough()));
    openMenu(await slot.findByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Open as full page" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "walkthroughs", options: { subPath: "wt_1" } });
  });

  it("shows the walkthrough on its own page, with a way back to its thread", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough()));
    await slot.findByText("The schema comes first.");
    expect(slot.container.querySelector(".wt-surface-page")).not.toBeNull();
    expect(slot.inspection.rpcCalls.map((call) => call.input)).toContainEqual({ walkthroughId: "wt_1" });
    openMenu(slot.getByRole("button", { name: "More" }));
    expect(slot.queryByRole("menuitem", { name: "Open as full page" })).toBeNull();
    fireEvent.click(await slot.findByRole("menuitem", { name: "Back to thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_1" }]);
  });

  it("says when the walkthrough no longer exists", async () => {
    const slot = await mountPage("wt_gone", { get: () => ({ view: null }) });
    await slot.findByText("This walkthrough no longer exists.");
  });

  it("shows a skeleton in the page's layout while the walkthrough loads", async () => {
    const slot = await mountPage("wt_1", { get: () => new Promise(() => {}) });
    expect(slot.getByRole("status", { name: "Opening the walkthrough…" })).toBeTruthy();
    expect(slot.container.querySelector(".wt-page")).not.toBeNull();
  });

  it("lists recent walkthroughs at the root and opens one as a page", async () => {
    const summary = { id: "wt_1", title: "Branch feature", request: "r", status: "reading", partCount: 3, currentPart: 0, openNotes: 0, createdAt: 1 };
    const slot = await mountPage("", { recent: () => ({ walkthroughs: [summary, { ...summary, id: "wt_2", title: "Walkthrough", request: "The PR", status: "done" }] }) });
    await slot.findByText(/In progress · Part 1 of 3/u);
    expect(slot.queryByText("reading")).toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: /The PR/ }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "walkthroughs", options: { subPath: "wt_2" } }]);
  });
});

describe("header and subject", () => {
  it("links a PR walkthrough to its pull request under GitHub's title, on the introduction", async () => {
    const w = walkthrough({ currentPart: null, mode: "pr", baseRef: "c884aad (PR base on main)", pr: { number: 2, url: "https://github.com/o/r/pull/2", title: "The real PR title" } });
    const slot = await mountPage("wt_1", viewOf(w));
    const link = await slot.findByRole("link", { name: "#2 The real PR title" });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/2");
    expect(slot.queryByText(/PR base on main/u)).toBeNull();
  });

  it("names the start of history instead of the empty tree", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ currentPart: null, baseRef: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" })));
    await slot.findByText(/everything since the start of history/u);
  });

  it("asks before finishing, and finishing is only in the overflow menu", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(walkthrough()), close: () => ({ ok: true }) });
    await slot.findByText("The schema comes first.");
    expect(slot.queryByRole("button", { name: /Finish/u })).toBeNull();
    openMenu(slot.getByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Finish walkthrough" }));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "close")).toEqual([]);
    fireEvent.click(await slot.findByRole("button", { name: "Finish walkthrough" }));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "close")).toHaveLength(1);
  });
});

describe("out-of-date parts", () => {
  it("offers a rewrite when the code changed after the part was written", async () => {
    const stale = walkthrough({ codeFingerprint: "new", parts: [part("Schema", { writtenAgainst: "old", staleFiles: ["src/schema.ts"] })] });
    const slot = await mountPage("wt_1", { ...viewOf(stale), retry: () => ({ ok: true }) });
    await slot.findByText(/schema\.ts changed after this part was written/u);
    fireEvent.click(slot.getByRole("button", { name: "Rewrite this part" }));
    expect(slot.inspection.rpcCalls.at(-1)?.input).toEqual({ walkthroughId: "wt_1", place: 0 });
  });

  it("stays quiet when the change moved but not in files this part cites", async () => {
    const elsewhere = walkthrough({ codeFingerprint: "new", parts: [part("Schema", { writtenAgainst: "old", staleFiles: [], blocks: [{ kind: "prose", text: "The schema comes first." }] })] });
    const slot = await mountPage("wt_1", viewOf(elsewhere));
    await slot.findByText("The schema comes first.");
    expect(slot.queryByText(/changed after/u)).toBeNull();
    expect(slot.queryByRole("button", { name: "Rewrite this part" })).toBeNull();
  });

  it("falls back to the whole-change fingerprint for parts that do not say which files changed", async () => {
    const legacy = walkthrough({ codeFingerprint: "new", parts: [part("Schema", { writtenAgainst: "old" })] });
    const w = { ...legacy, parts: legacy.parts.map((entry) => { const { staleFiles: _drop, ...rest } = entry as typeof entry & { staleFiles?: string[] }; return rest as typeof entry; }) };
    const slot = await mountPage("wt_1", viewOf(w));
    await slot.findByText(/The code changed after this part was written/u);
  });

  it("stays quiet when the part matches the code", async () => {
    const fresh = walkthrough({ codeFingerprint: "same", parts: [part("Schema", { writtenAgainst: "same", blocks: [{ kind: "prose", text: "The schema comes first." }] })] });
    const slot = await mountPage("wt_1", viewOf(fresh));
    await slot.findByText("The schema comes first.");
    expect(slot.queryByText(/code changed after/u)).toBeNull();
  });
});
