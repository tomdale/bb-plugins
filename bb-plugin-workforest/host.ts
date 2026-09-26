import { randomUUID } from "node:crypto";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract, type Job } from "./contracts.js";
import { buildOperation, createWorkforest, runCommand } from "./workforest.js";

const jobs = new Map<string, Job>();
let running: Promise<void> | null = null;
let controller: AbortController | null = null;
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    inventory: (_, context) => createWorkforest(context.signal).inventory(),
    templates: (_, context) => createWorkforest(context.signal).templates(),
    detail: ({ selector }, context) =>
      createWorkforest(context.signal).detail(selector),
    logs: ({ selector }, context) =>
      createWorkforest(context.signal).logs(selector),
    preview: ({ selector }, context) =>
      createWorkforest(context.signal).preview(selector),
    jobs: () => [...jobs.values()].reverse(),
    start: (operation, context) => {
      if (running)
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
