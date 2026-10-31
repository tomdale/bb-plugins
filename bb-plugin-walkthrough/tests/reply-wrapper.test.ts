import { afterEach, describe, expect, it, vi } from "vitest";
import { stripReplyWrapper } from "../src/reply-wrapper.ts";
import { STREAM_CHANNEL, type StreamPayload } from "../src/schemas.ts";
import { WORKER_GUIDE } from "../src/worker.ts";
import { PLAN, setup, THREAD } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

describe("stripReplyWrapper", () => {
  it("removes the wrapper with its attributes and closer", () => {
    expect(stripReplyWrapper(':::reply{state="complete" kind="answer"}\nBecause the cap.\n:::')).toBe("Because the cap.");
    expect(stripReplyWrapper('::::reply{state="review"}\nOne.\n\n:::\nTwo.\n::::')).toBe("One.\n\n:::\nTwo.");
    expect(stripReplyWrapper(':::reply\n:::reply{kind="answer"}\nNested.\n:::\n:::')).toBe("Nested.");
  });

  it("leaves ordinary text alone, including colons and a lone fence", () => {
    for (const text of ["Plain answer.", "Note: this :::reply is mid-line", ":: two colons\nmore", "```\n:::\n```", ""]) expect(stripReplyWrapper(text)).toBe(text);
  });

  it("shows nothing while the opener is still being written, then the text as it grows, never the closer", () => {
    const whole = ':::reply{state="complete" kind="answer"}\nBecause the cap bounds it.\n:::';
    const shown = Array.from({ length: whole.length + 1 }, (_, length) => stripReplyWrapper(whole.slice(0, length)));
    expect(shown.slice(0, 40).every((text) => text === "")).toBe(true);
    for (const text of shown) expect(text).not.toMatch(/:::|reply\{/u);
    expect(shown.at(-1)).toBe("Because the cap bounds it.");
    // Every step extends the previous one: the visible text only grows.
    for (let index = 1; index < shown.length; index += 1) expect(shown[index]!.startsWith(shown[index - 1]!)).toBe(true);
  });
});

describe("answers are stored and streamed without the reply wrapper", () => {
  it("tells the helper not to use reply blocks", () => {
    expect(WORKER_GUIDE).toMatch(/never wrap[^.]*:::reply/iu);
  });

  it("saves a clean answer and streams clean text", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const wrapped = (body: string) => `:::reply{state="complete" kind="answer"}\n${body}\n:::`;
    let text: string | null = null;
    const { harness, rpc, tool, idle } = await setup({ agentText: () => text });
    const started = rpc("start", { threadId: THREAD, request: "" });
    await vi.advanceTimersByTimeAsync(1200);
    const { walkthroughId } = await started;
    await vi.advanceTimersByTimeAsync(200);
    await tool("walkthrough_plan", PLAN);
    await tool("walkthrough_write_part", { part: 1, blocks: [{ kind: "prose", text: "x" }], suggestions: [] });
    await idle("Done.");
    await vi.advanceTimersByTimeAsync(200);
    await tool("walkthrough_write_part", { part: 2, blocks: [{ kind: "prose", text: "y" }], suggestions: [] });
    await idle("Done.");
    await vi.advanceTimersByTimeAsync(200);
    await rpc("ask", { walkthroughId, place: 0, question: "Why?" });
    await vi.advanceTimersByTimeAsync(100);
    text = wrapped("Because the cap");
    await vi.advanceTimersByTimeAsync(300);
    const payloads = harness.realtimeSignals.filter((signal) => signal.channel === STREAM_CHANNEL).map((signal) => signal.payload as StreamPayload);
    expect(payloads.at(-1)!.text).toBe("Because the cap");
    expect(payloads.filter((payload) => payload.requestKind === "ask").every((payload) => !/:::|reply\{/u.test(payload.text))).toBe(true);
    expect((await rpc("streamSnapshot", { walkthroughId })).snapshot.text).toBe("Because the cap");
    expect((await rpc("get", { walkthroughId })).view.walkthrough.parts[0].discussion[0].answer).toBe("Because the cap");

    // The final message comes from the stored events; its wrapper is stripped the same way.
    await idle(wrapped("ignored"));
    await vi.advanceTimersByTimeAsync(300);
    expect((await rpc("get", { walkthroughId })).view.walkthrough.parts[0].discussion[0]).toMatchObject({ answer: "Because the cap", status: "done" });
  });
});
