import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { admitRequest, ACCESS_HEADER } from "./policy.ts";
import { http } from "./integration/isolated.ts";

test("relay discards Vercel platform metadata without forwarding it as authority", async t => {
  const server = createServer((req, res) => {
    try { res.end(JSON.stringify(admitRequest(req, req.headers.host!, false, true).headers)); }
    catch { res.writeHead(403).end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await http(url, "/install/version", { headers: {
    [ACCESS_HEADER]: "a".repeat(43), authorization: "Bearer synthetic-native-key",
    "x-vercel-forwarded-for": "synthetic-address", "x-vercel-full-id": "synthetic-id",
  } });
  assert.equal(response.status, 200);
  const forwarded = JSON.parse(response.body.toString());
  assert.equal(forwarded.authorization, "Bearer synthetic-native-key");
  assert.equal(forwarded["x-vercel-forwarded-for"], undefined);
  assert.equal(forwarded["x-vercel-full-id"], undefined);
  assert.equal(forwarded[ACCESS_HEADER], undefined);
  assert.equal((await http(url, "/install/version", { headers: {
    [ACCESS_HEADER]: "a".repeat(43), "x-bb-gate-auth": "owner",
  } })).status, 403);
});

test("local machine bridge still rejects platform metadata", async t => {
  const server = createServer((req, res) => {
    try { admitRequest(req, req.headers.host!, false); res.end(); }
    catch { res.writeHead(403).end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await http(url, "/install/version", { headers: {
    [ACCESS_HEADER]: "a".repeat(43), "x-vercel-full-id": "synthetic-id",
  } })).status, 403);
});
