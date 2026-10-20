import { z } from "zod";
import { scopeSchema } from "./configuration.js";
export const accountHostInputSchema = z
  .object({
    hostId: z.string().min(1).max(200),
  })
  .strict();
export const projectsInputSchema = accountHostInputSchema
  .extend({
    teamId: scopeSchema.shape.teamId,
  })
  .strict();
const choiceSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
  })
  .strict();
export const accountChoicesSchema = z
  .object({
    choices: z.array(choiceSchema).max(5000),
  })
  .strict();
const directorySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => /^(\/|[A-Za-z]:[\\/])/.test(value) && !/[\r\n\0]/.test(value),
    "Choose an absolute linked directory.",
  );
export const connectionInputSchema = z
  .object({
    hostId: accountHostInputSchema.shape.hostId,
    directory: directorySchema.nullable().optional(),
    teamId: scopeSchema.shape.teamId.optional(),
    projectId: scopeSchema.shape.projectId.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.directory != null
        ? value.teamId === undefined && value.projectId === undefined
        : value.teamId !== undefined && value.projectId !== undefined,
    "Choose a team and project, or supply a linked directory.",
  );
export const legacyIdentitySchema = scopeSchema
  .extend({
    accountId: z.string().min(1).max(200),
    count: z.number().int().positive(),
  })
  .strict();
export const accountConnectInputSchema = connectionInputSchema
  .safeExtend({
    adoptLegacyAllocations: z.boolean().default(false),
    expectedLegacyIdentity: legacyIdentitySchema.nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      value.adoptLegacyAllocations === (value.expectedLegacyIdentity !== null),
    "Adoption requires the inspected account, team, project, and count; ordinary connect requires expectedLegacyIdentity null.",
  );
export const connectionSchema = scopeSchema
  .extend({
    hostId: accountHostInputSchema.shape.hostId,
    directory: directorySchema.nullable(),
    accountId: z.string().min(1).max(200),
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;
export const accountNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullable();
export const authenticatedConnectionSchema = z
  .object({ connection: connectionSchema, accountName: accountNameSchema })
  .strict();
export const accountInspectionSchema = z
  .object({
    available: z.boolean(),
    legacyAllocations: scopeSchema
      .extend({ count: z.number().int().positive() })
      .strict()
      .nullable(),
    adoptedAllocations: z.number().int().nonnegative(),
    message: z.string(),
    hostId: z.string().nullable(),
    directory: z.string().nullable(),
    accountId: z.string().nullable(),
    accountName: accountNameSchema,
    teamId: z.string().nullable(),
    projectId: z.string().nullable(),
  })
  .strict();
