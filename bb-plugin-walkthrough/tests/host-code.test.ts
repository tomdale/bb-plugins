import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "walkthrough-code-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  await mkdir(join(root, "src"));
  const path = join(root, "src", "file.ts");
  await writeFile(path, "export const value = 1;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const baseRef = git("rev-parse", "HEAD");
  await writeFile(path, "export const value = 2;\n");
  git("commit", "--quiet", "-am", "change");
  const harness = experimental_createHostEntryHarness(hostEntry);
  const read = (overrides: { path?: string; baseRef?: string; headRef?: string; includeUncommitted?: boolean; withFullFile?: boolean } = {}) => harness.experimental_call("readCode", {
    path, baseRef, includeUncommitted: true, withFullFile: true, ...overrides,
  });
  return { root, path, git, read, harness };
}

describe("host code loading", () => {
  it("reads a pinned head commit instead of the checkout, whatever HEAD and the working tree hold", async () => {
    const { read, path, git, harness } = await repository();
    try {
      const head = git("rev-parse", "HEAD");
      await writeFile(path, "export const value = 3;\n");
      git("commit", "--quiet", "-am", "later");
      await writeFile(path, "export const value = 4;\n");
      const result = await read({ headRef: head });
      expect(result.patch).toContain("+export const value = 2;");
      expect(result.patch).not.toContain("value = 3");
      expect(result.sides?.new.content).toBe("export const value = 2;\n");
      await expect(read({ headRef: "0".repeat(40) })).rejects.toThrow();
    } finally { await harness.experimental_dispose(); }
  });

  it("resolves the excerpt's repository and returns a real patch and both revisions", async () => {
    const { read, harness } = await repository();
    try {
      const result = await read();
      expect(result.path).toBe("src/file.ts");
      expect(result.patch).toContain("-export const value = 1;");
      expect(result.patch).toContain("+export const value = 2;");
      expect(result.sides?.old.content).toBe("export const value = 1;\n");
      expect(result.sides?.new.content).toBe("export const value = 2;\n");
    } finally { await harness.experimental_dispose(); }
  });

  it("includes dirty edits only in local mode", async () => {
    const { read, path, harness } = await repository();
    try {
      await writeFile(path, "export const value = 3;\n");
      expect((await read()).patch).toContain("+export const value = 3;");
      const committed = await read({ includeUncommitted: false });
      expect(committed.patch).toContain("+export const value = 2;");
      expect(committed.sides?.new.content).toBe("export const value = 2;\n");
    } finally { await harness.experimental_dispose(); }
  });

  it("shows explicitly referenced untracked and deleted files", async () => {
    const { read, path, root, harness } = await repository();
    try {
      const added = join(root, "src", "new.ts");
      await writeFile(added, "new code\n");
      expect(await read({ path: added })).toMatchObject({ patch: expect.stringContaining("+new code"), sides: { old: { content: "" }, new: { content: "new code\n" } } });
      await rm(path);
      expect(await read()).toMatchObject({ patch: expect.stringContaining("+++ /dev/null"), sides: { new: { content: "" } } });
    } finally { await harness.experimental_dispose(); }
  });

  it("rejects relative host paths and oversized content", async () => {
    const { read, root, harness } = await repository();
    try {
      await expect(read({ path: "src/file.ts" })).rejects.toThrow("must be absolute");
      const large = join(root, "src", "large.ts");
      await writeFile(large, "x".repeat(1_000_001));
      await expect(read({ path: large })).rejects.toThrow("1 MB display limit");
    } finally { await harness.experimental_dispose(); }
  });

  it("keeps unchanged source available and surfaces invalid bases and binary files", async () => {
    const { read, path, git, harness } = await repository();
    try {
      expect(await read({ baseRef: git("rev-parse", "HEAD") })).toMatchObject({ patch: "", sides: { new: { content: "export const value = 2;\n" } } });
      await expect(read({ baseRef: "does-not-exist" })).rejects.toThrow();
      await writeFile(path, Buffer.from([0, 1, 2]));
      await expect(read()).rejects.toThrow("Binary files");
    } finally { await harness.experimental_dispose(); }
  });
});
