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
// Settings choices. Vercel's plan limits are not visible to BB, so choices
// above the Hobby limits are tagged with the plans that allow them rather
// than hidden.
export const TIMEOUT_CHOICES_MINUTES = [
  15, 30, 45, 60, 120, 240, 480, 1440,
] as const;
const HOBBY_MAX_VCPUS = 4;
const PRO_MAX_VCPUS = 8;
const HOBBY_MAX_TIMEOUT_MINUTES = 45;
export const MEMORY_MIB_PER_VCPU = 2048;

function vcpuChoiceLabel(vcpus: number): string {
  const size = `${vcpus} vCPU${vcpus === 1 ? "" : "s"} · ${(vcpus * MEMORY_MIB_PER_VCPU) / 1024} GiB`;
  if (vcpus <= HOBBY_MAX_VCPUS) return size;
  return `${size} (${vcpus <= PRO_MAX_VCPUS ? "Pro and up" : "Enterprise"})`;
}
function timeoutChoiceLabel(minutes: number): string {
  const duration =
    minutes < 60
      ? `${minutes} minutes`
      : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return minutes <= HOBBY_MAX_TIMEOUT_MINUTES
    ? duration
    : `${duration} (Pro and up)`;
}
const choiceLabels = (
  values: readonly number[],
  label: (n: number) => string,
) => Object.fromEntries(values.map((value) => [String(value), label(value)]));

/**
 * Launch defaults, shown as dropdowns in the host's Configuration form.
 * Select settings store strings; `resolveLaunchDefaults` parses them.
 */
export const SETTING_DESCRIPTORS = {
  defaultVcpus: {
    type: "select",
    default: "2",
    label: "Default vCPUs",
    description:
      "Memory is 2 GiB per vCPU. The composer can override this per thread.",
    options: allowedVcpus.map(String),
    experimental_optionLabels: choiceLabels(allowedVcpus, vcpuChoiceLabel),
  },
  defaultTimeoutMinutes: {
    type: "select",
    default: "30",
    label: "Default lifetime",
    description:
      "Sandboxes stop for good at this limit and uncommitted files are lost.",
    options: TIMEOUT_CHOICES_MINUTES.map(String),
    experimental_optionLabels: choiceLabels(
      TIMEOUT_CHOICES_MINUTES,
      timeoutChoiceLabel,
    ),
  },
} as const;
export type Credentials = z.infer<typeof scopeSchema> & {
  token: string;
  expiresAt: number;
};
export type LaunchInputs = z.infer<typeof resolvedInputsSchema>;
export class SafeError extends Error {}
export function resolveLaunchDefaults(raw: {
  defaultVcpus: string;
  defaultTimeoutMinutes: string;
}): LaunchInputs {
  const defaults = resolvedInputsSchema.safeParse({
    vcpus: Number(raw.defaultVcpus),
    timeoutMinutes: Number(raw.defaultTimeoutMinutes),
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
