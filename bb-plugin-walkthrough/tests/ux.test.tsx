// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPage, mounted, note, part, stubWidth, viewOf, walkthrough } from "./helpers.tsx";
import { deliverWalkthrough } from "../src/deliver.ts";
import { mergedReviewDraft } from "../src/model.ts";

beforeEach(() => {
  stubWidth(480);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const patch = (lines: string[], start = 3) =>
  ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", `@@ -${start},${lines.length} +${start},${lines.length} @@`, ...lines, ""].join("\n");
const snapshot = { change: patch([" one", "+two added", "-two removed", " three"]), after: patch([" one", " two added", " three"]), before: patch([" one", " two removed", " three"]), baseSha: "aaaaaaa1111", headSha: "bbbbbbb2222222", capturedAt: 1 };
const code = (extra: Record<string, unknown> = {}, notes: unknown[] = []) => ({ kind: "code" as const, caption: "The schema", path: "src/a.ts", startLine: 3, endLine: 9, notes, ...extra });
const codeWalkthrough = (block: Record<string, unknown>, extra: Record<string, unknown> = {}) => walkthrough({ parts: [part("Schema", { blocks: [block] })], ...extra });
const prWalkthrough = (extra: Record<string, unknown> = {}) => walkthrough({ mode: "pr", pr: { number: 2, url: "https://github.com/o/r/pull/2", title: "T" }, ...extra });

describe("answers", () => {
  it("shows an answer without its reply wrapper, complete or still streaming", async () => {
    const answered = part("Schema", {
      discussion: [
        { id: "e1", question: "Why?", answer: ':::reply{state="complete" kind="answer"}\nBecause of the cap.\n:::', status: "done", askedAt: 1 },
        { id: "e2", question: "And?", answer: ':::reply{state="review" kind="answer"}\nStill typ', status: "answering", askedAt: 2 },
      ],
    });
    const slot = await mountPage("wt_1", viewOf(walkthrough({ parts: [answered] })));
    await slot.findByText("Because of the cap.");
    await slot.findByText("Still typ");
    expect(slot.container.textContent).not.toMatch(/:::|reply\{/u);
  });
});

describe("the reader's flags", () => {
  const agentNote = { line: 4, text: "Count checks reject invented ids." };
  const mine = note({ id: "n7", kind: "todo", text: "Check ids", location: { path: "src/a.ts", startLine: 4 }, createdAt: 50 });

  it("marks the reader's flag with its own lettered marker and leaves the agent's numbering alone", async () => {
    const w = codeWalkthrough(code({ snapshot }, [agentNote, { line: 5, text: "Second agent note." }]));
    const slot = await mountPage("wt_1", viewOf(w, [mine]));
    const agent = await slot.findByRole("button", { name: /Note 1: Count checks/u });
    expect(agent.textContent).toBe("1");
    expect(agent.className).not.toContain("wt-m-own");
    const own = slot.getByRole("button", { name: /Your todo a: Check ids/u });
    expect(own.textContent).toBe("a");
    expect(own.className).toContain("wt-m-own");
    // The agent's second note is still 2; the reader's flag did not take a number.
    expect(slot.getByRole("button", { name: /Note 2: Second agent note/u }).textContent).toBe("2");
  });

  it("gives a saved prose note a highlight over its span and a margin glyph", async () => {
    const highlights = new Map<string, unknown>();
    vi.stubGlobal("CSS", { highlights, escape: (value: string) => value });
    class FakeHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    vi.stubGlobal("Highlight", FakeHighlight);
    const prose = note({ id: "n3", kind: "note", text: "Why a map?", groupIndex: 0, location: null, quote: "schema comes first", createdAt: 5 });
    const slot = await mountPage("wt_1", viewOf(walkthrough(), [prose]));
    const glyph = await slot.findByRole("button", { name: /Your note a: Why a map/u });
    expect(glyph.getAttribute("data-note-glyph")).toBe("n3");
    expect(glyph.className).toContain("wt-prose-flag");
    const registered = highlights.get("wt-note") as FakeHighlight;
    expect(registered.ranges.map((range) => range.toString())).toEqual(["schema comes first"]);
  });

  it("snaps a prose selection to whole words before it is flagged", async () => {
    const rect = { top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10, x: 0, y: 0, toJSON() {} } as DOMRect;
    (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => rect;
    const slot = await mountPage("wt_1", { ...viewOf(walkthrough()), addNote: () => note({ id: "n9" }) });
    const paragraph = (await slot.findByText("The schema comes first.")).firstChild!;
    const range = document.createRange();
    range.setStart(paragraph, 6); // sche|ma
    range.setEnd(paragraph, 15); // com|es
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(paragraph.parentElement!);
    expect(selection.toString()).toBe("schema comes");
    fireEvent.click(await slot.findByRole("button", { name: "Note" }));
    fireEvent.change(await slot.findByRole("textbox", { name: "Note text" }), { target: { value: "Why?" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "addNote")?.input).toMatchObject({ kind: "note", quote: "schema comes", location: null }));
  });

  it("says what the composer is making", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }))));
    fireEvent.click(await slot.findByRole("button", { name: "Flag line 4" }));
    fireEvent.click(await slot.findByRole("button", { name: "Todo" }));
    const composer = await slot.findByRole("dialog", { name: "New todo" });
    expect(composer.textContent).toContain("New todo");
    expect(composer.textContent).toContain("Something to do");
  });
});

describe("confirmations", () => {
  it("says 'Note saved' with no id, above the pager, and clears itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slot = await mountPage("wt_1", { ...viewOf(codeWalkthrough(code({ snapshot }))), addNote: () => note({ id: "n42", kind: "note" }) });
    const row = await vi.waitFor(() => slot.getByRole("button", { name: "Flag line 4" }));
    fireEvent.click(row);
    fireEvent.click(slot.getByRole("button", { name: "Note" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Note text" }), { target: { value: "hello" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    const toast = await vi.waitFor(() => slot.getByText("Note saved"));
    expect(slot.container.textContent).not.toMatch(/n42/u);
    // It lives in its own live region, after the pager in the root, positioned above it by the stylesheet.
    const stack = toast.closest(".wt-toasts")!;
    expect(stack.getAttribute("aria-live")).toBe("polite");
    expect(stack.compareDocumentPosition(slot.container.querySelector(".wt-pager")!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(stack.contains(slot.container.querySelector(".wt-next"))).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    expect(slot.queryByText("Note saved")).toBeNull();
  });

  it("keeps errors a little longer and lets them be dismissed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slot = await mountPage("wt_1", { ...viewOf(codeWalkthrough(code({ snapshot }))), addNote: () => { throw new Error("The thread is busy"); } });
    fireEvent.click(await vi.waitFor(() => slot.getByRole("button", { name: "Flag line 4" })));
    fireEvent.click(slot.getByRole("button", { name: "Note" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Note text" }), { target: { value: "hello" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => slot.getByText("The thread is busy"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(slot.getByText("The thread is busy")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    expect(slot.queryByText("The thread is busy")).toBeNull();
  });
});

describe("flagging code", () => {
  it("flags a line when its text is clicked, and offers a pointer cursor and a tooltip on the gutter", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }))));
    await slot.findByRole("button", { name: "Flag line 4" });
    const row = slot.container.querySelector<HTMLElement>('.wt-row[data-line="4"]')!;
    expect(row.className).toContain("wt-flaggable");
    expect(slot.getByRole("button", { name: "Flag line 4" }).getAttribute("data-tip")).toBe("Flag this line");
    fireEvent.click(row.querySelector(".wt-text")!);
    expect(await slot.findByRole("toolbar", { name: "Flag this" })).toBeTruthy();
  });

  it("does not flag a line while the reader is dragging a selection across it", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }))));
    await slot.findByRole("button", { name: "Flag line 4" });
    const row = slot.container.querySelector<HTMLElement>('.wt-row[data-line="4"] .wt-text')!;
    const range = document.createRange();
    range.selectNodeContents(row);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.click(row);
    expect(slot.queryByRole("toolbar", { name: "Flag this" })).toBeNull();
  });

  it("moves between lines with Up and Down and flags the line with c", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }))));
    const region = await slot.findByRole("region", { name: /Up and Down move between lines/u });
    region.focus();
    fireEvent.keyDown(region, { key: "ArrowDown" });
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(slot.container.querySelector(".wt-row[data-cursor]")!.getAttribute("data-line")).toBe("4");
    expect(slot.container.querySelector(".wt-code [role=status]")!.textContent).toBe("Line 4. Press C to flag it.");
    fireEvent.keyDown(region, { key: "c" });
    expect(await slot.findByRole("toolbar", { name: "Flag this" })).toBeTruthy();
  });

  it("keeps the flagged line where it was on screen when saving changes the page height", async () => {
    let top = 100;
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.matches?.('.wt-row[data-line="4"]') ? ({ top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON() {} } as DOMRect) : original.call(this);
    });
    const added = note({ id: "n2", kind: "note", text: "hi", location: { path: "src/a.ts", startLine: 4 }, createdAt: 9 });
    let saved = false;
    const base = viewOf(codeWalkthrough(code({ snapshot })));
    const slot = await mountPage("wt_1", { get: () => ({ view: { ...base.get().view, notes: saved ? [added] : [] } }), addNote: () => { saved = true; return added; } });
    fireEvent.click(await slot.findByRole("button", { name: "Flag line 4" }));
    fireEvent.click(slot.getByRole("button", { name: "Note" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Note text" }), { target: { value: "hi" } });
    const scroller = slot.container.querySelector<HTMLElement>(".wt-scroll")!;
    scroller.scrollTop = 30;
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toBe(true));
    top = 160; // the page grew above the line
    await slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "changed" });
    await waitFor(() => expect(scroller.scrollTop).toBe(90));
  });
});

describe("figure trust", () => {
  it("shows the revision the figure was read at, the PR link, and copies the path", async () => {
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) };
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }), { mode: "pr", pr: { number: 2, url: "https://github.com/o/r/pull/2", title: "T" } })));
    expect((await slot.findByLabelText("Read at revision bbbbbbb")).textContent).toBe("@ bbbbbbb");
    const link = slot.getByRole("link", { name: "Open on GitHub" });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/blob/bbbbbbb2222222/src/a.ts#L3-L9");
    fireEvent.click(slot.getByRole("button", { name: "Copy the path" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("src/a.ts"));
    await slot.findByText("Path copied");
  });

  it("has no GitHub link outside a PR, and no revision without a snapshot", async () => {
    const slot = await mountPage("wt_1", viewOf(codeWalkthrough(code({ snapshot }))));
    await slot.findByRole("button", { name: "Copy the path" });
    expect(slot.queryByRole("link", { name: "Open on GitHub" })).toBeNull();
    expect(slot.getByLabelText(/Read at revision/u)).toBeTruthy();
  });

  it("shows no revision when there is no saved copy", async () => {
    const bare = await mountPage("wt_1", { ...viewOf(codeWalkthrough(code())), excerpt: () => ({ outcome: "unavailable", message: "gone" }) });
    await bare.findByText("No saved copy of this code");
    expect(bare.queryByLabelText(/Read at revision/u)).toBeNull();
  });
});

describe("legacy walkthroughs without a saved copy", () => {
  it("collapses the margin notes under the figure and hides the empty controls", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(codeWalkthrough(code({}, [{ line: 4, text: "Orphaned." }]))), excerpt: () => ({ outcome: "unavailable", message: "x" }) });
    await slot.findByText("No saved copy of this code");
    expect(slot.queryByRole("group", { name: "Show the code as" })).toBeNull();
    const details = slot.container.querySelector("details.wt-notes-collapsed")!;
    expect(details.textContent).toContain("1 note on this code");
    expect(details.hasAttribute("open")).toBe(false);
    expect(slot.container.querySelector(".wt-margin")).toBeNull();
  });
});

describe("coverage", () => {
  const coverage = {
    files: [
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, covered: true, excluded: null, plannedIn: null },
      { path: "src/b.ts", status: "modified", additions: 3, deletions: 1, covered: false, excluded: null, plannedIn: null },
      { path: "Cargo.lock", status: "modified", additions: 9, deletions: 9, covered: false, excluded: "lockfile", plannedIn: null },
    ],
    covered: ["src/a.ts"],
    uncovered: ["src/b.ts"],
    notShown: ["Cargo.lock"],
    changed: 3,
    truncated: false,
    capturedAt: 1,
  };
  const withCoverage = (w: ReturnType<typeof walkthrough>) => ({ get: () => ({ view: { walkthrough: w, notes: [], reviewDraft: mergedReviewDraft(w, []), coverage } }) });

  it("lists what the figures cover and what they do not, in the introduction and the wrap-up", async () => {
    const intro = await mountPage("wt_1", withCoverage(walkthrough({ currentPart: null, introduction: "Hello." })));
    await intro.findByText("Hello.");
    const strip = intro.container.querySelector(".wt-coverage")!;
    expect(strip.textContent).toContain("1 of 2");
    expect(strip.textContent).toContain("Not covered: src/b.ts");
    expect(strip.textContent).toContain("Left out on purpose: Cargo.lock");
  });

  it("lists coverage on the wrap-up too", async () => {
    const wrapped = await mountPage("wt_1", withCoverage(walkthrough({ status: "wrapping-up", wrapUp: part("Wrap", { blocks: [{ kind: "prose", text: "Done." }] }) })));
    await wrapped.findByText("Done.");
    expect(wrapped.container.querySelector(".wt-coverage")!.textContent).toContain("1 of 2");
  });

  it("is absent when the server does not know the changed files yet", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ currentPart: null, introduction: "Hello." })));
    await slot.findByText("Hello.");
    expect(slot.container.querySelector(".wt-coverage")).toBeNull();
  });
});

describe("counting and titles", () => {
  it("counts parts one way everywhere: the pill, the margin number, and the named introduction and wrap-up", async () => {
    const w = walkthrough({ currentPart: 1, parts: [part("A"), part("B"), part("C")] });
    const slot = await mountPage("wt_1", viewOf(w));
    await slot.findByText("B prose.");
    expect(slot.getByRole("button", { name: "Parts: Part 2 of 3" }).textContent).toBe("Part 2 of 3");
    expect(slot.container.querySelector(".wt-pn")!.textContent).toBe("PART2");
  });

  it("names the introduction and the wrap-up instead of numbering them", async () => {
    const intro = await mountPage("wt_1", viewOf(walkthrough({ currentPart: null, introduction: "Hi.", parts: [part("A"), part("B"), part("C")] })));
    await intro.findByText("Hi.");
    expect(intro.getByRole("button", { name: "Parts: Introduction" })).toBeTruthy();
    expect(intro.container.querySelector(".wt-pn")).toBeNull();
  });

  it("names the wrap-up too", async () => {
    const wrap = await mountPage("wt_1", viewOf(walkthrough({ status: "wrapping-up", parts: [part("A")], wrapUp: part("W", { blocks: [{ kind: "prose", text: "Fin." }] }) })));
    await wrap.findByText("Fin.");
    expect(wrap.getByRole("button", { name: "Parts: Wrap-up" })).toBeTruthy();
    expect(wrap.container.querySelector(".wt-pn")).toBeNull();
  });

  it("stands in the request for a title the plan has not chosen yet, and the plan's title replaces it", async () => {
    let title = "Walkthrough";
    const live = () => walkthrough({ title, request: "the retry logic", status: "planning", parts: [], currentPart: null, inFlight: { request: { kind: "plan" }, sentAt: 1, afterSeq: 0 } });
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: live(), notes: [], reviewDraft: null } }) });
    const heading = await slot.findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("the retry logic");
    expect(heading.getAttribute("data-placeholder")).toBe("true");
    title = "Retrying failed requests";
    await slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "changed" });
    await waitFor(() => expect(slot.getByRole("heading", { level: 1 }).textContent).toBe("Retrying failed requests"));
    expect(slot.getByRole("heading", { level: 1 }).hasAttribute("data-placeholder")).toBe(false);
  });
});

describe("the ask input", () => {
  it("is present on every page and says why it is unavailable", async () => {
    const writing = await mountPage("wt_1", viewOf(walkthrough({ parts: [part("A", { status: "writing", blocks: [] })] })));
    expect((await writing.findByRole("textbox", { name: "You can ask as soon as this part is written" })).getAttribute("aria-disabled")).toBe("true");
  });

  it("says a walkthrough is finished in place of the input, not in a dead field", async () => {
    const closed = await mountPage("wt_1", viewOf(walkthrough({ status: "done" })));
    expect((await closed.findByText("This walkthrough is finished")).className).toBe("wt-finished");
    expect(closed.queryByRole("textbox")).toBeNull();
  });

  it("announces the page and the concerns sheet to screen readers", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ currentPart: 1, parts: [part("Schema"), part("Store")] }), [note({ id: "n1" })]));
    await slot.findByText("Store prose.");
    const status = () => slot.container.querySelector(".wt > .wt-sr[role=status]")!.textContent;
    expect(status()).toBe("Part 2 of 2: Store");
    fireEvent.click(slot.getByRole("button", { name: "Concerns · 1" }));
    expect(status()).toBe("Concerns open. 1 open item.");
    expect(slot.container.querySelector("aside")!.getAttribute("aria-label")).toBe("Concerns");
  });

  it("takes a question when the part is ready", async () => {
    const live = await mountPage("wt_1", viewOf(walkthrough()));
    expect((await live.findByRole("textbox", { name: "Ask about this part" })).hasAttribute("aria-disabled")).toBe(false);
  });

  it("labels Prev with the part it goes back to", async () => {
    const slot = await mountPage("wt_1", viewOf(walkthrough({ currentPart: 1, parts: [part("Schema"), part("Store")] })));
    expect(await slot.findByRole("button", { name: "Previous: Schema" })).toBeTruthy();
  });
});

describe("wrap-up actions and counts", () => {
  const wrapped = (extra: Record<string, unknown> = {}) =>
    walkthrough({ status: "wrapping-up", currentPart: 0, parts: [part("Schema")], wrapUp: part("Wrapping up", { blocks: [{ kind: "prose", text: "That is the change." }] }), ...extra });

  it("pins the primary action in the pager, outside the scrolling page", async () => {
    const slot = await mountPage("wt_1", viewOf(wrapped(), [note({ id: "n1", kind: "todo" })]));
    await slot.findByText("That is the change.");
    const actions = Array.from(slot.container.querySelectorAll<HTMLElement>(".wt-pager .wt-pager-actions button"));
    expect(actions.map((button) => button.textContent)).toEqual(["Send open items to thread"]);
    expect(actions[0]!.closest(".wt-scroll")).toBeNull();
    expect(slot.container.querySelector(".wt-scroll")!.textContent).not.toContain("Send open items to thread");
  });

  it("counts '3 open · 2 in review' and does not count what is already waiting on the thread", async () => {
    const w = prWalkthrough({ status: "wrapping-up", currentPart: 0, parts: [part("Schema")], wrapUp: part("W", { blocks: [{ kind: "prose", text: "Done." }] }) });
    const notes = [
      note({ id: "n1", kind: "comment", text: "A", location: { path: "src/a.ts", startLine: 3 } }),
      note({ id: "n2", kind: "comment", text: "B", location: { path: "src/a.ts", startLine: 5 } }),
      note({ id: "n3", kind: "comment", text: "C", location: { path: "src/a.ts", startLine: 7 }, includeInReview: false }),
      note({ id: "n4", kind: "todo", text: "Sent already", sentAt: 5 }),
    ];
    const slot = await mountPage("wt_1", viewOf(w, notes));
    await slot.findByText("Done.");
    const ledger = slot.container.querySelector(".wt-ledger")!.textContent!;
    expect(ledger).toContain("3open · 2 in review · 1 waiting on the thread");
    expect(slot.getByRole("button", { name: "Concerns · 3" })).toBeTruthy();
  });

  it("disables Send with a 'Sent' state when nothing is new", async () => {
    const slot = await mountPage("wt_1", viewOf(wrapped(), [note({ id: "n1", kind: "todo", sentAt: 5 })]));
    await slot.findByText("That is the change.");
    const action = slot.container.querySelector<HTMLButtonElement>(".wt-pager .wt-pager-actions button")!;
    expect(action.textContent).toBe("Sent to thread");
    expect(action.disabled).toBe(true);
  });

  it("disables Send when there is nothing to send at all", async () => {
    const none = await mountPage("wt_1", viewOf(wrapped(), []));
    expect((await none.findByRole("button", { name: "Send open items to thread" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for the message first, and sends exactly what the reader saw with the notes it covers", async () => {
    const draft = { message: "From my walkthrough of X.\n\n- n1 todo: \"Check this\"", noteIds: ["n1"] };
    const slot = await mountPage("wt_1", { ...viewOf(wrapped({ intent: "understand" }), [note({ id: "n1", kind: "todo" })]), prepareHandOff: () => ({ draft }), handOff: () => ({ sent: true }) });
    await slot.findByText("That is the change.");
    fireEvent.click(slot.getByRole("button", { name: "Ask the thread to apply it" }));
    const field = (await slot.findByRole("textbox", { name: "Message to your thread" })) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe(draft.message));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "handOff")).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Send to thread" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "handOff")?.input).toEqual({ walkthroughId: "wt_1", message: draft.message, noteIds: ["n1"] }));
    await slot.findByText("Sent to your thread");
  });
});

describe("concerns sheet", () => {
  const base = () => prWalkthrough({ parts: [part("Schema"), part("Store")] });
  const notes = [
    note({ id: "n1", kind: "comment", text: "A false recap still passes", quote: "it can instantiate the client and res.text(body) afterwards when the first request arrives and then keeps going for a very long time so that it must be cut somewhere in the middle of the sentence, preferably at a word", location: { path: "bb-plugin/src/model.ts", startLine: 85 }, groupIndex: 1 }),
    note({ id: "n2", kind: "todo", text: "Confirm redaction", groupIndex: 0 }),
  ];
  const note1Quote = "it can instantiate the client and res.text(body) afterwards when the first request arrives and then keeps going for a very long time so that it must be cut somewhere in the middle of the sentence, preferably at a word";
  const open = async (rpc: Record<string, (input: never) => unknown>) => {
    const slot = await mountPage("wt_1", rpc);
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    return slot;
  };

  it("labels resolve, edit and delete in plain sight, and asks before deleting", async () => {
    const slot = await open({ ...viewOf(base(), notes), deleteNote: () => ({ ok: true }) });
    const item = slot.container.querySelector<HTMLElement>('[data-note-id="n2"]')!;
    const labels = Array.from(item.querySelectorAll(".wt-it-actions button")).map((button) => button.textContent);
    expect(labels).toEqual(["Resolve", "Edit", "Delete"]);
    fireEvent.click(Array.from(item.querySelectorAll("button")).find((button) => button.textContent === "Delete")!);
    expect(item.textContent).toContain("Delete this todo?");
    expect(slot.inspection.rpcCalls.some((call) => call.method === "deleteNote")).toBe(false);
    fireEvent.click(Array.from(item.querySelectorAll("button")).find((button) => button.textContent === "Keep")!);
    expect(item.textContent).not.toContain("Delete this todo?");
    fireEvent.click(Array.from(item.querySelectorAll("button")).find((button) => button.textContent === "Delete")!);
    fireEvent.click(Array.from(item.querySelectorAll("button")).find((button) => button.textContent === "Delete" && button.className.includes("danger"))!);
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "deleteNote")?.input).toEqual({ walkthroughId: "wt_1", noteId: "n2" }));
  });

  it("shows the directory with the file, and a quote cut on a word", async () => {
    const slot = await open(viewOf(base(), notes));
    const item = slot.container.querySelector<HTMLElement>('[data-note-id="n1"]')!;
    expect(item.querySelector(".wt-it-loc")!.textContent).toBe("Part 2 · src/model.ts:85");
    const quote = item.querySelector(".wt-it-quote")!.textContent!;
    expect(quote.endsWith("…")).toBe(true);
    expect(note1Quote.startsWith(quote.slice(0, -1))).toBe(true);
    expect(note1Quote[quote.length - 1]).toBe(" ");
    expect(quote).not.toMatch(/\s…$/u);
  });

  it("jumps to the part and the line when an item is chosen", async () => {
    const w = walkthrough({ mode: "pr", pr: { number: 2, url: null, title: "T" }, currentPart: 1, parts: [part("Schema"), part("Store", { blocks: [code({ snapshot, path: "bb-plugin/src/model.ts", startLine: 83, endLine: 90 })] })] });
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    const slot = await open(viewOf(w, [{ ...notes[0]!, location: { path: "bb-plugin/src/model.ts", startLine: 4 } }]));
    fireEvent.click(slot.getByRole("button", { name: /Go to Part 2/u }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(slot.container.querySelector('.wt-row[data-line="4"]')!.hasAttribute("data-flash")).toBe(true);
  });

  it("offers Send open items only where there is a todo or question to send", async () => {
    const commentsOnly = await open(viewOf(base(), [notes[0]!]));
    expect(commentsOnly.queryByRole("button", { name: "Send open items to thread" })).toBeNull();
  });

  it("offers it when a todo is waiting", async () => {
    const withTodo = await open(viewOf(base(), notes));
    expect(withTodo.getByRole("button", { name: "Send open items to thread" })).toBeTruthy();
  });

  it("puts Include in review beside each comment", async () => {
    const slot = await open(viewOf(base(), notes));
    const item = slot.container.querySelector<HTMLElement>('[data-note-id="n1"]')!;
    expect(item.querySelector(".wt-it-head .wt-include")!.textContent).toContain("In review");
    expect(item.querySelector('[role="checkbox"]')!.getAttribute("aria-label")).toBe("Include in review");
  });

  it("lets the reader accept or dismiss the helper's suggested outcome", async () => {
    const proposed = [note({ id: "n2", kind: "question", text: "Why?", proposedResolution: "Because the cap truncates." })];
    const slot = await open({ ...viewOf(base(), proposed), acceptResolution: () => proposed[0], dismissResolution: () => proposed[0] });
    expect(slot.container.textContent).toMatch(/Suggested answer:\W*Because the cap truncates\./u);
    fireEvent.click(slot.getByRole("button", { name: "Accept and resolve" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "acceptResolution")?.input).toEqual({ walkthroughId: "wt_1", noteId: "n2" }));
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "dismissResolution")).toBe(true));
  });
});

describe("review draft and post dialog", () => {
  const review = { body: "Looks good overall.", event: "COMMENT", comments: [{ path: "src/config.rs", line: 76, side: "LEFT", body: "This removed branch mattered." }], status: "draft", url: null, updatedAt: 1 };
  const w = () => ({ ...prWalkthrough(), review }) as ReturnType<typeof prWalkthrough>;

  it("shows a summary field even before there is one", async () => {
    const empty = await mountPage("wt_1", viewOf(prWalkthrough()));
    fireEvent.click(await empty.findByRole("button", { name: /Concerns/u }));
    fireEvent.click(empty.getByRole("tab", { name: /Review draft/u }));
    expect(empty.getByLabelText("Summary").textContent).toContain("No summary yet");
  });

  it("shows the summary and the side each comment is on", async () => {
    const slot = await mountPage("wt_1", viewOf(w()));
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    fireEvent.click(slot.getByRole("tab", { name: /Review draft/u }));
    expect(slot.getByLabelText("Summary").textContent).toContain("Looks good overall.");
    expect(slot.container.textContent).toContain("old side (removed code)");
  });

  it("titles the dialog with what it posts, separates path:line from the comment, and includes the summary", async () => {
    const slot = await mountPage("wt_1", { ...viewOf(w()), requestReviewPost: () => ({ ok: true }) });
    fireEvent.click(await slot.findByRole("button", { name: /Concerns/u }));
    fireEvent.click(slot.getByRole("tab", { name: /Review draft/u }));
    fireEvent.click(await slot.findByRole("button", { name: "Post review" }));
    const dialog = await slot.findByRole("dialog");
    expect(dialog.textContent).toContain("Post review to GitHub as a comment");
    const items = Array.from(dialog.querySelectorAll('[aria-label="What will be posted"] li'));
    expect(items[0]!.textContent).toContain("Summary");
    expect(items[0]!.textContent).toContain("Looks good overall.");
    const comment = items[1]!;
    expect(comment.querySelector("code")!.textContent).toBe("src/config.rs:76 (old side)");
    expect(comment.querySelector(".wt-post-body")!.textContent).toBe("This removed branch mattered.");
    expect(comment.querySelector(".wt-post-label")!.textContent).toContain("Inline comment");
    fireEvent.click(await slot.findByRole("radio", { name: "Request changes" }));
    expect(dialog.textContent).toContain("Post review to GitHub and request changes");
  });
});
