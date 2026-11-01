import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { AdmissionLeases } from "../grants.ts";
import { openBridge, openRelayAdapter } from "../bridge.ts";
import { openTunnelRelay, startConnector, hostFingerprint } from "../tunnel.ts";
import { syntheticKeys } from "./keys.ts";
import { http, isolatedCore, freePort } from "./isolated.ts";
import { ACCESS_HEADER } from "../policy.ts";

test("released native daemon synchronizes registered skill files over SSH/WS with entirely temporary HOME and data", { timeout: 90_000 }, async t => {
  const core = await isolatedCore(); t.after(() => core.close());
  const leases = new AdmissionLeases();
  const rejections: unknown[] = [];
  const bridge = await openBridge({ baseUrl: core.baseUrl, leases, onRejection: snapshot => { rejections.push(snapshot.last); } }); t.after(() => bridge.close());
  const host = syntheticKeys(); const client = syntheticKeys();
  const reversePort = await freePort(); const publicPort = await freePort();
  const bridgePort = Number(new URL(bridge.url).port);
  const relay = await openTunnelRelay({ hostKey: host.privateKey, authorizedKey: client.publicKey, reversePort }); t.after(() => relay.close());
  const adapter = await openRelayAdapter({ reversePort, bridgePort, publicAuthority: `127.0.0.1:${publicPort}`, port: publicPort, connector: relay, onRejection: snapshot => { rejections.push(snapshot.last); } }); t.after(() => adapter.close());
  const connector = await startConnector({ relayUrl: adapter.url.replace("http:", "ws:"), privateKey: client.privateKey, hostFingerprint: hostFingerprint(host.privateKey), reversePort, bridgePort }); t.after(() => connector.close());
  const enrollmentReply = await http(core.baseUrl, "/internal/hosts/enroll-key", { method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": "2" } });
  assert.equal(enrollmentReply.status, 201);
  const enrollment = JSON.parse(enrollmentReply.body.toString());
  const grant = leases.acquire("synthetic-released-daemon", enrollment.hostId, new AbortController().signal);
  const home = join(core.directory, "worker-home"); const data = join(home, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(core.env).filter(([key]) => !key.startsWith("BB_") && !key.startsWith("XDG_")));
  Object.assign(env, {
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    BB_DATA_DIR: data, BB_SERVER_URL: adapter.url, BB_HOST_DAEMON_PORT: String(await freePort()),
    BB_HOST_ID: enrollment.hostId, BB_HOST_ENROLL_KEY: enrollment.enrollKey,
    BB_SERVER_HEADERS: JSON.stringify({ [ACCESS_HEADER]: grant.token }), BB_HOST_DAEMON_AUTO_UPDATE: "false", BB_HOST_DAEMON_SUPERVISED: "false",
  });
  const entry = process.env.BB_TEST_DAEMON_JS ?? "/Applications/bb Personal.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb-app.js";
  const daemon = spawn(process.execPath, [entry, "host-daemon"], { cwd: home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  daemon.stdout.on("data", data => { logs = (logs + data).slice(-1024 * 1024); });
  daemon.stderr.on("data", data => { logs = (logs + data).slice(-1024 * 1024); });
  daemon.on("error", () => {});
  t.after(async () => {
    const killGroup = (signal: NodeJS.Signals) => { try { process.kill(-daemon.pid!, signal); } catch {} };
    const exit = daemon.exitCode === null && daemon.signalCode === null ? once(daemon, "exit") : null;
    killGroup("SIGTERM");
    if (exit) {
      const timer = setTimeout(() => killGroup("SIGKILL"), 5000);
      await exit; clearTimeout(timer);
    }
    killGroup("SIGKILL");
  });
  const startupDiagnostics = async () => {
    const files = await readdir(join(data, "logs")).catch(() => []);
    const workerLogs = await Promise.all(files.filter(name => /^host-daemon.*\.log$/.test(name)).map(name => readFile(join(data, "logs", name), "utf8").catch(() => "")));
    return (logs + workerLogs.join("\n") + JSON.stringify(rejections)).replaceAll(enrollment.enrollKey, "[redacted]").replaceAll(grant.token, "[redacted]").replaceAll(client.privateKey, "[redacted]").replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted]").slice(-4000);
  };
  let connected = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    const response = await http(core.baseUrl, `/api/v1/hosts/${enrollment.hostId}`);
    if (response.status === 200 && JSON.parse(response.body.toString()).status === "connected") { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(connected, true, `Released native daemon enrolled and connected its actual session/WS protocol: ${connected ? "" : await startupDiagnostics()}`);
  let commandChannelReady = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await http(core.baseUrl, `/api/v1/system/cli-skills?hostIds=${enrollment.hostId}`);
    assert.equal(response.status, 200);
    if (JSON.parse(response.body.toString()).machines[0].status !== "unknown") { commandChannelReady = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(commandChannelReady, true, `Skill synchronization requires a native WebSocket command roundtrip: ${commandChannelReady ? "" : await startupDiagnostics()}`);
  const installBody = JSON.stringify({ hostIds: [enrollment.hostId] });
  const installed = await http(core.baseUrl, "/api/v1/system/cli-skills/install", {
    method: "POST", body: installBody, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(installBody)) },
  });
  assert.equal(installed.status, 200);
  const result = JSON.parse(installed.body.toString()).results;
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, true, `Released daemon skill synchronization failed: ${JSON.stringify(result[0])}`);
  assert.ok(result[0].installations.length > 0);
  const expectedSkill = await readFile(join(dirname(core.serverEntry), "builtin-skills/bb-cli/SKILL.md"));
  for (const installation of result[0].installations as { name: string; path: string }[]) {
    const destination = relative(home, installation.path);
    assert.ok(destination && !isAbsolute(destination) && !destination.startsWith(".."), "Skill installation stays within the isolated daemon HOME");
    assert.equal(installation.name, "bb-cli");
    assert.deepEqual(await readFile(join(installation.path, "SKILL.md")), expectedSkill, "Native manifest/content synchronization materializes the registered skill bytes");
  }
  const synchronized = await http(core.baseUrl, `/api/v1/system/cli-skills?hostIds=${enrollment.hostId}`);
  assert.equal(synchronized.status, 200);
  assert.equal(JSON.parse(synchronized.body.toString()).machines[0].status, "installed", "Native hash verification recognizes the complete synchronized skill tree");
  for (const secret of [enrollment.enrollKey, grant.token, client.privateKey]) {
    assert.ok(!logs.includes(secret)); assert.ok(!core.logs().includes(secret));
  }
  leases.release(grant.key, grant.hostId, grant.id);
  let disconnected = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await http(core.baseUrl, `/api/v1/hosts/${enrollment.hostId}`);
    if (JSON.parse(response.body.toString()).status === "disconnected") { disconnected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(disconnected, true, "Transport revoke closes the actual native daemon stream");
});
