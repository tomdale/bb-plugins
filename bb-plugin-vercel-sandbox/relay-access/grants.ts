import { createHash, randomBytes, randomUUID } from "node:crypto";

interface Grant {
  id: string; key: string; hostId: string; token: string; expiresAt: number;
}

/**
 * Process-lifetime transport admission leases. Native BB credentials determine
 * the host; the stored hostId is only an acquisition/release correlation key.
 * Restart deliberately invalidates every lease. Existing-worker header
 * reconfiguration is outside this fresh-bootstrap prototype.
 */
export class AdmissionLeases {
  private readonly grants = new Map<string, Grant>();
  private readonly revoked = new Set<(digest: string) => void>();
  readonly now: () => number;

  constructor(now = Date.now) { this.now = now; }
  digest(token: string) { return createHash("sha256").update(token).digest("hex"); }
  acquire(key: string, hostId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.expire();
    const previous = [...this.grants.values()].find(g => g.key === key && g.hostId === hostId);
    if (previous) return { ...previous };
    if (this.grants.size >= 256) throw new Error("Transport admission capacity reached");
    const grant = { id: randomUUID(), key, hostId, token: randomBytes(32).toString("base64url"), expiresAt: this.now() + 24 * 60 * 60 * 1000 };
    this.grants.set(this.digest(grant.token), grant);
    return { ...grant };
  }
  accepts(token: string): boolean {
    this.expire();
    return this.grants.has(this.digest(token));
  }
  release(key: string, hostId: string, id: string | null) {
    for (const [digest, grant] of this.grants) {
      if (grant.key === key && grant.hostId === hostId && (id === null || grant.id === id)) this.remove(digest);
    }
  }
  expire() {
    for (const [digest, grant] of this.grants) if (grant.expiresAt <= this.now()) this.remove(digest);
  }
  private remove(digest: string) {
    this.grants.delete(digest);
    for (const listener of this.revoked) listener(digest);
  }
  onRevoke(listener: (digest: string) => void) { this.revoked.add(listener); return () => { this.revoked.delete(listener); }; }
  clear() { for (const digest of this.grants.keys()) this.remove(digest); }
}
