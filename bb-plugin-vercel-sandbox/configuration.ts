import { z } from "zod";

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
export const SETTING_DESCRIPTORS = {
  defaultVcpus: {
    type: "number",
    default: 2,
    label: "Default vCPUs",
    description:
      "1 vCPU or an even whole number up to 32. Vercel account plan limits apply; memory is 2048 MiB per vCPU.",
  },
  defaultTimeoutMinutes: {
    type: "number",
    default: 30,
    label: "Default lifetime (minutes)",
    description:
      "Whole number from 5 to 1440. Vercel account plan limits apply. Expiry discards uncommitted files.",
  },
} as const;
export type Credentials = z.infer<typeof scopeSchema> & {
  token: string;
  expiresAt: number;
};
export type LaunchInputs = z.infer<typeof resolvedInputsSchema>;
export class SafeError extends Error {}
export function resolveLaunchDefaults(raw: {
  defaultVcpus: number;
  defaultTimeoutMinutes: number;
}): LaunchInputs {
  const defaults = resolvedInputsSchema.safeParse({
    vcpus: raw.defaultVcpus,
    timeoutMinutes: raw.defaultTimeoutMinutes,
  });
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
