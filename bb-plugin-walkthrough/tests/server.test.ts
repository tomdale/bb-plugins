import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const THREAD = "thr_1";

async function setup() {
  const writes: Array<{ path: string; content: string }> = [];
  const sent: Array<{ visible: string; agent: string }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "walkthrough",
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: THREAD, environmentId: "env_1", status: "idle" }),
        send: async (args) => {
          const texts = args.input.map((part) => ("text" in part ? { text: part.text, agentOnly: part.visibility === "agent-only" } : null));
          sent.push({
            visible: texts.filter((part) => part && !part.agentOnly).map((part) => part!.text).join("\n"),
            agent: texts.filter((part) => part?.agentOnly).map((part) => part!.text).join("\n"),
          });
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
  /** Ends the agent's turn the way BB does, which opens any requested pause. */
  const endTurn = () =>
    harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD, environmentId: "env_1", status: "idle" }),
      lastAssistantText: "narration",
    });
  return { bb, harness, tool, textOf, writes, sent, endTurn };
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

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met");
}

async function waitForInteraction(harness: Awaited<ReturnType<typeof setup>>["harness"], after?: string) {
  let found: (typeof harness.inspection.pendingInteractions)[number] | undefined;
  await waitFor(() => {
    const pending = harness.inspection.pendingInteractions.filter((entry) => entry.id !== after);
    found = pending[pending.length - 1];
    return found !== undefined;
  });
  return found!;
}

describe("walkthrough tools", () => {
  it("opens the pause controls after the turn and delivers choices as chat messages", async () => {
    const { harness, tool, textOf, sent, endTurn } = await setup();
    const started = textOf(await tool("walkthrough_start", START));
    expect(started).toContain("started in local mode with 2 groups");
    expect(started).toContain("/work/repo/.agent/review-notes.md");

    const paused = textOf(await tool("walkthrough_pause", { suggestions: ["Why two groups?"] }));
    expect(paused).toContain("final message of this turn");
    expect(harness.inspection.pendingInteractions).toHaveLength(0);

    await endTurn();
    const overview = await waitForInteraction(harness);
    expect(overview.rendererId).toBe("walkthrough-pause");
    expect(overview.title).toBe("Walkthrough overview · 2 groups");
    expect(overview.payload).toMatchObject({ stage: "overview", nextGroupTitle: "Schema", suggestions: ["Why two groups?"] });
    harness.behavior.submitInteraction(overview.id, { action: "next" });
    await waitFor(() => sent.length === 1);
    expect(sent[0]!.visible).toBe("Start: 1. Schema");
    expect(sent[0]!.agent).toContain("Group 1 of 2");
    expect(sent[0]!.agent).toContain("src/schema.ts:1-20");

    const view = await harness.behavior.callRpc("get", { threadId: THREAD });
    expect(view).toMatchObject({ view: { walkthrough: { status: "reviewing", currentGroup: 0, pause: null } } });

    await tool("walkthrough_pause", { suggestions: [] });
    await endTurn();
    const groupPause = await waitForInteraction(harness, overview.id);
    await harness.behavior.callRpc("addNote", { threadId: THREAD, kind: "todo", text: "Rename column" });
    harness.behavior.submitInteraction(groupPause.id, { action: "finish" });
    await waitFor(() => sent.length === 2);
    expect(sent[1]!.visible).toBe("Finish the walkthrough");
    expect(sent[1]!.agent).toContain("Finish procedure (local mode)");
    expect(sent[1]!.agent).toContain('n1 todo [Group 1: Schema]: "Rename column"');
  });

  it("sends a typed question verbatim and keeps the group", async () => {
    const { harness, tool, sent, endTurn } = await setup();
    await tool("walkthrough_start", START);
    await tool("walkthrough_advance", { action: "next" });
    await tool("walkthrough_pause", {});
    await endTurn();
    const pending = await waitForInteraction(harness);
    harness.behavior.submitInteraction(pending.id, { action: "ask", text: "What calls this?" });
    await waitFor(() => sent.length === 1);
    expect(sent[0]!.visible).toBe("What calls this?");
    expect(sent[0]!.agent).toContain('group 1 ("Schema")');
    const view = (await harness.behavior.callRpc("get", { threadId: THREAD })) as { view: { walkthrough: { currentGroup: number } } };
    expect(view.view.walkthrough.currentGroup).toBe(0);
  });

  it("closes without an agent turn and reopens dismissed controls on request", async () => {
    const { harness, tool, sent, endTurn } = await setup();
    await tool("walkthrough_start", START);
    await tool("walkthrough_pause", {});
    await endTurn();
    const first = await waitForInteraction(harness);
    harness.behavior.cancelInteraction(first.id);
    await waitFor(async () => {
      const view = (await harness.behavior.callRpc("get", { threadId: THREAD })) as { view: { pauseRequested: boolean } };
      return view.view.pauseRequested;
    });
    await endTurn();
    expect(harness.inspection.pendingInteractions.filter((entry) => entry.id !== first.id)).toHaveLength(0);
    expect(await harness.behavior.callRpc("showPause", { threadId: THREAD })).toEqual({ opened: true });
    const reopened = await waitForInteraction(harness, first.id);
    harness.behavior.submitInteraction(reopened.id, { action: "complete" });
    await waitFor(async () => {
      const view = (await harness.behavior.callRpc("get", { threadId: THREAD })) as { view: { walkthrough: { status: string } } };
      return view.view.walkthrough.status === "finished";
    });
    expect(sent).toHaveLength(0);
  });

  it("ignores PR metadata outside PR mode", async () => {
    const { harness, tool } = await setup();
    await tool("walkthrough_start", { ...START, pr: { number: 1, url: "", title: "" } });
    const view = (await harness.behavior.callRpc("get", { threadId: THREAD })) as { view: { walkthrough: { pr: unknown } } };
    expect(view.view.walkthrough.pr).toBeNull();
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
    await harness.behavior.callRpc("requestReviewPost", { threadId: THREAD, event: "COMMENT" });
    expect(sent.at(-1)!.visible).toContain("PR #12");
    expect(sent.at(-1)!.agent).toContain("explicit request");
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
