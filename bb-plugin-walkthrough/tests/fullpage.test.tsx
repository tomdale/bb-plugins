// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Walkthrough } from "../src/schemas.ts";
import { walkthroughIdFromSubPath } from "../src/ui/FullPage.tsx";

const PLUGIN_ID = "walkthrough";

function walkthrough(overrides: Partial<Walkthrough> = {}): Walkthrough {
  return {
    id: "wt_1",
    threadId: "thr_1",
    workerThreadId: "thr_w",
    request: "Walk me through it",
    status: "reading",
    message: null,
    title: "Branch feature",
    mode: "local",
    baseRef: "origin/main",
    includeUncommitted: true,
    pr: null,
    introduction: "",
    parts: [
      {
        title: "Schema",
        summary: "",
        locations: [],
        status: "ready",
        blocks: [{ kind: "prose", text: "The schema comes first." }],
        suggestions: [],
        message: null,
        discussion: [],
      },
    ],
    currentPart: 0,
    wrapUp: null,
    environmentId: "env_1",
    hostId: "host_1",
    workspacePath: "/w",
    notesFile: { enabled: false, path: null, written: false, error: null },
    review: null,
    queue: [],
    inFlight: null,
    nextNoteNumber: 1,
    nextExchangeNumber: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const mounted: Array<{ lifecycle: { unmount: () => void } }> = [];
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  vi.unstubAllGlobals();
});

async function mountPanel() {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: { walkthroughId: "wt_1" } }, {
    pluginId: PLUGIN_ID,
    rpc: { get: () => ({ view: { walkthrough: walkthrough(), notes: [] } }) },
  });
  mounted.push(slot);
  return slot;
}

async function mountPage(subPath: string, rpc: Record<string, () => unknown>) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const registration = app.navPanels.find((panel) => panel.path === "walkthroughs")!;
  const slot = renderSlot(registration, { subPath }, { pluginId: PLUGIN_ID, rpc: rpc as never });
  mounted.push(slot);
  return slot;
}

describe("full page", () => {
  it("reads the walkthrough id from the nav panel's sub-path", () => {
    expect(walkthroughIdFromSubPath("")).toBeNull();
    expect(walkthroughIdFromSubPath("wt_1")).toBe("wt_1");
    expect(walkthroughIdFromSubPath("/wt_1/")).toBe("wt_1");
  });

  it("expands the panel's walkthrough into the full page", async () => {
    const slot = await mountPanel();
    fireEvent.click(await slot.findByRole("button", { name: "Open as a full page" }));
    // The panel first retitles its own tab; the click then navigates.
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "walkthroughs", options: { subPath: "wt_1" } });
  });

  it("shows the walkthrough on its own page, with a way back to its thread", async () => {
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: walkthrough(), notes: [] } }) });
    await slot.findByText("The schema comes first.");
    expect(slot.queryByRole("button", { name: "Open as a full page" })).toBeNull();
    expect(slot.inspection.rpcCalls.map((call) => call.input)).toContainEqual({ walkthroughId: "wt_1" });
    expect(slot.inspection.navigateCalls).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_1" }]);
  });

  it("says when the walkthrough no longer exists", async () => {
    const slot = await mountPage("wt_gone", { get: () => ({ view: null }) });
    await slot.findByText("This walkthrough no longer exists.");
  });

  it("lists recent walkthroughs at the root and opens one as a page", async () => {
    const summary = { id: "wt_1", title: "Branch feature", request: "r", status: "reading", partCount: 3, currentPart: 0, openNotes: 0, createdAt: 1 };
    const slot = await mountPage("", { recent: () => ({ walkthroughs: [summary, { ...summary, id: "wt_2", title: "Walkthrough", request: "The PR", status: "done" }] }) });
    // Raw statuses become words, with progress.
    await slot.findByText(/In progress · Part 1 of 3/u);
    expect(slot.queryByText("reading")).toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: /The PR/ }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "walkthroughs", options: { subPath: "wt_2" } }]);
  });
});

describe("wrap-up", () => {
  const part = (title: string) => ({
    title,
    summary: "",
    locations: [],
    status: "ready" as const,
    blocks: [{ kind: "prose" as const, text: `${title} prose.` }],
    suggestions: [],
    message: null,
    discussion: [],
  });
  const wrapped = walkthrough({
    status: "wrapping-up",
    currentPart: 1,
    parts: [part("Schema"), part("Store")],
    wrapUp: { ...part("Wrapping up"), blocks: [{ kind: "prose", text: "That is the change." }] },
  });

  it("lets the reader go back to the parts and return to the wrap-up", async () => {
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: wrapped, notes: [] } }), openPart: () => ({ ok: true }) });
    await slot.findByText("That is the change.");
    fireEvent.click(slot.getByRole("button", { name: "Back to the parts" }));
    await slot.findByText("Store prose.");
    expect(slot.queryByText("That is the change.")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Back to wrap-up/u }));
    await slot.findByText("That is the change.");
  });
});

describe("header", () => {
  const view = (overrides: Partial<Walkthrough>) => ({ get: () => ({ view: { walkthrough: walkthrough(overrides), notes: [] } }), close: () => ({ ok: true }) });

  it("links a PR walkthrough to its pull request under GitHub's title", async () => {
    const slot = await mountPage("wt_1", view({ mode: "pr", baseRef: "c884aad (PR base on main)", pr: { number: 2, url: "https://github.com/o/r/pull/2", title: "The real PR title" } }));
    const link = await slot.findByRole("link", { name: "#2 The real PR title" });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/2");
    expect(slot.queryByText(/PR base on main/u)).toBeNull();
  });

  it("names the start of history instead of the empty tree", async () => {
    const slot = await mountPage("wt_1", view({ baseRef: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" }));
    await slot.findByText(/everything since the start of history/u);
  });

  it("asks before finishing a walkthrough that is still being read", async () => {
    const slot = await mountPage("wt_1", view({}));
    expect(slot.queryByRole("button", { name: "Close this walkthrough" })).toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Finish this walkthrough" }));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "close")).toEqual([]);
    fireEvent.click(await slot.findByRole("button", { name: "Finish walkthrough" }));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "close")).toHaveLength(1);
  });
});

describe("code excerpts", () => {
  const codePart = {
    title: "Schema",
    summary: "",
    locations: [],
    status: "ready" as const,
    blocks: [{ kind: "code" as const, caption: "The schema", path: "src/a.ts", startLine: 3, endLine: 9, notes: [] }],
    suggestions: [],
    message: null,
    discussion: [],
  };
  const context = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -3,2 +3,2 @@", " one", " two", ""].join("\n");

  it("opens unchanged code as after and carries its location for notes", async () => {
    const slot = await mountPage("wt_1", {
      get: () => ({ view: { walkthrough: walkthrough({ parts: [codePart] }), notes: [] } }),
      excerpt: () => ({ outcome: "available", path: "src/a.ts", change: context, after: context, before: context }),
    });
    const after = await slot.findByRole("button", { name: "after" });
    await vi.waitFor(() => expect(after.getAttribute("aria-pressed")).toBe("true"));
    expect(slot.getByRole("button", { name: "change" }).getAttribute("aria-pressed")).toBe("false");
    const figure = slot.container.querySelector("figure")!;
    expect([figure.dataset.codePath, figure.dataset.codeStart, figure.dataset.codeEnd]).toEqual(["src/a.ts", "3", "9"]);
    expect(slot.getByRole("region", { name: /src\/a\.ts, lines 3 to 9/u })).toBeTruthy();
  });
});

describe("notes drawer", () => {
  it("is a labelled region that Escape closes, with focus returned to its button", async () => {
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: walkthrough(), notes: [] } }) });
    const toggle = await slot.findByRole("button", { name: /Notes/u });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const drawer = await slot.findByRole("complementary", { name: "Notes" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(slot.queryByRole("complementary", { name: "Notes" })).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes from the scrim when it overlays a narrow page", async () => {
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: walkthrough(), notes: [] } }) });
    fireEvent.click(await slot.findByRole("button", { name: /Notes/u }));
    await slot.findByRole("complementary", { name: "Notes" });
    fireEvent.click(slot.container.querySelector("[data-drawer-scrim]")!);
    expect(slot.queryByRole("complementary", { name: "Notes" })).toBeNull();
  });
});

describe("note composer", () => {
  it("starts the next note with no file after saving one anchored to a file", async () => {
    const codePart = {
      title: "Schema",
      summary: "",
      locations: [{ path: "src/other.ts" }],
      status: "ready" as const,
      blocks: [{ kind: "code" as const, caption: "The schema", path: "src/a.ts", startLine: 3, endLine: 9, notes: [] }],
      suggestions: [],
      message: null,
      discussion: [],
    };
    const note = { id: "n1", walkthroughId: "wt_1", kind: "question", text: "x", groupIndex: 0, location: null, quote: null, status: "open", resolution: null, author: "user", createdAt: 0, updatedAt: 0 };
    const slot = await mountPage("wt_1", {
      get: () => ({ view: { walkthrough: walkthrough({ parts: [codePart] }), notes: [] } }),
      excerpt: () => ({ outcome: "unavailable", message: "n/a" }),
      addNote: () => note,
    });
    fireEvent.click(await slot.findByRole("button", { name: /Notes/u }));
    const file = (await slot.findByRole("combobox", { name: "File" })) as HTMLSelectElement;
    // The part's code excerpts come first.
    expect(Array.from(file.options).map((option) => option.textContent)).toEqual(["No file", "src/a.ts:3-9", "src/other.ts"]);
    const record = async (text: string) => {
      fireEvent.change(slot.getByRole("textbox", { name: "Note text" }), { target: { value: text } });
      fireEvent.click(slot.getByRole("button", { name: "Record" }));
      await vi.waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "addNote")).toHaveLength(text === "first" ? 1 : 2));
    };
    fireEvent.change(file, { target: { value: "0" } });
    expect((slot.getByRole("textbox", { name: "Lines" }) as HTMLInputElement).value).toBe("3-9");
    await record("first");
    await vi.waitFor(() => expect((slot.getByRole("combobox", { name: "File" }) as HTMLSelectElement).value).toBe("-1"));
    await record("second");
    const inputs = slot.inspection.rpcCalls.filter((call) => call.method === "addNote").map((call) => call.input as { location: unknown });
    expect(inputs.map((input) => input.location)).toEqual([{ path: "src/a.ts", startLine: 3, endLine: 9 }, null]);
  });
});

describe("review drawer", () => {
  it("says where a post goes and how to change the draft", async () => {
    const review = { body: "Looks good.", event: "COMMENT" as const, comments: [], status: "draft" as const, url: null, updatedAt: 0 };
    const pr = { number: 2, url: "https://github.com/o/r/pull/2", title: "The real PR title" };
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: walkthrough({ mode: "pr", pr, review }), notes: [] } }) });
    fireEvent.click(await slot.findByRole("button", { name: "Review" }));
    await slot.findByText(/ask in the walkthrough/u);
    fireEvent.click(await slot.findByRole("button", { name: /Post…/u }));
    await slot.findByText("This posts publicly to GitHub as your gh account.");
    expect((await slot.findByRole("link", { name: "o/r#2" })).getAttribute("href")).toBe(pr.url);
  });
});

describe("out-of-date parts", () => {
  it("offers a rewrite when the code changed after the part was written", async () => {
    const base = walkthrough();
    const stale = walkthrough({ codeFingerprint: "new", parts: [{ ...base.parts[0]!, writtenAgainst: "old" }] });
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: stale, notes: [] } }), retry: () => ({ ok: true }) });
    await slot.findByText(/code changed after this part was written/u);
    fireEvent.click(slot.getByRole("button", { name: "Rewrite this part" }));
    expect(slot.inspection.rpcCalls.at(-1)?.input).toEqual({ walkthroughId: "wt_1", place: 0 });
  });

  it("stays quiet when the part matches the code", async () => {
    const base = walkthrough();
    const fresh = walkthrough({ codeFingerprint: "same", parts: [{ ...base.parts[0]!, writtenAgainst: "same" }] });
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: fresh, notes: [] } }) });
    await slot.findByText("The schema comes first.");
    expect(slot.queryByText(/code changed after/u)).toBeNull();
  });
});
