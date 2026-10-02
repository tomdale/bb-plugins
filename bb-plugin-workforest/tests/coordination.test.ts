import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makePluginAgentConfigurationContext,
  makeMessageDispatchHookContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { detail, entry } from "./fixtures.js";

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(dispose.splice(0).map((fn) => fn()));
});
const workspace = {
  ...entry,
  type: "template-workspace" as const,
  repos: ["app"],
};
const repo = { ...detail.repositories[0]!, path: `${entry.path}/app` };
const role = {
  role: "coordinator",
  hostId: "h1",
  selector: entry.selector,
  workspacePath: entry.path,
  checkoutPath: entry.path,
};
const lane = {
  ...detail.tasks[0]!,
  slug: "refunds",
  path: `${entry.path}/_tasks/app/refunds`,
};
const assignment = {
  repository: "app",
  taskName: "refunds",
  task: "Implement refunds",
  doneCriteria: "Tests pass",
};
function setup() {
  let metadata: Record<string, unknown> = { coordination: role };
  let lanes: (typeof lane)[] = [];
  const fake = createFakePluginHost({
    pluginId: "workforest",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            environmentId: "e1",
            parentThreadId: threadId === "child" ? "parent" : null,
          }),
        getPluginMetadata: async () => metadata,
        updatePluginMetadata: async ({ set }) => {
          metadata = { ...metadata, ...set };
          return metadata;
        },
        list: async () => [],
        defaultExecutionOptions: async () => ({
          model: "test-model",
          reasoningLevel: "medium",
          permissionMode: "accept-edits",
          serviceTier: "default",
          source: "client/turn/start",
        }),
        spawn: async () => makeThreadResponse({ id: "child" }),
      },
      environments: {
        get: async () => ({ id: "e1", hostId: "h1", path: entry.path }),
      },
      projects: {
        list: async () => [],
        create: async () => ({ id: "repo-project" }),
      },
    },
    experimental_callHostRpc: async ({ method }) => {
      if (method === "inventory")
        return { workspaces: [workspace], repositories: [] };
      if (method === "detail")
        return { ...detail, repositories: [repo], tasks: lanes };
      if (method === "createTask") {
        lanes = [lane];
        return { path: lane.path, branch: lane.branch };
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  plugin(fake.bb);
  dispose.push(() => fake.harness.lifecycle.dispose());
  return fake.harness;
}
const toolContext = {
  threadId: "parent",
  signal: new AbortController().signal,
};
describe("Workforest coordination", () => {
  it("selects coordinator tools only for the matching host and checkout", async () => {
    const h = setup();
    await h.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: { id: "parent" },
        host: { id: "h1" },
        environment: { path: entry.path },
      }),
    );
    await h.behavior.callRpc("project", {
      hostId: "h1",
      selector: entry.selector,
    });
    const base = makePluginAgentConfigurationContext({
      pluginMetadata: { coordination: role },
      environment: { path: entry.path },
      host: { id: "h1" },
    });
    const config = await h.behavior.resolveAgentConfiguration(base);
    expect(config.tools.map((tool) => tool.name)).toEqual([
      "workforest_workspace_context",
      "workforest_delegate_to_repo",
    ]);
    expect(config.instructions).toContain("committed HEAD");
    expect(
      (
        await h.behavior.resolveAgentConfiguration({
          ...base,
          host: { ...base.host, id: "other" },
        })
      ).tools,
    ).toEqual([]);
    expect(
      (
        await h.behavior.resolveAgentConfiguration({
          ...base,
          environment: { ...base.environment, path: "/other" },
        })
      ).tools,
    ).toEqual([]);
  });
  it("rejects coordinator metadata forged for a repository checkout", async () => {
    const h = setup();
    const forged = { ...role, role: "coordinator", checkoutPath: repo.path };
    const config = await h.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        pluginMetadata: { coordination: forged },
        environment: { path: repo.path },
        host: { id: "h1" },
      }),
    );
    expect(config.tools).toEqual([]);
    h.sdk.stub("threads.getPluginMetadata", async () => ({
      coordination: forged,
    }));
    h.sdk.stub("environments.get", async () => ({
      id: "e1",
      hostId: "h1",
      path: repo.path,
    }));
    await expect(
      h.behavior.callAgentTool(
        "workforest_delegate_to_repo",
        assignment,
        toolContext,
      ),
    ).rejects.toThrow("workspace root");
    expect(h.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("gives workers context but not delegation", async () => {
    const h = setup();
    const config = await h.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        pluginMetadata: {
          coordination: { ...role, role: "worker", checkoutPath: repo.path },
        },
        environment: { path: repo.path },
        host: { id: "h1" },
      }),
    );
    expect(config.tools.map((tool) => tool.name)).toEqual([
      "workforest_workspace_context",
    ]);
    expect(config.instructions).toContain(
      "keep edits within your assigned checkout",
    );
  });
  it("discovers the workspace root on dispatch and makes picker context survive reload", async () => {
    const h = setup();
    h.sdk.stub("threads.getPluginMetadata", async () => ({}));
    const ctx = makeMessageDispatchHookContext({
      thread: { id: "parent" },
      host: { id: "h1" },
      environment: { path: entry.path },
    });
    expect(await h.registrations.hooks["message.dispatch"]!(ctx)).toEqual({
      action: "proceed",
    });
    expect(h.inspection.sdk.callsTo("threads.updatePluginMetadata")[0]).toEqual(
      [
        {
          threadId: "parent",
          pluginId: "workforest",
          set: { coordination: role },
        },
      ],
    );
    const next = await h.lifecycle.reload(plugin);
    const config = await next.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        environment: { path: entry.path },
        host: { id: "h1" },
      }),
    );
    expect(config.tools.map((tool) => tool.name)).toContain(
      "workforest_delegate_to_repo",
    );
  });
  it("creates an isolated task child with metadata before its first turn", async () => {
    const h = setup();
    const result = await h.behavior.callAgentTool(
      "workforest_delegate_to_repo",
      assignment,
      toolContext,
    );
    expect(JSON.parse(result as string)).toEqual({
      threadId: "child",
      path: lane.path,
      branch: lane.branch,
      reused: false,
    });
    const spawn = h.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<
      string,
      any
    >;
    expect(spawn.projectId).toBe("repo-project");
    expect(spawn.parentThreadId).toBe("parent");
    expect(spawn.environment).toEqual({
      type: "host",
      hostId: "h1",
      workspace: { type: "unmanaged", path: lane.path },
    });
    expect(spawn.pluginMetadata.coordination.role).toBe("worker");
    expect(spawn.prompt).toContain("Tests pass");
    expect(h.inspection.sdk.callsTo("projects.create")[0]).toEqual([
      {
        name: "app",
        source: { type: "local_path", hostId: "h1", path: repo.path },
      },
    ]);
    expect(
      h.experimental_hostRpcCalls.find((call) => call.method === "createTask")
        ?.input,
    ).toEqual({
      selector: entry.selector,
      repository: "app",
      name: "refunds",
      setup: false,
    });
    const reused = await h.behavior.callAgentTool(
      "workforest_delegate_to_repo",
      assignment,
      toolContext,
    );
    expect(JSON.parse(reused as string).reused).toBe(true);
    expect(h.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    await expect(
      h.behavior.callAgentTool(
        "workforest_delegate_to_repo",
        { ...assignment, task: "Different task" },
        toolContext,
      ),
    ).rejects.toThrow("different assignment");
  });
  it("allows parallel repository tasks in distinct task lanes but rejects duplicate in-flight delegation", async () => {
    const h = setup();
    const result = await Promise.allSettled([
      h.behavior.callAgentTool(
        "workforest_delegate_to_repo",
        assignment,
        toolContext,
      ),
      h.behavior.callAgentTool(
        "workforest_delegate_to_repo",
        assignment,
        toolContext,
      ),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(h.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("rejects unknown members and detached role metadata", async () => {
    const h = setup();
    await expect(
      h.behavior.callAgentTool(
        "workforest_delegate_to_repo",
        { ...assignment, repository: "other" },
        toolContext,
      ),
    ).rejects.toThrow("not a member");
    h.sdk.stub("threads.getPluginMetadata", async () => ({
      coordination: { ...role, checkoutPath: "/wrong" },
    }));
    await expect(
      h.behavior.callAgentTool(
        "workforest_delegate_to_repo",
        assignment,
        toolContext,
      ),
    ).rejects.toThrow("not configured");
    expect(h.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("refuses shared checkouts attached even to an idle live thread", async () => {
    const h = setup();
    h.sdk.stub("threads.list", async () => [
      makeThreadResponse({
        id: "existing",
        environmentId: "repo-env",
        status: "idle",
      }),
    ]);
    h.sdk.stub("environments.get", async ({ environmentId }) => ({
      id: environmentId,
      hostId: "h1",
      path: environmentId === "repo-env" ? repo.path : entry.path,
    }));
    await expect(
      h.behavior.callAgentTool(
        "workforest_delegate_to_repo",
        { ...assignment, checkout: "shared" },
        toolContext,
      ),
    ).rejects.toThrow("@thread:existing");
    expect(h.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("shared mode skips task creation and keeps its child repository-scoped", async () => {
    const h = setup();
    await h.behavior.callAgentTool(
      "workforest_delegate_to_repo",
      { ...assignment, checkout: "shared" },
      toolContext,
    );
    expect(
      h.experimental_hostRpcCalls.some((call) => call.method === "createTask"),
    ).toBe(false);
    expect(
      (h.inspection.sdk.callsTo("threads.spawn")[0]![0] as any).environment
        .workspace.path,
    ).toBe(repo.path);
  });
  it("returns fresh repository inventory and child status", async () => {
    const h = setup();
    h.sdk.stub("threads.list", async () => [
      makeThreadResponse({ id: "child", status: "idle" }),
    ]);
    const result = JSON.parse(
      (await h.behavior.callAgentTool(
        "workforest_workspace_context",
        {},
        toolContext,
      )) as string,
    );
    expect(result.workspace.repositories[0].path).toBe(repo.path);
    expect(result.threads[0].id).toBe("child");
  });
  it("retains a task lane and releases its delegation lock when spawn fails", async () => {
    const h = setup();
    h.sdk.stub("threads.spawn", async () => {
      throw new Error("offline");
    });
    await expect(
      h.behavior.callAgentTool(
        "workforest_delegate_to_repo",
        assignment,
        toolContext,
      ),
    ).rejects.toThrow("offline");
    h.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: "retry-child" }),
    );
    const retried = JSON.parse(
      (await h.behavior.callAgentTool(
        "workforest_delegate_to_repo",
        assignment,
        toolContext,
      )) as string,
    );
    expect(retried.threadId).toBe("retry-child");
    expect(
      h.experimental_hostRpcCalls.filter(
        (call) => call.method === "createTask",
      ),
    ).toHaveLength(1);
  });
});
