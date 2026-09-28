import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const environmentNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/u,
    "Use a variable name containing letters, digits and underscores, not starting with a digit.",
  )
  .max(128);
export const commandSchema = z
  .string()
  .trim()
  .min(1, "Enter a command.")
  .max(16_384)
  .refine(
    (value) => !value.includes("\0"),
    "Commands cannot contain NUL bytes.",
  );
export const dynamicEntrySchema = z
  .object({ name: environmentNameSchema, command: commandSchema })
  .strict();
export const dynamicEntriesSchema = z
  .array(dynamicEntrySchema)
  .max(128)
  .superRefine((entries, context) => {
    const names = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (names.has(entry.name))
        context.addIssue({
          code: "custom",
          message: `Duplicate variable ${entry.name}`,
          path: [index, "name"],
        });
      names.add(entry.name);
    }
  });
export type DynamicEntry = z.infer<typeof dynamicEntrySchema>;

const dynamicStateSchema = z
  .object({ entries: dynamicEntriesSchema, revision: z.string() })
  .strict();
const staticStateSchema = z
  .object({
    names: z.array(z.string()),
    revision: z.string(),
    path: z.string(),
  })
  .strict();
const expectedRevision = z.string().min(1);
const success = z.object({ ok: z.literal(true) });
export const contract = defineRpcContract({
  dynamicList: { input: z.object({}).strict(), output: dynamicStateSchema },
  dynamicSave: {
    input: z
      .object({
        originalName: environmentNameSchema.nullable(),
        entry: dynamicEntrySchema,
        revision: expectedRevision,
      })
      .strict(),
    output: dynamicStateSchema,
  },
  dynamicRemove: {
    input: z
      .object({ name: environmentNameSchema, revision: expectedRevision })
      .strict(),
    output: dynamicStateSchema,
  },
  staticList: { input: z.object({}).strict(), output: staticStateSchema },
  staticSave: {
    input: z
      .object({
        originalName: environmentNameSchema.nullable(),
        name: environmentNameSchema,
        value: z
          .string()
          .max(128 * 1024)
          .refine(
            (value) => !value.includes("\0"),
            "Values cannot contain NUL bytes.",
          )
          .nullable(),
        revision: expectedRevision,
      })
      .strict(),
    output: staticStateSchema,
  },
  staticRemove: {
    input: z
      .object({ name: environmentNameSchema, revision: expectedRevision })
      .strict(),
    output: staticStateSchema,
  },
  reloadConfig: { input: z.object({}).strict(), output: success },
});
export type DynamicState = z.infer<typeof dynamicStateSchema>;
export type StaticState = z.infer<typeof staticStateSchema>;
