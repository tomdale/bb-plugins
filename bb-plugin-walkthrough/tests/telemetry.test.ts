// The plugin's record of its own requests to the hidden worker: which model ran,
// how long the turn took, what it cost in tokens, and what the reader got. Nothing
// else in the plugin can answer those questions, so these tests pin the fields the
// measuring script reads.
import { describe, expect, it } from "vitest";
import type { RequestRun } from "../src/schemas.ts";
import { WalkthroughStore } from "../src/store.ts";
import { PLAN, setup, settle, THREAD } from "./helpers.ts";

/** The model the plugin pins. */
const LUNA = "vercel-ai-gateway/openai/gpt-6-luna";
/** The model production actually ran instead: the pair worth seeing in a record. */
const SOL = "vercel-ai-gateway/openai/gpt-6.1-sol";
const levels = (...efforts: string[]) => efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" }));
const catalog = () => ({ models: [{ id: LUNA, supportedReasoningEfforts: levels("low", "medium") }] });

/** Cumulative token counts, as the worker reports them after the turns given. */
const totals = (...turns: Array<{ input: number; cached: number; output: number }>) => {
  const sum = (pick: "input" | "cached" | "output") => turns.reduce((total, turn) => total + turn[pick], 0);
  return { inputTokens: sum("input"), cachedInputTokens: sum("cached"), outputTokens: sum("output"), totalTokens: sum("input") + sum("cached") + sum("output") };
};

/** What one helper turn leaves in the worker's log: the model that ran, the turn status, the usage after it. */
const turn = (cumulative: ReturnType<typeof totals>, extra: Array<{ type: string; data: unknown }> = []) => [
  { type: "client/turn/requested", data: { execution: { model: SOL, reasoningLevel: "high" } } },
  { type: "turn/completed", data: { status: "completed" } },
  { type: "thread/tokenUsage/updated", data: { tokenUsage: { total: cumulative } } },
  ...extra,
];

/** A log whose nth request is answered by the nth turn given; the last one repeats. */
const turns = (...logs: Array<Array<{ type: string; data: unknown }>>) => (turn: number) => logs[Math.min(turn, logs.length) - 1] ?? [];

const rows = (bb: unknown, id: string): RequestRun[] =>
  new WalkthroughStore((bb as { storage: { database: () => never } }).storage.database()).get(id)?.requests ?? [];

describe("the record of one request", () => {
  it("says which model actually ran, how long the turn took, what it cost, and what the reader got", async () => {
    const { bb, rpc, tool, idle } = await setup({ catalog, turnEvents: turns(turn(totals({ input: 1_200, cached: 800, output: 45 }))) });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();

    const [plan] = rows(bb, walkthroughId);
    expect(plan).toMatchObject({
      n: 1,
      kind: "plan",
      part: null,
      // The pin and the model the server ran are separate fields: a preference the
      // provider ignored is exactly what this record exists to show.
      askedModel: LUNA,
      askedReasoning: "medium",
      model: SOL,
      reasoning: "high",
      outcome: "planned",
      turnStatus: "completed",
      inputTokens: 1_200,
      cachedInputTokens: 800,
      outputTokens: 45,
      detail: null,
    });
    expect(plan!.settledAt).toBeGreaterThanOrEqual(plan!.sentAt);
    expect(plan!.ms).toBe(plan!.settledAt! - plan!.sentAt);
  }, 20_000);

  it("records what each request added, not the thread's running total", async () => {    const first = totals({ input: 1_000, cached: 0, output: 20 });
    const both = totals({ input: 1_000, cached: 0, output: 20 }, { input: 300, cached: 900, output: 60 });
    // The plan turn's usage, then the write the plan queued: its counts are the running total again.
    const { bb, rpc, tool, idle } = await setup({ turnEvents: turns(turn(first), turn(both)) });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    await idle("");
    await settle();

    const recorded = rows(bb, walkthroughId);
    // The plan queues both parts, so the second one is already in flight when the first ends.
    expect(recorded.map((run) => [run.kind, run.outcome])).toEqual([
      ["plan", "planned"],
      ["write", "empty"],
      ["write", null],
    ]);
    expect(recorded[0]).toMatchObject({ inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 20 });
    expect(recorded[1]).toMatchObject({ part: 0, inputTokens: 300, cachedInputTokens: 900, outputTokens: 60 });
    expect(recorded[2]).toMatchObject({ part: 1, settledAt: null, inputTokens: null });
  }, 20_000);

  it("prefers the payload's own per-turn reading over a difference of thread totals", async () => {
    // Measured on a real walkthrough: the second turn's `total` came back as the turn's own
    // numbers instead of the thread's, so a difference went negative and output was lost.
    const reset = [
      { type: "client/turn/requested", data: { execution: { model: SOL, reasoningLevel: "high" } } },
      { type: "turn/completed", data: { status: "completed" } },
      { type: "thread/tokenUsage/updated", data: { tokenUsage: { total: { inputTokens: 3, cachedInputTokens: 29_031, outputTokens: 28, totalTokens: 29_062 }, last: { inputTokens: 3, cachedInputTokens: 29_031, outputTokens: 28, totalTokens: 29_062 } } } },
    ];
    const { bb, rpc, tool, idle } = await setup({
      turnEvents: turns(
        turn(totals({ input: 3, cached: 27_721, output: 238 })),
        reset,
      ),
    });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    await idle("");
    await settle();

    const write = rows(bb, walkthroughId)[1];
    expect(write).toMatchObject({ kind: "write", inputTokens: 3, cachedInputTokens: 29_031, outputTokens: 28 });
  }, 20_000);

  it("records a turn that produced nothing, with the reason the reader was shown", async () => {
    const { bb, rpc, tool, idle } = await setup({ turnEvents: turns(turn(totals()), turn(totals())) });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    // No message and no arguments: the write tool refuses, so the part never commits.
    await tool("walkthrough_write_part", { part: 1 });
    await idle("");
    await settle();

    const write = rows(bb, walkthroughId)[1];
    expect(write).toMatchObject({ kind: "write", part: 0, outcome: "empty", detail: "This part could not be written." });
  }, 20_000);

  it("keeps the provider's error code beside the plugin's own reason", async () => {
    const failed = turn(totals({ input: 10, cached: 0, output: 0 }), [{ type: "provider/error", data: { code: "gateway_stream_timeout", message: "Provider error" } }]);
    const { bb, rpc, tool, idle } = await setup({ turnEvents: turns(turn(totals()), failed) });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    await tool("walkthrough_write_part", { part: 1 });
    await idle("");
    await settle();

    const write = rows(bb, walkthroughId)[1];
    expect(write).toMatchObject({
      outcome: "empty",
      turnStatus: "completed",
      model: SOL,
      detail: "This part could not be written. (gateway_stream_timeout)",
    });
  }, 20_000);

  it("records a request the walkthrough never saw end as abandoned, with the reason", async () => {
    const { bb, rpc } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    // The plan request is in flight: nothing has reported back yet.
    expect(rows(bb, walkthroughId).map((run) => run.settledAt)).toEqual([null]);

    await rpc("close", { walkthroughId });
    await settle();

    const recorded = rows(bb, walkthroughId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: "plan", outcome: "abandoned", detail: "This walkthrough was finished before the helper got to it." });
    expect(recorded[0]!.ms).toBeGreaterThanOrEqual(0);
  }, 20_000);

  it("keeps the record out of what the pane receives", async () => {
    const { rpc, tool, idle, view } = await setup({ turnEvents: turns(turn(totals({ input: 5, cached: 0, output: 1 }))) });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();

    const current = await view(walkthroughId);
    expect(current.walkthrough).not.toHaveProperty("requests");
    expect(current.walkthrough).not.toHaveProperty("usage");
  }, 20_000);
});
