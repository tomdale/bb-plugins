import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const side = z.object({ path: z.string(), content: z.string() }).strict();
export const codeSnapshotSchema = z.object({
  path: z.string(),
  patch: z.string(),
  truncated: z.boolean(),
  sides: z.object({ old: side, new: side }).strict().nullable(),
}).strict();
export type CodeSnapshot = z.infer<typeof codeSnapshotSchema>;

export const changeStatusSchema = z.enum(["added", "modified", "deleted", "renamed"]);
export type ChangeStatus = z.infer<typeof changeStatusSchema>;

/** Where a file's change lives in the workspace; a file can be in several. */
export const changeOriginSchema = z.enum(["committed", "staged", "unstaged", "untracked"]);
export type ChangeOrigin = z.infer<typeof changeOriginSchema>;

export const changedFileSchema = z
  .object({
    path: z.string(),
    /** The path before a rename; null otherwise. */
    oldPath: z.string().nullable(),
    status: changeStatusSchema,
    /** Null for binary files and files too large to count. */
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    binary: z.boolean(),
    origins: z.array(changeOriginSchema),
  })
  .strict();
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const changedFilesInputSchema = z
  .object({
    /** Any absolute path inside the repository (normally the workspace root). */
    path: z.string().min(1),
    baseRef: z.string().min(1),
    /** A pinned head (a PR's) replaces both HEAD and the working tree. */
    headRef: z.string().min(1).optional(),
    includeUncommitted: z.boolean(),
  })
  .strict();
export type ChangedFilesInput = z.infer<typeof changedFilesInputSchema>;

export const changedFilesSchema = z
  .object({
    files: z.array(changedFileSchema),
    /** Files whose change is staged, unstaged, or untracked right now, whatever the base. */
    staged: z.number().int().nonnegative(),
    unstaged: z.number().int().nonnegative(),
    untracked: z.number().int().nonnegative(),
    /** True when more files changed than were listed. */
    truncated: z.boolean(),
    branch: z.string().nullable(),
  })
  .strict();
export type ChangedFiles = z.infer<typeof changedFilesSchema>;

export const codeHostContract = defineRpcContract({
  /**
   * A content hash of each named file as the working tree holds it right now
   * (null when the file is absent), for noticing that a file a part cites has
   * changed since the part was written. Paths are relative to the repository.
   */
  fileHashes: {
    input: z.object({ path: z.string().min(1), paths: z.array(z.string().min(1).max(1024)).max(200) }).strict(),
    output: z.object({ hashes: z.record(z.string(), z.string().nullable()) }).strict(),
  },
  /**
   * The files that differ from `baseRef`: committed, staged, unstaged and
   * untracked work alike, with renames detected, plus how much of the working
   * tree is staged, unstaged, and untracked.
   */
  changedFiles: {
    input: changedFilesInputSchema,
    output: changedFilesSchema,
  },
  readCode: {
    input: z
      .object({
        path: z.string().min(1),
        baseRef: z.string().min(1),
        /** Read this commit instead of the checkout: a PR head, which the working tree may not be. */
        headRef: z.string().min(1).optional(),
        includeUncommitted: z.boolean(),
        withFullFile: z.boolean(),
      })
      .strict(),
    output: codeSnapshotSchema,
  },
});
