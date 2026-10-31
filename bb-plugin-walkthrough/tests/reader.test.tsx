// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePatchRows, rowIndexForLine } from "../src/ui/patch-lines.ts";
import { mountPage, mountPanel, mounted, note, pagedView, part, stubWidth, viewOf, walkthrough } from "./helpers.tsx";

beforeEach(() => {
  stubWidth(480);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
});

const patch = (lines: string[], start = 3) =>
  ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", `@@ -${start},${lines.length} +${start},${lines.length} @@`, ...lines, ""].join("\n");
const CODE = [" one", "+two added", "-two removed", " three"];
const code = (extra: Record<string, unknown> = {}, notes: unknown[] = []) => ({ kind: "code" as const, caption: "The schema", path: "src/a.ts", startLine: 3, endLine: 9, notes, ...extra });
const snapshot = { change: patch(CODE), after: patch([" one", " two added", " three"]), before: patch([" one", " two removed", " three"]), baseSha: "a", headSha: "b", capturedAt: 1 };
const codeWalkthrough = (block: Record<string, unknown>, extra: Record<string, unknown> = {}) => walkthrough({ parts: [part("Schema", { blocks: [block] })], ...extra });

describe("patch rows", () => {
  it("numbers rows from hunk headers and marks skipped lines between hunks", () => {
    const rows = parsePatchRows(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -3,2 +3,2 @@", " a", "-b", "+c", "@@ -20,1 +20,1 @@", " z"].join("\n"));
    expect(rows.map((row) => [row.kind, row.oldNo, row.newNo])).toEqual([["ctx", 3, 3], ["del", 4, null], ["add", null, 4], ["gap", null, null], ["ctx", 20, 20]]);
    expect(rowIndexForLine(rows, 4)).toBe(2);
    expect(rowIndexForLine(rows, 19)).toBe(4);
  });
});

describe("fonts", () => {
  it("bundles Newsreader into the page stylesheet with the system fallbacks", () => {
    const fonts = readFileSync("assets/newsreader.css", "utf8");
    expect(fonts).toContain('font-family:"Newsreader Variable"');
    expect(fonts).toContain("data:font/woff2;base64,");
    const css = readFileSync("app.css", "utf8");
    expect(css).toContain('@import "./assets/newsreader.css"');
    expect(css).toMatch(/--wt-serif:[^;]*"New York"[^;]*Georgia/u);
  });
});

describe("figures", () => {
  it("renders from the saved snapshot without asking git, with a Diff / After / Before switch", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }))));
    const group = await slot.findByRole("group", { name: "Show the code as" });
    expect(Array.from(group.querySelectorAll("button")).map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([["Diff", "true"], ["After", "false"], ["Before", "false"]]);
    expect(slot.container.querySelectorAll(".wt-row.wt-add")).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "After" }));
    expect(slot.container.querySelectorAll(".wt-row.wt-add, .wt-row.wt-del")).toHaveLength(0);
    expect(slot.container.textContent).toContain("two added");
    fireEvent.click(slot.getByRole("button", { name: "Before" }));
    expect(slot.container.textContent).toContain("two removed");
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "excerpt")).toEqual([]);
    const figure = slot.container.querySelector("figure")!;
    expect([figure.dataset.codePath, figure.dataset.codeStart, figure.dataset.codeEnd]).toEqual(["src/a.ts", "3", "9"]);
  });

  it("shows current code with no switch when the agent picked code", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ view: "code", snapshot }))));
    await slot.findByRole("region", { name: /src\/a\.ts, lines 3 to 9/u });
    expect(slot.queryByRole("group", { name: "Show the code as" })).toBeNull();
    expect(slot.container.textContent).toContain("two added");
    expect(slot.container.textContent).not.toContain("two removed");
  });

  it("falls back to the excerpt RPC for walkthroughs without a snapshot, opening unchanged code as After", async () => {
    const context = patch([" one", " two"]);
    const slot = await mountPage("wt_1", {
      ...viewOf(codeWalkthrough(code())),
      excerpt: () => ({ outcome: "available", path: "src/a.ts", change: context, after: context, before: context }),
    });
    const after = await slot.findByRole("button", { name: "After" });
    await waitFor(() => expect(after.getAttribute("aria-pressed")).toBe("true"));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "excerpt")).toHaveLength(1);
  });

  it("says one muted line when the code is gone and never shows a git error", async () => {
    const slot = await mountPage("wt_1", {
      ...viewOf(codeWalkthrough(code())),
      excerpt: () => ({ outcome: "unavailable", message: "fatal: bad object deadbeef" }),
    });
    await slot.findByText("No saved copy of this code");
    expect(slot.queryByText(/fatal/u)).toBeNull();
    // Nothing to switch or copy, and no margin to hang notes in.
    expect(slot.queryByRole("group", { name: "Show the code as" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Copy the code" })).toBeNull();
  });

  it("numbers margin notes in the gutter and lights the line and note together on hover", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }, [{ line: 4, text: "Count checks reject invented ids." }]))));
    const marker = await slot.findByRole("button", { name: /Note 1: Count checks/u });
    expect(marker.closest(".wt-row")!.className).toContain("wt-add");
    fireEvent.mouseEnter(marker);
    expect(marker.closest(".wt-row")!.className).toContain("wt-hot");
    expect(slot.container.querySelector(".wt-mn")!.className).toContain("wt-hot");
    fireEvent.mouseLeave(marker);
    expect(slot.container.querySelector(".wt-mn")!.className).not.toContain("wt-hot");
    // At panel width the note stacks under the figure.
    expect(slot.container.querySelector(".wt-notes-stack")).not.toBeNull();
    expect(slot.container.querySelector(".wt-margin")).toBeNull();
  });

  it("hangs notes in the right margin on wide windows", async () => {
    stubWidth(1100);
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }, [{ line: 4, text: "First." }, { line: 4, text: "Second at the same row." }]))));
    await slot.findByRole("button", { name: /Note 1/u });
    const slots = Array.from(slot.container.querySelectorAll<HTMLElement>(".wt-margin-slot"));
    expect(slots).toHaveLength(2);
    // Notes at one row never overlap: the second starts below the first.
    expect(parseFloat(slots[1]!.style.top)).toBeGreaterThan(parseFloat(slots[0]!.style.top));
    expect(slot.container.querySelector(".wt")!.hasAttribute("data-wide")).toBe(true);
  });

  it("flags a line from its number", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(codeWalkthrough(code({ snapshot }))), addNote: () => note({ id: "n2", kind: "todo" }) });
    fireEvent.click(await slot.findByRole("button", { name: "Flag line 4" }));
    const toolbar = await slot.findByRole("toolbar", { name: "Flag this" });
    expect(Array.from(toolbar.querySelectorAll("button")).map((button) => [button.textContent, button.disabled || button.getAttribute("aria-disabled") === "true"])).toEqual([["Note", false], ["Todo", false], ["Comment", true], ["Ask", false]]);
    expect(toolbar.textContent).toContain("Comments are for pull requests");
    fireEvent.click(slot.getByRole("button", { name: "Todo" }));
    expect(slot.getByRole("dialog", { name: "New todo" }).textContent).toContain("New todo");
    fireEvent.change(await slot.findByRole("textbox", { name: "Todo text" }), { target: { value: "Check ids" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "addNote")).toHaveLength(1));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "addNote")!.input).toMatchObject({ kind: "todo", text: "Check ids", groupIndex: 0, location: { path: "src/a.ts", startLine: 4 } });
  });

  it("offers Comment when the walkthrough has a review, and Ask scopes the pager input", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }), { mode: "pr", pr: { number: 2, url: null, title: "T" } })));
    fireEvent.click(await slot.findByRole("button", { name: "Flag line 4" }));
    const toolbar = await slot.findByRole("toolbar", { name: "Flag this" });
    expect(Array.from(toolbar.querySelectorAll("button")).map((button) => [button.textContent, button.disabled])).toEqual([["Note", false], ["Todo", false], ["Comment", false], ["Ask", false]]);
    fireEvent.click(slot.getByRole("button", { name: "Ask" }));
    await slot.findByText(/About “two added”/u);
  });
});

describe("concerns", () => {
  const base = () => walkthrough({ mode: "pr", pr: { number: 2, url: "https://github.com/o/r/pull/2", title: "T" }, parts: [part("Schema"), part("Store")] });
  const notes = [
    note({ id: "n1", kind: "comment", text: "A false recap still passes", location: { path: "src/model.ts", startLine: 85 } }),
    note({ id: "n2", kind: "todo", text: "Confirm redaction", groupIndex: 1 }),
    note({ id: "n3", kind: "question", text: "Why this timestamp?", groupIndex: 0 }),
  ];

  it("is an overlay sheet that Escape closes, returning focus to the toggle", async () => {
    const slot = await mountPage("wt_1", viewOf(base(), notes));
    const toggle = await slot.findByRole("button", { name: /Concerns/u });
    expect(toggle.textContent).toBe("Concerns · 3");
    const sheet = slot.container.querySelector("aside")!;
    expect(sheet.hasAttribute("inert")).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(sheet.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(sheet.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("lists Open items and a Review draft tab, and includes a comment in the review", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(base(), notes), updateNote: () => notes[0] });
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    expect(slot.getByRole("tab", { name: "Open items · 3" }).getAttribute("aria-selected")).toBe("true");
    expect(slot.getByRole("tab", { name: "Review draft · 1" })).toBeTruthy();
    const checkbox = slot.getAllByRole("checkbox", { name: "Include in review" })[0]!;
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(checkbox);
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "updateNote")?.input).toEqual({ walkthroughId: "wt_1", noteId: "n1", includeInReview: false }));
  });

  it("sends open items to the thread", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(base(), notes), prepareHandOff: () => ({ draft: { message: "From my walkthrough.", noteIds: ["n2"] } }), handOff: () => ({ sent: true }) });
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    fireEvent.click(slot.getByRole("button", { name: "Send open items to thread" }));
    // The same previewed flow as everywhere else: nothing is sent until Send.
    await slot.findByRole("textbox", { name: "Message to your thread" });
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "handOff")).toHaveLength(0);
    fireEvent.click(await slot.findByRole("button", { name: "Send to thread" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "handOff")).toHaveLength(1));
  });

  it("shows the review draft and waits for confirmation before posting", async () => {
    const review = { body: "Looks good.", event: "COMMENT", comments: [], status: "draft", url: null, updatedAt: 0 };
    const w = { ...base(), review } as ReturnType<typeof base>;
    const slot = await mountPage("wt_1", { ...viewOf(w, notes), requestReviewPost: () => ({ ok: true }) });
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    fireEvent.click(slot.getByRole("tab", { name: /Review draft/u }));
    await slot.findByText("Looks good.");
    fireEvent.click(slot.getByRole("button", { name: "Post review" }));
    await slot.findByText("This posts publicly to GitHub as your gh account.");
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "requestReviewPost")).toEqual([]);
    expect((await slot.findByRole("link", { name: "o/r#2" })).getAttribute("href")).toBe("https://github.com/o/r/pull/2");
    const dialog = slot.getByRole("dialog");
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Post review")!);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "requestReviewPost")).toHaveLength(1));
  });

  it("only offers a plain comment on a merged PR", async () => {
    const merged = walkthrough({ mode: "pr", pr: { number: 3, url: "https://github.com/o/r/pull/3", title: "T", headRef: null, state: "merged" }, review: { body: "b", event: "REQUEST_CHANGES", comments: [], status: "draft", url: null, updatedAt: 1 } });
    const slot = await mountPage("wt_1", viewOf(merged));
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    fireEvent.click(slot.getByRole("tab", { name: /Review draft/u }));
    fireEvent.click(await slot.findByRole("button", { name: "Post review" }));
    const radios = await slot.findAllByRole("radio");
    expect(radios.map((radio) => [radio.textContent, (radio as HTMLButtonElement).disabled])).toEqual([["Comment", false], ["Request changes", true], ["Approve", true]]);
  });

  it("jumps to the part a concern belongs to", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(base(), notes), openPart: () => ({ ok: true }) });
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    fireEvent.click(slot.getByRole("button", { name: "Go to Part 2" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "openPart")?.input).toEqual({ walkthroughId: "wt_1", index: 1 }));
  });
});

describe("pager and keyboard", () => {
  const two = (extra: Record<string, unknown> = {}) => walkthrough({ parts: [part("Schema", { suggestions: ["Is this tested?", "Why a map?"] }), part("Store")], ...extra });

  it("names the next part and pages with Prev and Next", async () => {
    const paged = pagedView(two());
    const slot = await mountPage("wt_1", paged.rpc);
    fireEvent.click(await slot.findByRole("button", { name: /Next: Store/u }));
    await paged.changed(slot);
    await slot.findByText("Store prose.");
    fireEvent.click(slot.getByRole("button", { name: "Previous: Schema" }));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "openPart").map((call) => call.input)).toEqual([
      { walkthroughId: "wt_1", index: 1 },
      { walkthroughId: "wt_1", index: 0 },
    ]);
  });

  it("serializes rapid Next so a double click cannot skip a part", async () => {
    const paged = pagedView(walkthrough({ parts: [part("One"), part("Two"), part("Three")] }));
    const slot = await mountPage("wt_1", paged.rpc);
    const next = await slot.findByRole("button", { name: /Next: Two/u });
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.keyDown(slot.container.querySelector(".wt")!, { key: "ArrowRight" });
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "openPart").map((call) => call.input)).toEqual([{ walkthroughId: "wt_1", index: 1 }]);
    // Once the page has moved, the next press is a new move from the new page.
    await paged.changed(slot);
    fireEvent.click(await slot.findByRole("button", { name: /Next: Three/u }));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "openPart").map((call) => call.input)).toEqual([{ walkthroughId: "wt_1", index: 1 }, { walkthroughId: "wt_1", index: 2 }]);
  });

  it("lifts the lock after a moment when the page never changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const slot = await mountPage("wt_1", { ...viewOf(two()), openPart: () => ({ ok: true }) });
      const next = await vi.waitFor(() => slot.getByRole("button", { name: /Next: Store/u }));
      fireEvent.click(next);
      expect((slot.getByRole("button", { name: /Writing…|Next: Store/u }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect((slot.getByRole("button", { name: /Next: Store/u }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables Next with 'Writing…' while the next part is being written, and Wrap up while the last part is", async () => {
    const writingNext = walkthrough({ parts: [part("Schema"), part("Store", { status: "writing", blocks: [] })] });
    const slot = await mountPage("wt_1", viewOf(writingNext));
    const waiting = await slot.findByRole("button", { name: "Writing…" });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    const lastWriting = walkthrough({ currentPart: 1, parts: [part("Schema"), part("Store", { status: "writing", blocks: [] })] });
    const second = await mountPage("wt_1", viewOf(lastWriting));
    const [, wrap] = await second.findAllByRole("button", { name: "Writing…" });
    expect((wrap ?? waiting) as HTMLButtonElement).toHaveProperty("disabled", true);
    expect(second.queryByRole("button", { name: "Wrap up" })).toBeNull();
  });

  it("does not skip into a part that has not been started while the current one is still writing", async () => {
    const w = walkthrough({ parts: [part("One", { status: "writing", blocks: [] }), part("Two", { status: "pending", blocks: [] })] });
    const slot = await mountPage("wt_1", viewOf(w));
    expect(((await slot.findByRole("button", { name: "Writing…" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("wraps up from the last part", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(two({ currentPart: 1 })), wrapUp: () => ({ ok: true }) });
    fireEvent.click(await slot.findByRole("button", { name: /Wrap up/u }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "wrapUp")).toHaveLength(1));
  });

  it("asks a suggested question on tap and a typed question on Enter", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(two()), ask: () => ({ ok: true }) });
    fireEvent.click(await slot.findByRole("button", { name: "Is this tested?" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "ask")?.input).toEqual({ walkthroughId: "wt_1", place: 0, question: "Is this tested?" }));
    const input = slot.getByRole("textbox", { name: "Ask about this part" });
    fireEvent.change(input, { target: { value: "What about nulls?" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "ask")).toHaveLength(2));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "ask")[1]!.input).toMatchObject({ question: "What about nulls?" });
  });

  it("prefers the latest answer's follow-up suggestions", async () => {
    const answered = part("Schema", { suggestions: ["Old one"], discussion: [{ id: "e1", question: "q", answer: "a", status: "done", askedAt: 1, suggestions: ["Fresh follow-up"] }] });
    const slot = await mountPage("wt_1", viewOf(walkthrough({ parts: [answered] })));
    await slot.findByRole("button", { name: "Fresh follow-up" });
    expect(slot.queryByRole("button", { name: "Old one" })).toBeNull();
  });

  it("pages with the arrow keys and j/k, and / focuses the input, but not while typing", async () => {
    const paged = pagedView(walkthrough({ currentPart: 1, parts: [part("A"), part("B"), part("C"), part("D")] }));
    const slot = await mountPage("wt_1", paged.rpc);
    await slot.findByText("B prose.");
    const root = slot.container.querySelector<HTMLElement>(".wt")!;
    const calls = () => slot.inspection.rpcCalls.filter((call) => call.method === "openPart").map((call) => (call.input as { index: number | null }).index);
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(calls()).toEqual([2]);
    await paged.changed(slot);
    await slot.findByText("C prose.");
    fireEvent.keyDown(root, { key: "j" });
    await paged.changed(slot);
    await slot.findByText("D prose.");
    fireEvent.keyDown(root, { key: "k" });
    await paged.changed(slot);
    await slot.findByText("C prose.");
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(calls()).toEqual([2, 3, 2, 1]);
    const input = slot.getByRole("textbox", { name: "Ask about this part" });
    fireEvent.keyDown(root, { key: "/" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "j" });
    expect(calls()).toHaveLength(4);
  });

  it("pages with the keys from inside a code figure, where Up and Down move between lines", async () => {
    const paged = pagedView(codeWalkthrough(code({ snapshot })));
    const slot = await mountPage("wt_1", paged.rpc);
    const region = await slot.findByRole("region", { name: /src\/a\.ts, lines 3 to 9/u });
    region.focus();
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "openPart")).toHaveLength(0);
    expect(region.getAttribute("tabindex")).toBe("0");
  });

  it("hides the question input on the introduction", async () => {
    const slot = await mountPage("wt_1", viewOf(two({ currentPart: null, introduction: "Hello." })));
    await slot.findByText("Hello.");
    // The input stays put, saying why it cannot take a question here.
    const input = slot.getByRole("textbox", { name: "Press Next, then ask about any part" });
    expect(input.getAttribute("aria-disabled")).toBe("true");
    expect((input as HTMLInputElement).readOnly).toBe(true);
    expect(slot.getByRole("button", { name: "Previous part" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("part picker", () => {
  it("lists every page with its status", async () => {
    const w = walkthrough({
      codeFingerprint: "new",
      parts: [part("Schema", { writtenAgainst: "old", staleFiles: ["src/a.ts"] }), part("Store", { status: "writing" }), part("Cache", { status: "pending" }), part("Retry", { status: "failed" })],
      currentPart: 0,
    });
    const slot = await mountPage("wt_1", viewOf(w));
    const chip = await slot.findByRole("button", { name: "Parts: Part 1 of 4" });
    fireEvent.click(chip);
    const list = await slot.findByRole("list", { name: "Parts" });
    const rows = Array.from(list.querySelectorAll("li")).map((row) => row.textContent);
    expect(rows).toEqual(["IntroductionReady", "1SchemaOut of date", "2StoreWriting", "3CacheNot started", "4RetryFailed", "Wrap-upNot started"]);
  });
});

describe("skeleton", () => {
  it("shows the page's layout, not a spinner, before part 1", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ status: "planning", parts: [], currentPart: null, inFlight: { request: { kind: "plan" }, sentAt: 1, afterSeq: 0 } })));
    expect(await slot.findByRole("status", { name: /Reading the change/u })).toBeTruthy();
    expect(slot.container.querySelectorAll(".wt-skel").length).toBeGreaterThan(4);
    // No part number is claimed before there is a part.
    expect(slot.container.querySelector(".wt-pn")).toBeNull();
  });

  it("renders the blocks of a part that is partly written, with a skeleton for the rest", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ parts: [part("Schema", { status: "writing", blocks: [{ kind: "prose", text: "The first paragraph." }] })] })));
    await slot.findByText("The first paragraph.");
    expect(slot.getByRole("status", { name: "Writing this part…" })).toBeTruthy();
  });

  it("skeletons a part that is still being written", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ parts: [part("Schema", { status: "writing", blocks: [] })] })));
    expect(await slot.findByRole("status", { name: "Writing this part…" })).toBeTruthy();
  });
});

describe("margin thread", () => {
  it("renders a streaming answer as it grows without remounting what is already on screen", async () => {
    let answer = "The first";
    let status = "answering";
    const live = () => walkthrough({ parts: [part("Schema", { discussion: [{ id: "e1", question: "Why?", answer, status, askedAt: 1 }] })] });
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: live(), notes: [] } }) });
    await slot.findByText("The first");
    const question = slot.getByText("Why?");
    const answerBox = slot.container.querySelector(".wt-a")!;
    expect(answerBox.className).toContain("wt-streaming");
    for (const next of ["The first words", "The first words of a longer answer.\n\nA second paragraph."]) {
      answer = next;
      await slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "changed" });
      await waitFor(() => expect(slot.container.querySelector(".wt-a")!.textContent).toContain(next.split("\n")[0]!));
    }
    await slot.findByText("A second paragraph.");
    expect(slot.getByText("Why?")).toBe(question);
    expect(slot.container.querySelector(".wt-a")).toBe(answerBox);
    status = "done";
    await slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "changed" });
    await waitFor(() => expect(slot.container.querySelector(".wt-a")!.className).not.toContain("wt-streaming"));
  });
});

describe("wrap-up", () => {
  const wrapped = (extra: Record<string, unknown> = {}) =>
    walkthrough({
      status: "wrapping-up",
      currentPart: 1,
      parts: [part("Schema", { discussion: [{ id: "e1", question: "q", answer: "a", status: "done", askedAt: 1 }] }), part("Store", { status: "pending" })],
      wrapUp: part("Wrapping up", { blocks: [{ kind: "prose", text: "That is the change." }] }),
      ...extra,
    });
  const notes = [note({ id: "n1", kind: "todo" }), note({ id: "n2", kind: "question", text: "Why?" })];

  it("shows the ledger: open items, questions answered, parts skipped", async () => {
    const slot = await mountPage("wt_1", viewOf(wrapped(), notes));
    await slot.findByText("That is the change.");
    const ledger = slot.container.querySelector(".wt-ledger")!.textContent!;
    expect(ledger).toContain("Open items2");
    expect(ledger).toContain("Questions answered1");
    expect(ledger).toContain("Parts skipped1Store");
  });

  it("own-change: the one primary action sends open items to the thread", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(wrapped(), notes), prepareHandOff: () => ({ draft: { message: "From my walkthrough.", noteIds: ["n1"] } }), handOff: () => ({ sent: true }) });
    await slot.findByText("That is the change.");
    expect(slot.queryByRole("button", { name: "Post review" })).toBeNull();
    fireEvent.click(slot.container.querySelector<HTMLElement>(".wt-pager .wt-pager-actions .wt-btn-primary")!);
    fireEvent.click(await slot.findByRole("button", { name: "Send to thread" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "handOff")).toHaveLength(1));
    expect(slot.queryByRole("button", { name: /^Finish/u })).toBeNull();
  });

  it("review: the primary action is Post review, behind a confirmation", async () => {
    const review = { body: "Ok.", event: "COMMENT", comments: [], status: "draft", url: null, updatedAt: 1 };
    const slot = await mountPage("wt_1", viewOf(wrapped({ mode: "pr", pr: { number: 2, url: null, title: "T" }, review }), notes));
    await slot.findByText("That is the change.");
    fireEvent.click(slot.container.querySelector<HTMLElement>(".wt-pager .wt-pager-actions .wt-btn-primary")!);
    await slot.findByText(/Post review to GitHub as a comment/u);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "requestReviewPost")).toEqual([]);
  });

  it("understand: Save notes writes a file and says where, and the thread can be asked to apply them", async () => {
    const saved = { threadId: "thr_1", path: "walkthrough-notes/branch-feature-1.md", absolutePath: "/s/thr_1/walkthrough-notes/branch-feature-1.md", notes: 1 };
    const slot = await mountPage("wt_1", { ...viewOf(wrapped({ intent: "understand" }), notes), saveNotes: () => saved, prepareHandOff: () => ({ draft: { message: "From my walkthrough of Branch feature. These are notes I recorded while reading; act on the todos and answer the questions here, in this thread:\n\n- n1 todo: \"Check this\"", noteIds: ["n1", "n2"] } }), handOff: () => ({ sent: true }) });
    await slot.findByText("That is the change.");
    fireEvent.click(slot.getByRole("button", { name: "Save notes" }));
    await slot.findByText("branch-feature-1.md");
    expect(slot.container.querySelector(".wt-saved")!.textContent).toContain("Saved to this thread\u2019s storage");
    // Saved is a state, not a standing invitation: the button settles until the notes change.
    expect((slot.getByRole("button", { name: "Saved" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "saveNotes")).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "Ask the thread to apply it" }));
    // The message is shown, prefilled and editable, and nothing is sent until the reader presses Send.
    const message = (await slot.findByRole("textbox", { name: "Message to your thread" })) as HTMLTextAreaElement;
    expect(message.value).toContain("These are notes I recorded while reading");
    expect(message.value).toContain("Check this");
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "handOff")).toEqual([]);
    fireEvent.change(message, { target: { value: `${message.value}\n\nOnly do the first one.` } });
    fireEvent.click(slot.getByRole("button", { name: "Send to thread" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "handOff")).toHaveLength(1));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "handOff")!.input).toMatchObject({ noteIds: ["n1", "n2"], message: expect.stringContaining("Only do the first one.") });
  });

  it("lets the reader go back to the parts from the wrap-up and return", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(wrapped(), notes), openPart: () => ({ ok: true }) });
    await slot.findByText("That is the change.");
    fireEvent.click(slot.getByRole("button", { name: /^Previous/u }));
    await slot.findByText("Store").catch(() => undefined);
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "openPart")?.input).toEqual({ walkthroughId: "wt_1", index: 1 }));
    await waitFor(() => expect(slot.queryByText("That is the change.")).toBeNull());
  });
});

describe("starter", () => {
  it("offers one button for the changes on this branch, with an optional focus", async () => {
    const target = { kind: "uncommitted", files: 4, additions: 120, deletions: 30 };
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [] }), detectTarget: () => ({ target }), start: () => ({ walkthroughId: "wt_9" }) });
    await slot.findByText("Uncommitted changes · 4 files, +120 \u221230");
    fireEvent.change(slot.getByRole("textbox", { name: "Focus" }), { target: { value: "the retry logic" } });
    fireEvent.click(slot.getByRole("button", { name: "Walk me through it" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "start")?.input).toEqual({ threadId: "thr_1", request: "the retry logic" }));
  });

  const earlier = { id: "wt_1", title: "Earlier one", request: "r", status: "done", partCount: 3, currentPart: 2, openNotes: 0, createdAt: 1 };
  const prTarget = { kind: "pr", number: 12, title: "Add the thing", url: "https://github.com/o/r/pull/12", draft: false };

  it("recognizes the thread's pull request and starts it in this same tab", async () => {
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [earlier] }), detectTarget: () => ({ target: prTarget }), start: () => ({ walkthroughId: "wt_9" }), ...viewOf(walkthrough({ id: "wt_9" })) });
    await slot.findByText("PR #12 \u00b7 Add the thing");
    fireEvent.click(slot.getByRole("button", { name: "Walk me through this PR" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "start")?.input).toEqual({ threadId: "thr_1", request: "This PR, for review" }));
    // The walkthrough replaces the starter in its own tab; no second tab is opened, even as it retitles.
    await slot.findByText("The schema comes first.");
    expect(slot.inspection.navigateCalls.some((call) => call.method === "openThreadPanel")).toBe(false);
  });

  it("opens an earlier walkthrough in this same tab", async () => {
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [earlier] }), detectTarget: () => ({ target: null }), ...viewOf(walkthrough()) });
    fireEvent.click(await slot.findByRole("button", { name: /Earlier one/u }));
    await slot.findByText("The schema comes first.");
    expect(slot.inspection.navigateCalls.some((call) => call.method === "openThreadPanel")).toBe(false);
  });

  it("has a top bar and a labelled focus field", async () => {
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [] }), detectTarget: () => ({ target: null }) });
    expect(slot.container.querySelector("header.wt-top")).not.toBeNull();
    expect(slot.container.textContent).toContain("Focus (optional)");
  });

  it("looks for changes again while it is open, keeping what it found meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let target: unknown = null;
      const slot = await mountPanel({}, { list: () => ({ walkthroughs: [] }), detectTarget: () => ({ target }) });
      await slot.findByText("No changes found");
      target = { kind: "uncommitted", files: 5, additions: 20, deletions: 2, staged: 3, unstaged: 2, untracked: 0 };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });
      await slot.findByText("Uncommitted changes · 5 files, +20 \u22122");
      expect(slot.container.textContent).toContain("3 staged · 2 not staged");
      expect(slot.inspection.rpcCalls.filter((call) => call.method === "detectTarget").length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
