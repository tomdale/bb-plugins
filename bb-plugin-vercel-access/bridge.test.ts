import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { connect } from "node:net";
import { once } from "node:events";
import { AdmissionLeases } from "./grants.ts";
import { openBridge, checkCore } from "./bridge.ts";
import { ACCESS_HEADER, DAEMON_PROTOCOL, MAX_BODY, TESTED_CORE, route } from "./policy.ts";
import { http } from "./integration/isolated.ts";

async function fixture(t: test.TestContext) {
  const seen: { method: string; target: string; headers: import("node:http").IncomingHttpHeaders }[] = [];
  const core = createServer((req, res) => {
    seen.push({ method: req.method!, target: req.url!, headers: req.headers });
    if (req.url === "/install/version") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(TESTED_CORE)); }
    else if (req.url === "/install/bb-app.tgz") { res.statusCode = req.headers["if-none-match"] ? 304 : 200; res.setHeader("etag", `"sha256-${"a".repeat(64)}"`); res.end(req.headers["if-none-match"] ? undefined : "synthetic artifact"); }
    else { req.resume(); res.end("synthetic native response"); }
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  t.after(() => new Promise<void>(resolve => core.close(() => resolve())));
  const baseUrl = `http://127.0.0.1:${(core.address() as { port: number }).port}`;
  const leases = new AdmissionLeases();
  const bridge = await openBridge({ baseUrl, leases });
  t.after(() => bridge.close());
  seen.length = 0;
  const grant = leases.acquire("synthetic-key", "synthetic-host", new AbortController().signal);
  return { seen, baseUrl, leases, bridge, grant, headers: { [ACCESS_HEADER]: grant.token } };
}

const forbidden = [
  ["POST", "/internal/hosts/enroll-key"], ["GET", "/api/v1/system/config"], ["PUT", "/api/v1/settings/general"],
  ["POST", "/api/v1/hosts"], ["DELETE", "/api/v1/hosts/synthetic"], ["POST", "/api/v1/hosts/synthetic/reconnect-commands"],
  ["POST", "/api/v1/projects"], ["POST", "/api/v1/threads"], ["POST", "/api/v1/plugins/vercel-access/rpc/test"],
  ["GET", "/ws"], ["GET", "/terminal/ws"], ["GET", "/internal/server-move/pending"], ["POST", "/internal/server-move/import"],
  ["GET", "/"], ["OPTIONS", "/internal/session/open"], ["HEAD", "/install.sh"], ["POST", "/install.sh"],
  ["GET", "/internal/session/open"], ["GET", "/internal/ws?sessionId=abc"], ["GET", "/internal/session/open/../hosts/enroll-key"],
  ["GET", "/internal/%77s?sessionId=abc"], ["POST", "/internal//hosts/enroll"], ["GET", "http://127.0.0.1/install.sh"],
  ["GET", "//install.sh"], ["GET", "/install.sh?url=http://127.0.0.1"], ["GET", "/install.sh#ignored"],
  ["GET", "/install.sh\\../api/v1/system/config"], ["POST", "/internal/hosts/enroll;ignored"],
];

for (const [method, target] of forbidden) test(`denied with zero native dispatch: ${method} ${target}`, async t => {
  const { bridge, seen, headers } = await fixture(t);
  const result = await http(bridge.url, target, { method, headers });
  assert.equal(result.status, 403);
  assert.equal(seen.length, 0);
});

const forbiddenHeaders: Record<string, string>[] = [
  { origin: "https://synthetic.example" }, { cookie: "owner=synthetic" }, { "x-bb-enrollment": "synthetic" },
  { "x-bb-gate-auth-kind": "owner" }, { "x-bb-gate-machine-id": "synthetic" },
  { "x-forwarded-for": "127.0.0.1" }, { forwarded: "for=127.0.0.1" },
  { "x-forwarded-host": "localhost" }, { "x-real-ip": "127.0.0.1" },
  { "sec-fetch-site": "same-origin" }, { "sec-fetch-mode": "navigate" }, { "accept-language": "en-US" },
  { host: "owner.example" }, { connection: "x-bb-gate-auth-kind" }, { "x-http-method-override": "POST" },
  { "if-none-match": '"wrong"' }, { "transfer-encoding": "chunked" },
];
for (const headers of forbiddenHeaders) test(`forbidden request header: ${Object.keys(headers)[0]}`, async t => {
  const fixtureState = await fixture(t);
  const response = await http(fixtureState.bridge.url, "/install/version", { headers: { ...fixtureState.headers, ...headers } });
  assert.equal(response.status, 403);
  assert.equal(fixtureState.seen.length, 0);
});

test("anonymous/direct-origin traffic has no native dispatch; native credentials remain opaque", async t => {
  const { bridge, headers, seen, grant } = await fixture(t);
  assert.equal((await http(bridge.url, "/install/version")).status, 403);
  assert.equal((await http(bridge.url, "/install/version", { headers: { [ACCESS_HEADER]: "a".repeat(43) } })).status, 403);
  assert.equal(seen.length, 0);
  const result = await fetch(`${bridge.url}/install/version`, { headers: { ...headers, authorization: "Bearer synthetic-native-key" } });
  assert.equal(result.status, 200);
  await result.arrayBuffer();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, "Bearer synthetic-native-key");
  assert.equal(seen[0].headers[ACCESS_HEADER], undefined);
  assert.equal(seen[0].headers["sec-fetch-mode"], undefined);
  assert.equal(seen[0].headers["accept-language"], undefined);
  assert.equal(seen[0].headers["accept-encoding"], "identity");
  assert.ok(!JSON.stringify(result.headers).includes(grant.token));
});

test("native conditional artifact request preserves 304 without following redirects", async t => {
  const { bridge, headers } = await fixture(t);
  const first = await http(bridge.url, "/install/bb-app.tgz", { headers });
  assert.equal(first.status, 200);
  const cached = await http(bridge.url, "/install/bb-app.tgz", { headers: { ...headers, "if-none-match": first.headers.etag! } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal(cached.headers.etag, first.headers.etag);
  assert.equal(cached.headers["cache-control"], "no-store");
});

async function raw(base: string, bytes: string) {
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(base).port) });
  let reply = "";
  socket.on("data", data => { reply += data.toString(); });
  socket.on("error", () => {});
  const done = once(socket, "close");
  await once(socket, "connect"); socket.end(bytes); await done;
  return reply;
}

for (const mutation of ["duplicate-access", "duplicate-host", "cl-te", "duplicate-length", "truncated", "absolute", "http10", "connect", "expect"]) {
  test(`parser/framing rejection has no native side effect: ${mutation}`, async t => {
    const { bridge, seen, grant } = await fixture(t);
    const authority = new URL(bridge.url).host;
    let target = "/internal/session/open";
    let method = "POST";
    let version = "HTTP/1.1";
    let extra = "";
    if (mutation === "duplicate-access") extra = `${ACCESS_HEADER}: ${grant.token}\r\n`;
    if (mutation === "duplicate-host") extra = `Host: ${authority}\r\n`;
    if (mutation === "cl-te") extra = "Transfer-Encoding: chunked\r\n";
    if (mutation === "duplicate-length") extra = "Content-Length: 2\r\n";
    if (mutation === "absolute") target = "http://localhost/internal/session/open";
    if (mutation === "http10") version = "HTTP/1.0";
    if (mutation === "connect") { method = "CONNECT"; target = "127.0.0.1:80"; }
    if (mutation === "expect") extra = "Expect: 100-continue\r\n";
    await raw(bridge.url, `${method} ${target} ${version}\r\nHost: ${authority}\r\n${ACCESS_HEADER}: ${grant.token}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n${extra}\r\n${mutation === "truncated" ? "{" : "{}"}`);
    assert.equal(seen.length, 0);
  });
}

test("plugin artifact IDs include reserved hyphens but reject path aliases and wrong methods", () => {
  const digest = "a".repeat(64);
  for (const id of ["single-hyphen", "bb--storage-retention", "bb--mcp", "plugin123"]) {
    const target = `/internal/plugins/${id}/host/${digest}`;
    assert.equal(route("GET", target), "http");
    for (const method of ["POST", "HEAD", "OPTIONS"]) assert.equal(route(method, target), null);
  }
  for (const id of ["", "-plugin", "plugin-", "plugin/owner", "plugin%2fowner", "plugin%5cowner", "../owner", "%62b--storage-retention", "Plugin"]) {
    assert.equal(route("GET", `/internal/plugins/${id}/host/${digest}`), null);
  }
  assert.equal(route("GET", `/internal/plugins/bb--storage-retention/host/${digest.toUpperCase()}`), null);
});

test("untested releases and non-loopback upstreams fail closed", async t => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ ...TESTED_CORE, protocolVersion: 999 })));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await assert.rejects(checkCore(`http://127.0.0.1:${(server.address() as { port: number }).port}`), /conformance/);
  for (const base of ["http://localhost:1234", "http://192.0.2.1:1234", "http://user:pass@127.0.0.1:1234", "http://127.0.0.1:1234/path"]) await assert.rejects(checkCore(base));
});

test("grants are idempotent only in-process and fail closed on cancellation, expiry, null release and restart", () => {
  let now = 1000;
  const leases = new AdmissionLeases(() => now);
  const controller = new AbortController();
  const a = leases.acquire("a", "host-a", controller.signal);
  assert.deepEqual(leases.acquire("a", "host-a", controller.signal), a);
  controller.abort(); assert.throws(() => leases.acquire("aborted", "host-a", controller.signal));
  leases.release("a", "host-a", null); assert.equal(leases.accepts(a.token), false);
  const b = leases.acquire("a", "host-a", new AbortController().signal);
  assert.notEqual(b.id, a.id);
  leases.release("a", "host-a", a.id); assert.equal(leases.accepts(b.token), true);
  assert.equal(new AdmissionLeases().accepts(b.token), false);
  now += 24 * 60 * 60 * 1000;
  assert.equal(leases.accepts(b.token), false);
  assert.equal(route("GET", "/internal/skills/tree/" + "a".repeat(64)), "http");
});

async function wsFixture(t: test.TestContext) {
  let nativeMessages = 0;
  const nativeSockets: WebSocket[] = [];
  const core = createServer((_req, res) => res.end(JSON.stringify(TESTED_CORE)));
  const websocket = new WebSocketServer({ server: core, perMessageDeflate: false });
  websocket.on("connection", peer => {
    nativeSockets.push(peer);
    peer.on("error", () => {});
    peer.on("message", bytes => { nativeMessages++; if (bytes.toString() === "native-close") peer.close(4001, "native closed"); });
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  t.after(async () => { for (const socket of websocket.clients) socket.terminate(); websocket.close(); await new Promise<void>(resolve => core.close(() => resolve())); });
  let now = 1000;
  const leases = new AdmissionLeases(() => now);
  const bridge = await openBridge({ baseUrl: `http://127.0.0.1:${(core.address() as { port: number }).port}`, leases });
  t.after(() => bridge.close());
  const grant = leases.acquire("ws", "synthetic", new AbortController().signal);
  const open = async () => {
    const peer = new WebSocket(`${bridge.url.replace("http:", "ws:")}/internal/ws?sessionId=synthetic`, [DAEMON_PROTOCOL], { headers: { [ACCESS_HEADER]: grant.token } });
    peer.on("error", () => {});
    t.after(() => peer.terminate());
    await once(peer, "open");
    return peer;
  };
  return { open, nativeSockets, messages: () => nativeMessages, expire: () => { now += 24 * 60 * 60 * 1000; leases.expire(); } };
}

test("legal native and client WS close metadata survives both directions", async t => {
  const fixture = await wsFixture(t);
  const a = await fixture.open();
  const fromNative = once(a, "close");
  a.send("native-close");
  const [code, reason] = await fromNative;
  assert.equal(code, 4001); assert.equal(reason.toString(), "native closed");
  const b = await fixture.open();
  const received = once(fixture.nativeSockets.at(-1)!, "close");
  const clientClosed = once(b, "close");
  const closeReason = "é".repeat(50);
  b.close(4000, closeReason);
  const [upstreamCode, upstreamReason] = await received;
  await clientClosed;
  assert.equal(upstreamCode, 4000); assert.equal(upstreamReason.toString(), closeReason);
});

test("oversized WS messages and admission expiry close active streams", async t => {
  const fixture = await wsFixture(t);
  const oversized = await fixture.open();
  const closed = once(oversized, "close");
  oversized.send(Buffer.alloc(MAX_BODY + 1));
  await closed;
  assert.equal(fixture.messages(), 0);
  const expiring = await fixture.open();
  const expired = once(expiring, "close");
  fixture.expire();
  await expired;
});

test("HTTP cancellation closes the native response producer", async t => {
  let stopped!: () => void;
  const nativeStopped = new Promise<void>(resolve => { stopped = resolve; });
  const core = createServer((req, res) => {
    if (req.url === "/install/version") { res.end(JSON.stringify(TESTED_CORE)); return; }
    res.write("first bytes");
    res.once("close", stopped);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  t.after(() => new Promise<void>(resolve => core.close(() => resolve())));
  const leases = new AdmissionLeases();
  const bridge = await openBridge({ baseUrl: `http://127.0.0.1:${(core.address() as { port: number }).port}`, leases }); t.after(() => bridge.close());
  const grant = leases.acquire("cancel", "synthetic", new AbortController().signal);
  await new Promise<void>((resolve, reject) => {
    const client = request(`${bridge.url}/install/bb-app.tgz`, { headers: { [ACCESS_HEADER]: grant.token } }, response => {
      response.once("data", () => { response.destroy(); client.destroy(); resolve(); });
    });
    client.on("error", reject); client.end();
  });
  await nativeStopped;
});

test("native async tool responses may wait beyond a short socket-idle deadline", { timeout: 15_000 }, async t => {
  const core = createServer((req, res) => {
    if (req.url === "/install/version") { res.end(JSON.stringify(TESTED_CORE)); return; }
    req.resume();
    const timer = setTimeout(() => res.end("native async result"), 6500);
    res.once("close", () => clearTimeout(timer));
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  t.after(() => new Promise<void>(resolve => core.close(() => resolve())));
  const leases = new AdmissionLeases();
  const bridge = await openBridge({ baseUrl: `http://127.0.0.1:${(core.address() as { port: number }).port}`, leases }); t.after(() => bridge.close());
  const grant = leases.acquire("async", "synthetic", new AbortController().signal);
  const result = await http(bridge.url, "/internal/session/tool-call", { method: "POST", headers: { [ACCESS_HEADER]: grant.token, "content-type": "application/json", "content-length": "2" }, body: "{}" });
  assert.equal(result.status, 200); assert.equal(result.body.toString(), "native async result");
});
