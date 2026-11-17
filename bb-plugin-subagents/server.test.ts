import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makePluginAgentConfigurationContext,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import type { Run } from "./src/contracts.ts";
import type { StatusSummarizer } from "./src/summarizer.ts";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function catalogModel(model: string, efforts: string[]) {
  return {
    id: model,
    model,
    displayName: model,
    description: "",
    isDefault: false,
    defaultReasoningEffort: efforts[0]!,
    reasoningDiscovery: "known",
    supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: "" })),
  };
}

async function setup(settings: Record<string, number> = {}, summarizer?: StatusSummarizer) {
  const threads = new Map([
    [
      "origin",
      makeThreadResponse({
        id: "origin",
        projectId: "project",
        environmentId: "environment",
        providerId: "pi",
        status: "active",
      }),
    ],
  ]);
  let next = 0;
  let latestOutput = "Findings";
  const host = createFakePluginHost({
    pluginId: "subagents",
    settings,
    sdk: {
      providers: {
        models: async () => ({
          modelLoadError: null,
          models: [
            catalogModel("claude-opus-4-6", ["low", "medium", "high", "xhigh"]),
            catalogModel("claude-haiku-4-5", ["low", "medium"]),
          ],
          selectedOnlyModels: [],
        }) as never,
      },
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("missing thread");
          return thread;
        },
        defaultExecutionOptions: async () => ({
          model: "claude-opus-4-6",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          serviceTier: "default",
          source: "client/thread/start",
        }),
        spawn: async args => {
          const thread = makeThreadResponse({
            id: `child-${++next}`,
            projectId: args.projectId,
            environmentId: "environment",
            providerId: args.providerId ?? "pi",
            status: "active",
            visibility: "hidden",
          });
          threads.set(thread.id, thread);
          return thread;
        },
        output: async () => ({ output: latestOutput }),
        archive: async ({ threadId }) => {
          threads.get(threadId)!.archivedAt = 1;
          return { archived: 1 };
        },
        unarchive: async ({ threadId }) => {
          threads.get(threadId)!.archivedAt = null;
          return { ok: true };
        },
        stop: async () => ({ ok: true }),
        update: async ({ threadId, visibility, parentThreadId }) => {
          const thread = threads.get(threadId)!;
          if (visibility) thread.visibility = visibility;
          if (parentThreadId !== undefined) thread.parentThreadId = parentThreadId;
          return thread;
        },
        send: async () => ({}) as never,
      },
    },
  });
  hosts.push(host);
  await plugin(host.bb, summarizer);
  async function create(threadId = "origin", task = "Review code.", options: Record<string, unknown> = {}) {
    const result = await host.harness.behavior.callAgentTool(
      "subagent_create",
      { task, ...options },
      { threadId, projectId: "project" },
    );
    return JSON.parse(result as string) as { id: string; threadId: string };
  }
  async function list(threadId = "origin") {
    return host.harness.behavior.callRpc("list", { threadId }) as Promise<{ runs: Run[] }>;
  }
  return {
    ...host,
    threads,
    create,
    list,
    setOutput(value: string) {
      latestOutput = value;
    },
  };
}

describe("background subagents", () => {
  it("creates hidden workers and records provider, model, thinking level, and initial status summary", async () => {
    const host = await setup();
    const run = await host.create("origin", "Inspect CSRF middleware across API routes.");
    expect(run.threadId).toBe("child-1");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({
      environment: { type: "reuse", environmentId: "environment" },
      visibility: "hidden",
      lifecycleOwnerThreadId: "origin",
      providerId: "pi",
      model: "claude-opus-4-6",
      reasoningLevel: "high",
      permissionMode: "accept-edits",
      serviceTier: "default",
    });
    const stored = (await host.list()).runs[0]!;
    expect(stored).toMatchObject({
      status: "running",
      providerId: "pi",
      model: "claude-opus-4-6",
      reasoningLevel: "high",
      statusSummary: "Inspect CSRF middleware across API routes.",
    });
  });

  it("starts a worker at a requested reasoning level the model supports", async () => {
    const host = await setup();
    await host.create("origin", "Deep review.", { reasoningLevel: "xhigh" });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({
      model: "claude-opus-4-6",
      reasoningLevel: "xhigh",
    });
    expect((await host.list()).runs[0]).toMatchObject({ reasoningLevel: "xhigh" });
  });

  it("rejects a reasoning level the selected model does not list, before spawning", async () => {
    const host = await setup();
    await expect(
      host.create("origin", "Quick check.", { model: "claude-haiku-4-5", reasoningLevel: "xhigh" }),
    ).rejects.toThrow(/not supported by pi\/claude-haiku-4-5\. Supported reasoning levels: low, medium/);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("falls back to the selected model's default when it cannot run the inherited level", async () => {
    const host = await setup();
    await host.create("origin", "Quick check.", { model: "claude-haiku-4-5" });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({
      model: "claude-haiku-4-5",
      reasoningLevel: "low",
    });
  });

  it("backfills missing providerId, model, and reasoningLevel on historical runs from thread execution options", async () => {
    const host = await setup();
    const run = await host.create("origin", "Legacy run.");
    host.bb.storage
      .database()
      .prepare(
        "UPDATE runs SET data = json_remove(data, '$.providerId', '$.model', '$.reasoningLevel') WHERE id = ?",
      )
      .run(run.id);
    const hydrated = (await host.list()).runs[0]!;
    expect(hydrated).toMatchObject({
      providerId: "pi",
      model: "claude-opus-4-6",
      reasoningLevel: "high",
    });
  });

  it("updates statusSummary when the subagent emits a new reply or after 30 seconds via the summarizer", async () => {
    const summarizerCalls: string[] = [];
    const host = await setup({}, async ({ excerpt }) => {
      summarizerCalls.push(excerpt);
      return `Summarized: ${excerpt}`;
    });
    const run = await host.create("origin", "Audit routes.");

    // 1. Immediate update when the subagent emits a new reply
    host.setOutput("Checked 6 of 10 routes so far.");
    await host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: host.threads.get(run.threadId)!,
      sequence: 2,
    });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect((await host.list()).runs[0]!.statusSummary).toBe("Summarized: Checked 6 of 10 routes so far.");
    expect(summarizerCalls).toEqual(["Checked 6 of 10 routes so far."]);

    // 2. Periodic update after 30 seconds using an excerpt of latest output
    host.setOutput("Now checking OAuth callback state binding.");
    host.bb.storage
      .database()
      .prepare("UPDATE runs SET data = json_set(data, '$.summaryUpdatedAt', 1) WHERE id = ?")
      .run(run.id);
    const service = host.harness.behavior.runService("reconcile");
    await new Promise(resolve => setTimeout(resolve, 20));
    service.controller.abort();
    await service.done;
    expect((await host.list()).runs[0]!.statusSummary).toBe(
      "Summarized: Now checking OAuth callback state binding.",
    );
    expect(summarizerCalls).toEqual([
      "Checked 6 of 10 routes so far.",
      "Now checking OAuth callback state binding.",
    ]);
  });

  it("settles once, sends output, archives and releases the runtime", async () => {
    const host = await setup();
    const run = await host.create();
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: host.threads.get(run.threadId)!,
      lastAssistantText: "All 14 routes verified.",
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: host.threads.get(run.threadId)!,
      lastAssistantText: "All 14 routes verified.",
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const stored = (await host.list()).runs[0]!;
    expect(stored).toMatchObject({
      status: "completed",
      output: "Findings",
      statusSummary: "Findings.",
      cleanupPending: false,
    });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
  });

  it("detaches a subagent into a visible child thread of its parent and suspends background lifecycle", async () => {
    const host = await setup();
    const run = await host.create();
    const detached = await host.harness.behavior.callRpc("detach", { id: run.id });
    expect(detached).toEqual({ threadId: run.threadId });
    expect(host.threads.get(run.threadId)!).toMatchObject({
      visibility: "visible",
      parentThreadId: "origin",
    });
    expect((await host.list()).runs).toHaveLength(0);
    expect(JSON.stringify(host.harness.inspection.sdk.callsTo("threads.send"))).toContain("detached subagent");
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: host.threads.get(run.threadId)!,
      lastAssistantText: "Findings",
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    await expect(
      host.harness.behavior.callAgentTool("subagent_kill", { id: run.id }, { threadId: "origin" }),
    ).rejects.toThrow("detached");
  });

  it("enforces depth, ownership and capacity without relying on metadata", async () => {
    const host = await setup({ maxDepth: 1, maxConcurrent: 2 });
    const a = await host.create();
    const b = await host.create();
    await expect(host.create()).rejects.toThrow("concurrent");
    await expect(host.create(a.threadId)).rejects.toThrow("depth");
    await expect(
      host.harness.behavior.callAgentTool("subagent_kill", { id: b.id }, { threadId: a.threadId }),
    ).rejects.toThrow("another thread");
    await expect(
      host.harness.behavior.callAgentTool("subagent_status", { id: a.id }, { threadId: "stranger" }),
    ).rejects.toThrow("another thread");
  });

  it("preserves partial output and stops before harvesting a killed run", async () => {
    const host = await setup();
    const run = await host.create();
    const result = await host.harness.behavior.callAgentTool(
      "subagent_kill",
      { id: run.id, reason: "stuck" },
      { threadId: "origin" },
    );
    expect(JSON.parse(result as string)).toMatchObject({
      status: "killed",
      output: "Findings",
      error: "stuck",
    });
    const calls = host.harness.inspection.sdk.calls.map(call => call.path);
    expect(calls.indexOf("threads.stop")).toBeLessThan(calls.indexOf("threads.output"));
  });

  it("reconciles completed workers and retries notification failures after reload", async () => {
    const host = await setup();
    const run = await host.create();
    host.threads.get(run.threadId)!.status = "idle";
    host.harness.inspection.sdk.stub("threads.send", async () => {
      throw new Error("offline");
    });
    const service = host.harness.behavior.runService("reconcile");
    await new Promise(resolve => setTimeout(resolve, 20));
    service.controller.abort();
    await service.done;
    expect((await host.list()).runs[0]!.notifications).toHaveLength(1);
    host.harness.inspection.sdk.stub("threads.send", async () => ({}) as never);
    const reloaded = await host.harness.lifecycle.reload(plugin);
    const resumed = reloaded.harness.behavior.runService("reconcile");
    await new Promise(resolve => setTimeout(resolve, 20));
    resumed.controller.abort();
    await resumed.done;
    expect(
      ((await reloaded.harness.behavior.callRpc("list", { threadId: "origin" })) as { runs: Run[] }).runs[0]!
        .notifications,
    ).toHaveLength(0);
    await reloaded.harness.lifecycle.dispose();
  });

  it("bounds list output independently of accumulated prompts and results", async () => {
    const host = await setup();
    await host.create("origin", "x".repeat(32000));
    const result = await host.harness.behavior.callAgentTool("subagent_status", {}, { threadId: "origin" });
    expect((result as string).length).toBeLessThan(2000);
    expect(result).not.toContain("task");
  });

  async function reconcileOnce(host: Awaited<ReturnType<typeof setup>>) {
    const service = host.harness.behavior.runService("reconcile");
    await new Promise(resolve => setTimeout(resolve, 20));
    service.controller.abort();
    await service.done;
  }

  function setRun(host: Awaited<ReturnType<typeof setup>>, id: string, fields: Record<string, unknown>) {
    const db = host.bb.storage.database();
    for (const [key, value] of Object.entries(fields)) {
      db.prepare(`UPDATE runs SET data = json_set(data, '$.${key}', json(?)) WHERE id = ?`).run(
        JSON.stringify(value),
        id,
      );
    }
  }

  const sentTo = (host: Awaited<ReturnType<typeof setup>>, threadId: string) =>
    host.harness.inspection.sdk
      .callsTo("threads.send")
      .map(call => call[0] as { threadId: string; mode: string; input: { text: string }[] })
      .filter(call => call.threadId === threadId);

  it("asks a worker to wrap up at the deadline instead of stopping it", async () => {
    const host = await setup();
    const run = await host.create("origin", "Review code.", { timeout: 600 });
    setRun(host, run.id, { deadline: 1 });
    await reconcileOnce(host);
    const [wrapUp] = sentTo(host, run.threadId);
    expect(wrapUp).toMatchObject({ mode: "steer-if-active" });
    expect(wrapUp!.input[0]!.text).toContain("Time limit reached");
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    const [listed] = (await host.list()).runs;
    expect(listed).toMatchObject({ status: "winding-down" });
    expect(listed!.graceDeadline).toBeGreaterThan(Date.now() + 30_000);
    expect(await host.harness.behavior.fetchHttp("GET", "/active-rows").then(r => r.json())).toEqual({
      roots: [{ threadId: "origin", working: 1 }],
    });
  });

  it("settles a worker that wraps up within the grace period as timed out, keeping its report", async () => {
    const host = await setup();
    const run = await host.create("origin", "Review code.", { timeout: 600 });
    setRun(host, run.id, { deadline: 1 });
    await reconcileOnce(host);
    host.setOutput("Done: A. Remaining: B.");
    host.threads.get(run.threadId)!.status = "idle";
    await reconcileOnce(host);
    const [settled] = (await host.list()).runs;
    expect(settled).toMatchObject({ status: "timed-out", output: "Done: A. Remaining: B." });
    expect(settled!.error).toContain("incomplete");
    const report = sentTo(host, "origin").at(-1)!.input[0]!.text;
    expect(report).toContain("timed-out");
    expect(report).toContain(`subagent_resume({ id: "${run.id}"`);
  });

  it("settles a worker that declares the task complete during its wrap-up as completed", async () => {
    const host = await setup();
    const run = await host.create("origin", "Review code.", { timeout: 600 });
    setRun(host, run.id, { deadline: 1 });
    await reconcileOnce(host);
    expect(sentTo(host, run.threadId)[0]!.input[0]!.text).toContain("Begin your reply with COMPLETE");
    host.setOutput("**COMPLETE**\nEverything is reviewed.");
    host.threads.get(run.threadId)!.status = "idle";
    await reconcileOnce(host);
    expect((await host.list()).runs[0]).toMatchObject({ status: "completed", error: null });
  });

  it("settles a worker that reports INCOMPLETE during its wrap-up as timed out", async () => {
    const host = await setup();
    const run = await host.create("origin", "Review code.", { timeout: 600 });
    setRun(host, run.id, { deadline: 1 });
    await reconcileOnce(host);
    host.setOutput("INCOMPLETE\nTwo files remain.");
    host.threads.get(run.threadId)!.status = "idle";
    await reconcileOnce(host);
    expect((await host.list()).runs[0]).toMatchObject({ status: "timed-out" });
  });

  it("counts a worker that finishes on its own at the deadline as completed", async () => {
    const host = await setup();
    const run = await host.create("origin", "Review code.", { timeout: 600 });
    setRun(host, run.id, { deadline: 1 });
    host.threads.get(run.threadId)!.status = "idle";
    await reconcileOnce(host);
    expect((await host.list()).runs[0]).toMatchObject({ status: "completed" });
  });

  it("stops a worker that ignores the wrap-up order once its grace period ends", async () => {
    const host = await setup();
    const run = await host.create("origin", "Review code.", { timeout: 600 });
    setRun(host, run.id, { deadline: 1 });
    await reconcileOnce(host);
    setRun(host, run.id, { graceDeadline: 1 });
    await reconcileOnce(host);
    expect((await host.list()).runs[0]).toMatchObject({ status: "timed-out", output: "Findings" });
    expect((await host.list()).runs[0]!.error).toContain("did not wrap up");
    expect(host.harness.inspection.sdk.callsTo("threads.stop").length).toBeGreaterThan(0);
  });

  it("falls back to a hard stop when the wrap-up order cannot be delivered", async () => {
    const host = await setup();
    const run = await host.create("origin", "Review code.", { timeout: 600 });
    setRun(host, run.id, { deadline: 1 });
    host.harness.inspection.sdk.stub("threads.send", async () => {
      throw new Error("offline");
    });
    await reconcileOnce(host);
    expect((await host.list()).runs[0]).toMatchObject({ status: "timed-out", output: "Findings" });
    expect(host.harness.inspection.sdk.callsTo("threads.stop").length).toBeGreaterThan(0);
  });

  it("stops at the deadline when the run has no time to wrap up", async () => {
    const host = await setup();
    const run = await host.create();
    setRun(host, run.id, { deadline: 1, timeoutMs: null });
    await reconcileOnce(host);
    expect((await host.list()).runs[0]).toMatchObject({ status: "timed-out", output: "Findings" });
  });

  it("sends time-check notices as a long run's deadline nears, one message for all that fell due", async () => {
    const host = await setup();
    const run = await host.create("origin", "Review code.", { timeout: 86400 });
    const [first, second, third] = (await host.list()).runs[0]!.notices;
    expect(third).toBeGreaterThan(second!);
    expect(second).toBeGreaterThan(first!);
    setRun(host, run.id, { notices: [1, 2, Date.now() + 3_600_000] });
    await reconcileOnce(host);
    const notices = sentTo(host, run.threadId);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.input[0]!.text).toContain("Time check");
    expect((await host.list()).runs[0]!.notices).toHaveLength(1);
    expect((await host.list()).runs[0]).toMatchObject({ status: "running" });
  });

  describe("resume", () => {
    async function timedOut(host: Awaited<ReturnType<typeof setup>>, options: Record<string, unknown> = {}) {
      const run = await host.create("origin", "Review code.", options);
      await host.harness.behavior.callAgentTool("subagent_kill", { id: run.id }, { threadId: "origin" });
      setRun(host, run.id, { status: "timed-out" });
      return run;
    }
    const resume = (host: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown>, threadId = "origin") =>
      host.harness.behavior.callAgentTool("subagent_resume", args, { threadId });

    it("continues a timed-out worker in its session with a fresh budget", async () => {
      const host = await setup();
      const run = await timedOut(host);
      const result = JSON.parse((await resume(host, { id: run.id })) as string);
      expect(result).toMatchObject({ status: "running", resumeCount: 1, threadId: run.threadId });
      expect(result.deadline).toBeGreaterThan(Date.now());
      expect(host.harness.inspection.sdk.callsTo("threads.unarchive")).toHaveLength(1);
      const message = sentTo(host, run.threadId).at(-1)!;
      expect(message.mode).toBe("auto");
      expect(message.input[0]!.text).toContain("continue the task where you left off");
      expect((await host.list()).runs[0]).toMatchObject({ status: "running", error: null, resumeCount: 1 });
    });

    it("steers the resumed worker with the caller's message and a custom timeout", async () => {
      const host = await setup();
      const run = await timedOut(host);
      await resume(host, { id: run.id, message: "Skip the tests; finish the docs.", timeout: 300 });
      expect(sentTo(host, run.threadId).at(-1)!.input[0]!.text).toContain("Skip the tests; finish the docs.");
      expect((await host.list()).runs[0]).toMatchObject({ timeoutMs: 300_000 });
    });

    it("resumes a killed worker and settles it again on completion", async () => {
      const host = await setup();
      const run = await host.create();
      await host.harness.behavior.callAgentTool("subagent_kill", { id: run.id }, { threadId: "origin" });
      await resume(host, { id: run.id });
      host.threads.get(run.threadId)!.status = "idle";
      await reconcileOnce(host);
      expect((await host.list()).runs[0]).toMatchObject({ status: "completed", resumeCount: 1 });
    });

    it("continues a failed worker and a completed worker given new instructions", async () => {
      const host = await setup();
      const failed = await timedOut(host);
      setRun(host, failed.id, { status: "failed", error: "provider error" });
      await resume(host, { id: failed.id });
      expect(sentTo(host, failed.threadId).at(-1)!.input[0]!.text).toContain("ended in a failure");
      const done = await host.create();
      host.threads.get(done.threadId)!.status = "idle";
      await reconcileOnce(host);
      await expect(resume(host, { id: done.id })).rejects.toThrow(/needs a message/);
      await resume(host, { id: done.id, message: "Now review the tests too." });
      const message = sentTo(host, done.threadId).at(-1)!.input[0]!.text;
      expect(message).toContain("finished your task earlier");
      expect(message).toContain("Now review the tests too.");
      expect((await host.list()).runs.find(run => run.id === done.id)).toMatchObject({
        status: "running",
        resumeCount: 1,
      });
    });

    it("rejects runs that are still working, detached, or owned by another thread", async () => {
      const host = await setup();
      const running = await host.create();
      await expect(resume(host, { id: running.id })).rejects.toThrow(/still working/);
      const stopped = await timedOut(host);
      await expect(resume(host, { id: stopped.id }, "stranger")).rejects.toThrow(/another thread/);
      await host.harness.behavior.callRpc("detach", { id: stopped.id });
      await expect(resume(host, { id: stopped.id })).rejects.toThrow(/detached/);
    });

    it("respects the concurrency limit and a deleted worker", async () => {
      const host = await setup({ maxConcurrent: 1 });
      const run = await timedOut(host);
      await host.create();
      await expect(resume(host, { id: run.id })).rejects.toThrow(/Maximum concurrent/);
      const other = await setup();
      const gone = await timedOut(other);
      other.threads.get(gone.threadId)!.deletedAt = 1;
      await expect(resume(other, { id: gone.id })).rejects.toThrow(/deleted/);
    });

    it("leaves the run timed out and released when the worker cannot be messaged", async () => {
      const host = await setup();
      const run = await timedOut(host);
      host.harness.inspection.sdk.stub("threads.send", async () => {
        throw new Error("offline");
      });
      await expect(resume(host, { id: run.id })).rejects.toThrow("offline");
      expect((await host.list()).runs[0]).toMatchObject({ status: "timed-out", resumeCount: 0 });
      expect(host.harness.inspection.sdk.callsTo("threads.archive").length).toBeGreaterThan(1);
    });
  });

  it("reattaches a spawned worker after a crash before its ID was saved", async () => {
    const host = await setup();
    const run = await host.create();
    host.bb.storage
      .database()
      .prepare("UPDATE runs SET data = json_set(data, '$.threadId', NULL, '$.status', 'starting') WHERE id = ?")
      .run(run.id);
    host.harness.inspection.sdk.stub("threads.list", async () => [host.threads.get(run.threadId)!]);
    host.harness.inspection.sdk.stub("threads.getPluginMetadata", async () => ({ runId: run.id }));
    const service = host.harness.behavior.runService("reconcile");
    await new Promise(resolve => setTimeout(resolve, 20));
    service.controller.abort();
    await service.done;
    expect((await host.list()).runs[0]).toMatchObject({ threadId: run.threadId, status: "running" });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("offers minimal schema-defined tools without injected instructions", async () => {
    const host = await setup();
    const configuration = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "origin" } }),
    );
    expect(configuration.tools.map(tool => tool.name)).toEqual([
      "subagent_create",
      "subagent_status",
      "subagent_kill",
      "subagent_resume",
    ]);
    expect(configuration.skills).toEqual([]);
    expect(configuration.instructions).toBeFalsy();
  });

  it("serves active roots for sidebar row glyphs over the plugin http route", async () => {
    const host = await setup();
    const first = await host.create();
    await host.harness.behavior.callRpc("detach", { id: first.id });
    await host.create();
    const response = await host.harness.behavior.fetchHttp("GET", "/active-rows");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ roots: [{ threadId: "origin", working: 1 }] });
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("imports only public SDK surfaces", () => {
    const scan = experimental_scanPublicSdkOnly(import.meta.dirname, {
      allow: [
        /^vitest$/,
        /^@testing-library\/react$/,
        /^react$/,
        /^@radix-ui\/react-slot$/,
        /^@radix-ui\/react-scroll-area$/,
        /^@radix-ui\/react-separator$/,
        /^@radix-ui\/react-tooltip$/,
        /^class-variance-authority$/,
        /^clsx$/,
        /^tailwind-merge$/,
      ],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
