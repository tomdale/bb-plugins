import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import ssh2, { type Connection } from "ssh2";
const { Server } = ssh2;
import { WebSocketServer, createWebSocketStream, WebSocket } from "ws";
import { createServer as createHttpServer } from "node:http";
import { openRelayAdapter } from "./bridge.ts";
import { startConnector, openTunnelRelay, hostFingerprint, CONNECTOR_PATH, validSignatureProof } from "./tunnel.ts";
import { freePort, http } from "./integration/isolated.ts";

import { syntheticKeys } from "./integration/keys.ts";

test("SSH signature proof accepts only true, rejecting false, Error and thrown errors", () => {
  assert.equal(validSignatureProof(() => true), true);
  assert.equal(validSignatureProof(() => false), false);
  assert.equal(validSignatureProof(() => new Error("synthetic verification error")), false);
  assert.equal(validSignatureProof(() => { throw new Error("synthetic thrown verification error"); }), false);
});

test("unauthenticated control framing, socket admission and pre-aborted connector fail closed", { timeout: 15_000 }, async t => {
  const host = syntheticKeys(); const client = syntheticKeys();
  const reversePort = await freePort();
  const relay = await openTunnelRelay({ hostKey: host.privateKey, authorizedKey: client.publicKey, reversePort }); t.after(() => relay.close());
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(startConnector({ relayUrl: relay.url, privateKey: client.privateKey, hostFingerprint: hostFingerprint(host.privateKey), bridgePort: await freePort(), reversePort, signal: aborted.signal }));
  const open = async () => {
    const socket = new WebSocket(`${relay.url}${CONNECTOR_PATH}`, { perMessageDeflate: false }); socket.on("error", () => {}); t.after(() => socket.terminate()); await once(socket, "open"); return socket;
  };
  const malformed = await open();
  const malformedClosed = new Promise<void>(resolve => malformed.once("close", () => resolve()));
  malformed.send("not an SSH identification or packet\n"); await malformedClosed;
  const oversized = await open();
  const oversizedClosed = new Promise<void>(resolve => oversized.once("close", () => resolve()));
  oversized.send(Buffer.alloc(64 * 1024 + 1)); await oversizedClosed;
  const held = await Promise.all(Array.from({ length: 4 }, () => open()));
  const fifth = new WebSocket(`${relay.url}${CONNECTOR_PATH}`); fifth.on("error", () => {}); let admitted = false; fifth.on("open", () => { admitted = true; fifth.terminate(); });
  await new Promise<void>(resolve => fifth.once("close", () => resolve()));
  assert.equal(admitted, false, "Unauthenticated control sockets are capped before SSH work");
  for (const socket of held) socket.terminate();
});

test("standard SSH-over-WS reverse stream with fixed Host adapter and untrusted platform metadata", { timeout: 30_000 }, async t => {
  const host = syntheticKeys(); const client = syntheticKeys();
  const reversePort = await freePort();
  const bridge = createHttpServer((req, res) => {
    assert.equal(req.headers.host, `127.0.0.1:${(bridge.address() as { port: number }).port}`);
    assert.equal(req.headers["x-forwarded-for"], undefined);
    assert.equal(req.headers["x-bb-gate-auth-kind"], undefined);
    assert.equal(req.headers.authorization, "Bearer synthetic-native-key");
    res.end("synthetic fixed bridge");
  });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  t.after(() => new Promise<void>(resolve => bridge.close(() => resolve())));
  const bridgePort = (bridge.address() as { port: number }).port;
  const relay = await openTunnelRelay({ hostKey: host.privateKey, authorizedKey: client.publicKey, reversePort });
  t.after(() => relay.close());
  const connector = await startConnector({ relayUrl: relay.url, privateKey: client.privateKey, hostFingerprint: hostFingerprint(host.privateKey), bridgePort, reversePort });
  t.after(() => connector.close());
  const adapter = await openRelayAdapter({ reversePort, bridgePort, publicAuthority: "synthetic-sandbox.example" });
  t.after(() => adapter.close());
  const headers = {
    host: "synthetic-sandbox.example", "x-vercel-access": "a".repeat(43), authorization: "Bearer synthetic-native-key",
    "x-forwarded-for": "192.0.2.8", "x-forwarded-host": "owner.invalid", "x-forwarded-proto": "http", "x-real-ip": "127.0.0.1", "x-vercel-id": "synthetic-platform-metadata", forwarded: "for=127.0.0.1",
  };
  t.diagnostic("Request through authenticated SSH reverse listener");
  const response = await http(adapter.url, "/install/version", { headers });
  t.diagnostic("Fixed bridge responded");
  assert.equal(response.status, 200); assert.equal(response.body.toString(), "synthetic fixed bridge");
  assert.equal((await http(adapter.url, "/api/v1/system/config", { headers })).status, 403);
  assert.equal((await http(adapter.url, "/install/version", { headers: { ...headers, host: "owner.invalid" } })).status, 403);
  assert.equal((await http(adapter.url, "/install/version", { headers: { ...headers, "x-bb-gate-auth-kind": "owner" } })).status, 403);
  await assert.rejects(startConnector({ relayUrl: relay.url, privateKey: client.privateKey, hostFingerprint: "0".repeat(64), bridgePort, reversePort }));
  const impostor = syntheticKeys();
  await assert.rejects(startConnector({ relayUrl: relay.url, privateKey: impostor.privateKey, hostFingerprint: hostFingerprint(host.privateKey), bridgePort, reversePort }));
  assert.equal((await http(relay.url.replace("ws:", "http:"), "/install/version", { headers: { "x-vercel-access": "a".repeat(43) } })).status, 403);
  const forged = new WebSocket(`${relay.url}${CONNECTOR_PATH}`, { headers: { "x-vercel-access": "a".repeat(43) } });
  forged.on("error", () => {});
  let opened = false; forged.on("open", () => { opened = true; forged.terminate(); });
  await new Promise<void>(resolve => forged.once("close", () => resolve()));
  assert.equal(opened, false, "Machine admission does not authenticate connector control");
  await connector.close();
  assert.equal(connector.running(), false);
  t.diagnostic("Request after connector close");
  assert.equal((await http(adapter.url, "/install/version", { headers })).status, 502);
});

test("compromised SSH relay cannot choose a laptop destination or open unregistered channels", { timeout: 30_000 }, async t => {
  const host = syntheticKeys(); const client = syntheticKeys();
  const reversePort = await freePort();
  let canaryConnections = 0;
  const canary = createServer(socket => { canaryConnections++; socket.destroy(); });
  canary.listen(0, "127.0.0.1"); await once(canary, "listening");
  t.after(() => new Promise<void>(resolve => canary.close(() => resolve())));
  const canaryPort = (canary.address() as { port: number }).port;
  let bridgeConnections = 0;
  let allDialed!: () => void;
  const acceptedAll = new Promise<void>(resolve => { allDialed = resolve; });
  let hold = false;
  const held = new Set<import("node:net").Socket>();
  const bridge = createServer(socket => {
    bridgeConnections++;
    if (bridgeConnections === 17) allDialed();
    if (hold) { held.add(socket); socket.on("error", () => {}); socket.once("close", () => held.delete(socket)); socket.resume(); }
    else socket.end("only fixed bridge");
  });
  t.after(() => { for (const socket of held) socket.destroy(); });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  t.after(() => new Promise<void>(resolve => bridge.close(() => resolve())));
  let malicious: Connection | undefined;
  const ssh = new Server({ hostKeys: [host.privateKey] }, connection => {
    malicious = connection;
    connection.on("error", () => {});
    connection.on("authentication", context => context.accept());
    connection.on("request", (accept, reject, name) => name === "tcpip-forward" ? accept?.() : reject?.());
  });
  const web = createHttpServer();
  const ws = new WebSocketServer({ server: web });
  ws.on("connection", socket => { socket.on("error", () => {}); const stream = createWebSocketStream(socket); stream.on("error", () => {}); ssh.injectSocket(stream as import("node:net").Socket); });
  web.listen(0, "127.0.0.1"); await once(web, "listening");
  t.after(async () => { malicious?.end(); for (const socket of ws.clients) socket.terminate(); ws.close(); await new Promise<void>(resolve => web.close(() => resolve())); });
  const connector = await startConnector({ relayUrl: `ws://127.0.0.1:${(web.address() as { port: number }).port}`, privateKey: client.privateKey, hostFingerprint: hostFingerprint(host.privateKey), bridgePort: (bridge.address() as { port: number }).port, reversePort });
  t.after(() => connector.close());
  const forward = (destination: string, destinationPort: number, source: string, sourcePort: number) => new Promise<{ accepted: boolean; bytes: string }>(resolve => {
    malicious!.forwardOut(destination, destinationPort, source, sourcePort, (error, channel) => {
      if (error) { resolve({ accepted: false, bytes: "" }); return; }
      let bytes = ""; channel.on("data", (chunk: Buffer) => { bytes += chunk; }); channel.on("error", () => {}); channel.on("close", () => resolve({ accepted: true, bytes })); channel.resume();
    });
  });
  assert.equal((await forward("127.0.0.1", canaryPort, "127.0.0.1", canaryPort)).accepted, false);
  assert.equal((await forward("192.0.2.1", reversePort, "127.0.0.1", canaryPort)).accepted, false);
  const validTuple = await forward("127.0.0.1", reversePort, "127.0.0.1", canaryPort);
  assert.equal(validTuple.bytes, "only fixed bridge");
  assert.equal(canaryConnections, 0);
  assert.equal(bridgeConnections, 1);
  hold = true;
  const channels = await Promise.all(Array.from({ length: 17 }, () => new Promise<import("ssh2").ServerChannel | undefined>(resolve => {
    malicious!.forwardOut("127.0.0.1", reversePort, "127.0.0.1", canaryPort, (error, channel) => {
      if (error) { resolve(undefined); return; }
      channel.on("error", () => {}); resolve(channel);
    });
  })));
  assert.equal(channels.filter(Boolean).length, 16, "Concurrent channel bound enforced before local dialing");
  t.diagnostic(`Accepted SSH channels: ${channels.filter(Boolean).length}; local accepts so far: ${bridgeConnections}`);
  await acceptedAll;
  t.diagnostic("All confined local dials accepted");
  assert.equal(bridgeConnections, 17, "Only one prior request and 16 admitted local sockets");
  const localClosures = [...held].map(socket => new Promise<void>(resolve => socket.once("close", () => resolve())));
  await connector.close();
  await Promise.all(localClosures);
  assert.equal(held.size, 0, "Disposal closes every locally confined channel socket");
  for (const channel of channels) channel?.destroy();
  assert.equal(canaryConnections, 0);
});
