import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, connect } from "node:net";
import type { Duplex } from "node:stream";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import ssh2 from "ssh2";
import { openBridge, openRelayAdapter } from "../bridge.ts";
import { AdmissionLeases } from "../grants.ts";
import { TESTED_CORE } from "../policy.ts";
import { openTunnelRelay, startConnector, hostFingerprint } from "../tunnel.ts";
import { DiagnosticStore } from "../diagnostics.ts";
import { probeVersion } from "../readiness.ts";

async function listen(server: ReturnType<typeof createTcpServer>) {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); return (server.address() as { port: number }).port;
}
async function freePort() { const server = createTcpServer(); const port = await listen(server); await new Promise<void>(resolve => server.close(() => resolve())); return port; }
const root = process.argv[2];
const secret = "synthetic-secret-that-must-not-appear";
const sockets = new Set<Duplex>();
let header: string | null = null;
let wrongHost = false;
let backendMode = "normal";
let relayPort = 0;
const backend = createServer((_req, response) => {
  if (backendMode === "status") { response.writeHead(503); response.end(secret); }
  else if (backendMode === "protocol") response.end(JSON.stringify({ ...TESTED_CORE, protocolVersion: 1, secret }));
  else if (backendMode === "version") response.end(JSON.stringify({ ...TESTED_CORE, version: secret }));
  else if (backendMode === "json") response.end(secret);
  else if (backendMode === "large") response.end(secret.repeat(200));
  else response.end(JSON.stringify(TESTED_CORE));
});
const front = createHttpsServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, (req, response) => {
  const headers = { ...req.headers, ...(header ? { [header]: secret } : {}) };
  const upstream = request({ hostname: "127.0.0.1", port: relayPort, method: req.method, path: req.url, headers, agent: false }, native => { response.writeHead(native.statusCode!, native.headers); native.pipe(response); });
  upstream.on("error", () => { response.writeHead(502); response.end(); }); req.pipe(upstream);
});
front.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
front.on("upgrade", (req, socket, head) => {
  const remote = connect({ host: "127.0.0.1", port: relayPort }); sockets.add(remote); remote.once("close", () => sockets.delete(remote));
  remote.on("error", () => socket.destroy()); socket.on("error", () => remote.destroy());
  remote.once("connect", () => {
    const lines = req.rawHeaders.map((part, index, all) => index % 2 && wrongHost && all[index - 1].toLowerCase() === "host" ? "wrong-host.invalid" : part);
    remote.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.reduce((text, part, index) => text + part + (index % 2 ? "\r\n" : ": "), "")}\r\n`);
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
  });
});
const untrusted = createHttpsServer({ key: await readFile(join(root, "other-key.pem")), cert: await readFile(join(root, "other-cert.pem")) });
let bridge: Awaited<ReturnType<typeof openBridge>> | undefined;
let relay: Awaited<ReturnType<typeof openTunnelRelay>> | undefined;
let adapter: Awaited<ReturnType<typeof openRelayAdapter>> | undefined;
let connector: Awaited<ReturnType<typeof startConnector>> | undefined;
try {
  const backendPort = await listen(backend), publicPort = await listen(front), untrustedPort = await listen(untrusted);
  const leases = new AdmissionLeases(); bridge = await openBridge({ baseUrl: `http://127.0.0.1:${backendPort}`, leases });
  const bridgePort = Number(new URL(bridge.url).port), reversePort = await freePort();
  const host = ssh2.utils.generateKeyPairSync("rsa", { bits: 2048 }), client = ssh2.utils.generateKeyPairSync("ed25519");
  relay = await openTunnelRelay({ hostKey: host.private, authorizedKey: client.public, reversePort });
  adapter = await openRelayAdapter({ reversePort, bridgePort, publicAuthority: `127.0.0.1:${publicPort}`, connector: relay }); relayPort = Number(new URL(adapter.url).port);
  const origin = `https://127.0.0.1:${publicPort}`;
  const store = new DiagnosticStore(); store.begin();
  const options = { relayUrl: origin.replace("https:", "wss:"), privateKey: client.private, hostFingerprint: hostFingerprint(host.private), bridgePort, reversePort };
  connector = await startConnector({ ...options, diagnostics: store.record });
  for (const stage of ["tls", "wss", "ssh-host", "ssh-auth", "reverse"]) assert.equal(store.snapshot().stages.find(item => item.stage === stage)!.state, "verified");
  const grant = leases.acquire("synthetic-diagnostics", "host_synthetic", new AbortController().signal);
  const probe = (attempt = 1) => probeVersion({ origin, token: grant.token, signal: new AbortController().signal, attempt, diagnostics: store.record });
  assert.equal(await probe(), true);
  header = "x-vercel-id"; assert.equal(await probe(), true);
  header = "x-synthetic-unknown"; assert.equal(await probe(2), false);
  assert.equal(store.snapshot().stages.find(item => item.stage === "version-probe")!.reason, "http-denied");
  assert.equal(adapter.diagnostics().last!.reason, "unlisted-header"); assert.deepEqual(adapter.diagnostics().last!.headerNames, ["x-synthetic-unknown"]);
  assert.equal(connector.running(), true);
  header = null;
  for (const [mode, reason] of [["status", "http-status"], ["protocol", "protocol-mismatch"], ["version", "version-mismatch"], ["json", "invalid-json"], ["large", "body-limit"]]) {
    backendMode = mode; assert.equal(await probe(3), false); assert.equal(store.snapshot().stages.find(item => item.stage === "version-probe")!.reason, reason);
  }
  backendMode = "normal"; assert.equal(await probe(), true);
  await connector.close(); connector = undefined;
  assert.equal(store.snapshot().stages.find(item => item.stage === "reverse")!.reason, "disposed");
  const failures: Record<string, unknown> = {};
  for (const [name, overrides] of [["pin", { hostFingerprint: "0".repeat(64) }], ["key", { privateKey: ssh2.utils.generateKeyPairSync("ed25519").private }], ["tls", { relayUrl: `wss://127.0.0.1:${untrustedPort}` }]] as const) {
    const failure = new DiagnosticStore(); failure.begin();
    await assert.rejects(startConnector({ ...options, ...overrides, diagnostics: failure.record }));
    const expected = name === "pin" ? "host-pin-mismatch" : name === "key" ? "ssh-auth-rejected" : "tls-certificate";
    assert.equal(failure.snapshot().firstFailure!.reason, expected); failures[name] = failure.snapshot();
  }
  const reverseFailure = new DiagnosticStore(); reverseFailure.begin();
  await assert.rejects(startConnector({ ...options, reversePort: await freePort(), diagnostics: reverseFailure.record }));
  assert.equal(reverseFailure.snapshot().firstFailure!.reason, "reverse-rejected");
  wrongHost = true;
  const wrong = new DiagnosticStore(); wrong.begin();
  await assert.rejects(startConnector({ ...options, diagnostics: wrong.record }));
  assert.equal(adapter.diagnostics().last!.reason, "host-mismatch"); assert.equal(adapter.diagnostics().last!.hostMatches, false); assert.equal(adapter.diagnostics().last!.status, null);
  wrongHost = false;
  const loss = new DiagnosticStore(); loss.begin();
  connector = await startConnector({ ...options, diagnostics: loss.record });
  await relay.close();
  await Promise.race([connector.exited, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Local peer loss deadline")), 2000).unref())]);
  assert.equal(connector.running(), false); assert.equal(loss.snapshot().stages.find(item => item.stage === "reverse")!.reason, "peer-closed");
  const output = JSON.stringify({ ok: true, localTls200: true, wrongHostDenied: true, diagnostics: store.snapshot(), failures, admission: adapter.diagnostics(), peerLoss: loss.snapshot() });
  assert.ok(!output.includes(secret)); assert.ok(!output.includes(client.private)); assert.ok(!output.includes(options.relayUrl)); assert.ok(!output.includes(grant.token));
  console.log(output);
} finally {
  await connector?.close(); await adapter?.close(); await relay?.close(); await bridge?.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all([backend, front, untrusted].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
}
