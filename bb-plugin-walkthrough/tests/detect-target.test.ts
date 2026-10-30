import { describe, expect, it } from "vitest";
import { detectTarget } from "../src/detect-target.ts";
import { setup, THREAD } from "./helpers.ts";

const file = (path: string) => ({ path, insertions: 1, deletions: 1 });
function status(overrides: { working?: object; merge?: object | null } = {}) {
  return {
    outcome: "available",
    workspace: {
      branch: { currentBranch: "tomdale/x", defaultBranch: "main" },
      workingTree: { files: [], insertions: 0, deletions: 0, hasUncommittedChanges: false, lineStatsComplete: true, ...overrides.working },
      mergeBase: overrides.merge === null ? null : { files: [], insertions: 0, deletions: 0, hasCommittedUnmergedChanges: false, baseRef: "origin/main", mergeBaseBranch: "main", ...overrides.merge },
    },
  };
}
const pr = (state: string) => ({ outcome: "available", pullRequest: { number: 7, title: "Fix the thing", url: "https://github.com/o/r/pull/7", state } });

function sdk(parts: { pullRequest?: unknown; status?: unknown; environmentId?: string | null }) {
  return {
    threads: { get: async () => ({ environmentId: parts.environmentId === undefined ? "env_1" : parts.environmentId }) },
    environments: {
      pullRequest: async () => parts.pullRequest ?? { outcome: "absent", message: "none" },
      status: async () => parts.status ?? status(),
    },
  } as never;
}

describe("detectTarget", () => {
  it("prefers an open pull request", async () => {
    const target = await detectTarget(sdk({ pullRequest: pr("open"), status: status({ working: { hasUncommittedChanges: true, files: [file("a")] } }) }), "t");
    expect(target).toEqual({ kind: "pr", number: 7, title: "Fix the thing", url: "https://github.com/o/r/pull/7", draft: false });
  });

  it("marks a draft pull request and ignores a merged one", async () => {
    expect(await detectTarget(sdk({ pullRequest: pr("draft") }), "t")).toMatchObject({ kind: "pr", draft: true });
    expect(await detectTarget(sdk({ pullRequest: pr("merged") }), "t")).toBeNull();
  });

  it("counts uncommitted changes, then committed branch changes", async () => {
    const working = { hasUncommittedChanges: true, files: [file("a"), file("b")], insertions: 120, deletions: 30 };
    expect(await detectTarget(sdk({ status: status({ working }) }), "t")).toEqual({ kind: "uncommitted", files: 2, additions: 120, deletions: 30 });
    const merge = { hasCommittedUnmergedChanges: true, files: [file("a")], insertions: 5, deletions: 2 };
    expect(await detectTarget(sdk({ status: status({ merge }) }), "t")).toEqual({ kind: "branch", branch: "tomdale/x", base: "origin/main", files: 1, additions: 5, deletions: 2 });
  });

  it("is null without a workspace, without changes, or when the host cannot say", async () => {
    expect(await detectTarget(sdk({ environmentId: null }), "t")).toBeNull();
    expect(await detectTarget(sdk({}), "t")).toBeNull();
    expect(await detectTarget(sdk({ status: { outcome: "unavailable" } }), "t")).toBeNull();
  });
});

describe("detectTarget RPC", () => {
  it("answers null instead of failing when the lookups throw", async () => {
    const { rpc, harness } = await setup();
    harness.inspection.sdk.stub("environments.pullRequest", async () => {
      throw new Error("boom");
    });
    harness.inspection.sdk.stub("environments.status", async () => {
      throw new Error("boom");
    });
    expect(await rpc("detectTarget", { threadId: THREAD })).toEqual({ target: null });
  });
});
