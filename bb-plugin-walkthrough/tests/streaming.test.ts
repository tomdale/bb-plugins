import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_CHANNEL, type StreamPayload } from "../src/schemas.ts";
import { PLAN, setup, THREAD } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

const streamed = (harness: { realtimeSignals: Array<{ channel: string; payload: unknown }> }) =>
  harness.realtimeSignals.filter((signal) => signal.channel === STREAM_CHANNEL).map((signal) => signal.payload as StreamPayload);

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("streaming a request", () => {
  it("publishes the answer as it grows, snapshots it for a late client, and ends with a terminal state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let text: string | null = null;
    const { harness, rpc, tool, idle } = await setup({ agentText: () => text });
    const started = rpc("start", { threadId: THREAD, request: "" });
    await advance(1200);
    const { walkthroughId } = await started;
    await advance(200);
    await tool("walkthrough_plan", PLAN);
    await tool("walkthrough_write_part", { part: 1, blocks: [{ kind: "prose", text: "x" }], suggestions: [] });
    await idle("Done.");
    await advance(200);
    await tool("walkthrough_write_part", { part: 2, blocks: [{ kind: "prose", text: "y" }], suggestions: [] });
    await idle("Done.");
    await advance(200);
    const before = streamed(harness).length;
    await rpc("ask", { walkthroughId, place: 0, question: "Why?" });
    await advance(100);
    text = "Because the cap";
    await advance(300);
    const published = streamed(harness);
    expect(published.length).toBeGreaterThan(before);
    expect(published.at(-1)).toMatchObject({ walkthroughId, requestKind: "ask", place: 0, text: "Because the cap", state: "streaming" });
    expect((await rpc("streamSnapshot", { walkthroughId })).snapshot).toMatchObject({ requestKind: "ask", text: "Because the cap" });
    // The coarse save lets a reload show progress.
    const view = (await rpc("get", { walkthroughId })).view;
    expect(view.walkthrough.parts[0].discussion[0].answer).toBe("Because the cap");

    await idle("Because the cap bounds it.");
    await advance(300);
    expect(streamed(harness).at(-1)).toMatchObject({ walkthroughId, state: "done" });
    expect((await rpc("streamSnapshot", { walkthroughId })).snapshot).toBeNull();
    const count = streamed(harness).length;
    await advance(3000);
    expect(streamed(harness)).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes a cancelled state when the walkthrough is closed mid-stream and stops its timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let text: string | null = "Writing…";
    const { harness, rpc } = await setup({ agentText: () => text });
    const started = rpc("start", { threadId: THREAD, request: "" });
    await advance(1200);
    const { walkthroughId } = await started;
    await advance(500);
    expect(streamed(harness).at(-1)).toMatchObject({ requestKind: "plan", state: "streaming", text: "Writing…" });
    await rpc("close", { walkthroughId });
    await advance(300);
    expect(streamed(harness).at(-1)).toMatchObject({ walkthroughId, state: "cancelled", text: "Writing…" });
    text = null;
    await advance(3000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops every timer when the stream-tail service is aborted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { harness, rpc } = await setup({ agentText: () => "hi" });
    const service = harness.behavior.runService("stream-tail");
    const started = rpc("start", { threadId: THREAD, request: "" });
    await advance(1200);
    await started;
    await advance(300);
    service.controller.abort();
    await service.done;
    await advance(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
