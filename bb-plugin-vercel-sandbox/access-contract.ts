import { z } from "zod";

export const ACCESS_PROVIDER = "vercel-sandbox-relay";
export const setupKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const accessStatusSchema = z.object({
  available: z.boolean(),
  ready: z.boolean(),
  message: z.string().max(500),
  key: setupKeySchema.nullable(),
  phase: z.string().max(32).nullable(),
  expiresAt: z.number().finite().nullable(),
  selected: z.boolean(),
  defaultProvider: z.string().nullable(),
  canRestore: z.boolean(),
}).strict();
const empty = z.object({}).strict();
const key = z.object({ key: setupKeySchema }).strict();
export const accessMethods = {
  "access.status": { input: empty, output: accessStatusSchema },
  "access.enable": { input: empty, output: accessStatusSchema },
  "access.disable": { input: empty, output: accessStatusSchema },
  "access.prepare": { input: key.extend({ approveAllocation: z.literal(true) }).strict(), output: accessStatusSchema },
  "access.inspect": { input: key, output: accessStatusSchema },
  "access.activate": { input: key, output: accessStatusSchema },
  "access.stop": { input: key, output: accessStatusSchema },
  "access.select": { input: z.object({ expectedDefault: z.string().nullable(), approveDefaultChange: z.literal(true) }).strict(), output: accessStatusSchema },
  "access.restore": { input: empty, output: accessStatusSchema },
};
