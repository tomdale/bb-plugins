export type GrantPhase = "pending" | "active" | "revoking" | "revoked";

export interface GrantRecord {
  key: string;
  hostId: string;
  id: string;
  phase: GrantPhase;
  expiresAt: number;
}

export function acquireIntent(
  existing: GrantRecord | undefined,
  input: { key: string; hostId: string; id: string; expiresAt: number },
): GrantRecord {
  if (!input.key || !input.hostId || !input.id || !Number.isSafeInteger(input.expiresAt)) {
    throw new Error("Invalid grant intent");
  }
  if (!existing) return { ...input, phase: "pending" };
  if (existing.key !== input.key || existing.hostId !== input.hostId) {
    throw new Error("Acquisition identity conflict");
  }
  if (existing.phase === "revoked" || existing.phase === "revoking") {
    throw new Error("Released acquisition cannot be reused");
  }
  return { ...existing };
}

export function activate(record: GrantRecord): GrantRecord {
  if (record.phase !== "pending" && record.phase !== "active") {
    throw new Error("Cannot activate a released grant");
  }
  return { ...record, phase: "active" };
}

export function beginRelease(
  record: GrantRecord,
  input: { key: string; hostId: string; grantId: string | null },
): GrantRecord {
  if (record.key !== input.key || record.hostId !== input.hostId ||
      (input.grantId !== null && input.grantId !== record.id)) {
    throw new Error("Release identity conflict");
  }
  return { ...record, phase: record.phase === "revoked" ? "revoked" : "revoking" };
}

export function finishRelease(record: GrantRecord): GrantRecord {
  if (record.phase !== "revoking" && record.phase !== "revoked") {
    throw new Error("Release must deny access before remote cleanup");
  }
  return { ...record, phase: "revoked" };
}

export function isUsable(record: GrantRecord, now: number): boolean {
  return record.phase === "active" && now < record.expiresAt;
}
