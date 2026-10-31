import { describe, expect, it } from "vitest";
import { COVERED_RESOLUTION } from "../src/model.ts";
import { readNote } from "../src/store.ts";
import { PLAN, setup, settle, THREAD } from "./helpers.ts";

async function started() {
  const env = await setup();
  const { walkthroughId } = await env.rpc("start", { threadId: THREAD, request: "Explain" });
  await settle();
  await env.tool("walkthrough_plan", PLAN);
  const note = await env.rpc("addNote", { walkthroughId, kind: "question", text: "Why 4,000?", groupIndex: 0 });
  const notes = async () => (await env.view(walkthroughId)).notes as Array<any>;
  return { ...env, walkthroughId, note, notes };
}

describe("the helper proposes how a note ends; only the reader resolves it", () => {
  it("keeps a note open when the helper tries to resolve it, and records the proposal", async () => {
    const { tool, note, notes } = await started();
    const result = await tool("walkthrough_note", { op: "update", noteId: note.id, status: "resolved", resolution: "The API caps requests at 4,000." });
    expect(JSON.stringify(result)).toContain("stays open until the reader accepts it");
    expect(await notes()).toMatchObject([{ id: note.id, status: "open", resolution: null, proposedResolution: "The API caps requests at 4,000." }]);
  });

  it("takes a proposal through proposedResolution, and tells the helper it is awaiting the reader", async () => {
    const { tool, note, notes } = await started();
    const result = await tool("walkthrough_note", { op: "update", noteId: note.id, proposedResolution: "A provider limit." });
    expect(await notes()).toMatchObject([{ status: "open", proposedResolution: "A provider limit." }]);
    expect(JSON.stringify(result)).toContain("proposed outcome (awaiting the reader)");
  });

  it("closes the note with the proposal only when the reader accepts", async () => {
    const { rpc, tool, note, notes, walkthroughId } = await started();
    await tool("walkthrough_note", { op: "update", noteId: note.id, proposedResolution: "A provider limit." });
    expect(await rpc("acceptResolution", { walkthroughId, noteId: note.id })).toMatchObject({ status: "resolved", resolution: "A provider limit.", proposedResolution: null });
    expect(await notes()).toMatchObject([{ status: "resolved", resolution: "A provider limit.", proposedResolution: null }]);
  });

  it("leaves the note as it was when the reader dismisses the proposal", async () => {
    const { rpc, tool, note, notes, walkthroughId } = await started();
    await tool("walkthrough_note", { op: "update", noteId: note.id, proposedResolution: "A provider limit." });
    await rpc("dismissResolution", { walkthroughId, noteId: note.id });
    expect(await notes()).toMatchObject([{ status: "open", resolution: null, proposedResolution: null }]);
  });

  it("refuses to accept a note nobody proposed an outcome for", async () => {
    const { rpc, note, walkthroughId } = await started();
    await expect(rpc("acceptResolution", { walkthroughId, noteId: note.id })).rejects.toThrow(/no proposed outcome/u);
  });

  it("drops a proposal the reader's own edit has made out of date", async () => {
    const { rpc, tool, note, notes, walkthroughId } = await started();
    await tool("walkthrough_note", { op: "update", noteId: note.id, proposedResolution: "A provider limit." });
    await rpc("updateNote", { walkthroughId, noteId: note.id, text: "Why 4,000 and not 5,000?" });
    expect((await notes())[0]).toMatchObject({ status: "open", proposedResolution: null });
  });

  it("never lets the helper reopen or resolve through status alone", async () => {
    const { tool, note, notes } = await started();
    await tool("walkthrough_note", { op: "update", noteId: note.id, status: "resolved" });
    expect((await notes())[0]).toMatchObject({ status: "open", resolution: null, proposedResolution: null });
  });

  it("turns a review's covered comments into proposals, without duplicating them in the draft", async () => {
    const env = await setup();
    const { walkthroughId } = await env.rpc("start", { threadId: THREAD, request: "Review" });
    await settle();
    await env.tool("walkthrough_plan", { ...PLAN, mode: "pr", baseRef: "abc1234", pr: { number: 7, title: "T", headRef: "def5678" } });
    const comment = await env.rpc("addNote", { walkthroughId, kind: "comment", text: "Guard this.", groupIndex: 0, location: { path: "tts.ts", startLine: 3 } });
    expect((await env.view(walkthroughId)).reviewDraft.comments).toHaveLength(1);
    await env.tool("walkthrough_review", { body: "Looks fine.", comments: [{ path: "tts.ts", line: 3, side: "RIGHT", body: "Please guard this call." }], coveredNotes: [comment.id] });
    const view = await env.view(walkthroughId);
    expect(view.notes[0]).toMatchObject({ status: "open", proposedResolution: COVERED_RESOLUTION });
    expect(view.reviewDraft.comments.map((entry: any) => entry.body)).toEqual(["Please guard this call."]);
  });

  it("reads notes stored before proposals as having none", () => {
    const old = { id: "n1", walkthroughId: "w", kind: "question", text: "t", groupIndex: 0, location: null, quote: null, status: "resolved", resolution: "old answer", author: "user", createdAt: 1, updatedAt: 1 };
    expect(readNote(old)).toMatchObject({ status: "resolved", resolution: "old answer" });
    expect(readNote(old).proposedResolution ?? null).toBeNull();
  });
});
