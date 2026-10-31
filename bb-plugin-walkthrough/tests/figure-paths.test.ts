// A figure names its file inside its repository, never a machine path, even when the worker wrote an absolute one and the code lives outside the thread's workspace.
import { describe, expect, it } from "vitest";
import { filesRead } from "../src/coverage.ts";
import { deliverView } from "../src/deliver.ts";
import { blockDisplayPath } from "../src/figure-paths.ts";
import { displayPath, repoPathFromPatch, repoRootOf } from "../src/files.ts";
import { walkthrough } from "./helpers.tsx";

const OTHER_REPO = "/Users/tomdale/Code/Repos/bb-plugin-workstreams/main";
const patch = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n  line\n`;
const block = (path: string, extra: Record<string, unknown> = {}) => ({
  kind: "code" as const, caption: "c", path, startLine: 107, endLine: 127, notes: [], view: "code" as const,
  snapshot: { change: null, after: patch("src/server/quick.ts"), before: null, baseSha: null, headSha: null, capturedAt: 1 }, snapshotError: null, ...extra,
});

describe("repository-relative figure paths", () => {
  it("reads the repository path from a patch header", () => {
    expect(repoPathFromPatch(patch("src/server/quick.ts"))).toBe("src/server/quick.ts");
    expect(repoPathFromPatch("--- a/old.ts\n+++ /dev/null\n")).toBe("old.ts");
    expect(repoPathFromPatch(null)).toBeNull();
    expect(repoPathFromPatch("no header")).toBeNull();
  });

  it("finds the repository root a machine path was cut from", () => {
    expect(repoRootOf(`${OTHER_REPO}/src/server/quick.ts`, "src/server/quick.ts")).toBe(OTHER_REPO);
    expect(repoRootOf("/a/b.ts", "x/b.ts")).toBeNull();
    expect(repoRootOf("src/a.ts", "src/a.ts")).toBeNull();
  });

  it("strips the workspace, then any known repository root, and keeps relative paths", () => {
    const context = { workspacePath: "/Users/tomdale/Code/tomdaleOS", repoRoots: [OTHER_REPO] };
    expect(displayPath("/Users/tomdale/Code/tomdaleOS/apps/web/a.ts", context)).toBe("apps/web/a.ts");
    expect(displayPath(`${OTHER_REPO}/src/server/quick.ts`, context)).toBe("src/server/quick.ts");
    expect(displayPath("./src/a.ts", context)).toBe("src/a.ts");
    expect(displayPath("src/a.ts", context)).toBe("src/a.ts");
  });

  it("never shows a whole machine path when no root is known", () => {
    expect(displayPath("/Users/tomdale/Code/Repos/other/main/src/server/quick.ts", { workspacePath: null })).toBe("…/src/server/quick.ts");
    expect(displayPath("/tmp/a.ts", { workspacePath: null })).toBe("tmp/a.ts");
  });

  it("prefers the saved name, then the patch header, then the workspace-relative path", () => {
    expect(blockDisplayPath(block(`${OTHER_REPO}/src/server/quick.ts`, { displayPath: "saved.ts" }), null)).toBe("saved.ts");
    expect(blockDisplayPath(block(`${OTHER_REPO}/src/server/quick.ts`), "/Users/tomdale/Code/tomdaleOS")).toBe("src/server/quick.ts");
    expect(blockDisplayPath(block("/ws/src/a.ts", { snapshot: null }), "/ws")).toBe("src/a.ts");
  });

  it("delivers every code block with a repository-relative name, old records included", () => {
    const stored = walkthrough({ workspacePath: "/Users/tomdale/Code/tomdaleOS", parts: [{ ...walkthrough().parts[0]!, blocks: [block(`${OTHER_REPO}/src/server/quick.ts`)] }] });
    const view = deliverView({ walkthrough: stored, notes: [], reviewDraft: null });
    const delivered = view.walkthrough.parts[0]!.blocks[0]!;
    expect(delivered).toMatchObject({ kind: "code", displayPath: "src/server/quick.ts", path: `${OTHER_REPO}/src/server/quick.ts` });
    expect(view.walkthrough.repoRoots).toEqual([OTHER_REPO]);
  });

  it("lists the files read by their repository paths, not machine paths", () => {
    const stored = walkthrough({
      workspacePath: "/Users/tomdale/Code/tomdaleOS",
      parts: [{ ...walkthrough().parts[0]!, blocks: [block(`${OTHER_REPO}/src/server/quick.ts`), block("/Users/tomdale/Code/tomdaleOS/apps/a.ts", { snapshot: null })] }],
    });
    expect(filesRead(stored)).toEqual(["apps/a.ts", "src/server/quick.ts"]);
  });
});
