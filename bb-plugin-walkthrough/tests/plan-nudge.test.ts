// A plan turn that ends with the walkthrough written but no tool call: some
// models stop there whatever the instructions say (docs/latency.md). The plugin
// asks once more for the calls alone, saving the message it already wrote, and
// fails visibly rather than waiting forever if that comes back empty too.
import { describe, expect, it } from "vitest";
import { PLAN, setup, settle, THREAD } from "./helpers.ts";

const patch = "--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n";
const readCode = () => ({ path: "src/retry.ts", patch, truncated: false, sides: { old: { path: "src/retry.ts", content: "old\n" }, new: { path: "src/retry.ts", content: "new\n" } } });

/** What a helper streams in a plan turn: the introduction, the part: 1 fence, part 1 and its suggestions. */
const STREAMED = [
  "<!-- walkthrough:start -->",
  "Before this change a failed upload stopped. Now [it is retried](line:2), and the loop gives up after a cap.",
  "",
  "```walkthrough",
  "part: 1",
  "```",
  "",
  "The loop counts attempts and [stops at three](line:3).",
  "",
  "```walkthrough",
  "path: src/retry.ts",
  "lines: 1-3",
  "view: diff",
  "caption: The retry loop, in retry.ts",
  "note 2: The old loop never stopped.",
  "```",
  "",
  "```walkthrough",
  "suggestions:",
  "What happens on the fourth failure?",
  "Why three?",
  "```",
  "",
].join("\n");

describe("a plan turn that wrote the walkthrough but called nothing", () => {
  it("asks once more for the calls, without showing the raw markup", async () => {
    const { rpc, idle, sent, view } = await setup({ readCode });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Walk me through it" });
    await settle();
    await idle(STREAMED);
    await settle();

    const current = (await view(walkthroughId)).walkthrough;
    expect(current.status).toBe("planning");
    expect(current.message).toBeNull();
    expect(current.parts).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("walkthrough_plan was never called");
    expect(sent[1]!.text).toContain("Do not write another message");
  }, 20_000);

  it("saves the message it already wrote when the second ask calls the tools", async () => {
    const { rpc, tool, idle, view } = await setup({ readCode });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Walk me through it" });
    await settle();
    await idle(STREAMED);
    await settle();

    // The nudge turn calls the tools with no message and no content: both come from the saved message.
    const { introduction: _left, ...bare } = PLAN;
    expect(await tool("walkthrough_plan", { ...bare, intent: "understand", baseRef: "HEAD" })).toContain("Planned");
    expect(await tool("walkthrough_write_part", { part: 1 })).toBe("Part 1 is on the page.");
    await idle("Done.");
    await settle();

    const current = (await view(walkthroughId)).walkthrough;
    expect(current.status).toBe("reading");
    expect(current.introduction).toBe("Before this change a failed upload stopped. Now [it is retried](line:2), and the loop gives up after a cap.");
    expect(current.parts[0]).toMatchObject({ status: "ready", suggestions: ["What happens on the fourth failure?", "Why three?"] });
    expect(current.parts[0]!.blocks.map((block: { kind: string }) => block.kind)).toEqual(["prose", "code"]);
    expect(current.streamedPlan).toBeNull();
  }, 20_000);

  it("fails visibly when the second ask writes nothing either", async () => {
    const { rpc, idle, sent, view } = await setup({ readCode });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Walk me through it" });
    await settle();
    await idle(STREAMED);
    await settle();
    await idle("I have written the walkthrough.");
    await settle();

    const current = (await view(walkthroughId)).walkthrough;
    expect(current.status).toBe("failed");
    expect(current.message).toBe("The helper wrote the walkthrough but never saved it.");
    // One nudge, never a loop.
    expect(sent).toHaveLength(2);
  }, 20_000);

  it("leaves a helper's question alone: a turn with no walkthrough written is not nudged", async () => {
    const { rpc, idle, sent, view } = await setup({ readCode });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await idle("Do you want a PR review or a local walkthrough?");
    await settle();

    const current = (await view(walkthroughId)).walkthrough;
    expect(current.status).toBe("planning");
    expect(current.message).toContain("PR review or a local walkthrough");
    expect(sent).toHaveLength(1);
  }, 20_000);
});
