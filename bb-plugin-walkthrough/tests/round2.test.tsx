// @vitest-environment jsdom
// Round two, in the pane: the starter leads to a running walkthrough, the thread's opener, one send flow, and the small honesty fixes.
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { mountPage, mountPanel, mounted, note, part, PLUGIN_ID, stubWidth, viewOf, walkthrough } from "./helpers.tsx";
import { STREAM_CHANNEL } from "../src/schemas.ts";

beforeEach(() => {
  stubWidth(480);
  // Each test is a fresh client: nothing has been opened yet.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key), clear: () => store.clear() });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
});

const HOUR = 60 * 60 * 1000;
const summary = (overrides: Record<string, unknown> = {}) => ({ id: "wt_live", title: "How p-limit works", request: "r", status: "reading", partCount: 4, currentPart: 1, openNotes: 0, createdAt: Date.now() - 5 * 60_000, updatedAt: Date.now() - 60_000, ...overrides });

describe("the starter leads to a walkthrough that is running", () => {
  it("puts a Continue card first and never says 'No changes found' as the headline", async () => {
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [summary()] }), detectTarget: () => ({ target: null }), ...viewOf(walkthrough({ id: "wt_live" })) });
    const card = await slot.findByRole("region", { name: "Continue" });
    expect(card.textContent).toContain("How p-limit works");
    expect(card.textContent).toContain("In progress");
    expect(card.textContent).toContain("Part 2 of 4");
    expect(slot.queryByText("No changes found")).toBeNull();
    // The card comes before the start form.
    const page = slot.container.querySelector(".wt-page")!;
    expect(page.firstElementChild).toBe(card);
    expect(slot.container.textContent).toContain("Start another walkthrough");
    fireEvent.click(slot.getByRole("button", { name: "Continue" }));
    await slot.findByText("The schema comes first.");
    expect(slot.inspection.navigateCalls.some((call) => call.method === "openThreadPanel")).toBe(false);
  });

  it("still speaks up about an empty tree when nothing is running", async () => {
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [] }), detectTarget: () => ({ target: null }) });
    await slot.findByText("No changes found");
    expect(slot.queryByRole("region", { name: "Continue" })).toBeNull();
    expect(slot.container.querySelector(".wt-pn")).toBeNull();
  });

  const done = summary({ status: "done", currentPart: 3 });
  it("offers a recently finished walkthrough", async () => {
    const recent = await mountPanel({}, { list: () => ({ walkthroughs: [done] }), detectTarget: () => ({ target: null }) });
    expect((await recent.findByRole("region", { name: "Continue" })).textContent).toContain("Finished");
    expect(recent.getByRole("button", { name: "Open it" })).toBeTruthy();
  });

  it("does not offer one from last week", async () => {
    const old = await mountPanel({}, { list: () => ({ walkthroughs: [{ ...done, createdAt: Date.now() - 9 * 24 * HOUR, updatedAt: Date.now() - 8 * 24 * HOUR }] }), detectTarget: () => ({ target: null }) });
    await old.findByText("Earlier walkthroughs");
    expect(old.queryByRole("region", { name: "Continue" })).toBeNull();
  });

  it("does not list the walkthrough twice", async () => {
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [summary(), summary({ id: "wt_old", title: "Older", status: "done", createdAt: 1, updatedAt: 1 })] }), detectTarget: () => ({ target: null }) });
    await slot.findByRole("region", { name: "Continue" });
    const earlier = slot.getByRole("region", { name: "Earlier walkthroughs" });
    expect(earlier.textContent).toContain("Older");
    expect(earlier.textContent).not.toContain("How p-limit works");
  });

  it("shows what was found when there are changes, with its counts", async () => {
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [summary()] }), detectTarget: () => ({ target: { kind: "uncommitted", files: 3, additions: 9, deletions: 1, staged: 1, unstaged: 2, untracked: 0 } }) });
    await slot.findByText(/Uncommitted changes · 3 files/u);
  });
});

describe("the thread's automatic opener", () => {
  // What the host answers when asked to open a tab: false when the thread has no side panel.
  let accepted = true;
  beforeEach(() => {
    accepted = true;
  });
  const mountOpener = async (walkthroughs: unknown[], settings: Record<string, unknown> = {}) => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_1", projectId: "p", isCompactViewport: false }, { pluginId: PLUGIN_ID, rpc: { list: () => ({ walkthroughs }) } as never, settings: settings as never, openThreadPanel: () => accepted } as never);
    mounted.push(slot as never);
    return slot;
  };
  const opened = (slot: Awaited<ReturnType<typeof mountOpener>>) => slot.inspection.navigateCalls.filter((call) => call.method === "openThreadPanel");

  it("opens a live walkthrough as soon as a client views the thread, once", async () => {
    const slot = await mountOpener([summary({ title: "Walkthrough", request: "How p-limit works" })]);
    await waitFor(() => expect(opened(slot).length).toBeGreaterThan(0));
    expect(opened(slot)[0]!.options).toMatchObject({ actionId: "walkthrough", title: "Walkthrough", params: { walkthroughId: "wt_live" } });
    // A later change to the same list does not open it again.
    await act(() => slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_live", reason: "changed" }));
    expect(opened(slot)).toHaveLength(1);
    // Nor does another mount in this client (a reload, or a second pane).
    const again = await mountOpener([summary()]);
    await settle();
    expect(opened(again)).toHaveLength(0);
  });

  it("tries again later when the thread has no side panel to open it in", async () => {
    accepted = false;
    const slot = await mountOpener([summary()]);
    await waitFor(() => expect(opened(slot).length).toBeGreaterThan(0));
    const before = opened(slot).length;
    accepted = true;
    await act(() => slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_live", reason: "changed" }));
    await waitFor(() => expect(opened(slot).length).toBeGreaterThan(before));
    const total = opened(slot).length;
    await act(() => slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_live", reason: "changed" }));
    await settle();
    expect(opened(slot)).toHaveLength(total);
  });

  it("gives the tab the walkthrough's name once it has one", async () => {
    const slot = await mountOpener([summary({ title: "TTL cache" })]);
    await waitFor(() => expect(opened(slot)[0]?.options).toMatchObject({ title: "Walkthrough: TTL cache" }));
  });

  it("leaves finished and long-abandoned walkthroughs alone, and honors the setting", async () => {
    const finished = await mountOpener([summary({ status: "done" })]);
    const abandoned = await mountOpener([summary({ id: "wt_old", createdAt: Date.now() - 30 * HOUR, updatedAt: Date.now() - 20 * HOUR })]);
    const off = await mountOpener([summary({ id: "wt_off" })], { autoOpenPanel: false });
    await settle();
    expect(opened(finished)).toHaveLength(0);
    expect(opened(abandoned)).toHaveLength(0);
    expect(opened(off)).toHaveLength(0);
  });
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

describe("one flow to send open items", () => {
  const wrapped = (extra: Record<string, unknown> = {}) =>
    walkthrough({ status: "wrapping-up", currentPart: 0, parts: [part("Schema")], wrapUp: part("Wrapping up", { blocks: [{ kind: "prose", text: "That is the change." }] }), ...extra });
  const rpc = { prepareHandOff: () => ({ draft: { message: "From my walkthrough.\n\n- your todo (a): \"Check\"", noteIds: ["n1"] } }), handOff: () => ({ sent: true }) };
  const todo = note({ id: "n1", kind: "todo", text: "Check" });

  it("shows one send button on the wrap-up: the pinned one, with the sheet open too", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(wrapped(), [todo]), ...rpc });
    await slot.findByText("That is the change.");
    fireEvent.click(slot.getByRole("button", { name: /Concerns/u }));
    expect(slot.getAllByRole("button", { name: "Send open items to thread" })).toHaveLength(1);
    expect(slot.container.querySelector(".wt-sheet-foot")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Send open items to thread" }));
    const field = (await slot.findByRole("textbox", { name: "Message to your thread" })) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toContain("your todo (a)"));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "handOff")).toBe(false);
  });

  it("keeps the sheet's button on a page that has no pinned one, and previews there too", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(walkthrough({ parts: [part("Schema")] }), [todo]), ...rpc });
    await slot.findByText("Schema prose.");
    fireEvent.click(slot.getByRole("button", { name: /Concerns/u }));
    fireEvent.click(slot.getByRole("button", { name: "Send open items to thread" }));
    await slot.findByRole("textbox", { name: "Message to your thread" });
    fireEvent.click(await slot.findByRole("button", { name: "Send to thread" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "handOff")?.input).toEqual({ walkthroughId: "wt_1", message: expect.stringContaining("your todo (a)"), noteIds: ["n1"] }));
    await slot.findByText("Sent to your thread");
  });
});

describe("saved notes", () => {
  const wrapped = () =>
    walkthrough({ intent: "understand", status: "wrapping-up", currentPart: 0, parts: [part("Schema")], wrapUp: part("Wrapping up", { blocks: [{ kind: "prose", text: "That is the change." }] }) });
  const saved = { threadId: "thr_1", path: "walkthrough-notes/how-p-limit-works-1.md", absolutePath: "/s/x.md", notes: 1 };

  it("says where they went in plain words, links the file, and settles to Saved until the notes change", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(wrapped(), [note({ id: "n1", kind: "note", text: "Hm", updatedAt: 1 })]), saveNotes: () => saved });
    await slot.findByText("That is the change.");
    fireEvent.click(slot.getByRole("button", { name: "Save notes" }));
    const where = await waitFor(() => {
      const element = slot.container.querySelector(".wt-saved");
      if (!element) throw new Error("not yet");
      return element;
    });
    expect(where.textContent).toBe("Saved to this thread\u2019s storage: how-p-limit-works-1.md");
    fireEvent.click(slot.getByRole("link", { name: "how-p-limit-works-1.md" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "experimental_openFilePreview", options: { target: { kind: "thread-storage", threadId: "thr_1", path: saved.path } } });
    const button = slot.getByRole("button", { name: "Saved" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).not.toContain("wt-btn-primary");
  });

  it("has nothing to save when no note is open", async () => {
    const slot = await mountPage("wt_1", viewOf(wrapped(), []));
    await slot.findByText("That is the change.");
    expect((slot.getByRole("button", { name: "Save notes" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Comment on a local diff", () => {
  const selectProse = async (slot: Awaited<ReturnType<typeof mountPage>>) => {
    (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({ top: 400, bottom: 420, left: 40, right: 80, width: 40, height: 20, x: 40, y: 400, toJSON() {} }) as DOMRect;
    const paragraph = (await slot.findByText("The schema comes first.")).firstChild!;
    const range = document.createRange();
    range.setStart(paragraph, 4);
    range.setEnd(paragraph, 10);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(paragraph.parentElement!);
    return slot.findByRole("toolbar");
  };

  it("is shown disabled, can be focused, and says why", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough()));
    const toolbar = await selectProse(slot);
    const comment = Array.from(toolbar.querySelectorAll("button")).find((button) => button.textContent === "Comment")!;
    expect(comment.getAttribute("aria-disabled")).toBe("true");
    // It stays a focusable, hoverable control (a disabled button gets no pointer events, so it could not say why).
    act(() => comment.focus());
    expect(document.activeElement).toBe(comment);
    fireEvent.pointerMove(comment, { pointerType: "mouse" });
    await waitFor(() => expect(within(document.body).getAllByText("Comments are for pull requests").length).toBeGreaterThan(0), { timeout: 2000 });
    // Pressing it does nothing.
    fireEvent.click(comment);
    expect(slot.queryByRole("dialog", { name: "New comment" })).toBeNull();
  });

  it("is a working option on a pull request", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ mode: "pr", pr: { number: 2, url: "https://github.com/o/r/pull/2", title: "T" } })));
    const toolbar = await selectProse(slot);
    const comment = Array.from(toolbar.querySelectorAll("button")).find((button) => button.textContent === "Comment")!;
    expect(comment.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(comment);
    await slot.findByRole("dialog", { name: "New comment" });
  });
});

describe("an overview's files read", () => {
  const cited = (path: string) => ({ kind: "code" as const, caption: "c", path, startLine: 1, endLine: 5, notes: [], view: "code" as const, snapshot: null, snapshotError: null });

  const parts = () => [part("Queue", { blocks: [cited("index.js"), cited("lib/queue.js")] })];
  const wrapUp = () => part("Wrapping up", { blocks: [{ kind: "prose", text: "That is how it works." }] });

  it("lists the files its figures cite on the wrap-up", async () => {
    const overview = await mountPage("wt_1", viewOf(walkthrough({ intent: "understand", status: "wrapping-up", parts: parts(), wrapUp: wrapUp(), workspacePath: "/w" })));
    await overview.findByText("That is how it works.");
    const strip = overview.getByRole("region", { name: "Files read" });
    expect(strip.textContent).toContain("2 files cited in figures");
    expect(Array.from(strip.querySelectorAll("li")).map((item) => item.textContent)).toEqual(["index.js", "lib/queue.js"]);
  });

  it("is an overview's strip only: a change has its coverage instead", async () => {
    const change = await mountPage("wt_1", viewOf(walkthrough({ intent: "own-change", status: "wrapping-up", parts: parts(), wrapUp: wrapUp(), workspacePath: "/w" })));
    await change.findByText("That is how it works.");
    expect(change.queryByRole("region", { name: "Files read" })).toBeNull();
  });
});

describe("the pager", () => {
  it("keeps the word Next whole and names the page it leads to", async () => {
    const long = "Rejecting unsuccessful responses before they reach the cache";
    const slot = await mountPage("wt_1", viewOf(walkthrough({ currentPart: 0, parts: [part("Schema"), part(long)] })));
    const next = await slot.findByRole("button", { name: `Next: ${long}` });
    expect(next.querySelector(".wt-next-kicker")!.textContent).toBe("Next");
    expect(next.querySelector(".wt-next-title")!.textContent).toBe(long);
  });

  it("explains the composer in one calm line on the introduction and while a part is written", async () => {
    const intro = await mountPage("wt_1", viewOf(walkthrough({ currentPart: null, introduction: "Hello." })));
    expect(await intro.findByRole("textbox", { name: "Press Next, then ask about any part" })).toBeTruthy();
    const writing = await mountPage("wt_1", viewOf(walkthrough({ parts: [part("Schema", { status: "writing", blocks: [] })] })));
    expect(await writing.findByRole("textbox", { name: "You can ask as soon as this part is written" })).toBeTruthy();
  });
});

describe("the Concerns chip", () => {
  it("is yellow only while the sheet is open", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough(), [note({ id: "n1", kind: "todo" })]));
    const chip = await slot.findByRole("button", { name: /Concerns/u });
    expect(chip.hasAttribute("data-selected")).toBe(false);
    fireEvent.click(chip);
    expect(chip.getAttribute("data-selected")).toBe("true");
    fireEvent.click(chip);
    expect(chip.hasAttribute("data-selected")).toBe(false);
  });
});

describe("honest progress while the plan is written", () => {
  it("says how many steps the helper has taken while it looks through the code, without a forecast", async () => {
    const preparing = walkthrough({ status: "planning", currentPart: null, parts: [], introduction: "", inFlight: { request: { kind: "plan" }, sentAt: 1, afterSeq: 0 } });
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: preparing, notes: [], reviewDraft: null } }), streamSnapshot: () => ({ snapshot: null }) });
    await slot.findByRole("status", { name: /Reading the change/u });
    await act(() => slot.emitRealtime(STREAM_CHANNEL, { walkthroughId: "wt_1", requestKind: "plan", place: 0, seq: 3, text: "I'll read the diff first.", state: "streaming", steps: 4 }));
    await slot.findByText("Looking through the code \u00b7 4 steps so far");
    expect(slot.container.textContent).toContain("I'll read the diff first.");
  });

  it("calls a part that is queued behind another by what it is waiting for", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ currentPart: 1, parts: [part("Schema"), part("Store", { status: "pending", blocks: [], summary: "How rows are kept" })] })));
    await slot.findByRole("status", { name: "Waiting for the helper to reach this part" });
  });
});
