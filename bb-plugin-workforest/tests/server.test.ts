import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
import plugin from "../server.js";
import { bootstrap, detail, entry } from "./fixtures.js";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});
async function setup(environmentPath = entry.path) {
  const project = {
    ...bootstrap.projects[0]!,
    kind: "standard" as const,
    createdAt: 0,
    updatedAt: 0,
    gitRemoteUrl: null,
    sources: [
      {
        ...bootstrap.projects[0]!.sources[0]!,
        id: "source1",
        projectId: "p1",
        type: "local_path" as const,
        isDefault: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  };
  const fake = createFakePluginHost({
    pluginId: "workforest",
    sdk: {
      projects: {
        list: async () => [project],
        get: async () => project,
        create: async () => ({ ...project, id: "p2" }),
      },
      threads: {
        spawn: async () => makeThreadResponse({ id: "t-new" }),
        get: async () => makeThreadResponse({ id: "t1", environmentId: "e1" }),
      },
      environments: {
        get: async () => ({
          id: "e1",
          hostId: "h1",
          path: environmentPath,
          projectId: "p1",
          baseBranch: null,
          branchName: "feature/fix-auth",
          createdAt: 0,
          updatedAt: 0,
          defaultBranch: "main",
          isGitRepo: true,
          isWorktree: true,
          managed: false,
          mergeBaseBranch: null,
          name: null,
          status: "ready",
          workspaceProvisionType: "unmanaged",
        }),
      },
    },
    experimental_callHostRpc: async ({ method }) => {
      if (method === "detail") return detail;
      if (method === "inventory")
        return { workspaces: [], repositories: [entry] };
      throw new Error(`Unexpected ${method}`);
    },
  });
  plugin(fake.bb);
  disposers.push(() => fake.harness.lifecycle.dispose());
  return fake.harness;
}
const target = { hostId: "h1", selector: entry.selector, path: entry.path };
describe("BB integration", () => {
  it("reuses a project only for an exact machine and checkout path", async () => {
    const h = await setup();
    expect(
      await h.behavior.callRpc("project", {
        hostId: "h1",
        selector: entry.selector,
      }),
    ).toEqual({ projectId: "p1", path: entry.path });
    expect(h.inspection.sdk.callsTo("projects.create")).toHaveLength(0);
    expect(h.experimental_hostRpcCalls[0]?.method).toBe("detail");
  });
  it("registers the machine's fresh checkout path and coalesces concurrent requests", async () => {
    const h = await setup();
    h.sdk.stub("projects.list", async () => []);
    const input = { hostId: "h2", selector: entry.selector };
    const results = await Promise.all([
      h.behavior.callRpc("project", input),
      h.behavior.callRpc("project", input),
    ]);
    expect(results).toEqual([
      { projectId: "p2", path: entry.path },
      { projectId: "p2", path: entry.path },
    ]);
    expect(h.inspection.sdk.callsTo("projects.create")).toHaveLength(1);
    expect(h.inspection.sdk.callsTo("projects.create")[0]).toEqual([
      {
        name: "app / fix-auth",
        source: { type: "local_path", hostId: "h2", path: entry.path },
      },
    ]);
  });
  it("does not reuse another machine's project or a parent directory", async () => {
    const h = await setup();
    await h.behavior.callRpc("project", {
      hostId: "h2",
      selector: entry.selector,
    });
    expect(h.inspection.sdk.callsTo("projects.create")).toHaveLength(1);
    h.sdk.stub("projects.list", async () => [
      {
        ...bootstrap.projects[0],
        sources: [{ hostId: "h1", path: "/work/app" }],
      },
    ]);
    await h.behavior.callRpc("project", {
      hostId: "h1",
      selector: entry.selector,
    });
    expect(h.inspection.sdk.callsTo("projects.create")).toHaveLength(2);
  });
  it("clears failed registration attempts so a retry can succeed", async () => {
    const h = await setup();
    h.sdk.stub("projects.list", async () => []);
    h.sdk.stub("projects.create", async () => {
      throw new Error("Machine offline");
    });
    const input = { hostId: "h1", selector: entry.selector };
    await expect(h.behavior.callRpc("project", input)).rejects.toThrow(
      "Machine offline",
    );
    h.sdk.stub("projects.create", async () => ({ id: "retry" }));
    expect(await h.behavior.callRpc("project", input)).toEqual({
      projectId: "retry",
      path: entry.path,
    });
  });
  it("uses host and path, not branch identity, for thread context", async () => {
    const h = await setup();
    expect(await h.behavior.callRpc("context", { threadId: "t1" })).toEqual({
      hostId: "h1",
      entry,
      path: entry.path,
    });
  });
  it("finds single-repo task lanes outside the parent checkout", async () => {
    const h = await setup(detail.tasks[0]!.path);
    expect(await h.behavior.callRpc("context", { threadId: "t1" })).toEqual({
      hostId: "h1",
      entry,
      path: detail.tasks[0]!.path,
    });
  });
  it("does not trust a path-shaped task candidate without matching metadata", async () => {
    const path = "/work/app/_tasks/fix-auth/other";
    const h = await setup(path);
    expect(await h.behavior.callRpc("context", { threadId: "t1" })).toEqual({
      hostId: "h1",
      entry: null,
      path,
    });
  });
  it("rejects malformed RPC mutation input", async () => {
    const h = await setup();
    await expect(
      h.behavior.callRpc("start", {
        hostId: "h1",
        operation: { kind: "create", name: "--force", sources: ["o/r"] },
      }),
    ).rejects.toThrow();
    expect(h.experimental_hostRpcCalls).toHaveLength(0);
  });
  it("uses only public SDK surfaces", async () => {
    const result = await experimental_scanPublicSdkOnly(
      fileURLToPath(new URL("..", import.meta.url)),
      {
        allow: [
          /^vitest(?:\/config)?$/,
          /^@testing-library\//,
          /^@hugeicons\//,
          /^@radix-ui\//,
          /^react(?:-dom)?$/,
          /^(?:class-variance-authority|clsx|tailwind-merge|vaul)$/,
          /^@\//,
        ],
      },
    );
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
