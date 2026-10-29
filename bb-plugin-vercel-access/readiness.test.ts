import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DiagnosticStore } from "./diagnostics.ts";
import { probeVersion } from "./readiness.ts";

test("probe timeout retains known status, attempt bound and no response/credential material", async () => {
  const secret = "synthetic-private-body-and-token";
  const server = createServer((_request, response) => {
    response.writeHead(200); response.flushHeaders();
    const timer = setTimeout(() => response.end(secret), 2000);
    response.once("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const diagnostics = new DiagnosticStore(); diagnostics.begin();
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal(await probeVersion({ origin, token: secret, signal: new AbortController().signal, attempt: 999, diagnostics: diagnostics.record }), false);
    const status = diagnostics.snapshot().stages.find(item => item.stage === "version-probe")!;
    assert.equal(status.reason, "timeout"); assert.equal(status.httpStatus, 200); assert.equal(status.attempts, 20);
    assert.ok(!JSON.stringify(diagnostics.snapshot()).includes(secret)); assert.ok(!JSON.stringify(diagnostics.snapshot()).includes(origin));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
