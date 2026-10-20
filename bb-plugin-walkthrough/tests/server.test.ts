import { describe, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const THREAD = "thr_user";
const WORKER = "thr_worker";

async function setup(options: { forkFails?: boolean; readCode?: () => unknown; turnStatus?: () => string | undefined; sendError?: () => Error | null } = {}) {
  const sent: Array<{ threadId: string; text: string }> = [];
  const writes: Array<{ path: string; content: string }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "walkthrough",
    experimental_hostEntry: true,
    experimental_callHostRpc: () => options.readCode?.(),
    sdk: {
      threads: {
        get: async (args: { threadId: string }) => makeThreadResponse({ id: args.threadId, environmentId: "env_1", status: "idle" }),
        fork: async () => {
          if (options.forkFails) throw new Error("fork unsupported");
          return makeThreadResponse({ id: WORKER, visibility: "hidden" });
        },
        spawn: async () => makeThreadResponse({ id: WORKER, visibility: "hidden" }),
        send: async (args) => {
          const failure = options.sendError?.();
          if (failure) throw failure;
          const first = args.input[0];
          sent.push({ threadId: args.threadId, text: first && "text" in first ? first.text : "" });
          return {} as never;
        },
        stop: async () => ({}) as never,
        archive: async () => ({}) as never,
        events: {
          list: async (args: { types?: readonly string[] }) =>
            (args.types?.includes("turn/completed") ? [{ seq: 99, type: "turn/completed", data: { status: options.turnStatus?.() } }] : []) as never,
        },
        queuedMessages: { list: async () => [] as never, send: async () => ({}) as never },
      },
      environments: {
        get: async () => ({ id: "env_1", hostId: "host_1", path: "/work/repo" }) as never,
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
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const tool = (name: string, input: unknown, threadId = WORKER) => harness.behavior.callAgentTool(name, input, { threadId });
  const idle = (text: string) =>
    harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: WORKER, status: "idle" }),
      lastAssistantText: text,
    });
  const view = async (id: string) => (await rpc("get", { walkthroughId: id })).view;
  return { bb, harness, rpc, tool, idle, view, sent, writes };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

const PLAN = {
  mode: "local",
  title: "Read aloud plugin",
  baseRef: "origin/main",
  introduction: "Before this branch there was no speech.",
  parts: [
    { title: "Keeping speech requests small", summary: "Bounds", locations: [{ path: "tts.ts", startLine: 1, endLine: 40 }] },
    { title: "Choosing whose key pays", summary: "Keys" },
    { title: "The player", summary: "UI" },
  ],
};

const PART = {
  part: 1,
  blocks: [
    { kind: "prose", text: "Before, nothing. Now [the cap](line:3) bounds it." },
    { kind: "code", caption: "The cap, in tts.ts", path: "tts.ts", startLine: 1, endLine: 10, notes: [{ line: 3, text: "Truncates." }] },
  ],
  suggestions: ["Why 4,000?"],
};

describe("walkthrough code routing", () => {
  const patch = "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new\n";

  it("loads an excerpt from another repository on the walkthrough's host", async () => {
    const { rpc, tool, harness } = await setup({ readCode: () => ({
      path: "src/file.ts", patch, truncated: false,
      sides: { old: { path: "src/file.ts", content: "old\n" }, new: { path: "src/file.ts", content: "new\n" } },
    }) });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Explain another repository" });
    await tool("walkthrough_plan", PLAN);
    const result = await rpc("excerpt", { walkthroughId, path: "/work/other/src/file.ts", startLine: 1, endLine: 1 });
    expect(result).toMatchObject({ outcome: "available", path: "src/file.ts", change: patch, after: expect.stringContaining(" new"), before: expect.stringContaining(" old") });
    expect(harness.inspection.sdk.callsTo("environments.diffPatch")).toHaveLength(0);
    expect(harness.experimental_hostRpcCalls).toMatchObject([{ hostId: "host_1", method: "readCode", input: { path: "/work/other/src/file.ts", baseRef: "origin/main", includeUncommitted: true, withFullFile: true } }]);
  });

  it("normalizes an absolute in-workspace path for the environment diff API", async () => {
    const { rpc, tool, harness } = await setup();
    harness.inspection.sdk.stub("environments.diffPatch", async () => ({ outcome: "available", patches: [{ path: "src/file.ts", patch, truncated: false }] }));
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Explain this repo" });
    await tool("walkthrough_plan", PLAN);
    expect(await rpc("diff", { walkthroughId, path: "/work/repo/src/file.ts" })).toMatchObject({ outcome: "available", path: "src/file.ts", patch });
    expect(harness.inspection.sdk.callsTo("environments.diffPatch")[0]?.[0]).toMatchObject({ paths: ["src/file.ts"] });
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
  });
});

describe("walkthrough listing", () => {
  it("lists a thread's walkthroughs, and every thread's most recent first", async () => {
    const { rpc } = await setup();
    const first = await rpc("start", { threadId: THREAD, request: "First" });
    await settle();
    const second = await rpc("start", { threadId: "thr_other", request: "Second" });
    await settle();
    const ids = (listing: { walkthroughs: Array<{ id: string }> }) => listing.walkthroughs.map((walkthrough) => walkthrough.id);
    expect(ids(await rpc("list", { threadId: THREAD }))).toEqual([first.walkthroughId]);
    expect(ids(await rpc("recent", {}))).toEqual([second.walkthroughId, first.walkthroughId]);
    expect((await rpc("recent", {})).walkthroughs[0]).toMatchObject({ request: "Second", status: "planning", partCount: 0, openNotes: 0 });
  });
});

describe("walkthrough orchestration", () => {
  it("forks a hidden worker, plans, then writes the part on screen and the next one", async () => {
    const { rpc, tool, idle, view, sent } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Walk me through this branch" });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: WORKER });
    expect(sent[0]!.text).toContain("walkthrough_plan");

    expect(await tool("walkthrough_plan", PLAN)).toContain("Planned 3 parts");
    await idle("Planned.");
    await settle();
    let current = await view(walkthroughId);
    expect(current.walkthrough.status).toBe("reading");
    expect(current.walkthrough.inFlight.request).toEqual({ kind: "write", part: 0 });
    expect(sent.at(-1)!.text).toContain('Write part 1 of 3: "Keeping speech requests small"');

    await tool("walkthrough_write_part", PART);
    await idle("Done.");
    await settle();
    current = await view(walkthroughId);
    expect(current.walkthrough.parts[0].status).toBe("ready");
    expect(current.walkthrough.parts[0].blocks[1]).toMatchObject({ kind: "code", path: "tts.ts" });
    expect(current.walkthrough.inFlight.request).toEqual({ kind: "write", part: 1 });
  });

  it("answers questions ahead of queued writes and keeps the answer from the final message", async () => {
    const { rpc, tool, idle, view, sent } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    await rpc("openPart", { walkthroughId, index: 0 });
    await rpc("ask", { walkthroughId, place: 0, question: "Why truncate?" });
    let current = await view(walkthroughId);
    expect(current.walkthrough.queue[0]).toMatchObject({ kind: "ask", place: 0 });
    await tool("walkthrough_write_part", PART);
    await idle("Done.");
    await settle();
    expect(sent.at(-1)!.text).toContain("Why truncate?");
    await idle("Because the Gateway caps input.");
    await settle();
    current = await view(walkthroughId);
    expect(current.walkthrough.parts[0].discussion[0]).toMatchObject({ question: "Why truncate?", answer: "Because the Gateway caps input.", status: "done" });
  });

  it("surfaces the worker's question when it cannot plan, and sends the reply", async () => {
    const { rpc, tool, idle, view, sent } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await idle("Do you want a PR review or a local walkthrough?");
    await settle();
    let current = await view(walkthroughId);
    expect(current.walkthrough.status).toBe("planning");
    expect(current.walkthrough.message).toContain("PR review or a local walkthrough");
    await rpc("reply", { walkthroughId, text: "Local, please." });
    await settle();
    expect(sent.at(-1)!.text).toContain("Local, please.");
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    current = await view(walkthroughId);
    expect(current.walkthrough.status).toBe("reading");
    expect(current.walkthrough.message).toBeNull();
  });

  it("marks a part failed when the worker ends without writing it", async () => {
    const { rpc, tool, idle, view } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    await idle("I could not find that file.");
    await settle();
    const current = await view(walkthroughId);
    expect(current.walkthrough.parts[0]).toMatchObject({ status: "failed", message: "I could not find that file." });
  });

  it("wraps up with notes, hands open ones to the user's thread, and closes the worker", async () => {
    const { rpc, tool, idle, view, sent, harness, writes } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    await rpc("addNote", { walkthroughId, kind: "todo", text: "Name the cap", groupIndex: 0, location: { path: "tts.ts", startLine: 3 } });
    await settle();
    expect(writes.at(-1)?.path).toBe(`/work/repo/.agent/review-notes/${walkthroughId}.md`);
    expect(writes.find((write) => write.path.endsWith(".gitignore"))).toMatchObject({ path: "/work/repo/.agent/review-notes/.gitignore", content: "*\n" });
    expect(writes.at(-1)?.content).toContain("[Keeping speech requests small · tts.ts:3] Name the cap (n1)");

    await rpc("wrapUp", { walkthroughId });
    await idle("stopped writing");
    await settle();
    expect(sent.at(-1)!.text).toContain("The user is wrapping up");
    expect(sent.at(-1)!.text).toContain('n1 todo [Keeping speech requests small · tts.ts:3]: "Name the cap"');
    await tool("walkthrough_wrap_up", { blocks: [{ kind: "prose", text: "We covered the cap." }], followUps: ["Make the todo"] });
    await idle("Wrapped.");
    await settle();
    let current = await view(walkthroughId);
    expect(current.walkthrough.wrapUp).toMatchObject({ status: "ready", suggestions: ["Make the todo"] });

    expect(await rpc("handOff", { walkthroughId })).toEqual({ sent: true });
    expect(sent.at(-1)).toMatchObject({ threadId: THREAD });
    expect(sent.at(-1)!.text).toContain("Todo: Name the cap (tts.ts:3)");

    await rpc("close", { walkthroughId });
    current = await view(walkthroughId);
    expect(current.walkthrough.status).toBe("done");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
  });

  it("falls back to a fresh hidden worker when forking is unavailable", async () => {
    const { rpc, view, harness } = await setup({ forkFails: true });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    const current = await view(walkthroughId);
    expect(current.walkthrough.workerThreadId).toBe(WORKER);
    expect(current.walkthrough.inFlight.request).toEqual({ kind: "plan" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("offers worker tools only to worker threads", async () => {
    const { harness } = await setup();
    const user = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(user.tools.map((entry) => entry.name)).toEqual(["walkthrough_open"]);
    const worker = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { role: "walkthrough-worker", walkthroughId: "wt_x" } }),
    );
    expect(worker.tools.map((entry) => entry.name)).toContain("walkthrough_write_part");
    expect(worker.tools.map((entry) => entry.name)).not.toContain("walkthrough_open");
  });
});

describe("walkthrough failure handling", () => {
  it("fails an interrupted part with a fixed message, not the previous turn's text", async () => {
    let status: string | undefined;
    const { rpc, tool, idle, view } = await setup({ turnStatus: () => status });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    status = "interrupted";
    await idle("Planned.");
    await settle();
    const current = await view(walkthroughId);
    expect(current.walkthrough.parts[0]).toMatchObject({ status: "failed", message: "The helper was stopped before it finished." });
  });

  it("closes the walkthrough when the helper's thread is archived instead of retrying forever", async () => {
    let error: Error | null = null;
    const { rpc, tool, idle, view } = await setup({ sendError: () => error });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    error = new Error("HTTP 409: Thread is archived");
    await idle("Planned.");
    await settle();
    const current = await view(walkthroughId);
    expect(current.walkthrough).toMatchObject({ status: "done", queue: [], inFlight: null });
    expect(current.walkthrough.parts[0]).toMatchObject({ status: "failed", message: expect.stringContaining("no longer running") });
  });

  it("fails answers and parts still owed when the user finishes the walkthrough", async () => {
    const { rpc, tool, idle, view } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    await rpc("close", { walkthroughId });
    const current = await view(walkthroughId);
    expect(current.walkthrough).toMatchObject({ status: "done", inFlight: null, queue: [] });
    expect(current.walkthrough.parts[0]).toMatchObject({ status: "failed" });
  });
});
