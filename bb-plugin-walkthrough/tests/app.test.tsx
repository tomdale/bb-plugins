// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PausePayload, WalkthroughView } from "../src/schemas.ts";

const payload: PausePayload = {
  walkthroughId: "wt_1",
  mode: "pr",
  stage: "group",
  groupIndex: 0,
  groupCount: 2,
  groupTitle: "Schema",
  nextGroupTitle: "Store",
  suggestions: ["Why a new table?"],
  locations: [{ path: "src/schema.ts", startLine: 1, endLine: 20 }],
  environmentId: "env_1",
};

const view: WalkthroughView = {
  walkthrough: {
    id: "wt_1",
    threadId: "thr_1",
    mode: "pr",
    status: "reviewing",
    title: "PR #12: Schema",
    baseRef: "origin/main",
    headRef: null,
    includeUncommitted: false,
    pr: { number: 12, url: null, title: null },
    groups: [
      { title: "Schema", summary: "", locations: payload.locations, status: "current" },
      { title: "Store", summary: "", locations: [], status: "pending" },
    ],
    currentGroup: 0,
    environmentId: "env_1",
    hostId: "host_1",
    workspacePath: "/w",
    notesFile: { enabled: true, path: "/w/.agent/review-notes.md", written: false, error: null },
    review: null,
    pause: null,
    nextNoteNumber: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  notes: [],
  pausePending: true,
  pauseRequested: false,
};

async function renderPause() {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const registration = app.pendingInteractions.find((entry) => entry.id === "walkthrough-pause")!;
  const submit = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const addNote = vi.fn((input: { kind: string; text: string; location?: unknown }) => ({
    id: "n1",
    walkthroughId: "wt_1",
    kind: input.kind,
    text: input.text,
    groupIndex: 0,
    location: input.location ?? null,
    quote: null,
    status: "open",
    resolution: null,
    author: "user",
    createdAt: 0,
    updatedAt: 0,
  }));
  const slot = renderSlot(
    registration,
    {
      interaction: { id: "int_1", threadId: "thr_1", title: "Walkthrough", payload, createdAt: 0, expiresAt: null },
      submit,
      cancel,
    },
    { rpc: { get: () => ({ view }), addNote } as never, openThreadPanel: () => true },
  );
  return { slot, submit, cancel, addNote };
}

afterEach(cleanup);

describe("pause form", () => {
  it("continues to the next group", async () => {
    const { slot, submit } = await renderPause();
    fireEvent.click(await slot.findByRole("button", { name: /Next: Store/u }));
    expect(submit).toHaveBeenCalledWith({ action: "next" });
  });

  it("asks a typed question and runs dotted commands", async () => {
    const { slot, submit, addNote } = await renderPause();
    const input = await slot.findByLabelText("Ask a question or record a note");
    fireEvent.change(input, { target: { value: "What calls this?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).toHaveBeenCalledWith({ action: "ask", text: "What calls this?" });

    submit.mockClear();
    fireEvent.change(input, { target: { value: ".comment Needs a test" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(addNote).toHaveBeenCalled());
    expect(addNote.mock.calls[0]![0]).toMatchObject({ kind: "comment", text: "Needs a test", groupIndex: 0 });
    expect(submit).not.toHaveBeenCalled();
    expect(await slot.findByText(/Recorded comment n1/u)).toBeTruthy();
  });

  it("records a note with a file location without leaving the pause", async () => {
    const { slot, submit, addNote } = await renderPause();
    fireEvent.change(await slot.findByLabelText("Ask a question or record a note"), { target: { value: "Rename" } });
    fireEvent.change(slot.getByLabelText("Attach the note to"), { target: { value: "0" } });
    fireEvent.click(slot.getByRole("button", { name: "Todo" }));
    await waitFor(() => expect(addNote).toHaveBeenCalled());
    expect(addNote.mock.calls[0]![0]).toMatchObject({
      kind: "todo",
      location: { path: "src/schema.ts", startLine: 1, endLine: 20 },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("asks a suggested question", async () => {
    const { slot, submit } = await renderPause();
    fireEvent.click(await slot.findByRole("button", { name: /Why a new table\?/u }));
    expect(submit).toHaveBeenCalledWith({ action: "ask", text: "Why a new table?" });
  });
});
