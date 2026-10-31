import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A repository whose only pending work is staged, with every kind of change. */
async function stagedRepository() {
  const root = await mkdtemp(join(tmpdir(), "walkthrough-changes-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  await mkdir(join(root, "src"));
  const body = Array.from({ length: 30 }, (_, index) => `export const value${index} = ${index};`).join("\n");
  await writeFile(join(root, "src", "old-name.ts"), `${body}\n`);
  await writeFile(join(root, "src", "doomed.ts"), "export const doomed = true;\n");
  await writeFile(join(root, "src", "kept.ts"), "export const kept = 1;\n");
  await writeFile(join(root, "logo.bin"), Buffer.from([0, 1, 2, 3]));
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const baseRef = git("rev-parse", "HEAD");
  git("mv", "src/old-name.ts", "src/new-name.ts");
  git("rm", "--quiet", "src/doomed.ts");
  await writeFile(join(root, "src", "added.ts"), `export const long = "${"x".repeat(8000)}";\nexport const two = 2;\n`);
  await writeFile(join(root, "logo.bin"), Buffer.from([0, 9, 9, 9, 9]));
  await writeFile(join(root, "src", "kept.ts"), "export const kept = 2;\n");
  git("add", ".");
  await writeFile(join(root, "src", "scratch.ts"), "one\ntwo\nthree");
  const harness = experimental_createHostEntryHarness(hostEntry);
  return { root, git, baseRef, harness };
}

describe("host changedFiles", () => {
  it("lists staged-only work: additions, a rename, a deletion, a binary file and a very long line", async () => {
    const { root, baseRef, harness } = await stagedRepository();
    try {
      const result = await harness.experimental_call("changedFiles", { path: root, baseRef, includeUncommitted: true });
      const byPath = new Map(result.files.map((file) => [file.path, file]));
      expect(byPath.get("src/new-name.ts")).toMatchObject({ status: "renamed", oldPath: "src/old-name.ts", origins: ["staged"], additions: 0, deletions: 0 });
      expect(byPath.get("src/doomed.ts")).toMatchObject({ status: "deleted", additions: 0, deletions: 1, origins: ["staged"] });
      expect(byPath.get("src/added.ts")).toMatchObject({ status: "added", additions: 2, deletions: 0, binary: false });
      expect(byPath.get("src/kept.ts")).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
      expect(byPath.get("logo.bin")).toMatchObject({ binary: true, additions: null, deletions: null });
      expect(byPath.get("src/scratch.ts")).toMatchObject({ status: "added", additions: 3, origins: ["untracked"] });
      expect(result).toMatchObject({ staged: 5, unstaged: 0, untracked: 1, truncated: false });
    } finally { await harness.experimental_dispose(); }
  });

  it("separates staged from unstaged edits and counts untracked binaries without lines", async () => {
    const { root, baseRef, harness } = await stagedRepository();
    try {
      await writeFile(join(root, "src", "kept.ts"), "export const kept = 3;\n");
      await writeFile(join(root, "blob.dat"), Buffer.from([0, 0, 1]));
      const result = await harness.experimental_call("changedFiles", { path: root, baseRef, includeUncommitted: true });
      const byPath = new Map(result.files.map((file) => [file.path, file]));
      expect(byPath.get("src/kept.ts")?.origins).toEqual(["staged", "unstaged"]);
      expect(byPath.get("blob.dat")).toMatchObject({ binary: true, additions: null, origins: ["untracked"] });
      expect(result.unstaged).toBe(1);
    } finally { await harness.experimental_dispose(); }
  });

  it("leaves pending work out when it is not part of the comparison", async () => {
    const { root, baseRef, harness } = await stagedRepository();
    try {
      const result = await harness.experimental_call("changedFiles", { path: root, baseRef, includeUncommitted: false });
      expect(result.files).toEqual([]);
      expect(result.staged).toBe(5);
    } finally { await harness.experimental_dispose(); }
  });

  it("reads a pinned head's committed change, not the checkout", async () => {
    const { root, git, baseRef, harness } = await stagedRepository();
    try {
      git("commit", "--quiet", "-m", "stage");
      const head = git("rev-parse", "HEAD");
      await writeFile(join(root, "src", "later.ts"), "later\n");
      const result = await harness.experimental_call("changedFiles", { path: root, baseRef, headRef: head, includeUncommitted: false });
      expect(result.files.map((file) => file.path)).not.toContain("src/later.ts");
      expect(result.files.find((file) => file.path === "src/new-name.ts")).toMatchObject({ status: "renamed", origins: ["committed"] });
    } finally { await harness.experimental_dispose(); }
  });
});

describe("host readCode with staged work", () => {
  it("reads a staged-only new file, rename and deletion against the base, and caps nothing in the host", async () => {
    const { root, baseRef, harness } = await stagedRepository();
    try {
      const read = (name: string) => harness.experimental_call("readCode", { path: join(root, name), baseRef, includeUncommitted: true, withFullFile: true });
      const added = await read("src/added.ts");
      expect(added.patch).toContain("+export const two = 2;");
      expect(added.sides?.new.content).toContain("x".repeat(8000));
      expect(added.sides?.old.content).toBe("");
      expect(await read("src/new-name.ts")).toMatchObject({ patch: expect.stringContaining("+export const value0 = 0;"), sides: { old: { content: "" } } });
      expect(await read("src/doomed.ts")).toMatchObject({ patch: expect.stringContaining("-export const doomed = true;"), sides: { new: { content: "" } } });
      await expect(read("logo.bin")).rejects.toThrow("Binary files");
    } finally { await harness.experimental_dispose(); }
  });
});
