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
  it("reuses a matching project without creating a clone or worktree", async () => {
    const h = await setup();
    expect(
      await h.behavior.callRpc("connect", { ...target, projectId: null }),
    ).toEqual({ projectId: "p1" });
    expect(h.inspection.sdk.callsTo("projects.create")).toHaveLength(0);
    expect(h.experimental_hostRpcCalls[0]?.hostId).toBe("h1");
  });
  it("launches an explicit unmanaged environment on the selected machine", async () => {
    const h = await setup();
    expect(
      await h.behavior.callRpc("launch", {
        ...target,
        projectId: "p1",
        prompt: "Fix auth",
      }),
    ).toEqual({ threadId: "t-new" });
    const calls = h.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).toContain('"type":"unmanaged"');
    expect(JSON.stringify(calls)).toContain('"hostId":"h1"');
    expect(JSON.stringify(calls)).toContain(entry.path);
    expect(JSON.stringify(calls)).not.toContain("managed-worktree");
  });
  it("rejects stale or arbitrary checkout paths before project or thread mutations", async () => {
    const h = await setup();
    await expect(
      h.behavior.callRpc("launch", {
        ...target,
        path: "/etc",
        projectId: "p1",
        prompt: "go",
      }),
    ).rejects.toThrow("no longer part");
    expect(h.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("does not silently attach a remote checkout to a project from another host", async () => {
    const h = await setup();
    await expect(
      h.behavior.callRpc("connect", {
        ...target,
        hostId: "remote",
        projectId: "p1",
      }),
    ).rejects.toThrow("no source");
    expect(h.inspection.sdk.callsTo("projects.create")).toHaveLength(0);
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
