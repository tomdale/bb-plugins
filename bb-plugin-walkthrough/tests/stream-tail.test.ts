import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamPayload } from "../src/schemas.ts";
import { MAX_STREAM_TEXT, PERSIST_EVERY_MS, POLL_MAX_MS, PUBLISH_MIN_MS, StreamTail, type DeltaRow, type TailTarget } from "../src/stream-tail.ts";

/** A fake worker thread: deltas appended over time, read back in pages after a seq. */
function fakeWorker() {
  const rows: DeltaRow[] = [];
  let seq = 100;
  let reads = 0;
  return {
    rows,
    get reads() {
      return reads;
    },
    emit(delta: string, itemId = "i1") {
      seq += 1;
      rows.push({ seq, itemId, delta });
    },
    readDeltas: async (_thread: string, afterSeq: number) => {
      reads += 1;
      return rows.filter((row) => row.seq > afterSeq).slice(0, 100);
    },
  };
}

const target = (overrides: Partial<TailTarget> = {}): TailTarget => ({
  walkthroughId: "wt_1",
  workerThreadId: "thr_w",
  request: { kind: "write", part: 1 },
  afterSeq: 100,
  sentAt: 1,
  ...overrides,
});

function harness() {
  const worker = fakeWorker();
  const published: Array<StreamPayload & { at: number }> = [];
  const persisted: string[] = [];
  const tail = new StreamTail({
    readDeltas: worker.readDeltas,
    publish: (payload) => published.push({ ...payload, at: Date.now() }),
    persist: (_target, text) => persisted.push(text),
  });
  return { worker, published, persisted, tail };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("StreamTail", () => {
  it("publishes the full text within 150 ms of a delta", async () => {
    const { worker, published, tail } = harness();
    tail.track(target());
    await vi.advanceTimersByTimeAsync(10);
    const emittedAt = Date.now();
    worker.emit("Hello ");
    await vi.advanceTimersByTimeAsync(150);
    expect(published).toHaveLength(1);
    expect(published[0]!.at - emittedAt).toBeLessThanOrEqual(150);
    expect(published[0]).toMatchObject({ walkthroughId: "wt_1", requestKind: "write", place: 1, text: "Hello ", state: "streaming", seq: 101 });
    worker.emit("world");
    await vi.advanceTimersByTimeAsync(150);
    expect(published.at(-1)!.text).toBe("Hello world");
    tail.dispose();
  });

  it("throttles bursts to one publish per window even when poked constantly", async () => {
    const { worker, published, tail } = harness();
    tail.track(target());
    await vi.advanceTimersByTimeAsync(5);
    for (let n = 0; n < 60; n += 1) {
      worker.emit(`w${n} `);
      tail.poke("wt_1");
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(published.length).toBeGreaterThan(3);
    for (let n = 1; n < published.length; n += 1) {
      expect(published[n]!.at - published[n - 1]!.at).toBeGreaterThanOrEqual(PUBLISH_MIN_MS);
      expect(published[n]!.seq).toBeGreaterThanOrEqual(published[n - 1]!.seq);
    }
    expect(published.at(-1)!.text.endsWith("w59 ")).toBe(true);
    tail.dispose();
  });

  it("backs off while the worker is quiet, then answers quickly to a poke", async () => {
    const { worker, tail } = harness();
    tail.track(target());
    await vi.advanceTimersByTimeAsync(3000);
    const quietReads = worker.reads;
    expect(quietReads).toBeLessThan(3000 / 120);
    expect(quietReads).toBeGreaterThan(3000 / (POLL_MAX_MS + 50));
    worker.emit("x");
    tail.poke("wt_1");
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.reads).toBeGreaterThan(quietReads);
    tail.dispose();
  });

  it("publishes the markup message, not a later commentary message", async () => {
    const { worker, published, tail } = harness();
    tail.track(target());
    worker.emit("Intro.\n\n```walkthrough\npath: a.ts\n```\n", "markup");
    await vi.advanceTimersByTimeAsync(130);
    worker.emit("Done.", "after");
    await vi.advanceTimersByTimeAsync(130);
    expect(published.at(-1)!.text).toContain("```walkthrough");
    tail.dispose();
  });

  it("publishes the latest message for an answer, saving it at a coarse cadence", async () => {
    const { worker, published, persisted, tail } = harness();
    tail.track(target({ request: { kind: "ask", place: "wrap-up", exchangeId: "e1" } }));
    worker.emit("Let me look.", "a");
    await vi.advanceTimersByTimeAsync(130);
    worker.emit("The answer ", "b");
    await vi.advanceTimersByTimeAsync(130);
    worker.emit("is here.", "b");
    await vi.advanceTimersByTimeAsync(130);
    expect(published.at(-1)).toMatchObject({ requestKind: "ask", place: "wrap-up", text: "The answer is here." });
    expect(persisted.length).toBe(1);
    await vi.advanceTimersByTimeAsync(PERSIST_EVERY_MS + 200);
    worker.emit(" More.", "b");
    await vi.advanceTimersByTimeAsync(200);
    expect(persisted.length).toBe(2);
    tail.dispose();
  });

  it("drains and publishes a terminal payload on finish, then stops polling", async () => {
    const { worker, published, tail } = harness();
    tail.track(target());
    worker.emit("Almost");
    await vi.advanceTimersByTimeAsync(130);
    worker.emit(" there.");
    await tail.finish("wt_1", "failed");
    expect(published.at(-1)).toMatchObject({ text: "Almost there.", state: "failed" });
    expect(tail.active).toEqual([]);
    const reads = worker.reads;
    await vi.advanceTimersByTimeAsync(2000);
    expect(worker.reads).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes a terminal payload for a cancelled request that wrote nothing, but stays quiet for a silent success", async () => {
    const { published, tail } = harness();
    tail.track(target());
    await tail.finish("wt_1", "done");
    expect(published).toEqual([]);
    tail.track(target({ sentAt: 2 }));
    await tail.finish("wt_1", "cancelled");
    expect(published).toEqual([expect.objectContaining({ state: "cancelled", text: "" })]);
  });

  it("follows several walkthroughs at once and keeps them apart", async () => {
    const { worker, published, tail } = harness();
    const other = fakeWorker();
    const mixed = new StreamTail({
      readDeltas: (thread, after) => (thread === "thr_w" ? worker.readDeltas(thread, after) : other.readDeltas(thread, after)),
      publish: (payload) => published.push({ ...payload, at: Date.now() }),
    });
    mixed.track(target());
    mixed.track(target({ walkthroughId: "wt_2", workerThreadId: "thr_o", request: { kind: "plan" } }));
    worker.emit("one");
    other.emit("two");
    await vi.advanceTimersByTimeAsync(200);
    expect(published.filter((p) => p.walkthroughId === "wt_1").at(-1)).toMatchObject({ text: "one", requestKind: "write" });
    expect(published.filter((p) => p.walkthroughId === "wt_2").at(-1)).toMatchObject({ text: "two", requestKind: "plan", place: 0 });
    await mixed.finish("wt_1", "done");
    expect(mixed.active).toEqual(["wt_2"]);
    mixed.dispose();
    tail.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts cleanly when a new request replaces the one being followed, and does not leak timers on repeated tracking", async () => {
    const { worker, published, tail } = harness();
    for (let n = 0; n < 5; n += 1) tail.track(target());
    expect(vi.getTimerCount()).toBe(1);
    worker.emit("first");
    await vi.advanceTimersByTimeAsync(130);
    tail.track(target({ sentAt: 2, afterSeq: 101, request: { kind: "write", part: 2 } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(published.some((p) => p.state === "cancelled" && p.place === 1)).toBe(true);
    worker.emit("second");
    await vi.advanceTimersByTimeAsync(200);
    expect(published.at(-1)).toMatchObject({ place: 2, text: "second", state: "streaming" });
    tail.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps the text it holds and publishes", async () => {
    const { worker, published, tail } = harness();
    tail.track(target());
    for (let n = 0; n < 5; n += 1) worker.emit("x".repeat(MAX_STREAM_TEXT / 2));
    await vi.advanceTimersByTimeAsync(200);
    expect(published.at(-1)!.text.length).toBe(MAX_STREAM_TEXT);
    tail.dispose();
  });

  it("survives a failing read and keeps following", async () => {
    const worker = fakeWorker();
    let fail = true;
    const published: StreamPayload[] = [];
    const tail = new StreamTail({
      readDeltas: async (thread, after) => {
        if (fail) throw new Error("boom");
        return worker.readDeltas(thread, after);
      },
      publish: (payload) => published.push(payload),
    });
    tail.track(target());
    await vi.advanceTimersByTimeAsync(300);
    fail = false;
    worker.emit("ok");
    await vi.advanceTimersByTimeAsync(400);
    expect(published.at(-1)?.text).toBe("ok");
    tail.dispose();
  });

  it("answers a snapshot from the stored events when nothing is being followed", async () => {
    const { worker, tail } = harness();
    worker.emit("Before ");
    worker.emit("the join.");
    expect(await tail.snapshot(target())).toMatchObject({ text: "Before the join.", state: "streaming", seq: 102, place: 1 });
    expect(await tail.snapshot(target({ request: { kind: "reply", text: "x" } }))).toBeNull();
  });
});
