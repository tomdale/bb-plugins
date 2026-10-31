import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedFiles, fileHashes, readCode } from "../src/host-code.ts";
import { MAX_EXCERPT_LINE } from "../src/service.ts";
import { PLAN, setup, settle, THREAD } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A real repository standing in for the thread's workspace; the host calls run the real git code against it. */
async function workspace(prepare: (root: string, git: (...args: string[]) => string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "walkthrough-polish-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  await mkdir(join(root, "src"));
  await prepare(root, git);
  const signal = new AbortController().signal;
  const hostRpc = ({ method, input }: { method: string; input: any }) => {
    if (method === "readCode") return readCode(input, signal);
    if (method === "changedFiles") return changedFiles(input, signal);
    if (method === "fileHashes") return fileHashes(input, signal).then((hashes) => ({ hashes }));
    throw new Error(`unexpected host call ${method}`);
  };
  return { root, git, hostRpc };
}

/** Points the fake environment at the real repository. */
async function boot(root: string, hostRpc: (call: { method: string; input: any }) => unknown) {
  const env = await setup({ hostRpc });
  env.harness.inspection.sdk.stub("environments.get", async () => ({ id: "env_1", hostId: "host_1", path: root }));
  // BB's own diff APIs know nothing of staged-only or unchanged files here: the host must answer.
  env.harness.inspection.sdk.stub("environments.diffPatch", async () => ({ outcome: "available", patches: [] }));
  env.harness.inspection.sdk.stub("environments.status", async () => ({ outcome: "unavailable" }));
  env.harness.inspection.sdk.stub("environments.pullRequest", async () => ({ outcome: "absent", message: "none" }));
  return env;
}

/** Real git is slower than the fake host's fixed settle, so wait for the condition itself. */
async function until(condition: () => boolean | Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const understandPlan = { ...PLAN, intent: "understand", baseRef: "HEAD", includeUncommitted: false, parts: [{ title: "The queue", summary: "How jobs wait", locations: [{ path: "src/queue.ts" }] }, { title: "Limits", summary: "Caps" }] };

describe("figures always show code", () => {
  it("captures the current source for an understand walkthrough with no diff", async () => {
    const { root, hostRpc } = await workspace(async (dir, git) => {
      await writeFile(join(dir, "src", "queue.ts"), "export function enqueue() {\n  return 1;\n}\nexport const size = 3;\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
    });
    const { rpc, tool, view, sent } = await boot(root, hostRpc);
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Walk me through how the queue works" });
    await until(() => sent.length > 0, "the plan request");
    expect(await tool("walkthrough_plan", understandPlan)).toContain("Planned 2 parts");
    const result = await tool("walkthrough_write_part", {
      part: 1,
      blocks: [{ kind: "prose", text: "Jobs wait here." }, { kind: "code", caption: "enqueue", path: "src/queue.ts", startLine: 1, endLine: 3, view: "code" }],
      suggestions: ["Who calls enqueue?"],
    });
    expect(result).toBe("Part 1 is on the page.");
    const figure = (await view(walkthroughId)).walkthrough.parts[0].blocks[1];
    expect(figure.snapshotError).toBeNull();
    expect(figure.snapshot.after).toContain(" export function enqueue() {");
    expect(figure.snapshot.after).toContain(" }");
    expect(JSON.stringify(figure.snapshot)).not.toMatch(/no changes against/u);
    expect(figure.snapshot.change).toBeNull();
  });

  it("reads staged-only additions, a rename, a deletion, a binary file and a very long line", async () => {
    const { root, hostRpc } = await workspace(async (dir, git) => {
      await writeFile(join(dir, "src", "old.ts"), Array.from({ length: 12 }, (_, index) => `export const a${index} = ${index};`).join("\n") + "\n");
      await writeFile(join(dir, "src", "doomed.ts"), "export const doomed = 1;\n");
      await writeFile(join(dir, "logo.bin"), Buffer.from([0, 1, 2]));
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      git("mv", "src/old.ts", "src/new.ts");
      git("rm", "--quiet", "src/doomed.ts");
      await writeFile(join(dir, "src", "added.ts"), `export const wide = "${"y".repeat(9000)}";\nexport const two = 2;\n`);
      await writeFile(join(dir, "logo.bin"), Buffer.from([0, 7, 7, 7]));
      git("add", ".");
    });
    const { rpc, tool, view, sent } = await boot(root, hostRpc);
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Walk me through my staged work" });
    await until(() => sent.length > 0, "the plan request");
    await tool("walkthrough_plan", { ...PLAN, baseRef: "HEAD", includeUncommitted: true });
    const code = (path: string, startLine = 1, endLine = 2) => ({ kind: "code", caption: path, path, startLine, endLine });
    const text = await tool("walkthrough_write_part", {
      part: 1,
      blocks: [{ kind: "prose", text: "Staged work." }, code("src/added.ts"), code("src/new.ts"), code("src/doomed.ts", 1, 1), code("logo.bin")],
      suggestions: [],
    });
    const blocks = (await view(walkthroughId)).walkthrough.parts[0].blocks;
    const [added, renamed, deleted, binary] = blocks.slice(1);
    expect(added.snapshot.change).toContain("+export const two = 2;");
    expect(added.snapshot.before).toBeNull();
    const longest = Math.max(...added.snapshot.after.split("\n").map((line: string) => line.length));
    expect(longest).toBeLessThan(MAX_EXCERPT_LINE + 80);
    expect(added.snapshot.after).toContain("line cut at");
    expect(renamed.snapshot.after).toContain("export const a0 = 0;");
    expect(deleted.snapshot.change).toContain("-export const doomed = 1;");
    expect(binary.snapshot).toBeNull();
    expect(binary.snapshotError).toBe("Binary files can't be shown as code.");
    expect(text).toContain("logo.bin");
  });
});

describe("target detection counts staged, unstaged and untracked work", () => {
  it("reports a staged-only change instead of 'no changes'", async () => {
    const { root, hostRpc } = await workspace(async (dir, git) => {
      await writeFile(join(dir, "a.ts"), "one\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      await writeFile(join(dir, "a.ts"), "two\n");
      await writeFile(join(dir, "b.ts"), "new\n");
      git("add", ".");
      await writeFile(join(dir, "c.ts"), "loose\n");
    });
    const { rpc } = await boot(root, hostRpc);
    expect(await rpc("detectTarget", { threadId: THREAD })).toEqual({
      target: { kind: "uncommitted", files: 3, additions: 3, deletions: 1, staged: 2, unstaged: 0, untracked: 1 },
    });
  });
});

describe("the plan request tells the helper what the working tree holds", () => {
  it("lists staged and untracked files and how to read them", async () => {
    const { root, hostRpc } = await workspace(async (dir, git) => {
      await writeFile(join(dir, "a.ts"), "one\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      await writeFile(join(dir, "staged.ts"), "new\n");
      git("add", ".");
    });
    const env = await boot(root, hostRpc);
    await env.rpc("start", { threadId: THREAD, request: "Walk me through this" });
    await until(() => env.sent.length > 0, "the plan request");
    expect(env.sent[0]!.text).toContain("1 staged, 0 unstaged, 0 untracked");
    expect(env.sent[0]!.text).toContain("added: staged.ts");
    expect(env.sent[0]!.text).toContain("git diff --cached");
  });
});

describe("coverage", () => {
  it("compares the changed files with the files figures and parts cite, listing lockfiles as not shown", async () => {
    const { root, hostRpc } = await workspace(async (dir, git) => {
      await writeFile(join(dir, "src", "a.ts"), "a\n");
      await writeFile(join(dir, "src", "b.ts"), "b\n");
      await writeFile(join(dir, "package-lock.json"), "{}\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      await writeFile(join(dir, "src", "a.ts"), "a2\n");
      await writeFile(join(dir, "src", "b.ts"), "b2\n");
      await writeFile(join(dir, "src", "c.ts"), "c\n");
      await writeFile(join(dir, "package-lock.json"), "{\"x\":1}\n");
      git("add", ".");
    });
    const { rpc, tool, view, sent } = await boot(root, hostRpc);
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Explain" });
    await until(() => sent.length > 0, "the plan request");
    await tool("walkthrough_plan", { ...PLAN, baseRef: "HEAD", includeUncommitted: true, parts: [{ title: "A", summary: "", locations: [{ path: "src/a.ts" }] }, { title: "B", summary: "", locations: [{ path: "src/b.ts" }] }] });
    await until(async () => (await view(walkthroughId)).coverage !== null, "the change set");
    let coverage = (await view(walkthroughId)).coverage;
    expect(coverage.changed).toBe(4);
    expect(coverage.covered).toEqual([]);
    expect(coverage.uncovered).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(coverage.notShown).toEqual(["package-lock.json"]);
    expect(coverage.files.find((file: any) => file.path === "src/b.ts")).toMatchObject({ covered: false, plannedIn: 1, additions: 1, deletions: 1, status: "modified" });
    await tool("walkthrough_write_part", { part: 1, blocks: [{ kind: "code", caption: "a", path: "src/a.ts", startLine: 1, endLine: 1 }], suggestions: [] });
    coverage = (await view(walkthroughId)).coverage;
    expect(coverage.covered).toEqual(["src/a.ts"]);
    expect(coverage.uncovered).toEqual(["src/b.ts", "src/c.ts"]);
    expect(coverage.files.find((file: any) => file.path === "src/a.ts")).toMatchObject({ covered: true, excluded: null, plannedIn: null });
    expect(coverage.files.find((file: any) => file.path === "package-lock.json")).toMatchObject({ covered: false, excluded: "lockfile" });
  });

  it("is null before the changed files are known", async () => {
    const { rpc, view } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Explain" });
    expect((await view(walkthroughId)).coverage).toBeNull();
  });
});

describe("per-part staleness", () => {
  it("marks a part stale only for the files it cites that changed after it was written", async () => {
    const { root, hostRpc } = await workspace(async (dir, git) => {
      await writeFile(join(dir, "src", "a.ts"), "a\n");
      await writeFile(join(dir, "src", "b.ts"), "b\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
    });
    const { rpc, tool, idle, view, sent } = await boot(root, hostRpc);
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Explain" });
    await until(() => sent.length > 0, "the plan request");
    await tool("walkthrough_plan", { ...PLAN, baseRef: "HEAD", parts: [{ title: "A", summary: "", locations: [] }, { title: "B", summary: "", locations: [] }] });
    const write = (part: number, path: string) => tool("walkthrough_write_part", { part, blocks: [{ kind: "code", caption: path, path, startLine: 1, endLine: 1 }], suggestions: [] });
    await write(1, "src/a.ts");
    await rpc("openPart", { walkthroughId, index: 1 });
    await write(2, "src/b.ts");
    await writeFile(join(root, "unrelated.ts"), "new work\n");
    await rpc("openPart", { walkthroughId, index: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    let parts = (await view(walkthroughId)).walkthrough.parts;
    expect(parts.map((part: any) => part.staleFiles)).toEqual([[], []]);
    await writeFile(join(root, "src", "a.ts"), "a changed\n");
    await rpc("openPart", { walkthroughId, index: 1 });
    await until(async () => (await view(walkthroughId)).walkthrough.parts[0].staleFiles.length > 0, "the stale mark");
    parts = (await view(walkthroughId)).walkthrough.parts;
    expect(parts.map((part: any) => part.staleFiles)).toEqual([["src/a.ts"], []]);
    // Writing the part again against the new code clears it.
    await write(1, "src/a.ts");
    parts = (await view(walkthroughId)).walkthrough.parts;
    expect(parts[0].staleFiles).toEqual([]);
    void idle;
  });

  it("delivers an empty list for walkthroughs that predate it", async () => {
    const { rpc, tool, view } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Explain" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    expect((await view(walkthroughId)).walkthrough.parts[0].staleFiles).toEqual([]);
  });
});

describe("figures that could not be read are repaired", () => {
  const code = (path: string) => ({ kind: "code", caption: path, path, startLine: 1, endLine: 1 });

  it("retries once, within the write, a read that failed for a passing reason", async () => {
    const { root, hostRpc } = await workspace(async (dir, git) => {
      await writeFile(join(dir, "src", "a.ts"), "a\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
    });
    let reads = 0;
    const flaky = (call: { method: string; input: any }) => {
      if (call.method === "readCode" && (reads += 1) === 1) throw new Error("spawn EAGAIN");
      return hostRpc(call);
    };
    const { rpc, tool, view, sent } = await boot(root, flaky);
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "x" });
    await until(() => sent.length > 0, "the plan request");
    await tool("walkthrough_plan", { ...PLAN, baseRef: "HEAD" });
    expect(await tool("walkthrough_write_part", { part: 1, blocks: [code("src/a.ts")], suggestions: [] })).toBe("Part 1 is on the page.");
    expect((await view(walkthroughId)).walkthrough.parts[0].blocks[0].snapshot.after).toContain("a");
    expect(reads).toBe(2);
  });

  it("gives a figure its code once the file exists, when the reader opens the part", async () => {
    const { root, hostRpc } = await workspace(async (dir, git) => {
      await writeFile(join(dir, "src", "a.ts"), "a\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
    });
    const { rpc, tool, view, sent } = await boot(root, hostRpc);
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "x" });
    await until(() => sent.length > 0, "the plan request");
    await tool("walkthrough_plan", { ...PLAN, baseRef: "HEAD" });
    const text = await tool("walkthrough_write_part", { part: 1, blocks: [{ kind: "prose", text: "Here." }, code("src/late.ts")], suggestions: [] });
    expect(JSON.stringify(text)).toContain("src/late.ts");
    let figure = (await view(walkthroughId)).walkthrough.parts[0].blocks[1];
    expect(figure).toMatchObject({ snapshot: null, snapshotError: expect.stringContaining("isn't in the reviewed revisions") });
    await writeFile(join(root, "src", "late.ts"), "late\n");
    await rpc("openPart", { walkthroughId, index: 0 });
    await until(async () => (await view(walkthroughId)).walkthrough.parts[0].blocks[1].snapshot !== null, "the repaired figure");
    figure = (await view(walkthroughId)).walkthrough.parts[0].blocks[1];
    expect(figure.snapshot.after).toContain("late");
    expect(figure.snapshotError).toBeNull();
  });
});
