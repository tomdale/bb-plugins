import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import WebSocket from "ws";
import { Authority, MemoryPersistence } from "./transport/authority.ts";
import { Relay, LocalFence, MemoryFenceStorage } from "./transport/relay.ts";
import { Connector } from "./transport/connector.ts";
import { Gateway } from "./transport/gateway.ts";
import { LIMITS, binding, fresh, seal, type Frame } from "./transport/protocol.ts";
import { connect } from "./transport/wire.ts";

async function setup(t: TestContext) {
  let now = 10_000;
  const clock = () => now;
  const identity = { installationId: "synthetic-installation", relayId: "fixture-relay", generation: 1 };
  const signing = { gateway: generateKeyPairSync("ed25519"), connector: generateKeyPairSync("ed25519"), relay: generateKeyPairSync("ed25519") };
  const keys = { gateway: signing.gateway.publicKey, connector: signing.connector.publicKey, relay: signing.relay.publicKey };
  const persistence = new MemoryPersistence(), gatewayAuthority = new Authority(persistence, clock);
  await gatewayAuthority.recover();
  const lease = await gatewayAuthority.acquire("fixture-acquisition", "fixture-host");
  const sibling = await gatewayAuthority.acquire("sibling-acquisition", "sibling-host");
  const copy = async () => {
    const p = new MemoryPersistence(); await p.save(await persistence.load());
    const authority = new Authority(p, clock); await authority.recover(); return authority;
  };
  const relayAuthority = await copy(), connectorAuthority = await copy();
  const fence = new LocalFence(new MemoryFenceStorage());
  const relay = new Relay(identity, signing.relay.privateKey, keys, relayAuthority, fence, false);
  await relay.listen();
  const connector = new Connector({ url: relay.url, identity, privateKey: signing.connector.privateKey, keys, now: clock, automaticTick: false }, connectorAuthority);
  await connector.open();
  const gateway = new Gateway({ url: relay.url, identity, privateKey: signing.gateway.privateKey, keys, now: clock, automaticTick: false }, gatewayAuthority);
  await gateway.listen();
  t.after(async () => { await gateway.close(); connector.close(); await relay.close(); });
  return { identity, signing, keys, lease, sibling, gateway, relay, connector, gatewayAuthority, relayAuthority, connectorAuthority, clock, fence,
    advance(ms: number) { now += ms; } };
}
function http(url: string, path: string, token?: string, body?: Buffer, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; data: Buffer }>((resolve, reject) => {
    const req = request(url, { path, method: body ? "POST" : "GET", headers: {
      ...(token ? { "x-fixture-access": token } : {}), ...(body ? { "content-length": String(body.length) } : {}), ...headers,
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (bytes) => chunks.push(bytes));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, data: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end(body);
  });
}
async function websocket(gateway: Gateway, token: string) {
  const ws = new WebSocket(gateway.url.replace("http:", "ws:") + "/v1/fixture/ws", "fixture.v1", {
    headers: { "x-fixture-access": token }, maxPayload: LIMITS.chunk, perMessageDeflate: false,
  });
  ws.on("error", () => {});
  await once(ws, "open");
  return ws;
}
test("real outbound connector, independent gateways, streamed binary HTTP and WebSocket", { timeout: 10_000 }, async (t) => {
  const s = await setup(t);
  assert.equal(s.relay.sockets.size, 2);
  assert.equal((await http(s.gateway.url, "/v0/probe", s.lease.token)).data.toString(), "synthetic probe\n");
  const body = Buffer.alloc(256 * 1024); for (let i = 0; i < body.length; i++) body[i] = i % 256;
  assert.deepEqual((await http(s.gateway.url, "/v1/fixture/echo", s.lease.token, body)).data, body);
  const data = await http(s.gateway.url, "/v1/fixture/bytes", s.lease.token);
  assert.equal(data.data.length, 512 * 1024); assert(data.data.every((byte) => byte === 0xa5));
  const gateway2 = new Gateway(s.gateway.options, s.gatewayAuthority); await gateway2.listen(); t.after(() => gateway2.close());
  const probes = await Promise.all(Array.from({ length: 8 }, (_, i) => http(i % 2 ? gateway2.url : s.gateway.url, "/v0/probe", s.lease.token)));
  assert(probes.every((p) => p.status === 200));
  const ws = await websocket(s.gateway, s.lease.token); t.after(() => ws.terminate());
  assert.equal(ws.protocol, "fixture.v1");
  let message = once(ws, "message"); ws.send(Buffer.from([0, 255, 128, 1]));
  let [bytes, binary] = await message; assert.deepEqual(bytes, Buffer.from([0, 255, 128, 1])); assert.equal(binary, true);
  message = once(ws, "message"); ws.send("synthetic text");
  [bytes, binary] = await message; assert.equal(bytes.toString(), "synthetic text"); assert.equal(binary, false);
  const closed = once(ws, "close"); ws.close(1000, "fixture done");
  const [code, reason] = await closed; assert.equal(code, 1000); assert.equal(reason.toString(), "fixture done");
  assert(s.relay.ledger.peakStreams <= LIMITS.streams);
  for (const wire of s.relay.sockets) assert(wire.peakQueue <= LIMITS.queue);
});

function openFrame(s: Awaited<ReturnType<typeof setup>>, epoch: string): Extract<Frame, { type: "open" }> {
  return { ...s.identity, type: "open", gatewayEpoch: epoch, connectorEpoch: s.connector.session!.connection.epoch, id: fresh(),
    grantId: s.lease.id, hostId: s.lease.hostId, acquisitionEpoch: s.lease.epoch, scope: "transport:probe", method: "GET",
    target: "/v0/probe", mode: "http", body: "signed-ordered-v1", length: 0, issuedAt: s.clock(), deadline: s.clock() + LIMITS.ttl };
}
async function rawGateway(s: Awaited<ReturnType<typeof setup>>, t: TestContext) {
  const connection = await connect({ ...s.gateway.options, role: "gateway" });
  connection.wire.handler = async () => {};
  t.after(() => connection.wire.close());
  return connection;
}
test("machine gateway rejects anonymous, forged authority, ambiguous targets and direct relay access", { timeout: 10_000 }, async (t) => {
  const s = await setup(t);
  for (const token of [undefined, "bad", "owner", s.signing.connector.publicKey.export({ type: "spki", format: "der" }).toString("base64url")]) {
    assert.equal((await http(s.gateway.url, "/v0/probe", token)).status, 403);
  }
  for (const name of ["x-bb-gate-host", "x-bb-plugin-token", "x-bb-owner", "x-forwarded-for", "forwarded", "origin", "cookie", "sec-fetch-site"]) {
    assert.equal((await http(s.gateway.url, "/v0/probe", s.lease.token, undefined, { [name]: "synthetic" })).status, 403, name);
  }
  for (const path of ["/internal/session/open", "/internal/hosts/enroll-key", "/ws", "/v0/probe?host=other", "/v0/%70robe", "/v0//probe", "/v0/../v0/probe", "/v1/fixture/ws"]) {
    assert.equal((await http(s.gateway.url, path, s.lease.token)).status, 403, path);
  }
  assert.equal((await http(s.gateway.url, "/v0/probe", s.lease.token, Buffer.from("body"))).status, 403);
  assert.equal((await http(s.gateway.url, "/v0/probe", s.lease.token, undefined, { host: "foreign.invalid" })).status, 403);
  assert.equal((await http(s.relay.url.replace("ws:", "http:").replace("/tunnel", ""), "/v0/probe", s.lease.token)).status, 403);
  const machine = new WebSocket(s.relay.url, { headers: { "x-fixture-access": s.lease.token } });
  const denied = new Promise<number>((resolve) => machine.once("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode!); machine.terminate(); }));
  machine.on("error", () => {}); assert.equal(await denied, 403);
  for (const options of [
    { privateKey: generateKeyPairSync("ed25519").privateKey },
    { privateKey: s.signing.connector.privateKey },
    { identity: { ...s.identity, generation: 2 } },
    { identity: { ...s.identity, installationId: "foreign" } },
  ]) await assert.rejects(connect({ ...s.gateway.options, role: "gateway", ...options }));
  for (const url of ["ws://localhost:1234/tunnel", "ws://192.168.1.1:1234/tunnel", "wss://external.invalid/tunnel", "ws://127.0.0.1:1234/arbitrary"]) {
    await assert.rejects(connect({ ...s.gateway.options, role: "gateway", url }));
  }
  assert.equal((await http(s.gateway.url, "/v0/probe", s.lease.token)).status, 200);
});

test("relay rejects signed wrong binding/role/target, replay, malformed frames and body semantics", { timeout: 15_000 }, async (t) => {
  const variants: ((f: Extract<Frame, { type: "open" }>) => object)[] = [
    (f) => ({ ...f, hostId: "other" }), (f) => ({ ...f, grantId: "other" }), (f) => ({ ...f, acquisitionEpoch: 99 }),
    (f) => ({ ...f, generation: 2 }), (f) => ({ ...f, installationId: "other" }), (f) => ({ ...f, relayId: "other" }),
    (f) => ({ ...f, gatewayEpoch: "old" }), (f) => ({ ...f, connectorEpoch: "old" }),
    (f) => ({ ...f, scope: "owner" }), (f) => ({ ...f, target: "http://127.0.0.1:1/" }),
    (f) => ({ ...f, target: "/internal/session/open", method: "POST" }), (f) => ({ ...f, length: 1 }),
    (f) => ({ ...f, body: "unsigned" }), (f) => ({ ...f, deadline: f.issuedAt - 1 }),
    (f) => ({ ...f, deadline: f.issuedAt + LIMITS.ttl + 1 }), (f) => ({ ...f, issuedAt: f.issuedAt + 1 }),
    (f) => ({ ...f, unexpected: true }), (f) => ({ ...f, version: 0 }),
  ];
  for (const variant of variants) {
    await t.test(String(variants.indexOf(variant)), async (t) => {
      const s = await setup(t), raw = await rawGateway(s, t), closed = once(raw.wire, "closed");
      await raw.wire.send(variant(openFrame(s, raw.epoch)) as Frame); await closed;
      assert.equal(s.relay.ledger.streams.size, 0);
    });
  }
  await t.test("duplicate stream ID", async (t) => {
    const s = await setup(t), raw = await rawGateway(s, t), open = openFrame(s, raw.epoch);
    const started = new Promise<void>((resolve) => { raw.wire.handler = async () => resolve(); });
    await raw.wire.send(open); await started;
    const closed = once(raw.wire, "closed"); await raw.wire.send(open); await closed;
  });
  for (const message of ["{", JSON.stringify({ text: "abc", signature: "abc" }), "x".repeat(LIMITS.frame + 1)]) {
    await t.test("malformed/oversized", async (t) => {
      const s = await setup(t), raw = await rawGateway(s, t), closed = once(raw.wire, "closed");
      // Bypass the sender budget to test ws maxPayload and the receiver parser.
      raw.wire.socket.send(message); await closed;
    });
  }
  for (const frame of [
    { type: "data", seq: 1, bytes: "AA==", binary: true },
    { type: "data", seq: 0, bytes: "!", binary: true },
    { type: "data", seq: 0, bytes: Buffer.alloc(LIMITS.chunk + 1).toString("base64"), binary: true },
    { type: "data", seq: 0, bytes: "AA==", binary: true }, // GET declares zero bytes
    { type: "end", count: 1, code: 1000, reason: "" },
    { type: "start", status: 200, protocol: "" }, // gateway cannot send a response
  ]) await t.test("invalid streaming state", async (t) => {
    const s = await setup(t), raw = await rawGateway(s, t), open = openFrame(s, raw.epoch);
    const started = new Promise<void>((resolve) => { raw.wire.handler = async () => resolve(); });
    await raw.wire.send(open); await started;
    const closed = once(raw.wire, "closed"); await raw.wire.send({ ...binding(open), ...frame } as Frame); await closed;
  });
});

test("connector independently rejects a grant accepted by gateway and relay", { timeout: 10_000 }, async (t) => {
  const s = await setup(t);
  // No shared authorization object: revoke only the laptop's local copy, with no remote update.
  await s.connectorAuthority.release(s.lease.key, s.lease.hostId, s.lease.epoch, null);
  const closed = once(s.connector.session!, "closed");
  const response = http(s.gateway.url, "/v0/probe", s.lease.token).catch(() => ({ status: 0 }));
  await closed; assert.notEqual((await response).status, 200);
  assert.equal(s.connector.fixture!.streams.size, 0);
});

function hold(gateway: Gateway, token: string) {
  return new Promise<{ req: ReturnType<typeof request>; res: import("node:http").IncomingMessage }>((resolve, reject) => {
    const req = request(gateway.url + "/v1/fixture/hold", { headers: { "x-fixture-access": token } }, (res) => {
      res.on("error", () => {}); resolve({ req, res });
    }); req.on("error", reject); req.end();
  });
}
test("active stream caps, HTTP cancellation and consumer-driven credits bound queues", { timeout: 10_000 }, async (t) => {
  const s = await setup(t);
  const holds = await Promise.all(Array.from({ length: LIMITS.streams }, () => hold(s.gateway, s.lease.token)));
  assert.equal(s.relay.ledger.streams.size, LIMITS.streams);
  assert.equal(s.connector.fixture!.streams.size, LIMITS.streams);
  assert.equal((await http(s.gateway.url, "/v0/probe", s.lease.token)).status, 403);
  const allCancelled = new Promise<void>((resolve) => {
    let cancelled = 0; s.connector.fixture!.on("cancelled", () => { if (++cancelled === holds.length) resolve(); });
  });
  for (const h of holds) h.res.destroy(); await allCancelled;
  assert.equal(s.connector.fixture!.streams.size, 0);
  assert.equal(s.relay.ledger.streams.size, 0);
  assert.equal(s.relay.ledger.peakStreams, LIMITS.streams);
  assert.equal((await http(s.gateway.url, "/v1/fixture/echo", s.lease.token, Buffer.alloc(LIMITS.body + 1))).status, 403);
  const raw = await rawGateway(s, t), open = { ...openFrame(s, raw.epoch), target: "/v1/fixture/bytes" };
  const received = new Promise<Extract<Frame, { type: "data" }>>((resolve) => {
    raw.wire.handler = async (f) => { if (f.type === "data") resolve(f); };
  });
  await raw.wire.send(open); await raw.wire.send({ ...binding(open), type: "end", count: 0, code: 1000, reason: "" });
  const data = await received;
  // An explicit application barrier: the receiver withholds credit. The fixture cannot advance.
  const state = s.connector.session!.ledger.streams.get(`${open.gatewayEpoch}/${open.id}`)!;
  assert.equal(state.responseSeq, 1); assert.equal(state.responsePending, 0); assert.equal(state.response, LIMITS.chunk);
  assert.equal(s.relay.ledger.streams.get(`${open.gatewayEpoch}/${open.id}`)!.responseSeq, 1);
  assert.equal(data.seq, 0); assert(Buffer.from(data.bytes, "base64").length <= LIMITS.chunk);
  for (const wire of s.relay.sockets) assert(wire.peakQueue <= LIMITS.queue);
});
test("local revoke and expiry terminate active HTTP and WS, not only new opens", { timeout: 10_000 }, async (t) => {
  for (const expiry of [false, true]) await t.test(expiry ? "expiry" : "local revoke with stale remote replicas", async (t) => {
    const s = await setup(t), h = await hold(s.gateway, s.lease.token);
    const opened = once(s.connector.fixture!, "opened"), ws = await websocket(s.gateway, s.lease.token);
    await opened; t.after(() => ws.terminate());
    const wsClosed = once(ws, "close"), httpClosed = new Promise<void>((resolve) => h.res.once("close", resolve));
    if (expiry) { s.advance(60_000); s.connector.session!.sweep(); }
    else await s.connectorAuthority.release(s.lease.key, s.lease.hostId, s.lease.epoch, null);
    await Promise.all([wsClosed, httpClosed]);
    assert.equal(s.connector.fixture!.streams.size, 0);
    assert.equal(s.connector.session!.ledger.streams.size, 0);
    assert.notEqual((await http(s.gateway.url, "/v0/probe", s.lease.token).catch(() => ({ status: 0 }))).status, 200);
  });
});
test("new connector epochs fence stale sockets and reconnect never replays an interrupted POST", { timeout: 10_000 }, async (t) => {
  const s = await setup(t);
  let req!: ReturnType<typeof request>;
  const started = once(s.connector.fixture!, "opened");
  const requestClosed = new Promise<void>((resolve) => {
    req = request(s.gateway.url + "/v1/fixture/mutate", { method: "POST", headers: { "x-fixture-access": s.lease.token, "content-length": "10" } });
    req.on("error", () => {}); req.on("close", resolve); req.write(Buffer.from("partial"));
  });
  await started;
  const oldFixture = s.connector.fixture!, oldEpoch = s.connector.session!.connection.epoch;
  const oldClosed = once(s.connector.session!, "closed");
  const replacement = new Connector(s.connector.options, s.connectorAuthority); t.after(() => replacement.close());
  await replacement.open(); await oldClosed; await requestClosed;
  assert.equal(oldFixture.mutations, 0); assert.notEqual(replacement.session!.connection.epoch, oldEpoch);
  await s.gateway.attach();
  assert.equal((await http(s.gateway.url, "/v0/probe", s.lease.token)).status, 200);
  assert.equal(replacement.fixture!.mutations, 0);
  assert.equal((await http(s.gateway.url, "/v1/fixture/mutate", s.lease.token, Buffer.from("new action"))).data.toString(), "1");
  const raw = await rawGateway(s, t), closed = once(raw.wire, "closed");
  await raw.wire.send({ ...openFrame(s, raw.epoch), connectorEpoch: oldEpoch }); await closed;
});
test("relay replacement durably advances fencing; stale origin and generation remain unusable", { timeout: 10_000 }, async (t) => {
  const s = await setup(t), identity = { ...s.identity, generation: 2 };
  const oldClosed = once(s.connector.session!, "closed");
  const relay = new Relay(identity, s.signing.relay.privateKey, s.keys, s.relayAuthority, s.fence, false);
  t.after(() => relay.close()); await relay.listen(); await oldClosed;
  await assert.rejects(connect({ ...s.gateway.options, role: "gateway" }));
  await assert.rejects(connect({ ...s.gateway.options, url: relay.url, role: "gateway" }));
  const connector = new Connector({ ...s.connector.options, identity, url: relay.url }, s.connectorAuthority);
  t.after(() => connector.close()); await connector.open();
  const gateway = new Gateway({ ...s.gateway.options, identity, url: relay.url }, s.gatewayAuthority);
  t.after(() => gateway.close()); await gateway.listen();
  assert.equal((await http(gateway.url, "/v0/probe", s.lease.token)).status, 200);
  assert.equal(s.fence.current!.generation, 2);
  await assert.rejects(s.fence.claim(1, fresh()));
});
test("explicit heartbeat timeout and jittered reconnect scheduler use fresh epochs", { timeout: 10_000 }, async (t) => {
  const s = await setup(t), old = s.connector.session!, closed = once(old, "closed");
  s.advance(LIMITS.timeout); old.connection.wire.tick(); await closed;
  const controller = new AbortController(), waits: number[] = [];
  const opened = new Promise<void>((resolve) => {
    const original = s.connector.open.bind(s.connector);
    s.connector.open = async (signal) => { const session = await original(signal); resolve(); return session; };
  });
  const run = s.connector.run(controller.signal, async (ms) => { waits.push(ms); controller.abort(); }, () => 0.5);
  await opened;
  assert.notEqual(s.connector.session!.connection.epoch, old.connection.epoch);
  s.connector.close(); await run;
  assert.deepEqual(waits, [1000]);
});

test("receive queue exhaustion fails closed while respecting the byte cap", { timeout: 10_000 }, async (t) => {
  const s = await setup(t), raw = await rawGateway(s, t), receiver = [...s.relay.sockets].at(-1)!;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  receiver.handler = async () => { entered(); await blocked; };
  await raw.wire.send(openFrame(s, raw.epoch)); await reached;
  const closed = once(raw.wire, "closed");
  const payload = seal({ ...binding(openFrame(s, raw.epoch)), type: "data", seq: 0,
    bytes: Buffer.alloc(LIMITS.chunk).toString("base64"), binary: true }, s.signing.gateway.privateKey);
  for (let i = 0; i < 50; i++) raw.wire.socket.send(payload);
  await closed;
  assert(receiver.peakQueue <= LIMITS.queue); assert(receiver.peakQueue > LIMITS.queue - 2 * Buffer.byteLength(payload));
  release(); await receiver.idle(); assert.equal(receiver.queued, 0);
});
test("bounded replay budget, fragment budget and declared body completion are enforced", { timeout: 10_000 }, async (t) => {
  await t.test("replay storage saturation (seeded capacity fixture)", async (t) => {
    const s = await setup(t), raw = await rawGateway(s, t);
    for (let i = 0; i < LIMITS.seen; i++) s.relay.ledger.seen.add(`seed-${i}`);
    const closed = once(raw.wire, "closed"); await raw.wire.send(openFrame(s, raw.epoch)); await closed;
    assert.equal(s.relay.ledger.seen.size, LIMITS.seen);
  });
  await t.test("fragment saturation", async (t) => {
    const s = await setup(t), raw = await rawGateway(s, t), closed = once(raw.wire, "closed");
    for (let i = 0; i < 65; i++) raw.wire.socket.send("x", { fin: false });
    raw.wire.socket.send("x", { fin: true }); await closed;
  });
  await t.test("truncated POST cannot commit", async (t) => {
    const s = await setup(t), raw = await rawGateway(s, t);
    const open = { ...openFrame(s, raw.epoch), method: "POST" as const, target: "/v1/fixture/mutate", length: 10 };
    const started = new Promise<void>((resolve) => { raw.wire.handler = async () => resolve(); });
    await raw.wire.send(open); await started;
    const closed = once(raw.wire, "closed"); await raw.wire.send({ ...binding(open), type: "end", count: 0, code: 1000, reason: "" }); await closed;
    assert.equal(s.connector.fixture!.mutations, 0);
  });
  await t.test("body substitution invalidates the Ed25519 signature", async (t) => {
    const s = await setup(t), raw = await rawGateway(s, t);
    const open = { ...openFrame(s, raw.epoch), method: "POST" as const, target: "/v1/fixture/mutate", length: 1 };
    const started = new Promise<void>((resolve) => { raw.wire.handler = async () => resolve(); });
    await raw.wire.send(open); await started;
    const envelope = JSON.parse(seal({ ...binding(open), type: "data", seq: 0, bytes: "AA==", binary: true }, s.signing.gateway.privateKey));
    const payload = JSON.parse(Buffer.from(envelope.text, "base64url").toString()); payload.bytes = "/w==";
    envelope.text = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const closed = once(raw.wire, "closed"); raw.wire.socket.send(JSON.stringify(envelope)); await closed;
    assert.equal(s.connector.fixture!.mutations, 0);
  });
});

test("ACK-withholding cancellation settles each producer without sacrificing siblings", { timeout: 10_000 }, async (t) => {
  const s = await setup(t), session = s.gateway.session!, fixture = s.connector.fixture!;
  const originalAck = session.ack.bind(session);
  let withhold = true;
  session.ack = async (frame) => { if (!withhold) await originalAck(frame); };
  for (let i = 0; i <= LIMITS.streams; i++) {
    withhold = true;
    const first = await new Promise<{ res: import("node:http").IncomingMessage; bytes: Buffer }>((resolve, reject) => {
      const req = request(s.gateway.url + "/v1/fixture/bytes", { headers: { "x-fixture-access": s.lease.token } }, (res) => {
        res.on("error", () => {}); res.once("data", (bytes: Buffer) => resolve({ res, bytes }));
      }); req.on("error", reject); req.end();
    });
    assert(first.bytes.length > 0 && first.bytes.length < 512 * 1024);
    assert.equal(fixture.producers, 1); assert.equal(s.connector.session!.pendingCredits, 1);
    const settled = once(fixture, "producer-settled"), cancelled = once(fixture, "cancelled");
    first.res.destroy(); await Promise.all([settled, cancelled]);
    assert.equal(fixture.producers, 0); assert.equal(s.connector.session!.pendingCredits, 0);
    assert.equal(fixture.streams.size, 0); assert.equal(s.relay.ledger.streams.size, 0);
    assert.equal(s.connector.session!.ledger.streams.size, 0); assert.equal(session.ledger.streams.size, 0);
    assert.equal(s.connector.session!.connection.wire.closed, false);
    withhold = false;
    assert.equal((await http(s.gateway.url, "/v0/probe", s.sibling.token)).status, 200);
  }
});
test("WS close is transported in both directions with exact code/reason and stream cleanup", { timeout: 10_000 }, async (t) => {
  const s = await setup(t), fixture = s.connector.fixture!;
  let opened = once(fixture, "opened");
  const client = await websocket(s.gateway, s.lease.token); await opened;
  const peerClose = once(fixture, "peer-close"); client.close(4001, "client synthetic close");
  const [end] = await peerClose as [Extract<Frame, { type: "end" }>];
  assert.equal(end.code, 4001); assert.equal(end.reason, "client synthetic close");
  assert.equal(fixture.streams.size, 0); assert.equal(s.connector.session!.ledger.streams.size, 0);
  assert.equal(s.relay.ledger.streams.size, 0); assert.equal(s.gateway.session!.ledger.streams.size, 0);
  opened = once(fixture, "opened");
  const serverClosed = await websocket(s.gateway, s.lease.token), [open] = await opened as [Extract<Frame, { type: "open" }>];
  const closed = once(serverClosed, "close");
  await s.connector.session!.end(open, 4002, "fixture synthetic close");
  const [code, reason] = await closed; assert.equal(code, 4002); assert.equal(reason.toString(), "fixture synthetic close");
  assert.equal(fixture.streams.size, 0); assert.equal(s.relay.ledger.streams.size, 0);
  assert.equal((await http(s.gateway.url, "/v0/probe", s.sibling.token)).status, 200);
});
test("disconnect after mutation commit but before response never replays on scheduled reconnect", { timeout: 10_000 }, async (t) => {
  const s = await setup(t), previous = s.connector.session!, fixture = s.connector.fixture!;
  const committed = once(fixture, "mutated");
  fixture.once("mutated", () => s.connector.close());
  const response = http(s.gateway.url, "/v1/fixture/mutate", s.lease.token, Buffer.from("exactly once attempt"));
  await committed; await assert.rejects(response);
  assert.equal(fixture.mutations, 1);
  const controller = new AbortController();
  let scheduled!: () => void;
  const reached = new Promise<void>((resolve) => { scheduled = resolve; });
  const originalOpen = s.connector.open.bind(s.connector);
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  s.connector.open = async (signal) => { const session = await originalOpen(signal); opened(); return session; };
  const running = s.connector.run(controller.signal, async (ms, signal) => {
    assert.equal(ms, 1000); scheduled();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }, () => 0);
  await ready;
  await s.gateway.attach();
  assert.equal((await http(s.gateway.url, "/v0/probe", s.lease.token)).status, 200);
  assert.notEqual(s.connector.session!.connection.epoch, previous.connection.epoch);
  assert.equal(s.connector.fixture!.mutations, 1);
  s.connector.close(); await reached; controller.abort(); await running;
});

test("laptop verifier rejects authority and bindings even if relay forwarding checks are bypassed", { timeout: 10_000 }, async (t) => {
  for (const variant of [
    { hostId: "foreign" }, { grantId: "foreign" }, { acquisitionEpoch: 2 }, { scope: "owner" },
    { generation: 2 }, { installationId: "foreign" }, { relayId: "foreign" },
    { connectorEpoch: "old" }, { target: "/internal/hosts/enroll-key", method: "POST" },
  ]) await t.test(JSON.stringify(variant), async (t) => {
    const s = await setup(t), relayConnector = [...s.relay.sockets][0]!;
    const frame = { ...openFrame(s, s.gateway.session!.connection.epoch), ...variant } as Frame;
    const closed = once(s.connector.session!, "closed");
    await relayConnector.sendRaw(seal(frame, s.signing.gateway.privateKey)); await closed;
    assert.equal(s.connector.fixture!.mutations, 0); assert.equal(s.connector.fixture!.streams.size, 0);
  });
  await t.test("relay cannot impersonate a gateway signer", async (t) => {
    const s = await setup(t), closed = once(s.connector.session!, "closed");
    await [...s.relay.sockets][0]!.sendRaw(seal(openFrame(s, s.gateway.session!.connection.epoch), s.signing.relay.privateKey)); await closed;
  });
  await t.test("replayed signed open at laptop", async (t) => {
    const s = await setup(t), raw = await rawGateway(s, t), open = openFrame(s, raw.epoch);
    const started = new Promise<void>((resolve) => { raw.wire.handler = async () => resolve(); });
    await raw.wire.send(open); await started;
    const closed = once(s.connector.session!, "closed");
    await [...s.relay.sockets][0]!.sendRaw(seal(open, s.signing.gateway.privateKey)); await closed;
  });
});

test("withheld consumer credit pauses after one chunk and resumes with exact bytes", { timeout: 10_000 }, async (t) => {
  const s = await setup(t), session = s.gateway.session!, originalAck = session.ack.bind(session);
  let paused = true, held!: (frame: Extract<Frame, { type: "data" }>) => void;
  const barrier = new Promise<Extract<Frame, { type: "data" }>>((resolve) => { held = resolve; });
  session.ack = async (frame) => { if (paused) held(frame); else await originalAck(frame); };
  let finished = false;
  const response = http(s.gateway.url, "/v1/fixture/bytes", s.lease.token).then((r) => { finished = true; return r; });
  const first = await barrier;
  assert.equal(finished, false); assert.equal(s.connector.fixture!.producers, 1);
  assert.equal(s.connector.session!.pendingCredits, 1);
  const producer = s.connector.session!.ledger.streams.get(`${first.gatewayEpoch}/${first.id}`)!;
  assert.equal(producer.responseSeq, 1); assert.equal(producer.response, LIMITS.chunk);
  paused = false; await originalAck(first);
  const result = await response; assert.equal(result.data.length, 512 * 1024); assert(result.data.every((byte) => byte === 0xa5));
  assert.equal(s.connector.session!.pendingCredits, 0); assert.equal(s.relay.ledger.streams.size, 0);
});
test("handshake expiry cannot be extended by pongs and malformed epoch types are rejected", { timeout: 10_000 }, async (t) => {
  const s = await setup(t);
  const socket = new WebSocket(s.relay.url, { headers: { "x-fixture-role": "gateway" } });
  socket.on("error", () => {});
  const challenge = await once(socket, "message");
  const envelope = JSON.parse(challenge[0].toString()), payload = JSON.parse(Buffer.from(envelope.text, "base64url").toString());
  const closed = once(socket, "close");
  socket.send(seal({ ...s.identity, type: "hello", role: "gateway", epoch: null, challenge: payload.challenge } as unknown as import("./transport/protocol.ts").Hello, s.signing.gateway.privateKey));
  await closed;
  const unready = new WebSocket(s.relay.url, { headers: { "x-fixture-role": "gateway" } });
  unready.on("error", () => {}); await once(unready, "message");
  const receiver = [...s.relay.sockets].at(-1)!, timedOut = once(unready, "close");
  s.advance(LIMITS.ttl);
  const pong = once(receiver.socket, "pong"); unready.pong(); await pong;
  receiver.tick(); await timedOut;
  assert.equal(receiver.closed, true);
});

test("legal application closes stay stream-local across independent gateways and distinct grants", { timeout: 10_000 }, async (t) => {
  const s = await setup(t), fixture = s.connector.fixture!;
  const gatewayB = new Gateway(s.gateway.options, s.gatewayAuthority);
  await gatewayB.listen(); t.after(() => gatewayB.close());
  let opened = once(fixture, "opened");
  const clientB = await websocket(gatewayB, s.sibling.token); await opened;
  t.after(() => clientB.terminate());
  const connectorWire = s.connector.session!.connection.wire;
  const gatewayAWire = s.gateway.session!.connection.wire, gatewayBWire = gatewayB.session!.connection.wire;
  for (const [code, reason] of [[4000, "fixture application close"], [1000, "r".repeat(81)]] as const) {
    opened = once(fixture, "opened");
    const clientA = await websocket(s.gateway, s.lease.token), [open] = await opened as [Extract<Frame, { type: "open" }>];
    const peerClosed = once(fixture, "peer-close"), clientClosed = once(clientA, "close");
    clientA.close(code, reason);
    const [end] = await peerClosed as [Extract<Frame, { type: "end" }>]; await clientClosed;
    assert.equal(end.code, code); assert.equal(end.reason, reason);
    assert.equal(end.id, open.id); assert.equal(fixture.streams.size, 1);
    assert.equal(s.gateway.session!.ledger.streams.size, 0); assert.equal(gatewayB.session!.ledger.streams.size, 1);
    assert.equal(s.relay.ledger.streams.size, 1); assert.equal(s.connector.session!.ledger.streams.size, 1);
    assert.equal(connectorWire.closed, false); assert.equal(gatewayAWire.closed, false); assert.equal(gatewayBWire.closed, false);
    assert.equal(s.relay.sockets.size, 3);
    const echo = once(clientB, "message"); clientB.send("sibling remains usable");
    assert.equal((await echo)[0].toString(), "sibling remains usable");
    assert.equal((await http(gatewayB.url, "/v0/probe", s.sibling.token)).status, 200);
  }
});
