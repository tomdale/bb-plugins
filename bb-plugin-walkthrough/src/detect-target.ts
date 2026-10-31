// What a manual start would cover, for the starter: the thread's open pull
// request, else its uncommitted changes (staged, unstaged and untracked alike),
// else the branch's committed changes against its merge base. The working tree
// comes from the host's git when it can answer, because BB's environment
// status can miss work that is only staged; the status is the fallback.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ChangedFiles } from "./code-contract.ts";

const changeCounts = { files: z.number().int().nonnegative(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() };

export const detectedTargetSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("pr"), number: z.number().int().positive(), title: z.string(), url: z.string(), draft: z.boolean() }).strict(),
    z
      .object({
        kind: z.literal("uncommitted"),
        ...changeCounts,
        /** Of `files`, how many have staged changes, unstaged changes, or are untracked; a file can be in two. Absent when only BB's status answered. */
        staged: z.number().int().nonnegative().optional(),
        unstaged: z.number().int().nonnegative().optional(),
        untracked: z.number().int().nonnegative().optional(),
      })
      .strict(),
    z.object({ kind: z.literal("branch"), branch: z.string().nullable(), base: z.string().nullable(), ...changeCounts }).strict(),
  ])
  .nullable();
export type DetectedTarget = z.infer<typeof detectedTargetSchema>;

type Sdk = Pick<BbPluginApi["sdk"], "threads" | "environments">;

/** The host's view of the working tree against HEAD; null when it cannot answer. */
export type WorkingTreeReader = (where: { hostId: string; path: string }) => Promise<ChangedFiles | null>;

/** Null when the thread has no workspace, nothing has changed, or the host cannot say. */
export async function detectTarget(sdk: Sdk, threadId: string, workingTree?: WorkingTreeReader): Promise<DetectedTarget> {
  const thread = await sdk.threads.get({ threadId });
  if (!thread.environmentId) return null;
  const environmentId = thread.environmentId;
  const [pullRequest, status] = await Promise.all([
    sdk.environments.pullRequest({ environmentId }).catch(() => null),
    sdk.environments.status({ environmentId }).catch(() => null),
  ]);
  if (pullRequest?.outcome === "available") {
    const { number, title, url, state } = pullRequest.pullRequest;
    if (state === "open" || state === "draft") return { kind: "pr", number, title, url, draft: state === "draft" };
  }
  const environment = workingTree ? await sdk.environments.get({ environmentId }).catch(() => null) : null;
  const found = workingTree && environment?.path ? await workingTree({ hostId: environment.hostId, path: environment.path }).catch(() => null) : null;
  if (found && found.files.length > 0) {
    const sum = (pick: (file: ChangedFiles["files"][number]) => number | null) => found.files.reduce((total, file) => total + (pick(file) ?? 0), 0);
    return {
      kind: "uncommitted",
      files: found.files.length,
      additions: sum((file) => file.additions),
      deletions: sum((file) => file.deletions),
      staged: found.staged,
      unstaged: found.unstaged,
      untracked: found.untracked,
    };
  }
  if (status?.outcome !== "available") return null;
  const { workingTree: tree, mergeBase, branch } = status.workspace;
  if (tree.hasUncommittedChanges && tree.files.length > 0) {
    return { kind: "uncommitted", files: tree.files.length, additions: tree.insertions, deletions: tree.deletions };
  }
  if (mergeBase && mergeBase.hasCommittedUnmergedChanges && mergeBase.files.length > 0) {
    return {
      kind: "branch",
      branch: branch.currentBranch,
      base: mergeBase.baseRef ?? mergeBase.mergeBaseBranch,
      files: mergeBase.files.length,
      additions: mergeBase.insertions,
      deletions: mergeBase.deletions,
    };
  }
  return null;
}
