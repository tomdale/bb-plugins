import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AtomicFile } from "./persistence.ts";
import { fresh, type Frame, LIMITS } from "./protocol.ts";

export interface Lease {
  key: string; hostId: string; id: string; epoch: number; token: string;
  phase: "pending" | "active" | "revoking" | "revoked"; expiresAt: number;
}
export interface Snapshot { version: 1; leases: Lease[] }
export interface Persistence { load(): Promise<Snapshot>; save(state: Snapshot): Promise<void> }
export class MemoryPersistence implements Persistence {
  state: Snapshot = { version: 1, leases: [] };
  async load() { return structuredClone(this.state); }
  async save(state: Snapshot) { this.state = structuredClone(state); }
}

// Single-writer local journal. No distributed locking, cloud CAS, or key vault is implied.
export class FilePersistence extends AtomicFile<Snapshot> implements Persistence {
  constructor(path: string) { super(path, { version: 1, leases: [] }); }
}
export type Boundary = "intent" | "issued" | "active" | "revoke-intent" | "remote-revoked" | "revoked";
export interface GrantAdapter { issue(lease: Readonly<Lease>): Promise<void>; revoke(lease: Readonly<Lease>): Promise<void> }
const noop: GrantAdapter = { async issue() {}, async revoke() {} };
export class Authority {
  #state: Snapshot = { version: 1, leases: [] };
  #tail: Promise<unknown> = Promise.resolve();
  #ready = false;
  #listeners = new Set<() => void>();
  constructor(readonly persistence: Persistence, readonly now: () => number = Date.now,
    readonly adapter: GrantAdapter = noop, readonly boundary: (name: Boundary) => void = () => {}) {}
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn);
    this.#tail = next.catch(() => {});
    return next;
  }
  onChange(fn: () => void): () => void { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; }
  #notify() { for (const fn of this.#listeners) fn(); }
  async #save(boundary: Boundary) {
    try { await this.persistence.save(this.#state); this.#notify(); this.boundary(boundary); }
    catch (error) { this.#ready = false; this.#notify(); throw error; }
  }
  recover(): Promise<void> {
    return this.#serial(async () => {
      this.#ready = false;
      this.#state = await this.persistence.load();
      validateSnapshot(this.#state);
      this.#notify();
      for (const lease of this.#state.leases) {
        if (lease.phase === "revoking") await this.#revoke(lease);
        if (lease.phase === "pending") {
          if (lease.expiresAt <= this.now()) await this.#release(lease);
          else await this.#issue(lease);
        }
      }
      this.#ready = true;
      this.#notify();
    });
  }
  acquire(key: string, hostId: string, ttl = 60_000): Promise<Lease> {
    return this.#serial(async () => {
      if (!this.#ready || !/^[\w-]{1,128}$/.test(key) || !/^[\w-]{1,128}$/.test(hostId) ||
          !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86_400_000) throw new Error("Acquisition denied");
      const history = this.#state.leases.filter((x) => x.key === key && x.hostId === hostId);
      const previous = history.at(-1);
      if (previous && previous.phase !== "revoked") {
        if (previous.phase === "revoking" || previous.expiresAt <= this.now()) throw new Error("Repair required");
        if (previous.phase === "pending") await this.#issue(previous);
        return structuredClone(previous);
      }
      if (this.#state.leases.length >= 512) throw new Error("Grant journal budget");
      const lease: Lease = { key, hostId, id: fresh(), epoch: (previous?.epoch ?? 0) + 1,
        token: randomBytes(32).toString("base64url"), phase: "pending", expiresAt: this.now() + ttl };
      this.#state.leases.push(lease);
      await this.#save("intent");
      await this.#issue(lease);
      return structuredClone(lease);
    });
  }
  async #issue(lease: Lease) {
    try {
      await this.adapter.issue(structuredClone(lease)); this.boundary("issued");
      lease.phase = "active"; await this.#save("active");
    } catch (error) { this.#ready = false; this.#notify(); throw error; }
  }
  release(key: string, hostId: string, epoch: number, grantId: string | null): Promise<void> {
    return this.#serial(async () => {
      if (!this.#ready) throw new Error("Not recovered");
      const lease = this.#state.leases.find((x) => x.key === key && x.hostId === hostId && x.epoch === epoch);
      if (!lease || grantId !== null && lease.id !== grantId) throw new Error("Release identity");
      if (lease.phase !== "revoked") await this.#release(lease);
    });
  }
  async #release(lease: Lease) { lease.phase = "revoking"; await this.#save("revoke-intent"); await this.#revoke(lease); }
  async #revoke(lease: Lease) {
    await this.adapter.revoke(structuredClone(lease)); this.boundary("remote-revoked");
    lease.phase = "revoked"; await this.#save("revoked");
  }
  byId(id: string): Lease | undefined {
    const lease = this.#state.leases.find((x) => x.id === id);
    return this.#ready && lease?.phase === "active" && this.now() < lease.expiresAt ? structuredClone(lease) : undefined;
  }
  authenticate(token: string | undefined): Lease {
    if (!token || token.length > 256) throw new Error("Machine credential");
    const hash = (value: string) => createHash("sha256").update(value).digest();
    const supplied = hash(token);
    const lease = this.#state.leases.find((x) => timingSafeEqual(hash(x.token), supplied));
    const active = lease && this.byId(lease.id);
    if (!active) throw new Error("Machine credential");
    return active;
  }
  check(frame: Extract<Frame, { type: "open" }>): Lease {
    const lease = this.byId(frame.grantId), now = this.now();
    if (!lease || lease.hostId !== frame.hostId || lease.epoch !== frame.acquisitionEpoch ||
        frame.issuedAt > now || frame.deadline <= now || frame.deadline <= frame.issuedAt ||
        frame.deadline - frame.issuedAt > LIMITS.ttl) throw new Error("Grant/open lifetime");
    return lease;
  }
}
function validateSnapshot(state: Snapshot): void {
  if (!state || state.version !== 1 || !Array.isArray(state.leases) || state.leases.length > 512) throw new Error("Journal format");
  const ids = new Set<string>(), epochs = new Set<string>();
  for (const lease of state.leases) {
    if (!lease) throw new Error("Journal lease");
    const epoch = JSON.stringify([lease.key, lease.hostId, lease.epoch]);
    if (![lease.key, lease.hostId, lease.id, lease.token].every((s) => typeof s === "string" && /^[\w-]{1,128}$/.test(s)) ||
        !Number.isSafeInteger(lease.epoch) || lease.epoch < 1 || !Number.isSafeInteger(lease.expiresAt) ||
        !["pending", "active", "revoking", "revoked"].includes(lease.phase) || ids.has(lease.id) || epochs.has(epoch)) throw new Error("Journal lease");
    ids.add(lease.id); epochs.add(epoch);
  }
}
