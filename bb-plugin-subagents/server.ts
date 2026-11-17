import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createInput, resumeInput, rpcContract } from "./src/contracts.ts";
import { Subagents } from "./src/service.ts";
import type { StatusSummarizer } from "./src/summarizer.ts";
export { rpcContract } from "./src/contracts.ts";

export default async function plugin(bb: BbPluginApi, summarizer?: StatusSummarizer) {
  const settings = bb.settings.define({
    maxDepth: {
      type: "number",
      label: "Maximum nesting depth",
      default: 2,
      experimental_schema: z.number().int().min(1).max(10),
    },
    maxConcurrent: {
      type: "number",
      label: "Maximum active subagents per original thread",
      default: 4,
      experimental_schema: z.number().int().min(1).max(32),
    },
    defaultTimeout: {
      type: "number",
      label: "Default timeout in seconds (0 = unlimited)",
      default: 1800,
      experimental_schema: z.number().int().min(0).max(86400),
    },
  });
  const service = new Subagents(bb, () => settings.get(), summarizer);
  bb.agents.registerTool({
    name: "subagent_create",
    description:
      "Start a background subagent in this thread's existing environment. Returns immediately with a run ID; completion is delivered to this thread. Inherits provider, model, reasoning level and permissions; optional model selects another model of the same provider, and optional reasoningLevel (a level id the model lists, such as low, medium, high or xhigh) overrides the inherited level. Workers share files; coordinate edits. timeout is seconds (default 1800, 0 unlimited); omit unless you can estimate the runtime. Workers get time-check notices as the deadline nears, are asked to wrap up at it, and are stopped only after a grace period (10% of the timeout, 30–600 seconds); settled runs, including timed-out ones, can be continued with subagent_resume. Users can detach a run into a child thread. Parent interruption does not kill its workers.",
    parameters: createInput,
    async execute(input, { threadId }) {
      const run = await service.create(threadId, input);
      return JSON.stringify({ id: run.id, title: run.title, status: run.status, threadId: run.threadId });
    },
  });
  bb.agents.registerTool({
    name: "subagent_status",
    description:
      "Read a subagent's status and bounded output by run ID, or list up to 100 recent runs owned by this thread and its descendants. Full history is in each worker thread.",
    parameters: z.object({ id: z.string().optional() }).strict(),
    execute: ({ id }, { threadId }) => JSON.stringify(service.status(threadId, id)),
  });
  bb.agents.registerTool({
    name: "subagent_kill",
    description:
      "Stop an owned background subagent by run ID and preserve its partial output; subagent_resume can continue it later. With no ID, list owned runs. Cannot stop a detached session, yourself, peers, or ancestors.",
    parameters: z.object({ id: z.string().optional(), reason: z.string().max(1000).optional() }).strict(),
    async execute({ id, reason }, { threadId }) {
      return JSON.stringify(
        id ? await service.kill(threadId, id, reason ?? "Stopped by the owning agent.") : service.status(threadId),
      );
    },
  });
  bb.agents.registerTool({
    name: "subagent_resume",
    description:
      "Continue a settled subagent you own (completed, failed, timed out, or killed) in its existing session, with a fresh time budget. Optional message steers it with new instructions; without one it continues where it left off. A completed subagent needs a message. Completion is delivered to this thread again. Cannot resume working runs, detached sessions, or peers' runs.",
    parameters: resumeInput,
    async execute(input, { threadId }) {
      const run = await service.resume(threadId, input);
      return JSON.stringify({
        id: run.id,
        title: run.title,
        status: run.status,
        threadId: run.threadId,
        resumeCount: run.resumeCount,
        deadline: run.deadline,
      });
    },
  });
  let settingsDepth = (await settings.get()).maxDepth;
  bb.agents.configure(context => {
    const run = service.byThread(context.thread.id);
    return {
      tools: [...(!run || run.depth < settingsDepth ? ["subagent_create"] : []), "subagent_status", "subagent_kill", "subagent_resume"],
      skills: [],
    };
  });
  settings.onChange(value => {
    settingsDepth = value.maxDepth;
  });
  const observe = (threadId: string, failure?: string, lastAssistantText?: string | null) => {
    void service.settle(threadId, failure, lastAssistantText).catch(cause => bb.log.warn(String(cause)));
  };
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => observe(thread.id, undefined, lastAssistantText));
  bb.events.on("thread.failed", ({ thread, error }) => observe(thread.id, error ?? "Worker failed."));
  bb.events.on("experimental_thread.events", ({ thread }) => {
    void service.refreshSummaryIfNeeded(thread.id).catch(cause => bb.log.warn(String(cause)));
  });
  bb.rpc.register(rpcContract, {
    list: ({ threadId }) => service.list(threadId),
    detach: ({ id }) => service.detach(id),
  });
  bb.http.route("GET", "/active-rows", () => Response.json({ roots: service.activeRoots() }));
  bb.background.service("reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        await service.reconcile();
        if (signal.aborted) break;
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 5000);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    },
  });
  bb.onDispose(() => service.dispose());
}
