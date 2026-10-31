// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPage, mountPanel, mounted, openMenu, stubWidth, viewOf, walkthrough } from "./helpers.tsx";

beforeEach(() => {
  stubWidth(480);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  vi.unstubAllGlobals();
});

const summary = (id: string, title: string) => ({ id, title, request: "r", status: "reading", partCount: 3, currentPart: 0, openNotes: 0, createdAt: 1 });

/** An index whose `delete` removes the row, the way the server does. */
function indexOf(...titles: string[]) {
  const state = { rows: titles.map((title, index) => summary(`wt_${index + 1}`, title)), deleted: [] as string[], fail: null as string | null };
  const rpc = {
    recent: () => ({ walkthroughs: state.rows }),
    delete: ({ walkthroughId }: { walkthroughId: string }) => {
      if (state.fail) throw new Error(state.fail);
      state.deleted.push(walkthroughId);
      state.rows = state.rows.filter((row) => row.id !== walkthroughId);
      return { deleted: true };
    },
  };
  const changed = (slot: { emitRealtime: (channel: string, payload: unknown) => Promise<unknown> | unknown }, walkthroughId: string) =>
    slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId, reason: "deleted" });
  return { state, rpc, changed };
}

describe("deleting from the Walkthroughs index", () => {
  it("gives each row a Delete button beside, not inside, the button that opens it", async () => {
    const { rpc } = indexOf("Retry loop", "Queue");
    const slot = await mountPage("", rpc);
    const open = await slot.findByRole("button", { name: /^Retry loop/ });
    const remove = slot.getByRole("button", { name: "Delete Retry loop" });
    expect(open.contains(remove)).toBe(false);
    expect(open.parentElement).toBe(remove.parentElement);
    expect(slot.getByRole("button", { name: "Delete Queue" })).toBeTruthy();
  });

  it("takes no room until the row is hovered or focused, and is revealed by focus-visible", () => {
    const css = readFileSync("app.css", "utf8");
    expect(css).toMatch(/\.wt-summary-delete \{[^}]*width: 0;[^}]*overflow: hidden/u);
    expect(css).toMatch(/\.wt-summary-item:hover \.wt-summary-delete, \.wt-summary-item:has\(:focus-visible\) \.wt-summary-delete[^{]*\{[^}]*width: 28px/u);
  });

  it("does not let a press on Delete reach the row", async () => {
    const { rpc } = indexOf("Retry loop");
    const slot = await mountPage("", rpc);
    const reached = vi.fn();
    document.addEventListener("pointerdown", reached);
    fireEvent.pointerDown(await slot.findByRole("button", { name: "Delete Retry loop" }));
    document.removeEventListener("pointerdown", reached);
    expect(reached).not.toHaveBeenCalled();
  });

  it("names the walkthrough and what goes, and deletes nothing until confirmed", async () => {
    const { rpc, state } = indexOf("Retry loop");
    const slot = await mountPage("", rpc);
    fireEvent.click(await slot.findByRole("button", { name: "Delete Retry loop" }));
    const dialog = await slot.findByRole("dialog");
    expect(dialog.textContent).toContain("Delete “Retry loop”?");
    expect(dialog.textContent).toMatch(/removes the walkthrough, its notes, and your questions and the answers/u);
    expect(dialog.textContent).toMatch(/helper thread is archived/u);
    expect(dialog.textContent).toMatch(/Notes you saved to a file stay where they are/u);
    expect(state.deleted).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(state.deleted).toEqual([]);
  });

  it("deletes on confirm, drops the row, and moves focus to the row that took its place", async () => {
    const { rpc, state, changed } = indexOf("Retry loop", "Queue", "Cache");
    const slot = await mountPage("", rpc);
    fireEvent.click(await slot.findByRole("button", { name: "Delete Queue" }));
    fireEvent.click(await slot.findByRole("button", { name: "Delete walkthrough" }));
    await waitFor(() => expect(state.deleted).toEqual(["wt_2"]));
    await changed(slot, "wt_2");
    await waitFor(() => expect(slot.queryByRole("button", { name: /^Queue/ })).toBeNull());
    expect(slot.getByRole("button", { name: /^Retry loop/ })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: /^Cache/ })));
  });

  it("moves focus to the heading when the last row goes", async () => {
    const { rpc, state, changed } = indexOf("Only one");
    const slot = await mountPage("", rpc);
    fireEvent.click(await slot.findByRole("button", { name: "Delete Only one" }));
    fireEvent.click(await slot.findByRole("button", { name: "Delete walkthrough" }));
    await waitFor(() => expect(state.deleted).toEqual(["wt_1"]));
    await changed(slot, "wt_1");
    await slot.findByText(/No walkthroughs yet/u);
    await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("heading", { name: "Recent walkthroughs" })));
  });

  it("shows a failure in the dialog and keeps it open", async () => {
    const { rpc, state } = indexOf("Retry loop");
    state.fail = "The server is busy.";
    const slot = await mountPage("", rpc);
    fireEvent.click(await slot.findByRole("button", { name: "Delete Retry loop" }));
    fireEvent.click(await slot.findByRole("button", { name: "Delete walkthrough" }));
    expect((await slot.findByRole("alert")).textContent).toContain("The server is busy.");
    expect(slot.getByRole("dialog")).toBeTruthy();
  });
});

describe("deleting from a walkthrough", () => {
  it("offers Delete in the overflow menu, and confirms before deleting", async () => {
    const deleted: string[] = [];
    const slot = await mountPanel({ walkthroughId: "wt_1" }, { ...viewOf(walkthrough()), delete: ({ walkthroughId }: { walkthroughId: string }) => (deleted.push(walkthroughId), { deleted: true }) });
    openMenu(await slot.findByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Delete walkthrough…" }));
    expect((await slot.findByRole("dialog")).textContent).toContain("Delete “Branch feature”?");
    expect(deleted).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Delete walkthrough" }));
    await waitFor(() => expect(deleted).toEqual(["wt_1"]));
  });

  it("is offered on a finished walkthrough too", async () => {
    const slot = await mountPanel({ walkthroughId: "wt_1" }, viewOf(walkthrough({ status: "done" })));
    openMenu(await slot.findByRole("button", { name: "More" }));
    expect(await slot.findByRole("menuitem", { name: "Delete walkthrough…" })).toBeTruthy();
    expect(slot.queryByRole("menuitem", { name: "Finish walkthrough" })).toBeNull();
  });

  it("turns an open pane into the deleted state, with a link to the index, when the walkthrough goes", async () => {
    let gone = false;
    const slot = await mountPanel({ walkthroughId: "wt_1" }, { get: () => ({ view: gone ? null : (viewOf(walkthrough()).get() as { view: unknown }).view }) });
    await slot.findByText("The schema comes first.");
    gone = true;
    await slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "deleted" });
    await slot.findByText("This walkthrough was deleted");
    expect(slot.queryByText("The schema comes first.")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "See your other walkthroughs" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "walkthroughs" });
  });
});
