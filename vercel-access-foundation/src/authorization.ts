import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { isUsable, type GrantRecord } from "./grants.ts";

export const PROBE_PATH = "/v0/probe";
export const MAX_ASSERTION_BYTES = 8192;
export const ASSERTION_TTL_MS = 15_000;
export const MAX_REPLAY_ENTRIES = 4096;

export interface RelayIdentity {
  installationId: string;
  relayId: string;
  generation: number;
}

export interface ProbeClaims extends RelayIdentity {
  version: 0;
  grantId: string;
  hostId: string;
  scope: "transport:probe";
  method: "GET";
  target: typeof PROBE_PATH;
  bodyHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

const claimKeys = [
  "installationId", "relayId", "generation", "version", "grantId", "hostId", "scope",
  "method", "target", "bodyHash", "issuedAt", "expiresAt", "nonce",
].sort();

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertSafeHeaders(headers: Headers): void {
  for (const name of headers.keys()) {
    if (name.startsWith("x-bb-gate-") || name.startsWith("x-forwarded-") ||
        name.startsWith("sec-fetch-") ||
        ["forwarded", "cookie", "origin", "x-bb-plugin-token"].includes(name)) {
      throw new Error("Untrusted authority header");
    }
  }
}

export function signProbe(claims: ProbeClaims, privateKey: KeyObject): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`;
}

function parseClaims(value: unknown): ProbeClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid assertion");
  }
  const c = value as Record<string, unknown>;
  if (Object.keys(c).sort().join(",") !== claimKeys.join(",") ||
      c.version !== 0 || c.scope !== "transport:probe" || c.method !== "GET" ||
      c.target !== PROBE_PATH || c.bodyHash !== digest("") ||
      !Number.isSafeInteger(c.generation) || Number(c.generation) < 1 ||
      !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) ||
      ![c.installationId, c.relayId, c.grantId, c.hostId, c.nonce].every(
        (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v),
      )) {
    throw new Error("Invalid assertion claims");
  }
  return c as unknown as ProbeClaims;
}

export class ProbeVerifier {
  readonly #seen = new Map<string, number>();
  readonly #key: KeyObject;
  readonly #identity: RelayIdentity;

  constructor(publicKey: KeyObject, identity: RelayIdentity) {
    this.#key = publicKey;
    this.#identity = { ...identity };
  }

  verify(input: {
    assertion: string;
    method: string;
    target: string;
    bodyHash: string;
    headers: Headers;
    grant: GrantRecord;
    now: number;
  }): ProbeClaims {
    assertSafeHeaders(input.headers);
    if (Buffer.byteLength(input.assertion) > MAX_ASSERTION_BYTES) throw new Error("Assertion too large");
    const parts = input.assertion.split(".");
    if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
      throw new Error("Invalid assertion encoding");
    }
    const [payload, signature] = parts as [string, string];
    if (!verify(null, Buffer.from(payload), this.#key, Buffer.from(signature, "base64url"))) {
      throw new Error("Invalid assertion signature");
    }
    const claims = parseClaims(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (claims.installationId !== this.#identity.installationId ||
        claims.relayId !== this.#identity.relayId || claims.generation !== this.#identity.generation ||
        claims.method !== input.method || claims.target !== input.target || claims.bodyHash !== input.bodyHash ||
        claims.grantId !== input.grant.id || claims.hostId !== input.grant.hostId ||
        !isUsable(input.grant, input.now) || claims.issuedAt > input.now ||
        claims.expiresAt <= input.now || claims.expiresAt <= claims.issuedAt ||
        claims.expiresAt - claims.issuedAt > ASSERTION_TTL_MS) {
      throw new Error("Assertion binding, lifetime, or grant refused");
    }
    for (const [nonce, expiresAt] of this.#seen) {
      if (expiresAt <= input.now) this.#seen.delete(nonce);
    }
    if (this.#seen.has(claims.nonce)) throw new Error("Replayed assertion");
    if (this.#seen.size >= MAX_REPLAY_ENTRIES) throw new Error("Replay budget exhausted");
    this.#seen.set(claims.nonce, claims.expiresAt);
    return claims;
  }
}
