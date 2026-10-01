import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import type { Run } from "./src/contracts.ts";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
async function setup(settings: Record<string, number> = {}) {
  const threads = new Map([
    ["origin", makeThreadResponse({ id: "origin", projectId: "project", environmentId: "environment", providerId: "pi", status: "active" })],
  ]);
  let next = 0;
  const host = createFakePluginHost({ pluginId: "subagents", settings, sdk: { threads: {
    get: async ({ threadId }) => { const thread = threads.get(threadId); if (!thread) throw new Error("missing thread"); return thread; },
    defaultExecutionOptions: async () => ({ model: "model-a", reasoningLevel: "high", permissionMode: "accept-edits", serviceTier: "default", source: "client/thread/start" }),
    spawn: async args => { const thread = makeThreadResponse({ id: `child-${++next}`, projectId: args.projectId, environmentId: "environment", status: "active", visibility: "hidden" }); threads.set(thread.id, thread); return thread; },
    output: async () => ({ output: "Findings" }),
    archive: async ({ threadId }) => { threads.get(threadId)!.archivedAt = 1; return { archived: 1 }; },
    unarchive: async ({ threadId }) => { threads.get(threadId)!.archivedAt = null; return { ok: true }; },
    stop: async () => ({ ok: true }),
    update: async ({ threadId, visibility }) => { const thread = threads.get(threadId)!; if (visibility) thread.visibility = visibility; return thread; },
    send: async () => ({}) as never,
  } } });
  hosts.push(host);
  await plugin(host.bb);
  async function create(threadId = "origin", task = "Review code") {
    const result = await host.harness.behavior.callAgentTool("subagent_create", { task }, { threadId, projectId: "project" });
    return JSON.parse(result as string) as { id: string; threadId: string };
  }
  async function list(threadId = "origin") { return host.harness.behavior.callRpc("list", { threadId }) as Promise<{ runs: Run[]; promoted: Run | null }>; }
  return { ...host, threads, create, list };
}

describe("background subagents", () => {
  it("creates hidden workers with the exact environment and execution defaults", async () => {
    const host = await setup();
    const run = await host.create();
    expect(run.threadId).toBe("child-1");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({
      environment: { type: "reuse", environmentId: "environment" }, visibility: "hidden", lifecycleOwnerThreadId: "origin",
      providerId: "pi", model: "model-a", reasoningLevel: "high", permissionMode: "accept-edits", serviceTier: "default",
    });
    expect((await host.list()).runs[0]!.status).toBe("running");
  });
  it("settles once, sends output, archives and releases the runtime", async () => {
    const host = await setup(); const run = await host.create();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: host.threads.get(run.threadId)!, lastAssistantText: "Findings" });
    await new Promise(resolve => setTimeout(resolve, 10));
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: host.threads.get(run.threadId)!, lastAssistantText: "Findings" });
    await new Promise(resolve => setTimeout(resolve, 10));
    const stored = (await host.list()).runs[0]!;
    expect(stored).toMatchObject({ status: "completed", output: "Findings", cleanupPending: false });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
  });
  it("promotes the same session, suspends automatic delivery, and returns control", async () => {
    const host = await setup(); const run = await host.create();
    const promoted = await host.harness.behavior.callRpc("promote", { id: run.id });
    expect(promoted).toEqual({ threadId: run.threadId });
    expect(host.threads.get(run.threadId)!.visibility).toBe("visible");
    expect((await host.list()).runs[0]).toMatchObject({ control: "user", deadline: null });
    expect(JSON.stringify(host.harness.inspection.sdk.callsTo("threads.send"))).toContain("begun interacting");
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: host.threads.get(run.threadId)!, lastAssistantText: "Findings" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    await expect(host.harness.behavior.callAgentTool("subagent_kill", { id: run.id }, { threadId: "origin" })).rejects.toThrow("user controls");
    expect(await host.harness.behavior.callRpc("returnControl", { id: run.id })).toEqual({ threadId: "origin" });
    expect((await host.list()).runs[0]).toMatchObject({ control: "returned", output: "Findings" });
    expect(host.threads.get(run.threadId)!.visibility).toBe("hidden");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    await host.harness.behavior.callRpc("returnControl", { id: run.id });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
  });
  it("enforces depth, ownership and capacity without relying on metadata", async () => {
    const host = await setup({ maxDepth: 1, maxConcurrent: 2 });
    const a = await host.create(); const b = await host.create();
    await expect(host.create()).rejects.toThrow("concurrent");
    await expect(host.create(a.threadId)).rejects.toThrow("depth");
    await expect(host.harness.behavior.callAgentTool("subagent_kill", { id: b.id }, { threadId: a.threadId })).rejects.toThrow("another thread");
    await expect(host.harness.behavior.callAgentTool("subagent_status", { id: a.id }, { threadId: "stranger" })).rejects.toThrow("another thread");
  });
  it("preserves partial output and stops before harvesting a killed run", async () => {
    const host = await setup(); const run = await host.create();
    const result = await host.harness.behavior.callAgentTool("subagent_kill", { id: run.id, reason: "stuck" }, { threadId: "origin" });
    expect(JSON.parse(result as string)).toMatchObject({ status: "killed", output: "Findings", error: "stuck" });
    const calls = host.harness.inspection.sdk.calls.map(call => call.path);
    expect(calls.indexOf("threads.stop")).toBeLessThan(calls.indexOf("threads.output"));
  });
  it("reconciles completed workers and retries notification failures after reload", async () => {
    const host = await setup(); const run = await host.create();
    host.threads.get(run.threadId)!.status = "idle";
    host.harness.inspection.sdk.stub("threads.send", async () => { throw new Error("offline"); });
    const service = host.harness.behavior.runService("reconcile");
    await new Promise(resolve => setTimeout(resolve, 20));
    service.controller.abort(); await service.done;
    expect((await host.list()).runs[0]!.notifications).toHaveLength(1);
    host.harness.inspection.sdk.stub("threads.send", async () => ({}) as never);
    const reloaded = await host.harness.lifecycle.reload(plugin);
    const resumed = reloaded.harness.behavior.runService("reconcile");
    await new Promise(resolve => setTimeout(resolve, 20));
    resumed.controller.abort(); await resumed.done;
    expect((await reloaded.harness.behavior.callRpc("list", { threadId: "origin" }) as { runs: Run[] }).runs[0]!.notifications).toHaveLength(0);
    await reloaded.harness.lifecycle.dispose();
  });
  it("bounds list output independently of accumulated prompts and results", async () => {
    const host = await setup(); await host.create("origin", "x".repeat(32000));
    const result = await host.harness.behavior.callAgentTool("subagent_status", {}, { threadId: "origin" });
    expect((result as string).length).toBeLessThan(2000);
    expect(result).not.toContain("task");
  });
  it("enforces deadlines while preserving output", async () => {
    const host = await setup(); const run = await host.create();
    const db = host.bb.storage.database();
    db.prepare("UPDATE runs SET data = json_set(data, '$.deadline', 1) WHERE id = ?").run(run.id);
    const service = host.harness.behavior.runService("reconcile");
    await new Promise(resolve => setTimeout(resolve, 20));
    service.controller.abort(); await service.done;
    expect((await host.list()).runs[0]).toMatchObject({ status: "timed-out", output: "Findings" });
  });
  it("reattaches a spawned worker after a crash before its ID was saved", async () => {
    const host = await setup(); const run = await host.create();
    host.bb.storage.database().prepare("UPDATE runs SET data = json_set(data, '$.threadId', NULL, '$.status', 'starting') WHERE id = ?").run(run.id);
    host.harness.inspection.sdk.stub("threads.list", async () => [host.threads.get(run.threadId)!]);
    host.harness.inspection.sdk.stub("threads.getPluginMetadata", async () => ({ runId: run.id }));
    const service = host.harness.behavior.runService("reconcile");
    await new Promise(resolve => setTimeout(resolve, 20));
    service.controller.abort(); await service.done;
    expect((await host.list()).runs[0]).toMatchObject({ threadId: run.threadId, status: "running" });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("offers minimal schema-defined tools without injected instructions", async () => {
    const host = await setup();
    const configuration = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "origin" } }));
    expect(configuration.tools.map(tool => tool.name)).toEqual(["subagent_create", "subagent_status", "subagent_kill"]);
    expect(configuration.skills).toEqual([]);
    expect(configuration.instructions).toBeFalsy();
  });
  it("imports only public SDK surfaces", () => {
    const scan = experimental_scanPublicSdkOnly(import.meta.dirname, { allow: [/^vitest$/, /^@testing-library\/react$/, /^react$/, /^@radix-ui\/react-slot$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/] });
    expect(scan.violations).toEqual([]); expect(scan.privateDependencies).toEqual([]);
  });
});
