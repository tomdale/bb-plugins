// What a manual start would cover, for the starter: the thread's open pull
// request, else its uncommitted changes, else the branch's committed changes
// against its merge base. Reads only the environment's status; no git here.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const changeCounts = { files: z.number().int().nonnegative(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() };

export const detectedTargetSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("pr"), number: z.number().int().positive(), title: z.string(), url: z.string(), draft: z.boolean() }).strict(),
    z.object({ kind: z.literal("uncommitted"), ...changeCounts }).strict(),
    z.object({ kind: z.literal("branch"), branch: z.string().nullable(), base: z.string().nullable(), ...changeCounts }).strict(),
  ])
  .nullable();
export type DetectedTarget = z.infer<typeof detectedTargetSchema>;

type Sdk = Pick<BbPluginApi["sdk"], "threads" | "environments">;

/** Null when the thread has no workspace, nothing has changed, or the host cannot say. */
export async function detectTarget(sdk: Sdk, threadId: string): Promise<DetectedTarget> {
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
  if (status?.outcome !== "available") return null;
  const { workingTree, mergeBase, branch } = status.workspace;
  if (workingTree.hasUncommittedChanges && workingTree.files.length > 0) {
    return { kind: "uncommitted", files: workingTree.files.length, additions: workingTree.insertions, deletions: workingTree.deletions };
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
