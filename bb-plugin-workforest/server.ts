import { posix } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  hostContract,
  rpcContract,
  targetSchema,
  type Detail,
} from "./contracts.js";
import { isWithin, resolveCheckout } from "./workforest.js";
import { registerCoordination } from "./coordination.js";

import { WORKFOREST_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
export { WORKFOREST_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

/** A Workforest source is either a configured template or one repository. */
export const workforestEnvironmentInputs = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("new"),
      source: z.string().min(1).max(200),
      name: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(80),
    })
    .strict(),
  z
    .object({
      mode: z.literal("existing"),
      selector: z.string().min(1).max(200),
      path: z.string().startsWith("/").max(16384),
    })
    .strict(),
]);
type WorkforestEnvironmentInputs = z.infer<typeof workforestEnvironmentInputs>;

export { rpcContract } from "./contracts.js";

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const coordination = registerCoordination(bb);

  bb.experimental_environments.register({
    id: WORKFOREST_ENVIRONMENT_PROVIDER_ID,
    displayName: "Workforest workspace",
    description:
      "Create or attach a Workforest worktree or multi-repository workspace.",
    icon: "GitBranch",
    requires: { projectCheckout: true },
    inputs: workforestEnvironmentInputs,
    availability(context) {
      return context.projectCheckout === null
        ? {
            status: "unavailable",
            message: "Select a Workforest template or repository project.",
          }
        : { status: "available" };
    },
    policy: { retireGraceMs: null },
    experimental_existingPath: (inputs) =>
      inputs.mode === "existing" ? inputs.path : null,
    async validate(context) {
      if (context.inputs.mode === "existing") return { action: "accept" };
      if (!context.inputs.source.startsWith("@")) return { action: "accept" };
      return { action: "accept" };
    },
    async create(context) {
      if (context.inputs.mode === "existing") {
        if (!(await context.experimental_claimPath(context.inputs.path))) {
          return {
            status: "failed",
            message: "That Workforest checkout is already in use.",
          };
        }
        const detail = await host.call(
          "detail",
          { selector: context.inputs.selector },
          { hostId: context.host.id, signal: context.signal },
        );
        resolveCheckout(detail, context.inputs.path);
        const role = await coordination.identify(
          context.host.id,
          context.inputs.path,
        );
        if (role) await coordination.seed(context.thread.id, role);
        return {
          status: "created",
          path: context.inputs.path,
          ownsPath: false,
        };
      }
      context.report.step(`Creating Workforest ${context.inputs.source}…`);
      try {
        const created = await host.call(
          "createEnvironment",
          { name: context.inputs.name, source: context.inputs.source },
          { hostId: context.host.id, signal: context.signal },
        );
        const role = await coordination.identify(context.host.id, created.path);
        if (role) await coordination.seed(context.thread.id, role);
        return { status: "created", path: created.path, ownsPath: true };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async remove() {
      // Workforest deliberately owns workspace deletion. BB must not run `wf delete`
      // when a thread is archived because other tools or threads may still use it.
      return { status: "removed" };
    },
  });

  const inventoryCache = new Map<
    string,
    { expires: number; result: ReturnType<typeof inventory> }
  >();
  async function inventory(hostId: string) {
    return host.call("inventory", null, { hostId });
  }
  async function cachedInventory(hostId: string) {
    const cached = inventoryCache.get(hostId);
    if (cached && cached.expires > Date.now()) return cached.result;
    const result = inventory(hostId);
    inventoryCache.set(hostId, { expires: Date.now() + 10000, result });
    try {
      return await result;
    } catch (error) {
      inventoryCache.delete(hostId);
      throw error;
    }
  }
  const pendingProjects = new Map<
    string,
    Promise<{ projectId: string; path: string }>
  >();
  function ensureProject(
    hostId: string,
    selector: string,
    requestedPath?: string,
  ) {
    const key = JSON.stringify([hostId, selector, requestedPath]);
    const pending = pendingProjects.get(key);
    if (pending) return pending;
    const result = (async () => {
      // Resolve on the machine again: a stale browser inventory must not register a removed checkout.
      const detail = await host.call("detail", { selector }, { hostId });
      const path = resolveCheckout(detail, requestedPath ?? detail.path);
      await coordination.identify(hostId, path);
      const projects = await bb.sdk.projects.list();
      const existing = projects.find((project) =>
        project.sources.some(
          (source) => source.hostId === hostId && source.path === path,
        ),
      );
      const project =
        existing ??
        (await bb.sdk.projects.create({
          name: selector.replace("/", " / "),
          source: { type: "local_path", hostId, path },
        }));
      return { projectId: project.id, path };
    })().finally(() => pendingProjects.delete(key));
    pendingProjects.set(key, result);
    return result;
  }
  bb.rpc.register(rpcContract, {
    bootstrap: async () => {
      const [hosts, projects] = await Promise.all([
        bb.sdk.hosts.list(),
        bb.sdk.projects.list(),
      ]);
      return { hosts, projects };
    },
    project: ({ hostId, selector, path }) =>
      ensureProject(hostId, selector, path),
    inventory: ({ hostId }) => inventory(hostId),
    templates: ({ hostId }) => host.call("templates", null, { hostId }),
    detail: ({ hostId, selector }) =>
      host.call("detail", { selector }, { hostId }),
    logs: ({ hostId, selector }) => host.call("logs", { selector }, { hostId }),
    jobs: ({ hostId }) => host.call("jobs", null, { hostId }),
    preview: ({ hostId, selector }) =>
      host.call("preview", { selector }, { hostId }),
    start: async ({ hostId, operation }) => {
      const result = await host.call("start", operation, { hostId });
      inventoryCache.delete(hostId);
      bb.realtime.publish("changed", { hostId });
      return result;
    },
    context: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) return null;
      const environment = await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });
      if (!environment.path)
        return { hostId: environment.hostId, entry: null, path: null };
      const data = await cachedInventory(environment.hostId);
      const entries = [...data.repositories, ...data.workspaces].sort(
        (a, b) => b.path.length - a.path.length,
      );
      let entry =
        entries.find((entry) => isWithin(environment.path!, entry.path)) ??
        null;
      // Single-repository lanes live beside their parent, under <repo>/_tasks/<change>.
      // The layout only narrows candidates; fresh Workforest metadata establishes ownership.
      if (!entry) {
        for (const candidate of entries.filter(
          (entry) =>
            entry.type === "worktree" &&
            isWithin(
              environment.path!,
              posix.join(posix.dirname(entry.path), "_tasks", entry.changeName),
            ),
        )) {
          const detail = await host.call(
            "detail",
            { selector: candidate.selector },
            { hostId: environment.hostId },
          );
          if (
            detail.tasks.some((task) => isWithin(environment.path!, task.path))
          ) {
            entry = candidate;
            break;
          }
        }
      }
      return { hostId: environment.hostId, entry, path: environment.path };
    },
  });

  bb.cli.register({
    name: "workforest",
    summary: "Inspect Workforest checkouts on an explicit BB machine",
    commands: [
      {
        name: "list",
        summary: "List managed checkouts",
        usage: "bb workforest list <host-id>",
      },
      {
        name: "status",
        summary: "Inspect checkout status",
        usage: "bb workforest status <host-id> <group/name>",
      },
    ],
    async run(argv) {
      const [command, hostId, selector, ...extra] = argv;
      if (
        !hostId ||
        extra.length ||
        !["list", "status"].includes(command ?? "") ||
        (command === "list" && selector)
      )
        return {
          exitCode: 1,
          stderr:
            "Usage: bb workforest list <host-id> | status <host-id> <group/name>",
        };
      try {
        const result =
          command === "list"
            ? await inventory(hostId)
            : await host.call(
                "detail",
                targetSchema.pick({ selector: true }).parse({ selector }),
                { hostId },
              );
        const text = JSON.stringify(result, null, 2);
        if (Buffer.byteLength(text) > 200000)
          throw new Error(
            "Inventory is too large for CLI output. Use the Workforest UI.",
          );
        return { exitCode: 0, stdout: text };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
