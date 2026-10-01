import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const createInput = z.object({
  task: z.string().trim().min(1).max(32000),
  title: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  timeout: z.number().int().min(0).max(86400).optional(),
}).strict();
export const runSchema = z.object({
  id: z.string(), ownerThreadId: z.string(), rootThreadId: z.string(),
  threadId: z.string().nullable(), title: z.string(), task: z.string(),
  depth: z.number(), createdAt: z.number(), deadline: z.number().nullable(),
  status: z.enum(["starting", "running", "completed", "failed", "killed", "timed-out"]),
  control: z.enum(["agent", "user", "returned"]),
  output: z.string(), error: z.string().nullable(),
  notifications: z.array(z.string()), cleanupPending: z.boolean(),
});
export type Run = z.infer<typeof runSchema>;
const target = z.object({ id: z.string().min(1) }).strict();
export const rpcContract = defineRpcContract({
  list: { input: z.object({ threadId: z.string() }).strict(), output: z.object({ runs: z.array(runSchema), promoted: runSchema.nullable() }) },
  promote: { input: target, output: z.object({ threadId: z.string() }) },
  returnControl: { input: target, output: z.object({ threadId: z.string() }) },
});
