import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const id = z.string().min(1).max(200);
export const selector = z
  .string()
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*\/[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/);
export const slug = z
  .string()
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const absolutePath = z.string().max(16384).startsWith("/");
export const entrySchema = z.object({
  selector,
  type: z.enum(["worktree", "template-workspace", "adhoc-workspace"]),
  groupName: z.string(),
  changeName: z.string(),
  path: absolutePath,
  state: z.string(),
  repository: z.string().optional(),
  repos: z.array(z.string()).optional(),
  modifiedAtMs: z.number(),
});
export const inventorySchema = z.object({
  workspaces: z.array(entrySchema),
  repositories: z.array(entrySchema),
});
export const repositorySchema = z.object({
  name: z.string(),
  path: absolutePath,
  branch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  state: z.string(),
  dirty: z.object({ total: z.number() }),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  integrated: z.boolean().nullable(),
  setup: z
    .object({
      status: z.string(),
      step: z.string().optional(),
      message: z.string().optional(),
    })
    .nullable(),
});
export const taskSchema = z.object({
  selector: z.string(),
  parentRepo: z.string(),
  slug: z.string(),
  branch: z.string(),
  path: absolutePath,
  state: z.string(),
  merged: z.boolean().nullable(),
});
export const detailSchema = z.object({
  selector,
  path: absolutePath,
  repositories: z.array(repositorySchema),
  tasks: z.array(taskSchema),
});
export const templateSchema = z.object({
  id: z.string(),
  repositories: z.array(z.string()),
  config: z.object({ description: z.string().optional() }),
});
export const targetSchema = z.object({ hostId: id, selector });
export const checkoutSchema = targetSchema.extend({ path: absolutePath });
export const operationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create"),
      name: slug,
      sources: z
        .array(
          z
            .string()
            .regex(
              /^(?:@[a-zA-Z0-9][a-zA-Z0-9_+.-]*|[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)$/,
            ),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      selector,
      repository: z.string().min(1).max(200),
      name: slug,
      setup: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("retry"), selector }).strict(),
]);
export const jobSchema = z.object({
  id,
  label: z.string(),
  state: z.enum(["running", "succeeded", "failed"]),
  output: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export const previewSchema = z.object({
  selector,
  path: absolutePath,
  blocked: z.boolean(),
  blockers: z.array(
    z.object({ message: z.string(), suggestion: z.string().optional() }),
  ),
  notes: z.array(z.string()),
});
export const hostContract = defineRpcContract({
  inventory: { input: z.null(), output: inventorySchema },
  createEnvironment: {
    input: z
      .object({
        name: slug,
        source: z.string().min(1).max(200),
      })
      .strict(),
    output: z.object({ path: absolutePath, selector }),
  },
  createTask: {
    input: z
      .object({ selector, repository: id, name: slug, setup: z.boolean() })
      .strict(),
    output: z.object({ path: absolutePath, branch: z.string() }),
  },
  templates: { input: z.null(), output: z.array(templateSchema) },
  detail: { input: z.object({ selector }), output: detailSchema },
  logs: {
    input: z.object({ selector }),
    output: z.object({ text: z.string() }),
  },
  start: { input: operationSchema, output: jobSchema },
  jobs: { input: z.null(), output: z.array(jobSchema) },
  preview: { input: z.object({ selector }), output: previewSchema },
});
export const bootstrapSchema = z.object({
  hosts: z.array(z.object({ id, name: z.string(), status: z.string() })),
  projects: z.array(
    z.object({
      id,
      name: z.string(),
      sources: z.array(z.object({ hostId: id, path: z.string() })),
    }),
  ),
});
export const rpcContract = defineRpcContract({
  bootstrap: { input: z.null(), output: bootstrapSchema },
  project: {
    input: targetSchema.extend({ path: absolutePath.optional() }),
    output: z.object({ projectId: id, path: absolutePath }),
  },
  inventory: { input: z.object({ hostId: id }), output: inventorySchema },
  templates: {
    input: z.object({ hostId: id }),
    output: z.array(templateSchema),
  },
  detail: { input: targetSchema, output: detailSchema },
  logs: { input: targetSchema, output: z.object({ text: z.string() }) },
  start: {
    input: z.object({ hostId: id, operation: operationSchema }),
    output: jobSchema,
  },
  jobs: { input: z.object({ hostId: id }), output: z.array(jobSchema) },
  preview: { input: targetSchema, output: previewSchema },
  context: {
    input: z.object({ threadId: id }),
    output: z
      .object({
        hostId: id,
        entry: entrySchema.nullable(),
        path: z.string().nullable(),
      })
      .nullable(),
  },
});
export type Entry = z.infer<typeof entrySchema>;
export type Detail = z.infer<typeof detailSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type Job = z.infer<typeof jobSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type Template = z.infer<typeof templateSchema>;
export type Preview = z.infer<typeof previewSchema>;
