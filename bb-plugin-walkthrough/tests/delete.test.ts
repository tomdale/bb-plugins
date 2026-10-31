import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGED_CHANNEL, STREAM_CHANNEL, type StreamPayload } from "../src/schemas.ts";
import { PLAN, setup, settle, THREAD, WORKER } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

const changed = (harness: { realtimeSignals: Array<{ channel: string; payload: unknown }> }) =>
  harness.realtimeSignals.filter((signal) => signal.channel === CHANGED_CHANNEL).map((signal) => signal.payload as { walkthroughId: string; reason: string });

/** A started walkthrough with a plan and one note. */
async function seeded(options: Parameters<typeof setup>[0] = {}) {
  const kit = await setup(options);
  const { walkthroughId } = await kit.rpc("start", { threadId: THREAD, request: "Walk me through it" });
  await settle();
  await kit.tool("walkthrough_plan", PLAN);
  await kit.idle("Planned.");
  await settle();
  await kit.rpc("addNote", { walkthroughId, kind: "todo", text: "Name the cap", groupIndex: 0 });
  return { ...kit, walkthroughId };
}

describe("deleting a walkthrough", () => {
  it("removes it and its notes, archives the helper, and tells open panes", async () => {
    const { rpc, view, harness, walkthroughId } = await seeded();
    expect(await rpc("delete", { walkthroughId })).toEqual({ deleted: true });
    expect(await view(walkthroughId)).toBeNull();
    expect((await rpc("recent", {})).walkthroughs).toEqual([]);
    expect((await rpc("list", { threadId: THREAD })).walkthroughs).toEqual([]);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toMatchObject([[{ threadId: WORKER }]]);
    expect(changed(harness).at(-1)).toEqual({ threadId: THREAD, walkthroughId, reason: "deleted" });
    await expect(rpc("updateNote", { walkthroughId, noteId: "n1", text: "x" })).rejects.toThrow();
  });

  it("keeps notes saved to the thread's storage", async () => {
    const { rpc, writes, harness, walkthroughId } = await seeded();
    harness.inspection.sdk.stub("threads.storageLocation", async () => ({ hostId: "host_1", storageRootPath: "/store/thr_user" }) as never);
    await rpc("saveNotes", { walkthroughId });
    expect(writes).toHaveLength(1);
    await rpc("delete", { walkthroughId });
    expect(writes).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("files.delete")).toEqual([]);
    expect(harness.inspection.sdk.callsTo("files.remove")).toEqual([]);
  });

  it("deleting again, or an id that never existed, does nothing", async () => {
    const { rpc, harness, walkthroughId } = await seeded();
    const [first, second] = await Promise.all([rpc("delete", { walkthroughId }), rpc("delete", { walkthroughId })]);
    expect([first.deleted, second.deleted].sort()).toEqual([false, true]);
    expect(await rpc("delete", { walkthroughId })).toEqual({ deleted: false });
    expect(await rpc("delete", { walkthroughId: "wt_never" })).toEqual({ deleted: false });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
  });

  it("still deletes when the helper thread is already gone", async () => {
    const { rpc, view, harness, walkthroughId } = await seeded();
    harness.inspection.sdk.stub("threads.archive", async () => {
      throw new Error("HTTP 404: no such thread");
    });
    harness.inspection.sdk.stub("threads.stop", async () => {
      throw new Error("HTTP 404: no such thread");
    });
    expect(await rpc("delete", { walkthroughId })).toEqual({ deleted: true });
    expect(await view(walkthroughId)).toBeNull();
  });

  it("stops a helper that is mid-write before archiving it, and nothing it does afterwards brings the walkthrough back", async () => {
    const { rpc, tool, idle, view, harness } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    // The plan request is in flight: the helper is writing.
    expect((await view(walkthroughId)).walkthrough.inFlight).not.toBeNull();
    await rpc("delete", { walkthroughId });
    const calls = harness.inspection.sdk.calls.map((call) => call.path);
    expect(calls.indexOf("threads.stop")).toBeGreaterThan(-1);
    expect(calls.indexOf("threads.stop")).toBeLessThan(calls.indexOf("threads.archive"));
    expect(await tool("walkthrough_plan", PLAN)).toMatchObject({ isError: true });
    await idle("late");
    await settle();
    expect(await view(walkthroughId)).toBeNull();
    expect((await rpc("recent", {})).walkthroughs).toEqual([]);
  });

  it("does not stop a helper of a finished walkthrough", async () => {
    const { rpc, harness, walkthroughId } = await seeded();
    await rpc("close", { walkthroughId });
    const stopped = harness.inspection.sdk.callsTo("threads.stop").length;
    await rpc("delete", { walkthroughId });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(stopped);
  });

  it("ends the stream follower with a cancelled payload and leaves no timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { harness, rpc } = await setup({ agentText: () => "Writing…" });
    const started = rpc("start", { threadId: THREAD, request: "" });
    await vi.advanceTimersByTimeAsync(1200);
    const { walkthroughId } = await started;
    await vi.advanceTimersByTimeAsync(400);
    await rpc("delete", { walkthroughId });
    await vi.advanceTimersByTimeAsync(400);
    const payloads = harness.realtimeSignals.filter((signal) => signal.channel === STREAM_CHANNEL).map((signal) => signal.payload as StreamPayload);
    expect(payloads.at(-1)).toMatchObject({ walkthroughId, state: "cancelled" });
    const count = payloads.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === STREAM_CHANNEL)).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
});
