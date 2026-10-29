import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { ASSERTION_TTL_MS, MAX_ASSERTION_BYTES, MAX_REPLAY_ENTRIES, PROBE_PATH, ProbeVerifier, digest, signProbe, type ProbeClaims } from "./authorization.ts";
import type { GrantRecord } from "./grants.ts";

const keys = generateKeyPairSync("ed25519");
const identity = { installationId: "installation_test", relayId: "relay_test", generation: 1 };
const grant: GrantRecord = { key: "key_test", id: "grant_test", hostId: "host_test", phase: "active", expiresAt: 100_000 };
const claims: ProbeClaims = {
  ...identity, version: 0, grantId: grant.id, hostId: grant.hostId,
  scope: "transport:probe", method: "GET", target: PROBE_PATH,
  bodyHash: digest(""), issuedAt: 1000, expiresAt: 2000, nonce: "nonce_test",
};
const input = { method: "GET", target: PROBE_PATH, bodyHash: digest(""), headers: new Headers(), grant, now: 1000 };
const verifier = () => new ProbeVerifier(keys.publicKey, identity);

test("signed probe is bound to exact target and consumed once", () => {
  const v = verifier();
  const request = { ...input, assertion: signProbe(claims, keys.privateKey) };
  assert.deepEqual(v.verify(request), claims);
  assert.throws(() => v.verify(request), /Replayed/);
});

test("reject anonymous, malformed, oversized, and foreign-signer assertions", () => {
  for (const assertion of ["", "a.b.c", "..", "x".repeat(MAX_ASSERTION_BYTES + 1), signProbe(claims, generateKeyPairSync("ed25519").privateKey)]) {
    assert.throws(() => verifier().verify({ ...input, assertion }));
  }
});

test("reject authority-header injection regardless of casing", () => {
  for (const name of ["X-BB-Gate-Auth", "x-bb-gate-machine-id", "x-bb-gate-assertion", "X-Forwarded-Host", "Forwarded", "Cookie", "Origin", "Sec-Fetch-Site", "x-bb-plugin-token"]) {
    assert.throws(() => verifier().verify({ ...input, assertion: signProbe(claims, keys.privateKey), headers: new Headers({ [name]: "synthetic" }) }));
  }
});

test("reject wrong scope, identity, generation, target, body binding, and lifetime", () => {
  const overrides = [
    { scope: "owner" }, { scope: "machine:runtime" }, { hostId: "another_host" },
    { grantId: "another_grant" }, { installationId: "another_installation" },
    { relayId: "another_relay" }, { generation: 2 }, { generation: 0 },
    { version: 1 }, { target: "/api/v1/hosts" }, { target: "/internal/hosts/enroll-key" },
    { method: "POST" }, { bodyHash: digest("unexpected") },
    { issuedAt: 1001 }, { expiresAt: 1000 }, { expiresAt: 1000 + ASSERTION_TTL_MS + 1 },
    { issuedAt: 2000, expiresAt: 1500 }, { nonce: "" }, { extra: "unexpected" },
  ];
  for (const override of overrides) {
    const assertion = signProbe({ ...claims, ...override } as ProbeClaims, keys.privateKey);
    assert.throws(() => verifier().verify({ ...input, assertion }), JSON.stringify(override));
  }
  assert.throws(() => verifier().verify({ ...input, bodyHash: digest("unexpected"), assertion: signProbe(claims, keys.privateKey) }));
  for (const target of ["//v0/probe", "/v0/%70robe", "/v0/../v0/probe", "/v0/probe?x=1", "/v0/probe/", "/internal/ws"]) {
    assert.throws(() => verifier().verify({ ...input, target, assertion: signProbe(claims, keys.privateKey) }));
  }
});

test("replay cache fails closed at its bound and reclaims expired entries", () => {
  const v = verifier();
  for (let i = 0; i < MAX_REPLAY_ENTRIES; i++) {
    v.verify({ ...input, assertion: signProbe({ ...claims, nonce: `nonce_${i}` }, keys.privateKey) });
  }
  assert.throws(() => v.verify({ ...input, assertion: signProbe(claims, keys.privateKey) }), /budget/);
  const later = { ...claims, issuedAt: 2000, expiresAt: 3000 };
  assert.deepEqual(v.verify({ ...input, now: 2000, assertion: signProbe(later, keys.privateKey) }), later);
});

test("local revocation and expired grants deny otherwise valid assertions", () => {
  for (const change of [{ phase: "pending" }, { phase: "revoking" }, { phase: "revoked" }, { expiresAt: 1000 }]) {
    assert.throws(() => verifier().verify({ ...input, grant: { ...grant, ...change } as GrantRecord, assertion: signProbe(claims, keys.privateKey) }));
  }
});
