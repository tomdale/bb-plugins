import { posix } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  hostContract,
  rpcContract,
  targetSchema,
  type Checkout,
  type Detail,
} from "./contracts.js";
import { isWithin, resolveCheckout } from "./workforest.js";
export { rpcContract } from "./contracts.js";

export function ensureReady(detail: Detail, path: string) {
  resolveCheckout(detail, path);
  const task = detail.tasks.find((task) => task.path === path);
  if (task && !["ready", "skipped"].includes(task.state))
    throw new Error(
      `Task is ${task.state}; wait for setup before launching a thread.`,
    );
  const repos = detail.repositories.filter(
    (repo) =>
      path === detail.path ||
      repo.path === path ||
      repo.name === task?.parentRepo,
  );
  if (
    repos.some(
      (repo) => repo.setup && !["ready", "skipped"].includes(repo.setup.status),
    )
  )
    throw new Error(
      "Repository setup is not ready. Resolve setup before launching a thread.",
    );
}

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const connecting = new Map<string, Promise<{ projectId: string }>>();
  const launchLocks = new Set<string>();
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
  async function checkout(target: Checkout) {
    const detail = await host.call(
      "detail",
      { selector: target.selector },
      { hostId: target.hostId },
    );
    ensureReady(detail, target.path);
    return detail;
  }
  async function connect(target: Checkout & { projectId: string | null }) {
    const key = `${target.hostId}:${target.path}:${target.projectId ?? "new"}`;
    const current = connecting.get(key);
    if (current) return current;
    const result = (async () => {
      await checkout(target);
      if (target.projectId) {
        const project = await bb.sdk.projects.get({
          projectId: target.projectId,
        });
        if (project.kind !== "standard")
          throw new Error("Choose a standard BB project for Workforest work.");
        if (!project.sources.some((source) => source.hostId === target.hostId))
          throw new Error(
            "This project has no source on the selected machine. Add a source in BB first, or create a new project here.",
          );
        return { projectId: project.id };
      }
      const projects = await bb.sdk.projects.list();
      const existing = projects.find((project) =>
        project.sources.some(
          (source) =>
            source.hostId === target.hostId && source.path === target.path,
        ),
      );
      if (existing) return { projectId: existing.id };
      const project = await bb.sdk.projects.create({
        name: target.selector,
        source: {
          type: "local_path",
          hostId: target.hostId,
          path: target.path,
        },
      });
      return { projectId: project.id };
    })();
    connecting.set(key, result);
    try {
      return await result;
    } finally {
      connecting.delete(key);
    }
  }

  bb.rpc.register(rpcContract, {
    bootstrap: async () => {
      const [hosts, projects] = await Promise.all([
        bb.sdk.hosts.list(),
        bb.sdk.projects.list(),
      ]);
      return { hosts, projects };
    },
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
    connect,
    launch: async (target) => {
      const key = `${target.hostId}:${target.path}`;
      if (launchLocks.has(key))
        throw new Error(
          "A thread is already being launched for this checkout.",
        );
      launchLocks.add(key);
      try {
        await connect(target);
        const thread = await bb.sdk.threads.spawn({
          projectId: target.projectId,
          environment: {
            type: "host",
            hostId: target.hostId,
            workspace: { type: "unmanaged", path: target.path },
          },
          prompt: target.prompt,
          title: target.selector,
        });
        bb.realtime.publish("changed", { hostId: target.hostId });
        return { threadId: thread.id };
      } finally {
        launchLocks.delete(key);
      }
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
