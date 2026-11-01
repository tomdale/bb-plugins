// The plan turn end to end through the real service and the fake host: what the
// helper writes as its streamed message, what it passes to the tools, and what
// the walkthrough holds afterwards. These are the checks that decide whether a
// reader ever gets a part, so they run without a model at all.
import { messageText } from "../fixtures/load.ts";
import { scoreFormat } from "../scorer/format-score.ts";
import { PLAN, settle, setup, THREAD } from "../../tests/helpers.ts";
import { equal, ok } from "./expect.ts";
import type { Check } from "./check.ts";

const REQUEST = "Give me a walkthrough of my uncommitted changes in this repo (staged and unstaged).";

/** A diff the fake host serves for every excerpt, so a code block commits with a snapshot. */
const readCode = () => ({
  path: "src/retry.ts",
  patch: "--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old\n+new\n",
  truncated: false,
  sides: { old: { path: "src/retry.ts", content: "old\n" }, new: { path: "src/retry.ts", content: "new\n" } },
});

const parts = [
  { title: "Retry gets a ceiling", summary: "The cap and the error it throws", locations: [{ path: "src/retry.ts", startLine: 1, endLine: 6 }] },
  { title: "The queue stops swallowing the drain", summary: "drain records the failure", locations: [{ path: "src/queue.ts", startLine: 1, endLine: 30 }] },
  { title: "The test that pins the cap", summary: "One test", locations: [] },
];

const deltasFrom = (text: string) => () => [{ seq: 101, itemId: "m1", delta: text }];

export const streamedMessageChecks: Check[] = [
  {
    name: "streamed message: plan and write commit part 1 from the message",
    async run() {
      const message = messageText("recorded-plan-deepseek-v4.1-flash-1017-a.md");
      const { rpc, tool, view } = await setup({ readCode, deltas: deltasFrom(message) });
      const { walkthroughId } = await rpc("start", { threadId: THREAD, request: REQUEST });
      await settle();
      // No introduction argument: the plan takes it from the message the reader watched.
      const planned = await tool("walkthrough_plan", { mode: "local", intent: "own-change", title: "Retrying uploads", baseRef: "HEAD", includeUncommitted: true, parts });
      ok(!String(planned).includes("isError"), `the plan succeeded: ${String(planned)}`);
      equal(await tool("walkthrough_write_part", { part: 1 }), "Part 1 is on the page.", "part 1 commits from the message");

      const walkthrough = (await view(walkthroughId)).walkthrough;
      const part = walkthrough.parts[0];
      ok(walkthrough.introduction.startsWith("Before this change"), `the introduction came from the message: ${JSON.stringify(walkthrough.introduction.slice(0, 80))}`);
      ok(!walkthrough.introduction.includes("```walkthrough"), "the introduction stops before the part fence");
      equal(part.status, "ready", "part 1 status");
      equal(part.blocks.map((block: { kind: string }) => block.kind), ["prose", "code"], "the message's blocks");
      equal(part.blocks[1].path, "src/retry.ts", "the code block's path");
      equal([part.blocks[1].startLine, part.blocks[1].endLine], [1, 46], "the code block's lines");
      ok(part.blocks[1].snapshot?.after?.includes("new"), "the code block kept its snapshot");
      equal(part.suggestions.length, 3, "the message's suggestions");
      equal(part.suggestions[0], "Why call onAttempt before the sleep rather than after a failure settles?", "first suggestion");
      ok(typeof walkthrough.timing?.part1Ready === "number", "part 1 ready was timed");
      return `${walkthrough.introduction.length} char introduction, ${part.blocks.length} blocks`;
    },
  },
  {
    // Recorded behaviour of a helper that writes the message and ends its turn
    // without calling walkthrough_plan (deepseek-v4.1-flash-1017 and
    // deepseek-v4.1-flash, docs/latency.md). The plugin asks once more for the
    // calls alone and keeps the message out of sight meanwhile; a second empty
    // turn fails the walkthrough instead of leaving the pane waiting.
    name: "streamed message: a plan turn without walkthrough_plan asks once, then fails",
    async run() {
      const message = messageText("recorded-plan-deepseek-v4.1-flash-1017-a.md");
      const { rpc, idle, sent, view } = await setup({ readCode, deltas: deltasFrom(message) });
      const { walkthroughId } = await rpc("start", { threadId: THREAD, request: REQUEST });
      await settle();
      equal(sent.length, 1, "the plan request goes out once");

      await idle(message);
      await settle();
      const nudged = (await view(walkthroughId)).walkthrough;
      equal(
        { status: nudged.status, parts: nudged.parts.length, message: nudged.message, retry: nudged.inFlight?.request },
        { status: "planning", parts: 0, message: null, retry: { kind: "plan", retry: true } },
        "the walkthrough after a plan turn that called no tool",
      );
      equal(sent.length, 2, "the plugin asks once more");
      ok(sent[1].text.includes("walkthrough_plan was never called"), "the second ask names what is missing");
      ok(sent[1].text.includes("Do not write another message"), "the second ask spends its turn on the calls alone");

      await idle("I have written the walkthrough.");
      await settle();
      const failed = (await view(walkthroughId)).walkthrough;
      equal(failed.status, "failed", "a second empty turn fails the walkthrough");
      equal(failed.message, "The helper wrote the walkthrough but never saved it.", "the failure says what happened");
      equal(sent.length, 2, "never a third ask");
      equal(failed.timing?.part1Ready, undefined, "part 1 was never committed");
      // The message itself is well formed: this failure is the missing tool call, not the format.
      equal(scoreFormat(message).ok, true, "the recorded message scores clean");
      return "asked once more, then failed with a message the reader can read";
    },
  },
  {
    name: "arguments: content passed to the tools commits the part",
    async run() {
      const { rpc, tool, view } = await setup({ readCode });
      const { walkthroughId } = await rpc("start", { threadId: THREAD, request: REQUEST });
      await settle();
      const { introduction, ...bare } = PLAN;
      // No message and no content: the one nudge that names the format, and nothing saved.
      const nudged = JSON.stringify(await tool("walkthrough_plan", { ...bare, intent: "understand", baseRef: "HEAD" }));
      ok(nudged.includes("isError\":true"), "a plan with no message and no content fails once");
      ok(nudged.includes("<!-- walkthrough:start -->"), "the nudge shows the message format");
      ok(String(await tool("walkthrough_plan", { ...PLAN, intent: "understand", baseRef: "HEAD" })).includes("Planned"), "the same plan with content succeeds");

      const written = await tool("walkthrough_write_part", {
        part: 1,
        blocks: [
          { kind: "prose", text: "The loop stops after [three tries](line:1)." },
          { kind: "code", caption: "The loop", path: "src/retry.ts", startLine: 1, endLine: 1, view: "diff", notes: [{ line: 1, text: "Capped." }] },
        ],
        suggestions: ["What if the send throws?", "Is the cap configurable?"],
      });
      equal(written, "Part 1 is on the page.", "part 1 commits from the arguments");
      const walkthrough = (await view(walkthroughId)).walkthrough;
      equal(walkthrough.introduction, introduction, "the introduction came from the argument");
      equal(walkthrough.parts[0].status, "ready", "part 1 status");
      equal(walkthrough.parts[0].suggestions, ["What if the send throws?", "Is the cap configurable?"], "the argument's suggestions");
      ok(walkthrough.parts[0].blocks[1].snapshot?.after?.includes("new"), "the code block kept its snapshot");
      return "argument path and message path commit the same shape";
    },
  },
];
