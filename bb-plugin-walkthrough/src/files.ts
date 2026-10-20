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

export function fileTarget(context: FileContext, path: string): ExperimentalLiveFileTarget | null {
  const relative = workspaceRelativePath(path, context.workspacePath);
  if (relative !== null && context.environmentId) return { kind: "workspace", environmentId: context.environmentId, path: relative };
  if (isAbsolutePath(path) && context.hostId) return { kind: "host", hostId: context.hostId, path };
  return null;
}
