import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const THREAD = "thr_1";

async function setup() {
  const writes: Array<{ path: string; content: string }> = [];
  const sent: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "walkthrough",
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: THREAD, environmentId: "env_1" }),
        send: async (args) => {
          const first = args.input[0];
          sent.push(first && "text" in first ? first.text : "");
          return {} as never;
        },
      },
      environments: {
        get: async () => ({ id: "env_1", hostId: "host_1", path: "/work/repo" }) as never,
        diffPatch: async () =>
          ({
            outcome: "available",
            patches: [
              {
                path: "src/new.ts",
                truncated: false,
                patch: "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n",
              },
            ],
          }) as never,
        diffFiles: async () => ({ outcome: "available", mergeBaseRef: "abc1234" }) as never,
        diffFile: async (args: { side: string; mergeBaseRef?: string }) => {
          if (args.mergeBaseRef !== "abc1234") throw new Error("expected merge-base sha");
          return { content: "a\nb\n", contentEncoding: "utf8", path: "src/new.ts", sizeBytes: 4 } as never;
        },
      },
      files: {
        write: async (args: { path: string; content: string }) => {
          writes.push({ path: args.path, content: args.content });
          return { outcome: "written", sha256: "x", sizeBytes: args.content.length } as never;
        },
      },
    },
  });
  await plugin(bb);
  const tool = (name: string, input: unknown) => harness.behavior.callAgentTool(name, input, { threadId: THREAD });
  const textOf = (result: unknown) =>
    typeof result === "string" ? result : (result as { content: Array<{ text: string }> }).content.map((part) => part.text).join("\n");
  return { bb, harness, tool, textOf, writes, sent };
}

const START = {
  mode: "local",
  title: "Branch feature",
  baseRef: "origin/main",
  groups: [
    { title: "Schema", summary: "Data shape", locations: [{ path: "src/schema.ts", startLine: 1, endLine: 20 }] },
    { title: "Store", locations: [] },
  ],
};

async function waitForInteraction(harness: Awaited<ReturnType<typeof setup>>["harness"]) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pending = harness.inspection.pendingInteractions;
    if (pending.length > 0) return pending[pending.length - 1]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no pending interaction");
}

describe("walkthrough tools", () => {
  it("starts, pauses, advances, and finishes through the pause form", async () => {
    const { harness, tool, textOf } = await setup();
    const started = textOf(await tool("walkthrough_start", START));
    expect(started).toContain("started in local mode with 2 groups");
    expect(started).toContain("/work/repo/.agent/review-notes.md");

    const firstPause = tool("walkthrough_pause", { suggestions: [] });
    const overview = await waitForInteraction(harness);
    expect(overview.rendererId).toBe("walkthrough-pause");
    expect(overview.payload).toMatchObject({ stage: "overview", nextGroupTitle: "Schema" });
    harness.behavior.submitInteraction(overview.id, { action: "next" });
    const group1 = textOf(await firstPause);
    expect(group1).toContain("Group 1 of 2");
    expect(group1).toContain("src/schema.ts:1-20");

    const view = await harness.behavior.callRpc("get", { threadId: THREAD });
    expect(view).toMatchObject({ view: { walkthrough: { status: "reviewing", currentGroup: 0 } } });

    const secondPause = tool("walkthrough_pause", { suggestions: ["Why a new table?"] });
    const groupPause = await waitForInteraction(harness);
    await harness.behavior.callRpc("addNote", { threadId: THREAD, kind: "todo", text: "Rename column" });
    harness.behavior.submitInteraction(groupPause.id, { action: "finish" });
    const finish = textOf(await secondPause);
    expect(finish).toContain("Finish procedure (local mode)");
    expect(finish).toContain('n1 todo [Group 1: Schema]: "Rename column"');
  });

  it("answers ask without moving state", async () => {
    const { harness, tool, textOf } = await setup();
    await tool("walkthrough_start", START);
    await tool("walkthrough_advance", { action: "next" });
    const pause = tool("walkthrough_pause", {});
    const pending = await waitForInteraction(harness);
    harness.behavior.submitInteraction(pending.id, { action: "ask", text: "What calls this?" });
    const result = textOf(await pause);
    expect(result).toContain('"What calls this?"');
    expect(result).toContain("call walkthrough_pause again");
    const view = (await harness.behavior.callRpc("get", { threadId: THREAD })) as { view: { walkthrough: { currentGroup: number } } };
    expect(view.view.walkthrough.currentGroup).toBe(0);
  });

  it("reports user-recorded notes once and mirrors them to the notes file", async () => {
    const { harness, tool, textOf, writes } = await setup();
    await tool("walkthrough_start", START);
    await tool("walkthrough_advance", { action: "next" });
    await harness.behavior.callRpc("addNote", {
      threadId: THREAD,
      kind: "question",
      text: "Is this migration reversible?",
      location: { path: "src/schema.ts", startLine: 4 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes.at(-1)?.path).toBe("/work/repo/.agent/review-notes.md");
    expect(writes.at(-1)?.content).toContain("[Group 1: Schema · src/schema.ts:4] Is this migration reversible? (n1)");

    const next = textOf(await tool("walkthrough_advance", { action: "next" }));
    expect(next).toContain("Is this migration reversible?");
    const again = textOf(await tool("walkthrough_advance", { action: "finish" }));
    expect(again).toContain("All notes:");
    expect(again).not.toContain("since your last walkthrough call");
  });

  it("resolves notes and keeps them in Resolved / Answered", async () => {
    const { tool, textOf, writes } = await setup();
    await tool("walkthrough_start", START);
    await tool("walkthrough_note", { kind: "question", text: "Why?" });
    const updated = textOf(await tool("walkthrough_note", { op: "update", noteId: "n1", status: "resolved", resolution: "Perf." }));
    expect(updated).toContain("resolved");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes.at(-1)?.content).toContain("## Resolved / Answered");
  });

  it("refuses review drafts in local mode and sends explicit post requests in PR mode", async () => {
    const { harness, tool, textOf, sent } = await setup();
    await tool("walkthrough_start", START);
    expect(textOf(await tool("walkthrough_review", { body: "x", comments: [] }))).toContain("only in PR mode");

    await tool("walkthrough_start", { ...START, mode: "pr", pr: { number: 12 }, replace: true });
    const saved = textOf(
      await tool("walkthrough_review", { body: "Looks good", comments: [{ path: "src/schema.ts", line: 3, body: "Nit" }] }),
    );
    expect(saved).toContain("1 inline comments");
    await harness.behavior.callRpc("sendToAgent", { threadId: THREAD, request: { kind: "postReview", event: "COMMENT" } });
    expect(sent.at(-1)).toContain("PR #12");
    expect(sent.at(-1)).toContain("explicit request");
  });

  it("contributes instructions only while a walkthrough is active", async () => {
    const { harness, tool } = await setup();
    const provider = harness.registrations.instructionProvider;
    expect(provider).toBeTruthy();
    expect(provider!({ threadId: THREAD, projectId: "p" })).toBeNull();
    await tool("walkthrough_start", START);
    expect(provider!({ threadId: THREAD, projectId: "p" })).toContain("walkthrough in progress");
    await tool("walkthrough_advance", { action: "complete" });
    expect(provider!({ threadId: THREAD, projectId: "p" })).toBeNull();
  });

  it("serves diffs with empty old contents for added files", async () => {
    const { harness, tool } = await setup();
    await tool("walkthrough_start", START);
    const result = (await harness.behavior.callRpc("diff", { threadId: THREAD, path: "src/new.ts", withFullFile: true })) as {
      outcome: string;
      fullFileContents: { old: { content: string }; new: { content: string } } | null;
    };
    expect(result.outcome).toBe("available");
    expect(result.fullFileContents).toEqual({ old: { path: "src/new.ts", content: "" }, new: { path: "src/new.ts", content: "a\nb\n" } });
  });
});
