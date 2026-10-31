import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { readNote, readWalkthrough } from "../src/store.ts";
import { OPEN_DESCRIPTION, OPEN_INSTRUCTIONS } from "../src/tools.ts";
import { PLAN_INSTRUCTIONS, WRITE_PART_INSTRUCTIONS } from "../src/worker.ts";
import { PART, PLAN, setup, settle, THREAD } from "./helpers.ts";

const patch = "--- a/tts.ts\n+++ b/tts.ts\n@@ -1,2 +1,2 @@\n a\n-old\n+new\n";
const codeRead = () => ({
  path: "tts.ts",
  patch,
  truncated: false,
  sides: { old: { path: "tts.ts", content: "a\nold\n" }, new: { path: "tts.ts", content: "a\nnew\n" } },
});
const PR_PLAN = { ...PLAN, mode: "pr", baseRef: "abc1234", pr: { number: 7, title: "T", headRef: "def5678" } };

async function planned(options: Parameters<typeof setup>[0] = {}, plan: Record<string, unknown> = PLAN) {
  const ctx = await setup(options);
  const { walkthroughId } = await ctx.rpc("start", { threadId: THREAD, request: "" });
  await settle();
  await ctx.tool("walkthrough_plan", plan);
  return { ...ctx, walkthroughId };
}

function legacyWalkthrough(id: string) {
  const part = { title: "P", summary: "", locations: [], status: "ready", suggestions: ["Why?"], message: null, discussion: [{ id: "e1", question: "q", answer: "a", status: "done", askedAt: 1 }], blocks: [
    { kind: "prose", text: "Hello" },
    { kind: "code", caption: "c", path: "tts.ts", startLine: 1, endLine: 2, notes: [] },
  ] };
  return {
    id, threadId: THREAD, workerThreadId: "w", request: "r", status: "reading", message: null, title: "Old", mode: "pr", baseRef: "main",
    includeUncommitted: false, pr: { number: 1, url: null, title: null }, introduction: "", parts: [part], currentPart: 0, wrapUp: null,
    environmentId: null, hostId: null, workspacePath: null,
    notesFile: { enabled: true, path: "/w/.agent/review-notes/x.md", written: true, error: null },
    review: null, queue: [], inFlight: null, nextNoteNumber: 2, nextExchangeNumber: 2, createdAt: 1, updatedAt: 1,
  };
}

describe("stored data upgrades", () => {
  it("backfills newer fields on old rows and keeps them loadable through RPC", async () => {
    const { bb, rpc } = await setup();
    const db = bb.storage.database();
    const old = legacyWalkthrough("wt_old");
    db.prepare(`INSERT INTO walkthroughs_v2 (id, thread_id, worker_thread_id, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run("wt_old", THREAD, "w", "reading", JSON.stringify(old), 1);
    const note = { id: "n1", walkthroughId: "wt_old", kind: "comment", text: "c", groupIndex: 0, location: { path: "tts.ts", startLine: 2 }, quote: null, status: "open", resolution: null, author: "user", createdAt: 1, updatedAt: 1 };
    db.prepare(`INSERT INTO notes (id, walkthrough_id, data, reported, created_at) VALUES (?, ?, ?, 0, ?)`).run("n1", "wt_old", JSON.stringify(note), 1);
    const { view } = await rpc("get", { walkthroughId: "wt_old" });
    expect(view.walkthrough.intent).toBe("review");
    expect(view.walkthrough.parts[0].blocks[1]).toMatchObject({ view: "diff", snapshot: null, snapshotError: null });
    expect(view.notes[0].includeInReview).toBe(true);
    expect(view.reviewDraft.comments).toMatchObject([{ path: "tts.ts", line: 2, noteId: "n1" }]);
  });

  it("sanitizes damaged new fields instead of discarding the record", () => {
    const old = legacyWalkthrough("wt_bad") as any;
    old.intent = "bogus";
    old.notesFile = { nope: 1 };
    old.parts[0].blocks[1].view = "weird";
    old.parts[0].blocks[1].snapshot = { change: 5 };
    old.parts[0].discussion[0].suggestions = "not an array";
    const walkthrough = readWalkthrough(old);
    expect(walkthrough.intent).toBe("review");
    expect(walkthrough.notesFile).toBeUndefined();
    expect(walkthrough.parts[0].blocks[1]).toMatchObject({ view: "diff", snapshot: null });
    expect(walkthrough.parts[0].discussion[0]!.suggestions).toBeUndefined();
    expect(readNote({ id: "n", walkthroughId: "w", kind: "note", text: "t", groupIndex: null, location: null, quote: null, status: "open", resolution: null, author: "user", includeInReview: "yes", createdAt: 1, updatedAt: 1 }).includeInReview).toBe(false);
  });
});

describe("code snapshots", () => {
  const block = { kind: "code", caption: "c", path: "tts.ts", startLine: 1, endLine: 2, notes: [] };

  it("captures change, after, before, and the commits when a part is written", async () => {
    const { tool, view, walkthroughId } = await planned({ readCode: codeRead }, PR_PLAN);
    await tool("walkthrough_write_part", { part: 1, blocks: [{ kind: "prose", text: "x" }, { ...block, view: "code" }, block], suggestions: [] });
    const blocks = (await view(walkthroughId)).walkthrough.parts[0].blocks;
    expect(blocks[1]).toMatchObject({ view: "code", snapshotError: null, snapshot: { baseSha: "abc1234", headSha: "def5678", change: expect.stringContaining("+new"), after: expect.stringContaining(" new"), before: expect.stringContaining(" old") } });
    expect(blocks[2]).toMatchObject({ view: "diff" });
    expect(typeof blocks[1].snapshot.capturedAt).toBe("number");
  });

  it("stores no snapshot and a short reason, never raw stderr, and tells the worker", async () => {
    const { tool, view, walkthroughId, harness } = await planned({ readCode: () => { throw new Error("fatal: bad object /Users/secret/repo/.git"); } }, PR_PLAN);
    harness.inspection.sdk.stub("environments.diffPatch", async () => ({ outcome: "available", patches: [] }));
    const result = await tool("walkthrough_write_part", { part: 1, blocks: [block], suggestions: [] });
    expect(String(JSON.stringify(result))).toContain("could not be read");
    const saved = (await view(walkthroughId)).walkthrough.parts[0];
    expect(saved.status).toBe("ready");
    expect(saved.blocks[0]).toMatchObject({ snapshot: null, snapshotError: "This code couldn't be read." });
    expect(JSON.stringify(saved)).not.toContain("secret");
  });

  it("serves a reader-safe message from the excerpt RPC too", async () => {
    const { rpc, walkthroughId } = await planned({ readCode: () => { throw new Error("fatal: /Users/secret/x"); } }, PR_PLAN);
    const result = await rpc("excerpt", { walkthroughId, path: "tts.ts", startLine: 1, endLine: 2 });
    expect(result).toEqual({ outcome: "unavailable", message: "This code couldn't be read." });
  });

  it("rejects a snapshot supplied by the worker", async () => {
    const { tool } = await planned({ readCode: codeRead });
    await expect(tool("walkthrough_write_part", { part: 1, blocks: [{ ...block, snapshot: null }], suggestions: [] })).rejects.toThrow();
  });
});

describe("pacing and first paint", () => {
  it("writes one part ahead of the reader, then waits until the reader moves", async () => {
    const { tool, idle, view, rpc, sent, walkthroughId } = await planned();
    await idle("Planned.");
    await settle();
    await tool("walkthrough_write_part", PART);
    await idle("Done.");
    await settle();
    await tool("walkthrough_write_part", { ...PART, part: 2 });
    await idle("Done.");
    await settle();
    let current = (await view(walkthroughId)).walkthrough;
    expect(current.parts.map((part: { status: string }) => part.status)).toEqual(["ready", "ready", "pending"]);
    expect(current.inFlight).toBeNull();
    expect(current.queue).toEqual([]);
    const count = sent.length;
    await settle();
    expect(sent).toHaveLength(count);
    await rpc("openPart", { walkthroughId, index: 0 });
    expect((await view(walkthroughId)).walkthrough.inFlight).toBeNull();
    await rpc("openPart", { walkthroughId, index: 1 });
    current = (await view(walkthroughId)).walkthrough;
    expect(current.inFlight.request).toEqual({ kind: "write", part: 2 });
    expect(current.parts[2].status).toBe("writing");
  });

  it("moves ahead when the reader asks about a part", async () => {
    const { tool, idle, view, rpc, walkthroughId } = await planned();
    await idle("Planned.");
    await settle();
    await tool("walkthrough_write_part", PART);
    await idle("Done.");
    await settle();
    await tool("walkthrough_write_part", { ...PART, part: 2 });
    await idle("Done.");
    await settle();
    await rpc("ask", { walkthroughId, place: 1, question: "What about keys?" });
    await settle();
    const current = (await view(walkthroughId)).walkthrough;
    expect(current.inFlight.request.kind).toBe("ask");
    expect(current.queue).toEqual([{ kind: "write", part: 2 }]);
  });

  it("asks for plan and part 1 in one turn, and does not repeat part 1 when it was written", async () => {
    const { rpc, tool, idle, view, sent } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    expect(sent[0]!.text).toContain("walkthrough_plan");
    expect(sent[0]!.text).toContain("same turn, call walkthrough_write_part for part 1");
    await tool("walkthrough_plan", PLAN);
    let current = (await view(walkthroughId)).walkthrough;
    expect(current.parts[0].status).toBe("writing");
    await tool("walkthrough_write_part", PART);
    current = (await view(walkthroughId)).walkthrough;
    expect(current.parts[0].status).toBe("ready");
    await idle("Planned and wrote part 1.");
    await settle();
    current = (await view(walkthroughId)).walkthrough;
    expect(current.inFlight.request).toEqual({ kind: "write", part: 1 });
    expect(sent.at(-1)!.text).toContain("Write part 2 of 3");
    expect(current.parts[0].status).toBe("ready");
  });

  it("falls back to a separate part 1 request when the worker only planned", async () => {
    const { tool, idle, view, sent, walkthroughId } = await planned();
    await idle("Planned.");
    await settle();
    const current = (await view(walkthroughId)).walkthrough;
    expect(current.inFlight.request).toEqual({ kind: "write", part: 0 });
    expect(current.parts[0].status).toBe("writing");
    expect(sent.at(-1)!.text).toContain("Write part 1 of 3");
    await tool("walkthrough_write_part", PART);
  });
});

describe("intent", () => {
  it("defaults from the mode and honors the planner's choice", async () => {
    const local = await planned();
    expect((await local.view(local.walkthroughId)).walkthrough.intent).toBe("own-change");
    const pr = await planned({}, PR_PLAN);
    expect((await pr.view(pr.walkthroughId)).walkthrough.intent).toBe("review");
    const understand = await planned({}, { ...PLAN, intent: "understand" });
    expect((await understand.view(understand.walkthroughId)).walkthrough.intent).toBe("understand");
  });

  it("changes the wrap-up request by intent", async () => {
    const wrap = async (plan: Record<string, unknown>) => {
      const ctx = await planned({}, plan);
      await ctx.idle("Planned.");
      await settle();
      await ctx.rpc("wrapUp", { walkthroughId: ctx.walkthroughId });
      await ctx.idle("stopped");
      await settle();
      return ctx.sent.at(-1)!.text;
    };
    const understand = await wrap({ ...PLAN, intent: "understand" });
    expect(understand).toContain("Intent: understand");
    expect(understand).toContain("what the reader should now hold in their head");
    expect(understand).not.toContain("turning the todos into a plan");
    const own = await wrap(PLAN);
    expect(own).toContain("Intent: own-change");
    expect(own).toContain("turning the todos into a plan");
    const review = await wrap(PR_PLAN);
    expect(review).toContain("Intent: review");
    expect(review).toContain("already inline in the review draft");
  });
});

describe("review draft", () => {
  it("derives inline comments from included comment notes and merges worker drafts", async () => {
    const { rpc, tool, walkthroughId } = await planned({}, PR_PLAN);
    const included = await rpc("addNote", { walkthroughId, kind: "comment", text: "Guard this", groupIndex: 0, location: { path: "tts.ts", startLine: 3 } });
    expect(included.includeInReview).toBe(true);
    const excluded = await rpc("addNote", { walkthroughId, kind: "comment", text: "Maybe", groupIndex: 0, location: { path: "tts.ts", startLine: 4 }, includeInReview: false });
    expect(excluded.includeInReview).toBe(false);
    let { view } = await rpc("get", { walkthroughId });
    expect(view.reviewDraft).toMatchObject({ status: "draft", event: "COMMENT", comments: [{ body: "Guard this", line: 3, noteId: included.id }] });
    await tool("walkthrough_review", { body: "Overall fine", comments: [{ path: "x.ts", line: 1, body: "Worker thought" }] });
    ({ view } = await rpc("get", { walkthroughId }));
    expect(view.reviewDraft.body).toBe("Overall fine");
    expect(view.reviewDraft.comments.map((comment: { body: string }) => comment.body)).toEqual(["Worker thought", "Guard this"]);
    expect(view.walkthrough.review.comments).toHaveLength(1);
    await rpc("updateNote", { walkthroughId, noteId: excluded.id, includeInReview: true });
    await rpc("updateNote", { walkthroughId, noteId: included.id, includeInReview: false });
    ({ view } = await rpc("get", { walkthroughId }));
    expect(view.reviewDraft.comments.map((comment: { body: string }) => comment.body)).toEqual(["Worker thought", "Maybe"]);
    expect(String(JSON.stringify(await tool("walkthrough_status", {})))).toContain("Maybe");
  });

  it("has no review draft outside PR mode", async () => {
    const { rpc, walkthroughId } = await planned();
    await rpc("addNote", { walkthroughId, kind: "comment", text: "c", groupIndex: 0, location: { path: "tts.ts", startLine: 3 } });
    expect((await rpc("get", { walkthroughId })).view.reviewDraft).toBeNull();
  });

  it("no longer offers the review-notes mirror", async () => {
    const { rpc, walkthroughId, writes, harness } = await planned();
    await rpc("addNote", { walkthroughId, kind: "todo", text: "t", groupIndex: 0 });
    await settle();
    expect(writes).toEqual([]);
    expect((await rpc("get", { walkthroughId })).view.walkthrough.notesFile).toBeUndefined();
    await expect(rpc("setNotesFileEnabled", { walkthroughId, enabled: true })).rejects.toThrow();
    expect(harness.inspection.sdk.callsTo("files.write")).toHaveLength(0);
  });
});

describe("suggestions", () => {
  it("lets the answer turn refresh the follow-ups, and only then", async () => {
    const { rpc, tool, idle, view, walkthroughId, sent } = await planned();
    await idle("Planned.");
    await settle();
    await tool("walkthrough_write_part", PART);
    await idle("Done.");
    await settle();
    await tool("walkthrough_write_part", { ...PART, part: 2 });
    await idle("Done.");
    await settle();
    expect(String(JSON.stringify(await tool("walkthrough_suggest", { suggestions: ["Early?"] }).catch((error: Error) => error.message)))).toMatch(/only while answering/u);
    await rpc("ask", { walkthroughId, place: 0, question: "Why truncate?" });
    await settle();
    expect(sent.at(-1)!.text).toContain("walkthrough_suggest");
    await tool("walkthrough_suggest", { suggestions: ["What if the text is exactly 4,000?", "Who truncates the tail?"] });
    const exchange = (await view(walkthroughId)).walkthrough.parts[0].discussion[0];
    expect(exchange.suggestions).toEqual(["What if the text is exactly 4,000?", "Who truncates the tail?"]);
  });
});

describe("delivered instructions", () => {
  it("keeps every instruction text under BB's 4,096 character limit", async () => {
    const { harness } = await setup();
    const worker = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { role: "walkthrough-worker", walkthroughId: "wt_x" } }));
    const user = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    const texts = [worker.instructions, user.instructions, ...worker.tools.map((tool) => tool.instructions), ...user.tools.map((tool) => tool.instructions)].filter((text): text is string => typeof text === "string");
    expect(texts.length).toBeGreaterThanOrEqual(6);
    for (const text of texts) expect(text.length).toBeLessThan(4096);
    expect(worker.tools.map((tool) => tool.name)).toContain("walkthrough_suggest");
  });

  it("measures the open tool's description, its instructions and the skill the same way", () => {
    const skill = readFileSync(new URL("../skills/bb-walkthrough/SKILL.md", import.meta.url), "utf8");
    for (const text of [OPEN_DESCRIPTION, OPEN_INSTRUCTIONS, skill]) expect(text.length).toBeLessThan(4096);
  });

  it("routes explain-the-code requests, with no diff, to walkthrough_open", async () => {
    const { harness } = await setup();
    const user = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    const open = user.tools.find((tool) => tool.name === "walkthrough_open")!;
    const skill = readFileSync(new URL("../skills/bb-walkthrough/SKILL.md", import.meta.url), "utf8");
    for (const text of [open.description, open.instructions ?? "", skill]) {
      expect(text).toMatch(/walk me through how/iu);
      expect(text).toMatch(/existing code|nothing (has )?changed|clean working tree|no change/iu);
    }
    expect(open.instructions).toMatch(/instead of answering in chat/u);
  });

  it("says in the tool result whether the pane is already open beside the thread", async () => {
    const { tool } = await setup();
    const opened = await tool("walkthrough_open", { request: "Walk me through how the queue works" }, THREAD);
    expect(JSON.stringify(opened)).toContain("pane is open beside this thread now");
  });
});

describe("understand intent instructions", () => {
  it("asks for excerpts of the current code and keeps change-review language out of the plan and write instructions", () => {
    expect(PLAN_INSTRUCTIONS).toMatch(/understand[^.]*baseRef to HEAD/u);
    expect(PLAN_INSTRUCTIONS).toMatch(/Never use change-review words/u);
    expect(WRITE_PART_INSTRUCTIONS).toMatch(/understand walkthrough every code block is view "code"/u);
    expect(WRITE_PART_INSTRUCTIONS).toMatch(/Staged, unstaged, and untracked files are all current code/u);
  });
});
