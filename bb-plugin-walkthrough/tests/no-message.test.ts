// The commit path when the helper never wrote a streamed message: the plugin
// saves from the tool arguments, and the result is the same walkthrough.
import { describe, expect, it } from "vitest";
import { PLAN, setup, settle, THREAD } from "./helpers.ts";

const patch = "--- a/src/upload.ts\n+++ b/src/upload.ts\n@@ -1 +1 @@\n-old\n+new\n";
const readCode = () => ({ path: "src/upload.ts", patch, truncated: false, sides: { old: { path: "src/upload.ts", content: "old\n" }, new: { path: "src/upload.ts", content: "new\n" } } });

describe("a helper that passes content as tool arguments", () => {
  it("is nudged once with the exact format when it passes none, then commits the arguments with snapshot, suggestions and intent", async () => {
    const { rpc, tool, view } = await setup({ readCode });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Walk me through the retry" });
    await settle();
    const { introduction, ...bare } = PLAN;

    // The cheap failure: no message, no content. It costs nothing to save and says exactly what to do.
    const nudged = JSON.stringify(await tool("walkthrough_plan", { ...bare, intent: "understand", baseRef: "HEAD" }));
    expect(nudged).toContain("isError\":true");
    expect(nudged).toContain("<!-- walkthrough:start -->");
    expect(nudged).toContain("Reasoning is not a message");
    expect((await view(walkthroughId)).walkthrough.parts).toEqual([]);

    // The fallback: content in arguments is never thrown away.
    expect(await tool("walkthrough_plan", { ...PLAN, intent: "understand", baseRef: "HEAD" })).toContain("Planned");
    const written = await tool("walkthrough_write_part", {
      part: 1,
      blocks: [{ kind: "prose", text: "The loop stops after [three tries](line:1)." }, { kind: "code", caption: "The loop", path: "src/upload.ts", startLine: 1, endLine: 1, view: "diff", notes: [{ line: 1, text: "Capped." }] }],
      suggestions: ["What if send throws?", "Is the cap configurable?"],
    });
    expect(written).toBe("Part 1 is on the page.");
    const current = (await view(walkthroughId)).walkthrough;
    expect(current.intent).toBe("understand");
    expect(current.introduction).toBe(introduction);
    expect(current.parts[0]).toMatchObject({ status: "ready", suggestions: ["What if send throws?", "Is the cap configurable?"] });
    expect(current.parts[0].blocks[1].snapshot.after).toContain("new");
    expect(current.parts[0].blocks[1].notes).toEqual([{ line: 1, text: "Capped." }]);
  }, 20_000);

  it("is told to plan first when it writes a part before a plan exists", async () => {
    const rows = [{ seq: 101, itemId: "m", delta: "<!-- walkthrough:start -->\n```walkthrough\npath: a.ts\nlines: 1\n```\n" }];
    const { rpc, tool } = await setup({ deltas: () => rows });
    await rpc("start", { threadId: THREAD, request: "x" });
    await settle();
    expect(JSON.stringify(await tool("walkthrough_write_part", { part: 1 }))).toContain("never call it in parallel");
  }, 20_000);
});

describe("the helper's model decides how content is delivered", () => {
  const asks = async (model: string | null) => {
    const userTurns = () => (model === null ? [] : [{ seq: 5, type: "client/turn/requested", data: { execution: { model } } }]);
    const { rpc, sent } = await setup({ userTurns });
    await rpc("start", { threadId: THREAD, request: "Walk me through this" });
    await settle();
    return sent[0]!.text;
  };

  it("asks a model that skips the streamed message to pass arguments, and everyone else to stream", async () => {
    expect(await asks("vercel-ai-gateway/anthropic/claude-sonnet-5.5")).toContain("Delivery for this session");
    for (const model of ["vercel-ai-gateway/anthropic/claude-opus-5.5", "vercel-ai-gateway/openai/gpt-6-luna", null]) {
      const text = await asks(model);
      expect(text).not.toContain("Delivery for this session");
      expect(text).toContain("you must write it before calling any walkthrough tool");
    }
  }, 20_000);
});
