import { describe, expect, it } from "vitest";
import { START_MARKER } from "../src/stream-markup.ts";
import { committedMessage } from "../src/stream-commit.ts";
import { PLAN, setup, settle, THREAD } from "./helpers.ts";

const CONTENT = [
  "Before this change, requests had no limit.",
  "",
  "The queue now holds [a cap](line:3) on pending jobs.",
  "",
  "```walkthrough",
  "part: 1",
  "```",
  "",
  "Each job waits in [the queue](line:3).",
  "",
  "```walkthrough",
  "path: tts.ts",
  "lines: 1-10",
  "view: code",
  "caption: The cap, in tts.ts",
  "note 3: Truncates here.",
  "```",
  "",
  "```walkthrough",
  "suggestions:",
  "Why 4,000?",
  "What if it is exactly 4,000?",
  "```",
].join("\n");
/** What the helper wrote: chatter, the marker, the content, chatter. */
const MESSAGE = ["Now let me set up the walkthrough plan.", START_MARKER, CONTENT, "", "Done, part 1 committed."].join("\n");

describe("committedMessage", () => {
  it("splits the introduction from part 1 and reads figures and suggestions", () => {
    const message = committedMessage(CONTENT);
    expect(message.introduction).toBe("Before this change, requests had no limit.\n\nThe queue now holds [a cap](line:3) on pending jobs.");
    expect(message.blocks).toEqual([
      { kind: "prose", text: "Each job waits in [the queue](line:3)." },
      { kind: "code", caption: "The cap, in tts.ts", path: "tts.ts", startLine: 1, endLine: 10, view: "code", notes: [{ line: 3, text: "Truncates here." }] },
    ]);
    expect(message.suggestions).toEqual(["Why 4,000?", "What if it is exactly 4,000?"]);
    expect(message.dropped).toEqual([]);
  });

  it("takes the whole message as the part when there is no part marker, and a caption from the path", () => {
    const message = committedMessage("Text.\n\n```walkthrough\npath: a.ts\nlines: 5\n```");
    expect(message.introduction).toBe("");
    expect(message.blocks).toEqual([{ kind: "prose", text: "Text." }, { kind: "code", caption: "a.ts", path: "a.ts", startLine: 5, endLine: 5, notes: [] }]);
  });

  it("drops a figure without a path or lines and says so, and never throws on garbage", () => {
    const message = committedMessage("Prose.\n\n```walkthrough\ncaption: Nothing to show\n```\n");
    expect(message.blocks).toEqual([{ kind: "prose", text: "Prose." }]);
    expect(message.dropped).toHaveLength(1);
    expect(committedMessage("```walkthrough\n")).toMatchObject({ blocks: [], suggestions: [] });
    expect(committedMessage("")).toMatchObject({ blocks: [], introduction: "" });
  });
});

describe("saving what the streamed message said", () => {
  it("plans from the message's introduction and writes part 1 from the same message, with no content in the tool calls", async () => {
    const patch = "--- a/tts.ts\n+++ b/tts.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const readCode = () => ({ path: "tts.ts", patch, truncated: false, sides: { old: { path: "tts.ts", content: "old\n" }, new: { path: "tts.ts", content: "new\n" } } });
    const { rpc, tool, view } = await setup({ agentText: () => MESSAGE, readCode });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Walk me through this" });
    await settle();
    const { introduction: _omitted, ...withoutIntroduction } = PLAN;
    expect(await tool("walkthrough_plan", withoutIntroduction)).toContain("with just part: 1");
    expect(await tool("walkthrough_write_part", { part: 1 })).toBe("Part 1 is on the page.");
    const current = (await view(walkthroughId)).walkthrough;
    expect(current.introduction).toContain("a cap");
    expect(current.parts[0]).toMatchObject({ status: "ready", suggestions: ["Why 4,000?", "What if it is exactly 4,000?"] });
    expect(current.parts[0].blocks.map((block: any) => block.kind)).toEqual(["prose", "code"]);
    expect(current.parts[0].blocks[1]).toMatchObject({ view: "code", path: "tts.ts" });
  });

  it("still takes explicit blocks, and says what is missing when there is no message to read", async () => {
    const { rpc, tool, view } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "x" });
    await settle();
    const { introduction: _omitted, ...withoutIntroduction } = PLAN;
    const failed = await tool("walkthrough_plan", withoutIntroduction);
    // The error teaches the whole format, so the helper can write its message and retry in the same turn.
    expect(JSON.stringify(failed)).toContain("There is no walkthrough message earlier in this turn");
    expect(JSON.stringify(failed)).toContain(START_MARKER);
    expect(JSON.stringify(failed)).toContain("part: 1");
    await tool("walkthrough_plan", PLAN);
    const missing = await tool("walkthrough_write_part", { part: 1 });
    expect(JSON.stringify(missing)).toContain("There is no walkthrough message earlier in this turn");
    expect(JSON.stringify(missing)).toContain("with only the part number");
    expect(await tool("walkthrough_write_part", { part: 1, blocks: [{ kind: "prose", text: "Explicit." }], suggestions: ["Q?"] })).toBe("Part 1 is on the page.");
    expect((await view(walkthroughId)).walkthrough.parts[0].blocks).toEqual([{ kind: "prose", text: "Explicit." }]);
  }, 20_000);
});

describe("a plan-turn message without the part: 1 fence", () => {
  const PROSE = "Before this change nothing retried.\n\nNow uploads try three times.";
  const FIGURE = "```walkthrough\npath: tts.ts\nlines: 1-10\nview: code\ncaption: The cap\n```";
  const SUGGESTIONS = "```walkthrough\nsuggestions:\nWhy 4,000?\n```";

  it("takes the prose before the first code block as the introduction and the rest as part 1", () => {
    const message = committedMessage(`${PROSE}\n\n${FIGURE}\n\nThe cap is [here](line:3).\n\n${SUGGESTIONS}`, "plan");
    expect(message.introduction).toBe(PROSE);
    expect(message.blocks.map((block) => block.kind)).toEqual(["code", "prose"]);
    expect(message.suggestions).toEqual(["Why 4,000?"]);
  });

  it("keeps a write turn's whole message as the part, and an explicit fence wins in a plan turn", () => {
    expect(committedMessage(`${PROSE}\n\n${FIGURE}`, "write")).toMatchObject({ introduction: "" });
    expect(committedMessage(`${PROSE}\n\n\`\`\`walkthrough\npart: 1\n\`\`\`\n\n${FIGURE}`, "plan").introduction).toBe(PROSE);
  });

  it("commits through the tools, and names the missing introduction when the message has only part 1", async () => {
    const rows: Array<{ seq: number; itemId: string; delta: string }> = [];
    let seq = 100;
    const say = (text: string) => rows.push({ seq: (seq += 1), itemId: `m${seq}`, delta: text });
    const { rpc, tool, view } = await setup({ deltas: () => rows });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "x" });
    await settle();
    const { introduction: _omitted, ...withoutIntroduction } = PLAN;
    say(`${START_MARKER}\n${FIGURE}\n\n${SUGGESTIONS}`);
    expect(JSON.stringify(await tool("walkthrough_plan", withoutIntroduction))).toContain("Your message has no introduction");
    say(`${START_MARKER}\n${PROSE}\n\n${FIGURE}\n\n${SUGGESTIONS}`);
    await tool("walkthrough_plan", withoutIntroduction);
    expect(await tool("walkthrough_write_part", { part: 1 })).toContain("Part 1 is on the page");
    const current = (await view(walkthroughId)).walkthrough;
    expect(current.introduction).toBe(PROSE);
    expect(current.parts[0].blocks.map((block: { kind: string }) => block.kind)).toEqual(["code"]);
  }, 20_000);
});
