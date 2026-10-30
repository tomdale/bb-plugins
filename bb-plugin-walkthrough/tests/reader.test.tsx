// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePatchRows, rowIndexForLine } from "../src/ui/patch-lines.ts";
import { mountPage, mountPanel, mounted, note, part, stubWidth, viewOf, walkthrough } from "./helpers.tsx";

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
    expect(slot.container.querySelectorAll(".wt-add")).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "After" }));
    expect(slot.container.querySelectorAll(".wt-add, .wt-del")).toHaveLength(0);
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
    await slot.findByText("This code is no longer on disk.");
    expect(slot.queryByText(/fatal/u)).toBeNull();
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
    expect(Array.from(toolbar.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Note", "Todo", "Ask"]);
    fireEvent.click(slot.getByRole("button", { name: "Todo" }));
    fireEvent.change(await slot.findByRole("textbox", { name: "Todo text" }), { target: { value: "Check ids" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "addNote")).toHaveLength(1));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "addNote")!.input).toMatchObject({ kind: "todo", text: "Check ids", groupIndex: 0, location: { path: "src/a.ts", startLine: 4 } });
  });

  it("offers Comment when the walkthrough has a review, and Ask scopes the pager input", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }), { mode: "pr", pr: { number: 2, url: null, title: "T" } })));
    fireEvent.click(await slot.findByRole("button", { name: "Flag line 4" }));
    const toolbar = await slot.findByRole("toolbar", { name: "Flag this" });
    expect(Array.from(toolbar.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Note", "Todo", "Comment", "Ask"]);
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
    const slot = await mountPage("wt_1", { ...viewOf(base(), notes), handOff: () => ({ sent: true }) });
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    fireEvent.click(slot.getByRole("button", { name: "Send open items to thread" }));
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
    fireEvent.click(slot.getByRole("button", { name: "Part 2" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "openPart")?.input).toEqual({ walkthroughId: "wt_1", index: 1 }));
  });
});

describe("pager and keyboard", () => {
  const two = (extra: Record<string, unknown> = {}) => walkthrough({ parts: [part("Schema", { suggestions: ["Is this tested?", "Why a map?"] }), part("Store")], ...extra });

  it("names the next part and pages with Prev and Next", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(two()), openPart: () => ({ ok: true }) });
    fireEvent.click(await slot.findByRole("button", { name: /Next: Store/u }));
    fireEvent.click(slot.getByRole("button", { name: "Previous" }));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "openPart").map((call) => call.input)).toEqual([
      { walkthroughId: "wt_1", index: 1 },
      { walkthroughId: "wt_1", index: null },
    ]);
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
    const slot = await mountPage("wt_1", { ...viewOf(two()), openPart: () => ({ ok: true }) });
    await slot.findByText("Schema prose.");
    const root = slot.container.querySelector<HTMLElement>(".wt")!;
    fireEvent.keyDown(root, { key: "ArrowRight" });
    fireEvent.keyDown(root, { key: "j" });
    fireEvent.keyDown(root, { key: "k" });
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "openPart")).toHaveLength(4));
    const input = slot.getByRole("textbox", { name: "Ask about this part" });
    fireEvent.keyDown(root, { key: "/" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "j" });
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "openPart")).toHaveLength(4);
  });

  it("hides the question input on the introduction", async () => {
    const slot = await mountPage("wt_1", viewOf(two({ currentPart: null, introduction: "Hello." })));
    await slot.findByText("Hello.");
    expect(slot.queryByRole("textbox")).toBeNull();
    expect(slot.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("part picker", () => {
  it("lists every page with its status", async () => {
    const w = walkthrough({
      codeFingerprint: "new",
      parts: [part("Schema", { writtenAgainst: "old" }), part("Store", { status: "writing" }), part("Cache", { status: "pending" }), part("Retry", { status: "failed" })],
      currentPart: 0,
    });
    const slot = await mountPage("wt_1", viewOf(w));
    const chip = await slot.findByRole("button", { name: "Parts: 2 of 6" });
    fireEvent.click(chip);
    const list = await slot.findByRole("list", { name: "Parts" });
    const rows = Array.from(list.querySelectorAll("li")).map((row) => row.textContent);
    expect(rows).toEqual(["·IntroductionReady", "1SchemaOut of date", "2StoreWriting", "3CacheNot started", "4RetryFailed", "·Wrap-upNot started"]);
  });
});

describe("skeleton", () => {
  it("shows the page's layout, not a spinner, before part 1", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ status: "planning", parts: [], currentPart: null, inFlight: { request: { kind: "plan" }, sentAt: 1, afterSeq: 0 } })));
    expect(await slot.findByRole("status", { name: /Reading the change/u })).toBeTruthy();
    expect(slot.container.querySelectorAll(".wt-skel").length).toBeGreaterThan(4);
    expect(slot.container.querySelector(".wt-pn")).not.toBeNull();
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
    const slot = await mountPage("wt_1", { ...viewOf(wrapped(), notes), handOff: () => ({ sent: true }) });
    await slot.findByText("That is the change.");
    expect(slot.queryByRole("button", { name: "Post review" })).toBeNull();
    fireEvent.click(slot.container.querySelector<HTMLElement>(".wt-actions .wt-btn-primary")!);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "handOff")).toHaveLength(1));
    expect(slot.queryByRole("button", { name: /^Finish/u })).toBeNull();
  });

  it("review: the primary action is Post review, behind a confirmation", async () => {
    const review = { body: "Ok.", event: "COMMENT", comments: [], status: "draft", url: null, updatedAt: 1 };
    const slot = await mountPage("wt_1", viewOf(wrapped({ mode: "pr", pr: { number: 2, url: null, title: "T" }, review }), notes));
    await slot.findByText("That is the change.");
    fireEvent.click(slot.container.querySelector<HTMLElement>(".wt-actions .wt-btn-primary")!);
    await slot.findByText(/Post review to PR #2/u);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "requestReviewPost")).toEqual([]);
  });

  it("understand: Save notes copies them, and the thread can be asked to apply them", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const slot = await mountPage("wt_1", { ...viewOf(wrapped({ intent: "understand" }), notes), handOff: () => ({ sent: true }) });
    await slot.findByText("That is the change.");
    fireEvent.click(slot.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect((writeText.mock.calls[0] as unknown as [string])[0]).toContain("Check this");
    fireEvent.click(slot.getByRole("button", { name: "Ask the thread to apply it" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "handOff")).toHaveLength(1));
  });

  it("lets the reader go back to the parts from the wrap-up and return", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(wrapped(), notes), openPart: () => ({ ok: true }) });
    await slot.findByText("That is the change.");
    fireEvent.click(slot.getByRole("button", { name: "Previous" }));
    await slot.findByText("Store").catch(() => undefined);
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "openPart")?.input).toEqual({ walkthroughId: "wt_1", index: 1 }));
    await waitFor(() => expect(slot.queryByText("That is the change.")).toBeNull());
  });
});

describe("starter", () => {
  it("offers one button for the changes on this branch, with an optional focus", async () => {
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [] }), start: () => ({ walkthroughId: "wt_9" }) });
    await slot.findByText("Changes on this branch");
    fireEvent.change(slot.getByRole("textbox", { name: "Focus" }), { target: { value: "the retry logic" } });
    fireEvent.click(slot.getByRole("button", { name: "Walk me through it" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "start")?.input).toEqual({ threadId: "thr_1", request: "the retry logic" }));
  });

  it("recognizes the thread's pull request and lists earlier walkthroughs", async () => {
    const earlier = { id: "wt_1", title: "Earlier one", request: "r", status: "done", partCount: 3, currentPart: 2, openNotes: 0, createdAt: 1 };
    const slot = await mountPanel({}, { list: () => ({ walkthroughs: [earlier] }), start: () => ({ walkthroughId: "wt_9" }) }, {
      sidebarPullRequests: { thr_1: { number: 12, title: "Add the thing", url: "https://github.com/o/r/pull/12", state: "open", attention: "none" } },
    });
    await slot.findByText("#12 Add the thing");
    fireEvent.click(slot.getByRole("button", { name: "Walk me through this PR" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "start")?.input).toEqual({ threadId: "thr_1", request: "This PR, for review" }));
    fireEvent.click(await slot.findByRole("button", { name: /Earlier one/u }));
    expect(slot.inspection.navigateCalls.some((call) => call.method === "openThreadPanel")).toBe(true);
  });
});
