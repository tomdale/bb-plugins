// How much of the change a walkthrough shows: the changed files against the
// files its committed figures and parts cite. Pure, so the server can compute
// it on every delivery from the stored change set.
import { workspaceRelativePath } from "./files.ts";
import type { ChangeSet, Coverage, CoverageFile, Part, Walkthrough } from "./schemas.ts";

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "Podfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "gradle.lockfile",
  "Package.resolved",
]);

const GENERATED_PATTERNS = [
  /(^|\/)(dist|build|out|coverage|\.next|\.turbo|__generated__|generated|node_modules)\//u,
  /\.min\.(js|css)$/u,
  /\.(snap|map)$/u,
  /\.generated\.[a-z]+$/u,
  /\.pb\.(go|ts|js)$/u,
  /_pb2(_grpc)?\.pyi?$/u,
  /(^|\/)[^/]*\.d\.ts\.map$/u,
];

/** Why a changed file is listed but not expected to be explained, or null for an ordinary file. */
export function exclusionReason(file: { path: string; binary: boolean }): "lockfile" | "generated" | "binary" | null {
  const name = file.path.split("/").at(-1) ?? file.path;
  if (LOCKFILE_NAMES.has(name)) return "lockfile";
  if (GENERATED_PATTERNS.some((pattern) => pattern.test(file.path))) return "generated";
  return file.binary ? "binary" : null;
}

/** The files a part cites: its code figures and its planned locations. Figures only count once the part is written. */
function citedBy(walkthrough: Pick<Walkthrough, "workspacePath">, part: Pick<Part, "blocks" | "locations" | "status">): { shown: Set<string>; planned: Set<string> } {
  const normalize = (path: string) => workspaceRelativePath(path, walkthrough.workspacePath) ?? path;
  const shown = new Set<string>();
  const planned = new Set<string>();
  if (part.status === "ready") {
    for (const block of part.blocks) if (block.kind === "code") shown.add(normalize(block.path));
    for (const location of part.locations) shown.add(normalize(location.path));
  } else {
    for (const location of part.locations) planned.add(normalize(location.path));
  }
  return { shown, planned };
}

export function computeCoverage(walkthrough: Walkthrough, changeSet: ChangeSet | null | undefined): Coverage | null {
  if (!changeSet) return null;
  const shown = new Set<string>();
  const planned = new Map<string, number>();
  walkthrough.parts.forEach((part, index) => {
    const cited = citedBy(walkthrough, part);
    cited.shown.forEach((path) => shown.add(path));
    cited.planned.forEach((path) => planned.has(path) || planned.set(path, index));
  });
  if (walkthrough.wrapUp) citedBy(walkthrough, walkthrough.wrapUp).shown.forEach((path) => shown.add(path));
  const files: CoverageFile[] = changeSet.files.map((file) => {
    const covered = shown.has(file.path) || (file.oldPath !== null && shown.has(file.oldPath));
    const plannedIn = covered ? null : (planned.get(file.path) ?? (file.oldPath === null ? undefined : planned.get(file.oldPath)) ?? null);
    return { path: file.path, status: file.status, additions: file.additions, deletions: file.deletions, covered, excluded: exclusionReason(file), plannedIn };
  });
  return {
    files,
    covered: files.filter((file) => file.covered).map((file) => file.path),
    uncovered: files.filter((file) => !file.covered && file.excluded === null).map((file) => file.path),
    notShown: files.filter((file) => !file.covered && file.excluded !== null).map((file) => file.path),
    changed: files.length,
    truncated: changeSet.truncated,
    capturedAt: changeSet.capturedAt,
  };
}

/** The workspace-relative paths a part cites, for staleness checks. */
export function citedPaths(walkthrough: Pick<Walkthrough, "workspacePath">, part: Pick<Part, "blocks" | "locations">): string[] {
  const paths = new Set<string>();
  for (const block of part.blocks) if (block.kind === "code") paths.add(workspaceRelativePath(block.path, walkthrough.workspacePath) ?? block.path);
  for (const location of part.locations) paths.add(workspaceRelativePath(location.path, walkthrough.workspacePath) ?? location.path);
  return [...paths].sort();
}
