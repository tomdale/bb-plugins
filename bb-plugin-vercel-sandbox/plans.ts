// Vercel plan limits shared by the server and the Settings and composer UI.
// This module has no dependencies so the app bundle can import it cheaply.

export const PLANS = ["hobby", "pro", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_NAMES: Record<Plan, string> = {
  hobby: "Hobby",
  pro: "Pro",
  enterprise: "Enterprise",
};

/** Sandbox maximums for each plan, per the pinned SDK's documentation. */
export const PLAN_LIMITS: Record<
  Plan,
  { maxVcpus: number; maxTimeoutMinutes: number }
> = {
  hobby: { maxVcpus: 4, maxTimeoutMinutes: 45 },
  pro: { maxVcpus: 8, maxTimeoutMinutes: 1440 },
  enterprise: { maxVcpus: 32, maxTimeoutMinutes: 1440 },
};

/**
 * Caps launch inputs at a plan's maximums. Every cap is itself an allowed
 * vCPU count and lifetime, so the result is always launchable on that plan.
 * An unknown plan leaves the inputs unchanged.
 */
export function capToPlan<T extends { vcpus: number; timeoutMinutes: number }>(
  inputs: T,
  plan: Plan | null,
): T {
  if (plan === null) return inputs;
  const limits = PLAN_LIMITS[plan];
  return {
    ...inputs,
    vcpus: Math.min(inputs.vcpus, limits.maxVcpus),
    timeoutMinutes: Math.min(inputs.timeoutMinutes, limits.maxTimeoutMinutes),
  };
}
