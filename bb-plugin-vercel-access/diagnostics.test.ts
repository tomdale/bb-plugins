import test from "node:test";
import assert from "node:assert/strict";
import { AdmissionDiagnostics, DiagnosticStore, networkReason } from "./diagnostics.ts";
import { diagnosticSnapshotSchema } from "./diagnostic-contract.ts";

const secret = "synthetic-secret-not-for-diagnostics";
test("diagnostic snapshots are fixed-size enum records, not raw error/config captures", () => {
  const store = new DiagnosticStore(); store.begin();
  store.record("tls", "failed", "tls-certificate", { httpStatus: 9999, attempts: 9999, payload: secret } as never);
  store.record("ssh-auth", "failed", "ssh-auth-rejected");
  assert.equal(store.snapshot().firstFailure?.reason, "tls-certificate");
  for (let i = 0; i < 100; i++) store.record("version-probe", "failed", "http-denied", { httpStatus: 403, attempts: i });
  const snapshot = diagnosticSnapshotSchema.parse(store.snapshot());
  assert.equal(snapshot.stages.length, 8);
  assert.equal(snapshot.stages.find(item => item.stage === "version-probe")!.attempts, 20);
  assert.equal(snapshot.stages.find(item => item.stage === "tls")!.httpStatus, null);
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  store.begin(); store.record("wss", "pending");
  assert.notEqual(store.snapshot().firstFailure?.generation, store.snapshot().generation);
  store.record("readiness", "verified"); assert.equal(store.snapshot().firstFailure, null);
});

test("network reasons use known codes only, excluding messages, URLs and arbitrary codes", () => {
  assert.equal(networkReason({ code: "ERR_TLS_CERT_ALTNAME_INVALID", message: secret, hostname: secret }), "tls-certificate");
  assert.equal(networkReason({ code: "ERR_SSL_WRONG_VERSION_NUMBER" }), "tls-handshake");
  assert.equal(networkReason({ code: "ECONNREFUSED" }), "connection-refused");
  assert.equal(networkReason({ code: "ENOTFOUND" }), "dns-failure");
  assert.equal(networkReason({ code: secret, message: secret }), "network-error");
});

test("denial diagnostics cap header names, count and rate, and never copy values or request targets", () => {
  let now = 0, writes = 0;
  const store = new AdmissionDiagnostics(() => writes++, () => now);
  const event = { reason: "unlisted-header", headerNames: ["x-synthetic-unknown", "bad\n", "x".repeat(65), "x-second"], route: "version", method: "GET", status: 403, hostMatches: true, value: secret, target: `/${secret}?key=${secret}` } as const;
  store.record(event as never);
  assert.deepEqual(store.snapshot().last!.headerNames, ["x-second", "x-synthetic-unknown"]);
  for (let i = 0; i < 100; i++) store.record(event as never);
  assert.equal(store.snapshot().count, 8); assert.equal(writes, 8);
  for (let second = 1; second < 8; second++) { now = second * 1000; for (let i = 0; i < 100; i++) store.record(event as never); }
  assert.equal(store.snapshot().count, 32); assert.equal(writes, 32);
  assert.ok(store.snapshot().suppressed > 0);
  assert.ok(JSON.stringify(store.snapshot()).length < 4096);
  assert.ok(!JSON.stringify(store.snapshot()).includes(secret));
});
