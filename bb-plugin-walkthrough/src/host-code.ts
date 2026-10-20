import { execFile } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { CodeSnapshot } from "./code-contract.ts";

const MAX_BYTES = 1_000_000;

/** Read the repository named by an absolute excerpt, not the conversation's cwd. */
export async function readCode(
  input: { path: string; baseRef: string; headRef?: string | undefined; includeUncommitted: boolean; withFullFile: boolean },
  signal: AbortSignal,
): Promise<CodeSnapshot> {
  if (!isAbsolute(input.path)) throw new Error("Code paths on the host must be absolute.");
  const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => {
    execFile("git", ["--literal-pathspecs", "-C", cwd, ...args], { signal, timeout: 15_000, maxBuffer: MAX_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
  const root = (await git(dirname(input.path), ["rev-parse", "--show-toplevel"])).trim();
  const absolute = join(await realpath(dirname(input.path)), basename(input.path));
  const path = relative(root, absolute).split("\\").join("/");
  if (!path || path.startsWith("../") || isAbsolute(path)) throw new Error("The code path must be inside its repository.");
  const baseCommit = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`])).trim();
  // A pinned head (a PR's) replaces both HEAD and the working tree.
  const head = input.headRef ? (await git(root, ["rev-parse", "--verify", "--end-of-options", `${input.headRef}^{commit}`])).trim() : "HEAD";
  const base = (await git(root, ["merge-base", baseCommit, head])).trim();
  const includeUncommitted = input.includeUncommitted && !input.headRef;
  const patch = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", base, ...(includeUncommitted ? [] : [head]), "--", path]);
  const show = async (ref: string): Promise<string | null> => {
    // Missing sides are expected for added and deleted files; other failures must surface.
    const exists = await git(root, ["ls-tree", "--name-only", ref, "--", path]);
    return exists.trim() === "" ? null : git(root, ["show", `${ref}:${path}`]);
  };
  const old = await show(base);
  let current: string | null;
  if (includeUncommitted) {
    try {
      signal.throwIfAborted();
      const file = await open(input.path, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("Code excerpts require a regular file.");
        if (stat.size > MAX_BYTES) throw new Error("The code file exceeds the 1 MB display limit.");
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(bytes, size, bytes.length - size);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size > MAX_BYTES) throw new Error("The code file exceeds the 1 MB display limit.");
        current = bytes.subarray(0, size).toString("utf8");
      } finally {
        await file.close();
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      current = null;
    }
  } else {
    current = await show(head);
  }
  if (old?.includes("\0") || current?.includes("\0")) throw new Error("Binary files cannot be shown as code excerpts.");
  if (old === null && current === null) throw new Error(`No file at ${input.path} in the selected revisions.`);
  // Git diff omits untracked files, but an excerpt can explicitly name one.
  const untracked = !patch && old === null && current !== null && current !== "";
  const lines = untracked && current !== null ? current.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const addition = untracked ? `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n` : "";
  return {
    path,
    patch: patch || addition,
    truncated: false,
    sides: input.withFullFile ? { old: { path, content: old ?? "" }, new: { path, content: current ?? "" } } : null,
  };
}
