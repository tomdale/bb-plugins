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

export const codeHostContract = defineRpcContract({
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
