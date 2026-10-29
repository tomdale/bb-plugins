import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { AdmissionLeases } from "../grants.ts";
import { openBridge, openRelayAdapter } from "../bridge.ts";
import { openTunnelRelay, startConnector, hostFingerprint } from "../tunnel.ts";
import { syntheticKeys } from "./keys.ts";
import { createHash } from "node:crypto";
import { ACCESS_HEADER, DAEMON_PROTOCOL, TESTED_CORE } from "../policy.ts";
import { http, isolatedCore, freePort } from "./isolated.ts";

const json = (value: unknown) => {
  const body = JSON.stringify(value);
  return { method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, body };
};

function openSocket(url: string, token: string, key: string) {
  const socket = new WebSocket(url.replace("http:", "ws:"), [DAEMON_PROTOCOL], {
    headers: { [ACCESS_HEADER]: token, authorization: `Bearer ${key}` },
  });
  socket.on("error", () => {});
  return socket;
}

async function rejectsSocket(socket: WebSocket) {
  let opened = false;
  socket.on("open", () => { opened = true; socket.terminate(); });
  socket.on("unexpected-response", (_req, response) => { response.destroy(); socket.terminate(); });
  await once(socket, "close").catch(() => {});
  assert.equal(opened, false, "No downstream 101 before native auth");
}

for (const transport of ["direct", "ssh-ws"] as const) test(`isolated released BB (${transport}): native enrollment, sessions, host auth, revocation and restart`, { timeout: 120_000 }, async t => {
  const core = await isolatedCore();
  t.after(() => core.close());
  const version = JSON.parse((await http(core.baseUrl, "/install/version")).body.toString());
  assert.deepEqual(version, TESTED_CORE);
  const setup = async (leases: AdmissionLeases) => {
    const localBridge = await openBridge({ baseUrl: core.baseUrl, leases });
    if (transport === "direct") return localBridge;
    const host = syntheticKeys(); const client = syntheticKeys();
    const reversePort = await freePort(); const publicPort = await freePort();
    const bridgePort = Number(new URL(localBridge.url).port);
    const relay = await openTunnelRelay({ hostKey: host.privateKey, authorizedKey: client.publicKey, reversePort });
    const adapter = await openRelayAdapter({ reversePort, bridgePort, publicAuthority: `127.0.0.1:${publicPort}`, port: publicPort, connector: relay });
    const connector = await startConnector({ relayUrl: adapter.url.replace("http:", "ws:"), privateKey: client.privateKey, hostFingerprint: hostFingerprint(host.privateKey), reversePort, bridgePort });
    return { url: adapter.url, async close() { await connector.close(); await adapter.close(); await relay.close(); await localBridge.close(); } };
  };
  const leases = new AdmissionLeases();
  let bridge = await setup(leases);
  t.after(() => bridge.close());
  const grant = leases.acquire("synthetic-launch-a", "host-a", new AbortController().signal);
  const access = { [ACCESS_HEADER]: grant.token };
  const bridged = (target: string, body: unknown, key?: string) => {
    const options = json(body);
    return http(bridge.url, target, { ...options, headers: { ...options.headers, ...access, ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  };
  const createEnrollment = async () => {
    const reply = await http(core.baseUrl, "/internal/hosts/enroll-key", json({}));
    assert.equal(reply.status, 201);
    return JSON.parse(reply.body.toString()) as { hostId: string; enrollKey: string };
  };
  const a = await createEnrollment();
  const b = await createEnrollment();
  const installer = await http(bridge.url, "/install.sh", { headers: access });
  assert.equal(installer.status, 200);
  const artifact = await http(bridge.url, "/install/bb-app.tgz", { headers: access });
  assert.equal(artifact.status, 200);
  assert.equal(createHash("sha256").update(artifact.body).digest("hex"), artifact.headers["x-bb-artifact-sha256"]);
  const conditional = await http(bridge.url, "/install/bb-app.tgz", { headers: { ...access, "if-none-match": artifact.headers.etag! } });
  assert.equal(conditional.status, 304); assert.equal(conditional.body.length, 0);
  assert.match(installer.body.toString(), /bootstrap/);
  assert.ok(!installer.body.includes(a.enrollKey));
  assert.equal((await http(bridge.url, "/install.sh", { headers: { ...access, "x-bb-enrollment": a.enrollKey } })).status, 403);
  assert.equal((await bridged("/internal/hosts/enroll", { hostId: a.hostId, hostName: "Synthetic A" })).status, 401);
  const mismatch = await createEnrollment();
  assert.equal((await bridged("/internal/hosts/enroll", { hostId: b.hostId, hostName: "Synthetic B" }, mismatch.enrollKey)).status, 401);
  const enroll = async (identity: typeof a) => {
    const reply = await bridged("/internal/hosts/enroll", { hostId: identity.hostId, hostName: "Synthetic machine" }, identity.enrollKey);
    assert.equal(reply.status, 201);
    return (JSON.parse(reply.body.toString()) as { hostKey: string }).hostKey;
  };
  const keyA = await enroll(a);
  const keyB = await enroll(b);
  const sessionBody = (hostId: string) => ({
    hostId, instanceId: "synthetic-instance", hostName: "Synthetic worker", hasMachineCredential: false,
    platform: "linux", dataDir: "/tmp/synthetic-workspace", localApiPort: null,
    protocolVersion: TESTED_CORE.protocolVersion, activeThreads: [],
  });
  assert.equal((await bridged("/internal/session/open", sessionBody(a.hostId))).status, 401);
  assert.equal((await bridged("/internal/session/open", sessionBody(a.hostId), "synthetic-wrong-key")).status, 401);
  assert.equal((await bridged("/internal/session/open", sessionBody(b.hostId), keyA)).status, 403);
  const opened = await fetch(`${bridge.url}/internal/session/open`, {
    method: "POST", headers: { ...access, authorization: `Bearer ${keyA}`, "content-type": "application/json" },
    body: JSON.stringify(sessionBody(a.hostId)),
  });
  assert.equal(opened.status, 201);
  const sessionA = (await opened.json()).sessionId as string;
  // Transport admission A plus native key B intentionally authenticates B,
  // never A: this proves the documented absence of transport host binding.
  const openedB = await bridged("/internal/session/open", sessionBody(b.hostId), keyB);
  assert.equal(openedB.status, 201);
  const events = await bridged("/internal/session/events", { sessionId: sessionA, eventGroups: [] }, keyA);
  assert.equal(events.status, 200, events.body.toString());
  assert.equal((await bridged("/internal/session/events", { sessionId: sessionA, eventGroups: [] }, keyB)).status, 403);
  const query = new URLSearchParams({ sessionId: sessionA, threadId: "synthetic-thread", projectId: "synthetic-project", path: "harmless.txt" });
  const attachment = await http(bridge.url, `/internal/session/project-attachment-content?${query}`, { headers: { ...access, authorization: `Bearer ${keyB}` } });
  assert.equal(attachment.status, 403);

  await rejectsSocket(openSocket(`${bridge.url}/internal/ws?sessionId=${sessionA}`, grant.token, "synthetic-wrong-key"));
  await rejectsSocket(openSocket(`${bridge.url}/internal/ws?sessionId=${sessionA}`, grant.token, keyB));
  const socket = openSocket(`${bridge.url}/internal/ws?sessionId=${sessionA}`, grant.token, keyA);
  t.after(() => socket.terminate());
  await once(socket, "open");
  assert.equal(socket.protocol, DAEMON_PROTOCOL);
  assert.equal(socket.extensions, "", "Default native ws compression offer is discarded, not negotiated");
  const messages: string[] = [];
  socket.on("message", bytes => messages.push(bytes.toString()));
  socket.send(JSON.stringify({ type: "heartbeat" }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(socket.readyState, WebSocket.OPEN, `Native heartbeat accepted: ${messages.length} native responses`);
  const closed = once(socket, "close");
  leases.release(grant.key, grant.hostId, grant.id);
  await closed;
  assert.equal((await http(bridge.url, "/install/version", { headers: access })).status, 403);
  await rejectsSocket(openSocket(`${bridge.url}/internal/ws?sessionId=${sessionA}`, grant.token, keyA));
  await bridge.close();
  await core.restart();
  const replacement = new AdmissionLeases();
  bridge = await setup(replacement);
  assert.equal((await http(bridge.url, "/install/version", { headers: access })).status, 403);
  const fresh = replacement.acquire("synthetic-launch-a", "host-a", new AbortController().signal);
  const reopened = await http(bridge.url, "/internal/session/open", {
    ...json(sessionBody(a.hostId)), headers: { ...json(sessionBody(a.hostId)).headers, [ACCESS_HEADER]: fresh.token, authorization: `Bearer ${keyA}` },
  });
  assert.equal(reopened.status, 201, reopened.body.toString());
  const reEnroll = await http(core.baseUrl, "/internal/hosts/enroll-key", json({ hostId: a.hostId }));
  assert.equal(reEnroll.status, 201);
  const newEnrollment = JSON.parse(reEnroll.body.toString());
  const newOptions = json({ hostId: a.hostId, hostName: "Synthetic replacement native key" });
  const newIdentity = await http(bridge.url, "/internal/hosts/enroll", { ...newOptions, headers: { ...newOptions.headers, [ACCESS_HEADER]: fresh.token, authorization: `Bearer ${newEnrollment.enrollKey}` } });
  assert.equal(newIdentity.status, 201);
  const oldKey = await http(bridge.url, "/internal/session/open", { ...json(sessionBody(a.hostId)), headers: { ...json(sessionBody(a.hostId)).headers, [ACCESS_HEADER]: fresh.token, authorization: `Bearer ${keyA}` } });
  assert.equal(oldKey.status, 401, "Core native key revocation remains authoritative independently of transport admission");
  for (const secret of [grant.token, fresh.token, a.enrollKey, b.enrollKey, keyA, keyB]) assert.ok(!core.logs().includes(secret), "Credentials absent from server diagnostics");
});
