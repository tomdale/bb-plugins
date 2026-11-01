export const enableErrors = {
  inspect: "Couldn't inspect the saved relay. Check the Vercel account connection, then retry.",
  cleanup: "Couldn't confirm cleanup of the old relay. Retry to finish cleanup before creating a replacement.",
  prepare: "Couldn't prepare the relay. Check the Vercel account connection, then retry the same setup.",
  connect: "Couldn't connect the relay. Open Details for its status, then retry.",
  readiness: "The relay is still connecting. Wait a moment, then retry; the existing relay will be reused.",
  select: "Couldn't select the relay for new machines. Refresh status and retry.",
} as const;

export function safeAccessError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return Object.values(enableErrors).find(message => message === error.message) ?? null;
}
