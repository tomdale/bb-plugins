import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ChangedFile, ChangedFiles, ChangedFilesInput, ChangeOrigin, CodeSnapshot } from "./code-contract.ts";
import { EMPTY_TREE_SHA } from "./empty-tree.ts";

const MAX_BYTES = 1_000_000;
/** Untracked files larger than this are listed without a line count. */
const MAX_COUNTED_BYTES = 1_000_000;
const MAX_LISTED_FILES = 2000;

type Git = (cwd: string, args: string[]) => Promise<string>;

function gitRunner(signal: AbortSignal): Git {
  return (cwd, args) => new Promise<string>((resolve, reject) => {
    execFile("git", ["--literal-pathspecs", "-C", cwd, ...args], { signal, timeout: 15_000, maxBuffer: 16 * MAX_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

/** Read the repository named by an absolute excerpt, not the conversation's cwd. */
export async function readCode(
  input: { path: string; baseRef: string; headRef?: string | undefined; includeUncommitted: boolean; withFullFile: boolean },
  signal: AbortSignal,
): Promise<CodeSnapshot> {
  if (!isAbsolute(input.path)) throw new Error("Code paths on the host must be absolute.");
  const git = gitRunner(signal);
  const root = (await git(dirname(input.path), ["rev-parse", "--show-toplevel"])).trim();
  const absolute = join(await realpath(dirname(input.path)), basename(input.path));
  const path = relative(root, absolute).split("\\").join("/");
  if (!path || path.startsWith("../") || isAbsolute(path)) throw new Error("The code path must be inside its repository.");
  const emptyBase = input.baseRef.trim().toLowerCase() === EMPTY_TREE_SHA;
  const baseCommit = emptyBase ? EMPTY_TREE_SHA : (await git(root, ["rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`])).trim();
  // A pinned head (a PR's) replaces both HEAD and the working tree.
  const head = input.headRef ? (await git(root, ["rev-parse", "--verify", "--end-of-options", `${input.headRef}^{commit}`])).trim() : "HEAD";
  // The empty tree is not a commit, so there is nothing to merge-base against.
  const base = emptyBase ? EMPTY_TREE_SHA : (await git(root, ["merge-base", baseCommit, head])).trim();
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

/** Splits a NUL-terminated git listing, dropping the empty tail. */
function fields(output: string): string[] {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** `git status --porcelain=v1 -z`: which paths are staged, unstaged, or untracked. */
function parseStatus(output: string) {
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();
  const entries = fields(output);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const path = entry.slice(3);
    // A rename or copy is followed by its source path.
    if (x === "R" || x === "C" || y === "R" || y === "C") index += 1;
    if (x === "?" && y === "?") untracked.add(path);
    else if (x === "!" ) continue;
    else {
      if (x !== " ") staged.add(path);
      if (y !== " ") unstaged.add(path);
    }
  }
  return { staged, unstaged, untracked };
}

/** `git diff --numstat -z -M`: "adds\tdels\tpath\0" or "adds\tdels\t\0old\0new\0" for a rename. */
function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null; oldPath: string | null }> {
  const result = new Map<string, { additions: number | null; deletions: number | null; oldPath: string | null }>();
  const entries = fields(output);
  for (let index = 0; index < entries.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(entries[index]!);
    if (!match) continue;
    let path = match[3]!;
    let oldPath: string | null = null;
    if (path === "") {
      oldPath = entries[index + 1] ?? null;
      path = entries[index + 2] ?? "";
      index += 2;
    }
    result.set(path, { additions: match[1] === "-" ? null : Number(match[1]), deletions: match[2] === "-" ? null : Number(match[2]), oldPath });
  }
  return result;
}

/** `git diff --name-status -z -M`: "M\0path\0", "R100\0old\0new\0". */
function parseNameStatus(output: string): Map<string, { status: ChangedFile["status"]; oldPath: string | null }> {
  const result = new Map<string, { status: ChangedFile["status"]; oldPath: string | null }>();
  const entries = fields(output);
  for (let index = 0; index < entries.length; index += 1) {
    const code = entries[index]![0];
    if (code === "R" || code === "C") {
      const oldPath = entries[index + 1] ?? null;
      const path = entries[index + 2] ?? "";
      index += 2;
      result.set(path, { status: code === "R" ? "renamed" : "added", oldPath: code === "R" ? oldPath : null });
    } else {
      const path = entries[index + 1] ?? "";
      index += 1;
      result.set(path, { status: code === "A" ? "added" : code === "D" ? "deleted" : "modified", oldPath: null });
    }
  }
  return result;
}

async function countUntracked(root: string, path: string): Promise<{ additions: number | null; binary: boolean }> {
  try {
    const file = await open(join(root, path), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return { additions: 0, binary: false };
      const bytes = Buffer.alloc(Math.min(stat.size, MAX_COUNTED_BYTES));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const slice = bytes.subarray(0, bytesRead);
      if (slice.includes(0)) return { additions: null, binary: true };
      if (stat.size > MAX_COUNTED_BYTES) return { additions: null, binary: false };
      let lines = 0;
      for (const byte of slice) if (byte === 10) lines += 1;
      if (slice.length > 0 && slice.at(-1) !== 10) lines += 1;
      return { additions: lines, binary: false };
    } finally {
      await file.close();
    }
  } catch {
    return { additions: null, binary: false };
  }
}

/**
 * Every file that differs from the base, wherever its change lives: commits,
 * the index, the working tree, or not yet tracked. The comparison is the one
 * a reader's excerpts use (base against the pinned head, or against the
 * working tree), so a staged-only change is as visible as a committed one.
 */
export async function changedFiles(input: ChangedFilesInput, signal: AbortSignal): Promise<ChangedFiles> {
  if (!isAbsolute(input.path)) throw new Error("Code paths on the host must be absolute.");
  const git = gitRunner(signal);
  const root = (await git(input.path, ["rev-parse", "--show-toplevel"])).trim();
  const emptyBase = input.baseRef.trim().toLowerCase() === EMPTY_TREE_SHA;
  const baseCommit = emptyBase ? EMPTY_TREE_SHA : (await git(root, ["rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`])).trim();
  const head = input.headRef ? (await git(root, ["rev-parse", "--verify", "--end-of-options", `${input.headRef}^{commit}`])).trim() : "HEAD";
  const base = emptyBase ? EMPTY_TREE_SHA : (await git(root, ["merge-base", baseCommit, head])).trim();
  const worktree = input.includeUncommitted && !input.headRef;
  const range = [base, ...(worktree ? [] : [head])];
  const diff = (flag: string) => git(root, ["diff", "--no-ext-diff", "--no-textconv", "-M", flag, "-z", ...range, "--"]);
  const [numstat, nameStatus, status, branch, committedNames] = await Promise.all([
    diff("--numstat"),
    diff("--name-status"),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).then((text) => text.trim() || null, () => null),
    // Paths changed by commits alone, to say which changes are already committed.
    emptyBase ? Promise.resolve("") : git(root, ["diff", "--name-only", "-z", "--no-renames", base, head, "--"]),
  ]);
  const counts = parseNumstat(numstat);
  const statuses = parseNameStatus(nameStatus);
  const state = parseStatus(status);
  const committed = new Set(fields(committedNames));
  const files: ChangedFile[] = [];
  for (const [path, change] of statuses) {
    const count = counts.get(path);
    const origins: ChangeOrigin[] = [];
    if (committed.has(path) || input.headRef || emptyBase) origins.push("committed");
    if (worktree && state.staged.has(path)) origins.push("staged");
    if (worktree && state.unstaged.has(path)) origins.push("unstaged");
    files.push({
      path,
      oldPath: change.oldPath,
      status: change.status,
      additions: count?.additions ?? null,
      deletions: count?.deletions ?? null,
      binary: count !== undefined && count.additions === null && count.deletions === null,
      origins: origins.length === 0 ? ["committed"] : origins,
    });
  }
  if (worktree) {
    for (const path of [...state.untracked].sort()) {
      if (statuses.has(path)) continue;
      const counted = await countUntracked(root, path);
      files.push({ path, oldPath: null, status: "added", additions: counted.additions, deletions: counted.additions === null ? null : 0, binary: counted.binary, origins: ["untracked"] });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: files.slice(0, MAX_LISTED_FILES),
    staged: state.staged.size,
    unstaged: state.unstaged.size,
    untracked: state.untracked.size,
    truncated: files.length > MAX_LISTED_FILES,
    branch,
  };
}

const MAX_HASHED_BYTES = 20_000_000;

/** Hashes of the named files' working-tree contents; a missing or unreadable file hashes to null. */
export async function fileHashes(input: { path: string; paths: string[] }, signal: AbortSignal): Promise<Record<string, string | null>> {
  if (!isAbsolute(input.path)) throw new Error("Code paths on the host must be absolute.");
  const root = (await gitRunner(signal)(input.path, ["rev-parse", "--show-toplevel"])).trim();
  const hashes: Record<string, string | null> = {};
  for (const path of input.paths) {
    signal.throwIfAborted();
    const absolute = join(root, path);
    if (isAbsolute(path) || relative(root, absolute).startsWith("..")) {
      hashes[path] = null;
      continue;
    }
    try {
      const bytes = await readFile(absolute);
      hashes[path] = bytes.length > MAX_HASHED_BYTES ? `size:${bytes.length}` : createHash("sha1").update(bytes).digest("hex");
    } catch {
      hashes[path] = null;
    }
  }
  return hashes;
}
