import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, type Job, type WorkforestSource } from "./contracts.js";
import {
  buildOperation,
  createWorkforest,
  parseEnvelope,
  runCommand,
} from "./workforest.js";

const jobs = new Map<string, Job>();
let running: Promise<void> | null = null;
let controller: AbortController | null = null;
let taskRunning = false;
let sourceCatalog: { expires: number; items: WorkforestSource[] } | undefined;
async function sources(signal: AbortSignal): Promise<WorkforestSource[]> {
  if (sourceCatalog && sourceCatalog.expires > Date.now())
    return sourceCatalog.items;
  const [configText, templates, cacheText] = await Promise.all([
    runCommand(["config", "show", "--json"], { signal }),
    createWorkforest(signal).templates(),
    runCommand(["cache", "list", "--json"], { signal }),
  ]);
  const config = parseEnvelope(
    configText,
    z.object({
      resolvedDirectories: z.object({
        repos: z.string().startsWith("/"),
        workspaces: z.string().startsWith("/"),
      }),
    }),
  );
  const cache = parseEnvelope(
    cacheText,
    z.array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
        slug: z.string().min(1),
      }),
    ),
  );
  const items = [
    ...templates.map((template) => ({
      id: `template:${template.id}`,
      kind: "template" as const,
      name: template.id,
      source: `@${template.id}`,
      path: join(config.resolvedDirectories.workspaces, template.id),
      description: template.config.description,
    })),
    ...cache.map((repo) => ({
      id: `repository:${repo.slug}`,
      kind: "repository" as const,
      name: repo.name,
      source: repo.slug,
      path: join(config.resolvedDirectories.repos, repo.name),
    })),
  ];
  sourceCatalog = { expires: Date.now() + 30000, items };
  return items;
}
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    sources: (_, context) => sources(context.signal),
    ensureSource: async ({ sourceId }, context) => {
      const source = (await sources(context.signal)).find(
        (source) => source.id === sourceId,
      );
      if (!source)
        throw new Error("Workforest source no longer exists. Refresh sources.");
      await mkdir(source.path, { recursive: true });
      return source;
    },
    inventory: (_, context) => createWorkforest(context.signal).inventory(),
    createEnvironment: async ({ name, source }, context) => {
      const output = await runCommand(["new", name, source, "--json"], {
        signal: context.signal,
        timeoutMs: 15 * 60 * 1000,
      });
      const result = parseEnvelope(
        output,
        z.object({
          targetPath: z.string().startsWith("/"),
          selector: z.string().min(1),
          outcome: z.string(),
        }),
      );
      return { path: result.targetPath, selector: result.selector };
    },
    createTask: async ({ selector, repository, name, setup }, context) => {
      if (running || taskRunning)
        throw new Error(
          "Another Workforest operation is running on this machine.",
        );
      taskRunning = true;
      try {
        const workforest = createWorkforest(context.signal);
        const detail = await workforest.detail(selector);
        const command = buildOperation(
          { kind: "task", selector, repository, name, setup },
          detail,
        );
        await runCommand([...command.args, "--json"], {
          cwd: command.cwd,
          signal: context.signal,
          timeoutMs: 15 * 60 * 1000,
        });
        const fresh = await workforest.detail(selector);
        const task = fresh.tasks.find(
          (task) => task.parentRepo === repository && task.slug === name,
        );
        if (!task)
          throw new Error(
            "Task was created but could not be resolved. Refresh Workforest status before retrying.",
          );
        return { path: task.path, branch: task.branch };
      } finally {
        taskRunning = false;
      }
    },
    templates: (_, context) => createWorkforest(context.signal).templates(),
    detail: ({ selector }, context) =>
      createWorkforest(context.signal).detail(selector),
    logs: ({ selector }, context) =>
      createWorkforest(context.signal).logs(selector),
    preview: ({ selector }, context) =>
      createWorkforest(context.signal).preview(selector),
    jobs: () => [...jobs.values()].reverse(),
    start: (operation, context) => {
      if (running || taskRunning)
        throw new Error(
          "Another Workforest operation is running on this machine. Wait for it to finish.",
        );
      const job: Job = {
        id: randomUUID(),
        label:
          operation.kind === "create"
            ? `Create ${operation.name}`
            : `${operation.kind}: ${operation.selector}`,
        state: "running",
        output: "",
        startedAt: Date.now(),
        finishedAt: null,
      };
      jobs.set(job.id, job);
      if (jobs.size > 30) jobs.delete(jobs.keys().next().value!);
      const lease = context.experimental_retainWorker();
      controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        context.lifecycle.signal,
      ]);
      // Mutations outlive the initiating RPC, but never the owning plugin generation.
      running = Promise.resolve().then(async () => {
        try {
          const detail =
            operation.kind === "create"
              ? undefined
              : await createWorkforest(signal).detail(operation.selector);
          const command = buildOperation(operation, detail);
          job.output = (
            await runCommand(command.args, {
              cwd: command.cwd,
              signal,
              timeoutMs: 15 * 60 * 1000,
            })
          ).slice(-24000);
          job.state = "succeeded";
        } catch (error) {
          job.state = "failed";
          job.output = error instanceof Error ? error.message : String(error);
        } finally {
          job.finishedAt = Date.now();
          try {
            await lease.dispose();
          } catch (error) {
            job.state = "failed";
            job.output += `\nWorker cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
          } finally {
            running = null;
            controller = null;
          }
        }
      });
      return { ...job };
    },
  },
  dispose: async () => {
    controller?.abort();
    await running;
  },
});
