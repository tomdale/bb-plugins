import { z } from "zod";
import { PLANS } from "./plans.js";

export const allowedVcpus = [
  1,
  ...Array.from({ length: 16 }, (_, index) => (index + 1) * 2),
];
export const vcpusSchema = z
  .number()
  .int()
  .min(1)
  .max(32)
  .refine(
    (value) => value === 1 || value % 2 === 0,
    "Choose 1 vCPU or an even vCPU count up to 32.",
  );
export const timeoutMinutesSchema = z.number().int().min(5).max(1440);
export const launchInputsSchema = z
  .object({
    vcpus: vcpusSchema.optional(),
    timeoutMinutes: timeoutMinutesSchema.optional(),
  })
  .strict()
  .nullable()
  .transform((value) => value ?? {});
export const resolvedInputsSchema = z
  .object({
    vcpus: vcpusSchema,
    timeoutMinutes: timeoutMinutesSchema,
  })
  .strict();
export const scopeSchema = z
  .object({
    teamId: z.string().regex(/^team_[A-Za-z0-9]+$/),
    projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  })
  .strict();
/** A Vercel team's billing plan, which caps sandbox size and lifetime. */
export const planSchema = z.enum(PLANS);
export type { Plan } from "./plans.js";
export const DEFAULT_LAUNCH_INPUTS = { vcpus: 2, timeoutMinutes: 30 } as const;
export const MEMORY_MIB_PER_VCPU = 2048;
export type Credentials = z.infer<typeof scopeSchema> & {
  token: string;
  expiresAt: number;
};
export type LaunchInputs = z.infer<typeof resolvedInputsSchema>;
export class SafeError extends Error {}
/**
 * Parses the stored launch defaults; nothing stored means the built-in
 * defaults, and a stored value that no longer validates is refused rather
 * than replaced, so a launch never silently uses a size nobody chose.
 */
export function resolveLaunchDefaults(stored: unknown): LaunchInputs {
  if (stored === null || stored === undefined) return DEFAULT_LAUNCH_INPUTS;
  const defaults = resolvedInputsSchema.safeParse(stored);
  if (!defaults.success)
    throw new SafeError(
      "Default vCPUs must be 1 or an even count up to 32 and lifetime must be 5–1440 whole minutes.",
    );
  return defaults.data;
}
export function safeMessage(error: unknown): string {
  return error instanceof SafeError
    ? error.message
    : "Vercel Sandbox operation failed. Check the connected machine, CLI login, linked project, plan limits, and connectivity; retry cleanup after resolving the problem.";
}
