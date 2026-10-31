import type { ExperimentalLiveFileTarget } from "@get-bb/plugin-sdk/app";
import type { Walkthrough } from "./schemas.ts";

export type FileContext = Pick<Walkthrough, "environmentId" | "hostId" | "workspacePath">;

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path);
}

/** Only paths inside this workspace may be sent to its diff and preview APIs. */
export function workspaceRelativePath(path: string, root: string | null): string | null {
  let relative = path;
  if (isAbsolutePath(path)) {
    if (root === null) return null;
    const prefix = `${root.replace(/\/+$/u, "")}/`;
    if (!path.startsWith(prefix)) return null;
    relative = path.slice(prefix.length);
  }
  relative = relative.replace(/^(?:\.\/)+/u, "");
  if (!relative || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return relative;
}

/** The file's path inside its repository, as a patch's `+++ b/…` or `--- a/…` header names it. */
export function repoPathFromPatch(patch: string | null | undefined): string | null {
  if (!patch) return null;
  const header = /^\+\+\+ b\/(.+)$/mu.exec(patch) ?? /^--- a\/(.+)$/mu.exec(patch);
  return header?.[1]?.trim() || null;
}

/** The directory a repository-relative path was cut from, or null when `path` does not end in it. */
export function repoRootOf(path: string, relative: string): string | null {
  const suffix = `/${relative}`;
  return relative !== "" && path.endsWith(suffix) && path.length > suffix.length ? path.slice(0, -suffix.length) : null;
}

/**
 * The name a reader sees for a code path: relative to the repository it lives
 * in, never a machine path. The workspace and every repository root a figure
 * was read from are stripped; a path under none of them (an old record whose
 * figure has no snapshot) keeps only its last three segments behind an ellipsis.
 */
export function displayPath(path: string, context: { workspacePath: string | null; repoRoots?: readonly string[] | undefined }): string {
  if (!isAbsolutePath(path)) return path.replace(/^(?:\.\/)+/u, "");
  for (const root of [context.workspacePath, ...(context.repoRoots ?? [])]) {
    if (!root) continue;
    const prefix = `${root.replace(/\/+$/u, "")}/`;
    if (path.startsWith(prefix) && path.length > prefix.length) return path.slice(prefix.length);
  }
  const segments = path.split(/[\\/]/u).filter(Boolean);
  return segments.length <= 3 ? segments.join("/") : `…/${segments.slice(-3).join("/")}`;
}

export function fileTarget(context: FileContext, path: string): ExperimentalLiveFileTarget | null {
  const relative = workspaceRelativePath(path, context.workspacePath);
  if (relative !== null && context.environmentId) return { kind: "workspace", environmentId: context.environmentId, path: relative };
  if (isAbsolutePath(path) && context.hostId) return { kind: "host", hostId: context.hostId, path };
  return null;
}
