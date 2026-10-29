import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);

test("trusted local TLS, SSH stages, denial names and version reasons are distinct and secret-free", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-tls-diagnostics-"));
  try {
    for (const [key, cert] of [["key.pem", "cert.pem"], ["other-key.pem", "other-cert.pem"]]) {
      await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, key), "-out", join(root, cert), "-days", "1", "-subj", "/CN=synthetic-local-only", "-addext", "subjectAltName=IP:127.0.0.1"], { timeout: 10_000, maxBuffer: 64 * 1024 });
    }
    const result = await exec(process.execPath, [fileURLToPath(new URL("./integration/diagnostics-fixture.ts", import.meta.url)), root], {
      cwd: root, timeout: 20_000, maxBuffer: 32 * 1024,
      env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: root, NODE_EXTRA_CA_CERTS: join(root, "cert.pem") },
    });
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, true); assert.equal(value.localTls200, true); assert.equal(value.wrongHostDenied, true);
    assert.equal(value.failures.pin.firstFailure.reason, "host-pin-mismatch");
    assert.equal(value.failures.key.firstFailure.reason, "ssh-auth-rejected");
    assert.equal(value.failures.tls.firstFailure.reason, "tls-certificate");
    assert.equal(result.stderr, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});
